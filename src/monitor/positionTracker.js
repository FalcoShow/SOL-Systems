// ============================================================
//  SOL SYSTEMS — Position Tracker
//  File: src/monitor/positionTracker.js
//
//  In-memory state engine that tracks every open position
//  across ALL tracked wallets simultaneously.
//
//  Answers critical questions in real-time:
//    - Is Cented currently holding WIF? (prevents duplicate entry)
//    - What was his entry price for WIF? (needed to calc his PnL%)
//    - Are WE currently in a position for WIF? (prevents double buy)
//    - What is our current unrealized PnL on open positions?
//
//  Two parallel position maps:
//    1. _trackedPositions  : what the COPIED wallets currently hold
//    2. _myPositions       : what OUR wallet currently holds
//
//  Both maps are keyed by: walletAddress:tokenMint
//
//  State is rebuilt from the database on startup so positions
//  survive bot restarts. Then kept in-memory for zero-latency
//  lookups during live trading.
// ============================================================

'use strict';

const { EventEmitter } = require('events');
const logger           = require('../utils/logger');
const { shortenAddress, getSOLPrice } = require('../utils/solana');

// ────────────────────────────────────────────────────────────
//  POSITION OBJECT SHAPE
//
//  {
//    walletAddress:  string,   // whose position (tracked or ours)
//    tokenMint:      string,   // SPL token mint address
//    tokenSymbol:    string,   // e.g. "WIF"
//    tokenName:      string,   // e.g. "dogwifhat"
//    tradeId:        string,   // DB trade ID for our position
//    entryPriceSOL:  number,   // price per token at entry
//    entryPriceUSD:  number,
//    entryAmountSOL: number,   // SOL committed
//    entryTokens:    number,   // tokens received
//    entryTime:      Date,
//    currentPriceSOL: number,  // updated by price job
//    currentPriceUSD: number,
//    unrealizedPnLSOL: number,
//    unrealizedPnLPct: number,
//    lastUpdated:    Date,
//  }
// ────────────────────────────────────────────────────────────

class PositionTracker extends EventEmitter {
  constructor() {
    super();

    // Tracked wallet positions: "walletAddress:tokenMint" → Position
    this._trackedPositions = new Map();

    // Our copy positions: "MY_WALLET:tokenMint" → Position
    this._myPositions = new Map();

    // Index: tokenMint → Set of walletAddresses holding it
    // Lets us instantly find all wallets in a given token
    this._tokenIndex = new Map();

    // Stats
    this._stats = {
      totalOpened:  0,
      totalClosed:  0,
      peakOpen:     0,
    };
  }

  // ──────────────────────────────────────────────────────────
  //  INITIALIZATION
  //  Rebuild state from database on startup
  // ──────────────────────────────────────────────────────────

  /**
   * Load open positions from the database into memory.
   * Called once during app startup so we recover after restarts.
   *
   * @param {Array} openTrades - Open Trade records from database
   */
  loadFromDatabase(openTrades = []) {
    logger.info('Loading open positions from database', {
      count: openTrades.length,
    });

    for (const trade of openTrades) {
      if (trade.tradeType !== 'BUY' || !trade.isOpen) continue;

      // Restore our position
      const restoredEntryPrice = trade.executedPriceSOL || trade.requestedPriceSOL || 0;
      const restoredEntrySOL   = trade.executedAmountSOL || trade.requestedAmountSOL || 0;
      // Derive entryTokens from cost/price when DB value is missing —
      // without this, unrealized PnL shows -100% and triggers stop-loss
      const restoredEntryTokens = trade.amountTokens > 0
        ? trade.amountTokens
        : (restoredEntryPrice > 0 ? restoredEntrySOL / restoredEntryPrice : 0);

      const myPosition = {
        walletAddress:    'MY_WALLET',
        tokenMint:        trade.tokenMint,
        tokenSymbol:      trade.tokenSymbol || '???',
        tokenName:        trade.tokenName   || 'Unknown',
        tradeId:          trade.id,
        entryPriceSOL:    restoredEntryPrice,
        entryPriceUSD:    trade.executedPriceUSD  || 0,
        entryAmountSOL:   restoredEntrySOL,
        entryTokens:      restoredEntryTokens,
        entryTime:        trade.confirmedAt        || trade.createdAt,
        currentPriceSOL:  trade.executedPriceSOL  || 0,
        currentPriceUSD:  trade.executedPriceUSD  || 0,
        unrealizedPnLSOL: 0,
        unrealizedPnLPct: 0,
        lastUpdated:      new Date(),
        source:           'database-restore',
      };

      this._setMyPosition(trade.tokenMint, myPosition);

      // Restore tracked wallet position if we have the data
      if (trade.trackedWallet?.address) {
        const trackedPosition = {
          walletAddress:    trade.trackedWallet.address,
          tokenMint:        trade.tokenMint,
          tokenSymbol:      trade.tokenSymbol || '???',
          tokenName:        trade.tokenName   || 'Unknown',
          tradeId:          null,
          entryPriceSOL:    trade.requestedPriceSOL || 0,
          entryPriceUSD:    0,
          entryAmountSOL:   trade.trackedCapitalSOL || 0,
          entryTokens:      0,
          entryTime:        trade.detectedAt || trade.createdAt,
          currentPriceSOL:  0,
          currentPriceUSD:  0,
          unrealizedPnLSOL: 0,
          unrealizedPnLPct: 0,
          lastUpdated:      new Date(),
          source:           'database-restore',
        };
        this._setTrackedPosition(trade.trackedWallet.address, trade.tokenMint, trackedPosition);
      }
    }

    const myCount      = this._myPositions.size;
    const trackedCount = this._trackedPositions.size;

    logger.info('Positions loaded from database', {
      myOpenPositions:      myCount,
      trackedOpenPositions: trackedCount,
    });

    if (myCount > 0) {
      this._stats.peakOpen = Math.max(this._stats.peakOpen, myCount);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  TRACKED WALLET POSITION MANAGEMENT
  //  Track what the COPIED wallets currently hold
  // ──────────────────────────────────────────────────────────

  /**
   * Record that a tracked wallet entered a position (BUY detected).
   *
   * @param {string} walletAddress
   * @param {object} swapData - Parsed swap from transactionParser
   */
  openTrackedPosition(walletAddress, swapData) {
    const key = this._trackedKey(walletAddress, swapData.tokenMint);

    // If they're already in this position, update rather than duplicate
    if (this._trackedPositions.has(key)) {
      logger.debug('Tracked wallet adding to existing position', {
        wallet: shortenAddress(walletAddress),
        token:  swapData.tokenSymbol,
      });
      return this._addToTrackedPosition(walletAddress, swapData);
    }

    const position = {
      walletAddress,
      tokenMint:        swapData.tokenMint,
      tokenSymbol:      swapData.tokenSymbol || '???',
      tokenName:        swapData.tokenName   || 'Unknown',
      tradeId:          null,
      entryPriceSOL:    swapData.pricePerTokenSOL,
      entryPriceUSD:    swapData.pricePerTokenUSD || 0,
      entryAmountSOL:   swapData.amountSOL,
      entryTokens:      swapData.amountTokens,
      entryTime:        swapData.blockTime || new Date(),
      currentPriceSOL:  swapData.pricePerTokenSOL,
      currentPriceUSD:  swapData.pricePerTokenUSD || 0,
      unrealizedPnLSOL: 0,
      unrealizedPnLPct: 0,
      lastUpdated:      new Date(),
      source:           'live',
    };

    this._setTrackedPosition(walletAddress, swapData.tokenMint, position);
    this._updateTokenIndex(walletAddress, swapData.tokenMint, 'add');

    logger.debug('Tracked position opened', {
      wallet:    shortenAddress(walletAddress),
      token:     swapData.tokenSymbol,
      amountSOL: swapData.amountSOL?.toFixed(4),
      price:     swapData.pricePerTokenSOL?.toFixed(8),
    });

    this.emit('trackedPositionOpened', { walletAddress, position });
    return position;
  }

  /**
   * Record that a tracked wallet exited a position (SELL detected).
   * Returns the closed position with PnL calculated.
   *
   * @param {string} walletAddress
   * @param {object} swapData - Parsed swap from transactionParser
   * @returns {object|null} Closed position with PnL data, or null if not found
   */
  closeTrackedPosition(walletAddress, swapData) {
    const key      = this._trackedKey(walletAddress, swapData.tokenMint);
    const position = this._trackedPositions.get(key);

    if (!position) {
      // They sold a token we didn't see them buy
      // Common if they entered before we started monitoring
      logger.debug('Tracked wallet closed position we never saw open', {
        wallet: shortenAddress(walletAddress),
        token:  swapData.tokenSymbol,
      });
      return null;
    }

    // Calculate their PnL
    const exitPriceSOL   = swapData.pricePerTokenSOL;
    const entryPriceSOL  = position.entryPriceSOL;
    const pnlPct = entryPriceSOL > 0
      ? ((exitPriceSOL - entryPriceSOL) / entryPriceSOL) * 100
      : 0;

    const pnlSOL = swapData.amountSOL - position.entryAmountSOL;
    const isWin  = pnlSOL >= 0;

    const closedPosition = {
      ...position,
      exitPriceSOL:  exitPriceSOL,
      exitPriceUSD:  swapData.pricePerTokenUSD || 0,
      exitAmountSOL: swapData.amountSOL,
      exitTime:      swapData.blockTime || new Date(),
      pnlSOL,
      pnlPct,
      isWin,
      holdTimeMs: new Date() - position.entryTime,
    };

    // Remove from active positions
    this._trackedPositions.delete(key);
    this._updateTokenIndex(walletAddress, swapData.tokenMint, 'remove');

    this._stats.totalClosed++;

    logger.debug('Tracked position closed', {
      wallet:  shortenAddress(walletAddress),
      token:   swapData.tokenSymbol,
      pnlPct:  pnlPct.toFixed(2) + '%',
      isWin,
    });

    this.emit('trackedPositionClosed', { walletAddress, position: closedPosition });
    return closedPosition;
  }

  // ──────────────────────────────────────────────────────────
  //  MY POSITION MANAGEMENT
  //  Track what OUR wallet currently holds
  // ──────────────────────────────────────────────────────────

  /**
   * Record that we entered a copy position (our BUY confirmed).
   *
   * @param {string} tokenMint
   * @param {object} tradeData - Our confirmed trade data
   */
  openMyPosition(tokenMint, tradeData) {
    const existing = this._myPositions.get(tokenMint);

    if (existing) {
      logger.warn('Attempted to open duplicate position', {
        token:  tradeData.tokenSymbol,
        existing: existing.tradeId,
      });
      return existing;
    }

    const position = {
      walletAddress:    'MY_WALLET',
      tokenMint,
      tokenSymbol:      tradeData.tokenSymbol  || '???',
      tokenName:        tradeData.tokenName    || 'Unknown',
      tradeId:          tradeData.id,
      entryPriceSOL:    tradeData.executedPriceSOL  || tradeData.requestedPriceSOL || 0,
      entryPriceUSD:    tradeData.executedPriceUSD  || 0,
      entryAmountSOL:   tradeData.executedAmountSOL || tradeData.requestedAmountSOL,
      entryTokens:      tradeData.amountTokens || 0,
      entryTime:        tradeData.confirmedAt  || new Date(),
      currentPriceSOL:  tradeData.executedPriceSOL  || 0,
      currentPriceUSD:  tradeData.executedPriceUSD  || 0,
      unrealizedPnLSOL: 0,
      unrealizedPnLPct: 0,
      lastUpdated:      new Date(),
      source:           'live',
    };

    this._myPositions.set(tokenMint, position);
    this._stats.totalOpened++;
    this._stats.peakOpen = Math.max(this._stats.peakOpen, this._myPositions.size);

    logger.info('Our position opened', {
      token:     position.tokenSymbol,
      amountSOL: position.entryAmountSOL.toFixed(4),
      price:     position.entryPriceSOL.toFixed(8),
      tradeId:   position.tradeId,
    });

    this.emit('myPositionOpened', { position });
    return position;
  }

  /**
   * Record that we closed a copy position (our SELL confirmed).
   * Returns closed position with final PnL.
   *
   * @param {string} tokenMint
   * @param {object} tradeData - Our confirmed sell trade data
   * @returns {object|null}
   */
  closeMyPosition(tokenMint, tradeData) {
    const position = this._myPositions.get(tokenMint);

    if (!position) {
      logger.warn('Attempted to close position that is not open', {
        token: tradeData.tokenSymbol || shortenAddress(tokenMint),
      });
      return null;
    }

    const exitPriceSOL  = tradeData.executedPriceSOL || 0;
    const exitAmountSOL = tradeData.executedAmountSOL || 0;
    const entryAmountSOL = position.entryAmountSOL;

    const pnlSOL = exitAmountSOL - entryAmountSOL;
    const pnlPct = entryAmountSOL > 0
      ? (pnlSOL / entryAmountSOL) * 100
      : 0;

    const closedPosition = {
      ...position,
      exitPriceSOL,
      exitPriceUSD:  tradeData.executedPriceUSD || 0,
      exitAmountSOL,
      exitTime:      tradeData.confirmedAt || new Date(),
      pnlSOL,
      pnlPct,
      isWin:         pnlSOL >= 0,
      holdTimeMs:    new Date() - position.entryTime,
    };

    this._myPositions.delete(tokenMint);
    this._stats.totalClosed++;

    const sign = pnlSOL >= 0 ? '+' : '';
    logger.info('Our position closed', {
      token:   position.tokenSymbol,
      pnlSOL:  `${sign}${pnlSOL.toFixed(4)} SOL`,
      pnlPct:  `${sign}${pnlPct.toFixed(2)}%`,
      isWin:   pnlSOL >= 0,
    });

    this.emit('myPositionClosed', { position: closedPosition });
    return closedPosition;
  }

  // ──────────────────────────────────────────────────────────
  //  QUERIES
  //  Fast in-memory lookups used constantly during trade flow
  // ──────────────────────────────────────────────────────────

  /**
   * Check if a tracked wallet is currently in a position for a token.
   * Used to detect ENTRY (first time buying) vs adding to position.
   *
   * @param {string} walletAddress
   * @param {string} tokenMint
   * @returns {boolean}
   */
  isTrackedWalletInPosition(walletAddress, tokenMint) {
    return this._trackedPositions.has(this._trackedKey(walletAddress, tokenMint));
  }

  /**
   * Check if WE are currently in a position for a token.
   * Prevents double-buying the same token.
   *
   * @param {string} tokenMint
   * @returns {boolean}
   */
  isInMyPosition(tokenMint) {
    return this._myPositions.has(tokenMint);
  }

  /**
   * Get the tracked wallet's position for a specific token.
   * Used to get their entry price when they sell (to calc their PnL%).
   *
   * @param {string} walletAddress
   * @param {string} tokenMint
   * @returns {object|null}
   */
  getTrackedPosition(walletAddress, tokenMint) {
    return this._trackedPositions.get(
      this._trackedKey(walletAddress, tokenMint)
    ) || null;
  }

  /**
   * Get our position for a specific token.
   *
   * @param {string} tokenMint
   * @returns {object|null}
   */
  getMyPosition(tokenMint) {
    return this._myPositions.get(tokenMint) || null;
  }

  /**
   * Get ALL of our currently open positions.
   * Used by /positions Telegram command and dashboard.
   *
   * @returns {Array<object>}
   */
  getAllMyPositions() {
    return Array.from(this._myPositions.values());
  }

  /**
   * Get all positions for a specific tracked wallet.
   *
   * @param {string} walletAddress
   * @returns {Array<object>}
   */
  getTrackedWalletPositions(walletAddress) {
    const results = [];
    for (const [key, position] of this._trackedPositions.entries()) {
      if (key.startsWith(walletAddress + ':')) {
        results.push(position);
      }
    }
    return results;
  }

  /**
   * Get count of our currently open positions.
   * Used by risk manager to enforce max open positions limit.
   *
   * @returns {number}
   */
  getMyOpenPositionCount() {
    return this._myPositions.size;
  }

  /**
   * Get all wallets currently holding a specific token.
   * Useful for understanding how many tracked wallets are in a trade.
   *
   * @param {string} tokenMint
   * @returns {string[]} Array of wallet addresses
   */
  getWalletsInToken(tokenMint) {
    return Array.from(this._tokenIndex.get(tokenMint) || []);
  }

  // ──────────────────────────────────────────────────────────
  //  PRICE UPDATES
  //  Called by priceUpdateJob.js every 30 seconds
  // ──────────────────────────────────────────────────────────

  /**
   * Update current prices and recalculate unrealized PnL
   * for all open positions.
   *
   * @param {Map<string, number>} priceMap - tokenMint → current SOL price
   * @param {number} solPriceUSD           - Current SOL/USD price
   */
  updatePrices(priceMap, solPriceUSD = 0) {
    let updatedCount = 0;

    for (const [tokenMint, position] of this._myPositions.entries()) {
      const currentPriceSOL = priceMap.get(tokenMint);
      if (!currentPriceSOL) continue;

      const currentPriceUSD = currentPriceSOL * solPriceUSD;

      // Unrealized PnL = (currentPrice - entryPrice) / entryPrice * 100
      const unrealizedPnLPct = position.entryPriceSOL > 0
        ? ((currentPriceSOL - position.entryPriceSOL) / position.entryPriceSOL) * 100
        : 0;

      // In SOL terms: (currentValue - entryValue)
      const currentValue    = position.entryTokens * currentPriceSOL;
      const unrealizedPnLSOL = currentValue - position.entryAmountSOL;

      // Update in place
      position.currentPriceSOL  = currentPriceSOL;
      position.currentPriceUSD  = currentPriceUSD;
      position.unrealizedPnLSOL = unrealizedPnLSOL;
      position.unrealizedPnLPct = unrealizedPnLPct;
      position.lastUpdated      = new Date();

      updatedCount++;
    }

    // Also update tracked wallet positions
    for (const [, position] of this._trackedPositions.entries()) {
      const currentPriceSOL = priceMap.get(position.tokenMint);
      if (!currentPriceSOL) continue;

      const unrealizedPnLPct = position.entryPriceSOL > 0
        ? ((currentPriceSOL - position.entryPriceSOL) / position.entryPriceSOL) * 100
        : 0;

      position.currentPriceSOL  = currentPriceSOL;
      position.currentPriceUSD  = currentPriceSOL * solPriceUSD;
      position.unrealizedPnLPct = unrealizedPnLPct;
      position.lastUpdated      = new Date();
    }

    if (updatedCount > 0) {
      logger.debug('Position prices updated', {
        myPositions: updatedCount,
        solPriceUSD: solPriceUSD.toFixed(2),
      });
      this.emit('pricesUpdated', { count: updatedCount });
    }
  }

  // ──────────────────────────────────────────────────────────
  //  SUMMARY STATS
  // ──────────────────────────────────────────────────────────

  /**
   * Get a summary of all open positions with total unrealized PnL.
   * Used by /positions Telegram command.
   *
   * @returns {object}
   */
  getSummary() {
    const positions   = this.getAllMyPositions();
    let totalUnrealizedSOL = 0;
    let totalInvestedSOL   = 0;

    for (const p of positions) {
      totalUnrealizedSOL += p.unrealizedPnLSOL || 0;
      totalInvestedSOL   += p.entryAmountSOL   || 0;
    }

    const totalUnrealizedPct = totalInvestedSOL > 0
      ? (totalUnrealizedSOL / totalInvestedSOL) * 100
      : 0;

    return {
      openCount:             positions.length,
      totalInvestedSOL:      parseFloat(totalInvestedSOL.toFixed(6)),
      totalUnrealizedSOL:    parseFloat(totalUnrealizedSOL.toFixed(6)),
      totalUnrealizedPct:    parseFloat(totalUnrealizedPct.toFixed(2)),
      positions:             positions.map((p) => ({
        tokenMint:        p.tokenMint,
        token:            p.tokenSymbol,
        entryAmountSOL:   p.entryAmountSOL,
        entryPriceSOL:    p.entryPriceSOL,
        entryTokens:      p.entryTokens,
        unrealizedPnLSOL: p.unrealizedPnLSOL,
        unrealizedPnLPct: p.unrealizedPnLPct,
        entryTime:        p.entryTime,
        holdTimeMs:       new Date() - p.entryTime,
        tradeId:          p.tradeId,
      })),
      allTimeOpened:  this._stats.totalOpened,
      allTimeClosed:  this._stats.totalClosed,
      peakOpen:       this._stats.peakOpen,
    };
  }

  // ──────────────────────────────────────────────────────────
  //  INTERNAL HELPERS
  // ──────────────────────────────────────────────────────────

  /** Generate map key for tracked position. @private */
  _trackedKey(walletAddress, tokenMint) {
    return `${walletAddress}:${tokenMint}`;
  }

  /** Set a tracked position in the map. @private */
  _setTrackedPosition(walletAddress, tokenMint, position) {
    this._trackedPositions.set(this._trackedKey(walletAddress, tokenMint), position);
  }

  /** Set our position in the map. @private */
  _setMyPosition(tokenMint, position) {
    this._myPositions.set(tokenMint, position);
  }

  /**
   * Handle a tracked wallet adding to an existing position.
   * Updates entry price to weighted average.
   * @private
   */
  _addToTrackedPosition(walletAddress, swapData) {
    const key      = this._trackedKey(walletAddress, swapData.tokenMint);
    const existing = this._trackedPositions.get(key);
    if (!existing) return;

    // Weighted average entry price
    const totalSOL     = existing.entryAmountSOL + swapData.amountSOL;
    const totalTokens  = existing.entryTokens    + swapData.amountTokens;
    const avgPriceSOL  = totalSOL / totalTokens;

    existing.entryAmountSOL  = totalSOL;
    existing.entryTokens     = totalTokens;
    existing.entryPriceSOL   = avgPriceSOL;
    existing.lastUpdated     = new Date();

    logger.debug('Tracked wallet added to existing position', {
      wallet:       shortenAddress(walletAddress),
      token:        swapData.tokenSymbol,
      newAvgPrice:  avgPriceSOL.toFixed(8),
      totalSOL:     totalSOL.toFixed(4),
    });
  }

  /**
   * Maintain the token → wallets index.
   * @private
   */
  _updateTokenIndex(walletAddress, tokenMint, action) {
    if (action === 'add') {
      if (!this._tokenIndex.has(tokenMint)) {
        this._tokenIndex.set(tokenMint, new Set());
      }
      this._tokenIndex.get(tokenMint).add(walletAddress);
    } else {
      const set = this._tokenIndex.get(tokenMint);
      if (set) {
        set.delete(walletAddress);
        if (set.size === 0) this._tokenIndex.delete(tokenMint);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────
//  SINGLETON EXPORT
// ────────────────────────────────────────────────────────────

const positionTracker = new PositionTracker();
module.exports = positionTracker;