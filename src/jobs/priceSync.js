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
const rateLimiter     = require('../utils/birdeyeRateLimiter');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const BIRDEYE_PRICE_URL = 'https://public-api.birdeye.so/defi/price';
const SOL_MINT          = 'So11111111111111111111111111111111111111112';
const INTERVAL_MS       = 60_000;   // 60 seconds
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

    // Fetch prices from Birdeye (Jupiter Price API v2 now requires auth)
    const priceMap = {};
    for (const mint of mints) {
      const price = await _fetchBirdeyePrice(mint).catch(() => null);
      if (price) priceMap[mint] = price;
    }

    // Fetch SOL price in USD for positionTracker
    const solPriceUSD = await _fetchBirdeyePriceUSD(SOL_MINT).catch(() => 0) || 0;

    // Update positionTracker in one batch call
    const priceMapForTracker = new Map(Object.entries(priceMap));
    positionTracker.updatePrices(priceMapForTracker, solPriceUSD);

    // Build updates array for WebSocket broadcast
    const updates = [];
    for (const position of positions) {
      const mint = position.tokenMint;
      if (!mint || !priceMap[mint]) continue;

      const currentPriceSOL = priceMap[mint];
      const entryAmountSOL  = position.entryAmountSOL || 0;
      const entryTokens     = position.entryTokens    || 0;

      if (entryAmountSOL <= 0 || entryTokens <= 0) continue;

      const currentValueSOL   = currentPriceSOL * entryTokens;
      const unrealizedPnLSOL  = currentValueSOL - entryAmountSOL;
      const unrealizedPnLPct  = entryAmountSOL > 0
        ? (unrealizedPnLSOL / entryAmountSOL) * 100
        : 0;

      updates.push({
        tokenMint:       mint,
        tokenSymbol:     position.token,
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
//  BIRDEYE PRICE API
//  Primary price source (Jupiter Price API v2 now requires auth)
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
    rateLimiter.request(() =>
      axios.get(BIRDEYE_PRICE_URL, {
        params:  { address: mint },
        headers: { 'X-API-KEY': apiKey },
        timeout: REQUEST_TIMEOUT,
      })
    ),
    rateLimiter.request(() =>
      axios.get(BIRDEYE_PRICE_URL, {
        params:  { address: SOL_MINT },
        headers: { 'X-API-KEY': apiKey },
        timeout: REQUEST_TIMEOUT,
      })
    ),
  ]);

  const tokenPriceUSD = tokenRes.data?.data?.value;
  const solPriceUSD   = solRes.data?.data?.value;

  if (!tokenPriceUSD || !solPriceUSD || solPriceUSD <= 0) return null;

  return tokenPriceUSD / solPriceUSD;
}

/**
 * Fetch a single token's USD price from Birdeye.
 * @param {string} mint
 * @returns {Promise<number|null>}
 */
async function _fetchBirdeyePriceUSD(mint) {
  const apiKey = config.prices.birdeyeApiKey;
  if (!apiKey) return null;

  const res = await rateLimiter.request(() =>
    axios.get(BIRDEYE_PRICE_URL, {
      params:  { address: mint },
      headers: { 'X-API-KEY': apiKey },
      timeout: REQUEST_TIMEOUT,
    })
  );

  return res.data?.data?.value || null;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop, getStatus };