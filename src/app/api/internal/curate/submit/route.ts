import { NextResponse } from 'next/server';
import {
  allowedFeedTypes,
  getFeedItemById,
  getFeedItemBySourceId,
  insertOrIgnoreFeedItem,
  normalizeArticleSourceId,
  normalizeFeedInput,
  normalizeType,
  normalizeTweetSourceId,
} from '@/lib/db/feed';
import { getDb } from '@/lib/db/client';
import { getDataPath } from '@/lib/data-dir';
import {
  appendAcceptedFeedItems,
  appendCurationCandidateEntries,
  notifyFeedUpdate,
  rememberAcceptedIdentifiers,
  resolveParentIdForBatchInsert,
} from '@/lib/curation-submit';
import {
  applyCachedItemEnrichment,
  queueBatchEnrichment,
} from '@/lib/feed-enrichment';
import { getBrowseCacheItemByExactSourceId } from '@/lib/db/browse-cache';
import { validateFeedProminenceInput } from '@/lib/feed-prominence';
import {
  getYouTubeCanonicalSourceFields,
  isYouTubeSource,
} from '@/lib/youtube-feed';
import { validateArticlePublishEvidence } from '@/lib/article-publish-evidence';
import {
  canonicalizeTwitterFeedItemForSubmit,
  extractTweetIdFromStatusUrl,
} from '@/lib/twitter-feed-canonicalization';
import { listOpenClawSessions } from '@/lib/openclaw/sessions';
import { pickNextThreadColor, sanitizeThreadColor } from '@/lib/thread-colors';
import { readUsageLevelConfig } from '@/lib/usage-level';
import type { FeedInsertInput } from '@/lib/db/feed';
import type { FeedItem, LinkPreview } from '@/types/feed';
import { readBrainConfig } from '../../../../../../lib/brain-config.js';

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
const openClawMcpAppHtmlError = 'openclaw cards must include metadata.mcpAppHtml — markdown-only openclaw submissions are no longer accepted';
const evogentSkillSourceIdPrefix = 'evogent-skill:';
const openClawSessionPrefix = 'openclaw:';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

type OpenClawSessionListResult = {
  sessions?: Array<{
    key?: unknown;
    sessionId?: unknown;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

async function hasExistingOpenClawSessionId(
  originSessionId: string,
  validationContext: OriginSessionValidationContext,
): Promise<boolean> {
  if (!originSessionId.startsWith(openClawSessionPrefix)) {
    return false;
  }

  const sessionKey = originSessionId.slice(openClawSessionPrefix.length).trim();
  if (!sessionKey) {
    return false;
  }

  const existingCheck = validationContext.openClawSessionChecks.get(originSessionId);
  if (existingCheck) {
    return existingCheck;
  }

  const check = (async () => {
    try {
      const result = await listOpenClawSessions({ includeSessionKey: sessionKey }) as OpenClawSessionListResult;
      return Array.isArray(result.sessions)
        && result.sessions.some((session) => (
          session.sessionId === originSessionId
          || session.key === sessionKey
        ));
    } catch {
      return false;
    }
  })();

  validationContext.openClawSessionChecks.set(originSessionId, check);
  return check;
}

async function normalizeOriginSessionId(
  originSessionId: string | null,
  validationContext: OriginSessionValidationContext,
): Promise<string | null> {
  if (!originSessionId) {
    return null;
  }

  if (hasExistingChatSessionId(originSessionId)) {
    return originSessionId;
  }

  if (await hasExistingOpenClawSessionId(originSessionId, validationContext)) {
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

function assignThreadColor(item: FeedInsertInput): FeedInsertInput {
  const metadata = isRecord(item.metadata) ? item.metadata : null;
  const thread = metadata && isRecord(metadata.thread) ? metadata.thread : null;
  const threadId = typeof thread?.threadId === 'string' && thread.threadId.trim()
    ? thread.threadId.trim()
    : null;
  if (!metadata || !thread || !threadId) {
    return item;
  }

  const color = ensureThreadColor(threadId);
  item.metadata = {
    ...metadata,
    thread: {
      ...thread,
      threadId,
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

  const counts = ['considered', 'selected', 'rejected'] as const;
  const parsedCounts = Object.fromEntries(counts.map((field) => {
    const rawValue = input[field];
    const normalized = typeof rawValue === 'number' && Number.isFinite(rawValue)
      ? Math.max(0, Math.floor(rawValue))
      : Number.NaN;
    return [field, normalized];
  })) as Record<(typeof counts)[number], number>;

  const invalidCountField = counts.find((field) => !Number.isFinite(parsedCounts[field]));
  if (invalidCountField) {
    return {
      ok: false,
      error: { scope: 'cycleSummary', error: `Field "${invalidCountField}" must be a finite number` },
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

  return {
    ok: true,
    entry: {
      cycleId: cycleId.value,
      type: 'cycle_summary',
      considered: parsedCounts.considered,
      selected: parsedCounts.selected,
      rejected: parsedCounts.rejected,
      topRejectionReasons: input.topRejectionReasons.map((entry) => entry.trim()).filter(Boolean),
      ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
      timestamp: new Date().toISOString(),
    },
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
  const response = await fetch(notifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (!response.ok) {
    throw new Error(`Chat notify failed (${response.status})`);
  }
}

function parseFeedInsertInput(input: unknown, index: number): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { scope: 'item', index, error: 'Item must be a JSON object' },
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
          sourceId: typeof input.sourceId === 'string' ? input.sourceId : typeof input.source_id === 'string' ? input.source_id : null,
          error: prominenceError,
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
          sourceId: typeof input.sourceId === 'string' ? input.sourceId : typeof input.source_id === 'string' ? input.source_id : null,
          error: prominenceError,
        },
      };
    }
  }

  const publishedAtRaw = input.publishedAt ?? input.published_at;
  const publishedAt = parseIso8601Timestamp(publishedAtRaw, 'publishedAt');
  if (!publishedAt.ok) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId: typeof input.sourceId === 'string' ? input.sourceId : typeof input.source_id === 'string' ? input.source_id : null,
        error: publishedAt.error,
      },
    };
  }

  const normalizedType = normalizeType(input.type);
  if (!normalizedType) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId: typeof input.sourceId === 'string' ? input.sourceId : typeof input.source_id === 'string' ? input.source_id : null,
        error: buildInvalidTypeMessage(typeof input.type === 'string' ? input.type.trim() || String(input.type) : String(input.type)),
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

  if (
    normalized.source == null
    && normalized.metadata?.source === 'chat-curator'
  ) {
    normalized.source = 'openclaw';
  }

  return { ok: true, normalized };
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

  if (!suggestionType || suggestionType === 'code_fix') {
    return { ok: true, normalized: item };
  }

  return {
    ok: false,
    error: {
      scope: 'item',
      index,
      sourceId: item.sourceId ?? null,
      error: 'All suggestions must use suggestionType "code_fix".',
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

function validateArticleBody(
  item: FeedInsertInput,
  index: number,
): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError } {
  if (item.type !== 'article') {
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), articleUrlValidationTimeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': articleUrlValidationUserAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (response.status >= 400 && response.status < 500 && !nonTerminalArticleStatusCodes.has(response.status)) {
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
      const contentType = response.headers.get('content-type') ?? '';
      const normalizedContentType = contentType.toLowerCase();
      if (!normalizedContentType || normalizedContentType.includes('html') || normalizedContentType.includes('xml')) {
        const html = await response.text();
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
    console.warn('[curate-submit] allowing article after transient URL validation failure', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }

  return { ok: true };
}

function getCachedTwitterPayloadForSubmitItem(item: FeedInsertInput): Record<string, unknown> | null {
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

function readOpenClawBundleDir(metadata: FeedInsertInput['metadata'] | undefined): string | null {
  if (!isRecord(metadata) || !isRecord(metadata.openClaw)) {
    return null;
  }

  const bundleDir = typeof metadata.openClaw.bundleDir === 'string'
    ? metadata.openClaw.bundleDir.trim()
    : '';
  if (!bundleDir) {
    return null;
  }

  return bundleDir.replace(/\/+$/, '') || bundleDir;
}

function readEvogentSkillSourceId(sourceId: string | null): string | null {
  const trimmed = typeof sourceId === 'string' ? sourceId.trim() : '';
  return trimmed.startsWith(evogentSkillSourceIdPrefix) ? trimmed : null;
}

function getExistingOpenClawSkillDuplicateKey(
  item: FeedInsertInput,
  canonicalSourceId: string | null,
): string | null {
  const skillSourceId = readEvogentSkillSourceId(canonicalSourceId);
  const bundleDir = readOpenClawBundleDir(item.metadata);
  if (!skillSourceId && !bundleDir) {
    return null;
  }

  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (skillSourceId) {
    clauses.push('source_id = @skillSourceId');
    params.skillSourceId = skillSourceId;
  }
  if (bundleDir) {
    clauses.push("rtrim(json_extract(metadata, '$.openClaw.bundleDir'), '/') = @bundleDir");
    params.bundleDir = bundleDir;
  }

  const row = getDb().prepare(`
    SELECT
      source_id AS sourceId,
      rtrim(json_extract(metadata, '$.openClaw.bundleDir'), '/') AS bundleDir
    FROM feed
    WHERE ${clauses.join(' OR ')}
    ORDER BY created_at_ms DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(params) as { sourceId: string | null; bundleDir: string | null } | undefined;

  if (!row) {
    return null;
  }

  if (skillSourceId && row.sourceId === skillSourceId) {
    return skillSourceId;
  }
  if (bundleDir && row.bundleDir === bundleDir) {
    return `openclaw-bundle:${bundleDir}`;
  }

  return skillSourceId ?? `openclaw-bundle:${bundleDir}`;
}

export async function POST(request: Request) {
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
  const acceptedIds: string[] = [];
  const duplicateSourceIds = new Set<string>();
  const acceptedIdentifiers = new Map<string, string>();
  let hasArticleBodyValidationError = false;
  let hasOpenClawMcpAppHtmlValidationError = false;
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
    const parsed = parseFeedInsertInput(rawItem, index);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }

    const canonicalizedTwitter = canonicalizeTwitterItemForSubmit(parsed.normalized, index);
    if (!canonicalizedTwitter.ok) {
      errors.push(canonicalizedTwitter.error);
      continue;
    }

    const validatedPublishEvidence = validatePublishEvidence(canonicalizedTwitter.normalized, index);
    if (!validatedPublishEvidence.ok) {
      errors.push(validatedPublishEvidence.error);
      continue;
    }

    const validatedSuggestion = validateSuggestionIntegrity(validatedPublishEvidence.normalized, index);
    if (!validatedSuggestion.ok) {
      errors.push(validatedSuggestion.error);
      continue;
    }

    const validatedYouTube = validateValidatedYouTubeItem(validatedSuggestion.normalized, index);
    if (!validatedYouTube.ok) {
      errors.push(validatedYouTube.error);
      continue;
    }

    const validatedArticleBody = validateArticleBody(validatedYouTube.normalized, index);
    if (!validatedArticleBody.ok) {
      errors.push(validatedArticleBody.error);
      hasArticleBodyValidationError = true;
      continue;
    }

    const normalized = validatedArticleBody.normalized;
    const openClawMetadataSource = typeof normalized.metadata?.source === 'string'
      ? normalized.metadata.source.trim().toLowerCase()
      : '';
    const openClawMcpAppHtml = normalized.metadata?.mcpAppHtml;
    if (
      normalized.source === 'openclaw'
      && openClawMetadataSource !== 'chat-curator'
      && (typeof openClawMcpAppHtml !== 'string' || !openClawMcpAppHtml.trim())
    ) {
      errors.push({
        scope: 'item',
        index,
        sourceId: normalized.sourceId ?? null,
        error: openClawMcpAppHtmlError,
      });
      hasOpenClawMcpAppHtmlValidationError = true;
      continue;
    }

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

    if (canonicalSourceId) {
      const existing = getFeedItemBySourceId(canonicalSourceId);
      if (existing) {
        duplicates += 1;
        duplicateSourceIds.add(canonicalSourceId);
        continue;
      }
    }

    const openClawSkillDuplicateKey = getExistingOpenClawSkillDuplicateKey(normalizedWithProvenance, canonicalSourceId);
    if (openClawSkillDuplicateKey) {
      duplicates += 1;
      duplicateSourceIds.add(openClawSkillDuplicateKey);
      continue;
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

    const openClawSkillDuplicateKey = getExistingOpenClawSkillDuplicateKey(normalizedWithProvenance, canonicalSourceId);
    if (openClawSkillDuplicateKey) {
      duplicates += 1;
      duplicateSourceIds.add(openClawSkillDuplicateKey);
      continue;
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

  let notificationItems = acceptedFeedItems.map((acceptedFeedItem) => (
    acceptedFeedItem.id ? getFeedItemById(acceptedFeedItem.id) ?? acceptedFeedItem : acceptedFeedItem
  ));
  const acceptedEnrichmentTargets = notificationItems.filter((acceptedFeedItem) => (
    Boolean(acceptedFeedItem.id)
    && !acceptedFeedItem.parentId
    && (acceptedFeedItem.type === 'tweet' || acceptedFeedItem.source === 'hackernews')
  ));

  const brainConfig = readBrainConfig(getDataPath('config.md'));
  const usageLevelConfig = readUsageLevelConfig();
  const shouldSkipBulkEnrichment = usageLevelConfig.level === 'low';

  if (acceptedEnrichmentTargets.length > 0 && !shouldSkipBulkEnrichment) {
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

  notificationItems = acceptedFeedItems.map((acceptedFeedItem) => (
    acceptedFeedItem.id ? getFeedItemById(acceptedFeedItem.id) ?? acceptedFeedItem : acceptedFeedItem
  ));

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

  try {
    await appendCurationCandidateEntries(candidateLogEntries);
  } catch (error) {
    errors.push({
      scope: 'system',
      error: error instanceof Error ? error.message : 'Failed to append curation candidate log entries',
    });
  }

  return NextResponse.json({
    accepted: acceptedIds.length,
    duplicates,
    errors,
    acceptedIds,
    duplicateSourceIds: Array.from(duplicateSourceIds),
  }, {
    status: hasArticleBodyValidationError || hasOpenClawMcpAppHtmlValidationError ? 400 : 200,
  });
}
