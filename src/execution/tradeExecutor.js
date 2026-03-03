// ============================================================
//  SOL SYSTEMS — Trade Executor
//  File: src/execution/tradeExecutor.js
//
//  The central orchestrator of the entire copy trading system.
//  Connects every module together into one clean pipeline.
//
//  Full flow per detected trade:
//    1.  Receive swapDetected event from walletMonitor/webhook
//    2.  Parse the transaction (transactionParser)
//    3.  Validate swap data
//    4.  Check if it's a BUY or SELL
//    5.  For BUY:  run scaling math → risk checks → execute → record → notify
//    6.  For SELL: find our open position → execute sell → calc PnL → record → notify
//    7.  Update positionTracker state
//    8.  Send Telegram notification
//
//  Concurrency:
//    Uses a queue (p-queue) so if two wallets trade simultaneously,
//    trades are processed one at a time in order — no race conditions
//    on shared state or the database.
//
//  Speed target: detection → confirmation in under 2000ms
// ============================================================

'use strict';

const PQueue             = require('p-queue').default;
const config             = require('../config');
const logger             = require('../utils/logger');
const { parseTransaction, validateSwapData } = require('../monitor/transactionParser');
const positionTracker    = require('../monitor/positionTracker');
const { scalePositionSize, calculateSOLPnL, verifyPercentageMatch } = require('../utils/calculator');
const { executeFullSwap, getTokenAmountForSell, getQuote, SOL_MINT } = require('./jupiterClient');
const riskManager        = require('./riskManager');
const tradeRepository    = require('./tradeRepository');
const { getSOLBalance, getSOLPrice, shortenAddress, SOLToLamports, lamportsToSOL } = require('../utils/solana');
const marketRegime       = require('../jobs/marketRegime');

// ────────────────────────────────────────────────────────────
//  EXECUTION QUEUE
//  Processes one trade at a time to prevent race conditions.
//  If Cented and another wallet both trade simultaneously,
//  the second trade queues and runs after the first completes.
//  concurrency: 1 = sequential processing
// ────────────────────────────────────────────────────────────

const executionQueue = new PQueue({ concurrency: 1 });

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────

// Telegram notifier — injected after bot initializes to avoid
// circular dependency (bot → executor → bot)
let _telegramNotifier = null;

// Track trades in flight to prevent duplicate processing
const _inFlightSignatures = new Set();

// ────────────────────────────────────────────────────────────
//  INITIALIZATION
// ────────────────────────────────────────────────────────────

/**
 * Initialize the trade executor.
 * Call this once at startup after all modules are ready.
 *
 * @param {object} walletMonitor   - Singleton wallet monitor
 * @param {object} heliusWebhook   - Singleton webhook handler
 * @param {object} telegramNotifier - Telegram notification module
 */
function init(walletMonitor, heliusWebhook, telegramNotifier) {
  _telegramNotifier = telegramNotifier;

  // Listen for swap events from WebSocket monitor
  walletMonitor.on('swapDetected', (event) => {
    _enqueueTradeEvent(event, 'websocket');
  });

  // Listen for swap events from Helius webhook
  heliusWebhook.on('swapDetected', (event) => {
    _enqueueTradeEvent(event, 'webhook');
  });

  logger.info('TradeExecutor initialized and listening for swap events');
}

// ────────────────────────────────────────────────────────────
//  EVENT HANDLER — Enqueue detected swaps
// ────────────────────────────────────────────────────────────

/**
 * Add a detected swap event to the execution queue.
 * Returns immediately — processing happens asynchronously.
 *
 * @param {object} event  - swapDetected event payload
 * @param {string} source - 'websocket' or 'webhook'
 * @private
 */
function _enqueueTradeEvent(event, source) {
  const sig = event.signature || event.swapData?.txSignature;

  // Deduplicate before even queuing
  if (_inFlightSignatures.has(sig)) {
    logger.debug('Trade already in queue or processing', {
      sig: sig?.slice(0, 8) + '...',
    });
    return;
  }

  _inFlightSignatures.add(sig);

  executionQueue.add(async () => {
    try {
      await _processTradeEvent(event, source);
    } catch (err) {
      logger.error('Unhandled error in trade execution pipeline', {
        error: err.message,
        stack: err.stack,
        sig:   sig?.slice(0, 8) + '...',
      });
    } finally {
      _inFlightSignatures.delete(sig);
    }
  });

  logger.debug('Trade event queued', {
    sig:       sig?.slice(0, 8) + '...',
    source,
    queueSize: executionQueue.size,
  });
}

// ────────────────────────────────────────────────────────────
//  MAIN PIPELINE — Process a single trade event end to end
// ────────────────────────────────────────────────────────────

/**
 * Full trade processing pipeline.
 * This runs inside the queue — only one instance at a time.
 *
 * @param {object} event  - swapDetected event
 * @param {string} source - Detection source
 * @private
 */
async function _processTradeEvent(event, source) {
  const detectedAt     = event.detectedAt || new Date();
  const walletAddress  = event.walletAddress;
  const walletId       = event.walletId;
  const nickname       = event.nickname || shortenAddress(walletAddress);
  const signature      = event.signature || event.swapData?.txSignature;

  logger.info('Processing trade event', {
    wallet:    nickname,
    sig:       signature?.slice(0, 8) + '...',
    source,
    queueWait: Date.now() - detectedAt.getTime() + 'ms',
  });

  // ── Step 1: Parse the transaction ─────────────────────────
  // If webhook already parsed it, use that — saves ~200ms
  let swapData = event.swapData || null;

  if (!swapData) {
    swapData = await parseTransaction(signature, walletAddress, detectedAt);
  }

  if (!swapData || !validateSwapData(swapData)) {
    logger.debug('Transaction is not a valid swap, skipping', {
      sig: signature?.slice(0, 8) + '...',
    });
    return;
  }

  logger.tradeDetected(nickname, swapData.tradeType, swapData.tokenSymbol, swapData.amountSOL);

  // ── Step 2: Route to BUY or SELL handler ─────────────────
  if (swapData.tradeType === 'BUY') {
    await _handleBuy(swapData, walletAddress, walletId, nickname, detectedAt);
  } else if (swapData.tradeType === 'SELL') {
    await _handleSell(swapData, walletAddress, walletId, nickname, detectedAt);
  }
}

// ────────────────────────────────────────────────────────────
//  BUY HANDLER
// ────────────────────────────────────────────────────────────

/**
 * Handle a BUY detected on a tracked wallet.
 * Scales the position, runs risk checks, executes, records, notifies.
 *
 * @private
 */
async function _handleBuy(swapData, walletAddress, walletId, nickname, detectedAt) {
  const { tokenMint, tokenSymbol, tokenName, amountSOL: trackedAmountSOL } = swapData;

  // ── Check: Are we already in this position? ────────────────
  if (positionTracker.isInMyPosition(tokenMint)) {
    logger.warn('Skipping BUY — already in position', {
      wallet: nickname,
      token:  tokenSymbol,
    });
    await _recordSkippedTrade(swapData, walletAddress, walletId, 'Already in position');
    return;
  }

  // ── Update tracked wallet position ────────────────────────
  positionTracker.openTrackedPosition(walletAddress, swapData);

  // ── Load settings + tracked wallet in parallel ───────────
  const [settings, trackedWallet] = await Promise.all([
    tradeRepository.getSettings(),
    tradeRepository.getTrackedWallet(walletAddress),
  ]);

  // ── Time window enforcement ───────────────────────────────
  // If the AI assigned a tracking window, skip trades outside it.
  // e.g. trackFrom="13:00", trackUntil="21:00" → only trade 13:00–21:00 UTC
  if (trackedWallet?.trackFrom && trackedWallet?.trackUntil) {
    const now  = new Date();
    const hhmm = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
    if (hhmm < trackedWallet.trackFrom || hhmm >= trackedWallet.trackUntil) {
      logger.info('Skipping trade — outside AI tracking window', {
        wallet: nickname,
        token:  tokenSymbol,
        now:    hhmm,
        window: `${trackedWallet.trackFrom}–${trackedWallet.trackUntil} UTC`,
      });
      await _recordSkippedTrade(swapData, walletAddress, walletId,
        `Outside tracking window (${trackedWallet.trackFrom}–${trackedWallet.trackUntil} UTC)`);
      return;
    }
  }

  // ── Stale entry detection ────────────────────────────────
  // If the token price has moved significantly since the tracked wallet
  // bought, our entry is stale — we'd buy at a worse price and their
  // profitable exit becomes our loss. Check the current price vs their
  // entry price to decide whether to skip, reduce, or proceed.
  const staleMaxDev = settings.staleEntryMaxDevPct ?? 20;
  let staleMultiplier = 1.0; // 1.0 = full position, 0.5 = half, 0 = skip

  if (swapData.pricePerTokenSOL && swapData.pricePerTokenSOL > 0) {
    try {
      // Get a quick Jupiter quote to check current price
      // Buy 0.001 SOL worth to get the exchange rate without moving the market
      const probeQuote = await getQuote({
        inputMint:      SOL_MINT,
        outputMint:     tokenMint,
        amountLamports: SOLToLamports(0.001),
        slippageBps:    500, // loose slippage for probe — we don't execute this
      });

      if (probeQuote && probeQuote.outAmount) {
        const probeTokensOut = parseFloat(probeQuote.outAmount);
        const probeSOLIn     = 0.001;
        const currentPriceSOL = probeTokensOut > 0 ? probeSOLIn / probeTokensOut : 0;
        const theirPriceSOL   = swapData.pricePerTokenSOL;

        if (currentPriceSOL > 0 && theirPriceSOL > 0) {
          const deviationPct = ((currentPriceSOL - theirPriceSOL) / theirPriceSOL) * 100;

          if (deviationPct > staleMaxDev) {
            // Token pumped too much — skip entirely
            logger.warn('Skipping BUY — stale entry, token pumped too far', {
              wallet: nickname, token: tokenSymbol,
              theirPrice: theirPriceSOL.toFixed(12),
              currentPrice: currentPriceSOL.toFixed(12),
              deviation: deviationPct.toFixed(1) + '%',
              maxDev: staleMaxDev + '%',
            });
            await _recordSkippedTrade(swapData, walletAddress, walletId,
              `Stale entry — price up ${deviationPct.toFixed(1)}% since tracked wallet bought (max ${staleMaxDev}%)`);
            return;
          }

          if (deviationPct > staleMaxDev / 2.5) {
            // Moderate deviation — reduce position by 50%
            staleMultiplier = 0.5;
            logger.info('Late entry detected — reducing position 50%', {
              wallet: nickname, token: tokenSymbol,
              deviation: deviationPct.toFixed(1) + '%',
            });
          }

          if (deviationPct < -15) {
            // Token dumping after their buy — bad signal
            logger.warn('Skipping BUY — token dumping after tracked wallet bought', {
              wallet: nickname, token: tokenSymbol,
              deviation: deviationPct.toFixed(1) + '%',
            });
            await _recordSkippedTrade(swapData, walletAddress, walletId,
              `Token dumping ${deviationPct.toFixed(1)}% since tracked wallet bought — bad signal`);
            return;
          }
        }
      }
    } catch (err) {
      // Non-fatal — if we can't check, proceed with full position
      logger.debug('Stale entry check failed — proceeding anyway', {
        token: tokenSymbol, error: err.message,
      });
    }
  }

  // ── Capital for position sizing ───────────────────────────
  // Use the AI-assigned budget for this wallet (allocationSOL) when set,
  // so we deploy exactly the slice the AI intended rather than full capital.
  // Falls back to full settings capital for manually-added wallets.
  // In full compound mode, use live balance for maximum growth.
  let myCapitalSOL = trackedWallet?.allocationSOL || settings.myCapitalSOL;

  if (!trackedWallet?.allocationSOL && settings.compoundMode === 'full') {
    const liveBalance = await getSOLBalance(config.wallet.publicKey).catch(() => null);
    if (liveBalance && liveBalance > myCapitalSOL) {
      myCapitalSOL = Math.max(liveBalance - (settings.minSolReserve || 0.1), myCapitalSOL);
    }
  }

  // ── Get tracked wallet's estimated capital ────────────────
  const trackedCapitalSOL = trackedWallet?.manualCapitalSOL
    || trackedWallet?.estimatedCapitalSOL
    || 0;

  if (!trackedCapitalSOL || trackedCapitalSOL === 0) {
    logger.warn('Tracked wallet capital unknown — using fallback estimate', {
      wallet: nickname,
    });
  }

  // ── Scale position size ───────────────────────────────────
  const scaling = scalePositionSize({
    trackedBuyAmountSOL:    trackedAmountSOL,
    trackedWalletCapitalSOL: trackedCapitalSOL || (trackedAmountSOL * 10), // fallback: assume trade is ~10% of cap
    settings: {
      myCapitalSOL,
      maxPositionPct:   settings.maxPositionPct,
      minSolReserve:    settings.minSolReserve,
      maxOpenPositions: settings.maxOpenPositions,
    },
    currentOpenPositions: positionTracker.getMyOpenPositionCount(),
  });

  // Compute supplementary ratios for logging and DB records
  const effectiveTrackedCap = trackedCapitalSOL || (trackedAmountSOL * 10);
  const scalingRatio        = myCapitalSOL / effectiveTrackedCap;
  const trackedPositionPct  = trackedAmountSOL / effectiveTrackedCap;

  if (scaling.skip) {
    logger.warn('Scaled position too small to execute', {
      wallet: nickname,
      token:  tokenSymbol,
      reason: scaling.reason,
    });
    await _recordSkippedTrade(swapData, walletAddress, walletId, scaling.reason);
    return;
  }

  // ── Apply risk manager limits ─────────────────────────────
  const currentSOLBalance   = await getSOLBalance(config.wallet.publicKey);
  const openPositionsCount  = positionTracker.getMyOpenPositionCount();
  const todayLossSOL        = await tradeRepository.getTodayLossSOL();

  const riskCheck = riskManager.checkBuy({
    proposedPositionSOL: scaling.positionSOL,
    settings,
    context: {
      currentSOLBalance,
      openPositionsCount,
      todayLossSOL,
    },
  });

  if (!riskCheck.approved) {
    logger.warn('Risk manager blocked BUY', {
      wallet: nickname,
      token:  tokenSymbol,
      reason: riskCheck.skipReason,
    });
    await _recordSkippedTrade(swapData, walletAddress, walletId, riskCheck.skipReason);

    // If daily loss limit hit — notify via Telegram
    if (riskCheck.skipReason?.includes('loss limit')) {
      await _notify('LOSS_LIMIT_HIT', { settings, todayLossSOL });
    }
    return;
  }

  // Apply stale entry and market regime multipliers
  const regimeMultiplier = marketRegime.getMultiplier();

  if (regimeMultiplier <= 0) {
    logger.warn('Skipping BUY — market regime is PANIC', {
      wallet: nickname, token: tokenSymbol, regime: marketRegime.getRegime(),
    });
    await _recordSkippedTrade(swapData, walletAddress, walletId,
      `Market regime: ${marketRegime.getRegime()} — no new buys`);
    return;
  }

  const finalPositionSOL = riskCheck.finalPositionSOL * staleMultiplier * regimeMultiplier;

  if (staleMultiplier < 1.0 || regimeMultiplier !== 1.0) {
    logger.info('Position adjusted by multipliers', {
      original: riskCheck.finalPositionSOL.toFixed(4),
      final:    finalPositionSOL.toFixed(4),
      stale:    staleMultiplier,
      regime:   regimeMultiplier,
      regimeName: marketRegime.getRegime(),
    });
  }

  // ── Record the wallet trade in DB ─────────────────────────
  const walletTradeRecord = await tradeRepository.recordWalletTrade({
    trackedWalletId:   walletId,
    txSignature:       swapData.txSignature,
    blockTime:         swapData.blockTime,
    tradeType:         'BUY',
    tokenMint,
    tokenSymbol,
    tokenName,
    amountSOL:         trackedAmountSOL,
    amountTokens:      swapData.amountTokens,
    pricePerTokenSOL:  swapData.pricePerTokenSOL,
    pricePerTokenUSD:  swapData.pricePerTokenUSD,
    trackedCapitalSOL,
  });

  // ── Record our pending trade in DB ────────────────────────
  const myTradeRecord = await tradeRepository.recordMyTrade({
    trackedWalletId:    walletId,
    walletTradeId:      walletTradeRecord.id,
    tradeType:          'BUY',
    tokenMint,
    tokenSymbol,
    tokenName,
    myCapitalSOL,
    trackedCapitalSOL,
    scalingRatio,
    requestedAmountSOL: finalPositionSOL,
    requestedPriceSOL:  swapData.pricePerTokenSOL,
    detectedAt,
    status:             'PENDING',
  });

  // ── Execute the swap on Jupiter ───────────────────────────
  logger.info('Executing copy BUY', {
    token:       tokenSymbol,
    amountSOL:   finalPositionSOL.toFixed(4),
    scalingRatio: scalingRatio.toFixed(4),
    theirPct:    (trackedPositionPct * 100).toFixed(2) + '%',
    ourPct:      scaling.positionPct.toFixed(2) + '%',
  });

  const submittedAt = new Date();
  const swapResult  = await executeFullSwap({
    tradeType:   'BUY',
    tokenMint,
    amountSOL:   finalPositionSOL,
    slippageBps: settings.maxSlippageBps,
  });

  const confirmedAt   = new Date();
  const executionMs   = confirmedAt.getTime() - detectedAt.getTime();

  // ── Handle execution result ───────────────────────────────
  if (!swapResult.success) {
    logger.tradeFailed('BUY', tokenSymbol, swapResult.error);

    await tradeRepository.updateTradeStatus(myTradeRecord.id, {
      status:       'FAILED',
      errorMessage: swapResult.error,
      submittedAt,
    });

    await _notify('TRADE_FAILED', {
      tradeType: 'BUY',
      tokenSymbol,
      error: swapResult.error,
    });

    // Remove from tracked positions since we didn't actually buy
    positionTracker.closeTrackedPosition(walletAddress, swapData);
    return;
  }

  // ── Update trade record with confirmed data ────────────────
  await tradeRepository.updateTradeStatus(myTradeRecord.id, {
    status:           'CONFIRMED',
    txSignature:      swapResult.signature,
    submittedAt,
    confirmedAt,
    executionMs,
    executedAmountSOL: swapResult.actualSolAmount,
    amountTokens:      swapResult.actualTokenAmount,
    executedPriceSOL:  swapResult.actualPriceSOL,
    slippagePct:       swapResult.priceImpactPct,
  });

  // ── Update position tracker ───────────────────────────────
  positionTracker.openMyPosition(tokenMint, {
    id:               myTradeRecord.id,
    tokenSymbol,
    tokenName,
    executedPriceSOL: swapResult.actualPriceSOL,
    executedAmountSOL: swapResult.actualSolAmount,
    amountTokens:     swapResult.actualTokenAmount,
    confirmedAt,
  });

  // ── Update wallet stats ───────────────────────────────────
  await tradeRepository.incrementWalletTradeCount(walletId);

  logger.tradeConfirmed('BUY', tokenSymbol, swapResult.actualSolAmount, swapResult.signature, executionMs);

  // ── Send Telegram notification ────────────────────────────
  if (settings.notifyOnBuy) {
    await _notify('BUY_EXECUTED', {
      nickname,
      tokenSymbol,
      tokenName,
      amountSOL:     swapResult.actualSolAmount,
      priceSOL:      swapResult.actualPriceSOL,
      txSignature:   swapResult.signature,
      executionMs,
      theirPct:      trackedPositionPct,
      ourPct:        scaling.positionPct,
    });
  }
}

// ────────────────────────────────────────────────────────────
//  SELL HANDLER
// ────────────────────────────────────────────────────────────

/**
 * Handle a SELL detected on a tracked wallet.
 * Find our open position, execute the sell, calculate PnL, notify.
 *
 * @private
 */
async function _handleSell(swapData, walletAddress, walletId, nickname, detectedAt) {
  const { tokenMint, tokenSymbol } = swapData;

  // ── Check: Are we in this position? ──────────────────────
  const myPosition = positionTracker.getMyPosition(tokenMint);

  if (!myPosition) {
    logger.info('Tracked wallet sold token we are not holding — skipping', {
      wallet: nickname,
      token:  tokenSymbol,
    });
    // Still close their tracked position
    positionTracker.closeTrackedPosition(walletAddress, swapData);
    return;
  }

  // ── Get tracked wallet's entry price for PnL comparison ──
  const trackedPosition = positionTracker.getTrackedPosition(walletAddress, tokenMint);
  const trackedEntryPriceSOL = trackedPosition?.entryPriceSOL || 0;
  const trackedPnlPct = trackedEntryPriceSOL > 0
    ? ((swapData.pricePerTokenSOL - trackedEntryPriceSOL) / trackedEntryPriceSOL) * 100
    : 0;

  // ── Close tracked wallet's position ───────────────────────
  positionTracker.closeTrackedPosition(walletAddress, swapData);

  // ── Load settings ─────────────────────────────────────────
  const settings = await tradeRepository.getSettings();

  // ── Get actual token balance we hold ─────────────────────
  // Always sell the EXACT amount we hold — not estimated
  const tokenBalance = await getTokenAmountForSell(
    config.wallet.publicKey,
    tokenMint
  );

  if (!tokenBalance.amount || tokenBalance.amount === '0') {
    logger.warn('No token balance found for sell — position may have already been closed', {
      token: tokenSymbol,
    });
    positionTracker.closeMyPosition(tokenMint, { executedAmountSOL: 0 });
    return;
  }

  // ── Record the wallet sell trade in DB ────────────────────
  const walletTradeRecord = await tradeRepository.recordWalletTrade({
    trackedWalletId:  walletId,
    txSignature:      swapData.txSignature,
    blockTime:        swapData.blockTime,
    tradeType:        'SELL',
    tokenMint,
    tokenSymbol,
    tokenName:        swapData.tokenName,
    amountSOL:        swapData.amountSOL,
    amountTokens:     swapData.amountTokens,
    pricePerTokenSOL: swapData.pricePerTokenSOL,
    pricePerTokenUSD: swapData.pricePerTokenUSD,
    pnlPct:           trackedPnlPct,
    isWin:            trackedPnlPct >= 0,
  });

  // ── Record our pending sell in DB ─────────────────────────
  const myTradeRecord = await tradeRepository.recordMyTrade({
    trackedWalletId:    walletId,
    walletTradeId:      walletTradeRecord.id,
    tradeType:          'SELL',
    tokenMint,
    tokenSymbol,
    tokenName:          swapData.tokenName,
    myCapitalSOL:       settings.myCapitalSOL,
    trackedCapitalSOL:  trackedPosition?.entryAmountSOL || 0,
    scalingRatio:       myPosition.entryAmountSOL / (trackedPosition?.entryAmountSOL || 1),
    requestedAmountSOL: myPosition.entryAmountSOL,
    requestedPriceSOL:  swapData.pricePerTokenSOL,
    entryTradeId:       myPosition.tradeId,
    trackedPnlPct,
    detectedAt,
    status:             'PENDING',
  });

  // ── Execute the sell on Jupiter ───────────────────────────
  logger.info('Executing copy SELL', {
    token:         tokenSymbol,
    tokenAmount:   tokenBalance.uiAmount,
    trackedPnlPct: trackedPnlPct.toFixed(2) + '%',
  });

  const submittedAt = new Date();
  const swapResult  = await executeFullSwap({
    tradeType:    'SELL',
    tokenMint,
    amountTokens: parseFloat(tokenBalance.amount), // Raw token units
    slippageBps:  settings.maxSlippageBps,
  });

  const confirmedAt = new Date();
  const executionMs = confirmedAt.getTime() - detectedAt.getTime();

  // ── Handle execution result ───────────────────────────────
  if (!swapResult.success) {
    logger.tradeFailed('SELL', tokenSymbol, swapResult.error);

    await tradeRepository.updateTradeStatus(myTradeRecord.id, {
      status:       'FAILED',
      errorMessage: swapResult.error,
      submittedAt,
    });

    await _notify('TRADE_FAILED', {
      tradeType: 'SELL',
      tokenSymbol,
      error: swapResult.error,
    });
    return;
  }

  // ── Calculate our PnL ─────────────────────────────────────
  const entryAmountSOL  = myPosition.entryAmountSOL;
  const exitAmountSOL   = swapResult.actualSolAmount;
  const { pnlSOL, pnlPct, isWin } = calculateSOLPnL(entryAmountSOL, exitAmountSOL);

  // ── Verify our PnL% matched theirs ───────────────────────
  const accuracy = verifyPercentageMatch(trackedPnlPct, pnlPct);

  logger.tradePnL(tokenSymbol, pnlSOL, 0, pnlPct, isWin);

  if (accuracy.rating === 'POOR' || accuracy.rating === 'FAILED') {
    logger.warn('PnL accuracy below threshold', {
      token:        tokenSymbol,
      theirPct:     trackedPnlPct.toFixed(2) + '%',
      ourPct:       pnlPct.toFixed(2) + '%',
      deviation:    accuracy.deviation.toFixed(2) + 'pp',
      rating:       accuracy.rating,
    });
  }

  // ── Get SOL price for USD conversion ─────────────────────
  const solPriceUSD = await getSOLPrice().catch(() => 0);
  const pnlUSD      = pnlSOL * solPriceUSD;

  // ── Update trade record ───────────────────────────────────
  await tradeRepository.updateTradeStatus(myTradeRecord.id, {
    status:           'CONFIRMED',
    txSignature:      swapResult.signature,
    submittedAt,
    confirmedAt,
    executionMs,
    executedAmountSOL: swapResult.actualSolAmount,
    amountTokens:      swapResult.actualTokenAmount,
    executedPriceSOL:  swapResult.actualPriceSOL,
    slippagePct:       swapResult.priceImpactPct,
    pnlSOL,
    pnlUSD,
    pnlPct,
    trackedPnlPct,
    pnlDeviation:      accuracy.deviation,
    isWin,
    isOpen:            false,
  });

  // ── Close position in tracker ─────────────────────────────
  positionTracker.closeMyPosition(tokenMint, {
    executedAmountSOL: swapResult.actualSolAmount,
    executedPriceSOL:  swapResult.actualPriceSOL,
    confirmedAt,
  });

  // ── Update wallet stats ───────────────────────────────────
  await tradeRepository.updateWalletPnL(walletId, pnlSOL, isWin);

  // ── Intraday wallet eviction ───────────────────────────────
  // If this was a loss, check whether this wallet has hit a consecutive
  // loss streak. 5+ losses in a row strongly signals the wallet's edge
  // has broken for the day — pause it to prevent further drawdown.
  if (!isWin) {
    const EVICTION_THRESHOLD = 5;
    const streak = await tradeRepository.getConsecutiveLosses(walletId);

    if (streak >= EVICTION_THRESHOLD) {
      logger.warn('Evicting wallet — consecutive loss threshold hit', {
        wallet:   nickname,
        streak,
        threshold: EVICTION_THRESHOLD,
      });

      await tradeRepository.deactivateTrackedWallet(walletAddress);

      await _notify('RAW', {
        message:
          `🚨 *Wallet Evicted — Loss Streak*\n\n` +
          `Wallet: *${nickname}* (\`${walletAddress.slice(0, 8)}...\`)\n` +
          `Consecutive losses: *${streak}*\n\n` +
          `_Wallet paused until next nightly AI refresh._\n` +
          `_Use /addwallet to re-enable manually if needed._`,
      });
    }
  }

  // ── Send Telegram notification ────────────────────────────
  if (settings.notifyOnSell) {
    await _notify('SELL_EXECUTED', {
      nickname,
      tokenSymbol,
      tokenName:      swapData.tokenName,
      entryPriceSOL:  myPosition.entryPriceSOL,
      exitPriceSOL:   swapResult.actualPriceSOL,
      pnlSOL,
      pnlUSD,
      pnlPct,
      trackedPnlPct,
      isWin,
      txSignature:    swapResult.signature,
      executionMs,
      accuracyRating: accuracy.rating,
    });
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Record a trade we decided to skip (risk manager or other check).
 * @private
 */
async function _recordSkippedTrade(swapData, walletAddress, walletId, reason) {
  try {
    const settings = await tradeRepository.getSettings();

    // Record the wallet trade so we have history
    const walletTradeRecord = await tradeRepository.recordWalletTrade({
      trackedWalletId:  walletId,
      txSignature:      swapData.txSignature,
      blockTime:        swapData.blockTime,
      tradeType:        swapData.tradeType,
      tokenMint:        swapData.tokenMint,
      tokenSymbol:      swapData.tokenSymbol,
      tokenName:        swapData.tokenName,
      amountSOL:        swapData.amountSOL,
      amountTokens:     swapData.amountTokens,
      pricePerTokenSOL: swapData.pricePerTokenSOL,
      pricePerTokenUSD: swapData.pricePerTokenUSD,
    });

    // Record our skipped trade
    await tradeRepository.recordMyTrade({
      trackedWalletId:    walletId,
      walletTradeId:      walletTradeRecord.id,
      tradeType:          swapData.tradeType,
      tokenMint:          swapData.tokenMint,
      tokenSymbol:        swapData.tokenSymbol,
      tokenName:          swapData.tokenName,
      myCapitalSOL:       settings.myCapitalSOL,
      trackedCapitalSOL:  0,
      scalingRatio:       0,
      requestedAmountSOL: 0,
      detectedAt:         swapData.blockTime || new Date(),
      status:             'SKIPPED',
      errorMessage:       reason,
    });

  } catch (err) {
    logger.error('Failed to record skipped trade', { error: err.message });
  }
}

/**
 * Send a Telegram notification.
 * Silently fails if notifier not yet initialized.
 * @private
 */
async function _notify(type, data) {
  if (!_telegramNotifier) return;
  try {
    await _telegramNotifier.send(type, data);
  } catch (err) {
    logger.error('Telegram notification failed', {
      type,
      error: err.message,
    });
  }
}

// ────────────────────────────────────────────────────────────
//  STATUS
// ────────────────────────────────────────────────────────────

/**
 * Get executor status for health checks.
 * @returns {object}
 */
function getStatus() {
  return {
    queueSize:    executionQueue.size,
    queuePending: executionQueue.pending,
    inFlight:     _inFlightSignatures.size,
  };
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  init,
  getStatus,
};