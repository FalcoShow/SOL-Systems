// ============================================================
//  SOL SYSTEMS — Real-Time WebSocket Wallet Monitor
//  File: src/monitor/walletMonitor.js
//
//  This is the engine that watches tracked wallets 24/7.
//  Opens a persistent WebSocket connection to Solana RPC and
//  subscribes to every log event on every tracked wallet.
//
//  When a swap is detected:
//    1. Extract the transaction signature from the log
//    2. Pass to transactionParser.js for decoding
//    3. Emit SWAP_DETECTED event → tradeExecutor.js picks it up
//
//  Resilience features:
//    - Auto-reconnect with exponential backoff on disconnect
//    - Subscription health checks every 30 seconds
//    - Missed trade detection via periodic signature polling
//    - Handles RPC rate limits gracefully
//    - Picks up new wallets added at runtime without restart
// ============================================================

'use strict';

const WebSocket        = require('ws');
const { EventEmitter } = require('events');
const { Connection, PublicKey } = require('@solana/web3.js');
const config           = require('../config');
const logger           = require('../utils/logger');
const { getConnection, shortenAddress } = require('../utils/solana');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

// How long to wait before reconnecting after a disconnect
// Uses exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
const RECONNECT_BASE_MS   = 1000;
const RECONNECT_MAX_MS    = 30000;

// How often to ping subscriptions to verify they're alive
const HEALTH_CHECK_MS     = 30000; // 30 seconds

// How often to poll for missed transactions as a backup
const POLL_INTERVAL_MS    = 10000; // 10 seconds

// Max signatures to check per poll cycle per wallet
const POLL_LIMIT          = 5;

// Programs that indicate a DEX swap is happening
// We use these to filter logs — only care about swap transactions
const SWAP_PROGRAM_IDS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter v4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzM3Mhe8bU6',   // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v2
  'RVKd61ztZW9GUwhRbbLoYVRE5Xf1B2tVscKqwZqXgEr',  // Raydium v4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',  // Serum DEX
]);

// ────────────────────────────────────────────────────────────
//  WALLET MONITOR CLASS
// ────────────────────────────────────────────────────────────

class WalletMonitor extends EventEmitter {
  constructor() {
    super();

    // Map of walletAddress → subscriptionId
    this._subscriptions = new Map();

    // Map of walletAddress → wallet info object
    this._trackedWallets = new Map();

    // Set of recently seen tx signatures (prevents duplicate processing)
    // Capped at 1000 entries to prevent memory leak
    this._seenSignatures = new Set();
    this._seenSignaturesQueue = []; // For eviction

    // WebSocket connection state
    this._ws             = null;
    this._wsConnected    = false;
    this._reconnectTimer = null;
    this._reconnectCount = 0;

    // Health check interval
    this._healthCheckTimer = null;

    // Polling interval (backup for missed trades)
    this._pollTimer        = null;

    // Last seen signature per wallet for polling
    this._lastSignature    = new Map();

    // Round-robin polling: index tracks which wallet to poll next
    this._pollIndex        = 0;
    this._pollBackoffUntil = 0; // Timestamp — if set, skip polling until then

    // Running state
    this._running          = false;
  }

  // ──────────────────────────────────────────────────────────
  //  PUBLIC API
  // ──────────────────────────────────────────────────────────

  /**
   * Start the monitor with a list of wallets to track.
   * Call this once on app startup.
   *
   * @param {Array<{address: string, nickname: string, id: string}>} wallets
   */
  async start(wallets = []) {
    if (this._running) {
      logger.warn('WalletMonitor already running');
      return;
    }

    this._running = true;
    logger.info('WalletMonitor starting', { walletCount: wallets.length });

    // Load initial wallet list
    for (const wallet of wallets) {
      this._trackedWallets.set(wallet.address, wallet);
    }

    // Pre-seed _lastSignature so the first poll cycle doesn't
    // catch old transactions from before this boot.
    await this._initializeLastSignatures();

    // Open WebSocket connection
    await this._connect();

    // Start health check loop
    this._healthCheckTimer = setInterval(
      () => this._healthCheck(),
      HEALTH_CHECK_MS
    );

    // Start polling loop (backup for missed trades)
    this._pollTimer = setInterval(
      () => this._pollMissedTrades(),
      POLL_INTERVAL_MS
    );

    logger.info('WalletMonitor started', {
      wallets: wallets.map((w) => w.nickname || shortenAddress(w.address)),
    });
  }

  /**
   * Stop the monitor cleanly.
   * Closes WebSocket, clears all intervals.
   */
  async stop() {
    logger.info('WalletMonitor stopping');
    this._running = false;

    clearInterval(this._healthCheckTimer);
    clearInterval(this._pollTimer);
    clearTimeout(this._reconnectTimer);

    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }

    this._subscriptions.clear();
    this._wsConnected = false;

    logger.info('WalletMonitor stopped');
  }

  /**
   * Add a new wallet to monitor at runtime.
   * Does not require restart — subscription is created immediately.
   *
   * @param {{address: string, nickname: string, id: string}} wallet
   */
  async addWallet(wallet) {
    if (this._trackedWallets.has(wallet.address)) {
      logger.warn('Wallet already being monitored', {
        address: shortenAddress(wallet.address),
        nickname: wallet.nickname,
      });
      return;
    }

    this._trackedWallets.set(wallet.address, wallet);

    if (this._wsConnected) {
      await this._subscribe(wallet.address);
    }

    logger.info('Wallet added to monitor', {
      nickname: wallet.nickname,
      address: shortenAddress(wallet.address),
    });
  }

  /**
   * Remove a wallet from monitoring at runtime.
   *
   * @param {string} walletAddress
   */
  removeWallet(walletAddress) {
    const subscriptionId = this._subscriptions.get(walletAddress);

    if (subscriptionId !== undefined && this._wsConnected) {
      this._unsubscribe(walletAddress, subscriptionId);
    }

    this._trackedWallets.delete(walletAddress);
    this._subscriptions.delete(walletAddress);
    this._lastSignature.delete(walletAddress);

    logger.info('Wallet removed from monitor', {
      address: shortenAddress(walletAddress),
    });
  }

  /**
   * Get current monitor status.
   * @returns {object}
   */
  getStatus() {
    return {
      running:          this._running,
      wsConnected:      this._wsConnected,
      reconnectCount:   this._reconnectCount,
      trackedWallets:   this._trackedWallets.size,
      activeSubscriptions: this._subscriptions.size,
      seenSignatures:   this._seenSignatures.size,
    };
  }

  // ──────────────────────────────────────────────────────────
  //  WEBSOCKET CONNECTION
  // ──────────────────────────────────────────────────────────

  /**
   * Open the WebSocket connection to Solana RPC.
   * @private
   */
  async _connect() {
    logger.info('Opening WebSocket connection to Solana RPC', {
      wsUrl: config.solana.wsUrl.replace(/api-key=.+/, 'api-key=***'),
    });

    try {
      this._ws = new WebSocket(config.solana.wsUrl, {
        handshakeTimeout: 10000,
        perMessageDeflate: false, // Disable compression for lower latency
      });

      this._ws.on('open',    () => this._onOpen());
      this._ws.on('message', (data) => this._onMessage(data));
      this._ws.on('error',   (err)  => this._onError(err));
      this._ws.on('close',   (code, reason) => this._onClose(code, reason));

      // Wait for connection to open
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout after 10s'));
        }, 10000);

        this._ws.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });

        this._ws.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

    } catch (err) {
      logger.error('WebSocket connection failed', { error: err.message });
      this._scheduleReconnect();
    }
  }

  /**
   * Called when WebSocket opens successfully.
   * Subscribes to all tracked wallets.
   * @private
   */
  async _onOpen() {
    this._wsConnected  = true;
    this._reconnectCount = 0;

    logger.info('WebSocket connected to Solana RPC ✓');

    // Subscribe to all currently tracked wallets
    const wallets = Array.from(this._trackedWallets.keys());
    for (const address of wallets) {
      await this._subscribe(address);
      // Small delay between subscriptions to avoid overwhelming RPC
      await _sleep(100);
    }

    this.emit('connected');
  }

  /**
   * Handle incoming WebSocket messages.
   * @private
   */
  _onMessage(rawData) {
    try {
      const data = JSON.parse(rawData.toString());

      // ── Subscription confirmation ──────────────────────────
      // When we subscribe, the RPC sends back the subscription ID
      if (data.id && data.result !== undefined) {
        this._handleSubscriptionConfirm(data);
        return;
      }

      // ── Log notification ───────────────────────────────────
      // This is the main event — a wallet we're watching did something
      if (data.method === 'logsNotification') {
        this._handleLogsNotification(data.params);
        return;
      }

      // ── Unsubscribe confirmation ───────────────────────────
      if (data.id && data.result === true) {
        logger.debug('Unsubscribe confirmed', { id: data.id });
        return;
      }

    } catch (err) {
      logger.error('Failed to parse WebSocket message', {
        error: err.message,
        data: rawData.toString().slice(0, 200),
      });
    }
  }

  /**
   * Handle WebSocket errors.
   * @private
   */
  _onError(err) {
    logger.error('WebSocket error', { error: err.message });
    this.emit('error', err);
  }

  /**
   * Handle WebSocket close.
   * Triggers reconnect unless we stopped intentionally.
   * @private
   */
  _onClose(code, reason) {
    this._wsConnected = false;
    this._subscriptions.clear();

    logger.warn('WebSocket connection closed', {
      code,
      reason: reason?.toString() || 'unknown',
    });

    this.emit('disconnected', { code, reason });

    // Only reconnect if we're still supposed to be running
    if (this._running) {
      this._scheduleReconnect();
    }
  }

  // ──────────────────────────────────────────────────────────
  //  SUBSCRIPTIONS
  // ──────────────────────────────────────────────────────────

  /**
   * Subscribe to log events for a specific wallet address.
   * This is the Solana RPC method that alerts us when any transaction
   * involves the wallet we're watching.
   *
   * @param {string} walletAddress
   * @private
   */
  _subscribe(walletAddress) {
    if (!this._wsConnected || !this._ws) {
      logger.warn('Cannot subscribe — WebSocket not connected', {
        address: shortenAddress(walletAddress),
      });
      return;
    }

    // Generate a unique request ID for this subscription
    // We use it to match the confirmation response back to the wallet
    const requestId = Date.now() + Math.floor(Math.random() * 1000);

    // Store the pending request so we can map it when confirmed
    this._pendingSubscriptions = this._pendingSubscriptions || new Map();
    this._pendingSubscriptions.set(requestId, walletAddress);

    // Solana logsSubscribe RPC call
    // "mentions" filter: only fire when this wallet address appears in tx logs
    const subscribeMsg = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'logsSubscribe',
      params: [
        { mentions: [walletAddress] },  // Only trigger for our wallet
        { commitment: config.solana.commitment },
      ],
    };

    this._ws.send(JSON.stringify(subscribeMsg));

    logger.debug('Subscription sent', {
      address: shortenAddress(walletAddress),
      nickname: this._trackedWallets.get(walletAddress)?.nickname,
      requestId,
    });
  }

  /**
   * Handle subscription confirmation from RPC.
   * Maps the subscription ID to the wallet address.
   * @private
   */
  _handleSubscriptionConfirm(data) {
    if (!this._pendingSubscriptions) return;

    const walletAddress = this._pendingSubscriptions.get(data.id);
    if (!walletAddress) return;

    const subscriptionId = data.result;
    this._subscriptions.set(walletAddress, subscriptionId);
    this._pendingSubscriptions.delete(data.id);

    const wallet = this._trackedWallets.get(walletAddress);
    logger.info('Wallet subscription active ✓', {
      nickname:       wallet?.nickname || 'unknown',
      address:        shortenAddress(walletAddress),
      subscriptionId,
    });
  }

  /**
   * Unsubscribe from a wallet's log events.
   * @private
   */
  _unsubscribe(walletAddress, subscriptionId) {
    if (!this._ws || !this._wsConnected) return;

    const unsubMsg = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'logsUnsubscribe',
      params: [subscriptionId],
    };

    this._ws.send(JSON.stringify(unsubMsg));

    logger.debug('Unsubscribed from wallet', {
      address: shortenAddress(walletAddress),
      subscriptionId,
    });
  }

  // ──────────────────────────────────────────────────────────
  //  LOG NOTIFICATION HANDLER
  //  This fires every time a tracked wallet makes a transaction
  // ──────────────────────────────────────────────────────────

  /**
   * Process a logsNotification event from the RPC.
   * This is called for EVERY transaction the tracked wallet signs.
   * We filter here to only process swap transactions.
   *
   * @param {object} params - The notification params from RPC
   * @private
   */
  async _handleLogsNotification(params) {
    try {
      const result    = params?.result;
      const value     = result?.value;
      const signature = value?.signature;
      const logs      = value?.logs || [];
      const err       = value?.err;

      if (!signature) return;

      // Skip failed transactions immediately
      if (err) {
        logger.debug('Skipping failed transaction', {
          sig: signature.slice(0, 8) + '...',
        });
        return;
      }

      // Deduplicate — WebSocket can sometimes deliver the same tx twice
      if (this._isSeenSignature(signature)) {
        return;
      }
      this._markSeenSignature(signature);

      // Determine which wallet triggered this notification
      // by checking which of our tracked wallets is in the log mentions
      const walletAddress = this._findWalletInLogs(logs, params);

      if (!walletAddress) {
        logger.debug('Could not identify wallet from log notification');
        return;
      }

      const wallet = this._trackedWallets.get(walletAddress);

      // Check if any swap program IDs appear in the logs
      // This quickly filters out non-swap transactions (transfers, etc.)
      const isSwap = this._logsContainSwap(logs);

      if (!isSwap) {
        logger.debug('Transaction is not a swap, skipping', {
          sig: signature.slice(0, 8) + '...',
          wallet: wallet?.nickname,
        });
        return;
      }

      const detectedAt = new Date();

      logger.info('🔍 Swap detected on tracked wallet', {
        nickname:  wallet?.nickname || shortenAddress(walletAddress),
        address:   shortenAddress(walletAddress),
        signature: signature.slice(0, 8) + '...',
        detectedAt: detectedAt.toISOString(),
      });

      // Update last seen time
      this._lastSignature.set(walletAddress, signature);

      // ── Emit the event ─────────────────────────────────────
      // tradeExecutor.js is listening for this and will handle
      // the full parse + execution pipeline
      this.emit('swapDetected', {
        walletAddress,
        walletId:   wallet?.id,
        nickname:   wallet?.nickname,
        signature,
        logs,
        detectedAt,
      });

    } catch (err) {
      logger.error('Error handling log notification', { error: err.message });
    }
  }

  /**
   * Check if log messages contain any known swap program invocations.
   * This filters out wallet activity that isn't a DEX swap
   * (e.g. NFT transfers, SOL sends, staking, etc.)
   *
   * @param {string[]} logs
   * @returns {boolean}
   * @private
   */
  _logsContainSwap(logs) {
    if (!logs || logs.length === 0) return false;

    return logs.some((log) => {
      // Check for program invocations of known swap programs
      if (log.includes('Program') && log.includes('invoke')) {
        return Array.from(SWAP_PROGRAM_IDS).some((programId) =>
          log.includes(programId)
        );
      }
      // Also catch generic swap instruction names
      return log.includes('Swap') ||
             log.includes('swap') ||
             log.includes('Exchange') ||
             log.includes('TokenSwap');
    });
  }

  /**
   * Find which tracked wallet address appears in the log notification.
   * The RPC tells us which subscriptionId fired — map it back to an address.
   *
   * @param {string[]} logs
   * @param {object} params
   * @returns {string|null}
   * @private
   */
  _findWalletInLogs(logs, params) {
    // The subscription result contains the subscription ID
    const subscriptionId = params?.subscription;

    if (subscriptionId !== undefined) {
      // Find the wallet address for this subscription ID
      for (const [address, subId] of this._subscriptions.entries()) {
        if (subId === subscriptionId) {
          return address;
        }
      }
    }

    // Fallback: scan log strings for any of our tracked wallet addresses
    if (logs && logs.length > 0) {
      const logStr = logs.join(' ');
      for (const address of this._trackedWallets.keys()) {
        if (logStr.includes(address)) {
          return address;
        }
      }
    }

    return null;
  }

  // ──────────────────────────────────────────────────────────
  //  RECONNECTION LOGIC
  //  Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s max
  // ──────────────────────────────────────────────────────────

  /**
   * Schedule a reconnect attempt with exponential backoff.
   * @private
   */
  _scheduleReconnect() {
    if (this._reconnectTimer) return; // Already scheduled

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this._reconnectCount),
      RECONNECT_MAX_MS
    );

    this._reconnectCount++;

    logger.warn(`WebSocket reconnecting in ${delay}ms`, {
      attempt: this._reconnectCount,
      delay:   `${delay}ms`,
    });

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;

      if (!this._running) return;

      logger.info('Attempting WebSocket reconnect', {
        attempt: this._reconnectCount,
      });

      // Clean up old WebSocket before reconnecting
      if (this._ws) {
        try { this._ws.terminate(); } catch (_) {}
        this._ws = null;
      }

      await this._connect();
    }, delay);
  }

  // ──────────────────────────────────────────────────────────
  //  HEALTH CHECK
  //  Periodically verify subscriptions are still active
  // ──────────────────────────────────────────────────────────

  /**
   * Verify all subscriptions are alive.
   * Re-subscribes any that have gone stale.
   * @private
   */
  async _healthCheck() {
    if (!this._wsConnected) return;

    // Send a WebSocket ping frame to keep the connection alive.
    // Helius (and most RPC providers) close idle connections after ~5 min.
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.ping(); } catch (_) {}
    }

    const trackedCount = this._trackedWallets.size;
    const subCount     = this._subscriptions.size;

    logger.debug('Health check', {
      wsConnected:   this._wsConnected,
      trackedWallets: trackedCount,
      activeSubscriptions: subCount,
    });

    // If we have fewer subscriptions than tracked wallets,
    // some subscriptions were lost — re-subscribe
    if (subCount < trackedCount) {
      logger.warn('Missing subscriptions detected — re-subscribing', {
        tracked: trackedCount,
        active:  subCount,
        missing: trackedCount - subCount,
      });

      for (const [address] of this._trackedWallets) {
        if (!this._subscriptions.has(address)) {
          await this._subscribe(address);
          await _sleep(100);
        }
      }
    }

    this.emit('healthCheck', this.getStatus());
  }

  // ──────────────────────────────────────────────────────────
  //  POLLING FALLBACK
  //  Catches trades that the WebSocket might have missed
  //  Runs every 10 seconds as a safety net
  // ──────────────────────────────────────────────────────────

  /**
   * Pre-seed _lastSignature for each wallet so the first poll
   * cycle only catches genuinely NEW transactions, not old ones
   * from before this boot.
   * @private
   */
  async _initializeLastSignatures() {
    const connection = getConnection();
    for (const [address, wallet] of this._trackedWallets.entries()) {
      try {
        const sigs = await connection.getSignaturesForAddress(
          new PublicKey(address),
          { limit: 1, commitment: 'confirmed' }
        );
        if (sigs && sigs.length > 0) {
          this._lastSignature.set(address, sigs[0].signature);
          this._markSeenSignature(sigs[0].signature);
        }
      } catch (err) {
        logger.debug('Failed to seed last signature for wallet', {
          wallet: wallet.nickname, error: err.message,
        });
      }
    }
    logger.info('Pre-seeded last signatures for polling', {
      walletCount: this._lastSignature.size,
    });
  }

  /**
   * Poll a subset of tracked wallets each cycle (round-robin).
   * Polls up to WALLETS_PER_POLL wallets per 10s cycle to conserve
   * RPC quota for trade execution. Backs off on 429 rate-limit errors.
   * @private
   */
  async _pollMissedTrades() {
    if (!this._running) return;

    // Respect rate-limit backoff
    if (Date.now() < this._pollBackoffUntil) return;

    const connection = getConnection();
    const walletEntries = Array.from(this._trackedWallets.entries());
    if (walletEntries.length === 0) return;

    // Poll up to 3 wallets per cycle (round-robin)
    const WALLETS_PER_POLL = Math.min(3, walletEntries.length);

    for (let i = 0; i < WALLETS_PER_POLL; i++) {
      const idx = this._pollIndex % walletEntries.length;
      this._pollIndex++;
      const [address, wallet] = walletEntries[idx];

      try {
        const lastSig = this._lastSignature.get(address);

        const signatures = await connection.getSignaturesForAddress(
          new PublicKey(address),
          {
            limit: POLL_LIMIT,
            until: lastSig || undefined,
            commitment: 'confirmed',
          }
        );

        if (!signatures || signatures.length === 0) continue;

        for (const sigInfo of signatures) {
          const sig = sigInfo.signature;

          // Skip if we already processed this
          if (this._isSeenSignature(sig)) continue;
          if (sigInfo.err) continue; // Skip failed txs

          logger.info('Caught missed transaction via polling', {
            nickname:  wallet.nickname,
            signature: sig.slice(0, 8) + '...',
          });

          this._markSeenSignature(sig);
          this._lastSignature.set(address, sig);

          // Emit as if it came from WebSocket — same pipeline
          this.emit('swapDetected', {
            walletAddress: address,
            walletId:      wallet.id,
            nickname:      wallet.nickname,
            signature:     sig,
            logs:          [],
            detectedAt:    new Date(),
            source:        'poll',
          });
        }

      } catch (err) {
        // Back off on rate limit (429) — skip polling for 30s
        if (err.message?.includes('429') || err.message?.includes('rate')) {
          this._pollBackoffUntil = Date.now() + 30_000;
          logger.warn('RPC rate limit hit during polling — backing off 30s', {
            wallet: wallet.nickname,
          });
          return; // Stop this cycle entirely
        }

        logger.debug('Poll check failed for wallet', {
          address: shortenAddress(address),
          error:   err.message,
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  //  DEDUPLICATION
  //  Prevent the same transaction from being processed twice
  // ──────────────────────────────────────────────────────────

  /**
   * Check if we've already seen and processed this signature.
   * @param {string} signature
   * @returns {boolean}
   * @private
   */
  _isSeenSignature(signature) {
    return this._seenSignatures.has(signature);
  }

  /**
   * Mark a signature as seen. Evicts oldest entries if cache is full.
   * @param {string} signature
   * @private
   */
  _markSeenSignature(signature) {
    // Evict oldest if we're at capacity (prevent memory leak)
    if (this._seenSignaturesQueue.length >= 1000) {
      const oldest = this._seenSignaturesQueue.shift();
      this._seenSignatures.delete(oldest);
    }

    this._seenSignatures.add(signature);
    this._seenSignaturesQueue.push(signature);
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/** Promise-based sleep helper. */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────
//  SINGLETON EXPORT
//  The entire app shares one WalletMonitor instance
// ────────────────────────────────────────────────────────────

const walletMonitor = new WalletMonitor();
module.exports = walletMonitor;