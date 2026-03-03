// ============================================================
//  SOL SYSTEMS — Jito Bundle Client
//  File: src/execution/jitoClient.js
//
//  Sends transactions via Jito block engine for MEV protection.
//  Jito bundles bypass the public mempool — sandwich bots
//  cannot see or front-run our trades.
//
//  Flow:
//    1. Get tip accounts from Jito API
//    2. Build a tip transaction (small SOL transfer to validator)
//    3. Bundle our swap tx + tip tx together
//    4. Submit bundle to Jito block engine
//    5. Poll for bundle status until landed or expired
//
//  No API key needed — Jito only charges the tip per bundle.
//  Tip goes directly to the validator who includes our bundle.
// ============================================================

'use strict';

const axios      = require('axios');
const bs58       = require('bs58');
const {
  VersionedTransaction,
  Transaction,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
}                = require('@solana/web3.js');
const config     = require('../config');
const logger     = require('../utils/logger');
const { getWallet, getConnection } = require('../utils/solana');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const BLOCK_ENGINE_URL = config.jito.blockEngineUrl;
const BUNDLE_SEND_URL  = `${BLOCK_ENGINE_URL}/api/v1/bundles`;
const TIP_ACCOUNTS_URL = `${BLOCK_ENGINE_URL}/api/v1/bundles/tip_accounts`;

const DEFAULT_TIP_LAMPORTS = config.jito.tipLamports;
const MAX_TIP_LAMPORTS     = config.jito.maxTipLamports;

const BUNDLE_STATUS_POLL_MS = 1000;    // Check every 1s
const BUNDLE_TIMEOUT_MS     = 30_000;  // 30s max wait

// Cache tip accounts for 5 minutes
let _tipAccountsCache  = null;
let _tipAccountsCacheAt = 0;
const TIP_ACCOUNTS_TTL = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Send a signed transaction via Jito bundle for MEV protection.
 *
 * @param {VersionedTransaction} signedTransaction - Already signed swap tx
 * @returns {Promise<{success: boolean, signature?: string, error?: string, bundleId?: string}>}
 */
async function sendBundle(signedTransaction) {
  if (!config.jito.enabled) {
    return { success: false, error: 'Jito bundles disabled' };
  }

  try {
    const wallet     = getWallet();
    const connection = getConnection();

    // ── Get a random tip account ──────────────────────────
    const tipAccount = await _getTipAccount();
    if (!tipAccount) {
      return { success: false, error: 'Failed to fetch Jito tip accounts' };
    }

    // ── Build tip transaction ─────────────────────────────
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tipTx = new Transaction();
    tipTx.recentBlockhash = blockhash;
    tipTx.feePayer = wallet.publicKey;
    tipTx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey:   new PublicKey(tipAccount),
        lamports:   DEFAULT_TIP_LAMPORTS,
      })
    );
    tipTx.sign(wallet);

    // ── Serialize both transactions ───────────────────────
    const swapTxSerialized = bs58.default.encode(signedTransaction.serialize());
    const tipTxSerialized  = bs58.default.encode(tipTx.serialize());

    // ── Submit bundle ─────────────────────────────────────
    logger.debug('[Jito] Submitting bundle', {
      tipLamports: DEFAULT_TIP_LAMPORTS,
      tipAccount:  tipAccount.slice(0, 8) + '...',
    });

    const response = await axios.post(BUNDLE_SEND_URL, {
      jsonrpc: '2.0',
      id:      1,
      method:  'sendBundle',
      params:  [[swapTxSerialized, tipTxSerialized]],
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    });

    const bundleId = response.data?.result;
    if (!bundleId) {
      const err = response.data?.error?.message || 'No bundle ID returned';
      logger.warn('[Jito] Bundle submission failed', { error: err });
      return { success: false, error: `Jito bundle rejected: ${err}` };
    }

    logger.info('[Jito] Bundle submitted', { bundleId });

    // ── Poll for bundle status ────────────────────────────
    const status = await _pollBundleStatus(bundleId);

    if (status.landed) {
      // Extract swap tx signature from the serialized transaction
      const sig = bs58.default.encode(signedTransaction.signatures[0]);
      logger.info('[Jito] Bundle landed', { bundleId, signature: sig.slice(0, 8) + '...' });
      return { success: true, signature: sig, bundleId };
    }

    return {
      success: false,
      error:   status.error || 'Bundle did not land',
      bundleId,
    };

  } catch (err) {
    logger.warn('[Jito] Bundle send failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Check if Jito bundles are enabled and available.
 * @returns {boolean}
 */
function isEnabled() {
  return !!config.jito.enabled;
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — TIP ACCOUNTS
// ────────────────────────────────────────────────────────────

async function _getTipAccount() {
  const now = Date.now();

  if (_tipAccountsCache && (now - _tipAccountsCacheAt) < TIP_ACCOUNTS_TTL) {
    // Return a random cached tip account
    const idx = Math.floor(Math.random() * _tipAccountsCache.length);
    return _tipAccountsCache[idx];
  }

  try {
    const response = await axios.post(TIP_ACCOUNTS_URL, {
      jsonrpc: '2.0',
      id:      1,
      method:  'getTipAccounts',
      params:  [],
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5_000,
    });

    const accounts = response.data?.result;
    if (!accounts || accounts.length === 0) {
      logger.warn('[Jito] No tip accounts returned');
      return null;
    }

    _tipAccountsCache   = accounts;
    _tipAccountsCacheAt = now;

    const idx = Math.floor(Math.random() * accounts.length);
    return accounts[idx];

  } catch (err) {
    logger.debug('[Jito] Tip accounts fetch failed', { error: err.message });
    return null;
  }
}

// ────────────────────────────────────────────────────────────
//  PRIVATE — BUNDLE STATUS POLLING
// ────────────────────────────────────────────────────────────

async function _pollBundleStatus(bundleId) {
  const startMs = Date.now();

  while (Date.now() - startMs < BUNDLE_TIMEOUT_MS) {
    try {
      const response = await axios.post(BUNDLE_SEND_URL, {
        jsonrpc: '2.0',
        id:      1,
        method:  'getBundleStatuses',
        params:  [[bundleId]],
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5_000,
      });

      const statuses = response.data?.result?.value;
      if (statuses && statuses.length > 0) {
        const status = statuses[0];
        const confirmationStatus = status.confirmation_status;

        if (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
          return { landed: true };
        }

        // Bundle was rejected
        if (status.err) {
          return { landed: false, error: JSON.stringify(status.err) };
        }
      }

    } catch (_) {
      // Polling error — just retry
    }

    await new Promise(r => setTimeout(r, BUNDLE_STATUS_POLL_MS));
  }

  return { landed: false, error: `Bundle timeout after ${BUNDLE_TIMEOUT_MS}ms` };
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { sendBundle, isEnabled };
