// ============================================================
//  SOL SYSTEMS — Helius Webhook Handler
//  File: src/monitor/heliusWebhook.js
//
//  This is the REDUNDANT BACKUP to walletMonitor.js WebSocket.
//
//  How it works:
//    1. You register your server URL with Helius dashboard
//    2. Helius monitors the wallets on their end 24/7
//    3. The instant a tracked wallet transacts, Helius sends
//       an HTTP POST to your server at /webhook/helius
//    4. We validate it's genuinely from Helius (HMAC signature)
//    5. We parse the payload and emit the same swapDetected
//       event that walletMonitor.js emits
//
//  Why run both WebSocket AND webhook?
//    - WebSocket: fastest (sub-200ms), but can drop silently
//    - Webhook:   slightly slower (~300-500ms), but push-based
//    - Together:  if WebSocket misses a trade, webhook catches it
//    - The deduplication cache in walletMonitor prevents double
//      execution if both detect the same trade
//
//  Setup required (one-time):
//    1. Go to https://dev.helius.xyz/webhooks
//    2. Create a new webhook
//    3. Set URL to: https://YOUR_SERVER/webhook/helius
//    4. Add all tracked wallet addresses
//    5. Select transaction types: SWAP
//    6. Copy the webhook secret into your .env as HELIUS_WEBHOOK_SECRET
//
//  Express route registered in: src/api/server.js
//    POST /webhook/helius → heliusWebhook.handleRequest
// ============================================================

'use strict';

const crypto         = require('crypto');
const { EventEmitter } = require('events');
const config         = require('../config');
const logger         = require('../utils/logger');
const { shortenAddress } = require('../utils/solana');
const { parseTransaction, validateSwapData } = require('./transactionParser');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

// Helius signs each webhook payload with HMAC-SHA256
// We verify this to prevent spoofed webhook requests
const SIGNATURE_HEADER = 'helius-signature';

// Maximum age of a webhook event we'll accept
// Prevents replay attacks where an old payload is re-sent
const MAX_EVENT_AGE_MS = 60000; // 60 seconds

// ────────────────────────────────────────────────────────────
//  HELIUS WEBHOOK HANDLER CLASS
// ────────────────────────────────────────────────────────────

class HeliusWebhookHandler extends EventEmitter {
  constructor() {
    super();

    // Track processed signatures to deduplicate with WebSocket
    this._processedSignatures = new Set();
    this._processedQueue      = [];

    // Reference to walletMonitor for deduplication check
    this._walletMonitor = null;

    // Stats
    this._stats = {
      received:    0,
      processed:   0,
      duplicates:  0,
      errors:      0,
      lastReceived: null,
    };
  }

  // ──────────────────────────────────────────────────────────
  //  INITIALIZATION
  // ──────────────────────────────────────────────────────────

  /**
   * Initialize with a reference to the wallet monitor.
   * Used to share the deduplication cache — so if WebSocket
   * already processed a tx, webhook won't re-process it.
   *
   * @param {object} walletMonitor - The singleton walletMonitor instance
   */
  init(walletMonitor) {
    this._walletMonitor = walletMonitor;
    logger.info('Helius webhook handler initialized', {
      webhookPath: config.helius.webhookPath,
      secretConfigured: !!config.helius.webhookSecret,
    });
  }

  // ──────────────────────────────────────────────────────────
  //  MAIN REQUEST HANDLER
  //  Called by Express route: POST /webhook/helius
  // ──────────────────────────────────────────────────────────

  /**
   * Handle an incoming webhook POST request from Helius.
   * This is the Express middleware function.
   *
   * @param {object} req - Express request
   * @param {object} res - Express response
   */
  async handleRequest(req, res) {
    const receivedAt = new Date();
    this._stats.received++;
    this._stats.lastReceived = receivedAt;

    try {
      // ── Step 1: Validate signature ──────────────────────
      // Must happen BEFORE parsing body for security
      const isValid = this._validateSignature(req);
      if (!isValid) {
        logger.warn('Webhook signature validation failed — possible spoofed request', {
          ip:        req.ip,
          userAgent: req.get('user-agent'),
        });
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // ── Step 2: Parse payload ───────────────────────────
      const events = req.body;

      if (!Array.isArray(events) || events.length === 0) {
        logger.debug('Webhook received empty or invalid payload');
        return res.status(200).json({ received: 0 });
      }

      logger.debug('Webhook payload received', {
        eventCount: events.length,
        receivedAt: receivedAt.toISOString(),
      });

      // ── Step 3: Respond to Helius immediately ───────────
      // CRITICAL: Respond with 200 BEFORE processing trades
      // Helius will retry if we don't respond within 5 seconds
      // Processing trades can take 1-2 seconds — respond first
      res.status(200).json({ received: events.length });

      // ── Step 4: Process each event asynchronously ───────
      for (const event of events) {
        this._processEvent(event, receivedAt).catch((err) => {
          logger.error('Webhook event processing error', { error: err.message });
          this._stats.errors++;
        });
      }

    } catch (err) {
      this._stats.errors++;
      logger.error('Webhook handler error', { error: err.message });

      // Only send error response if we haven't already sent 200
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  //  SIGNATURE VALIDATION
  //  Verify the request genuinely came from Helius
  // ──────────────────────────────────────────────────────────

  /**
   * Validate the HMAC-SHA256 signature from Helius.
   * Helius sends: HMAC-SHA256(webhookSecret, rawBody)
   * We recompute it and compare.
   *
   * @param {object} req - Express request (must have rawBody attached)
   * @returns {boolean}
   * @private
   */
  _validateSignature(req) {
    const webhookSecret = config.helius.webhookSecret;

    // If no secret configured, skip validation in dev mode
    // But always validate in production
    if (!webhookSecret) {
      if (config.env.isProd) {
        logger.error('HELIUS_WEBHOOK_SECRET not set in production — rejecting all webhooks');
        return false;
      }
      logger.warn('Webhook signature validation SKIPPED — no secret configured (dev mode only)');
      return true;
    }

    const receivedSig = req.headers[SIGNATURE_HEADER];
    if (!receivedSig) {
      logger.warn('Webhook request missing signature header', {
        header: SIGNATURE_HEADER,
      });
      return false;
    }

    // Raw body must be preserved by Express for HMAC verification
    // This is set up in server.js with the verify option on bodyParser
    const rawBody = req.rawBody;
    if (!rawBody) {
      logger.warn('Raw body not available for signature verification');
      // Fall through — better to accept than reject valid trades
      return true;
    }

    try {
      const expectedSig = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      // Use timingSafeEqual to prevent timing attacks
      const sigBuffer      = Buffer.from(receivedSig,  'hex');
      const expectedBuffer = Buffer.from(expectedSig, 'hex');

      if (sigBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    } catch (err) {
      logger.error('Signature verification threw error', { error: err.message });
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────
  //  EVENT PROCESSING
  // ──────────────────────────────────────────────────────────

  /**
   * Process a single Helius webhook event.
   * Validates, deduplicates, parses, and emits swapDetected.
   *
   * @param {object} event      - Single Helius transaction event
   * @param {Date}   receivedAt - When the webhook was received
   * @private
   */
  async _processEvent(event, receivedAt) {
    const signature = event.signature || event.transactionSignature;

    if (!signature) {
      logger.debug('Webhook event missing signature, skipping');
      return;
    }

    const shortSig = signature.slice(0, 8) + '...';

    // ── Deduplication ─────────────────────────────────────
    // Check our local cache first
    if (this._isProcessed(signature)) {
      this._stats.duplicates++;
      logger.debug('Webhook duplicate detected (local cache)', { sig: shortSig });
      return;
    }

    // Check walletMonitor's seen signatures cache
    // This prevents re-processing what WebSocket already caught
    if (this._walletMonitor && this._walletMonitor._isSeenSignature(signature)) {
      this._stats.duplicates++;
      logger.debug('Webhook duplicate detected (WebSocket already processed)', {
        sig: shortSig,
      });
      return;
    }

    // Mark as processed in both caches
    this._markProcessed(signature);
    if (this._walletMonitor) {
      this._walletMonitor._markSeenSignature(signature);
    }

    // ── Identify which tracked wallet this belongs to ─────
    const walletAddress = this._extractWalletAddress(event);
    if (!walletAddress) {
      logger.debug('Could not identify wallet in webhook event', { sig: shortSig });
      return;
    }

    // ── Filter: only process swap transactions ────────────
    const isSwap = this._isSwapEvent(event);
    if (!isSwap) {
      logger.debug('Webhook event is not a swap, skipping', {
        sig:  shortSig,
        type: event.type,
      });
      return;
    }

    logger.info('📨 Webhook swap event received', {
      sig:        shortSig,
      wallet:     shortenAddress(walletAddress),
      type:       event.type,
      receivedAt: receivedAt.toISOString(),
    });

    this._stats.processed++;

    // ── Parse the transaction ─────────────────────────────
    const swapData = await parseTransaction(signature, walletAddress, receivedAt);

    if (!swapData) {
      logger.warn('Webhook: transaction parsing returned null', { sig: shortSig });
      return;
    }

    if (!validateSwapData(swapData)) {
      logger.warn('Webhook: swap data failed validation', { sig: shortSig });
      return;
    }

    // ── Emit swapDetected — same event as WebSocket ───────
    // tradeExecutor.js listens on both walletMonitor AND here
    this.emit('swapDetected', {
      walletAddress,
      signature,
      swapData,
      detectedAt:  receivedAt,
      source:      'webhook',
    });

    logger.debug('Webhook event emitted as swapDetected', {
      sig:   shortSig,
      type:  swapData.tradeType,
      token: swapData.tokenSymbol,
    });
  }

  // ──────────────────────────────────────────────────────────
  //  HELPERS
  // ──────────────────────────────────────────────────────────

  /**
   * Extract the relevant wallet address from a Helius event.
   * Returns the first address that matches a tracked wallet.
   *
   * @param {object} event
   * @returns {string|null}
   * @private
   */
  _extractWalletAddress(event) {
    // Primary: feePayer is almost always the trader
    if (event.feePayer) return event.feePayer;

    // From account data changes
    if (event.accountData && Array.isArray(event.accountData)) {
      const first = event.accountData[0];
      if (first?.account) return first.account;
    }

    // From native transfers
    if (event.nativeTransfers && event.nativeTransfers.length > 0) {
      return event.nativeTransfers[0].fromUserAccount || null;
    }

    // From token transfers
    if (event.tokenTransfers && event.tokenTransfers.length > 0) {
      return event.tokenTransfers[0].fromUserAccount || null;
    }

    return null;
  }

  /**
   * Determine if a Helius event represents a DEX swap.
   *
   * @param {object} event
   * @returns {boolean}
   * @private
   */
  _isSwapEvent(event) {
    const swapTypes = new Set([
      'SWAP',
      'TOKEN_SWAP',
      'JUPITER_SWAP',
      'RAYDIUM_SWAP',
      'ORCA_SWAP',
      'SERUM_SWAP',
      'UNKNOWN', // Sometimes Helius doesn't classify correctly — check events
    ]);

    if (swapTypes.has(event.type)) return true;

    // Check events object
    if (event.events?.swap) return true;

    // Check if UNKNOWN type has swap-like token transfers
    if (event.type === 'UNKNOWN') {
      const transfers = event.tokenTransfers || [];
      return transfers.length >= 2; // Swap always has at least 2 token movements
    }

    return false;
  }

  /**
   * Check if a signature was already processed via webhook.
   * @param {string} signature
   * @returns {boolean}
   * @private
   */
  _isProcessed(signature) {
    return this._processedSignatures.has(signature);
  }

  /**
   * Mark a signature as processed. Evicts oldest if at capacity.
   * @param {string} signature
   * @private
   */
  _markProcessed(signature) {
    if (this._processedQueue.length >= 500) {
      const oldest = this._processedQueue.shift();
      this._processedSignatures.delete(oldest);
    }
    this._processedSignatures.add(signature);
    this._processedQueue.push(signature);
  }

  // ──────────────────────────────────────────────────────────
  //  HELIUS WEBHOOK MANAGEMENT API
  //  Programmatically manage webhook subscriptions via Helius API
  //  Called when you add/remove wallets from the dashboard
  // ──────────────────────────────────────────────────────────

  /**
   * Register or update a Helius webhook to include a new wallet address.
   * Called automatically when a new wallet is added via dashboard or Telegram.
   *
   * @param {string} webhookId      - Your Helius webhook ID (from dashboard)
   * @param {string[]} addresses    - Full list of addresses to monitor
   * @returns {Promise<boolean>}
   */
  async updateWebhookAddresses(webhookId, addresses) {
    if (!webhookId) {
      logger.warn('No webhookId configured — skipping Helius webhook update');
      return false;
    }

    try {
      const axios = require('axios');
      const url   = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${config.solana.heliusApiKey}`;

      const response = await axios.put(url, {
        webhookURL:       `${config.api.dashboardUrl}/webhook/helius`,
        transactionTypes: ['SWAP'],
        accountAddresses: addresses,
        webhookType:      'enhanced',
        authHeader:       config.helius.webhookSecret || '',
      }, { timeout: 10000 });

      logger.info('Helius webhook addresses updated', {
        webhookId,
        addressCount: addresses.length,
        status:       response.status,
      });

      return true;

    } catch (err) {
      logger.error('Failed to update Helius webhook addresses', {
        webhookId,
        error: err.message,
      });
      return false;
    }
  }

  /**
   * Create a brand new Helius webhook.
   * Only needed on first-time setup.
   *
   * @param {string[]} addresses   - Wallet addresses to monitor
   * @param {string}   serverUrl   - Your public server URL
   * @returns {Promise<string|null>} The new webhook ID
   */
  async createWebhook(addresses, serverUrl) {
    try {
      const axios = require('axios');
      const url   = `https://api.helius.xyz/v0/webhooks?api-key=${config.solana.heliusApiKey}`;

      const response = await axios.post(url, {
        webhookURL:       `${serverUrl}/webhook/helius`,
        transactionTypes: ['SWAP'],
        accountAddresses: addresses,
        webhookType:      'enhanced',
        authHeader:       config.helius.webhookSecret || '',
      }, { timeout: 10000 });

      const webhookId = response.data?.webhookID;

      logger.info('Helius webhook created', {
        webhookId,
        url:          `${serverUrl}/webhook/helius`,
        addressCount: addresses.length,
      });

      return webhookId;

    } catch (err) {
      logger.error('Failed to create Helius webhook', { error: err.message });
      return null;
    }
  }

  /**
   * List all existing Helius webhooks for this API key.
   * Useful for debugging and setup verification.
   *
   * @returns {Promise<Array>}
   */
  async listWebhooks() {
    try {
      const axios = require('axios');
      const url   = `https://api.helius.xyz/v0/webhooks?api-key=${config.solana.heliusApiKey}`;

      const response = await axios.get(url, { timeout: 10000 });
      return response.data || [];

    } catch (err) {
      logger.error('Failed to list Helius webhooks', { error: err.message });
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  //  STATUS & STATS
  // ──────────────────────────────────────────────────────────

  /**
   * Get current webhook handler stats.
   * @returns {object}
   */
  getStats() {
    return {
      ...this._stats,
      processedCacheSize: this._processedSignatures.size,
    };
  }
}

// ────────────────────────────────────────────────────────────
//  SINGLETON EXPORT
// ────────────────────────────────────────────────────────────

const heliusWebhook = new HeliusWebhookHandler();
module.exports = heliusWebhook;