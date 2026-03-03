// ============================================================
//  SOL SYSTEMS — Wallet Intelligence Job
//  File: src/jobs/walletIntelligence.js
//
//  The nightly orchestrator that runs at 11:50 PM UTC.
//  Coordinates the full AI wallet selection pipeline:
//
//    11:50 PM UTC — Intelligence job starts
//      1. Read current capital from DB
//      2. Fetch candidates from Birdeye + GMGN (aggregator)
//      3. Score and select wallets via Claude AI
//      4. Save report to DB (WalletIntelligence table)
//      5. Serve HTML report at /intelligence/:date
//
//    12:00 AM UTC — Daily report fires (existing job)
//      6. Daily PnL report sent to Telegram
//      7. Intelligence Telegram summary sent right after
//      8. Old AI wallets removed from monitor
//         (existing manually-added wallets KEPT)
//      9. New AI wallets added to monitor + DB
//     10. Helius webhook updated with new addresses
//
//  Wallet swap rules:
//    - Only wallets added by AI (addedByAI=true) are removed
//    - Wallets you manually added are NEVER touched
//    - Old AI wallets with open positions keep tracking
//      until all positions close naturally
//    - New wallets start tracking immediately
//
//  This job is started from dailyReportJob.js at startup
//  and hooks into the midnight cron to fire after PnL report.
// ============================================================

'use strict';

const cron             = require('node-cron');
const tradeRepository  = require('../execution/tradeRepository');
const walletMonitor    = require('../monitor/walletMonitor');
const positionTracker  = require('../monitor/positionTracker');
const { getCandidates } = require('../ai/dataSources/aggregator');
const { runScoring }   = require('../ai/walletScorer');
const { getWalletStats } = require('../ai/dataSources/birdeye');
const { getSOLBalance } = require('../utils/solana');
const config           = require('../config');
const logger           = require('../utils/logger');

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

// Telegram send function — injected from dailyReportJob
let _sendFn     = null;

// Cron job handle
let _job        = null;

// Whether a run is currently in progress (prevent overlap)
let _isRunning  = false;

// The last completed report — cached for the HTTP route
let _lastReport = null;

// ────────────────────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────────────────────

/**
 * Start the wallet intelligence cron job.
 * Fires at 11:50 PM UTC — 10 minutes before the daily report.
 *
 * @param {Function} sendFn - Telegram send function from bot.js
 */
function start(sendFn) {
  _sendFn = sendFn;

  // "50 23 * * *" = 23:50 UTC every night
  _job = cron.schedule('50 23 * * *', async () => {
    logger.info('[Intelligence] Nightly job triggered (23:50 UTC)');
    await runIntelligenceJob();
  }, {
    timezone: 'UTC',
  });

  logger.info('[Intelligence] Wallet intelligence job scheduled', {
    schedule: '23:50 UTC nightly',
  });
}

/**
 * Stop the cron job cleanly.
 */
function stop() {
  if (_job) {
    _job.stop();
    _job = null;
    logger.info('[Intelligence] Job stopped');
  }
}

/**
 * Get the last completed report.
 * Used by the API route to serve the HTML report.
 *
 * @returns {object|null}
 */
function getLastReport() {
  return _lastReport;
}

/**
 * Manually trigger the intelligence job.
 * Useful for testing: /testintelligence Telegram command.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.testOnly=false] - If true, run the full AI pipeline
 *   but skip the wallet swap so existing wallets are not affected.
 * @returns {Promise<object>} The generated report
 */
async function runNow({ testOnly = false } = {}) {
  return runIntelligenceJob({ testOnly });
}

// ────────────────────────────────────────────────────────────
//  CORE JOB ORCHESTRATOR
// ────────────────────────────────────────────────────────────

/**
 * Run the full intelligence pipeline.
 * Called by cron at 23:50 UTC or manually via runNow().
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.testOnly=false] - Skip wallet swap (for /testintelligence)
 */
async function runIntelligenceJob({ testOnly = false } = {}) {
  if (_isRunning) {
    logger.warn('[Intelligence] Job already running — skipping this trigger');
    return null;
  }

  _isRunning = true;
  const startedAt = Date.now();

  // Figure out the date this report is FOR (tomorrow)
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const forDate = tomorrow.toISOString().split('T')[0]; // "2026-03-03"

  logger.info('[Intelligence] Starting pipeline', { forDate });

  // Create a PENDING record in DB immediately
  // This lets us track the job status even if it crashes
  let recordId = null;
  try {
    const record = await _createPendingRecord(forDate);
    recordId     = record?.id || null;
  } catch (err) {
    logger.warn('[Intelligence] Could not create pending DB record', {
      error: err.message,
    });
  }

  try {
    // ── Step 1: Get current capital ───────────────────────
    const [settings, liveBalance] = await Promise.allSettled([
      tradeRepository.getSettings(),
      getSOLBalance(config.wallet.publicKey).catch(() => null),
    ]);

    const settingsVal   = settings.status === 'fulfilled'  ? settings.value  : null;
    const balanceVal    = liveBalance.status === 'fulfilled' ? liveBalance.value : null;

    // Use live balance if available, else fall back to DB capital setting
    const capitalSOL = balanceVal
      ? parseFloat(balanceVal.toFixed(4))
      : parseFloat((settingsVal?.myCapitalSOL || 10).toFixed(4));

    logger.info('[Intelligence] Capital snapshot', { capitalSOL });

    // ── Step 2: Fetch + score candidates ──────────────────
    await _updateRecord(recordId, { status: 'RUNNING' });

    const { candidates, dataQuality } = await getCandidates();

    logger.info('[Intelligence] Candidates ready', {
      count:   candidates.length,
      quality: dataQuality,
    });

    // ── Step 3: AI scoring via Claude ─────────────────────
    const report = await runScoring({
      candidates,
      capitalSOL,
      forDate,
      dataQuality,
    });

    // Attach data quality to report for DB storage
    report.dataQuality = dataQuality;

    // ── Step 4: Save full report to DB ────────────────────
    await _saveReport(recordId, forDate, capitalSOL, report, dataQuality);

    // Cache for HTTP route
    _lastReport = { forDate, report };

    // ── Step 5: Swap wallets at midnight ──────────────────
    // We schedule the actual swap for 00:01 UTC so it fires
    // cleanly AFTER the daily PnL report at 00:00 UTC.
    // In testOnly mode (from /testintelligence), skip the swap
    // so existing wallets are not affected.
    if (testOnly) {
      logger.info('[Intelligence] testOnly mode — wallet swap skipped');
    } else {
      _scheduleWalletSwap(report, forDate);
    }

    logger.info('[Intelligence] Pipeline complete', {
      forDate,
      wallets:    report.wallets.length,
      confidence: report.confidence,
      elapsed:    Math.round((Date.now() - startedAt) / 1000) + 's',
    });

    return report;

  } catch (err) {
    logger.error('[Intelligence] Pipeline failed', {
      error: err.message,
      stack: err.stack,
    });

    await _updateRecord(recordId, {
      status:       'FAILED',
      errorMessage: err.message,
    });

    // Send failure alert to Telegram
    await _sendRaw(
      `⚠️ *AI Intelligence Job Failed*\n\n` +
      `Error: ${err.message}\n\n` +
      `Existing wallets will continue tracking.\n` +
      `Check Railway logs for details.`
    ).catch(() => {});

    return null;

  } finally {
    _isRunning = false;
  }
}

// ────────────────────────────────────────────────────────────
//  WALLET SWAP LOGIC
// ────────────────────────────────────────────────────────────

/**
 * Schedule the wallet swap for 00:01 UTC (1 minute after midnight).
 * This ensures the daily PnL report fires first at 00:00.
 *
 * @param {object} report  - The AI report from walletScorer
 * @param {string} forDate - Date string
 * @private
 */
function _scheduleWalletSwap(report, forDate) {
  const msUntilSwap = _msUntilUTCTime(0, 1); // 00:01 UTC

  logger.info('[Intelligence] Wallet swap scheduled', {
    forDate,
    inMs: msUntilSwap,
    inMin: Math.round(msUntilSwap / 60000),
  });

  setTimeout(async () => {
    try {
      await _executeWalletSwap(report, forDate);
    } catch (err) {
      logger.error('[Intelligence] Wallet swap failed', { error: err.message });
      await _sendRaw(
        `⚠️ *Wallet swap failed at midnight*\n\nError: ${err.message}\n` +
        `Previous wallets still active. Manual intervention may be needed.`
      ).catch(() => {});
    }
  }, msUntilSwap);
}

/**
 * Execute the actual wallet swap:
 *   1. Identify current AI-managed wallets
 *   2. Find which have open positions (keep tracking those)
 *   3. Remove AI wallets with no open positions
 *   4. Add new AI-recommended wallets
 *   5. Update DB tracking records
 *   6. Send Telegram intelligence summary
 *
 * @param {object} report
 * @param {string} forDate
 * @private
 */
async function _executeWalletSwap(report, forDate) {
  logger.info('[Intelligence] Executing wallet swap', { forDate });

  // ── Get current state ─────────────────────────────────
  const allTracked     = await tradeRepository.getTrackedWallets(true);
  const aiWallets      = allTracked.filter((w) => w.addedByAI === true);
  const manualWallets  = allTracked.filter((w) => w.addedByAI !== true);
  const openPositions  = positionTracker.getSummary().positions || [];

  // Set of token addresses currently held (to identify active wallets)
  const walletsWithOpenPositions = new Set(
    openPositions.map((p) => p.trackedWalletAddress).filter(Boolean)
  );

  logger.info('[Intelligence] Swap analysis', {
    aiWallets:    aiWallets.length,
    manualWallets: manualWallets.length,
    openPositions: openPositions.length,
  });

  // ── Step 1: Remove old AI wallets (no open positions) ─
  const removed = [];
  for (const wallet of aiWallets) {
    const hasOpenPos = walletsWithOpenPositions.has(wallet.address);

    if (hasOpenPos) {
      // Keep tracking — has open positions that need to close naturally
      logger.info('[Intelligence] Keeping old AI wallet (open positions)', {
        nickname: wallet.nickname,
        address:  wallet.address.slice(0, 8) + '...',
      });
      continue;
    }

    // Safe to remove — no open positions
    try {
      // Deactivate in DB
      await tradeRepository.deactivateTrackedWallet(wallet.address);

      // Update AI tracking fields
      await tradeRepository.prisma.trackedWallet.update({
        where: { address: wallet.address },
        data:  { aiRemovedAt: new Date() },
      });

      // Remove from live monitor
      walletMonitor.removeWallet(wallet.address);

      removed.push({ address: wallet.address, nickname: wallet.nickname });

      logger.info('[Intelligence] Removed old AI wallet', {
        nickname: wallet.nickname,
        address:  wallet.address.slice(0, 8) + '...',
      });
    } catch (err) {
      logger.warn('[Intelligence] Failed to remove wallet', {
        address: wallet.address.slice(0, 8) + '...',
        error:   err.message,
      });
    }
  }

  // ── Step 2: Add new AI-recommended wallets ────────────
  const added = [];
  for (const rec of report.wallets) {
    if (!rec.address) continue;

    // Check if already being tracked (manual or AI)
    const existing = await tradeRepository.getTrackedWallet(rec.address);

    if (existing && existing.isActive) {
      logger.info('[Intelligence] Wallet already tracked — updating nickname', {
        address:  rec.address.slice(0, 8) + '...',
        nickname: rec.nickname,
      });
      // Update nickname and mark as AI-managed
      await tradeRepository.prisma.trackedWallet.update({
        where: { address: rec.address },
        data: {
          nickname:       rec.nickname,
          addedByAI:      true,
          aiAddedAt:      new Date(),
          intelligenceId: forDate,
          allocationSOL:  rec.allocationSOL || null,
          trackFrom:      rec.trackFrom     || null,
          trackUntil:     rec.trackUntil    || null,
        },
      });
      continue;
    }

    try {
      // Add to DB
      const dbWallet = await tradeRepository.prisma.trackedWallet.upsert({
        where:  { address: rec.address },
        create: {
          id:                  require('crypto').randomUUID(),
          address:             rec.address,
          nickname:            rec.nickname,
          isActive:            true,
          estimatedCapitalSOL: rec.estimatedCapSOL || 0,
          addedByAI:           true,
          aiAddedAt:           new Date(),
          intelligenceId:      forDate,
          allocationSOL:       rec.allocationSOL   || null,
          trackFrom:           rec.trackFrom       || null,
          trackUntil:          rec.trackUntil      || null,
        },
        update: {
          isActive:        true,
          nickname:        rec.nickname,
          addedByAI:       true,
          aiAddedAt:       new Date(),
          intelligenceId:  forDate,
          aiRemovedAt:     null,
          allocationSOL:   rec.allocationSOL   || null,
          trackFrom:       rec.trackFrom       || null,
          trackUntil:      rec.trackUntil      || null,
        },
      });

      // Add to live monitor
      await walletMonitor.addWallet({
        id:       dbWallet.id,
        address:  rec.address,
        nickname: rec.nickname,
      });

      // ── Capital re-estimation ─────────────────────────
      // Newly added AI wallets start with estimatedCapitalSOL = 0,
      // which causes scalePositionSize() to use a rough fallback.
      // Call Birdeye immediately to get a real estimate so the
      // very first copied trade is sized correctly.
      try {
        const stats = await getWalletStats(rec.address);
        if (stats?.estimatedCapSOL > 0) {
          await tradeRepository.prisma.trackedWallet.update({
            where: { address: rec.address },
            data:  {
              estimatedCapitalSOL: stats.estimatedCapSOL,
              capitalUpdatedAt:    new Date(),
            },
          });
          logger.info('[Intelligence] Capital estimated for new wallet', {
            nickname:       rec.nickname,
            estimatedCapSOL: stats.estimatedCapSOL,
          });
        }
      } catch (capErr) {
        logger.warn('[Intelligence] Capital estimation failed — will use fallback sizing', {
          address: rec.address.slice(0, 8) + '...',
          error:   capErr.message,
        });
      }

      added.push({
        address:       rec.address,
        nickname:      rec.nickname,
        allocationSOL: rec.allocationSOL,
        trackFrom:     rec.trackFrom,
        trackUntil:    rec.trackUntil,
      });

      logger.info('[Intelligence] Added new AI wallet', {
        nickname:  rec.nickname,
        address:   rec.address.slice(0, 8) + '...',
        allocation: rec.allocationSOL + ' SOL',
        window:    `${rec.trackFrom} → ${rec.trackUntil}`,
      });

    } catch (err) {
      logger.error('[Intelligence] Failed to add wallet', {
        address: rec.address.slice(0, 8) + '...',
        error:   err.message,
      });
    }
  }

  // ── Step 3: Update DB record with results ─────────────
  await tradeRepository.prisma.walletIntelligence.updateMany({
    where: { forDate },
    data: {
      walletsAdded:   added.length,
      walletsRemoved: removed.length,
      addedWallets:   JSON.stringify(added),
      removedWallets: JSON.stringify(removed),
      status:         'COMPLETE',
    },
  });

  // ── Step 4: Send Telegram intelligence summary ────────
  await _sendRaw(report.telegramSummary);

  // Send a concise swap confirmation
  if (added.length > 0 || removed.length > 0) {
    const addedNames   = added.map((w) => w.nickname).join(', ');
    const removedNames = removed.map((w) => w.nickname).join(', ');

    await _sendRaw(
      `🔄 *Wallet Roster Updated*\n\n` +
      (added.length   > 0 ? `✅ Added: ${addedNames}\n`   : '') +
      (removed.length > 0 ? `🗑 Removed: ${removedNames}\n` : '') +
      `\n_All ${manualWallets.length} manual wallet(s) unchanged._`
    );
  }

  logger.info('[Intelligence] Wallet swap complete', {
    added:   added.length,
    removed: removed.length,
    manual:  manualWallets.length,
  });
}

// ────────────────────────────────────────────────────────────
//  DATABASE HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Create a PENDING intelligence record for today's run.
 * @param {string} forDate
 * @returns {Promise<object>}
 * @private
 */
async function _createPendingRecord(forDate) {
  try {
    return await tradeRepository.prisma.walletIntelligence.upsert({
      where:  { forDate },
      create: {
        id:             require('crypto').randomUUID(),
        forDate,
        capitalSOL:     0,
        reportJson:     {},
        telegramSummary: '',
        htmlReport:     '',
        status:         'PENDING',
      },
      update: {
        status:       'PENDING',
        errorMessage: null,
        generatedAt:  new Date(),
      },
    });
  } catch (err) {
    logger.warn('[Intelligence] Could not upsert pending record', {
      error: err.message,
    });
    return null;
  }
}

/**
 * Update an intelligence record's fields.
 * @param {string|null} id
 * @param {object} data
 * @private
 */
async function _updateRecord(id, data) {
  if (!id) return;
  try {
    await tradeRepository.prisma.walletIntelligence.update({
      where: { id },
      data,
    });
  } catch (err) {
    logger.debug('[Intelligence] Could not update DB record', { error: err.message });
  }
}

/**
 * Save the completed AI report to the DB.
 * @param {string|null} recordId
 * @param {string}      forDate
 * @param {number}      capitalSOL
 * @param {object}      report
 * @param {object}      dataQuality
 * @private
 */
async function _saveReport(recordId, forDate, capitalSOL, report, dataQuality) {
  const data = {
    capitalSOL,
    walletsRecommended: report.wallets.length,
    reportJson:         {
      wallets:   report.wallets,
      summary:   report.summary,
      confidence: report.confidence,
      strategyType: report.strategyType,
    },
    telegramSummary:    report.telegramSummary || '',
    htmlReport:         report.htmlReport      || '',
    status:             'COMPLETE',
    confidence:         report.confidence       || 0,
    birdeyeDataQuality: dataQuality?.birdeye    || 0,
    gmgnDataQuality:    dataQuality?.gmgn       || 0,
    cieloDataQuality:   dataQuality?.cielo      || 0,
  };

  try {
    if (recordId) {
      await tradeRepository.prisma.walletIntelligence.update({
        where: { id: recordId },
        data,
      });
    } else {
      await tradeRepository.prisma.walletIntelligence.upsert({
        where:  { forDate },
        create: {
          id:      require('crypto').randomUUID(),
          forDate,
          ...data,
          addedWallets:   '[]',
          removedWallets: '[]',
        },
        update: data,
      });
    }
    logger.info('[Intelligence] Report saved to DB', { forDate });
  } catch (err) {
    logger.error('[Intelligence] Failed to save report to DB', { error: err.message });
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Calculate milliseconds until the next occurrence of HH:MM UTC.
 * Used to schedule the wallet swap exactly at 00:01 UTC.
 *
 * @param {number} hour   - UTC hour (0-23)
 * @param {number} minute - UTC minute (0-59)
 * @returns {number} ms until that time
 * @private
 */
function _msUntilUTCTime(hour, minute) {
  const now    = new Date();
  const target = new Date();

  target.setUTCHours(hour, minute, 0, 0);

  // If target is in the past (e.g. it's already 00:05), add 24h
  if (target <= now) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - now.getTime();
}

/**
 * Send a raw markdown string to Telegram.
 * @param {string} text
 * @private
 */
async function _sendRaw(text) {
  if (!_sendFn) return;
  return _sendFn('RAW', { message: text });
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  runNow,
  getLastReport,
  runIntelligenceJob,
};