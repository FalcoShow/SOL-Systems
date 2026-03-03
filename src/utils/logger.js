// ============================================================
//  SOL SYSTEMS — Winston Logger
//  File: src/utils/logger.js
//
//  Provides a single shared logger instance used everywhere.
//
//  Outputs:
//    - Console  : colorized, human-readable (all levels)
//    - app.log  : full JSON log, rotates daily, kept 7 days
//    - error.log: errors only, rotates daily, kept 14 days
//
//  Usage anywhere in the app:
//    const logger = require('./utils/logger');
//    logger.info('Trade detected', { token: 'WIF', amount: 2.5 });
//    logger.warn('Slippage high', { slippagePct: 3.2 });
//    logger.error('Swap failed', { error: err.message });
//    logger.debug('Raw tx data', { tx });   // only shows in debug mode
// ============================================================

'use strict';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// ────────────────────────────────────────────────────────────
//  ENSURE LOGS DIRECTORY EXISTS
//  Create ./logs folder if it doesn't exist yet
// ────────────────────────────────────────────────────────────

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ────────────────────────────────────────────────────────────
//  LOG LEVEL
//  Read from config — defaults to 'info' in production,
//  'debug' recommended during development
// ────────────────────────────────────────────────────────────

// We read directly from process.env here (not from config/index.js)
// because the logger is initialized before config in some cases
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_RETENTION_DAYS = process.env.LOG_RETENTION_DAYS || '7';

// ────────────────────────────────────────────────────────────
//  CUSTOM LOG LEVELS & COLORS
//  Extends Winston defaults with trade-specific levels
// ────────────────────────────────────────────────────────────

const levels = {
  error:  0,   // System errors, failed trades, crashes
  warn:   1,   // High slippage, retries, skipped trades
  info:   2,   // Trade executions, bot start/stop, daily reports
  trade:  3,   // Every buy/sell detection and execution (custom)
  debug:  4,   // Detailed flow, raw API responses, timing data
};

const levelColors = {
  error:  'red',
  warn:   'yellow',
  info:   'cyan',
  trade:  'green',
  debug:  'gray',
};

winston.addColors(levelColors);

// ────────────────────────────────────────────────────────────
//  FORMATTERS
// ────────────────────────────────────────────────────────────

// Timestamp format: 2024-03-01 14:32:05.123
const timestampFormat = winston.format.timestamp({
  format: 'YYYY-MM-DD HH:mm:ss.SSS',
});

// Console format — colorized and human-readable
// Example: [2024-03-01 14:32:05.123] INFO  Trade detected { token: 'WIF', amountSOL: 2.5 }
const consoleFormat = winston.format.combine(
  timestampFormat,
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? ' ' + JSON.stringify(meta, null, 0)
      : '';
    return `[${timestamp}] ${level.padEnd(7)} ${message}${metaStr}`;
  })
);

// File format — clean JSON, one line per log entry
// Machines can parse this; useful for future analytics
const fileFormat = winston.format.combine(
  timestampFormat,
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// ────────────────────────────────────────────────────────────
//  TRANSPORTS
// ────────────────────────────────────────────────────────────

const transports = [];

// 1. Console — always on
transports.push(
  new winston.transports.Console({
    level: LOG_LEVEL,
    format: consoleFormat,
  })
);

// 2. Daily rotating app log — all levels
//    Writes to: logs/sol-systems-2024-03-01.log
//    Rotates at midnight, keeps last N days
transports.push(
  new DailyRotateFile({
    level: LOG_LEVEL,
    format: fileFormat,
    dirname: logsDir,
    filename: 'sol-systems-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: `${LOG_RETENTION_DAYS}d`,
    maxSize: '50m',          // Rotate if file hits 50MB regardless of date
    zippedArchive: true,     // Compress old log files to save disk space
    auditFile: path.join(logsDir, '.app-log-audit.json'),
  })
);

// 3. Daily rotating error log — errors only
//    Writes to: logs/sol-systems-errors-2024-03-01.log
//    Kept longer than app log (14 days) for debugging
transports.push(
  new DailyRotateFile({
    level: 'error',
    format: fileFormat,
    dirname: logsDir,
    filename: 'sol-systems-errors-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '14d',
    maxSize: '20m',
    zippedArchive: true,
    auditFile: path.join(logsDir, '.error-log-audit.json'),
  })
);

// ────────────────────────────────────────────────────────────
//  CREATE LOGGER INSTANCE
// ────────────────────────────────────────────────────────────

// Reuse the error transport for exceptions & rejections instead of
// creating extra DailyRotateFile instances (reduces listener count).
const errorTransport = transports.find((t) => t instanceof DailyRotateFile && t.level === 'error');

const logger = winston.createLogger({
  levels,
  level: LOG_LEVEL,
  transports,
  exitOnError: false,
  exceptionHandlers: [errorTransport],
  rejectionHandlers: [errorTransport],
});

// Raise maxListeners on DailyRotateFile transports to prevent
// "MaxListenersExceededWarning" — Winston attaches many piped
// stream listeners internally and 10 is not enough.
for (const t of transports) {
  if (t instanceof DailyRotateFile && typeof t.setMaxListeners === 'function') {
    t.setMaxListeners(20);
  }
}

// ────────────────────────────────────────────────────────────
//  HELPER METHODS
//  Convenience wrappers for common trading log patterns
// ────────────────────────────────────────────────────────────

/**
 * Log a detected trade on a tracked wallet
 * logger.tradeDetected('Cented', 'BUY', 'WIF', 2.5)
 */
logger.tradeDetected = (walletNickname, tradeType, tokenSymbol, amountSOL) => {
  logger.log('trade', `🔍 DETECTED ${tradeType} on ${walletNickname}`, {
    wallet: walletNickname,
    type: tradeType,
    token: tokenSymbol,
    amountSOL,
  });
};

/**
 * Log a copy trade we submitted
 * logger.tradeSubmitted('BUY', 'WIF', 1.25, '5KJp...')
 */
logger.tradeSubmitted = (tradeType, tokenSymbol, amountSOL, txSignature) => {
  logger.log('trade', `📤 SUBMITTED ${tradeType} copy trade`, {
    type: tradeType,
    token: tokenSymbol,
    amountSOL,
    tx: txSignature ? txSignature.slice(0, 8) + '...' : 'pending',
  });
};

/**
 * Log a confirmed copy trade with execution time
 * logger.tradeConfirmed('BUY', 'WIF', 1.25, '5KJp...', 847)
 */
logger.tradeConfirmed = (tradeType, tokenSymbol, amountSOL, txSignature, executionMs) => {
  const emoji = tradeType === 'BUY' ? '🟢' : '🔴';
  logger.log('trade', `${emoji} CONFIRMED ${tradeType} — ${tokenSymbol}`, {
    type: tradeType,
    token: tokenSymbol,
    amountSOL,
    tx: txSignature ? txSignature.slice(0, 8) + '...' : 'unknown',
    executionMs,
    speed: executionMs < 1000 ? 'FAST' : executionMs < 2000 ? 'OK' : 'SLOW',
  });
};

/**
 * Log a failed trade with reason
 * logger.tradeFailed('BUY', 'WIF', 'Slippage exceeded')
 */
logger.tradeFailed = (tradeType, tokenSymbol, reason) => {
  logger.error(`❌ FAILED ${tradeType} — ${tokenSymbol}`, {
    type: tradeType,
    token: tokenSymbol,
    reason,
  });
};

/**
 * Log a skipped trade with reason (risk manager blocked it)
 * logger.tradeSkipped('BUY', 'WIF', 'Max open positions reached')
 */
logger.tradeSkipped = (tradeType, tokenSymbol, reason) => {
  logger.warn(`⏭️  SKIPPED ${tradeType} — ${tokenSymbol}`, {
    type: tradeType,
    token: tokenSymbol,
    reason,
  });
};

/**
 * Log a PnL result when a position closes
 * logger.tradePnL('WIF', 0.187, 27.12, 219.6, true)
 */
logger.tradePnL = (tokenSymbol, pnlSOL, pnlUSD, pnlPct, isWin) => {
  const emoji = isWin ? '✅' : '❌';
  const sign = pnlSOL >= 0 ? '+' : '';
  logger.log('trade', `${emoji} PNL ${tokenSymbol} ${sign}${pnlPct.toFixed(1)}%`, {
    token: tokenSymbol,
    pnlSOL: `${sign}${pnlSOL.toFixed(4)}`,
    pnlUSD: `${sign}$${Math.abs(pnlUSD).toFixed(2)}`,
    pnlPct: `${sign}${pnlPct.toFixed(2)}%`,
    result: isWin ? 'WIN' : 'LOSS',
  });
};

// ────────────────────────────────────────────────────────────
//  STARTUP LOG
//  Confirms logger initialized correctly
// ────────────────────────────────────────────────────────────

logger.info('Logger initialized', {
  level: LOG_LEVEL,
  logsDir,
  retentionDays: LOG_RETENTION_DAYS,
});

module.exports = logger;