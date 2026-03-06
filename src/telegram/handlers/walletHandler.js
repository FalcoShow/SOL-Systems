// ============================================================
//  SOL SYSTEMS — Wallet Handler
//  File: src/telegram/handlers/walletHandler.js
//
//  Handles all wallet management Telegram commands:
//    /wallets        — list all tracked wallets with stats
//    /addwallet      — add a new wallet to copy + auto-estimate capital
//    /removewallet   — stop copying a wallet
//
//  When adding a wallet, the handler:
//    1. Validates the address is a real Solana public key
//    2. Checks it isn't already being tracked
//    3. Fetches last 30 days of trade history from Helius
//    4. Runs estimateWalletCapital() to infer their SOL capital
//    5. Saves to database
//    6. Adds to walletMonitor live subscriptions
//    7. Updates Helius webhook to include the new address
//    8. Confirms to user with capital estimate and confidence
// ============================================================

'use strict';

const axios             = require('axios');
const config            = require('../../config');
const logger            = require('../../utils/logger');
const tradeRepository   = require('../../execution/tradeRepository');
const walletMonitor     = require('../../monitor/walletMonitor');
const heliusWebhook     = require('../../monitor/heliusWebhook');
const { estimateWalletCapital } = require('../../utils/calculator');
const { isValidSolanaAddress, shortenAddress, getSOLBalance } = require('../../utils/solana');

// ────────────────────────────────────────────────────────────
//  /wallets — LIST ALL TRACKED WALLETS
// ────────────────────────────────────────────────────────────

/**
 * Handle /wallets — show all tracked wallets with their stats.
 * @param {object} ctx - Telegraf context
 */
async function handleListWallets(ctx) {
  try {
    const wallets = await tradeRepository.getTrackedWallets(false); // all, not just active

    if (!wallets || wallets.length === 0) {
      await ctx.replyWithMarkdown(
        '👛 *No Wallets Tracked Yet*\n\n' +
        'Add a wallet to start copy trading:\n' +
        '`/addwallet <address> <nickname>`\n\n' +
        '*Example:*\n' +
        '`/addwallet CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o Cented`'
      );
      return;
    }

    const lines = [
      `👛 *Tracked Wallets (${wallets.length})*`,
      '━━━━━━━━━━━━━━━━━━━━━',
      '',
    ];

    for (const wallet of wallets) {
      const statusEmoji = wallet.isActive ? '🟢' : '🔴';
      const capital     = wallet.manualCapitalSOL || wallet.estimatedCapitalSOL || 0;
      const wins        = wallet.totalWins   || 0;
      const losses      = wallet.totalLosses || 0;
      const total       = wins + losses;
      const winRate     = total > 0 ? ((wins / total) * 100).toFixed(0) + '%' : 'N/A';
      const pnl         = wallet.totalPnLSOL || 0;
      const pnlSign     = pnl >= 0 ? '+' : '';
      const lastTrade   = wallet.lastTradeAt
        ? _relativeTime(wallet.lastTradeAt)
        : 'Never';

      lines.push(
        `${statusEmoji} *${wallet.nickname}*`,
        `   📍 \`${shortenAddress(wallet.address)}\``,
        `   💰 Capital: \`${capital.toFixed(1)} SOL\` est.`,
        `   📊 ${total} trades · ${winRate} win rate`,
        `   💸 PnL: \`${pnlSign}${pnl.toFixed(3)} SOL\``,
        `   🕐 Last trade: ${lastTrade}`,
        ''
      );
    }

    const activeCount = wallets.filter(w => w.isActive).length;
    lines.push(`_${activeCount} active · ${wallets.length - activeCount} paused_`);

    await ctx.replyWithMarkdown(lines.join('\n'));

  } catch (err) {
    logger.error('walletHandler.handleListWallets error', { error: err.message });
    await ctx.reply('❌ Failed to fetch wallet list. Check logs.');
  }
}

// ────────────────────────────────────────────────────────────
//  /addwallet — ADD A NEW WALLET
// ────────────────────────────────────────────────────────────

/**
 * Handle /addwallet <address> <nickname>
 * Full pipeline: validate → estimate capital → save → subscribe → confirm
 *
 * @param {object} ctx
 * @param {string} address   - Solana wallet address
 * @param {string} nickname  - Display name for this wallet
 */
async function handleAddWallet(ctx, address, nickname) {
  try {
    // ── Step 1: Validate address format ───────────────────
    if (!isValidSolanaAddress(address)) {
      await ctx.replyWithMarkdown(
        '❌ *Invalid Solana address*\n\n' +
        'Make sure you copied the full address.\n' +
        'It should be 32–44 characters of letters and numbers.\n\n' +
        '*Usage:* `/addwallet <address> <nickname>`'
      );
      return;
    }

    // ── Step 2: Check not already tracked ─────────────────
    const existing = await tradeRepository.getTrackedWallet(address);
    if (existing) {
      const status = existing.isActive ? 'already being tracked' : 'tracked but paused';
      await ctx.replyWithMarkdown(
        `⚠️ *Wallet Already Exists*\n\n` +
        `*${existing.nickname}* is ${status}.\n` +
        `Address: \`${shortenAddress(address)}\``
      );
      return;
    }

    // ── Step 3: Check it's not our own trading wallet ─────
    if (address === config.wallet.publicKey) {
      await ctx.reply('❌ You cannot track your own trading wallet.');
      return;
    }

    // Use address shorthand as nickname if none provided
    const finalNickname = nickname || shortenAddress(address);

    // Send progress update — capital estimation takes a few seconds
    await ctx.replyWithMarkdown(
      `⏳ *Analyzing wallet...*\n\n` +
      `Fetching last 30 days of trade history for\n` +
      `*${finalNickname}*\n\`${shortenAddress(address)}\``
    );

    // ── Step 4: Fetch trade history for capital estimation ─
    const recentTrades = await _fetchWalletTradeHistory(address);

    // ── Step 5: Estimate capital ───────────────────────────
    const capitalEstimate = estimateWalletCapital(recentTrades, {
      assumedPositionPct: 0.10,
      percentile:         75,
    });

    // ── Step 6: Get current SOL balance as a sanity check ─
    const currentBalance = await getSOLBalance(address).catch(() => null);

    // If estimated capital is wildly off vs actual balance, use balance
    let finalCapitalSOL = capitalEstimate.estimatedCapitalSOL;
    if (currentBalance !== null && currentBalance > 0) {
      // If balance is more than 2x the estimate, use balance directly
      if (currentBalance > finalCapitalSOL * 2) {
        finalCapitalSOL = currentBalance;
        logger.debug('Using live balance over estimate', {
          estimate: capitalEstimate.estimatedCapitalSOL,
          balance:  currentBalance,
        });
      }
    }

    // ── Step 7: Save to database ───────────────────────────
    const walletRecord = await tradeRepository.addTrackedWallet({
      address,
      nickname:            finalNickname,
      estimatedCapitalSOL: finalCapitalSOL,
    });

    // ── Step 8: Add to live WebSocket monitor ─────────────
    await walletMonitor.addWallet({
      id:       walletRecord.id,
      address,
      nickname: finalNickname,
    });

    // ── Step 9: Update Helius webhook addresses ────────────
    // Get all active wallet addresses for the webhook update
    const allWallets  = await tradeRepository.getTrackedWallets(true);
    const allAddresses = allWallets.map(w => w.address);

    const webhookId = process.env.HELIUS_WEBHOOK_ID;
    if (webhookId) {
      await heliusWebhook.updateWebhookAddresses(webhookId, allAddresses)
        .catch(err => logger.warn('Webhook update failed (non-critical)', {
          error: err.message,
        }));
    }

    // ── Step 10: Confirm to user ───────────────────────────
    const confidenceEmoji = {
      high:   '🟢',
      medium: '🟡',
      low:    '🔴',
    }[capitalEstimate.confidence] || '⚪';

    const recentTradeCount = recentTrades.length;
    const balanceStr = currentBalance !== null
      ? `\`${currentBalance.toFixed(2)} SOL\``
      : 'unknown';

    const lines = [
      `✅ *Wallet Added — ${finalNickname}*`,
      '━━━━━━━━━━━━━━━━━━━━━',
      '',
      `📍 Address: \`${shortenAddress(address)}\``,
      `💰 Live balance: ${balanceStr}`,
      '',
      '📊 *Capital Estimate*',
      `${confidenceEmoji} Estimated: \`${finalCapitalSOL.toFixed(1)} SOL\``,
      `   Confidence: ${capitalEstimate.confidence.toUpperCase()}`,
      `   Based on: ${capitalEstimate.basedOnTrades} trades (30d)`,
      '',
      recentTradeCount > 0
        ? `📈 Found ${recentTradeCount} recent transactions to analyze`
        : '⚠️ No recent trades found — using default estimate',
      '',
      '━━━━━━━━━━━━━━━━━━━━━',
      '🟢 *Now monitoring live*',
      '',
      `The bot will copy all ${finalNickname}'s trades from now on.`,
      '',
      `_To override capital estimate:_`,
      `_/capital <SOL amount>_`,
    ];

    await ctx.replyWithMarkdown(lines.join('\n'));

    logger.info('Wallet added via Telegram', {
      nickname: finalNickname,
      address:  shortenAddress(address),
      capital:  finalCapitalSOL.toFixed(2),
      confidence: capitalEstimate.confidence,
    });

  } catch (err) {
    logger.error('walletHandler.handleAddWallet error', {
      address,
      error: err.message,
    });

    // Handle specific known errors gracefully
    if (err.message?.includes('already being tracked')) {
      await ctx.reply(`⚠️ This wallet is already being tracked.`);
    } else {
      await ctx.replyWithMarkdown(
        `❌ *Failed to add wallet*\n\nError: ${err.message}\n\nCheck that the address is correct and try again.`
      );
    }
  }
}

// ────────────────────────────────────────────────────────────
//  /removewallet — STOP COPYING A WALLET
// ────────────────────────────────────────────────────────────

/**
 * Handle /removewallet <address>
 * Deactivates the wallet — stops copying but keeps trade history.
 *
 * @param {object} ctx
 * @param {string} address - Wallet address to remove
 */
async function handleRemoveWallet(ctx, address) {
  try {
    // Validate address
    if (!isValidSolanaAddress(address)) {
      await ctx.replyWithMarkdown(
        '❌ *Invalid address format*\n\nUse `/wallets` to see tracked addresses.'
      );
      return;
    }

    // Check the wallet is actually being tracked
    const wallet = await tradeRepository.getTrackedWallet(address);
    if (!wallet) {
      await ctx.replyWithMarkdown(
        '⚠️ *Wallet not found*\n\n' +
        `\`${shortenAddress(address)}\` is not in your tracked wallets.\n\n` +
        'Use /wallets to see what\'s being tracked.'
      );
      return;
    }

    const nickname = wallet.nickname;

    // Deactivate in database (keeps history)
    await tradeRepository.deactivateTrackedWallet(address);

    // Remove from live WebSocket subscriptions
    walletMonitor.removeWallet(address);

    // Update Helius webhook to remove this address
    const remainingWallets  = await tradeRepository.getTrackedWallets(true);
    const remainingAddresses = remainingWallets.map(w => w.address);

    const webhookId = process.env.HELIUS_WEBHOOK_ID;
    if (webhookId && remainingAddresses.length >= 0) {
      await heliusWebhook.updateWebhookAddresses(webhookId, remainingAddresses)
        .catch(err => logger.warn('Webhook update on remove failed (non-critical)', {
          error: err.message,
        }));
    }

    await ctx.replyWithMarkdown(
      `🔴 *Wallet Removed — ${nickname}*\n\n` +
      `📍 \`${shortenAddress(address)}\`\n\n` +
      `The bot will no longer copy trades from this wallet.\n\n` +
      `_Trade history is preserved. Use /pnl to see past results._`
    );

    logger.info('Wallet removed via Telegram', {
      nickname,
      address: shortenAddress(address),
    });

  } catch (err) {
    logger.error('walletHandler.handleRemoveWallet error', {
      address,
      error: err.message,
    });
    await ctx.reply(`❌ Failed to remove wallet: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────
//  CAPITAL ESTIMATION — HELIUS TRADE HISTORY FETCH
//  Fetches the last 30 days of swap transactions for a wallet
//  so we can estimate their total SOL capital
// ────────────────────────────────────────────────────────────

/**
 * Fetch recent swap transactions for a wallet from Helius.
 * Used to estimate the wallet's total SOL capital.
 *
 * @param {string} address - Wallet address
 * @returns {Promise<Array>} Array of trade objects with amountSOL and tradeType
 * @private
 */
async function _fetchWalletTradeHistory(address) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions`;

    const response = await axios.get(url, {
      params: {
        'api-key': config.solana.heliusApiKey,
        limit:     100,
        type:      'SWAP',
      },
      timeout: 15000,
    });

    const txList = response.data || [];

    if (txList.length === 0) {
      logger.debug('No swap history found for wallet', {
        address: shortenAddress(address),
      });
      return [];
    }

    // Parse each transaction into our standard trade format
    const trades = [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const tx of txList) {
      // Only look at last 30 days
      if (tx.timestamp && tx.timestamp * 1000 < thirtyDaysAgo) continue;

      // Extract swap data from Helius enhanced transaction
      const swapEvent  = tx.events?.swap;
      const transfers  = tx.tokenTransfers || [];

      let tradeType = null;
      let amountSOL = 0;

      const SOL_MINT = 'So11111111111111111111111111111111111111112';

      if (swapEvent) {
        const inputs  = swapEvent.tokenInputs  || [];
        const outputs = swapEvent.tokenOutputs || [];

        const solInput  = inputs.find(i  => i.mint === SOL_MINT);
        const solOutput = outputs.find(o => o.mint === SOL_MINT);

        if (solInput) {
          tradeType = 'BUY';
          const raw = solInput.rawTokenAmount;
          amountSOL = raw
            ? parseFloat(raw.tokenAmount) / 1e9
            : (solInput.tokenAmount || 0);
        } else if (solOutput) {
          tradeType = 'SELL';
          const raw = solOutput.rawTokenAmount;
          amountSOL = raw
            ? parseFloat(raw.tokenAmount) / 1e9
            : (solOutput.tokenAmount || 0);
        }
      } else if (transfers.length >= 2) {
        const solSent     = transfers.find(t => t.mint === SOL_MINT && t.fromUserAccount === address);
        const solReceived = transfers.find(t => t.mint === SOL_MINT && t.toUserAccount   === address);

        if (solSent) {
          tradeType = 'BUY';
          amountSOL = solSent.tokenAmount || 0;
        } else if (solReceived) {
          tradeType = 'SELL';
          amountSOL = solReceived.tokenAmount || 0;
        }
      }

      if (tradeType && amountSOL > 0.001) {
        trades.push({ tradeType, amountSOL });
      }
    }

    logger.debug('Trade history fetched for capital estimation', {
      address:    shortenAddress(address),
      totalTxs:   txList.length,
      validTrades: trades.length,
    });

    return trades;

  } catch (err) {
    logger.warn('Failed to fetch wallet trade history', {
      address: shortenAddress(address),
      error:   err.message,
    });
    return []; // Return empty — capital will use fallback estimate
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Format a relative time string.
 * @param {Date|string} date
 * @returns {string}
 * @private
 */
function _relativeTime(date) {
  if (!date) return 'never';
  const ms      = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(ms / 60000);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);

  if (days > 0)    return `${days}d ago`;
  if (hours > 0)   return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  handleListWallets,
  handleAddWallet,
  handleRemoveWallet,
};