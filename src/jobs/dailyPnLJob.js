// ============================================================
//  SOL SYSTEMS — Daily PnL Job
//  File: src/jobs/dailyPnLJob.js
//
//  Runs automatically at 00:00 UTC every day.
//  Also callable manually via /dailyreport in Telegram.
//
//  What it does:
//    1. Queries all CONFIRMED trades from the past 24 hours
//    2. Calculates: net PnL (SOL + USD), ROI%, win/loss counts,
//       win rate, best trade, worst trade, trade count
//    3. Saves a DailyPnL snapshot to the database
//       (used by the Analytics page's daily bar chart)
//    4. Sends the formatted report to your Telegram chat
//
//  Your copied trade records (Trade table) are NEVER modified —
//  this job only READS trades and WRITES to DailyPnL.
// ============================================================

'use strict';

const cron = require('node-cron');

const logger          = require('../utils/logger');
const tradeRepository = require('../execution/tradeRepository');
const { getSOLPrice } = require('../utils/solana');

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

let _cronJob        = null;
let _lastRunAt      = null;
let _lastReportData = null;

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

/**
 * Start the daily PnL cron job.
 * Fires at exactly 00:00 UTC every day.
 */
function start() {
  if (_cronJob) return;

  // Cron: minute hour day month weekday
  // '0 0 * * *' = midnight UTC every day
  _cronJob = cron.schedule('0 0 * * *', async () => {
    logger.info('Daily PnL job triggered by cron');
    await runDailyReport();
  }, { timezone: 'UTC' });

  logger.info('Daily PnL job scheduled', { schedule: '00:00 UTC daily' });
}

/**
 * Stop the cron job (called on graceful shutdown).
 */
function stop() {
  if (_cronJob) {
    _cronJob.stop();
    _cronJob = null;
    logger.info('Daily PnL job stopped');
  }
}

/**
 * Job health status — returned by /health endpoint and /status Telegram command.
 */
function getStatus() {
  return {
    running:        !!_cronJob,
    lastRunAt:      _lastRunAt,
    lastReportData: _lastReportData
      ? {
          date:        _lastReportData.date,
          netPnlSOL:   _lastReportData.netPnlSOL,
          tradeCount:  _lastReportData.tradeCount,
          winRate:     _lastReportData.winRate,
        }
      : null,
  };
}

// ────────────────────────────────────────────────────────────
//  CORE REPORT LOGIC
//  Extracted into its own function so it can be called from:
//    - The cron schedule (automatic midnight run)
//    - The Telegram /dailyreport command handler
//    - The API route POST /api/settings/test-telegram (preview)
// ────────────────────────────────────────────────────────────

/**
 * Run the full daily PnL calculation and send the Telegram report.
 *
 * @param {object}  [options]
 * @param {boolean} [options.skipTelegram=false]  - Compute but don't send to Telegram
 * @param {Date}    [options.forDate]             - Override date (defaults to yesterday UTC)
 *
 * @returns {Promise<DailyReport>} The computed report data
 */
async function runDailyReport(options = {}) {
  const { skipTelegram = false, forDate } = options;

  // ── Determine the 24-hour window ─────────────────────────
  // Default: yesterday 00:00 UTC → today 00:00 UTC
  // When called at midnight the "current day" just ended.
  const now       = new Date();
  const todayUTC  = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const windowEnd   = forDate ? new Date(forDate) : todayUTC;
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

  const dateLabel = windowStart.toISOString().slice(0, 10); // "YYYY-MM-DD"

  logger.info('Running daily PnL report', {
    date:   dateLabel,
    from:   windowStart.toISOString(),
    to:     windowEnd.toISOString(),
  });

  try {
    // ── 1. Fetch all confirmed closed trades in window ──────
    const { trades } = await tradeRepository.getTradeHistory({
      fromDate: windowStart,
      toDate:   windowEnd,
      limit:    10000,
      offset:   0,
    });

    // Only count closed (SELL-confirmed or completed) trades for PnL
    const closedTrades = trades.filter(
      (t) => t.pnlSOL !== null && t.pnlSOL !== undefined
    );

    // ── 2. Aggregate stats ───────────────────────────────────
    const tradeCount  = closedTrades.length;
    const wins        = closedTrades.filter((t) => (t.pnlSOL || 0) > 0);
    const losses      = closedTrades.filter((t) => (t.pnlSOL || 0) <= 0);
    const netPnlSOL   = closedTrades.reduce((sum, t) => sum + (t.pnlSOL || 0), 0);
    const winRate     = tradeCount > 0 ? (wins.length / tradeCount) * 100 : 0;

    // Best and worst trades
    const bestTrade  = wins.length > 0
      ? wins.reduce((best, t) => (t.pnlSOL > best.pnlSOL ? t : best))
      : null;
    const worstTrade = losses.length > 0
      ? losses.reduce((worst, t) => (t.pnlSOL < worst.pnlSOL ? t : worst))
      : null;

    // SOL → USD conversion
    let solPriceUSD = 0;
    try {
      solPriceUSD = await getSOLPrice();
    } catch {
      // Non-critical — report in SOL only if price fetch fails
    }

    const netPnlUSD = netPnlSOL * solPriceUSD;

    // Current capital for ROI% calculation
    const settings    = await tradeRepository.getSettings();
    const capitalSOL  = settings?.myCapitalSOL || 10;
    const roiPct      = capitalSOL > 0 ? (netPnlSOL / capitalSOL) * 100 : 0;

    // ── 3. Build the report object ───────────────────────────
    const report = {
      date:         dateLabel,
      windowStart:  windowStart.toISOString(),
      windowEnd:    windowEnd.toISOString(),
      tradeCount,
      wins:         wins.length,
      losses:       losses.length,
      winRate:      parseFloat(winRate.toFixed(2)),
      netPnlSOL:    parseFloat(netPnlSOL.toFixed(6)),
      netPnlUSD:    parseFloat(netPnlUSD.toFixed(2)),
      roiPct:       parseFloat(roiPct.toFixed(4)),
      solPriceUSD:  parseFloat(solPriceUSD.toFixed(2)),
      capitalSOL,
      bestTrade:    bestTrade  ? _summariseTrade(bestTrade)  : null,
      worstTrade:   worstTrade ? _summariseTrade(worstTrade) : null,
    };

    _lastReportData = report;

    // ── 4. Save DailyPnL snapshot to database ───────────────
    await _saveDailySnapshot(report);

    // ── 5. Send Telegram report ──────────────────────────────
    if (!skipTelegram) {
      await _sendTelegramReport(report);
    }

    _lastRunAt = new Date();
    logger.info('Daily PnL report complete', {
      date:       dateLabel,
      trades:     tradeCount,
      netPnlSOL:  netPnlSOL.toFixed(4),
      winRate:    winRate.toFixed(1) + '%',
    });

    return report;

  } catch (err) {
    logger.error('Daily PnL job failed', { error: err.message, date: dateLabel });
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
//  SAVE DAILY SNAPSHOT
//  Persists the report to the DailyPnL table so the Analytics
//  page can show the daily bar chart without re-aggregating.
// ────────────────────────────────────────────────────────────

async function _saveDailySnapshot(report) {
  try {
    // Upsert — if we re-run the report for the same date it overwrites
    await tradeRepository.rawPrisma.dailyPnL.upsert({
      where: { date: report.date },
      create: {
        date:                report.date,
        totalTradesExecuted: report.tradeCount    || 0,
        totalWins:           report.wins           || 0,
        totalLosses:         report.losses         || 0,
        winRatePct:          report.winRate         || 0,
        netPnLSOL:           report.netPnlSOL      || 0,
        netPnLUSD:           report.netPnlUSD      || null,
        roiPct:              report.roiPct          || 0,
        bestTradePnLSOL:     report.bestTrade?.pnlSOL   || null,
        bestTradePnLPct:     report.bestTrade?.pnlPct   || null,
        worstTradePnLSOL:    report.worstTrade?.pnlSOL  || null,
        worstTradePnLPct:    report.worstTrade?.pnlPct  || null,
        endingCapitalSOL:    report.capitalSOL      || null,
      },
      update: {
        totalTradesExecuted: report.tradeCount    || 0,
        totalWins:           report.wins           || 0,
        totalLosses:         report.losses         || 0,
        winRatePct:          report.winRate         || 0,
        netPnLSOL:           report.netPnlSOL      || 0,
        netPnLUSD:           report.netPnlUSD      || null,
        roiPct:              report.roiPct          || 0,
        bestTradePnLSOL:     report.bestTrade?.pnlSOL   || null,
        bestTradePnLPct:     report.bestTrade?.pnlPct   || null,
        worstTradePnLSOL:    report.worstTrade?.pnlSOL  || null,
        worstTradePnLPct:    report.worstTrade?.pnlPct  || null,
        endingCapitalSOL:    report.capitalSOL      || null,
      },
    });

    logger.debug('DailyPnL snapshot saved', { date: report.date });
  } catch (err) {
    // Non-fatal — report is still sent to Telegram even if DB write fails
    logger.error('Failed to save DailyPnL snapshot', { error: err.message });
  }
}

// ────────────────────────────────────────────────────────────
//  TELEGRAM REPORT
//  Formats and sends the daily summary message.
//  Matches the format defined in the roadmap (File 18).
// ────────────────────────────────────────────────────────────

async function _sendTelegramReport(report) {
  // Lazy-load bot to avoid circular dependency on startup
  let send;
  try {
    ({ send } = require('../telegram/bot'));
  } catch {
    logger.warn('Telegram bot not available — skipping daily report message');
    return;
  }

  const sign       = report.netPnlSOL >= 0 ? '+' : '';
  const roiSign    = report.roiPct    >= 0 ? '+' : '';
  const pnlEmoji   = report.netPnlSOL >= 0 ? '📈' : '📉';
  const resultLine = report.netPnlSOL >= 0 ? '✅ Profitable day' : '❌ Losing day';

  // Format best/worst trade lines
  const bestLine = report.bestTrade
    ? `🏆 Best: *${report.bestTrade.tokenSymbol}* ${sign}${report.bestTrade.pnlSOL.toFixed(4)} SOL (${sign}${report.bestTrade.pnlPct?.toFixed(1) || '?'}%)`
    : '🏆 Best: —';

  const worstLine = report.worstTrade
    ? `💀 Worst: *${report.worstTrade.tokenSymbol}* ${report.worstTrade.pnlSOL.toFixed(4)} SOL (${report.worstTrade.pnlPct?.toFixed(1) || '?'}%)`
    : '💀 Worst: —';

  const usdLine = report.solPriceUSD > 0
    ? ` (+$${Math.abs(report.netPnlUSD).toFixed(2)})`
    : '';

  const message = [
    `📊 *DAILY PnL REPORT — ${report.date}*`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `${pnlEmoji} *Net PnL:* ${sign}${report.netPnlSOL.toFixed(4)} SOL${usdLine}`,
    `📊 *ROI:* ${roiSign}${report.roiPct.toFixed(2)}%`,
    ``,
    `✅ Wins: *${report.wins}*  ❌ Losses: *${report.losses}*`,
    `🎯 Win Rate: *${report.winRate.toFixed(1)}%*`,
    `📋 Trades: *${report.tradeCount}*`,
    ``,
    bestLine,
    worstLine,
    ``,
    resultLine,
    `⏱ ${report.date} UTC`,
  ].join('\n');

  try {
    await send('RAW', { message });
    logger.info('Daily Telegram report sent', { date: report.date });
  } catch (err) {
    logger.error('Failed to send daily Telegram report', { error: err.message });
    // Don't rethrow — DB snapshot already saved, Telegram failure is non-fatal
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

function _summariseTrade(trade) {
  return {
    tokenSymbol: trade.tokenSymbol || 'UNKNOWN',
    tokenName:   trade.tokenName   || trade.tokenSymbol || 'UNKNOWN',
    pnlSOL:      parseFloat((trade.pnlSOL || 0).toFixed(6)),
    pnlPct:      trade.pnlPct ? parseFloat(trade.pnlPct.toFixed(2)) : null,
    txSignature: trade.exitTxSignature || trade.entryTxSignature || null,
  };
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { start, stop, getStatus, runDailyReport };