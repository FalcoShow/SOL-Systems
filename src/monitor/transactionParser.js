// ============================================================
//  SOL SYSTEMS — Transaction Parser
//  File: src/monitor/transactionParser.js
//
//  Takes a raw Solana transaction signature and decodes it into
//  clean, structured swap data the trade executor can act on.
//
//  Parse pipeline (in order, falls back if each fails):
//    1. Helius Enhanced Transactions API  — most reliable
//    2. Helius DAS API                   — fallback for new tokens
//    3. Native Solana RPC getParsedTx    — last resort fallback
//
//  Output format (SwapData object):
//  {
//    txSignature:      string,
//    walletAddress:    string,
//    tradeType:        'BUY' | 'SELL',
//    tokenMint:        string,
//    tokenSymbol:      string,
//    tokenName:        string,
//    amountSOL:        number,   // SOL spent (BUY) or received (SELL)
//    amountTokens:     number,   // Tokens received (BUY) or spent (SELL)
//    pricePerTokenSOL: number,   // amountSOL / amountTokens
//    pricePerTokenUSD: number,   // fetched from price API
//    blockTime:        Date,
//    detectedAt:       Date,
//    source:           string,   // which parser handled it
//    confidence:       'high' | 'medium' | 'low'
//  }
// ============================================================

'use strict';

const axios                           = require('axios');
const { LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const config                          = require('../config');
const logger                          = require('../utils/logger');
const {
  getConnection,
  getTokenMetadata,
  getTokenPrice,
  getSOLPrice,
  shortenAddress,
} = require('../utils/solana');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

// Native SOL and Wrapped SOL mint addresses
// Both represent SOL in swap transactions
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// USDC mint — sometimes trades are USDC↔token instead of SOL↔token
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Stablecoins we treat similarly to SOL for trade direction detection
const STABLE_MINTS = new Set([USDC_MINT, USDT_MINT]);

// Helius API base URL
const HELIUS_API = 'https://api.helius.xyz/v0';

// Request timeout for all external API calls
const API_TIMEOUT_MS = 8000;

// ────────────────────────────────────────────────────────────
//  MAIN PARSE FUNCTION
//  Called by walletMonitor.js → tradeExecutor.js
// ────────────────────────────────────────────────────────────

/**
 * Parse a transaction signature into structured swap data.
 * Tries multiple parsing strategies in order of reliability.
 *
 * @param {string} txSignature   - Solana transaction signature
 * @param {string} walletAddress - The tracked wallet that made this tx
 * @param {Date}   detectedAt    - When we first detected this tx
 *
 * @returns {Promise<SwapData|null>} Parsed swap or null if not a swap
 */
async function parseTransaction(txSignature, walletAddress, detectedAt = new Date()) {
  logger.debug('Parsing transaction', {
    sig:    txSignature.slice(0, 8) + '...',
    wallet: shortenAddress(walletAddress),
  });

  // ── Strategy 1: Helius Enhanced Transactions ─────────────
  try {
    const result = await _parseWithHeliusEnhanced(txSignature, walletAddress, detectedAt);
    if (result) {
      logger.debug('Parsed via Helius Enhanced ✓', {
        sig:       txSignature.slice(0, 8) + '...',
        type:      result.tradeType,
        token:     result.tokenSymbol,
        amountSOL: result.amountSOL?.toFixed(4),
      });
      return result;
    }
  } catch (err) {
    logger.warn('Helius Enhanced parse failed, trying fallback', {
      sig:   txSignature.slice(0, 8) + '...',
      error: err.message,
    });
  }

  // ── Strategy 2: Native RPC Parsed Transaction ────────────
  try {
    const result = await _parseWithNativeRPC(txSignature, walletAddress, detectedAt);
    if (result) {
      logger.debug('Parsed via native RPC ✓', {
        sig:   txSignature.slice(0, 8) + '...',
        type:  result.tradeType,
        token: result.tokenSymbol,
      });
      return result;
    }
  } catch (err) {
    logger.warn('Native RPC parse failed', {
      sig:   txSignature.slice(0, 8) + '...',
      error: err.message,
    });
  }

  // All parsers failed — not a swap or unsupported format
  logger.debug('Transaction could not be parsed as swap', {
    sig: txSignature.slice(0, 8) + '...',
  });
  return null;
}

// ────────────────────────────────────────────────────────────
//  STRATEGY 1: HELIUS ENHANCED TRANSACTIONS
//  Best parser — handles all major Solana DEXs automatically
//  Helius decodes the raw tx and gives us clean swap events
// ────────────────────────────────────────────────────────────

/**
 * Parse using Helius Enhanced Transactions API.
 * @private
 */
async function _parseWithHeliusEnhanced(txSignature, walletAddress, detectedAt) {
  const url = `${HELIUS_API}/transactions/?api-key=${config.solana.heliusApiKey}`;

  const response = await axios.post(
    url,
    { transactions: [txSignature] },
    {
      timeout: API_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    }
  );

  if (!response.data || response.data.length === 0) {
    return null;
  }

  const tx = response.data[0];

  // Helius classifies the transaction type for us
  // We only care about SWAP type transactions
  const isSwap = (
    tx.type === 'SWAP'             ||
    tx.type === 'TOKEN_SWAP'       ||
    tx.type === 'JUPITER_SWAP'     ||
    tx.type === 'RAYDIUM_SWAP'     ||
    tx.type === 'ORCA_SWAP'        ||
    (tx.events && tx.events.swap)
  );

  if (!isSwap) {
    logger.debug('Helius: Not a swap transaction', {
      sig:  txSignature.slice(0, 8) + '...',
      type: tx.type,
    });
    return null;
  }

  // ── Extract from swap event (preferred) ──────────────────
  if (tx.events?.swap) {
    return _extractFromSwapEvent(tx, walletAddress, detectedAt);
  }

  // ── Extract from token transfers (fallback) ───────────────
  if (tx.tokenTransfers && tx.tokenTransfers.length >= 1) {
    return _extractFromTokenTransfers(tx, walletAddress, detectedAt);
  }

  return null;
}

/**
 * Extract swap data from Helius swap event object.
 * This is the most structured and reliable data path.
 * @private
 */
async function _extractFromSwapEvent(tx, walletAddress, detectedAt) {
  const swap     = tx.events.swap;
  const feePayer = tx.feePayer || walletAddress;

  // Get all token inputs and outputs for this wallet
  const inputs  = swap.tokenInputs  || [];
  const outputs = swap.tokenOutputs || [];

  if (inputs.length === 0 || outputs.length === 0) {
    return null;
  }

  // Find the main input and output
  // For multi-hop swaps (e.g. TOKEN → SOL → TOKEN), we want
  // the first input and last output that involve our wallet
  const input  = inputs.find((i)  => i.userAccount === feePayer) || inputs[0];
  const output = outputs.find((o) => o.userAccount === feePayer) || outputs[outputs.length - 1];

  if (!input || !output) return null;

  // ── Determine trade direction ─────────────────────────────
  const inputMint  = input.mint;
  const outputMint = output.mint;

  const inputIsSOL    = inputMint  === SOL_MINT || inputMint  === WSOL_MINT;
  const outputIsSOL   = outputMint === SOL_MINT || outputMint === WSOL_MINT;
  const inputIsStable = STABLE_MINTS.has(inputMint);

  let tradeType, tokenMint, amountSOL, amountTokens;

  if (inputIsSOL || inputIsStable) {
    // Spent SOL/stable → received token = BUY
    tradeType    = 'BUY';
    tokenMint    = outputMint;
    amountSOL    = _extractAmount(input);
    amountTokens = _extractAmount(output);
  } else if (outputIsSOL || STABLE_MINTS.has(outputMint)) {
    // Spent token → received SOL/stable = SELL
    tradeType    = 'SELL';
    tokenMint    = inputMint;
    amountSOL    = _extractAmount(output);
    amountTokens = _extractAmount(input);
  } else {
    // Token → Token swap (rare, e.g. WIF → BONK)
    // Treat the input as SELL and output as BUY
    // Use the larger-valued side as the "SOL equivalent"
    tradeType    = 'BUY';
    tokenMint    = outputMint;
    amountSOL    = _extractAmount(input);   // Approximate
    amountTokens = _extractAmount(output);
    logger.debug('Token→Token swap detected', {
      inputMint:  shortenAddress(inputMint),
      outputMint: shortenAddress(outputMint),
    });
  }

  if (!amountSOL || !amountTokens || !tokenMint) {
    return null;
  }

  const pricePerTokenSOL = amountTokens > 0 ? amountSOL / amountTokens : 0;

  // ── Fetch token metadata and price ───────────────────────
  const [metadata, tokenPriceUSD, solPriceUSD] = await Promise.all([
    getTokenMetadata(tokenMint).catch(() => ({ symbol: '???', name: 'Unknown' })),
    getTokenPrice(tokenMint).catch(() => 0),
    getSOLPrice().catch(() => 0),
  ]);

  const pricePerTokenUSD = tokenPriceUSD || (pricePerTokenSOL * solPriceUSD);

  return {
    txSignature:      tx.signature || tx.transactionError?.signature,
    walletAddress:    feePayer,
    tradeType,
    tokenMint,
    tokenSymbol:      metadata.symbol,
    tokenName:        metadata.name,
    amountSOL:        parseFloat(amountSOL.toFixed(9)),
    amountTokens:     parseFloat(amountTokens.toFixed(9)),
    pricePerTokenSOL: parseFloat(pricePerTokenSOL.toFixed(12)),
    pricePerTokenUSD: parseFloat((pricePerTokenUSD || 0).toFixed(8)),
    blockTime:        tx.timestamp ? new Date(tx.timestamp * 1000) : new Date(),
    detectedAt,
    source:           'helius-swap-event',
    confidence:       'high',
  };
}

/**
 * Extract swap data from Helius token transfers array.
 * Used when swap event object is not populated.
 * @private
 */
async function _extractFromTokenTransfers(tx, walletAddress, detectedAt) {
  if (!tx) return null;                           // ← add this line
  const feePayer  = tx.feePayer || walletAddress;
  const transfers = tx.tokenTransfers || [];

  // Group transfers by direction relative to our wallet
  const sent     = transfers.filter((t) => t.fromUserAccount === feePayer);
  const received = transfers.filter((t) => t.toUserAccount   === feePayer);

  if (sent.length === 0 || received.length === 0) {
    return null;
  }

  // Find the SOL/stablecoin side to determine direction
  const sentSOL     = sent.find((t)     => t.mint === SOL_MINT || t.mint === WSOL_MINT);
  const receivedSOL = received.find((t) => t.mint === SOL_MINT || t.mint === WSOL_MINT);

  let tradeType, tokenMint, amountSOL, amountTokens;
  let tokenTransfer, solTransfer;

  if (sentSOL) {
    // Sent SOL → BUY
    tradeType    = 'BUY';
    solTransfer  = sentSOL;
    tokenTransfer = received.find((t) => t.mint !== SOL_MINT && t.mint !== WSOL_MINT);
    if (!tokenTransfer) return null;
    tokenMint    = tokenTransfer.mint;
    amountSOL    = solTransfer.tokenAmount    || 0;
    amountTokens = tokenTransfer.tokenAmount  || 0;
  } else if (receivedSOL) {
    // Received SOL → SELL
    tradeType    = 'SELL';
    solTransfer  = receivedSOL;
    tokenTransfer = sent.find((t) => t.mint !== SOL_MINT && t.mint !== WSOL_MINT);
    if (!tokenTransfer) return null;
    tokenMint    = tokenTransfer.mint;
    amountSOL    = solTransfer.tokenAmount   || 0;
    amountTokens = tokenTransfer.tokenAmount || 0;
  } else {
    // No SOL side found — token-to-token or unrecognized
    return null;
  }

  if (!amountSOL || !amountTokens || !tokenMint) return null;

  const pricePerTokenSOL = amountTokens > 0 ? amountSOL / amountTokens : 0;

  const [metadata, tokenPriceUSD, solPriceUSD] = await Promise.all([
    getTokenMetadata(tokenMint).catch(() => ({ symbol: '???', name: 'Unknown' })),
    getTokenPrice(tokenMint).catch(() => 0),
    getSOLPrice().catch(() => 0),
  ]);

  const pricePerTokenUSD = tokenPriceUSD || (pricePerTokenSOL * solPriceUSD);

  return {
    txSignature:      tx.signature,
    walletAddress:    feePayer,
    tradeType,
    tokenMint,
    tokenSymbol:      metadata.symbol,
    tokenName:        metadata.name,
    amountSOL:        parseFloat(amountSOL.toFixed(9)),
    amountTokens:     parseFloat(amountTokens.toFixed(9)),
    pricePerTokenSOL: parseFloat(pricePerTokenSOL.toFixed(12)),
    pricePerTokenUSD: parseFloat((pricePerTokenUSD || 0).toFixed(8)),
    blockTime:        tx.timestamp ? new Date(tx.timestamp * 1000) : new Date(),
    detectedAt,
    source:           'helius-transfers',
    confidence:       'medium',
  };
}

// ────────────────────────────────────────────────────────────
//  STRATEGY 2: NATIVE SOLANA RPC
//  Last resort — less structured than Helius but always available
// ────────────────────────────────────────────────────────────

/**
 * Parse using native Solana RPC getParsedTransaction.
 * Less reliable than Helius but works as emergency backup.
 * @private
 */
async function _parseWithNativeRPC(txSignature, walletAddress, detectedAt) {
  const connection = getConnection();

  const tx = await connection.getParsedTransaction(txSignature, {
    commitment:                   'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx || !tx.meta) return null;
  if (tx.meta.err)    return null; // Failed transaction

  const feePayer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58()
    || walletAddress;

  // ── Analyze SOL balance changes ───────────────────────────
  const preSolLamports  = tx.meta.preBalances[0]  || 0;
  const postSolLamports = tx.meta.postBalances[0] || 0;
  const solDiffLamports = postSolLamports - preSolLamports;
  const solDiff         = solDiffLamports / LAMPORTS_PER_SOL;

  // ── Analyze token balance changes ─────────────────────────
  const preTokens  = tx.meta.preTokenBalances  || [];
  const postTokens = tx.meta.postTokenBalances || [];

  // Find tokens that changed for our wallet (account index 0 = fee payer)
  const tokenChanges = _computeTokenBalanceChanges(preTokens, postTokens, feePayer, tx);

  if (tokenChanges.length === 0) return null;

  // Pick the most significant token change (largest absolute amount)
  const mainChange = tokenChanges.sort(
    (a, b) => Math.abs(b.uiChange) - Math.abs(a.uiChange)
  )[0];

  if (!mainChange) return null;

  // ── Determine direction from SOL flow ────────────────────
  // If SOL went down (negative diff accounting for fees), it's a BUY
  // The fee is typically ~0.000005-0.00003 SOL
  const estimatedFee = 0.00005;
  const netSolChange = solDiff + estimatedFee; // Remove fee to see true SOL flow

  let tradeType, amountSOL, amountTokens, tokenMint;

  if (netSolChange < -0.0001 && mainChange.uiChange > 0) {
    // SOL decreased, tokens increased = BUY
    tradeType    = 'BUY';
    amountSOL    = Math.abs(netSolChange);
    amountTokens = mainChange.uiChange;
    tokenMint    = mainChange.mint;
  } else if (netSolChange > 0.0001 && mainChange.uiChange < 0) {
    // SOL increased, tokens decreased = SELL
    tradeType    = 'SELL';
    amountSOL    = Math.abs(netSolChange);
    amountTokens = Math.abs(mainChange.uiChange);
    tokenMint    = mainChange.mint;
  } else {
    // Can't determine direction clearly
    logger.debug('Native parse: ambiguous trade direction', {
      solDiff:    solDiff.toFixed(6),
      tokenChange: mainChange.uiChange,
    });
    return null;
  }

  if (!amountSOL || amountSOL < 0.0001 || !amountTokens) return null;

  const pricePerTokenSOL = amountTokens > 0 ? amountSOL / amountTokens : 0;

  const [metadata, tokenPriceUSD, solPriceUSD] = await Promise.all([
    getTokenMetadata(tokenMint).catch(() => ({ symbol: '???', name: 'Unknown' })),
    getTokenPrice(tokenMint).catch(() => 0),
    getSOLPrice().catch(() => 0),
  ]);

  const pricePerTokenUSD = tokenPriceUSD || (pricePerTokenSOL * solPriceUSD);

  return {
    txSignature,
    walletAddress: feePayer,
    tradeType,
    tokenMint,
    tokenSymbol:      metadata.symbol,
    tokenName:        metadata.name,
    amountSOL:        parseFloat(amountSOL.toFixed(9)),
    amountTokens:     parseFloat(amountTokens.toFixed(9)),
    pricePerTokenSOL: parseFloat(pricePerTokenSOL.toFixed(12)),
    pricePerTokenUSD: parseFloat((pricePerTokenUSD || 0).toFixed(8)),
    blockTime:        tx.blockTime ? new Date(tx.blockTime * 1000) : new Date(),
    detectedAt,
    source:           'native-rpc',
    confidence:       'low',
  };
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Extract a numeric token amount from a Helius token input/output object.
 * Handles multiple possible field formats Helius uses.
 * @private
 */
function _extractAmount(tokenObj) {
  if (!tokenObj) return 0;

  // Try rawTokenAmount first (most precise)
  if (tokenObj.rawTokenAmount) {
    const raw      = tokenObj.rawTokenAmount;
    const decimals = raw.decimals ?? 9;
    return parseFloat(raw.tokenAmount || '0') / Math.pow(10, decimals);
  }

  // Try tokenAmount directly
  if (typeof tokenObj.tokenAmount === 'number') {
    return tokenObj.tokenAmount;
  }

  if (typeof tokenObj.tokenAmount === 'string') {
    return parseFloat(tokenObj.tokenAmount) || 0;
  }

  // Try amount field
  if (typeof tokenObj.amount === 'number') {
    return tokenObj.amount;
  }

  return 0;
}

/**
 * Compute token balance changes per account from pre/post balance arrays.
 * Used by native RPC parser.
 * @private
 */
function _computeTokenBalanceChanges(preTokens, postTokens, feePayer, tx) {
  const changes = [];
  const accountKeys = tx.transaction.message.accountKeys.map(
    (k) => k.pubkey?.toBase58() || k.toString()
  );

  // Build map of pre-balances keyed by accountIndex + mint
  const preMap = new Map();
  for (const pre of preTokens) {
    const owner = accountKeys[pre.accountIndex] || '';
    const key   = `${pre.accountIndex}:${pre.mint}`;
    preMap.set(key, {
      uiAmount: pre.uiTokenAmount?.uiAmount || 0,
      owner,
      mint: pre.mint,
    });
  }

  // Compare with post-balances
  for (const post of postTokens) {
    const owner = accountKeys[post.accountIndex] || '';

    // Only track changes for the fee payer's token accounts
    if (owner !== feePayer && post.owner !== feePayer) continue;

    const key    = `${post.accountIndex}:${post.mint}`;
    const pre    = preMap.get(key);
    const preAmt = pre ? (pre.uiAmount || 0) : 0;
    const postAmt = post.uiTokenAmount?.uiAmount || 0;
    const change = postAmt - preAmt;

    if (Math.abs(change) > 0) {
      changes.push({
        mint:     post.mint,
        uiChange: change,
        owner,
      });
    }
  }

  // Also check for tokens that were fully spent (appear in pre but not post)
  for (const [key, pre] of preMap.entries()) {
    if (pre.owner !== feePayer) continue;
    const exists = postTokens.some(
      (p) => `${p.accountIndex}:${p.mint}` === key
    );
    if (!exists && pre.uiAmount > 0) {
      changes.push({
        mint:     pre.mint,
        uiChange: -pre.uiAmount, // Fully spent
        owner:    pre.owner,
      });
    }
  }

  return changes;
}

/**
 * Validate that a parsed swap result looks sane before returning it.
 * Catches obviously wrong values that could cause bad trades.
 *
 * @param {object} swapData
 * @returns {boolean}
 */
function validateSwapData(swapData) {
  if (!swapData) return false;

  const issues = [];

  if (!swapData.txSignature)        issues.push('missing txSignature');
  if (!swapData.walletAddress)      issues.push('missing walletAddress');
  if (!swapData.tradeType)          issues.push('missing tradeType');
  if (!swapData.tokenMint)          issues.push('missing tokenMint');
  if (!swapData.amountSOL || swapData.amountSOL <= 0)
    issues.push(`invalid amountSOL: ${swapData.amountSOL}`);
  if (!swapData.amountTokens || swapData.amountTokens <= 0)
    issues.push(`invalid amountTokens: ${swapData.amountTokens}`);
  if (!['BUY', 'SELL'].includes(swapData.tradeType))
    issues.push(`invalid tradeType: ${swapData.tradeType}`);

  // Sanity check: SOL amount shouldn't be astronomical
  if (swapData.amountSOL > 100000) {
    issues.push(`suspiciously large amountSOL: ${swapData.amountSOL}`);
  }

  if (issues.length > 0) {
    logger.warn('Swap data validation failed', {
      sig:    swapData.txSignature?.slice(0, 8) + '...',
      issues,
    });
    return false;
  }

  return true;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  parseTransaction,
  validateSwapData,

  // Exported for testing
  _extractFromSwapEvent,
  _extractFromTokenTransfers,
  SOL_MINT,
  WSOL_MINT,
  USDC_MINT,
};