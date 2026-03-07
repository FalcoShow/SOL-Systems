// ============================================================
//  SOL SYSTEMS — Settings Routes
//  File: src/api/routes/settings.js
//
//  REST endpoints for reading and updating system configuration.
//  Mounted at /api/settings in server.js.
//
//  Endpoints:
//    GET  /api/settings         — current settings
//    PUT  /api/settings         — update settings
//    POST /api/settings/pause   — pause all trading
//    POST /api/settings/resume  — resume trading
//    POST /api/settings/test-telegram — send a test Telegram message
// ============================================================

'use strict';

const express          = require('express');
const { PrismaClient } = require('@prisma/client');
const logger           = require('../../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

// Default settings used when no row exists in the DB yet
const DEFAULTS = {
  myCapitalSOL:       10,
  maxPositionPct:     0.10,    // 10% max per trade
  minSolReserve:      0.1,     // always keep 0.1 SOL for gas
  maxOpenPositions:   10,
  dailyLossLimitSOL:  2,       // pause if we lose 2 SOL in a day
  slippageBps:        50,      // 0.5% slippage tolerance
  rugPullThresholdPct: 50,     // exit if token drops 50% from entry
  isTradingPaused:    false,
  telegramNotifyBuys:  true,
  telegramNotifySells: true,
  telegramNotifyPnl:   true,
};

// ── GET /api/settings ────────────────────────────────────────
// Returns current settings, falling back to defaults for any
// unset fields so the frontend always gets a complete object.
router.get('/', async (req, res) => {
  try {
    const settings = await prisma.settings.findFirst();

    // Merge DB values with defaults (DB wins on conflicts)
    const merged = { ...DEFAULTS, ...(settings || {}) };

    return res.json({ settings: merged });

  } catch (err) {
    logger.error('GET /api/settings failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ── PUT /api/settings ────────────────────────────────────────
// Update one or more settings. Only fields included in the body
// are changed — everything else stays as-is (partial update).
//
// Accepted body fields:
//   myCapitalSOL, maxPositionPct, minSolReserve, maxOpenPositions,
//   dailyLossLimitSOL, slippageBps, rugPullThresholdPct,
//   telegramNotifyBuys, telegramNotifySells, telegramNotifyPnl
//
// NOTE: isTradingPaused is intentionally NOT accepted here —
//       use POST /pause or /resume for that to make it explicit.
router.put('/', async (req, res) => {
  try {
    const allowed = [
      'myCapitalSOL',
      'maxPositionPct',
      'minSolReserve',
      'maxOpenPositions',
      'dailyLossLimitSOL',
      'slippageBps',
      'rugPullThresholdPct',
      'telegramNotifyBuys',
      'telegramNotifySells',
      'telegramNotifyPnl',
    ];

    // Validation rules
    const numericFields = [
      'myCapitalSOL', 'maxPositionPct', 'minSolReserve',
      'maxOpenPositions', 'dailyLossLimitSOL', 'slippageBps',
      'rugPullThresholdPct',
    ];

    const updates = {};

    for (const field of allowed) {
      if (req.body[field] === undefined) continue;

      if (numericFields.includes(field)) {
        const val = parseFloat(req.body[field]);
        if (isNaN(val) || val < 0) {
          return res.status(400).json({
            error:   'Validation failed',
            message: `${field} must be a non-negative number`,
          });
        }
        updates[field] = val;
      } else {
        updates[field] = Boolean(req.body[field]);
      }
    }

    // Specific range checks
    if (updates.maxPositionPct !== undefined && updates.maxPositionPct > 1) {
      return res.status(400).json({
        error:   'Validation failed',
        message: 'maxPositionPct must be between 0 and 1 (e.g. 0.10 for 10%)',
      });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    // Upsert — create the row if it doesn't exist yet
    const existing = await prisma.settings.findFirst();

    let settings;
    if (existing) {
      settings = await prisma.settings.update({
        where: { id: existing.id },
        data:  updates,
      });
    } else {
      settings = await prisma.settings.create({
        data: { ...DEFAULTS, ...updates },
      });
    }

    logger.info('Settings updated', updates);

    return res.json({ message: 'Settings updated', settings });

  } catch (err) {
    logger.error('PUT /api/settings failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── POST /api/settings/pause ─────────────────────────────────
// Emergency stop — immediately halts all new trade execution.
// Open positions are NOT closed — only new entries are blocked.
router.post('/pause', async (req, res) => {
  try {
    const existing = await prisma.settings.findFirst();

    if (existing) {
      await prisma.settings.update({
        where: { id: existing.id },
        data:  { isTradingPaused: true },
      });
    } else {
      await prisma.settings.create({
        data: { ...DEFAULTS, isTradingPaused: true },
      });
    }

    logger.warn('Trading PAUSED via API');

    return res.json({
      message:         'Trading paused — no new positions will be opened',
      isTradingPaused: true,
    });

  } catch (err) {
    logger.error('POST /api/settings/pause failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to pause trading' });
  }
});

// ── POST /api/settings/resume ────────────────────────────────
// Re-enables trading after a pause.
router.post('/resume', async (req, res) => {
  try {
    const existing = await prisma.settings.findFirst();

    if (existing) {
      await prisma.settings.update({
        where: { id: existing.id },
        data:  { isTradingPaused: false },
      });
    } else {
      await prisma.settings.create({
        data: { ...DEFAULTS, isTradingPaused: false },
      });
    }

    logger.info('Trading RESUMED via API');

    return res.json({
      message:         'Trading resumed — new positions will be opened normally',
      isTradingPaused: false,
    });

  } catch (err) {
    logger.error('POST /api/settings/resume failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to resume trading' });
  }
});

// ── POST /api/settings/test-telegram ─────────────────────────
// Sends a test message to your Telegram chat to confirm the bot
// token and chat ID are correctly configured.
router.post('/test-telegram', async (req, res) => {
  try {
    // Lazy-load to avoid circular dependencies
    const { send } = require('../../telegram/bot');

    await send('RAW', {
      message: '✅ *SOL Systems Test*\n\nTelegram notifications are working correctly.',
    });

    return res.json({ message: 'Test message sent to Telegram' });

  } catch (err) {
    logger.error('POST /api/settings/test-telegram failed', { error: err.message });
    return res.status(500).json({
      error:   'Failed to send test message',
      message: err.message,
    });
  }
});

module.exports = router;