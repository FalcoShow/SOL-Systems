// ============================================================
//  SOL SYSTEMS — Jupiter DEX Client
//  File: src/execution/jupiterClient.js
//
//  Full Jupiter v6 integration for executing swaps on Solana.
//  Jupiter is the best DEX aggregator on Solana — it routes
//  through Raydium, Orca, Meteora, and 20+ other DEXs to
//  always find the best price for our trades.
//
//  Execution pipeline per trade:
//    1. getQuote()            — get best route + price
//    2. buildSwapTransaction()— construct the swap tx
//    3. executeSwap()         — sign + send to network
//    4. confirmTransaction()  — wait for on-chain confirmation
//    5. getSwapResult()       — fetch final fill price + amounts
//
//  Speed optimizations:
//    - Reuses axios instance with keep-alive connections
//    - Pre-fetches blockhash in parallel with quote
//    - Uses skipPreflight for faster submission
//    - Commitment level: "confirmed" not "finalized" (saves ~1s)
//    - Retry logic with fresh blockhash on timeout
// ============================================================

'use strict';

const axios                  = require('axios');
const {
  VersionedTransaction,
  Connection,
  PublicKey,
  TransactionMessage,
  ComputeBudgetProgram,
}                            = require('@solana/web3.js');
const { getWallet, getConnection, shortenAddress, SOLToLamports, lamportsToSOL } = require('../utils/solana');
const config                 = require('../config');
const logger                 = require('../utils/logger');
const jitoClient             = require('./jitoClient');
const feeEstimator           = require('./feeEstimator');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

// Native SOL mint (used as inputMint when buying with SOL)
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Jupiter API v6 endpoints
const JUPITER_QUOTE_URL = config.jupiter.quoteApiUrl;
const JUPITER_SWAP_URL  = config.jupiter.swapApiUrl;

// Transaction confirmation settings
const CONFIRM_TIMEOUT_MS  = 60000;  // 60s max wait for confirmation
const CONFIRM_INTERVAL_MS = 500;    // Check every 500ms
const MAX_RETRIES         = 3;      // Max tx submission retries

// Priority fee in microlamports — pays validators to include our tx faster
// Higher = faster inclusion, but costs more SOL
// 100,000 microlamports = 0.0001 lamports per compute unit
const PRIORITY_FEE_MICROLAMPORTS = 100000;

// Compute unit limit for swap transactions
const COMPUTE_UNIT_LIMIT = 200000;

// ────────────────────────────────────────────────────────────
//  AXIOS INSTANCE
//  Configured with keep-alive and timeouts for performance
// ────────────────────────────────────────────────────────────

const http  = require('http');
const https = require('https');

const jupiterAxios = axios.create({
  timeout: 10000,
  httpAgent:  new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
  headers: { 'Content-Type': 'application/json' },
});

// ────────────────────────────────────────────────────────────
//  STEP 1: GET QUOTE
//  Ask Jupiter for the best swap route and expected output
// ────────────────────────────────────────────────────────────

/**
 * Get a swap quote from Jupiter for a given input/output pair.
 *
 * For BUY:  inputMint = SOL_MINT, outputMint = tokenMint
 * For SELL: inputMint = tokenMint, outputMint = SOL_MINT
 *
 * @param {object} params
 * @param {string} params.inputMint        - Input token mint address
 * @param {string} params.outputMint       - Output token mint address
 * @param {number} params.amountLamports   - Amount in lamports (or raw token units)
 * @param {number} params.slippageBps      - Slippage tolerance in basis points
 *
 * @returns {Promise<QuoteResponse>} Jupiter quote response
 */
async function getQuote({
  inputMint,
  outputMint,
  amountLamports,
  slippageBps = config.jupiter.slippageBps,
}) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount:         amountLamports.toString(),
    slippageBps:    slippageBps.toString(),
    onlyDirectRoutes: 'false',    // Allow multi-hop for better prices
    asLegacyTransaction: 'false', // Use versioned transactions
    maxAccounts:    '64',         // Jupiter default
  });

  const url = `${JUPITER_QUOTE_URL}?${params.toString()}`;

  logger.debug('Fetching Jupiter quote', {
    inputMint:   shortenAddress(inputMint),
    outputMint:  shortenAddress(outputMint),
    amountLamports,
    slippageBps,
  });

  const startMs = Date.now();

  try {
    const response = await jupiterAxios.get(url);
    const quote    = response.data;

    if (!quote || !quote.outAmount) {
      throw new Error('Jupiter returned empty quote response');
    }

    const quoteMs = Date.now() - startMs;

    logger.debug('Jupiter quote received', {
      outAmount:    quote.outAmount,
      priceImpact:  quote.priceImpactPct,
      routePlan:    quote.routePlan?.length + ' hops',
      quoteMs,
    });

    // Validate price impact is within our configured limit
    const priceImpact = parseFloat(quote.priceImpactPct || '0');
    if (priceImpact > config.jupiter.maxPriceImpact) {
      throw new Error(
        `Price impact too high: ${priceImpact.toFixed(2)}% > ${config.jupiter.maxPriceImpact}% limit`
      );
    }

    return quote;

  } catch (err) {
    if (err.response?.status === 400) {
      throw new Error(`Jupiter quote failed: ${err.response.data?.error || 'Bad request'}`);
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
//  STEP 2: BUILD SWAP TRANSACTION
//  Convert the quote into a signable Solana transaction
// ────────────────────────────────────────────────────────────

/**
 * Build a swap transaction from a Jupiter quote.
 * Returns a VersionedTransaction ready to be signed and sent.
 *
 * @param {object} quote          - Quote response from getQuote()
 * @param {string} userPublicKey  - Our wallet's public key
 *
 * @returns {Promise<VersionedTransaction>}
 */
async function buildSwapTransaction(quote, userPublicKey) {
  // Get dynamic priority fee instead of static value
  const dynamicFee = await feeEstimator.getRecommendedFee();

  logger.debug('Building swap transaction', { priorityFee: dynamicFee });

  const swapRequest = {
    quoteResponse:              quote,
    userPublicKey,
    wrapAndUnwrapSol:           true,   // Auto-wrap/unwrap SOL↔WSOL
    useSharedAccounts:          true,   // Reduces tx size
    feeAccount:                 null,   // No referral fee
    computeUnitPriceMicroLamports: dynamicFee,
    asLegacyTransaction:        false,  // Use versioned tx
    useTokenLedger:             false,
    destinationTokenAccount:    null,   // Use default ATA
  };

  try {
    const response = await jupiterAxios.post(JUPITER_SWAP_URL, swapRequest);
    const { swapTransaction } = response.data;

    if (!swapTransaction) {
      throw new Error('Jupiter did not return a swap transaction');
    }

    // Deserialize the base64-encoded versioned transaction
    const txBuffer  = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);

    logger.debug('Swap transaction built', {
      numSignatures:  transaction.signatures.length,
      numInstructions: transaction.message.compiledInstructions?.length,
    });

    return transaction;

  } catch (err) {
    if (err.response?.data) {
      throw new Error(`Jupiter swap build failed: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
//  STEP 3: EXECUTE SWAP
//  Sign the transaction and broadcast it to the Solana network
// ────────────────────────────────────────────────────────────

/**
 * Sign and send a swap transaction to the Solana network.
 * Returns the transaction signature immediately after sending
 * (before confirmation — use confirmTransaction() for that).
 *
 * @param {VersionedTransaction} transaction - Built swap transaction
 * @param {Keypair} wallet                   - Signing wallet keypair
 *
 * @returns {Promise<string>} Transaction signature
 */
async function executeSwap(transaction, wallet) {
  const connection = getConnection();

  // Get fresh blockhash — must be done right before signing
  // Blockhashes expire after ~90 seconds
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(config.solana.commitment);

  // Update the transaction's recent blockhash
  transaction.message.recentBlockhash = blockhash;

  // Sign the transaction with our wallet
  transaction.sign([wallet]);

  logger.debug('Sending swap transaction to network', {
    blockhash:   blockhash.slice(0, 8) + '...',
    lastValidBlockHeight,
  });

  const submitMs = Date.now();

  // Send the transaction
  // skipPreflight: true = don't simulate before sending (faster)
  // maxRetries: 0 = we handle retries ourselves with fresh blockhash
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight:      true,
      maxRetries:         0,
      preflightCommitment: 'processed',
    }
  );

  const submitDuration = Date.now() - submitMs;

  logger.debug('Transaction submitted to network', {
    signature:    signature.slice(0, 8) + '...',
    submitMs:     submitDuration,
  });

  return { signature, lastValidBlockHeight };
}

// ────────────────────────────────────────────────────────────
//  STEP 4: CONFIRM TRANSACTION
//  Wait for the transaction to be confirmed on-chain
// ────────────────────────────────────────────────────────────

/**
 * Wait for a transaction to be confirmed on the Solana network.
 * Polls until confirmed, expired, or timeout.
 *
 * @param {string} signature           - Transaction signature to confirm
 * @param {number} lastValidBlockHeight - Block height after which tx expires
 *
 * @returns {Promise<{confirmed: boolean, error: string|null}>}
 */
async function confirmTransaction(signature, lastValidBlockHeight) {
  const connection = getConnection();
  const startMs    = Date.now();

  logger.debug('Waiting for transaction confirmation', {
    sig: signature.slice(0, 8) + '...',
  });

  while (Date.now() - startMs < CONFIRM_TIMEOUT_MS) {
    // Check current block height
    const currentBlockHeight = await connection.getBlockHeight();

    if (currentBlockHeight > lastValidBlockHeight) {
      return {
        confirmed:  false,
        error:      'Transaction expired — block height exceeded',
        elapsedMs:  Date.now() - startMs,
      };
    }

    // Check transaction status
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: false,
    });

    const confirmationStatus = status?.value?.confirmationStatus;
    const txError            = status?.value?.err;

    if (txError) {
      return {
        confirmed: false,
        error:     `Transaction failed on-chain: ${JSON.stringify(txError)}`,
        elapsedMs: Date.now() - startMs,
      };
    }

    if (
      confirmationStatus === 'confirmed' ||
      confirmationStatus === 'finalized'
    ) {
      const elapsedMs = Date.now() - startMs;
      logger.debug('Transaction confirmed', {
        sig:       signature.slice(0, 8) + '...',
        status:    confirmationStatus,
        elapsedMs,
      });

      return { confirmed: true, error: null, elapsedMs };
    }

    // Not yet confirmed — wait before checking again
    await _sleep(CONFIRM_INTERVAL_MS);
  }

  return {
    confirmed: false,
    error:     `Confirmation timeout after ${CONFIRM_TIMEOUT_MS}ms`,
    elapsedMs: CONFIRM_TIMEOUT_MS,
  };
}

// ────────────────────────────────────────────────────────────
//  STEP 5: GET SWAP RESULT
//  After confirmation, fetch the actual fill price and amounts
// ────────────────────────────────────────────────────────────

/**
 * Fetch the actual execution details of a confirmed swap.
 * Parses the on-chain transaction to get real fill price,
 * actual amounts received, and slippage experienced.
 *
 * @param {string} signature - Confirmed transaction signature
 *
 * @returns {Promise<SwapResult>}
 */
async function getSwapResult(signature) {
  const connection = getConnection();

  try {
    const tx = await connection.getParsedTransaction(signature, {
      commitment:                   'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta) {
      return { success: false, error: 'Transaction not found after confirmation' };
    }

    if (tx.meta.err) {
      return { success: false, error: `On-chain error: ${JSON.stringify(tx.meta.err)}` };
    }

    // Extract actual token amounts from balance changes
    const preTokens  = tx.meta.preTokenBalances  || [];
    const postTokens = tx.meta.postTokenBalances  || [];
    const preSol     = tx.meta.preBalances[0]     || 0;
    const postSol    = tx.meta.postBalances[0]    || 0;

    const feeLamports  = tx.meta.fee || 0;
    const feeSOL       = lamportsToSOL(feeLamports);
    const netSolChange = lamportsToSOL(postSol - preSol);

    // Find the main token that changed
    let tokenMint    = null;
    let tokenChange  = 0;

    for (const post of postTokens) {
      const pre = preTokens.find(
        (p) => p.accountIndex === post.accountIndex && p.mint === post.mint
      );
      const preAmt  = pre?.uiTokenAmount?.uiAmount  || 0;
      const postAmt = post.uiTokenAmount?.uiAmount  || 0;
      const change  = postAmt - preAmt;

      if (Math.abs(change) > Math.abs(tokenChange)) {
        tokenChange = change;
        tokenMint   = post.mint;
      }
    }

    // Determine actual SOL spent or received (excluding fee)
    const actualSolAmount = Math.abs(netSolChange + feeSOL);
    const actualTokenAmount = Math.abs(tokenChange);

    // Calculate actual fill price
    const actualPricePerToken = actualTokenAmount > 0
      ? actualSolAmount / actualTokenAmount
      : 0;

    return {
      success:            true,
      signature,
      tokenMint,
      actualSolAmount:    parseFloat(actualSolAmount.toFixed(9)),
      actualTokenAmount:  parseFloat(actualTokenAmount.toFixed(9)),
      actualPriceSOL:     parseFloat(actualPricePerToken.toFixed(12)),
      feeSOL:             parseFloat(feeSOL.toFixed(9)),
      netSolChange:       parseFloat(netSolChange.toFixed(9)),
      blockTime:          tx.blockTime ? new Date(tx.blockTime * 1000) : new Date(),
    };

  } catch (err) {
    logger.error('Failed to get swap result', {
      sig:   signature.slice(0, 8) + '...',
      error: err.message,
    });
    return { success: false, error: err.message };
  }
}

// ────────────────────────────────────────────────────────────
//  FULL SWAP ORCHESTRATOR
//  Runs the complete pipeline with retry logic
// ────────────────────────────────────────────────────────────

/**
 * Execute a complete swap from quote to confirmation.
 * This is the main function called by tradeExecutor.js.
 *
 * Handles retries automatically:
 *   - Slippage exceeded    → retry with higher slippage (up to 2x)
 *   - Block expired        → retry with fresh blockhash
 *   - RPC timeout          → retry up to MAX_RETRIES times
 *   - On-chain failure     → DO NOT retry (prevents double fills)
 *
 * @param {object} params
 * @param {string} params.tradeType       - 'BUY' or 'SELL'
 * @param {string} params.tokenMint       - Token to buy or sell
 * @param {number} params.amountSOL       - SOL amount for BUY trades
 * @param {number} params.amountTokens    - Token amount for SELL trades
 * @param {number} params.slippageBps     - Starting slippage (increases on retry)
 *
 * @returns {Promise<FullSwapResult>}
 */
async function executeFullSwap({
  tradeType,
  tokenMint,
  amountSOL,
  amountTokens,
  slippageBps = config.jupiter.slippageBps,
}) {
  const wallet          = getWallet();
  const userPublicKey   = wallet.publicKey.toBase58();
  const startMs         = Date.now();
  let   currentSlippage = slippageBps;
  let   lastError       = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Jupiter swap attempt ${attempt}/${MAX_RETRIES}`, {
        type:        tradeType,
        token:       shortenAddress(tokenMint),
        amountSOL:   amountSOL?.toFixed(4),
        slippageBps: currentSlippage,
      });

      // ── Determine input/output mints and amounts ─────────
      let inputMint, outputMint, amountLamports;

      if (tradeType === 'BUY') {
        // Buying: spend SOL → receive token
        inputMint      = SOL_MINT;
        outputMint     = tokenMint;
        amountLamports = SOLToLamports(amountSOL);
      } else {
        // Selling: spend tokens → receive SOL
        inputMint  = tokenMint;
        outputMint = SOL_MINT;
        // For token sells, amount is in raw token units
        // We use the quote's inAmount for precision
        amountLamports = Math.floor(amountTokens);
      }

      // ── Step 1: Get quote ────────────────────────────────
      const quote = await getQuote({
        inputMint,
        outputMint,
        amountLamports,
        slippageBps: currentSlippage,
      });

      // ── Step 2: Build transaction ────────────────────────
      const transaction = await buildSwapTransaction(quote, userPublicKey);

      // ── Step 3: Execute (sign + send) ───────────────────
      // Try Jito bundle first for MEV protection, fallback to standard
      let signature, lastValidBlockHeight, usedJito = false;

      if (jitoClient.isEnabled()) {
        // Sign the transaction first (Jito needs it pre-signed)
        const { blockhash, lastValidBlockHeight: lvbh } =
          await getConnection().getLatestBlockhash(config.solana.commitment);
        transaction.message.recentBlockhash = blockhash;
        transaction.sign([wallet]);
        lastValidBlockHeight = lvbh;

        const jitoResult = await jitoClient.sendBundle(transaction);
        if (jitoResult.success) {
          signature = jitoResult.signature;
          usedJito  = true;
          logger.info('Trade sent via Jito bundle', {
            sig:      signature?.slice(0, 8) + '...',
            bundleId: jitoResult.bundleId,
          });
        } else {
          logger.debug('Jito bundle failed — falling back to standard send', {
            error: jitoResult.error,
          });
        }
      }

      // Standard send (fallback or if Jito disabled)
      if (!usedJito) {
        const execResult = await executeSwap(transaction, wallet);
        signature            = execResult.signature;
        lastValidBlockHeight = execResult.lastValidBlockHeight;
      }

      const submittedAt = new Date();

      // ── Step 4: Confirm ─────────────────────────────────
      // If Jito bundle landed, confirmation is already done — just verify
      const confirmation = usedJito
        ? { confirmed: true, error: null, elapsedMs: 0 }
        : await confirmTransaction(signature, lastValidBlockHeight);

      if (!confirmation.confirmed) {
        // Distinguish between expiry (retriable) and on-chain failure (not retriable)
        if (confirmation.error?.includes('expired')) {
          logger.warn('Transaction expired, retrying with fresh blockhash', {
            attempt,
            sig: signature.slice(0, 8) + '...',
          });
          lastError = confirmation.error;
          continue; // Retry with new blockhash
        }

        if (confirmation.error?.includes('on-chain')) {
          // On-chain failure — do NOT retry (trade definitively failed)
          logger.error('Transaction failed on-chain — NOT retrying', {
            sig:   signature.slice(0, 8) + '...',
            error: confirmation.error,
          });
          return {
            success:     false,
            signature,
            error:       confirmation.error,
            totalMs:     Date.now() - startMs,
            attempts:    attempt,
          };
        }

        // Unknown failure — retry
        lastError = confirmation.error;
        continue;
      }

      const confirmedAt = new Date();

      // ── Step 5: Get actual fill data ────────────────────
      const swapResult = await getSwapResult(signature);
      const totalMs    = Date.now() - startMs;

      logger.tradeConfirmed(
        tradeType,
        shortenAddress(tokenMint),
        swapResult.actualSolAmount || amountSOL,
        signature,
        totalMs
      );

      return {
        success:         true,
        signature,
        submittedAt,
        confirmedAt,
        totalMs,
        attempts:        attempt,
        // Actual fill data
        tokenMint,
        actualSolAmount:   swapResult.actualSolAmount,
        actualTokenAmount: swapResult.actualTokenAmount,
        actualPriceSOL:    swapResult.actualPriceSOL,
        feeSOL:            swapResult.feeSOL,
        // Quote data (what we expected)
        expectedOutAmount: quote.outAmount,
        slippageUsed:      currentSlippage,
        priceImpactPct:    parseFloat(quote.priceImpactPct || '0'),
      };

    } catch (err) {
      lastError = err.message;

      // Slippage exceeded — increase and retry
      if (err.message?.includes('Slippage') || err.message?.includes('slippage')) {
        const maxSlippage = slippageBps * 2;
        currentSlippage   = Math.min(currentSlippage * 2, maxSlippage);

        logger.warn('Slippage exceeded, increasing tolerance', {
          attempt,
          newSlippage: currentSlippage,
          maxSlippage,
        });

        if (currentSlippage > maxSlippage) {
          logger.error('Max slippage exceeded — trade aborted', {
            tokenMint: shortenAddress(tokenMint),
            maxSlippage,
          });
          break;
        }
        continue;
      }

      // Price impact too high — do not retry (market conditions)
      if (err.message?.includes('Price impact')) {
        logger.warn('Trade skipped — price impact too high', {
          error: err.message,
        });
        return {
          success:  false,
          error:    err.message,
          totalMs:  Date.now() - startMs,
          attempts: attempt,
          skipReason: 'PRICE_IMPACT_TOO_HIGH',
        };
      }

      logger.warn(`Swap attempt ${attempt} failed`, {
        error:   err.message,
        attempt,
        totalMs: Date.now() - startMs,
      });

      if (attempt < MAX_RETRIES) {
        // Brief pause before retry
        await _sleep(500 * attempt);
      }
    }
  }

  // All retries exhausted
  return {
    success:  false,
    error:    lastError || 'All retry attempts failed',
    totalMs:  Date.now() - startMs,
    attempts: MAX_RETRIES,
  };
}

// ────────────────────────────────────────────────────────────
//  UTILITY: GET TOKEN BALANCE FOR SELL
//  Before selling, check how many tokens we actually hold
// ────────────────────────────────────────────────────────────

/**
 * Get the raw token amount (in smallest units) for a given mint.
 * Used when building a SELL transaction to know exact amount.
 *
 * @param {string} walletAddress
 * @param {string} tokenMint
 * @returns {Promise<{amount: string, decimals: number, uiAmount: number}>}
 */
async function getTokenAmountForSell(walletAddress, tokenMint) {
  const connection = getConnection();

  try {
    const pubkey   = new PublicKey(walletAddress);
    const tokenPub = new PublicKey(tokenMint);

    const response = await connection.getParsedTokenAccountsByOwner(pubkey, {
      mint: tokenPub,
    });

    if (!response.value || response.value.length === 0) {
      return { amount: '0', decimals: 0, uiAmount: 0 };
    }

    const tokenAccount = response.value[0];
    const info         = tokenAccount.account.data.parsed.info;
    const tokenAmount  = info.tokenAmount;

    return {
      amount:   tokenAmount.amount,    // Raw string e.g. "142857140000"
      decimals: tokenAmount.decimals,
      uiAmount: tokenAmount.uiAmount || 0,
    };

  } catch (err) {
    logger.error('Failed to get token amount for sell', {
      wallet: shortenAddress(walletAddress),
      mint:   shortenAddress(tokenMint),
      error:  err.message,
    });
    return { amount: '0', decimals: 0, uiAmount: 0 };
  }
}

// ────────────────────────────────────────────────────────────
//  SIMULATE QUOTE (dry run, no execution)
//  Used by the dashboard "preview" feature
// ────────────────────────────────────────────────────────────

/**
 * Get a quote without executing anything.
 * Returns expected output, price impact, and route info.
 * Used by the dashboard to preview trade sizing.
 *
 * @param {string} tradeType   - 'BUY' or 'SELL'
 * @param {string} tokenMint
 * @param {number} amountSOL
 * @returns {Promise<object>}
 */
async function simulateQuote(tradeType, tokenMint, amountSOL) {
  try {
    const inputMint      = tradeType === 'BUY' ? SOL_MINT : tokenMint;
    const outputMint     = tradeType === 'BUY' ? tokenMint : SOL_MINT;
    const amountLamports = SOLToLamports(amountSOL);

    const quote = await getQuote({
      inputMint,
      outputMint,
      amountLamports,
    });

    return {
      success:          true,
      inAmount:         quote.inAmount,
      outAmount:        quote.outAmount,
      priceImpactPct:   parseFloat(quote.priceImpactPct || '0'),
      routePlan:        quote.routePlan,
      slippageBps:      quote.slippageBps,
    };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  // Full pipeline (primary entry point)
  executeFullSwap,

  // Individual steps (used in tests and advanced flows)
  getQuote,
  buildSwapTransaction,
  executeSwap,
  confirmTransaction,
  getSwapResult,

  // Utilities
  getTokenAmountForSell,
  simulateQuote,

  // Constants
  SOL_MINT,
};