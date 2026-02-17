import { NextRequest, NextResponse } from 'next/server';
import { MEMORY_SESSION_COOKIE, verifySessionToken } from '@/lib/server/memory-auth';
import { importCsvDataset } from '@/lib/server/memory-store';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const token = request.cookies.get(MEMORY_SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const file = form.get('file');
    const name = String(form.get('name') || 'Imported dataset');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing CSV file' }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      return NextResponse.json({ error: 'Only CSV file is supported' }, { status: 400 });
    }

    const csvText = await file.text();
    const result = await importCsvDataset(csvText, name);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Import failed';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}

