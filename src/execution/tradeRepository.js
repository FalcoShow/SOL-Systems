// ============================================================
//  SOL SYSTEMS — Trade Repository
//  File: src/execution/tradeRepository.js
//
//  Complete database layer for all trade operations.
//  Every read and write to the database goes through here.
//  Uses Prisma ORM — never writes raw SQL anywhere else.
//
//  Responsibilities:
//    - Save detected wallet trades (what THEY did)
//    - Save our copy trades (what WE did)
//    - Update trade status through lifecycle (PENDING → CONFIRMED)
//    - Query trades for PnL reports and Telegram commands
//    - Read and update system settings
//    - Manage tracked wallet records
//    - Aggregate daily/weekly/all-time stats
//
//  All functions are async and return plain objects — never
//  raw Prisma model instances, so callers don't need Prisma
//  knowledge to use this module.
// ============================================================

'use strict';

const { PrismaClient } = require('@prisma/client');
const logger           = require('../utils/logger');

// ────────────────────────────────────────────────────────────
//  PRISMA CLIENT — single shared instance
// ────────────────────────────────────────────────────────────

const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn',  emit: 'event' },
  ],
  errorFormat: 'minimal',
});

// Forward Prisma errors to our logger
prisma.$on('error', (e) => logger.error('Prisma error', { message: e.message }));
prisma.$on('warn',  (e) => logger.warn('Prisma warning', { message: e.message }));

// ────────────────────────────────────────────────────────────
//  SETTINGS
// ────────────────────────────────────────────────────────────

/**
 * Get the global settings record.
 * Always returns the 'global' row — creates it if missing.
 *
 * @returns {Promise<Settings>}
 */
async function getSettings() {
  try {
    let settings = await prisma.settings.findUnique({
      where: { id: 'global' },
    });

    // Create default settings if they don't exist yet
    if (!settings) {
      settings = await prisma.settings.create({
        data: { id: 'global' },
      });
      logger.info('Default settings created');
    }

    return settings;
  } catch (err) {
    logger.error('Failed to get settings', { error: err.message });
    throw err;
  }
}

/**
 * Update one or more settings fields.
 *
 * @param {object} updates - Fields to update
 * @returns {Promise<Settings>}
 */
async function updateSettings(updates) {
  try {
    const settings = await prisma.settings.upsert({
      where:  { id: 'global' },
      create: { id: 'global', ...updates },
      update: updates,
    });
    logger.info('Settings updated', { keys: Object.keys(updates) });
    return settings;
  } catch (err) {
    logger.error('Failed to update settings', { error: err.message });
    throw err;
  }
}

/**
 * Pause all trading with an optional reason.
 *
 * @param {string} reason - Why trading is being paused
 */
async function pauseTrading(reason = 'Manual pause') {
  return updateSettings({
    isTradingPaused: true,
    pauseReason:     reason,
    pausedAt:        new Date(),
  });
}

/**
 * Resume trading.
 */
async function resumeTrading() {
  return updateSettings({
    isTradingPaused: false,
    pauseReason:     null,
    pausedAt:        null,
  });
}

// ────────────────────────────────────────────────────────────
//  TRACKED WALLETS
// ────────────────────────────────────────────────────────────

/**
 * Get all tracked wallets.
 *
 * @param {boolean} activeOnly - If true, only return active wallets
 * @returns {Promise<TrackedWallet[]>}
 */
async function getTrackedWallets(activeOnly = true) {
  try {
    return await prisma.trackedWallet.findMany({
      where:   activeOnly ? { isActive: true } : {},
      orderBy: { addedAt: 'asc' },
    });
  } catch (err) {
    logger.error('Failed to get tracked wallets', { error: err.message });
    throw err;
  }
}

/**
 * Get a single tracked wallet by address.
 *
 * @param {string} address - Solana wallet address
 * @returns {Promise<TrackedWallet|null>}
 */
async function getTrackedWallet(address) {
  try {
    return await prisma.trackedWallet.findUnique({
      where: { address },
    });
  } catch (err) {
    logger.error('Failed to get tracked wallet', { address, error: err.message });
    return null;
  }
}

/**
 * Add a new wallet to track.
 *
 * @param {object} data
 * @param {string} data.address              - Solana wallet address
 * @param {string} data.nickname             - Display name
 * @param {number} data.estimatedCapitalSOL  - Estimated total capital
 * @returns {Promise<TrackedWallet>}
 */
async function addTrackedWallet({ address, nickname, estimatedCapitalSOL = 0 }) {
  try {
    const wallet = await prisma.trackedWallet.create({
      data: {
        id:                  _generateId(),
        address,
        nickname,
        estimatedCapitalSOL,
        capitalUpdatedAt:    estimatedCapitalSOL > 0 ? new Date() : null,
        isActive:            true,
      },
    });
    logger.info('Tracked wallet added to database', {
      nickname,
      address: address.slice(0, 8) + '...',
    });
    return wallet;
  } catch (err) {
    if (err.code === 'P2002') {
      throw new Error(`Wallet ${address} is already being tracked`);
    }
    logger.error('Failed to add tracked wallet', { error: err.message });
    throw err;
  }
}

/**
 * Update a tracked wallet's estimated capital.
 *
 * @param {string} address
 * @param {number} estimatedCapitalSOL
 */
async function updateWalletCapital(address, estimatedCapitalSOL) {
  try {
    await prisma.trackedWallet.update({
      where: { address },
      data: {
        estimatedCapitalSOL,
        capitalUpdatedAt: new Date(),
      },
    });
  } catch (err) {
    logger.error('Failed to update wallet capital', { address, error: err.message });
  }
}

/**
 * Deactivate a tracked wallet (stop copying it).
 * Does not delete — preserves historical trade data.
 *
 * @param {string} address
 */
async function deactivateTrackedWallet(address) {
  try {
    await prisma.trackedWallet.update({
      where: { address },
      data:  { isActive: false },
    });
    logger.info('Tracked wallet deactivated', { address: address.slice(0, 8) + '...' });
  } catch (err) {
    logger.error('Failed to deactivate tracked wallet', { error: err.message });
    throw err;
  }
}

/**
 * Increment trade count for a wallet and update lastTradeAt.
 *
 * @param {string} walletId - TrackedWallet UUID
 */
async function incrementWalletTradeCount(walletId) {
  try {
    await prisma.trackedWallet.update({
      where: { id: walletId },
      data: {
        totalTradesCopied: { increment: 1 },
        lastTradeAt:       new Date(),
        lastSeenAt:        new Date(),
      },
    });
  } catch (err) {
    logger.error('Failed to increment wallet trade count', { walletId, error: err.message });
  }
}

/**
 * Update a wallet's cumulative PnL and win/loss counts.
 *
 * @param {string} walletId
 * @param {number} pnlSOL
 * @param {boolean} isWin
 */
async function updateWalletPnL(walletId, pnlSOL, isWin) {
  try {
    await prisma.trackedWallet.update({
      where: { id: walletId },
      data: {
        totalPnLSOL: { increment: pnlSOL },
        totalWins:   isWin ? { increment: 1 } : undefined,
        totalLosses: !isWin ? { increment: 1 } : undefined,
      },
    });
  } catch (err) {
    logger.error('Failed to update wallet PnL', { walletId, error: err.message });
  }
}

// ────────────────────────────────────────────────────────────
//  WALLET TRADES (what THEY did)
// ────────────────────────────────────────────────────────────

/**
 * Save a detected trade from a tracked wallet.
 *
 * @param {object} data - WalletTrade fields
 * @returns {Promise<WalletTrade>}
 */
async function recordWalletTrade(data) {
  try {
    return await prisma.walletTrade.create({
      data: {
        id:               _generateId(),
        trackedWalletId:  data.trackedWalletId,
        txSignature:      data.txSignature,
        blockTime:        data.blockTime || new Date(),
        tradeType:        data.tradeType,
        tokenMint:        data.tokenMint,
        tokenSymbol:      data.tokenSymbol  || null,
        tokenName:        data.tokenName    || null,
        amountSOL:        data.amountSOL    || 0,
        amountTokens:     data.amountTokens || 0,
        pricePerTokenSOL: data.pricePerTokenSOL || 0,
        pricePerTokenUSD: data.pricePerTokenUSD || null,
        trackedCapitalSOL: data.trackedCapitalSOL || null,
        entryTradeId:     data.entryTradeId || null,
        pnlSOL:           data.pnlSOL       || null,
        pnlUSD:           data.pnlUSD       || null,
        pnlPct:           data.pnlPct       || null,
        isWin:            data.isWin        ?? null,
      },
    });
  } catch (err) {
    // Duplicate signature — already recorded
    if (err.code === 'P2002') {
      logger.debug('Wallet trade already recorded', {
        sig: data.txSignature?.slice(0, 8) + '...',
      });
      return prisma.walletTrade.findUnique({
        where: { txSignature: data.txSignature },
      });
    }
    logger.error('Failed to record wallet trade', { error: err.message });
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
//  OUR TRADES (what WE did)
// ────────────────────────────────────────────────────────────

/**
 * Save a copy trade we're about to execute (status: PENDING).
 *
 * @param {object} data - Trade fields
 * @returns {Promise<Trade>}
 */
async function recordMyTrade(data) {
  try {
    return await prisma.trade.create({
      data: {
        id:                 _generateId(),
        trackedWalletId:    data.trackedWalletId,
        walletTradeId:      data.walletTradeId,
        tradeType:          data.tradeType,
        status:             data.status || 'PENDING',
        tokenMint:          data.tokenMint,
        tokenSymbol:        data.tokenSymbol    || null,
        tokenName:          data.tokenName      || null,
        myCapitalSOL:       data.myCapitalSOL   || 0,
        trackedCapitalSOL:  data.trackedCapitalSOL || 0,
        scalingRatio:       data.scalingRatio   || 0,
        requestedAmountSOL: data.requestedAmountSOL || 0,
        requestedPriceSOL:  data.requestedPriceSOL  || null,
        entryTradeId:       data.entryTradeId   || null,
        trackedPnlPct:      data.trackedPnlPct  || null,
        detectedAt:         data.detectedAt     || new Date(),
        isOpen:             data.tradeType === 'BUY',
        errorMessage:       data.errorMessage   || null,
        updatedAt:          new Date(),
      },
    });
  } catch (err) {
    logger.error('Failed to record our trade', { error: err.message });
    throw err;
  }
}

/**
 * Update a trade's status and execution data after Jupiter confirms.
 *
 * @param {string} tradeId  - Trade UUID
 * @param {object} updates  - Fields to update
 */
async function updateTradeStatus(tradeId, updates) {
  try {
    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status:            updates.status            || undefined,
        txSignature:       updates.txSignature       || undefined,
        submittedAt:       updates.submittedAt       || undefined,
        confirmedAt:       updates.confirmedAt       || undefined,
        executionMs:       updates.executionMs       ?? undefined,
        executedAmountSOL: updates.executedAmountSOL ?? undefined,
        amountTokens:      updates.amountTokens      ?? undefined,
        executedPriceSOL:  updates.executedPriceSOL  ?? undefined,
        executedPriceUSD:  updates.executedPriceUSD  ?? undefined,
        slippagePct:       updates.slippagePct       ?? undefined,
        pnlSOL:            updates.pnlSOL            ?? undefined,
        pnlUSD:            updates.pnlUSD            ?? undefined,
        pnlPct:            updates.pnlPct            ?? undefined,
        trackedPnlPct:     updates.trackedPnlPct     ?? undefined,
        pnlDeviation:      updates.pnlDeviation      ?? undefined,
        isWin:             updates.isWin             ?? undefined,
        isOpen:            updates.isOpen            ?? undefined,
        errorMessage:      updates.errorMessage      || undefined,
        updatedAt:         new Date(),
      },
    });
  } catch (err) {
    logger.error('Failed to update trade status', {
      tradeId,
      status: updates.status,
      error:  err.message,
    });
  }
}

// ────────────────────────────────────────────────────────────
//  TRADE QUERIES
// ────────────────────────────────────────────────────────────

/**
 * Get all currently open trades (our positions).
 * Used by positionTracker on startup and positionSyncJob.
 *
 * @returns {Promise<Trade[]>}
 */
async function getOpenTrades() {
  try {
    return await prisma.trade.findMany({
      where: {
        isOpen:    true,
        tradeType: 'BUY',
        status:    'CONFIRMED',
      },
      include: {
        trackedWallet: {
          select: { address: true, nickname: true },
        },
      },
      orderBy: { confirmedAt: 'asc' },
    });
  } catch (err) {
    logger.error('Failed to get open trades', { error: err.message });
    return [];
  }
}

/**
 * Get trades from the last 24 hours.
 * Powers the /pnl Telegram command and daily report.
 *
 * @returns {Promise<Trade[]>}
 */
async function get24HourTrades() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return await prisma.trade.findMany({
      where: {
        createdAt: { gte: since },
        status:    'CONFIRMED',
      },
      include: {
        trackedWallet: {
          select: { nickname: true, address: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  } catch (err) {
    logger.error('Failed to get 24h trades', { error: err.message });
    return [];
  }
}

/**
 * Get paginated trade history with optional filters.
 * Used by the dashboard trade history page.
 *
 * @param {object} options
 * @param {number} options.limit          - Records per page (default 50)
 * @param {number} options.offset         - Pagination offset
 * @param {string} options.walletAddress  - Filter by tracked wallet
 * @param {string} options.tradeType      - 'BUY' or 'SELL'
 * @param {string} options.result         - 'WIN' or 'LOSS'
 * @param {Date}   options.fromDate
 * @param {Date}   options.toDate
 * @returns {Promise<{trades: Trade[], total: number}>}
 */
async function getTradeHistory({
  limit        = 50,
  offset       = 0,
  walletAddress,
  tradeType,
  result,
  fromDate,
  toDate,
} = {}) {
  try {
    const where = { status: 'CONFIRMED' };

    if (walletAddress) {
      where.trackedWallet = { address: walletAddress };
    }
    if (tradeType) {
      where.tradeType = tradeType;
    }
    if (result === 'WIN')  where.isWin = true;
    if (result === 'LOSS') where.isWin = false;
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = fromDate;
      if (toDate)   where.createdAt.lte = toDate;
    }

    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        include: {
          trackedWallet: {
            select: { nickname: true, address: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.trade.count({ where }),
    ]);

    return { trades, total };
  } catch (err) {
    logger.error('Failed to get trade history', { error: err.message });
    return { trades: [], total: 0 };
  }
}

/**
 * Get a single trade by ID.
 *
 * @param {string} tradeId
 * @returns {Promise<Trade|null>}
 */
async function getTradeById(tradeId) {
  try {
    return await prisma.trade.findUnique({
      where:   { id: tradeId },
      include: {
        trackedWallet: true,
        walletTrade:   true,
      },
    });
  } catch (err) {
    logger.error('Failed to get trade by ID', { tradeId, error: err.message });
    return null;
  }
}

/**
 * Get today's total realized loss in SOL.
 * Used by risk manager to check daily loss limit.
 *
 * @returns {Promise<number>} Negative number (loss) or 0
 */
async function getTodayLossSOL() {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const result = await prisma.trade.aggregate({
      where: {
        createdAt: { gte: startOfDay },
        status:    'CONFIRMED',
        tradeType: 'SELL',
        isWin:     false,
        pnlSOL:    { not: null },
      },
      _sum: { pnlSOL: true },
    });

    return result._sum.pnlSOL || 0;
  } catch (err) {
    logger.error('Failed to get today loss SOL', { error: err.message });
    return 0;
  }
}

/**
 * Get aggregate stats for a time period.
 * Used by analytics API routes.
 *
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {Promise<object>}
 */
async function getAggregateStats(fromDate, toDate) {
  try {
    const where = {
      status:    'CONFIRMED',
      tradeType: 'SELL',
      isOpen:    false,
      createdAt: {},
    };
    if (fromDate) where.createdAt.gte = fromDate;
    if (toDate)   where.createdAt.lte = toDate;

    const [agg, wins, losses] = await Promise.all([
      prisma.trade.aggregate({
        where,
        _sum:   { pnlSOL: true, pnlUSD: true, executionMs: true },
        _count: { id: true },
        _avg:   { pnlPct: true, executionMs: true },
        _max:   { pnlSOL: true, pnlPct: true },
        _min:   { pnlSOL: true, pnlPct: true },
      }),
      prisma.trade.count({ where: { ...where, isWin: true  } }),
      prisma.trade.count({ where: { ...where, isWin: false } }),
    ]);

    const total   = agg._count.id || 0;
    const winRate = total > 0 ? (wins / total) * 100 : 0;

    return {
      totalTrades:      total,
      wins,
      losses,
      winRatePct:       parseFloat(winRate.toFixed(2)),
      netPnLSOL:        agg._sum.pnlSOL     || 0,
      netPnLUSD:        agg._sum.pnlUSD     || 0,
      avgPnLPct:        agg._avg.pnlPct     || 0,
      bestPnLSOL:       agg._max.pnlSOL     || 0,
      worstPnLSOL:      agg._min.pnlSOL     || 0,
      bestPnLPct:       agg._max.pnlPct     || 0,
      worstPnLPct:      agg._min.pnlPct     || 0,
      avgExecutionMs:   Math.round(agg._avg.executionMs || 0),
    };
  } catch (err) {
    logger.error('Failed to get aggregate stats', { error: err.message });
    return {};
  }
}

// ────────────────────────────────────────────────────────────
//  DAILY PNL SNAPSHOTS
// ────────────────────────────────────────────────────────────

/**
 * Save or update the daily PnL snapshot for a given date.
 * Called by the daily cron job at midnight UTC.
 *
 * @param {string} date   - Format: "2024-03-01"
 * @param {object} data   - Aggregate stats for the day
 */
async function saveDailyPnL(date, data) {
  try {
    await prisma.dailyPnL.upsert({
      where:  { date },
      create: { id: _generateId(), date, ...data },
      update: data,
    });
    logger.info('Daily PnL saved', { date, netPnLSOL: data.netPnLSOL });
  } catch (err) {
    logger.error('Failed to save daily PnL', { date, error: err.message });
  }
}

/**
 * Get daily PnL records for the last N days.
 * Used by dashboard analytics charts.
 *
 * @param {number} days - Number of days to return (default 30)
 * @returns {Promise<DailyPnL[]>}
 */
async function getDailyPnLHistory(days = 30) {
  try {
    return await prisma.dailyPnL.findMany({
      orderBy: { date: 'desc' },
      take:    days,
    });
  } catch (err) {
    logger.error('Failed to get daily PnL history', { error: err.message });
    return [];
  }
}

// ────────────────────────────────────────────────────────────
//  NOTIFICATION LOGGING
// ────────────────────────────────────────────────────────────

/**
 * Log a Telegram notification that was sent.
 *
 * @param {object} data
 * @param {string} data.type     - NotificationType enum value
 * @param {string} data.message  - Full message text
 * @param {string} data.tradeId  - Related trade ID (optional)
 * @param {boolean} data.success - Whether send succeeded
 * @param {string} data.errorMsg - Error message if failed
 */
async function logNotification(data) {
  try {
    await prisma.notificationLog.create({
      data: {
        id:       _generateId(),
        type:     data.type,
        message:  data.message  || '',
        tradeId:  data.tradeId  || null,
        success:  data.success  ?? true,
        errorMsg: data.errorMsg || null,
      },
    });
  } catch (err) {
    // Non-critical — don't throw if notification logging fails
    logger.debug('Failed to log notification', { error: err.message });
  }
}

// ────────────────────────────────────────────────────────────
//  CONNECTION MANAGEMENT
// ────────────────────────────────────────────────────────────

/**
 * Connect Prisma to the database.
 * Called once at app startup.
 */
async function connect() {
  try {
    await prisma.$connect();
    logger.info('Database connected ✓');
  } catch (err) {
    logger.error('Database connection failed', { error: err.message });
    throw err;
  }
}

/**
 * Disconnect Prisma gracefully.
 * Called during app shutdown.
 */
async function disconnect() {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}

/**
 * Run a raw health check query.
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Generate a UUID v4 string for record IDs.
 * @returns {string}
 * @private
 */
function _generateId() {
  return require('crypto').randomUUID();
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  // Settings
  getSettings,
  updateSettings,
  pauseTrading,
  resumeTrading,

  // Tracked wallets
  getTrackedWallets,
  getTrackedWallet,
  addTrackedWallet,
  updateWalletCapital,
  deactivateTrackedWallet,
  incrementWalletTradeCount,
  updateWalletPnL,

  // Trade writes
  recordWalletTrade,
  recordMyTrade,
  updateTradeStatus,

  // Trade reads
  getOpenTrades,
  get24HourTrades,
  getTradeHistory,
  getTradeById,
  getTodayLossSOL,
  getAggregateStats,

  // Daily PnL
  saveDailyPnL,
  getDailyPnLHistory,

  // Notifications
  logNotification,

  // Connection
  connect,
  disconnect,
  healthCheck,

  // Expose prisma for advanced queries in jobs
  prisma,
};