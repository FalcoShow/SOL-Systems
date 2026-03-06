// ============================================================
//  SOL SYSTEMS — Helius On-Chain Wallet Data Source
//  File: src/ai/dataSources/helius.js
//
//  Fourth data source for the wallet intelligence pipeline.
//  Uses first-party blockchain data via Helius Enhanced
//  Transactions API — no third-party leaderboards to break.
//
//  Discovery strategy:
//    1. Fetch trending Solana tokens from DexScreener (free, no key)
//    2. For each trending token, get recent swap history via Helius
//    3. Extract unique trader wallets from those swaps
//    4. Enrich top wallets with full 7-day swap history
//    5. Calculate stats (win rate, PnL, frequency) from raw data
//    6. Return normalised WalletCandidate objects
//
//  API:  Helius Enhanced Transactions (already have key)
//  Auth: ?api-key= query param
//  Base: https://api-mainnet.helius-rpc.com
// ============================================================

'use strict';

const axios  = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const HELIUS_BASE       = 'https://api-mainnet.helius-rpc.com';
const DEXSCREENER_BASE  = 'https://api.dexscreener.com';
const REQUEST_TIMEOUT   = 15_000;
const DELAY_BETWEEN     = 350;      // ms between Helius calls (~2.8 RPS, well under 30 RPS)
const MAX_WALLETS       = 20;
const MAX_TRENDING      = 8;        // Trending tokens to scan
const SOL_MINT          = 'So11111111111111111111111111111111111111112';

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Discover top trader wallets from on-chain data.
 * Uses DexScreener for trending tokens, Helius for on-chain swap data.
 *
 * @returns {Promise<WalletCandidate[]>}
 */
async function getTopTraders() {
  const apiKey = config.solana.heliusApiKey;

  if (!apiKey) {
    logger.debug('[Helius] No API key configured — skipping Helius data source');
    return [];
  }

  logger.info('[Helius] Discovering whale traders from on-chain data...');

  try {
    // ── Step 1: Get trending Solana tokens ───────────────────
    const trendingTokens = await _fetchTrendingTokens();

    if (trendingTokens.length === 0) {
      logger.warn('[Helius] No trending tokens found — skipping');
      return [];
    }

    logger.info('[Helius] Trending tokens fetched', {
      count: trendingTokens.length,
      tokens: trendingTokens.slice(0, 5).map(t => t.symbol),
    });

    // ── Step 2: Find active traders for each trending token ──
    const walletActivity = new Map(); // walletAddr → { tokens, totalVolumeSOL, swapCount, lastSeen }

    for (const token of trendingTokens.slice(0, MAX_TRENDING)) {
      try {
        await _sleep(DELAY_BETWEEN);
        const swappers = await _getTokenSwappers(apiKey, token.address);

        for (const swapper of swappers) {
          if (!walletActivity.has(swapper.wallet)) {
            walletActivity.set(swapper.wallet, {
              tokens:         new Set(),
              totalVolumeSOL: 0,
              swapCount:      0,
              lastSeen:       null,
            });
          }
          const entry = walletActivity.get(swapper.wallet);
          entry.tokens.add(token.symbol || token.address.slice(0, 8));
          entry.totalVolumeSOL += swapper.volumeSOL;
          entry.swapCount += swapper.count;
          if (!entry.lastSeen || swapper.lastSeen > entry.lastSeen) {
            entry.lastSeen = swapper.lastSeen;
          }
        }
      } catch (err) {
        logger.debug('[Helius] Failed to scan token swappers', {
          token: token.symbol || token.address.slice(0, 8),
          error: err.message,
        });
      }
    }

    if (walletActivity.size === 0) {
      logger.warn('[Helius] No traders discovered from trending tokens');
      return [];
    }

    logger.info('[Helius] Whale wallets discovered', {
      uniqueWallets: walletActivity.size,
    });

    // ── Step 3: Rank wallets by activity and take top N ──────
    const rankedWallets = [...walletActivity.entries()]
      .filter(([, stats]) => stats.swapCount >= 2 && stats.totalVolumeSOL > 0.5)
      .sort((a, b) => b[1].swapCount - a[1].swapCount)
      .slice(0, MAX_WALLETS);

    // ── Step 4: Enrich top wallets with full swap history ────
    const candidates = [];

    for (const [walletAddr, discoveryStats] of rankedWallets) {
      try {
        await _sleep(DELAY_BETWEEN);
        const stats = await _enrichWallet(apiKey, walletAddr);

        candidates.push({
          address:          walletAddr,
          source:           'helius',
          pnl7dUSD:         stats.pnl7dUSD,
          pnl30dUSD:        0,
          winRatePct:       stats.winRatePct,
          totalTrades7d:    stats.trades7d,
          totalTrades30d:   0,
          tradesPerDay:     stats.tradesPerDay,
          avgHoldTimeMs:    stats.avgHoldMs,
          estimatedCapSOL:  stats.estCapSOL,
          topTokens:        [...new Set([...(stats.topTokens || []), ...discoveryStats.tokens])].slice(0, 5),
          lastActiveAt:     discoveryStats.lastSeen,
          smartMoneyLabel:  null,
          dataQuality:      stats.dataQuality,
        });
      } catch (err) {
        logger.debug('[Helius] Failed to enrich wallet', {
          address: walletAddr.slice(0, 8) + '...',
          error:   err.message,
        });
      }
    }

    logger.info('[Helius] Enrichment complete', {
      discovered: walletActivity.size,
      enriched:   candidates.length,
    });

    return candidates;

  } catch (err) {
    logger.warn('[Helius] getTopTraders failed — source will be skipped', {
      error: err.message,
    });
    return [];
  }
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — TRENDING TOKEN DISCOVERY (DexScreener)
// ────────────────────────────────────────────────────────────

/**
 * Fetch trending Solana tokens from DexScreener.
 * Free API, no key required.
 *
 * @returns {Promise<Array<{address: string, symbol: string}>>}
 * @private
 */
async function _fetchTrendingTokens() {
  try {
    // DexScreener token boosts = tokens with promoted visibility
    const response = await axios.get(`${DEXSCREENER_BASE}/token-boosts/top/v1`, {
      timeout: REQUEST_TIMEOUT,
    });

    const items = response.data || [];
    if (!Array.isArray(items)) return [];

    // Filter for Solana tokens only
    const solanaTokens = items
      .filter(item => item.chainId === 'solana' && item.tokenAddress)
      .map(item => ({
        address: item.tokenAddress,
        symbol:  item.description || item.tokenAddress.slice(0, 8),
      }))
      .slice(0, MAX_TRENDING * 2); // Get extras in case some fail

    if (solanaTokens.length > 0) return solanaTokens;

    // Fallback: try latest token profiles
    const fallback = await axios.get(`${DEXSCREENER_BASE}/token-profiles/latest/v1`, {
      timeout: REQUEST_TIMEOUT,
    });

    const fbItems = fallback.data || [];
    if (!Array.isArray(fbItems)) return [];

    return fbItems
      .filter(item => item.chainId === 'solana' && item.tokenAddress)
      .map(item => ({
        address: item.tokenAddress,
        symbol:  item.description || item.tokenAddress.slice(0, 8),
      }))
      .slice(0, MAX_TRENDING * 2);

  } catch (err) {
    logger.debug('[Helius] DexScreener trending fetch failed', { error: err.message });
    return [];
  }
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — TOKEN SWAPPER DISCOVERY (Helius)
// ────────────────────────────────────────────────────────────

/**
 * Find wallets that recently swapped a specific token.
 * Uses Helius parsed transaction history.
 *
 * @param {string} apiKey
 * @param {string} tokenMint
 * @returns {Promise<Array<{wallet: string, volumeSOL: number, count: number, lastSeen: Date}>>}
 * @private
 */
async function _getTokenSwappers(apiKey, tokenMint) {
  try {
    const response = await axios.get(
      `${HELIUS_BASE}/v0/addresses/${tokenMint}/transactions`, {
        params: {
          'api-key': apiKey,
          type:      'SWAP',
          limit:     100,
        },
        timeout: REQUEST_TIMEOUT,
      }
    );

    const txs = response.data || [];
    if (!Array.isArray(txs) || txs.length === 0) return [];

    // Extract unique wallets from swap transactions
    const walletMap = new Map();
    for (const tx of txs) {
      const wallet = tx.feePayer;
      if (!wallet || wallet === tokenMint) continue;

      // Calculate SOL volume from native transfers
      const solVolume = _extractSOLVolume(tx);

      if (!walletMap.has(wallet)) {
        walletMap.set(wallet, { wallet, volumeSOL: 0, count: 0, lastSeen: null });
      }
      const entry = walletMap.get(wallet);
      entry.count += 1;
      entry.volumeSOL += solVolume;
      const txTime = tx.timestamp ? new Date(tx.timestamp * 1000) : null;
      if (txTime && (!entry.lastSeen || txTime > entry.lastSeen)) {
        entry.lastSeen = txTime;
      }
    }

    // Return wallets sorted by swap count
    return [...walletMap.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

  } catch (err) {
    logger.debug('[Helius] Token swapper fetch failed', {
      token: tokenMint.slice(0, 8) + '...',
      error: err.message,
    });
    return [];
  }
}

/**
 * Extract total SOL volume from a parsed transaction.
 * @param {object} tx - Helius parsed transaction
 * @returns {number} SOL amount
 * @private
 */
function _extractSOLVolume(tx) {
  let totalSOL = 0;

  // From native transfers
  if (Array.isArray(tx.nativeTransfers)) {
    for (const nt of tx.nativeTransfers) {
      totalSOL += (nt.amount || 0) / 1e9; // lamports to SOL
    }
  }

  // From swap events
  if (tx.events?.swap) {
    const swap = tx.events.swap;
    if (swap.nativeInput?.amount) {
      totalSOL += swap.nativeInput.amount / 1e9;
    }
    if (swap.nativeOutput?.amount) {
      totalSOL += swap.nativeOutput.amount / 1e9;
    }
  }

  return totalSOL;
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — WALLET ENRICHMENT (Helius)
// ────────────────────────────────────────────────────────────

/**
 * Enrich a wallet with stats from its on-chain swap history.
 *
 * @param {string} apiKey
 * @param {string} address
 * @returns {Promise<object>}
 * @private
 */
async function _enrichWallet(apiKey, address) {
  const response = await axios.get(
    `${HELIUS_BASE}/v0/addresses/${address}/transactions`, {
      params: {
        'api-key': apiKey,
        type:      'SWAP',
        limit:     100,
      },
      timeout: REQUEST_TIMEOUT,
    }
  );

  const txs = response.data || [];
  if (!Array.isArray(txs) || txs.length === 0) {
    return _emptyStats();
  }

  return _calculateStats(txs, address);
}

/**
 * Calculate performance stats from Helius parsed swap transactions.
 *
 * @param {Array} txs - Helius parsed transactions
 * @param {string} walletAddr
 * @returns {object}
 * @private
 */
function _calculateStats(txs, walletAddr) {
  // Sort by timestamp ascending
  const sorted = [...txs]
    .filter(tx => tx.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (sorted.length === 0) return _emptyStats();

  // Track buys and pair with sells for PnL
  const buys = new Map(); // tokenMint → { timestamp, solAmount }
  const tokensSeen = new Map(); // tokenMint → count (for diversity tracking)
  let wins = 0;
  let losses = 0;
  let holdTimes = [];
  let solAmounts = [];
  let parsedSwaps = 0;

  for (const tx of sorted) {
    // Primary path: events.swap (Helius Enhanced format)
    const swap = tx.events?.swap;

    if (swap) {
      parsedSwaps++;
      const isBuy  = swap.nativeInput && swap.nativeInput.amount > 0;
      const isSell = swap.nativeOutput && swap.nativeOutput.amount > 0;

      if (isBuy) {
        const solSpent = swap.nativeInput.amount / 1e9;
        solAmounts.push(solSpent);
        const outputMint = swap.tokenOutputs?.[0]?.mint
          || swap.innerSwaps?.[0]?.tokenOutputs?.[0]?.mint;
        if (outputMint && outputMint !== SOL_MINT) {
          buys.set(outputMint, { timestamp: tx.timestamp, solAmount: solSpent });
          tokensSeen.set(outputMint, (tokensSeen.get(outputMint) || 0) + 1);
        }
      }

      if (isSell) {
        const solReceived = swap.nativeOutput.amount / 1e9;
        solAmounts.push(solReceived);
        const inputMint = swap.tokenInputs?.[0]?.mint
          || swap.innerSwaps?.[0]?.tokenInputs?.[0]?.mint;
        if (inputMint && inputMint !== SOL_MINT) {
          tokensSeen.set(inputMint, (tokensSeen.get(inputMint) || 0) + 1);
        }
        if (inputMint && inputMint !== SOL_MINT && buys.has(inputMint)) {
          const buy = buys.get(inputMint);
          const pnl = solReceived - buy.solAmount;
          if (pnl > 0) wins++;
          else losses++;
          if (tx.timestamp > buy.timestamp) {
            holdTimes.push((tx.timestamp - buy.timestamp) * 1000);
          }
          buys.delete(inputMint);
        }
      }
      continue;
    }

    // Fallback path: use nativeTransfers + tokenTransfers when events.swap is missing
    const nativeXfers = tx.nativeTransfers || [];
    const tokenXfers  = tx.tokenTransfers || [];
    if (nativeXfers.length === 0 && tokenXfers.length === 0) continue;
    parsedSwaps++;

    // Detect BUY: wallet sent SOL, received tokens
    const solSent = nativeXfers
      .filter(nt => nt.fromUserAccount === walletAddr)
      .reduce((sum, nt) => sum + (nt.amount || 0), 0) / 1e9;
    const solReceived = nativeXfers
      .filter(nt => nt.toUserAccount === walletAddr)
      .reduce((sum, nt) => sum + (nt.amount || 0), 0) / 1e9;
    const tokensReceived = tokenXfers
      .filter(tt => tt.toUserAccount === walletAddr && tt.mint !== SOL_MINT);
    const tokensSent = tokenXfers
      .filter(tt => tt.fromUserAccount === walletAddr && tt.mint !== SOL_MINT);

    if (solSent > 0.001 && tokensReceived.length > 0) {
      // BUY: SOL → Token
      solAmounts.push(solSent);
      const mint = tokensReceived[0].mint;
      if (mint) {
        buys.set(mint, { timestamp: tx.timestamp, solAmount: solSent });
        tokensSeen.set(mint, (tokensSeen.get(mint) || 0) + 1);
      }
    } else if (solReceived > 0.001 && tokensSent.length > 0) {
      // SELL: Token → SOL
      solAmounts.push(solReceived);
      const mint = tokensSent[0].mint;
      if (mint) tokensSeen.set(mint, (tokensSeen.get(mint) || 0) + 1);
      if (mint && buys.has(mint)) {
        const buy = buys.get(mint);
        const pnl = solReceived - buy.solAmount;
        if (pnl > 0) wins++;
        else losses++;
        if (tx.timestamp > buy.timestamp) {
          holdTimes.push((tx.timestamp - buy.timestamp) * 1000);
        }
        buys.delete(mint);
      }
    }
  }

  logger.debug('[Helius] Stats calculation', {
    wallet: walletAddr.slice(0, 8) + '...',
    totalTxs: sorted.length, parsedSwaps, wins, losses,
  });

  const total       = wins + losses;
  const winRatePct  = total > 0 ? (wins / total) * 100 : 0;
  const avgHoldMs   = holdTimes.length > 0
    ? holdTimes.reduce((s, t) => s + t, 0) / holdTimes.length
    : 0;

  // Estimate capital using 75th percentile (not max — avoids outlier inflation)
  let estCapSOL = 0;
  if (solAmounts.length > 0) {
    const sorted = [...solAmounts].sort((a, b) => a - b);
    const p75    = sorted[Math.floor(sorted.length * 0.75)] || sorted[sorted.length - 1];
    estCapSOL    = Math.min(p75 * 5, 500); // Conservative: cap at 500 SOL
  }

  // Trades in last 7 days (filter to actual 7d window)
  const now7dAgo     = Math.floor(Date.now() / 1000) - (7 * 86400);
  const trades7dOnly = sorted.filter(tx => tx.timestamp >= now7dAgo);
  const trades7dCount = trades7dOnly.length;
  const tradesPerDay  = parseFloat((trades7dCount / 7).toFixed(1));

// 7d PnL: use matched buy/sell pairs only (accurate)
  // Re-run a clean pass using the same pairing logic
  const buysForPnl = new Map();
  let pnlSOL = 0;
  for (const tx of sorted.filter(t => t.timestamp >= now7dAgo)) {
    const swap = tx.events?.swap;
    if (!swap) continue;
    if (swap.nativeInput?.amount) {
      const outputMint = swap.tokenOutputs?.[0]?.mint
        || swap.innerSwaps?.[0]?.tokenOutputs?.[0]?.mint;
      if (outputMint && outputMint !== SOL_MINT) {
        buysForPnl.set(outputMint, swap.nativeInput.amount / 1e9);
      }
    }
    if (swap.nativeOutput?.amount) {
      const inputMint = swap.tokenInputs?.[0]?.mint
        || swap.innerSwaps?.[0]?.tokenInputs?.[0]?.mint;
      if (inputMint && inputMint !== SOL_MINT && buysForPnl.has(inputMint)) {
        pnlSOL += (swap.nativeOutput.amount / 1e9) - buysForPnl.get(inputMint);
        buysForPnl.delete(inputMint);
      }
    }
  }
  const pnl7dUSD = parseFloat((pnlSOL * 150).toFixed(2));

  // Top tokens by frequency (for diversity scoring)
  const topTokens = [...tokensSeen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([mint]) => mint);

  // Data quality score
  let quality = 40; // Base: we have first-party on-chain data
  if (total > 5)      quality += 20;
  if (winRatePct > 0)  quality += 15;
  if (estCapSOL > 1)   quality += 15;
  if (sorted.length > 20) quality += 10;

  return {
    winRatePct:   parseFloat(winRatePct.toFixed(2)),
    trades7d:     trades7dCount,
    tradesPerDay,
    avgHoldMs:    Math.round(avgHoldMs),
    estCapSOL:    parseFloat(estCapSOL.toFixed(2)),
    pnl7dUSD:     parseFloat(pnl7dUSD.toFixed(2)),
    topTokens,
    dataQuality:  Math.min(100, quality),
  };
}

function _emptyStats() {
  return {
    winRatePct:   0,
    trades7d:     0,
    tradesPerDay: 0,
    avgHoldMs:    0,
    estCapSOL:    0,
    pnl7dUSD:     0,
    topTokens:    [],
    dataQuality:  0,
  };
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  getTopTraders,
};
