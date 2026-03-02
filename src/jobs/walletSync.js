// ============================================================
//  SOL SYSTEMS — Wallet Sync Job
//  File: src/jobs/walletSync.js
//
//  Runs every hour. For each tracked wallet:
//    1. Counts all trades copied (BUY + SELL) from DB
//    2. Recalculates win/loss counts and total PnL
//    3. Finds the most recent trade timestamp
//    4. Re-estimates wallet capital from recent trade sizes
//    5. Writes corrected stats back to the database
//
//  Why this is needed:
//    The real-time path (tradeExecutor) updates wallet stats
//    on every trade, but if the bot restarts mid-trade, or a
//    DB write fails, counts can drift. This job is the truth
//    reconciler — it always derives stats from raw trade data
//    so the Wallets page is always accurate.
// ============================================================

'use strict';

const tradeRepository = require('../execution/tradeRepository');
const { estimateWalletCapital } = require('../utils/calculator');
const logger = require('../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const INTERVAL_MS    = 60 * 60 * 1000;  // 1 hour
const LOOKBACK_DAYS  = 30;              // days of history for capital estimate

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _intervalId        = null;
let _isRunning         = false;
let _lastRunAt         = null;
let _consecutiveErrors = 0;

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

function start() {
  if (_intervalId) return;

  logger.info('Wallet sync job started', { intervalMs: INTERVAL_MS });

  // Run once at startup, then hourly
  _runSync();
  _intervalId = setInterval(_runSync, INTERVAL_MS);
}

function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('Wallet sync job stopped');
  }
}

function getStatus() {
  return {
    running:           !!_intervalId,
    lastRunAt:         _lastRunAt,
    consecutiveErrors: _consecutiveErrors,
    intervalMs:        INTERVAL_MS,
  };
}

// ────────────────────────────────────────────────────────────
//  CORE SYNC
// ────────────────────────────────────────────────────────────

async function _runSync() {
  if (_isRunning) return;
  _isRunning = true;

  try {
    logger.debug('Wallet sync starting...');

    const wallets = await tradeRepository.getTrackedWallets(false); // all, not just active

    if (!wallets || wallets.length === 0) {
      _lastRunAt = new Date();
      return;
    }

    let updated = 0;

    for (const wallet of wallets) {
      try {
        await _syncWallet(wallet);
        updated++;
      } catch (err) {
        // Don't let one wallet failure stop the rest
        logger.warn('Failed to sync wallet', {
          wallet: wallet.nickname,
          error:  err.message,
        });
      }
    }

    _lastRunAt = new Date();
    _consecutiveErrors = 0;

    logger.debug('Wallet sync complete', {
      wallets: wallets.length,
      updated,
    });

  } catch (err) {
    _consecutiveErrors++;
    logger.error('Wallet sync job error', {
      error:             err.message,
      consecutiveErrors: _consecutiveErrors,
    });
  } finally {
    _isRunning = false;
  }
}

// ────────────────────────────────────────────────────────────
//  PER-WALLET RECONCILIATION
// ────────────────────────────────────────────────────────────

async function _syncWallet(wallet) {
  // Pull ALL trades ever recorded for this wallet from the DB
  const { trades } = await tradeRepository.getTradeHistory({
    walletAddress: wallet.address,
    limit:         10000,
    offset:        0,
  });

  if (!trades || trades.length === 0) {
    // No trades yet — nothing to reconcile
    return;
  }

  // ── Compute stats from raw trade records ─────────────────
  const sells       = trades.filter(t => t.tradeType === 'SELL' && t.status === 'CONFIRMED');
  const buys        = trades.filter(t => t.tradeType === 'BUY'  && t.status === 'CONFIRMED');

  const totalWins   = sells.filter(t => t.isWin === true).length;
  const totalLosses = sells.filter(t => t.isWin === false).length;
  const totalPnLSOL = sells.reduce((sum, t) => sum + (t.pnlSOL || 0), 0);

  // Most recent trade timestamp across BUYs and SELLs
  const allConfirmed = trades.filter(t => t.confirmedAt);
  const lastTradeAt  = allConfirmed.length > 0
    ? new Date(Math.max(...allConfirmed.map(t => new Date(t.confirmedAt).getTime())))
    : null;

  // Total trades copied = confirmed BUYs (each BUY = one copy action)
  const totalTradesCopied = buys.length;

  // ── Re-estimate capital from recent buy sizes ─────────────
  // Only recalculate if wallet doesn't have a manual override
  let estimatedCapitalSOL = wallet.estimatedCapitalSOL;

  if (!wallet.manualCapitalSOL) {
    const lookbackDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const recentBuys   = buys
      .filter(t => t.confirmedAt && new Date(t.confirmedAt) >= lookbackDate)
      .map(t => ({
        tradeType: 'BUY',
        amountSOL: t.executedAmountSOL || t.requestedAmountSOL || 0,
      }))
      .filter(t => t.amountSOL > 0);

    if (recentBuys.length >= 3) {
      const estimate = estimateWalletCapital(recentBuys, {
        assumedPositionPct: 0.10,
        percentile:         75,
      });
      if (estimate.estimatedCapitalSOL > 0) {
        estimatedCapitalSOL = estimate.estimatedCapitalSOL;
      }
    }
  }

  // ── Write reconciled stats back to DB ────────────────────
  // Use raw prisma client for a targeted update
  await tradeRepository.rawPrisma.trackedWallet.update({
    where: { address: wallet.address },
    data: {
      totalTradesCopied: totalTradesCopied,
      totalWins:         totalWins,
      totalLosses:       totalLosses,
      totalPnLSOL:       totalPnLSOL,
      lastTradeAt:       lastTradeAt,
      estimatedCapitalSOL: estimatedCapitalSOL,
    },
  });

  logger.debug('Wallet synced', {
    nickname:        wallet.nickname,
    totalTrades:     totalTradesCopied,
    wins:            totalWins,
    losses:          totalLosses,
    totalPnL:        totalPnLSOL.toFixed(4),
    estimatedCapital: estimatedCapitalSOL.toFixed(1),
  });
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop, getStatus };