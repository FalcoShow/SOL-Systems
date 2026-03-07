// ============================================================
//  SOL SYSTEMS — Helius Webhook Handler
//  File: src/monitor/heliusWebhook.js
// ============================================================

'use strict';

const crypto             = require('crypto');
const { EventEmitter }   = require('events');
const config             = require('../config');
const logger             = require('../utils/logger');
const { shortenAddress } = require('../utils/solana');
const { parseTransaction, validateSwapData } = require('./transactionParser');

const MAX_EVENT_AGE_MS = 60000;

class HeliusWebhookHandler extends EventEmitter {
  constructor() {
    super();
    this._processedSignatures = new Set();
    this._processedQueue      = [];
    this._walletMonitor       = null;
    this._stats = {
      received:     0,
      processed:    0,
      duplicates:   0,
      errors:       0,
      lastReceived: null,
    };
  }

  // ──────────────────────────────────────────────────────────
  //  INITIALIZATION
  // ──────────────────────────────────────────────────────────

  init(walletMonitor) {
    this._walletMonitor = walletMonitor;
    logger.info('Helius webhook handler initialized', {
      webhookPath:      config.helius.webhookPath,
      secretConfigured: !!config.helius.webhookSecret,
    });
  }

  // ──────────────────────────────────────────────────────────
  //  MAIN REQUEST HANDLER
  // ──────────────────────────────────────────────────────────

  async handleRequest(req, res) {
    const receivedAt = new Date();
    this._stats.received++;
    this._stats.lastReceived = receivedAt;

    try {
      const isValid = this._validateSignature(req);
      if (!isValid) {
        logger.warn('Webhook signature validation failed — possible spoofed request', {
          ip:        req.ip,
          userAgent: req.get('user-agent'),
        });
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const events = req.body;
      if (!Array.isArray(events) || events.length === 0) {
        logger.debug('Webhook received empty or invalid payload');
        return res.status(200).json({ received: 0 });
      }

      logger.debug('Webhook payload received', {
        eventCount: events.length,
        receivedAt: receivedAt.toISOString(),
      });

      // Respond immediately — BEFORE processing trades
      res.status(200).json({ received: events.length });

      for (const event of events) {
        this._processEvent(event, receivedAt).catch((err) => {
          logger.error('Webhook event processing error', { error: err.message });
          this._stats.errors++;
        });
      }

    } catch (err) {
      this._stats.errors++;
      logger.error('Webhook handler error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  //  SIGNATURE VALIDATION — BUG 1 FIX
  //  Helius sends authHeader value as plain Authorization header
  // ──────────────────────────────────────────────────────────

  _validateSignature(req) {
    const webhookSecret = config.helius.webhookSecret;

    if (!webhookSecret) {
      if (config.env.isProd) {
        logger.error('HELIUS_WEBHOOK_SECRET not set in production — rejecting all webhooks');
        return false;
      }
      logger.warn('Webhook signature validation SKIPPED — no secret configured (dev mode only)');
      return true;
    }

    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      logger.warn('Webhook request missing Authorization header', {
        ip:        req.ip,
        userAgent: req.get('user-agent'),
      });
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    try {
      const a = Buffer.from(authHeader,    'utf8');
      const b = Buffer.from(webhookSecret, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────
  //  EVENT PROCESSING — BUG 2 FIX (walletId + nickname)
  // ──────────────────────────────────────────────────────────

  async _processEvent(event, receivedAt) {
    const signature = event.signature || event.transactionSignature;

    if (!signature) {
      logger.debug('Webhook event missing signature, skipping');
      return;
    }

    const shortSig = signature.slice(0, 8) + '...';

    // Deduplication — local cache only
    // Do NOT cross-check WebSocket's _seenSignatures — the WebSocket marks
    // ALL transactions as seen (including non-swaps), which would block
    // the webhook from processing legitimate swap events that the WebSocket
    // didn't recognize as swaps (e.g. Pump.fun, Meteora).
    // TradeExecutor has its own DB-level dedup (isSignatureProcessed) to
    // prevent double execution if both WebSocket and webhook detect the same swap.
    if (this._isProcessed(signature)) {
      this._stats.duplicates++;
      logger.debug('Webhook duplicate detected (local cache)', { sig: shortSig });
      return;
    }

    this._markProcessed(signature);

    const walletAddress = this._extractWalletAddress(event);
    if (!walletAddress) {
      logger.debug('Could not identify wallet in webhook event', { sig: shortSig });
      return;
    }

    const isSwap = this._isSwapEvent(event);
    if (!isSwap) {
      logger.debug('Webhook event is not a swap, skipping', {
        sig:  shortSig,
        type: event.type,
      });
      return;
    }

    logger.info('Webhook swap event received', {
      sig:        shortSig,
      wallet:     shortenAddress(walletAddress),
      type:       event.type,
      receivedAt: receivedAt.toISOString(),
    });

    this._stats.processed++;

    const swapData = await parseTransaction(signature, walletAddress, receivedAt);

    if (!swapData) {
      logger.warn('Webhook: transaction parsing returned null', { sig: shortSig });
      return;
    }

    if (!validateSwapData(swapData)) {
      logger.warn('Webhook: swap data failed validation', { sig: shortSig });
      return;
    }

    // Resolve walletId + nickname from DB
    let walletId = null;
    let nickname = shortenAddress(walletAddress);

    try {
      const tradeRepository = require('../execution/tradeRepository');
      const walletRecord    = await tradeRepository.getTrackedWallet(walletAddress);
      if (walletRecord) {
        walletId = walletRecord.id;
        nickname = walletRecord.nickname || walletRecord.name || nickname;
      }
    } catch (err) {
      logger.debug('Could not resolve walletId for webhook event', { error: err.message });
    }

    // Emit swapDetected — same shape as WebSocket
    this.emit('swapDetected', {
      walletAddress,
      walletId,
      nickname,
      signature,
      swapData,
      detectedAt: receivedAt,
      source:     'webhook',
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

  _extractWalletAddress(event) {
    if (event.feePayer) return event.feePayer;

    if (event.accountData && Array.isArray(event.accountData)) {
      const first = event.accountData[0];
      if (first?.account) return first.account;
    }

    if (event.nativeTransfers && event.nativeTransfers.length > 0) {
      return event.nativeTransfers[0].fromUserAccount || null;
    }

    if (event.tokenTransfers && event.tokenTransfers.length > 0) {
      return event.tokenTransfers[0].fromUserAccount || null;
    }

    return null;
  }

  _isSwapEvent(event) {
    const swapTypes = new Set([
      'SWAP',
      'TOKEN_SWAP',
      'JUPITER_SWAP',
      'RAYDIUM_SWAP',
      'ORCA_SWAP',
      'SERUM_SWAP',
      'UNKNOWN',
    ]);

    if (swapTypes.has(event.type)) return true;
    if (event.events?.swap) return true;

    if (event.type === 'UNKNOWN') {
      const transfers = event.tokenTransfers || [];
      return transfers.length >= 2;
    }

    return false;
  }

  _isProcessed(signature) {
    return this._processedSignatures.has(signature);
  }

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
  // ──────────────────────────────────────────────────────────

  async updateWebhookAddresses(webhookId, addresses) {
    if (!webhookId) {
      logger.warn('No webhookId configured — skipping Helius webhook update');
      return false;
    }

    try {
      const axios = require('axios');
      const url   = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${config.solana.heliusApiKey}`;

      const response = await axios.put(url, {
        webhookURL:       `${config.helius.webhookBaseUrl}${config.helius.webhookPath}`,
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