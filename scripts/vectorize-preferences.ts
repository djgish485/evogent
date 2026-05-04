import type Database from 'better-sqlite3';
import { getDb, isVectorExtensionAvailable } from '../src/lib/db/client';
import { addPreferenceVector, initVectorStore } from '../src/lib/vectors/store';

interface MissingVectorRow {
  id: string;
  text: string;
  signal_type: string;
  source: string;
  weight: number;
  author_username: string | null;
}

const BATCH_SIZE = 500;

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name: string } | undefined;

  return !!row;
}

async function main() {
  let db: Database.Database;
  try {
    db = getDb();
    initVectorStore(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vectorize-preferences] Vector store initialization failed: ${message}`);
    return;
  }

  if (!isVectorExtensionAvailable() || !tableExists(db, 'pref_vec')) {
    console.warn('[vectorize-preferences] sqlite-vec is unavailable; skipping vectorization.');
    return;
  }

  let totalProcessed = 0;

  while (true) {
    const rows = db.prepare(`
      SELECT p.id, p.text, p.signal_type, p.source, p.weight, p.author_username
      FROM preferences p
      LEFT JOIN preference_vectors pv ON pv.id = p.id
      LEFT JOIN pref_vec v ON v.id = p.id
      WHERE pv.id IS NULL OR v.id IS NULL
      ORDER BY p.created_at ASC
      LIMIT ?
    `).all(BATCH_SIZE) as MissingVectorRow[];

    if (rows.length === 0) {
      break;
    }

    let processedThisBatch = 0;
    for (const row of rows) {
      try {
        await addPreferenceVector(
          row.id,
          row.text,
          row.signal_type,
          row.source,
          row.weight,
          row.author_username,
        );
        processedThisBatch += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[vectorize-preferences] Failed on ${row.id}: ${message}`);
      }
    }

    if (processedThisBatch === 0) {
      console.warn('[vectorize-preferences] No vectors were written in this batch; stopping to avoid retry loop.');
      break;
    }

    totalProcessed += processedThisBatch;
    console.log(`[vectorize-preferences] Vectorized ${totalProcessed} preferences...`);
  }

  console.log(`[vectorize-preferences] Complete. Vectorized ${totalProcessed} preference records.`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[vectorize-preferences] Exiting without vectorization: ${message}`);
});
