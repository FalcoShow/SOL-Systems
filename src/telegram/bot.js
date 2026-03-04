// ============================================================
//  SOL SYSTEMS — Telegram Bot
//  File: src/telegram/bot.js
//
//  Main Telegram bot setup using the Telegraf framework.
//  Registers every command, routes to handlers, and provides
//  the send() function used by tradeExecutor for notifications.
//
//  Commands registered:
//    /start    — welcome + system status
//    /status   — full system health check
//    /pnl      — 24-hour PnL report
//    /pnl7d    — 7-day PnL summary
//    /trades   — last 10 executed trades
//    /positions — current open positions
//    /wallets  — tracked wallets list
//    /addwallet <address> <nickname> — start copying a wallet
//    /removewallet <address>         — stop copying a wallet
//    /pause    — pause all trading
//    /resume   — resume trading
//    /capital <amount>  — update starting capital
//    /intelligence      — show last AI wallet report
//    /testintelligence  — trigger AI pipeline manually
//    /help     — command list
//
//  Security:
//    Every message is checked against TELEGRAM_CHAT_ID.
//    The bot ONLY responds to your personal chat ID.
//    Any other user messaging the bot gets silently ignored.
// ============================================================

'use strict';

const { Telegraf, Markup } = require('telegraf');
const config               = require('../config');
const logger               = require('../utils/logger');
const tradeRepository      = require('../execution/tradeRepository');

// Handlers (built in Files 18–22)
const pnlHandler         = require('./handlers/pnlHandler');
const tradeNotifier      = require('./handlers/tradeNotifier');
const walletHandler      = require('./handlers/walletHandler');
const statusHandler      = require('./handlers/statusHandler');
const walletIntelligence = require('../jobs/walletIntelligence');

// ────────────────────────────────────────────────────────────
//  BOT INSTANCE
// ────────────────────────────────────────────────────────────

const bot = new Telegraf(config.telegram.botToken);

// Authorized chat ID — only messages from this ID are processed
const AUTHORIZED_CHAT_ID = config.telegram.chatId.toString();

// ────────────────────────────────────────────────────────────
//  SECURITY MIDDLEWARE
//  Runs before every command and message.
//  Silently drops anything not from your chat ID.
// ────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id?.toString();

  if (chatId !== AUTHORIZED_CHAT_ID) {
    logger.warn('Unauthorized Telegram message blocked', {
      fromChatId: chatId,
      username:   ctx.from?.username,
    });
    return; // Silently ignore — don't even reply
  }

  // Log every incoming command for audit trail
  if (ctx.message?.text) {
    logger.debug('Telegram command received', {
      text: ctx.message.text.slice(0, 50),
    });
  }

  return next();
});

// ────────────────────────────────────────────────────────────
//  ERROR HANDLER
//  Catches any unhandled errors in command handlers
// ────────────────────────────────────────────────────────────

bot.catch(async (err, ctx) => {
  logger.error('Telegram bot error', {
    error:   err.message,
    command: ctx.message?.text,
  });

  try {
    await ctx.reply(
      '❌ An error occurred processing that command.\n' +
      `Error: ${err.message}`
    );
  } catch (_) {
    // Reply failed — just log it
  }
});

// ────────────────────────────────────────────────────────────
//  /start — Welcome message
// ────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const settings = await tradeRepository.getSettings().catch(() => null);

  const message = [
    '🚀 *SOL SYSTEMS — Copy Trading Bot*',
    '━━━━━━━━━━━━━━━━━━━━━',
    '',
    '✅ Bot is online and running',
    '',
    `💰 Capital: *${settings?.myCapitalSOL?.toFixed(2) || '?'} SOL*`,
    `⚡ Trading: *${settings?.isTradingPaused ? '🔴 PAUSED' : '🟢 ACTIVE'}*`,
    '',
    'Use /help to see all commands',
    'Use /status for full system health',
  ].join('\n');

  await ctx.replyWithMarkdown(message, _mainKeyboard());
});

// ────────────────────────────────────────────────────────────
//  /help — Command list
// ────────────────────────────────────────────────────────────

bot.command('help', async (ctx) => {
  const message = [
    '📋 *SOL SYSTEMS — Command Reference*',
    '━━━━━━━━━━━━━━━━━━━━━',
    '',
    '📊 *Reports*',
    '/pnl — 24-hour PnL report',
    '/pnl7d — 7-day PnL summary',
    '/trades — Last 10 trades',
    '/positions — Open positions',
    '',
    '👛 *Wallets*',
    '/wallets — List tracked wallets',
    '/addwallet <address> <name> — Add wallet',
    '/removewallet <address> — Remove wallet',
    '',
    '⚙️ *Controls*',
    '/status — System health check',
    '/pause — Pause all trading',
    '/resume — Resume trading',
    '/capital <SOL> — Update capital',
    '',
    '🤖 *AI Intelligence*',
    '/intelligence — View last AI wallet report',
    '/testintelligence — Run AI pipeline (dry run)',
    '/golive — Run AI pipeline + activate wallets',
    '/cleanup — Purge ghost positions from DB',
    '',
    '💡 *Examples*',
    '/addwallet CyaE1V...ga54o Cented',
    '/capital 15.5',
  ].join('\n');

  await ctx.replyWithMarkdown(message);
});

// ────────────────────────────────────────────────────────────
//  /status — System health check
// ────────────────────────────────────────────────────────────

bot.command('status', async (ctx) => {
  await ctx.reply('🔍 Checking system status...');
  await statusHandler.handleStatus(ctx);
});

// ────────────────────────────────────────────────────────────
//  /pnl — 24-hour PnL report
// ────────────────────────────────────────────────────────────

bot.command('pnl', async (ctx) => {
  await ctx.reply('📊 Generating 24h PnL report...');
  await pnlHandler.handle24hPnL(ctx);
});

// ────────────────────────────────────────────────────────────
//  /pnl7d — 7-day PnL summary
// ────────────────────────────────────────────────────────────

bot.command('pnl7d', async (ctx) => {
  await ctx.reply('📈 Generating 7-day PnL summary...');
  await pnlHandler.handle7dPnL(ctx);
});

// ────────────────────────────────────────────────────────────
//  /trades — Last 10 executed trades
// ────────────────────────────────────────────────────────────

bot.command('trades', async (ctx) => {
  await pnlHandler.handleRecentTrades(ctx);
});

// ────────────────────────────────────────────────────────────
//  /positions — Current open positions
// ────────────────────────────────────────────────────────────

bot.command('positions', async (ctx) => {
  await pnlHandler.handlePositions(ctx);
});

// ────────────────────────────────────────────────────────────
//  /wallets — List tracked wallets
// ────────────────────────────────────────────────────────────

bot.command('wallets', async (ctx) => {
  await walletHandler.handleListWallets(ctx);
});

// ────────────────────────────────────────────────────────────
//  /addwallet <address> <nickname>
// ────────────────────────────────────────────────────────────

bot.command('addwallet', async (ctx) => {
  const parts    = ctx.message.text.trim().split(/\s+/);
  const address  = parts[1];
  const nickname = parts.slice(2).join(' ') || null;

  if (!address) {
    await ctx.replyWithMarkdown(
      '❌ *Usage:* `/addwallet <address> <nickname>`\n\n' +
      '*Example:*\n`/addwallet CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o Cented`'
    );
    return;
  }

  await ctx.reply('⏳ Adding wallet and estimating capital...');
  await walletHandler.handleAddWallet(ctx, address, nickname);
});

// ────────────────────────────────────────────────────────────
//  /removewallet <address>
// ────────────────────────────────────────────────────────────

bot.command('removewallet', async (ctx) => {
  const parts   = ctx.message.text.trim().split(/\s+/);
  const address = parts[1];

  if (!address) {
    await ctx.replyWithMarkdown(
      '❌ *Usage:* `/removewallet <address>`'
    );
    return;
  }

  await walletHandler.handleRemoveWallet(ctx, address);
});

// ────────────────────────────────────────────────────────────
//  /pause — Pause all trading
// ────────────────────────────────────────────────────────────

bot.command('pause', async (ctx) => {
  const parts  = ctx.message.text.trim().split(/\s+/);
  const reason = parts.slice(1).join(' ') || 'Manual pause via Telegram';

  try {
    await tradeRepository.pauseTrading(reason);

    const message = [
      '🔴 *TRADING PAUSED*',
      '━━━━━━━━━━━━━━━━━━━━━',
      `📝 Reason: ${reason}`,
      '',
      'No new trades will be executed.',
      'Existing open positions remain open.',
      '',
      'Use /resume to restart trading.',
    ].join('\n');

    await ctx.replyWithMarkdown(message);
    logger.warn('Trading paused via Telegram', { reason });

  } catch (err) {
    await ctx.reply(`❌ Failed to pause trading: ${err.message}`);
  }
});

// ────────────────────────────────────────────────────────────
//  /resume — Resume trading
// ────────────────────────────────────────────────────────────

bot.command('resume', async (ctx) => {
  try {
    await tradeRepository.resumeTrading();

    const settings = await tradeRepository.getSettings();
    const message  = [
      '🟢 *TRADING RESUMED*',
      '━━━━━━━━━━━━━━━━━━━━━',
      `💰 Capital: ${settings.myCapitalSOL.toFixed(2)} SOL`,
      `📊 Max position: ${(settings.maxPositionPct * 100).toFixed(0)}% per trade`,
      '',
      '✅ Copy trading is now active.',
    ].join('\n');

    await ctx.replyWithMarkdown(message);
    logger.info('Trading resumed via Telegram');

  } catch (err) {
    await ctx.reply(`❌ Failed to resume trading: ${err.message}`);
  }
});

// ────────────────────────────────────────────────────────────
//  /intelligence — Show last AI wallet intelligence report
// ────────────────────────────────────────────────────────────

bot.command('intelligence', async (ctx) => {
  const last = walletIntelligence.getLastReport();

  if (!last || !last.report) {
    await ctx.replyWithMarkdown(
      '📭 *No intelligence report available yet.*\n\n' +
      'The AI wallet intelligence job runs nightly at 11:50 PM UTC.\n' +
      'Use /testintelligence to trigger it manually right now.'
    );
    return;
  }

  const { forDate, report } = last;
  await ctx.replyWithMarkdown(report.telegramSummary || (
    `🤖 *AI Intelligence — ${forDate}*\n\n` +
    `Wallets: ${report.wallets?.length || 0} selected\n` +
    `Confidence: ${report.confidence}/100\n\n` +
    `_Use /testintelligence to regenerate._`
  ));
});

// ────────────────────────────────────────────────────────────
//  /testintelligence — Manually trigger the intelligence job
// ────────────────────────────────────────────────────────────

bot.command('testintelligence', async (ctx) => {
  await ctx.replyWithMarkdown(
    '🤖 *Running AI wallet intelligence pipeline...*\n\n' +
    '_Fetching from Helius + Birdeye + Cielo, scoring candidates..._\n' +
    '_This takes 30-90 seconds. You\'ll receive the full report when done._'
  );

  // Run in background with testOnly=true so the wallet swap is skipped
  walletIntelligence.runNow({ testOnly: true }).then(async (report) => {
    if (!report) {
      await send('RAW', { message: '⚠️ *Intelligence job returned no report.* Check server logs.' });
    } else {
      await send('RAW', {
        message:
          `✅ *Intelligence pipeline complete*\n\n` +
          `Wallets selected: ${report.wallets?.length || 0}\n` +
          `Confidence: ${report.confidence}/100\n\n` +
          `_Wallet swap skipped (test mode). Use nightly run for live swap._`,
      });
      // Also send the full Telegram summary so the user sees it
      if (report.telegramSummary) {
        await send('RAW', { message: report.telegramSummary });
      }
    }
  }).catch(async (err) => {
    logger.error('testintelligence command failed', { error: err.message });
    await send('RAW', {
      message: `⚠️ *Intelligence test failed*\n\nError: ${err.message}`,
    });
  });
});

// ────────────────────────────────────────────────────────────
//  /golive — Full intelligence pipeline + LIVE wallet swap
// ────────────────────────────────────────────────────────────

bot.command('golive', async (ctx) => {
  await ctx.replyWithMarkdown(
    '🚀 *GOING LIVE — Running full intelligence pipeline...*\n\n' +
    '_This will discover wallets, score them, and ACTIVATE them for copy trading._\n' +
    '_Running now — full report coming in 30-90 seconds..._'
  );

  // Run in LIVE mode — testOnly=false triggers the actual wallet swap
  walletIntelligence.runNow({ testOnly: false }).then(async (report) => {
    if (!report) {
      await send('RAW', { message: '⚠️ *Intelligence job returned no report.* Check server logs.' });
    } else {
      await send('RAW', {
        message:
          `🚀 *LIVE pipeline complete!*\n\n` +
          `Wallets selected: ${report.wallets?.length || 0}\n` +
          `Confidence: ${report.confidence}/100\n\n` +
          `_Wallet swap scheduled for 00:01 UTC. New wallets will start tracking automatically._`,
      });
      if (report.telegramSummary) {
        await send('RAW', { message: report.telegramSummary });
      }
    }
  }).catch(async (err) => {
    logger.error('golive command failed', { error: err.message });
    await send('RAW', {
      message: `⚠️ *Go-live failed*\n\nError: ${err.message}`,
    });
  });
});

// ────────────────────────────────────────────────────────────
//  /cleanup — Purge ghost positions from DB
// ────────────────────────────────────────────────────────────

bot.command('cleanup', async (ctx) => {
  try {
    const result = await tradeRepository.cleanupGhostPositions();
    if (result.closedCount === 0) {
      await ctx.replyWithMarkdown('✅ *No ghost positions found* — database is clean.');
    } else {
      await ctx.replyWithMarkdown(
        `🧹 *Cleanup complete*\n\nClosed ${result.closedCount} ghost position(s) ` +
        `(FAILED/PENDING/empty trades that were stuck as "open").`
      );
    }
  } catch (err) {
    logger.error('cleanup command failed', { error: err.message });
    await ctx.replyWithMarkdown(`⚠️ *Cleanup failed:* ${err.message}`);
  }
});

// ────────────────────────────────────────────────────────────
//  /capital <amount> — Update starting capital
// ────────────────────────────────────────────────────────────

bot.command('capital', async (ctx) => {
  const parts  = ctx.message.text.trim().split(/\s+/);
  const amount = parseFloat(parts[1]);

  if (!parts[1] || isNaN(amount) || amount <= 0) {
    await ctx.replyWithMarkdown(
      '❌ *Usage:* `/capital <SOL amount>`\n\n' +
      '*Example:* `/capital 15.5`'
    );
    return;
  }

  try {
    const oldSettings = await tradeRepository.getSettings();
    await tradeRepository.updateSettings({ myCapitalSOL: amount });

    const message = [
      '💰 *CAPITAL UPDATED*',
      '━━━━━━━━━━━━━━━━━━━━━',
      `Previous: ${oldSettings.myCapitalSOL.toFixed(4)} SOL`,
      `New:      ${amount.toFixed(4)} SOL`,
      '',
      '✅ All future trades will scale to this capital.',
    ].join('\n');

    await ctx.replyWithMarkdown(message);
    logger.info('Capital updated via Telegram', {
      from: oldSettings.myCapitalSOL,
      to:   amount,
    });

  } catch (err) {
    await ctx.reply(`❌ Failed to update capital: ${err.message}`);
  }
});

// ────────────────────────────────────────────────────────────
//  KEYBOARD HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Main quick-action keyboard shown with /start.
 * @private
 */
function _mainKeyboard() {
  return Markup.keyboard([
    ['📊 /pnl', '📈 /pnl7d'],
    ['📋 /trades', '💼 /positions'],
    ['👛 /wallets', '⚙️ /status'],
    ['🔴 /pause', '🟢 /resume'],
  ]).resize();
}

// ────────────────────────────────────────────────────────────
//  OUTBOUND NOTIFICATION SENDER
//  Called by tradeExecutor.js for trade alerts
// ────────────────────────────────────────────────────────────

/**
 * Send a notification message to the authorized Telegram chat.
 * This is the function injected into tradeExecutor as the notifier.
 *
 * @param {string} type - NotificationType
 * @param {object} data - Notification payload
 */
async function send(type, data) {
  try {
    let message;

    switch (type) {
      case 'BUY_EXECUTED':
        message = tradeNotifier.formatBuy(data);
        break;
      case 'SELL_EXECUTED':
        message = tradeNotifier.formatSell(data);
        break;
      case 'TRADE_FAILED':
        message = tradeNotifier.formatFailed(data);
        break;
      case 'TRADE_SKIPPED':
        message = tradeNotifier.formatSkipped(data);
        break;
      case 'DAILY_REPORT':
        message = tradeNotifier.formatDailyReport(data);
        break;
      case 'RAW':
        // Pre-formatted markdown string — send as-is
        message = data.message;
        break;
      case 'INTELLIGENCE_REPORT':
        message = data.message || `🤖 *AI Intelligence Report Ready*\n\n${data.summary || ''}`;
        break;
      case 'INTELLIGENCE_FAILED':
        message = `⚠️ *AI Intelligence Job Failed*\n\nError: ${data.error || 'Unknown error'}\n\nExisting wallets continue tracking.`;
        break;
      case 'SYSTEM_ONLINE':
        message = `🟢 *SOL SYSTEMS ONLINE*\n\nBot started and monitoring ${data.walletCount || 0} wallet(s).\nCapital: ${data.capitalSOL?.toFixed(2) || '?'} SOL`;
        break;
      case 'SYSTEM_PAUSED':
        message = `🔴 *TRADING AUTO-PAUSED*\n\nReason: ${data.reason}`;
        break;
      case 'LOSS_LIMIT_HIT':
        message = `🚨 *DAILY LOSS LIMIT HIT*\n\nLost ${Math.abs(data.todayLossSOL || 0).toFixed(4)} SOL today.\nTrading has been paused automatically.\n\nUse /resume when ready to continue.`;
        break;
      case 'ERROR_ALERT':
        message = `⚠️ *SYSTEM ERROR*\n\n${data.error || 'Unknown error occurred'}`;
        break;
      default:
        message = `📢 ${type}: ${JSON.stringify(data)}`;
    }

    await bot.telegram.sendMessage(AUTHORIZED_CHAT_ID, message, {
      parse_mode: 'Markdown',
    });

    // Log notification to database
    await tradeRepository.logNotification({
      type,
      message,
      tradeId:  data.tradeId || null,
      success:  true,
    }).catch(() => {}); // Non-critical

  } catch (err) {
    logger.error('Failed to send Telegram notification', {
      type,
      error: err.message,
    });

    await tradeRepository.logNotification({
      type,
      message:  JSON.stringify(data),
      success:  false,
      errorMsg: err.message,
    }).catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────
//  LIFECYCLE
// ────────────────────────────────────────────────────────────

/**
 * Start the Telegram bot (polling mode for local dev,
 * webhook mode automatically handled by Telegraf on cloud).
 */
async function start() {
  try {
    bot.launch();  // ← remove await — this runs forever intentionally

    // Give it 2 seconds to connect before continuing
    await new Promise(resolve => setTimeout(resolve, 2000));

    const botInfo = await bot.telegram.getMe();
    logger.info('Telegram bot started', {
      username: '@' + botInfo.username,
      id:       botInfo.id,
    });

    await send('SYSTEM_ONLINE', {
      walletCount: 0,
      capitalSOL:  (await tradeRepository.getSettings()).myCapitalSOL,
    });

  } catch (err) {
    logger.error('Failed to start Telegram bot', { error: err.message });
    throw err;
  }
}

/**
 * Stop the bot gracefully.
 */
function stop() {
  bot.stop('SIGTERM');
  logger.info('Telegram bot stopped');
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  bot,
  start,
  stop,
  send,
};