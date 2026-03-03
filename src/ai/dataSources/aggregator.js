// ============================================================
//  SOL SYSTEMS — Wallet Data Aggregator
//  File: src/ai/dataSources/aggregator.js
//
//  Combines data from all sources (Birdeye + GMGN), deduplicates
//  wallets that appear in multiple sources, filters out bots and
//  farmers, and outputs a clean ranked candidate list.
//
//  Pipeline:
//    1. Fetch from Birdeye and GMGN in parallel
//    2. Merge wallets that appear in both sources (avg their stats)
//    3. Apply hard disqualifier filters (bots, farmers, dormant)
//    4. Score each wallet 0-100 using the research rubric
//    5. Return top N candidates sorted by score
//
//  Scoring rubric weights (from research):
//    - Daily consistency (green days)  : 30%
//    - Monthly SOL profit              : 20%
//    - Win rate                        : 20%
//    - Trade frequency                 : 10%
//    - Average hold time               : 10%
//    - Token diversity                 : 10%
//
//  Hard disqualifiers (score → 0, wallet excluded):
//    - Win rate = 0 (no calculable history)
//    - Wallet dormant > 48 hours
//    - Trades > 500/day (almost certainly a bot)
//    - Single token accounts for > 80% of trades (farmer signal)
//    - Data quality score < 30 (insufficient data)
// ============================================================

'use strict';

const birdeye = require('./birdeye');
const gmgn    = require('./gmgn');
const cielo   = require('./cielo');
const helius  = require('./helius');
const logger  = require('../../utils/logger');

const ENABLE_GMGN = process.env.ENABLE_GMGN === 'true'; // Disabled by default — no public API

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

// How many candidates to return to the AI scorer
const TOP_N = 15;

// Max wallets expected from any single data source (Birdeye/GMGN each cap at 20)
const MAX_WALLETS = 20;

// Hard disqualifier thresholds
const MIN_WIN_RATE        = 5;    // Below 5% = no usable signal
const MAX_TRADES_PER_DAY  = 500;  // Above this = bot
const MAX_DORMANT_HOURS   = 48;   // Inactive > 48h = skip
const MIN_DATA_QUALITY    = 30;   // Below 30 = not enough data
const MIN_TRADES_7D       = 3;    // Need at least 3 trades in 7 days

// Scoring weight config — must sum to 1.0
const WEIGHTS = {
  dailyConsistency: 0.30,
  monthlyProfit:    0.20,
  winRate:          0.20,
  tradeFrequency:   0.10,
  avgHoldTime:      0.10,
  tokenDiversity:   0.10,
};

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Fetch, merge, filter, score and rank wallet candidates
 * from all data sources.
 *
 * Returns the top N candidates ready for the Claude AI scorer.
 *
 * @returns {Promise<{ candidates: ScoredWallet[], dataQuality: SourceQuality }>}
 */
async function getCandidates() {
  logger.info('[Aggregator] Starting multi-source wallet fetch...');

  // ── Step 1: Fetch from all sources in parallel ────────
  const sourcePromises = [
    birdeye.getTopTraders(),
    ENABLE_GMGN ? gmgn.getTopTraders() : Promise.resolve([]),
    cielo.getTopTraders(),
    helius.getTopTraders(),
  ];

  const [birdeyeResults, gmgnResults, cieloResults, heliusResults] =
    await Promise.allSettled(sourcePromises);

  const birdeyeWallets = birdeyeResults.status === 'fulfilled'
    ? birdeyeResults.value : [];
  const gmgnWallets    = gmgnResults.status === 'fulfilled'
    ? gmgnResults.value : [];
  const cieloWallets   = cieloResults.status === 'fulfilled'
    ? cieloResults.value : [];
  const heliusWallets  = heliusResults.status === 'fulfilled'
    ? heliusResults.value : [];

  // Track data source quality for the intelligence report
  const dataQuality = {
    birdeye: _sourceQuality(birdeyeWallets),
    gmgn:    _sourceQuality(gmgnWallets),
    cielo:   _sourceQuality(cieloWallets),
    helius:  _sourceQuality(heliusWallets),
  };

  logger.info('[Aggregator] Sources fetched', {
    birdeye:  birdeyeWallets.length,
    gmgn:     gmgnWallets.length,
    cielo:    cieloWallets.length,
    helius:   heliusWallets.length,
    quality:  dataQuality,
  });

  // ── Step 2: Merge and deduplicate ─────────────────────
  const merged = _mergeAndDeduplicate([
    ...birdeyeWallets, ...gmgnWallets, ...cieloWallets, ...heliusWallets,
  ]);

  logger.info('[Aggregator] After deduplication', { count: merged.length });

  // ── Step 3: Apply hard disqualifier filters ───────────
  const filtered = merged.filter(_passesDisqualifiers);

  logger.info('[Aggregator] After disqualifier filters', {
    before: merged.length,
    after:  filtered.length,
    removed: merged.length - filtered.length,
  });

  // ── Step 4: Score each wallet ─────────────────────────
  const scored = filtered.map((wallet) => ({
    ...wallet,
    score:        _scoreWallet(wallet),
    scoreBreakdown: _scoreBreakdown(wallet),
  }));

  // ── Step 5: Sort by score descending, take top N ──────
  const ranked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  logger.info('[Aggregator] Final candidate list ready', {
    total:   scored.length,
    topN:    ranked.length,
    topScore: ranked[0]?.score || 0,
    topAddress: ranked[0]?.address?.slice(0, 8) + '...',
  });

  return { candidates: ranked, dataQuality };
}

// ────────────────────────────────────────────────────────────
//  DEDUPLICATION
// ────────────────────────────────────────────────────────────

/**
 * Merge wallets that appear in multiple sources.
 * When a wallet appears in both Birdeye and GMGN, we average
 * their stats and boost their data quality score.
 *
 * @param {Array} wallets - All wallets from all sources combined
 * @returns {Array} Deduplicated wallet list
 * @private
 */
function _mergeAndDeduplicate(wallets) {
  const map = new Map();  // address → merged wallet

  for (const wallet of wallets) {
    const addr = wallet.address;
    if (!addr) continue;

    if (!map.has(addr)) {
      // First time seeing this address — just store it
      map.set(addr, {
        ...wallet,
        sources:      [wallet.source],
        sourceCount:  1,
      });
    } else {
      // Already seen — merge stats by averaging
      const existing = map.get(addr);
      map.set(addr, {
        ...existing,
        // Average numerical fields from both sources
        pnl7dUSD:        _avg(existing.pnl7dUSD,        wallet.pnl7dUSD),
        pnl30dUSD:       _avg(existing.pnl30dUSD,       wallet.pnl30dUSD),
        winRatePct:      _avg(existing.winRatePct,      wallet.winRatePct),
        totalTrades7d:   _avg(existing.totalTrades7d,   wallet.totalTrades7d),
        totalTrades30d:  _avg(existing.totalTrades30d,  wallet.totalTrades30d),
        tradesPerDay:    _avg(existing.tradesPerDay,    wallet.tradesPerDay),
        avgHoldTimeMs:   _avg(existing.avgHoldTimeMs,   wallet.avgHoldTimeMs),
        estimatedCapSOL: _avg(existing.estimatedCapSOL, wallet.estimatedCapSOL),
        // Multi-source boosts data quality
        dataQuality:     Math.min(100, existing.dataQuality + 20),
        sources:         [...existing.sources, wallet.source],
        sourceCount:     existing.sourceCount + 1,
        // Keep smart money label if either source has one
        smartMoneyLabel: existing.smartMoneyLabel || wallet.smartMoneyLabel || null,
        // Merge token lists
        topTokens:       _mergeTokens(existing.topTokens, wallet.topTokens),
        // Use most recent lastActiveAt
        lastActiveAt:    _moreRecent(existing.lastActiveAt, wallet.lastActiveAt),
      });
    }
  }

  return Array.from(map.values());
}

// ────────────────────────────────────────────────────────────
//  HARD DISQUALIFIERS
// ────────────────────────────────────────────────────────────

/**
 * Check if a wallet passes all hard disqualifier rules.
 * Returns false if the wallet should be excluded entirely.
 *
 * @param {object} wallet
 * @returns {boolean}
 * @private
 */
function _passesDisqualifiers(wallet) {
  // Must have an address
  if (!wallet.address) return false;

  // Must have enough data to make a decision
  if (wallet.dataQuality < MIN_DATA_QUALITY) {
    logger.debug('[Aggregator] Disqualified: low data quality', {
      address: wallet.address.slice(0, 8) + '...',
      quality: wallet.dataQuality,
    });
    return false;
  }

  // Must have calculable win rate
  if (wallet.winRatePct < MIN_WIN_RATE) {
    logger.debug('[Aggregator] Disqualified: win rate too low', {
      address: wallet.address.slice(0, 8) + '...',
      winRate: wallet.winRatePct,
    });
    return false;
  }

  // Must have recent activity
  if (wallet.lastActiveAt) {
    const hoursSince = (Date.now() - new Date(wallet.lastActiveAt).getTime())
      / (1000 * 60 * 60);
    if (hoursSince > MAX_DORMANT_HOURS) {
      logger.debug('[Aggregator] Disqualified: dormant wallet', {
        address:    wallet.address.slice(0, 8) + '...',
        hoursSince: Math.round(hoursSince),
      });
      return false;
    }
  }

  // Must have minimum trade activity
  if (wallet.totalTrades7d < MIN_TRADES_7D) {
    logger.debug('[Aggregator] Disqualified: insufficient trades', {
      address: wallet.address.slice(0, 8) + '...',
      trades7d: wallet.totalTrades7d,
    });
    return false;
  }

  // Bot detection: too many trades per day
  if (wallet.tradesPerDay > MAX_TRADES_PER_DAY) {
    logger.debug('[Aggregator] Disqualified: likely bot', {
      address:     wallet.address.slice(0, 8) + '...',
      tradesPerDay: wallet.tradesPerDay,
    });
    return false;
  }

  // Farmer detection: trades concentrated in very few tokens
  // A human trader diversifies; a farmer spams one token
  if (wallet.topTokens && wallet.topTokens.length === 1 && wallet.totalTrades7d > 20) {
    logger.debug('[Aggregator] Disqualified: single-token farmer', {
      address: wallet.address.slice(0, 8) + '...',
    });
    return false;
  }

  return true;
}

// ────────────────────────────────────────────────────────────
//  SCORING ENGINE
// ────────────────────────────────────────────────────────────

/**
 * Score a wallet from 0-100 using the research rubric.
 *
 * @param {object} wallet
 * @returns {number} Score 0-100
 * @private
 */
function _scoreWallet(wallet) {
  const breakdown = _scoreBreakdown(wallet);
  const score = (
    breakdown.dailyConsistency * WEIGHTS.dailyConsistency +
    breakdown.monthlyProfit    * WEIGHTS.monthlyProfit    +
    breakdown.winRate          * WEIGHTS.winRate          +
    breakdown.tradeFrequency   * WEIGHTS.tradeFrequency   +
    breakdown.avgHoldTime      * WEIGHTS.avgHoldTime      +
    breakdown.tokenDiversity   * WEIGHTS.tokenDiversity
  );

  // Multi-source bonus: wallet appearing in multiple sources
  // gets up to +5 bonus points (cross-validated = more reliable)
  const sourceBonus = (wallet.sourceCount || 1) > 1 ? 5 : 0;

  // Smart money bonus: GMGN labels this as insider/smart money
  const smartBonus  = wallet.smartMoneyLabel ? 3 : 0;

  return Math.min(100, Math.round(score + sourceBonus + smartBonus));
}

/**
 * Calculate the raw score for each dimension (0-100 each).
 * These are the un-weighted component scores.
 *
 * @param {object} wallet
 * @returns {object} Score breakdown per dimension
 * @private
 */
function _scoreBreakdown(wallet) {
  return {
    // Daily consistency — proxy from win rate + frequency
    // We don't have direct "days green" data from APIs
    // so we estimate: high win rate + steady trades ≈ consistent days
    dailyConsistency: _scoreDailyConsistency(wallet),

    // Monthly profit in SOL-equivalent
    monthlyProfit: _scoreMonthlyProfit(wallet),

    // Raw win rate
    winRate: _scoreWinRate(wallet),

    // Trade frequency — optimal is 5-30/day (human scalper range)
    tradeFrequency: _scoreTradeFrequency(wallet),

    // Average hold time — optimal for copy trading is 5min-4hrs
    avgHoldTime: _scoreAvgHoldTime(wallet),

    // Token diversity — not too concentrated, not too scattered
    tokenDiversity: _scoreTokenDiversity(wallet),
  };
}

/** Daily consistency score (0-100). */
function _scoreDailyConsistency(wallet) {
  // Estimate from win rate + trade regularity
  const wr = wallet.winRatePct || 0;
  const tpd = wallet.tradesPerDay || 0;

  // High win rate = more green days
  const wrScore = wr >= 80 ? 100
    : wr >= 70 ? 85
    : wr >= 65 ? 70
    : wr >= 60 ? 50
    : wr >= 50 ? 30
    : 10;

  // Regular daily activity = more consistent
  const actScore = tpd >= 5 && tpd <= 30 ? 100
    : tpd >= 1 && tpd < 5  ? 60
    : tpd > 30 && tpd <= 100 ? 70
    : 30;

  return Math.round((wrScore * 0.7) + (actScore * 0.3));
}

/** Monthly profit score (0-100). */
function _scoreMonthlyProfit(wallet) {
  // Use 30d PnL if available, else extrapolate from 7d
  const pnl30d = wallet.pnl30dUSD > 0
    ? wallet.pnl30dUSD
    : (wallet.pnl7dUSD || 0) * 4.3;

  if (pnl30d >= 100_000) return 100;
  if (pnl30d >= 50_000)  return 85;
  if (pnl30d >= 20_000)  return 70;
  if (pnl30d >= 5_000)   return 55;
  if (pnl30d >= 1_000)   return 40;
  if (pnl30d >= 100)     return 25;
  return 10;
}

/** Win rate score (0-100). */
function _scoreWinRate(wallet) {
  const wr = wallet.winRatePct || 0;
  if (wr >= 80) return 100;
  if (wr >= 70) return 80;
  if (wr >= 65) return 60;
  if (wr >= 60) return 40;
  if (wr >= 50) return 20;
  return 0;
}

/** Trade frequency score (0-100). Optimal = 5-30/day. */
function _scoreTradeFrequency(wallet) {
  const tpd = wallet.tradesPerDay || 0;
  if (tpd >= 5  && tpd <= 30)  return 100;  // Optimal human scalper range
  if (tpd >= 30 && tpd <= 100) return 70;   // High frequency, still copyable
  if (tpd >= 1  && tpd < 5)    return 50;   // Swing trader — fewer signals
  if (tpd > 100)                return 60;   // Likely bot but still trackable
  return 0;
}

/** Average hold time score (0-100). Optimal = 5min-4hrs. */
function _scoreAvgHoldTime(wallet) {
  const holdMs = wallet.avgHoldTimeMs || 0;
  const holdMin = holdMs / (1000 * 60);

  if (holdMin >= 5   && holdMin <= 240) return 100;  // 5min-4hrs optimal
  if (holdMin >= 1   && holdMin < 5)    return 60;   // Very fast — hard to copy
  if (holdMin >= 240 && holdMin <= 1440) return 70;  // 4-24hrs — swing
  if (holdMin > 1440)                   return 30;   // Multi-day hold
  if (holdMin === 0)                    return 50;   // Unknown hold time
  return 20;
}

/** Token diversity score (0-100). Optimal = 10-50 unique tokens/month. */
function _scoreTokenDiversity(wallet) {
  const unique = wallet.topTokens?.length || 0;
  // We only have top 5 tokens — scale accordingly
  if (unique >= 4) return 100;   // 4-5 different top tokens = diversified
  if (unique === 3) return 75;
  if (unique === 2) return 50;
  if (unique === 1) return 20;   // Concentrated — farmer risk
  return 40;                     // Unknown
}

// ────────────────────────────────────────────────────────────
//  DATA QUALITY ASSESSMENT
// ────────────────────────────────────────────────────────────

/**
 * Calculate overall quality score for a data source (0-100).
 * Based on how many wallets were returned and their avg data quality.
 *
 * @param {Array} wallets
 * @returns {number}
 * @private
 */
function _sourceQuality(wallets) {
  if (!wallets || wallets.length === 0) return 0;

  const avgQuality = wallets.reduce((s, w) => s + (w.dataQuality || 0), 0)
    / wallets.length;
  const countScore = Math.min(100, (wallets.length / MAX_WALLETS) * 100);

  return Math.round((avgQuality * 0.7) + (countScore * 0.3));
}

// ────────────────────────────────────────────────────────────
//  UTILITY HELPERS
// ────────────────────────────────────────────────────────────

/** Average two numbers, handling zeros gracefully. */
function _avg(a, b) {
  const na = parseFloat(a) || 0;
  const nb = parseFloat(b) || 0;
  if (na === 0) return nb;
  if (nb === 0) return na;
  return (na + nb) / 2;
}

/** Return the more recent of two dates. */
function _moreRecent(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

/** Merge two token arrays, deduplicating, up to 5 entries. */
function _mergeTokens(a, b) {
  return [...new Set([...(a || []), ...(b || [])])].slice(0, 5);
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  getCandidates,
};