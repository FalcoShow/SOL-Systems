// ============================================================
//  SOL SYSTEMS — Position Guardian
//  File: src/jobs/positionGuardian.js
//
//  Autonomous capital protection system. Runs every 30 seconds
//  and checks all open positions against safety thresholds:
//
//    - Hard stop-loss:   unrealized PnL < -30%    → sell 100%
//    - Time-decay stop:  held > 4hrs AND PnL < -10% → sell 100%
//    - Stale position:   held > 24hrs (any PnL)   → sell 100%
//    - Take-profit:      PnL > +100%              → sell 50%
//    - Trailing stop:    PnL was > +30%, dropped to
//                        50% of peak               → sell 100%
//
//  This is the single most important safety feature.
//  Without it, the bot bag-holds forever on any position
//  where the tracked wallet doesn't sell.
//
//  The guardian executes sells independently — it does NOT
//  wait for the tracked wallet to sell first.
// ============================================================

'use strict';

const positionTracker = require('../monitor/positionTracker');
const { executeFullSwap, getTokenAmountForSell } = require('../execution/jupiterClient');
const tradeRepository = require('../execution/tradeRepository');
const config          = require('../config');
const logger          = require('../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 30_000; // 30 seconds
const MIN_POSITION_AGE  = 60_000; // Don't touch positions < 1 min old (let them settle)

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _intervalId     = null;
let _isRunning      = false;
let _telegramSendFn = null;

// Track peak PnL% per position for trailing stop
// tokenMint → { peakPnLPct: number }
const _positionPeaks = new Map();

// Track take-profit executions to avoid re-triggering
const _takeProfitTriggered = new Set(); // tokenMint

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

/**
 * Start the position guardian.
 * @param {Function} [sendFn] - Telegram notification function
 */
function start(sendFn) {
  if (_intervalId) return;
  _telegramSendFn = sendFn || null;

  logger.info('[Guardian] Position guardian started', {
    intervalMs: CHECK_INTERVAL_MS,
  });

  _intervalId = setInterval(_runGuardianCheck, CHECK_INTERVAL_MS);
}

/**
 * Stop the position guardian.
 */
function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('[Guardian] Position guardian stopped');
  }
}

/**
 * Get guardian status for health checks.
 */
function getStatus() {
  return {
    running:         !!_intervalId,
    peakTracking:    _positionPeaks.size,
    takeProfitsDone: _takeProfitTriggered.size,
  };
}

// ────────────────────────────────────────────────────────────
//  CORE GUARDIAN LOOP
// ────────────────────────────────────────────────────────────

async function _runGuardianCheck() {
  if (_isRunning) return; // Prevent overlap
  _isRunning = true;

  try {
    const positions = positionTracker.getAllMyPositions();
    if (!positions || positions.length === 0) {
      _isRunning = false;
      return;
    }

    // Load settings once per check cycle
    const settings = await tradeRepository.getSettings().catch(() => null);
    if (!settings) {
      _isRunning = false;
      return;
    }

    // Thresholds from settings (with sane defaults)
    const stopLossPct             = settings.stopLossPct              ?? -30;
    const takeProfitPct           = settings.takeProfitPct            ?? 100;
    const trailingStopActivatePct = settings.trailingStopActivatePct  ?? 30;
    const trailingStopTrailPct    = settings.trailingStopTrailPct     ?? 50;
    const maxHoldTimeHours        = settings.maxHoldTimeHours         ?? 24;

    for (const position of positions) {
      try {
        await _evaluatePosition(position, {
          stopLossPct,
          takeProfitPct,
          trailingStopActivatePct,
          trailingStopTrailPct,
          maxHoldTimeHours,
          settings,
        });
      } catch (err) {
        logger.debug('[Guardian] Error evaluating position', {
          token: position.tokenSymbol || position.tokenMint?.slice(0, 8),
          error: err.message,
        });
      }
    }

    // Clean up peaks for positions that no longer exist
    const openMints = new Set(positions.map(p => p.tokenMint));
    for (const mint of _positionPeaks.keys()) {
      if (!openMints.has(mint)) {
        _positionPeaks.delete(mint);
        _takeProfitTriggered.delete(mint);
      }
    }

  } catch (err) {
    logger.error('[Guardian] Check cycle failed', { error: err.message });
  } finally {
    _isRunning = false;
  }
}

// ────────────────────────────────────────────────────────────
//  POSITION EVALUATION
// ────────────────────────────────────────────────────────────

async function _evaluatePosition(position, thresholds) {
  const { tokenMint, tokenSymbol, entryTime, unrealizedPnLPct } = position;
  if (!tokenMint) return;

  const holdTimeMs = Date.now() - new Date(entryTime).getTime();
  const holdTimeHrs = holdTimeMs / (1000 * 60 * 60);
  const pnlPct = unrealizedPnLPct || 0;

  // Don't touch brand-new positions (let them settle)
  if (holdTimeMs < MIN_POSITION_AGE) return;

  // Update peak PnL tracking
  if (!_positionPeaks.has(tokenMint)) {
    _positionPeaks.set(tokenMint, { peakPnLPct: pnlPct });
  }
  const peakData = _positionPeaks.get(tokenMint);
  if (pnlPct > peakData.peakPnLPct) {
    peakData.peakPnLPct = pnlPct;
  }

  const symbol = tokenSymbol || tokenMint.slice(0, 8);

  // ── Rule 1: Hard stop-loss ─────────────────────────────
  if (pnlPct <= thresholds.stopLossPct) {
    logger.warn('[Guardian] STOP-LOSS triggered', {
      token: symbol, pnlPct: pnlPct.toFixed(2), threshold: thresholds.stopLossPct,
    });
    await _executeSell(position, 100, 'STOP_LOSS', thresholds.settings);
    return;
  }

  // ── Rule 2: Time-decay stop ────────────────────────────
  if (holdTimeHrs > 4 && pnlPct < -10) {
    logger.warn('[Guardian] TIME-DECAY stop triggered', {
      token: symbol, holdHrs: holdTimeHrs.toFixed(1), pnlPct: pnlPct.toFixed(2),
    });
    await _executeSell(position, 100, 'TIME_DECAY_STOP', thresholds.settings);
    return;
  }

  // ── Rule 3: Stale position ─────────────────────────────
  if (holdTimeHrs > thresholds.maxHoldTimeHours) {
    logger.warn('[Guardian] STALE position — max hold time exceeded', {
      token: symbol, holdHrs: holdTimeHrs.toFixed(1), maxHrs: thresholds.maxHoldTimeHours,
    });
    await _executeSell(position, 100, 'MAX_HOLD_TIME', thresholds.settings);
    return;
  }

  // ── Rule 4: Take-profit (partial sell) ─────────────────
  if (pnlPct >= thresholds.takeProfitPct && !_takeProfitTriggered.has(tokenMint)) {
    logger.info('[Guardian] TAKE-PROFIT triggered', {
      token: symbol, pnlPct: pnlPct.toFixed(2), threshold: thresholds.takeProfitPct,
    });
    _takeProfitTriggered.add(tokenMint);
    await _executeSell(position, 50, 'TAKE_PROFIT', thresholds.settings);
    return;
  }

  // ── Rule 5: Trailing stop ──────────────────────────────
  if (peakData.peakPnLPct >= thresholds.trailingStopActivatePct) {
    const trailLevel = peakData.peakPnLPct * (thresholds.trailingStopTrailPct / 100);
    if (pnlPct <= trailLevel && pnlPct < peakData.peakPnLPct) {
      logger.warn('[Guardian] TRAILING STOP triggered', {
        token: symbol,
        peakPnL: peakData.peakPnLPct.toFixed(2),
        currentPnL: pnlPct.toFixed(2),
        trailLevel: trailLevel.toFixed(2),
      });
      await _executeSell(position, 100, 'TRAILING_STOP', thresholds.settings);
      return;
    }
  }
}

// ────────────────────────────────────────────────────────────
//  AUTONOMOUS SELL EXECUTION
// ────────────────────────────────────────────────────────────

/**
 * Execute an autonomous sell for a position.
 *
 * @param {object} position - Position from positionTracker
 * @param {number} sellPct  - Percentage to sell (50 or 100)
 * @param {string} reason   - Why (STOP_LOSS, TAKE_PROFIT, etc.)
 * @param {object} settings - Current settings
 * @private
 */
async function _executeSell(position, sellPct, reason, settings) {
  const { tokenMint, tokenSymbol, entryAmountSOL, tradeId } = position;
  const symbol = tokenSymbol || tokenMint.slice(0, 8);

  try {
    // Get actual on-chain token balance
    const tokenBalance = await getTokenAmountForSell(config.wallet.publicKey, tokenMint);
    const rawAmount = parseFloat(tokenBalance.amount || '0');

    if (rawAmount <= 0) {
      logger.warn('[Guardian] No token balance found — closing position in tracker', {
        token: symbol, reason,
      });
      positionTracker.closeMyPosition(tokenMint, {
        executedAmountSOL: 0,
        confirmedAt: new Date(),
      });
      return;
    }

    // Calculate sell amount (partial or full)
    const sellAmount = sellPct < 100
      ? Math.floor(rawAmount * (sellPct / 100))
      : rawAmount;

    logger.info('[Guardian] Executing autonomous sell', {
      token: symbol, reason, sellPct, sellAmount,
    });

    // Execute the swap via Jupiter
    const swapResult = await executeFullSwap({
      tradeType:    'SELL',
      tokenMint,
      amountTokens: sellAmount,
      slippageBps:  settings.maxSlippageBps || 100,
    });

    if (!swapResult.success) {
      logger.error('[Guardian] Autonomous sell FAILED', {
        token: symbol, reason, error: swapResult.error,
      });
      await _sendNotification(
        `⚠️ Guardian sell FAILED for ${symbol}\n` +
        `Reason: ${reason}\nError: ${swapResult.error}`
      );
      return;
    }

    const solReceived = swapResult.actualSolAmount || 0;

    // Update position tracker
    if (sellPct >= 100) {
      positionTracker.closeMyPosition(tokenMint, {
        executedAmountSOL: solReceived,
        executedPriceSOL:  swapResult.actualPriceSOL || 0,
        confirmedAt:       new Date(),
      });
    }
    // For partial sells (take-profit 50%), we don't close the position
    // The remaining 50% continues to be tracked with updated metrics

    // Update DB trade record
    if (tradeId) {
      try {
        const pnlSOL = solReceived - (entryAmountSOL || 0) * (sellPct / 100);
        const pnlPct = entryAmountSOL > 0
          ? ((solReceived / (entryAmountSOL * (sellPct / 100))) - 1) * 100
          : 0;

        await tradeRepository.prisma.trade.update({
          where: { id: tradeId },
          data: {
            status:           'CONFIRMED',
            isOpen:           sellPct >= 100 ? false : true,
            confirmedAt:      new Date(),
            executedAmountSOL: solReceived,
            executedPriceSOL:  swapResult.actualPriceSOL || 0,
            pnlSOL:           pnlSOL,
            pnlPct:           pnlPct,
            isWin:            pnlSOL > 0,
            errorMessage:     `Guardian: ${reason} (${sellPct}%)`,
          },
        });
      } catch (dbErr) {
        logger.debug('[Guardian] DB update failed', { error: dbErr.message });
      }
    }

    // Calculate PnL for notification
    const pnlSOL = solReceived - (entryAmountSOL || 0) * (sellPct / 100);
    const pnlStr = pnlSOL >= 0 ? `+${pnlSOL.toFixed(4)}` : pnlSOL.toFixed(4);
    const emoji = _reasonEmoji(reason);

    logger.info('[Guardian] Autonomous sell CONFIRMED', {
      token: symbol, reason, sellPct, solReceived: solReceived.toFixed(4),
      pnlSOL: pnlStr, txMs: swapResult.totalMs,
    });

    // Telegram notification
    await _sendNotification(
      `${emoji} *Guardian: ${reason.replace(/_/g, ' ')}*\n\n` +
      `Token: ${symbol}\n` +
      `Sold: ${sellPct}% of position\n` +
      `SOL received: ${solReceived.toFixed(4)}\n` +
      `PnL: ${pnlStr} SOL\n` +
      `Execution: ${swapResult.totalMs}ms`
    );

  } catch (err) {
    logger.error('[Guardian] Sell execution error', {
      token: symbol, reason, error: err.message,
    });
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

function _reasonEmoji(reason) {
  switch (reason) {
    case 'STOP_LOSS':       return '🛑';
    case 'TIME_DECAY_STOP': return '⏰';
    case 'MAX_HOLD_TIME':   return '⌛';
    case 'TAKE_PROFIT':     return '💰';
    case 'TRAILING_STOP':   return '📉';
    default:                return '🤖';
  }
}

async function _sendNotification(text) {
  if (!_telegramSendFn) return;
  try {
    await _telegramSendFn('RAW', { message: text });
  } catch (_) {
    // Non-fatal — guardian should never block on Telegram
  }
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop, getStatus };
