'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { LinearUser } from '@/lib/types';
import {
  getTokens,
  saveTokens,
  clearTokens,
  getUser,
  saveUser,
  isTokenExpired,
  startLogin,
  exchangeCode,
  refreshAccessToken,
  getOAuthState,
} from '@/lib/oauth';
import { fetchLinearUser } from '@/lib/linear';

interface AuthState {
  user: LinearUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: () => void;
  logout: () => void;
  getAccessToken: () => string | null;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<LinearUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const getAccessToken = useCallback((): string | null => {
    const tokens = getTokens();
    return tokens?.access_token ?? null;
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = setInterval(async () => {
      const tokens = getTokens();
      if (!tokens?.refresh_token) return;
      try {
        const fresh = await refreshAccessToken(tokens.refresh_token);
        saveTokens(fresh);
      } catch {
        // Silent fail
      }
    }, 20 * 60 * 60 * 1000); // 20 hours
  }, []);

  const logout = useCallback(() => {
    clearTokens();
    setUser(null);
    setError(null);
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
  }, []);

  const login = useCallback(() => {
    startLogin();
  }, []);

  useEffect(() => {
    const init = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const returnedState = params.get('state');

      // Handle OAuth callback
      if (code) {
        window.history.replaceState({}, '', window.location.pathname);

        const savedState = getOAuthState();
        if (returnedState !== savedState) {
          setError('Login failed: state mismatch. Please try again.');
          setIsLoading(false);
          return;
        }

        try {
          const tokens = await exchangeCode(code);
          saveTokens(tokens);
          const linearUser = await fetchLinearUser(tokens.access_token as string);
          saveUser(linearUser);
          setUser(linearUser);
          scheduleRefresh();
        } catch (err) {
          console.error('OAuth error:', err);
          setError('Login failed. Please try again.');
        }
        setIsLoading(false);
        return;
      }

      // Handle error callback
      if (params.get('error')) {
        window.history.replaceState({}, '', window.location.pathname);
        setError(`Login denied: ${params.get('error_description') || params.get('error')}`);
        setIsLoading(false);
        return;
      }

      // Check existing session
      const tokens = getTokens();
      const cachedUser = getUser();

      if (tokens && cachedUser) {
        setUser(cachedUser);
        setIsLoading(false);
        scheduleRefresh();

        // Refresh in background if expired
        if (isTokenExpired(tokens) && tokens.refresh_token) {
          try {
            const fresh = await refreshAccessToken(tokens.refresh_token);
            saveTokens(fresh);
            const updatedUser = await fetchLinearUser(fresh.access_token as string);
            saveUser(updatedUser);
            setUser(updatedUser);
          } catch {
            // Keep using cached data
          }
        }
        return;
      }

      if (tokens) {
        try {
          let accessToken = tokens.access_token;
          if (isTokenExpired(tokens) && tokens.refresh_token) {
            const fresh = await refreshAccessToken(tokens.refresh_token);
            saveTokens(fresh);
            accessToken = fresh.access_token as string;
          }
          const linearUser = await fetchLinearUser(accessToken);
          saveUser(linearUser);
          setUser(linearUser);
          scheduleRefresh();
        } catch {
          clearTokens();
          setError('Session expired. Please log in again.');
        }
        setIsLoading(false);
        return;
      }

      // No session
      setIsLoading(false);
    };

    init();

    // Refresh on visibility change
    const handleVisibility = async () => {
      if (document.visibilityState !== 'visible') return;
      const tokens = getTokens();
      if (!tokens?.refresh_token || !isTokenExpired(tokens)) return;
      try {
        const fresh = await refreshAccessToken(tokens.refresh_token);
        saveTokens(fresh);
      } catch {
        // Silent
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [scheduleRefresh]);

  return {
    user,
    isAuthenticated: !!user,
    isLoading,
    error,
    login,
    logout,
    getAccessToken,
  };
}
