// ============================================================
//  SOL SYSTEMS — Settings Page
//  File: dashboard/src/pages/Settings.jsx
//
//  Live settings editor. All changes hit PUT /api/settings
//  and take effect immediately — no restart required.
//
//  Sections:
//    1. Trading Controls  — pause/resume with one click
//    2. Capital & Sizing  — capital, max position %, reserve
//    3. Risk Management   — daily loss limit, max positions
//    4. Execution         — slippage, notifications
//    5. System Info       — read-only config info
// ============================================================

import { useState, useEffect } from "react";
import { apiFetch } from "../App.jsx";

// ────────────────────────────────────────────────────────────
//  FIELD COMPONENTS
// ────────────────────────────────────────────────────────────

function SettingRow({ label, hint, children }) {
  return (
    <div className="setting-row">
      <div className="setting-row__meta">
        <span className="setting-row__label">{label}</span>
        {hint && <span className="setting-row__hint">{hint}</span>}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step = "0.01", suffix }) {
  return (
    <div className="number-input-wrap">
      <input
        type="number"
        value={value ?? ""}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        min={min}
        max={max}
        step={step}
        style={{ width: 120, textAlign: "right" }}
      />
      {suffix && <span className="input-suffix">{suffix}</span>}
    </div>
  );
}

function Toggle({ value, onChange, labelOn = "ON", labelOff = "OFF" }) {
  return (
    <button
      className={`toggle-btn ${value ? "toggle-btn--on" : "toggle-btn--off"}`}
      onClick={() => onChange(!value)}
    >
      <span className="toggle-btn__dot" />
      <span>{value ? labelOn : labelOff}</span>
    </button>
  );
}

// ────────────────────────────────────────────────────────────
//  SECTION WRAPPER
// ────────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div className="settings-section">
      <div className="settings-section__title">{title}</div>
      <div className="settings-section__body">{children}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  PAUSE / RESUME PANEL
// ────────────────────────────────────────────────────────────

function TradingControlPanel({ settings, onRefresh }) {
  const [loading, setLoading] = useState(false);
  const [reason,  setReason]  = useState("");
  const isPaused = settings?.isTradingPaused;

  async function handlePause() {
    setLoading(true);
    try {
      await apiFetch("/api/trading/pause", {
        method: "POST",
        body: JSON.stringify({ reason: reason || "Manual pause via dashboard" }),
      });
      onRefresh();
    } catch (err) {
      alert("Pause failed: " + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResume() {
    setLoading(true);
    try {
      await apiFetch("/api/trading/resume", { method: "POST" });
      setReason("");
      onRefresh();
    } catch (err) {
      alert("Resume failed: " + err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`trading-control ${isPaused ? "trading-control--paused" : "trading-control--active"}`}>
      <div className="trading-control__status">
        <span className="trading-control__dot" />
        <div>
          <div className="trading-control__state">
            {isPaused ? "TRADING PAUSED" : "TRADING ACTIVE"}
          </div>
          {isPaused && settings.pauseReason && (
            <div className="trading-control__reason">{settings.pauseReason}</div>
          )}
        </div>
      </div>

      {!isPaused ? (
        <div className="trading-control__actions">
          <input
            type="text"
            placeholder="Pause reason (optional)"
            value={reason}
            onChange={e => setReason(e.target.value)}
            style={{ width: 240, fontSize: 11 }}
          />
          <button
            className="btn btn-danger"
            onClick={handlePause}
            disabled={loading}
            style={{ padding: "8px 20px" }}
          >
            {loading ? "Pausing..." : "⏸ Pause Trading"}
          </button>
        </div>
      ) : (
        <button
          className="btn btn-primary"
          onClick={handleResume}
          disabled={loading}
          style={{ padding: "8px 24px" }}
        >
          {loading ? "Resuming..." : "▶ Resume Trading"}
        </button>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  SETTINGS PAGE
// ────────────────────────────────────────────────────────────

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [form,     setForm]     = useState({});
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState("");
  const [dirty,    setDirty]    = useState(false);

  async function fetchSettings() {
    try {
      const s = await apiFetch("/api/settings");
      setSettings(s);
      setForm({
        myCapitalSOL:      s.myCapitalSOL      ?? 10,
        // Backend stores 0–1 decimal; UI shows percentage
        maxPositionPct:    (s.maxPositionPct   ?? 0.10) * 100,
        minSolReserve:     s.minSolReserve     ?? 0.1,
        maxOpenPositions:  s.maxOpenPositions  ?? 10,
        dailyLossLimitSOL: s.dailyLossLimitSOL ?? 2,
        maxSlippageBps:    s.maxSlippageBps    ?? 100,
        notifyOnBuy:       s.notifyOnBuy       ?? true,
        notifyOnSell:      s.notifyOnSell      ?? true,
        notifyOnSkip:      s.notifyOnSkip      ?? false,
      });
      setDirty(false);
    } catch {
      // Settings fetch failure — leave form blank, user will see error state
    }
  }

  useEffect(() => { fetchSettings(); }, []);

  function update(key, value) {
    setForm(f => ({ ...f, [key]: value }));
    setDirty(true);
    setSaved(false);
    setError("");
  }

  async function handleSave() {
    setSaving(true); setError(""); setSaved(false);
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          myCapitalSOL:      form.myCapitalSOL,
          maxPositionPct:    form.maxPositionPct / 100,   // convert % → decimal for backend
          minSolReserve:     form.minSolReserve,
          maxOpenPositions:  Math.round(form.maxOpenPositions),
          dailyLossLimitSOL: form.dailyLossLimitSOL,
          maxSlippageBps:    Math.round(form.maxSlippageBps),
          notifyOnBuy:       form.notifyOnBuy,
          notifyOnSell:      form.notifyOnSell,
          notifyOnSkip:      form.notifyOnSkip,
        }),
      });
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 3000);
      fetchSettings();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="card fade-in">
        <div className="empty-state" style={{ padding: 48 }}>
          <span className="empty-icon" style={{ animation: "pulse 1s infinite" }}>◬</span>
          <span className="empty-text">Loading settings...</span>
        </div>
      </div>
    );
  }

  // Live preview: max position in SOL
  const maxPositionSOL = ((form.maxPositionPct / 100) * form.myCapitalSOL).toFixed(2);

  return (
    <div className="settings-page fade-in">

      {/* ── Section 1: Trading state ── */}
      <Section title="Trading Controls">
        <TradingControlPanel settings={settings} onRefresh={fetchSettings} />
      </Section>

      {/* ── Section 2: Capital & Sizing ── */}
      <Section title="Capital & Position Sizing">
        <SettingRow
          label="My Trading Capital"
          hint="Total SOL allocated for copy trading. Used to calculate position sizes."
        >
          <NumberInput
            value={form.myCapitalSOL}
            onChange={v => update("myCapitalSOL", v)}
            min={0.1} step="0.1" suffix="SOL"
          />
        </SettingRow>

        <SettingRow
          label="Max Position Size"
          hint={`Max % of capital per trade. Currently: up to ${maxPositionSOL} SOL per trade.`}
        >
          <NumberInput
            value={form.maxPositionPct}
            onChange={v => update("maxPositionPct", Math.min(v, 100))}
            min={0.1} max={100} step="0.5" suffix="%"
          />
        </SettingRow>

        <SettingRow
          label="Minimum SOL Reserve"
          hint="Always keep at least this much SOL for gas fees. Never traded."
        >
          <NumberInput
            value={form.minSolReserve}
            onChange={v => update("minSolReserve", v)}
            min={0.01} step="0.01" suffix="SOL"
          />
        </SettingRow>
      </Section>

      {/* ── Section 3: Risk Management ── */}
      <Section title="Risk Management">
        <SettingRow
          label="Daily Loss Limit"
          hint="Auto-pause trading if this much SOL is lost in one day. Set to 0 to disable."
        >
          <NumberInput
            value={form.dailyLossLimitSOL}
            onChange={v => update("dailyLossLimitSOL", v)}
            min={0} step="0.1" suffix="SOL"
          />
        </SettingRow>

        <SettingRow
          label="Max Open Positions"
          hint="Stop opening new positions once this many are open simultaneously."
        >
          <NumberInput
            value={form.maxOpenPositions}
            onChange={v => update("maxOpenPositions", Math.round(v))}
            min={1} max={50} step="1" suffix="positions"
          />
        </SettingRow>
      </Section>

      {/* ── Section 4: Execution ── */}
      <Section title="Execution">
        <SettingRow
          label="Max Slippage"
          hint="Maximum price impact allowed on Jupiter swaps. 100 bps = 1%."
        >
          <NumberInput
            value={form.maxSlippageBps}
            onChange={v => update("maxSlippageBps", Math.round(v))}
            min={10} max={5000} step="10" suffix="bps"
          />
        </SettingRow>

        <SettingRow
          label="Notify on BUY"
          hint="Send Telegram message when a buy trade is executed."
        >
          <Toggle
            value={form.notifyOnBuy}
            onChange={v => update("notifyOnBuy", v)}
          />
        </SettingRow>

        <SettingRow
          label="Notify on SELL"
          hint="Send Telegram message when a sell trade is executed with PnL."
        >
          <Toggle
            value={form.notifyOnSell}
            onChange={v => update("notifyOnSell", v)}
          />
        </SettingRow>

        <SettingRow
          label="Notify on SKIP"
          hint="Send Telegram message when a trade is skipped by the risk manager."
        >
          <Toggle
            value={form.notifyOnSkip}
            onChange={v => update("notifyOnSkip", v)}
          />
        </SettingRow>
      </Section>

      {/* ── Section 5: Read-only info ── */}
      <Section title="System Info">
        <div className="info-grid">
          {[
            ["Bot Wallet",  settings.botWalletAddress || "Check .env"],
            ["Network",     "Solana Mainnet"],
            ["DEX",         "Jupiter v6"],
            ["Database",    "PostgreSQL (Neon)"],
            ["API Port",    "3001"],
            ["Dashboard",   "localhost:5173"],
          ].map(([label, value]) => (
            <div key={label} className="info-row">
              <span className="info-label">{label}</span>
              <span className="info-value">{value}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Floating save bar ── */}
      <div className={`save-bar ${dirty ? "save-bar--visible" : ""}`}>
        <div className="save-bar__inner">
          {error   && <span className="save-bar__error">{error}</span>}
          {saved   && <span className="save-bar__success">✅ Settings saved</span>}
          {!error && !saved && dirty && (
            <span className="save-bar__dirty">You have unsaved changes</span>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-ghost"
              onClick={fetchSettings}
              disabled={saving}
              style={{ padding: "8px 16px" }}
            >
              Discard
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || !dirty}
              style={{ padding: "8px 24px" }}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .settings-page {
          display: flex; flex-direction: column; gap: 16px;
          padding-bottom: 80px; /* room for save bar */
          max-width: 780px;
        }

        /* section */
        .settings-section { background: var(--bg2); border: 1px solid var(--border); }
        .settings-section__title {
          font-family: var(--font-sans); font-size: 11px; font-weight: 600;
          letter-spacing: 0.15em; text-transform: uppercase;
          color: var(--muted); padding: 14px 20px;
          border-bottom: 1px solid var(--border);
        }
        .settings-section__body { padding: 4px 0; }

        /* setting row */
        .setting-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 20px; gap: 20px;
          border-bottom: 1px solid var(--border);
        }
        .setting-row:last-child { border-bottom: none; }
        .setting-row__meta    { display: flex; flex-direction: column; gap: 3px; flex: 1; }
        .setting-row__label   { font-size: 13px; font-weight: 500; }
        .setting-row__hint    { font-size: 11px; color: var(--muted); line-height: 1.4; }
        .setting-row__control { flex-shrink: 0; }

        /* number input */
        .number-input-wrap       { display: flex; align-items: center; gap: 6px; }
        .number-input-wrap input { width: 100px; text-align: right; }
        .input-suffix { font-size: 11px; color: var(--muted); min-width: 60px; }

        /* toggle */
        .toggle-btn {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 14px; border-radius: 2px; cursor: pointer;
          border: 1px solid; font-size: 11px; font-weight: 700;
          letter-spacing: 0.08em; transition: all 0.15s;
          font-family: var(--font-mono);
        }
        .toggle-btn--on  { background: rgba(0,229,160,0.1); color: var(--pos);   border-color: var(--pos); }
        .toggle-btn--off { background: transparent;          color: var(--muted); border-color: var(--border2); }
        .toggle-btn__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
        .toggle-btn--on .toggle-btn__dot { animation: pulse 1.5s infinite; }

        /* trading control */
        .trading-control {
          display: flex; align-items: center; justify-content: space-between;
          flex-wrap: wrap; gap: 16px; padding: 20px;
          border-radius: 2px; margin: 4px;
        }
        .trading-control--active {
          background: rgba(0,229,160,0.04);
          border: 1px solid rgba(0,229,160,0.15);
        }
        .trading-control--paused {
          background: rgba(255,170,0,0.04);
          border: 1px solid rgba(255,170,0,0.20);
        }
        .trading-control__status { display: flex; align-items: center; gap: 12px; }
        .trading-control__dot {
          width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
        }
        .trading-control--active .trading-control__dot {
          background: var(--pos); animation: pulse 1.5s infinite;
        }
        .trading-control--paused .trading-control__dot { background: var(--warn); }
        .trading-control__state {
          font-family: var(--font-sans); font-size: 14px; font-weight: 700;
        }
        .trading-control--active .trading-control__state { color: var(--pos); }
        .trading-control--paused .trading-control__state { color: var(--warn); }
        .trading-control__reason { font-size: 11px; color: var(--muted); margin-top: 3px; }
        .trading-control__actions {
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        }

        /* info grid */
        .info-grid { padding: 4px 0; }
        .info-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 10px 20px; border-bottom: 1px solid var(--border); font-size: 12px;
        }
        .info-row:last-child { border-bottom: none; }
        .info-label { color: var(--muted); }
        .info-value { font-family: var(--font-mono); color: var(--text); font-weight: 500; }

        /* save bar — sticks to bottom, offset by sidebar width */
        .save-bar {
          position: fixed; bottom: 0;
          left: var(--sidebar-w);   /* matches sidebar width */
          right: 0;
          background: var(--bg2); border-top: 1px solid var(--border2);
          transform: translateY(100%);
          transition: transform 0.2s ease;
          z-index: 100;
        }
        .save-bar--visible { transform: translateY(0); }
        .save-bar__inner {
          display: flex; align-items: center; justify-content: flex-end;
          gap: 16px; padding: 12px 24px;
        }
        .save-bar__dirty   { font-size: 12px; color: var(--muted); margin-right: auto; }
        .save-bar__error   { font-size: 12px; color: var(--neg);   margin-right: auto; }
        .save-bar__success { font-size: 12px; color: var(--pos);   margin-right: auto; }
      `}</style>
    </div>
  );
}