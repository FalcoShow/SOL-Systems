// ============================================================
//  SOL SYSTEMS — Express API Server
//  File: src/api/server.js
// ============================================================

'use strict';

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const http       = require('http');
const { WebSocketServer } = require('ws');

const config          = require('../config');
const logger          = require('../utils/logger');
const tradeRepository = require('../execution/tradeRepository');
const positionTracker = require('../monitor/positionTracker');
const walletMonitor   = require('../monitor/walletMonitor');
const heliusWebhook   = require('../monitor/heliusWebhook');
const tradeExecutor   = require('../execution/tradeExecutor');
const { getSOLBalance, getSOLPrice } = require('../utils/solana');

const { authMiddleware }  = require('./middleware/auth');
const walletsRouter       = require('./routes/wallets');
const tradesRouter        = require('./routes/trades');
const settingsRouter      = require('./routes/settings');
const analyticsRouter     = require('./routes/analytics');
const walletIntelligence  = require('../jobs/walletIntelligence');

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-API-Key','x-api-key','helius-signature'],
}));
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health',
}));

// Raw body for Helius HMAC
app.use((req, res, next) => {
  if (req.path === '/webhook/helius') {
    let rawBody = '';
    req.on('data', (chunk) => { rawBody += chunk.toString(); });
    req.on('end', () => {
      req.rawBody = rawBody;
      try { req.body = JSON.parse(rawBody); } catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});
app.use((req, res, next) => {
  if (req.path !== '/webhook/helius') {
    express.json({ limit: '1mb' })(req, res, next);
  } else {
    next();
  }
});

// ── PUBLIC ROUTES ────────────────────────────────────────────

app.post('/webhook/helius', (req, res) => {
  heliusWebhook.handleRequest(req, res);
});

// /health MUST return 200 immediately — Railway fires this the instant
// the HTTP server binds. walletMonitor/tradeExecutor are not yet started
// at that point (they boot later in index.js). Any check touching those
// modules will throw => 503 => deploy killed.
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    ts:     new Date().toISOString(),
  });
});

// Full system health — auth required, only meaningful after full boot
app.get('/api/health', authMiddleware, async (req, res) => {
  try {
    const dbOk  = await tradeRepository.healthCheck().catch(() => false);
    const wsOk  = walletMonitor.getStatus?.()?.wsConnected ?? false;
    return res.status(dbOk ? 200 : 503).json({
      status:       (dbOk && wsOk) ? 'ok' : 'degraded',
      db:           dbOk,
      websocket:    wsOk,
      openPositions: positionTracker.getSummary?.()?.openCount ?? 0,
      uptime:       process.uptime(),
      ts:           new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({ status: 'error', error: err.message });
  }
});

// ── AUTH GATE ────────────────────────────────────────────────
app.use('/api', authMiddleware);

// ── ROUTE MODULES ────────────────────────────────────────────
app.use('/api/wallets',   walletsRouter);
app.use('/api/trades',    tradesRouter);
app.use('/api/settings',  settingsRouter);
app.use('/api/analytics', analyticsRouter);

// ── INLINE API ROUTES ────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const now = new Date();
    const [settings, stats24h, stats7d, balance, solPrice, wallets] = await Promise.all([
      tradeRepository.getSettings(),
      tradeRepository.getAggregateStats(new Date(now - 864e5), now),
      tradeRepository.getAggregateStats(new Date(now - 7*864e5), now),
      getSOLBalance(config.wallet?.publicKey).catch(() => 0),
      getSOLPrice().catch(() => 0),
      tradeRepository.getTrackedWallets(true),
    ]);
    const pos  = positionTracker.getSummary?.() ?? {};
    const mon  = walletMonitor.getStatus?.()    ?? {};
    const exec = tradeExecutor.getStatus?.()    ?? {};
    return res.json({
      settings: {
        myCapitalSOL: settings.myCapitalSOL, isTradingPaused: settings.isTradingPaused,
        pauseReason: settings.pauseReason||null, maxPositionPct: settings.maxPositionPct,
        maxOpenPositions: settings.maxOpenPositions, dailyLossLimitSOL: settings.dailyLossLimitSOL,
      },
      wallet: { balance, solPriceUSD: solPrice, balanceUSD: parseFloat((balance*solPrice).toFixed(2)) },
      stats24h, stats7d,
      positions: {
        openCount: pos.openCount??0, totalInvestedSOL: pos.totalInvestedSOL??0,
        totalUnrealizedSOL: pos.totalUnrealizedSOL??0, totalUnrealizedPct: pos.totalUnrealizedPct??0,
      },
      system: {
        wsConnected: mon.wsConnected??false, trackedWallets: wallets.length,
        activeSubscriptions: mon.activeSubscriptions??0, queueSize: exec.queueSize??0,
        uptime: process.uptime(),
      },
      ts: now.toISOString(),
    });
  } catch (err) {
    logger.error('GET /api/stats error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/positions', (req, res) => {
  try {
    return res.json(positionTracker.getSummary?.() ?? { trades: [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading/pause', async (req, res) => {
  try {
    const { reason = 'Manual pause via dashboard' } = req.body;
    await tradeRepository.pauseTrading(reason);
    logger.warn('Trading PAUSED via API', { reason });
    return res.json({ success: true, paused: true, reason });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading/resume', async (req, res) => {
  try {
    await tradeRepository.resumeTrading();
    logger.info('Trading RESUMED via API');
    return res.json({ success: true, paused: false });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/pnl/daily', async (req, res) => {
  try {
    const days    = Math.min(parseInt(req.query.days||'30'), 365);
    const history = await tradeRepository.getDailyPnLHistory(days);
    return res.json({ history, days });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/pnl/summary', async (req, res) => {
  try {
    const now = new Date();
    const [s24h,s7d,s30d,sAll] = await Promise.all([
      tradeRepository.getAggregateStats(new Date(now-864e5),    now),
      tradeRepository.getAggregateStats(new Date(now-7*864e5),  now),
      tradeRepository.getAggregateStats(new Date(now-30*864e5), now),
      tradeRepository.getAggregateStats(null, null),
    ]);
    return res.json({ '24h':s24h, '7d':s7d, '30d':s30d, allTime:sAll });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── INTELLIGENCE ROUTES ──────────────────────────────────────
// HTML report viewer — public, served directly in browser
// GET /intelligence          → latest report HTML
// GET /intelligence/:date    → specific date HTML (e.g. /intelligence/2026-03-03)

app.get('/intelligence', async (req, res) => {
  try {
    const last = walletIntelligence.getLastReport();
    if (last?.report?.htmlReport) {
      return res.type('html').send(last.report.htmlReport);
    }
    // Fall back to most recent DB record
    const record = await tradeRepository.prisma.walletIntelligence.findFirst({
      orderBy: { forDate: 'desc' },
    });
    if (record?.htmlReport) {
      return res.type('html').send(record.htmlReport);
    }
    return res.status(404).type('html').send(
      '<html><body style="background:#0a0a0f;color:#e2e8f0;font-family:sans-serif;padding:40px">' +
      '<h2>No intelligence report available yet.</h2>' +
      '<p>The nightly AI job runs at 11:50 PM UTC. Use <code>/testintelligence</code> in Telegram to generate one now.</p>' +
      '</body></html>'
    );
  } catch (err) {
    logger.error('GET /intelligence error', { error: err.message });
    return res.status(500).send('Internal server error');
  }
});

app.get('/intelligence/:date', async (req, res) => {
  try {
    const { date } = req.params;
    // Validate date format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).type('html').send('<html><body>Invalid date format. Use YYYY-MM-DD.</body></html>');
    }
    const record = await tradeRepository.prisma.walletIntelligence.findUnique({
      where: { forDate: date },
    });
    if (!record?.htmlReport) {
      return res.status(404).type('html').send(
        `<html><body style="background:#0a0a0f;color:#e2e8f0;font-family:sans-serif;padding:40px">` +
        `<h2>No intelligence report found for ${date}.</h2></body></html>`
      );
    }
    return res.type('html').send(record.htmlReport);
  } catch (err) {
    logger.error('GET /intelligence/:date error', { error: err.message });
    return res.status(500).send('Internal server error');
  }
});

// JSON API endpoints for intelligence data (auth required via /api gate)
app.get('/api/intelligence', async (req, res) => {
  try {
    const records = await tradeRepository.prisma.walletIntelligence.findMany({
      orderBy: { forDate: 'desc' },
      take: 30,
      select: {
        id: true, forDate: true, generatedAt: true, status: true,
        capitalSOL: true, walletsRecommended: true, walletsAdded: true,
        walletsRemoved: true, confidence: true,
        birdeyeDataQuality: true, gmgnDataQuality: true,
        reportJson: true,
      },
    });
    return res.json({ reports: records });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/intelligence/latest', async (req, res) => {
  try {
    const last = walletIntelligence.getLastReport();
    if (last) return res.json(last);
    const record = await tradeRepository.prisma.walletIntelligence.findFirst({
      orderBy: { forDate: 'desc' },
    });
    return record ? res.json(record) : res.status(404).json({ error: 'No report available' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/intelligence/run', async (req, res) => {
  try {
    res.json({ success: true, message: 'Intelligence pipeline started. Check Telegram for results.' });
    // Run after responding so HTTP doesn't time out
    walletIntelligence.runNow().catch((err) => {
      logger.error('Manual intelligence run failed', { error: err.message });
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── 404 + ERROR ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled API error', { error: err.message, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ── WEBSOCKET ────────────────────────────────────────────────
let _wss = null;

function broadcast(type, data) {
  if (!_wss) return;
  const message = JSON.stringify({ type, data, ts: new Date().toISOString() });
  let sent = 0;
  _wss.clients.forEach((c) => { if (c.readyState === 1) { c.send(message); sent++; } });
  if (sent > 0) logger.debug('WS broadcast', { type, clients: sent });
}

// ── LIFECYCLE ────────────────────────────────────────────────
let _httpServer = null;

async function start() {
  const port = config.env?.port || 3001;
  _httpServer = http.createServer(app);
  _wss = new WebSocketServer({ server: _httpServer, path: '/ws' });

  _wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.debug('WS client connected', { ip });
    try {
      ws.send(JSON.stringify({
        type: 'INIT',
        data: {
          positions: positionTracker.getSummary?.() ?? {},
          monitor:   walletMonitor.getStatus?.()    ?? {},
          executor:  tradeExecutor.getStatus?.()    ?? {},
        },
        ts: new Date().toISOString(),
      }));
    } catch (err) {
      logger.warn('Failed to send WS INIT', { error: err.message });
    }
    ws.on('close', () => logger.debug('WS disconnected', { ip }));
    ws.on('error', (err) => logger.debug('WS error', { error: err.message }));
  });

  await new Promise((resolve, reject) => {
    _httpServer.listen(port, (err) => err ? reject(err) : resolve());
  });

  logger.info(`API server started on port ${port}`);
  return _httpServer;
}

async function stop() {
  if (_httpServer) {
    await new Promise((resolve) => _httpServer.close(resolve));
    logger.info('API server stopped');
    _httpServer = null;
  }
}

module.exports = { app, start, stop, broadcast };