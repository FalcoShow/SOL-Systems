// ============================================================
//  SOL SYSTEMS — Risk Management Engine
//  File: src/utils/riskManager.js
//
//  This is the safety net between copy signals and execution.
//  Nothing gets traded unless it passes every check in here.
//
//  Every function returns a consistent shape so the trade
//  executor can handle results without branching on types:
//    { limitHit, reason, ...extras }   — for limit checks
//    { isRug, dropPct, reason }        — for rug detection
//    { drawdownPct, drawdownSOL, ... } — for drawdown
//    { skip, reason }                  — for the master gate
//
//  Functions:
//    - checkDailyLossLimit()  : halt when daily loss cap is hit
//    - checkMaxPositions()    : enforce open position ceiling
//    - detectRugPull()        : identify rapid price collapse
//    - calculateDrawdown()    : measure peak-to-current decline
//    - shouldSkipTrade()      : master gate combining all rules
// ============================================================

'use strict';

const logger = require('./logger');

// ────────────────────────────────────────────────────────────
//  DAILY LOSS LIMIT
//  Halts all new trades for the rest of the day once cumulative
//  losses hit the configured ceiling.
//
//  Why this matters:
//    A bad day of copy trading can spiral fast if the tracked
//    wallet keeps entering losers. This cap gives you a hard
//    stop so you don't blow 30% of your capital in one session.
//
//  todayLossSOL can be stored as positive OR negative — we use
//  Math.abs() so both conventions work correctly.
// ────────────────────────────────────────────────────────────

/**
 * Check whether today's cumulative loss has hit the daily limit.
 *
 * @param {object} params
 * @param {number} params.todayLossSOL      - Total SOL lost today (positive or negative)
 * @param {number} params.dailyLossLimitSOL - Max SOL loss allowed per day (0 = disabled)
 *
 * @returns {{
 *   limitHit:     boolean,
 *   remainingSOL: number,   // SOL budget left before limit (0 if hit)
 *   reason:       string|null
 * }}
 */
function checkDailyLossLimit({ todayLossSOL, dailyLossLimitSOL }) {
  // A limit of 0 means "disabled" — never block trading
  if (!dailyLossLimitSOL || dailyLossLimitSOL === 0) {
    return {
      limitHit:     false,
      remainingSOL: Infinity,
      reason:       null,
    };
  }

  // Normalise — losses may be stored as negative numbers in the DB
  const lossAbs = Math.abs(todayLossSOL || 0);
  const limit   = Math.abs(dailyLossLimitSOL);

  if (lossAbs >= limit) {
    logger.warn('Daily loss limit hit — halting new trades', {
      todayLossSOL: lossAbs.toFixed(4),
      limitSOL:     limit.toFixed(4),
    });
    return {
      limitHit:     true,
      remainingSOL: 0,
      reason:       `Daily loss limit reached — lost ${lossAbs.toFixed(4)} SOL of ${limit.toFixed(4)} SOL limit`,
    };
  }

  const remaining = parseFloat((limit - lossAbs).toFixed(9));

  return {
    limitHit:     false,
    remainingSOL: remaining,
    reason:       null,
  };
}

// ────────────────────────────────────────────────────────────
//  MAX OPEN POSITIONS
//  Prevents opening more concurrent trades than configured.
//
//  Why this matters:
//    Too many open positions means you can't react fast enough
//    to close them in a market-wide sell-off. It also means
//    your capital is spread too thin to matter on any single win.
// ────────────────────────────────────────────────────────────

/**
 * Check whether the open position count is at its ceiling.
 *
 * @param {object} params
 * @param {number} params.currentOpenPositions - How many trades are currently open
 * @param {number} params.maxOpenPositions     - The configured ceiling
 *
 * @returns {{
 *   limitHit:       boolean,
 *   slotsRemaining: number,
 *   reason:         string|null
 * }}
 */
function checkMaxPositions({ currentOpenPositions, maxOpenPositions }) {
  const current = currentOpenPositions || 0;
  const max     = maxOpenPositions     || 10;

  if (current >= max) {
    logger.warn('Max open positions reached', { current, max });
    return {
      limitHit:       true,
      slotsRemaining: 0,
      reason:         `Max open positions reached (${current}/${max})`,
    };
  }

  return {
    limitHit:       false,
    slotsRemaining: max - current,
    reason:         null,
  };
}

// ────────────────────────────────────────────────────────────
//  RUG PULL DETECTION
//  Compares current token price to entry price.
//  If the drop exceeds the threshold, flag for emergency exit.
//
//  Why this matters:
//    Solana meme tokens can go from ATH to zero in minutes.
//    Waiting for a normal stop-loss to trigger can mean losing
//    80-90% instead of 50%. Early rug detection lets you exit
//    before the liquidity fully disappears.
//
//  Note: dropPct is always returned as a positive number
//  representing the magnitude of the fall (e.g. 75 = fell 75%).
//  If price went up, dropPct is 0.
// ────────────────────────────────────────────────────────────

/**
 * Detect whether a token's price has collapsed enough to be a rug pull.
 *
 * @param {object} params
 * @param {number} params.entryPriceSOL       - Price per token when we entered
 * @param {number} params.currentPriceSOL     - Current token price
 * @param {number} params.rugPullThresholdPct - Drop % that triggers the flag (e.g. 50)
 *
 * @returns {{
 *   isRug:   boolean,
 *   dropPct: number,      // How far price has fallen (0 if up)
 *   reason:  string|null
 * }}
 */
function detectRugPull({ entryPriceSOL, currentPriceSOL, rugPullThresholdPct }) {
  const entry     = entryPriceSOL     || 0;
  const current   = currentPriceSOL   || 0;
  const threshold = rugPullThresholdPct || 50;

  // If entry price is zero we can't calculate — don't flag
  if (entry <= 0) {
    return { isRug: false, dropPct: 0, reason: null };
  }

  // Calculate the percentage drop from entry
  // If price went up, drop is 0 (not a rug)
  const rawDrop = ((entry - current) / entry) * 100;
  const dropPct = parseFloat(Math.max(rawDrop, 0).toFixed(4));

  if (dropPct >= threshold) {
    const msg = `Price collapse detected — dropped ${dropPct.toFixed(1)}% from entry (threshold: ${threshold}%)`;
    logger.warn('Rug pull detected', {
      entryPrice:   entry.toFixed(8),
      currentPrice: current.toFixed(8),
      dropPct:      dropPct.toFixed(1),
      threshold,
    });
    return {
      isRug:   true,
      dropPct,
      reason:  msg,
    };
  }

  return {
    isRug:   false,
    dropPct,
    reason:  null,
  };
}

// ────────────────────────────────────────────────────────────
//  DRAWDOWN CALCULATION
//  Measures how far the portfolio has fallen from its all-time
//  high. Used for dashboard health display and Telegram alerts.
//
//  Severity bands:
//    LOW      < 10%   — normal trading variance
//    MEDIUM   < 25%   — worth watching
//    HIGH     < 50%   — consider reducing position sizes
//    CRITICAL >= 50%  — consider pausing until you review
//
//  If current > peak the function returns 0 — the peak should
//  be updated externally when a new high is reached.
// ────────────────────────────────────────────────────────────

/**
 * Calculate the current drawdown from the portfolio's peak value.
 *
 * @param {object} params
 * @param {number} params.peakCapitalSOL    - Highest portfolio value ever recorded
 * @param {number} params.currentCapitalSOL - Current portfolio value
 *
 * @returns {{
 *   drawdownPct: number,
 *   drawdownSOL: number,
 *   severity:    'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'
 * }}
 */
function calculateDrawdown({ peakCapitalSOL, currentCapitalSOL }) {
  const peak    = peakCapitalSOL    || 0;
  const current = currentCapitalSOL || 0;

  // At or above peak — no drawdown
  if (current >= peak || peak === 0) {
    return {
      drawdownPct: 0,
      drawdownSOL: 0,
      severity:    'LOW',
    };
  }

  const drawdownSOL = parseFloat((peak - current).toFixed(9));
  const drawdownPct = parseFloat(((drawdownSOL / peak) * 100).toFixed(4));

  // Severity band
  let severity;
  if      (drawdownPct < 10) severity = 'LOW';
  else if (drawdownPct < 25) severity = 'MEDIUM';
  else if (drawdownPct < 50) severity = 'HIGH';
  else                       severity = 'CRITICAL';

  if (severity === 'HIGH' || severity === 'CRITICAL') {
    logger.warn('Significant drawdown detected', {
      drawdownPct: drawdownPct.toFixed(2),
      drawdownSOL: drawdownSOL.toFixed(4),
      severity,
    });
  }

  return { drawdownPct, drawdownSOL, severity };
}

// ────────────────────────────────────────────────────────────
//  MASTER GATE — shouldSkipTrade()
//  Single call that combines every risk check.
//  The trade executor calls this before every Jupiter swap.
//
//  Check order (priority highest → lowest):
//    1. Trading paused manually
//    2. Daily loss limit
//    3. Max open positions
//    4. Insufficient SOL balance after reserve
//
//  Returns on first failure — stops checking once blocked.
// ────────────────────────────────────────────────────────────

/**
 * Master risk gate — run before every trade execution.
 *
 * @param {object} params
 * @param {boolean} params.isTradingPaused      - Manual pause flag
 * @param {number}  params.todayLossSOL          - SOL lost today
 * @param {number}  params.dailyLossLimitSOL     - Daily loss cap (0 = disabled)
 * @param {number}  params.currentOpenPositions  - Open trades right now
 * @param {number}  params.maxOpenPositions      - Open trade ceiling
 * @param {number}  params.currentBalanceSOL     - Live wallet balance
 * @param {number}  params.minSolReserve         - SOL to keep for gas
 * @param {number}  params.proposedPositionSOL   - Size of the trade we want to make
 *
 * @returns {{
 *   skip:   boolean,
 *   reason: string|null
 * }}
 */
function shouldSkipTrade(params) {
  const {
    isTradingPaused      = false,
    todayLossSOL         = 0,
    dailyLossLimitSOL    = 0,
    currentOpenPositions = 0,
    maxOpenPositions     = 10,
    currentBalanceSOL    = 0,
    minSolReserve        = 0.1,
    proposedPositionSOL  = 0,
  } = params;

  // ── Check 1: Manual pause ────────────────────────────────
  if (isTradingPaused) {
    return { skip: true, reason: 'Trading is paused' };
  }

  // ── Check 2: Daily loss limit ────────────────────────────
  const lossCheck = checkDailyLossLimit({ todayLossSOL, dailyLossLimitSOL });
  if (lossCheck.limitHit) {
    return { skip: true, reason: lossCheck.reason };
  }

  // ── Check 3: Max open positions ──────────────────────────
  const posCheck = checkMaxPositions({ currentOpenPositions, maxOpenPositions });
  if (posCheck.limitHit) {
    return { skip: true, reason: posCheck.reason };
  }

  // ── Check 4: Insufficient balance ───────────────────────
  const requiredSOL = proposedPositionSOL + minSolReserve;
  if (currentBalanceSOL < requiredSOL) {
    const available = Math.max(currentBalanceSOL - minSolReserve, 0);
    return {
      skip:   true,
      reason: `Insufficient balance — need ${requiredSOL.toFixed(4)} SOL, have ${currentBalanceSOL.toFixed(4)} SOL (${available.toFixed(4)} available after ${minSolReserve} SOL reserve)`,
    };
  }

  // ── All checks passed ────────────────────────────────────
  return { skip: false, reason: null };
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  checkDailyLossLimit,
  checkMaxPositions,
  detectRugPull,
  calculateDrawdown,
  shouldSkipTrade,
};