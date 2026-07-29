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
export const SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY = 'source-discovery';
export const PHONE_SOURCE_RECURRING_REFRESH_TRIGGERED_BY = 'phone-source-recurring';
export const PHONE_BENCHMARK_SHARE_REFRESH_TRIGGERED_BY =
  'phone-benchmark-full-browse-share';
const SOURCE_DISCOVERY_RUN_ID_PATTERN =
  /^source-discovery-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHONE_SOURCE_RECURRING_RUN_ID_PATTERN =
  /^phone-source-recurring-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

export interface SourceDiscoveryActivationRecord {
  source: string;
  runId: string;
  recipeSha256: string;
  activatedAtMs: number;
  itemsActivated: number;
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
  requirePublishedAt?: boolean;
  excludeFeedDuplicates?: boolean;
  unseenFirst?: boolean;
  eligibleForCuration?: boolean;
  limit?: number;
} = {}): BrowseCacheItemRecord[] {
  const source = trimToNull(input.source);
  const freshAfterMs = normalizeTimestampMs(input.freshAfterMs);
  const includeExpired = input.includeExpired === true;
  const requirePublishedAt = input.requirePublishedAt === true;
  const excludeFeedDuplicates = input.excludeFeedDuplicates === true;
  const unseenFirst = input.unseenFirst === true;
  const eligibleForCuration = input.eligibleForCuration === true;
  // Eligibility is one server-owned boundary, not a collection of caller-owned
  // query hints. Capture the cutoff once so conflicting legacy flags cannot
  // admit expired, already-reviewed, or already-shipped rows.
  const curationCutoffMs = eligibleForCuration ? Date.now() : null;
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit!)) : 200;

  const where: string[] = [];
  const params: Array<string | number> = [];

  if (source && !eligibleForCuration) {
    where.push(`source = ?`);
    params.push(source);
  }

  if (eligibleForCuration && curationCutoffMs !== null) {
    where.push(`expires_at_ms >= ?`);
    params.push(curationCutoffMs);
    where.push(`seen_by_curation_at_ms IS NULL`);
  } else if (!includeExpired && freshAfterMs !== null) {
    where.push(`expires_at_ms >= ?`);
    params.push(freshAfterMs);
  }

  if (!eligibleForCuration && requirePublishedAt) {
    where.push(`published_at_ms IS NOT NULL`);
  }

  if (eligibleForCuration || excludeFeedDuplicates) {
    where.push(`
      NOT EXISTS (
        SELECT 1
        FROM feed
        WHERE feed.source_id = browse_cache_items.source_id
      )
    `);
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

  if (eligibleForCuration) {
    // Full curation owns the editorial subset. Return the complete structurally
    // eligible set in stable evidence order; a legacy limit or source-balancing
    // shortlist must never become a mechanical editorial cap.
    const rows = getDb().prepare(`
      SELECT
        ${selectColumns}
      FROM browse_cache_items
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY fetched_at_ms ASC, source ASC, source_id ASC
    `).all(...params) as BrowseCacheItemRow[];

    return rows.map(rowToBrowseCacheItem);
  }

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

export function deleteBrowseCacheItemsForSource(sourceInput: string): number {
  const source = normalizeSource(sourceInput);
  if (!source) {
    throw new Error('Browse cache source is required');
  }
  return getDb().prepare(`
    DELETE FROM browse_cache_items
    WHERE source = ?
  `).run(source).changes;
}

export function discardUnactivatedSourceDiscoveryRun(
  sourceInput: string,
  runIdInput: string,
): number {
  const source = normalizeSource(sourceInput);
  const runId = trimToNull(runIdInput);
  if (!source || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
    throw new Error('A canonical source slug is required');
  }
  if (!runId || !SOURCE_DISCOVERY_RUN_ID_PATTERN.test(runId)) {
    throw new Error('An exact source discovery run identity is required');
  }
  return getDb().prepare(`
    DELETE FROM browse_cache_source_discovery_staging
    WHERE source = ?
      AND run_id = ?
  `).run(source, runId).changes;
}

export function cancelBrowseCacheSource(sourceInput: string): {
  source: string;
  deleted: number;
  stagedDeleted: number;
  optedOutAtMs: number;
} {
  const source = normalizeSource(sourceInput);
  if (!source || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
    throw new Error('A canonical source slug is required');
  }

  const tx = getDb().transaction(() => {
    const optedOutAtMs = Date.now();
    getDb().prepare(`
      INSERT INTO browse_cache_source_optouts (source, opted_out_at_ms)
      VALUES (?, ?)
      ON CONFLICT(source) DO UPDATE SET opted_out_at_ms = excluded.opted_out_at_ms
    `).run(source, optedOutAtMs);
    const deleted = getDb().prepare(`
      DELETE FROM browse_cache_items
      WHERE source = ?
    `).run(source).changes;
    const stagedDeleted = getDb().prepare(`
      DELETE FROM browse_cache_source_discovery_staging
      WHERE source = ?
    `).run(source).changes;
    return { source, deleted, stagedDeleted, optedOutAtMs };
  });

  return tx();
}

export function activateSourceDiscoveryRun(input: {
  source: string;
  runId: string;
  recipeSha256: string;
}): SourceDiscoveryActivationRecord {
  const source = normalizeSource(input.source);
  const runId = trimToNull(input.runId);
  const recipeSha256 = trimToNull(input.recipeSha256)?.toLowerCase() ?? null;
  if (!source || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
    throw new Error('A canonical source slug is required');
  }
  if (!runId || !SOURCE_DISCOVERY_RUN_ID_PATTERN.test(runId)) {
    throw new Error('An exact source discovery run identity is required');
  }
  if (!recipeSha256 || !/^[0-9a-f]{64}$/.test(recipeSha256)) {
    throw new Error('An exact lowercase recipe SHA-256 is required');
  }

  const tx = getDb().transaction((): SourceDiscoveryActivationRecord => {
    const optedOut = getDb().prepare(`
      SELECT 1
      FROM browse_cache_source_optouts
      WHERE source = ?
    `).get(source);
    if (optedOut) {
      throw new Error('Cancelled sources cannot activate discovery evidence');
    }

    const existing = getDb().prepare(`
      SELECT source, recipe_sha256, activated_at_ms, items_activated
      FROM browse_cache_source_discovery_activations
      WHERE run_id = ?
    `).get(runId) as {
      source: string;
      recipe_sha256: string;
      activated_at_ms: number;
      items_activated: number;
    } | undefined;
    if (existing) {
      if (existing.source !== source || existing.recipe_sha256 !== recipeSha256) {
        throw new Error('Source discovery activation identity is immutable');
      }
      return {
        source,
        runId,
        recipeSha256,
        activatedAtMs: existing.activated_at_ms,
        itemsActivated: existing.items_activated,
      };
    }

    const run = getDb().prepare(`
      SELECT source, triggered_by, started_at_ms, completed_at_ms, status, items_added, error
      FROM browse_cache_refresh_runs
      WHERE id = ?
    `).get(runId) as {
      source: string;
      triggered_by: string;
      started_at_ms: number;
      completed_at_ms: number | null;
      status: string;
      items_added: number;
      error: string | null;
    } | undefined;
    if (
      !run
      || run.source !== source
      || run.triggered_by !== SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY
      || run.status.toLowerCase() !== 'completed'
      || run.error !== null
      || !Number.isInteger(run.started_at_ms)
      || !Number.isInteger(run.completed_at_ms)
      || (run.completed_at_ms ?? -1) < run.started_at_ms
      || !Number.isInteger(run.items_added)
      || run.items_added < 1
      || run.items_added > 100
    ) {
      throw new Error('Source discovery run is not eligible for activation');
    }

    const stagedCount = getDb().prepare(`
      SELECT
        COUNT(*) AS value,
        SUM(CASE WHEN expires_at_ms > ? THEN 1 ELSE 0 END) AS live_value,
        SUM(CASE WHEN seen_by_curation_at_ms IS NULL THEN 1 ELSE 0 END) AS unseen_value
      FROM browse_cache_source_discovery_staging
      WHERE run_id = ?
        AND source = ?
    `).get(Date.now(), runId, source) as {
      value: number;
      live_value: number;
      unseen_value: number;
    };
    if (
      stagedCount.value !== run.items_added
      || stagedCount.live_value !== stagedCount.value
      || stagedCount.unseen_value !== stagedCount.value
    ) {
      throw new Error('Source discovery staging is incomplete, expired, or already consumed');
    }

    const itemsActivated = getDb().prepare(`
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
      )
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
      FROM browse_cache_source_discovery_staging
      WHERE run_id = ?
        AND source = ?
        AND 1 = 1
      ON CONFLICT(source, source_id) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        author_username = excluded.author_username,
        author_display_name = excluded.author_display_name,
        published_at_ms = excluded.published_at_ms,
        payload_json = excluded.payload_json,
        fetched_at_ms = excluded.fetched_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        seen_by_curation_at_ms = NULL
    `).run(runId, source).changes;
    if (itemsActivated !== stagedCount.value) {
      throw new Error('Source discovery activation did not publish every staged item');
    }

    const activatedAtMs = Date.now();
    getDb().prepare(`
      INSERT INTO browse_cache_source_discovery_activations (
        run_id,
        source,
        recipe_sha256,
        activated_at_ms,
        items_activated
      ) VALUES (?, ?, ?, ?, ?)
    `).run(runId, source, recipeSha256, activatedAtMs, itemsActivated);
    getDb().prepare(`
      DELETE FROM browse_cache_source_discovery_staging
      WHERE run_id = ?
        AND source = ?
    `).run(runId, source);

    return {
      source,
      runId,
      recipeSha256,
      activatedAtMs,
      itemsActivated,
    };
  });

  return tx();
}

/**
 * Complete stable queue for the fallback shipment boundary.
 *
 * This deliberately has no age window, per-source allocation, or newest-first limit. Callers
 * apply explicit agent judgments only after every structurally eligible unexpired/unseen row is
 * visible, so sustained arrivals cannot hide older work. The source allow-list is a product
 * boundary (public feed sources), not an editorial ranking signal.
 */
export function listUnseenShipmentCacheItems(
  sources: string[],
  nowMs: number,
): BrowseCacheItemRecord[] {
  const normalizedSources = [...new Set(sources.map(trimToNull).filter((value): value is string => Boolean(value)))];
  const normalizedNowMs = normalizeTimestampMs(nowMs);
  if (normalizedSources.length === 0 || normalizedNowMs === null) return [];

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
  ].join(',\n      ');
  const placeholders = normalizedSources.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT
      ${selectColumns}
    FROM browse_cache_items
    WHERE source IN (${placeholders})
      AND expires_at_ms >= ?
      AND seen_by_curation_at_ms IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM feed
        WHERE feed.source_id = browse_cache_items.source_id
      )
    ORDER BY fetched_at_ms ASC, source ASC, source_id ASC
  `).all(...normalizedSources, normalizedNowMs) as BrowseCacheItemRow[];

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
  const runError = trimToNull(input.error);
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
  const isSourceDiscovery = triggeredBy === SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY;
  const isRecurringPhoneSource = triggeredBy === PHONE_SOURCE_RECURRING_REFRESH_TRIGGERED_BY;
  if (isSourceDiscovery) {
    if (!SOURCE_DISCOVERY_RUN_ID_PATTERN.test(runId)) {
      throw new Error('Source discovery attempts require an exact UUID-backed run identity');
    }
    if (completedAtMs !== null && completedAtMs < startedAtMs) {
      throw new Error('Source discovery completedAtMs must not be before startedAtMs');
    }
    if (items.length > 100) {
      throw new Error('Source discovery attempts may submit at most 100 items');
    }
    if (status.toLowerCase() !== 'completed' && items.length > 0) {
      throw new Error('Non-completed source discovery runs may not publish cache items');
    }
    if (status.toLowerCase() === 'completed' && runError) {
      throw new Error('Completed source discovery runs may not carry an error');
    }
  }
  if (isRecurringPhoneSource) {
    if (!PHONE_SOURCE_RECURRING_RUN_ID_PATTERN.test(runId)) {
      throw new Error('Recurring phone sources require a fresh UUID-backed run identity');
    }
    if (completedAtMs !== null && completedAtMs < startedAtMs) {
      throw new Error('Recurring phone source completedAtMs must not be before startedAtMs');
    }
    if (items.length > 100) {
      throw new Error('Recurring phone source attempts may submit at most 100 items');
    }
    if (status.toLowerCase() !== 'completed' && items.length > 0) {
      throw new Error('Non-completed recurring phone source runs may not publish cache items');
    }
    if (status.toLowerCase() === 'completed' && runError) {
      throw new Error('Completed recurring phone source runs may not carry an error');
    }
  }
  // Phone-paradigm ingestion: an app the phone background-browses (a YouTube video, a Substack
  // post) rarely exposes a machine-readable publish date in the share, so phone rows arrive with
  // publishedAtMs unset. The curator's read tool defaults to requirePublishedAt (WHERE
  // published_at_ms IS NOT NULL), so undated phone rows are structurally invisible and the whole
  // phone acquisition layer gets silently bypassed. For phone-sourced runs, fall back to the browse
  // time as the recency proxy (the item was fresh in the user's feed when browsed; ORDER BY already
  // COALESCEs to fetched_at_ms). VM cache-skill runs still set real publish dates and keep the
  // strict filter, so their semantics are unchanged.
  const isPhoneBrowseRun = /phone/i.test(triggeredBy ?? '');
  const normalizedItems = new Map<string, UpsertBrowseCacheItemInput>();
  let canonicalSourceIdDuplicates = 0;

  for (const item of items) {
    const itemSource: string | null = normalizeSource(item.source) ?? source;
    if (!itemSource) continue;
    if (
      (isSourceDiscovery || isRecurringPhoneSource)
      && itemSource !== source
    ) {
      throw new Error('Phone source items must match the attempt source');
    }

    const sourceId = normalizeBrowseCacheSourceId(itemSource, item.sourceId);
    const fetchedAtMs = normalizeTimestampMs(item.fetchedAtMs);
    const expiresAtMs = normalizeTimestampMs(item.expiresAtMs);
    if (!sourceId || fetchedAtMs === null || expiresAtMs === null) {
      continue;
    }
    if (isSourceDiscovery || isRecurringPhoneSource) {
      if (normalizeTimestampMs(item.seenByCurationAtMs ?? null) !== null) {
        throw new Error('Phone source items must enter curation unseen');
      }
      if (
        fetchedAtMs < startedAtMs
        || fetchedAtMs > (completedAtMs ?? startedAtMs)
      ) {
        throw new Error('Phone source items must be fetched during the current attempt');
      }
      if (expiresAtMs <= (completedAtMs ?? startedAtMs)) {
        throw new Error('Phone source items must remain live after attempt completion');
      }
      const payload = getRecord(item.payload);
      const payloadText = trimToNull(
        typeof payload?.text === 'string' ? payload.text : null,
      );
      if (isSourceDiscovery && (
        trimToNull(typeof payload?.discoveryRunId === 'string' ? payload.discoveryRunId : null)
          !== runId
      )) {
        throw new Error('Source discovery items must carry the exact discovery run identity');
      }
      if (isSourceDiscovery && payload?.captureMethod !== 'phone-source-discovery') {
        throw new Error('Source discovery items must carry the exact capture method');
      }
      if (
        isRecurringPhoneSource
        && trimToNull(typeof payload?.recurringRunId === 'string' ? payload.recurringRunId : null)
          !== runId
      ) {
        throw new Error('Recurring phone source items must carry the exact current run identity');
      }
      if (
        isRecurringPhoneSource
        && payload?.captureMethod !== PHONE_SOURCE_RECURRING_REFRESH_TRIGGERED_BY
      ) {
        throw new Error('Recurring phone source items must carry the exact capture method');
      }
      if (!trimToNull(item.title) && !payloadText) {
        throw new Error('Phone source items must contain real title or text evidence');
      }
    }

    const normalizedItem: UpsertBrowseCacheItemInput = {
      ...item,
      source: itemSource,
      sourceId,
      payload: normalizeBrowseCachePayload(itemSource, sourceId, item.payload),
      publishedAtMs: normalizeTimestampMs(item.publishedAtMs) ?? (isPhoneBrowseRun ? fetchedAtMs : null),
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
  if (
    isSourceDiscovery
    && status.toLowerCase() === 'completed'
    && normalizedItems.size === 0
  ) {
    throw new Error('Completed source discovery requires at least one valid current-attempt item');
  }
  const provenEmpty = getRecord(getRecord(input.metadata)?.outcomeEvidence)?.provenEmpty === true;
  if (
    isRecurringPhoneSource
    && status.toLowerCase() === 'completed'
    && normalizedItems.size === 0
    && !provenEmpty
  ) {
    throw new Error('Completed recurring phone source requires items or explicit proven-empty evidence');
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
  const stageSourceDiscoveryItem = getDb().prepare(`
    INSERT INTO browse_cache_source_discovery_staging (
      run_id,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRunSql = `
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
  `;
  const insertRun = getDb().prepare(insertRunSql);
  const upsertRun = getDb().prepare(`
    ${insertRunSql}
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      triggered_by = excluded.triggered_by,
      started_at_ms = excluded.started_at_ms,
      completed_at_ms = excluded.completed_at_ms,
      status = excluded.status,
      items_added = excluded.items_added,
      error = excluded.error,
      metadata_json = excluded.metadata_json
    WHERE browse_cache_refresh_runs.triggered_by NOT IN (?, ?, ?)
  `);

  const tx = getDb().transaction(() => {
    let itemsAdded = 0;

    if (
      getDb().prepare(`
        SELECT 1
        FROM browse_cache_source_optouts
        WHERE source = ?
      `).get(source)
    ) {
      throw new Error('Cancelled sources cannot publish browse-cache evidence');
    }

    for (const item of normalizedItems.values()) {
      const itemValues = [
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
      ] as const;
      itemsAdded += isSourceDiscovery
        ? stageSourceDiscoveryItem.run(runId, ...itemValues).changes
        : upsertItem.run(...itemValues).changes;
    }

    // A source-discovery receipt is terminal authority for an expensive one-time provider run.
    // Its item count therefore comes only from rows the server accepted in this transaction;
    // never trust the provider's declared count for that boundary.
    const recordedItemsAdded = (isSourceDiscovery || isRecurringPhoneSource)
      ? itemsAdded
      : Number.isFinite(input.itemsAdded)
        ? Math.max(0, Math.floor(Number(input.itemsAdded)))
        : itemsAdded;
    const runValues = [
      runId,
      source,
      triggeredBy,
      startedAtMs,
      completedAtMs,
      status,
      recordedItemsAdded,
      runError,
      runMetadata ? JSON.stringify(runMetadata) : null,
    ] as const;
    const writeResult = (
      triggeredBy === PHONE_BENCHMARK_SHARE_REFRESH_TRIGGERED_BY
      || isSourceDiscovery
      || isRecurringPhoneSource
    )
      ? insertRun.run(...runValues)
      : upsertRun.run(
        ...runValues,
        PHONE_BENCHMARK_SHARE_REFRESH_TRIGGERED_BY,
        SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY,
        PHONE_SOURCE_RECURRING_REFRESH_TRIGGERED_BY,
      );
    if (writeResult.changes !== 1) {
      throw new Error('Browse cache refresh run identity is immutable');
    }
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
