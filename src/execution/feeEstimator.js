// ============================================================
//  SOL SYSTEMS — Dynamic Priority Fee Estimator
//  File: src/execution/feeEstimator.js
//
//  Uses Helius getRecentPrioritizationFees to dynamically set
//  the optimal priority fee for each transaction based on
//  real-time network conditions.
//
//  Instead of a static 100,000 microlamports, we calculate
//  the 75th percentile of recent fees and use that.
//  This ensures fast inclusion without overpaying.
//
//  Cached for 30 seconds to avoid spamming the RPC.
// ============================================================

'use strict';

const { getConnection } = require('../utils/solana');
const logger             = require('../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const DEFAULT_FEE_MICROLAMPORTS = 100_000;    // Fallback if estimation fails
const MAX_FEE_MICROLAMPORTS     = 500_000;    // Never pay more than this
const MIN_FEE_MICROLAMPORTS     = 10_000;     // Floor — always pay at least this
const CACHE_TTL_MS              = 30_000;     // 30 second cache

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _cachedFee    = DEFAULT_FEE_MICROLAMPORTS;
let _cachedAt     = 0;

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Get the recommended priority fee in microlamports per compute unit.
 * Uses cached value if fresh enough, otherwise fetches from RPC.
 *
 * @returns {Promise<number>} Fee in microlamports
 */
async function getRecommendedFee() {
  const now = Date.now();

  // Return cached value if fresh
  if (now - _cachedAt < CACHE_TTL_MS) {
    return _cachedFee;
  }

  try {
    const connection = getConnection();

    // getRecentPrioritizationFees returns fees for the last 150 slots
    const feeData = await connection.getRecentPrioritizationFees();

    if (!feeData || feeData.length === 0) {
      return DEFAULT_FEE_MICROLAMPORTS;
    }

    // Extract non-zero fees and sort ascending
    const fees = feeData
      .map(f => f.prioritizationFee)
      .filter(f => f > 0)
      .sort((a, b) => a - b);

    if (fees.length === 0) {
      _cachedFee = MIN_FEE_MICROLAMPORTS;
      _cachedAt  = now;
      return _cachedFee;
    }

    // Use 75th percentile for competitive but not excessive pricing
    const p75Index = Math.floor(fees.length * 0.75);
    const p75Fee   = fees[p75Index] || fees[fees.length - 1];

    // Clamp between min and max
    _cachedFee = Math.max(MIN_FEE_MICROLAMPORTS, Math.min(p75Fee, MAX_FEE_MICROLAMPORTS));
    _cachedAt  = now;

    logger.debug('[Fees] Priority fee updated', {
      p75:     p75Fee,
      clamped: _cachedFee,
      samples: fees.length,
      median:  fees[Math.floor(fees.length / 2)],
    });

    return _cachedFee;

  } catch (err) {
    logger.debug('[Fees] Fee estimation failed — using default', { error: err.message });
    return DEFAULT_FEE_MICROLAMPORTS;
  }
}

/**
 * Get the current cached fee without making an RPC call.
 * Useful for logging/display without adding latency.
 *
 * @returns {number}
 */
function getCurrentFee() {
  return _cachedFee;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { getRecommendedFee, getCurrentFee };
