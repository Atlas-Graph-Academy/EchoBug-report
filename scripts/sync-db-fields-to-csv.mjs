/**
 * Sync is_public, type, keys, memory_image_url from Supabase memory_new
 * into the local CSV files. Zero external dependencies beyond @supabase/supabase-js.
 *
 * Usage: node --env-file=.env.local scripts/sync-db-fields-to-csv.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const USER_ID = 'aab8c0c8-9315-47cf-922c-b8c193814df9';

const CSV_PATHS = [
  join(__dirname, '..', 'public', 'echo-memories-2026-02-15.csv'),
  join(__dirname, '..', 'data', 'memory', 'datasets', 'kobe-default', 'records.csv'),
];

// Minimal CSV parser that handles quoted fields with commas and newlines
function parseCSV(text) {
  const rows = [];
  let i = 0;
  while (i < text.length) {
    const row = [];
    while (i < text.length) {
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        let field = '';
        while (i < text.length) {
          if (text[i] === '"') {
            if (i + 1 < text.length && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field);
      } else {
        // Unquoted field
        let field = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
        row.push(field);
      }
      if (i < text.length && text[i] === ',') {
        i++; // skip comma
      } else {
        break; // end of row
      }
    }
    // Skip line endings
    if (i < text.length && text[i] === '\r') i++;
    if (i < text.length && text[i] === '\n') i++;
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }
  return rows;
}

function escapeCSV(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log('Fetching from Supabase...');
  const dbMap = {};
  let from = 0;
  const PAGE = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('memory_new')
      .select('id, is_public, type, keys, memory_image_url')
      .eq('user_id', USER_ID)
      .range(from, from + PAGE - 1);

    if (error) { console.error('DB error:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;

    for (const row of data) {
      dbMap[row.id] = {
        is_public: row.is_public ? 'true' : 'false',
        type: row.type ?? '',
        keys: row.keys ?? '',
        memory_image_url: row.memory_image_url ?? '',
      };
    }

    if (data.length < PAGE) break;
    from += PAGE;
  }

  const dbCount = Object.keys(dbMap).length;
  console.log(`Fetched ${dbCount} records from DB`);

  for (const csvPath of CSV_PATHS) {
    console.log(`\nProcessing: ${csvPath}`);
    const raw = readFileSync(csvPath, 'utf-8');
    const rows = parseCSV(raw);
    if (rows.length === 0) { console.log('  Empty file, skipping'); continue; }

    const header = rows[0];
    const idCol = header.indexOf('id');
    if (idCol === -1) { console.log('  No id column, skipping'); continue; }

    // New header with added columns
    const newHeader = [...header, 'is_public', 'type', 'keys', 'memory_image_url'];

    let matched = 0;
    let unmatched = 0;
    const outLines = [newHeader.map(escapeCSV).join(',')];

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const id = row[idCol];
      const db = dbMap[id];

      const newFields = db
        ? [db.is_public, db.type, db.keys, db.memory_image_url]
        : ['', '', '', ''];

      if (db) matched++; else unmatched++;

      outLines.push([...row.map(escapeCSV), ...newFields.map(escapeCSV)].join(','));
    }

    writeFileSync(csvPath, outLines.join('\n') + '\n', 'utf-8');
    console.log(`  ✓ ${matched} matched, ${unmatched} not in DB, ${rows.length - 1} data rows`);
  }

  console.log('\nDone!');
}

main();
