// ============================================================
//  SOL SYSTEMS — Status Handler
//  File: src/telegram/handlers/statusHandler.js
//
//  Handles the /status command — a full system health check
//  showing everything you need to know the bot is healthy.
//
//  Checks performed:
//    ✅ Database connectivity
//    ✅ WebSocket connection state + active subscriptions
//    ✅ Helius webhook stats
//    ✅ Trading wallet SOL balance
//    ✅ Open positions count vs max limit
//    ✅ Today's PnL vs daily loss limit
//    ✅ Execution queue depth
//    ✅ Trading paused/active state
//    ✅ Tracked wallets online count
//    ✅ System uptime
// ============================================================

'use strict';

const tradeRepository = require('../../execution/tradeRepository');
const walletMonitor   = require('../../monitor/walletMonitor');
const heliusWebhook   = require('../../monitor/heliusWebhook');
const positionTracker = require('../../monitor/positionTracker');
const tradeExecutor   = require('../../execution/tradeExecutor');
const { getSOLBalance, getSOLPrice, shortenAddress } = require('../../utils/solana');
const config          = require('../../config');
const logger          = require('../../utils/logger');

// Track when the process started for uptime calculation
const PROCESS_START = Date.now();

// ────────────────────────────────────────────────────────────
//  /status — FULL SYSTEM HEALTH CHECK
// ────────────────────────────────────────────────────────────

/**
 * Handle /status command.
 * Runs all health checks in parallel and formats a summary.
 *
 * @param {object} ctx - Telegraf context
 */
async function handleStatus(ctx) {
  try {
    // Run all checks concurrently for speed
    const [
      dbOk,
      settings,
      walletBalance,
      solPriceUSD,
      todayStats,
      openTrades,
    ] = await Promise.allSettled([
      tradeRepository.healthCheck(),
      tradeRepository.getSettings(),
      getSOLBalance(config.wallet.publicKey),
      getSOLPrice(),
      tradeRepository.getAggregateStats(
        new Date(new Date().setHours(0, 0, 0, 0)),
        new Date()
      ),
      tradeRepository.getOpenTrades(),
    ]);

    // Safely extract resolved values with fallbacks
    const db        = _resolved(dbOk, false);
    const s         = _resolved(settings, {});
    const balance   = _resolved(walletBalance, 0);
    const solPrice  = _resolved(solPriceUSD, 0);
    const today     = _resolved(todayStats, {});
    const openCount = _resolved(openTrades, []).length;

    // Live in-memory stats (no DB needed)
    const monitorStatus  = walletMonitor.getStatus();
    const webhookStats   = heliusWebhook.getStats();
    const executorStatus = tradeExecutor.getStatus();
    const positionSummary = positionTracker.getSummary();

    // Today's PnL
    const todayPnL    = today.netPnLSOL ?? 0;
    const todayTrades = today.totalTrades ?? 0;
    const lossLimit   = s.dailyLossLimitSOL ?? 0;
    const lossAbs     = Math.abs(Math.min(todayPnL, 0));
    const lossLimitPct = lossLimit > 0
      ? Math.min((lossAbs / lossLimit) * 100, 100)
      : 0;

    const message = _formatStatus({
      db,
      settings:          s,
      balance,
      solPrice,
      todayPnL,
      todayTrades,
      lossLimit,
      lossAbs,
      lossLimitPct,
      openCount,
      positionSummary,
      monitorStatus,
      webhookStats,
      executorStatus,
    });

    await ctx.replyWithMarkdown(message);

  } catch (err) {
    logger.error('statusHandler.handleStatus error', { error: err.message });
    await ctx.reply('❌ Failed to run status check. The system may be partially down.');
  }
}

// ────────────────────────────────────────────────────────────
//  FORMAT STATUS MESSAGE
// ────────────────────────────────────────────────────────────

/**
 * Build the full status message from all health check results.
 * @private
 */
function _formatStatus({
  db,
  settings,
  balance,
  solPrice,
  todayPnL,
  todayTrades,
  lossLimit,
  lossAbs,
  lossLimitPct,
  openCount,
  positionSummary,
  monitorStatus,
  webhookStats,
  executorStatus,
}) {
  const isPaused      = settings.isTradingPaused ?? false;
  const myCapital     = settings.myCapitalSOL    ?? 0;
  const maxPositions  = settings.maxOpenPositions ?? 10;
  const maxPosPct     = settings.maxPositionPct  ?? 0.10;
  const minReserve    = settings.minSolReserve   ?? 0.10;
  const maxSlippage   = settings.maxSlippageBps  ?? 100;
  const uptime        = _formatUptime(Date.now() - PROCESS_START);

  // ── Overall health score ──────────────────────────────
  const healthChecks = [
    db,
    monitorStatus.wsConnected,
    balance >= minReserve,
    !isPaused,
  ];
  const healthScore  = healthChecks.filter(Boolean).length;
  const healthEmoji  = healthScore === 4 ? '🟢'
                     : healthScore >= 2  ? '🟡'
                     : '🔴';
  const healthLabel  = healthScore === 4 ? 'ALL SYSTEMS GO'
                     : healthScore >= 2  ? 'DEGRADED'
                     : 'CRITICAL';

  // ── Trading state ─────────────────────────────────────
  const tradingEmoji = isPaused ? '🔴' : '🟢';
  const tradingLabel = isPaused
    ? `PAUSED${settings.pauseReason ? ' — ' + settings.pauseReason : ''}`
    : 'ACTIVE';

  // ── SOL balance bar ───────────────────────────────────
  const balancePct = myCapital > 0
    ? Math.min((balance / myCapital) * 100, 100)
    : 0;
  const balanceBar = _progressBar(balancePct, 10);

  // ── Loss limit bar ────────────────────────────────────
  const lossBar    = lossLimit > 0
    ? _progressBar(lossLimitPct, 10)
    : null;

  // ── WebSocket subscription status ────────────────────
  const wsEmoji     = monitorStatus.wsConnected ? '🟢' : '🔴';
  const subStatus   = `${monitorStatus.activeSubscriptions}/${monitorStatus.trackedWallets} wallets`;

  // ── Today PnL line ────────────────────────────────────
  const pnlSign     = todayPnL >= 0 ? '+' : '';
  const pnlEmoji    = todayPnL >= 0 ? '📈' : '📉';
  const pnlUSD      = solPrice > 0
    ? ` ($${(Math.abs(todayPnL) * solPrice).toFixed(2)})`
    : '';

  // ── Positions line ────────────────────────────────────
  const posBar      = _progressBar((openCount / maxPositions) * 100, 10);
  const unrealPnL   = positionSummary.totalUnrealizedSOL ?? 0;
  const unrealSign  = unrealPnL >= 0 ? '+' : '';

  // ── Execution queue ───────────────────────────────────
  const queueEmoji  = executorStatus.queueSize > 2 ? '⚠️' : '✅';

  // ── Webhook line ──────────────────────────────────────
  const whEmoji     = webhookStats.lastReceived ? '🟢' : '🟡';
  const whLast      = webhookStats.lastReceived
    ? _relativeTime(webhookStats.lastReceived)
    : 'never';

  const lines = [
    `${healthEmoji} *SOL SYSTEMS STATUS — ${healthLabel}*`,
    '━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${tradingEmoji} Trading: *${tradingLabel}*`,
    `⏱️ Uptime:  \`${uptime}\``,
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    '*💼 WALLET*',
    `   Balance:  \`${balance.toFixed(4)} SOL\``,
    `   Capital:  \`${myCapital.toFixed(2)} SOL\``,
    `   Reserve:  \`${minReserve} SOL\` (min gas)`,
    `   ${balanceBar} ${balancePct.toFixed(0)}%`,
    `   SOL Price: \`$${solPrice > 0 ? solPrice.toFixed(2) : '...'}\``,
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    `*${pnlEmoji} TODAY*`,
    `   PnL:     \`${pnlSign}${todayPnL.toFixed(4)} SOL\`${pnlUSD}`,
    `   Trades:  ${todayTrades} executed`,
    lossLimit > 0
      ? `   Loss:    \`${lossAbs.toFixed(4)} / ${lossLimit} SOL\``
      : '   Loss limit: disabled',
    lossBar ? `   ${lossBar} ${lossLimitPct.toFixed(0)}% of limit` : '',
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    '*📊 POSITIONS*',
    `   Open:    ${openCount} / ${maxPositions}`,
    `   ${posBar}`,
    unrealPnL !== 0
      ? `   Unrealized: \`${unrealSign}${unrealPnL.toFixed(4)} SOL\``
      : '   Unrealized: none',
    `   Max size: \`${(maxPosPct * 100).toFixed(0)}%\` per trade`,
    `   Slippage: \`${maxSlippage} bps\``,
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    '*🔗 CONNECTIONS*',
    `   ${wsEmoji} WebSocket:  ${monitorStatus.wsConnected ? 'connected' : 'DISCONNECTED'}`,
    `   📡 Wallets:   ${subStatus}`,
    `   🔄 Reconnects: ${monitorStatus.reconnectCount}`,
    `   ${whEmoji} Webhook:   last event ${whLast}`,
    `   📩 WH total: ${webhookStats.received || 0} recv · ${webhookStats.duplicates || 0} dups`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    '*⚙️  EXECUTION*',
    `   ${db ? '🟢' : '🔴'} Database:  ${db ? 'connected' : 'DISCONNECTED'}`,
    `   ${queueEmoji} Queue:     ${executorStatus.queueSize} pending`,
    `   🔒 In-flight: ${executorStatus.inFlight}`,
    '',
    `🕐 ${_timestamp()}`,
  ].filter(l => l !== '');

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Build a simple ASCII progress bar.
 * e.g. [████████░░] for 80%
 *
 * @param {number} pct   - 0 to 100
 * @param {number} width - Total bar width in characters
 * @returns {string}
 * @private
 */
function _progressBar(pct, width = 10) {
  const filled = Math.round(Math.min(Math.max(pct, 0), 100) / 100 * width);
  const empty  = width - filled;
  return `[${('█').repeat(filled)}${('░').repeat(empty)}]`;
}

/**
 * Format process uptime into a human-readable string.
 * @param {number} ms - Uptime in milliseconds
 * @returns {string}  e.g. "3d 4h 12m"
 * @private
 */
function _formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days    = Math.floor(totalSeconds / 86400);
  const hours   = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0)  return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Format a relative time string.
 * @param {Date} date
 * @returns {string}
 * @private
 */
function _relativeTime(date) {
  if (!date) return 'never';
  const ms      = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(ms / 60000);
  const hours   = Math.floor(minutes / 60);
  if (hours > 0)   return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Format a UTC timestamp for the footer.
 * @returns {string}
 * @private
 */
function _timestamp() {
  return new Date().toUTCString().replace('GMT', 'UTC').replace(/:\d\d /, ' ');
}

/**
 * Safely extract the value from a Promise.allSettled result.
 * Returns fallback if the promise rejected.
 *
 * @param {object} result   - Promise.allSettled result object
 * @param {*}      fallback - Value to use if rejected
 * @returns {*}
 * @private
 */
function _resolved(result, fallback) {
  return result?.status === 'fulfilled' ? result.value : fallback;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { handleStatus };