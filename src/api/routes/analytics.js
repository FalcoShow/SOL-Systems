// ============================================================
//  SOL SYSTEMS — Analytics Routes
//  File: src/api/routes/analytics.js
//
//  REST endpoints for performance analytics used by charts on
//  the React dashboard.
//  Mounted at /api/analytics in server.js.
//
//  Endpoints:
//    GET /api/analytics/pnl-curve       — time-series cumulative PnL
//    GET /api/analytics/win-rate        — win rate over time
//    GET /api/analytics/best-worst      — top 5 wins and top 5 losses
//    GET /api/analytics/tokens          — PnL breakdown by token
//    GET /api/analytics/daily-summary   — daily PnL array for bar chart
//    GET /api/analytics/overview        — all key metrics in one call
// ============================================================

'use strict';

const express          = require('express');
const { PrismaClient } = require('@prisma/client');
const logger           = require('../../utils/logger');
const { calculateWinRate } = require('../../utils/calculator');
const { getSOLBalance, getSOLPrice } = require('../../utils/solana');
const config           = require('../../config');
const walletMonitor    = require('../../monitor/walletMonitor');
const positionTracker  = require('../../monitor/positionTracker');
const tradeExecutor    = require('../../execution/tradeExecutor');

const router = express.Router();
const prisma = new PrismaClient();

// Helper — parse ?days query param, clamp between 1 and 365
function parseDays(query, defaultDays = 30) {
  const d = parseInt(query);
  if (isNaN(d) || d < 1) return defaultDays;
  return Math.min(d, 365);
}

// Helper — get closed trades within the last N days
async function getClosedTradesInWindow(days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return prisma.trade.findMany({
    where: {
      isOpen:    false,
      pnlSOL:    { not: null },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'asc' },
  });
}

// ── GET /api/analytics/pnl-curve ─────────────────────────────
// Time-series of cumulative PnL — each point is a closed trade
// that increments (or decrements) the running total.
// Used by the PnL line chart on the Analytics page.
//
// Query params:
//   days — look-back window in days (default 30, max 365)
//   currency — 'SOL' | 'USD' (default 'SOL')
router.get('/pnl-curve', async (req, res) => {
  try {
    const days     = parseDays(req.query.days, 30);
    const currency = req.query.currency === 'USD' ? 'USD' : 'SOL';

    const trades = await getClosedTradesInWindow(days);

    // Fetch current SOL price if USD display is requested
    let solPriceUSD = 0;
    if (currency === 'USD') {
      const settings  = await prisma.settings.findFirst();
      solPriceUSD = settings?.lastSolPriceUSD || 0;
    }

    // Build cumulative series
    let running = 0;
    const curve = trades.map((t) => {
      const pnl    = t.pnlSOL || 0;
      const value  = currency === 'USD' ? pnl * solPriceUSD : pnl;
      running     += value;
      return {
        timestamp:    t.createdAt,
        tradePnl:     parseFloat(value.toFixed(6)),
        cumulative:   parseFloat(running.toFixed(6)),
        tokenSymbol:  t.tokenSymbol,
        isWin:        pnl > 0,
      };
    });

    return res.json({
      currency,
      days,
      dataPoints: curve,
      finalPnl:   parseFloat(running.toFixed(6)),
    });

  } catch (err) {
    logger.error('GET /api/analytics/pnl-curve failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to generate PnL curve' });
  }
});

// ── GET /api/analytics/win-rate ──────────────────────────────
// Win rate over time — rolling 7-day win rate at each trade.
// Useful for spotting if copy quality is improving or degrading.
router.get('/win-rate', async (req, res) => {
  try {
    const days   = parseDays(req.query.days, 30);
    const trades = await getClosedTradesInWindow(days);

    // Rolling window: for each trade, show win rate of the last 20 trades
    const WINDOW = 20;
    const series = trades.map((_, idx) => {
      const window = trades.slice(Math.max(0, idx - WINDOW + 1), idx + 1);
      const wins   = window.filter((t) => (t.pnlSOL || 0) > 0).length;
      return {
        timestamp: trades[idx].createdAt,
        winRate:   parseFloat(calculateWinRate(wins, window.length).toFixed(2)),
        tradeNum:  idx + 1,
      };
    });

    const totalWins = trades.filter((t) => (t.pnlSOL || 0) > 0).length;

    return res.json({
      days,
      overallWinRate: parseFloat(calculateWinRate(totalWins, trades.length).toFixed(2)),
      totalTrades:    trades.length,
      series,
    });

  } catch (err) {
    logger.error('GET /api/analytics/win-rate failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to calculate win rate data' });
  }
});

// ── GET /api/analytics/best-worst ────────────────────────────
// Top 5 winning trades and top 5 losing trades.
// Powers the "Best & Worst Trades" section of the analytics page.
router.get('/best-worst', async (req, res) => {
  try {
    const days = parseDays(req.query.days, 30);

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const baseWhere = { isOpen: false, pnlSOL: { not: null }, createdAt: { gte: since } };

    const [best, worst] = await Promise.all([
      prisma.trade.findMany({
        where:   { ...baseWhere, pnlSOL: { gt: 0 } },
        orderBy: { pnlSOL: 'desc' },
        take:    5,
      }),
      prisma.trade.findMany({
        where:   { ...baseWhere, pnlSOL: { lt: 0 } },
        orderBy: { pnlSOL: 'asc' },
        take:    5,
      }),
    ]);

    const format = (t) => ({
      id:          t.id,
      tokenSymbol: t.tokenSymbol,
      tokenName:   t.tokenName,
      pnlSOL:      parseFloat((t.pnlSOL || 0).toFixed(6)),
      pnlPct:      t.pnlPct,
      entryDate:   t.createdAt,
      exitDate:    t.closedAt,
      solscanUrl:  t.exitTxSignature
        ? `https://solscan.io/tx/${t.exitTxSignature}`
        : null,
    });

    return res.json({
      days,
      bestTrades:  best.map(format),
      worstTrades: worst.map(format),
    });

  } catch (err) {
    logger.error('GET /api/analytics/best-worst failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch best/worst trades' });
  }
});

// ── GET /api/analytics/tokens ────────────────────────────────
// PnL broken down by token — which tokens made or lost the most.
// Shows gross PnL, trade count, and win rate per token.
router.get('/tokens', async (req, res) => {
  try {
    const days   = parseDays(req.query.days, 30);
    const trades = await getClosedTradesInWindow(days);

    // Aggregate by token symbol
    const tokenMap = {};

    for (const t of trades) {
      const symbol = t.tokenSymbol || 'UNKNOWN';
      if (!tokenMap[symbol]) {
        tokenMap[symbol] = {
          tokenSymbol: symbol,
          tokenName:   t.tokenName || symbol,
          tokenMint:   t.tokenMint,
          trades:      0,
          wins:        0,
          grossPnlSOL: 0,
        };
      }
      tokenMap[symbol].trades++;
      tokenMap[symbol].grossPnlSOL += t.pnlSOL || 0;
      if ((t.pnlSOL || 0) > 0) tokenMap[symbol].wins++;
    }

    // Convert to array, round numbers, add win rate
    const tokens = Object.values(tokenMap)
      .map((tk) => ({
        ...tk,
        grossPnlSOL: parseFloat(tk.grossPnlSOL.toFixed(6)),
        winRate:     parseFloat(calculateWinRate(tk.wins, tk.trades).toFixed(2)),
      }))
      .sort((a, b) => b.grossPnlSOL - a.grossPnlSOL); // best tokens first

    return res.json({ days, tokens });

  } catch (err) {
    logger.error('GET /api/analytics/tokens failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to aggregate token stats' });
  }
});

// ── GET /api/analytics/daily-summary ─────────────────────────
// Array of daily PnL totals — one entry per calendar day.
// Used by the green/red bar chart on the analytics page.
router.get('/daily-summary', async (req, res) => {
  try {
    const days   = parseDays(req.query.days, 30);
    const trades = await getClosedTradesInWindow(days);

    // Group by calendar day (UTC)
    const dayMap = {};

    for (const t of trades) {
      const day = t.createdAt.toISOString().slice(0, 10); // "YYYY-MM-DD"
      if (!dayMap[day]) {
        dayMap[day] = { date: day, pnlSOL: 0, trades: 0, wins: 0 };
      }
      dayMap[day].pnlSOL += t.pnlSOL || 0;
      dayMap[day].trades++;
      if ((t.pnlSOL || 0) > 0) dayMap[day].wins++;
    }

    // Fill in missing days with zeros so the chart has no gaps
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d   = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const day = d.toISOString().slice(0, 10);
      result.push(
        dayMap[day] || { date: day, pnlSOL: 0, trades: 0, wins: 0 }
      );
    }

    // Round PnL values
    result.forEach((d) => {
      d.pnlSOL  = parseFloat(d.pnlSOL.toFixed(6));
      d.winRate = d.trades > 0
        ? parseFloat(calculateWinRate(d.wins, d.trades).toFixed(2))
        : 0;
    });

    return res.json({ days, dailySummary: result });

  } catch (err) {
    logger.error('GET /api/analytics/daily-summary failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to generate daily summary' });
  }
});

// ── GET /api/analytics/overview ──────────────────────────────
// All key metrics combined in a single call — used by the
// dashboard's top stats bar so it only needs one request.
router.get('/overview', async (req, res) => {
  try {
    const now   = new Date();
    const since = new Date(now - 24 * 60 * 60 * 1000);

    const [
      settings,
      trades24h,
      tradesAllTime,
      openPositions,
      wallets,
      balance,
      solPrice,
    ] = await Promise.all([
      prisma.settings.findFirst(),
      prisma.trade.findMany({ where: { isOpen: false, createdAt: { gte: since } } }),
      prisma.trade.findMany({ where: { isOpen: false } }),
      prisma.trade.findMany({ where: { isOpen: true, status: 'CONFIRMED' } }),
      prisma.trackedWallet.findMany({ where: { isActive: true } }),
      getSOLBalance(config.wallet?.publicKey).catch(() => 0),
      getSOLPrice().catch(() => 0),
    ]);

    const calc24h     = summary(trades24h);
    const calcAllTime = summary(tradesAllTime);
    const mon         = walletMonitor.getStatus?.()    ?? {};
    const pos         = positionTracker.getSummary?.()  ?? {};
    const exec        = tradeExecutor.getStatus?.()    ?? {};

    return res.json({
      stats24h:  calc24h,
      statsAll:  calcAllTime,
      positions: {
        openCount:          pos.openCount ?? openPositions.length,
        totalInvestedSOL:   pos.totalInvestedSOL ?? 0,
        totalUnrealizedSOL: pos.totalUnrealizedSOL ?? 0,
        totalUnrealizedPct: pos.totalUnrealizedPct ?? 0,
      },
      wallet: {
        balance,
        solPriceUSD:  solPrice,
        balanceUSD:   parseFloat((balance * solPrice).toFixed(2)),
      },
      system: {
        wsConnected:         mon.wsConnected ?? false,
        trackedWallets:      wallets.length,
        activeSubscriptions: mon.activeSubscriptions ?? 0,
        queueSize:           exec.queueSize ?? 0,
        uptime:              process.uptime(),
      },
      settings: {
        isTradingPaused:   settings?.isTradingPaused  ?? false,
        myCapitalSOL:      settings?.myCapitalSOL      ?? 10,
        maxPositionPct:    settings?.maxPositionPct     ?? 0.1,
        maxOpenPositions:  settings?.maxOpenPositions   ?? 10,
        dailyLossLimitSOL: settings?.dailyLossLimitSOL  ?? 2,
        maxSlippageBps:    settings?.maxSlippageBps     ?? 100,
        minSolReserve:     settings?.minSolReserve      ?? 0.1,
      },
    });

  } catch (err) {
    logger.error('GET /api/analytics/overview failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to generate analytics overview' });
  }
});

/** Quick aggregate helper used by /overview. @private */
function summary(trades) {
  const total  = trades.length;
  const wins   = trades.filter((t) => (t.pnlSOL || 0) > 0).length;
  const pnlSOL = trades.reduce((s, t) => s + (t.pnlSOL || 0), 0);
  const pnlUSD = trades.reduce((s, t) => s + (t.pnlUSD || 0), 0);
  const execTimes = trades.map(t => t.executionMs).filter(Boolean);
  const avgMs  = execTimes.length > 0
    ? Math.round(execTimes.reduce((s, v) => s + v, 0) / execTimes.length)
    : 0;

  return {
    totalTrades:    total,
    wins,
    losses:         total - wins,
    winRate:        parseFloat(calculateWinRate(wins, total).toFixed(2)),
    winRatePct:     parseFloat(calculateWinRate(wins, total).toFixed(2)),
    netPnLSOL:      parseFloat(pnlSOL.toFixed(6)),
    netPnLUSD:      parseFloat(pnlUSD.toFixed(2)),
    avgExecutionMs: avgMs,
  };
}

module.exports = router;