// ============================================================
//  SOL SYSTEMS — Positions Page
//  File: dashboard/src/pages/Positions.jsx
//
//  Live open positions with:
//    - Card for each token currently held
//    - Entry price, current price, unrealized PnL
//    - Hold time counter (updates every second)
//    - SOL invested, token amount
//    - Copied from wallet nickname
//    - Solscan link to entry transaction
//    - Summary totals bar at top
// ============================================================

import { useState, useEffect } from "react";
import { useApp } from "../App.jsx";

const SOLSCAN_TX    = "https://solscan.io/tx/";
const SOLSCAN_TOKEN = "https://solscan.io/token/";

// ────────────────────────────────────────────────────────────
//  HELPERS  (defined at top so all components can use them)
// ────────────────────────────────────────────────────────────

function fmtPrice(price) {
  if (!price || price === 0) return "0";
  if (price >= 1)        return price.toFixed(4);
  if (price >= 0.001)    return price.toFixed(6);
  if (price >= 0.000001) return price.toFixed(9);
  return price.toExponential(4);
}

function fmtTokens(n) {
  if (!n || n === 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + "K";
  return n.toFixed(2);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ────────────────────────────────────────────────────────────
//  HOLD TIMER — updates every second
// ────────────────────────────────────────────────────────────

function useHoldTime(openedAt) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!openedAt) return;
    const start = new Date(openedAt).getTime();
    const tick  = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [openedAt]);

  return elapsed;
}

// ────────────────────────────────────────────────────────────
//  PNL BAR — visual fill showing % return
// ────────────────────────────────────────────────────────────

function PnLBar({ pct }) {
  const clamped = Math.min(Math.max(pct || 0, -100), 100);
  const isPos   = clamped >= 0;
  const fillPct = Math.abs(clamped);

  return (
    <div className="pnl-bar-track">
      <div
        className={`pnl-bar-fill ${isPos ? "pos" : "neg"}`}
        style={{ width: `${fillPct}%` }}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  POSITION CARD
// ────────────────────────────────────────────────────────────

function PositionCard({ position }) {
  // Support both camelCase variants the backend may return
  const openedAt     = position.openedAt     || position.entryTime || position.confirmedAt;
  const elapsed      = useHoldTime(openedAt);

  const pnlSOL       = position.unrealizedPnLSOL  ?? position.unrealizedPnlSOL  ?? 0;
  const pnlPct       = position.unrealizedPnLPct  ?? position.unrealizedPnlPct  ?? 0;
  const entrySOL     = position.entryAmountSOL     ?? 0;
  const entryPrice   = position.entryPriceSOL      ?? 0;
  const currentPrice = position.currentPriceSOL    ?? 0;
  const pnlSign      = pnlSOL >= 0 ? "+" : "";
  const isPos        = pnlSOL >= 0;
  const wallet       = position.copiedFrom || position.trackedWalletNickname || "—";
  const token        = position.token || position.tokenSymbol || "???";
  const tokenMint    = position.tokenMint || "";
  const txSig        = position.entryTxSignature || position.txSignature || "";
  const tokens       = position.tokenAmount ?? position.amountTokens ?? 0;

  return (
    <div className={`pos-card ${isPos ? "pos-card--up" : "pos-card--down"}`}>

      {/* Header row */}
      <div className="pos-card__header">
        <div className="pos-card__token-info">
          <span className="pos-card__symbol">
            {tokenMint
              ? <a href={SOLSCAN_TOKEN + tokenMint} target="_blank" rel="noreferrer"
                   className="token-link">{token}</a>
              : token
            }
          </span>
          <span className="pos-card__wallet">via {wallet}</span>
        </div>
        <div className="pos-card__pnl-block">
          <span className={`pos-card__pnl-pct ${isPos ? "pos" : "neg"}`}>
            {pnlSign}{pnlPct.toFixed(2)}%
          </span>
          <span className={`pos-card__pnl-sol ${isPos ? "pos" : "neg"}`}>
            {pnlSign}{pnlSOL.toFixed(4)} SOL
          </span>
        </div>
      </div>

      {/* PnL bar */}
      <PnLBar pct={pnlPct} />

      {/* Stats grid */}
      <div className="pos-card__stats">
        <div className="pos-stat">
          <span className="pos-stat__label">Invested</span>
          <span className="pos-stat__value">{entrySOL.toFixed(4)} SOL</span>
        </div>
        <div className="pos-stat">
          <span className="pos-stat__label">Tokens</span>
          <span className="pos-stat__value">{fmtTokens(tokens)}</span>
        </div>
        <div className="pos-stat">
          <span className="pos-stat__label">Entry price</span>
          <span className="pos-stat__value">{fmtPrice(entryPrice)} SOL</span>
        </div>
        <div className="pos-stat">
          <span className="pos-stat__label">Current price</span>
          <span className={`pos-stat__value ${
            currentPrice > entryPrice ? "pos" : currentPrice < entryPrice ? "neg" : ""
          }`}>
            {fmtPrice(currentPrice)} SOL
          </span>
        </div>
        <div className="pos-stat">
          <span className="pos-stat__label">Holding for</span>
          <span className="pos-stat__value pos-stat__value--timer">
            {formatDuration(elapsed)}
          </span>
        </div>
        <div className="pos-stat">
          <span className="pos-stat__label">Entry TX</span>
          <span className="pos-stat__value">
            {txSig
              ? <a href={SOLSCAN_TX + txSig} target="_blank" rel="noreferrer"
                   className="tx-link-sm">
                  {txSig.slice(0, 8)}…
                </a>
              : "—"
            }
          </span>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  SUMMARY BAR
// ────────────────────────────────────────────────────────────

function SummaryBar({ positions }) {
  const totalInvested   = positions.reduce((s, p) => s + (p.entryAmountSOL ?? 0), 0);
  const totalUnrealized = positions.reduce((s, p) =>
    s + (p.unrealizedPnLSOL ?? p.unrealizedPnlSOL ?? 0), 0);
  const totalPct = totalInvested > 0
    ? (totalUnrealized / totalInvested) * 100 : 0;
  const wins  = positions.filter(p =>
    (p.unrealizedPnLSOL ?? p.unrealizedPnlSOL ?? 0) > 0).length;
  const sign  = totalUnrealized >= 0 ? "+" : "";
  const isPos = totalUnrealized >= 0;

  return (
    <div className="pos-summary">
      <div className="pos-summary__item">
        <span className="pos-summary__label">Open Positions</span>
        <span className="pos-summary__value">{positions.length}</span>
      </div>
      <div className="pos-summary__item">
        <span className="pos-summary__label">Total Invested</span>
        <span className="pos-summary__value">{totalInvested.toFixed(4)} SOL</span>
      </div>
      <div className="pos-summary__item">
        <span className="pos-summary__label">Unrealized PnL</span>
        <span className={`pos-summary__value ${isPos ? "pos" : "neg"}`}>
          {sign}{totalUnrealized.toFixed(4)} SOL
        </span>
      </div>
      <div className="pos-summary__item">
        <span className="pos-summary__label">Avg Return</span>
        <span className={`pos-summary__value ${isPos ? "pos" : "neg"}`}>
          {sign}{totalPct.toFixed(2)}%
        </span>
      </div>
      <div className="pos-summary__item">
        <span className="pos-summary__label">In profit</span>
        <span className="pos-summary__value pos">{wins} / {positions.length}</span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  POSITIONS PAGE
// ────────────────────────────────────────────────────────────

export default function Positions() {
  const { positions, wsStatus, refresh } = useApp();

  // Auto-refresh every 30s to get updated prices
  useEffect(() => {
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="positions-page fade-in">

      {positions.length > 0 && <SummaryBar positions={positions} />}

      {positions.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: "60px 20px" }}>
            <span className="empty-icon">◉</span>
            <span className="empty-text">No Open Positions</span>
            <span style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", maxWidth: 300 }}>
              Positions appear here after a tracked wallet buys a token and
              the bot copies the trade.
            </span>
            <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <span className={`ws-micro ws-micro--${wsStatus}`}>
                {wsStatus === "connected" ? "● LIVE" : "○ " + wsStatus.toUpperCase()}
              </span>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                — monitoring for trades
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="pos-grid">
          {positions.map((pos, i) => (
            <PositionCard
              key={pos.tokenMint || pos.id || pos.token || i}
              position={pos}
            />
          ))}
        </div>
      )}

      <style>{`
        .positions-page { display: flex; flex-direction: column; gap: 16px; }

        /* summary bar */
        .pos-summary {
          display: flex; flex-wrap: wrap; gap: 0;
          background: var(--bg2); border: 1px solid var(--border);
        }
        .pos-summary__item {
          flex: 1; min-width: 140px;
          padding: 14px 20px;
          border-right: 1px solid var(--border);
          display: flex; flex-direction: column; gap: 4px;
        }
        .pos-summary__item:last-child { border-right: none; }
        .pos-summary__label { font-size: 9px; color: var(--muted);
          letter-spacing: 0.12em; text-transform: uppercase; }
        .pos-summary__value { font-size: 18px; font-weight: 700;
          font-family: var(--font-mono); }
        .pos-summary__value.pos { color: var(--pos); }
        .pos-summary__value.neg { color: var(--neg); }

        /* card grid */
        .pos-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 12px;
        }

        /* position card */
        .pos-card {
          background: var(--bg2); border: 1px solid var(--border);
          padding: 18px; display: flex; flex-direction: column; gap: 12px;
          transition: border-color 0.2s;
          animation: fadeIn 0.3s ease forwards;
        }
        .pos-card--up   { border-top: 2px solid var(--pos); }
        .pos-card--down { border-top: 2px solid var(--neg); }
        .pos-card:hover { border-color: var(--border2); }

        .pos-card__header {
          display: flex; justify-content: space-between; align-items: flex-start;
        }
        .pos-card__token-info { display: flex; flex-direction: column; gap: 3px; }
        .pos-card__symbol {
          font-family: var(--font-sans); font-size: 18px; font-weight: 800;
          letter-spacing: 0.02em;
        }
        .pos-card__wallet { font-size: 10px; color: var(--muted); letter-spacing: 0.08em; }

        .pos-card__pnl-block { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
        .pos-card__pnl-pct  { font-size: 22px; font-weight: 700;
          font-family: var(--font-mono); line-height: 1; }
        .pos-card__pnl-sol  { font-size: 12px; font-weight: 500;
          font-family: var(--font-mono); }

        /* pnl bar */
        .pnl-bar-track {
          height: 3px; background: var(--border2); border-radius: 2px; overflow: hidden;
        }
        .pnl-bar-fill {
          height: 100%; border-radius: 2px; transition: width 0.5s ease;
        }
        .pnl-bar-fill.pos { background: var(--pos); }
        .pnl-bar-fill.neg { background: var(--neg); }

        /* stats grid */
        .pos-card__stats {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          gap: 10px 8px;
        }
        .pos-stat { display: flex; flex-direction: column; gap: 2px; }
        .pos-stat__label {
          font-size: 9px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase;
        }
        .pos-stat__value { font-size: 11px; font-weight: 500; font-family: var(--font-mono); }
        .pos-stat__value--timer { color: var(--accent2); font-weight: 700; }

        .token-link { color: var(--text); text-decoration: none; }
        .token-link:hover { color: var(--accent); }
        .tx-link-sm {
          color: var(--accent2); text-decoration: none; font-size: 11px;
          font-family: var(--font-mono);
        }
        .tx-link-sm:hover { text-decoration: underline; }

        .ws-micro { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; }
        .ws-micro--connected    { color: var(--pos); }
        .ws-micro--reconnecting { color: var(--warn); }
        .ws-micro--error        { color: var(--neg); }
        .ws-micro--connecting   { color: var(--muted); }
      `}</style>
    </div>
  );
}