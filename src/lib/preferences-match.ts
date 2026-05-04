import type Database from 'better-sqlite3';
import { getDb, isVectorExtensionAvailable } from '@/lib/db/client';
import { generateEmbedding } from '@/lib/vectors/embeddings';

const SEARCH_LIMIT = 100;
const TOP_MATCHES_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_SIM_THRESHOLD = 0.5;
const MED_SIM_THRESHOLD = 0.35;

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

interface ScoredMatch extends MatchCandidate {
  similarity: number;
  qualityScore: number;
}

export interface PreferenceMatchResult {
  relevanceScore: number;
  matchedLikes: number;
  matchedDislikes: number;
  verdict: string;
  topMatches: Array<{
    text: string;
    similarity: number;
    qualityScore: number;
    signal: string;
    author: string | null;
  }>;
  density: {
    high: number;
    medium: number;
    total: number;
  };
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

function getRecencyMultiplier(createdAt: string | null): number {
  if (!createdAt) return 1;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return 1;
  const ageMs = Date.now() - createdAtMs;
  if (ageMs <= 30 * DAY_MS) return 1.3;
  if (ageMs <= 90 * DAY_MS) return 1.15;
  return 1;
}

function getSourceWeight(source: string | null): number {
  if (!source) return 1;
  switch (source) {
    case 'app_like':
    case 'app_thumbsup':
    case 'app_dislike':
    case 'app_hide':
      return 3.0;
    case 'twitter_archive_interest':
      return 0.15;
    case 'twitter_bookmark':
      return 2.0;
    case 'twitter_like':
      return 1.5;
    case 'twitter_archive_tweet':
      return 1.2;
    case 'twitter_archive_block':
    case 'twitter_archive_mute':
      return 2.0;
    case 'twitter_archive_like':
      return 0.7;
    default:
      return 1.0;
  }
}

function isLikeSignal(signalType: string): boolean {
  return signalType === 'liked' || signalType === 'explicit' || signalType === 'bookmarked';
}

function isDislikeSignal(signalType: string): boolean {
  return signalType === 'disliked' || signalType === 'hidden';
}

function distanceToSimilarity(metric: DistanceMetric, distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (metric === 'cosine') {
    return clamp01(1 - distance);
  }
  return clamp01(1 / (1 + Math.max(0, distance)));
}

export function emptyPreferenceMatchResult(): PreferenceMatchResult {
  return {
    relevanceScore: 0,
    matchedLikes: 0,
    matchedDislikes: 0,
    verdict: 'no_match',
    topMatches: [],
    density: { high: 0, medium: 0, total: 0 },
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
    ORDER BY distance ASC
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
    ORDER BY distance ASC
    LIMIT ?
  `).all(embedding, limit) as MatchCandidate[];
}

function searchByVector(
  db: Database.Database,
  embedding: Float32Array,
  limit: number,
): { rows: MatchCandidate[]; metric: DistanceMetric } {
  try {
    const rows = searchCosine(db, embedding, limit);
    return { rows, metric: 'cosine' };
  } catch {
    const rows = searchL2(db, embedding, limit);
    return { rows, metric: 'l2' };
  }
}

function computeVerdict(relevanceScore: number, matchedLikes: number, matchedDislikes: number): string {
  if (matchedDislikes > matchedLikes) return 'avoid';
  if (relevanceScore > 0.7) return 'strong_match';
  if (relevanceScore >= 0.4) return 'moderate_match';
  if (relevanceScore >= 0.2) return 'weak_match';
  return 'no_match';
}

export async function matchPreferenceText(text: string): Promise<PreferenceMatchResult> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return emptyPreferenceMatchResult();
  }

  const db = getDb();
  if (!isVectorExtensionAvailable() || !hasTable(db, 'pref_vec') || !hasTable(db, 'preferences')) {
    return emptyPreferenceMatchResult();
  }

  const embeddingCountRow = db.prepare(`SELECT COUNT(*) AS count FROM pref_vec`).get() as { count: number };
  if (!embeddingCountRow.count) {
    return emptyPreferenceMatchResult();
  }

  const queryEmbedding = await generateEmbedding(normalizedText);
  const vector = new Float32Array(queryEmbedding);
  const { rows, metric } = searchByVector(db, vector, SEARCH_LIMIT);

  if (rows.length === 0) {
    return emptyPreferenceMatchResult();
  }

  const scored: ScoredMatch[] = rows.map((row) => {
    const similarity = distanceToSimilarity(metric, row.distance);
    const sourceWeight = getSourceWeight(row.source);
    const textLen = (row.text || '').length;
    const lengthPenalty = textLen < 30 ? 0.15 : textLen < 60 ? 0.5 : 1.0;
    const qualityScore = clamp01(
      similarity * sourceWeight * lengthPenalty * getRecencyMultiplier(row.createdAt),
    );
    return { ...row, similarity, qualityScore };
  });

  scored.sort((a, b) => b.qualityScore - a.qualityScore);

  const likesOnly = scored.filter((row) => isLikeSignal(row.signalType));
  const dislikesOnly = scored.filter((row) => isDislikeSignal(row.signalType));

  const highSimLikes = likesOnly.filter((row) => row.similarity >= HIGH_SIM_THRESHOLD);
  const medSimLikes = likesOnly.filter((row) => row.similarity >= MED_SIM_THRESHOLD);
  const highSimDislikes = dislikesOnly.filter((row) => row.similarity >= HIGH_SIM_THRESHOLD);

  const bestQuality = likesOnly.length > 0 ? likesOnly[0].qualityScore : 0;
  const densityRaw = highSimLikes.length + (medSimLikes.length - highSimLikes.length) * 0.3;
  const densityFactor = clamp01(Math.sqrt(densityRaw) / 4);

  const positiveScore = bestQuality * 0.4 + densityFactor * 0.6;
  const negativeDensity = clamp01(Math.sqrt(highSimDislikes.length) / 3);
  const bestNegQuality = dislikesOnly.length > 0 ? dislikesOnly[0].qualityScore : 0;
  const negativeScore = bestNegQuality * 0.4 + negativeDensity * 0.6;
  const relevanceScore = clamp01(positiveScore - (negativeScore * 0.7));

  const matchedLikes = likesOnly.filter((row) => row.qualityScore >= 0.3).length;
  const matchedDislikes = dislikesOnly.filter((row) => row.qualityScore >= 0.3).length;
  const verdict = computeVerdict(relevanceScore, matchedLikes, matchedDislikes);

  const topMatches = scored.slice(0, TOP_MATCHES_LIMIT).map((row) => {
    const author = row.authorUsername
      ? (row.authorUsername.startsWith('@') ? row.authorUsername : `@${row.authorUsername}`)
      : null;
    return {
      text: row.text,
      similarity: roundTo(row.similarity, 4),
      qualityScore: roundTo(row.qualityScore, 4),
      signal: row.signalType,
      author,
    };
  });

  return {
    relevanceScore: roundTo(relevanceScore, 4),
    matchedLikes,
    matchedDislikes,
    verdict,
    topMatches,
    density: {
      high: highSimLikes.length,
      medium: medSimLikes.length,
      total: likesOnly.length,
    },
  };
}
