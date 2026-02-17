import { NextRequest, NextResponse } from 'next/server';
import { MEMORY_SESSION_COOKIE, verifySessionToken } from '@/lib/server/memory-auth';
import { setActiveKobeDataset } from '@/lib/server/memory-store';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const token = request.cookies.get(MEMORY_SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await setActiveKobeDataset();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Failed to switch dataset';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}

