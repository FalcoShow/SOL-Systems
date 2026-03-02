// ============================================================
//  SOL SYSTEMS — Central Config Loader
//  File: src/config/index.js
//
//  This is the SINGLE source of truth for all configuration.
//  Every other file imports from here — never from dotenv directly.
//
//  On startup it:
//    1. Loads your .env file
//    2. Validates every required variable is present
//    3. Parses and type-checks all values
//    4. Exports a clean, typed config object
//
//  If any required variable is missing the app will throw
//  immediately with a clear error message telling you exactly
//  which variable is missing — so you never get silent failures.
// ============================================================

'use strict';

require('dotenv').config();

// ────────────────────────────────────────────────────────────
//  VALIDATION HELPER
//  Throws a clear error if a required env var is missing
// ────────────────────────────────────────────────────────────

function required(key) {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(
      `\n\n  ❌ MISSING REQUIRED ENVIRONMENT VARIABLE: ${key}\n` +
      `     Check your .env file and make sure ${key} is set.\n` +
      `     See .env.example for reference.\n`
    );
  }
  return value.trim();
}

function optional(key, defaultValue = null) {
  const value = process.env[key];
  if (!value || value.trim() === '') return defaultValue;
  return value.trim();
}

function optionalInt(key, defaultValue) {
  const value = process.env[key];
  if (!value || value.trim() === '') return defaultValue;
  const parsed = parseInt(value.trim(), 10);
  if (isNaN(parsed)) {
    throw new Error(
      `\n\n  ❌ INVALID ENVIRONMENT VARIABLE: ${key} must be an integer, got "${value}"\n`
    );
  }
  return parsed;
}

function optionalFloat(key, defaultValue) {
  const value = process.env[key];
  if (!value || value.trim() === '') return defaultValue;
  const parsed = parseFloat(value.trim());
  if (isNaN(parsed)) {
    throw new Error(
      `\n\n  ❌ INVALID ENVIRONMENT VARIABLE: ${key} must be a number, got "${value}"\n`
    );
  }
  return parsed;
}

function optionalBool(key, defaultValue) {
  const value = process.env[key];
  if (!value || value.trim() === '') return defaultValue;
  return value.trim().toLowerCase() === 'true';
}

// ────────────────────────────────────────────────────────────
//  VALIDATE & BUILD CONFIG
//  This runs immediately when the module is first imported.
//  Any missing required variable crashes the app here with
//  a clear error — far better than a cryptic crash later.
// ────────────────────────────────────────────────────────────

let config;

try {
  config = {

    // ── Environment ─────────────────────────────────────────
    env: {
      nodeEnv:        optional('NODE_ENV', 'development'),
      isDev:          optional('NODE_ENV', 'development') === 'development',
      isProd:         optional('NODE_ENV', 'development') === 'production',
      port:           optionalInt('PORT', 3000),
    },

    // ── Solana RPC ───────────────────────────────────────────
    solana: {
      rpcUrl:         required('SOLANA_RPC_URL'),
      wsUrl:          required('SOLANA_WS_URL'),
      heliusApiKey:   required('HELIUS_API_KEY'),
      commitment:     optional('COMMITMENT_LEVEL', 'confirmed'),

      // Validate commitment level is one of the allowed values
      get validCommitment() {
        const allowed = ['processed', 'confirmed', 'finalized'];
        if (!allowed.includes(this.commitment)) {
          throw new Error(
            `\n\n  ❌ INVALID COMMITMENT_LEVEL: "${this.commitment}"\n` +
            `     Must be one of: ${allowed.join(', ')}\n`
          );
        }
        return this.commitment;
      }
    },

    // ── My Trading Wallet ────────────────────────────────────
    wallet: {
      publicKey:      required('MY_WALLET_PUBLIC_KEY'),
      privateKey:     required('MY_WALLET_PRIVATE_KEY'),
    },

    // ── Jupiter DEX ──────────────────────────────────────────
    jupiter: {
      quoteApiUrl:    optional('JUPITER_QUOTE_API_URL', 'https://quote-api.jup.ag/v6/quote'),
      swapApiUrl:     optional('JUPITER_SWAP_API_URL',  'https://quote-api.jup.ag/v6/swap'),
      slippageBps:    optionalInt('JUPITER_SLIPPAGE_BPS', 100),
      maxPriceImpact: optionalFloat('MAX_PRICE_IMPACT_PCT', 5.0),
    },

    // ── Telegram ─────────────────────────────────────────────
    telegram: {
      botToken:       required('TELEGRAM_BOT_TOKEN'),
      chatId:         required('TELEGRAM_CHAT_ID'),
    },

    // ── Database ─────────────────────────────────────────────
    database: {
      url:            required('DATABASE_URL'),
    },

    // ── Trading Capital & Risk ───────────────────────────────
    trading: {
      myCapitalSOL:       optionalFloat('MY_STARTING_CAPITAL_SOL', 10.0),
      maxPositionPct:     optionalFloat('MAX_POSITION_PCT', 0.10),
      minSolReserve:      optionalFloat('MIN_SOL_RESERVE', 0.1),
      maxOpenPositions:   optionalInt('MAX_OPEN_POSITIONS', 10),
      dailyLossLimitSOL:  optionalFloat('DAILY_LOSS_LIMIT_SOL', 2.0),
    },

    // ── Price Data ───────────────────────────────────────────
    prices: {
      birdeyeApiKey:  optional('BIRDEYE_API_KEY', null),
      birdeyeBaseUrl: 'https://public-api.birdeye.so',
    },

    // ── API Server ───────────────────────────────────────────
    api: {
      secretKey:      optional('API_SECRET_KEY', 'dev-secret-change-in-production'),
      dashboardUrl:   optional('DASHBOARD_URL', 'http://localhost:5173'),
    },

    // ── Logging ──────────────────────────────────────────────
    logging: {
      level:          optional('LOG_LEVEL', 'info'),
      retentionDays:  optionalInt('LOG_RETENTION_DAYS', 7),
    },

    // ── Helius Webhook ───────────────────────────────────────
    //  Used to validate incoming webhook requests from Helius
    //  are genuine and not spoofed
    helius: {
      webhookSecret:  optional('HELIUS_WEBHOOK_SECRET', null),
      webhookPath:    '/webhook/helius',
    },

  };

  // ── Post-load validation ─────────────────────────────────
  // These checks catch logical errors that simple required()
  // calls can't catch — e.g., values that are technically set
  // but would cause problems at runtime

  if (config.trading.maxPositionPct <= 0 || config.trading.maxPositionPct > 1) {
    throw new Error(
      `\n\n  ❌ INVALID MAX_POSITION_PCT: "${config.trading.maxPositionPct}"\n` +
      `     Must be between 0 and 1 (e.g., 0.10 for 10%)\n`
    );
  }

  if (config.trading.myCapitalSOL <= 0) {
    throw new Error(
      `\n\n  ❌ INVALID MY_STARTING_CAPITAL_SOL: "${config.trading.myCapitalSOL}"\n` +
      `     Must be greater than 0\n`
    );
  }

  if (config.jupiter.slippageBps < 0 || config.jupiter.slippageBps > 5000) {
    throw new Error(
      `\n\n  ❌ INVALID JUPITER_SLIPPAGE_BPS: "${config.jupiter.slippageBps}"\n` +
      `     Must be between 0 and 5000 (0% to 50%)\n`
    );
  }

  if (config.env.isProd && config.api.secretKey === 'dev-secret-change-in-production') {
    throw new Error(
      `\n\n  ❌ INSECURE API_SECRET_KEY in production\n` +
      `     Generate a strong key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\n`
    );
  }

} catch (err) {
  // Print the error clearly and exit — do not let the app
  // start in a broken state
  console.error(err.message);
  process.exit(1);
}

// ────────────────────────────────────────────────────────────
//  EXPORT
//  Frozen so nothing can accidentally mutate config at runtime
// ────────────────────────────────────────────────────────────

module.exports = Object.freeze(config);