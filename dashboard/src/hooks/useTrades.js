// ============================================================
//  SOL SYSTEMS — useTrades Hook
//  File: dashboard/src/hooks/useTrades.js
//
//  React hook for fetching and filtering trade history.
//  Used by the Trades page, the live feed, and the dashboard.
//
//  Returns:
//    trades          — array of trade objects
//    openTrades      — currently open positions
//    stats           — 24h aggregate stats
//    pagination      — { total, page, limit, totalPages }
//    isLoading       — true on first fetch
//    isRefreshing    — true on background refresh
//    error           — error message string or null
//    setFilters      — update filter criteria (triggers re-fetch)
//    setPage         — change the current page
//    refresh         — manually re-fetch
//
//  Usage:
//    const { trades, stats, setFilters } = useTrades();
//    const { trades: open } = useOpenTrades();   // convenience export
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api/client';

// Default filter state
const DEFAULT_FILTERS = {
  wallet:  '',
  token:   '',
  result:  '',   // '' | 'win' | 'loss' | 'open'
  from:    '',
  to:      '',
};

export function useTrades(autoRefreshMs = 0) {
  const [trades,       setTrades]       = useState([]);
  const [pagination,   setPagination]   = useState({ total: 0, page: 1, limit: 50, totalPages: 0 });
  const [stats,        setStats]        = useState(null);
  const [filters,      setFiltersState] = useState(DEFAULT_FILTERS);
  const [page,         setPage]         = useState(1);
  const [isLoading,    setIsLoading]    = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error,        setError]        = useState(null);

  const intervalRef = useRef(null);

  // ── Build query params from current filter state ─────────
  const buildParams = useCallback((currentFilters, currentPage) => {
    const params = { page: currentPage, limit: 50 };
    if (currentFilters.wallet) params.wallet = currentFilters.wallet;
    if (currentFilters.token)  params.token  = currentFilters.token;
    if (currentFilters.result) params.result = currentFilters.result;
    if (currentFilters.from)   params.from   = currentFilters.from;
    if (currentFilters.to)     params.to     = currentFilters.to;
    return params;
  }, []);

  // ── Fetch trades ─────────────────────────────────────────
  const fetchTrades = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    else         setIsRefreshing(true);
    setError(null);

    try {
      const params = buildParams(filters, page);
      const { data } = await api.get('/trades', { params });
      setTrades(data.trades || []);
      setPagination(data.pagination || {});
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [filters, page, buildParams]);

  // ── Fetch 24h stats ──────────────────────────────────────
  const fetchStats = useCallback(async () => {
    try {
      const { data } = await api.get('/trades/stats/24h');
      setStats(data);
    } catch {
      // Stats are non-critical — fail silently
    }
  }, []);

  // ── Initial load + re-fetch when filters/page change ─────
  useEffect(() => {
    fetchTrades();
    fetchStats();
  }, [fetchTrades, fetchStats]);

  // ── Auto-refresh ─────────────────────────────────────────
  useEffect(() => {
    if (autoRefreshMs > 0) {
      intervalRef.current = setInterval(() => {
        fetchTrades(true); // silent = true → no loading spinner
      }, autoRefreshMs);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefreshMs, fetchTrades]);

  // ── Update filters and reset to page 1 ───────────────────
  const setFilters = useCallback((newFilters) => {
    setFiltersState((prev) => ({ ...prev, ...newFilters }));
    setPage(1);
  }, []);

  const resetFilters = useCallback(() => {
    setFiltersState(DEFAULT_FILTERS);
    setPage(1);
  }, []);

  return {
    trades,
    pagination,
    stats,
    filters,
    page,
    isLoading,
    isRefreshing,
    error,
    setFilters,
    resetFilters,
    setPage,
    refresh: () => fetchTrades(false),
  };
}

// ── Convenience hook for open positions only ─────────────────
export function useOpenTrades(autoRefreshMs = 5000) {
  const [trades,    setTrades]    = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error,     setError]     = useState(null);
  const intervalRef = useRef(null);

  const fetch = useCallback(async () => {
    try {
      const { data } = await api.get('/trades/open');
      setTrades(data.trades || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    if (autoRefreshMs > 0) {
      intervalRef.current = setInterval(fetch, autoRefreshMs);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetch, autoRefreshMs]);

  return { trades, isLoading, error, refresh: fetch };
}