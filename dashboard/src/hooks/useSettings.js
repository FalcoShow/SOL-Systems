// ============================================================
//  SOL SYSTEMS — useSettings Hook
//  File: dashboard/src/hooks/useSettings.js
//
//  React hook for reading and updating system settings.
//  Used by the Settings page and the top nav pause/resume button.
//
//  Returns:
//    settings        — current settings object (or null while loading)
//    isLoading       — true on first fetch
//    isSaving        — true while a PUT is in flight
//    error           — error message string or null
//    updateSettings  — async fn to save one or more fields
//    pauseTrading    — async fn to trigger emergency stop
//    resumeTrading   — async fn to re-enable trading
//    refresh         — manually re-fetch settings
//
//  Usage:
//    const { settings, updateSettings, pauseTrading } = useSettings();
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

export function useSettings() {
  const [settings,  setSettings]  = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving,  setIsSaving]  = useState(false);
  const [error,     setError]     = useState(null);

  // ── Fetch current settings ───────────────────────────────
  const fetchSettings = useCallback(async () => {
    try {
      setError(null);
      const { data } = await api.get('/settings');
      setSettings(data.settings);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // ── Update one or more settings fields ───────────────────
  // Optimistically updates local state, rolls back on error.
  const updateSettings = useCallback(async (updates) => {
    const previous = settings;
    setSettings((s) => ({ ...s, ...updates }));
    setIsSaving(true);
    setError(null);

    try {
      const { data } = await api.put('/settings', updates);
      setSettings(data.settings);
      return { success: true };
    } catch (err) {
      setSettings(previous); // rollback
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setIsSaving(false);
    }
  }, [settings]);

  // ── Pause trading ────────────────────────────────────────
  const pauseTrading = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      await api.post('/settings/pause');
      setSettings((s) => ({ ...s, isTradingPaused: true }));
      return { success: true };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setIsSaving(false);
    }
  }, []);

  // ── Resume trading ───────────────────────────────────────
  const resumeTrading = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      await api.post('/settings/resume');
      setSettings((s) => ({ ...s, isTradingPaused: false }));
      return { success: true };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setIsSaving(false);
    }
  }, []);

  // ── Send test Telegram message ───────────────────────────
  const testTelegram = useCallback(async () => {
    try {
      await api.post('/settings/test-telegram');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }, []);

  return {
    settings,
    isLoading,
    isSaving,
    error,
    updateSettings,
    pauseTrading,
    resumeTrading,
    testTelegram,
    refresh: fetchSettings,
  };
}