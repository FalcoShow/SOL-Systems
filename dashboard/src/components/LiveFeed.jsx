// ============================================================
//  SOL SYSTEMS — LiveFeed Component
//  File: dashboard/src/components/LiveFeed.jsx
//
//  Auto-refreshing real-time trade feed. Polls the API every
//  2 seconds and animates new trades appearing at the top.
//  Also connects to the WebSocket (/ws) for instant push
//  updates when a trade executes.
//
//  Props:
//    maxTrades   — max trades to show (default 20)
//    compact     — boolean, use condensed row layout
//    showHeader  — boolean, show title + status bar
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TradeRow, TradeCard } from './TradeCard';
import api from '../api/client';

const POLL_INTERVAL_MS = 2000;
const WS_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3001')
  .replace(/^http/, 'ws') + '/ws';

// ────────────────────────────────────────────────────────────
//  LIVE FEED
// ────────────────────────────────────────────────────────────

export function LiveFeed({
  maxTrades  = 20,
  compact    = true,
  showHeader = true,
}) {
  const [trades,     setTrades]     = useState([]);
  const [isLive,     setIsLive]     = useState(false);  // WS connected
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error,      setError]      = useState(null);

  const wsRef          = useRef(null);
  const pollRef        = useRef(null);
  const knownIdsRef    = useRef(new Set());
  const newTradeIdsRef = useRef(new Set()); // for flash animation

  // ── Fetch latest trades from REST ───────────────────────
  const fetchTrades = useCallback(async (silent = true) => {
    try {
      const { data } = await api.get('/trades', {
        params: { limit: maxTrades, page: 1 },
      });

      const incoming = data.trades || [];

      // Find brand-new trades not seen before
      const newIds = incoming
        .filter((t) => !knownIdsRef.current.has(t.id))
        .map((t) => t.id);

      if (newIds.length > 0) {
        newIds.forEach((id) => {
          knownIdsRef.current.add(id);
          newTradeIdsRef.current.add(id);
        });

        // Clear flash animation after 2s
        setTimeout(() => {
          newIds.forEach((id) => newTradeIdsRef.current.delete(id));
        }, 2000);
      }

      setTrades(incoming.slice(0, maxTrades));
      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      if (!silent) setError(err.message);
    }
  }, [maxTrades]);

  // ── WebSocket connection for instant push updates ────────
  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        setIsLive(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          // Re-fetch on any trade event so we have the full DB record
          if (['TRADE_CONFIRMED', 'TRADE_EXECUTED', 'POSITION_CLOSED'].includes(msg.type)) {
            fetchTrades(true);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setIsLive(false);
        // Reconnect after 5s
        setTimeout(connectWS, 5000);
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      // WS not available — rely on polling only
      setIsLive(false);
    }
  }, [fetchTrades]);

  // ── Start polling + WS on mount ──────────────────────────
  useEffect(() => {
    fetchTrades(false); // initial load — show error if fails
    connectWS();

    // Fallback poll even with WS connected (catches missed events)
    pollRef.current = setInterval(() => fetchTrades(true), POLL_INTERVAL_MS);

    return () => {
      clearInterval(pollRef.current);
      wsRef.current?.close();
    };
  }, [fetchTrades, connectWS]);

  // ────────────────────────────────────────────────────────
  //  RENDER
  // ────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {showHeader && (
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-white">Live Feed</h3>
            {/* Live / polling indicator */}
            <div className="flex items-center gap-1">
              <div className={`w-1.5 h-1.5 rounded-full ${
                isLive ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'
              }`} />
              <span className="text-xs text-gray-500">
                {isLive ? 'Live' : 'Polling'}
              </span>
            </div>
          </div>
          {lastUpdate && (
            <span className="text-xs text-gray-600">
              {lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 mb-2">
          {error}
        </div>
      )}

      {/* Empty state */}
      {trades.length === 0 && !error && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-gray-600 text-2xl mb-2">📡</div>
            <div className="text-gray-500 text-sm">Watching for trades…</div>
            <div className="text-gray-600 text-xs mt-1">
              Trades appear here the instant they execute
            </div>
          </div>
        </div>
      )}

      {/* Trade list */}
      {trades.length > 0 && (
        <div className="flex-1 overflow-y-auto space-y-1 pr-0.5">
          {trades.map((trade) => {
            const isNew = newTradeIdsRef.current.has(trade.id);

            return (
              <div
                key={trade.id}
                className={`transition-all duration-500 ${
                  isNew ? 'animate-pulse ring-1 ring-blue-500/40 rounded-lg' : ''
                }`}
              >
                {compact
                  ? <TradeRow  trade={trade} />
                  : <TradeCard trade={trade} showWallet />
                }
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default LiveFeed;