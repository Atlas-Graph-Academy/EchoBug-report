import { NextRequest, NextResponse } from 'next/server';
import { loadMemoryBundle } from '@/lib/server/memory-store';
import { MEMORY_SESSION_COOKIE, verifySessionToken } from '@/lib/server/memory-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const token = request.cookies.get(MEMORY_SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const bundle = await loadMemoryBundle();
    return NextResponse.json(bundle);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Failed to load memory data';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}

