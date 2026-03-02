// ============================================================
//  SOL SYSTEMS — Main Entry Point
//  File: src/index.js
// ============================================================

'use strict';

process.title = 'sol-systems';

const logger          = require('./utils/logger');
const tradeRepository = require('./execution/tradeRepository');
const positionTracker = require('./monitor/positionTracker');
const walletMonitor   = require('./monitor/walletMonitor');
const heliusWebhook   = require('./monitor/heliusWebhook');
const tradeExecutor   = require('./execution/tradeExecutor');
const apiServer       = require('./api/server');
const telegramBot     = require('./telegram/bot');
const dailyReportJob  = require('./telegram/handlers/dailyReportJob');
const priceSync       = require('./jobs/priceSync');
const walletSync      = require('./jobs/walletSync');
const cleanupJob      = require('./jobs/cleanup');

async function main() {
  logger.info('═══════════════════════════════════════');
  logger.info('  SOL SYSTEMS — Copy Trading Bot');
  logger.info('  Starting up...');
  logger.info('═══════════════════════════════════════');

  logger.info('[1/10] Connecting to database...');
  await tradeRepository.connect();

  logger.info('[2/10] Loading settings...');
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

  logger.info('[3/10] Starting API server...');
  await apiServer.start();

  logger.info('[4/10] Starting Telegram bot...');
  await telegramBot.start();

  logger.info('[5/10] Restoring open positions...');
  const openTrades = await tradeRepository.getOpenTrades();
  positionTracker.loadFromDatabase(openTrades);
  logger.info(`Restored ${openTrades.length} open position(s) from database`);

  logger.info('[6/10] Loading tracked wallets...');
  const trackedWallets = await tradeRepository.getTrackedWallets(true);
  logger.info(`Found ${trackedWallets.length} active tracked wallet(s)`, {
    wallets: trackedWallets.map(w => w.nickname),
  });
  if (trackedWallets.length === 0) {
    logger.warn('No wallets configured yet. Use /addwallet in Telegram to start copying trades.');
  }

  logger.info('[7/10] Starting wallet monitor...');
  await walletMonitor.start(
    trackedWallets.map(w => ({ id: w.id, address: w.address, nickname: w.nickname }))
  );

  logger.info('[8/10] Initializing Helius webhook handler...');
  heliusWebhook.init(walletMonitor);

  logger.info('[9/10] Starting trade executor...');
  tradeExecutor.init(walletMonitor, heliusWebhook, telegramBot);

  logger.info('[10/10] Starting scheduled jobs...');
  dailyReportJob.start(telegramBot.send);
  priceSync.start(apiServer.broadcast);       // ← NEW: live price updates every 60s
  walletSync.start();
  cleanupJob.start();

  logger.info('═══════════════════════════════════════');
  logger.info('  ✅ SOL SYSTEMS ONLINE');
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
  logger.info(`Shutdown signal received: ${signal}`);
  logger.info('Shutting down gracefully...');
  try {
    priceSync.stop();                 // ← NEW: stop price sync cleanly
    walletSync.stop();
    cleanupJob.stop();
    dailyReportJob.stop();
    walletMonitor.stop();
    telegramBot.stop();
    await apiServer.stop();
    await tradeRepository.disconnect();
    logger.info('Shutdown complete. Goodbye.');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || reason });
});

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});