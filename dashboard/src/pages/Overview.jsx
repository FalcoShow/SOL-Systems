// ============================================================
//  SOL SYSTEMS — Overview Page
//  File: dashboard/src/pages/Overview.jsx
//
//  Main dashboard screen. Everything at a glance:
//    - 4 stat cards: Net PnL, Win Rate, Open Positions, Execution Speed
//    - 7-day PnL bar chart (Recharts)
//    - Live trade feed (real-time WebSocket events)
//    - System health panel
// ============================================================

import { useState, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from "recharts";
import { useApp, apiFetch } from "../App.jsx";

// ────────────────────────────────────────────────────────────
//  STAT CARD
// ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent, trend }) {
  return (
    <div className="stat-card fade-in">
      <div className="stat-card__label">{label}</div>
      <div className={`stat-card__value ${accent || ""}`}>{value}</div>
      {sub   && <div className="stat-card__sub">{sub}</div>}
      {trend !== undefined && (
        <div className={`stat-card__trend ${trend >= 0 ? "pos" : "neg"}`}>
          {trend >= 0 ? "▲" : "▼"} {Math.abs(trend).toFixed(1)}%
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  PNL CHART
// ────────────────────────────────────────────────────────────

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const val  = payload[0].value || 0;
  const sign = val >= 0 ? "+" : "";
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__date">{label}</div>
      <div className={`chart-tooltip__val ${val >= 0 ? "pos" : "neg"}`}>
        {sign}{val.toFixed(4)} SOL
      </div>
    </div>
  );
};

function PnLChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="empty-state" style={{ height: 180 }}>
        <span className="empty-icon">◈</span>
        <span className="empty-text">No trade history yet</span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <XAxis
          dataKey="dateShort"
          tick={{ fill: "#5a5a7a", fontSize: 10, fontFamily: "JetBrains Mono" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: "#5a5a7a", fontSize: 10, fontFamily: "JetBrains Mono" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={v => v.toFixed(2)}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
        <ReferenceLine y={0} stroke="rgba(255,255,255,0.08)" />
        <Bar dataKey="netPnLSOL" radius={[2, 2, 0, 0]} maxBarSize={32}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={(entry.netPnLSOL || 0) >= 0 ? "#00e5a0" : "#ff3b6b"}
              fillOpacity={0.85}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ────────────────────────────────────────────────────────────
//  LIVE FEED EVENT ROW
// ────────────────────────────────────────────────────────────

function FeedEvent({ event }) {
  const { type, data, ts } = event;

  // ts may be undefined on older events — fall back gracefully
  const time = ts
    ? new Date(ts).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      })
    : "—";

  if (type === "TRADE_CONFIRMED" && data) {
    const isBuy   = data.tradeType === "BUY";
    const pnlSign = (data.pnlSOL || 0) >= 0 ? "+" : "";
    return (
      <div className={`feed-event feed-event--${isBuy ? "buy" : "sell"}`}>
        <span className="feed-event__icon">{isBuy ? "▲" : "▼"}</span>
        <span className="feed-event__token">{data.tokenSymbol || "???"}</span>
        <span className="feed-event__detail">
          {isBuy
            ? `${(data.executedAmountSOL || 0).toFixed(4)} SOL`
            : `${pnlSign}${(data.pnlSOL || 0).toFixed(4)} SOL`}
        </span>
        <span className="feed-event__time">{time}</span>
      </div>
    );
  }

  return (
    <div className="feed-event feed-event--info">
      <span className="feed-event__icon">◈</span>
      <span className="feed-event__token">{type?.replace(/_/g, " ") || "EVENT"}</span>
      <span className="feed-event__time">{time}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  SYSTEM HEALTH PANEL
// ────────────────────────────────────────────────────────────

function HealthPanel({ stats }) {
  const sys      = stats?.system   || {};
  const settings = stats?.settings || {};
  const wallet   = stats?.wallet   || {};

  const items = [
    {
      label: "WebSocket",
      ok:    sys.wsConnected,
      value: sys.wsConnected ? "CONNECTED" : "DISCONNECTED",
    },
    {
      label: "Wallets monitored",
      ok:    (sys.trackedWallets || 0) > 0,
      value: `${sys.trackedWallets || 0} active`,
    },
    {
      label: "Trading",
      ok:    !settings.isTradingPaused,
      value: settings.isTradingPaused ? "PAUSED" : "ACTIVE",
    },
    {
      label: "SOL balance",
      ok:    (wallet.balance || 0) > (settings.minSolReserve || 0.1),
      value: `${(wallet.balance || 0).toFixed(4)} SOL`,
    },
    {
      label: "Exec queue",
      ok:    (sys.queueSize || 0) < 3,
      value: `${sys.queueSize || 0} pending`,
    },
    {
      label: "Database",
      ok:    sys.dbConnected !== false,
      value: sys.dbConnected !== false ? "ONLINE" : "OFFLINE",
    },
  ];

  return (
    <div className="health-panel">
      {items.map(({ label, ok, value }) => (
        <div key={label} className="health-row">
          <span className={`health-dot ${ok ? "ok" : "warn"}`} />
          <span className="health-label">{label}</span>
          <span className={`health-value ${ok ? "" : "warn-text"}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  OVERVIEW PAGE
// ────────────────────────────────────────────────────────────

export default function Overview() {
  const { stats, liveFeed, wsStatus } = useApp();
  const [chartData, setChartData]     = useState([]);

  // Fetch 7-day PnL history for chart
  useEffect(() => {
    apiFetch("/api/analytics/pnl-daily?days=7")
      .then(res => {
        // Backend may return { history: [...] } or { data: [...] }
        const raw = (res.history || res.data || []).slice().reverse();
        const formatted = raw.map(d => ({
          ...d,
          dateShort: new Date((d.date || d.ts) + "T00:00:00Z").toLocaleDateString("en-US", {
            weekday: "short", timeZone: "UTC",
          }),
        }));
        setChartData(formatted);
      })
      .catch(() => {});  // fail silently — chart just shows empty state
  }, []);

  const s24h     = stats?.stats24h   || {};
  const pos      = stats?.positions  || {};
  const wallet   = stats?.wallet     || {};
  const settings = stats?.settings   || {};

  const netPnL  = s24h.netPnLSOL    ?? 0;
  const netUSD  = s24h.netPnLUSD    ?? 0;
  const winRate = s24h.winRatePct   ?? 0;
  const avgMs   = s24h.avgExecutionMs ?? 0;
  const pnlSign = netPnL >= 0 ? "+" : "";
  const capital = settings.myCapitalSOL || 10;
  const roi     = capital > 0 ? (netPnL / capital) * 100 : 0;

  return (
    <div className="overview">

      {/* ── Stat cards ── */}
      <div className="stat-grid">
        <StatCard
          label="24h Net PnL"
          value={`${pnlSign}${netPnL.toFixed(4)} SOL`}
          sub={`${pnlSign}$${Math.abs(netUSD).toFixed(2)} · ${pnlSign}${roi.toFixed(2)}% ROI`}
          accent={netPnL >= 0 ? "pos" : "neg"}
          trend={roi}
        />
        <StatCard
          label="Win Rate (24h)"
          value={`${winRate.toFixed(1)}%`}
          sub={`${s24h.wins || 0}W · ${s24h.losses || 0}L · ${s24h.totalTrades || 0} trades`}
          accent={winRate >= 50 ? "pos" : "neg"}
        />
        <StatCard
          label="Open Positions"
          value={pos.openCount ?? 0}
          sub={`${(pos.totalInvestedSOL || 0).toFixed(3)} SOL invested`}
          accent={(pos.openCount || 0) > 0 ? "accent2" : ""}
        />
        <StatCard
          label="Avg Execution"
          value={avgMs > 0 ? `${avgMs}ms` : "—"}
          sub={avgMs > 0
            ? (avgMs < 1000 ? "⚡ Fast" : avgMs < 2000 ? "✅ On target" : "🐌 Slow")
            : "No trades yet"}
          accent={avgMs > 0 && avgMs < 1000 ? "pos" : avgMs > 2000 ? "neg" : ""}
        />
      </div>

      {/* ── Main grid: chart + live feed + health ── */}
      <div className="overview-grid">

        {/* 7-day chart — spans 2 cols */}
        <div className="card" style={{ gridColumn: "span 2" }}>
          <div className="card-title">7-Day PnL</div>
          <PnLChart data={chartData} />
        </div>

        {/* Live feed */}
        <div className="card live-feed-card">
          <div className="card-title" style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Live Feed</span>
            <span className={`ws-micro ws-micro--${wsStatus}`}>
              {wsStatus === "connected" ? "● LIVE" : "○ " + wsStatus.toUpperCase()}
            </span>
          </div>
          <div className="live-feed">
            {liveFeed.length === 0 ? (
              <div className="empty-state" style={{ padding: "30px 0" }}>
                <span className="empty-icon">◎</span>
                <span className="empty-text" style={{ fontSize: 11 }}>
                  Waiting for trades...
                </span>
              </div>
            ) : (
              liveFeed.map(event => (
                <FeedEvent key={event.id} event={event} />
              ))
            )}
          </div>
        </div>

        {/* System health */}
        <div className="card">
          <div className="card-title">System Health</div>
          <HealthPanel stats={stats} />
        </div>

      </div>

      <style>{`
        .overview { display: flex; flex-direction: column; gap: 20px; }

        /* stat grid */
        .stat-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px;
        }
        @media (max-width: 1100px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 600px)  { .stat-grid { grid-template-columns: 1fr; } }

        .stat-card {
          background: var(--bg2); border: 1px solid var(--border);
          padding: 20px; display: flex; flex-direction: column; gap: 4px;
          transition: border-color 0.2s;
        }
        .stat-card:hover { border-color: var(--border2); }
        .stat-card__label {
          font-size: 10px; letter-spacing: 0.12em; color: var(--muted);
          text-transform: uppercase; font-weight: 500;
        }
        .stat-card__value {
          font-size: 26px; font-weight: 700; letter-spacing: -0.02em;
          font-family: var(--font-mono); line-height: 1.1; margin-top: 4px;
        }
        .stat-card__value.pos     { color: var(--pos); }
        .stat-card__value.neg     { color: var(--neg); }
        .stat-card__value.accent2 { color: var(--accent2); }
        .stat-card__sub   { font-size: 11px; color: var(--muted); margin-top: 2px; }
        .stat-card__trend { font-size: 11px; font-weight: 600; margin-top: 4px; }
        .stat-card__trend.pos { color: var(--pos); }
        .stat-card__trend.neg { color: var(--neg); }

        /* main overview grid */
        .overview-grid {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 12px;
        }
        @media (max-width: 1000px) { .overview-grid { grid-template-columns: 1fr; } }
        @media (max-width: 1000px) .overview-grid .card[style] { grid-column: span 1 !important; }

        /* chart tooltip */
        .chart-tooltip {
          background: var(--bg3); border: 1px solid var(--border2);
          padding: 8px 12px; font-family: var(--font-mono);
        }
        .chart-tooltip__date { font-size: 10px; color: var(--muted); margin-bottom: 4px; }
        .chart-tooltip__val  { font-size: 13px; font-weight: 600; }
        .chart-tooltip__val.pos { color: var(--pos); }
        .chart-tooltip__val.neg { color: var(--neg); }

        /* live feed */
        .live-feed {
          display: flex; flex-direction: column; gap: 2px;
          max-height: 240px; overflow-y: auto;
        }
        .feed-event {
          display: flex; align-items: center; gap: 8px; padding: 7px 8px;
          border-radius: 2px; font-size: 11px; animation: fadeIn 0.3s ease;
        }
        .feed-event--buy  { background: rgba(0,229,160,0.05); }
        .feed-event--sell { background: rgba(255,59,107,0.05); }
        .feed-event--info { background: rgba(255,255,255,0.02); }
        .feed-event__icon  { font-size: 9px; width: 14px; text-align: center; }
        .feed-event--buy  .feed-event__icon { color: var(--pos); }
        .feed-event--sell .feed-event__icon { color: var(--neg); }
        .feed-event--info .feed-event__icon { color: var(--muted); }
        .feed-event__token  { font-weight: 700; min-width: 48px; color: var(--text); }
        .feed-event__detail { flex: 1; color: var(--muted); }
        .feed-event__time   { font-size: 10px; color: var(--muted); letter-spacing: 0.05em; }

        .ws-micro { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; }
        .ws-micro--connected    { color: var(--pos); }
        .ws-micro--reconnecting { color: var(--warn); }
        .ws-micro--error        { color: var(--neg); }
        .ws-micro--connecting   { color: var(--muted); }

        /* health panel */
        .health-panel { display: flex; flex-direction: column; gap: 10px; }
        .health-row   { display: flex; align-items: center; gap: 10px; font-size: 12px; }
        .health-dot   { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .health-dot.ok   { background: var(--pos); }
        .health-dot.warn { background: var(--warn); animation: pulse 1.5s infinite; }
        .health-label    { flex: 1; color: var(--muted); font-size: 11px; }
        .health-value    { font-weight: 500; font-size: 11px; }
        .warn-text       { color: var(--warn); }
      `}</style>
    </div>
  );
}