// ============================================================
//  SOL SYSTEMS — Trades Page
//  File: dashboard/src/pages/Trades.jsx
//
//  Full paginated trade history with filters:
//    - Type: ALL / BUY / SELL
//    - Result: ALL / WIN / LOSS
//    - Wallet: dropdown of tracked wallets
//    - Search: token symbol
//    - Date range
//  Columns: time, token, type, wallet, SOL amount, PnL, %, speed, tx link
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../App.jsx";

const PAGE_SIZE = 25;
const SOLSCAN   = "https://solscan.io/tx/";

// ────────────────────────────────────────────────────────────
//  FILTERS BAR
// ────────────────────────────────────────────────────────────

function FiltersBar({ filters, onChange, wallets }) {
  return (
    <div className="filters-bar">

      {/* Type */}
      <select
        value={filters.tradeType}
        onChange={e => onChange({ ...filters, tradeType: e.target.value, page: 0 })}
        style={{ width: 100 }}
      >
        <option value="">All types</option>
        <option value="BUY">BUY</option>
        <option value="SELL">SELL</option>
      </select>

      {/* Result */}
      <select
        value={filters.result}
        onChange={e => onChange({ ...filters, result: e.target.value, page: 0 })}
        style={{ width: 110 }}
      >
        <option value="">All results</option>
        <option value="WIN">WIN</option>
        <option value="LOSS">LOSS</option>
      </select>

      {/* Wallet */}
      <select
        value={filters.walletAddress}
        onChange={e => onChange({ ...filters, walletAddress: e.target.value, page: 0 })}
        style={{ width: 140 }}
      >
        <option value="">All wallets</option>
        {wallets.map(w => (
          <option key={w.address} value={w.address}>
            {w.nickname || w.address.slice(0, 8) + "…"}
          </option>
        ))}
      </select>

      {/* Token search */}
      <input
        type="text"
        placeholder="Search token..."
        value={filters.search}
        onChange={e => onChange({ ...filters, search: e.target.value, page: 0 })}
        style={{ width: 140 }}
      />

      {/* Date range */}
      <input
        type="date"
        value={filters.fromDate}
        onChange={e => onChange({ ...filters, fromDate: e.target.value, page: 0 })}
        style={{ width: 140 }}
      />
      <span style={{ color: "var(--muted)", fontSize: 11 }}>→</span>
      <input
        type="date"
        value={filters.toDate}
        onChange={e => onChange({ ...filters, toDate: e.target.value, page: 0 })}
        style={{ width: 140 }}
      />

      {/* Clear */}
      <button
        className="btn btn-ghost"
        onClick={() => onChange({
          tradeType: "", result: "", walletAddress: "",
          search: "", fromDate: "", toDate: "", page: 0,
        })}
        style={{ marginLeft: "auto", padding: "6px 12px" }}
      >
        Clear
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  TRADE ROW
// ────────────────────────────────────────────────────────────

function TradeRow({ trade }) {
  const isBuy   = trade.tradeType === "BUY";
  const isSell  = trade.tradeType === "SELL";
  const isWin   = trade.isWin;
  const pnl     = trade.pnlSOL;
  const pnlSign = (pnl || 0) >= 0 ? "+" : "";
  const speedMs = trade.executionMs;
  const speedTag = !speedMs ? "—"
    : speedMs < 1000 ? "⚡"
    : speedMs < 2000 ? "✅"
    : "🐌";

  const time = (trade.confirmedAt || trade.blockTime)
    ? new Date(trade.confirmedAt || trade.blockTime).toLocaleString([], {
        month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      })
    : "—";

  // Handle both nested and flat wallet shape
  const wallet = trade.trackedWallet?.nickname
    || trade.trackedWalletNickname
    || "—";
  const token  = trade.tokenSymbol || "???";
  const solAmt = isBuy
    ? (trade.executedAmountSOL || trade.requestedAmountSOL || 0).toFixed(4)
    : (trade.executedAmountSOL || 0).toFixed(4);

  const rowClass = [
    `trade-row trade-row--${isBuy ? "buy" : "sell"}`,
    isSell && isWin ? "trade-row--win" : "",
  ].filter(Boolean).join(" ");

  return (
    <tr className={rowClass}>
      <td className="td-time">{time}</td>
      <td className="td-token">
        <span className="token-badge">{token}</span>
      </td>
      <td>
        <span className={`badge ${isBuy ? "badge-info" : isWin ? "badge-win" : "badge-loss"}`}>
          {trade.tradeType}
        </span>
      </td>
      <td className="td-wallet">{wallet}</td>
      <td className="td-sol">{solAmt} SOL</td>
      <td className="td-pnl">
        {isSell && pnl != null ? (
          <span className={pnl >= 0 ? "pos" : "neg"}>
            {pnlSign}{pnl.toFixed(4)} SOL
          </span>
        ) : "—"}
      </td>
      <td className="td-pct">
        {isSell && trade.pnlPct != null ? (
          <span className={trade.pnlPct >= 0 ? "pos" : "neg"}>
            {pnlSign}{trade.pnlPct.toFixed(1)}%
          </span>
        ) : "—"}
      </td>
      <td className="td-speed" title={speedMs ? `${speedMs}ms` : ""}>
        {speedTag} {speedMs ? `${speedMs}ms` : ""}
      </td>
      <td className="td-tx">
        {trade.txSignature ? (
          <a href={SOLSCAN + trade.txSignature} target="_blank" rel="noreferrer"
             className="tx-link">
            {trade.txSignature.slice(0, 6)}…
          </a>
        ) : (
          <span style={{ color: "var(--muted)" }}>—</span>
        )}
      </td>
    </tr>
  );
}

// ────────────────────────────────────────────────────────────
//  PAGINATION
// ────────────────────────────────────────────────────────────

function Pagination({ page, pages, total, onPage }) {
  if (pages <= 1) return null;
  const visiblePages = Array.from(
    { length: Math.min(pages, 5) },
    (_, i) => Math.max(0, Math.min(page - 2, pages - 5)) + i
  );
  return (
    <div className="pagination">
      <span className="pagination__info">
        {total} trades · page {page + 1} of {pages}
      </span>
      <div className="pagination__btns">
        <button
          className="btn btn-ghost"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          style={{ padding: "4px 12px" }}
        >
          ← Prev
        </button>
        {visiblePages.map(p => (
          <button
            key={p}
            className={`btn ${p === page ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onPage(p)}
            style={{ padding: "4px 10px", minWidth: 36 }}
          >
            {p + 1}
          </button>
        ))}
        <button
          className="btn btn-ghost"
          disabled={page >= pages - 1}
          onClick={() => onPage(page + 1)}
          style={{ padding: "4px 12px" }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  SUMMARY STRIP
// ────────────────────────────────────────────────────────────

function SummaryStrip({ trades }) {
  if (!trades.length) return null;

  const sells   = trades.filter(t => t.tradeType === "SELL" && t.pnlSOL != null);
  const netPnL  = sells.reduce((s, t) => s + (t.pnlSOL || 0), 0);
  const wins    = sells.filter(t => t.isWin).length;
  const winRate = sells.length > 0 ? ((wins / sells.length) * 100).toFixed(0) : "—";
  const sign    = netPnL >= 0 ? "+" : "";

  return (
    <div className="summary-strip">
      <div className="summary-item">
        <span className="summary-label">Showing</span>
        <span className="summary-value">{trades.length} trades</span>
      </div>
      <div className="summary-item">
        <span className="summary-label">Net PnL</span>
        <span className={`summary-value ${netPnL >= 0 ? "pos" : "neg"}`}>
          {sign}{netPnL.toFixed(4)} SOL
        </span>
      </div>
      <div className="summary-item">
        <span className="summary-label">Win Rate</span>
        <span className="summary-value">{winRate}{sells.length > 0 ? "%" : ""}</span>
      </div>
      <div className="summary-item">
        <span className="summary-label">Closed trades</span>
        <span className="summary-value">{sells.length}</span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  TRADES PAGE
// ────────────────────────────────────────────────────────────

export default function Trades() {
  const [trades,  setTrades]  = useState([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [wallets, setWallets] = useState([]);
  const [filters, setFilters] = useState({
    tradeType: "", result: "", walletAddress: "",
    search: "", fromDate: "", toDate: "", page: 0,
  });

  // Fetch wallets for filter dropdown
  useEffect(() => {
    apiFetch("/api/wallets?activeOnly=false")
      .then(r => setWallets(r.wallets || []))
      .catch(() => {});
  }, []);

  // Fetch trades when filters change
  const fetchTrades = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit:  PAGE_SIZE,
        offset: filters.page * PAGE_SIZE,
      });
      if (filters.tradeType)     params.set("tradeType",     filters.tradeType);
      if (filters.result)        params.set("result",        filters.result);
      if (filters.walletAddress) params.set("walletAddress", filters.walletAddress);
      if (filters.fromDate)      params.set("fromDate",      filters.fromDate);
      if (filters.toDate)        params.set("toDate",        filters.toDate + "T23:59:59Z");

      const data = await apiFetch(`/api/trades?${params}`);
      let rows   = data.trades || [];

      // Client-side token search (server may not support it)
      if (filters.search) {
        const q = filters.search.toLowerCase();
        rows = rows.filter(t =>
          (t.tokenSymbol || "").toLowerCase().includes(q) ||
          (t.tokenName   || "").toLowerCase().includes(q)
        );
      }

      setTrades(rows);
      setTotal(data.total || 0);
    } catch {
      setTrades([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { fetchTrades(); }, [fetchTrades]);

  const pages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="trades-page fade-in">

      <FiltersBar filters={filters} onChange={setFilters} wallets={wallets} />

      <SummaryStrip trades={trades} />

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div className="empty-state" style={{ padding: 48 }}>
            <span className="empty-icon" style={{ animation: "pulse 1s infinite" }}>◈</span>
            <span className="empty-text">Loading trades...</span>
          </div>
        ) : trades.length === 0 ? (
          <div className="empty-state" style={{ padding: 48 }}>
            <span className="empty-icon">◎</span>
            <span className="empty-text">No trades match your filters</span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              Trades appear here after your first copy is executed
            </span>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Token</th>
                  <th>Type</th>
                  <th>Wallet</th>
                  <th>Amount</th>
                  <th>PnL (SOL)</th>
                  <th>PnL %</th>
                  <th>Speed</th>
                  <th>TX</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => <TradeRow key={t.id} trade={t} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination
        page={filters.page}
        pages={pages}
        total={total}
        onPage={p => setFilters(f => ({ ...f, page: p }))}
      />

      <style>{`
        .trades-page { display: flex; flex-direction: column; gap: 14px; }

        .filters-bar {
          display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
          background: var(--bg2); border: 1px solid var(--border);
          padding: 12px 16px;
        }
        .filters-bar select,
        .filters-bar input[type="text"],
        .filters-bar input[type="date"] {
          background: var(--bg3); border: 1px solid var(--border2);
          color: var(--text); padding: 6px 10px;
          font-family: var(--font-mono); font-size: 11px;
        }
        .filters-bar input[type="date"]::-webkit-calendar-picker-indicator {
          filter: invert(0.5);
        }

        .summary-strip {
          display: flex; gap: 24px; flex-wrap: wrap; padding: 10px 16px;
          background: var(--bg2); border: 1px solid var(--border);
        }
        .summary-item  { display: flex; flex-direction: column; gap: 2px; }
        .summary-label { font-size: 9px; color: var(--muted);
          letter-spacing: 0.1em; text-transform: uppercase; }
        .summary-value { font-size: 13px; font-weight: 600; }
        .summary-value.pos { color: var(--pos); }
        .summary-value.neg { color: var(--neg); }

        .trade-row--buy  td:first-child { border-left: 2px solid var(--accent2); }
        .trade-row--sell td:first-child { border-left: 2px solid var(--muted); }
        .trade-row--win  td:first-child { border-left-color: var(--pos); }

        .td-time   { color: var(--muted); font-size: 11px; white-space: nowrap; }
        .td-token  { font-weight: 700; }
        .td-wallet { color: var(--muted); font-size: 11px;
          max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .td-sol    { font-family: var(--font-mono); white-space: nowrap; }
        .td-pnl    { font-family: var(--font-mono); font-weight: 600; white-space: nowrap; }
        .td-pct    { font-family: var(--font-mono); font-weight: 600; white-space: nowrap; }
        .td-speed  { font-size: 11px; color: var(--muted); white-space: nowrap; }

        .token-badge {
          font-family: var(--font-sans); font-size: 12px; font-weight: 700;
          letter-spacing: 0.04em;
        }
        .tx-link {
          color: var(--accent2); text-decoration: none; font-size: 11px;
          font-family: var(--font-mono); letter-spacing: 0.05em;
        }
        .tx-link:hover { text-decoration: underline; }

        .pos { color: var(--pos); }
        .neg { color: var(--neg); }

        .pagination {
          display: flex; align-items: center; justify-content: space-between;
          flex-wrap: wrap; gap: 8px;
        }
        .pagination__info { font-size: 11px; color: var(--muted); }
        .pagination__btns { display: flex; gap: 4px; }
      `}</style>
    </div>
  );
}