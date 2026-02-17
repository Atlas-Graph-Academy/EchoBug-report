import { NextResponse } from 'next/server';
import {
  MEMORY_SESSION_COOKIE,
  createSessionToken,
  getSessionMaxAgeSec,
  isPasswordValid,
} from '@/lib/server/memory-auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  const password = body.password?.trim() || '';
  if (!isPasswordValid(password)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(MEMORY_SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: getSessionMaxAgeSec(),
  });
  return response;
}

