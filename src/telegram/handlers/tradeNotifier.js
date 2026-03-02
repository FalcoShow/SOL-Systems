// ============================================================
//  SOL SYSTEMS — Trade Notifier
//  File: src/telegram/handlers/tradeNotifier.js
//
//  Formats every real-time trade notification sent via Telegram.
//  Called by bot.js send() immediately after each trade event.
//
//  Formatters:
//    formatBuy()         — BUY confirmed notification
//    formatSell()        — SELL confirmed with full PnL breakdown
//    formatFailed()      — trade execution failure alert
//    formatSkipped()     — trade skipped by risk manager
//    formatDailyReport() — midnight auto daily summary
//
//  Design principles:
//    - Every notification fits on one mobile screen (no scrolling)
//    - Numbers always in monospace backticks for alignment
//    - Wins are green, losses are red — clear at a glance
//    - Include Solscan link so you can verify on-chain instantly
//    - Execution speed always shown — your benchmark metric
// ============================================================

'use strict';

// Solscan base URL for transaction verification links
const SOLSCAN_TX  = 'https://solscan.io/tx';
const SOLSCAN_TOKEN = 'https://solscan.io/token';

// ────────────────────────────────────────────────────────────
//  BUY NOTIFICATION
//  Fires the instant our copy BUY is confirmed on-chain
// ────────────────────────────────────────────────────────────

/**
 * Format a BUY confirmed notification.
 *
 * @param {object} data
 * @param {string} data.nickname         - Tracked wallet nickname (e.g. "Cented")
 * @param {string} data.tokenSymbol      - e.g. "WIF"
 * @param {string} data.tokenName        - e.g. "dogwifhat"
 * @param {number} data.amountSOL        - SOL we spent
 * @param {number} data.priceSOL         - Price per token in SOL
 * @param {string} data.txSignature      - Our transaction signature
 * @param {number} data.executionMs      - ms from detection to confirmation
 * @param {number} data.theirPct         - % of their capital they used
 * @param {number} data.ourPct           - % of our capital we used
 * @param {string} data.tokenMint        - Token mint address (optional)
 *
 * @returns {string} Markdown-formatted message
 */
function formatBuy(data) {
  const {
    nickname    = 'Tracked Wallet',
    tokenSymbol = '???',
    tokenName   = '',
    amountSOL   = 0,
    priceSOL    = 0,
    txSignature,
    executionMs = 0,
    theirPct    = 0,
    ourPct      = 0,
    tokenMint,
  } = data;

  const speedTag  = _speedTag(executionMs);
  const solscanTx = txSignature ? `[View TX](${SOLSCAN_TX}/${txSignature})` : '';
  const tokenLink = tokenMint   ? `[${tokenSymbol}](${SOLSCAN_TOKEN}/${tokenMint})` : tokenSymbol;
  const nameStr   = tokenName && tokenName !== tokenSymbol ? ` _(${tokenName})_` : '';

  const lines = [
    `🟢 *BUY EXECUTED — ${tokenSymbol}*${nameStr}`,
    '━━━━━━━━━━━━━━━━━━━━━',
    '',
    `📡 Copying: *${nickname}*`,
    `🪙 Token:   ${tokenLink}`,
    '',
    `💰 Spent:   \`${amountSOL.toFixed(4)} SOL\``,
    `📊 Price:   \`${_formatPrice(priceSOL)}\` SOL/token`,
    '',
    `📐 Their position: \`${theirPct.toFixed(1)}%\` of capital`,
    `📐 Our position:   \`${ourPct.toFixed(1)}%\` of capital`,
    '',
    `${speedTag} Executed in \`${executionMs}ms\``,
    solscanTx ? `🔗 ${solscanTx}` : '',
  ].filter(Boolean);

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
//  SELL NOTIFICATION
//  Fires the instant our copy SELL is confirmed on-chain
//  This is the most information-dense message — shows full PnL
// ────────────────────────────────────────────────────────────

/**
 * Format a SELL confirmed notification with full PnL breakdown.
 *
 * @param {object} data
 * @param {string} data.nickname         - Tracked wallet nickname
 * @param {string} data.tokenSymbol
 * @param {string} data.tokenName
 * @param {number} data.entryPriceSOL    - Our entry price per token
 * @param {number} data.exitPriceSOL     - Our exit price per token
 * @param {number} data.pnlSOL           - Our realized PnL in SOL
 * @param {number} data.pnlUSD           - Our realized PnL in USD
 * @param {number} data.pnlPct           - Our PnL percentage
 * @param {number} data.trackedPnlPct    - Their PnL percentage
 * @param {boolean} data.isWin
 * @param {string} data.txSignature
 * @param {number} data.executionMs
 * @param {string} data.accuracyRating   - 'PERFECT'|'GOOD'|'ACCEPTABLE'|'POOR'|'FAILED'
 *
 * @returns {string} Markdown-formatted message
 */
function formatSell(data) {
  const {
    nickname       = 'Tracked Wallet',
    tokenSymbol    = '???',
    tokenName      = '',
    entryPriceSOL  = 0,
    exitPriceSOL   = 0,
    pnlSOL         = 0,
    pnlUSD         = 0,
    pnlPct         = 0,
    trackedPnlPct  = 0,
    isWin          = false,
    txSignature,
    executionMs    = 0,
    accuracyRating = 'GOOD',
  } = data;

  const resultEmoji = isWin ? '✅' : '❌';
  const headerEmoji = isWin ? '🔴🏆' : '🔴💀';
  const pnlSign     = pnlSOL >= 0 ? '+' : '';
  const usdSign     = pnlUSD >= 0 ? '+' : '-';
  const theirSign   = trackedPnlPct >= 0 ? '+' : '';
  const nameStr     = tokenName && tokenName !== tokenSymbol ? ` _(${tokenName})_` : '';
  const speedTag    = _speedTag(executionMs);
  const solscanTx   = txSignature ? `[View TX](${SOLSCAN_TX}/${txSignature})` : '';

  // Accuracy line — how well we matched their PnL%
  const accuracyLine = _accuracyLine(accuracyRating, trackedPnlPct, pnlPct);

  // Price change direction arrow
  const priceArrow = exitPriceSOL > entryPriceSOL ? '📈' : '📉';

  const lines = [
    `${headerEmoji} *SELL EXECUTED — ${tokenSymbol}*${nameStr}`,
    '━━━━━━━━━━━━━━━━━━━━━',
    '',
    `📡 Copying:  *${nickname}*`,
    `${resultEmoji} Result:   \`${pnlSign}${pnlPct.toFixed(2)}%\``,
    `💰 PnL:     \`${pnlSign}${pnlSOL.toFixed(4)} SOL\``,
    `       \`${usdSign}$${Math.abs(pnlUSD).toFixed(2)} USD\``,
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    `${priceArrow} Entry:  \`${_formatPrice(entryPriceSOL)}\` SOL`,
    `${priceArrow} Exit:   \`${_formatPrice(exitPriceSOL)}\` SOL`,
    '',
    `📡 Their PnL: \`${theirSign}${trackedPnlPct.toFixed(2)}%\``,
    `👤 Our PnL:   \`${pnlSign}${pnlPct.toFixed(2)}%\``,
    accuracyLine,
    '',
    `${speedTag} Executed in \`${executionMs}ms\``,
    solscanTx ? `🔗 ${solscanTx}` : '',
  ].filter(Boolean);

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
//  FAILED TRADE NOTIFICATION
// ────────────────────────────────────────────────────────────

/**
 * Format a failed trade notification.
 *
 * @param {object} data
 * @param {string} data.tradeType   - 'BUY' or 'SELL'
 * @param {string} data.tokenSymbol
 * @param {string} data.error       - Error message
 *
 * @returns {string}
 */
function formatFailed(data) {
  const {
    tradeType   = 'BUY',
    tokenSymbol = '???',
    error       = 'Unknown error',
  } = data;

  // Truncate long error messages
  const errorShort = error.length > 120
    ? error.slice(0, 120) + '...'
    : error;

  return [
    `⚠️ *TRADE FAILED — ${tradeType} ${tokenSymbol}*`,
    '━━━━━━━━━━━━━━━━━━━━━',
    '',
    `❌ Error: ${errorShort}`,
    '',
    '_No funds were lost. Position was not opened._',
    '',
    'Check /status for system health.',
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
//  SKIPPED TRADE NOTIFICATION
// ────────────────────────────────────────────────────────────

/**
 * Format a skipped trade notification (risk manager blocked it).
 * Only sent if settings.notifyOnSkip is true — can be noisy.
 *
 * @param {object} data
 * @param {string} data.tradeType
 * @param {string} data.tokenSymbol
 * @param {string} data.reason      - Why it was skipped
 * @param {string} data.nickname    - Tracked wallet nickname
 *
 * @returns {string}
 */
function formatSkipped(data) {
  const {
    tradeType   = 'BUY',
    tokenSymbol = '???',
    reason      = 'Risk limit',
    nickname    = 'Wallet',
  } = data;

  return [
    `⏭️ *TRADE SKIPPED — ${tradeType} ${tokenSymbol}*`,
    '━━━━━━━━━━━━━━━━━━━━━',
    '',
    `📡 Wallet: ${nickname}`,
    `📝 Reason: ${reason}`,
    '',
    '_Risk manager blocked this trade._',
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
//  DAILY REPORT
//  Sent automatically at midnight by dailyReportJob.js
// ────────────────────────────────────────────────────────────

/**
 * Format the automated midnight daily report.
 *
 * @param {object} data
 * @param {object} data.stats       - From calculateDailyStats()
 * @param {number} data.capitalSOL  - Current capital
 * @param {number} data.solPriceUSD
 * @param {string} data.date        - e.g. "Monday, March 1"
 *
 * @returns {string}
 */
function formatDailyReport(data) {
  const {
    stats      = {},
    capitalSOL = 0,
    solPriceUSD = 0,
    date       = new Date().toDateString(),
  } = data;

  const netPnL    = stats.netPnLSOL  || 0;
  const netUSD    = stats.netPnLUSD  || 0;
  const roi       = stats.roiPct     || 0;
  const winRate   = stats.winRatePct || 0;
  const total     = stats.totalTrades || 0;
  const wins      = stats.wins        || 0;
  const losses    = stats.losses      || 0;
  const avgMs     = stats.avgExecutionMs || 0;

  const sign        = netPnL >= 0 ? '+' : '';
  const usdSign     = netUSD >= 0 ? '+' : '-';
  const roiSign     = roi    >= 0 ? '+' : '';
  const resultEmoji = netPnL >= 0 ? '🟢' : '🔴';
  const trophy      = netPnL >= 0 ? '🏆' : '📉';

  // Best/worst trade lines
  let bestLine  = 'None';
  let worstLine = 'None';
  if (stats.bestTrade) {
    const b = stats.bestTrade;
    const s = (b.pnlPct || 0) >= 0 ? '+' : '';
    bestLine = `${b.tokenSymbol || '???'} \`${s}${(b.pnlPct || 0).toFixed(1)}%\``;
  }
  if (stats.worstTrade) {
    const w = stats.worstTrade;
    const s = (w.pnlPct || 0) >= 0 ? '+' : '';
    worstLine = `${w.tokenSymbol || '???'} \`${s}${(w.pnlPct || 0).toFixed(1)}%\``;
  }

  return [
    `${trophy} *Daily Report — ${date}*`,
    '━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${resultEmoji} Net PnL: \`${sign}${netPnL.toFixed(4)} SOL\``,
    `         \`${usdSign}$${Math.abs(netUSD).toFixed(2)} USD\``,
    `📈 ROI:   \`${roiSign}${roi.toFixed(2)}%\``,
    `💼 Capital: \`${capitalSOL.toFixed(2)} SOL\``,
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    `📊 Trades:   ${total}`,
    `✅ Wins: ${wins}  ❌ Losses: ${losses}`,
    `🎯 Win Rate: ${winRate.toFixed(1)}%`,
    '',
    `🏆 Best:   ${bestLine}`,
    `💀 Worst:  ${worstLine}`,
    `⚡ Avg speed: ${avgMs}ms`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    `💲 SOL: $${solPriceUSD.toFixed(2)}`,
    `🕐 Generated at midnight UTC`,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Format execution speed with emoji tag.
 * @param {number} ms
 * @returns {string}
 * @private
 */
function _speedTag(ms) {
  if (ms < 800)  return '⚡';
  if (ms < 1500) return '✅';
  if (ms < 3000) return '🐢';
  return '🐌';
}

/**
 * Format a price in SOL with appropriate decimal places.
 * Very small prices get more decimals (memecoins trade at 0.000001 SOL).
 * @param {number} price
 * @returns {string}
 * @private
 */
function _formatPrice(price) {
  if (!price || price === 0) return '0';
  if (price >= 1)       return price.toFixed(4);
  if (price >= 0.001)   return price.toFixed(6);
  if (price >= 0.000001) return price.toFixed(9);
  return price.toExponential(4);
}

/**
 * Build the accuracy comparison line for SELL notifications.
 * Shows how closely our PnL% matched the tracked wallet's.
 * @private
 */
function _accuracyLine(rating, trackedPct, ourPct) {
  const deviation = Math.abs(ourPct - trackedPct).toFixed(1);
  const icons = {
    PERFECT:    '🎯',
    GOOD:       '✅',
    ACCEPTABLE: '⚠️',
    POOR:       '❌',
    FAILED:     '💀',
  };
  const icon = icons[rating] || '⚠️';
  return `${icon} Accuracy: ${rating} (±${deviation}pp vs wallet)`;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  formatBuy,
  formatSell,
  formatFailed,
  formatSkipped,
  formatDailyReport,
};