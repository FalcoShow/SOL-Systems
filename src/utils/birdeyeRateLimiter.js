// ============================================================
//  SOL SYSTEMS — Birdeye Rate Limiter
//  File: src/utils/birdeyeRateLimiter.js
//
//  Shared sliding-window rate limiter for all Birdeye API calls.
//  Prevents 429 errors by enforcing a global request-per-minute
//  budget across all consumers (priceSync, riskManager, intelligence).
//
//  Even with the paid Starter plan (300 RPM), this provides a
//  safety net against accidental rate limit abuse.
//
//  Usage:
//    const limiter = require('../utils/birdeyeRateLimiter');
//    const response = await limiter.request(() => axios.get(...));
// ============================================================

'use strict';

const logger = require('./logger');

// ────────────────────────────────────────────────────────────
//  CONFIGURATION
// ────────────────────────────────────────────────────────────

// Birdeye Lite ($39/mo) = 15 RPS = 900 RPM.
// Free tier = ~60 RPM.
// We cap at 200 RPM by default to stay well under limits.
// Override with BIRDEYE_RPM_LIMIT env var if needed.
const MAX_REQUESTS_PER_MINUTE = parseInt(process.env.BIRDEYE_RPM_LIMIT || '200', 10);
const MIN_INTERVAL_MS         = Math.ceil(60_000 / MAX_REQUESTS_PER_MINUTE); // ~300ms at 200 RPM
const WINDOW_MS               = 60_000;

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

const _timestamps = [];  // Sliding window of recent request timestamps
let _queue = [];         // Pending requests waiting for capacity
let _processing = false;

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

/**
 * Execute an async function with rate limiting.
 * Queues the call if the rate limit would be exceeded.
 *
 * @param {Function} fn - Async function to execute (should return a Promise)
 * @returns {Promise<*>} Result of fn()
 */
function request(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject });
    _processQueue();
  });
}

/**
 * Get current limiter stats for health checks.
 */
function getStats() {
  _pruneWindow();
  return {
    recentRequests:       _timestamps.length,
    maxPerMinute:         MAX_REQUESTS_PER_MINUTE,
    minIntervalMs:        MIN_INTERVAL_MS,
    queuedRequests:       _queue.length,
    capacityRemaining:    MAX_REQUESTS_PER_MINUTE - _timestamps.length,
  };
}

// ────────────────────────────────────────────────────────────
//  INTERNAL
// ────────────────────────────────────────────────────────────

function _pruneWindow() {
  const cutoff = Date.now() - WINDOW_MS;
  while (_timestamps.length > 0 && _timestamps[0] < cutoff) {
    _timestamps.shift();
  }
}

async function _processQueue() {
  if (_processing) return;
  _processing = true;

  while (_queue.length > 0) {
    _pruneWindow();

    // Check capacity
    if (_timestamps.length >= MAX_REQUESTS_PER_MINUTE) {
      // Wait until oldest request falls out of the window
      const waitMs = (_timestamps[0] + WINDOW_MS) - Date.now() + 50; // +50ms buffer
      if (waitMs > 0) {
        logger.debug('[BirdeyeLimiter] Rate limit reached, waiting', {
          waitMs,
          queued: _queue.length,
        });
        await _sleep(waitMs);
        continue;
      }
    }

    // Enforce minimum interval between requests
    const lastTs = _timestamps[_timestamps.length - 1] || 0;
    const sinceLast = Date.now() - lastTs;
    if (sinceLast < MIN_INTERVAL_MS) {
      await _sleep(MIN_INTERVAL_MS - sinceLast);
    }

    // Execute next queued request
    const { fn, resolve, reject } = _queue.shift();
    _timestamps.push(Date.now());

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      // If we got 429, back off for 3 seconds
      if (err.response?.status === 429) {
        logger.warn('[BirdeyeLimiter] Got 429 despite limiter — backing off 3s');
        await _sleep(3000);
      }
      reject(err);
    }
  }

  _processing = false;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { request, getStats };
