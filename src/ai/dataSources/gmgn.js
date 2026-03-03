// ============================================================
//  SOL SYSTEMS — GMGN Wallet Data Source
//  File: src/ai/dataSources/gmgn.js
//
//  Fetches wallet performance data from GMGN.ai.
//  GMGN has no official public API — this uses their internal
//  data endpoints that power their own leaderboard UI.
//
//  Data pulled:
//    - Leaderboard of top Solana traders by PnL
//    - Per-wallet: win rate, PnL 7d/30d, trade count
//    - Smart money labels (insider, whale, etc.)
//    - Last active timestamp
//
//  Resilience:
//    - Rotates between multiple known endpoint formats
//    - Falls back gracefully if GMGN blocks or rate-limits
//    - Returns empty array on any failure (never throws)
//    - Randomised delays to avoid detection as a scraper
//
//  NOTE: GMGN may change their endpoints without notice.
//  If this source returns 0 results consistently, check
//  the aggregator's dataQuality score — it will fall back
//  to Birdeye + Cielo automatically.
// ============================================================

'use strict';

const axios  = require('axios');
const logger = require('../../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT = 20_000;   // 20s — GMGN can be slow
const DELAY_MIN       = 500;      // Min ms between requests
const DELAY_MAX       = 1200;     // Max ms — randomised to look human
const MAX_WALLETS     = 20;
const MAX_RETRIES     = 2;        // Retry each endpoint up to 2x on transient failure

// GMGN rotates domains / paths periodically.
// We try multiple base URLs so the system survives endpoint changes.
const GMGN_BASES = [
  'https://gmgn.ai',
  'https://www.gmgn.ai',
];

// Rotate user agents to reduce chance of being blocked
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Fetch top trader wallets from GMGN leaderboard.
 * Returns array of wallet candidates with performance stats.
 *
 * @returns {Promise<WalletCandidate[]>}
 */
async function getTopTraders() {
  logger.info('[GMGN] Fetching top traders from leaderboard...');

  try {
    // Try primary endpoint first
    let leaders = await _fetchLeaderboard();

    if (!leaders || leaders.length === 0) {
      logger.debug('[GMGN] Primary leaderboard empty, trying alternate...');
      leaders = await _fetchLeaderboardAlternate();
    }

    if (!leaders || leaders.length === 0) {
      logger.warn('[GMGN] All leaderboard endpoints returned no data');
      return [];
    }

    logger.info('[GMGN] Leaderboard fetched', { count: leaders.length });

    // Enrich with per-wallet detail stats
    const enriched = [];

    for (const leader of leaders.slice(0, MAX_WALLETS)) {
      try {
        await _sleep(_randomDelay());
        const detail = await _fetchWalletDetail(leader.address);

        enriched.push({
          address:         leader.address,
          source:          'gmgn',
          pnl7dUSD:        leader.pnl7d        || detail?.pnl7d   || 0,
          pnl30dUSD:       leader.pnl30d       || detail?.pnl30d  || 0,
          winRatePct:      leader.winRate       || detail?.winRate || 0,
          totalTrades7d:   leader.trades7d      || detail?.trades  || 0,
          totalTrades30d:  leader.trades30d     || 0,
          tradesPerDay:    leader.tradesPerDay  || 0,
          avgHoldTimeMs:   detail?.avgHoldMs    || 0,
          estimatedCapSOL: detail?.estCapSOL    || 0,
          topTokens:       detail?.topTokens    || [],
          lastActiveAt:    detail?.lastActiveAt || leader.lastActive || null,
          smartMoneyLabel: leader.label         || null,  // e.g. "Smart Money", "KOL"
          dataQuality:     detail ? 70 : 40,   // Lower quality if detail fetch failed
        });

      } catch (err) {
        // Skip this wallet — non-fatal
        logger.debug('[GMGN] Failed to enrich wallet', {
          address: leader.address?.slice(0, 8) + '...',
          error:   err.message,
        });
      }
    }

    logger.info('[GMGN] Enrichment complete', {
      fetched:  leaders.length,
      enriched: enriched.length,
    });

    return enriched;

  } catch (err) {
    // GMGN is best-effort — never let it break the whole pipeline
    logger.warn('[GMGN] getTopTraders failed — source will be skipped', {
      error: err.message,
    });
    return [];
  }
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — LEADERBOARD FETCHING
// ────────────────────────────────────────────────────────────

/**
 * Fetch GMGN SOL trader leaderboard with base-URL rotation + retry.
 * Tries every base × every path until one succeeds.
 * @returns {Promise<Array>}
 * @private
 */
async function _fetchLeaderboard() {
  const paths = [
    { path: '/defi/quotation/v1/rank/sol/wallets/1d', params: { orderby: 'pnl', direction: 'desc', limit: MAX_WALLETS, offset: 0, period: '1d' } },
    { path: '/defi/quotation/v1/rank/sol/wallets/7d', params: { orderby: 'pnl', direction: 'desc', limit: MAX_WALLETS, offset: 0 } },
  ];

  for (const base of GMGN_BASES) {
    for (const { path, params } of paths) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await axios.get(`${base}${path}`, {
            params,
            headers: _headers(),
            timeout: REQUEST_TIMEOUT,
          });

          const items = response.data?.data?.rank || response.data?.rank || [];
          const normalised = _normaliseLeaderboard(items);
          if (normalised.length > 0) {
            logger.debug('[GMGN] Leaderboard fetched', { base, path, count: normalised.length });
            return normalised;
          }
        } catch (err) {
          logger.debug('[GMGN] Leaderboard attempt failed', {
            base, path, attempt, error: err.message,
          });
          if (attempt < MAX_RETRIES) await _sleep(_randomDelay());
        }
      }
    }
  }

  logger.warn('[GMGN] All leaderboard endpoints exhausted');
  return [];
}

/**
 * Normalise GMGN leaderboard items into a consistent shape.
 * GMGN changes their field names occasionally — this handles variations.
 *
 * @param {Array} items - Raw GMGN leaderboard items
 * @returns {Array}
 * @private
 */
function _normaliseLeaderboard(items) {
  if (!Array.isArray(items)) return [];

  return items
    .filter((item) => item && (item.address || item.wallet_address))
    .map((item) => ({
      address:     item.address       || item.wallet_address || item.owner,
      pnl7d:       parseFloat(item.pnl || item.realized_profit || item.profit || 0),
      pnl30d:      parseFloat(item.pnl_30d || item.realized_profit_30d || 0),
      winRate:     parseFloat(item.winrate || item.win_rate || item.win_ratio || 0) * 100,
      trades7d:    parseInt(item.buy_30d || item.trade_count || item.txs || 0),
      trades30d:   parseInt(item.buy_30d || 0),
      tradesPerDay: parseFloat(item.txs_30d / 30 || 0),
      label:       item.tag || item.type || item.label || null,
      lastActive:  item.last_active_timestamp
        ? new Date(item.last_active_timestamp * 1000)
        : null,
    }));
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — WALLET DETAIL
// ────────────────────────────────────────────────────────────

/**
 * Fetch detailed stats for a single wallet from GMGN.
 * Returns enriched data or null if fetch fails.
 *
 * @param {string} address
 * @returns {Promise<object|null>}
 * @private
 */
async function _fetchWalletDetail(address) {
  if (!address) return null;

  const paths = [
    { path: `/defi/quotation/v1/smartmoney/sol/walletNew/${address}`, params: { period: '7d' } },
    { path: `/api/v1/wallet_holdings/sol/${address}`, params: { orderby: 'realized_profit', direction: 'desc', limit: 20 } },
  ];

  for (const base of GMGN_BASES) {
    for (const { path, params } of paths) {
      try {
        const response = await axios.get(`${base}${path}`, {
          params,
          headers: _headers(),
          timeout: REQUEST_TIMEOUT,
        });

        const data = response.data?.data || response.data;
        if (!data) continue;

        return _normaliseWalletDetail(data, address);
      } catch (err) {
        logger.debug('[GMGN] Wallet detail attempt failed', {
          base,
          address: address.slice(0, 8) + '...',
          error:   err.message,
        });
        await _sleep(DELAY_MIN);
      }
    }
  }

  return null;
}

/**
 * Normalise raw GMGN wallet detail into a consistent shape.
 *
 * @param {object} data - Raw GMGN wallet data
 * @param {string} address
 * @returns {object}
 * @private
 */
function _normaliseWalletDetail(data, address) {
  // Extract top tokens from holdings or trade history
  const holdings = data.holdings || data.tokens || [];
  const topTokens = holdings
    .slice(0, 5)
    .map((h) => h.address || h.token || h.mint)
    .filter(Boolean);

  // Estimate capital from total holdings value
  const estCapSOL = parseFloat(
    data.sol_balance        ||
    data.total_value_sol    ||
    data.portfolio_value    ||
    0
  );

  // Average hold time — GMGN sometimes provides this directly
  const avgHoldMs = parseFloat(data.avg_hold_time || data.average_hold_time || 0) * 1000;

  // Last active
  const lastTs   = data.last_active_timestamp || data.last_trade_time;
  const lastActiveAt = lastTs ? new Date(lastTs * 1000) : null;

  return {
    pnl7d:       parseFloat(data.realized_profit_7d  || data.pnl_7d  || 0),
    pnl30d:      parseFloat(data.realized_profit_30d || data.pnl_30d || 0),
    winRate:     parseFloat(data.winrate || data.win_rate || 0) * 100,
    trades:      parseInt(data.buy_7d || data.trade_count_7d || 0),
    avgHoldMs:   Math.round(avgHoldMs),
    estCapSOL:   parseFloat(estCapSOL.toFixed(2)),
    topTokens,
    lastActiveAt,
  };
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Build request headers that mimic a browser request.
 * Rotates user agents to reduce block risk.
 *
 * @returns {object}
 * @private
 */
function _headers() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    'User-Agent':      ua,
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://gmgn.ai/',
    'Origin':          'https://gmgn.ai',
  };
}

/** Random delay between DELAY_MIN and DELAY_MAX ms. */
function _randomDelay() {
  return DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));
}

/** Promise-based sleep. */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  getTopTraders,
};