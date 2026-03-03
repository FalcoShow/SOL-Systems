// ============================================================
//  SOL SYSTEMS — Wallet Routes
//  File: src/api/routes/wallets.js
//
//  REST endpoints for managing tracked wallets.
//  Mounted at /api/wallets in server.js.
//
//  Endpoints:
//    GET    /api/wallets                  — list all tracked wallets
//    POST   /api/wallets                  — add new wallet to track
//    DELETE /api/wallets/:address         — stop tracking a wallet
//    GET    /api/wallets/:address/stats   — performance stats for one wallet
//    PATCH  /api/wallets/:address         — update nickname or capital override
// ============================================================

'use strict';

const express      = require('express');
const { PrismaClient } = require('@prisma/client');
const logger       = require('../../utils/logger');
const { estimateWalletCapital } = require('../../utils/calculator');

const router = express.Router();
const prisma = new PrismaClient();

// Helper — validate a Solana public key (base58, 32–44 chars)
function isValidSolanaAddress(address) {
  return typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

// ── GET /api/wallets ─────────────────────────────────────────
// Returns all tracked wallets with their current status and
// a quick summary of how many trades we've copied from each.
router.get('/', async (req, res) => {
  try {
    const wallets = await prisma.trackedWallet.findMany({
      orderBy: { addedAt: 'desc' },
      include: {
        _count: {
          select: { walletTrades: true },
        },
      },
    });

    const payload = wallets.map((w) => ({
      id:                   w.id,
      address:              w.address,
      nickname:             w.nickname,
      isActive:             w.isActive,
      estimatedCapitalSOL:  w.estimatedCapitalSOL,
      capitalOverrideSOL:   w.capitalOverrideSOL,
      createdAt:            w.addedAt,
      lastSeenAt:           w.lastSeenAt,
      detectedTradeCount:   w._count.walletTrades,
    }));

    return res.json({ wallets: payload, total: payload.length });

  } catch (err) {
    logger.error('GET /api/wallets failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

// ── POST /api/wallets ────────────────────────────────────────
// Add a new wallet to track. Validates the address, estimates
// the wallet's capital from its trade history, and saves it.
//
// Body: { address, nickname, capitalOverrideSOL? }
router.post('/', async (req, res) => {
  const { address, nickname, capitalOverrideSOL } = req.body;

  if (!address) {
    return res.status(400).json({ error: 'address is required' });
  }

  if (!isValidSolanaAddress(address)) {
    return res.status(400).json({ error: 'Invalid Solana address format' });
  }

  if (!nickname || nickname.trim().length === 0) {
    return res.status(400).json({ error: 'nickname is required' });
  }

  try {
    // Check for duplicate
    const existing = await prisma.trackedWallet.findUnique({
      where: { address },
    });

    if (existing) {
      return res.status(409).json({
        error:   'Wallet already tracked',
        message: `${address} is already being tracked as "${existing.nickname}"`,
      });
    }

    // Estimate capital from recent trade history
    // In production this calls the Helius API for recent transactions
    // For now we save 0 and let the sync job fill it in
    const estimatedCapitalSOL = capitalOverrideSOL
      ? parseFloat(capitalOverrideSOL)
      : 0;

    const wallet = await prisma.trackedWallet.create({
      data: {
        address,
        nickname:            nickname.trim(),
        isActive:            true,
        estimatedCapitalSOL,
        capitalOverrideSOL:  capitalOverrideSOL ? parseFloat(capitalOverrideSOL) : null,
        createdAt:           new Date(),
      },
    });

    logger.info('Wallet added for tracking', { address, nickname });

    return res.status(201).json({
      message: `Now tracking ${nickname}`,
      wallet: {
        id:                  wallet.id,
        address:             wallet.address,
        nickname:            wallet.nickname,
        estimatedCapitalSOL: wallet.estimatedCapitalSOL,
        isActive:            wallet.isActive,
        createdAt:           wallet.createdAt,
      },
    });

  } catch (err) {
    logger.error('POST /api/wallets failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to add wallet' });
  }
});

// ── DELETE /api/wallets/:address ─────────────────────────────
// Stop tracking a wallet. Does NOT delete historical trade data —
// we soft-delete by setting isActive = false so PnL history is preserved.
router.delete('/:address', async (req, res) => {
  const { address } = req.params;

  try {
    const wallet = await prisma.trackedWallet.findUnique({ where: { address } });

    if (!wallet) {
      return res.status(404).json({ error: `Wallet ${address} not found` });
    }

    await prisma.trackedWallet.update({
      where: { address },
      data:  { isActive: false },
    });

    logger.info('Wallet removed from tracking', { address, nickname: wallet.nickname });

    return res.json({
      message: `Stopped tracking ${wallet.nickname}`,
      address,
    });

  } catch (err) {
    logger.error('DELETE /api/wallets failed', { error: err.message, address });
    return res.status(500).json({ error: 'Failed to remove wallet' });
  }
});

// ── PATCH /api/wallets/:address ──────────────────────────────
// Update a wallet's nickname or manual capital override.
// Body: { nickname?, capitalOverrideSOL?, isActive? }
router.patch('/:address', async (req, res) => {
  const { address } = req.params;
  const { nickname, capitalOverrideSOL, isActive } = req.body;

  try {
    const wallet = await prisma.trackedWallet.findUnique({ where: { address } });

    if (!wallet) {
      return res.status(404).json({ error: `Wallet ${address} not found` });
    }

    const updates = {};
    if (nickname             !== undefined) updates.nickname            = nickname.trim();
    if (capitalOverrideSOL   !== undefined) updates.capitalOverrideSOL  = parseFloat(capitalOverrideSOL);
    if (isActive             !== undefined) updates.isActive            = Boolean(isActive);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updated = await prisma.trackedWallet.update({
      where: { address },
      data:  updates,
    });

    return res.json({ message: 'Wallet updated', wallet: updated });

  } catch (err) {
    logger.error('PATCH /api/wallets failed', { error: err.message, address });
    return res.status(500).json({ error: 'Failed to update wallet' });
  }
});

// ── GET /api/wallets/:address/stats ──────────────────────────
// Performance stats for a single tracked wallet — how well has
// copying this particular wallet performed?
router.get('/:address/stats', async (req, res) => {
  const { address } = req.params;

  try {
    const wallet = await prisma.trackedWallet.findUnique({ where: { address } });

    if (!wallet) {
      return res.status(404).json({ error: `Wallet ${address} not found` });
    }

    // Fetch all closed copy trades linked to this wallet
    const trades = await prisma.trade.findMany({
      where: {
        trackedWalletAddress: address,
        isOpen:               false,
        pnlSOL:               { not: null },
      },
    });

    const totalTrades = trades.length;
    const wins        = trades.filter((t) => (t.pnlSOL || 0) > 0).length;
    const losses      = totalTrades - wins;
    const grossPnlSOL = trades.reduce((sum, t) => sum + (t.pnlSOL || 0), 0);
    const winRate     = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    const bestTrade  = trades.reduce((best, t) =>
      (!best || (t.pnlSOL || 0) > (best.pnlSOL || 0)) ? t : best, null);
    const worstTrade = trades.reduce((worst, t) =>
      (!worst || (t.pnlSOL || 0) < (worst.pnlSOL || 0)) ? t : worst, null);

    return res.json({
      wallet: {
        address:             wallet.address,
        nickname:            wallet.nickname,
        estimatedCapitalSOL: wallet.estimatedCapitalSOL,
        isActive:            wallet.isActive,
      },
      stats: {
        totalTrades,
        wins,
        losses,
        winRate:      parseFloat(winRate.toFixed(2)),
        grossPnlSOL:  parseFloat(grossPnlSOL.toFixed(6)),
        bestTradeSOL: bestTrade  ? parseFloat((bestTrade.pnlSOL  || 0).toFixed(6)) : 0,
        worstTradeSOL: worstTrade ? parseFloat((worstTrade.pnlSOL || 0).toFixed(6)) : 0,
      },
    });

  } catch (err) {
    logger.error('GET /api/wallets/:address/stats failed', { error: err.message, address });
    return res.status(500).json({ error: 'Failed to fetch wallet stats' });
  }
});

module.exports = router;