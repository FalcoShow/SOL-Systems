// ============================================================
//  SOL SYSTEMS — Core Math & Scaling Engine
//  File: src/utils/calculator.js
//
//  This is the most critical file in the entire system.
//  Every position size, every PnL comparison, every scaling
//  decision runs through here.
//
//  The core problem it solves:
//    Cented has 500 SOL. You have 10 SOL.
//    Cented buys 50 SOL worth of WIF (10% of his capital).
//    You need to buy 1 SOL worth of WIF (10% of YOUR capital).
//    Your % return will then perfectly mirror his % return.
//
//  Functions:
//    - scalePositionSize()         : the core scaling formula
//    - estimateWalletCapital()     : estimate tracked wallet's SOL capital
//    - calculatePnLPercentage()    : exact % gain or loss
//    - calculateSOLPnL()           : SOL profit or loss
//    - calculateUSDPnL()           : USD profit or loss
//    - verifyPercentageMatch()     : confirm our % matched theirs
//    - calculateDailyStats()       : aggregate 24h performance
//    - calculateWinRate()          : win rate percentage
//    - applyRiskLimits()           : enforce max position size caps
//    - estimateTransactionFee()    : gas fee estimate per trade
// ============================================================

'use strict';

const BigNumber = require('bignumber.js');
const logger    = require('./logger');

// ────────────────────────────────────────────────────────────
//  BIGNUMBER CONFIGURATION
//  We use BigNumber for all financial math to avoid floating
//  point precision errors that are common in JavaScript.
// ────────────────────────────────────────────────────────────

BigNumber.config({
  DECIMAL_PLACES:  18,
  ROUNDING_MODE:   BigNumber.ROUND_HALF_UP,
  EXPONENTIAL_AT:  [-18, 18],
});

// Solana transaction fee in SOL (approximate)
// Each swap typically costs 2-3 transactions at ~0.000005 SOL each
const ESTIMATED_FEE_SOL = 0.000015;

// Minimum viable position size — below this SOL amount a trade
// is not worth executing (would be eaten by fees)
const MIN_POSITION_SOL = 0.01;

// ────────────────────────────────────────────────────────────
//  CORE SCALING FORMULA
//
//  Formula:
//    myPosition = (trackedBuyAmount / trackedWalletCapital) * myCapital
//
//  This ensures our % exposure mirrors the tracked wallet's exactly.
//
//  Example:
//    Cented capital:  500 SOL
//    Cented position:  50 SOL  (10%)
//    My capital:       10 SOL
//    My position:      (50 / 500) * 10 = 1 SOL  (10%) ✓
// ────────────────────────────────────────────────────────────

/**
 * Calculate the scaled position size for a copy trade.
 *
 * @param {object} params
 * @param {number} params.trackedWalletCapitalSOL  - Estimated total SOL capital of tracked wallet
 * @param {number} params.trackedBuyAmountSOL      - SOL amount the tracked wallet used
 * @param {object} params.settings                 - Risk/sizing settings
 * @param {number} params.settings.myCapitalSOL    - Your total trading capital
 * @param {number} params.settings.maxPositionPct  - Max fraction of capital per trade (0–1)
 * @param {number} params.settings.minSolReserve   - Min SOL to keep for gas fees
 * @param {number} params.settings.maxOpenPositions
 * @param {number} params.currentOpenPositions     - Currently open trade count
 * @param {number} params.currentBalanceSOL        - Live wallet SOL balance
 *
 * @returns {{
 *   positionSOL: number,   // Final SOL to use (0 if skipped)
 *   positionPct: number,   // Fraction of your capital e.g. 0.10 for 10%
 *   capped:      boolean,  // true if reduced by maxPositionPct cap
 *   skip:        boolean,  // true if trade should not execute
 *   reason:      string
 * }}
 */
function scalePositionSize(params) {
  const {
    trackedWalletCapitalSOL,
    trackedBuyAmountSOL,
    settings            = {},
    currentOpenPositions = 0,
    currentBalanceSOL,
  } = params;

  const {
    myCapitalSOL,
    maxPositionPct   = 0.10,
    minSolReserve    = 0.10,
    maxOpenPositions = 10,
  } = settings;

  try {
    // ── Guard: tracked capital must be valid ────────────────
    if (!trackedWalletCapitalSOL || trackedWalletCapitalSOL <= 0) {
      logger.warn('Tracked capital is zero or invalid — using fallback 1% position');
      return _fallbackPosition(myCapitalSOL, 'Tracked capital unknown');
    }

    if (!myCapitalSOL || myCapitalSOL <= 0) {
      throw new Error('myCapitalSOL cannot be zero');
    }

    if (!trackedBuyAmountSOL || trackedBuyAmountSOL <= 0) {
      throw new Error('trackedBuyAmountSOL cannot be zero');
    }

    // Live balance for reserve checks — fall back to myCapitalSOL if not provided
    const balanceSOL = (currentBalanceSOL !== undefined)
      ? currentBalanceSOL
      : myCapitalSOL;

    // ── Guard 1: Max open positions ─────────────────────────
    if (currentOpenPositions >= maxOpenPositions) {
      return {
        positionSOL: 0,
        positionPct: 0,
        capped:      false,
        skip:        true,
        reason:      `Max open positions reached (${currentOpenPositions}/${maxOpenPositions})`,
      };
    }

    // ── Step 1: Calculate raw scaled position ───────────────
    // (trackedBuy / trackedCapital) gives their %, then apply to myCapital
    const tBuy   = new BigNumber(trackedBuyAmountSOL);
    const tCap   = new BigNumber(trackedWalletCapitalSOL);
    const myCap  = new BigNumber(myCapitalSOL);
    const maxPct = new BigNumber(maxPositionPct);

    let scaled = tBuy.dividedBy(tCap).multipliedBy(myCap);

    // ── Step 2: Apply max position cap ─────────────────────
    const maxAllowed = myCap.multipliedBy(maxPct);
    let capped = false;

    if (scaled.isGreaterThan(maxAllowed)) {
      scaled = maxAllowed;
      capped = true;
    }

    // ── Guard 2: Insufficient balance after reserve ─────────
    const available = new BigNumber(balanceSOL).minus(new BigNumber(minSolReserve));
    if (scaled.isGreaterThan(available)) {
      return {
        positionSOL: 0,
        positionPct: 0,
        capped:      false,
        skip:        true,
        reason:      `Insufficient balance — need ${scaled.toFixed(4)} SOL but only ${available.toFixed(4)} available after ${minSolReserve} SOL reserve`,
      };
    }

    // ── Guard 3: Dust threshold ─────────────────────────────
    const finalSOL = scaled.toNumber();
    if (finalSOL < MIN_POSITION_SOL) {
      return {
        positionSOL: 0,
        positionPct: 0,
        capped,
        skip:   true,
        reason: `Position below minimum viable size — ${finalSOL.toFixed(6)} SOL is dust (minimum ${MIN_POSITION_SOL} SOL)`,
      };
    }

    // ── All clear ───────────────────────────────────────────
    const positionPct = scaled.dividedBy(myCap).toNumber();

    return {
      positionSOL: parseFloat(finalSOL.toFixed(9)),
      positionPct: parseFloat(positionPct.toFixed(9)),
      capped,
      skip:   false,
      reason: 'OK',
    };

  } catch (err) {
    logger.error('Position scaling failed', { error: err.message });
    throw err;
  }
}

/**
 * Fallback when tracked wallet capital is unknown.
 * Uses a conservative 1% of your capital.
 * @private
 */
function _fallbackPosition(myCapitalSOL, reason) {
  const fallbackPct = 0.01;
  const positionSOL = (myCapitalSOL || 0) * fallbackPct;
  return {
    positionSOL,
    positionPct: fallbackPct,
    capped:      false,
    skip:        positionSOL < MIN_POSITION_SOL,
    reason:      `Fallback 1% — ${reason}`,
  };
}

// ────────────────────────────────────────────────────────────
//  WALLET CAPITAL ESTIMATION
//  We can't see another wallet's exact balance, so we estimate
//  their total capital from their recent trading history.
// ────────────────────────────────────────────────────────────

/**
 * Estimate a tracked wallet's total SOL capital from trade history.
 *
 * @param {Array}  recentTrades
 * @param {object} [options]
 * @param {number} [options.assumedPositionPct=0.10]
 * @param {number} [options.percentile=75]
 *
 * @returns {{
 *   estimatedCapitalSOL: number,
 *   confidence: 'high'|'medium'|'low'|'none',
 *   basedOnTrades: number,
 *   method: string
 * }}
 */
function estimateWalletCapital(recentTrades, options = {}) {
  const {
    assumedPositionPct = 0.10,
    percentile         = 75,
  } = options;

  try {
    // ── No data at all ──────────────────────────────────────
    if (!recentTrades || recentTrades.length === 0) {
      return {
        estimatedCapitalSOL: 0,
        confidence:          'none',
        basedOnTrades:       0,
        method:              'no-data',
      };
    }

    // ── BUY trades only ─────────────────────────────────────
    const buyAmounts = recentTrades
      .filter((t) => t.tradeType === 'BUY' && t.amountSOL > 0)
      .map((t)    => t.amountSOL)
      .sort((a, b) => a - b);

    if (buyAmounts.length === 0) {
      return {
        estimatedCapitalSOL: 0,
        confidence:          'none',
        basedOnTrades:       0,
        method:              'no-buys',
      };
    }

    // ── Method 1: Percentile of position sizes ───────────────
    const p75Index   = Math.floor((percentile / 100) * buyAmounts.length);
    const typicalBuy = buyAmounts[Math.min(p75Index, buyAmounts.length - 1)];
    const estimate1  = typicalBuy / assumedPositionPct;

    // ── Method 2: Average of top half ───────────────────────
    const topHalf    = buyAmounts.slice(Math.floor(buyAmounts.length / 2));
    const avgTopHalf = topHalf.reduce((a, b) => a + b, 0) / topHalf.length;
    const estimate2  = avgTopHalf / assumedPositionPct;

    // ── Weighted average ─────────────────────────────────────
    const combined = (estimate1 * 0.6) + (estimate2 * 0.4);

    // ── Confidence based on sample size ─────────────────────
    let confidence;
    if      (buyAmounts.length >= 20) confidence = 'high';
    else if (buyAmounts.length >= 10) confidence = 'medium';
    else                              confidence = 'low';

    // Round to nearest 0.5 SOL for cleaner display
    const estimatedCapitalSOL = Math.round(combined * 2) / 2;

    return {
      estimatedCapitalSOL,
      confidence,
      basedOnTrades: buyAmounts.length,
      method:        'percentile-average',
    };

  } catch (err) {
    logger.error('Capital estimation failed', { error: err.message });
    return {
      estimatedCapitalSOL: 0,
      confidence:          'low',
      basedOnTrades:       0,
      method:              'error',
    };
  }
}

// ────────────────────────────────────────────────────────────
//  PNL CALCULATIONS
// ────────────────────────────────────────────────────────────

/**
 * Calculate PnL percentage between entry and exit price.
 * Formula: ((exitPrice - entryPrice) / entryPrice) * 100
 *
 * @param {number} entryPriceSOL
 * @param {number} exitPriceSOL
 * @returns {number} PnL as a percentage
 */
function calculatePnLPercentage(entryPriceSOL, exitPriceSOL) {
  try {
    if (!entryPriceSOL || entryPriceSOL === 0) {
      throw new Error('Entry price cannot be zero');
    }
    const entry = new BigNumber(entryPriceSOL);
    const exit  = new BigNumber(exitPriceSOL);
    return parseFloat(
      exit.minus(entry).dividedBy(entry).multipliedBy(100).toFixed(4)
    );
  } catch (err) {
    logger.error('PnL percentage calculation failed', { error: err.message });
    return 0;
  }
}

/**
 * Calculate SOL profit or loss for a closed position.
 *
 * Uses exitAmountSOL directly for PnL math.
 * Uses entryPriceSOL / exitPriceSOL to compute the multiplier.
 *
 * Example (2.5x profit):
 *   entryAmountSOL = 1,  exitAmountSOL = 2.5
 *   pnlSOL     = 2.5 - 1.0 = +1.5 SOL
 *   pnlPct     = (1.5 / 1.0) * 100 = +150%
 *   multiplier = 0.0025 / 0.001 = 2.5
 *
 * @param {object} params
 * @param {number} params.entryAmountSOL  - SOL spent entering the position
 * @param {number} params.exitAmountSOL   - SOL received on exit
 * @param {number} params.entryPriceSOL   - Token price at entry (used for multiplier)
 * @param {number} params.exitPriceSOL    - Token price at exit  (used for multiplier)
 *
 * @returns {{
 *   pnlSOL:     number,
 *   pnlPct:     number,
 *   multiplier: number,
 *   isWin:      boolean
 * }}
 * @throws {Error} if entryAmountSOL is zero or falsy
 */
function calculateSOLPnL({ entryAmountSOL, exitAmountSOL, entryPriceSOL, exitPriceSOL }) {
  // Hard throw — not caught internally so the caller receives it
  if (!entryAmountSOL || entryAmountSOL === 0) {
    throw new Error('entryAmountSOL cannot be zero');
  }

  try {
    const entry  = new BigNumber(entryAmountSOL);
    const exit   = new BigNumber(exitAmountSOL);
    const ePrice = new BigNumber(entryPriceSOL);
    const xPrice = new BigNumber(exitPriceSOL);

    // PnL from SOL amounts
    const pnlSOL = exit.minus(entry);
    const pnlPct = pnlSOL.dividedBy(entry).multipliedBy(100);

    // Price multiplier (e.g. 2.5x, 10x, 0.6x)
    const multiplier = ePrice.isZero()
      ? new BigNumber(0)
      : xPrice.dividedBy(ePrice);

    return {
      pnlSOL:     parseFloat(pnlSOL.toFixed(9)),
      pnlPct:     parseFloat(pnlPct.toFixed(4)),
      multiplier: parseFloat(multiplier.toFixed(6)),
      isWin:      pnlSOL.isGreaterThan(0),
    };

  } catch (err) {
    logger.error('SOL PnL calculation failed', { error: err.message });
    return { pnlSOL: NaN, pnlPct: NaN, multiplier: NaN, isWin: false };
  }
}

/**
 * Convert a SOL PnL amount to USD.
 * @param {number} pnlSOL
 * @param {number} solPriceUSD
 * @returns {number}
 */
function calculateUSDPnL(pnlSOL, solPriceUSD) {
  try {
    if (!solPriceUSD || solPriceUSD === 0) return 0;
    return parseFloat(
      new BigNumber(pnlSOL).multipliedBy(solPriceUSD).toFixed(2)
    );
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────────
//  ACCURACY VERIFICATION
//  After each trade closes, verify our position % matched the
//  tracked wallet's within an acceptable tolerance.
// ────────────────────────────────────────────────────────────

/**
 * Verify that our position percentage matched the tracked wallet's.
 *
 * Both percentages are expressed as decimals (e.g. 0.10 = 10%).
 *
 * Rating thresholds (absolute deviation in percentage points):
 *   PERFECT    deviationPp < 0.1
 *   GOOD       deviationPp < 2
 *   ACCEPTABLE deviationPp < 5,  OR cappedByRisk AND deviationPp ≥ 20
 *   POOR       deviationPp < 15
 *   FAILED     deviationPp ≥ 15
 *
 * cappedByRisk is true when ourPct < trackedPct. When the gap is also
 * large (≥ 20pp) the deviation is intentional — our max position cap
 * fired — so we upgrade the rating to ACCEPTABLE.
 * Small capped deviations (< 2pp) still rate GOOD as normal.
 *
 * @param {object} params
 * @param {number} params.trackedPct  - Their position as a decimal (e.g. 0.10)
 * @param {number} params.ourPct      - Our  position as a decimal  (e.g. 0.10)
 *
 * @returns {{
 *   accuracy:     number,                              // 0–100 match score
 *   deviationPp:  number,                              // Absolute gap in pp
 *   cappedByRisk: boolean,
 *   rating:       'PERFECT'|'GOOD'|'ACCEPTABLE'|'POOR'|'FAILED'
 * }}
 */
function verifyPercentageMatch({ trackedPct, ourPct }) {
  try {
    const tracked = new BigNumber(trackedPct);
    const ours    = new BigNumber(ourPct);

    // Deviation in percentage points: |ourPct - trackedPct| * 100
    // e.g. |0.10 - 0.098| * 100 = 0.2pp
    const deviationPp = ours.minus(tracked).abs().multipliedBy(100);
    const devNum      = deviationPp.toNumber();

    // Relative deviation used for accuracy score
    const relativeDeviation = tracked.isZero()
      ? new BigNumber(0)
      : deviationPp.dividedBy(tracked.abs().multipliedBy(100));

    // Accuracy 0–100 (100 = perfect match)
    const accuracy = parseFloat(
      BigNumber.max(
        new BigNumber(1).minus(relativeDeviation).multipliedBy(100),
        new BigNumber(0)
      ).toFixed(4)
    );

    // Did we buy less than them? → our risk cap fired
    const cappedByRisk = ours.isLessThan(tracked);

    // ── Rating logic ─────────────────────────────────────────
    // Priority order:
    //   1. Tiny gap   → PERFECT / GOOD regardless of capping
    //   2. Large gap explained by a risk cap (≥ 20pp) → ACCEPTABLE
    //   3. All other gaps rated by raw pp size
    let rating;

    if (devNum < 0.1) {
      // Essentially perfect
      rating = 'PERFECT';
    } else if (devNum < 2) {
      // Small gap — GOOD even if technically capped
      rating = 'GOOD';
    } else if (cappedByRisk && devNum >= 20) {
      // Large gap that is intentional (our max-position cap fired)
      // e.g. tracked went 50%, we were capped at 10% → 40pp gap
      rating = 'ACCEPTABLE';
    } else if (devNum < 5) {
      rating = 'ACCEPTABLE';
    } else if (devNum < 15) {
      rating = 'POOR';
    } else {
      rating = 'FAILED';
    }

    return {
      accuracy,
      deviationPp:  parseFloat(deviationPp.toFixed(4)),
      cappedByRisk,
      rating,
    };

  } catch (err) {
    logger.error('Percentage match verification failed', { error: err.message });
    return {
      accuracy:     0,
      deviationPp:  0,
      cappedByRisk: false,
      rating:       'FAILED',
    };
  }
}

// ────────────────────────────────────────────────────────────
//  DAILY STATS AGGREGATION
//  Powers the /pnl Telegram command and dashboard charts
// ────────────────────────────────────────────────────────────

/**
 * Calculate aggregate stats from an array of closed trades.
 *
 * @param {Array}  trades
 * @param {number} startingCapitalSOL
 * @param {number} [solPriceUSD=0]
 * @returns {object}
 */
function calculateDailyStats(trades, startingCapitalSOL, solPriceUSD = 0) {
  try {
    if (!trades || trades.length === 0) return _emptyStats();

    const closedTrades = trades.filter(
      (t) => !t.isOpen && t.pnlSOL !== null && t.pnlSOL !== undefined
    );

    if (closedTrades.length === 0) return _emptyStats();

    let grossPnL  = new BigNumber(0);
    let totalFees = new BigNumber(0);
    let wins      = 0;
    let losses    = 0;
    let winPnL    = new BigNumber(0);
    let lossPnL   = new BigNumber(0);
    let totalMs   = 0;
    let msCount   = 0;
    let bestTrade  = null;
    let worstTrade = null;

    for (const trade of closedTrades) {
      const pnl  = new BigNumber(trade.pnlSOL || 0);
      const fees = new BigNumber(ESTIMATED_FEE_SOL * 2);

      grossPnL  = grossPnL.plus(pnl);
      totalFees = totalFees.plus(fees);

      if (pnl.isGreaterThanOrEqualTo(0)) {
        wins++;
        winPnL = winPnL.plus(pnl);
      } else {
        losses++;
        lossPnL = lossPnL.plus(pnl);
      }

      if (!bestTrade  || pnl.isGreaterThan(bestTrade.pnlSOL))  bestTrade  = trade;
      if (!worstTrade || pnl.isLessThan(worstTrade.pnlSOL))    worstTrade = trade;

      if (trade.executionMs) {
        totalMs += trade.executionMs;
        msCount++;
      }
    }

    const netPnL      = grossPnL.minus(totalFees);
    const capital     = new BigNumber(startingCapitalSOL);
    const roiPct      = capital.isZero()
      ? new BigNumber(0)
      : netPnL.dividedBy(capital).multipliedBy(100);

    const totalTrades = closedTrades.length;
    const winRate     = totalTrades > 0
      ? new BigNumber(wins).dividedBy(totalTrades).multipliedBy(100)
      : new BigNumber(0);

    return {
      totalTrades,
      wins,
      losses,
      winRatePct:     parseFloat(winRate.toFixed(2)),
      grossPnLSOL:    parseFloat(grossPnL.toFixed(6)),
      feesSOL:        parseFloat(totalFees.toFixed(6)),
      netPnLSOL:      parseFloat(netPnL.toFixed(6)),
      netPnLUSD:      calculateUSDPnL(netPnL.toNumber(), solPriceUSD),
      roiPct:         parseFloat(roiPct.toFixed(4)),
      avgWinSOL:      wins   > 0 ? parseFloat(winPnL.dividedBy(wins).toFixed(6))    : 0,
      avgLossSOL:     losses > 0 ? parseFloat(lossPnL.dividedBy(losses).toFixed(6)) : 0,
      bestTrade,
      worstTrade,
      avgExecutionMs: msCount > 0 ? Math.round(totalMs / msCount) : 0,
    };

  } catch (err) {
    logger.error('Daily stats calculation failed', { error: err.message });
    return _emptyStats();
  }
}

/** @private */
function _emptyStats() {
  return {
    totalTrades:    0,
    wins:           0,
    losses:         0,
    winRatePct:     0,
    grossPnLSOL:    0,
    feesSOL:        0,
    netPnLSOL:      0,
    netPnLUSD:      0,
    roiPct:         0,
    avgWinSOL:      0,
    avgLossSOL:     0,
    bestTrade:      null,
    worstTrade:     null,
    avgExecutionMs: 0,
  };
}

/**
 * Calculate win rate percentage.
 * @param {number} wins
 * @param {number} totalTrades
 * @returns {number} 0–100
 */
function calculateWinRate(wins, totalTrades) {
  if (!totalTrades || totalTrades === 0) return 0;
  return parseFloat(
    new BigNumber(wins).dividedBy(totalTrades).multipliedBy(100).toFixed(2)
  );
}

// ────────────────────────────────────────────────────────────
//  RISK LIMIT ENFORCEMENT
//  Final safety check before any position is sent to Jupiter
// ────────────────────────────────────────────────────────────

/**
 * Apply all risk limits to a calculated position size.
 *
 * @param {number} proposedPositionSOL
 * @param {object} settings
 * @param {object} context
 * @returns {{ approved: boolean, finalPositionSOL: number, skipReason: string|null }}
 */
function applyRiskLimits(proposedPositionSOL, settings, context) {
  const {
    currentSOLBalance,
    openPositionsCount,
    todayLossSOL = 0,
  } = context;

  const {
    maxOpenPositions  = 10,
    minSolReserve     = 0.1,
    dailyLossLimitSOL = 0,
    isTradingPaused   = false,
  } = settings;

  if (isTradingPaused) {
    return { approved: false, finalPositionSOL: 0, skipReason: 'Trading is paused' };
  }

  if (openPositionsCount >= maxOpenPositions) {
    return {
      approved: false,
      finalPositionSOL: 0,
      skipReason: `Max open positions reached (${openPositionsCount}/${maxOpenPositions})`,
    };
  }

  // todayLossSOL is NET PnL: positive = winning, negative = losing.
  // Only trigger loss limit when net negative.
  const netLossAbs = Math.abs(Math.min(todayLossSOL, 0));
  if (dailyLossLimitSOL > 0 && netLossAbs >= dailyLossLimitSOL) {
    return {
      approved: false,
      finalPositionSOL: 0,
      skipReason: `Daily loss limit hit (${netLossAbs.toFixed(4)} SOL >= ${dailyLossLimitSOL} SOL limit)`,
    };
  }

  const requiredSOL = proposedPositionSOL + minSolReserve;
  if (currentSOLBalance < requiredSOL) {
    const available = Math.max(currentSOLBalance - minSolReserve, 0);
    if (available < MIN_POSITION_SOL) {
      return {
        approved: false,
        finalPositionSOL: 0,
        skipReason: `Insufficient SOL balance (need ${requiredSOL.toFixed(4)}, have ${currentSOLBalance.toFixed(4)})`,
      };
    }
    return {
      approved: true,
      finalPositionSOL: parseFloat(available.toFixed(9)),
      skipReason: null,
    };
  }

  return {
    approved: true,
    finalPositionSOL: proposedPositionSOL,
    skipReason: null,
  };
}

// ────────────────────────────────────────────────────────────
//  FEE ESTIMATION
// ────────────────────────────────────────────────────────────

/** @returns {number} Estimated round-trip fee in SOL */
function estimateTransactionFee() {
  return ESTIMATED_FEE_SOL;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  scalePositionSize,
  estimateWalletCapital,
  calculatePnLPercentage,
  calculateSOLPnL,
  calculateUSDPnL,
  verifyPercentageMatch,
  calculateDailyStats,
  calculateWinRate,
  applyRiskLimits,
  estimateTransactionFee,
  MIN_POSITION_SOL,
  ESTIMATED_FEE_SOL,
};