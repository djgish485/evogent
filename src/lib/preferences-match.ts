import type Database from 'better-sqlite3';
import { getDb, isVectorExtensionAvailable } from '@/lib/db/client';
import { generateEmbedding } from '@/lib/vectors/embeddings';

const SEARCH_LIMIT = 100;
const TOP_MATCHES_LIMIT = 12;

type DistanceMetric = 'cosine' | 'l2';

interface MatchCandidate {
  id: string;
  text: string;
  signalType: string;
  source: string | null;
  authorUsername: string | null;
  createdAt: string | null;
  distance: number;
}

export interface PreferenceMatchResult {
  metric: DistanceMetric | null;
  evidenceCount: number;
  topMatches: Array<{
    id: string;
    text: string;
    similarity: number;
    signal: string;
    source: string | null;
    author: string | null;
    createdAt: string | null;
  }>;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { name: string } | undefined;
  return !!row;
}

function distanceToSimilarity(metric: DistanceMetric, distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (metric === 'cosine') return clamp01(1 - distance);
  return clamp01(1 / (1 + Math.max(0, distance)));
}

export function emptyPreferenceMatchResult(): PreferenceMatchResult {
  return {
    metric: null,
    evidenceCount: 0,
    topMatches: [],
  };
}

function searchCosine(
  db: Database.Database,
  embedding: Float32Array,
  limit: number,
): MatchCandidate[] {
  return db.prepare(`
    SELECT
      p.id,
      p.text,
      p.signal_type AS signalType,
      p.source,
      p.author_username AS authorUsername,
      p.created_at AS createdAt,
      vec_distance_cosine(v.embedding, ?) AS distance
    FROM pref_vec v
    JOIN preferences p ON p.id = v.id
    LEFT JOIN feed f ON f.id = p.feed_item_id
    WHERE NOT (
      (
        COALESCE(f.type, '') = 'notification'
        AND COALESCE(f.source, '') = 'phone-notification'
      )
      OR COALESCE(p.source_id, '') LIKE 'phone-notification:%'
    )
    ORDER BY distance ASC, p.id ASC
    LIMIT ?
  `).all(embedding, limit) as MatchCandidate[];
}

function searchL2(
  db: Database.Database,
  embedding: Float32Array,
  limit: number,
): MatchCandidate[] {
  return db.prepare(`
    SELECT
      p.id,
      p.text,
      p.signal_type AS signalType,
      p.source,
      p.author_username AS authorUsername,
      p.created_at AS createdAt,
      vec_distance_L2(v.embedding, ?) AS distance
    FROM pref_vec v
    JOIN preferences p ON p.id = v.id
    LEFT JOIN feed f ON f.id = p.feed_item_id
    WHERE NOT (
      (
        COALESCE(f.type, '') = 'notification'
        AND COALESCE(f.source, '') = 'phone-notification'
      )
      OR COALESCE(p.source_id, '') LIKE 'phone-notification:%'
    )
    ORDER BY distance ASC, p.id ASC
    LIMIT ?
  `).all(embedding, limit) as MatchCandidate[];
}

function searchByVector(
  db: Database.Database,
  embedding: Float32Array,
  limit: number,
): { rows: MatchCandidate[]; metric: DistanceMetric } {
  try {
    return { rows: searchCosine(db, embedding, limit), metric: 'cosine' };
  } catch {
    return { rows: searchL2(db, embedding, limit), metric: 'l2' };
  }
}

/**
 * Return nearby private evidence without interpreting it.
 *
 * Similarity is the vector store's raw geometric relationship. Signal type,
 * source, author, and timestamp remain facts for the calling agent to weigh;
 * mechanics apply no recency decay, source/account weights, verdict, or
 * positive/negative composite.
 */
export async function matchPreferenceText(text: string): Promise<PreferenceMatchResult> {
  const normalizedText = text.trim();
  if (!normalizedText) return emptyPreferenceMatchResult();

  const db = getDb();
  if (!isVectorExtensionAvailable() || !hasTable(db, 'pref_vec') || !hasTable(db, 'preferences')) {
    return emptyPreferenceMatchResult();
  }
  const embeddingCountRow = db.prepare('SELECT COUNT(*) AS count FROM pref_vec')
    .get() as { count: number };
  if (!embeddingCountRow.count) return emptyPreferenceMatchResult();

  const vector = new Float32Array(await generateEmbedding(normalizedText));
  const { rows, metric } = searchByVector(db, vector, SEARCH_LIMIT);
  return {
    metric,
    evidenceCount: rows.length,
    topMatches: rows.slice(0, TOP_MATCHES_LIMIT).map((row) => ({
      id: row.id,
      text: row.text,
      similarity: roundTo(distanceToSimilarity(metric, row.distance), 4),
      signal: row.signalType,
      source: row.source,
      author: row.authorUsername
        ? (row.authorUsername.startsWith('@') ? row.authorUsername : `@${row.authorUsername}`)
        : null,
      createdAt: row.createdAt,
    })),
  };
}
