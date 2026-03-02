// ============================================================
//  SOL SYSTEMS — API Client
//  File: dashboard/src/api/client.js
//
//  Single Axios instance used by every hook and page to talk
//  to the backend. Centralising it here means:
//    - Auth header is set automatically on every request
//    - Base URL is configured once from the .env file
//    - Response errors are intercepted and normalized
//    - No copy-pasting headers across 10 different files
//
//  Usage:
//    import api from '../api/client';
//    const { data } = await api.get('/trades');
//    const { data } = await api.post('/wallets', { address, nickname });
// ============================================================

import axios from 'axios';

// Backend base URL — set VITE_API_URL in dashboard/.env
// Falls back to localhost:3001 for local development
const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// API key sent with every request — must match DASHBOARD_API_KEY on the backend
const API_KEY  = import.meta.env.VITE_API_KEY || '';

const api = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 15000,  // 15 second timeout — trades can be slow to aggregate
  headers: {
    'Content-Type': 'application/json',
    'x-api-key':    API_KEY,
  },
});

// ── Request interceptor ──────────────────────────────────────
// Log outgoing requests in development for debugging
api.interceptors.request.use(
  (config) => {
    if (import.meta.env.DEV) {
      console.debug(`[API] ${config.method?.toUpperCase()} ${config.url}`);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response interceptor ─────────────────────────────────────
// Normalize error messages so every component gets a clean
// error.message string instead of digging into axios structure
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status  = error.response?.status;
    const message = error.response?.data?.message
      || error.response?.data?.error
      || error.message
      || 'Unknown error';

    // 401 — API key mismatch (likely misconfigured .env)
    if (status === 401) {
      console.error('[API] Authentication failed — check VITE_API_KEY in dashboard/.env');
    }

    // 503 — backend is down or still booting
    if (status === 503) {
      console.warn('[API] Backend unavailable — may still be starting up');
    }

    // Attach normalized message so components can do: error.message
    const normalized       = new Error(message);
    normalized.status      = status;
    normalized.originalError = error;

    return Promise.reject(normalized);
  }
);

export default api;