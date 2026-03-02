// ============================================================
//  SOL SYSTEMS — TradeCard Component
//  File: dashboard/src/components/TradeCard.jsx
//
//  Displays a single trade entry — used in the live feed,
//  trade history table rows, and the best/worst trade panels.
//
//  Props:
//    trade       — trade object from the API
//    compact     — boolean, shows condensed single-line layout
//    showWallet  — boolean, shows which wallet was copied
// ============================================================

import React from 'react';

// ── Helpers ──────────────────────────────────────────────────

function formatSOL(val) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL`;
}

function formatPct(val) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function shortenTx(sig) {
  if (!sig) return null;
  return `${sig.slice(0, 6)}...${sig.slice(-4)}`;
}

// ────────────────────────────────────────────────────────────
//  TRADE CARD — Full layout
// ────────────────────────────────────────────────────────────

export function TradeCard({ trade, showWallet = false }) {
  if (!trade) return null;

  const isWin      = (trade.pnlSOL ?? 0) > 0;
  const isOpen     = trade.isOpen;
  const isBuy      = trade.tradeType === 'BUY';
  const pnlColor   = isOpen ? 'text-yellow-400' : isWin ? 'text-green-400' : 'text-red-400';
  const typeColor  = isBuy  ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400';
  const borderColor = isOpen ? 'border-yellow-500/30' : isWin ? 'border-green-500/30' : 'border-red-500/30';

  const solscanUrl = (trade.exitTxSignature || trade.entryTxSignature)
    ? `https://solscan.io/tx/${trade.exitTxSignature || trade.entryTxSignature}`
    : null;

  return (
    <div className={`rounded-lg border bg-gray-800/50 p-4 ${borderColor}`}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {/* Buy / Sell badge */}
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${typeColor}`}>
            {isBuy ? 'BUY' : 'SELL'}
          </span>

          {/* Token name */}
          <span className="font-semibold text-white text-sm">
            {trade.tokenSymbol || 'UNKNOWN'}
          </span>
          {trade.tokenName && trade.tokenName !== trade.tokenSymbol && (
            <span className="text-gray-400 text-xs">({trade.tokenName})</span>
          )}

          {/* Open badge */}
          {isOpen && (
            <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">
              OPEN
            </span>
          )}
        </div>

        {/* Timestamp */}
        <div className="text-right">
          <div className="text-xs text-gray-400">{formatTime(trade.createdAt)}</div>
          <div className="text-xs text-gray-500">{formatDate(trade.createdAt)}</div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-gray-500 mb-0.5">Amount</div>
          <div className="text-white font-medium">
            {trade.entryAmountSOL
              ? `${parseFloat(trade.entryAmountSOL).toFixed(4)} SOL`
              : '—'}
          </div>
        </div>

        <div>
          <div className="text-gray-500 mb-0.5">{isOpen ? 'Entry Price' : 'PnL'}</div>
          <div className={`font-medium ${isOpen ? 'text-white' : pnlColor}`}>
            {isOpen
              ? (trade.entryPriceSOL ? `$${parseFloat(trade.entryPriceSOL).toFixed(6)}` : '—')
              : formatSOL(trade.pnlSOL)
            }
          </div>
        </div>

        <div>
          <div className="text-gray-500 mb-0.5">ROI</div>
          <div className={`font-medium ${pnlColor}`}>
            {isOpen
              ? formatPct(trade.unrealizedPnlPct)
              : formatPct(trade.pnlPct)
            }
          </div>
        </div>
      </div>

      {/* Footer row */}
      {(showWallet || solscanUrl) && (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-700/50">
          {showWallet && trade.trackedWalletAddress && (
            <span className="text-xs text-gray-500">
              Copying: {trade.trackedWalletNickname || trade.trackedWalletAddress?.slice(0, 8) + '…'}
            </span>
          )}
          {solscanUrl && (
            <a
              href={solscanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 ml-auto"
            >
              View TX ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  COMPACT TRADE ROW — for dense table / feed layouts
// ────────────────────────────────────────────────────────────

export function TradeRow({ trade }) {
  if (!trade) return null;

  const isWin    = (trade.pnlSOL ?? 0) > 0;
  const isOpen   = trade.isOpen;
  const isBuy    = trade.tradeType === 'BUY';
  const pnlColor = isOpen ? 'text-yellow-400' : isWin ? 'text-green-400' : 'text-red-400';

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded hover:bg-gray-800/40 text-sm border-b border-gray-800/50 last:border-0">
      {/* Type indicator dot */}
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isBuy ? 'bg-green-500' : 'bg-red-500'}`} />

      {/* Token */}
      <div className="w-16 font-medium text-white truncate">
        {trade.tokenSymbol || '???'}
      </div>

      {/* Amount */}
      <div className="w-24 text-gray-300 text-xs">
        {trade.entryAmountSOL
          ? `${parseFloat(trade.entryAmountSOL).toFixed(3)} SOL`
          : '—'}
      </div>

      {/* PnL */}
      <div className={`flex-1 font-medium text-xs ${pnlColor}`}>
        {isOpen ? 'Open' : formatSOL(trade.pnlSOL)}
      </div>

      {/* ROI */}
      <div className={`w-16 text-right text-xs font-medium ${pnlColor}`}>
        {isOpen
          ? formatPct(trade.unrealizedPnlPct)
          : formatPct(trade.pnlPct)}
      </div>

      {/* Time */}
      <div className="w-12 text-right text-xs text-gray-500">
        {formatTime(trade.createdAt)}
      </div>
    </div>
  );
}

export default TradeCard;