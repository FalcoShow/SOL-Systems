// ============================================================
//  SOL SYSTEMS — Dynamic Allocation Manager
//  File: src/jobs/allocationManager.js
//
//  Runs every 4 hours and adjusts capital allocation per
//  tracked wallet based on rolling 24h performance.
//
//  Rules:
//    - Wallets with >70% win rate + positive PnL: +20% allocation
//    - Wallets with <40% win rate or negative PnL: -30% allocation
//    - Freed capital reallocated to best performers
//    - Only adjusts AI-managed wallets (addedByAI=true)
//    - Manual wallets keep their original allocation
//
//  This prevents a single underperforming wallet from consuming
//  disproportionate capital, while rewarding hot wallets with
//  more capacity to compound faster.
// ============================================================

'use strict';

const tradeRepository = require('../execution/tradeRepository');
const logger          = require('../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // Every 4 hours
const MIN_TRADES_FOR_ADJUST = 3; // Need at least 3 closed trades to judge

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _intervalId  = null;
let _sendFn      = null;

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

function start(sendFn) {
  if (_intervalId) return;
  _sendFn = sendFn || null;
  _intervalId = setInterval(_runAllocationCheck, CHECK_INTERVAL_MS);
  logger.info('[Allocator] Dynamic allocation manager started', {
    intervalHrs: CHECK_INTERVAL_MS / (60 * 60 * 1000),
  });
}

function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('[Allocator] Dynamic allocation manager stopped');
  }
}

// ────────────────────────────────────────────────────────────
//  CORE LOGIC
// ────────────────────────────────────────────────────────────

async function _runAllocationCheck() {
  try {
    const settings = await tradeRepository.getSettings();
    if (!settings || settings.isTradingPaused) return;

    const totalCapital = settings.myCapitalSOL;

    // Get all active AI-managed wallets
    const allWallets = await tradeRepository.getTrackedWallets(true);
    const aiWallets  = allWallets.filter(w => w.addedByAI);

    if (aiWallets.length === 0) return;

    // Calculate performance for each wallet
    const walletPerf = [];
    for (const wallet of aiWallets) {
      const perf = await tradeRepository.getWalletPerformance24h(wallet.id);
      walletPerf.push({ wallet, perf });
    }

    // Categorize wallets
    const adjustments = [];
    let totalFreed = 0;

    for (const { wallet, perf } of walletPerf) {
      const currentAlloc = wallet.allocationSOL || (totalCapital / aiWallets.length);

      if (perf.trades < MIN_TRADES_FOR_ADJUST) {
        // Not enough data — keep current allocation
        adjustments.push({ wallet, newAlloc: currentAlloc, reason: 'insufficient_data' });
        continue;
      }

      if (perf.winRate >= 70 && perf.pnlSOL > 0) {
        // Top performer — increase by 20%
        const newAlloc = currentAlloc * 1.2;
        adjustments.push({ wallet, newAlloc, reason: 'top_performer' });
        logger.info('[Allocator] Increasing allocation for top performer', {
          wallet: wallet.nickname, winRate: perf.winRate.toFixed(1) + '%',
          pnl: perf.pnlSOL.toFixed(4), change: '+20%',
        });
      } else if (perf.winRate < 40 || perf.pnlSOL < 0) {
        // Underperformer — decrease by 30%
        const freed    = currentAlloc * 0.3;
        const newAlloc = currentAlloc * 0.7;
        totalFreed += freed;
        adjustments.push({ wallet, newAlloc, reason: 'underperformer' });
        logger.info('[Allocator] Decreasing allocation for underperformer', {
          wallet: wallet.nickname, winRate: perf.winRate.toFixed(1) + '%',
          pnl: perf.pnlSOL.toFixed(4), change: '-30%',
        });
      } else {
        // Average — keep current
        adjustments.push({ wallet, newAlloc: currentAlloc, reason: 'average' });
      }
    }

    // Redistribute freed capital to top performers
    const topPerformers = adjustments.filter(a => a.reason === 'top_performer');
    if (totalFreed > 0 && topPerformers.length > 0) {
      const bonus = totalFreed / topPerformers.length;
      for (const adj of topPerformers) {
        adj.newAlloc += bonus;
      }
      logger.info('[Allocator] Redistributed freed capital', {
        freed: totalFreed.toFixed(4),
        recipients: topPerformers.length,
        bonusEach: (totalFreed / topPerformers.length).toFixed(4),
      });
    }

    // Enforce allocation bounds before writing
    const maxAlloc = totalCapital * 0.40; // No wallet > 40% of capital
    const minAlloc = totalCapital * 0.10; // No wallet < 10% of capital

    // Apply allocation changes to DB
    for (const { wallet, newAlloc, reason } of adjustments) {
      if (reason === 'insufficient_data' || reason === 'average') continue;

      // Clamp allocation to [min, max] bounds
      const clampedAlloc = Math.max(minAlloc, Math.min(newAlloc, maxAlloc));

      try {
        await tradeRepository.prisma.trackedWallet.update({
          where: { id: wallet.id },
          data:  { allocationSOL: parseFloat(clampedAlloc.toFixed(4)) },
        });
      } catch (err) {
        logger.debug('[Allocator] Failed to update allocation', {
          wallet: wallet.nickname, error: err.message,
        });
      }
    }

    const changed = adjustments.filter(a => a.reason !== 'insufficient_data' && a.reason !== 'average');
    if (changed.length > 0) {
      logger.info('[Allocator] Allocation cycle complete', {
        wallets: aiWallets.length,
        adjusted: changed.length,
        freed: totalFreed.toFixed(4),
      });
    }

  } catch (err) {
    logger.error('[Allocator] Allocation check failed', { error: err.message });
  }
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop };
