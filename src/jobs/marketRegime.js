// ============================================================
//  SOL SYSTEMS — Market Regime Detector
//  File: src/jobs/marketRegime.js
//
//  Monitors SOL price every 5 minutes and determines the
//  current market regime. The regime adjusts position sizing
//  and stop-loss behavior system-wide.
//
//  Regimes:
//    PANIC      — SOL dropped 10%+ in 1hr → pause new buys
//    DEFENSIVE  — SOL dropped 5-10% in 1hr → halve position sizes
//    NORMAL     — default operation
//    AGGRESSIVE — SOL rose 5%+ in 1hr → slightly larger positions
//
//  Other modules read the current regime via getRegime()
//  and apply a multiplier to their position sizing.
// ============================================================

'use strict';

const { getSOLPrice } = require('../utils/solana');
const logger          = require('../utils/logger');
const tradeRepository = require('../execution/tradeRepository');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 5 * 60 * 1000;  // Every 5 minutes
const PRICE_HISTORY_WINDOW = 12;           // Keep last 12 samples (1 hour at 5min intervals)

// Regime thresholds (percentage change over 1 hour)
const PANIC_THRESHOLD      = -10;
const DEFENSIVE_THRESHOLD  = -5;
const AGGRESSIVE_THRESHOLD = 5;

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _intervalId    = null;
let _sendFn        = null;
let _currentRegime = 'NORMAL';
let _priceHistory  = []; // { price: number, time: number }[]
let _lastNotifiedRegime = 'NORMAL';

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

function start(sendFn) {
  if (_intervalId) return;
  _sendFn = sendFn || null;
  _intervalId = setInterval(_checkRegime, CHECK_INTERVAL_MS);
  // Do an initial check immediately
  _checkRegime();
  logger.info('[Regime] Market regime detector started');
}

function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('[Regime] Market regime detector stopped');
  }
}

/**
 * Get the current market regime.
 * @returns {'PANIC' | 'DEFENSIVE' | 'NORMAL' | 'AGGRESSIVE'}
 */
function getRegime() {
  return _currentRegime;
}

/**
 * Get the position size multiplier for the current regime.
 * @returns {number} Multiplier (0 = don't trade, 0.5 = half size, 1.0 = normal, 1.15 = aggressive)
 */
function getMultiplier() {
  switch (_currentRegime) {
    case 'PANIC':      return 0;      // No new buys
    case 'DEFENSIVE':  return 0.5;    // Half size
    case 'AGGRESSIVE': return 1.25;   // Larger positions — SOL pumping = meme coin alpha
    default:           return 1.0;    // Normal
  }
}

/**
 * Get regime status for health checks.
 */
function getStatus() {
  return {
    regime:       _currentRegime,
    multiplier:   getMultiplier(),
    priceHistory: _priceHistory.length,
    lastPrice:    _priceHistory.length > 0 ? _priceHistory[_priceHistory.length - 1].price : null,
  };
}

// ────────────────────────────────────────────────────────────
//  CORE LOGIC
// ────────────────────────────────────────────────────────────

async function _checkRegime() {
  try {
    const currentPrice = await getSOLPrice().catch(() => 0);
    if (!currentPrice || currentPrice <= 0) return;

    const now = Date.now();
    _priceHistory.push({ price: currentPrice, time: now });

    // Trim to window size
    if (_priceHistory.length > PRICE_HISTORY_WINDOW) {
      _priceHistory = _priceHistory.slice(-PRICE_HISTORY_WINDOW);
    }

    // Need at least 2 data points (10 minutes) to determine trend
    if (_priceHistory.length < 2) return;

    // Calculate 1-hour change (or whatever history we have)
    const oldest = _priceHistory[0];
    const changePct = ((currentPrice - oldest.price) / oldest.price) * 100;

    // Determine regime
    let newRegime = 'NORMAL';
    if (changePct <= PANIC_THRESHOLD) {
      newRegime = 'PANIC';
    } else if (changePct <= DEFENSIVE_THRESHOLD) {
      newRegime = 'DEFENSIVE';
    } else if (changePct >= AGGRESSIVE_THRESHOLD) {
      newRegime = 'AGGRESSIVE';
    }

    // If regime changed, log and optionally pause trading
    if (newRegime !== _currentRegime) {
      const prev = _currentRegime;
      _currentRegime = newRegime;

      logger.warn('[Regime] Market regime changed', {
        from: prev, to: newRegime,
        changePct: changePct.toFixed(2) + '%',
        solPrice: currentPrice.toFixed(2),
        multiplier: getMultiplier(),
      });

      // Auto-pause on PANIC
      if (newRegime === 'PANIC') {
        try {
          await tradeRepository.pauseTrading('Market regime: PANIC — SOL dropped ' + changePct.toFixed(1) + '% in 1hr');
        } catch (_) {}
      }

      // Auto-resume when leaving PANIC
      if (prev === 'PANIC' && newRegime !== 'PANIC') {
        try {
          const settings = await tradeRepository.getSettings();
          if (settings.pauseReason?.includes('Market regime: PANIC')) {
            await tradeRepository.resumeTrading();
            logger.info('[Regime] Auto-resumed trading after PANIC cleared');
          }
        } catch (_) {}
      }

      // Notify on regime changes (but not spam — only when different from last notified)
      if (newRegime !== _lastNotifiedRegime) {
        _lastNotifiedRegime = newRegime;
        _notifyRegimeChange(newRegime, changePct, currentPrice);
      }
    }

  } catch (err) {
    logger.debug('[Regime] Check failed', { error: err.message });
  }
}

async function _notifyRegimeChange(regime, changePct, solPrice) {
  if (!_sendFn) return;
  const emoji = {
    PANIC: '🚨', DEFENSIVE: '🛡️', NORMAL: '✅', AGGRESSIVE: '🚀',
  };

  try {
    await _sendFn('RAW', {
      message:
        `${emoji[regime] || '📊'} *Market Regime: ${regime}*\n\n` +
        `SOL 1hr change: ${changePct.toFixed(1)}%\n` +
        `SOL price: $${solPrice.toFixed(2)}\n` +
        `Position multiplier: ${getMultiplier()}x\n` +
        (regime === 'PANIC' ? '\n_Trading automatically paused._' : ''),
    });
  } catch (_) {}
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop, getRegime, getMultiplier, getStatus };
