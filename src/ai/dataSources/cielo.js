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
const MIN_SWAP_USD    = 500;      // Only consider swaps ≥ $500

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
      count: walletAddresses.length,
    });

    // ── Step 2: Enrich each wallet with PnL stats ──────────
    const candidates = [];

    for (const address of walletAddresses.slice(0, MAX_WALLETS)) {
      try {
        await _sleep(DELAY_BETWEEN);
        const stats = await _fetchWalletStats(apiKey, address);

        if (stats) {
          candidates.push({
            address,
            source:          'cielo',
            pnl7dUSD:        stats.pnl7d    || 0,
            pnl30dUSD:       stats.pnl30d   || 0,
            winRatePct:      stats.winRate   || 0,
            totalTrades7d:   stats.trades7d  || 0,
            totalTrades30d:  stats.trades30d || 0,
            tradesPerDay:    stats.tradesPerDay || 0,
            avgHoldTimeMs:   0,
            estimatedCapSOL: stats.estCapSOL || 0,
            topTokens:       stats.topTokens || [],
            lastActiveAt:    stats.lastActiveAt || null,
            smartMoneyLabel: null,
            dataQuality:     stats.dataQuality || 50,
          });
        }
      } catch (err) {
        logger.debug('[Cielo] Failed to enrich wallet', {
          address: address.slice(0, 8) + '...',
          error:   err.message,
        });
      }
    }

    logger.info('[Cielo] Enrichment complete', {
      discovered: walletAddresses.length,
      enriched:   candidates.length,
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
    const response = await axios.get(`${CIELO_BASE}/feed`, {
      params: {
        chains:   'solana',
        txTypes:  'swap',
        minUSD:   MIN_SWAP_USD,
        limit:    100,
      },
      headers: _headers(apiKey),
      timeout: REQUEST_TIMEOUT,
    });

    const items = response.data?.data || response.data?.items || response.data || [];

    if (!Array.isArray(items) || items.length === 0) {
      logger.debug('[Cielo] Feed returned empty results');
      return [];
    }

    // Extract unique wallet addresses, count occurrences for ranking
    const walletCounts = new Map();
    for (const item of items) {
      const addr = item.wallet || item.address || item.sender || item.from;
      if (addr && typeof addr === 'string' && addr.length > 30) {
        walletCounts.set(addr, (walletCounts.get(addr) || 0) + 1);
      }
    }

    // Sort by frequency (most active first) and return top N
    return [...walletCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_WALLETS)
      .map(([addr]) => addr);

  } catch (err) {
    logger.warn('[Cielo] Feed discovery failed', { error: err.message });
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
