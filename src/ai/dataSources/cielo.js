// ============================================================
//  SOL SYSTEMS — Cielo Wallet Data Source
//  File: src/ai/dataSources/cielo.js
//
//  Third data source for the wallet intelligence pipeline.
//  Uses the Cielo.finance feed API to discover active Solana
//  traders by watching for high-value swaps, then enriches
//  each unique wallet with PnL stats.
//
//  Discovery strategy:
//    1. Pull recent high-value Solana swaps from the /feed endpoint
//    2. Extract unique wallet addresses from those swaps
//    3. Enrich each wallet with /pnl/total-stats for PnL metrics
//    4. Return normalised WalletCandidate objects
//
//  API docs: https://developer.cielo.finance/reference
//  Auth:     X-API-KEY header
//  Base URL: https://feed-api.cielo.finance/api/v1
// ============================================================

'use strict';

const axios  = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const CIELO_BASE      = 'https://feed-api.cielo.finance/api/v1';
const REQUEST_TIMEOUT = 20_000;
const DELAY_BETWEEN   = 500;      // ms between sequential calls
const MAX_WALLETS     = 20;
const MIN_SWAP_USD    = 100;      // Only consider swaps ≥ $100 (cast wide net for discovery)

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Discover top trader wallets from Cielo feed.
 * Uses the feed to find active high-value Solana traders,
 * then enriches each with PnL stats.
 *
 * @returns {Promise<WalletCandidate[]>}
 */
async function getTopTraders() {
  const apiKey = config.cielo?.apiKey;

  // Cielo is optional — skip gracefully if no key is configured
  if (!apiKey) {
    logger.debug('[Cielo] No API key configured — skipping Cielo data source');
    return [];
  }

  logger.info('[Cielo] Fetching top traders from feed...');

  try {
    // ── Step 1: Discover active wallets from recent swaps ──
    const walletAddresses = await _discoverWalletsFromFeed(apiKey);

    if (walletAddresses.length === 0) {
      logger.warn('[Cielo] Feed returned no qualifying wallets');
      return [];
    }

    logger.info('[Cielo] Unique wallets discovered from feed', {
      count:   walletAddresses.length,
      topAddr: walletAddresses[0]?.address?.slice(0, 8) + '...',
    });

    // ── Step 2: Build candidates from feed data + optional PnL enrichment ──
    // Free Cielo plan only has /feed. PnL stats need Builder ($89/mo).
    // We extract basic stats from feed swaps and try PnL as a bonus.
    const candidates = [];

    for (const { address, feedStats } of walletAddresses.slice(0, MAX_WALLETS)) {
      try {
        // Try PnL enrichment (works on Builder+ plans, fails gracefully on Free)
        let pnlStats = null;
        try {
          await _sleep(DELAY_BETWEEN);
          pnlStats = await _fetchWalletStats(apiKey, address);
        } catch (_) {
          // Expected on free plan — PnL endpoint not available
        }

        // Merge feed-derived stats with PnL stats (PnL takes priority if available)
        const trades7d  = pnlStats?.trades7d  || feedStats.tradeCount || 0;
        const winRate   = pnlStats?.winRate   || 0;
        const pnl7d     = pnlStats?.pnl7d    || feedStats.estimatedPnlUSD || 0;

        candidates.push({
          address,
          source:          'cielo',
          pnl7dUSD:        pnl7d,
          pnl30dUSD:       pnlStats?.pnl30d   || 0,
          winRatePct:      winRate,
          totalTrades7d:   trades7d,
          totalTrades30d:  pnlStats?.trades30d || 0,
          tradesPerDay:    trades7d > 0 ? parseFloat((trades7d / 7).toFixed(1)) : feedStats.tradesPerDay || 0,
          avgHoldTimeMs:   0,
          estimatedCapSOL: pnlStats?.estCapSOL || feedStats.avgSwapUSD / 150 || 0,  // rough: avg swap / SOL price
          topTokens:       pnlStats?.topTokens || feedStats.tokens || [],
          lastActiveAt:    feedStats.lastSeen || null,
          smartMoneyLabel: null,
          dataQuality:     pnlStats ? (pnlStats.dataQuality || 60) : feedStats.quality,
        });
      } catch (err) {
        logger.debug('[Cielo] Failed to process wallet', {
          address: address.slice(0, 8) + '...',
          error:   err.message,
        });
      }
    }

    logger.info('[Cielo] Processing complete', {
      discovered: walletAddresses.length,
      candidates: candidates.length,
    });

    return candidates;

  } catch (err) {
    // Cielo is best-effort — never break the pipeline
    logger.warn('[Cielo] getTopTraders failed — source will be skipped', {
      error: err.message,
    });
    return [];
  }
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — FEED DISCOVERY
// ────────────────────────────────────────────────────────────

/**
 * Discover active trader wallets from Cielo feed.
 * Pulls recent high-value Solana swaps and extracts unique addresses.
 *
 * @param {string} apiKey
 * @returns {Promise<string[]>} Array of unique wallet addresses
 * @private
 */
async function _discoverWalletsFromFeed(apiKey) {
  try {
    // Try multiple param combos — narrow first, then progressively broader
    const paramSets = [
      { chains: 'solana', txTypes: 'swap', minUSD: MIN_SWAP_USD, limit: 100 },
      { chains: 'solana', txTypes: 'swap', limit: 100 },           // drop minUSD
      { chains: 'solana', limit: 100 },                             // drop txTypes too
    ];

    let items = [];

    for (const params of paramSets) {
      try {
        const response = await axios.get(`${CIELO_BASE}/feed`, {
          params,
          headers: _headers(apiKey),
          timeout: REQUEST_TIMEOUT,
        });

        // Cielo returns { status, data: { items: [...], paging: {...} }, message }
        // response.data is the axios body, response.data.data is the API "data" field
        const body = response.data;
        items = body?.data?.items
             || body?.items
             || (Array.isArray(body?.data) ? body.data : [])
             || [];

        // Log actual response shape at INFO level so we can debug in production
        logger.info('[Cielo] Feed response shape', {
          status:      body?.status,
          message:     body?.message || 'N/A',
          topKeys:     Object.keys(body || {}),
          dataType:    typeof body?.data,
          dataKeys:    body?.data && typeof body.data === 'object' ? Object.keys(body.data).slice(0, 8) : 'N/A',
          itemCount:   Array.isArray(items) ? items.length : 'not-array',
          firstItemKeys: Array.isArray(items) && items[0]
            ? Object.keys(items[0]).slice(0, 15)
            : 'none',
          firstItemSample: Array.isArray(items) && items[0]
            ? JSON.stringify(items[0]).slice(0, 300)
            : 'N/A',
          params,
        });

        if (Array.isArray(items) && items.length > 0) break;
      } catch (err) {
        logger.info('[Cielo] Feed request failed for param set', {
          params,
          status: err.response?.status,
          error:  err.message,
          body:   JSON.stringify(err.response?.data)?.slice(0, 200),
        });
      }

      // Small delay before trying next param set
      await _sleep(500);
    }

    if (!Array.isArray(items) || items.length === 0) {
      logger.info('[Cielo] Feed returned empty results after all param sets');
      return [];
    }

    // Extract unique wallet addresses with stats from feed items
    // Cielo feed items may use various field names for the wallet address
    const walletMap = new Map(); // addr → { count, totalUSD, tokens, lastSeen }
    for (const item of items) {
      const addr = item.wallet || item.wallet_address || item.from_address
                || item.from || item.address || item.sender || item.owner
                || item.maker || item.maker_address || item.trader;
      if (!addr || typeof addr !== 'string' || addr.length < 30) continue;

      const usdValue = parseFloat(
        item.amount_usd || item.token0_amount_usd || item.value_usd || item.usd_value || 0
      );
      const token = item.token0_symbol || item.token_symbol || item.symbol || null;
      const timestamp = item.timestamp ? new Date(
        typeof item.timestamp === 'number' && item.timestamp < 1e12
          ? item.timestamp * 1000
          : item.timestamp
      ) : null;

      if (!walletMap.has(addr)) {
        walletMap.set(addr, {
          count: 0, totalUSD: 0, tokens: new Set(), lastSeen: null,
        });
      }
      const entry = walletMap.get(addr);
      entry.count += 1;
      entry.totalUSD += usdValue;
      if (token) entry.tokens.add(token);
      if (timestamp && (!entry.lastSeen || timestamp > entry.lastSeen)) {
        entry.lastSeen = timestamp;
      }
    }

    logger.info('[Cielo] Wallets extracted from feed', {
      totalItems:    items.length,
      uniqueWallets: walletMap.size,
      sampleAddrs:   [...walletMap.keys()].slice(0, 3).map(a => a.slice(0, 8) + '...'),
    });

    // If we got items but no wallet addresses, log the field names so we can fix extraction
    if (items.length > 0 && walletMap.size === 0) {
      logger.warn('[Cielo] Got feed items but could not extract wallet addresses!', {
        itemCount:   items.length,
        sampleKeys:  items[0] ? Object.keys(items[0]) : [],
        sampleItem:  items[0] ? JSON.stringify(items[0]).slice(0, 400) : 'N/A',
      });
    }

    // Sort by frequency (most active first) and return top N with feed stats
    return [...walletMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_WALLETS)
      .map(([addr, stats]) => ({
        address: addr,
        feedStats: {
          tradeCount:      stats.count,
          tradesPerDay:    parseFloat((stats.count / 7).toFixed(1)),
          avgSwapUSD:      stats.count > 0 ? stats.totalUSD / stats.count : 0,
          estimatedPnlUSD: 0,  // Can't determine PnL from feed alone
          tokens:          [...stats.tokens].slice(0, 5),
          lastSeen:        stats.lastSeen,
          quality:         Math.min(100, 25 + (stats.count > 3 ? 15 : 0) + (stats.tokens.size > 1 ? 15 : 0) + (stats.totalUSD > 1000 ? 15 : 0)),
        },
      }));

  } catch (err) {
    logger.warn('[Cielo] Feed discovery failed', {
      error:  err.message,
      status: err.response?.status,
    });
    return [];
  }
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — WALLET ENRICHMENT
// ────────────────────────────────────────────────────────────

/**
 * Fetch PnL stats for a single wallet from Cielo.
 *
 * @param {string} apiKey
 * @param {string} address
 * @returns {Promise<object|null>}
 * @private
 */
async function _fetchWalletStats(apiKey, address) {
  try {
    const response = await axios.get(
      `${CIELO_BASE}/${address}/pnl/total-stats`,
      {
        params: { chains: 'solana' },
        headers: _headers(apiKey),
        timeout: REQUEST_TIMEOUT,
      }
    );

    const data = response.data?.data || response.data;
    if (!data) return null;

    return _normaliseStats(data, address);
  } catch (err) {
    // 404 or similar — wallet may not have enough data
    logger.debug('[Cielo] Wallet stats failed', {
      address: address.slice(0, 8) + '...',
      error:   err.message,
    });
    return null;
  }
}

/**
 * Normalise Cielo PnL response into a consistent shape.
 *
 * @param {object} data
 * @param {string} address
 * @returns {object}
 * @private
 */
function _normaliseStats(data, address) {
  const pnl7d  = parseFloat(data.pnl_7d  || data.realized_pnl_7d  || data.pnl7d  || 0);
  const pnl30d = parseFloat(data.pnl_30d || data.realized_pnl_30d || data.pnl30d || 0);

  const wins    = parseInt(data.wins    || data.win_count    || 0);
  const losses  = parseInt(data.losses  || data.loss_count   || 0);
  const total   = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  const trades7d  = parseInt(data.trades_7d  || data.trade_count_7d  || total || 0);
  const trades30d = parseInt(data.trades_30d || data.trade_count_30d || 0);

  const tradesPerDay = trades7d > 0 ? parseFloat((trades7d / 7).toFixed(1)) : 0;
  const estCapSOL    = parseFloat(data.portfolio_sol || data.total_value_sol || 0);

  // Top tokens from PnL breakdown if available
  const tokens = data.tokens || data.top_tokens || [];
  const topTokens = Array.isArray(tokens)
    ? tokens.slice(0, 5).map(t => t.mint || t.address || t.token).filter(Boolean)
    : [];

  const lastActiveAt = data.last_active
    ? new Date(data.last_active)
    : data.last_active_timestamp
      ? new Date(data.last_active_timestamp * 1000)
      : null;

  // Data quality: higher if we got meaningful data back
  let quality = 30;
  if (pnl7d !== 0)  quality += 20;
  if (total > 5)    quality += 20;
  if (winRate > 0)  quality += 15;
  if (estCapSOL > 0) quality += 15;

  return {
    pnl7d,
    pnl30d,
    winRate:      parseFloat(winRate.toFixed(2)),
    trades7d,
    trades30d,
    tradesPerDay,
    estCapSOL:    parseFloat(estCapSOL.toFixed(2)),
    topTokens,
    lastActiveAt,
    dataQuality:  Math.min(100, quality),
  };
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Build Cielo API request headers.
 *
 * @param {string} apiKey
 * @returns {object}
 * @private
 */
function _headers(apiKey) {
  return {
    'X-API-KEY': apiKey,
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
};
