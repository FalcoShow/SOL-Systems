// ============================================================
//  SOL SYSTEMS — Daily Report Job
//  File: src/telegram/handlers/dailyReportJob.js
//
//  Cron scheduler that automatically fires at midnight UTC
//  every night and sends a full daily summary to Telegram.
//
//  Schedule: "0 0 * * *" = 00:00 UTC daily
//
//  What it does at midnight:
//    1. Calculates full day's PnL and stats
//    2. Saves a DailyPnL snapshot to the database
//    3. Sends the formatted daily report to Telegram
//    4. Checks if daily loss limit was hit today
//    5. Auto-pauses trading if limit was hit
//    6. Resets the daily loss counter for the new day
//
//  Also runs a lighter "heartbeat" check every 10 minutes
//  that verifies the system is still healthy and fires an
//  alert if anything critical breaks silently overnight.
// ============================================================

'use strict';

const cron            = require('node-cron');
const tradeRepository = require('../../execution/tradeRepository');
const { calculateDailyStats } = require('../../utils/calculator');
const { _format24hReport }    = require('./pnlHandler');
const { formatDailyReport }   = require('./tradeNotifier');
const { getSOLPrice, getSOLBalance } = require('../../utils/solana');
const walletMonitor   = require('../../monitor/walletMonitor');
const config          = require('../../config');
const logger          = require('../../utils/logger');

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

// Telegram send function — injected from bot.js
let _sendFn = null;

// Cron job handles so we can stop them cleanly
let _dailyJob     = null;
let _heartbeatJob = null;

// Track consecutive heartbeat failures before alerting
let _heartbeatFailCount = 0;
const ALERT_AFTER_FAILURES = 3; // Alert after 3 consecutive bad checks (30 min)

// ────────────────────────────────────────────────────────────
//  INITIALIZATION
// ────────────────────────────────────────────────────────────

/**
 * Start all scheduled jobs.
 * Call this once at app startup after the Telegram bot is ready.
 *
 * @param {Function} sendFn - The bot.send() function from bot.js
 */
function start(sendFn) {
  _sendFn = sendFn;

  // ── Daily report at midnight UTC ────────────────────────
  // "0 0 * * *" = minute 0, hour 0, every day, every month, every weekday
  _dailyJob = cron.schedule('0 0 * * *', async () => {
    logger.info('Daily report job triggered');
    await runDailyReport();
  }, {
    timezone: 'UTC',
  });

  // ── Heartbeat every 10 minutes ───────────────────────────
  // "*/10 * * * *" = every 10 minutes
  _heartbeatJob = cron.schedule('*/10 * * * *', async () => {
    await runHeartbeat();
  }, {
    timezone: 'UTC',
  });

  logger.info('Scheduled jobs started', {
    dailyReport: '00:00 UTC daily',
    heartbeat:   'every 10 minutes',
  });
}

/**
 * Stop all scheduled jobs cleanly.
 */
function stop() {
  if (_dailyJob)     { _dailyJob.stop();     _dailyJob = null; }
  if (_heartbeatJob) { _heartbeatJob.stop(); _heartbeatJob = null; }
  logger.info('Scheduled jobs stopped');
}

// ────────────────────────────────────────────────────────────
//  DAILY REPORT
//  Runs at midnight UTC — summarises the completed day
// ────────────────────────────────────────────────────────────

/**
 * Generate, save, and send the daily report.
 * Also handles daily loss limit checks and resets.
 * Can be called manually for testing: require and call directly.
 */
async function runDailyReport() {
  try {
    logger.info('Generating daily report...');

    // ── Get yesterday's date string ──────────────────────
    // At midnight, "yesterday" is the day that just ended
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0]; // "2024-03-01"
    const dateLabel = yesterday.toLocaleDateString('en-US', {
      weekday: 'long',
      month:   'long',
      day:     'numeric',
      timeZone: 'UTC',
    });

    // ── Fetch all of yesterday's confirmed trades ─────────
    const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
    const endOfDay   = new Date(dateStr + 'T23:59:59.999Z');

    const { trades } = await tradeRepository.getTradeHistory({
      fromDate: startOfDay,
      toDate:   endOfDay,
      limit:    1000,
      offset:   0,
    });

    // ── Get current capital and SOL price ─────────────────
    const [settings, solPriceUSD] = await Promise.all([
      tradeRepository.getSettings(),
      getSOLPrice().catch(() => 0),
    ]);

    // ── Calculate full day stats ──────────────────────────
    const stats = calculateDailyStats(
      trades,
      settings.myCapitalSOL,
      solPriceUSD
    );

    // ── Save daily snapshot to database ──────────────────
    await tradeRepository.saveDailyPnL(dateStr, {
      totalTradesExecuted: stats.totalTrades,
      wins:                stats.wins,
      losses:              stats.losses,
      winRatePct:          stats.winRatePct,
      grossPnLSOL:         stats.grossPnLSOL,
      netPnLSOL:           stats.netPnLSOL,
      netPnLUSD:           stats.netPnLUSD,
      roiPct:              stats.roiPct,
      feesSOL:             stats.feesSOL,
      avgExecutionMs:      stats.avgExecutionMs,
      bestTradePnLPct:     stats.bestTrade?.pnlPct   || null,
      worstTradePnLPct:    stats.worstTrade?.pnlPct  || null,
      bestTokenSymbol:     stats.bestTrade?.tokenSymbol  || null,
      worstTokenSymbol:    stats.worstTrade?.tokenSymbol || null,
      capitalSOL:          settings.myCapitalSOL,
    });

    // ── Send Telegram daily report ────────────────────────
    const message = formatDailyReport({
      stats,
      capitalSOL: settings.myCapitalSOL,
      solPriceUSD,
      date: dateLabel,
    });

    await _send('DAILY_REPORT', { message, stats, capitalSOL: settings.myCapitalSOL, solPriceUSD, date: dateLabel });

    logger.info('Daily report sent', {
      date:        dateStr,
      netPnL:      stats.netPnLSOL.toFixed(4) + ' SOL',
      trades:      stats.totalTrades,
      winRate:     stats.winRatePct.toFixed(1) + '%',
    });

    // ── Daily loss limit check ────────────────────────────
    // After the day ends, check if we hit the limit
    // Auto-pause if we did and notify the user
    if (settings.dailyLossLimitSOL > 0) {
      const lossSOL = Math.abs(Math.min(stats.netPnLSOL, 0));
      if (lossSOL >= settings.dailyLossLimitSOL) {
        logger.warn('Daily loss limit was hit — auto-pausing for new day', {
          loss:  lossSOL.toFixed(4),
          limit: settings.dailyLossLimitSOL,
        });

        await tradeRepository.pauseTrading(
          `Daily loss limit hit: ${lossSOL.toFixed(4)} SOL lost (limit: ${settings.dailyLossLimitSOL} SOL)`
        );

        await _sendRaw(
          `🚨 *TRADING PAUSED — DAILY LOSS LIMIT*\n\n` +
          `Yesterday's loss: \`${lossSOL.toFixed(4)} SOL\`\n` +
          `Configured limit: \`${settings.dailyLossLimitSOL} SOL\`\n\n` +
          `Trading has been paused for review.\n` +
          `Use /resume when ready to continue.`
        );
      }
    }

  } catch (err) {
    logger.error('Daily report job failed', { error: err.message, stack: err.stack });

    // Still try to notify about the failure
    await _sendRaw('⚠️ *Daily report generation failed*\n\n' +
      `Error: ${err.message}\n\nCheck server logs.`
    ).catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────
//  HEARTBEAT CHECK
//  Runs every 10 minutes — verifies system is still healthy
// ────────────────────────────────────────────────────────────

/**
 * Run a lightweight system health check.
 * Silently passes most of the time.
 * Fires an alert after 3 consecutive failures (~30 minutes down).
 */
async function runHeartbeat() {
  try {
    const checks = await Promise.allSettled([
      tradeRepository.healthCheck(),        // DB alive?
    ]);

    const dbOk     = checks[0]?.status === 'fulfilled' && checks[0]?.value === true;
    const wsOk     = walletMonitor.getStatus().wsConnected;
    const allOk    = dbOk && wsOk;

    if (allOk) {
      // Reset failure counter on success
      if (_heartbeatFailCount > 0) {
        logger.info('Heartbeat: system recovered', { failCount: _heartbeatFailCount });
        _heartbeatFailCount = 0;

        // Send recovery alert if we had been failing
        await _sendRaw('🟢 *System recovered*\n\nAll connections restored.').catch(() => {});
      }
      _heartbeatFailCount = 0;
      return;
    }

    // Something is wrong
    _heartbeatFailCount++;

    logger.warn('Heartbeat check failed', {
      dbOk,
      wsOk,
      failCount: _heartbeatFailCount,
    });

    // Only alert after consecutive failures — avoids false positives
    if (_heartbeatFailCount >= ALERT_AFTER_FAILURES) {
      const issues = [];
      if (!dbOk) issues.push('❌ Database disconnected');
      if (!wsOk) issues.push('❌ WebSocket disconnected');

      await _sendRaw(
        `🔴 *SYSTEM ALERT — ${_heartbeatFailCount * 10} min down*\n\n` +
        issues.join('\n') + '\n\n' +
        '_Attempting automatic reconnect..._\n' +
        `Check /status for details.`
      ).catch(() => {});

      // Reset counter so we don't spam — next alert after another 3 failures
      _heartbeatFailCount = 0;
    }

  } catch (err) {
    logger.error('Heartbeat job threw error', { error: err.message });
    _heartbeatFailCount++;
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Send a notification via the injected send function.
 * @private
 */
async function _send(type, data) {
  if (!_sendFn) {
    logger.warn('dailyReportJob: sendFn not set, skipping notification');
    return;
  }
  return _sendFn(type, data);
}

/**
 * Send a raw markdown string directly to Telegram.
 * Used for messages that don't fit a standard type.
 * @private
 */
async function _sendRaw(markdownText) {
  if (!_sendFn) return;
  return _sendFn('RAW', { message: markdownText });
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  runDailyReport,   // Exported so you can test with: node -e "require('./dailyReportJob').runDailyReport()"
  runHeartbeat,
};