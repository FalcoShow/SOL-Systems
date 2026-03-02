// ============================================================
//  SOL SYSTEMS — API Authentication Middleware
//  File: src/api/middleware/auth.js
//
//  Protects all dashboard API endpoints with a simple API key.
//  The key lives in .env as DASHBOARD_API_KEY and must be sent
//  by the frontend in every request header:
//
//    Authorization: Bearer <your-api-key>
//    — OR —
//    x-api-key: <your-api-key>
//
//  Why not JWT or OAuth?
//    This dashboard is single-user (you). A shared secret key
//    is the right level of complexity — simple, fast, secure
//    enough for a personal trading tool behind HTTPS.
//
//  The /health endpoint is always exempt — Railway and Render
//  hit it constantly for uptime checks and must never be blocked.
// ============================================================

'use strict';

const logger = require('../../../src/utils/logger');

// ── Public routes that skip auth entirely ────────────────────
const PUBLIC_PATHS = [
  '/health',
  '/webhook/helius',   // Helius pushes to this — uses its own HMAC check
];

/**
 * Express middleware that validates the API key on every request.
 * Attach to the Express app BEFORE mounting any API routers.
 *
 * Usage in server.js:
 *   const { authMiddleware } = require('./middleware/auth');
 *   app.use('/api', authMiddleware);
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function authMiddleware(req, res, next) {
  // ── Always allow public routes ───────────────────────────
  if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) {
    return next();
  }

  // ── Read the configured key from env ────────────────────
  const configuredKey = process.env.DASHBOARD_API_KEY;

  if (!configuredKey) {
    // Misconfiguration — log loudly and reject
    logger.error('DASHBOARD_API_KEY is not set — all API requests will be rejected');
    return res.status(503).json({
      error:   'Server misconfiguration',
      message: 'API key is not configured. Set DASHBOARD_API_KEY in your environment.',
    });
  }

  // ── Extract the key from the request ────────────────────
  // Support both Authorization: Bearer <key> and x-api-key: <key>
  const authHeader = req.headers['authorization'] || '';
  const xApiKey    = req.headers['x-api-key']     || '';

  let incomingKey = xApiKey;

  if (!incomingKey && authHeader.startsWith('Bearer ')) {
    incomingKey = authHeader.slice(7).trim();
  }

  if (!incomingKey) {
    logger.warn('API request rejected — no key provided', {
      path:   req.path,
      method: req.method,
      ip:     req.ip,
    });
    return res.status(401).json({
      error:   'Unauthorized',
      message: 'Provide your API key via Authorization: Bearer <key> or x-api-key header.',
    });
  }

  // ── Constant-time comparison to prevent timing attacks ──
  // A naive === comparison leaks info about key length via
  // timing. timingSafeEqual from crypto fixes that.
  const crypto = require('crypto');

  let isValid = false;
  try {
    const a = Buffer.from(incomingKey,   'utf8');
    const b = Buffer.from(configuredKey, 'utf8');
    // buffers must be same length for timingSafeEqual
    isValid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    isValid = false;
  }

  if (!isValid) {
    logger.warn('API request rejected — invalid key', {
      path:   req.path,
      method: req.method,
      ip:     req.ip,
    });
    return res.status(401).json({
      error:   'Unauthorized',
      message: 'Invalid API key.',
    });
  }

  // ── Key is valid — continue ──────────────────────────────
  next();
}

/**
 * Standalone key validator — use in tests or non-Express contexts.
 *
 * @param {string} incomingKey
 * @returns {boolean}
 */
function isValidApiKey(incomingKey) {
  const configuredKey = process.env.DASHBOARD_API_KEY;
  if (!configuredKey || !incomingKey) return false;

  const crypto = require('crypto');
  try {
    const a = Buffer.from(incomingKey,   'utf8');
    const b = Buffer.from(configuredKey, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { authMiddleware, isValidApiKey };