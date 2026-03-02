// ============================================================
//  SOL SYSTEMS — Health Check
//  File: src/healthCheck.js
//
//  Provides the GET /health endpoint response.
//  Called by:
//    - Railway / Render for container uptime monitoring
//    - Docker HEALTHCHECK instruction
//    - The Telegram /status command
//    - The dashboard system status panel
//
//  This is a pure data-gathering module — it does NOT
//  register any Express routes itself. server.js registers
//  the route and calls getHealthStatus() to build the response.
//
//  Response shape:
//    {
//      status:         'ok' | 'degraded' | 'error',
//      db:             boolean,
//      websocket:      boolean,
//      openPositions:  number,
//      trackedWallets: number,
//      lastTrade:      ISO string | null,
//      uptime:         number (seconds),
//      ts:             ISO string,
//    }
// ============================================================

'use strict';

const logger = require('./utils/logger');

// Lazy-loaded to avoid circular dependencies on startup
let _tradeRepository = null;
let _walletMonitor   = null;
let _positionTracker = null;

function getRepo()     { return _tradeRepository || (_tradeRepository = require('./execution/tradeRepository')); }
function getMonitor()  { return _walletMonitor   || (_walletMonitor   = require('./monitor/walletMonitor')); }
function getTracker()  { return _positionTracker || (_positionTracker = require('./monitor/positionTracker')); }

// ────────────────────────────────────────────────────────────
//  HEALTH STATUS
// ────────────────────────────────────────────────────────────

/**
 * Gather health metrics from all system components.
 * Safe to call frequently — uses cached values where possible.
 *
 * @returns {Promise<HealthStatus>}
 */
async function getHealthStatus() {
  const startMs = Date.now();

  // ── Database check ───────────────────────────────────────
  let dbOk = false;
  try {
    dbOk = await getRepo().healthCheck();
  } catch (err) {
    logger.warn('Health check: DB ping failed', { error: err.message });
  }

  // ── WebSocket monitor check ──────────────────────────────
  let wsOk          = false;
  let trackedWallets = 0;
  try {
    const monitorStatus = getMonitor().getStatus();
    wsOk           = monitorStatus.wsConnected     ?? false;
    trackedWallets = monitorStatus.activeSubscriptions ?? 0;
  } catch {
    // Monitor not yet started — not an error on boot
  }

  // ── Open positions ───────────────────────────────────────
  let openPositions = 0;
  try {
    const summary = getTracker().getSummary();
    openPositions = summary.openCount ?? 0;
  } catch {
    // Tracker not yet initialised
  }

  // ── Last trade timestamp ─────────────────────────────────
  let lastTrade = null;
  try {
    const recent = await getRepo().getTradeHistory({ limit: 1, offset: 0 });
    if (recent?.trades?.length > 0) {
      lastTrade = recent.trades[0].confirmedAt
        || recent.trades[0].createdAt
        || null;
      if (lastTrade) lastTrade = new Date(lastTrade).toISOString();
    }
  } catch {
    // Non-critical
  }

  // ── Overall status ───────────────────────────────────────
  // 'ok'       — everything working
  // 'degraded' — DB up but WS down (can still report, can't detect trades)
  // 'error'    — DB down (can't function at all)
  let status;
  if (!dbOk)       status = 'error';
  else if (!wsOk)  status = 'degraded';
  else             status = 'ok';

  const elapsed = Date.now() - startMs;

  const health = {
    status,
    db:             dbOk,
    websocket:      wsOk,
    openPositions,
    trackedWallets,
    lastTrade,
    uptime:         Math.floor(process.uptime()),
    responseTimeMs: elapsed,
    ts:             new Date().toISOString(),
  };

  if (status !== 'ok') {
    logger.warn('Health check: system degraded', { status, db: dbOk, ws: wsOk });
  }

  return health;
}

/**
 * Express-compatible request handler.
 * Register in server.js as: app.get('/health', healthCheckHandler)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
async function healthCheckHandler(req, res) {
  try {
    const health   = await getHealthStatus();
    const httpCode = health.status === 'error' ? 503 : 200;
    return res.status(httpCode).json(health);
  } catch (err) {
    logger.error('Health check handler failed', { error: err.message });
    return res.status(503).json({
      status:  'error',
      error:   err.message,
      uptime:  Math.floor(process.uptime()),
      ts:      new Date().toISOString(),
    });
  }
}

module.exports = { getHealthStatus, healthCheckHandler };