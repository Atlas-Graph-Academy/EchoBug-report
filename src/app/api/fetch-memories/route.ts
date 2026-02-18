import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const USER_ID = 'aab8c0c8-9315-47cf-922c-b8c193814df9';
const PAGE_SIZE = 1000;
const TOP_K = 20;

// Explicit columns — excludes description_embedding (huge vector)
const MEMORY_COLUMNS = [
  'id', 'object', 'category', 'emotion', 'description', 'details',
  'location', 'time', 'created_at', 'keys', 'is_public', 'type',
  'latitude', 'longitude', 'memory_image_url',
].join(',');

function log(label: string, startMs: number) {
  console.log(`[fetch-memories] ${label}: ${(Date.now() - startMs).toLocaleString()}ms`);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function fetchAllMemories() {
  const all: Record<string, unknown>[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('memory_new')
      .select(MEMORY_COLUMNS)
      .eq('user_id', USER_ID)
      .order('time', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

/**
 * Use pgvector's cosine distance operator (<=>) via the echobug_test_neighbors
 * Postgres function to compute TOP_K neighbors entirely in the database.
 */
async function fetchNeighborsFromDb(memoryIds: string[]) {
  const t0 = Date.now();

  const { data, error } = await supabaseAdmin.rpc('echobug_test_neighbors', {
    p_user_id: USER_ID,
    p_top_k: TOP_K,
  });

  if (error) {
    console.error('[fetch-memories] RPC error:', error.message, error.details, error.hint);
    throw new Error(`echobug_test_neighbors RPC failed: ${error.message}`);
  }

  const rowCount = data?.length ?? 0;
  log('DB neighbor query', t0);
  console.log(`[fetch-memories] neighbor rows returned: ${rowCount}`);

  // Debug: log first 3 rows to see the shape
  if (data && data.length > 0) {
    console.log('[fetch-memories] sample rows:', JSON.stringify(data.slice(0, 3)));
  } else {
    console.warn('[fetch-memories] WARNING: RPC returned 0 rows! Check if description_embedding column has data.');
  }

  const neighbors: Record<string, Array<{ id: string; similarity: number }>> = {};
  const allScores: number[] = [];

  for (const row of (data || [])) {
    const sid = String(row.source_id);
    const nid = String(row.neighbor_id);
    const sim = round4(Number(row.similarity));
    if (!neighbors[sid]) neighbors[sid] = [];
    neighbors[sid].push({ id: nid, similarity: sim });
    allScores.push(sim);
  }

  // Ensure all memory IDs have an entry
  for (const id of memoryIds) {
    if (!neighbors[id]) neighbors[id] = [];
  }

  // Compute stats
  allScores.sort((a, b) => a - b);
  const n = allScores.length;
  const mean = n > 0 ? allScores.reduce((s, v) => s + v, 0) / n : 0;
  const std = n > 0 ? Math.sqrt(allScores.reduce((s, v) => s + (v - mean) ** 2, 0) / n) : 0;
  const stats = {
    mean: round4(mean),
    std: round4(std),
    min: n > 0 ? allScores[0] : 0,
    max: n > 0 ? allScores[n - 1] : 0,
    p25: round4(percentile(allScores, 25)),
    p50: round4(percentile(allScores, 50)),
    p75: round4(percentile(allScores, 75)),
    count: n,
  };
  console.log(`[fetch-memories] stats:`, stats);

  return { neighbors, stats, _debug: { rowCount } };
}

export async function GET() {
  const t0 = Date.now();
  try {
    console.log('[fetch-memories] GET start');

    const allRows = await fetchAllMemories();
    log('DB fetch records', t0);
    console.log(`[fetch-memories] rows: ${allRows.length}`);

    const records = allRows.map((row: Record<string, unknown>) => ({
      id: String(row.id ?? ''),
      object: String(row.object ?? ''),
      category: String(row.category ?? 'Unknown'),
      emotion: String(row.emotion ?? 'Unknown'),
      description: String(row.description ?? ''),
      details: String(row.details ?? ''),
      location: String(row.location ?? ''),
      time: String(row.time ?? ''),
      createdAt: String(row.created_at ?? row.time ?? ''),
      keys: String(row.keys ?? ''),
      isPublic: Boolean(row.is_public),
      type: String(row.type ?? ''),
      latitude: row.latitude as number | null,
      longitude: row.longitude as number | null,
      memoryImageUrl: String(row.memory_image_url ?? ''),
    }));
    log('record mapping', t0);

    const memoryIds = records.map(r => r.id);
    const { neighbors, stats, _debug } = await fetchNeighborsFromDb(memoryIds);
    log('neighbors total', t0);

    // Count how many nodes actually have neighbors
    const nodesWithNeighbors = Object.values(neighbors).filter(n => n.length > 0).length;

    log('response ready', t0);
    return NextResponse.json({
      records,
      embeddingsData: { neighbors, stats },
      count: records.length,
      _debug: {
        ..._debug,
        nodesWithNeighbors,
        totalNodes: records.length,
        timing: `${Date.now() - t0}ms`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[fetch-memories] ERROR after ${Date.now() - t0}ms:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
