// ============================================================
//  SOL SYSTEMS — Main Entry Point
//  File: src/index.js
// ============================================================

'use strict';

// ── Fires before ANYTHING else — proves node is running in Railway logs ──
console.log('═══════════════════════════════════════════════');
console.log('  SOL SYSTEMS — Node process started');
console.log('  Time:', new Date().toISOString());
console.log('  PID:', process.pid);
console.log('  Node:', process.version);
console.log('═══════════════════════════════════════════════');

process.title = 'sol-systems';

// ── Load all modules (any require-time error will be caught) ──
let logger, tradeRepository, positionTracker, walletMonitor,
    heliusWebhook, tradeExecutor, apiServer, telegramBot,
    dailyReportJob, priceSync, walletSync, cleanupJob,
    positionGuardian, allocationManager, marketRegime, intradayRotation;

try {
  console.log('[boot] Loading modules...');
  logger          = require('./utils/logger');
  tradeRepository = require('./execution/tradeRepository');
  positionTracker = require('./monitor/positionTracker');
  walletMonitor   = require('./monitor/walletMonitor');
  heliusWebhook   = require('./monitor/heliusWebhook');
  tradeExecutor   = require('./execution/tradeExecutor');
  apiServer       = require('./api/server');
  telegramBot     = require('./telegram/bot');
  dailyReportJob  = require('./telegram/handlers/dailyReportJob');
  priceSync       = require('./jobs/priceSync');
  walletSync      = require('./jobs/walletSync');
  cleanupJob      = require('./jobs/cleanup');
  positionGuardian   = require('./jobs/positionGuardian');
  allocationManager  = require('./jobs/allocationManager');
  marketRegime       = require('./jobs/marketRegime');
  intradayRotation   = require('./jobs/intradayRotation');
  console.log('[boot] All modules loaded OK');
} catch (err) {
  console.error('[boot] FATAL — module load failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}

// ────────────────────────────────────────────────────────────
//  STARTUP SEQUENCE
// ────────────────────────────────────────────────────────────

async function main() {
  logger.info('═══════════════════════════════════════');
  logger.info('  SOL SYSTEMS — Copy Trading Bot');
  logger.info('  Starting up...');
  logger.info('═══════════════════════════════════════');

  // API server starts FIRST — so Railway healthcheck passes
  // immediately while the rest of the system boots in the background.
  logger.info('[1/14] Starting API server...');
  await apiServer.start();
  logger.info('[1/14] API server listening — healthcheck will now pass');

  logger.info('[2/14] Connecting to database...');
  await tradeRepository.connect();

  logger.info('[3/14] Loading settings...');
  const settings = await tradeRepository.getSettings();
  logger.info('Settings loaded', {
    capital:        settings.myCapitalSOL + ' SOL',
    trading:        settings.isTradingPaused ? 'PAUSED' : 'ACTIVE',
    maxPositions:   settings.maxOpenPositions,
    maxPositionPct: (settings.maxPositionPct * 100).toFixed(0) + '%',
    lossLimit:      settings.dailyLossLimitSOL + ' SOL',
  });

  if (settings.isTradingPaused) {
    logger.warn('⚠️  Trading is currently PAUSED', { reason: settings.pauseReason });
  }

  logger.info('[4/14] Starting Telegram bot...');
  await telegramBot.start();

  logger.info('[5/14] Restoring open positions...');
  const openTrades = await tradeRepository.getOpenTrades();
  positionTracker.loadFromDatabase(openTrades);
  logger.info(`Restored ${openTrades.length} open position(s) from database`);

  logger.info('[6/14] Loading tracked wallets...');
  const trackedWallets = await tradeRepository.getTrackedWallets(true);
  logger.info(`Found ${trackedWallets.length} active tracked wallet(s)`, {
    wallets: trackedWallets.map(w => w.nickname),
  });
  if (trackedWallets.length === 0) {
    logger.warn('No wallets configured yet. Add one via the Wallets page or /addwallet in Telegram.');
  }

  logger.info('[7/14] Starting wallet monitor...');
  await walletMonitor.start(
    trackedWallets.map(w => ({ id: w.id, address: w.address, nickname: w.nickname }))
  );

  logger.info('[8/14] Initializing Helius webhook handler...');
  heliusWebhook.init(walletMonitor);

  logger.info('[9/14] Starting trade executor...');
  tradeExecutor.init(walletMonitor, heliusWebhook, telegramBot);

  logger.info('[10/14] Starting scheduled jobs...');
  dailyReportJob.start(telegramBot.send);
  priceSync.start(apiServer.broadcast);
  walletSync.start();
  cleanupJob.start();

  logger.info('[11/14] Starting position guardian...');
  positionGuardian.start(telegramBot.send);

  logger.info('[12/14] Starting market regime detector...');
  marketRegime.start(telegramBot.send);

  logger.info('[13/14] Starting allocation manager...');
  allocationManager.start(telegramBot.send);

  logger.info('[14/14] Starting intraday rotation...');
  intradayRotation.start(telegramBot.send);

  logger.info('═══════════════════════════════════════');
  logger.info('  ✅ SOL SYSTEMS FULLY ONLINE');
  logger.info(`  💰 Capital:   ${settings.myCapitalSOL} SOL`);
  logger.info(`  👛 Wallets:   ${trackedWallets.length} tracked`);
  logger.info(`  📊 Positions: ${openTrades.length} open`);
  logger.info('═══════════════════════════════════════');

  await telegramBot.send('SYSTEM_ONLINE', {
    walletCount: trackedWallets.length,
    capitalSOL:  settings.myCapitalSOL,
  });
}

// ────────────────────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ────────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[shutdown] Signal: ${signal}`);
  try {
    intradayRotation.stop();
    allocationManager.stop();
    marketRegime.stop();
    positionGuardian.stop();
    priceSync.stop();
    walletSync.stop();
    cleanupJob.stop();
    dailyReportJob.stop();
    walletMonitor.stop();
    telegramBot.stop();
    await apiServer.stop();
    await tradeRepository.disconnect();
    console.log('[shutdown] Clean exit.');
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] Error:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  console.error('[error] Unhandled rejection:', msg);
  if (logger) logger.error('Unhandled promise rejection', { reason: msg });
});

main().catch((err) => {
  console.error('[fatal] Startup error:', err.message);
  console.error(err.stack);
  process.exit(1);
});