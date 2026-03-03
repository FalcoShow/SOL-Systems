// ============================================================
//  SOL SYSTEMS — Dashboard Root
//  File: dashboard/src/App.jsx
//
//  Root component. Sets up:
//    - React Router for page navigation
//    - Live WebSocket connection to the API server
//    - Global data context (stats, positions, live feed)
//    - Layout shell (sidebar + topbar + main content area)
//
//  To bootstrap the dashboard:
//    cd dashboard
//    npm create vite@latest . -- --template react
//    npm install
//    npm install react-router-dom recharts
//    npm run dev
// ============================================================

import { useState, useEffect, useRef, createContext, useContext, useCallback } from "react";
import { BrowserRouter, Routes, Route, NavLink, useLocation } from "react-router-dom";
import { SpeedInsights } from "@vercel/speed-insights/react";

// Pages
import Overview   from "./pages/Overview";
import Trades     from "./pages/Trades";
import Positions  from "./pages/Positions";
import Wallets    from "./pages/Wallets";
import Settings   from "./pages/Settings";

// ────────────────────────────────────────────────────────────
//  CONFIG
// ────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";
const WS_URL   = import.meta.env.VITE_WS_URL  || "ws://localhost:3001/ws";
const API_KEY  = import.meta.env.VITE_API_KEY  || "";

// ────────────────────────────────────────────────────────────
//  GLOBAL DATA CONTEXT
//  Shared across all pages — no prop drilling
// ────────────────────────────────────────────────────────────

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// ────────────────────────────────────────────────────────────
//  API HELPER
// ────────────────────────────────────────────────────────────

export async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ────────────────────────────────────────────────────────────
//  WEBSOCKET HOOK
//  Maintains a persistent connection with auto-reconnect
// ────────────────────────────────────────────────────────────

function useWebSocket(onMessage) {
  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const [wsStatus, setWsStatus] = useState("connecting");

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("connected");
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        onMessage(msg);
      } catch (_) {}
    };

    ws.onclose = () => {
      setWsStatus("reconnecting");
      reconnectRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      setWsStatus("error");
      ws.close();
    };
  }, [onMessage]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [connect]);

  return wsStatus;
}

// ────────────────────────────────────────────────────────────
//  DATA PROVIDER
//  Fetches stats on load and refreshes every 15s.
//  Live events from WebSocket update state instantly.
// ────────────────────────────────────────────────────────────

function DataProvider({ children }) {
  const [stats,      setStats]      = useState(null);
  const [positions,  setPositions]  = useState([]);
  const [liveFeed,   setLiveFeed]   = useState([]);   // last 20 live events
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  // ── Fetch full stats from REST API ───────────────────────
  const fetchStats = useCallback(async () => {
    try {
      // /api/analytics/overview returns { stats24h, statsAll, positions, wallet, system, settings }
      // /api/trades/open returns { trades: [...] }
      const [overviewData, posData] = await Promise.all([
        apiFetch("/api/analytics/overview"),
        apiFetch("/api/trades/open"),
      ]);

      // Normalise into the shape all pages expect
      setStats({
        stats24h:  overviewData.stats24h  || {},
        statsAll:  overviewData.statsAll  || {},
        positions: overviewData.positions || {},
        wallet:    overviewData.wallet    || {},
        system:    overviewData.system    || {},
        settings:  overviewData.settings  || {},
      });
      setPositions(posData.trades || posData.positions || []);
      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + 15s polling
  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  // ── Handle live WebSocket events ─────────────────────────
  const handleWsMessage = useCallback((msg) => {
    if (msg.type === "INIT") {
      // Initial state push when dashboard connects
      if (msg.data?.positions) setPositions(msg.data.positions || []);
      return;
    }

    // Push to live feed (keep last 20)
    setLiveFeed(prev => [
      { ...msg, id: Date.now() + Math.random() },
      ...prev.slice(0, 19),
    ]);

    // Refresh stats on any trade event
    if (msg.type === "TRADE_CONFIRMED" || msg.type === "POSITION_CLOSED") {
      fetchStats();
    }
  }, [fetchStats]);

  const wsStatus = useWebSocket(handleWsMessage);

  const value = {
    stats,
    positions,
    liveFeed,
    loading,
    error,
    lastUpdate,
    wsStatus,
    refresh: fetchStats,
    apiKey: API_KEY,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ────────────────────────────────────────────────────────────
//  NAV ITEMS
// ────────────────────────────────────────────────────────────

const NAV = [
  { to: "/",          label: "Overview",  icon: "⬡" },
  { to: "/trades",    label: "Trades",    icon: "◈" },
  { to: "/positions", label: "Positions", icon: "◉" },
  { to: "/wallets",   label: "Wallets",   icon: "◎" },
  { to: "/settings",  label: "Settings",  icon: "◬" },
];

// ────────────────────────────────────────────────────────────
//  SIDEBAR
// ────────────────────────────────────────────────────────────

function Sidebar({ stats }) {
  const isPaused = stats?.settings?.isTradingPaused;
  const wsStatus = useApp()?.wsStatus;

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <span className="logo-mark">⬡</span>
        <div className="logo-text">
          <span className="logo-title">SOL SYSTEMS</span>
          <span className="logo-sub">Copy Trading</span>
        </div>
      </div>

      {/* System status pill */}
      <div className={`status-pill ${isPaused ? "paused" : "active"}`}>
        <span className="status-dot" />
        <span>{isPaused ? "PAUSED" : "TRADING ACTIVE"}</span>
      </div>

      {/* Nav links */}
      <nav className="sidebar-nav">
        {NAV.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `nav-item${isActive ? " nav-item--active" : ""}`
            }
          >
            <span className="nav-icon">{icon}</span>
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Bottom stats */}
      <div className="sidebar-footer">
        <div className="footer-stat">
          <span className="footer-label">Capital</span>
          <span className="footer-value">
            {stats?.settings?.myCapitalSOL?.toFixed(2) ?? "—"} SOL
          </span>
        </div>
        <div className="footer-stat">
          <span className="footer-label">Balance</span>
          <span className="footer-value">
            {stats?.wallet?.balance?.toFixed(4) ?? "—"} SOL
          </span>
        </div>
        <div className={`ws-badge ws-badge--${wsStatus}`}>
          <span className="ws-dot" />
          {wsStatus === "connected" ? "LIVE" : wsStatus.toUpperCase()}
        </div>
      </div>
    </aside>
  );
}

// ────────────────────────────────────────────────────────────
//  TOPBAR
// ────────────────────────────────────────────────────────────

function Topbar({ stats, lastUpdate }) {
  const location  = useLocation();
  const pageTitle = NAV.find(n =>
    n.to === "/" ? location.pathname === "/" : location.pathname.startsWith(n.to)
  )?.label ?? "Overview";

  const solPrice = stats?.wallet?.solPriceUSD;
  const pnl24h   = stats?.stats24h?.netPnLSOL ?? 0;
  const pnlSign  = pnl24h >= 0 ? "+" : "";
  const pnlClass = pnl24h >= 0 ? "pos" : "neg";
  const timeStr  = lastUpdate
    ? lastUpdate.toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      })
    : "—";

  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="page-title">{pageTitle}</h1>
      </div>
      <div className="topbar-right">
        {solPrice > 0 && (
          <div className="topbar-stat">
            <span className="topbar-label">SOL</span>
            <span className="topbar-value">${solPrice.toFixed(2)}</span>
          </div>
        )}
        <div className="topbar-stat">
          <span className="topbar-label">24h PnL</span>
          <span className={`topbar-value topbar-value--${pnlClass}`}>
            {pnlSign}{pnl24h.toFixed(4)} SOL
          </span>
        </div>
        <div className="topbar-time">{timeStr}</div>
      </div>
    </header>
  );
}

// ────────────────────────────────────────────────────────────
//  LAYOUT SHELL
// ────────────────────────────────────────────────────────────

function Shell() {
  const { stats, loading, error, lastUpdate } = useApp();

  if (loading) {
    return (
      <div className="boot-screen">
        <span className="boot-logo">⬡</span>
        <span className="boot-text">SOL SYSTEMS INITIALIZING...</span>
        <div className="boot-bar"><div className="boot-fill" /></div>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="boot-screen boot-screen--error">
        <span className="boot-logo">⬡</span>
        <span className="boot-text">CONNECTION FAILED</span>
        <span className="boot-error">{error}</span>
        <span className="boot-hint">
          Make sure <code>node src/index.js</code> is running and VITE_API_URL is correct.
        </span>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar stats={stats} />
      <div className="main-area">
        <Topbar stats={stats} lastUpdate={lastUpdate} />
        <main className="page-content">
          <Routes>
            <Route path="/"          element={<Overview />} />
            <Route path="/trades"    element={<Trades />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/wallets"   element={<Wallets />} />
            <Route path="/settings"  element={<Settings />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  GLOBAL STYLES  (injected once — avoids separate CSS file)
// ────────────────────────────────────────────────────────────

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;600;800&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #080810;
    --bg2:       #0d0d1a;
    --bg3:       #12121f;
    --border:    rgba(255,255,255,0.06);
    --border2:   rgba(255,255,255,0.12);
    --text:      #e8e8f0;
    --muted:     #5a5a7a;
    --accent:    #00e5a0;
    --accent2:   #00b8ff;
    --pos:       #00e5a0;
    --neg:       #ff3b6b;
    --warn:      #ffaa00;
    --font-mono: 'JetBrains Mono', monospace;
    --font-sans: 'Syne', sans-serif;
    --sidebar-w: 220px;
    --topbar-h:  56px;
    --radius:    2px;
  }

  html, body, #root {
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

  /* ── Boot screen ── */
  .boot-screen {
    height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 16px;
    background: var(--bg);
  }
  .boot-logo { font-size: 48px; color: var(--accent); animation: pulse 1.2s infinite; }
  .boot-text { font-family: var(--font-sans); font-size: 14px; font-weight: 600;
    letter-spacing: 0.2em; color: var(--muted); }
  .boot-error { color: var(--neg); font-size: 12px; max-width: 380px; text-align: center; }
  .boot-hint  { color: var(--muted); font-size: 11px; max-width: 320px; text-align: center; }
  .boot-hint code { color: var(--accent2); font-family: var(--font-mono); }
  .boot-bar   { width: 200px; height: 2px; background: var(--border2); border-radius: 1px; overflow: hidden; }
  .boot-fill  { height: 100%; width: 40%; background: var(--accent);
    animation: slide 1.2s ease-in-out infinite; }
  .boot-screen--error .boot-logo { color: var(--neg); animation: none; }

  /* ── Shell layout ── */
  .app-shell    { display: flex; height: 100vh; overflow: hidden; }
  .main-area    { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .page-content { flex: 1; overflow-y: auto; padding: 24px; }

  /* ── Sidebar ── */
  .sidebar {
    width: var(--sidebar-w); background: var(--bg2);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 20px 0;
    flex-shrink: 0;
  }
  .sidebar-logo {
    display: flex; align-items: center; gap: 10px;
    padding: 0 20px 20px; border-bottom: 1px solid var(--border);
  }
  .logo-mark  { font-size: 22px; color: var(--accent); line-height: 1; }
  .logo-text  { display: flex; flex-direction: column; }
  .logo-title { font-family: var(--font-sans); font-size: 13px; font-weight: 800;
    letter-spacing: 0.05em; color: var(--text); }
  .logo-sub   { font-size: 9px; letter-spacing: 0.15em; color: var(--muted);
    text-transform: uppercase; }

  .status-pill {
    margin: 16px 20px; padding: 6px 12px;
    display: flex; align-items: center; gap: 8px;
    border: 1px solid; border-radius: var(--radius);
    font-size: 9px; letter-spacing: 0.15em; font-weight: 700;
  }
  .status-pill.active { border-color: var(--pos); color: var(--pos);
    background: rgba(0,229,160,0.06); }
  .status-pill.paused { border-color: var(--warn); color: var(--warn);
    background: rgba(255,170,0,0.06); }
  .status-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: currentColor; animation: pulse 1.5s infinite;
  }
  .status-pill.paused .status-dot { animation: none; }

  .sidebar-nav { flex: 1; padding: 12px 0; }
  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 20px; color: var(--muted);
    text-decoration: none; transition: all 0.15s;
    font-size: 12px; letter-spacing: 0.05em; font-weight: 500;
    border-left: 2px solid transparent;
  }
  .nav-item:hover { color: var(--text); background: rgba(255,255,255,0.03); }
  .nav-item--active { color: var(--accent); border-left-color: var(--accent);
    background: rgba(0,229,160,0.05); }
  .nav-icon  { font-size: 14px; width: 18px; text-align: center; }
  .nav-label { font-family: var(--font-sans); font-weight: 600; }

  .sidebar-footer {
    padding: 16px 20px 0;
    border-top: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 10px;
  }
  .footer-stat  { display: flex; justify-content: space-between; align-items: center; }
  .footer-label { font-size: 10px; color: var(--muted); letter-spacing: 0.1em; }
  .footer-value { font-size: 11px; color: var(--text); font-weight: 500; }

  .ws-badge {
    display: flex; align-items: center; gap: 6px; margin-top: 4px;
    font-size: 9px; letter-spacing: 0.15em; font-weight: 700;
    padding: 4px 8px; border-radius: 1px;
  }
  .ws-badge--connected    { color: var(--pos); background: rgba(0,229,160,0.08); }
  .ws-badge--reconnecting { color: var(--warn); background: rgba(255,170,0,0.08); }
  .ws-badge--error        { color: var(--neg); background: rgba(255,59,107,0.08); }
  .ws-badge--connecting   { color: var(--muted); background: rgba(255,255,255,0.04); }
  .ws-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .ws-badge--connected .ws-dot { animation: pulse 1.5s infinite; }

  /* ── Topbar ── */
  .topbar {
    height: var(--topbar-h); background: var(--bg2);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 24px; flex-shrink: 0;
  }
  .page-title   { font-family: var(--font-sans); font-size: 16px; font-weight: 800;
    letter-spacing: 0.04em; }
  .topbar-right { display: flex; align-items: center; gap: 24px; }
  .topbar-stat  { display: flex; flex-direction: column; align-items: flex-end; }
  .topbar-label { font-size: 9px; color: var(--muted); letter-spacing: 0.12em;
    text-transform: uppercase; }
  .topbar-value { font-size: 13px; font-weight: 500; }
  .topbar-value--pos { color: var(--pos); }
  .topbar-value--neg { color: var(--neg); }
  .topbar-time  { font-size: 11px; color: var(--muted); letter-spacing: 0.05em;
    min-width: 80px; text-align: right; }

  /* ── Shared page components ── */
  .card {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px;
  }
  .card-title {
    font-family: var(--font-sans); font-size: 11px; font-weight: 600;
    letter-spacing: 0.15em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 16px;
  }
  .stat-value     { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .stat-value.pos { color: var(--pos); }
  .stat-value.neg { color: var(--neg); }
  .stat-sub       { font-size: 11px; color: var(--muted); margin-top: 4px; }

  .badge {
    display: inline-flex; align-items: center; padding: 2px 8px;
    border-radius: 1px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
  }
  .badge-win  { background: rgba(0,229,160,0.12);  color: var(--pos); }
  .badge-loss { background: rgba(255,59,107,0.12); color: var(--neg); }
  .badge-warn { background: rgba(255,170,0,0.12);  color: var(--warn); }
  .badge-info { background: rgba(0,184,255,0.12);  color: var(--accent2); }

  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; padding: 8px 12px;
    font-size: 10px; letter-spacing: 0.1em; color: var(--muted);
    border-bottom: 1px solid var(--border); font-weight: 500;
    text-transform: uppercase;
  }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  tr:last-child td { border-bottom: none; }

  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: var(--radius);
    font-family: var(--font-mono); font-size: 11px; font-weight: 700;
    letter-spacing: 0.08em; cursor: pointer; border: 1px solid;
    transition: all 0.15s; text-transform: uppercase;
  }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .btn-primary:not(:disabled):hover { background: #00ffb3; }
  .btn-ghost   { background: transparent; color: var(--muted); border-color: var(--border2); }
  .btn-ghost:not(:disabled):hover { color: var(--text); border-color: var(--text); }
  .btn-danger  { background: transparent; color: var(--neg); border-color: var(--neg); }
  .btn-danger:not(:disabled):hover { background: rgba(255,59,107,0.1); }

  input, select {
    background: var(--bg3); border: 1px solid var(--border2);
    color: var(--text); border-radius: var(--radius);
    padding: 8px 12px; font-family: var(--font-mono); font-size: 12px;
    outline: none; width: 100%; transition: border-color 0.15s;
  }
  input:focus, select:focus { border-color: var(--accent); }
  input::placeholder { color: var(--muted); }

  .empty-state {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 60px 20px; gap: 12px;
    text-align: center;
  }
  .empty-icon { font-size: 32px; color: var(--muted); }
  .empty-text { font-family: var(--font-sans); font-size: 14px; color: var(--muted); }

  .pos { color: var(--pos); }
  .neg { color: var(--neg); }

  /* ── Animations ── */
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.4; }
  }
  @keyframes slide {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .fade-in { animation: fadeIn 0.3s ease forwards; }
`;

// ────────────────────────────────────────────────────────────
//  ROOT COMPONENT
// ────────────────────────────────────────────────────────────

export default function App() {
  return (
    <>
      <style>{STYLES}</style>
      <BrowserRouter>
        <DataProvider>
          <Shell />
        </DataProvider>
      </BrowserRouter>
      <SpeedInsights />
    </>
  );
}