// ============================================================
//  SOL SYSTEMS — Cielo Wallet Data Source
//  File: src/ai/dataSources/cielo.js
//
//  Third data source for the wallet intelligence pipeline.
//  Cielo.finance provides on-chain analytics with a public API
//  that exposes top Solana trader wallets and their stats.
//
//  Used as a fallback when Birdeye or GMGN return sparse data.
//  Returns the same WalletCandidate shape as the other sources
//  so the aggregator can merge seamlessly.
//
//  API docs: https://docs.cielo.finance/api-reference
//  Rate limit: ~60 req/min on free tier
// ============================================================

'use strict';

const axios  = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const CIELO_BASE      = 'https://api.cielo.finance/v1';
const REQUEST_TIMEOUT = 20_000;
const DELAY_BETWEEN   = 400;      // ms between sequential calls
const MAX_WALLETS     = 20;

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Fetch top trader wallets from Cielo leaderboard.
 * Returns array of wallet candidates with performance stats.
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

  logger.info('[Cielo] Fetching top traders...');

  try {
    // ── Fetch top PnL wallets ────────────────────────────
    const response = await axios.get(`${CIELO_BASE}/solana/top-traders`, {
      params: {
        timeframe: '7d',
        sort:      'pnl',
        order:     'desc',
        limit:     MAX_WALLETS,
      },
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept':        'application/json',
      },
      timeout: REQUEST_TIMEOUT,
    });

    const traders = response.data?.data || response.data?.traders || [];
    if (!Array.isArray(traders) || traders.length === 0) {
      logger.warn('[Cielo] Leaderboard returned no results');
      return [];
    }

    logger.info('[Cielo] Leaderboard fetched', { count: traders.length });

    // ── Normalise into WalletCandidate shape ─────────────
    const candidates = [];

    for (const trader of traders.slice(0, MAX_WALLETS)) {
      try {
        const address = trader.address || trader.wallet_address || trader.owner;
        if (!address) continue;

        candidates.push({
          address,
          source:          'cielo',
          pnl7dUSD:        parseFloat(trader.pnl_7d   || trader.pnl   || 0),
          pnl30dUSD:       parseFloat(trader.pnl_30d  || 0),
          winRatePct:      parseFloat(trader.win_rate  || trader.winrate || 0) * 100,
          totalTrades7d:   parseInt(trader.trade_count || trader.trades || 0),
          totalTrades30d:  parseInt(trader.trade_count_30d || 0),
          tradesPerDay:    parseFloat(trader.trades_per_day || 0),
          avgHoldTimeMs:   parseFloat(trader.avg_hold_time || 0) * 1000,
          estimatedCapSOL: parseFloat(trader.estimated_capital || trader.portfolio_sol || 0),
          topTokens:       (trader.top_tokens || []).slice(0, 5).map(t => t.mint || t.address).filter(Boolean),
          lastActiveAt:    trader.last_active ? new Date(trader.last_active) : null,
          smartMoneyLabel: trader.label || null,
          dataQuality:     60,  // Moderate confidence — single-source unverified
        });

        await _sleep(DELAY_BETWEEN);
      } catch (err) {
        logger.debug('[Cielo] Failed to normalise trader', {
          error: err.message,
        });
      }
    }

    logger.info('[Cielo] Enrichment complete', { enriched: candidates.length });
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
//  HELPERS
// ────────────────────────────────────────────────────────────

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
