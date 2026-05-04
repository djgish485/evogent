import { randomUUID } from 'node:crypto';
import { getDb } from './client';

interface BrowseCacheItemRow {
  source: string;
  source_id: string;
  url: string | null;
  title: string | null;
  author_username: string | null;
  author_display_name: string | null;
  published_at_ms: number | null;
  payload_json: string;
  fetched_at_ms: number;
  expires_at_ms: number;
  seen_by_curation_at_ms: number | null;
}

interface BrowseCacheRefreshRunRow {
  id: string;
  source: string;
  triggered_by: string;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  status: string;
  items_added: number;
  error: string | null;
  metadata_json?: string | null;
}

export interface BrowseCacheItemRecord {
  source: string;
  sourceId: string;
  url: string | null;
  title: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  publishedAtMs: number | null;
  payload: Record<string, unknown>;
  fetchedAtMs: number;
  expiresAtMs: number;
  seenByCurationAtMs: number | null;
}

export interface BrowseCacheRefreshRunRecord {
  id: string;
  source: string;
  triggeredBy: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  status: string;
  itemsAdded: number;
  error: string | null;
  metadata: Record<string, unknown> | null;
}

export const SOURCE_SETUP_REFRESH_TRIGGERED_BY = 'setup-source-smoke';

export interface UpsertBrowseCacheItemInput {
  source: string;
  sourceId: string;
  url?: string | null;
  title?: string | null;
  authorUsername?: string | null;
  authorDisplayName?: string | null;
  publishedAtMs?: number | null;
  payload: Record<string, unknown>;
  fetchedAtMs: number;
  expiresAtMs: number;
  seenByCurationAtMs?: number | null;
}

export interface RecordBrowseCacheRefreshInput {
  runId?: string | null;
  source: string;
  triggeredBy: string;
  startedAtMs: number;
  completedAtMs?: number | null;
  status: string;
  itemsAdded?: number;
  error?: string | null;
  items?: UpsertBrowseCacheItemInput[];
  metadata?: Record<string, unknown> | null;
}

export interface CachedTweetEnrichmentState {
  authorAvatarUrl: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  url: string | null;
  title: string | null;
  mediaUrls: string[];
  metrics: {
    likes: number | null;
    reposts: number | null;
    replies: number | null;
    views: number | null;
  };
  publishedAt: string | null;
  publishedAtMs: number | null;
  communityNote: Record<string, unknown> | null;
  quotedTweet: null | {
    raw: Record<string, unknown>;
    text: string | null;
    authorUsername: string | null;
    authorDisplayName: string | null;
    authorAvatarUrl: string | null;
  };
  linkCard: Record<string, unknown> | null;
  linkPreviews: Record<string, unknown>[];
  urlEntities: Record<string, unknown>[];
}

export interface CachedTweetAuthorFacts {
  authorAvatarUrl: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
}

function parsePayloadJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty record.
  }

  return {};
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeSource(value: string | null | undefined): string | null {
  return trimToNull(value)?.toLowerCase() ?? null;
}

function isTwitterBrowseCacheSource(value: string | null | undefined): boolean {
  const normalized = normalizeSource(value);
  return normalized === 'twitter'
    || normalized === 'x'
    || normalized === 'x.com'
    || normalized === 'twitter.com';
}

function extractTweetIdFromSourceId(value: string | null | undefined): string | null {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;

  const prefixed = trimmed.match(/^(?:tweet-|twitter:)(\d+)$/i);
  if (prefixed) return prefixed[1];

  if (/^\d+$/.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 'x.com' && hostname !== 'twitter.com' && hostname !== 'mobile.twitter.com') {
      return null;
    }

    return parsed.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeBrowseCacheSourceId(source: string, sourceId: string | null | undefined): string | null {
  const trimmed = trimToNull(sourceId);
  if (!trimmed) return null;

  if (!isTwitterBrowseCacheSource(source)) {
    return trimmed;
  }

  return extractTweetIdFromSourceId(trimmed) ?? trimmed;
}

function normalizeBrowseCachePayload(
  source: string,
  sourceId: string,
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const payloadRecord = getRecord(payload);
  const normalizedPayload = payloadRecord ? { ...payloadRecord } : {};

  if (isTwitterBrowseCacheSource(source) && /^\d+$/.test(sourceId)) {
    normalizedPayload.sourceId = sourceId;
    if (trimToNull(typeof normalizedPayload.tweetId === 'string' ? normalizedPayload.tweetId : null) === null) {
      normalizedPayload.tweetId = sourceId;
    }
  }

  return normalizedPayload;
}

function normalizeAuthorUsername(value: string | null | undefined): string | null {
  const normalized = trimToNull(value)?.replace(/^@+/, '').trim().toLowerCase() ?? null;
  return normalized || null;
}

function normalizeTimestampMs(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : null;
}

const BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function getRefreshRunTimestampUpperBoundMs(now = Date.now()): number {
  return now + BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getNestedString(
  input: Record<string, unknown> | null,
  paths: string[][],
): string | null {
  for (const path of paths) {
    let current: unknown = input;
    for (const segment of path) {
      current = getRecord(current)?.[segment];
    }

    const normalized = trimToNull(typeof current === 'string' ? current : null);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function getNestedRecord(input: Record<string, unknown> | null, path: string[]): Record<string, unknown> | null {
  let current: unknown = input;
  for (const segment of path) {
    current = getRecord(current)?.[segment];
  }
  return getRecord(current);
}

function getNestedNumber(input: Record<string, unknown> | null, paths: string[][]): number | null {
  for (const path of paths) {
    let current: unknown = input;
    for (const segment of path) {
      current = getRecord(current)?.[segment];
    }

    const numeric = typeof current === 'number'
      ? current
      : typeof current === 'string'
        ? Number(current)
        : NaN;
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric);
    }
  }

  return null;
}

function getRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function rowToBrowseCacheItem(row: BrowseCacheItemRow): BrowseCacheItemRecord {
  return {
    source: row.source,
    sourceId: row.source_id,
    url: trimToNull(row.url),
    title: trimToNull(row.title),
    authorUsername: trimToNull(row.author_username),
    authorDisplayName: trimToNull(row.author_display_name),
    publishedAtMs: normalizeTimestampMs(row.published_at_ms),
    payload: parsePayloadJson(row.payload_json),
    fetchedAtMs: row.fetched_at_ms,
    expiresAtMs: row.expires_at_ms,
    seenByCurationAtMs: normalizeTimestampMs(row.seen_by_curation_at_ms),
  };
}

function rowToBrowseCacheRefreshRun(row: BrowseCacheRefreshRunRow): BrowseCacheRefreshRunRecord {
  const metadataJson = trimToNull(row.metadata_json);
  const metadata = metadataJson ? parsePayloadJson(metadataJson) : null;
  return {
    id: row.id,
    source: row.source,
    triggeredBy: row.triggered_by,
    startedAtMs: normalizeTimestampMs(row.started_at_ms),
    completedAtMs: normalizeTimestampMs(row.completed_at_ms),
    status: row.status,
    itemsAdded: Number.isFinite(row.items_added) ? Number(row.items_added) : 0,
    error: trimToNull(row.error),
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : null,
  };
}

function getCacheItemCompletenessRank(item: UpsertBrowseCacheItemInput): number {
  const payload = getRecord(item.payload);
  const completeness = [
    getNestedString(payload, [['textCapture', 'completeness']]),
    getNestedString(payload, [['cacheAudit', 'textCompleteness']]),
    getNestedString(payload, [['sourceQuality', 'textCompleteness']]),
    getNestedString(payload, [['completeness']]),
  ].map((value) => value?.toLowerCase()).filter(Boolean);

  if (completeness.includes('complete')) {
    return 2;
  }
  if (completeness.includes('incomplete')) {
    return 0;
  }
  return 1;
}

function getCacheItemTextSourceRank(item: UpsertBrowseCacheItemInput): number {
  const payload = getRecord(item.payload);
  const textSource = getNestedString(payload, [['textCapture', 'textSource'], ['textSource']])?.toLowerCase();
  if (textSource === 'status_page') return 2;
  if (textSource === 'timeline_card') return 1;
  return 0;
}

function getCacheItemPrimaryTextLength(item: UpsertBrowseCacheItemInput): number {
  const payload = getRecord(item.payload);
  return [
    getNestedString(payload, [['text']]),
    getNestedString(payload, [['fullText']]),
    item.title,
  ].reduce((maxLength, value) => Math.max(maxLength, value?.length ?? 0), 0);
}

function compareBrowseCacheItemQuality(
  candidate: UpsertBrowseCacheItemInput,
  existing: UpsertBrowseCacheItemInput,
): number {
  const candidateCompleteness = getCacheItemCompletenessRank(candidate);
  const existingCompleteness = getCacheItemCompletenessRank(existing);
  if (candidateCompleteness !== existingCompleteness) {
    return candidateCompleteness - existingCompleteness;
  }

  const candidateTextSource = getCacheItemTextSourceRank(candidate);
  const existingTextSource = getCacheItemTextSourceRank(existing);
  if (candidateTextSource !== existingTextSource) {
    return candidateTextSource - existingTextSource;
  }

  const candidateTextLength = getCacheItemPrimaryTextLength(candidate);
  const existingTextLength = getCacheItemPrimaryTextLength(existing);
  if (candidateTextLength !== existingTextLength) {
    return candidateTextLength - existingTextLength;
  }

  return (normalizeTimestampMs(candidate.fetchedAtMs) ?? 0) - (normalizeTimestampMs(existing.fetchedAtMs) ?? 0);
}

function mergeBrowseCacheRunMetadata(
  inputMetadata: Record<string, unknown> | null | undefined,
  audit: { canonicalSourceIdDuplicates: number },
): Record<string, unknown> | null {
  const metadata = inputMetadata && typeof inputMetadata === 'object' && !Array.isArray(inputMetadata)
    ? { ...inputMetadata }
    : {};

  if (audit.canonicalSourceIdDuplicates > 0) {
    const existingDedupeAudit = getRecord(metadata.dedupeAudit);
    metadata.dedupeAudit = {
      ...(existingDedupeAudit ?? {}),
      canonicalSourceIdDuplicates: audit.canonicalSourceIdDuplicates,
    };
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

export function listBrowseCacheItems(input: {
  source?: string | null;
  freshAfterMs?: number | null;
  includeExpired?: boolean;
  unseenFirst?: boolean;
  limit?: number;
} = {}): BrowseCacheItemRecord[] {
  const source = trimToNull(input.source);
  const freshAfterMs = normalizeTimestampMs(input.freshAfterMs);
  const includeExpired = input.includeExpired === true;
  const unseenFirst = input.unseenFirst === true;
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit!)) : 200;

  const where: string[] = [];
  const params: Array<string | number> = [];

  if (source) {
    where.push(`source = ?`);
    params.push(source);
  }

  if (!includeExpired && freshAfterMs !== null) {
    where.push(`expires_at_ms >= ?`);
    params.push(freshAfterMs);
  }

  const orderBy = unseenFirst
    ? `ORDER BY (seen_by_curation_at_ms IS NULL) DESC, COALESCE(published_at_ms, fetched_at_ms) DESC, fetched_at_ms DESC, source_id ASC`
    : `ORDER BY COALESCE(published_at_ms, fetched_at_ms) DESC, fetched_at_ms DESC, source_id ASC`;

  const selectColumns = [
    'source',
    'source_id',
    'url',
    'title',
    'author_username',
    'author_display_name',
    'published_at_ms',
    'payload_json',
    'fetched_at_ms',
    'expires_at_ms',
    'seen_by_curation_at_ms',
  ].join(',\n          ');

  if (!source) {
    const rows = getDb().prepare(`
      WITH filtered AS (
        SELECT
          ${selectColumns}
        FROM browse_cache_items
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ),
      source_count AS (
        SELECT COUNT(DISTINCT source) AS value FROM filtered
      ),
      ranked AS (
        SELECT
          ${selectColumns},
          ROW_NUMBER() OVER (PARTITION BY source ${orderBy}) AS source_rank
        FROM filtered
      )
      SELECT
        ${selectColumns}
      FROM ranked
      CROSS JOIN source_count
      WHERE source_rank <= CASE WHEN value > 0 THEN ((? + value - 1) / value) ELSE 0 END
      ${orderBy}
      LIMIT ?
    `).all(...params, limit, limit) as BrowseCacheItemRow[];

    return rows.map(rowToBrowseCacheItem);
  }

  const rows = getDb().prepare(`
    SELECT
      ${selectColumns}
    FROM browse_cache_items
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ${orderBy}
    LIMIT ?
  `).all(...params, limit) as BrowseCacheItemRow[];

  return rows.map(rowToBrowseCacheItem);
}

export function getLatestBrowseCacheItemBySourceId(sourceId: string): BrowseCacheItemRecord | null {
  const normalizedSourceId = trimToNull(sourceId);
  if (!normalizedSourceId) {
    return null;
  }

  const row = getDb().prepare(`
    SELECT
      source,
      source_id,
      url,
      title,
      author_username,
      author_display_name,
      published_at_ms,
      payload_json,
      fetched_at_ms,
      expires_at_ms,
      seen_by_curation_at_ms
    FROM browse_cache_items
    WHERE source_id = ?
    ORDER BY fetched_at_ms DESC, expires_at_ms DESC, source ASC
    LIMIT 1
  `).get(normalizedSourceId) as BrowseCacheItemRow | undefined;

  return row ? rowToBrowseCacheItem(row) : null;
}

export function getBrowseCacheItemByExactSourceId(source: string, sourceId: string): BrowseCacheItemRecord | null {
  const normalizedSource = trimToNull(source);
  const normalizedSourceId = trimToNull(sourceId);
  if (!normalizedSource || !normalizedSourceId) {
    return null;
  }

  const row = getDb().prepare(`
    SELECT
      source,
      source_id,
      url,
      title,
      author_username,
      author_display_name,
      published_at_ms,
      payload_json,
      fetched_at_ms,
      expires_at_ms,
      seen_by_curation_at_ms
    FROM browse_cache_items
    WHERE source = ?
      AND source_id = ?
    LIMIT 1
  `).get(normalizedSource, normalizedSourceId) as BrowseCacheItemRow | undefined;

  return row ? rowToBrowseCacheItem(row) : null;
}

export function getCachedTweetEnrichmentState(sourceId: string, source = 'twitter'): CachedTweetEnrichmentState {
  const cacheItem = getBrowseCacheItemByExactSourceId(source, sourceId);
  const payload = getRecord(cacheItem?.payload);
  const mediaUrls = new Set<string>();
  const media = Array.isArray(payload?.media) ? payload.media : [];
  const legacyMediaUrls = Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : [];

  for (const entry of media) {
    const record = getRecord(entry);
    const url = trimToNull(typeof record?.posterUrl === 'string' ? record.posterUrl : null)
      ?? trimToNull(typeof record?.url === 'string' ? record.url : null);
    if (url) {
      mediaUrls.add(url);
    }
  }

  for (const entry of legacyMediaUrls) {
    const url = trimToNull(typeof entry === 'string' ? entry : null);
    if (url) {
      mediaUrls.add(url);
    }
  }

  const quotedTweet = getRecord(payload?.quotedTweet);
  const communityNote = getRecord(payload?.communityNote) ?? getRecord(payload?.community_note);
  const linkCard = getRecord(payload?.linkCard);
  const publishedAt = getNestedString(payload, [['publishedAt']]);
  const payloadPublishedAtMs = getNestedNumber(payload, [['publishedAtMs']]);
  const publishedAtMs = normalizeTimestampMs(cacheItem?.publishedAtMs ?? payloadPublishedAtMs);
  const metrics = getNestedRecord(payload, ['metrics']);
  return {
    authorAvatarUrl: getNestedString(payload, [['authorAvatarUrl'], ['author', 'avatarUrl']]),
    authorUsername: cacheItem?.authorUsername
      ?? getNestedString(payload, [['authorUsername'], ['author', 'username']]),
    authorDisplayName: cacheItem?.authorDisplayName
      ?? getNestedString(payload, [['authorDisplayName'], ['author', 'displayName'], ['author', 'name']]),
    url: cacheItem?.url ?? getNestedString(payload, [['url']]),
    title: cacheItem?.title ?? getNestedString(payload, [['title']]),
    mediaUrls: [...mediaUrls],
    metrics: {
      likes: getNestedNumber(metrics, [['likes'], ['likeCount'], ['favoriteCount'], ['favorites']])
        ?? getNestedNumber(payload, [['likeCount'], ['favoriteCount']]),
      reposts: getNestedNumber(metrics, [['reposts'], ['repostCount'], ['retweets'], ['retweetCount']])
        ?? getNestedNumber(payload, [['repostCount'], ['retweetCount']]),
      replies: getNestedNumber(metrics, [['replies'], ['replyCount']])
        ?? getNestedNumber(payload, [['replyCount']]),
      views: getNestedNumber(metrics, [['views'], ['viewCount']])
        ?? getNestedNumber(payload, [['viewCount']]),
    },
    publishedAt,
    publishedAtMs,
    communityNote,
    quotedTweet: quotedTweet
      ? {
          raw: quotedTweet,
          text: getNestedString(quotedTweet, [['text']]),
          authorUsername: getNestedString(quotedTweet, [['author', 'username'], ['authorUsername']]),
          authorDisplayName: getNestedString(quotedTweet, [['author', 'displayName'], ['authorDisplayName']]),
          authorAvatarUrl: getNestedString(quotedTweet, [['author', 'avatarUrl'], ['authorAvatarUrl']]),
        }
      : null,
    linkCard,
    linkPreviews: getRecordArray(payload?.linkPreviews),
    urlEntities: getRecordArray(payload?.urlEntities),
  };
}

export function getLatestCachedTweetAuthorFacts(
  authorUsername: string,
  source = 'twitter',
  freshAfterMs = Date.now(),
): CachedTweetAuthorFacts | null {
  const normalizedSource = normalizeSource(source);
  const normalizedAuthorUsername = normalizeAuthorUsername(authorUsername);
  const normalizedFreshAfterMs = normalizeTimestampMs(freshAfterMs);

  if (!normalizedSource || !normalizedAuthorUsername || normalizedFreshAfterMs === null) {
    return null;
  }

  const rows = getDb().prepare(`
    SELECT
      source,
      source_id,
      url,
      title,
      author_username,
      author_display_name,
      published_at_ms,
      payload_json,
      fetched_at_ms,
      expires_at_ms,
      seen_by_curation_at_ms
    FROM browse_cache_items
    WHERE LOWER(source) = ?
      AND LOWER(LTRIM(author_username, '@')) = ?
      AND expires_at_ms >= ?
    ORDER BY fetched_at_ms DESC, expires_at_ms DESC, source_id ASC
    LIMIT 100
  `).all(normalizedSource, normalizedAuthorUsername, normalizedFreshAfterMs) as BrowseCacheItemRow[];

  for (const row of rows) {
    const item = rowToBrowseCacheItem(row);
    const payload = getRecord(item.payload);
    const authorAvatarUrl = getNestedString(payload, [['authorAvatarUrl'], ['author', 'avatarUrl']]);
    if (!authorAvatarUrl) {
      continue;
    }

    return {
      authorAvatarUrl,
      authorUsername: item.authorUsername,
      authorDisplayName: item.authorDisplayName
        ?? getNestedString(payload, [['authorDisplayName'], ['author', 'displayName'], ['author', 'name']]),
    };
  }

  return null;
}

export function markBrowseCacheItemsSeen(items: Array<{ source: string; sourceId: string }>, seenAtMs = Date.now()): number {
  const normalizedSeenAtMs = normalizeTimestampMs(seenAtMs);
  if (!normalizedSeenAtMs || items.length === 0) {
    return 0;
  }

  const update = getDb().prepare(`
    UPDATE browse_cache_items
    SET seen_by_curation_at_ms = ?
    WHERE source = ?
      AND source_id = ?
  `);

  const tx = getDb().transaction((entries: Array<{ source: string; sourceId: string }>) => {
    let changed = 0;
    for (const entry of entries) {
      const source = trimToNull(entry.source);
      const sourceId = trimToNull(entry.sourceId);
      if (!source || !sourceId) continue;
      changed += update.run(normalizedSeenAtMs, source, sourceId).changes;
    }
    return changed;
  });

  return tx(items);
}

export function getLatestBrowseCacheRefreshRun(source: string): BrowseCacheRefreshRunRecord | null {
  const normalizedSource = trimToNull(source);
  if (!normalizedSource) return null;
  const maxTimestampMs = getRefreshRunTimestampUpperBoundMs();

  const row = getDb().prepare(`
    SELECT
      id,
      source,
      triggered_by,
      started_at_ms,
      completed_at_ms,
      status,
      items_added,
      error,
      metadata_json
    FROM browse_cache_refresh_runs
    WHERE source = ?
      AND triggered_by != ?
      AND (
        (
          completed_at_ms IS NOT NULL
          AND completed_at_ms >= 0
          AND completed_at_ms <= ?
          AND (
            started_at_ms IS NULL
            OR (
              started_at_ms >= 0
              AND started_at_ms <= ?
              AND completed_at_ms + ? >= started_at_ms
            )
          )
        )
        OR (
          completed_at_ms IS NULL
          AND LOWER(status) != 'completed'
          AND started_at_ms IS NOT NULL
          AND started_at_ms >= 0
          AND started_at_ms <= ?
        )
      )
    ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC, id DESC
    LIMIT 1
  `).get(
    normalizedSource,
    SOURCE_SETUP_REFRESH_TRIGGERED_BY,
    maxTimestampMs,
    maxTimestampMs,
    BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS,
    maxTimestampMs,
  ) as BrowseCacheRefreshRunRow | undefined;

  return row ? rowToBrowseCacheRefreshRun(row) : null;
}

export function getLatestBrowseCacheSourceSetupRun(source: string): BrowseCacheRefreshRunRecord | null {
  const normalizedSource = trimToNull(source);
  if (!normalizedSource) return null;
  const maxTimestampMs = getRefreshRunTimestampUpperBoundMs();
  const runIdPrefix = `setup-source-${normalizedSource}-`;

  const row = getDb().prepare(`
    SELECT
      id,
      source,
      triggered_by,
      started_at_ms,
      completed_at_ms,
      status,
      items_added,
      error,
      metadata_json
    FROM browse_cache_refresh_runs
    WHERE source = ?
      AND triggered_by = ?
      AND LOWER(status) = 'completed'
      AND items_added > 0
      AND id LIKE ?
      AND completed_at_ms IS NOT NULL
      AND completed_at_ms >= 0
      AND completed_at_ms <= ?
      AND (
        started_at_ms IS NULL
        OR (
          started_at_ms >= 0
          AND started_at_ms <= ?
          AND completed_at_ms + ? >= started_at_ms
        )
      )
    ORDER BY completed_at_ms DESC, id DESC
    LIMIT 1
  `).get(
    normalizedSource,
    SOURCE_SETUP_REFRESH_TRIGGERED_BY,
    `${runIdPrefix}%`,
    maxTimestampMs,
    maxTimestampMs,
    BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS,
  ) as BrowseCacheRefreshRunRow | undefined;

  return row ? rowToBrowseCacheRefreshRun(row) : null;
}

export function recordBrowseCacheRefresh(input: RecordBrowseCacheRefreshInput): BrowseCacheRefreshRunRecord {
  const source = normalizeSource(input.source);
  const triggeredBy = trimToNull(input.triggeredBy);
  const status = trimToNull(input.status);
  const startedAtMs = normalizeTimestampMs(input.startedAtMs);
  const completedAtMs = normalizeTimestampMs(input.completedAtMs ?? null);

  if (!source || !triggeredBy || !status || startedAtMs === null) {
    throw new Error('Browse cache refresh runs require source, triggeredBy, status, and startedAtMs');
  }

  const maxTimestampMs = getRefreshRunTimestampUpperBoundMs();
  if (startedAtMs > maxTimestampMs) {
    throw new Error('Browse cache refresh startedAtMs must not be more than 5 minutes in the future');
  }

  if (completedAtMs !== null) {
    if (completedAtMs > maxTimestampMs) {
      throw new Error('Browse cache refresh completedAtMs must not be more than 5 minutes in the future');
    }

    if (completedAtMs + BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS < startedAtMs) {
      throw new Error('Browse cache refresh completedAtMs must not be before startedAtMs by more than 5 minutes');
    }
  }

  if (status.toLowerCase() === 'completed' && completedAtMs === null) {
    throw new Error('Completed browse cache refresh runs require completedAtMs');
  }

  const runId = trimToNull(input.runId) ?? `browse-cache-refresh-${randomUUID()}`;
  const items = Array.isArray(input.items) ? input.items : [];
  const normalizedItems = new Map<string, UpsertBrowseCacheItemInput>();
  let canonicalSourceIdDuplicates = 0;

  for (const item of items) {
    const itemSource = normalizeSource(item.source) ?? source;
    if (!itemSource) continue;

    const sourceId = normalizeBrowseCacheSourceId(itemSource, item.sourceId);
    const fetchedAtMs = normalizeTimestampMs(item.fetchedAtMs);
    const expiresAtMs = normalizeTimestampMs(item.expiresAtMs);
    if (!sourceId || fetchedAtMs === null || expiresAtMs === null) {
      continue;
    }

    const normalizedItem: UpsertBrowseCacheItemInput = {
      ...item,
      source: itemSource,
      sourceId,
      payload: normalizeBrowseCachePayload(itemSource, sourceId, item.payload),
      fetchedAtMs,
      expiresAtMs,
    };
    const key = `${itemSource}\u0000${sourceId}`;
    const existing = normalizedItems.get(key);
    if (existing) {
      canonicalSourceIdDuplicates += 1;
      if (compareBrowseCacheItemQuality(normalizedItem, existing) > 0) {
        normalizedItems.set(key, normalizedItem);
      }
      continue;
    }

    normalizedItems.set(key, normalizedItem);
  }

  const runMetadata = mergeBrowseCacheRunMetadata(input.metadata, { canonicalSourceIdDuplicates });
  const upsertItem = getDb().prepare(`
    INSERT INTO browse_cache_items (
      source,
      source_id,
      url,
      title,
      author_username,
      author_display_name,
      published_at_ms,
      payload_json,
      fetched_at_ms,
      expires_at_ms,
      seen_by_curation_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      url = excluded.url,
      title = excluded.title,
      author_username = excluded.author_username,
      author_display_name = excluded.author_display_name,
      published_at_ms = excluded.published_at_ms,
      payload_json = excluded.payload_json,
      fetched_at_ms = excluded.fetched_at_ms,
      expires_at_ms = excluded.expires_at_ms,
      seen_by_curation_at_ms = COALESCE(excluded.seen_by_curation_at_ms, browse_cache_items.seen_by_curation_at_ms)
  `);

  const upsertRun = getDb().prepare(`
    INSERT INTO browse_cache_refresh_runs (
      id,
      source,
      triggered_by,
      started_at_ms,
      completed_at_ms,
      status,
      items_added,
      error,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      triggered_by = excluded.triggered_by,
      started_at_ms = excluded.started_at_ms,
      completed_at_ms = excluded.completed_at_ms,
      status = excluded.status,
      items_added = excluded.items_added,
      error = excluded.error,
      metadata_json = excluded.metadata_json
  `);

  const tx = getDb().transaction(() => {
    let itemsAdded = 0;

    for (const item of normalizedItems.values()) {
      itemsAdded += upsertItem.run(
        item.source,
        item.sourceId,
        trimToNull(item.url),
        trimToNull(item.title),
        trimToNull(item.authorUsername),
        trimToNull(item.authorDisplayName),
        normalizeTimestampMs(item.publishedAtMs),
        JSON.stringify(item.payload ?? {}),
        item.fetchedAtMs,
        item.expiresAtMs,
        normalizeTimestampMs(item.seenByCurationAtMs ?? null),
      ).changes;
    }

    upsertRun.run(
      runId,
      source,
      triggeredBy,
      startedAtMs,
      completedAtMs,
      status,
      Number.isFinite(input.itemsAdded) ? Math.max(0, Math.floor(Number(input.itemsAdded))) : itemsAdded,
      trimToNull(input.error),
      runMetadata ? JSON.stringify(runMetadata) : null,
    );
  });

  tx();

  const row = getDb().prepare(`
    SELECT
      id,
      source,
      triggered_by,
      started_at_ms,
      completed_at_ms,
      status,
      items_added,
      error,
      metadata_json
    FROM browse_cache_refresh_runs
    WHERE id = ?
  `).get(runId) as BrowseCacheRefreshRunRow | undefined;

  if (!row) {
    throw new Error(`Failed to persist browse cache refresh run ${runId}`);
  }

  return rowToBrowseCacheRefreshRun(row);
}
