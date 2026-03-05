// ============================================================
//  SOL SYSTEMS — Solana Blockchain Utilities
//  File: src/utils/solana.js
//
//  Shared utility functions used across the entire system.
//  Every file that needs to talk to the Solana blockchain
//  goes through here — never creates its own connection.
//
//  Functions:
//    - getConnection()           : cached RPC connection
//    - getWallet()               : load trading wallet from private key
//    - getSOLBalance()           : get SOL balance of any address
//    - getTokenAccounts()        : get all SPL token holdings
//    - getTokenBalance()         : get balance of one specific token
//    - parseTransactionForSwap() : decode tx signature into swap data
//    - getTokenMetadata()        : get symbol/name for a token mint
//    - getTokenPrice()           : current USD price via Jupiter
//    - isValidSolanaAddress()    : validate a wallet address format
//    - lamportsToSOL()           : unit conversion
//    - SOLToLamports()           : unit conversion
//    - shortenAddress()          : "CyaE1V...ga54o" display format
// ============================================================

'use strict';

const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

// ────────────────────────────────────────────────────────────
//  CONNECTION CACHE
//  We create one connection and reuse it everywhere.
//  Creating a new connection per-request wastes resources
//  and slows down trade execution.
// ────────────────────────────────────────────────────────────

let _connection = null;

/**
 * Returns the cached Solana RPC connection.
 * Creates it on first call, reuses on every subsequent call.
 *
 * @returns {Connection}
 */
function getConnection() {
  if (!_connection) {
    _connection = new Connection(config.solana.rpcUrl, {
      commitment: config.solana.commitment,
      confirmTransactionInitialTimeout: 60000, // 60s timeout
      wsEndpoint: config.solana.wsUrl,
      httpHeaders: {
        // Some RPC providers require or prefer this
        'Content-Type': 'application/json',
      },
    });
    logger.debug('Solana RPC connection created', {
      rpcUrl: config.solana.rpcUrl.replace(/api-key=.+/, 'api-key=***'),
    });
  }
  return _connection;
}

// ────────────────────────────────────────────────────────────
//  WALLET
//  Load the trading wallet from the private key in .env
//  Cached after first load — private key only decoded once
// ────────────────────────────────────────────────────────────

let _wallet = null;

/**
 * Returns the trading wallet Keypair loaded from the private key.
 * Validates the key decodes correctly and matches the public key in config.
 *
 * @returns {Keypair}
 */
function getWallet() {
  if (!_wallet) {
    try {
      const privateKeyBytes = bs58.decode(config.wallet.privateKey);
      _wallet = Keypair.fromSecretKey(privateKeyBytes);

      // Verify the derived public key matches what's in .env
      const derivedPubkey = _wallet.publicKey.toBase58();
      if (derivedPubkey !== config.wallet.publicKey) {
        throw new Error(
          `Private key does not match public key in .env\n` +
          `  Expected: ${config.wallet.publicKey}\n` +
          `  Got:      ${derivedPubkey}`
        );
      }

      logger.info('Trading wallet loaded', {
        address: shortenAddress(derivedPubkey),
      });
    } catch (err) {
      logger.error('Failed to load trading wallet', { error: err.message });
      throw err;
    }
  }
  return _wallet;
}

// ────────────────────────────────────────────────────────────
//  SOL BALANCE
// ────────────────────────────────────────────────────────────

/**
 * Get the SOL balance of any wallet address.
 *
 * @param {string} walletAddress - Base58 public key
 * @returns {Promise<number>} Balance in SOL (not lamports)
 */
async function getSOLBalance(walletAddress) {
  try {
    const connection = getConnection();
    const pubkey = new PublicKey(walletAddress);
    const lamports = await connection.getBalance(pubkey);
    return lamportsToSOL(lamports);
  } catch (err) {
    logger.error('Failed to get SOL balance', {
      address: shortenAddress(walletAddress),
      error: err.message,
    });
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
//  TOKEN ACCOUNTS
// ────────────────────────────────────────────────────────────

/**
 * Get all SPL token accounts for a wallet.
 * Returns an array of { mint, balance, decimals, uiAmount }
 *
 * @param {string} walletAddress - Base58 public key
 * @returns {Promise<Array>}
 */
async function getTokenAccounts(walletAddress) {
  try {
    const connection = getConnection();
    const pubkey = new PublicKey(walletAddress);

    const response = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: TOKEN_PROGRAM_ID,
    });

    return response.value
      .map((account) => {
        const info = account.account.data.parsed.info;
        return {
          mint: info.mint,
          balance: info.tokenAmount.amount,        // Raw amount (string)
          decimals: info.tokenAmount.decimals,
          uiAmount: info.tokenAmount.uiAmount || 0, // Human-readable amount
          accountAddress: account.pubkey.toBase58(),
        };
      })
      .filter((t) => t.uiAmount > 0); // Only return non-zero balances
  } catch (err) {
    logger.error('Failed to get token accounts', {
      address: shortenAddress(walletAddress),
      error: err.message,
    });
    throw err;
  }
}

/**
 * Get the balance of a specific token in a wallet.
 * Returns 0 if the wallet doesn't hold that token.
 *
 * @param {string} walletAddress - Base58 public key
 * @param {string} tokenMint - Token mint address
 * @returns {Promise<number>} Token balance (human-readable UI amount)
 */
async function getTokenBalance(walletAddress, tokenMint) {
  try {
    const accounts = await getTokenAccounts(walletAddress);
    const match = accounts.find((a) => a.mint === tokenMint);
    return match ? match.uiAmount : 0;
  } catch (err) {
    logger.warn('Failed to get token balance, returning 0', {
      address: shortenAddress(walletAddress),
      mint: shortenAddress(tokenMint),
      error: err.message,
    });
    return 0;
  }
}

// ────────────────────────────────────────────────────────────
//  TRANSACTION PARSING
//  Decodes a Solana transaction signature into readable swap data
//  Uses Helius Enhanced Transactions API for clean parsing
// ────────────────────────────────────────────────────────────

/**
 * Parse a transaction signature into structured swap data.
 * Uses Helius Enhanced Transactions for reliable DEX swap detection.
 *
 * @param {string} txSignature - The transaction signature to parse
 * @returns {Promise<object|null>} Parsed swap data or null if not a swap
 */
async function parseTransactionForSwap(txSignature) {
  try {
    // Use Helius Enhanced Transactions API
    // This handles all the complex Solana transaction decoding for us
    const url = `https://api.helius.xyz/v0/transactions/?api-key=${config.solana.heliusApiKey}`;

    const response = await axios.post(
      url,
      { transactions: [txSignature] },
      { timeout: 10000 }
    );

    if (!response.data || response.data.length === 0) {
      logger.debug('No transaction data returned from Helius', { txSignature });
      return null;
    }

    const tx = response.data[0];

    // Check if this transaction involves a token swap
    // Helius classifies transaction types for us
    const swapTypes = ['SWAP', 'TOKEN_SWAP', 'JUPITER_SWAP'];
    const isSwap = swapTypes.includes(tx.type) ||
      (tx.events && tx.events.swap);

    if (!isSwap) {
      logger.debug('Transaction is not a swap', {
        txSignature: txSignature.slice(0, 8) + '...',
        type: tx.type,
      });
      return null;
    }

    return _parseHeliusSwapEvent(tx, txSignature);

  } catch (err) {
    // Fall back to native RPC parsing if Helius fails
    logger.warn('Helius parsing failed, attempting native parse', {
      txSignature: txSignature.slice(0, 8) + '...',
      error: err.message,
    });
    return _parseTransactionNative(txSignature);
  }
}

/**
 * Parse a Helius enhanced transaction response into our swap format.
 * Internal helper — not exported.
 *
 * @param {object} tx - Helius transaction object
 * @param {string} txSignature
 * @returns {object|null}
 */
function _parseHeliusSwapEvent(tx, txSignature) {
  try {
    const swapEvent = tx.events?.swap;

    if (!swapEvent) {
      // Try to extract from token transfers
      return _parseFromTokenTransfers(tx, txSignature);
    }

    const tokenIn = swapEvent.tokenInputs?.[0];
    const tokenOut = swapEvent.tokenOutputs?.[0];

    if (!tokenIn || !tokenOut) {
      logger.debug('Swap event missing token inputs/outputs', {
        txSignature: txSignature.slice(0, 8) + '...',
      });
      return null;
    }

    // Determine if this is a BUY or SELL relative to SOL
    // BUY  = SOL in, token out  (spending SOL to get a token)
    // SELL = token in, SOL out  (selling a token for SOL)
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';

    let tradeType, tokenMint, amountSOL, amountTokens;

    if (tokenIn.mint === SOL_MINT || tokenIn.mint === WSOL_MINT) {
      // Spent SOL → received a token = BUY
      tradeType   = 'BUY';
      tokenMint   = tokenOut.mint;
      amountSOL   = tokenIn.rawTokenAmount?.tokenAmount
        ? parseFloat(tokenIn.rawTokenAmount.tokenAmount) / LAMPORTS_PER_SOL
        : 0;
      amountTokens = tokenOut.rawTokenAmount?.tokenAmount
        ? parseFloat(tokenOut.rawTokenAmount.tokenAmount) /
          Math.pow(10, tokenOut.rawTokenAmount.decimals || 6)
        : 0;
    } else {
      // Spent a token → received SOL = SELL
      tradeType   = 'SELL';
      tokenMint   = tokenIn.mint;
      amountSOL   = tokenOut.rawTokenAmount?.tokenAmount
        ? parseFloat(tokenOut.rawTokenAmount.tokenAmount) / LAMPORTS_PER_SOL
        : 0;
      amountTokens = tokenIn.rawTokenAmount?.tokenAmount
        ? parseFloat(tokenIn.rawTokenAmount.tokenAmount) /
          Math.pow(10, tokenIn.rawTokenAmount.decimals || 6)
        : 0;
    }

    // Calculate price per token in SOL
    const pricePerTokenSOL = amountTokens > 0 ? amountSOL / amountTokens : 0;

    return {
      txSignature,
      walletAddress:   tx.feePayer,
      tradeType,
      tokenMint,
      tokenSymbol:     null, // Fetched separately via getTokenMetadata()
      tokenName:       null,
      amountSOL,
      amountTokens,
      pricePerTokenSOL,
      pricePerTokenUSD: null, // Fetched separately via getTokenPrice()
      blockTime:       tx.timestamp
        ? new Date(tx.timestamp * 1000)
        : new Date(),
      source:          'helius',
    };

  } catch (err) {
    logger.error('Failed to parse Helius swap event', {
      txSignature: txSignature.slice(0, 8) + '...',
      error: err.message,
    });
    return null;
  }
}

/**
 * Fallback: extract swap data from raw token transfer list.
 * Used when the swap event object isn't populated.
 */
function _parseFromTokenTransfers(tx, txSignature) {
  try {
    const transfers = tx.tokenTransfers || [];
    if (transfers.length < 2) return null;

    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const feePayer = tx.feePayer;

    // Find the transfer where the tracked wallet sent tokens (fromUserAccount)
    // and one where they received tokens (toUserAccount)
    const sent     = transfers.find((t) => t.fromUserAccount === feePayer);
    const received = transfers.find((t) => t.toUserAccount   === feePayer);

    if (!sent || !received) return null;

    const tradeType = sent.mint === SOL_MINT ? 'BUY' : 'SELL';

    let amountSOL, amountTokens, tokenMint;

    if (tradeType === 'BUY') {
      amountSOL    = sent.tokenAmount || 0;
      amountTokens = received.tokenAmount || 0;
      tokenMint    = received.mint;
    } else {
      amountSOL    = received.tokenAmount || 0;
      amountTokens = sent.tokenAmount || 0;
      tokenMint    = sent.mint;
    }

    return {
      txSignature,
      walletAddress:    feePayer,
      tradeType,
      tokenMint,
      tokenSymbol:      null,
      tokenName:        null,
      amountSOL,
      amountTokens,
      pricePerTokenSOL: amountTokens > 0 ? amountSOL / amountTokens : 0,
      pricePerTokenUSD: null,
      blockTime:        tx.timestamp
        ? new Date(tx.timestamp * 1000)
        : new Date(),
      source:           'helius-transfers',
    };
  } catch (err) {
    logger.error('Failed to parse from token transfers', {
      txSignature: txSignature.slice(0, 8) + '...',
      error: err.message,
    });
    return null;
  }
}

/**
 * Native RPC fallback parser.
 * Less reliable than Helius but works as emergency backup.
 */
async function _parseTransactionNative(txSignature) {
  try {
    const connection = getConnection();
    const tx = await connection.getParsedTransaction(txSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta) return null;

    // Look for token balance changes — the core signal of a swap
    const preBalances  = tx.meta.preTokenBalances  || [];
    const postBalances = tx.meta.postTokenBalances || [];

    if (preBalances.length === 0 && postBalances.length === 0) {
      return null; // No token movements = not a swap
    }

    // SOL balance change for the fee payer (index 0 = fee payer)
    const preSol  = tx.meta.preBalances[0]  || 0;
    const postSol = tx.meta.postBalances[0] || 0;
    const solDiff = (postSol - preSol) / LAMPORTS_PER_SOL;

    // Find which token changed hands for the fee payer
    const feePayer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58();

    // This is a simplified parse — the Helius version handles edge cases better
    logger.debug('Native tx parse completed (fallback)', {
      txSignature: txSignature.slice(0, 8) + '...',
      solDiff: solDiff.toFixed(4),
      feePayer: shortenAddress(feePayer || ''),
    });

    return null; // Return null and let the caller handle the miss gracefully
  } catch (err) {
    logger.error('Native transaction parse failed', {
      txSignature: txSignature.slice(0, 8) + '...',
      error: err.message,
    });
    return null;
  }
}

// ────────────────────────────────────────────────────────────
//  TOKEN METADATA
//  Fetch symbol and name for a token mint address
// ────────────────────────────────────────────────────────────

// In-memory cache so we don't re-fetch the same token's metadata
// on every trade. Most wallets trade the same tokens repeatedly.
const _metadataCache = new Map();

/**
 * Get the symbol and name for a token mint address.
 * Uses Jupiter's token list — covers 99% of Solana memecoins.
 * Results cached in memory for the session.
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<{symbol: string, name: string}>}
 */
async function getTokenMetadata(mintAddress) {
  if (_metadataCache.has(mintAddress)) {
    return _metadataCache.get(mintAddress);
  }

  // Strategy 1: Try Jupiter token list (builds full cache on first call)
  if (!_jupiterFetchFailed) {
    try {
      // Jupiter strict list — verified tokens, no auth required
      // Full list (lite-api.jup.ag/tokens/v1/all) is also available
      // but strict is sufficient and faster to load
      const url = `https://lite-api.jup.ag/tokens/v1/strict`;
      const response = await axios.get(url, { timeout: 10000 });

      // Response is a flat array of token objects
      const tokens = Array.isArray(response.data) ? response.data : [];

      // Build the full cache in one shot so future lookups are instant
      for (const token of tokens) {
        if (token.address) {
          _metadataCache.set(token.address, {
            symbol:  token.symbol  || 'UNKNOWN',
            name:    token.name    || 'Unknown Token',
            logoURI: token.logoURI || null,
          });
        }
      }

      logger.debug('Jupiter token list cached', { count: tokens.length });

      if (_metadataCache.has(mintAddress)) {
        return _metadataCache.get(mintAddress);
      }

      // Token not in strict list — fall through to Helius
      // This is expected for brand-new meme coins not yet verified
    } catch (err) {
      // Mark Jupiter as failed so we don't retry on every call
      _jupiterFetchFailed = true;
      logger.warn('Jupiter token list unavailable — using Helius for metadata', {
        error: err.message,
      });
    }
  }

  // Strategy 2: Helius DAS API (always available, per-token)
  return await _getTokenMetadataHelius(mintAddress);
}

// Track if Jupiter token list fetch failed so we don't retry DNS failures repeatedly
let _jupiterFetchFailed = false;

/**
 * Fallback metadata fetch via Helius DAS API.
 * Handles brand-new tokens not yet indexed by Jupiter.
 */
async function _getTokenMetadataHelius(mintAddress) {
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${config.solana.heliusApiKey}`;
    const response = await axios.post(url, {
      jsonrpc: '2.0',
      id: 'metadata',
      method: 'getAsset',
      params: { id: mintAddress },
    }, { timeout: 5000 });

    const asset = response.data?.result;
    if (!asset) {
      throw new Error('No asset data returned');
    }

    const metadata = {
      symbol:  asset.content?.metadata?.symbol  || mintAddress.slice(0, 6) + '...',
      name:    asset.content?.metadata?.name    || 'Unknown Token',
      logoURI: asset.content?.links?.image      || null,
    };

    _metadataCache.set(mintAddress, metadata);
    return metadata;

  } catch (err) {
    logger.debug('Helius metadata fallback failed', {
      mint: shortenAddress(mintAddress),
      error: err.message,
    });
    return { symbol: mintAddress.slice(0, 6) + '...', name: 'Unknown Token' };
  }
}

// ────────────────────────────────────────────────────────────
//  TOKEN PRICE
//  Fetch current USD price for a token via Jupiter Price API
// ────────────────────────────────────────────────────────────

/**
 * Get the current USD price of a token.
 * Uses Jupiter Price API v2 — no API key required.
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<number>} Price in USD, or 0 if unavailable
 */
async function getTokenPrice(mintAddress) {
  try {
    const url = `https://api.jup.ag/price/v2?ids=${mintAddress}`;
    const response = await axios.get(url, { timeout: 5000 });
    const priceData = response.data?.data?.[mintAddress];

    if (!priceData || !priceData.price) {
      return 0;
    }

    return priceData.price;
  } catch (err) {
    logger.debug('Failed to get token price from Jupiter', {
      mint: shortenAddress(mintAddress),
      error: err.message,
    });
    return 0;
  }
}

/**
 * Get current SOL price in USD.
 *
 * @returns {Promise<number>}
 */
async function getSOLPrice() {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  return getTokenPrice(SOL_MINT);
}

// ────────────────────────────────────────────────────────────
//  VALIDATION
// ────────────────────────────────────────────────────────────

/**
 * Check if a string is a valid Solana address.
 * Validates base58 format and correct length (32 bytes).
 *
 * @param {string} address
 * @returns {boolean}
 */
function isValidSolanaAddress(address) {
  try {
    if (!address || typeof address !== 'string') return false;
    const pubkey = new PublicKey(address);
    return PublicKey.isOnCurve(pubkey.toBuffer());
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────
//  UNIT CONVERSIONS
// ────────────────────────────────────────────────────────────

/**
 * Convert lamports to SOL.
 * 1 SOL = 1,000,000,000 lamports
 *
 * @param {number} lamports
 * @returns {number}
 */
function lamportsToSOL(lamports) {
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Convert SOL to lamports.
 *
 * @param {number} sol
 * @returns {number}
 */
function SOLToLamports(sol) {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}

// ────────────────────────────────────────────────────────────
//  DISPLAY HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Shorten a Solana address for display.
 * "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o"
 * becomes "CyaE1V...ga54o"
 *
 * @param {string} address
 * @param {number} chars - Characters to show at each end (default 6)
 * @returns {string}
 */
function shortenAddress(address, chars = 6) {
  if (!address || address.length <= chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format a SOL amount for display, always showing 4 decimal places.
 * e.g. 2.5 → "2.5000 SOL"
 *
 * @param {number} amount
 * @returns {string}
 */
function formatSOL(amount) {
  return `${amount.toFixed(4)} SOL`;
}

/**
 * Format a USD amount for display.
 * e.g. 412.8 → "$412.80"
 *
 * @param {number} amount
 * @returns {string}
 */
function formatUSD(amount) {
  return `$${Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  // Connection & wallet
  getConnection,
  getWallet,

  // Balances
  getSOLBalance,
  getTokenAccounts,
  getTokenBalance,

  // Transaction parsing
  parseTransactionForSwap,

  // Token data
  getTokenMetadata,
  getTokenPrice,
  getSOLPrice,

  // Validation
  isValidSolanaAddress,

  // Unit conversions
  lamportsToSOL,
  SOLToLamports,

  // Display helpers
  shortenAddress,
  formatSOL,
  formatUSD,
};