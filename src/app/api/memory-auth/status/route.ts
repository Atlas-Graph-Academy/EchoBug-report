import { NextRequest, NextResponse } from 'next/server';
import { MEMORY_SESSION_COOKIE, verifySessionToken } from '@/lib/server/memory-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const token = request.cookies.get(MEMORY_SESSION_COOKIE)?.value;
  return NextResponse.json({ authenticated: verifySessionToken(token) });
}

