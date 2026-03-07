// ============================================================
//  SOL SYSTEMS — Intraday Wallet Rotation
//  File: src/jobs/intradayRotation.js
//
//  Runs every 4 hours and checks AI-managed wallets for
//  inactivity or consecutive losses. Wallets that go cold
//  or start losing get their allocation reduced or removed
//  between nightly intelligence runs.
//
//  This prevents the system from sitting idle during the day
//  if the AI's best wallets stop trading.
//
//  Rules:
//    - 8+ hours inactive (2 consecutive cold checks): reduce allocation 50%
//    - 3+ consecutive losses in 4 hours: evict immediately
//    - Evicted wallets deactivated until next nightly AI refresh
// ============================================================

'use strict';

const tradeRepository = require('../execution/tradeRepository');
const logger          = require('../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS     = 4 * 60 * 60 * 1000; // Every 4 hours
const COLD_THRESHOLD_MS     = 8 * 60 * 60 * 1000;  // 8 hours = cold
const LOSS_STREAK_THRESHOLD = 3;                     // 3 consecutive losses = evict
const MIN_ALLOCATION_SOL    = 0.5;                   // Never reduce below this (gas fees make smaller trades unprofitable)

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _intervalId = null;
let _sendFn     = null;

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

function start(sendFn) {
  if (_intervalId) return;
  _sendFn = sendFn || null;
  _intervalId = setInterval(_runRotationCheck, CHECK_INTERVAL_MS);
  logger.info('[Rotation] Intraday wallet rotation started');
}

function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('[Rotation] Intraday wallet rotation stopped');
  }
}

// ────────────────────────────────────────────────────────────
//  CORE LOGIC
// ────────────────────────────────────────────────────────────

async function _runRotationCheck() {
  try {
    const allWallets = await tradeRepository.getTrackedWallets(true);
    const aiWallets  = allWallets.filter(w => w.addedByAI);

    if (aiWallets.length === 0) return;

    const now = Date.now();
    let evicted  = 0;
    let reduced  = 0;

    for (const wallet of aiWallets) {
      // ── Check 1: Consecutive loss streak ──────────────────
      try {
        const streak = await tradeRepository.getConsecutiveLosses(wallet.id);
        if (streak >= LOSS_STREAK_THRESHOLD) {
          logger.warn('[Rotation] Evicting wallet — loss streak', {
            wallet: wallet.nickname,
            streak,
          });

          await tradeRepository.deactivateTrackedWallet(wallet.address);
          evicted++;

          await _notify(
            `🔄 *Intraday Rotation — Wallet Evicted*\n\n` +
            `Wallet: *${wallet.nickname}*\n` +
            `Reason: ${streak} consecutive losses\n` +
            `_Will be re-evaluated at next nightly AI refresh._`
          );
          continue;
        }
      } catch (_) {}

      // ── Check 2: Inactivity ───────────────────────────────
      const lastActivity = wallet.lastTradeAt || wallet.lastSeenAt || wallet.addedAt;
      const idleMs = now - new Date(lastActivity).getTime();

      if (idleMs > COLD_THRESHOLD_MS) {
        // Wallet has been cold for 8+ hours — reduce allocation 50%
        const currentAlloc = wallet.allocationSOL;
        if (currentAlloc && currentAlloc > MIN_ALLOCATION_SOL) {
          const newAlloc = Math.max(currentAlloc * 0.5, MIN_ALLOCATION_SOL);
          try {
            await tradeRepository.prisma.trackedWallet.update({
              where: { id: wallet.id },
              data:  { allocationSOL: parseFloat(newAlloc.toFixed(4)) },
            });
            reduced++;
            logger.info('[Rotation] Reduced allocation for cold wallet', {
              wallet: wallet.nickname,
              idle: (idleMs / (60 * 60 * 1000)).toFixed(1) + 'hrs',
              oldAlloc: currentAlloc.toFixed(4),
              newAlloc: newAlloc.toFixed(4),
            });
          } catch (_) {}
        }
      }
    }

    if (evicted > 0 || reduced > 0) {
      logger.info('[Rotation] Rotation cycle complete', {
        checked: aiWallets.length,
        evicted,
        reduced,
      });
    }

  } catch (err) {
    logger.error('[Rotation] Rotation check failed', { error: err.message });
  }
}

async function _notify(text) {
  if (!_sendFn) return;
  try {
    await _sendFn('RAW', { message: text });
  } catch (_) {}
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop };
