// ============================================================
//  SOL SYSTEMS — Risk Manager Tests
//  File: tests/riskManager.test.js
//
//  Tests for the risk management engine in src/utils/riskManager.js
//  Run with: npm test
//
//  The risk manager is the safety net between the copy signals
//  and the actual Jupiter swap execution. Nothing gets traded
//  unless it passes every check in here.
//
//  Coverage targets:
//    - checkDailyLossLimit()   — halt trading when daily loss cap hit
//    - checkMaxPositions()     — enforce open position count ceiling
//    - detectRugPull()         — identify rapid price collapse
//    - calculateDrawdown()     — measure peak-to-current decline
//    - shouldSkipTrade()       — master gate combining all rules
// ============================================================

'use strict';

const {
  checkDailyLossLimit,
  checkMaxPositions,
  detectRugPull,
  calculateDrawdown,
  shouldSkipTrade,
} = require('../src/utils/riskManager');

// ────────────────────────────────────────────────────────────
//  checkDailyLossLimit
//  Returns true (should halt) when losses >= the configured limit
// ────────────────────────────────────────────────────────────

describe('checkDailyLossLimit()', () => {

  test('returns false when no losses today', () => {
    const result = checkDailyLossLimit({
      todayLossSOL:     0,
      dailyLossLimitSOL: 2,
    });
    expect(result.limitHit).toBe(false);
    expect(result.reason).toBeNull();
  });

  test('returns false when losses are below the limit', () => {
    const result = checkDailyLossLimit({
      todayLossSOL:      1.5,
      dailyLossLimitSOL: 2,
    });
    expect(result.limitHit).toBe(false);
  });

  test('returns true when losses exactly equal the limit', () => {
    const result = checkDailyLossLimit({
      todayLossSOL:      2.0,
      dailyLossLimitSOL: 2.0,
    });
    expect(result.limitHit).toBe(true);
    expect(result.reason).toMatch(/daily loss limit/i);
  });

  test('returns true when losses exceed the limit', () => {
    const result = checkDailyLossLimit({
      todayLossSOL:      3.5,
      dailyLossLimitSOL: 2.0,
    });
    expect(result.limitHit).toBe(true);
    expect(result.remainingSOL).toBe(0);
  });

  test('reports remaining loss budget when under limit', () => {
    const result = checkDailyLossLimit({
      todayLossSOL:      0.5,
      dailyLossLimitSOL: 2.0,
    });
    expect(result.limitHit).toBe(false);
    expect(result.remainingSOL).toBeCloseTo(1.5, 4);
  });

  test('returns false when daily limit is disabled (0)', () => {
    // A limit of 0 means "no limit configured" — never halt
    const result = checkDailyLossLimit({
      todayLossSOL:      999,
      dailyLossLimitSOL: 0,
    });
    expect(result.limitHit).toBe(false);
  });

  test('accepts negative todayLossSOL (stored as negative in db)', () => {
    // Some implementations store losses as negative numbers
    const result = checkDailyLossLimit({
      todayLossSOL:      -2.5,   // negative means loss
      dailyLossLimitSOL:  2.0,
    });
    expect(result.limitHit).toBe(true);
  });

});

// ────────────────────────────────────────────────────────────
//  checkMaxPositions
//  Prevents opening more positions than the configured ceiling
// ────────────────────────────────────────────────────────────

describe('checkMaxPositions()', () => {

  test('returns false when well under the limit', () => {
    const result = checkMaxPositions({
      currentOpenPositions: 3,
      maxOpenPositions:     10,
    });
    expect(result.limitHit).toBe(false);
    expect(result.reason).toBeNull();
  });

  test('returns false when one below the limit', () => {
    const result = checkMaxPositions({
      currentOpenPositions: 9,
      maxOpenPositions:     10,
    });
    expect(result.limitHit).toBe(false);
  });

  test('returns true when exactly at the limit', () => {
    const result = checkMaxPositions({
      currentOpenPositions: 10,
      maxOpenPositions:     10,
    });
    expect(result.limitHit).toBe(true);
    expect(result.reason).toMatch(/max.*position/i);
  });

  test('returns true when over the limit', () => {
    const result = checkMaxPositions({
      currentOpenPositions: 12,
      maxOpenPositions:     10,
    });
    expect(result.limitHit).toBe(true);
  });

  test('reports slots remaining when under limit', () => {
    const result = checkMaxPositions({
      currentOpenPositions: 4,
      maxOpenPositions:     10,
    });
    expect(result.slotsRemaining).toBe(6);
  });

  test('reports 0 slots when at limit', () => {
    const result = checkMaxPositions({
      currentOpenPositions: 10,
      maxOpenPositions:     10,
    });
    expect(result.slotsRemaining).toBe(0);
  });

  test('handles zero current positions', () => {
    const result = checkMaxPositions({
      currentOpenPositions: 0,
      maxOpenPositions:     5,
    });
    expect(result.limitHit).toBe(false);
    expect(result.slotsRemaining).toBe(5);
  });

});

// ────────────────────────────────────────────────────────────
//  detectRugPull
//  Flags a token if its price drops more than the threshold
//  within the observation window — triggers emergency exit
// ────────────────────────────────────────────────────────────

describe('detectRugPull()', () => {

  test('returns false for normal price movement', () => {
    const result = detectRugPull({
      entryPriceSOL:      0.001,
      currentPriceSOL:    0.0009,   // -10% — normal volatility
      rugPullThresholdPct: 50,
    });
    expect(result.isRug).toBe(false);
  });

  test('detects a 90% price collapse as rug pull', () => {
    const result = detectRugPull({
      entryPriceSOL:      0.001,
      currentPriceSOL:    0.0001,   // -90%
      rugPullThresholdPct: 50,
    });
    expect(result.isRug).toBe(true);
    expect(result.dropPct).toBeCloseTo(90, 1);
    expect(result.reason).toMatch(/rug|collapse/i);
  });

  test('detects a 60% drop when threshold is 50%', () => {
    const result = detectRugPull({
      entryPriceSOL:      0.002,
      currentPriceSOL:    0.0008,   // -60%
      rugPullThresholdPct: 50,
    });
    expect(result.isRug).toBe(true);
  });

  test('does not flag a 49% drop when threshold is 50%', () => {
    const result = detectRugPull({
      entryPriceSOL:      0.002,
      currentPriceSOL:    0.00102,  // just under 49% drop
      rugPullThresholdPct: 50,
    });
    expect(result.isRug).toBe(false);
  });

  test('detects token going to zero as rug pull', () => {
    const result = detectRugPull({
      entryPriceSOL:      0.001,
      currentPriceSOL:    0,        // complete collapse
      rugPullThresholdPct: 50,
    });
    expect(result.isRug).toBe(true);
    expect(result.dropPct).toBeCloseTo(100, 1);
  });

  test('returns correct dropPct in result', () => {
    const result = detectRugPull({
      entryPriceSOL:      0.001,
      currentPriceSOL:    0.00025,  // -75%
      rugPullThresholdPct: 50,
    });
    expect(result.dropPct).toBeCloseTo(75, 1);
  });

  test('returns false when price has gone up (not a rug)', () => {
    const result = detectRugPull({
      entryPriceSOL:      0.001,
      currentPriceSOL:    0.005,    // 5x pump — definitely not a rug
      rugPullThresholdPct: 50,
    });
    expect(result.isRug).toBe(false);
    expect(result.dropPct).toBe(0);  // no drop
  });

  test('handles custom thresholds correctly', () => {
    // Strict mode: flag anything over 30% drop
    const strict = detectRugPull({
      entryPriceSOL:       0.001,
      currentPriceSOL:     0.00065, // -35%
      rugPullThresholdPct: 30,
    });
    expect(strict.isRug).toBe(true);

    // Loose mode: only flag over 80% drop
    const loose = detectRugPull({
      entryPriceSOL:       0.001,
      currentPriceSOL:     0.00065, // -35%
      rugPullThresholdPct: 80,
    });
    expect(loose.isRug).toBe(false);
  });

});

// ────────────────────────────────────────────────────────────
//  calculateDrawdown
//  Measures current peak-to-trough decline of the portfolio
//  Used to display health in the dashboard and Telegram /pnl
// ────────────────────────────────────────────────────────────

describe('calculateDrawdown()', () => {

  test('returns 0 drawdown when at peak', () => {
    const result = calculateDrawdown({
      peakCapitalSOL:    10,
      currentCapitalSOL: 10,
    });
    expect(result.drawdownPct).toBe(0);
    expect(result.drawdownSOL).toBe(0);
  });

  test('calculates 20% drawdown correctly', () => {
    const result = calculateDrawdown({
      peakCapitalSOL:    10,
      currentCapitalSOL:  8,   // lost 2 SOL
    });
    expect(result.drawdownPct).toBeCloseTo(20, 2);
    expect(result.drawdownSOL).toBeCloseTo(2, 4);
  });

  test('calculates 50% drawdown correctly', () => {
    const result = calculateDrawdown({
      peakCapitalSOL:    10,
      currentCapitalSOL:  5,
    });
    expect(result.drawdownPct).toBeCloseTo(50, 2);
    expect(result.drawdownSOL).toBeCloseTo(5, 4);
  });

  test('returns 0 drawdown when above peak (profit)', () => {
    // If current > peak the peak should be updated elsewhere —
    // drawdown from old peak is not meaningful here, report 0
    const result = calculateDrawdown({
      peakCapitalSOL:    10,
      currentCapitalSOL: 12,   // grew above old peak
    });
    expect(result.drawdownPct).toBe(0);
    expect(result.drawdownSOL).toBe(0);
  });

  test('handles 100% loss (total wipe)', () => {
    const result = calculateDrawdown({
      peakCapitalSOL:    10,
      currentCapitalSOL:  0,
    });
    expect(result.drawdownPct).toBeCloseTo(100, 2);
    expect(result.drawdownSOL).toBeCloseTo(10, 4);
  });

  test('returns severity rating alongside the numbers', () => {
    // Drawdown severity: LOW < 10%, MEDIUM < 25%, HIGH < 50%, CRITICAL >= 50%
    const low = calculateDrawdown({ peakCapitalSOL: 10, currentCapitalSOL: 9.5 });
    expect(low.severity).toBe('LOW');

    const medium = calculateDrawdown({ peakCapitalSOL: 10, currentCapitalSOL: 8 });
    expect(medium.severity).toBe('MEDIUM');

    const high = calculateDrawdown({ peakCapitalSOL: 10, currentCapitalSOL: 6 });
    expect(high.severity).toBe('HIGH');

    const critical = calculateDrawdown({ peakCapitalSOL: 10, currentCapitalSOL: 4 });
    expect(critical.severity).toBe('CRITICAL');
  });

});

// ────────────────────────────────────────────────────────────
//  shouldSkipTrade
//  Master gate — combines every risk check into one call.
//  This is what the trade executor calls before every swap.
// ────────────────────────────────────────────────────────────

describe('shouldSkipTrade()', () => {

  // A clean context that should always pass all checks
  const cleanContext = {
    todayLossSOL:         0,
    dailyLossLimitSOL:    2,
    currentOpenPositions: 0,
    maxOpenPositions:     10,
    isTradingPaused:      false,
    currentBalanceSOL:    10,
    minSolReserve:        0.1,
    proposedPositionSOL:  1,
  };

  test('approves trade when all checks pass', () => {
    const result = shouldSkipTrade(cleanContext);
    expect(result.skip).toBe(false);
    expect(result.reason).toBeNull();
  });

  test('skips when trading is paused', () => {
    const result = shouldSkipTrade({
      ...cleanContext,
      isTradingPaused: true,
    });
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/paused/i);
  });

  test('skips when daily loss limit is hit', () => {
    const result = shouldSkipTrade({
      ...cleanContext,
      todayLossSOL:      2.5,
      dailyLossLimitSOL: 2.0,
    });
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/daily loss/i);
  });

  test('skips when max open positions reached', () => {
    const result = shouldSkipTrade({
      ...cleanContext,
      currentOpenPositions: 10,
      maxOpenPositions:     10,
    });
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/max.*position/i);
  });

  test('skips when insufficient SOL balance', () => {
    const result = shouldSkipTrade({
      ...cleanContext,
      currentBalanceSOL:   0.15,  // only 0.05 above reserve
      minSolReserve:       0.1,
      proposedPositionSOL: 1.0,
    });
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/balance|insufficient/i);
  });

  test('daily loss limit disabled (0) never blocks trading', () => {
    const result = shouldSkipTrade({
      ...cleanContext,
      todayLossSOL:      50,  // enormous loss
      dailyLossLimitSOL:  0,  // but limit is disabled
    });
    expect(result.skip).toBe(false);
  });

  test('paused check runs first — takes priority over all other checks', () => {
    // Everything wrong at once — should report "paused" not the others
    const result = shouldSkipTrade({
      ...cleanContext,
      isTradingPaused:      true,
      todayLossSOL:         99,
      currentOpenPositions: 99,
      currentBalanceSOL:    0,
    });
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/paused/i);
  });

  test('returns the first failing check when multiple rules fail', () => {
    // Loss limit + max positions both hit — should still skip, any reason
    const result = shouldSkipTrade({
      ...cleanContext,
      todayLossSOL:         3,
      dailyLossLimitSOL:    2,
      currentOpenPositions: 10,
      maxOpenPositions:     10,
    });
    expect(result.skip).toBe(true);
    expect(result.reason).toBeTruthy();
  });

});