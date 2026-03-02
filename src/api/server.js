// ============================================================
//  SOL SYSTEMS — Express API Server
//  File: src/api/server.js
//
//  REST API that powers the React dashboard and receives
//  the Helius webhook for redundant trade detection.
//
//  Route groups:
//    POST /webhook/helius              — Helius webhook (public, HMAC auth)
//    GET  /health                      — health check  (public)
//
//    GET  /api/stats                   — full dashboard summary
//    GET  /api/positions               — open positions (live)
//    GET  /api/pnl/daily               — daily PnL history
//    GET  /api/pnl/summary             — 24h / 7d / 30d / all-time
//    POST /api/trading/pause           — emergency stop
//    POST /api/trading/resume          — re-enable trading
//
//    /api/wallets/*   → routes/wallets.js
//    /api/trades/*    → routes/trades.js
//    /api/settings/*  → routes/settings.js
//    /api/analytics/* → routes/analytics.js
//
//  Auth:
//    Every /api/* route requires either:
//      Authorization: Bearer <DASHBOARD_API_KEY>
//      — OR —
//      x-api-key: <DASHBOARD_API_KEY>
//    Set DASHBOARD_API_KEY in your .env file.
//    /health and /webhook/helius are always public.
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

// ── New middleware + route modules ───────────────────────────
const { authMiddleware }  = require('./middleware/auth');
const walletsRouter       = require('./routes/wallets');
const tradesRouter        = require('./routes/trades');
const settingsRouter      = require('./routes/settings');
const analyticsRouter     = require('./routes/analytics');

// ────────────────────────────────────────────────────────────
//  APP + MIDDLEWARE
// ────────────────────────────────────────────────────────────

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy:    false, // React dashboard needs this off
  crossOriginEmbedderPolicy: false,
}));

// CORS — allow requests from the React dashboard
app.use(cors({
  origin:         config.api?.corsOrigin || '*',
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-api-key', 'helius-signature'],
}));

// HTTP request logging (quiet on /health to avoid noise)
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip:   (req) => req.path === '/health',
}));

// ────────────────────────────────────────────────────────────
//  RAW BODY CAPTURE — Helius webhook HMAC verification
//  Must sit before express.json() so we can read the raw
//  bytes for signature validation on /webhook/helius.
// ────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path === '/webhook/helius') {
    let rawBody = '';
    req.on('data', (chunk) => { rawBody += chunk.toString(); });
    req.on('end', () => {
      req.rawBody = rawBody;
      try   { req.body = JSON.parse(rawBody); }
      catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

// JSON body parser for every other route
app.use((req, res, next) => {
  if (req.path !== '/webhook/helius') {
    express.json({ limit: '1mb' })(req, res, next);
  } else {
    next();
  }
});

// ────────────────────────────────────────────────────────────
//  PUBLIC ROUTES  (no auth required)
// ────────────────────────────────────────────────────────────

// Helius webhook — auth is done via HMAC inside heliusWebhook.js
app.post('/webhook/helius', (req, res) => {
  heliusWebhook.handleRequest(req, res);
});

// Health check — used by Railway / Render for uptime monitoring
app.get('/health', async (req, res) => {
  try {
    const dbOk = await tradeRepository.healthCheck().catch(() => false);
    const wsOk = walletMonitor.getStatus().wsConnected;

    const status = (dbOk && wsOk) ? 'ok' : 'degraded';

    return res.status(dbOk ? 200 : 503).json({
      status,
      db:           dbOk,
      websocket:    wsOk,
      openPositions: positionTracker.getSummary().openCount,
      uptime:       process.uptime(),
      ts:           new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Health check failed', { error: err.message });
    return res.status(503).json({ status: 'error', error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
//  AUTH GATE — everything below requires a valid API key
// ────────────────────────────────────────────────────────────

app.use('/api', authMiddleware);

// ────────────────────────────────────────────────────────────
//  ROUTE MODULES
//  These are the new dedicated route files we built in Phase 5.
//  They handle all CRUD + analytics for wallets, trades, etc.
// ────────────────────────────────────────────────────────────

app.use('/api/wallets',   walletsRouter);
app.use('/api/trades',    tradesRouter);
app.use('/api/settings',  settingsRouter);
app.use('/api/analytics', analyticsRouter);

// ────────────────────────────────────────────────────────────
//  STATS — Full dashboard summary in one request
//  Aggregates wallet balance, 24h + 7d PnL, open positions,
//  and system health into a single payload for the dashboard.
// ────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const now      = new Date();
    const start24h = new Date(now - 24 * 60 * 60 * 1000);
    const start7d  = new Date(now - 7  * 24 * 60 * 60 * 1000);

    const [
      settings,
      stats24h,
      stats7d,
      balance,
      solPrice,
      wallets,
    ] = await Promise.all([
      tradeRepository.getSettings(),
      tradeRepository.getAggregateStats(start24h, now),
      tradeRepository.getAggregateStats(start7d,  now),
      getSOLBalance(config.wallet?.publicKey).catch(() => 0),
      getSOLPrice().catch(() => 0),
      tradeRepository.getTrackedWallets(true),
    ]);

    const positionSummary = positionTracker.getSummary();
    const monitorStatus   = walletMonitor.getStatus();
    const executorStatus  = tradeExecutor.getStatus();

    return res.json({
      settings: {
        myCapitalSOL:      settings.myCapitalSOL,
        isTradingPaused:   settings.isTradingPaused,
        pauseReason:       settings.pauseReason || null,
        maxPositionPct:    settings.maxPositionPct,
        maxOpenPositions:  settings.maxOpenPositions,
        dailyLossLimitSOL: settings.dailyLossLimitSOL,
      },
      wallet: {
        balance,
        solPriceUSD: solPrice,
        balanceUSD:  parseFloat((balance * solPrice).toFixed(2)),
      },
      stats24h,
      stats7d,
      positions: {
        openCount:          positionSummary.openCount,
        totalInvestedSOL:   positionSummary.totalInvestedSOL,
        totalUnrealizedSOL: positionSummary.totalUnrealizedSOL,
        totalUnrealizedPct: positionSummary.totalUnrealizedPct,
      },
      system: {
        wsConnected:         monitorStatus.wsConnected,
        trackedWallets:      wallets.length,
        activeSubscriptions: monitorStatus.activeSubscriptions,
        queueSize:           executorStatus.queueSize,
        uptime:              process.uptime(),
      },
      ts: now.toISOString(),
    });

  } catch (err) {
    logger.error('GET /api/stats error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
//  POSITIONS — Live open positions with unrealized PnL
// ────────────────────────────────────────────────────────────

app.get('/api/positions', (req, res) => {
  try {
    const summary = positionTracker.getSummary();
    return res.json(summary);
  } catch (err) {
    logger.error('GET /api/positions error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
//  TRADING CONTROLS — Pause / Resume
// ────────────────────────────────────────────────────────────

// POST /api/trading/pause
app.post('/api/trading/pause', async (req, res) => {
  try {
    const { reason = 'Manual pause via dashboard' } = req.body;
    await tradeRepository.pauseTrading(reason);
    logger.warn('Trading PAUSED via API', { reason });
    return res.json({ success: true, paused: true, reason });
  } catch (err) {
    logger.error('POST /api/trading/pause error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/trading/resume
app.post('/api/trading/resume', async (req, res) => {
  try {
    await tradeRepository.resumeTrading();
    logger.info('Trading RESUMED via API');
    return res.json({ success: true, paused: false });
  } catch (err) {
    logger.error('POST /api/trading/resume error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
//  PNL HISTORY
// ────────────────────────────────────────────────────────────

// GET /api/pnl/daily?days=30
app.get('/api/pnl/daily', async (req, res) => {
  try {
    const days    = Math.min(parseInt(req.query.days || '30'), 365);
    const history = await tradeRepository.getDailyPnLHistory(days);
    return res.json({ history, days });
  } catch (err) {
    logger.error('GET /api/pnl/daily error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/pnl/summary — all time windows in one request
app.get('/api/pnl/summary', async (req, res) => {
  try {
    const now = new Date();
    const [s24h, s7d, s30d, sAll] = await Promise.all([
      tradeRepository.getAggregateStats(new Date(now - 1  * 864e5), now),
      tradeRepository.getAggregateStats(new Date(now - 7  * 864e5), now),
      tradeRepository.getAggregateStats(new Date(now - 30 * 864e5), now),
      tradeRepository.getAggregateStats(null, null),
    ]);
    return res.json({ '24h': s24h, '7d': s7d, '30d': s30d, allTime: sAll });
  } catch (err) {
    logger.error('GET /api/pnl/summary error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
//  404 + GLOBAL ERROR HANDLERS
// ────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled API error', { error: err.message, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ────────────────────────────────────────────────────────────
//  WEBSOCKET SERVER — Live trade feed for the dashboard
//
//  Clients connect at ws://host/ws
//  On connect they immediately receive an INIT payload with
//  current system state so the dashboard renders instantly.
//  After that, tradeExecutor calls broadcast() after every
//  confirmed swap so the live feed updates in real time.
// ────────────────────────────────────────────────────────────

let _wss = null;

/**
 * Broadcast a live event to all connected dashboard clients.
 * Called by tradeExecutor after each confirmed trade.
 *
 * @param {string} type  - Event type e.g. 'TRADE_CONFIRMED', 'POSITION_UPDATE'
 * @param {object} data  - Event payload
 */
function broadcast(type, data) {
  if (!_wss) return;

  const message = JSON.stringify({ type, data, ts: new Date().toISOString() });
  let   sent    = 0;

  _wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(message);
      sent++;
    }
  });

  if (sent > 0) {
    logger.debug('WS broadcast sent', { type, clients: sent });
  }
}

// ────────────────────────────────────────────────────────────
//  SERVER LIFECYCLE
// ────────────────────────────────────────────────────────────

let _httpServer = null;

/**
 * Start the HTTP + WebSocket server.
 * Called by src/index.js during boot.
 *
 * @returns {Promise<http.Server>}
 */
async function start() {
  const port = config.api?.port || 3001;

  _httpServer = http.createServer(app);

  // Attach WebSocket server to the same port, accessible at /ws
  _wss = new WebSocketServer({ server: _httpServer, path: '/ws' });

  _wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.debug('Dashboard WS client connected', { ip });

    // Immediately send current state to new client
    try {
      ws.send(JSON.stringify({
        type: 'INIT',
        data: {
          positions: positionTracker.getSummary(),
          monitor:   walletMonitor.getStatus(),
          executor:  tradeExecutor.getStatus(),
        },
        ts: new Date().toISOString(),
      }));
    } catch (err) {
      logger.warn('Failed to send INIT to WS client', { error: err.message });
    }

    ws.on('close', () => logger.debug('Dashboard WS client disconnected', { ip }));
    ws.on('error', (err) => logger.debug('WS client error', { error: err.message }));
  });

  await new Promise((resolve, reject) => {
    _httpServer.listen(port, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  logger.info(`API server started`, {
    port,
    corsOrigin: config.api?.corsOrigin || '*',
    auth:       process.env.DASHBOARD_API_KEY ? 'enabled' : 'DISABLED — set DASHBOARD_API_KEY',
  });

  return _httpServer;
}

/**
 * Stop the HTTP server gracefully.
 * Called by src/index.js on SIGTERM / SIGINT.
 */
async function stop() {
  if (_httpServer) {
    await new Promise((resolve) => _httpServer.close(resolve));
    logger.info('API server stopped');
    _httpServer = null;
  }
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = { app, start, stop, broadcast };