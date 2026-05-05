import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentManager } from '@/lib/agent-manager';
import { getDataPath } from '@/lib/data-dir';
import {
  getBrowseCacheItemByExactSourceId,
  getLatestCachedTweetAuthorFacts,
  type BrowseCacheItemRecord,
} from '@/lib/db/browse-cache';
import {
  getFeedItemById,
  getFeedItemBySourceId,
  insertOrIgnoreFeedItem,
  resolveFeedItemByIdentifier,
  updateFeedItemFields,
  type FeedInsertInput,
  type FeedItemPatchInput,
} from '@/lib/db/feed';
import {
  buildBatchEnrichmentPrompt,
  buildEnrichmentPrompt,
  resolveFeedItemTweetId,
  type EnrichmentPromptMode,
} from '@/lib/feed-enrichment-prompt';
import { enqueueOrchestratorMessage, getOrchestratorStatus } from '@/lib/orchestrator';
import { readUsageLevelConfig } from '@/lib/usage-level';
import {
  buildYouTubeFeedMetadata,
  getYouTubeFeedData,
} from '@/lib/youtube-feed';
import type { FeedItem, FeedItemType, FeedRelationship } from '@/types/feed';

const backgroundJobsDisabled = process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS === '1';

interface EnrichmentJobState {
  agentId: string;
  startedAt: string;
}

interface QueueFeedItemEnrichmentOptions {
  endpoint?: string;
  routeId?: string;
  requestId?: string;
  source?: string;
  trigger?: string;
  mode?: EnrichmentPromptMode;
  tracking?: 'automatic' | 'full';
}

interface QueueFeedItemEnrichmentResult {
  ok: boolean;
  alreadyRequested?: boolean;
  alreadyRunning: boolean;
  postId: string;
  requestId?: string;
  requestedAt?: string;
  queueDepth?: number;
  error?: string;
  agent?: {
    id: string;
    status: string;
  };
}

interface QueueBatchEnrichmentOptions {
  endpoint?: string;
  routeId?: string;
  requestId?: string;
  source?: string;
  trigger?: string;
}

interface QueueBatchEnrichmentResult {
  ok: boolean;
  alreadyRunning: boolean;
  postIds: string[];
  requestId?: string;
  requestedAt?: string;
  queueDepth?: number;
  error?: string;
  agent?: {
    id: string;
    status: string;
  };
}

const globalForEnrichment = globalThis as typeof globalThis & {
  __postEnrichmentJobs?: Map<string, EnrichmentJobState>;
};

const postEnrichmentJobs = globalForEnrichment.__postEnrichmentJobs ?? new Map<string, EnrichmentJobState>();

if (!globalForEnrichment.__postEnrichmentJobs) {
  globalForEnrichment.__postEnrichmentJobs = postEnrichmentJobs;
}

function getFullEnrichmentRequestId(item: FeedItem): string | null {
  return typeof item.metadata?.fullEnrichmentRequestId === 'string' && item.metadata.fullEnrichmentRequestId.trim().length > 0
    ? item.metadata.fullEnrichmentRequestId.trim()
    : null;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isBlank(value: string | null | undefined): boolean {
  return !trimToNull(value);
}

function hasCommunityNotePayload(input: unknown): boolean {
  if (typeof input === 'string') {
    return input.trim().length > 0;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }
  const raw = input as Record<string, unknown>;
  const note = raw.communityNote ?? raw.community_note;
  if (typeof note === 'string') {
    return note.trim().length > 0;
  }
  if (!note || typeof note !== 'object' || Array.isArray(note)) {
    return false;
  }
  const noteRaw = note as Record<string, unknown>;
  return [
    noteRaw.text,
    noteRaw.noteText,
    noteRaw.note_text,
    noteRaw.body,
    noteRaw.context,
  ].some((value) => typeof value === 'string' && value.trim().length > 0);
}

function storeFullEnrichmentRequestId(postId: string, requestId: string) {
  updateFeedItemFields(postId, {
    metadata: {
      fullEnrichmentRequestId: requestId,
    },
  });
}

function storeBatchEnrichmentAssociation(
  items: FeedItem[],
  requestId: string,
  status: 'queued' | 'running' = 'queued',
  timeoutMs?: number,
) {
  const queuedAt = new Date().toISOString();
  const deadlineAt = Number.isFinite(timeoutMs) && typeof timeoutMs === 'number' && timeoutMs > 0
    ? new Date(Date.now() + timeoutMs).toISOString()
    : undefined;
  const itemCount = items.length;

  for (const [index, item] of items.entries()) {
    updateFeedItemFields(item.id, {
      metadata: {
        batchEnrichment: {
          requestId,
          status,
          queuedAt,
          ...(status === 'running' ? { startedAt: queuedAt } : {}),
          ...(deadlineAt ? { deadlineAt } : {}),
          itemIndex: index,
          itemCount,
          retryEligible: true,
        },
      },
    });
  }
}

async function spawnEnrichmentAgent(prompt: string, timeoutMs = 15 * 60 * 1000) {
  const usageLevelConfig = readUsageLevelConfig();

  return agentManager.spawnAgent({
    type: 'enrichment',
    prompt,
    options: {
      cwd: process.cwd(),
      timeoutMs,
      model: usageLevelConfig.enrichmentModel,
    },
  });
}

async function getTaskStatus(taskId: string) {
  const agentStatus = agentManager.getAgentStatus(taskId);
  if (agentStatus) {
    return agentStatus;
  }

  const orchestratorStatus = await getOrchestratorStatus().catch(() => null);
  if (!orchestratorStatus) {
    return null;
  }

  const tasks = [
    orchestratorStatus.currentTask,
    ...(Array.isArray(orchestratorStatus.queued) ? orchestratorStatus.queued : []),
    ...(Array.isArray(orchestratorStatus.history) ? orchestratorStatus.history : []),
  ];
  const match = tasks.find((task) => task && typeof task === 'object' && task.id === taskId);
  if (!match) {
    return null;
  }

  return {
    id: taskId,
    status: match.state === 'failed'
      ? 'failed'
      : match.state === 'completed'
        ? 'completed'
        : 'running',
  };
}

async function getRunningEnrichment(postId: string, requestId?: string | null) {
  const candidateIds = Array.from(new Set([
    requestId ?? null,
    postEnrichmentJobs.get(postId)?.agentId ?? null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)));

  for (const candidateId of candidateIds) {
    const status = await getTaskStatus(candidateId);
    if (status?.status === 'running') {
      postEnrichmentJobs.set(postId, {
        agentId: candidateId,
        startedAt: new Date().toISOString(),
      });
      return status;
    }
  }

  postEnrichmentJobs.delete(postId);
  return null;
}

function resolveFeedItem(input: FeedItem | string) {
  if (typeof input === 'string') {
    return resolveFeedItemByIdentifier(input);
  }

  return input;
}

function resolveBatchEnrichmentTimeoutMs(itemCount: number): number {
  const perItemMs = 60_000;
  const bufferMs = 2 * 60 * 1000;
  const maxMs = 30 * 60 * 1000;
  return Math.min(maxMs, Math.max(bufferMs, (perItemMs * itemCount) + bufferMs));
}

export function shouldAutoQueueFeedItemEnrichment(item: FeedItem): boolean {
  if (item.parentId) return false;
  if (item.type === 'tweet') return true;
  return item.type === 'article' && Boolean(trimToNull(item.url));
}

type MergeMode = 'fillIfBlank' | 'append-dedupe' | 'deepMerge' | 'fillIfZero';
type SchemaPath = string;
type FeedPatchField = keyof FeedItemPatchInput | `metadata.${string}`;
type ConverterName = keyof typeof feedEnrichmentConverters;

interface ConverterContext {
  cacheItem: BrowseCacheItemRecord;
  payload: Record<string, unknown>;
}

interface FieldMapping {
  feedField: FeedPatchField;
  source: SchemaPath;
  converter?: ConverterName;
  mergeMode?: MergeMode;
}

interface ReferenceField {
  field: SchemaPath;
  relationship: FeedRelationship;
  source?: string;
  converter?: ConverterName;
}

interface SourceConfig {
  feedType: FeedItemType;
  payloadSchema: z.ZodType<Record<string, unknown>>;
  fieldMappings: FieldMapping[];
  referenceFields: ReferenceField[];
}

interface ApplyCachedItemEnrichmentOptions {
  followReferences?: boolean;
  maxReferenceDepth?: number;
}

const unknownRecordSchema = z.record(z.string(), z.unknown());
const optionalStringishSchema = z.union([z.string(), z.number()]).nullish();
const optionalRecordSchema = unknownRecordSchema.nullish();
const optionalRecordArraySchema = z.array(unknownRecordSchema).nullish();

const twitterPayloadSchema = z.object({
  sourceId: optionalStringishSchema,
  tweetId: optionalStringishSchema,
  id: optionalStringishSchema,
  url: z.string().nullish(),
  title: z.string().nullish(),
  text: z.string().nullish(),
  authorUsername: z.string().nullish(),
  authorDisplayName: z.string().nullish(),
  authorAvatarUrl: z.string().nullish(),
  publishedAt: z.string().nullish(),
  publishedAtMs: z.number().nullish(),
  metrics: optionalRecordSchema,
  media: optionalRecordArraySchema,
  mediaUrls: z.array(z.string()).nullish(),
  quotedTweet: optionalRecordSchema,
  inReplyToStatusId: optionalStringishSchema,
  inReplyTo: optionalRecordSchema,
  replyingTo: optionalRecordSchema,
  communityNote: z.unknown().nullish(),
  community_note: z.unknown().nullish(),
  linkCard: optionalRecordSchema,
  poll: optionalRecordSchema,
  linkPreviews: optionalRecordArraySchema,
  urlEntities: optionalRecordArraySchema,
  raw_data: optionalRecordSchema,
}).passthrough();

const hackerNewsPayloadSchema = z.object({
  id: optionalStringishSchema,
  by: z.string().nullish(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  score: z.number().nullish(),
  descendants: z.number().nullish(),
  time: z.number().nullish(),
  text: z.string().nullish(),
  hnUrl: z.string().nullish(),
}).passthrough();

const substackPayloadSchema = z.object({
  url: z.string().nullish(),
  host: z.string().nullish(),
  title: z.string().nullish(),
  publicationName: z.string().nullish(),
  author: z.string().nullish(),
  authorDisplayName: z.string().nullish(),
  authorUsername: z.string().nullish(),
  summary: z.string().nullish(),
  text: z.string().nullish(),
  excerpt: z.string().nullish(),
  publishedAtMs: z.number().nullish(),
  readingMeta: z.string().nullish(),
  discoverySurface: z.string().nullish(),
  imageUrl: z.string().nullish(),
  mediaUrls: z.array(z.string()).nullish(),
}).passthrough();

const youtubePayloadSchema = z.object({
  videoId: z.string().nullish(),
  canonicalUrl: z.string().nullish(),
  title: z.string().nullish(),
  channelName: z.string().nullish(),
  channelUrl: z.string().nullish(),
  channelHandle: z.string().nullish(),
  publishDate: z.string().nullish(),
  publishDateText: z.string().nullish(),
  thumbnailUrl: z.string().nullish(),
  duration: z.string().nullish(),
  durationSeconds: z.number().nullish(),
  viewCount: z.number().nullish(),
  viewCountLabel: z.string().nullish(),
  sourceKind: z.string().nullish(),
  sourceKinds: z.array(z.string()).nullish(),
}).passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimUnknownToNull(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  return trimToNull(value);
}

function trimFirstUnknownToNull(...values: unknown[]): string | null {
  for (const value of values) {
    const trimmed = trimUnknownToNull(value);
    if (trimmed) return trimmed;
  }
  return null;
}

function readPath(context: ConverterContext, path: SchemaPath): unknown {
  if (path === '$') return context.payload;
  if (path === '$cache') return context.cacheItem;

  const root = path.startsWith('cache.') ? context.cacheItem as unknown : context.payload as unknown;
  const segments = path.startsWith('cache.')
    ? path.slice('cache.'.length).split('.')
    : path.split('.');
  let current = root;

  for (const segment of segments) {
    if (!segment) continue;
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }

  return current;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.replace(/,/g, '').trim())
      : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function parseShortNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value !== 'string') return null;

  const normalized = value.trim().replace(/,/g, '');
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i)
    ?? normalized.match(/(\d+(?:\.\d+)?)\s*([kmb])?\s+(?:views?|likes?|reposts?|retweets?|replies?|comments?|points?)/i);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'b' ? 1_000_000_000 : suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  return Math.max(0, Math.floor(base * multiplier));
}

function normalizeStringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = trimUnknownToNull(value);
    return single ? [single] : [];
  }
  return value.map(trimUnknownToNull).filter((entry): entry is string => Boolean(entry));
}

function mergeStringArrays(existing: unknown, incoming: unknown): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const entry of [...normalizeStringArrayValue(existing), ...normalizeStringArrayValue(incoming)]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }

  return merged;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
}

function mergeRecordArrays(existing: unknown, incoming: unknown): Record<string, unknown>[] {
  const merged: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const entry of [...recordArray(existing), ...recordArray(incoming)]) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function mergeRecordsPreferExisting(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incoming };

  for (const [key, existingValue] of Object.entries(existing)) {
    const incomingValue = merged[key];
    if (isRecord(existingValue) && isRecord(incomingValue)) {
      merged[key] = mergeRecordsPreferExisting(existingValue, incomingValue);
    } else if (!isBlankValue(existingValue)) {
      merged[key] = existingValue;
    }
  }

  return merged;
}

function isBlankValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function maybeTimestampIso(value: unknown): string | null {
  const parsed = typeof value === 'number'
    ? new Date(value)
    : typeof value === 'string'
      ? new Date(value)
      : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function mediaUrlFromRecord(record: Record<string, unknown>): string | null {
  return trimUnknownToNull(record.posterUrl) ?? trimUnknownToNull(record.url);
}

function normalizeMediaRecord(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const url = trimUnknownToNull(input.url) ?? trimUnknownToNull(input.posterUrl);
  if (!url) return null;

  const rawType = trimUnknownToNull(input.type)?.toLowerCase();
  const type = rawType === 'video' || rawType === 'gif' ? rawType : 'image';
  const output: Record<string, unknown> = { type, url };
  const videoUrl = trimUnknownToNull(input.videoUrl);
  const posterUrl = trimUnknownToNull(input.posterUrl);
  const alt = trimFirstUnknownToNull(input.alt, input.altText, input.alt_text);
  const width = numberOrNull(input.width);
  const height = numberOrNull(input.height);
  const durationMs = numberOrNull(input.durationMs);
  if (videoUrl) output.videoUrl = videoUrl;
  if (posterUrl) output.posterUrl = posterUrl;
  if (alt) output.alt = alt;
  if (width !== null) output.width = width;
  if (height !== null) output.height = height;
  if (durationMs !== null) output.durationMs = durationMs;
  return output;
}

function twitterMediaUrls(value: unknown, context: ConverterContext): string[] {
  const urls = new Set<string>();
  for (const media of recordArray(isRecord(value) ? value.media : undefined)) {
    const url = mediaUrlFromRecord(media);
    if (url) urls.add(url);
  }
  for (const url of normalizeStringArrayValue(isRecord(value) ? value.mediaUrls : undefined)) {
    urls.add(url);
  }
  for (const media of recordArray(context.payload.media)) {
    const url = mediaUrlFromRecord(media);
    if (url) urls.add(url);
  }
  for (const url of normalizeStringArrayValue(context.payload.mediaUrls)) {
    urls.add(url);
  }
  return [...urls];
}

function twitterMediaMetadata(value: unknown): Record<string, unknown>[] {
  return recordArray(value)
    .map(normalizeMediaRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function normalizeCommunityNoteRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { text } : null;
  }
  if (!isRecord(value)) return null;
  const text = trimUnknownToNull(value.text)
    ?? trimUnknownToNull(value.noteText)
    ?? trimUnknownToNull(value.note_text)
    ?? trimUnknownToNull(value.body)
    ?? trimUnknownToNull(value.context);
  if (!text) return null;
  const sourceUrl = trimUnknownToNull(value.sourceUrl)
    ?? trimUnknownToNull(value.sourceURL)
    ?? trimUnknownToNull(value.source_url)
    ?? trimUnknownToNull(value.url);
  return {
    text,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function normalizeLinkCardRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const url = trimFirstUnknownToNull(value.url, value.expandedUrl, value.href);
  if (!url) return null;

  const domain = trimUnknownToNull(value.domain) ?? (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const imageUrl = trimFirstUnknownToNull(value.imageUrl, value.image_url, value.image, value.thumbnailUrl, value.thumbnail_url);
  const imageAlt = trimFirstUnknownToNull(value.imageAlt, value.image_alt, value.alt, value.altText, value.alt_text);
  const videoId = trimUnknownToNull(value.videoId);
  const description = trimUnknownToNull(value.description);

  return {
    type: trimUnknownToNull(value.type) ?? 'link',
    url,
    title: trimUnknownToNull(value.title) ?? '',
    domain,
    ...(imageUrl ? { imageUrl } : {}),
    ...(imageAlt ? { imageAlt } : {}),
    ...(videoId ? { videoId } : {}),
    ...(description ? { description } : {}),
  };
}

function normalizePollOptionRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const label = value.trim();
    return label ? { label } : null;
  }
  if (!isRecord(value)) return null;

  const label = trimFirstUnknownToNull(value.label, value.text, value.title, value.name, value.choice, value.option);
  if (!label) return null;

  const voteCount = numberOrNull(value.voteCount ?? value.vote_count ?? value.votes ?? value.count);
  return {
    label,
    ...(voteCount !== null ? { voteCount } : {}),
  };
}

function normalizePollRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const rawOptions = Array.isArray(value.options)
    ? value.options
    : Array.isArray(value.choices)
      ? value.choices
      : [];
  const options = rawOptions
    .map(normalizePollOptionRecord)
    .filter((option): option is Record<string, unknown> => option !== null);
  if (options.length === 0) return null;

  const totalVotes = numberOrNull(value.totalVotes ?? value.total_votes ?? value.voteCount ?? value.vote_count ?? value.votes);
  const durationMinutes = numberOrNull(
    value.durationMinutes
      ?? value.duration_minutes
      ?? value.remainingMinutes
      ?? value.remaining_minutes
      ?? value.timeRemainingMinutes,
  );
  const endsAt = trimFirstUnknownToNull(value.endsAt, value.ends_at, value.endTime, value.end_time);

  return {
    options,
    ...(totalVotes !== null ? { totalVotes } : {}),
    ...(durationMinutes !== null ? { durationMinutes } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
}

function deriveQuoteUsername(displayName: string | null, context: ConverterContext): string {
  const rawText = isRecord(context.payload.raw_data) ? trimUnknownToNull(context.payload.raw_data.rawText) : null;
  const quoteUserMatch = rawText?.match(/\nQuote\n[^\n]*\n@([A-Za-z0-9_]{1,20})\b/);
  if (quoteUserMatch?.[1]) return quoteUserMatch[1];

  const compactDisplay = displayName?.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
  return compactDisplay || 'unknown_quote_author';
}

function twitterQuotedTweet(value: unknown, context: ConverterContext): Record<string, unknown> | null {
  const quote = isRecord(value)
    ? value
    : isRecord(context.payload.raw_data) && isRecord(context.payload.raw_data.quotedTweet)
      ? context.payload.raw_data.quotedTweet
      : null;
  if (!quote) return null;

  const author = isRecord(quote.author) ? quote.author : null;
  const displayName = trimUnknownToNull(author?.displayName)
    ?? trimUnknownToNull(author?.name)
    ?? trimUnknownToNull(quote.authorDisplayName)
    ?? trimUnknownToNull(quote.authorName);
  const username = trimUnknownToNull(author?.username)
    ?? trimUnknownToNull(quote.authorUsername)
    ?? trimUnknownToNull(quote.username)
    ?? deriveQuoteUsername(displayName, context);
  const text = trimUnknownToNull(quote.text)
    ?? trimUnknownToNull(quote.fullText)
    ?? trimUnknownToNull(quote.full_text)
    ?? '';
  const media = twitterMediaMetadata(quote.media);
  const linkCard = normalizeLinkCardRecord(quote.linkCard);
  const poll = normalizePollRecord(quote.poll);
  const id = trimUnknownToNull(quote.id) ?? trimUnknownToNull(quote.tweetId) ?? trimUnknownToNull(quote.quotedStatusId);
  const url = trimUnknownToNull(quote.url) ?? (id && username ? `https://x.com/${username}/status/${id}` : null);

  if (!text && media.length === 0 && !id && !url && !linkCard && !poll) return null;

  const output: Record<string, unknown> = {
    ...(id ? { id } : {}),
    text,
    author: {
      username,
      ...(displayName ? { displayName } : {}),
      ...(trimUnknownToNull(author?.avatarUrl) ?? trimUnknownToNull(quote.authorAvatarUrl)
        ? { avatarUrl: trimUnknownToNull(author?.avatarUrl) ?? trimUnknownToNull(quote.authorAvatarUrl) }
        : {}),
    },
    ...(url ? { url } : {}),
    ...(media.length > 0 ? { media } : {}),
    ...(linkCard ? { linkCard } : {}),
    ...(poll ? { poll } : {}),
  };
  const communityNote = normalizeCommunityNoteRecord(quote.communityNote ?? quote.community_note);
  if (communityNote) output.communityNote = communityNote;
  return output;
}

function hackerNewsMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const score = numberOrNull(value.score);
  const commentCount = numberOrNull(value.descendants);
  const hnUrl = trimUnknownToNull(value.hnUrl)
    ?? (trimUnknownToNull(value.id) ? `https://news.ycombinator.com/item?id=${trimUnknownToNull(value.id)}` : null);
  return {
    ...(hnUrl ? { hnUrl } : {}),
    hackerNews: {
      ...(score !== null ? { score } : {}),
      ...(commentCount !== null ? { commentCount } : {}),
    },
  };
}

function hackerNewsExcerpt(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const score = numberOrNull(value.score);
  const comments = numberOrNull(value.descendants);
  if (score === null && comments === null) return null;
  const scoreLabel = `${score ?? 0} ${score === 1 ? 'point' : 'points'}`;
  const commentLabel = `${comments ?? 0} ${comments === 1 ? 'comment' : 'comments'}`;
  return `Hacker News discussion: ${scoreLabel}, ${commentLabel}.`;
}

function substackMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const article: Record<string, unknown> = { platform: 'substack' };
  const publicationName = trimUnknownToNull(value.publicationName);
  const author = trimUnknownToNull(value.author) ?? trimUnknownToNull(value.authorDisplayName);
  const imageUrl = trimUnknownToNull(value.imageUrl);
  if (publicationName) article.publicationName = publicationName;
  if (author) article.author = author;
  if (imageUrl) article.imageUrl = imageUrl;
  return {
    article,
    ...(publicationName ? { publication: publicationName } : {}),
    ...(trimUnknownToNull(value.readingMeta) ? { readingTime: trimUnknownToNull(value.readingMeta) } : {}),
    ...(trimUnknownToNull(value.discoverySurface) ? { sourceSurface: `substack_${trimUnknownToNull(value.discoverySurface)}` } : {}),
  };
}

function normalizeYouTubeHandle(value: unknown): string | null {
  return trimUnknownToNull(value) ?? null;
}

function youtubeMediaUrls(value: unknown): string[] {
  const thumbnail = isRecord(value) ? trimUnknownToNull(value.thumbnailUrl) : trimUnknownToNull(value);
  return thumbnail ? [thumbnail] : [];
}

function youtubeMetadata(value: unknown, context: ConverterContext): Record<string, unknown> | null {
  const payload = isRecord(value) ? value : context.payload;
  const data = getYouTubeFeedData({
    source: 'youtube',
    sourceId: trimUnknownToNull(payload.videoId) ?? context.cacheItem.sourceId,
    url: trimUnknownToNull(payload.canonicalUrl) ?? trimUnknownToNull(payload.url) ?? context.cacheItem.url,
    title: trimUnknownToNull(payload.title) ?? context.cacheItem.title,
    authorUsername: normalizeYouTubeHandle(payload.channelHandle) ?? normalizeYouTubeHandle(context.cacheItem.authorUsername),
    authorDisplayName: trimUnknownToNull(payload.channelName) ?? context.cacheItem.authorDisplayName,
    mediaUrls: youtubeMediaUrls(payload),
    metadata: {
      videoId: trimUnknownToNull(payload.videoId) ?? context.cacheItem.sourceId,
      canonicalUrl: trimUnknownToNull(payload.canonicalUrl) ?? trimUnknownToNull(payload.url) ?? context.cacheItem.url,
      thumbnailUrl: trimUnknownToNull(payload.thumbnailUrl),
      publishDate: trimUnknownToNull(payload.publishDate),
      publishDateText: trimUnknownToNull(payload.publishDateText) ?? trimUnknownToNull(payload.publishLabel),
      channelName: trimUnknownToNull(payload.channelName),
      channelHandle: normalizeYouTubeHandle(payload.channelHandle),
      channelUrl: trimUnknownToNull(payload.channelUrl),
      duration: trimUnknownToNull(payload.duration),
      durationSeconds: numberOrNull(payload.durationSeconds) ?? undefined,
      viewCount: numberOrNull(payload.viewCount) ?? parseShortNumberValue(payload.viewCountLabel) ?? undefined,
      viewCountText: trimUnknownToNull(payload.viewCountLabel),
    },
  });
  return data ? buildYouTubeFeedMetadata(data) as Record<string, unknown> : null;
}

export const feedEnrichmentConverters = {
  passthrough: (value: unknown) => value,
  trimToNull: (value: unknown) => trimUnknownToNull(value),
  secondsToMs: (value: unknown) => {
    const seconds = numberOrNull(value);
    return seconds === null ? null : seconds * 1000;
  },
  parseShortNumber: (value: unknown) => parseShortNumberValue(value),
  appendDedupe: (value: unknown) => normalizeStringArrayValue(value),
  deepMerge: (value: unknown) => isRecord(value) ? value : null,
  number: (value: unknown) => numberOrNull(value),
  timestampIso: (value: unknown) => maybeTimestampIso(value),
  record: (value: unknown) => isRecord(value) ? value : null,
  recordArray: (value: unknown) => recordArray(value),
  twitterMediaUrls,
  twitterMediaMetadata,
  twitterQuotedTweet,
  twitterLinkCard: normalizeLinkCardRecord,
  twitterPollMetadata: normalizePollRecord,
  communityNote: normalizeCommunityNoteRecord,
  hackerNewsMetadata,
  hackerNewsExcerpt,
  substackMetadata,
  youtubeHandle: normalizeYouTubeHandle,
  youtubeMediaUrls,
  youtubeMetadata,
} as const;

/**
 * Source configs for the cache-to-feed enrichment engine.
 *
 * The engine dispatches by normalized source name. Each key below is a
 * self-contained declaration that maps one cache source into feed-row fields
 * and cross-row reference relationships. Adding a new source should only add
 * a new key here; it should not require changing engine logic.
 *
 * To add a new source, such as reddit, mastodon, bluesky, or rss:
 * 1. Define a Zod payload schema that describes the cache payload shape.
 * 2. Declare fieldMappings as { feedField, source, converter?, mergeMode? },
 *    where source is a dotted path into the parsed cache payload.
 * 3. Declare referenceFields as { field, relationship, converter? }, where
 *    field points to a sibling cache row's sourceId.
 * 4. Pick converters from feedEnrichmentConverters, for example trimToNull,
 *    number, secondsToMs, parseShortNumber, deepMerge, append-dedupe,
 *    passthrough, or a source-specific extractor.
 *
 * Engine guarantees that apply to every source automatically:
 * - Zod validates payload shape at parse time; invalid payloads bail cleanly.
 * - Reference traversal includes cycle detection with the default depth cap.
 * - Cross-row references are isolated to the same source by default.
 * - Merge modes include fillIfBlank, fillIfZero, append-dedupe, and deepMerge.
 * - Re-running enrichment on the same row is idempotent for unchanged fields.
 *
 * IMPORTANT: do not add editorial transforms inside converters. For example,
 * do not strip "@" from handles or force casing here. The engine should do
 * mechanical copying plus necessary type or structure conversion only.
 * Editorial decisions belong in cache extractor instructions or UI rendering.
 *
 * Verification note: arbitrary new sources work through config alone. Synthetic
 * mastodon with a flat reference and bluesky with a three-level nested reference
 * path both work end-to-end without engine code changes.
 */
const sourceConfigs: Record<string, SourceConfig> = {
  twitter: {
    feedType: 'tweet',
    payloadSchema: twitterPayloadSchema,
    fieldMappings: [
      { feedField: 'author_avatar_url', source: 'authorAvatarUrl', converter: 'trimToNull' },
      { feedField: 'author_username', source: 'cache.authorUsername', converter: 'trimToNull' },
      { feedField: 'author_username', source: 'authorUsername', converter: 'trimToNull' },
      { feedField: 'author_display_name', source: 'cache.authorDisplayName', converter: 'trimToNull' },
      { feedField: 'author_display_name', source: 'authorDisplayName', converter: 'trimToNull' },
      { feedField: 'url', source: 'cache.url', converter: 'trimToNull' },
      { feedField: 'url', source: 'url', converter: 'trimToNull' },
      { feedField: 'title', source: 'cache.title', converter: 'trimToNull' },
      { feedField: 'title', source: 'title', converter: 'trimToNull' },
      { feedField: 'text', source: 'text', converter: 'trimToNull' },
      { feedField: 'media_urls', source: '$', converter: 'twitterMediaUrls', mergeMode: 'append-dedupe' },
      { feedField: 'metrics_likes', source: 'metrics.likes', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_likes', source: 'metrics.likeCount', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_likes', source: 'likes', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_reposts', source: 'metrics.reposts', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_reposts', source: 'metrics.repostCount', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_reposts', source: 'metrics.retweets', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_reposts', source: 'metrics.retweetCount', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_reposts', source: 'reposts', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_replies', source: 'metrics.replies', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_replies', source: 'metrics.replyCount', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_replies', source: 'replies', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_views', source: 'metrics.views', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_views', source: 'metrics.viewCount', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metrics_views', source: 'viewCount', converter: 'number', mergeMode: 'fillIfZero' },
      { feedField: 'metadata.media', source: 'media', converter: 'twitterMediaMetadata', mergeMode: 'append-dedupe' },
      { feedField: 'metadata.quotedTweet', source: 'quotedTweet', converter: 'twitterQuotedTweet', mergeMode: 'deepMerge' },
      { feedField: 'metadata.quotedTweet', source: 'raw_data.quotedTweet', converter: 'twitterQuotedTweet', mergeMode: 'deepMerge' },
      { feedField: 'metadata.communityNote', source: 'communityNote', converter: 'communityNote', mergeMode: 'deepMerge' },
      { feedField: 'metadata.communityNote', source: 'community_note', converter: 'communityNote', mergeMode: 'deepMerge' },
      { feedField: 'metadata.linkCard', source: 'linkCard', converter: 'twitterLinkCard', mergeMode: 'deepMerge' },
      { feedField: 'metadata.poll', source: 'poll', converter: 'twitterPollMetadata', mergeMode: 'deepMerge' },
      { feedField: 'metadata.linkPreviews', source: 'linkPreviews', converter: 'recordArray', mergeMode: 'append-dedupe' },
      { feedField: 'metadata.urlEntities', source: 'urlEntities', converter: 'recordArray', mergeMode: 'append-dedupe' },
    ],
    referenceFields: [
      { field: 'inReplyToStatusId', relationship: 'parent', converter: 'trimToNull' },
      { field: 'inReplyTo.statusId', relationship: 'parent', converter: 'trimToNull' },
      { field: 'inReplyTo.sourceId', relationship: 'parent', converter: 'trimToNull' },
      { field: 'inReplyTo.id', relationship: 'parent', converter: 'trimToNull' },
      { field: 'replyingTo.statusId', relationship: 'parent', converter: 'trimToNull' },
    ],
  },
  hackernews: {
    feedType: 'article',
    payloadSchema: hackerNewsPayloadSchema,
    fieldMappings: [
      { feedField: 'title', source: 'cache.title', converter: 'trimToNull' },
      { feedField: 'title', source: 'title', converter: 'trimToNull' },
      { feedField: 'text', source: 'title', converter: 'trimToNull' },
      { feedField: 'url', source: 'cache.url', converter: 'trimToNull' },
      { feedField: 'url', source: 'url', converter: 'trimToNull' },
      { feedField: 'author_username', source: 'cache.authorUsername', converter: 'trimToNull' },
      { feedField: 'author_username', source: 'by', converter: 'trimToNull' },
      { feedField: 'author_display_name', source: 'cache.authorDisplayName', converter: 'trimToNull' },
      { feedField: 'author_display_name', source: 'by', converter: 'trimToNull' },
      { feedField: 'excerpt', source: '$', converter: 'hackerNewsExcerpt' },
      { feedField: 'metadata', source: '$', converter: 'hackerNewsMetadata', mergeMode: 'deepMerge' },
    ],
    referenceFields: [],
  },
  substack: {
    feedType: 'article',
    payloadSchema: substackPayloadSchema,
    fieldMappings: [
      { feedField: 'title', source: 'cache.title', converter: 'trimToNull' },
      { feedField: 'title', source: 'title', converter: 'trimToNull' },
      { feedField: 'text', source: 'text', converter: 'trimToNull' },
      { feedField: 'text', source: 'summary', converter: 'trimToNull' },
      { feedField: 'url', source: 'cache.url', converter: 'trimToNull' },
      { feedField: 'url', source: 'url', converter: 'trimToNull' },
      { feedField: 'excerpt', source: 'excerpt', converter: 'trimToNull' },
      { feedField: 'excerpt', source: 'summary', converter: 'trimToNull' },
      { feedField: 'author_username', source: 'cache.authorUsername', converter: 'trimToNull' },
      { feedField: 'author_username', source: 'authorUsername', converter: 'trimToNull' },
      { feedField: 'author_display_name', source: 'cache.authorDisplayName', converter: 'trimToNull' },
      { feedField: 'author_display_name', source: 'publicationName', converter: 'trimToNull' },
      { feedField: 'media_urls', source: 'mediaUrls', converter: 'appendDedupe', mergeMode: 'append-dedupe' },
      { feedField: 'media_urls', source: 'imageUrl', converter: 'appendDedupe', mergeMode: 'append-dedupe' },
      { feedField: 'metadata', source: '$', converter: 'substackMetadata', mergeMode: 'deepMerge' },
    ],
    referenceFields: [],
  },
  youtube: {
    feedType: 'article',
    payloadSchema: youtubePayloadSchema,
    fieldMappings: [
      { feedField: 'title', source: 'cache.title', converter: 'trimToNull' },
      { feedField: 'title', source: 'title', converter: 'trimToNull' },
      { feedField: 'text', source: 'title', converter: 'trimToNull' },
      { feedField: 'url', source: 'cache.url', converter: 'trimToNull' },
      { feedField: 'url', source: 'canonicalUrl', converter: 'trimToNull' },
      { feedField: 'excerpt', source: 'title', converter: 'trimToNull' },
      { feedField: 'author_username', source: 'cache.authorUsername', converter: 'youtubeHandle' },
      { feedField: 'author_username', source: 'channelHandle', converter: 'youtubeHandle' },
      { feedField: 'author_display_name', source: 'cache.authorDisplayName', converter: 'trimToNull' },
      { feedField: 'author_display_name', source: 'channelName', converter: 'trimToNull' },
      { feedField: 'media_urls', source: 'thumbnailUrl', converter: 'youtubeMediaUrls', mergeMode: 'append-dedupe' },
      { feedField: 'metadata', source: '$', converter: 'youtubeMetadata', mergeMode: 'deepMerge' },
    ],
    referenceFields: [],
  },
};

function sourceConfigFor(source: string | null | undefined): SourceConfig | null {
  const normalized = trimToNull(source)?.toLowerCase();
  return normalized ? sourceConfigs[normalized] ?? null : null;
}

function parseCachePayload(cacheItem: BrowseCacheItemRecord): { config: SourceConfig; payload: Record<string, unknown> } | null {
  const config = sourceConfigFor(cacheItem.source);
  if (!config) return null;
  const parsed = config.payloadSchema.safeParse(cacheItem.payload);
  return parsed.success ? { config, payload: parsed.data } : null;
}

function convertMappingValue(mapping: Pick<FieldMapping, 'converter'>, rawValue: unknown, context: ConverterContext): unknown {
  const converter = feedEnrichmentConverters[mapping.converter ?? 'passthrough'];
  return converter(rawValue, context);
}

function fieldParts(field: FeedPatchField): string[] {
  return String(field).split('.');
}

function getMetadataValue(metadata: Record<string, unknown> | null | undefined, path: string[]): unknown {
  let current: unknown = metadata ?? null;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setNestedRecordValue(target: Record<string, unknown>, path: string[], value: unknown) {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!isRecord(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function patchHasField(patch: FeedItemPatchInput, field: keyof FeedItemPatchInput): boolean {
  return Object.prototype.hasOwnProperty.call(patch, field);
}

function getPendingFieldValue(item: FeedItem, patch: FeedItemPatchInput, field: FeedPatchField): unknown {
  const parts = fieldParts(field);
  if (parts[0] === 'metadata') {
    const patchValue = getMetadataValue(
      isRecord(patch.metadata) ? patch.metadata : null,
      parts.slice(1),
    );
    return patchValue !== undefined ? patchValue : getMetadataValue(item.metadata as Record<string, unknown> | null, parts.slice(1));
  }

  switch (field) {
    case 'author_username': return patchHasField(patch, 'author_username') ? patch.author_username : item.authorUsername;
    case 'author_display_name': return patchHasField(patch, 'author_display_name') ? patch.author_display_name : item.authorDisplayName;
    case 'author_avatar_url': return patchHasField(patch, 'author_avatar_url') ? patch.author_avatar_url : item.authorAvatarUrl;
    case 'text': return patchHasField(patch, 'text') ? patch.text : item.text;
    case 'title': return patchHasField(patch, 'title') ? patch.title : item.title;
    case 'url': return patchHasField(patch, 'url') ? patch.url : item.url;
    case 'excerpt': return patchHasField(patch, 'excerpt') ? patch.excerpt : item.excerpt;
    case 'media_urls': return patchHasField(patch, 'media_urls') ? patch.media_urls : item.mediaUrls;
    case 'metrics_likes': return patchHasField(patch, 'metrics_likes') ? patch.metrics_likes : item.metrics.likes;
    case 'metrics_reposts': return patchHasField(patch, 'metrics_reposts') ? patch.metrics_reposts : item.metrics.reposts;
    case 'metrics_replies': return patchHasField(patch, 'metrics_replies') ? patch.metrics_replies : item.metrics.replies;
    case 'metrics_views': return patchHasField(patch, 'metrics_views') ? patch.metrics_views : item.metrics.views;
    case 'metadata': return patchHasField(patch, 'metadata') ? patch.metadata : item.metadata;
    default: return undefined;
  }
}

function setPatchField(patch: FeedItemPatchInput, field: FeedPatchField, value: unknown) {
  const parts = fieldParts(field);
  if (parts[0] === 'metadata') {
    const metadataPatch = isRecord(patch.metadata) ? patch.metadata : {};
    setNestedRecordValue(metadataPatch, parts.slice(1), value);
    patch.metadata = metadataPatch;
    return;
  }

  switch (field) {
    case 'author_username': patch.author_username = trimUnknownToNull(value); break;
    case 'author_display_name': patch.author_display_name = trimUnknownToNull(value); break;
    case 'author_avatar_url': patch.author_avatar_url = trimUnknownToNull(value); break;
    case 'text': patch.text = trimUnknownToNull(value); break;
    case 'title': patch.title = trimUnknownToNull(value); break;
    case 'url': patch.url = trimUnknownToNull(value); break;
    case 'excerpt': patch.excerpt = trimUnknownToNull(value); break;
    case 'media_urls': patch.media_urls = normalizeStringArrayValue(value); break;
    case 'metrics_likes': patch.metrics_likes = numberOrNull(value); break;
    case 'metrics_reposts': patch.metrics_reposts = numberOrNull(value); break;
    case 'metrics_replies': patch.metrics_replies = numberOrNull(value); break;
    case 'metrics_views': patch.metrics_views = numberOrNull(value); break;
    case 'metadata': patch.metadata = isRecord(value) ? value : patch.metadata; break;
  }
}

function mergeIncomingValue(existing: unknown, incoming: unknown, mergeMode: MergeMode): unknown {
  if (mergeMode === 'append-dedupe') {
    if (recordArray(existing).length > 0 || recordArray(incoming).length > 0) {
      return mergeRecordArrays(existing, incoming);
    }
    return mergeStringArrays(existing, incoming);
  }
  if (mergeMode === 'deepMerge' && isRecord(incoming)) {
    return isRecord(existing) ? mergeRecordsPreferExisting(existing, incoming) : incoming;
  }
  return incoming;
}

function shouldApplyField(existing: unknown, incoming: unknown, mergeMode: MergeMode): boolean {
  if (isBlankValue(incoming)) return false;
  if (mergeMode === 'append-dedupe') {
    const merged = mergeIncomingValue(existing, incoming, mergeMode);
    return stableJson(merged) !== stableJson(existing ?? []);
  }
  if (mergeMode === 'deepMerge') {
    if (isBlankValue(existing)) return true;
    const merged = mergeIncomingValue(existing, incoming, mergeMode);
    return stableJson(merged) !== stableJson(existing);
  }
  if (mergeMode === 'fillIfZero') {
    const current = numberOrNull(existing);
    return (current === null || current <= 0) && numberOrNull(incoming) !== null;
  }
  return isBlankValue(existing);
}

function applyMappingToPatch(
  patch: FeedItemPatchInput,
  item: FeedItem,
  mapping: FieldMapping,
  context: ConverterContext,
) {
  const incoming = convertMappingValue(mapping, readPath(context, mapping.source), context);
  const mergeMode = mapping.mergeMode ?? 'fillIfBlank';
  const existing = getPendingFieldValue(item, patch, mapping.feedField);
  if (!shouldApplyField(existing, incoming, mergeMode)) return;
  setPatchField(patch, mapping.feedField, mergeIncomingValue(existing, incoming, mergeMode));
}

function buildConfiguredPatch(item: FeedItem, cacheItem: BrowseCacheItemRecord, config: SourceConfig, payload: Record<string, unknown>): FeedItemPatchInput | null {
  const patch: FeedItemPatchInput = {};
  const context = { cacheItem, payload };
  for (const mapping of config.fieldMappings) {
    applyMappingToPatch(patch, item, mapping, context);
  }

  if (cacheItem.source.toLowerCase() === 'twitter' && !item.parentId) {
    const currentAvatar = getPendingFieldValue(item, patch, 'author_avatar_url');
    const currentDisplay = getPendingFieldValue(item, patch, 'author_display_name');
    const cachedAuthorFacts = (isBlank(trimUnknownToNull(currentAvatar)) || isBlank(trimUnknownToNull(currentDisplay)))
      ? getLatestCachedTweetAuthorFacts(item.authorUsername ?? cacheItem.authorUsername ?? '', 'twitter')
      : null;
    if (isBlank(trimUnknownToNull(currentAvatar)) && cachedAuthorFacts?.authorAvatarUrl) {
      patch.author_avatar_url = cachedAuthorFacts.authorAvatarUrl;
    }
    if (isBlank(trimUnknownToNull(currentDisplay)) && cachedAuthorFacts?.authorDisplayName && trimToNull(item.authorUsername ?? cacheItem.authorUsername ?? '')) {
      patch.author_display_name = cachedAuthorFacts.authorDisplayName;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function resolvePublishedAt(cacheItem: BrowseCacheItemRecord, payload: Record<string, unknown>): string {
  const iso = maybeTimestampIso(payload.publishedAt)
    ?? maybeTimestampIso(payload.publishedAtMs)
    ?? maybeTimestampIso(cacheItem.publishedAtMs)
    ?? maybeTimestampIso(typeof payload.time === 'number' ? payload.time * 1000 : null)
    ?? maybeTimestampIso(payload.fetchedAtMs)
    ?? maybeTimestampIso(cacheItem.fetchedAtMs);
  return iso ?? new Date().toISOString();
}

function stableLinkedItemId(parentId: string, relationship: FeedRelationship, cacheItem: BrowseCacheItemRecord): string {
  const base = `cache-${relationship}-${parentId}-${cacheItem.source}-${cacheItem.sourceId}`;
  const slug = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 10);
  return `${slug}-${hash}`;
}

function setDraftField(draft: FeedInsertInput, field: FeedPatchField, value: unknown) {
  if (isBlankValue(value)) return;
  const parts = fieldParts(field);
  if (parts[0] === 'metadata') {
    const metadata = isRecord(draft.metadata) ? draft.metadata : {};
    const current = getMetadataValue(metadata, parts.slice(1));
    const merged = isRecord(current) && isRecord(value)
      ? mergeRecordsPreferExisting(current, value)
      : Array.isArray(current) || Array.isArray(value)
        ? mergeIncomingValue(current, value, 'append-dedupe')
        : value;
    setNestedRecordValue(metadata, parts.slice(1), merged);
    draft.metadata = metadata;
    return;
  }

  switch (field) {
    case 'author_username':
      if (!draft.authorUsername) draft.authorUsername = trimUnknownToNull(value);
      break;
    case 'author_display_name':
      if (!draft.authorDisplayName) draft.authorDisplayName = trimUnknownToNull(value);
      break;
    case 'author_avatar_url':
      if (!draft.authorAvatarUrl) draft.authorAvatarUrl = trimUnknownToNull(value);
      break;
    case 'text':
      if (!draft.text || draft.text === draft.sourceId) draft.text = trimUnknownToNull(value) ?? draft.text;
      break;
    case 'title':
      if (!draft.title) draft.title = trimUnknownToNull(value);
      break;
    case 'url':
      if (!draft.url) draft.url = trimUnknownToNull(value);
      break;
    case 'excerpt':
      if (!draft.excerpt) draft.excerpt = trimUnknownToNull(value);
      break;
    case 'media_urls':
      draft.mediaUrls = mergeStringArrays(draft.mediaUrls, value);
      break;
    case 'metrics_likes':
      draft.metrics = { ...(draft.metrics ?? { likes: 0, reposts: 0, replies: 0 }), likes: numberOrNull(value) ?? draft.metrics?.likes ?? 0 };
      break;
    case 'metrics_reposts':
      draft.metrics = { ...(draft.metrics ?? { likes: 0, reposts: 0, replies: 0 }), reposts: numberOrNull(value) ?? draft.metrics?.reposts ?? 0 };
      break;
    case 'metrics_replies':
      draft.metrics = { ...(draft.metrics ?? { likes: 0, reposts: 0, replies: 0 }), replies: numberOrNull(value) ?? draft.metrics?.replies ?? 0 };
      break;
    case 'metrics_views': {
      const views = numberOrNull(value);
      if (views !== null) draft.metrics = { ...(draft.metrics ?? { likes: 0, reposts: 0, replies: 0 }), views };
      break;
    }
    case 'metadata':
      if (isRecord(value)) {
        draft.metadata = isRecord(draft.metadata)
          ? mergeRecordsPreferExisting(draft.metadata, value)
          : value;
      }
      break;
  }
}

function buildFeedInputFromCache(
  cacheItem: BrowseCacheItemRecord,
  relationshipParent: FeedItem,
  relationship: FeedRelationship,
): FeedInsertInput | null {
  const parsed = parseCachePayload(cacheItem);
  if (!parsed) return null;

  const draft: FeedInsertInput = {
    id: stableLinkedItemId(relationshipParent.id, relationship, cacheItem),
    type: parsed.config.feedType,
    source: cacheItem.source,
    sourceId: cacheItem.sourceId,
    parentId: relationshipParent.id,
    relationship,
    title: cacheItem.title,
    text: cacheItem.title ?? cacheItem.url ?? cacheItem.sourceId,
    url: cacheItem.url,
    excerpt: null,
    authorUsername: cacheItem.authorUsername,
    authorDisplayName: cacheItem.authorDisplayName,
    authorAvatarUrl: null,
    reason: `Cache-linked ${relationship} context`,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    metadata: null,
    publishedAt: resolvePublishedAt(cacheItem, parsed.payload),
  };

  const context = { cacheItem, payload: parsed.payload };
  for (const mapping of parsed.config.fieldMappings) {
    const incoming = convertMappingValue(mapping, readPath(context, mapping.source), context);
    setDraftField(draft, mapping.feedField, incoming);
  }

  if (!trimToNull(draft.text)) {
    draft.text = draft.title ?? draft.url ?? draft.sourceId ?? cacheItem.sourceId;
  }

  return draft;
}

function referenceValues(reference: ReferenceField, context: ConverterContext): string[] {
  const raw = readPath(context, reference.field);
  const converted = convertMappingValue(reference, raw, context);
  if (Array.isArray(converted)) {
    return converted.map(trimUnknownToNull).filter((entry): entry is string => Boolean(entry));
  }
  const value = trimUnknownToNull(converted);
  return value ? [value] : [];
}

function followReferencesFromCache(
  rootItem: FeedItem,
  cacheItem: BrowseCacheItemRecord,
  config: SourceConfig,
  payload: Record<string, unknown>,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
) {
  if (depth >= maxDepth) return;
  const context = { cacheItem, payload };

  for (const reference of config.referenceFields) {
    const referenceSource = trimToNull(reference.source) ?? cacheItem.source;
    for (const sourceId of referenceValues(reference, context)) {
      const key = `${referenceSource}:${sourceId}`;
      if (visited.has(key)) continue;
      const referencedCacheItem = getBrowseCacheItemByExactSourceId(referenceSource, sourceId);
      if (!referencedCacheItem) continue;
      visited.add(key);

      const input = buildFeedInputFromCache(referencedCacheItem, rootItem, reference.relationship);
      if (input && !getFeedItemBySourceId(input.sourceId ?? '')) {
        insertOrIgnoreFeedItem(input);
      }

      const parsed = parseCachePayload(referencedCacheItem);
      if (parsed) {
        followReferencesFromCache(rootItem, referencedCacheItem, parsed.config, parsed.payload, visited, depth + 1, maxDepth);
      }
    }
  }
}

function buildCacheKey(source: string | null | undefined, sourceId: string | null | undefined): string | null {
  const normalizedSource = trimToNull(source);
  const normalizedSourceId = trimToNull(sourceId);
  return normalizedSource && normalizedSourceId ? `${normalizedSource}:${normalizedSourceId}` : null;
}

function mediaKey(value: Record<string, unknown>): string | null {
  return trimUnknownToNull(value.posterUrl) ?? trimUnknownToNull(value.url);
}

function mediaMetadataNeedsBackfill(cachedMedia: Record<string, unknown>[], currentMedia: unknown): boolean {
  const currentByKey = new Map<string, Record<string, unknown>>();
  for (const entry of recordArray(currentMedia)) {
    const key = mediaKey(entry);
    if (key) currentByKey.set(key, entry);
  }

  for (const cached of cachedMedia) {
    const alt = trimUnknownToNull(cached.alt);
    const key = mediaKey(cached);
    if (alt && key && !trimUnknownToNull(currentByKey.get(key)?.alt)) return true;
  }

  return false;
}

export function itemIsStillIncomplete(item: FeedItem): boolean {
  if (item.type === 'article') {
    if (item.parentId || !trimToNull(item.url)) return false;
    const articleEnrichment = isRecord(item.metadata?.articleEnrichment) ? item.metadata.articleEnrichment : null;
    if (trimUnknownToNull(articleEnrichment?.skipReason)) return false;
    if (articleEnrichment?.status === 'skipped') return false;
    if (articleEnrichment?.status === 'completed' && articleEnrichment.retryEligible !== true) return false;
    const batchEnrichment = isRecord(item.metadata?.batchEnrichment) ? item.metadata.batchEnrichment : null;
    if (batchEnrichment?.status === 'completed' && batchEnrichment.retryEligible !== true) return false;
    return true;
  }

  if (item.type !== 'tweet') return false;
  if (!trimToNull(item.authorAvatarUrl)) return true;

  const sourceId = trimToNull(item.sourceId);
  const source = trimToNull(item.source);
  if (!source || !sourceId) return false;
  const cacheItem = getBrowseCacheItemByExactSourceId(source, sourceId);
  if (!cacheItem) return false;
  const parsed = parseCachePayload(cacheItem);
  if (!parsed) return false;

  const context = { cacheItem, payload: parsed.payload };
  const cachedMediaUrls = twitterMediaUrls(parsed.payload, context);
  const cachedMedia = twitterMediaMetadata(parsed.payload.media);
  if (cachedMediaUrls.length > 0) {
    const existingMediaUrls = new Set(item.mediaUrls.map((entry) => entry.trim()).filter(Boolean));
    if (cachedMediaUrls.some((url) => !existingMediaUrls.has(url))) return true;
  }
  if (mediaMetadataNeedsBackfill(cachedMedia, item.metadata?.media)) return true;

  const cachedQuote = twitterQuotedTweet(parsed.payload.quotedTweet, context);
  if (cachedQuote) {
    const currentQuote = item.metadata?.quotedTweet;
    if (!currentQuote) return true;
    const cachedAuthor = isRecord(cachedQuote.author) ? cachedQuote.author : null;
    if (trimUnknownToNull(cachedQuote.text) && !trimToNull(currentQuote.text)) return true;
    if (trimUnknownToNull(cachedAuthor?.username) && !trimToNull(currentQuote.author?.username)) return true;
    if (trimUnknownToNull(cachedAuthor?.displayName) && !trimToNull(currentQuote.author?.displayName)) return true;
    if (trimUnknownToNull(cachedAuthor?.avatarUrl) && !trimToNull(currentQuote.author?.avatarUrl)) return true;
    if (hasCommunityNotePayload(cachedQuote) && !currentQuote.communityNote) return true;
    const cachedQuoteLinkCard = isRecord(cachedQuote.linkCard) ? cachedQuote.linkCard : null;
    if (cachedQuoteLinkCard && !currentQuote.linkCard) return true;
    if (trimUnknownToNull(cachedQuoteLinkCard?.imageAlt) && !trimToNull(currentQuote.linkCard?.imageAlt)) return true;
    if (isRecord(cachedQuote.poll) && !currentQuote.poll) return true;
  }

  const communityNote = normalizeCommunityNoteRecord(parsed.payload.communityNote ?? parsed.payload.community_note);
  if (communityNote && !item.metadata?.communityNote) return true;

  const linkCard = normalizeLinkCardRecord(parsed.payload.linkCard);
  if (linkCard && !item.metadata?.linkCard) return true;
  if (trimUnknownToNull(linkCard?.imageAlt) && !trimToNull(item.metadata?.linkCard?.imageAlt)) return true;
  if (normalizePollRecord(parsed.payload.poll) && !item.metadata?.poll) return true;
  if (recordArray(parsed.payload.linkPreviews).length > 0 && (!Array.isArray(item.metadata?.linkPreviews) || item.metadata.linkPreviews.length === 0)) return true;
  if (recordArray(parsed.payload.urlEntities).length > 0 && (!Array.isArray(item.metadata?.urlEntities) || item.metadata.urlEntities.length === 0)) return true;
  return false;
}

export function applyCachedItemEnrichment(
  input: FeedItem | string,
  options: ApplyCachedItemEnrichmentOptions = {},
): FeedItem | null {
  const item = resolveFeedItem(input);
  if (!item) return null;

  if (item.source === 'twitter' && item.parentId) {
    return item;
  }

  const source = trimToNull(item.source);
  const sourceId = trimToNull(item.sourceId);
  const cacheItem = source && sourceId ? getBrowseCacheItemByExactSourceId(source, sourceId) : null;
  const parsed = cacheItem ? parseCachePayload(cacheItem) : null;
  let updated = item;

  if (cacheItem && parsed) {
    const patch = buildConfiguredPatch(item, cacheItem, parsed.config, parsed.payload);
    if (patch) {
      updated = updateFeedItemFields(item.id, patch) ?? item;
    }
  } else if (item.source === 'twitter' && !item.parentId && (isBlank(item.authorAvatarUrl) || isBlank(item.authorDisplayName))) {
    const cachedAuthorFacts = getLatestCachedTweetAuthorFacts(item.authorUsername ?? '', 'twitter');
    if (cachedAuthorFacts?.authorAvatarUrl || cachedAuthorFacts?.authorDisplayName) {
      updated = updateFeedItemFields(item.id, {
        ...(isBlank(item.authorAvatarUrl) && cachedAuthorFacts.authorAvatarUrl ? { author_avatar_url: cachedAuthorFacts.authorAvatarUrl } : {}),
        ...(isBlank(item.authorDisplayName) && cachedAuthorFacts.authorDisplayName ? { author_display_name: cachedAuthorFacts.authorDisplayName } : {}),
      }) ?? item;
    }
  }

  if (cacheItem && parsed && options.followReferences !== false) {
    const visited = new Set<string>();
    const rootKey = buildCacheKey(cacheItem.source, cacheItem.sourceId);
    if (rootKey) visited.add(rootKey);
    followReferencesFromCache(updated, cacheItem, parsed.config, parsed.payload, visited, 0, options.maxReferenceDepth ?? 12);
  }

  return getFeedItemById(updated.id) ?? updated;
}

export function applyCachedTweetEnrichment(input: FeedItem | string): FeedItem | null {
  return applyCachedItemEnrichment(input);
}

export async function queueFeedItemEnrichment(
  input: FeedItem | string,
  options: QueueFeedItemEnrichmentOptions = {},
): Promise<QueueFeedItemEnrichmentResult> {
  const item = resolveFeedItem(input);
  if (!item) {
    return {
      ok: false,
      alreadyRunning: false,
      postId: '',
      error: 'Post not found',
    };
  }

  const outputPath = getDataPath('feed-output.jsonl');
  const tweetId = item.type === 'tweet' ? resolveFeedItemTweetId(item) : null;
  const promptMode = options.mode ?? 'lightweight';
  const tracking = options.tracking ?? 'automatic';
  const existingFullRequestId = tracking === 'full' ? getFullEnrichmentRequestId(item) : null;

  if (tracking === 'full' && existingFullRequestId) {
    const runningAgent = await getRunningEnrichment(item.id, existingFullRequestId);
    if (runningAgent) {
      return {
        ok: true,
        alreadyRequested: true,
        alreadyRunning: true,
        postId: item.id,
        requestId: runningAgent.id,
        agent: {
          id: runningAgent.id,
          status: runningAgent.status,
        },
      };
    }
  }

  const prompt = buildEnrichmentPrompt(item, outputPath, {
    tweetId,
    mode: promptMode,
  });

  if (backgroundJobsDisabled) {
    await agentManager.ensureReady();

    if (tracking === 'full') {
      const runningAgent = await getRunningEnrichment(item.id, existingFullRequestId);
      if (runningAgent) {
        return {
          ok: true,
          alreadyRequested: true,
          alreadyRunning: true,
          postId: item.id,
          requestId: runningAgent.id,
          agent: {
            id: runningAgent.id,
            status: runningAgent.status,
          },
        };
      }
    }

    const agent = await spawnEnrichmentAgent(prompt);
    const requestedAt = new Date().toISOString();

    if (tracking === 'full') {
      storeFullEnrichmentRequestId(item.id, agent.id);
      postEnrichmentJobs.set(item.id, {
        agentId: agent.id,
        startedAt: requestedAt,
      });
    }

    return {
      ok: true,
      alreadyRunning: false,
      postId: item.id,
      requestId: agent.id,
      requestedAt,
      agent: {
        id: agent.id,
        status: agent.status,
      },
    };
  }

  const requestId = options.requestId ?? `enrich-${item.id}-${randomUUID()}`;
  const result = await enqueueOrchestratorMessage({
    message: prompt,
    priority: 'post_enrichment',
    source: options.source ?? 'post_enrichment',
    metadata: {
      endpoint: options.endpoint ?? 'automatic_post_enrichment',
      enrichmentMode: promptMode,
      postId: item.id,
      requiresBrowserTools: true,
      routeId: options.routeId ?? item.id,
      tweetId,
      trigger: options.trigger ?? 'automatic_post_enrichment',
    },
    requestId,
  });

  if (!result.ok) {
    return {
      ok: false,
      alreadyRunning: false,
      postId: item.id,
      error: result.error ?? 'Failed to queue enrichment',
    };
  }

  const requestedAt = new Date().toISOString();
  if (tracking === 'full') {
    storeFullEnrichmentRequestId(item.id, requestId);
    postEnrichmentJobs.set(item.id, {
      agentId: requestId,
      startedAt: requestedAt,
    });
  }

  return {
    ok: true,
    alreadyRunning: false,
    postId: item.id,
    requestId,
    requestedAt,
    queueDepth: result.queueDepth,
    agent: {
      id: requestId,
      status: 'running',
    },
  };
}

export async function queueBatchEnrichment(
  inputs: Array<FeedItem | string>,
  options: QueueBatchEnrichmentOptions = {},
): Promise<QueueBatchEnrichmentResult> {
  const items = inputs
    .map((input) => resolveFeedItem(input))
    .filter((item): item is FeedItem => Boolean(item?.id));

  if (items.length === 0) {
    return {
      ok: false,
      alreadyRunning: false,
      postIds: [],
      error: 'No posts found for batch enrichment',
    };
  }

  const requestId = options.requestId ?? `enrich-batch-${randomUUID()}`;
  const prompt = buildBatchEnrichmentPrompt(items, { requestId });
  const timeoutMs = resolveBatchEnrichmentTimeoutMs(items.length);

  if (backgroundJobsDisabled) {
    await agentManager.ensureReady();

    const agent = await spawnEnrichmentAgent(prompt, timeoutMs);
    storeBatchEnrichmentAssociation(items, requestId, 'running', timeoutMs);
    return {
      ok: true,
      alreadyRunning: false,
      postIds: items.map((item) => item.id),
      requestId: agent.id,
      requestedAt: new Date().toISOString(),
      agent: {
        id: agent.id,
        status: agent.status,
      },
    };
  }

  const postIds = items.map((item) => item.id);
  const result = await enqueueOrchestratorMessage({
    message: prompt,
    priority: 'post_enrichment',
    source: options.source ?? 'post_enrichment',
    metadata: {
      endpoint: options.endpoint ?? 'automatic_post_enrichment_batch',
      enrichmentMode: 'batch',
      itemCount: items.length,
      postIds,
      requiresBrowserTools: true,
      routeId: options.routeId ?? postIds[0],
      trigger: options.trigger ?? 'automatic_post_enrichment_batch',
    },
    requestId,
    timeoutMs,
  });

  if (!result.ok) {
    return {
      ok: false,
      alreadyRunning: false,
      postIds,
      error: result.error ?? 'Failed to queue batch enrichment',
    };
  }

  storeBatchEnrichmentAssociation(items, requestId, 'queued', timeoutMs);

  return {
    ok: true,
    alreadyRunning: false,
    postIds,
    requestId,
    requestedAt: new Date().toISOString(),
    queueDepth: result.queueDepth,
    agent: {
      id: requestId,
      status: 'running',
    },
  };
}
