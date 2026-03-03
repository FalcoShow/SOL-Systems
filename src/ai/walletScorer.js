// ============================================================
//  SOL SYSTEMS — AI Wallet Scorer
//  File: src/ai/walletScorer.js
//
//  The brain of the nightly intelligence system.
//  Takes the aggregator's candidate list + current capital
//  and calls the Claude AI API to produce:
//
//    1. Final wallet selection (3-5 wallets)
//    2. Exact SOL allocation per wallet
//    3. Active tracking time windows (when to copy)
//    4. Risk notes per wallet
//    5. A short Telegram summary
//    6. A full HTML report for the dashboard
//
//  Claude model: claude-sonnet-4-6
//  The prompt is carefully engineered to output strict JSON
//  so we can parse and act on it programmatically.
//
//  Output shape:
//  {
//    wallets: [
//      {
//        address:       string,
//        nickname:      string,
//        score:         number,
//        allocationPct: number,    // % of total capital to allocate
//        allocationSOL: number,    // Exact SOL amount
//        trackFrom:     string,    // e.g. "08:00 UTC"
//        trackUntil:    string,    // e.g. "16:00 UTC"
//        tradingStyle:  string,    // e.g. "Scalper", "Swing"
//        winRatePct:    number,
//        pnl30dUSD:     number,
//        riskNotes:     string[],
//        reasoning:     string,
//      }
//    ],
//    summary:        string,  // 3-4 sentence overview
//    totalAllocated: number,  // SOL allocated to AI wallets
//    reservedSOL:    number,  // Capital kept in reserve
//    confidence:     number,  // AI's confidence in this set 0-100
//  }
// ============================================================

'use strict';

const config = require('../config');
const logger = require('../utils/logger');

// ────────────────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────────────────

const CLAUDE_API_URL   = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL     = 'claude-sonnet-4-6';
const MAX_TOKENS       = 4096;
const REQUEST_TIMEOUT  = 60_000;   // 60s — AI calls can be slow

// Allocation rules baked into the prompt
const MIN_WALLETS      = 3;
const MAX_WALLETS      = 5;
const RESERVE_PCT      = 0.15;     // Always keep 15% of capital in reserve
const MAX_SINGLE_ALLOC = 0.40;     // No single wallet gets > 40% of capital
const MIN_SINGLE_ALLOC = 0.10;     // No wallet gets < 10% — not worth tracking

// ────────────────────────────────────────────────────────────
//  MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Run the AI wallet scoring and selection pipeline.
 *
 * @param {object}   params
 * @param {Array}    params.candidates  - Scored candidates from aggregator
 * @param {number}   params.capitalSOL  - Current bot capital in SOL
 * @param {string}   params.forDate     - Date string: "2026-03-03"
 * @param {object}   params.dataQuality - Source quality scores
 * @returns {Promise<AIReport>}
 */
async function runScoring({ candidates, capitalSOL, forDate, dataQuality }) {
  logger.info('[WalletScorer] Starting AI scoring pipeline...', {
    candidates: candidates.length,
    capitalSOL,
    forDate,
  });

  if (!candidates || candidates.length === 0) {
    logger.warn('[WalletScorer] No candidates to score — returning empty report');
    return _emptyReport(forDate, capitalSOL);
  }

  try {
    // ── Build the prompt ──────────────────────────────────
    const prompt = _buildPrompt(candidates, capitalSOL, forDate, dataQuality);

    // ── Call Claude API ───────────────────────────────────
    logger.info('[WalletScorer] Calling Claude API...');
    const rawResponse = await _callClaude(prompt);

    // ── Parse the JSON response ───────────────────────────
    const report = _parseResponse(rawResponse, candidates, capitalSOL, forDate);

    // ── Build formatted outputs ───────────────────────────
    report.telegramSummary = _buildTelegramSummary(report, forDate, capitalSOL);
    report.htmlReport      = _buildHtmlReport(report, forDate, capitalSOL, dataQuality);

    logger.info('[WalletScorer] AI scoring complete', {
      walletsSelected: report.wallets.length,
      confidence:      report.confidence,
      totalAllocated:  report.totalAllocated,
    });

    return report;

  } catch (err) {
    logger.error('[WalletScorer] AI scoring failed', { error: err.message });
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
//  PROMPT ENGINEERING
// ────────────────────────────────────────────────────────────

/**
 * Build the full Claude prompt with candidate data injected.
 * The prompt is engineered to produce strict JSON output.
 *
 * @param {Array}  candidates
 * @param {number} capitalSOL
 * @param {string} forDate
 * @param {object} dataQuality
 * @returns {string}
 * @private
 */
function _buildPrompt(candidates, capitalSOL, forDate, dataQuality) {
  const reserveSOL    = capitalSOL * RESERVE_PCT;
  const deployableSOL = capitalSOL - reserveSOL;
  const dateObj       = new Date(forDate + 'T00:00:00Z');
  const dayName       = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  // Format candidates for the prompt — only send fields the AI needs
  const candidateData = candidates.map((c, i) => ({
    rank:           i + 1,
    address:        c.address,
    score:          c.score,
    scoreBreakdown: c.scoreBreakdown,
    winRatePct:     c.winRatePct,
    pnl7dUSD:       Math.round(c.pnl7dUSD || 0),
    pnl30dUSD:      Math.round(c.pnl30dUSD || 0),
    tradesPerDay:   c.tradesPerDay,
    avgHoldTimeMin: Math.round((c.avgHoldTimeMs || 0) / 60000),
    estimatedCapSOL: c.estimatedCapSOL,
    topTokenCount:  (c.topTokens || []).length,
    sources:        c.sources || [c.source],
    sourceCount:    c.sourceCount || 1,
    smartMoneyLabel: c.smartMoneyLabel || null,
    lastActiveMinsAgo: c.lastActiveAt
      ? Math.round((Date.now() - new Date(c.lastActiveAt).getTime()) / 60000)
      : null,
  }));

  return `You are an expert Solana copy trading analyst. Your job is to select the best 3-5 wallets to copy trade tomorrow and provide exact capital allocation and time windows.

## TRADING OBJECTIVE
- Goal: Maximum daily green PnL with highest possible ROI
- Starting capital for tomorrow: ${deployableSOL.toFixed(4)} SOL (${capitalSOL.toFixed(4)} SOL total, ${reserveSOL.toFixed(4)} SOL kept in reserve)
- Date: ${dayName}
- Priority: Never a red day. Consistent compounding. Highest win rate.

## ALLOCATION RULES (MUST FOLLOW)
- Select between ${MIN_WALLETS} and ${MAX_WALLETS} wallets
- Total allocations must sum to exactly 100% of deployable capital (${deployableSOL.toFixed(4)} SOL)
- No single wallet allocation above ${MAX_SINGLE_ALLOC * 100}% (max ${(deployableSOL * MAX_SINGLE_ALLOC).toFixed(4)} SOL)
- No single wallet allocation below ${MIN_SINGLE_ALLOC * 100}% (min ${(deployableSOL * MIN_SINGLE_ALLOC).toFixed(4)} SOL)
- Prefer equal-weight allocations unless data strongly justifies concentration

## TIME WINDOW RULES
- Assign an active tracking window (UTC) for each wallet
- Base this on: Solana market activity patterns (peak volume 13:00-21:00 UTC)
- Scalpers (avgHoldTime < 30min, tradesPerDay > 15): Track 13:00-21:00 UTC
- Swing traders (avgHoldTime > 60min, tradesPerDay < 10): Track 08:00-20:00 UTC
- Unknown style: Track 12:00-20:00 UTC
- You may adjust windows based on wallet data if justified

## SCORING DATA
Data quality scores: Birdeye=${dataQuality.birdeye || 0}/100, GMGN=${dataQuality.gmgn || 0}/100

## CANDIDATE WALLETS (${candidates.length} pre-scored candidates)
${JSON.stringify(candidateData, null, 2)}

## REQUIRED OUTPUT FORMAT
Respond with ONLY a valid JSON object. No markdown. No explanation. No backticks. Just raw JSON.

{
  "wallets": [
    {
      "address": "full_wallet_address",
      "nickname": "short_memorable_name_max_12_chars",
      "score": 85,
      "allocationPct": 25,
      "allocationSOL": 2.125,
      "trackFrom": "13:00 UTC",
      "trackUntil": "21:00 UTC",
      "tradingStyle": "Scalper",
      "winRatePct": 74.5,
      "pnl30dUSD": 45000,
      "riskNotes": ["High trade frequency may cause slippage", "Recently active — good signal"],
      "reasoning": "2-3 sentence explanation of why this wallet was selected and why this allocation"
    }
  ],
  "summary": "3-4 sentence overview of tomorrow's strategy and expected outcomes",
  "confidence": 78,
  "totalAllocated": 8.5,
  "reservedSOL": 1.5,
  "strategyType": "balanced"
}`;
}

// ────────────────────────────────────────────────────────────
//  CLAUDE API CALL
// ────────────────────────────────────────────────────────────

/**
 * Call the Claude API with the wallet scoring prompt.
 *
 * @param {string} prompt
 * @returns {Promise<string>} Raw text response from Claude
 * @private
 */
async function _callClaude(prompt) {
  // We use node's built-in fetch (Node 18+) to avoid extra deps
  // Falls back to axios if fetch not available
  const fetchFn = globalThis.fetch || require('node-fetch');

  const body = JSON.stringify({
    model:      CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system:     'You are a Solana copy trading analyst. Always respond with raw JSON only — no markdown, no backticks, no explanation text.',
    messages: [
      { role: 'user', content: prompt },
    ],
  });

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetchFn(CLAUDE_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key':          config.anthropic.apiKey,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown');
      throw new Error(`Claude API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();

    // Extract text content from response
    const content = data?.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error('Claude API returned empty content');
    }

    const textBlock = content.find((b) => b.type === 'text');
    if (!textBlock?.text) {
      throw new Error('Claude API returned no text block');
    }

    return textBlock.text;

  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
//  RESPONSE PARSING
// ────────────────────────────────────────────────────────────

/**
 * Parse Claude's JSON response into a validated AIReport.
 * Handles cases where Claude wraps JSON in markdown fences.
 *
 * @param {string} rawText
 * @param {Array}  candidates
 * @param {number} capitalSOL
 * @param {string} forDate
 * @returns {AIReport}
 * @private
 */
function _parseResponse(rawText, candidates, capitalSOL, forDate) {
  // Strip markdown fences if Claude added them despite instructions
  let jsonStr = rawText.trim();
  jsonStr = jsonStr.replace(/^```json\s*/i, '').replace(/^```\s*/i, '');
  jsonStr = jsonStr.replace(/\s*```$/i, '');
  jsonStr = jsonStr.trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    logger.error('[WalletScorer] Failed to parse Claude response as JSON', {
      preview: jsonStr.slice(0, 200),
      error:   err.message,
    });
    // Return best-effort fallback using top candidates by score
    return _fallbackReport(candidates, capitalSOL, forDate);
  }

  // Validate and normalise the parsed response
  const wallets = (parsed.wallets || []).map((w) => {
    const deployable = capitalSOL * (1 - RESERVE_PCT);
    return {
      address:        w.address        || '',
      nickname:       (w.nickname      || _autoNickname(w.address)).slice(0, 12),
      score:          Number(w.score)  || 0,
      allocationPct:  Number(w.allocationPct) || 0,
      allocationSOL:  parseFloat(((Number(w.allocationPct) / 100) * deployable).toFixed(4)),
      trackFrom:      w.trackFrom      || '13:00 UTC',
      trackUntil:     w.trackUntil     || '21:00 UTC',
      tradingStyle:   w.tradingStyle   || 'Unknown',
      winRatePct:     Number(w.winRatePct) || 0,
      pnl30dUSD:      Number(w.pnl30dUSD)  || 0,
      riskNotes:      Array.isArray(w.riskNotes) ? w.riskNotes : [],
      reasoning:      w.reasoning      || '',
    };
  }).filter((w) => w.address && w.allocationPct > 0);

  const reserveSOL    = capitalSOL * RESERVE_PCT;
  const totalAlloc    = wallets.reduce((s, w) => s + w.allocationSOL, 0);

  return {
    forDate,
    wallets,
    summary:        parsed.summary        || 'AI analysis complete.',
    confidence:     Number(parsed.confidence) || 70,
    strategyType:   parsed.strategyType   || 'balanced',
    totalAllocated: parseFloat(totalAlloc.toFixed(4)),
    reservedSOL:    parseFloat(reserveSOL.toFixed(4)),
    capitalSOL,
  };
}

// ────────────────────────────────────────────────────────────
//  OUTPUT FORMATTERS
// ────────────────────────────────────────────────────────────

/**
 * Build the short Telegram summary message.
 * This is the message sent to you at midnight.
 *
 * @param {AIReport} report
 * @param {string}   forDate
 * @param {number}   capitalSOL
 * @returns {string}
 * @private
 */
function _buildTelegramSummary(report, forDate, capitalSOL) {
  const dateLabel = new Date(forDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });

  const walletLines = report.wallets.map((w, i) => {
    const emoji = ['🥇','🥈','🥉','4️⃣','5️⃣'][i] || '•';
    return (
      `${emoji} \`${w.address.slice(0, 8)}...\` _(${w.nickname})_\n` +
      `   • ${w.allocationPct}% = ${w.allocationSOL} SOL\n` +
      `   • Win rate: ${w.winRatePct.toFixed(1)}% | Style: ${w.tradingStyle}\n` +
      `   • Track: ${w.trackFrom} → ${w.trackUntil}`
    );
  }).join('\n\n');

  return (
    `🤖 *AI WALLET INTELLIGENCE — ${dateLabel}*\n\n` +
    `📊 Capital deployed: \`${report.totalAllocated} SOL\` of \`${capitalSOL} SOL\`\n` +
    `🔒 Reserve: \`${report.reservedSOL} SOL\`\n` +
    `🎯 Confidence: \`${report.confidence}/100\`\n\n` +
    `*Wallets for tomorrow:*\n\n` +
    walletLines + '\n\n' +
    `💬 _${report.summary}_\n\n` +
    `_Wallets auto-updated. Old wallets tracking until positions close._`
  );
}

/**
 * Build the full HTML report for the dashboard.
 * Served at /intelligence/YYYY-MM-DD
 *
 * @param {AIReport} report
 * @param {string}   forDate
 * @param {number}   capitalSOL
 * @param {object}   dataQuality
 * @returns {string}
 * @private
 */
function _buildHtmlReport(report, forDate, capitalSOL, dataQuality) {
  const dateLabel = new Date(forDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

  const walletCards = report.wallets.map((w, i) => `
    <div class="wallet-card rank-${i + 1}">
      <div class="wallet-rank">#${i + 1}</div>
      <div class="wallet-header">
        <span class="wallet-address">${w.address}</span>
        <span class="wallet-nickname">${w.nickname}</span>
        <span class="wallet-score score-badge">${w.score}/100</span>
      </div>
      <div class="wallet-stats">
        <div class="stat"><label>Allocation</label><value>${w.allocationPct}% — ${w.allocationSOL} SOL</value></div>
        <div class="stat"><label>Win Rate</label><value>${w.winRatePct.toFixed(1)}%</value></div>
        <div class="stat"><label>30d PnL</label><value>$${w.pnl30dUSD.toLocaleString()}</value></div>
        <div class="stat"><label>Style</label><value>${w.tradingStyle}</value></div>
        <div class="stat"><label>Track Window</label><value>${w.trackFrom} → ${w.trackUntil}</value></div>
      </div>
      <div class="wallet-reasoning">${w.reasoning}</div>
      ${w.riskNotes.length > 0 ? `
      <div class="risk-notes">
        <strong>⚠️ Risk Notes:</strong>
        <ul>${w.riskNotes.map((n) => `<li>${n}</li>`).join('')}</ul>
      </div>` : ''}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SOL Systems Intelligence — ${forDate}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0a0a0f; color: #e2e8f0; padding: 24px; }
    .header { border-bottom: 1px solid #1e2d3d; padding-bottom: 20px; margin-bottom: 28px; }
    .header h1 { font-size: 24px; color: #7dd3fc; }
    .header .date { color: #94a3b8; font-size: 14px; margin-top: 4px; }
    .meta-bar { display: flex; gap: 24px; margin-bottom: 28px; flex-wrap: wrap; }
    .meta-stat { background: #111827; border: 1px solid #1e2d3d; border-radius: 8px;
                 padding: 12px 20px; }
    .meta-stat label { font-size: 11px; color: #64748b; text-transform: uppercase;
                       letter-spacing: 0.05em; display: block; }
    .meta-stat value { font-size: 20px; font-weight: 600; color: #7dd3fc; }
    .summary { background: #111827; border-left: 3px solid #7dd3fc; border-radius: 4px;
               padding: 16px 20px; margin-bottom: 28px; color: #cbd5e1; line-height: 1.6; }
    .wallet-card { background: #111827; border: 1px solid #1e2d3d; border-radius: 12px;
                   padding: 24px; margin-bottom: 20px; }
    .wallet-card.rank-1 { border-color: #fbbf24; }
    .wallet-card.rank-2 { border-color: #94a3b8; }
    .wallet-card.rank-3 { border-color: #cd7c2f; }
    .wallet-rank { font-size: 12px; color: #64748b; margin-bottom: 8px; }
    .wallet-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
                     flex-wrap: wrap; }
    .wallet-address { font-family: monospace; font-size: 13px; color: #94a3b8; }
    .wallet-nickname { font-size: 16px; font-weight: 600; color: #e2e8f0; }
    .score-badge { background: #1e3a2f; color: #4ade80; border-radius: 6px;
                   padding: 3px 10px; font-size: 13px; font-weight: 600; margin-left: auto; }
    .wallet-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
                    gap: 12px; margin-bottom: 16px; }
    .stat label { font-size: 11px; color: #64748b; text-transform: uppercase;
                  letter-spacing: 0.05em; display: block; }
    .stat value { font-size: 15px; color: #e2e8f0; font-weight: 500; }
    .wallet-reasoning { font-size: 14px; color: #94a3b8; line-height: 1.6;
                        margin-bottom: 12px; }
    .risk-notes { background: #1a1209; border: 1px solid #78350f; border-radius: 6px;
                  padding: 12px 16px; }
    .risk-notes strong { color: #fbbf24; font-size: 13px; }
    .risk-notes ul { margin-top: 6px; padding-left: 16px; }
    .risk-notes li { font-size: 13px; color: #d97706; margin-top: 4px; }
    .data-quality { margin-top: 32px; padding-top: 20px;
                    border-top: 1px solid #1e2d3d; }
    .dq-label { font-size: 12px; color: #64748b; margin-bottom: 8px; }
    .dq-bar { display: flex; gap: 12px; }
    .dq-source { font-size: 12px; color: #94a3b8; }
    footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #1e2d3d;
             font-size: 12px; color: #475569; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🤖 SOL Systems — AI Wallet Intelligence</h1>
    <div class="date">${dateLabel} • Generated at midnight UTC</div>
  </div>

  <div class="meta-bar">
    <div class="meta-stat"><label>Capital Deployed</label><value>${report.totalAllocated} SOL</value></div>
    <div class="meta-stat"><label>Reserve</label><value>${report.reservedSOL} SOL</value></div>
    <div class="meta-stat"><label>Wallets Selected</label><value>${report.wallets.length}</value></div>
    <div class="meta-stat"><label>AI Confidence</label><value>${report.confidence}/100</value></div>
    <div class="meta-stat"><label>Strategy</label><value>${report.strategyType}</value></div>
  </div>

  <div class="summary">${report.summary}</div>

  <h2 style="margin-bottom:16px;color:#7dd3fc;font-size:18px;">
    Selected Wallets for ${forDate}
  </h2>
  ${walletCards}

  <div class="data-quality">
    <div class="dq-label">DATA SOURCE QUALITY</div>
    <div class="dq-bar">
      <span class="dq-source">Birdeye: ${dataQuality.birdeye || 0}/100</span>
      <span class="dq-source">GMGN: ${dataQuality.gmgn || 0}/100</span>
    </div>
  </div>

  <footer>Generated by SOL Systems AI Intelligence Engine •
    ${new Date().toISOString()} • claude-sonnet-4-6</footer>
</body>
</html>`;
}

// ────────────────────────────────────────────────────────────
//  FALLBACK REPORTS
// ────────────────────────────────────────────────────────────

/**
 * Fallback report when AI call fails.
 * Uses top 3 candidates by score with equal allocation.
 *
 * @param {Array}  candidates
 * @param {number} capitalSOL
 * @param {string} forDate
 * @returns {AIReport}
 * @private
 */
function _fallbackReport(candidates, capitalSOL, forDate) {
  logger.warn('[WalletScorer] Using fallback report (top 3 by score)');

  const deployable  = capitalSOL * (1 - RESERVE_PCT);
  const top3        = candidates.slice(0, 3);
  const allocPct    = Math.floor(100 / top3.length);

  const wallets = top3.map((c) => ({
    address:       c.address,
    nickname:      _autoNickname(c.address),
    score:         c.score,
    allocationPct: allocPct,
    allocationSOL: parseFloat(((allocPct / 100) * deployable).toFixed(4)),
    trackFrom:     '13:00 UTC',
    trackUntil:    '21:00 UTC',
    tradingStyle:  'Unknown',
    winRatePct:    c.winRatePct || 0,
    pnl30dUSD:     c.pnl30dUSD || 0,
    riskNotes:     ['AI analysis unavailable — using score-based fallback'],
    reasoning:     'Selected as top scorer by aggregator scoring rubric.',
  }));

  const reserveSOL   = capitalSOL * RESERVE_PCT;
  const totalAlloc   = wallets.reduce((s, w) => s + w.allocationSOL, 0);
  const report       = {
    forDate,
    wallets,
    summary:        'AI analysis failed. Using top-scored candidates as fallback.',
    confidence:     40,
    strategyType:   'fallback',
    totalAllocated: parseFloat(totalAlloc.toFixed(4)),
    reservedSOL:    parseFloat(reserveSOL.toFixed(4)),
    capitalSOL,
  };

  report.telegramSummary = _buildTelegramSummary(report, forDate, capitalSOL);
  report.htmlReport      = _buildHtmlReport(report, forDate, capitalSOL, {});
  return report;
}

/** Empty report when there are no candidates at all. */
function _emptyReport(forDate, capitalSOL) {
  const report = {
    forDate,
    wallets:        [],
    summary:        'No wallet candidates found. Data sources may be unavailable.',
    confidence:     0,
    strategyType:   'none',
    totalAllocated: 0,
    reservedSOL:    capitalSOL,
    capitalSOL,
    telegramSummary: `⚠️ *AI Intelligence — No Candidates Found*\n\nData sources returned no results for ${forDate}. All capital held in reserve. Continuing to copy existing wallets.`,
    htmlReport:     `<html><body style="background:#0a0a0f;color:#e2e8f0;padding:40px;font-family:sans-serif"><h1>No candidates found for ${forDate}</h1></body></html>`,
  };
  return report;
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Generate a short nickname from a wallet address.
 * e.g. "7xKXtg2C" → "Wallet-7xKX"
 */
function _autoNickname(address) {
  if (!address) return 'Unknown';
  return 'W-' + address.slice(0, 6);
}

// ────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  runScoring,
};