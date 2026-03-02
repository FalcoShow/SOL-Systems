// ============================================================
//  SOL SYSTEMS — Trade Routes
//  File: src/api/routes/trades.js
//
//  REST endpoints for trade history, open positions, and stats.
//  Mounted at /api/trades in server.js.
//
//  Endpoints:
//    GET /api/trades               — paginated trade history (with filters)
//    GET /api/trades/open          — currently open positions
//    GET /api/trades/:id           — single trade detail
//    GET /api/trades/stats/24h     — 24-hour aggregate stats
//    GET /api/trades/stats/all-time — lifetime stats
// ============================================================

'use strict';

const express          = require('express');
const { PrismaClient } = require('@prisma/client');
const logger           = require('../../utils/logger');
const { calculateDailyStats } = require('../../utils/calculator');

const router = express.Router();
const prisma = new PrismaClient();

// ── GET /api/trades ──────────────────────────────────────────
// Paginated trade history with optional filters.
//
// Query params:
//   wallet    — filter by trackedWalletAddress
//   token     — filter by token symbol (case-insensitive)
//   result    — 'win' | 'loss' | 'open'
//   from      — ISO date string (start of range)
//   to        — ISO date string (end of range)
//   page      — page number (default 1)
//   limit     — results per page (default 50, max 200)
router.get('/', async (req, res) => {
  try {
    const {
      wallet,
      token,
      result,
      from,
      to,
      page  = 1,
      limit = 50,
    } = req.query;

    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

    // Build where clause from filters
    const where = {};

    if (wallet) where.trackedWalletAddress = wallet;

    if (token) {
      where.tokenSymbol = { contains: token, mode: 'insensitive' };
    }

    if (result === 'win')  where.pnlSOL = { gt: 0 };
    if (result === 'loss') where.pnlSOL = { lt: 0 };
    if (result === 'open') where.isOpen = true;

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(to);
    }

    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      prisma.trade.count({ where }),
    ]);

    return res.json({
      trades,
      pagination: {
        total,
        page:       parseInt(page) || 1,
        limit:      take,
        totalPages: Math.ceil(total / take),
      },
    });

  } catch (err) {
    logger.error('GET /api/trades failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// ── GET /api/trades/open ─────────────────────────────────────
// Returns all currently open positions with unrealized PnL.
// Must be defined BEFORE /:id to avoid route shadowing.
router.get('/open', async (req, res) => {
  try {
    const openTrades = await prisma.trade.findMany({
      where:   { isOpen: true },
      orderBy: { createdAt: 'desc' },
    });

    // Enrich with unrealized PnL if currentPrice is stored
    const enriched = openTrades.map((t) => {
      let unrealizedPnlSOL   = null;
      let unrealizedPnlPct   = null;

      if (t.currentPriceSOL && t.entryPriceSOL && t.entryAmountSOL) {
        const multiplier      = t.currentPriceSOL / t.entryPriceSOL;
        const currentValueSOL = t.entryAmountSOL * multiplier;
        unrealizedPnlSOL      = parseFloat((currentValueSOL - t.entryAmountSOL).toFixed(6));
        unrealizedPnlPct      = parseFloat(((multiplier - 1) * 100).toFixed(4));
      }

      return { ...t, unrealizedPnlSOL, unrealizedPnlPct };
    });

    return res.json({ trades: enriched, total: enriched.length });

  } catch (err) {
    logger.error('GET /api/trades/open failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch open positions' });
  }
});

// ── GET /api/trades/stats/24h ────────────────────────────────
// Aggregate stats for the last 24 hours.
// Powers the top stats bar on the dashboard.
router.get('/stats/24h', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const trades = await prisma.trade.findMany({
      where: {
        createdAt: { gte: since },
        isOpen:    false,
      },
    });

    // Use the calculator's aggregation function for consistency
    const settings = await prisma.settings.findFirst();
    const capitalSOL = settings?.myCapitalSOL || 10;

    const stats = calculateDailyStats(trades, capitalSOL);

    return res.json({
      period:   '24h',
      since:    since.toISOString(),
      ...stats,
    });

  } catch (err) {
    logger.error('GET /api/trades/stats/24h failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to calculate 24h stats' });
  }
});

// ── GET /api/trades/stats/all-time ───────────────────────────
// Lifetime aggregate stats across all closed trades.
router.get('/stats/all-time', async (req, res) => {
  try {
    const trades = await prisma.trade.findMany({
      where: { isOpen: false },
    });

    const settings  = await prisma.settings.findFirst();
    const capitalSOL = settings?.myCapitalSOL || 10;

    const stats = calculateDailyStats(trades, capitalSOL);

    // Add extra lifetime fields
    const firstTrade = await prisma.trade.findFirst({
      orderBy: { createdAt: 'asc' },
    });

    return res.json({
      period:       'all-time',
      firstTradeAt: firstTrade?.createdAt ?? null,
      ...stats,
    });

  } catch (err) {
    logger.error('GET /api/trades/stats/all-time failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to calculate all-time stats' });
  }
});

// ── GET /api/trades/:id ──────────────────────────────────────
// Single trade detail — full data including execution timing,
// deviation from tracked wallet, tx links.
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid trade ID' });
    }

    const trade = await prisma.trade.findUnique({ where: { id } });

    if (!trade) {
      return res.status(404).json({ error: `Trade ${id} not found` });
    }

    // Attach Solscan links for easy verification
    const enriched = {
      ...trade,
      solscanEntryUrl: trade.entryTxSignature
        ? `https://solscan.io/tx/${trade.entryTxSignature}`
        : null,
      solscanExitUrl: trade.exitTxSignature
        ? `https://solscan.io/tx/${trade.exitTxSignature}`
        : null,
    };

    return res.json({ trade: enriched });

  } catch (err) {
    logger.error('GET /api/trades/:id failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch trade' });
  }
});

module.exports = router;