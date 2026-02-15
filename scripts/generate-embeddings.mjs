/**
 * Pre-compute embeddings for all memory descriptions
 *
 * Reads CSV → calls OpenAI text-embedding-3-small on each description →
 * computes pairwise cosine similarity → stores Top-10 neighbors per memory →
 * outputs public/echo-embeddings.json
 *
 * Usage: OPENAI_API_KEY=sk-xxx node scripts/generate-embeddings.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CSV_PATH = resolve(ROOT, 'public/echo-memories-2026-02-15.csv');
const OUTPUT_PATH = resolve(ROOT, 'public/echo-embeddings.json');

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const TOP_K = 10;
const BATCH_SIZE = 50; // OpenAI supports up to 2048 inputs per request

// ─── CSV Parser ───

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (char !== '\r') field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function mapRecords(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  const idx = (name) => header.indexOf(name);

  return rows.slice(1)
    .filter(row => row.some(v => v.trim().length > 0))
    .map(row => ({
      id: (row[idx('id')] || '').trim(),
      object: (row[idx('object')] || '').trim(),
      category: (row[idx('category')] || '').trim(),
      description: (row[idx('description')] || '').trim(),
      created_at: (row[idx('created_at')] || '').trim(),
    }));
}

// ─── OpenAI Embedding API ───

async function fetchEmbeddings(texts) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  // API returns embeddings sorted by index
  return data.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

async function embedAllDescriptions(records) {
  const embeddings = new Array(records.length);
  const totalBatches = Math.ceil(records.length / BATCH_SIZE);

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, records.length);
    const texts = records.slice(start, end).map(r => r.description || r.object || 'empty');

    console.log(`  Batch ${batch + 1}/${totalBatches} (records ${start}-${end - 1})...`);

    const batchEmbeddings = await fetchEmbeddings(texts);
    for (let i = 0; i < batchEmbeddings.length; i++) {
      embeddings[start + i] = batchEmbeddings[i];
    }

    // Rate limit: small pause between batches
    if (batch < totalBatches - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return embeddings;
}

// ─── Cosine Similarity ───

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function computeTopKNeighbors(records, embeddings, k) {
  console.log(`  Computing Top-${k} neighbors for ${records.length} records...`);

  const neighbors = {};

  for (let i = 0; i < records.length; i++) {
    if (i % 100 === 0) console.log(`    Progress: ${i}/${records.length}`);

    const scores = [];
    for (let j = 0; j < records.length; j++) {
      if (i === j) continue;
      scores.push({
        id: records[j].id,
        similarity: cosineSimilarity(embeddings[i], embeddings[j]),
      });
    }

    // Sort descending by similarity, take top K
    scores.sort((a, b) => b.similarity - a.similarity);
    neighbors[records[i].id] = scores.slice(0, k).map(s => ({
      id: s.id,
      similarity: Math.round(s.similarity * 10000) / 10000, // 4 decimal places
    }));
  }

  return neighbors;
}

// ─── Main ───

async function main() {
  console.log('Reading CSV...');
  const csvContent = readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCsv(csvContent);
  const records = mapRecords(rows);
  console.log(`  Found ${records.length} records\n`);

  console.log('Generating embeddings via OpenAI text-embedding-3-small...');
  const embeddings = await embedAllDescriptions(records);
  console.log(`  Done: ${embeddings.length} embeddings generated\n`);

  console.log('Computing similarity neighbors...');
  const neighbors = computeTopKNeighbors(records, embeddings, TOP_K);
  console.log('  Done\n');

  // Build output: neighbors only (no raw embeddings to save space)
  const output = {
    model: 'text-embedding-3-small',
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    topK: TOP_K,
    neighbors,
  };

  console.log('Writing output...');
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');

  const fileSizeKB = Math.round(readFileSync(OUTPUT_PATH).length / 1024);
  console.log(`  Saved to ${OUTPUT_PATH} (${fileSizeKB} KB)`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
