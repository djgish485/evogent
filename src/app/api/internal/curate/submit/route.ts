import { NextResponse } from 'next/server';
import { withFeedMutationLock } from '@/lib/feed-mutation-lock';
import fs from 'node:fs';
import path from 'node:path';
import {
  allowedFeedTypes,
  getFeedItemById,
  getFeedItemBySourceId,
  insertOrIgnoreFeedItem,
  normalizeArticleSourceId,
  normalizeFeedInput,
  normalizeType,
  normalizeTweetSourceId,
  setFeedItemSuggestionStatus,
} from '@/lib/db/feed';
import { getDb } from '@/lib/db/client';
import { fetchInternal } from '@/lib/internal-request-auth';
import {
  completeCurationLogByRequestId,
  getCurationLogByRequestId,
  getFeedItemCount,
  type CurationLogCompletionStatus,
} from '@/lib/db/activity';
import {
  appendAcceptedFeedItems,
  appendCurationCandidateEntries,
  notifyFeedUpdate,
  rememberAcceptedIdentifiers,
  resolveParentIdForBatchInsert,
} from '@/lib/curation-submit';
import {
  applyCachedItemEnrichment,
  itemIsStillIncomplete,
  queueBatchEnrichment,
} from '@/lib/feed-enrichment';
import { getBrowseCacheItemByExactSourceId } from '@/lib/db/browse-cache';
import { validateFeedProminenceInput } from '@/lib/feed-prominence';
import { validateFeedInterestInput } from '@/lib/feed-carry-forward';
import {
  getYouTubeCanonicalSourceFields,
  isYouTubeSource,
} from '@/lib/youtube-feed';
import { validateArticlePublishEvidence } from '@/lib/article-publish-evidence';
import {
  canonicalizeTwitterFeedItemForSubmit,
  extractTweetIdFromStatusUrl,
} from '@/lib/twitter-feed-canonicalization';
import { pickNextThreadColor, sanitizeThreadColor } from '@/lib/thread-colors';
import { readUsageLevelConfig } from '@/lib/usage-level';
import { isPhoneRuntime } from '@/lib/runtime-profile';
import {
  fetchPublicHttpText,
  UnsafePublicHttpUrlError,
} from '@/lib/public-http';
import type { FeedInsertInput } from '@/lib/db/feed';
import type { FeedItem, LinkPreview } from '@/types/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const iso8601Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const defaultChatNotifyUrl = `http://127.0.0.1:${process.env.PORT || '3001'}/api/internal/chat-notify`;
const articleBodySourceSynopsisError = [
  'Article body must carry the source\'s own synopsis (og:description, subtitle, or opening paragraph).',
  'The body cannot be the article title or title + curator boilerplate.',
  'Fetch the URL and use the source-owned text verbatim, or drop the candidate.',
].join(' ');
const minTitlePrefixRemainderLength = 100;
const articleUrlValidationTimeoutMs = 6_000;
const maxBatchEnrichmentChunkSize = 4;
const originalPublishDateSubmitTimeWindowMs = 60_000;
const defaultEarliestPlausiblePublishDateMs = Date.UTC(1990, 0, 1);
const earliestPlausiblePublishDateBySource = new Map<string, number>([
  ['tweet', Date.UTC(2006, 2, 21)],
  ['twitter', Date.UTC(2006, 2, 21)],
  ['x', Date.UTC(2006, 2, 21)],
  ['youtube', Date.UTC(2005, 3, 23)],
  ['instagram', Date.UTC(2010, 9, 6)],
]);
const openClawMcpAppHtmlError = 'openclaw cards must include metadata.mcpAppHtml — markdown-only openclaw submissions are no longer accepted';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sourceOwnedPublishDateSources = new Set([
  'youtube',
  'hackernews',
  'hacker-news',
  'hn',
  'article',
  'substack',
  'tweet',
  'twitter',
  'twitter.com',
  'x',
  'x.com',
]);
const publishDateBypassSources = new Set([
  'openclaw',
  'chat-curator',
  'curation',
]);
const recurringPhoneCapabilityActions = new Set([
  'android_accessibility_access',
  'termux_display_over_apps',
  'phone_host_policy',
]);
const missingRealPublishDateError = (source: string) => (
  `Submission missing real publish date. Source <${source}> requires a published_at from the original source. `
  + 'Pull it from browse_cache_items.published_at_ms or fetch it from the URL before submitting.'
);
const articleUrlValidationUserAgent = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/123.0.0.0 Safari/537.36',
].join(' ');
const nonTerminalArticleStatusCodes = new Set([401, 403, 408, 429]);
const deadArticlePageDescriptions = [
  'page not found',
  'sorry this page is unavailable',
  'this page does not exist',
  'article not found',
];
const warnedInvalidOriginSessionIds = new Set<string>();

type SubmitError = {
  scope: 'item' | 'candidate' | 'cycleSummary' | 'system';
  index?: number;
  sourceId?: string | null;
  error: string;
};

export type CurateSubmitItemPreflightResult =
  | { ok: true; normalized: FeedInsertInput }
  | {
      ok: false;
      error: SubmitError;
      strictCategory?: 'publish-date' | 'article-body' | 'openclaw-html' | 'missing-interest';
    };

export interface CurateSubmitItemPreflightOptions {
  requireInterest?: boolean;
  requirePrimaryRoot?: boolean;
}

type CandidateLogEntry = {
  cycleId: string;
  sourceId: string;
  authorUsername: string | null;
  text: string;
  reason: string;
  rejectionReason: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

type CycleSummaryLogEntry = {
  cycleId: string;
  type: 'cycle_summary';
  considered: number;
  selected: number;
  rejected: number;
  topRejectionReasons: string[];
  metadata?: Record<string, unknown>;
  timestamp: string;
};

type ChatSuggestionEvent = {
  type: 'chat_suggestion';
  originSessionId: string;
  suggestion: {
    id: string;
    title: string;
    summary: string;
    suggestionType: 'code_fix';
    proposedValue: string;
    status: string;
  };
};

type OriginSessionValidationContext = {
  openClawSessionChecks: Map<string, Promise<boolean>>;
};

type AutomatedCompletionAssessment = {
  shouldComplete: boolean;
  completionStatus: 'success' | 'successful_empty' | 'failed' | null;
  completionReason: string | null;
  rejectedReason: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getInputSourceId(input: Record<string, unknown>): string | null {
  return typeof input.sourceId === 'string'
    ? input.sourceId
    : typeof input.source_id === 'string'
      ? input.source_id
      : null;
}

function normalizeSourceName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isCancelledSourceDiscoverySuccess(item: FeedInsertInput): boolean {
  const metadata = isRecord(item.metadata) ? item.metadata : null;
  const source = normalizeSourceName(metadata?.sourceName);
  if (
    item.type !== 'notification'
    || item.source !== 'phone'
    || metadata?.notificationKind !== 'source_discovery_success'
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)
    || item.sourceId !== `source-discovery-${source}`
    || metadata.notificationId !== item.sourceId
  ) {
    return false;
  }
  return Boolean(getDb().prepare(`
    SELECT 1
    FROM browse_cache_source_optouts
    WHERE source = ?
  `).get(source));
}

function requiredSourceOwnedPublishDateSource(
  input: Record<string, unknown>,
  type: FeedInsertInput['type'],
): string | null {
  const source = normalizeSourceName(input.source);
  const metadata = isRecord(input.metadata) ? input.metadata : null;
  const metadataSource = normalizeSourceName(metadata?.source);

  if (publishDateBypassSources.has(source) || publishDateBypassSources.has(metadataSource)) {
    return null;
  }

  if (type === 'tweet') {
    return source || 'tweet';
  }

  return sourceOwnedPublishDateSources.has(source) ? source : null;
}

function validateSourceOwnedPublishedAt(
  value: unknown,
  source: string,
  requestReceivedAtMs: number,
): string | null {
  const trimmed = trimString(value);
  if (!trimmed || !iso8601Pattern.test(trimmed)) {
    return missingRealPublishDateError(source);
  }

  const parsed = new Date(trimmed);
  const publishedAtMs = parsed.getTime();
  if (!Number.isFinite(publishedAtMs)) {
    return missingRealPublishDateError(source);
  }

  if (publishedAtMs > requestReceivedAtMs) {
    return missingRealPublishDateError(source);
  }

  const earliestPlausibleMs = earliestPlausiblePublishDateBySource.get(source)
    ?? defaultEarliestPlausiblePublishDateMs;
  if (publishedAtMs < earliestPlausibleMs) {
    return `Submission has an implausible publish date for ${source}: ${trimmed}. `
      + 'Preserve the source item in browse evidence, but do not ship it until its real timestamp is recovered.';
  }

  if (Math.abs(publishedAtMs - requestReceivedAtMs) <= originalPublishDateSubmitTimeWindowMs) {
    return missingRealPublishDateError(source);
  }

  return null;
}

function normalizePublishedAtInput(input: Record<string, unknown>): unknown {
  const explicitPublishedAt = input.publishedAt ?? input.published_at;
  if (explicitPublishedAt !== undefined && explicitPublishedAt !== null) {
    return explicitPublishedAt;
  }

  const publishedAtMs = input.publishedAtMs ?? input.published_at_ms;
  const parsed = typeof publishedAtMs === 'number'
    ? publishedAtMs
    : typeof publishedAtMs === 'string' && publishedAtMs.trim()
      ? Number(publishedAtMs.trim())
      : null;

  if (!Number.isFinite(parsed)) {
    return explicitPublishedAt;
  }

  return new Date(parsed as number).toISOString();
}

function warnInvalidOriginSessionId(originSessionId: string) {
  if (warnedInvalidOriginSessionIds.has(originSessionId)) {
    return;
  }
  warnedInvalidOriginSessionIds.add(originSessionId);
  console.warn(`[curate-submit] Dropping invalid originSessionId: ${originSessionId}`);
}

function hasExistingChatSessionId(originSessionId: string): boolean {
  if (!uuidPattern.test(originSessionId)) {
    return false;
  }

  const row = getDb().prepare(`
    SELECT id
    FROM chat_sessions
    WHERE id = ?
    LIMIT 1
  `).get(originSessionId) as { id: string } | undefined;

  return Boolean(row);
}

async function normalizeOriginSessionId(
  originSessionId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for signature stability; dedup guard removed
  validationContext: OriginSessionValidationContext,
): Promise<string | null> {
  if (!originSessionId) {
    return null;
  }

  if (hasExistingChatSessionId(originSessionId)) {
    return originSessionId;
  }

  warnInvalidOriginSessionId(originSessionId);
  return null;
}

function readThreadColorCounts(db: ReturnType<typeof getDb>): Record<string, number> {
  const rows = db.prepare(`
    SELECT color, COUNT(*) AS count
    FROM threads
    GROUP BY color
  `).all() as Array<{ color: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const color = sanitizeThreadColor(row.color);
    if (!color) {
      continue;
    }
    counts[color] = (counts[color] ?? 0) + row.count;
  }
  return counts;
}

function ensureThreadColor(threadId: string): string {
  const db = getDb();
  const selectColor = db.prepare(`
    SELECT color
    FROM threads
    WHERE thread_id = ?
  `);
  const existing = selectColor.get(threadId) as { color: string } | undefined;
  const existingColor = sanitizeThreadColor(existing?.color);
  if (existingColor) {
    return existingColor;
  }

  const color = pickNextThreadColor(readThreadColorCounts(db));
  const now = Date.now();
  if (existing) {
    db.prepare(`
      UPDATE threads
      SET color = ?
      WHERE thread_id = ?
    `).run(color, threadId);
    return color;
  }

  db.prepare(`
    INSERT OR IGNORE INTO threads (thread_id, color, created_at_ms)
    VALUES (?, ?, ?)
  `).run(threadId, color, now);

  const stored = selectColor.get(threadId) as { color: string } | undefined;
  return sanitizeThreadColor(stored?.color) ?? color;
}

function normalizeSubmittedThreadMetadata(metadata: Record<string, unknown>): { threadId: string; thread: Record<string, unknown> } | null {
  const nestedThread = isRecord(metadata.thread) ? metadata.thread : null;
  const rawThreadId = typeof nestedThread?.threadId === 'string' && nestedThread.threadId.trim()
    ? nestedThread.threadId.trim()
    : typeof metadata.threadId === 'string' && metadata.threadId.trim()
      ? metadata.threadId.trim()
      : '';
  if (!rawThreadId) return null;

  const thread: Record<string, unknown> = nestedThread ? { ...nestedThread } : {};
  thread.threadId = rawThreadId;

  if (typeof thread.threadTitle !== 'string' || !thread.threadTitle.trim()) {
    if (typeof metadata.threadTitle === 'string' && metadata.threadTitle.trim()) {
      thread.threadTitle = metadata.threadTitle.trim();
    }
  }

  if (typeof thread.threadRationale !== 'string' || !thread.threadRationale.trim()) {
    if (typeof metadata.threadRationale === 'string' && metadata.threadRationale.trim()) {
      thread.threadRationale = metadata.threadRationale.trim();
    }
  }

  if (typeof thread.continuing !== 'boolean' && typeof metadata.continuing === 'boolean') {
    thread.continuing = metadata.continuing;
  }

  return { threadId: rawThreadId, thread };
}

function assignThreadColor(item: FeedInsertInput): FeedInsertInput {
  const metadata = isRecord(item.metadata) ? item.metadata : null;
  if (!metadata) {
    return item;
  }

  const normalizedThread = normalizeSubmittedThreadMetadata(metadata);
  if (!normalizedThread) {
    return item;
  }

  const color = ensureThreadColor(normalizedThread.threadId);
  item.metadata = {
    ...metadata,
    thread: {
      ...normalizedThread.thread,
      threadId: normalizedThread.threadId,
      color,
    },
  };
  return item;
}

function readRequiredString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `Field "${field}" must be a non-empty string` };
  }

  return { ok: true, value: value.trim() };
}

function parseIso8601Timestamp(
  value: unknown,
  field: string,
  options: { allowFuture?: boolean } = {},
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `Field "${field}" must be a non-empty ISO-8601 string` };
  }

  const trimmed = value.trim();
  if (!iso8601Pattern.test(trimmed)) {
    return { ok: false, error: `Field "${field}" must be a valid ISO-8601 timestamp` };
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: `Field "${field}" must be a valid ISO-8601 timestamp` };
  }

  if (!options.allowFuture && parsed.getTime() > Date.now()) {
    return { ok: false, error: `Field "${field}" must not be in the future` };
  }

  return { ok: true, value: parsed.toISOString() };
}

function buildInvalidTypeMessage(type: string): string {
  const validTypes = allowedFeedTypes.join(', ');
  const normalizedType = type.trim().toLowerCase();
  const hint = normalizedType === 'code_fix'
    ? " For code_fix suggestions, use {type: 'suggestion', metadata: {suggestionType: 'code_fix', ...}}."
    : '';
  return `Invalid type '${type}'. Valid types: ${validTypes}.${hint}`;
}

function parseCandidateEntry(input: unknown, index: number): { ok: true; entry: CandidateLogEntry } | { ok: false; error: SubmitError } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { scope: 'candidate', index, error: 'Candidate entry must be a JSON object' },
    };
  }

  const cycleId = readRequiredString(input.cycleId, 'cycleId');
  if (!cycleId.ok) {
    return { ok: false, error: { scope: 'candidate', index, error: cycleId.error } };
  }

  const sourceId = readRequiredString(input.sourceId, 'sourceId');
  if (!sourceId.ok) {
    return { ok: false, error: { scope: 'candidate', index, error: sourceId.error } };
  }

  const text = readRequiredString(input.text, 'text');
  if (!text.ok) {
    return { ok: false, error: { scope: 'candidate', index, error: text.error } };
  }

  const reason = readRequiredString(input.reason, 'reason');
  if (!reason.ok) {
    return { ok: false, error: { scope: 'candidate', index, error: reason.error } };
  }

  const rejectionReason = readRequiredString(input.rejectionReason, 'rejectionReason');
  if (!rejectionReason.ok) {
    return { ok: false, error: { scope: 'candidate', index, error: rejectionReason.error } };
  }

  const timestamp = parseIso8601Timestamp(input.timestamp, 'timestamp', { allowFuture: true });
  if (!timestamp.ok) {
    return { ok: false, error: { scope: 'candidate', index, error: timestamp.error } };
  }

  return {
    ok: true,
    entry: {
      cycleId: cycleId.value,
      sourceId: sourceId.value,
      authorUsername: typeof input.authorUsername === 'string' && input.authorUsername.trim()
        ? input.authorUsername.trim()
        : null,
      text: text.value,
      reason: reason.value,
      rejectionReason: rejectionReason.value,
      timestamp: timestamp.value,
      ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    },
  };
}

function parseCycleSummary(input: unknown): { ok: true; entry: CycleSummaryLogEntry | null } | { ok: false; error: SubmitError } {
  if (input === undefined || input === null) {
    return { ok: true, entry: null };
  }

  if (!isRecord(input)) {
    return {
      ok: false,
      error: { scope: 'cycleSummary', error: 'cycleSummary must be a JSON object' },
    };
  }

  const cycleId = readRequiredString(input.cycleId, 'cycleId');
  if (!cycleId.ok) {
    return { ok: false, error: { scope: 'cycleSummary', error: cycleId.error } };
  }

  const requiredCountFields = ['considered', 'selected'] as const;
  const parsedRequiredCounts = Object.fromEntries(requiredCountFields.map((field) => {
    const rawValue = input[field];
    const normalized = typeof rawValue === 'number' && Number.isFinite(rawValue)
      ? Math.max(0, Math.floor(rawValue))
      : Number.NaN;
    return [field, normalized];
  })) as Record<(typeof requiredCountFields)[number], number>;

  const invalidCountField = requiredCountFields.find((field) => !Number.isFinite(parsedRequiredCounts[field]));
  if (invalidCountField) {
    return {
      ok: false,
      error: { scope: 'cycleSummary', error: `Field "${invalidCountField}" must be a finite number` },
    };
  }
  if (parsedRequiredCounts.selected > parsedRequiredCounts.considered) {
    return {
      ok: false,
      error: { scope: 'cycleSummary', error: 'Field "selected" cannot exceed "considered"' },
    };
  }

  const rawRejected = input.rejected;
  const rejected = rawRejected === undefined || rawRejected === null
    ? Math.max(0, parsedRequiredCounts.considered - parsedRequiredCounts.selected)
    : typeof rawRejected === 'number' && Number.isFinite(rawRejected)
      ? Math.max(0, Math.floor(rawRejected))
      : Number.NaN;
  if (!Number.isFinite(rejected)) {
    return {
      ok: false,
      error: { scope: 'cycleSummary', error: 'Field "rejected" must be a finite number when provided' },
    };
  }
  if (parsedRequiredCounts.selected + rejected !== parsedRequiredCounts.considered) {
    return {
      ok: false,
      error: { scope: 'cycleSummary', error: 'Fields "selected" and "rejected" must add up to "considered"' },
    };
  }

  if (!Array.isArray(input.topRejectionReasons) || !input.topRejectionReasons.every((entry) => typeof entry === 'string')) {
    return {
      ok: false,
      error: { scope: 'cycleSummary', error: 'Field "topRejectionReasons" must be an array of strings' },
    };
  }

  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    return {
      ok: false,
      error: { scope: 'cycleSummary', error: 'Field "metadata" must be a JSON object when provided' },
    };
  }

  const metadata: Record<string, unknown> = isRecord(input.metadata) ? { ...input.metadata } : {};
  const copiedTopLevelMetadataFields = [
    'mode',
    'curationMode',
    'cycleMode',
    'triggerMode',
    'carryForwardAudit',
  ] as const;
  for (const field of copiedTopLevelMetadataFields) {
    if (metadata[field] === undefined && input[field] !== undefined) {
      metadata[field] = input[field];
    }
  }

  return {
    ok: true,
    entry: {
      cycleId: cycleId.value,
      type: 'cycle_summary',
      considered: parsedRequiredCounts.considered,
      selected: parsedRequiredCounts.selected,
      rejected,
      topRejectionReasons: input.topRejectionReasons.map((entry) => entry.trim()).filter(Boolean),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      timestamp: new Date().toISOString(),
    },
  };
}

type PendingAutomatedCurationState = {
  requestId: string;
  feedDelta: number;
};

function readPendingAutomatedCurationState(cycleId: string | null): PendingAutomatedCurationState | null {
  if (!cycleId) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT request_id, feed_count_before
    FROM curation_log
    WHERE completed_at IS NULL
      AND request_id = ?
      AND (
        triggered_by LIKE 'adaptive_heartbeat:%'
        OR triggered_by LIKE 'phone_scheduler:%'
      )
    LIMIT 1
  `).get(cycleId) as { request_id: string; feed_count_before: number | null } | undefined;
  if (!row) return null;
  const baseline = typeof row.feed_count_before === 'number'
    ? Math.max(0, Math.floor(row.feed_count_before))
    : null;
  return {
    requestId: row.request_id,
    feedDelta: baseline === null ? 0 : Math.max(0, getFeedItemCount() - baseline),
  };
}

function readLatestPendingAutomatedCurationCycleId(): string | null {
  const row = getDb().prepare(`
    SELECT request_id
    FROM curation_log
    WHERE completed_at IS NULL
      AND request_id IS NOT NULL
      AND (
        triggered_by LIKE 'adaptive_heartbeat:%'
        OR triggered_by LIKE 'phone_scheduler:%'
      )
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT 1
  `).get() as { request_id: string } | undefined;
  return row?.request_id ?? null;
}

function hasEmptyCycleJudgment(entry: CycleSummaryLogEntry | null): boolean {
  if (!entry) return false;
  if (entry.selected !== 0) return false;
  return entry.topRejectionReasons.length > 0;
}

function assessAutomatedCurationCompletion(input: {
  acceptedCount: number;
  duplicateCount: number;
  cycleFeedDelta: number;
  cycleSummary: CycleSummaryLogEntry | null;
  errors: SubmitError[];
}): AutomatedCompletionAssessment {
  const acceptedCount = input.acceptedCount;
  const hasReceiptValidationError = input.errors.some(
    (error) => error.scope === 'cycleSummary' || error.scope === 'candidate',
  );
  if (!input.cycleSummary || hasReceiptValidationError) {
    const reason = 'automated curation completion receipt is invalid; correct the cycleSummary or candidate receipts and resubmit';
    return {
      shouldComplete: true,
      completionStatus: 'failed',
      completionReason: reason,
      rejectedReason: reason,
    };
  }

  if (input.errors.length > 0) {
    return { shouldComplete: false, completionStatus: null, completionReason: null, rejectedReason: null };
  }

  const priorCycleFeedDelta = Math.max(0, Math.floor(input.cycleFeedDelta));
  const duplicateCount = Math.max(0, Math.floor(input.duplicateCount));
  const durableSelectionCount = priorCycleFeedDelta + acceptedCount + duplicateCount;
  if (input.cycleSummary.selected !== durableSelectionCount) {
    const reason = [
      `automated curation receipt selected=${input.cycleSummary.selected}`,
      `does not match durable cycle selection evidence=${durableSelectionCount}`,
      `(${priorCycleFeedDelta} prior-cycle persisted + ${acceptedCount} accepted + ${duplicateCount} duplicate)`,
    ].join(' ');
    return {
      shouldComplete: true,
      completionStatus: 'failed',
      completionReason: reason,
      rejectedReason: reason,
    };
  }

  // A terminal receipt may intentionally carry no items when earlier chunks in
  // this same pending cycle already persisted them. The cycle baseline is durable
  // evidence; final-call batch size is not the definition of success.
  if (acceptedCount > 0 || priorCycleFeedDelta > 0) {
    return { shouldComplete: true, completionStatus: 'success', completionReason: null, rejectedReason: null };
  }

  if (duplicateCount > 0) {
    return {
      shouldComplete: true,
      completionStatus: 'successful_empty',
      completionReason: 'curate-submit completed with selected items already present in the feed',
      rejectedReason: null,
    };
  }

  if (hasEmptyCycleJudgment(input.cycleSummary)) {
    return { shouldComplete: true, completionStatus: 'successful_empty', completionReason: null, rejectedReason: null };
  }

  const reason = input.cycleSummary.selected > 0
    ? 'automated curation receipt reports selected items but has no accepted, duplicate, or prior-cycle feed evidence'
    : 'empty automated curation receipt must include at least one concrete rejection reason documenting the agent judgment';
  return {
    shouldComplete: true,
    completionStatus: 'failed',
    completionReason: reason,
    rejectedReason: reason,
  };
}

function buildChatSuggestionSummary(item: FeedItem): string {
  const rawSummary = item.text.replace(/\s+/g, ' ').trim()
    || (typeof item.metadata?.proposedValue === 'string' ? item.metadata.proposedValue.replace(/\s+/g, ' ').trim() : '');
  if (!rawSummary) {
    return 'Suggested code fix';
  }

  const firstSentenceMatch = rawSummary.match(/^.+?[.!?](?=\s|$)/);
  const firstLine = (firstSentenceMatch?.[0] ?? rawSummary).trim();
  if (firstLine.length <= 140) {
    return firstLine;
  }

  return `${firstLine.slice(0, 137).trimEnd()}...`;
}

function buildAcceptedCodeFixChatSuggestionEvents(items: FeedItem[]): ChatSuggestionEvent[] {
  return items.flatMap((item) => {
    const suggestionType = typeof item.metadata?.suggestionType === 'string'
      ? item.metadata.suggestionType.trim().toLowerCase()
      : '';
    const proposedValue = typeof item.metadata?.proposedValue === 'string'
      ? item.metadata.proposedValue.trim()
      : '';
    const originSessionId = typeof item.originSessionId === 'string' ? item.originSessionId.trim() : '';

    if (
      item.type !== 'suggestion'
      || suggestionType !== 'code_fix'
      || !originSessionId
      || !proposedValue
    ) {
      return [];
    }

    return [{
      type: 'chat_suggestion' as const,
      originSessionId,
      suggestion: {
        id: item.id,
        title: item.title?.trim() || 'Suggested code fix',
        summary: buildChatSuggestionSummary(item),
        suggestionType: 'code_fix' as const,
        proposedValue,
        status: item.suggestionStatus ?? 'pending',
      },
    }];
  });
}

async function notifyChatSuggestionEvents(events: ChatSuggestionEvent[]) {
  if (events.length === 0) {
    return;
  }

  const notifyUrl = process.env.INTERNAL_CHAT_NOTIFY_URL || defaultChatNotifyUrl;
  const response = await fetchInternal(notifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) {
    throw new Error(`Chat notify failed (${response.status})`);
  }
}

function parseFeedInsertInput(
  input: unknown,
  index: number,
  requestReceivedAtMs: number,
): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError; publishDateValidationError?: boolean } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { scope: 'item', index, error: 'Item must be a JSON object' },
    };
  }

  const sourceId = getInputSourceId(input);
  const normalizedType = normalizeType(input.type);
  if (!normalizedType) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId,
        error: buildInvalidTypeMessage(typeof input.type === 'string' ? input.type.trim() || String(input.type) : String(input.type)),
      },
    };
  }

  const metadata = isRecord(input.metadata) ? input.metadata : null;
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'prominence')) {
    const prominenceError = validateFeedProminenceInput(metadata.prominence);
    if (prominenceError) {
      return {
        ok: false,
        error: {
          scope: 'item',
          index,
          sourceId,
          error: prominenceError,
        },
      };
    }
  }
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'interest')) {
    const interestError = validateFeedInterestInput(metadata.interest);
    if (interestError) {
      return {
        ok: false,
        error: {
          scope: 'item',
          index,
          sourceId,
          error: interestError,
        },
      };
    }
  }
  if (
    metadata
    && isRecord(metadata.thread)
    && Object.prototype.hasOwnProperty.call(metadata.thread, 'prominence')
  ) {
    const prominenceError = validateFeedProminenceInput(
      metadata.thread.prominence,
      'metadata.thread.prominence',
      { requiredSource: 'homepage' },
    );
    if (prominenceError) {
      return {
        ok: false,
        error: {
          scope: 'item',
          index,
          sourceId,
          error: prominenceError,
        },
      };
    }
  }

  const publishedAtRaw = normalizePublishedAtInput(input);
  const requiredPublishDateSource = requiredSourceOwnedPublishDateSource(input, normalizedType);
  if (requiredPublishDateSource) {
    const publishDateError = validateSourceOwnedPublishedAt(
      publishedAtRaw,
      requiredPublishDateSource,
      requestReceivedAtMs,
    );
    if (publishDateError) {
      return {
        ok: false,
        publishDateValidationError: true,
        error: {
          scope: 'item',
          index,
          sourceId,
          error: publishDateError,
        },
      };
    }
  }

  const isMissingPublishedAt = publishedAtRaw === undefined
    || publishedAtRaw === null
    || (typeof publishedAtRaw === 'string' && !publishedAtRaw.trim());
  const publishedAtInput = isMissingPublishedAt
    ? new Date(requestReceivedAtMs).toISOString()
    : publishedAtRaw;
  const publishedAt = parseIso8601Timestamp(publishedAtInput, 'publishedAt');
  if (!publishedAt.ok) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId,
        error: publishedAt.error,
      },
    };
  }

  const normalized = normalizeFeedInput({
    ...input,
    type: normalizedType,
    publishedAt: publishedAt.value,
  });

  if (!normalized) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId: typeof input.sourceId === 'string' ? input.sourceId : typeof input.source_id === 'string' ? input.source_id : null,
        error: 'Item failed feed normalization',
      },
    };
  }

  const topLevelSource = typeof normalized.source === 'string'
    ? normalized.source.trim().toLowerCase()
    : '';
  if (topLevelSource === 'curation') {
    normalized.source = 'openclaw';
    if (
      !normalized.metadata
      || !Object.prototype.hasOwnProperty.call(normalized.metadata, 'source')
    ) {
      normalized.metadata = {
        ...(normalized.metadata ?? {}),
        source: 'chat-curator',
      };
    }
  } else if (
    normalized.source == null
    && normalized.metadata?.source === 'chat-curator'
  ) {
    normalized.source = 'openclaw';
  }

  ensureHackerNewsDiscussionUrl(normalized);

  return { ok: true, normalized };
}

function ensureHackerNewsDiscussionUrl(normalized: FeedInsertInput): void {
  const metadata = (normalized.metadata && typeof normalized.metadata === 'object'
    ? normalized.metadata
    : {}) as Record<string, unknown>;
  const metadataSource = typeof metadata.source === 'string'
    ? metadata.source.trim().toLowerCase()
    : '';
  const topLevel = typeof normalized.source === 'string'
    ? normalized.source.trim().toLowerCase()
    : '';
  const isHackerNews = metadataSource === 'hackernews' || topLevel === 'hackernews';
  if (!isHackerNews) return;
  const hasUrl = ['hnUrl', 'discussionUrl', 'hackerNewsUrl'].some((key) => {
    const value = metadata[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
  if (hasUrl) return;
  const sourceCandidates = [normalized.sourceId, metadata.sourceId]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  let id: string | null = null;
  for (const candidate of sourceCandidates) {
    const prefixed = candidate.match(/^hn-(\d+)$/i);
    if (prefixed?.[1]) {
      id = prefixed[1];
      break;
    }
    if (/^\d+$/.test(candidate)) {
      id = candidate;
      break;
    }
  }
  if (!id) {
    console.warn('[curate/submit] hackernews item missing hnUrl and unresolvable sourceId', {
      sourceId: normalized.sourceId ?? null,
      url: normalized.url ?? null,
    });
    return;
  }
  metadata.hnUrl = `https://news.ycombinator.com/item?id=${id}`;
  normalized.metadata = metadata as FeedInsertInput['metadata'];
}

function validatePublishEvidence(
  item: FeedInsertInput,
  index: number,
): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError } {
  const articlePublishEvidenceError = validateArticlePublishEvidence({
    type: item.type,
    source: item.source,
    url: item.url,
    publishedAt: item.publishedAt,
    metadata: item.metadata,
  });

  if (!articlePublishEvidenceError) {
    return { ok: true, normalized: item };
  }

  return {
    ok: false,
    error: {
      scope: 'item',
      index,
      sourceId: item.sourceId ?? null,
      error: articlePublishEvidenceError,
    },
  };
}

function validateSuggestionIntegrity(
  item: FeedInsertInput,
  index: number,
): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError } {
  if (item.type !== 'suggestion') {
    return { ok: true, normalized: item };
  }

  const metadata = item.metadata ?? {};
  const suggestionType = typeof metadata.suggestionType === 'string'
    ? metadata.suggestionType.trim().toLowerCase()
    : '';

  if (!suggestionType || suggestionType === 'code_fix' || suggestionType === 'life_admin' || suggestionType === 'source_setup') {
    return { ok: true, normalized: item };
  }

  return {
    ok: false,
    error: {
      scope: 'item',
      index,
      sourceId: item.sourceId ?? null,
      error: 'All suggestions must use suggestionType "code_fix", "life_admin", or "source_setup".',
    },
  };
}

function validateValidatedYouTubeItem(
  item: FeedInsertInput,
  index: number,
): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError } {
  if (item.type !== 'article' || !isYouTubeSource(item.source)) {
    return { ok: true, normalized: item };
  }

  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const canonicalFields = getYouTubeCanonicalSourceFields({
    sourceId: item.sourceId,
    url: item.url,
    metadata,
    mediaUrls: item.mediaUrls,
  });

  if (!canonicalFields) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId: item.sourceId ?? null,
        error: 'YouTube item must include a canonical watch URL or video id',
      },
    };
  }

  if (!canonicalFields.thumbnailUrl) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId: canonicalFields.videoId,
        error: 'YouTube item must preserve thumbnailUrl before feed submission',
      },
    };
  }

  if (!canonicalFields.publishDate && !canonicalFields.publishDateText) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId: canonicalFields.videoId,
        error: 'YouTube item must preserve publishDate or publishDateText before feed submission',
      },
    };
  }

  if (!canonicalFields.publishedAt) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId: canonicalFields.videoId,
        error: 'YouTube item publish metadata could not be resolved to publishedAt',
      },
    };
  }

  return {
    ok: true,
    normalized: item,
  };
}

function normalizeArticleBodyComparisonText(value: string | null | undefined): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLowerCase()
    : '';
}

function isTitleOnlyArticleBody(value: string | null | undefined, title: string | null | undefined): boolean {
  const normalizedTitle = normalizeArticleBodyComparisonText(title);
  const normalizedValue = normalizeArticleBodyComparisonText(value);

  if (!normalizedTitle || !normalizedValue) {
    return false;
  }

  if (normalizedValue === normalizedTitle) {
    return true;
  }

  if (!normalizedValue.startsWith(normalizedTitle)) {
    return false;
  }

  const remainder = normalizedValue.slice(normalizedTitle.length).trim();
  return remainder.length < minTitlePrefixRemainderLength;
}

function isRichOpenClawSkillCard(item: FeedInsertInput): boolean {
  const metadata = isRecord(item.metadata) ? item.metadata : null;
  if (!metadata) {
    return false;
  }

  const source = typeof item.source === 'string'
    ? item.source.trim().toLowerCase()
    : '';
  const metadataSource = typeof metadata.source === 'string'
    ? metadata.source.trim().toLowerCase()
    : '';
  const mcpAppHtml = typeof metadata.mcpAppHtml === 'string'
    ? metadata.mcpAppHtml.trim()
    : '';
  const openClaw = isRecord(metadata.openClaw) ? metadata.openClaw : null;
  const skill = typeof openClaw?.skill === 'string'
    ? openClaw.skill.trim()
    : '';

  return source === 'openclaw'
    && metadataSource === 'openclaw'
    && Boolean(mcpAppHtml)
    && Boolean(skill);
}

function validateArticleBody(
  item: FeedInsertInput,
  index: number,
): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError } {
  if (item.type !== 'article') {
    return { ok: true, normalized: item };
  }

  if (isRichOpenClawSkillCard(item)) {
    return { ok: true, normalized: item };
  }

  const hasTitleOnlyText = isTitleOnlyArticleBody(item.text, item.title);
  const hasTitleOnlyExcerpt = typeof item.excerpt === 'string' && item.excerpt.trim()
    ? isTitleOnlyArticleBody(item.excerpt, item.title)
    : false;

  if (!hasTitleOnlyText && !hasTitleOnlyExcerpt) {
    return { ok: true, normalized: item };
  }

  return {
    ok: false,
    error: {
      scope: 'item',
      index,
      sourceId: item.sourceId ?? null,
      error: articleBodySourceSynopsisError,
    },
  };
}

function normalizeDeadArticlePageText(value: string | null | undefined): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/&(?:nbsp|#160);/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ');
}

function extractOgDescription(html: string): string | null {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const descriptor = tag.match(/\b(?:property|name)\s*=\s*(['"])(.*?)\1/i)?.[2]?.trim().toLowerCase();
    if (descriptor !== 'og:description') {
      continue;
    }
    const content = tag.match(/\bcontent\s*=\s*(['"])(.*?)\1/i)?.[2]?.trim();
    return content ? decodeBasicHtmlEntities(content).trim() : null;
  }
  return null;
}

function articlePageDescriptionLooksDead(value: string | null | undefined): boolean {
  const normalized = normalizeDeadArticlePageText(value);
  return Boolean(normalized) && deadArticlePageDescriptions.some((description) => (
    normalized === description || normalized.startsWith(`${description} `)
  ));
}

async function validateArticleUrl(
  item: FeedInsertInput,
  index: number,
): Promise<{ ok: true } | { ok: false; error: SubmitError }> {
  if (item.type !== 'article' || !item.url?.trim()) {
    return { ok: true };
  }

  const url = item.url.trim();

  try {
    const response = await fetchPublicHttpText(url, {
      timeoutMs: articleUrlValidationTimeoutMs,
      maxBytes: 262_144,
      headers: {
        'User-Agent': articleUrlValidationUserAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (
      response.status >= 400
      && response.status < 500
      && !nonTerminalArticleStatusCodes.has(response.status)
    ) {
      return {
        ok: false,
        error: {
          scope: 'item',
          index,
          sourceId: item.sourceId ?? null,
          error: `Article URL returned ${response.status}`,
        },
      };
    }

    if (response.status === 200) {
      const contentType = response.contentType;
      const normalizedContentType = contentType.toLowerCase();
      if (!normalizedContentType || normalizedContentType.includes('html') || normalizedContentType.includes('xml')) {
        // Only the <head> holds og:description. Cap the regex input to 256KB: a multi-MB page
        // (e.g. a GitHub releases page) makes the meta-tag scan peg CPU for a minute on-device.
        const html = response.text;
        if (articlePageDescriptionLooksDead(extractOgDescription(html))) {
          return {
            ok: false,
            error: {
              scope: 'item',
              index,
              sourceId: item.sourceId ?? null,
              error: 'Article URL returns Page Not Found body',
            },
          };
        }
      }
    }
  } catch (error) {
    if (error instanceof UnsafePublicHttpUrlError) {
      return {
        ok: false,
        error: {
          scope: 'item',
          index,
          sourceId: item.sourceId ?? null,
          error: 'Article URL must resolve only to a public HTTP destination',
        },
      };
    }
    console.warn(
      '[curate-submit] allowing article after transient public URL validation failure',
      error instanceof Error ? error.message : String(error),
    );
  }

  return { ok: true };
}

/**
 * Shared, side-effect-free item-shape gate for direct submit and the curator bench.
 * URL reachability is separated below so callers can validate a batch concurrently.
 */
export function preflightCurateSubmitItemShape(
  input: unknown,
  index: number,
  requestReceivedAtMs: number,
  options: CurateSubmitItemPreflightOptions = {},
): CurateSubmitItemPreflightResult {
  const parsed = parseFeedInsertInput(input, index, requestReceivedAtMs);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      ...(parsed.publishDateValidationError ? { strictCategory: 'publish-date' as const } : {}),
    };
  }

  const canonicalizedTwitter = canonicalizeTwitterItemForSubmit(parsed.normalized, index);
  if (!canonicalizedTwitter.ok) return canonicalizedTwitter;

  const validatedPublishEvidence = validatePublishEvidence(canonicalizedTwitter.normalized, index);
  if (!validatedPublishEvidence.ok) return validatedPublishEvidence;

  const validatedSuggestion = validateSuggestionIntegrity(validatedPublishEvidence.normalized, index);
  if (!validatedSuggestion.ok) return validatedSuggestion;

  const validatedYouTube = validateValidatedYouTubeItem(validatedSuggestion.normalized, index);
  if (!validatedYouTube.ok) return validatedYouTube;

  const validatedArticleBody = validateArticleBody(validatedYouTube.normalized, index);
  if (!validatedArticleBody.ok) {
    return {
      ...validatedArticleBody,
      strictCategory: 'article-body',
    };
  }

  const normalized = validatedArticleBody.normalized;
  const metadata = isRecord(normalized.metadata) ? normalized.metadata : null;
  const openClawMetadataSource = typeof metadata?.source === 'string'
    ? metadata.source.trim().toLowerCase()
    : '';
  const openClawMcpAppHtml = metadata?.mcpAppHtml;
  if (
    normalized.source === 'openclaw'
    && normalized.type !== 'suggestion'
    && openClawMetadataSource !== 'chat-curator'
    && (typeof openClawMcpAppHtml !== 'string' || !openClawMcpAppHtml.trim())
  ) {
    return {
      ok: false,
      strictCategory: 'openclaw-html',
      error: {
        scope: 'item',
        index,
        sourceId: normalized.sourceId ?? null,
        error: openClawMcpAppHtmlError,
      },
    };
  }

  if (
    options.requireInterest
    && !normalized.parentId
    && ['tweet', 'article', 'analysis', 'youtube', 'hackernews'].includes(normalized.type)
    && !isRecord(metadata?.interest)
  ) {
    return {
      ok: false,
      strictCategory: 'missing-interest',
      error: {
        scope: 'item',
        index,
        sourceId: normalized.sourceId ?? null,
        error: 'metadata.interest is required as supporting agent judgment on every primary item in automated curation submits: include { "score": <0-1 ordinal content-value evidence>, "durability": "evergreen" | "dated" | "news" }. Shipment and order must still be explicit agent decisions; then resubmit this item (curate.md pre-POST checklist).',
      },
    };
  }

  if (options.requirePrimaryRoot) {
    if (!['tweet', 'article', 'analysis'].includes(normalized.type)) {
      return {
        ok: false,
        error: {
          scope: 'item',
          index,
          sourceId: normalized.sourceId ?? null,
          error: 'Curator bench items must be primary tweet, article, or analysis items',
        },
      };
    }
    if (normalized.parentId) {
      return {
        ok: false,
        error: {
          scope: 'item',
          index,
          sourceId: normalized.sourceId ?? null,
          error: 'Curator bench items must be self-contained primary roots, not unresolved children',
        },
      };
    }
  }

  return { ok: true, normalized };
}

export async function preflightCurateSubmitItemUrl(
  item: FeedInsertInput,
  index: number,
): Promise<{ ok: true } | { ok: false; error: SubmitError }> {
  return validateArticleUrl(item, index);
}

function getCachedTwitterPayloadForSubmitItem(item: FeedInsertInput): Record<string, unknown> | null {
  const normalizedSource = item.source?.trim().toLowerCase() ?? '';
  if (
    item.sourceId?.trim()
    && ['twitter', 'twitter.com', 'x', 'x.com'].includes(normalizedSource)
  ) {
    const exactCacheItem = getBrowseCacheItemByExactSourceId(
      'twitter',
      item.sourceId.trim(),
    );
    if (exactCacheItem) {
      return exactCacheItem.payload;
    }
  }

  const candidateTweetId = item.sourceId
    ? extractTweetIdFromStatusUrl(item.sourceId) ?? normalizeTweetSourceId(item.sourceId)
    : item.url
      ? extractTweetIdFromStatusUrl(item.url)
      : null;
  const normalizedCandidate = candidateTweetId && /^\d+$/.test(candidateTweetId)
    ? candidateTweetId
    : item.url
      ? extractTweetIdFromStatusUrl(item.url)
      : null;

  if (!normalizedCandidate || !/^\d+$/.test(normalizedCandidate)) {
    return null;
  }

  return getBrowseCacheItemByExactSourceId('twitter', normalizedCandidate)?.payload ?? null;
}

function canonicalizeTwitterItemForSubmit(
  item: FeedInsertInput,
  index: number,
): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError } {
  const result = canonicalizeTwitterFeedItemForSubmit(item, {
    cachedPayload: getCachedTwitterPayloadForSubmitItem(item),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId: result.sourceId,
        error: result.error,
      },
    };
  }

  return { ok: true, normalized: result.item };
}

async function normalizeFeedItemProvenance(
  item: FeedInsertInput,
  requestOriginSessionId: string | null,
  validationContext: OriginSessionValidationContext,
): Promise<{ ok: true; normalized: FeedInsertInput }> {
  const metadata = isRecord(item.metadata) ? { ...item.metadata } : {};
  const hasMetadataOriginSessionId = Object.prototype.hasOwnProperty.call(metadata, 'originSessionId');
  const metadataOriginSessionId = typeof metadata.originSessionId === 'string' && metadata.originSessionId.trim()
    ? metadata.originSessionId.trim()
    : null;
  const originKind = typeof metadata.originKind === 'string' && metadata.originKind.trim()
    ? metadata.originKind.trim().toLowerCase()
    : null;
  const effectiveOriginSessionId = typeof item.originSessionId === 'string' && item.originSessionId.trim()
    ? item.originSessionId.trim()
    : metadataOriginSessionId ?? requestOriginSessionId;
  const normalizedOriginSessionId = await normalizeOriginSessionId(effectiveOriginSessionId ?? null, validationContext);

  item.originSessionId = normalizedOriginSessionId;

  if (effectiveOriginSessionId || hasMetadataOriginSessionId || originKind) {
    item.metadata = {
      ...metadata,
      originSessionId: normalizedOriginSessionId,
      ...(originKind ? { originKind } : {}),
    };
  }

  return { ok: true, normalized: item };
}

async function postUnlocked(request: Request) {
  const requestReceivedAtMs = Date.now();
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isRecord(payload)) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  if (!Array.isArray(payload.items)) {
    return NextResponse.json({ error: 'Field "items" must be an array' }, { status: 400 });
  }

  if (payload.candidates !== undefined && !Array.isArray(payload.candidates)) {
    return NextResponse.json({ error: 'Field "candidates" must be an array when provided' }, { status: 400 });
  }

  const errors: SubmitError[] = [];
  const acceptedItems: FeedInsertInput[] = [];
  const acceptedFeedItems: FeedItem[] = [];
  const reactivatedFeedItems: FeedItem[] = [];
  const pendingNotificationReactivations = new Map<string, FeedItem>();
  const acceptedIds: string[] = [];
  const duplicateSourceIds = new Set<string>();
  const acceptedIdentifiers = new Map<string, string>();
  let hasStrictValidationError = false;
  const hasCycleSummaryInput = Object.prototype.hasOwnProperty.call(payload, 'cycleSummary');
  let duplicates = 0;
  const originSessionValidation: OriginSessionValidationContext = {
    openClawSessionChecks: new Map(),
  };
  const requestOriginSessionId = typeof payload.originSessionId === 'string' && payload.originSessionId.trim()
    ? payload.originSessionId.trim()
    : typeof payload.origin_session_id === 'string' && payload.origin_session_id.trim()
      ? payload.origin_session_id.trim()
      : typeof payload.originConversationId === 'string' && payload.originConversationId.trim()
        ? payload.originConversationId.trim()
        : typeof payload.origin_conversation_id === 'string' && payload.origin_conversation_id.trim()
          ? payload.origin_conversation_id.trim()
      : null;

  const pendingItems: Array<{
    index: number;
    normalized: FeedInsertInput;
    canonicalSourceId: string | null;
  }> = [];

  for (const [index, rawItem] of payload.items.entries()) {
    const preflight = preflightCurateSubmitItemShape(
      rawItem,
      index,
      requestReceivedAtMs,
      { requireInterest: hasCycleSummaryInput },
    );
    if (!preflight.ok) {
      if (preflight.strictCategory) hasStrictValidationError = true;
      errors.push(preflight.error);
      continue;
    }

    const normalized = preflight.normalized;
    if (Array.isArray(normalized.mediaUrls)) {
      const seenMediaUrls = new Set<string>();
      const mediaUrls: string[] = [];
      for (const url of normalized.mediaUrls) {
        const trimmedUrl = url.trim();
        if (!trimmedUrl || seenMediaUrls.has(trimmedUrl)) {
          continue;
        }
        seenMediaUrls.add(trimmedUrl);
        mediaUrls.push(trimmedUrl);
      }
      normalized.mediaUrls = mediaUrls;
    }
    const submittedLinkPreviews = normalized.metadata?.linkPreviews;
    if (Array.isArray(submittedLinkPreviews)) {
      const metadata = normalized.metadata ?? {};
      const seenLinkPreviewUrls = new Set<string>();
      const linkPreviews: LinkPreview[] = [];
      for (const preview of submittedLinkPreviews) {
        const trimmedUrl = preview.url.trim();
        if (!trimmedUrl || seenLinkPreviewUrls.has(trimmedUrl)) {
          continue;
        }
        seenLinkPreviewUrls.add(trimmedUrl);
        linkPreviews.push({
          ...preview,
          url: trimmedUrl,
        });
      }
      normalized.metadata = {
        ...metadata,
        linkPreviews,
      };
    }
    const normalizedProvenance = await normalizeFeedItemProvenance(
      normalized,
      requestOriginSessionId,
      originSessionValidation,
    );
    const normalizedWithProvenance = normalizedProvenance.normalized;
    const canonicalSourceId = normalizedWithProvenance.sourceId
      ? normalizedWithProvenance.type === 'tweet'
        ? normalizeTweetSourceId(normalizedWithProvenance.sourceId)
        : normalizeArticleSourceId(normalizedWithProvenance.sourceId)
      : null;
    if (canonicalSourceId) {
      normalizedWithProvenance.sourceId = canonicalSourceId;
    }

    // Source cancellation and notification submission share the feed mutation lock. Whichever
    // arrives first now closes the race: cancellation-first makes the late success a silent
    // duplicate, while notification-first lets cancellation find and dismiss the stored row.
    if (isCancelledSourceDiscoverySuccess(normalizedWithProvenance)) {
      duplicates += 1;
      if (canonicalSourceId) duplicateSourceIds.add(canonicalSourceId);
      continue;
    }

    if (canonicalSourceId) {
      const existing = getFeedItemBySourceId(canonicalSourceId);
      if (existing) {
        const incomingMetadata = normalizedWithProvenance.metadata;
        const existingMetadata = existing.metadata;
        const incomingIncidentKey = typeof incomingMetadata?.incidentKey === 'string'
          ? incomingMetadata.incidentKey.trim()
          : '';
        const existingIncidentKey = typeof existingMetadata?.incidentKey === 'string'
          ? existingMetadata.incidentKey.trim()
          : '';
        const incomingActionKind = typeof incomingMetadata?.userActionKind === 'string'
          ? incomingMetadata.userActionKind.trim()
          : '';
        const existingActionKind = typeof existingMetadata?.userActionKind === 'string'
          ? existingMetadata.userActionKind.trim()
          : '';
        const incomingNotificationId = typeof incomingMetadata?.notificationId === 'string'
          ? incomingMetadata.notificationId.trim()
          : '';
        const existingNotificationId = typeof existingMetadata?.notificationId === 'string'
          ? existingMetadata.notificationId.trim()
          : '';
        if (
          normalizedWithProvenance.type === 'notification'
          && normalizedWithProvenance.source === 'phone'
          && normalizedWithProvenance.metadata?.reactivateOnRepeat === true
          && existing.type === 'notification'
          && existing.source === 'phone'
          && existing.metadata?.reactivateOnRepeat === true
          && existing.suggestionStatus === 'dismissed'
          && recurringPhoneCapabilityActions.has(incomingActionKind)
          && incomingActionKind === existingActionKind
          && incomingIncidentKey.length > 0
          && incomingIncidentKey === existingIncidentKey
          && incomingNotificationId === canonicalSourceId
          && existingNotificationId === canonicalSourceId
        ) {
          pendingNotificationReactivations.set(existing.id, existing);
        }
        duplicates += 1;
        duplicateSourceIds.add(canonicalSourceId);
        continue;
      }
    }

    pendingItems.push({
      index,
      normalized: normalizedWithProvenance,
      canonicalSourceId,
    });
  }

  const articleUrlValidationResults = await Promise.all(
    pendingItems.map((pendingItem) => validateArticleUrl(pendingItem.normalized, pendingItem.index)),
  );
  const articleUrlValidationErrors = new Map<number, SubmitError>();
  for (const [resultIndex, result] of articleUrlValidationResults.entries()) {
    if (!result.ok) {
      const pendingItem = pendingItems[resultIndex];
      if (pendingItem) {
        articleUrlValidationErrors.set(pendingItem.index, result.error);
        errors.push(result.error);
      }
    }
  }

  const candidateEntries: CandidateLogEntry[] = [];
  for (const [index, candidate] of (payload.candidates ?? []).entries()) {
    const parsed = parseCandidateEntry(candidate, index);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    candidateEntries.push(parsed.entry);
  }

  const cycleSummary = parseCycleSummary(payload.cycleSummary);
  if (!cycleSummary.ok) {
    errors.push(cycleSummary.error);
  }

  const candidateLogEntries = cycleSummary.ok && cycleSummary.entry
    ? [...candidateEntries, cycleSummary.entry]
    : candidateEntries;
  const submittedCycleId = cycleSummary.ok ? cycleSummary.entry?.cycleId ?? null : null;
  const pendingCycleBeforeSubmit = hasCycleSummaryInput
    ? readPendingAutomatedCurationState(submittedCycleId)
    : null;
  const submittedCycleLog = hasCycleSummaryInput && submittedCycleId
    ? getCurationLogByRequestId(submittedCycleId)
    : null;
  const latestPendingAutomatedCycleId = hasCycleSummaryInput && !pendingCycleBeforeSubmit
    ? readLatestPendingAutomatedCurationCycleId()
    : null;
  if (latestPendingAutomatedCycleId && submittedCycleId) {
    errors.push({
      scope: 'cycleSummary',
      error: `cycleSummary.cycleId must match the pending automated cycle exactly; received "${submittedCycleId}"`,
    });
  } else if (submittedCycleLog?.completedAt) {
    errors.push({
      scope: 'cycleSummary',
      error: `cycleSummary.cycleId "${submittedCycleId}" is already terminal and cannot be reused`,
    });
  }
  if (pendingCycleBeforeSubmit && submittedCycleId) {
    for (const candidate of candidateEntries) {
      if (candidate.cycleId !== submittedCycleId) {
        errors.push({
          scope: 'candidate',
          sourceId: candidate.sourceId,
          error: `candidate.cycleId must exactly match terminal cycleSummary.cycleId "${submittedCycleId}"`,
        });
      }
    }
  }
  const isAutomatedCurationCompletionSubmit = Boolean(pendingCycleBeforeSubmit);

  const preflightAcceptedCount = pendingItems.filter(({ index }) => !articleUrlValidationErrors.has(index)).length;
  const preflightAssessment: AutomatedCompletionAssessment = hasCycleSummaryInput
    ? assessAutomatedCurationCompletion({
      acceptedCount: preflightAcceptedCount,
      duplicateCount: duplicates,
      cycleFeedDelta: pendingCycleBeforeSubmit?.feedDelta ?? 0,
      cycleSummary: cycleSummary.ok ? cycleSummary.entry : null,
      errors,
    })
    : { shouldComplete: false, completionStatus: null, completionReason: null, rejectedReason: null };

  if (preflightAssessment.rejectedReason) {
    try {
      await appendCurationCandidateEntries(candidateLogEntries);
    } catch (error) {
      errors.push({
        scope: 'system',
        error: error instanceof Error ? error.message : 'Failed to append curation candidate log entries',
      });
    }

    return NextResponse.json({
      accepted: 0,
      wouldAccept: preflightAcceptedCount,
      duplicates,
      errors,
      acceptedIds: [],
      completionDeferred: false,
      completionDeferredReason: null,
      completionRejected: true,
      completionRejectedReason: preflightAssessment.rejectedReason,
      duplicateSourceIds: Array.from(duplicateSourceIds),
    }, { status: 422 });
  }

  for (const { index, normalized, canonicalSourceId } of pendingItems) {
    if (articleUrlValidationErrors.has(index)) {
      continue;
    }

    const normalizedWithProvenance = normalized;

    if (normalizedWithProvenance.parentId) {
      const resolvedParentId = resolveParentIdForBatchInsert(normalizedWithProvenance.parentId, acceptedIdentifiers);
      if (!resolvedParentId) {
        errors.push({
          scope: 'item',
          index,
          sourceId: canonicalSourceId,
          error: `Unable to resolve parentId "${normalizedWithProvenance.parentId}"`,
        });
        continue;
      }
      normalizedWithProvenance.parentId = resolvedParentId;
    }

    const normalizedWithThreadColor = assignThreadColor(normalizedWithProvenance);
    const inserted = insertOrIgnoreFeedItem(normalizedWithThreadColor);
    if (!inserted) {
      if (canonicalSourceId) {
        duplicates += 1;
        duplicateSourceIds.add(canonicalSourceId);
      } else {
        errors.push({
          scope: 'item',
          index,
          sourceId: null,
          error: 'Insert was ignored for an unknown reason',
        });
      }
      continue;
    }

    const stored = normalizedWithProvenance.id ? getFeedItemById(normalizedWithProvenance.id) : null;
    if (!stored) {
      errors.push({
        scope: 'item',
        index,
        sourceId: canonicalSourceId,
        error: 'Inserted item could not be reloaded from the database',
      });
      continue;
    }

    acceptedItems.push(normalizedWithThreadColor);
    acceptedFeedItems.push(stored);
    acceptedIds.push(stored.id);
    rememberAcceptedIdentifiers(acceptedIdentifiers, normalizedWithThreadColor);

  }

  // Recurrence may undo a prior dismissal only after the entire one-off request is valid.
  // Automated cycle receipts never carry this authority, and a rejected/mixed request has no
  // notification-status side effect.
  if (
    !hasCycleSummaryInput
    && !hasStrictValidationError
    && errors.length === 0
  ) {
    for (const existing of pendingNotificationReactivations.values()) {
      setFeedItemSuggestionStatus(existing.id, 'pending');
      const reactivated = getFeedItemById(existing.id);
      if (reactivated) reactivatedFeedItems.push(reactivated);
    }
  }

  try {
    await appendAcceptedFeedItems(acceptedItems);
  } catch (error) {
    errors.push({
      scope: 'system',
      error: error instanceof Error ? error.message : 'Failed to append accepted feed items to JSONL',
    });
  }

  for (const acceptedFeedItem of acceptedFeedItems) {
    if (!acceptedFeedItem.id) {
      continue;
    }

    applyCachedItemEnrichment(acceptedFeedItem);
  }

  let notificationItems = [
    ...acceptedFeedItems.map((acceptedFeedItem) => (
      acceptedFeedItem.id ? getFeedItemById(acceptedFeedItem.id) ?? acceptedFeedItem : acceptedFeedItem
    )),
    ...reactivatedFeedItems,
  ];
  const shouldSkipBulkEnrichment = isPhoneRuntime() || readUsageLevelConfig().level === 'low';
  const acceptedEnrichmentTargets = shouldSkipBulkEnrichment
    ? []
    : notificationItems.filter((acceptedFeedItem) => (
      Boolean(acceptedFeedItem.id)
      && !acceptedFeedItem.parentId
      && (acceptedFeedItem.type === 'tweet' || acceptedFeedItem.source === 'hackernews')
      && itemIsStillIncomplete(acceptedFeedItem)
      // Freshness-fallback items are already display-ready (tweet text / HN synopsis in hand). Bulk
      // enrichment spawns a codex/claude agent per batch — slow AND memory-hungry (the OOM cause)
      // — and it BLOCKS the submit response (await queueBatchEnrichment). Skipping it for fallback
      // items keeps promotion bounded and safe under memory pressure.
      && (acceptedFeedItem.metadata as Record<string, unknown> | null)?.freshnessFloor !== true
    ));

  if (acceptedEnrichmentTargets.length > 0) {
    try {
      const chunks: FeedItem[][] = [];
      for (let index = 0; index < acceptedEnrichmentTargets.length; index += maxBatchEnrichmentChunkSize) {
        chunks.push(acceptedEnrichmentTargets.slice(index, index + maxBatchEnrichmentChunkSize));
      }

      for (const [chunkIndex, chunk] of chunks.entries()) {
        const firstTargetId = chunk[0]?.id ?? 'unknown';
        const requestId = [
          'curation-submit-enrichment-batch',
          firstTargetId,
          acceptedEnrichmentTargets.length,
          `chunk-${chunkIndex + 1}-of-${chunks.length}`,
        ].join('-');
        const result = await queueBatchEnrichment(chunk, {
          endpoint: '/api/internal/curate/submit',
          requestId,
          routeId: firstTargetId,
          source: 'curation_submit_feed_enrichment',
          trigger: 'curation_submit_batch',
        });

        if (!result.ok) {
          errors.push({
            scope: 'system',
            error: result.error ?? 'Failed to queue batch enrichment task',
          });
        }
      }
    } catch (error) {
      errors.push({
        scope: 'system',
        error: error instanceof Error
          ? error.message
          : 'Failed to queue batch enrichment task',
      });
    }
  }

  notificationItems = [
    ...acceptedFeedItems.map((acceptedFeedItem) => (
      acceptedFeedItem.id ? getFeedItemById(acceptedFeedItem.id) ?? acceptedFeedItem : acceptedFeedItem
    )),
    ...reactivatedFeedItems.map((reactivatedFeedItem) => (
      getFeedItemById(reactivatedFeedItem.id) ?? reactivatedFeedItem
    )),
  ];

  try {
    await notifyFeedUpdate(notificationItems);
  } catch (error) {
    errors.push({
      scope: 'system',
      error: error instanceof Error ? error.message : 'Failed to notify websocket clients',
    });
  }

  try {
    await notifyChatSuggestionEvents(buildAcceptedCodeFixChatSuggestionEvents(notificationItems));
  } catch (error) {
    errors.push({
      scope: 'system',
      error: error instanceof Error ? error.message : 'Failed to notify chat suggestion websocket clients',
    });
  }

  try {
    await appendCurationCandidateEntries(candidateLogEntries);
  } catch (error) {
    errors.push({
      scope: 'system',
      error: error instanceof Error ? error.message : 'Failed to append curation candidate log entries',
    });
  }

  const completionCandidate = acceptedIds.length > 0
    || duplicates > 0
    || (cycleSummary.ok && cycleSummary.entry && errors.length === 0);
  const pendingAutomatedCurationState = completionCandidate
    ? pendingCycleBeforeSubmit
    : null;
  const automatedCompletionAssessment: AutomatedCompletionAssessment = hasCycleSummaryInput
    ? assessAutomatedCurationCompletion({
      acceptedCount: acceptedIds.length,
      duplicateCount: duplicates,
      // Use the durable delta observed before this terminal call. The current
      // call's accepted rows are counted separately above; reading the delta
      // again after insertion would double-count them.
      cycleFeedDelta: pendingCycleBeforeSubmit?.feedDelta ?? 0,
      cycleSummary: cycleSummary.ok ? cycleSummary.entry : null,
      errors,
    })
    : { shouldComplete: true, completionStatus: acceptedIds.length > 0 ? 'success' : 'successful_empty', completionReason: null, rejectedReason: null };
  const shouldCompletePendingAutomatedCuration = completionCandidate
    && isAutomatedCurationCompletionSubmit
    && automatedCompletionAssessment.shouldComplete;
  const completionDeferred = completionCandidate
    && isAutomatedCurationCompletionSubmit
    && !automatedCompletionAssessment.shouldComplete;
  const completionDeferredReason = completionDeferred
    ? 'automated curation remains pending until an error-free cycleSummary receipt with complete evidence is submitted'
    : null;

  if (shouldCompletePendingAutomatedCuration && pendingAutomatedCurationState) {
    const completionStatus: CurationLogCompletionStatus = automatedCompletionAssessment.completionStatus
      ?? (acceptedIds.length > 0 ? 'success' : 'successful_empty');
    completeCurationLogByRequestId(pendingAutomatedCurationState.requestId, {
      itemsAdded: pendingAutomatedCurationState.feedDelta + acceptedIds.length,
      completionStatus,
      completionReason: automatedCompletionAssessment.completionReason
        ?? (acceptedIds.length > 0
          ? `curate-submit accepted ${acceptedIds.length} item${acceptedIds.length === 1 ? '' : 's'}`
          : (pendingAutomatedCurationState?.feedDelta ?? 0) > 0
            ? `terminal receipt confirmed ${pendingAutomatedCurationState?.feedDelta} item${pendingAutomatedCurationState?.feedDelta === 1 ? '' : 's'} persisted across the cycle`
            : 'curate-submit completed without new feed items'),
    });
  }

  if (hasCycleSummaryInput || shouldCompletePendingAutomatedCuration) {
    try {
      const acceptedTypeCounts: Record<string, number> = {};
      for (const id of acceptedIds) {
        const storedRow = getFeedItemById(id);
        if (storedRow?.type) acceptedTypeCounts[storedRow.type] = (acceptedTypeCounts[storedRow.type] ?? 0) + 1;
      }
      const cycleIdForArtifact = (cycleSummary.ok && cycleSummary.entry?.cycleId
        ? cycleSummary.entry.cycleId
        : `submit-${requestReceivedAtMs}`).replace(/[^a-zA-Z0-9_-]/g, '');
      const artifactDir = path.join(process.cwd(), 'data', 'tmp');
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, `curate-cycle-summary-${cycleIdForArtifact}.json`), JSON.stringify({
        receivedAt: new Date(requestReceivedAtMs).toISOString(),
        accepted: acceptedIds.length,
        duplicates,
        acceptedTypeCounts,
        completionStatus: automatedCompletionAssessment.completionStatus,
        cycleSummary: cycleSummary.ok ? cycleSummary.entry : null,
      }, null, 2));
    } catch {
      // best-effort audit artifact; never block a submit on it
    }
  }

  return NextResponse.json({
    accepted: acceptedIds.length,
    reactivated: reactivatedFeedItems.length,
    duplicates,
    errors,
    acceptedIds,
    completionDeferred,
    completionDeferredReason,
    completionRejected: Boolean(automatedCompletionAssessment.rejectedReason),
    completionRejectedReason: automatedCompletionAssessment.rejectedReason,
    duplicateSourceIds: Array.from(duplicateSourceIds),
  }, {
    status: hasStrictValidationError ? 400 : 200,
  });
}

export async function POST(request: Request) {
  return withFeedMutationLock(() => postUnlocked(request));
}
