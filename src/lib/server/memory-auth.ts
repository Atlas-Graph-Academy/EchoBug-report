import { createHmac, timingSafeEqual } from 'crypto';

export const MEMORY_SESSION_COOKIE = 'echo_memory_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 14; // 14 days

function getPassword(): string {
  return process.env.MEMORY_ACCESS_PASSWORD ?? '888';
}

function getSecret(): string {
  return process.env.MEMORY_SESSION_SECRET ?? 'local-memory-session-secret';
}

function sign(value: string): string {
  return createHmac('sha256', getSecret()).update(value).digest('base64url');
}

export function isPasswordValid(input: string): boolean {
  return input === getPassword();
}

export function createSessionToken(nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SEC;
  const payload = String(exp);
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string | undefined | null, nowMs = Date.now()): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const exp = Number(payload);
  if (!Number.isFinite(exp)) return false;
  return exp > Math.floor(nowMs / 1000);
}

export function getSessionMaxAgeSec(): number {
  return SESSION_MAX_AGE_SEC;
}

