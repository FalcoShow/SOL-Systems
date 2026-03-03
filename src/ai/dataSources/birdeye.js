// ============================================================
//  SOL SYSTEMS — Birdeye Wallet Data Source
//  File: src/ai/dataSources/birdeye.js
//
//  Fetches live wallet performance data from Birdeye API.
//  Used by the nightly wallet intelligence job to score and
//  rank candidate wallets for copy trading.
//
//  Data pulled per wallet:
//    - 7d and 30d PnL in SOL and USD
//    - Win rate percentage
//    - Trade count and frequency
//    - Average hold time
//    - Top tokens traded
//    - Estimated capital (largest single position)
//
//  Birdeye endpoints used:
//    - /trader/gainers-losers  : leaderboard of top traders
//    - /trader/txs/seek-by-time: wallet trade history
//    - /defi/token_overview    : token liquidity (reused from riskManager)
//
//  Rate limits: Birdeye public tier = 100 req/min
//  We stay well under this with delays between calls.
// ============================================================

'use strict';

const axios       = require('axios');
const config      = require('../../config');
const logger      = require('../../utils/logger');
const rateLimiter = require('../../utils/birdeyeRateLimiter');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const BIRDEYE_BASE    = 'https://public-api.birdeye.so';
const REQUEST_TIMEOUT = 15_000;   // 15s — longer than price calls, data is richer
const DELAY_BETWEEN   = 300;      // 300ms between calls to respect rate limits
const MAX_WALLETS     = 20;       // Max candidate wallets to fetch in one run
const CHAIN           = 'solana';

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Fetch top trader wallets from Birdeye leaderboard.
 * Returns an array of wallet candidates with performance stats.
 *
 * @returns {Promise<WalletCandidate[]>}
 */
async function getTopTraders() {
  const apiKey = config.prices.birdeyeApiKey;

  if (!apiKey) {
    logger.warn('[Birdeye] No API key configured — skipping Birdeye data source');
    return [];
  }

  logger.info('[Birdeye] Fetching top traders from leaderboard...');

  try {
    // ── Step 1: Pull the top gainers leaderboard ──────────
    const gainers = await _fetchGainersLeaderboard(apiKey);

    if (!gainers || gainers.length === 0) {
      logger.warn('[Birdeye] Leaderboard returned no results');
      return [];
    }

    logger.info('[Birdeye] Leaderboard fetched', { count: gainers.length });

    // ── Step 2: Enrich each wallet with detailed stats ────
    const enriched = [];

    for (const gainer of gainers.slice(0, MAX_WALLETS)) {
      try {
        await _sleep(DELAY_BETWEEN);
        const stats = await _fetchWalletStats(apiKey, gainer.address);

        if (stats) {
          enriched.push({
            address:          gainer.address,
            source:           'birdeye',
            // From leaderboard
            pnl7dUSD:         gainer.pnl7d     || 0,
            pnl30dUSD:        gainer.pnl30d    || 0,
            // From detailed stats
            winRatePct:       stats.winRatePct  || 0,
            totalTrades7d:    stats.trades7d    || 0,
            totalTrades30d:   stats.trades30d   || 0,
            avgHoldTimeMs:    stats.avgHoldMs   || 0,
            tradesPerDay:     stats.tradesPerDay || 0,
            estimatedCapSOL:  stats.estCapSOL   || 0,
            topTokens:        stats.topTokens   || [],
            lastActiveAt:     stats.lastActiveAt || null,
            dataQuality:      stats.dataQuality  || 50,
          });
        }

      } catch (err) {
        // Non-fatal — skip this wallet, log and continue
        logger.debug('[Birdeye] Failed to enrich wallet', {
          address: gainer.address?.slice(0, 8) + '...',
          error:   err.message,
        });
      }
    }

    logger.info('[Birdeye] Wallet enrichment complete', {
      fetched:  gainers.length,
      enriched: enriched.length,
    });

    return enriched;

  } catch (err) {
    logger.error('[Birdeye] getTopTraders failed', { error: err.message });
    return [];
  }
}

/**
 * Fetch stats for a single known wallet address.
 * Used when we already have addresses and want to score them.
 *
 * @param {string} address - Solana wallet address
 * @returns {Promise<WalletCandidate|null>}
 */
async function getWalletStats(address) {
  const apiKey = config.prices.birdeyeApiKey;
  if (!apiKey) return null;

  try {
    const stats = await _fetchWalletStats(apiKey, address);
    if (!stats) return null;

    return {
      address,
      source:          'birdeye',
      pnl7dUSD:        stats.pnl7dUSD    || 0,
      pnl30dUSD:       stats.pnl30dUSD   || 0,
      winRatePct:      stats.winRatePct  || 0,
      totalTrades7d:   stats.trades7d    || 0,
      totalTrades30d:  stats.trades30d   || 0,
      avgHoldTimeMs:   stats.avgHoldMs   || 0,
      tradesPerDay:    stats.tradesPerDay || 0,
      estimatedCapSOL: stats.estCapSOL   || 0,
      topTokens:       stats.topTokens   || [],
      lastActiveAt:    stats.lastActiveAt || null,
      dataQuality:     stats.dataQuality  || 50,
    };
  } catch (err) {
    logger.debug('[Birdeye] getWalletStats failed', {
      address: address?.slice(0, 8) + '...',
      error:   err.message,
    });
    return null;
  }
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — API CALLS
// ────────────────────────────────────────────────────────────

/**
 * Pull the top gainers leaderboard from Birdeye.
 * Returns raw leaderboard entries with basic PnL data.
 *
 * @param {string} apiKey
 * @returns {Promise<Array>}
 * @private
 */
async function _fetchGainersLeaderboard(apiKey) {
  // Try multiple timeframes — if one rate-limits, wait and try the next.
  // The free tier shares a 60 RPM account limit with priceSync,
  // so we space out calls to avoid 429s.
  const timeframes = ['1W', 'yesterday', 'today'];

  for (const type of timeframes) {
    try {
      const response = await rateLimiter.request(() =>
        axios.get(`${BIRDEYE_BASE}/trader/gainers-losers`, {
          params: {
            type,
            sort_by:   'PnL',
            sort_type: 'desc',
            offset:    0,
            limit:     Math.min(MAX_WALLETS, 10),  // Birdeye max is 10
          },
          headers: _headers(apiKey),
          timeout: REQUEST_TIMEOUT,
        })
      );

      const items = response.data?.data?.items || [];
      if (items.length > 0) {
        logger.info('[Birdeye] Leaderboard fetched', { type, count: items.length });
        return items.map((item) => ({
          address: item.address || item.owner,
          pnl7d:   item.pnl || 0,
          pnl30d:  type === '1M' ? (item.pnl || 0) : 0,
        }));
      }
    } catch (err) {
      const status = err.response?.status;
      const body   = err.response?.data;
      logger.info('[Birdeye] Leaderboard attempt failed', {
        type,
        status: status || 'network',
        error:  err.message,
        body:   typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)?.slice(0, 200),
      });

      // 429 = rate limited — wait 3s before next attempt
      if (status === 429) {
        await _sleep(3000);
      }
      // 401/403 = endpoint not available on this plan — stop trying
      if (status === 401 || status === 403) {
        logger.warn('[Birdeye] Leaderboard endpoint not available on current plan');
        break;
      }
    }
  }

  logger.warn('[Birdeye] All leaderboard timeframes failed — endpoint may require Premium+ plan');
  return [];
}

/**
 * Fetch detailed trade stats for a single wallet.
 * Calculates win rate, trade frequency, avg hold time from tx history.
 *
 * @param {string} apiKey
 * @param {string} address
 * @returns {Promise<object|null>}
 * @private
 */
async function _fetchWalletStats(apiKey, address) {
  try {
    // Fetch recent transaction history for this wallet
    const now       = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);

    const response = await rateLimiter.request(() =>
      axios.get(`${BIRDEYE_BASE}/trader/txs/seek-by-time`, {
        params: {
          address,
          tx_type:   'swap',
          time_from: sevenDaysAgo,
          time_to:   now,
          limit:     100,
        },
        headers: _headers(apiKey),
        timeout: REQUEST_TIMEOUT,
      })
    );

    const txs = response.data?.data?.items || [];

    if (txs.length === 0) {
      return null;   // No recent activity — wallet is dormant
    }

    // ── Calculate stats from raw transactions ─────────────
    return _calculateStatsFromTxs(txs);

  } catch (err) {
    logger.debug('[Birdeye] _fetchWalletStats failed', {
      address: address?.slice(0, 8) + '...',
      error:   err.message,
    });
    return null;
  }
}

/**
 * Calculate performance stats from raw transaction array.
 * Computes win rate, hold time, trade frequency, estimated capital.
 *
 * @param {Array} txs - Raw Birdeye swap transactions
 * @returns {object}
 * @private
 */
function _calculateStatsFromTxs(txs) {
  if (!txs || txs.length === 0) return null;

  // ── Sort by time ascending ────────────────────────────
  const sorted = [...txs].sort((a, b) => a.blockUnixTime - b.blockUnixTime);

  let wins        = 0;
  let losses      = 0;
  let holdTimes   = [];
  let solAmounts  = [];
  let tokensSeen  = new Map();  // tokenMint → count

  // Build buy map to pair with sells for PnL
  const buys = new Map();  // tokenMint → { time, amountSol }

  for (const tx of sorted) {
    const isBuy    = tx.side === 'buy'  || tx.type === 'buy';
    const isSell   = tx.side === 'sell' || tx.type === 'sell';
    const mint     = tx.tokenAddress || tx.baseAddress;
    const amtSOL   = parseFloat(tx.volumeSOL || tx.volume || 0);
    const blockTime = tx.blockUnixTime || tx.time || 0;

    // Track token popularity
    if (mint) {
      tokensSeen.set(mint, (tokensSeen.get(mint) || 0) + 1);
    }

    if (amtSOL > 0) solAmounts.push(amtSOL);

    if (isBuy && mint) {
      buys.set(mint, { time: blockTime, amtSOL });
    }

    if (isSell && mint && buys.has(mint)) {
      const buy = buys.get(mint);
      const pnlPct = ((amtSOL - buy.amtSOL) / buy.amtSOL) * 100;

      if (pnlPct > 0) wins++;
      else losses++;

      // Hold time in milliseconds
      if (buy.time && blockTime > buy.time) {
        holdTimes.push((blockTime - buy.time) * 1000);
      }

      buys.delete(mint);
    }
  }

  const total      = wins + losses;
  const winRatePct = total > 0 ? (wins / total) * 100 : 0;
  const avgHoldMs  = holdTimes.length > 0
    ? holdTimes.reduce((s, t) => s + t, 0) / holdTimes.length
    : 0;

  // Estimate capital from largest single SOL amount seen
  const estCapSOL = solAmounts.length > 0
    ? Math.max(...solAmounts) * 10  // Rough estimate: largest trade ≈ 10% of capital
    : 0;

  // Trades per day (over 7 day window)
  const tradesPerDay = txs.length / 7;

  // Top 5 tokens by frequency
  const topTokens = [...tokensSeen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([mint]) => mint);

  // Last active timestamp
  const lastTx     = sorted[sorted.length - 1];
  const lastActiveAt = lastTx?.blockUnixTime
    ? new Date(lastTx.blockUnixTime * 1000)
    : null;

  // Data quality score — how confident are we in these stats?
  // Higher with more trades, better with matched buy/sell pairs
  const dataQuality = Math.min(100, Math.round(
    (total / 20) * 40 +      // 40 pts for having 20+ matched trades
    (txs.length / 50) * 30 + // 30 pts for 50+ total txs
    (winRatePct > 0 ? 30 : 0) // 30 pts for calculable win rate
  ));

  return {
    winRatePct:  parseFloat(winRatePct.toFixed(2)),
    wins,
    losses,
    trades7d:    txs.length,
    trades30d:   0,      // Would need a 30d call — skipped for now
    tradesPerDay: parseFloat(tradesPerDay.toFixed(1)),
    avgHoldMs:   Math.round(avgHoldMs),
    estCapSOL:   parseFloat(estCapSOL.toFixed(2)),
    topTokens,
    lastActiveAt,
    dataQuality,
  };
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Build standard Birdeye request headers.
 * Matches the pattern used in riskManager.js.
 *
 * @param {string} apiKey
 * @returns {object}
 * @private
 */
function _headers(apiKey) {
  return {
    'X-API-KEY': apiKey,
    'x-chain':   CHAIN,
    'Accept':    'application/json',
  };
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
  getWalletStats,
};