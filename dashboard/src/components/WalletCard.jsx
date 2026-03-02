// ============================================================
//  SOL SYSTEMS — WalletCard Component
//  File: dashboard/src/components/WalletCard.jsx
//
//  Displays a tracked wallet's summary — used in the Wallets
//  page and the dashboard sidebar panel.
//
//  Props:
//    wallet      — wallet object from the API
//    onRemove    — callback fn(address) when remove is clicked
//    onEdit      — callback fn(wallet) when edit is clicked
//    showStats   — boolean, show PnL stats below card (default true)
// ============================================================

import React, { useState } from 'react';

// ── Helpers ──────────────────────────────────────────────────

function shorten(address) {
  if (!address) return '—';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatSOL(val) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(4)} SOL`;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ────────────────────────────────────────────────────────────
//  WALLET CARD
// ────────────────────────────────────────────────────────────

export function WalletCard({ wallet, onRemove, onEdit, showStats = true }) {
  const [copied,         setCopied]         = useState(false);
  const [confirmRemove,  setConfirmRemove]  = useState(false);

  if (!wallet) return null;

  const isActive      = wallet.isActive !== false;
  const estimatedCap  = wallet.capitalOverrideSOL ?? wallet.estimatedCapitalSOL ?? 0;
  const hasStats      = wallet.stats && showStats;

  const handleCopy = () => {
    copyToClipboard(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRemoveConfirm = () => {
    setConfirmRemove(false);
    onRemove?.(wallet.address);
  };

  const solscanUrl = `https://solscan.io/account/${wallet.address}`;

  return (
    <div className={`rounded-lg border bg-gray-800/50 p-4 ${
      isActive ? 'border-green-500/30' : 'border-gray-600/30'
    }`}>

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          {/* Nickname + status badge */}
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-white">{wallet.nickname}</span>
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${
              isActive
                ? 'bg-green-500/20 text-green-400'
                : 'bg-gray-500/20 text-gray-400'
            }`}>
              {isActive ? 'ACTIVE' : 'PAUSED'}
            </span>
          </div>

          {/* Address with copy button */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400 font-mono">
              {shorten(wallet.address)}
            </span>
            <button
              onClick={handleCopy}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              title="Copy address"
            >
              {copied ? '✓' : '⧉'}
            </button>
            <a
              href={solscanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300"
              title="View on Solscan"
            >
              ↗
            </a>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5">
          {onEdit && (
            <button
              onClick={() => onEdit(wallet)}
              className="text-xs text-gray-400 hover:text-white bg-gray-700/50 hover:bg-gray-700 px-2 py-1 rounded transition-colors"
            >
              Edit
            </button>
          )}
          {onRemove && !confirmRemove && (
            <button
              onClick={() => setConfirmRemove(true)}
              className="text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 px-2 py-1 rounded transition-colors"
            >
              Remove
            </button>
          )}
          {confirmRemove && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-red-400">Sure?</span>
              <button
                onClick={handleRemoveConfirm}
                className="text-xs text-red-400 bg-red-500/20 hover:bg-red-500/30 px-2 py-1 rounded"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                className="text-xs text-gray-400 bg-gray-700/50 hover:bg-gray-700 px-2 py-1 rounded"
              >
                No
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Capital row */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-gray-500 mb-0.5">Est. Capital</div>
          <div className="text-white font-medium">
            {estimatedCap > 0 ? `${estimatedCap.toFixed(1)} SOL` : 'Unknown'}
            {wallet.capitalOverrideSOL && (
              <span className="text-gray-500 ml-1">(manual)</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Trades Detected</div>
          <div className="text-white font-medium">
            {wallet.detectedTradeCount ?? wallet._count?.walletTrades ?? 0}
          </div>
        </div>
      </div>

      {/* Optional stats section */}
      {hasStats && (
        <div className="mt-3 pt-3 border-t border-gray-700/50 grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-gray-500 mb-0.5">Copy PnL</div>
            <div className={`font-medium ${
              (wallet.stats.grossPnlSOL ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
            }`}>
              {formatSOL(wallet.stats.grossPnlSOL)}
            </div>
          </div>
          <div>
            <div className="text-gray-500 mb-0.5">Win Rate</div>
            <div className="text-white font-medium">
              {wallet.stats.winRate != null ? `${wallet.stats.winRate.toFixed(1)}%` : '—'}
            </div>
          </div>
          <div>
            <div className="text-gray-500 mb-0.5">Trades</div>
            <div className="text-white font-medium">
              {wallet.stats.totalTrades ?? 0}
            </div>
          </div>
        </div>
      )}

      {/* Last seen */}
      {wallet.lastSeenAt && (
        <div className="mt-2 text-xs text-gray-600">
          Last trade: {new Date(wallet.lastSeenAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}

export default WalletCard;