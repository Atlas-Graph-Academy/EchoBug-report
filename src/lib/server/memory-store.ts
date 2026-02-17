import { mkdir, readFile, writeFile, copyFile, access } from 'fs/promises';
import path from 'path';
import type { EmbeddingsData } from '@/lib/narrative';

export interface MemoryRecord {
  id: string;
  object: string;
  category: string;
  emotion: string;
  description: string;
  details: string;
  visibility: string;
  location: string;
  time: string;
  createdAt: string;
}

interface ActiveSourceMeta {
  datasetId: string;
  label: string;
  csvPath: string;
  embeddingsPath: string;
  owner: 'kobe' | 'user';
  updatedAt: string;
}

export interface MemoryBundle {
  records: MemoryRecord[];
  embeddingsData: EmbeddingsData;
  source: {
    datasetId: string;
    label: string;
    owner: 'kobe' | 'user';
    updatedAt: string;
  };
}

const ROOT = process.cwd();
const DATA_ROOT = path.join(ROOT, 'data', 'memory');
const DATASET_ROOT = path.join(DATA_ROOT, 'datasets');
const ACTIVE_FILE = path.join(DATA_ROOT, 'active-source.json');
const KOBE_DATASET_ID = 'kobe-default';
const KOBE_CSV_PUBLIC = path.join(ROOT, 'public', 'echo-memories-2026-02-15.csv');
const KOBE_EMBEDDINGS_PUBLIC = path.join(ROOT, 'public', 'echo-embeddings.json');

const TOP_K = 10;
const EMBEDDING_BATCH_SIZE = 50;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureBootstrap(): Promise<void> {
  await mkdir(DATASET_ROOT, { recursive: true });
  const kobeDir = path.join(DATASET_ROOT, KOBE_DATASET_ID);
  await mkdir(kobeDir, { recursive: true });

  const kobeCsv = path.join(kobeDir, 'records.csv');
  const kobeEmb = path.join(kobeDir, 'embeddings.json');
  if (!(await exists(kobeCsv))) {
    await copyFile(KOBE_CSV_PUBLIC, kobeCsv);
  }
  if (!(await exists(kobeEmb))) {
    await copyFile(KOBE_EMBEDDINGS_PUBLIC, kobeEmb);
  }

  if (!(await exists(ACTIVE_FILE))) {
    const meta: ActiveSourceMeta = {
      datasetId: KOBE_DATASET_ID,
      label: 'Kobe dataset',
      csvPath: kobeCsv,
      embeddingsPath: kobeEmb,
      owner: 'kobe',
      updatedAt: new Date().toISOString(),
    };
    await writeFile(ACTIVE_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  }
}

async function readActiveSource(): Promise<ActiveSourceMeta> {
  await ensureBootstrap();
  const raw = await readFile(ACTIVE_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as ActiveSourceMeta;
  if (
    !parsed ||
    !parsed.datasetId ||
    !parsed.csvPath ||
    !parsed.embeddingsPath ||
    !(await exists(parsed.csvPath)) ||
    !(await exists(parsed.embeddingsPath))
  ) {
    await setActiveKobeDataset();
    return readActiveSource();
  }
  return parsed;
}

async function writeActiveSource(meta: ActiveSourceMeta): Promise<void> {
  await ensureBootstrap();
  await writeFile(ACTIVE_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char !== '\r') field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function mapRecords(rows: string[][]): MemoryRecord[] {
  if (!rows.length) return [];
  const header = rows[0];
  const idx = (name: string) => header.indexOf(name);
  const read = (row: string[], index: number) => (index >= 0 ? (row[index] ?? '').trim() : '');

  return rows
    .slice(1)
    .filter((row) => row.some((v) => v.trim().length > 0))
    .map((row, i) => {
      const id = read(row, idx('id')) || `mem-${i + 1}`;
      const createdAt = read(row, idx('created_at')) || read(row, idx('createdAt'));
      return {
        id,
        object: read(row, idx('object')) || id,
        category: read(row, idx('category')) || 'Unknown',
        emotion: read(row, idx('emotion')) || 'Unknown',
        description: read(row, idx('description')) || '',
        details: read(row, idx('details')) || '',
        visibility: read(row, idx('visibility')) || 'Unknown',
        location: read(row, idx('location')) || 'Unknown',
        time: read(row, idx('time')) || createdAt || '',
        createdAt: createdAt || read(row, idx('time')) || '',
      };
    });
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const k of a) if (b.has(k)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

async function fetchEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${errorText}`);
  }
  const json = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function buildNeighborsByEmbeddings(records: MemoryRecord[], apiKey: string): Promise<EmbeddingsData> {
  const vectors: number[][] = new Array(records.length);
  const totalBatches = Math.ceil(records.length / EMBEDDING_BATCH_SIZE);
  for (let batch = 0; batch < totalBatches; batch += 1) {
    const start = batch * EMBEDDING_BATCH_SIZE;
    const end = Math.min(start + EMBEDDING_BATCH_SIZE, records.length);
    const texts = records
      .slice(start, end)
      .map((r) => (r.description || r.details || r.object || '').trim() || 'empty');
    const embedded = await fetchEmbeddings(texts, apiKey);
    for (let i = 0; i < embedded.length; i += 1) vectors[start + i] = embedded[i];
  }

  const neighbors: Record<string, Array<{ id: string; similarity: number }>> = {};
  for (let i = 0; i < records.length; i += 1) {
    const scores: Array<{ id: string; similarity: number }> = [];
    for (let j = 0; j < records.length; j += 1) {
      if (i === j) continue;
      scores.push({
        id: records[j].id,
        similarity: round4(cosineSimilarity(vectors[i], vectors[j])),
      });
    }
    scores.sort((a, b) => b.similarity - a.similarity);
    neighbors[records[i].id] = scores.slice(0, TOP_K);
  }
  return { neighbors };
}

function buildNeighborsFallback(records: MemoryRecord[]): EmbeddingsData {
  const tokenSets = records.map((r) => tokenize(`${r.object} ${r.description} ${r.details} ${r.category}`));
  const neighbors: Record<string, Array<{ id: string; similarity: number }>> = {};
  for (let i = 0; i < records.length; i += 1) {
    const scores: Array<{ id: string; similarity: number }> = [];
    for (let j = 0; j < records.length; j += 1) {
      if (i === j) continue;
      scores.push({ id: records[j].id, similarity: round4(jaccard(tokenSets[i], tokenSets[j])) });
    }
    scores.sort((a, b) => b.similarity - a.similarity);
    neighbors[records[i].id] = scores.slice(0, TOP_K);
  }
  return { neighbors };
}

async function buildEmbeddingsData(records: MemoryRecord[]): Promise<EmbeddingsData> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && records.length > 0) {
    try {
      return await buildNeighborsByEmbeddings(records, apiKey);
    } catch {
      return buildNeighborsFallback(records);
    }
  }
  return buildNeighborsFallback(records);
}

export async function loadMemoryBundle(): Promise<MemoryBundle> {
  const source = await readActiveSource();
  const csvContent = await readFile(source.csvPath, 'utf-8');
  const records = mapRecords(parseCsv(csvContent));
  const embRaw = await readFile(source.embeddingsPath, 'utf-8');
  const embParsed = JSON.parse(embRaw) as Partial<EmbeddingsData> & {
    neighbors?: Record<string, Array<{ id: string; similarity: number }>>;
  };
  const embeddingsData: EmbeddingsData = {
    neighbors: embParsed.neighbors || {},
  };
  return {
    records,
    embeddingsData,
    source: {
      datasetId: source.datasetId,
      label: source.label,
      owner: source.owner,
      updatedAt: source.updatedAt,
    },
  };
}

export async function setActiveKobeDataset(): Promise<void> {
  await ensureBootstrap();
  const kobeDir = path.join(DATASET_ROOT, KOBE_DATASET_ID);
  const meta: ActiveSourceMeta = {
    datasetId: KOBE_DATASET_ID,
    label: 'Kobe dataset',
    csvPath: path.join(kobeDir, 'records.csv'),
    embeddingsPath: path.join(kobeDir, 'embeddings.json'),
    owner: 'kobe',
    updatedAt: new Date().toISOString(),
  };
  await writeActiveSource(meta);
}

export async function importCsvDataset(
  csvText: string,
  name = 'Imported dataset'
): Promise<{ datasetId: string; rowCount: number; updatedAt: string }> {
  await ensureBootstrap();
  const rows = parseCsv(csvText);
  const records = mapRecords(rows);
  if (records.length === 0) throw new Error('CSV has no valid rows');

  const datasetId = `import-${Date.now()}`;
  const datasetDir = path.join(DATASET_ROOT, datasetId);
  await mkdir(datasetDir, { recursive: true });

  const csvPath = path.join(datasetDir, 'records.csv');
  const embeddingsPath = path.join(datasetDir, 'embeddings.json');

  await writeFile(csvPath, csvText, 'utf-8');
  const embeddingsData = await buildEmbeddingsData(records);
  await writeFile(embeddingsPath, JSON.stringify(embeddingsData, null, 2), 'utf-8');

  const updatedAt = new Date().toISOString();
  const meta: ActiveSourceMeta = {
    datasetId,
    label: name,
    csvPath,
    embeddingsPath,
    owner: 'user',
    updatedAt,
  };
  await writeActiveSource(meta);

  return { datasetId, rowCount: records.length, updatedAt };
}

