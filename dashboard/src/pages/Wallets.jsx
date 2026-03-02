// ============================================================
//  SOL SYSTEMS — Wallets Page
//  File: dashboard/src/pages/Wallets.jsx
//
//  Wallet management page:
//    - List all tracked wallets with stats
//    - Add new wallet form (address + nickname + optional capital)
//    - Remove wallet button (with confirm)
//    - Per-wallet: trades copied, win rate, PnL, capital est.
//    - Solscan link for each wallet address
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../App.jsx";

const SOLSCAN_WALLET = "https://solscan.io/account/";

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

function shortAddr(addr) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function relativeTime(date) {
  if (!date) return "never";
  const ms = Date.now() - new Date(date).getTime();
  const m  = Math.floor(ms / 60000);
  const h  = Math.floor(m / 60);
  const d  = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

// ────────────────────────────────────────────────────────────
//  ADD WALLET FORM
// ────────────────────────────────────────────────────────────

function AddWalletForm({ onAdded }) {
  const [address,  setAddress]  = useState("");
  const [nickname, setNickname] = useState("");
  const [capital,  setCapital]  = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [success,  setSuccess]  = useState("");

  async function handleSubmit() {
    setError(""); setSuccess("");
    if (!address.trim()) { setError("Address is required"); return; }
    if (address.trim().length < 32) { setError("Address looks too short — check it"); return; }

    setLoading(true);
    try {
      const body = {
        address:  address.trim(),
        nickname: nickname.trim() || null,
      };
      // Only include capital if user entered a value
      if (capital !== "" && !isNaN(parseFloat(capital))) {
        body.manualCapitalSOL = parseFloat(capital);
      }

      const res = await apiFetch("/api/wallets", {
        method: "POST",
        body: JSON.stringify(body),
      });

      const name = res.wallet?.nickname || res.nickname || address.slice(0, 8) + "…";
      setSuccess(`✅ ${name} added and monitoring started`);
      setAddress(""); setNickname(""); setCapital("");
      onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card add-form">
      <div className="card-title">Add Wallet to Copy</div>
      <div className="add-form__fields">
        <div className="field-group">
          <label className="field-label">Solana Wallet Address</label>
          <input
            type="text"
            placeholder="e.g. CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o"
            value={address}
            onChange={e => setAddress(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
            style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
        </div>
        <div className="field-group" style={{ maxWidth: 200 }}>
          <label className="field-label">Nickname (optional)</label>
          <input
            type="text"
            placeholder="e.g. Cented"
            value={nickname}
            onChange={e => setNickname(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
          />
        </div>
        <div className="field-group" style={{ maxWidth: 160 }}>
          <label className="field-label">Known Capital (SOL)</label>
          <input
            type="number"
            placeholder="Auto-estimate"
            value={capital}
            onChange={e => setCapital(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
            min="0"
            step="0.1"
          />
        </div>
        <div className="field-group field-group--btn">
          <label className="field-label">&nbsp;</label>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? "Adding..." : "+ Add Wallet"}
          </button>
        </div>
      </div>

      {error   && <div className="form-msg form-msg--error">{error}</div>}
      {success && <div className="form-msg form-msg--success">{success}</div>}

      <div className="add-form__hint">
        The bot starts copying this wallet's trades immediately after adding.
        Capital is estimated automatically from trade history if left blank.
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  WALLET CARD
// ────────────────────────────────────────────────────────────

function WalletCard({ wallet, onRemoved }) {
  const [confirming, setConfirming] = useState(false);
  const [removing,   setRemoving]   = useState(false);

  const wins      = wallet.totalWins    || 0;
  const losses    = wallet.totalLosses  || 0;
  const total     = wins + losses;
  const winRate   = total > 0 ? ((wins / total) * 100).toFixed(0) : null;
  const pnl       = wallet.totalPnLSOL  || 0;
  const pnlSign   = pnl >= 0 ? "+" : "";
  const capital   = wallet.manualCapitalSOL || wallet.estimatedCapitalSOL || 0;
  const lastTrade = wallet.lastTradeAt ? relativeTime(wallet.lastTradeAt) : "Never";
  const addedDate = wallet.addedAt
    ? new Date(wallet.addedAt).toLocaleDateString([], {
        month: "short", day: "numeric", year: "numeric",
      })
    : "—";

  async function handleRemove() {
    if (!confirming) { setConfirming(true); return; }
    setRemoving(true);
    try {
      await apiFetch(`/api/wallets/${wallet.address}`, { method: "DELETE" });
      onRemoved();
    } catch (err) {
      setRemoving(false);
      setConfirming(false);
      alert("Failed to remove: " + err.message);
    }
  }

  return (
    <div className={`wallet-card ${!wallet.isActive ? "wallet-card--inactive" : ""}`}>

      {/* Header */}
      <div className="wallet-card__header">
        <div className="wallet-card__identity">
          <div className="wallet-card__name">
            {wallet.nickname || shortAddr(wallet.address)}
            {!wallet.isActive && (
              <span className="badge badge-warn" style={{ marginLeft: 8 }}>PAUSED</span>
            )}
          </div>
          <a
            href={SOLSCAN_WALLET + wallet.address}
            target="_blank"
            rel="noreferrer"
            className="wallet-card__address"
          >
            {shortAddr(wallet.address)}
            <span style={{ marginLeft: 4, fontSize: 9, color: "var(--accent2)" }}>↗</span>
          </a>
        </div>

        <div className="wallet-card__actions">
          {confirming ? (
            <>
              <span style={{ fontSize: 11, color: "var(--neg)", marginRight: 8 }}>
                Remove and stop copying?
              </span>
              <button
                className="btn btn-danger"
                onClick={handleRemove}
                disabled={removing}
                style={{ padding: "4px 12px", fontSize: 11 }}
              >
                {removing ? "Removing..." : "Confirm"}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setConfirming(false)}
                style={{ padding: "4px 10px", fontSize: 11, marginLeft: 4 }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="btn btn-ghost"
              onClick={handleRemove}
              style={{
                padding: "4px 12px", fontSize: 11,
                color: "var(--neg)", borderColor: "var(--neg)",
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="wallet-card__stats">
        <div className="w-stat">
          <span className="w-stat__label">Est. Capital</span>
          <span className="w-stat__value">{capital.toFixed(1)} SOL</span>
        </div>
        <div className="w-stat">
          <span className="w-stat__label">Trades Copied</span>
          <span className="w-stat__value">{wallet.totalTradesCopied || 0}</span>
        </div>
        <div className="w-stat">
          <span className="w-stat__label">Win Rate</span>
          <span className={`w-stat__value ${
            winRate !== null ? (parseFloat(winRate) >= 50 ? "pos" : "neg") : ""
          }`}>
            {winRate !== null ? `${winRate}%` : "—"}
          </span>
        </div>
        <div className="w-stat">
          <span className="w-stat__label">W / L</span>
          <span className="w-stat__value">
            <span className="pos">{wins}</span>
            <span style={{ color: "var(--muted)" }}> / </span>
            <span className="neg">{losses}</span>
          </span>
        </div>
        <div className="w-stat">
          <span className="w-stat__label">Total PnL</span>
          <span className={`w-stat__value ${pnl >= 0 ? "pos" : "neg"}`}>
            {pnlSign}{pnl.toFixed(3)} SOL
          </span>
        </div>
        <div className="w-stat">
          <span className="w-stat__label">Last Trade</span>
          <span className="w-stat__value">{lastTrade}</span>
        </div>
        <div className="w-stat">
          <span className="w-stat__label">Added</span>
          <span className="w-stat__value">{addedDate}</span>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  WALLETS PAGE
// ────────────────────────────────────────────────────────────

export default function Wallets() {
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const fetchWallets = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/wallets?activeOnly=${!showAll}`);
      setWallets(res.wallets || []);
    } catch {
      setWallets([]);
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => { fetchWallets(); }, [fetchWallets]);

  const active   = wallets.filter(w => w.isActive);
  const inactive = wallets.filter(w => !w.isActive);

  return (
    <div className="wallets-page fade-in">

      <AddWalletForm onAdded={fetchWallets} />

      {/* Toolbar */}
      <div className="wallets-toolbar">
        <div className="wallets-toolbar__count">
          {active.length} active wallet{active.length !== 1 ? "s" : ""}
          {inactive.length > 0 && ` · ${inactive.length} paused`}
        </div>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={showAll}
            onChange={e => setShowAll(e.target.checked)}
            style={{ width: "auto", marginRight: 6 }}
          />
          Show removed wallets
        </label>
      </div>

      {/* Wallet list */}
      {loading ? (
        <div className="card">
          <div className="empty-state" style={{ padding: 40 }}>
            <span className="empty-icon" style={{ animation: "pulse 1s infinite" }}>◎</span>
            <span className="empty-text">Loading wallets...</span>
          </div>
        </div>
      ) : wallets.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: 48 }}>
            <span className="empty-icon">◎</span>
            <span className="empty-text">No wallets tracked yet</span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              Add a wallet above to start copy trading
            </span>
          </div>
        </div>
      ) : (
        <div className="wallets-list">
          {wallets.map(w => (
            <WalletCard key={w.id || w.address} wallet={w} onRemoved={fetchWallets} />
          ))}
        </div>
      )}

      <style>{`
        .wallets-page { display: flex; flex-direction: column; gap: 16px; }

        /* add form */
        .add-form__fields {
          display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end;
          margin-bottom: 12px;
        }
        .field-group      { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 200px; }
        .field-group--btn { flex: 0; min-width: unset; }
        .field-label      { font-size: 10px; color: var(--muted);
          letter-spacing: 0.1em; text-transform: uppercase; }
        .form-msg          { font-size: 12px; padding: 8px 12px; border-radius: 2px; margin-top: 4px; }
        .form-msg--error   { background: rgba(255,59,107,0.1); color: var(--neg);
          border: 1px solid rgba(255,59,107,0.2); }
        .form-msg--success { background: rgba(0,229,160,0.08); color: var(--pos);
          border: 1px solid rgba(0,229,160,0.2); }
        .add-form__hint { font-size: 11px; color: var(--muted); margin-top: 8px; line-height: 1.6; }

        /* toolbar */
        .wallets-toolbar {
          display: flex; align-items: center; justify-content: space-between; padding: 4px 0;
        }
        .wallets-toolbar__count { font-size: 12px; color: var(--muted); }
        .toggle-label {
          font-size: 11px; color: var(--muted); cursor: pointer;
          display: flex; align-items: center;
        }

        /* wallet list */
        .wallets-list { display: flex; flex-direction: column; gap: 10px; }

        /* wallet card */
        .wallet-card {
          background: var(--bg2); border: 1px solid var(--border);
          padding: 18px; animation: fadeIn 0.3s ease;
          transition: border-color 0.2s;
        }
        .wallet-card:hover { border-color: var(--border2); }
        .wallet-card--inactive { opacity: 0.55; }

        .wallet-card__header {
          display: flex; justify-content: space-between; align-items: flex-start;
          margin-bottom: 14px; flex-wrap: wrap; gap: 10px;
        }
        .wallet-card__identity { display: flex; flex-direction: column; gap: 4px; }
        .wallet-card__name {
          font-family: var(--font-sans); font-size: 16px; font-weight: 700;
          letter-spacing: 0.02em; display: flex; align-items: center;
        }
        .wallet-card__address {
          font-family: var(--font-mono); font-size: 11px; color: var(--muted);
          text-decoration: none; letter-spacing: 0.05em;
        }
        .wallet-card__address:hover { color: var(--accent2); }
        .wallet-card__actions { display: flex; align-items: center; }

        /* stats */
        .wallet-card__stats {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
          gap: 12px 8px; padding-top: 14px; border-top: 1px solid var(--border);
        }
        .w-stat        { display: flex; flex-direction: column; gap: 3px; }
        .w-stat__label { font-size: 9px; color: var(--muted);
          letter-spacing: 0.1em; text-transform: uppercase; }
        .w-stat__value { font-size: 13px; font-weight: 600; font-family: var(--font-mono); }
        .w-stat__value.pos { color: var(--pos); }
        .w-stat__value.neg { color: var(--neg); }
        .pos { color: var(--pos); }
        .neg { color: var(--neg); }
      `}</style>
    </div>
  );
}