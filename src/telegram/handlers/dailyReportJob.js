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
//
//  Intelligence integration (new):
//    - Starts walletIntelligence job at 23:50 UTC nightly
//    - Intelligence job runs the AI pipeline and schedules
//      the wallet swap for 00:01 UTC (1 min after midnight)
//    - At 00:00 UTC this file sends the daily PnL report
//    - At 00:01 UTC walletIntelligence sends the AI summary
//      and swaps in the new AI-selected wallet roster
//    - Exports runIntelligenceNow + getLastIntelligence
//      so bot.js can wire /testintelligence and /intelligence
// ============================================================

'use strict';

const cron               = require('node-cron');
const tradeRepository    = require('../../execution/tradeRepository');
const { calculateDailyStats } = require('../../utils/calculator');
const { formatDailyReport }   = require('./tradeNotifier');
const { getSOLPrice }    = require('../../utils/solana');
const walletMonitor      = require('../../monitor/walletMonitor');
const walletIntelligence = require('../../jobs/walletIntelligence');
const logger             = require('../../utils/logger');

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

// Telegram send function — injected from bot.js via index.js
let _sendFn = null;

// Cron job handles so we can stop them cleanly
let _dailyJob     = null;
let _heartbeatJob = null;

// Track consecutive heartbeat failures before alerting
let _heartbeatFailCount = 0;
const ALERT_AFTER_FAILURES = 3; // Alert after 3 consecutive bad checks (~30 min)

// ────────────────────────────────────────────────────────────
//  INITIALIZATION
// ────────────────────────────────────────────────────────────

/**
 * Start all scheduled jobs.
 * Call this once at app startup after the Telegram bot is ready.
 * Also starts the walletIntelligence nightly job (23:50 UTC).
 *
 * @param {Function} sendFn - The bot.send() function from bot.js
 */
function start(sendFn) {
  _sendFn = sendFn;

  // ── Daily PnL report at midnight UTC ────────────────────
  // "0 0 * * *" = minute 0, hour 0, every day
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

  // ── AI Wallet Intelligence job (23:50 UTC nightly) ───────
  // Runs 10 minutes before midnight so the AI report is ready
  // by the time the daily PnL report fires at 00:00 UTC.
  // The wallet swap itself fires at 00:01 UTC (inside that job).
  walletIntelligence.start(sendFn);

  logger.info('Scheduled jobs started', {
    dailyReport:  '00:00 UTC daily',
    heartbeat:    'every 10 minutes',
    intelligence: '23:50 UTC nightly',
  });
}

/**
 * Stop all scheduled jobs cleanly including intelligence.
 */
function stop() {
  if (_dailyJob)     { _dailyJob.stop();     _dailyJob = null; }
  if (_heartbeatJob) { _heartbeatJob.stop(); _heartbeatJob = null; }
  walletIntelligence.stop();
  logger.info('Scheduled jobs stopped');
}

// ────────────────────────────────────────────────────────────
//  DAILY REPORT
//  Runs at midnight UTC — summarises the completed day
// ────────────────────────────────────────────────────────────

/**
 * Generate, save, and send the daily PnL report.
 * Also handles daily loss limit checks and auto-pause.
 * Also previews the intelligence report if it's ready.
 * Can be called manually: node -e "require('./dailyReportJob').runDailyReport()"
 */
async function runDailyReport() {
  try {
    logger.info('Generating daily report...');

    // ── Get yesterday's date string ──────────────────────
    // At midnight, "yesterday" is the day that just ended
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const dateStr   = yesterday.toISOString().split('T')[0]; // "2026-03-03"
    const dateLabel = yesterday.toLocaleDateString('en-US', {
      weekday:  'long',
      month:    'long',
      day:      'numeric',
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
      totalTradesExecuted: stats.totalTrades   || 0,
      totalWins:           stats.wins           || 0,
      totalLosses:         stats.losses         || 0,
      winRatePct:          stats.winRatePct     || 0,
      grossPnLSOL:         stats.grossPnLSOL   || 0,
      netPnLSOL:           stats.netPnLSOL     || 0,
      netPnLUSD:           stats.netPnLUSD     || null,
      roiPct:              stats.roiPct        || 0,
      feesSOL:             stats.feesSOL       || 0,
      bestTradePnLSOL:     stats.bestTrade?.pnlSOL  || null,
      bestTradePnLPct:     stats.bestTrade?.pnlPct  || null,
      worstTradePnLSOL:    stats.worstTrade?.pnlSOL || null,
      worstTradePnLPct:    stats.worstTrade?.pnlPct || null,
      endingCapitalSOL:    settings.myCapitalSOL,
    });

    // ── Send Telegram daily report ────────────────────────
    const message = formatDailyReport({
      stats,
      capitalSOL:  settings.myCapitalSOL,
      solPriceUSD,
      date:        dateLabel,
    });

    await _send('DAILY_REPORT', {
      message,
      stats,
      capitalSOL:  settings.myCapitalSOL,
      solPriceUSD,
      date:        dateLabel,
    });

    logger.info('Daily report sent', {
      date:    dateStr,
      netPnL:  stats.netPnLSOL.toFixed(4) + ' SOL',
      trades:  stats.totalTrades,
      winRate: stats.winRatePct.toFixed(1) + '%',
    });

    // ── Intelligence report preview ───────────────────────
    // If the 23:50 intelligence job finished in time, preview it.
    // The full AI summary + wallet swap fires at 00:01 (that job's timer).
    const lastIntel = walletIntelligence.getLastReport();
    if (lastIntel && lastIntel.forDate === _tomorrowDateStr()) {
      await _sendRaw(
        `🤖 _AI wallet intelligence report is ready._\n` +
        `_New wallet roster will activate in ~1 minute..._`
      ).catch(() => {});
    }

    // ── Daily loss limit check ────────────────────────────
    if (settings.dailyLossLimitSOL > 0) {
      const lossSOL = Math.abs(Math.min(stats.netPnLSOL, 0));
      if (lossSOL >= settings.dailyLossLimitSOL) {
        logger.warn('Daily loss limit was hit — auto-pausing for new day', {
          loss:  lossSOL.toFixed(4),
          limit: settings.dailyLossLimitSOL,
        });

        await tradeRepository.pauseTrading(
          `Daily loss limit hit: ${lossSOL.toFixed(4)} SOL lost ` +
          `(limit: ${settings.dailyLossLimitSOL} SOL)`
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

    await _sendRaw(
      `⚠️ *Daily report generation failed*\n\n` +
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
      tradeRepository.healthCheck(),
    ]);

    const dbOk  = checks[0]?.status === 'fulfilled' && checks[0]?.value === true;
    const wsOk  = walletMonitor.getStatus().wsConnected;
    const allOk = dbOk && wsOk;

    if (allOk) {
      if (_heartbeatFailCount > 0) {
        logger.info('Heartbeat: system recovered', { failCount: _heartbeatFailCount });
        _heartbeatFailCount = 0;
        await _sendRaw('🟢 *System recovered*\n\nAll connections restored.').catch(() => {});
      }
      _heartbeatFailCount = 0;
      return;
    }

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

      // Reset counter — next alert after another 3 failures
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

/** Send a typed notification via the injected send function. */
async function _send(type, data) {
  if (!_sendFn) {
    logger.warn('dailyReportJob: sendFn not set, skipping notification');
    return;
  }
  return _sendFn(type, data);
}

/** Send a raw markdown string directly to Telegram. */
async function _sendRaw(markdownText) {
  if (!_sendFn) return;
  return _sendFn('RAW', { message: markdownText });
}

/** Return tomorrow's date string "YYYY-MM-DD" in UTC. */
function _tomorrowDateStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  runDailyReport,   // test: node -e "require('./dailyReportJob').runDailyReport()"
  runHeartbeat,

  // Intelligence pass-throughs — used by bot.js for /testintelligence, /intelligence
  runIntelligenceNow:  walletIntelligence.runNow,
  getLastIntelligence: walletIntelligence.getLastReport,
};
