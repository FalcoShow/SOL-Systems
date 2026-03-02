// ============================================================
//  SOL SYSTEMS — PnL Handler
//  File: src/telegram/handlers/pnlHandler.js
//
//  Handles all PnL-related Telegram commands:
//    /pnl       → 24-hour PnL report
//    /pnl7d     → 7-day summary
//    /trades    → last 10 executed trades
//    /positions → current open positions with live PnL
//
//  All messages formatted for clean mobile Telegram reading.
//  Uses Markdown for bold/mono text. Keeps messages concise —
//  nobody wants to scroll through 200 lines on their phone.
// ============================================================

'use strict';

const tradeRepository = require('../../execution/tradeRepository');
const positionTracker = require('../../monitor/positionTracker');
const { calculateDailyStats, calculateWinRate } = require('../../utils/calculator');
const { getSOLPrice, formatSOL, formatUSD } = require('../../utils/solana');
const logger = require('../../utils/logger');

// ────────────────────────────────────────────────────────────
//  /pnl — 24-HOUR REPORT
// ────────────────────────────────────────────────────────────

/**
 * Generate and send the 24-hour PnL report.
 * @param {object} ctx - Telegraf context
 */
async function handle24hPnL(ctx) {
  try {
    const [trades, settings, solPriceUSD] = await Promise.all([
      tradeRepository.get24HourTrades(),
      tradeRepository.getSettings(),
      getSOLPrice().catch(() => 0),
    ]);

    const stats = calculateDailyStats(
      trades.filter((t) => t.tradeType === 'SELL'),
      settings.myCapitalSOL,
      solPriceUSD
    );

    const openPositions = positionTracker.getAllMyPositions();
    const unrealizedSOL = openPositions.reduce(
      (sum, p) => sum + (p.unrealizedPnLSOL || 0), 0
    );

    const buys  = trades.filter((t) => t.tradeType === 'BUY').length;
    const sells = trades.filter((t) => t.tradeType === 'SELL' && t.status === 'CONFIRMED').length;

    const netSign    = stats.netPnLSOL >= 0 ? '+' : '';
    const unrealSign = unrealizedSOL >= 0 ? '+' : '';
    const roiSign    = stats.roiPct >= 0 ? '+' : '';

    const lines = [
      '📊 *24-HOUR PnL REPORT*',
      '━━━━━━━━━━━━━━━━━━━━━',
      '',
      `💰 Capital:       \`${settings.myCapitalSOL.toFixed(2)} SOL\``,
      '',
      '📈 *Realized PnL*',
      `   Net:     \`${netSign}${stats.netPnLSOL.toFixed(4)} SOL\``,
      solPriceUSD > 0
        ? `   USD:     \`${netSign}${formatUSD(Math.abs(stats.netPnLUSD))}\``
        : null,
      `   ROI:     \`${roiSign}${stats.roiPct.toFixed(2)}%\``,
      '',
      '📉 *Unrealized PnL* (open positions)',
      `   SOL:     \`${unrealSign}${unrealizedSOL.toFixed(4)} SOL\``,
      '',
      '🎯 *Trade Stats*',
      `   Closed:  \`${stats.totalTrades}\` (${stats.wins}W / ${stats.losses}L)`,
      `   Win rate: \`${stats.winRatePct.toFixed(1)}%\``,
      `   Buys:    \`${buys}\` | Sells: \`${sells}\``,
      stats.avgExecutionMs > 0
        ? `   Avg speed: \`${stats.avgExecutionMs}ms\``
        : null,
      '',
    ];

    // Best and worst trade
    if (stats.bestTrade && stats.bestTrade.pnlSOL > 0) {
      const best = stats.bestTrade;
      lines.push(`🏆 Best:  \`${best.tokenSymbol || '???'}\` +${best.pnlPct?.toFixed(1) || '0'}% (+${best.pnlSOL?.toFixed(4)} SOL)`);
    }
    if (stats.worstTrade && stats.worstTrade.pnlSOL < 0) {
      const worst = stats.worstTrade;
      lines.push(`💀 Worst: \`${worst.tokenSymbol || '???'}\` ${worst.pnlPct?.toFixed(1) || '0'}% (${worst.pnlSOL?.toFixed(4)} SOL)`);
    }

    if (stats.totalTrades === 0 && openPositions.length === 0) {
      lines.push('_No trades in the last 24 hours._');
    }

    lines.push('');
    lines.push(`_${openPositions.length} position(s) currently open_`);
    lines.push(`_Use /positions for details_`);

    const message = lines.filter((l) => l !== null).join('\n');
    await ctx.replyWithMarkdown(message);

  } catch (err) {
    logger.error('pnlHandler.handle24hPnL error', { error: err.message });
    await ctx.reply('❌ Failed to generate PnL report. Check logs.');
  }
}

// ────────────────────────────────────────────────────────────
//  /pnl7d — 7-DAY SUMMARY
// ────────────────────────────────────────────────────────────

/**
 * Generate and send the 7-day PnL summary.
 * @param {object} ctx - Telegraf context
 */
async function handle7dPnL(ctx) {
  try {
    const [dailyHistory, settings, solPriceUSD] = await Promise.all([
      tradeRepository.getDailyPnLHistory(7),
      tradeRepository.getSettings(),
      getSOLPrice().catch(() => 0),
    ]);

    // Also get aggregate stats for the 7-day window
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stats7d  = await tradeRepository.getAggregateStats(fromDate, new Date());

    const netSign = stats7d.netPnLSOL >= 0 ? '+' : '';
    const roiSign = stats7d.roiPct >= 0 ? '+' : '';

    const lines = [
      '📈 *7-DAY PnL SUMMARY*',
      '━━━━━━━━━━━━━━━━━━━━━',
      '',
      `💰 Capital: \`${settings.myCapitalSOL.toFixed(2)} SOL\``,
      '',
      '📊 *7-Day Totals*',
      `   Net PnL:  \`${netSign}${(stats7d.netPnLSOL || 0).toFixed(4)} SOL\``,
      solPriceUSD > 0
        ? `   USD:      \`${netSign}${formatUSD(Math.abs(stats7d.netPnLUSD || 0))}\``
        : null,
      `   Trades:   \`${stats7d.totalTrades || 0}\` (${stats7d.wins || 0}W / ${stats7d.losses || 0}L)`,
      `   Win rate: \`${(stats7d.winRatePct || 0).toFixed(1)}%\``,
      `   Best day: \`+${(stats7d.bestPnLSOL || 0).toFixed(4)} SOL\``,
      '',
      '📅 *Daily Breakdown*',
    ];

    if (dailyHistory.length === 0) {
      lines.push('_No daily records yet — runs at midnight UTC._');
    } else {
      // Show most recent first
      for (const day of dailyHistory.slice(0, 7)) {
        const sign   = day.netPnLSOL >= 0 ? '✅' : '❌';
        const pnlStr = day.netPnLSOL >= 0
          ? `+${day.netPnLSOL.toFixed(4)}`
          : day.netPnLSOL.toFixed(4);

        const dateStr = new Date(day.date).toLocaleDateString('en-US', {
          weekday: 'short',
          month:   'short',
          day:     'numeric',
        });

        lines.push(
          `${sign} ${dateStr}: \`${pnlStr} SOL\` ` +
          `(${day.totalTradesExecuted || 0}t, ${(day.winRatePct || 0).toFixed(0)}% WR)`
        );
      }
    }

    const message = lines.filter((l) => l !== null).join('\n');
    await ctx.replyWithMarkdown(message);

  } catch (err) {
    logger.error('pnlHandler.handle7dPnL error', { error: err.message });
    await ctx.reply('❌ Failed to generate 7-day report. Check logs.');
  }
}

// ────────────────────────────────────────────────────────────
//  /trades — LAST 10 TRADES
// ────────────────────────────────────────────────────────────

/**
 * Show the last 10 executed trades.
 * @param {object} ctx - Telegraf context
 */
async function handleRecentTrades(ctx) {
  try {
    const { trades } = await tradeRepository.getTradeHistory({
      limit:  10,
      offset: 0,
    });

    if (trades.length === 0) {
      await ctx.replyWithMarkdown('_No trades executed yet._');
      return;
    }

    const lines = [
      '📋 *LAST 10 TRADES*',
      '━━━━━━━━━━━━━━━━━━━━━',
      '',
    ];

    for (const trade of trades) {
      const isBuy    = trade.tradeType === 'BUY';
      const isSell   = trade.tradeType === 'SELL';
      const isSkipped = trade.status === 'SKIPPED';
      const isFailed  = trade.status === 'FAILED';

      let emoji;
      if (isSkipped)          emoji = '⏭️';
      else if (isFailed)      emoji = '❌';
      else if (isBuy)         emoji = '🟢';
      else if (trade.isWin)   emoji = '✅';
      else                    emoji = '🔴';

      const token   = trade.tokenSymbol || '???';
      const wallet  = trade.trackedWallet?.nickname || 'Unknown';
      const dateStr = _formatTimeAgo(trade.createdAt);

      if (isBuy && !isSkipped && !isFailed) {
        const amt = trade.executedAmountSOL?.toFixed(3) || trade.requestedAmountSOL?.toFixed(3) || '?';
        lines.push(`${emoji} *BUY ${token}* — ${amt} SOL`);
        lines.push(`   _${wallet} • ${dateStr}_`);
      } else if (isSell && !isSkipped && !isFailed) {
        const pnlSign = (trade.pnlPct || 0) >= 0 ? '+' : '';
        const pnlStr  = `${pnlSign}${(trade.pnlPct || 0).toFixed(1)}%`;
        const pnlSOL  = `${pnlSign}${(trade.pnlSOL || 0).toFixed(4)} SOL`;
        lines.push(`${emoji} *SELL ${token}* — \`${pnlStr}\` (${pnlSOL})`);
        lines.push(`   _${wallet} • ${dateStr}_`);
      } else if (isSkipped) {
        lines.push(`${emoji} *SKIP ${trade.tradeType} ${token}*`);
        lines.push(`   _${trade.errorMessage?.slice(0, 40) || 'Unknown reason'}_`);
      } else if (isFailed) {
        lines.push(`${emoji} *FAIL ${trade.tradeType} ${token}*`);
        lines.push(`   _${trade.errorMessage?.slice(0, 40) || 'Unknown error'}_`);
      }

      lines.push('');
    }

    await ctx.replyWithMarkdown(lines.join('\n'));

  } catch (err) {
    logger.error('pnlHandler.handleRecentTrades error', { error: err.message });
    await ctx.reply('❌ Failed to fetch recent trades.');
  }
}

// ────────────────────────────────────────────────────────────
//  /positions — OPEN POSITIONS WITH LIVE PNL
// ────────────────────────────────────────────────────────────

/**
 * Show all currently open positions with unrealized PnL.
 * @param {object} ctx - Telegraf context
 */
async function handlePositions(ctx) {
  try {
    const summary = positionTracker.getSummary();

    if (summary.openCount === 0) {
      await ctx.replyWithMarkdown(
        '💼 *OPEN POSITIONS*\n━━━━━━━━━━━━━━━━━━━━━\n\n_No open positions._'
      );
      return;
    }

    const totalSign    = summary.totalUnrealizedSOL >= 0 ? '+' : '';
    const totalPctSign = summary.totalUnrealizedPct >= 0 ? '+' : '';

    const lines = [
      '💼 *OPEN POSITIONS*',
      '━━━━━━━━━━━━━━━━━━━━━',
      '',
      `Total invested: \`${summary.totalInvestedSOL.toFixed(4)} SOL\``,
      `Unrealized PnL: \`${totalSign}${summary.totalUnrealizedSOL.toFixed(4)} SOL\` (${totalPctSign}${summary.totalUnrealizedPct.toFixed(2)}%)`,
      '',
    ];

    for (const pos of summary.positions) {
      const pnlSign    = pos.unrealizedPnLSOL >= 0 ? '+' : '';
      const pnlPctSign = pos.unrealizedPnLPct >= 0 ? '+' : '';
      const ageStr     = _formatHoldTime(pos.holdTimeMs);
      const emoji      = pos.unrealizedPnLSOL >= 0 ? '📈' : '📉';

      lines.push(`${emoji} *${pos.token}*`);
      lines.push(`   Invested: \`${pos.entryAmountSOL?.toFixed(4)} SOL\``);
      lines.push(
        `   PnL:     \`${pnlSign}${pos.unrealizedPnLSOL?.toFixed(4)} SOL\` ` +
        `(${pnlPctSign}${pos.unrealizedPnLPct?.toFixed(2)}%)`
      );
      lines.push(`   Held:    \`${ageStr}\``);
      lines.push('');
    }

    lines.push(`_Prices update every 30 seconds_`);

    await ctx.replyWithMarkdown(lines.join('\n'));

  } catch (err) {
    logger.error('pnlHandler.handlePositions error', { error: err.message });
    await ctx.reply('❌ Failed to fetch positions.');
  }
}

// ────────────────────────────────────────────────────────────
//  FORMATTING HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Format a timestamp as a human-readable "time ago" string.
 * e.g. "2h 14m ago", "just now", "3d ago"
 * @param {Date|string} date
 * @returns {string}
 */
function _formatTimeAgo(date) {
  const ms      = Date.now() - new Date(date).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);

  if (seconds < 60)  return 'just now';
  if (minutes < 60)  return `${minutes}m ago`;
  if (hours < 24)    return `${hours}h ${minutes % 60}m ago`;
  return `${days}d ago`;
}

/**
 * Format a hold time in milliseconds as a human-readable string.
 * e.g. "14m 32s", "3h 2m", "2d 14h"
 * @param {number} ms
 * @returns {string}
 */
function _formatHoldTime(ms) {
  if (!ms || ms < 0) return '?';

  const totalSeconds = Math.floor(ms / 1000);
  const seconds      = totalSeconds % 60;
  const minutes      = Math.floor(totalSeconds / 60) % 60;
  const hours        = Math.floor(totalSeconds / 3600) % 24;
  const days         = Math.floor(totalSeconds / 86400);

  if (days > 0)    return `${days}d ${hours}h`;
  if (hours > 0)   return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  handle24hPnL,
  handle7dPnL,
  handleRecentTrades,
  handlePositions,
};