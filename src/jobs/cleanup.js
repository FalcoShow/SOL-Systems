// ============================================================
//  SOL SYSTEMS — Cleanup Job
//  File: src/jobs/cleanup.js
//
//  Runs daily at 01:00 UTC. Keeps the system lean:
//    1. Purges notification logs older than 7 days
//    2. Purges wallet trade records older than 90 days
//       (raw on-chain events, not our copied trades)
//    3. Rotates local log files older than retentionDays
//    4. Weekly VACUUM ANALYZE on all tables (Sundays)
//
//  Our copied trades (myTrades) are NEVER deleted —
//  they are your permanent PnL record.
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const logger          = require('../utils/logger');
const tradeRepository = require('../execution/tradeRepository');
const config          = require('../config');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const NOTIFICATION_RETENTION_DAYS  = 7;
const WALLET_TRADE_RETENTION_DAYS  = 90;
const LOG_RETENTION_DAYS           = config.logging?.retentionDays || 7;

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _dailyJob  = null;
let _lastRunAt = null;

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

function start() {
  if (_dailyJob) return;

  // Run at 01:00 UTC every day (after daily report at 00:00)
  _dailyJob = cron.schedule('0 1 * * *', async () => {
    logger.info('Cleanup job triggered');
    await runCleanup();
  }, { timezone: 'UTC' });

  logger.info('Cleanup job scheduled', { schedule: '01:00 UTC daily' });
}

function stop() {
  if (_dailyJob) {
    _dailyJob.stop();
    _dailyJob = null;
    logger.info('Cleanup job stopped');
  }
}

function getStatus() {
  return {
    running:   !!_dailyJob,
    lastRunAt: _lastRunAt,
  };
}

// ────────────────────────────────────────────────────────────
//  MAIN CLEANUP ROUTINE
// ────────────────────────────────────────────────────────────

async function runCleanup() {
  const results = {
    notificationsDeleted: 0,
    walletTradesDeleted:  0,
    logFilesDeleted:      0,
    vacuumRan:            false,
    errors:               [],
  };

  // ── 1. Purge old notification logs ───────────────────────
  try {
    const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 86400000);
    const del    = await tradeRepository.rawPrisma.notificationLog.deleteMany({
      where: { sentAt: { lt: cutoff } },
    });
    results.notificationsDeleted = del.count;
    logger.debug('Notifications purged', { count: del.count, olderThan: cutoff.toISOString() });
  } catch (err) {
    results.errors.push(`notifications: ${err.message}`);
    logger.warn('Failed to purge notifications', { error: err.message });
  }

  // ── 2. Purge old walletTrade records ─────────────────────
  // walletTrades = raw records of what tracked wallets did
  // These are just reference data — safe to purge after 90 days
  try {
    const cutoff = new Date(Date.now() - WALLET_TRADE_RETENTION_DAYS * 86400000);
    const del    = await tradeRepository.rawPrisma.walletTrade.deleteMany({
      where: { detectedAt: { lt: cutoff } },
    });
    results.walletTradesDeleted = del.count;
    logger.debug('Wallet trades purged', { count: del.count, olderThan: cutoff.toISOString() });
  } catch (err) {
    results.errors.push(`walletTrades: ${err.message}`);
    logger.warn('Failed to purge wallet trades', { error: err.message });
  }

  // ── 3. Rotate local log files ────────────────────────────
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    if (fs.existsSync(logsDir)) {
      const files   = fs.readdirSync(logsDir);
      const cutoff  = Date.now() - LOG_RETENTION_DAYS * 86400000;

      for (const file of files) {
        if (!file.endsWith('.log')) continue;
        const filePath = path.join(logsDir, file);
        const stat     = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          results.logFilesDeleted++;
          logger.debug('Log file deleted', { file });
        }
      }
    }
  } catch (err) {
    results.errors.push(`logFiles: ${err.message}`);
    logger.warn('Failed to rotate log files', { error: err.message });
  }

  // ── 4. Weekly VACUUM ANALYZE (Sundays only) ──────────────
  // VACUUM reclaims storage from deleted rows.
  // ANALYZE updates query planner statistics.
  // Only run on Sundays to avoid performance impact on trading days.
  const isSunday = new Date().getUTCDay() === 0;
  if (isSunday) {
    try {
      // Raw SQL — Prisma doesn't expose VACUUM directly
      await tradeRepository.rawPrisma.$executeRawUnsafe('VACUUM ANALYZE;');
      results.vacuumRan = true;
      logger.info('VACUUM ANALYZE complete');
    } catch (err) {
      // VACUUM can fail on Neon serverless — non-fatal
      results.errors.push(`vacuum: ${err.message}`);
      logger.warn('VACUUM failed (non-critical)', { error: err.message });
    }
  }

  // ── Summary log ──────────────────────────────────────────
  _lastRunAt = new Date();
  logger.info('Cleanup complete', {
    notificationsDeleted: results.notificationsDeleted,
    walletTradesDeleted:  results.walletTradesDeleted,
    logFilesDeleted:      results.logFilesDeleted,
    vacuumRan:            results.vacuumRan,
    errors:               results.errors.length,
  });

  return results;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop, getStatus, runCleanup };