// ============================================================
//  SOL SYSTEMS — Calculator Tests
//  File: tests/calculator.test.js
//
//  Tests for the core math engine in src/utils/calculator.js
//  Run with: npm test
//
//  Coverage targets:
//    - scalePositionSize()   — the % matching algorithm
//    - calculateSOLPnL()     — realized PnL on sell
//    - verifyPercentageMatch() — accuracy scoring
//    - estimateWalletCapital() — capital estimation
// ============================================================

'use strict';

const {
  scalePositionSize,
  calculateSOLPnL,
  verifyPercentageMatch,
  estimateWalletCapital,
} = require('../src/utils/calculator');

// ────────────────────────────────────────────────────────────
//  scalePositionSize
//  Core algorithm: mirrors tracked wallet's % bet with ours
// ────────────────────────────────────────────────────────────

describe('scalePositionSize()', () => {

  const baseSettings = {
    myCapitalSOL:     10,
    maxPositionPct:   0.10,   // 10% max = 1 SOL
    minSolReserve:    0.1,
    maxOpenPositions: 10,
  };

  test('scales 10% wallet bet to 10% of our capital', () => {
    const result = scalePositionSize({
      trackedWalletCapitalSOL: 100,
      trackedBuyAmountSOL:     10,   // 10% of 100
      settings:                baseSettings,
      currentOpenPositions:    0,
      currentBalanceSOL:       10,
    });
    expect(result.positionSOL).toBeCloseTo(1.0, 4);
    expect(result.positionPct).toBeCloseTo(0.10, 4);
    expect(result.reason).toBe('OK');
  });

  test('scales 5% wallet bet to 5% of our capital', () => {
    const result = scalePositionSize({
      trackedWalletCapitalSOL: 200,
      trackedBuyAmountSOL:     10,   // 5% of 200
      settings:                baseSettings,
      currentOpenPositions:    0,
      currentBalanceSOL:       10,
    });
    expect(result.positionSOL).toBeCloseTo(0.5, 4);
    expect(result.positionPct).toBeCloseTo(0.05, 4);
  });

  test('caps position at maxPositionPct even if wallet bet more', () => {
    const result = scalePositionSize({
      trackedWalletCapitalSOL: 100,
      trackedBuyAmountSOL:     50,   // 50% of wallet — way over our 10% max
      settings:                baseSettings,
      currentOpenPositions:    0,
      currentBalanceSOL:       10,
    });
    expect(result.positionSOL).toBeCloseTo(1.0, 4);  // capped at 10%
    expect(result.capped).toBe(true);
  });

  test('rejects trade if insufficient balance after reserve', () => {
    const result = scalePositionSize({
      trackedWalletCapitalSOL: 100,
      trackedBuyAmountSOL:     10,
      settings:                { ...baseSettings, minSolReserve: 0.5 },
      currentOpenPositions:    0,
      currentBalanceSOL:       0.55,  // only 0.05 SOL above reserve
    });
    expect(result.positionSOL).toBe(0);
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/insufficient/i);
  });

  test('rejects trade if max open positions reached', () => {
    const result = scalePositionSize({
      trackedWalletCapitalSOL: 100,
      trackedBuyAmountSOL:     10,
      settings:                baseSettings,
      currentOpenPositions:    10,   // at the limit
      currentBalanceSOL:       10,
    });
    expect(result.positionSOL).toBe(0);
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/max.*position/i);
  });

  test('handles fractional wallet percentages correctly', () => {
    const result = scalePositionSize({
      trackedWalletCapitalSOL: 1000,
      trackedBuyAmountSOL:     2.5,   // 0.25% of 1000
      settings:                baseSettings,
      currentOpenPositions:    0,
      currentBalanceSOL:       10,
    });
    expect(result.positionSOL).toBeCloseTo(0.025, 4);  // 0.25% of 10
    expect(result.positionPct).toBeCloseTo(0.0025, 4);
  });

  test('returns minimum viable position floor if above reserve', () => {
    // Very small bet — should still execute if above dust threshold
    const result = scalePositionSize({
      trackedWalletCapitalSOL: 10000,
      trackedBuyAmountSOL:     1,     // 0.01% of 10000
      settings:                { ...baseSettings, myCapitalSOL: 10 },
      currentOpenPositions:    0,
      currentBalanceSOL:       10,
    });
    // 0.01% of 10 SOL = 0.001 SOL — below dust, should skip
    expect(result.positionSOL).toBe(0);
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/dust|minimum/i);
  });

});

// ────────────────────────────────────────────────────────────
//  calculateSOLPnL
//  Realized PnL on a sell
// ────────────────────────────────────────────────────────────

describe('calculateSOLPnL()', () => {

  test('calculates profit correctly', () => {
    const result = calculateSOLPnL({
      entryAmountSOL:  1.0,
      exitAmountSOL:   2.5,
      entryPriceSOL:   0.001,
      exitPriceSOL:    0.0025,
    });
    expect(result.pnlSOL).toBeCloseTo(1.5, 6);
    expect(result.pnlPct).toBeCloseTo(150, 2);
    expect(result.isWin).toBe(true);
    expect(result.multiplier).toBeCloseTo(2.5, 2);
  });

  test('calculates loss correctly', () => {
    const result = calculateSOLPnL({
      entryAmountSOL:  1.0,
      exitAmountSOL:   0.6,
      entryPriceSOL:   0.001,
      exitPriceSOL:    0.0006,
    });
    expect(result.pnlSOL).toBeCloseTo(-0.4, 6);
    expect(result.pnlPct).toBeCloseTo(-40, 2);
    expect(result.isWin).toBe(false);
    expect(result.multiplier).toBeCloseTo(0.6, 2);
  });

  test('calculates break-even correctly', () => {
    const result = calculateSOLPnL({
      entryAmountSOL: 1.0,
      exitAmountSOL:  1.0,
      entryPriceSOL:  0.001,
      exitPriceSOL:   0.001,
    });
    expect(result.pnlSOL).toBeCloseTo(0, 6);
    expect(result.pnlPct).toBeCloseTo(0, 2);
    expect(result.isWin).toBe(false); // break-even is not a win
  });

  test('handles 100% loss (rug pull — token goes to zero)', () => {
    const result = calculateSOLPnL({
      entryAmountSOL: 1.0,
      exitAmountSOL:  0,
      entryPriceSOL:  0.001,
      exitPriceSOL:   0,
    });
    expect(result.pnlSOL).toBeCloseTo(-1.0, 6);
    expect(result.pnlPct).toBeCloseTo(-100, 2);
    expect(result.isWin).toBe(false);
  });

  test('handles 10x moonshot', () => {
    const result = calculateSOLPnL({
      entryAmountSOL:  0.5,
      exitAmountSOL:   5.0,
      entryPriceSOL:   0.0001,
      exitPriceSOL:    0.001,
    });
    expect(result.pnlSOL).toBeCloseTo(4.5, 6);
    expect(result.pnlPct).toBeCloseTo(900, 2);
    expect(result.multiplier).toBeCloseTo(10, 2);
    expect(result.isWin).toBe(true);
  });

  test('throws if entryAmountSOL is zero', () => {
    expect(() => calculateSOLPnL({
      entryAmountSOL: 0,
      exitAmountSOL:  1,
      entryPriceSOL:  0.001,
      exitPriceSOL:   0.002,
    })).toThrow();
  });

});

// ────────────────────────────────────────────────────────────
//  verifyPercentageMatch
//  Accuracy scoring: how close were we to the tracked wallet?
// ────────────────────────────────────────────────────────────

describe('verifyPercentageMatch()', () => {

  test('perfect match scores 100%', () => {
    const result = verifyPercentageMatch({
      trackedPct: 0.10,
      ourPct:     0.10,
    });
    expect(result.accuracy).toBeCloseTo(100, 1);
    expect(result.rating).toBe('PERFECT');
    expect(result.deviationPp).toBeCloseTo(0, 4);
  });

  test('slight deviation scores GOOD', () => {
    const result = verifyPercentageMatch({
      trackedPct: 0.10,
      ourPct:     0.098,  // capped at our max
    });
    expect(result.accuracy).toBeGreaterThan(90);
    expect(result.rating).toBe('GOOD');
  });

  test('large deviation due to cap scores ACCEPTABLE', () => {
    const result = verifyPercentageMatch({
      trackedPct: 0.50,   // wallet went 50%
      ourPct:     0.10,   // we capped at 10%
    });
    expect(result.rating).toBe('ACCEPTABLE');
    expect(result.cappedByRisk).toBe(true);
  });

  test('very poor match scores POOR or FAILED', () => {
    const result = verifyPercentageMatch({
      trackedPct: 0.10,
      ourPct:     0.01,   // severe under-execution
    });
    expect(['POOR', 'FAILED']).toContain(result.rating);
  });

  test('handles zero tracked percentage gracefully', () => {
    expect(() => verifyPercentageMatch({
      trackedPct: 0,
      ourPct:     0.05,
    })).not.toThrow();
  });

});

// ────────────────────────────────────────────────────────────
//  estimateWalletCapital
//  Infers wallet size from their trade history
// ────────────────────────────────────────────────────────────

describe('estimateWalletCapital()', () => {

  // Simulate a wallet that consistently bets ~10% of 500 SOL
  const trades50SOL = Array.from({ length: 20 }, (_, i) => ({
    tradeType: 'BUY',
    amountSOL: 48 + (i % 5),  // 48-52 SOL per trade ≈ ~10% of 500
  }));

  test('estimates capital correctly from consistent trade history', () => {
    const result = estimateWalletCapital(trades50SOL, {
      assumedPositionPct: 0.10,
      percentile:         75,
    });
    // Should estimate ~500 SOL ± 20%
    expect(result.estimatedCapitalSOL).toBeGreaterThan(400);
    expect(result.estimatedCapitalSOL).toBeLessThan(600);
    expect(result.confidence).toBe('high');
  });

  test('returns low confidence for sparse history', () => {
    const result = estimateWalletCapital(
      trades50SOL.slice(0, 4),  // only 4 trades
      { assumedPositionPct: 0.10, percentile: 75 }
    );
    expect(result.confidence).toBe('low');
  });

  test('returns medium confidence for moderate history', () => {
    const result = estimateWalletCapital(
      trades50SOL.slice(0, 12),  // 12 trades
      { assumedPositionPct: 0.10, percentile: 75 }
    );
    expect(result.confidence).toBe('medium');
  });

  test('handles variable position sizing from whale wallet', () => {
    // Whale bets between 50-500 SOL — high variance
    const whaleTrades = [
      ...Array.from({ length: 5  }, () => ({ tradeType: 'BUY', amountSOL: 500 })),
      ...Array.from({ length: 10 }, () => ({ tradeType: 'BUY', amountSOL: 100 })),
      ...Array.from({ length: 5  }, () => ({ tradeType: 'BUY', amountSOL: 50  })),
    ];
    const result = estimateWalletCapital(whaleTrades, {
      assumedPositionPct: 0.10,
      percentile:         75,
    });
    // 75th percentile of [50×5, 100×10, 500×5] ≈ 500
    // capital = 500 / 0.10 = 5000
    expect(result.estimatedCapitalSOL).toBeGreaterThan(2000);
    expect(result.estimatedCapitalSOL).toBeLessThan(8000);
  });

  test('returns 0 for empty trade history', () => {
    const result = estimateWalletCapital([], {
      assumedPositionPct: 0.10,
      percentile:         75,
    });
    expect(result.estimatedCapitalSOL).toBe(0);
    expect(result.confidence).toBe('none');
  });

  test('ignores SELL trades — only counts BUYs', () => {
    const mixedTrades = [
      { tradeType: 'BUY',  amountSOL: 50 },
      { tradeType: 'SELL', amountSOL: 80 },  // sells should be ignored
      { tradeType: 'BUY',  amountSOL: 48 },
      { tradeType: 'SELL', amountSOL: 20 },
      { tradeType: 'BUY',  amountSOL: 52 },
    ];
    const withSells    = estimateWalletCapital(mixedTrades, { assumedPositionPct: 0.10, percentile: 75 });
    const buysOnly     = estimateWalletCapital(
      mixedTrades.filter(t => t.tradeType === 'BUY'),
      { assumedPositionPct: 0.10, percentile: 75 }
    );
    expect(withSells.estimatedCapitalSOL).toBeCloseTo(buysOnly.estimatedCapitalSOL, 1);
  });

});