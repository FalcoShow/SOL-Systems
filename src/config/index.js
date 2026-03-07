// ============================================================
//  SOL SYSTEMS — Central Config Loader
//  File: src/config/index.js
// ============================================================

'use strict';

require('dotenv').config();

console.log('[config] Loading environment variables...');

function required(key) {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    console.error(`\n\n  ❌ MISSING REQUIRED ENV VAR: ${key}\n     Check Railway Variables.\n`);
    process.exit(1);
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
    console.error(`\n\n  ❌ INVALID ENV VAR: ${key} must be an integer, got "${value}"\n`);
    process.exit(1);
  }
  return parsed;
}

function optionalFloat(key, defaultValue) {
  const value = process.env[key];
  if (!value || value.trim() === '') return defaultValue;
  const parsed = parseFloat(value.trim());
  if (isNaN(parsed)) {
    console.error(`\n\n  ❌ INVALID ENV VAR: ${key} must be a number, got "${value}"\n`);
    process.exit(1);
  }
  return parsed;
}

function optionalBool(key, defaultValue) {
  const value = process.env[key];
  if (!value || value.trim() === '') return defaultValue;
  return value.trim().toLowerCase() === 'true';
}

let config;

try {
  config = {

    env: {
      nodeEnv: optional('NODE_ENV', 'development'),
      isDev:   optional('NODE_ENV', 'development') === 'development',
      isProd:  optional('NODE_ENV', 'development') === 'production',
      port:    optionalInt('PORT', 3001),
    },

    solana: {
      rpcUrl:       required('SOLANA_RPC_URL'),
      wsUrl:        required('SOLANA_WS_URL'),
      heliusApiKey: required('HELIUS_API_KEY'),
      commitment:   optional('COMMITMENT_LEVEL', 'confirmed'),
    },

    wallet: {
      publicKey:  required('MY_WALLET_PUBLIC_KEY'),
      privateKey: required('MY_WALLET_PRIVATE_KEY'),
    },

    jupiter: {
      quoteApiUrl:    optional('JUPITER_QUOTE_API_URL', 'https://public.jupiterapi.com/quote'),
      swapApiUrl:     optional('JUPITER_SWAP_API_URL',  'https://public.jupiterapi.com/swap'),
      slippageBps:    optionalInt('JUPITER_SLIPPAGE_BPS', 100),
      maxPriceImpact: optionalFloat('MAX_PRICE_IMPACT_PCT', 5.0),
    },

    telegram: {
      botToken: required('TELEGRAM_BOT_TOKEN'),
      chatId:   required('TELEGRAM_CHAT_ID'),
    },

    database: {
      url: required('DATABASE_URL'),
    },

    trading: {
      myCapitalSOL:      optionalFloat('MY_STARTING_CAPITAL_SOL', 10.0),
      maxPositionPct:    optionalFloat('MAX_POSITION_PCT', 0.10),
      minSolReserve:     optionalFloat('MIN_SOL_RESERVE', 0.1),
      maxOpenPositions:  optionalInt('MAX_OPEN_POSITIONS', 10),
      dailyLossLimitSOL: optionalFloat('DAILY_LOSS_LIMIT_SOL', 2.0),
    },

    anthropic: {
      apiKey: required('ANTHROPIC_API_KEY'),
    },

    prices: {
      birdeyeApiKey:  optional('BIRDEYE_API_KEY', null),
      birdeyeBaseUrl: 'https://public-api.birdeye.so',
    },

    cielo: {
      apiKey: optional('CIELO_API_KEY', null),
    },

    api: {
      // Accept either key name — whichever is set in Railway
      // In production, at least one key MUST be set (no fallback)
      secretKey:    optional('API_SECRET_KEY', null) ||
                    optional('API_KEY',         null) ||
                    optional('DASHBOARD_API_KEY', null) ||
                    (optional('NODE_ENV', 'development') === 'production'
                      ? (() => { throw new Error('API_SECRET_KEY is required in production'); })()
                      : 'dev-local-only'),
      dashboardUrl: optional('DASHBOARD_URL', 'http://localhost:5173'),
    },

    logging: {
      level:         optional('LOG_LEVEL', 'info'),
      retentionDays: optionalInt('LOG_RETENTION_DAYS', 7),
    },

    helius: {
      webhookSecret:  optional('HELIUS_WEBHOOK_SECRET', null),
      webhookPath:    '/webhook/helius',
      webhookBaseUrl: optional('WEBHOOK_BASE_URL', 'https://solsystems.up.railway.app'),
    },

    jito: {
      enabled:        optionalBool('USE_JITO_BUNDLES', true),
      blockEngineUrl: optional('JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf'),
      tipLamports:    optionalInt('JITO_TIP_LAMPORTS', 10000), // 0.00001 SOL default
      maxTipLamports: optionalInt('JITO_MAX_TIP_LAMPORTS', 100000), // 0.0001 SOL cap
    },

  };

  // ── Post-load validation ────────────────────────────────────

  if (config.trading.maxPositionPct <= 0 || config.trading.maxPositionPct > 1) {
    console.error(`\n\n  ❌ INVALID MAX_POSITION_PCT: "${config.trading.maxPositionPct}" — must be 0.01–1.0\n`);
    process.exit(1);
  }

  if (config.trading.myCapitalSOL <= 0) {
    console.error(`\n\n  ❌ INVALID MY_STARTING_CAPITAL_SOL: "${config.trading.myCapitalSOL}" — must be > 0\n`);
    process.exit(1);
  }

  if (config.jupiter.slippageBps < 0 || config.jupiter.slippageBps > 5000) {
    console.error(`\n\n  ❌ INVALID JUPITER_SLIPPAGE_BPS: "${config.jupiter.slippageBps}" — must be 0–5000\n`);
    process.exit(1);
  }

  console.log('[config] ✅ Config loaded OK');
  console.log(`[config]    ENV=${config.env.nodeEnv}  PORT=${config.env.port}  CAPITAL=${config.trading.myCapitalSOL} SOL`);

} catch (err) {
  console.error('[config] FATAL:', err.message);
  process.exit(1);
}

module.exports = Object.freeze(config);