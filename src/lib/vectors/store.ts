import type Database from 'better-sqlite3';
import { getDb, isVectorExtensionAvailable } from '@/lib/db/client';
import { cosineSimilarity, generateEmbedding, generateEmbeddings } from './embeddings';

export interface SimilarPreference {
  id: string;
  text: string;
  signalType: string;
  weight: number;
  similarity: number;
}

export interface VectorStats {
  total: number;
  vectorized: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
}

function hasPrefVecTable(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'pref_vec'
  `).get() as { name: string } | undefined;

  return !!row;
}

export function initVectorStore(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preference_vectors (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      source TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      author_username TEXT
    );
  `);

  if (!isVectorExtensionAvailable()) {
    return;
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pref_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[384]
      );
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vectors] Failed to initialize pref_vec: ${message}`);
  }
}

export async function addPreferenceVector(
  id: string,
  text: string,
  signalType: string,
  source: string,
  weight = 1,
  authorUsername: string | null = null,
): Promise<void> {
  const db = getDb();
  initVectorStore(db);

  db.prepare(`
    INSERT OR REPLACE INTO preference_vectors (
      id,
      text,
      signal_type,
      source,
      weight,
      author_username
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, text, signalType, source, weight, authorUsername);

  if (!isVectorExtensionAvailable() || !hasPrefVecTable(db)) {
    return;
  }

  try {
    const embedding = await generateEmbedding(text);
    db.prepare(`
      INSERT OR REPLACE INTO pref_vec (id, embedding)
      VALUES (?, ?)
    `).run(id, new Float32Array(embedding));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vectors] Failed to store embedding for ${id}: ${message}`);
  }
}

export async function findSimilarPreferences(queryText: string, limit = 10): Promise<SimilarPreference[]> {
  const db = getDb();
  initVectorStore(db);

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 10;

  const queryEmbedding = await generateEmbedding(queryText);

  if (!isVectorExtensionAvailable() || !hasPrefVecTable(db)) {
    return findSimilarPreferencesFallback(db, queryEmbedding, safeLimit);
  }

  try {
    const rows = db.prepare(`
      SELECT
        pv.id,
        pv.text,
        pv.signal_type,
        pv.weight,
        vec_distance_L2(v.embedding, ?) AS distance
      FROM pref_vec v
      JOIN preference_vectors pv ON pv.id = v.id
      ORDER BY distance ASC
      LIMIT ?
    `).all(new Float32Array(queryEmbedding), safeLimit) as Array<{
      id: string;
      text: string;
      signal_type: string;
      weight: number;
      distance: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      signalType: row.signal_type,
      weight: row.weight,
      similarity: 1 / (1 + row.distance),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vectors] Vector search failed; using JS fallback: ${message}`);
    return findSimilarPreferencesFallback(db, queryEmbedding, safeLimit);
  }
}

async function findSimilarPreferencesFallback(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number,
): Promise<SimilarPreference[]> {
  const rows = db.prepare(`
    SELECT id, text, signal_type, weight
    FROM preference_vectors
    ORDER BY rowid DESC
    LIMIT 400
  `).all() as Array<{
    id: string;
    text: string;
    signal_type: string;
    weight: number;
  }>;

  if (rows.length === 0) return [];

  const embeddings = await generateEmbeddings(rows.map((row) => row.text));
  const scored = rows.map((row, index) => {
    const similarity = cosineSimilarity(queryEmbedding, embeddings[index] ?? queryEmbedding);
    return {
      id: row.id,
      text: row.text,
      signalType: row.signal_type,
      weight: row.weight,
      similarity,
    };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

export function getVectorStats(): VectorStats {
  const db = getDb();
  initVectorStore(db);

  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM preference_vectors`).get() as { count: number };

  const typeRows = db.prepare(`
    SELECT signal_type, COUNT(*) AS count
    FROM preference_vectors
    GROUP BY signal_type
  `).all() as Array<{ signal_type: string; count: number }>;

  const sourceRows = db.prepare(`
    SELECT source, COUNT(*) AS count
    FROM preference_vectors
    GROUP BY source
  `).all() as Array<{ source: string; count: number }>;

  let vectorized = 0;
  if (isVectorExtensionAvailable() && hasPrefVecTable(db)) {
    try {
      const vectorizedRow = db.prepare(`SELECT COUNT(*) AS count FROM pref_vec`).get() as { count: number };
      vectorized = vectorizedRow.count;
    } catch {
      vectorized = 0;
    }
  }

  return {
    total: totalRow.count,
    vectorized,
    byType: Object.fromEntries(typeRows.map((row) => [row.signal_type, row.count])),
    bySource: Object.fromEntries(sourceRows.map((row) => [row.source, row.count])),
  };
}
