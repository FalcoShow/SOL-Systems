// ============================================================
//  SOL SYSTEMS — Risk Manager
//  File: src/execution/riskManager.js
//
//  Every safety guardrail in one place.
//  Called by tradeExecutor.js BEFORE every trade is sent
//  to Jupiter. If any check fails, the trade is blocked.
//
//  Checks performed on every BUY:
//    1.  Trading paused?              → block
//    2.  Max open positions hit?      → block
//    3.  Daily loss limit hit?        → block + alert
//    4.  Insufficient SOL balance?    → reduce or block
//    5.  Position size too small?     → block
//    6.  Token blacklisted?           → block
//    7.  Price impact too high?       → block
//    8.  Token liquidity too low?     → block (rug protection)
//    9.  Token age too new?           → warn or block
//   10.  Honeypot check?             → block
//
//  Additional standalone checks:
//    - checkDailyLossLimit()          → called by scheduler
//    - isTokenSafe()                  → called before any trade
//    - getTokenLiquidity()            → liquidity fetch
// ============================================================

'use strict';

const axios   = require('axios');
const config  = require('../config');
const logger  = require('../utils/logger');
const { shortenAddress } = require('../utils/solana');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

// Minimum liquidity a token pool must have before we trade it
// Below this = too easy to rug pull or manipulate price
const MIN_LIQUIDITY_USD = 10000; // $10,000 minimum pool liquidity

// Minimum token age in seconds before we trade it
// Tokens under 60 seconds old are almost certainly pump-and-dumps
const MIN_TOKEN_AGE_SECONDS = 60;

// Maximum % of pool liquidity we should represent with one trade
// If our trade is > 1% of the pool, we'll move the price significantly
const MAX_POOL_OWNERSHIP_PCT = 1.0;

// Minimum SOL amount for a trade to be worth executing
// Below this the gas fees eat too much of the return
const MIN_VIABLE_TRADE_SOL = 0.01;

// Token blacklist — mints we will NEVER trade regardless of signals
// Add known scam tokens or tokens you want to avoid here
const TOKEN_BLACKLIST = new Set([
  // Add known scam mint addresses here
  // e.g. 'ScamTokenMintAddress123...',
]);

// Birdeye API for liquidity + token safety data
const BIRDEYE_BASE = 'https://public-api.birdeye.so';

// ────────────────────────────────────────────────────────────
//  MAIN BUY CHECK
//  Called by tradeExecutor before every copy BUY
// ────────────────────────────────────────────────────────────

/**
 * Run all risk checks for a proposed BUY trade.
 * Returns approved/rejected with a specific reason.
 *
 * @param {object} params
 * @param {number} params.proposedPositionSOL - Scaled position size
 * @param {object} params.settings            - Current settings from DB
 * @param {object} params.context             - Runtime context
 * @param {number} params.context.currentSOLBalance   - Live wallet balance
 * @param {number} params.context.openPositionsCount  - Current open positions
 * @param {number} params.context.todayLossSOL        - Today's running loss
 * @param {string} params.tokenMint           - Token we'd be buying
 *
 * @returns {{
 *   approved: boolean,
 *   finalPositionSOL: number,
 *   skipReason: string|null,
 *   warnings: string[]
 * }}
 */
function checkBuy({ proposedPositionSOL, settings, context, tokenMint }) {
  const warnings = [];

  const {
    currentSOLBalance  = 0,
    openPositionsCount = 0,
    todayLossSOL       = 0,
  } = context;

  const {
    isTradingPaused    = false,
    pauseReason        = null,
    maxOpenPositions   = 10,
    minSolReserve      = 0.1,
    dailyLossLimitSOL  = 0,
  } = settings;

  // ── Check 1: Trading paused ──────────────────────────────
  if (isTradingPaused) {
    return _reject(`Trading is paused${pauseReason ? ': ' + pauseReason : ''}`, warnings);
  }

  // ── Check 2: Max open positions ──────────────────────────
  if (openPositionsCount >= maxOpenPositions) {
    return _reject(
      `Max open positions reached (${openPositionsCount}/${maxOpenPositions})`,
      warnings
    );
  }

  // ── Check 3: Daily loss limit ────────────────────────────
  if (dailyLossLimitSOL > 0) {
    const lossAbs = Math.abs(todayLossSOL);
    if (lossAbs >= dailyLossLimitSOL) {
      return _reject(
        `Daily loss limit hit — lost ${lossAbs.toFixed(4)} SOL today (limit: ${dailyLossLimitSOL} SOL)`,
        warnings
      );
    }

    // Warn if approaching limit
    if (lossAbs >= dailyLossLimitSOL * 0.80) {
      warnings.push(
        `Approaching daily loss limit: ${lossAbs.toFixed(4)}/${dailyLossLimitSOL} SOL (80%)`
      );
    }
  }

  // ── Check 4: SOL balance sufficient ─────────────────────
  const availableSOL   = currentSOLBalance - minSolReserve;
  const requiredSOL    = proposedPositionSOL;

  if (availableSOL <= 0) {
    return _reject(
      `Insufficient SOL — balance ${currentSOLBalance.toFixed(4)} SOL is at or below reserve (${minSolReserve} SOL)`,
      warnings
    );
  }

  let finalPositionSOL = proposedPositionSOL;

  if (requiredSOL > availableSOL) {
    // Reduce position to what we can actually afford
    finalPositionSOL = availableSOL;
    warnings.push(
      `Position reduced from ${proposedPositionSOL.toFixed(4)} to ${finalPositionSOL.toFixed(4)} SOL (insufficient balance)`
    );
  }

  // ── Check 5: Minimum viable trade size ──────────────────
  if (finalPositionSOL < MIN_VIABLE_TRADE_SOL) {
    return _reject(
      `Position too small to execute — ${finalPositionSOL.toFixed(6)} SOL < ${MIN_VIABLE_TRADE_SOL} SOL minimum`,
      warnings
    );
  }

  // ── Check 6: Token blacklist ─────────────────────────────
  if (tokenMint && TOKEN_BLACKLIST.has(tokenMint)) {
    return _reject(`Token is blacklisted: ${shortenAddress(tokenMint)}`, warnings);
  }

  // All synchronous checks passed
  return _approve(finalPositionSOL, warnings);
}

// ────────────────────────────────────────────────────────────
//  TOKEN SAFETY CHECK
//  Async checks that require external API calls.
//  Called separately from checkBuy() since they take ~200-500ms.
//  tradeExecutor runs this in parallel with other setup steps.
// ────────────────────────────────────────────────────────────

/**
 * Run async token safety checks.
 * Should be called BEFORE checkBuy() in the execution pipeline
 * so results are ready when needed.
 *
 * @param {string} tokenMint      - Token mint address to check
 * @param {number} tradeAmountSOL - How much SOL we plan to spend
 * @param {number} solPriceUSD    - Current SOL/USD price
 *
 * @returns {Promise<TokenSafetyResult>}
 */
async function checkTokenSafety(tokenMint, tradeAmountSOL = 0, solPriceUSD = 0) {
  const result = {
    safe:       true,
    warnings:   [],
    blockReason: null,
    liquidity:  null,
    tokenAge:   null,
  };

  try {
    // Run safety checks in parallel for speed
    const [liquidityData, tokenInfo] = await Promise.allSettled([
      getTokenLiquidity(tokenMint),
      getTokenInfo(tokenMint),
    ]);

    // ── Liquidity check ──────────────────────────────────
    if (liquidityData.status === 'fulfilled' && liquidityData.value) {
      const liquidity = liquidityData.value;
      result.liquidity = liquidity.liquidityUSD;

      if (liquidity.liquidityUSD < MIN_LIQUIDITY_USD) {
        result.safe        = false;
        result.blockReason = `Liquidity too low — $${liquidity.liquidityUSD.toFixed(0)} < $${MIN_LIQUIDITY_USD.toLocaleString()} minimum`;
        logger.warn('Token failed liquidity check', {
          mint:        shortenAddress(tokenMint),
          liquidity:   `$${liquidity.liquidityUSD.toFixed(0)}`,
          minimum:     `$${MIN_LIQUIDITY_USD.toLocaleString()}`,
        });
        return result; // Early exit — definitely not safe
      }

      // Warn if our trade is a large % of pool
      const tradeAmountUSD  = tradeAmountSOL * solPriceUSD;
      const poolOwnershipPct = (tradeAmountUSD / liquidity.liquidityUSD) * 100;

      if (poolOwnershipPct > MAX_POOL_OWNERSHIP_PCT) {
        result.warnings.push(
          `Trade is ${poolOwnershipPct.toFixed(1)}% of pool — expect high slippage`
        );
        logger.warn('Trade represents large % of pool liquidity', {
          mint:          shortenAddress(tokenMint),
          tradeUSD:      `$${tradeAmountUSD.toFixed(0)}`,
          poolUSD:       `$${liquidity.liquidityUSD.toFixed(0)}`,
          ownershipPct:  poolOwnershipPct.toFixed(1) + '%',
        });
      }
    } else {
      // Could not fetch liquidity — warn but don't block
      result.warnings.push('Could not verify token liquidity');
      logger.debug('Liquidity check unavailable', {
        mint:  shortenAddress(tokenMint),
        error: liquidityData.reason?.message,
      });
    }

    // ── Token age check ─────────────────────────────────
    if (tokenInfo.status === 'fulfilled' && tokenInfo.value) {
      const info    = tokenInfo.value;
      result.tokenAge = info.createdAt;

      if (info.createdAt) {
        const ageSeconds = (Date.now() - new Date(info.createdAt).getTime()) / 1000;

        if (ageSeconds < MIN_TOKEN_AGE_SECONDS) {
          result.safe        = false;
          result.blockReason = `Token is only ${ageSeconds.toFixed(0)}s old — too new to trade safely`;
          logger.warn('Token failed age check', {
            mint:       shortenAddress(tokenMint),
            ageSec:     ageSeconds.toFixed(0),
            minimumSec: MIN_TOKEN_AGE_SECONDS,
          });
          return result;
        }

        // Warn if under 5 minutes old
        if (ageSeconds < 300) {
          result.warnings.push(`Token is only ${(ageSeconds / 60).toFixed(1)} minutes old — high risk`);
        }
      }

      // ── Honeypot / transfer-tax check ─────────────────
      if (info.buyTax !== undefined && info.sellTax !== undefined) {
        const totalTax = info.buyTax + info.sellTax;

        if (info.sellTax > 10) {
          result.safe        = false;
          result.blockReason = `Sell tax too high: ${info.sellTax}% — likely honeypot`;
          logger.warn('Token failed sell tax check', {
            mint:     shortenAddress(tokenMint),
            sellTax:  info.sellTax + '%',
          });
          return result;
        }

        if (totalTax > 5) {
          result.warnings.push(`High transfer tax: ${totalTax}% total (buy: ${info.buyTax}%, sell: ${info.sellTax}%)`);
        }
      }

      // ── Top holder concentration check ────────────────
      // If top 10 holders own > 80% of supply, rug risk is high
      if (info.top10HolderPct !== undefined && info.top10HolderPct > 80) {
        result.warnings.push(
          `Top 10 holders own ${info.top10HolderPct.toFixed(1)}% of supply — rug risk`
        );
        logger.warn('High holder concentration detected', {
          mint:           shortenAddress(tokenMint),
          top10HolderPct: info.top10HolderPct.toFixed(1) + '%',
        });
      }
    }

  } catch (err) {
    // Safety checks failed — log but don't block
    // We don't want an API outage to stop all trading
    result.warnings.push(`Safety check error: ${err.message}`);
    logger.error('Token safety check threw unexpected error', {
      mint:  shortenAddress(tokenMint),
      error: err.message,
    });
  }

  if (result.warnings.length > 0) {
    logger.warn('Token safety warnings', {
      mint:     shortenAddress(tokenMint),
      warnings: result.warnings,
    });
  }

  return result;
}

// ────────────────────────────────────────────────────────────
//  DAILY LOSS LIMIT CHECK
//  Called by positionSyncJob on a schedule
// ────────────────────────────────────────────────────────────

/**
 * Check if today's losses have hit the configured limit.
 * If yes, pauses trading and sends an alert.
 *
 * @param {number} todayLossSOL - Today's total realized loss in SOL
 * @param {object} settings     - Current settings from DB
 * @returns {{ limitHit: boolean, message: string }}
 */
function checkDailyLossLimit(todayLossSOL, settings) {
  const { dailyLossLimitSOL = 0 } = settings;

  if (dailyLossLimitSOL <= 0) {
    return { limitHit: false, message: 'Daily loss limit disabled' };
  }

  const lossAbs = Math.abs(Math.min(todayLossSOL, 0));

  if (lossAbs >= dailyLossLimitSOL) {
    const message = `🚨 Daily loss limit hit: ${lossAbs.toFixed(4)} SOL lost today (limit: ${dailyLossLimitSOL} SOL). Trading paused automatically.`;

    logger.error('DAILY LOSS LIMIT HIT — pausing all trading', {
      todayLoss:  lossAbs.toFixed(4) + ' SOL',
      limit:      dailyLossLimitSOL + ' SOL',
    });

    return { limitHit: true, message };
  }

  const pct = (lossAbs / dailyLossLimitSOL) * 100;
  return {
    limitHit: false,
    message:  `Daily loss: ${lossAbs.toFixed(4)} SOL (${pct.toFixed(1)}% of ${dailyLossLimitSOL} SOL limit)`,
  };
}

// ────────────────────────────────────────────────────────────
//  EXTERNAL DATA FETCHERS
// ────────────────────────────────────────────────────────────

/**
 * Fetch token pool liquidity from Birdeye API.
 *
 * @param {string} tokenMint
 * @returns {Promise<{liquidityUSD: number}>}
 */
async function getTokenLiquidity(tokenMint) {
  try {
    const headers = config.prices.birdeyeApiKey
      ? { 'X-API-KEY': config.prices.birdeyeApiKey }
      : {};

    const response = await axios.get(
      `${BIRDEYE_BASE}/defi/token_overview`,
      {
        params:  { address: tokenMint },
        headers: { ...headers, 'x-chain': 'solana' },
        timeout: 5000,
      }
    );

    const data = response.data?.data;
    if (!data) return { liquidityUSD: 0 };

    return {
      liquidityUSD: data.liquidity || data.liquidityUSD || 0,
      volume24h:    data.v24hUSD   || 0,
      priceUSD:     data.price     || 0,
    };

  } catch (err) {
    logger.debug('Birdeye liquidity fetch failed', {
      mint:  shortenAddress(tokenMint),
      error: err.message,
    });
    return { liquidityUSD: 0 };
  }
}

/**
 * Fetch detailed token information including transfer taxes
 * and holder distribution.
 *
 * @param {string} tokenMint
 * @returns {Promise<object>}
 */
async function getTokenInfo(tokenMint) {
  try {
    const headers = config.prices.birdeyeApiKey
      ? { 'X-API-KEY': config.prices.birdeyeApiKey }
      : {};

    const response = await axios.get(
      `${BIRDEYE_BASE}/defi/token_security`,
      {
        params:  { address: tokenMint },
        headers: { ...headers, 'x-chain': 'solana' },
        timeout: 5000,
      }
    );

    const data = response.data?.data;
    if (!data) return {};

    return {
      createdAt:       data.creationTime ? new Date(data.creationTime * 1000) : null,
      buyTax:          data.buyTax       || 0,
      sellTax:         data.sellTax      || 0,
      top10HolderPct:  data.top10HolderPercent || null,
      isHoneypot:      data.isHoneypot   || false,
      mintAuthority:   data.mintAuthority || null,
      freezeAuthority: data.freezeAuthority || null,
    };

  } catch (err) {
    logger.debug('Birdeye token info fetch failed', {
      mint:  shortenAddress(tokenMint),
      error: err.message,
    });
    return {};
  }
}

// ────────────────────────────────────────────────────────────
//  TOKEN BLACKLIST MANAGEMENT
// ────────────────────────────────────────────────────────────

/**
 * Add a token mint to the runtime blacklist.
 * Takes effect immediately for all future trades.
 *
 * @param {string} tokenMint
 */
function blacklistToken(tokenMint) {
  TOKEN_BLACKLIST.add(tokenMint);
  logger.warn('Token added to blacklist', { mint: shortenAddress(tokenMint) });
}

/**
 * Remove a token from the runtime blacklist.
 *
 * @param {string} tokenMint
 */
function removeFromBlacklist(tokenMint) {
  TOKEN_BLACKLIST.delete(tokenMint);
  logger.info('Token removed from blacklist', { mint: shortenAddress(tokenMint) });
}

/**
 * Get the current blacklist.
 * @returns {string[]}
 */
function getBlacklist() {
  return Array.from(TOKEN_BLACKLIST);
}

// ────────────────────────────────────────────────────────────
//  POSITION SIZE VALIDATION
//  Standalone check used by the dashboard preview feature
// ────────────────────────────────────────────────────────────

/**
 * Validate a proposed position size against all configured limits.
 * Returns a breakdown of how each limit applies.
 * Used by the dashboard "preview trade" feature.
 *
 * @param {number} proposedSOL   - SOL amount to validate
 * @param {object} settings      - Current settings
 * @param {number} currentBalance - Current wallet SOL balance
 * @returns {object}
 */
function validatePositionSize(proposedSOL, settings, currentBalance) {
  const {
    myCapitalSOL     = 10,
    maxPositionPct   = 0.10,
    minSolReserve    = 0.10,
  } = settings;

  const maxAllowed   = myCapitalSOL * maxPositionPct;
  const available    = currentBalance - minSolReserve;
  const effectiveMax = Math.min(maxAllowed, available);

  return {
    proposedSOL,
    maxAllowedByPct:    parseFloat(maxAllowed.toFixed(4)),
    availableAfterReserve: parseFloat(available.toFixed(4)),
    effectiveMax:       parseFloat(effectiveMax.toFixed(4)),
    wouldBeCapped:      proposedSOL > effectiveMax,
    finalPositionSOL:   parseFloat(Math.min(proposedSOL, effectiveMax).toFixed(4)),
    isViable:           Math.min(proposedSOL, effectiveMax) >= MIN_VIABLE_TRADE_SOL,
    positionPct:        parseFloat(((proposedSOL / myCapitalSOL) * 100).toFixed(2)),
  };
}

// ────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ────────────────────────────────────────────────────────────

/** Build an approved result. @private */
function _approve(finalPositionSOL, warnings = []) {
  return {
    approved:        true,
    finalPositionSOL: parseFloat(finalPositionSOL.toFixed(9)),
    skipReason:      null,
    warnings,
  };
}

/** Build a rejected result. @private */
function _reject(reason, warnings = []) {
  logger.warn('Risk check rejected trade', { reason, warnings });
  return {
    approved:         false,
    finalPositionSOL: 0,
    skipReason:       reason,
    warnings,
  };
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  // Primary checks
  checkBuy,
  checkTokenSafety,
  checkDailyLossLimit,

  // Token data
  getTokenLiquidity,
  getTokenInfo,

  // Blacklist management
  blacklistToken,
  removeFromBlacklist,
  getBlacklist,

  // Utilities
  validatePositionSize,

  // Constants (exported for tests + dashboard)
  MIN_LIQUIDITY_USD,
  MIN_TOKEN_AGE_SECONDS,
  MIN_VIABLE_TRADE_SOL,
};