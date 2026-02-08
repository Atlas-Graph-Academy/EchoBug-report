const LINEAR_CLIENT_ID = process.env.NEXT_PUBLIC_LINEAR_CLIENT_ID!;
const REDIRECT_URI = process.env.NEXT_PUBLIC_REDIRECT_URI!;
const LINEAR_AUTH_URL = 'https://linear.app/oauth/authorize';
const LINEAR_SCOPES = 'read,write,issues:create';
const SCOPE_VERSION = 'v2'; // bump to force re-auth when scopes change

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

function base64UrlEncode(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  let str = '';
  bytes.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateRandomString(64);
  const hashed = await sha256(verifier);
  const challenge = base64UrlEncode(hashed);
  return { verifier, challenge };
}

export function startLogin(): void {
  generatePKCE().then(({ verifier, challenge }) => {
    const state = generateRandomString(32);

    sessionStorage.setItem('pkce_verifier', verifier);
    sessionStorage.setItem('oauth_state', state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: LINEAR_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: LINEAR_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    window.location.href = `${LINEAR_AUTH_URL}?${params}`;
  });
}

export async function exchangeCode(code: string): Promise<Record<string, unknown>> {
  const verifier = sessionStorage.getItem('pkce_verifier');
  if (!verifier) throw new Error('Missing PKCE verifier');

  const res = await fetch('/api/linear/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: REDIRECT_URI }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokens = await res.json();
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('oauth_state');
  return tokens;
}

export async function refreshAccessToken(refreshToken: string): Promise<Record<string, unknown>> {
  const res = await fetch('/api/linear/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) throw new Error('Token refresh failed');
  return await res.json();
}

import type { LinearTokens, LinearUser } from './types';

export function getTokens(): LinearTokens | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('echobug_tokens');
  if (!raw) return null;
  try {
    const tokens = JSON.parse(raw) as LinearTokens & { scope_version?: string };
    if (tokens.scope_version !== SCOPE_VERSION) {
      clearTokens();
      return null;
    }
    return tokens;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: Record<string, unknown>): void {
  const data = { ...tokens, saved_at: Date.now(), scope_version: SCOPE_VERSION };
  localStorage.setItem('echobug_tokens', JSON.stringify(data));
}

export function clearTokens(): void {
  localStorage.removeItem('echobug_tokens');
  localStorage.removeItem('echobug_user');
}

export function getUser(): LinearUser | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('echobug_user');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveUser(user: LinearUser): void {
  localStorage.setItem('echobug_user', JSON.stringify(user));
}

export function isTokenExpired(tokens: LinearTokens): boolean {
  if (!tokens.saved_at || !tokens.expires_in) return true;
  const expiresAt = tokens.saved_at + tokens.expires_in * 1000;
  return Date.now() > expiresAt - 60000;
}

export function getOAuthState(): string | null {
  return sessionStorage.getItem('oauth_state');
}
