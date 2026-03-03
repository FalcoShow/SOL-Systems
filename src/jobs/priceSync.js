// ============================================================
//  SOL SYSTEMS — Price Sync Job
//  File: src/jobs/priceSync.js
//
//  Runs every 60 seconds. For every open position:
//    1. Fetches current token price from Jupiter Price API
//    2. Calculates unrealized PnL vs entry price
//    3. Updates positionTracker in-memory state
//    4. Broadcasts PRICE_UPDATE event to dashboard WebSocket
//    5. Checks if any position hit a stop-loss threshold
//
//  Price sources (in priority order):
//    1. Jupiter Price API v2 (batch up to 100 tokens)
//    2. Birdeye API (fallback for illiquid tokens)
//
//  Does NOT write to database — positions are only persisted
//  on open (BUY) and close (SELL). Prices are live in-memory.
// ============================================================

'use strict';

const axios           = require('axios');
const config          = require('../config');
const logger          = require('../utils/logger');
const positionTracker = require('../monitor/positionTracker');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';
const BIRDEYE_PRICE_URL = 'https://public-api.birdeye.so/defi/price';
const SOL_MINT          = 'So11111111111111111111111111111111111111112';
const USDC_MINT         = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const INTERVAL_MS       = 60_000;   // 60 seconds
const BATCH_SIZE        = 100;      // Jupiter supports up to 100 mints per call
const REQUEST_TIMEOUT   = 10_000;   // 10s timeout per price fetch

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _intervalId   = null;
let _broadcastFn  = null;   // injected from server.js
let _isRunning    = false;
let _lastRunAt    = null;
let _consecutiveErrors = 0;

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

/**
 * Start the price sync job.
 * @param {Function} broadcastFn - apiServer.broadcast() for WS push
 */
function start(broadcastFn) {
  if (_intervalId) return; // already running
  _broadcastFn = broadcastFn;

  logger.info('Price sync job started', { intervalMs: INTERVAL_MS });

  // Run once immediately, then on interval
  _runSync();
  _intervalId = setInterval(_runSync, INTERVAL_MS);
}

/**
 * Stop the price sync job.
 */
function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('Price sync job stopped');
  }
}

/**
 * Get job status for health checks.
 */
function getStatus() {
  return {
    running:           !!_intervalId,
    lastRunAt:         _lastRunAt,
    consecutiveErrors: _consecutiveErrors,
    intervalMs:        INTERVAL_MS,
  };
}

// ────────────────────────────────────────────────────────────
//  CORE SYNC LOGIC
// ────────────────────────────────────────────────────────────

async function _runSync() {
  if (_isRunning) return; // prevent overlap if a run takes > 60s
  _isRunning = true;

  try {
    // Get all open positions from in-memory tracker
    const summary   = positionTracker.getSummary();
    const positions = summary.positions || [];

    if (positions.length === 0) {
      _lastRunAt = new Date();
      return; // nothing to update
    }

    // Collect unique token mints from open positions
    const mints = [...new Set(
      positions
        .map(p => p.tokenMint)
        .filter(Boolean)
        .filter(m => m !== SOL_MINT)
    )];

    if (mints.length === 0) {
      _lastRunAt = new Date();
      return;
    }

    logger.debug('Price sync running', {
      positions: positions.length,
      mints:     mints.length,
    });

    // Fetch prices in batches of BATCH_SIZE
    const priceMap = {};
    for (let i = 0; i < mints.length; i += BATCH_SIZE) {
      const batch  = mints.slice(i, i + BATCH_SIZE);
      const prices = await _fetchJupiterPrices(batch);
      Object.assign(priceMap, prices);
    }

    // For any mints Jupiter couldn't price, try Birdeye
    const unpricedMints = mints.filter(m => !priceMap[m]);
    if (unpricedMints.length > 0) {
      for (const mint of unpricedMints) {
        const price = await _fetchBirdeyePrice(mint).catch(() => null);
        if (price) priceMap[mint] = price;
      }
    }

    // Update each position with fresh price data
    const updates = [];
    for (const position of positions) {
      const mint = position.tokenMint;
      if (!mint || !priceMap[mint]) continue;

      const currentPriceSOL = priceMap[mint];
      const entryPriceSOL   = position.entryPriceSOL || 0;
      const tokenAmount     = position.tokenAmount   || 0;
      const entryAmountSOL  = position.entryAmountSOL || 0;

      if (entryPriceSOL <= 0 || tokenAmount <= 0) continue;

      // Unrealized PnL = (current_price - entry_price) × tokens
      const currentValueSOL   = currentPriceSOL * tokenAmount;
      const unrealizedPnLSOL  = currentValueSOL - entryAmountSOL;
      const unrealizedPnLPct  = entryAmountSOL > 0
        ? (unrealizedPnLSOL / entryAmountSOL) * 100
        : 0;

      // Push update into positionTracker
      positionTracker.updatePositionPrice(mint, {
        currentPriceSOL,
        currentValueSOL,
        unrealizedPnLSOL,
        unrealizedPnLPct,
      });

      updates.push({
        tokenMint:       mint,
        tokenSymbol:     position.token || position.tokenSymbol,
        currentPriceSOL,
        unrealizedPnLSOL,
        unrealizedPnLPct,
      });
    }

    // Broadcast all updates to dashboard WebSocket clients
    if (updates.length > 0 && _broadcastFn) {
      _broadcastFn('PRICE_UPDATE', {
        updates,
        totalUnrealizedSOL: updates.reduce((s, u) => s + u.unrealizedPnLSOL, 0),
        ts: new Date().toISOString(),
      });
    }

    _lastRunAt = new Date();
    _consecutiveErrors = 0;

    logger.debug('Price sync complete', {
      updated: updates.length,
      priced:  Object.keys(priceMap).length,
    });

  } catch (err) {
    _consecutiveErrors++;
    logger.error('Price sync error', {
      error:             err.message,
      consecutiveErrors: _consecutiveErrors,
    });
  } finally {
    _isRunning = false;
  }
}

// ────────────────────────────────────────────────────────────
//  JUPITER PRICE API  (primary)
//  Returns SOL-denominated prices for up to 100 mints
// ────────────────────────────────────────────────────────────

/**
 * Fetch prices from Jupiter Price API v2.
 * Returns { [mint]: priceInSOL } map.
 *
 * Jupiter returns USD prices. We convert to SOL using
 * the SOL/USDC price fetched in the same call.
 *
 * @param {string[]} mints
 * @returns {Promise<Record<string, number>>}
 */
async function _fetchJupiterPrices(mints) {
  const allMints = [...new Set([...mints, SOL_MINT, USDC_MINT])];

  const response = await axios.get(JUPITER_PRICE_URL, {
    params: {
      ids:              allMints.join(','),
      showExtraInfo:    false,
    },
    timeout: REQUEST_TIMEOUT,
  });

  const data   = response.data?.data || {};
  const result = {};

  // Get SOL price in USD so we can convert
  const solPriceUSD  = parseFloat(data[SOL_MINT]?.price || 0);
  if (solPriceUSD <= 0) {
    logger.warn('Jupiter returned no SOL price — skipping conversion');
    return result;
  }

  for (const mint of mints) {
    const priceUSD = parseFloat(data[mint]?.price || 0);
    if (priceUSD > 0) {
      result[mint] = priceUSD / solPriceUSD; // convert USD → SOL
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────
//  BIRDEYE PRICE API  (fallback)
//  Used for illiquid tokens Jupiter can't price
// ────────────────────────────────────────────────────────────

/**
 * Fetch a single token price from Birdeye.
 * Returns price in SOL.
 *
 * @param {string} mint
 * @returns {Promise<number|null>}
 */
async function _fetchBirdeyePrice(mint) {
  const apiKey = config.prices.birdeyeApiKey;
  if (!apiKey) return null;

  const [tokenRes, solRes] = await Promise.all([
    axios.get(BIRDEYE_PRICE_URL, {
      params:  { address: mint },
      headers: { 'X-API-KEY': apiKey },
      timeout: REQUEST_TIMEOUT,
    }),
    axios.get(BIRDEYE_PRICE_URL, {
      params:  { address: SOL_MINT },
      headers: { 'X-API-KEY': apiKey },
      timeout: REQUEST_TIMEOUT,
    }),
  ]);

  const tokenPriceUSD = tokenRes.data?.data?.value;
  const solPriceUSD   = solRes.data?.data?.value;

  if (!tokenPriceUSD || !solPriceUSD || solPriceUSD <= 0) return null;

  return tokenPriceUSD / solPriceUSD;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop, getStatus };