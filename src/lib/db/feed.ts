import { randomUUID } from 'node:crypto';
import { getDb } from './client';
import type { FeedSortOrder } from '@/lib/feed-query';
import {
  buildSuggestionGroupItems,
  getSuggestionGroupLatestTimestamp,
} from '@/lib/feed-groups';
import { getDerivedFeedMediaTypes, getFeedMediaUrlsAndTypes } from '@/lib/feed-media';
import { normalizeReplyCaptureMetadata } from '@/lib/reply-capture';
import { deriveAnalysisPresentation } from '@/lib/analysis-presentation';
import { normalizeFeedProminence } from '@/lib/feed-prominence';
import { buildYouTubeFeedMetadata, getYouTubeFeedData, isYouTubeSource } from '@/lib/youtube-feed';
import { resolveHackerNewsDiscussionUrl } from '@/lib/hacker-news';
import { escapeSqlLikePattern, tokenizeSearchQuery } from '@/lib/search-utils';

/** Ensure SQLite datetime strings (no TZ) become proper ISO 8601 UTC */
function normalizeUtcTimestamp(ts: string): string {
  if (!ts) return ts;
  const parsed = new Date(ts);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  let s = ts.includes('T') ? ts : ts.replace(' ', 'T');
  if (!s.endsWith('Z')) s += 'Z';
  return s;
}

function timestampToEpochMilliseconds(timestamp: string, fallback = Date.now()): number {
  const epochMs = new Date(timestamp).getTime();
  return Number.isFinite(epochMs) ? epochMs : fallback;
}

import type {
  ChildPreview,
  FeedItem,
  FeedPendingCounts,
  FeedRelationship,
  FeedItemType,
  FeedSuggestionGroup,
  SuggestionStatus,
  FeedMetrics,
  FeedMediaType,
  FeedMetadata,
  FeedThread,
  FeedThreadMetadata,
  LinkCard,
  LinkPreview,
  MediaItem,
  Poll,
  QuoteTweet,
  TweetCommunityNote,
} from '@/types/feed';

interface FeedRow {
  id: string;
  type: string;
  source: string | null;
  source_id: string | null;
  origin_session_id: string | null;
  parent_id: string | null;
  relationship: string | null;
  title: string | null;
  text: string;
  url: string | null;
  excerpt: string | null;
  author_username: string | null;
  author_display_name: string | null;
  reason: string | null;
  tags: string | null;
  media_urls: string | null;
  display_order: number | null;
  thread_id: string | null;
  display_subtitle: string | null;
  display_thread_title?: string | null;
  display_thread_subtitle?: string | null;
  display_thread_active?: number | null;
  metrics_likes: number | null;
  metrics_reposts: number | null;
  metrics_replies: number | null;
  metrics_views: number | null;
  author_avatar_url: string | null;
  metadata: string | null;
  published_at: string;
  published_at_ms: number | null;
  created_at: string;
  created_at_ms: number | null;
}

export interface FeedInsertInput {
  id?: string;
  type: FeedItemType;
  source?: string | null;
  sourceId?: string | null;
  originSessionId?: string | null;
  parentId?: string | null;
  relationship?: FeedRelationship | null;
  title?: string | null;
  text: string;
  url?: string | null;
  excerpt?: string | null;
  authorUsername?: string | null;
  authorDisplayName?: string | null;
  authorAvatarUrl?: string | null;
  reason?: string | null;
  tags?: string[];
  mediaUrls?: string[];
  metrics?: FeedMetrics;
  metadata?: FeedMetadata | null;
  publishedAt: string;
}

export interface FeedEnrichmentInput {
  text?: string | null;
  metrics: FeedMetrics;
  mediaUrls?: string[] | null;
  authorAvatarUrl?: string | null;
  metadata?: FeedMetadata | null;
}

export interface FeedItemPatchInput {
  author_username?: string | null;
  author_display_name?: string | null;
  text?: string | null;
  title?: string | null;
  url?: string | null;
  excerpt?: string | null;
  reason?: string | null;
  tags?: string[] | string | null;
  media_urls?: string[] | string | null;
  author_avatar_url?: string | null;
  metadata?: Record<string, unknown> | string | null;
  metrics_likes?: number | null;
  metrics_reposts?: number | null;
  metrics_replies?: number | null;
  metrics_views?: number | null;
  published_at?: string | null;
  published_at_ms?: number | null;
}

export interface FeedQuery {
  offset: number;
  limit: number;
  types: FeedItemType[];
  sources: string[];
  sort: FeedSortOrder;
  search: string | null;
  threadId?: string | null;
}

export interface FeedArrangeOrderingInput {
  feedItemId: string;
  displayOrder: number;
  threadId?: string | null;
  displaySubtitle?: string | null;
}

export interface FeedArrangeThreadInput {
  id: string;
  title: string;
  subtitle?: string | null;
  active: boolean;
}

export interface FeedArrangeResult {
  updatedItemIds: string[];
  activeThreads: FeedThread[];
  orderingCount: number;
  threadCount: number;
}

export const allowedFeedTypes: FeedItemType[] = ['tweet', 'article', 'analysis', 'suggestion', 'notification'];
const allowedRelationships: FeedRelationship[] = ['parent', 'child', 'reply', 'analysis', 'related', 'thread'];

function createEmptyPendingCounts(): FeedPendingCounts {
  return {
    tweet: 0,
    article: 0,
    analysis: 0,
    suggestion: 0,
    notification: 0,
  };
}

function readThreadPaginationKey(item: FeedItem): string | null {
  return item.threadId?.trim()
    || (typeof item.metadata?.thread?.threadId === 'string' ? item.metadata.thread.threadId.trim() : '')
    || null;
}

function getThreadAwareFeedPageItems(items: FeedItem[], offset: number, limit: number): FeedItem[] {
  const start = Math.max(0, offset);
  let extendedEnd = Math.min(items.length, start + Math.max(0, limit));
  if (start >= extendedEnd) {
    return [];
  }

  while (extendedEnd < items.length) {
    const pageThreadKeys = new Set<string>();
    for (let index = start; index < extendedEnd; index += 1) {
      const key = readThreadPaginationKey(items[index]);
      if (key) {
        pageThreadKeys.add(key);
      }
    }

    if (pageThreadKeys.size === 0) {
      break;
    }

    let nextEnd = extendedEnd;
    for (let index = extendedEnd; index < items.length; index += 1) {
      const key = readThreadPaginationKey(items[index]);
      if (key && pageThreadKeys.has(key)) {
        nextEnd = index + 1;
      }
    }

    if (nextEnd === extendedEnd) {
      break;
    }

    extendedEnd = nextEnd;
  }

  return items.slice(start, extendedEnd);
}

export function normalizeTweetSourceId(sourceId: string): string {
  const trimmed = sourceId.trim();
  const match = trimmed.match(/^(?:tweet-|twitter:)(\d+)$/i);
  return match?.[1] ?? trimmed;
}

function extractArticleLegacySourceIdParts(sourceId: string): { hostOrSlug: string; path: string } | null {
  const trimmed = sourceId.trim();
  const match = trimmed.match(/^([^:/?#\s]+):(\/p\/[^?#\s]+)$/i);
  if (!match) {
    return null;
  }

  return {
    hostOrSlug: match[1],
    path: match[2],
  };
}

function getLegacyArticleSourceIdVariants(sourceId: string): string[] {
  const trimmed = sourceId.trim();
  if (!trimmed) {
    return [];
  }

  const variants = new Set<string>();
  const legacyParts = extractArticleLegacySourceIdParts(trimmed);
  if (legacyParts) {
    variants.add(trimmed);
  }

  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/i.test(parsed.protocol) || !/^\/p\/[^?#\s]+$/i.test(parsed.pathname)) {
      return [...variants];
    }

    variants.add(`${parsed.hostname}:${parsed.pathname}`);
    if (parsed.hostname.endsWith('.substack.com')) {
      const slug = parsed.hostname.slice(0, -'.substack.com'.length);
      if (slug) {
        variants.add(`${slug}:${parsed.pathname}`);
      }
    }
  } catch {
    return [...variants];
  }

  return [...variants];
}

export function normalizeArticleSourceId(sourceId: string): string {
  const trimmed = sourceId.trim();
  if (!trimmed) {
    return trimmed;
  }

  const legacyParts = extractArticleLegacySourceIdParts(trimmed);
  if (legacyParts) {
    const host = legacyParts.hostOrSlug.includes('.')
      ? legacyParts.hostOrSlug
      : `${legacyParts.hostOrSlug}.substack.com`;
    return `https://${host}${legacyParts.path}`;
  }

  return trimmed;
}

function getSourceIdLookupCandidates(sourceId: string): string[] {
  const trimmed = sourceId.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = new Set<string>([trimmed]);
  const normalizedArticleSourceId = normalizeArticleSourceId(trimmed);
  if (normalizedArticleSourceId) {
    candidates.add(normalizedArticleSourceId);
    for (const variant of getLegacyArticleSourceIdVariants(normalizedArticleSourceId)) {
      candidates.add(variant);
    }
  }

  return [...candidates];
}

const relationshipOrderSql = `
  CASE COALESCE(relationship, '')
    WHEN 'parent' THEN 1
    WHEN 'child' THEN 2
    WHEN 'reply' THEN 3
    WHEN 'analysis' THEN 4
    WHEN 'related' THEN 5
    WHEN 'thread' THEN 6
    ELSE 7
  END
`;

const childPreviewRelationshipOrderSql = `
  CASE COALESCE(relationship, '')
    WHEN 'analysis' THEN 1
    WHEN 'related' THEN 2
    WHEN 'reply' THEN 3
    WHEN 'child' THEN 4
    WHEN 'thread' THEN 5
    WHEN 'parent' THEN 6
    ELSE 7
  END
`;

export interface FeedChildrenByRelationship {
  parent: FeedItem[];
  child: FeedItem[];
  reply: FeedItem[];
  analysis: FeedItem[];
  related: FeedItem[];
  thread: FeedItem[];
  unknown: FeedItem[];
}

interface ChildPreviewRow {
  id: string;
  parent_id: string;
  type: string;
  relationship: string | null;
  title: string | null;
  text: string;
  source: string | null;
  author_username: string | null;
  author_display_name: string | null;
  author_avatar_url: string | null;
  published_at: string | null;
  reason: string | null;
}

interface QuotedTweetMatch {
  parentItem: FeedItem;
  quote: QuoteTweet;
}

const EMBEDDED_QUOTED_TWEET_REASON = 'Quoted tweet embedded in parent post';
const CHILD_PREVIEW_LIMIT = 6;

function toChildPreviewText(text: string, maxLength = 100): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength).trimEnd()}...`;
}

function parseJsonArray(input: string | null): string[] {
  if (!input) return [];
  try {
    const value = JSON.parse(input);
    if (Array.isArray(value)) {
      return value.map((v) => String(v));
    }
  } catch {
    return [];
  }
  return [];
}

function parseJsonRecord(input: string | null): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const value = JSON.parse(input);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function toInteger(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function toCount(value: unknown, fallback = 0): number {
  const num = toInteger(value, fallback);
  return num < 0 ? fallback : num;
}

function normalizeMediaItem(input: unknown): MediaItem | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  if (type !== 'image' && type !== 'video' && type !== 'gif') return null;

  const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url : null;
  if (!url) return null;

  const media: MediaItem = {
    type,
    url,
  };

  if (typeof raw.videoUrl === 'string' && raw.videoUrl.trim()) media.videoUrl = raw.videoUrl;
  if (typeof raw.posterUrl === 'string' && raw.posterUrl.trim()) media.posterUrl = raw.posterUrl;
  const alt = firstTrimmedString(raw.alt, raw.altText, raw.alt_text);
  if (alt) media.alt = alt;

  const width = toInteger(raw.width, -1);
  if (width >= 0) media.width = width;

  const height = toInteger(raw.height, -1);
  if (height >= 0) media.height = height;

  const durationMs = toInteger(raw.durationMs, -1);
  if (durationMs >= 0) media.durationMs = durationMs;

  return media;
}

function isBlobMediaUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith('blob:');
}

function dedupeFeedMediaUrls(mediaUrls: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const url of mediaUrls) {
    if (isBlobMediaUrl(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    normalized.push(url);
  }

  return normalized;
}

function getMediaDedupeKey(media: MediaItem): string {
  return (media.posterUrl?.trim() || media.url.trim());
}

function mergeMediaItems(existing: MediaItem, incoming: MediaItem): MediaItem {
  return {
    ...incoming,
    ...existing,
  };
}

function dedupeFeedMediaItems(media: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  const normalized: MediaItem[] = [];

  for (const entry of media) {
    const key = getMediaDedupeKey(entry);
    if (!key || isBlobMediaUrl(key)) {
      continue;
    }
    if (seen.has(key)) {
      const existingIndex = normalized.findIndex((item) => getMediaDedupeKey(item) === key);
      if (existingIndex >= 0) {
        normalized[existingIndex] = mergeMediaItems(normalized[existingIndex], entry);
      }
      continue;
    }
    seen.add(key);
    normalized.push(entry);
  }

  return normalized;
}

function dedupeMetadataMedia(metadata: FeedMetadata | null): FeedMetadata | null {
  if (!Array.isArray(metadata?.media)) {
    return metadata;
  }

  const media = dedupeFeedMediaItems(metadata.media);
  if (media.length === metadata.media.length) {
    return metadata;
  }

  const next: FeedMetadata = { ...metadata };
  if (media.length > 0) {
    const { mediaTypes } = getFeedMediaUrlsAndTypes(media);
    next.media = media;
    next.mediaTypes = mediaTypes;
  } else {
    delete next.media;
    delete next.mediaTypes;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function normalizeCommunityNoteSourceUrl(input: unknown): string | null {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function firstTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function normalizeCommunityNote(input: unknown): TweetCommunityNote | null {
  if (typeof input === 'string') {
    const text = input.trim();
    return text ? { text } : null;
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const nestedNote = raw.note && typeof raw.note === 'object' && !Array.isArray(raw.note)
    ? raw.note as Record<string, unknown>
    : null;
  const text = firstTrimmedString(
    raw.text,
    raw.noteText,
    raw.note_text,
    raw.body,
    raw.context,
    nestedNote?.text,
  );
  if (!text) {
    return null;
  }

  const sourceUrl = normalizeCommunityNoteSourceUrl(
    raw.sourceUrl
      ?? raw.sourceURL
      ?? raw.source_url
      ?? raw.sourceLink
      ?? raw.source_link
      ?? raw.url
      ?? nestedNote?.sourceUrl
      ?? nestedNote?.source_url,
  );

  return {
    text,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function normalizePollOption(input: unknown): Poll['options'][number] | null {
  if (typeof input === 'string') {
    const label = input.trim();
    return label ? { label } : null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const raw = input as Record<string, unknown>;
  const label = firstTrimmedString(raw.label, raw.text, raw.title, raw.name, raw.choice, raw.option);
  if (!label) return null;

  const voteCount = toCount(raw.voteCount ?? raw.vote_count ?? raw.votes ?? raw.count, -1);
  return {
    label,
    ...(voteCount >= 0 ? { voteCount } : {}),
  };
}

function normalizePoll(input: unknown): Poll | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const rawOptions = Array.isArray(raw.options)
    ? raw.options
    : Array.isArray(raw.choices)
      ? raw.choices
      : [];
  const options = rawOptions
    .map(normalizePollOption)
    .filter((option): option is Poll['options'][number] => option !== null);
  if (options.length === 0) return null;

  const totalVotes = toCount(raw.totalVotes ?? raw.total_votes ?? raw.voteCount ?? raw.vote_count ?? raw.votes, -1);
  const durationMinutes = toInteger(
    raw.durationMinutes ?? raw.duration_minutes ?? raw.remainingMinutes ?? raw.remaining_minutes ?? raw.timeRemainingMinutes,
    -1,
  );
  const endsAt = firstTrimmedString(raw.endsAt, raw.ends_at, raw.endTime, raw.end_time);

  return {
    options,
    ...(totalVotes >= 0 ? { totalVotes } : {}),
    ...(durationMinutes >= 0 ? { durationMinutes } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
}

function parseTweetStatusUrl(input: string | null | undefined): { username?: string; id?: string; url?: string } {
  const value = input?.trim();
  if (!value) return {};

  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
    if (!match) {
      return { url: parsed.toString() };
    }

    return {
      username: match[1],
      id: match[2],
      url: parsed.toString(),
    };
  } catch {
    return {};
  }
}

function normalizeTweetAuthorHandle(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/^@+/, '').trim();
  return normalized || null;
}

export function buildTweetStatusUrl(
  authorUsername: string | null | undefined,
  sourceId: string | null | undefined,
): string | null {
  const normalizedAuthorUsername = normalizeTweetAuthorHandle(authorUsername);
  if (!normalizedAuthorUsername) {
    return null;
  }

  const normalizedSourceId = normalizeTweetSourceId(sourceId?.trim() ?? '');
  const tweetId = /^\d+$/.test(normalizedSourceId)
    ? normalizedSourceId
    : parseTweetStatusUrl(normalizedSourceId).id ?? null;

  if (!tweetId) {
    return null;
  }

  return `https://x.com/${normalizedAuthorUsername}/status/${tweetId}`;
}

function normalizeQuoteMetrics(raw: Record<string, unknown>): FeedMetrics | null {
  const nestedMetrics = raw.metrics && typeof raw.metrics === 'object'
    ? raw.metrics as Record<string, unknown>
    : null;
  const likes = toCount(
    nestedMetrics?.likes
      ?? nestedMetrics?.likeCount
      ?? nestedMetrics?.favoriteCount
      ?? nestedMetrics?.favorite_count
      ?? nestedMetrics?.favorites
      ?? raw.likeCount
      ?? raw.favoriteCount
      ?? raw.favorite_count,
    -1,
  );
  const reposts = toCount(
    nestedMetrics?.reposts
      ?? nestedMetrics?.repostCount
      ?? nestedMetrics?.retweets
      ?? nestedMetrics?.retweetCount
      ?? nestedMetrics?.retweet_count
      ?? raw.repostCount
      ?? raw.retweetCount
      ?? raw.retweet_count,
    -1,
  );
  const replies = toCount(
    nestedMetrics?.replies
      ?? nestedMetrics?.replyCount
      ?? nestedMetrics?.reply_count
      ?? raw.replyCount
      ?? raw.reply_count,
    -1,
  );

  if (likes < 0 && reposts < 0 && replies < 0) {
    return null;
  }

  return {
    likes: Math.max(0, likes),
    reposts: Math.max(0, reposts),
    replies: Math.max(0, replies),
  };
}

function normalizeQuoteTweet(input: unknown): QuoteTweet | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const authorRaw = raw.author && typeof raw.author === 'object' ? raw.author as Record<string, unknown> : null;
  const parsedUrl = parseTweetStatusUrl(typeof raw.url === 'string' ? raw.url : null);
  const username = (
    authorRaw && typeof authorRaw.username === 'string' ? authorRaw.username
      : typeof raw.authorUsername === 'string' ? raw.authorUsername
        : typeof raw.username === 'string' ? raw.username
          : parsedUrl.username
  )?.trim() ?? '';
  const id = (
    typeof raw.id === 'string' ? raw.id
      : typeof raw.tweetId === 'string' ? raw.tweetId
        : typeof raw.quotedStatusId === 'string' ? raw.quotedStatusId
          : typeof raw.quotedStatusIdStr === 'string' ? raw.quotedStatusIdStr
            : parsedUrl.id
  )?.trim() ?? '';
  const text = (
    typeof raw.text === 'string' ? raw.text
      : typeof raw.full_text === 'string' ? raw.full_text
        : typeof raw.fullText === 'string' ? raw.fullText
          : ''
  ).trim();

  const media = Array.isArray(raw.media)
    ? raw.media.map(normalizeMediaItem).filter((item): item is MediaItem => item !== null)
    : [];
  const linkCard = normalizeLinkCard(raw.linkCard);
  const poll = normalizePoll(raw.poll);

  if (!username || (!text && media.length === 0 && !id && !parsedUrl.url && !linkCard && !poll)) return null;

  const quote: QuoteTweet = {
    text,
    author: {
      username,
    },
  };
  if (id) {
    quote.id = id;
  }

  const authorName = (
    authorRaw && typeof authorRaw.name === 'string' ? authorRaw.name
      : typeof raw.authorName === 'string' ? raw.authorName
        : ''
  ).trim();
  if (authorName) {
    quote.author.name = authorName;
  }

  const authorDisplayName = (
    authorRaw && typeof authorRaw.displayName === 'string' ? authorRaw.displayName
      : typeof raw.authorDisplayName === 'string' ? raw.authorDisplayName
        : ''
  ).trim();
  if (authorDisplayName) {
    quote.author.displayName = authorDisplayName;
  } else if (quote.author.name) {
    quote.author.displayName = quote.author.name;
  }

  const avatarFromAuthor = authorRaw && typeof authorRaw.avatarUrl === 'string' ? authorRaw.avatarUrl : null;
  const avatarFromProfile = authorRaw && typeof authorRaw.profileImageUrl === 'string' ? authorRaw.profileImageUrl : null;
  const avatarFromQuote = typeof raw.authorAvatarUrl === 'string'
    ? raw.authorAvatarUrl
    : typeof raw.authorProfileImageUrl === 'string'
      ? raw.authorProfileImageUrl
      : typeof raw.profileImageUrl === 'string'
        ? raw.profileImageUrl
        : null;
  const avatarUrl = avatarFromAuthor || avatarFromProfile || avatarFromQuote;
  if (avatarUrl) {
    quote.author.avatarUrl = avatarUrl;
  }

  quote.url = parsedUrl.url || (username && id ? `https://x.com/${username}/status/${id}` : undefined);
  if (media.length > 0) {
    quote.media = media;
  }

  const metrics = normalizeQuoteMetrics(raw);
  if (metrics) {
    quote.metrics = metrics;
  }

  if (typeof raw.publishedAt === 'string' && raw.publishedAt) {
    quote.publishedAt = raw.publishedAt;
  }

  const communityNote = normalizeCommunityNote(raw.communityNote ?? raw.community_note);
  if (communityNote) {
    quote.communityNote = communityNote;
  }
  if (linkCard) {
    quote.linkCard = linkCard;
  }
  if (poll) {
    quote.poll = poll;
  }

  return quote;
}

function normalizeLinkCard(input: unknown): LinkCard | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (!url) return null;

  const title = typeof raw.title === 'string' ? raw.title : '';
  const domain = typeof raw.domain === 'string' ? raw.domain : '';

  const card: LinkCard = {
    type: typeof raw.type === 'string' && raw.type ? raw.type : 'link',
    url,
    title,
    domain,
  };

  const imageUrl = firstTrimmedString(raw.imageUrl, raw.image_url, raw.image, raw.thumbnailUrl, raw.thumbnail_url);
  if (imageUrl) card.imageUrl = imageUrl;
  const imageAlt = firstTrimmedString(raw.imageAlt, raw.image_alt, raw.alt, raw.altText, raw.alt_text);
  if (imageAlt) card.imageAlt = imageAlt;
  if (typeof raw.videoId === 'string' && raw.videoId.trim()) card.videoId = raw.videoId;
  if (typeof raw.description === 'string' && raw.description.trim()) card.description = raw.description;

  return card;
}

function normalizeLinkPreview(input: unknown): LinkPreview | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (!url) return null;

  const title = typeof raw.title === 'string' ? raw.title : '';
  const domain = typeof raw.domain === 'string' ? raw.domain : '';

  const preview: LinkPreview = {
    url,
    title,
    domain,
  };

  const image = typeof raw.image === 'string'
    ? raw.image
    : typeof raw.imageUrl === 'string'
      ? raw.imageUrl
      : '';
  if (image.trim()) preview.image = image;
  const imageAlt = firstTrimmedString(raw.imageAlt, raw.image_alt, raw.alt, raw.altText, raw.alt_text);
  if (imageAlt) preview.imageAlt = imageAlt;

  if (typeof raw.description === 'string' && raw.description.trim()) {
    preview.description = raw.description;
  }

  return preview;
}

function normalizeFeedMediaType(input: unknown): FeedMediaType | null {
  const type = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (type === 'photo' || type === 'image') return 'photo';
  if (type === 'video') return 'video';
  if (type === 'animated_gif' || type === 'gif') return 'animated_gif';
  return null;
}

const normalizedMetadataKeys = new Set([
  'incidentKey',
  'inReplyToStatusId',
  'conversationId',
  'thread',
  'prominence',
  'replyCapture',
  'media',
  'mediaTypes',
  'communityNote',
  'community_note',
  'quotedTweet',
  'linkCard',
  'poll',
  'linkPreviews',
  'article',
  'suggestionType',
  'reflectionCycle',
  'configField',
  'configFile',
  'proposedValue',
  'taskId',
  'taskSummary',
  'codeFixTaskFamily',
  'codeFixAttemptNumber',
  'codeFixRetryOfTaskId',
  'codeFixPreviousTaskId',
  'codeFixImpactFiles',
  'codeFixOrchestratorBatchId',
  'codeFixOrchestratorStatus',
  'codeFixBlockedByTaskId',
  'codeFixFailure',
  'suggestionStatus',
  'diff',
  'chatMessageId',
  'chatReplyToMessageId',
  'chatSuggestionIndex',
  'severity',
  'autoResolveCondition',
  'dismissable',
  'notificationId',
  'repairCoordinator',
  'repairOriginSuggestionId',
  'repairOriginTaskId',
  'fullEnrichmentRequestId',
  'expiresAt',
  'urlEntities',
  'likeCount',
  'repostCount',
  'replyCount',
  'viewCount',
  'isRetweet',
  'retweetedBy',
]);

function getPassthroughMetadata(raw: Record<string, unknown>): FeedMetadata {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !normalizedMetadataKeys.has(key)),
  ) as FeedMetadata;
}

const normalizedThreadMetadataKeys = new Set([
  'threadId',
  'threadTitle',
  'threadRationale',
  'continuing',
  'prominence',
]);

function normalizeThreadMetadata(input: unknown): FeedThreadMetadata | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : '';
  if (!threadId) return null;

  const thread = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !normalizedThreadMetadataKeys.has(key)),
  ) as FeedThreadMetadata;

  thread.threadId = threadId;

  if (typeof raw.threadTitle === 'string' && raw.threadTitle.trim()) {
    thread.threadTitle = raw.threadTitle.trim();
  }

  if (typeof raw.threadRationale === 'string' && raw.threadRationale.trim()) {
    thread.threadRationale = raw.threadRationale.trim();
  }

  if (typeof raw.continuing === 'boolean') {
    thread.continuing = raw.continuing;
  }

  const prominence = normalizeFeedProminence(raw.prominence);
  if (prominence) {
    thread.prominence = prominence;
  }

  return thread;
}

function normalizeMetadata(input: unknown): FeedMetadata | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  const metadata: FeedMetadata = getPassthroughMetadata(raw);

  if (typeof raw.incidentKey === 'string' && raw.incidentKey.trim()) {
    metadata.incidentKey = raw.incidentKey.trim();
  }

  if (typeof raw.inReplyToStatusId === 'string' && raw.inReplyToStatusId.trim()) {
    metadata.inReplyToStatusId = raw.inReplyToStatusId.trim();
  }

  if (typeof raw.conversationId === 'string' && raw.conversationId.trim()) {
    metadata.conversationId = raw.conversationId.trim();
  }

  const thread = normalizeThreadMetadata(raw.thread);
  if (thread) {
    metadata.thread = thread;
  }

  const replyCapture = normalizeReplyCaptureMetadata(raw.replyCapture);
  if (replyCapture) {
    metadata.replyCapture = replyCapture;
  }

  const prominence = normalizeFeedProminence(raw.prominence);
  if (prominence) {
    metadata.prominence = prominence;
  }

  if (Array.isArray(raw.media)) {
    const media = raw.media.map(normalizeMediaItem).filter((item): item is MediaItem => item !== null);
    if (media.length > 0) metadata.media = media;
  }

  if (Array.isArray(raw.mediaTypes)) {
    const mediaTypes = raw.mediaTypes
      .map(normalizeFeedMediaType)
      .filter((item): item is FeedMediaType => item !== null);
    if (mediaTypes.length > 0) metadata.mediaTypes = mediaTypes;
  }

  const communityNote = normalizeCommunityNote(raw.communityNote ?? raw.community_note);
  if (communityNote) metadata.communityNote = communityNote;

  const quote = normalizeQuoteTweet(raw.quotedTweet);
  if (quote) metadata.quotedTweet = quote;

  const linkCard = normalizeLinkCard(raw.linkCard);
  if (linkCard) metadata.linkCard = linkCard;

  const poll = normalizePoll(raw.poll);
  if (poll) metadata.poll = poll;

  if (Array.isArray(raw.linkPreviews)) {
    const linkPreviews = raw.linkPreviews
      .map(normalizeLinkPreview)
      .filter((item): item is LinkPreview => item !== null);

    if (linkPreviews.length > 0) {
      metadata.linkPreviews = linkPreviews;
    }
  }

  if (raw.article && typeof raw.article === 'object' && !Array.isArray(raw.article)) {
    metadata.article = raw.article as Record<string, unknown>;
  }

  if (typeof raw.suggestionType === 'string' && raw.suggestionType.trim()) {
    metadata.suggestionType = raw.suggestionType.trim();
  }

  if (typeof raw.reflectionCycle === 'boolean') {
    metadata.reflectionCycle = raw.reflectionCycle;
  }

  if (typeof raw.configField === 'string' && raw.configField.trim()) {
    metadata.configField = raw.configField.trim();
  }

  if (typeof raw.configFile === 'string' && raw.configFile.trim()) {
    metadata.configFile = raw.configFile.trim();
  }

  if (typeof raw.proposedValue === 'string' && raw.proposedValue.trim()) {
    metadata.proposedValue = raw.proposedValue.trim();
  }

  if (typeof raw.taskId === 'string' && raw.taskId.trim()) {
    metadata.taskId = raw.taskId.trim();
  }

  if (typeof raw.taskSummary === 'string' && raw.taskSummary.trim()) {
    metadata.taskSummary = raw.taskSummary.trim();
  }

  if (typeof raw.codeFixTaskFamily === 'string' && raw.codeFixTaskFamily.trim()) {
    metadata.codeFixTaskFamily = raw.codeFixTaskFamily.trim();
  }

  if (typeof raw.codeFixAttemptNumber === 'number' && Number.isInteger(raw.codeFixAttemptNumber) && raw.codeFixAttemptNumber > 0) {
    metadata.codeFixAttemptNumber = raw.codeFixAttemptNumber;
  }

  if (typeof raw.codeFixRetryOfTaskId === 'string' && raw.codeFixRetryOfTaskId.trim()) {
    metadata.codeFixRetryOfTaskId = raw.codeFixRetryOfTaskId.trim();
  }

  if (typeof raw.codeFixPreviousTaskId === 'string' && raw.codeFixPreviousTaskId.trim()) {
    metadata.codeFixPreviousTaskId = raw.codeFixPreviousTaskId.trim();
  }

  if (Array.isArray(raw.codeFixImpactFiles)) {
    const codeFixImpactFiles = raw.codeFixImpactFiles
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (codeFixImpactFiles.length > 0) {
      metadata.codeFixImpactFiles = codeFixImpactFiles;
    }
  }

  if (typeof raw.codeFixOrchestratorBatchId === 'string' && raw.codeFixOrchestratorBatchId.trim()) {
    metadata.codeFixOrchestratorBatchId = raw.codeFixOrchestratorBatchId.trim();
  }

  if (typeof raw.codeFixOrchestratorStatus === 'string' && raw.codeFixOrchestratorStatus.trim()) {
    metadata.codeFixOrchestratorStatus = raw.codeFixOrchestratorStatus.trim();
  }

  if (typeof raw.codeFixBlockedByTaskId === 'string' && raw.codeFixBlockedByTaskId.trim()) {
    metadata.codeFixBlockedByTaskId = raw.codeFixBlockedByTaskId.trim();
  }

  if (raw.codeFixFailure && typeof raw.codeFixFailure === 'object' && !Array.isArray(raw.codeFixFailure)) {
    const failureRaw = raw.codeFixFailure as Record<string, unknown>;
    const summary = typeof failureRaw.summary === 'string' && failureRaw.summary.trim()
      ? failureRaw.summary.trim()
      : '';
    const category = typeof failureRaw.category === 'string' && failureRaw.category.trim()
      ? failureRaw.category.trim()
      : '';
    const fingerprint = typeof failureRaw.fingerprint === 'string' && failureRaw.fingerprint.trim()
      ? failureRaw.fingerprint.trim()
      : '';

    if (summary && category && fingerprint) {
      metadata.codeFixFailure = {
        category,
        fingerprint,
        incidentKey: typeof failureRaw.incidentKey === 'string' && failureRaw.incidentKey.trim()
          ? failureRaw.incidentKey.trim()
          : null,
        summary,
        phase: typeof failureRaw.phase === 'string' && failureRaw.phase.trim()
          ? failureRaw.phase.trim()
          : null,
        error: typeof failureRaw.error === 'string' && failureRaw.error.trim()
          ? failureRaw.error.trim()
          : null,
        ...(typeof failureRaw.terminalReason === 'string' && failureRaw.terminalReason.trim()
          ? { terminalReason: failureRaw.terminalReason.trim() }
          : {}),
        ...(typeof failureRaw.evidence === 'string' && failureRaw.evidence.trim()
          ? { evidence: failureRaw.evidence.trim() }
          : {}),
        terminal: failureRaw.terminal !== false,
        autoRepairEligible: failureRaw.autoRepairEligible === true,
        repair: failureRaw.repair && typeof failureRaw.repair === 'object' && !Array.isArray(failureRaw.repair)
          ? {
              suggestionId: typeof (failureRaw.repair as Record<string, unknown>).suggestionId === 'string'
                ? (failureRaw.repair as Record<string, unknown>).suggestionId as string
                : null,
              taskId: typeof (failureRaw.repair as Record<string, unknown>).taskId === 'string'
                ? (failureRaw.repair as Record<string, unknown>).taskId as string
                : null,
              status: typeof (failureRaw.repair as Record<string, unknown>).status === 'string'
                ? (failureRaw.repair as Record<string, unknown>).status as SuggestionStatus
                : null,
            }
          : null,
        ...(typeof failureRaw.callbackStatus === 'string' && failureRaw.callbackStatus.trim()
          ? { callbackStatus: failureRaw.callbackStatus.trim() }
          : {}),
        ...(typeof failureRaw.callbackFingerprint === 'string' && failureRaw.callbackFingerprint.trim()
          ? { callbackFingerprint: failureRaw.callbackFingerprint.trim() }
          : {}),
        ...(typeof failureRaw.callbackQueuedAt === 'string' && failureRaw.callbackQueuedAt.trim()
          ? { callbackQueuedAt: failureRaw.callbackQueuedAt.trim() }
          : {}),
        ...(typeof failureRaw.callbackUpdatedAt === 'string' && failureRaw.callbackUpdatedAt.trim()
          ? { callbackUpdatedAt: failureRaw.callbackUpdatedAt.trim() }
          : {}),
        ...(typeof failureRaw.callbackMessageId === 'string' && failureRaw.callbackMessageId.trim()
          ? { callbackMessageId: failureRaw.callbackMessageId.trim() }
          : {}),
        ...(typeof failureRaw.callbackError === 'string' && failureRaw.callbackError.trim()
          ? { callbackError: failureRaw.callbackError.trim() }
          : {}),
        ...(typeof failureRaw.notificationId === 'string' && failureRaw.notificationId.trim()
          ? { notificationId: failureRaw.notificationId.trim() }
          : {}),
        ...(typeof failureRaw.originSessionId === 'string' && failureRaw.originSessionId.trim()
          ? { originSessionId: failureRaw.originSessionId.trim() }
          : {}),
      };
    }
  }

  const suggestionStatus = typeof raw.suggestionStatus === 'string' ? raw.suggestionStatus.trim().toLowerCase() : '';
  if (
    suggestionStatus === 'pending'
    || suggestionStatus === 'accepted'
    || suggestionStatus === 'dismissed'
    || suggestionStatus === 'dispatched'
    || suggestionStatus === 'running'
    || suggestionStatus === 'merged'
    || suggestionStatus === 'failed'
  ) {
    metadata.suggestionStatus = suggestionStatus;
  }

  if (raw.diff === null) {
    metadata.diff = null;
  } else if (typeof raw.diff === 'string' && raw.diff.trim()) {
    metadata.diff = raw.diff;
  }

  if (typeof raw.chatMessageId === 'string' && raw.chatMessageId.trim()) {
    metadata.chatMessageId = raw.chatMessageId.trim();
  }

  if (typeof raw.chatReplyToMessageId === 'string' && raw.chatReplyToMessageId.trim()) {
    metadata.chatReplyToMessageId = raw.chatReplyToMessageId.trim();
  }

  if (typeof raw.chatSuggestionIndex === 'number' && Number.isInteger(raw.chatSuggestionIndex) && raw.chatSuggestionIndex >= 0) {
    metadata.chatSuggestionIndex = raw.chatSuggestionIndex;
  }

  const severity = typeof raw.severity === 'string' ? raw.severity.trim().toLowerCase() : '';
  if (severity === 'info' || severity === 'warning' || severity === 'error') {
    metadata.severity = severity;
  }

  if (typeof raw.autoResolveCondition === 'string' && raw.autoResolveCondition.trim()) {
    metadata.autoResolveCondition = raw.autoResolveCondition.trim();
  }

  if (typeof raw.dismissable === 'boolean') {
    metadata.dismissable = raw.dismissable;
  }

  if (typeof raw.notificationId === 'string' && raw.notificationId.trim()) {
    metadata.notificationId = raw.notificationId.trim();
  }

  if (typeof raw.repairCoordinator === 'boolean') {
    metadata.repairCoordinator = raw.repairCoordinator;
  }

  if (typeof raw.repairOriginSuggestionId === 'string' && raw.repairOriginSuggestionId.trim()) {
    metadata.repairOriginSuggestionId = raw.repairOriginSuggestionId.trim();
  }

  if (typeof raw.repairOriginTaskId === 'string' && raw.repairOriginTaskId.trim()) {
    metadata.repairOriginTaskId = raw.repairOriginTaskId.trim();
  }

  if (typeof raw.fullEnrichmentRequestId === 'string' && raw.fullEnrichmentRequestId.trim()) {
    metadata.fullEnrichmentRequestId = raw.fullEnrichmentRequestId.trim();
  }

  if (typeof raw.expiresAt === 'string' && raw.expiresAt.trim()) {
    const expiresAt = new Date(raw.expiresAt.trim());
    if (!Number.isNaN(expiresAt.getTime())) {
      metadata.expiresAt = expiresAt.toISOString();
    }
  }

  if (Array.isArray(raw.urlEntities)) {
    const entities = raw.urlEntities
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        url: typeof entry.url === 'string' ? entry.url : '',
        expandedUrl: typeof entry.expandedUrl === 'string'
          ? entry.expandedUrl
          : typeof entry.expanded_url === 'string'
            ? entry.expanded_url
            : undefined,
        displayUrl: typeof entry.displayUrl === 'string'
          ? entry.displayUrl
          : typeof entry.display_url === 'string'
            ? entry.display_url
            : undefined,
      }))
      .filter((entry) => entry.url);

    if (entities.length > 0) {
      metadata.urlEntities = entities;
    }
  }

  const likeCount = toCount(raw.likeCount, -1);
  if (likeCount >= 0) {
    metadata.likeCount = likeCount;
  }

  const repostCount = toCount(raw.repostCount, -1);
  if (repostCount >= 0) {
    metadata.repostCount = repostCount;
  }

  const replyCount = toCount(raw.replyCount, -1);
  if (replyCount >= 0) {
    metadata.replyCount = replyCount;
  }

  const viewCount = toCount(raw.viewCount, -1);
  if (viewCount >= 0) {
    metadata.viewCount = viewCount;
  }

  if (typeof raw.isRetweet === 'boolean') {
    metadata.isRetweet = raw.isRetweet;
  }

  if (raw.retweetedBy && typeof raw.retweetedBy === 'object') {
    const retweetedByRaw = raw.retweetedBy as Record<string, unknown>;
    const retweetedBy: FeedMetadata['retweetedBy'] = {};

    if (typeof retweetedByRaw.username === 'string' && retweetedByRaw.username.trim()) {
      retweetedBy.username = retweetedByRaw.username;
    }

    if (typeof retweetedByRaw.displayName === 'string' && retweetedByRaw.displayName.trim()) {
      retweetedBy.displayName = retweetedByRaw.displayName;
    }

    if (Object.keys(retweetedBy).length > 0) {
      metadata.retweetedBy = retweetedBy;
    }
  }

  if (Array.isArray(metadata.media)) {
    const media = dedupeFeedMediaItems(metadata.media);
    if (media.length > 0) {
      metadata.media = media;
    } else {
      delete metadata.media;
    }
  }

  const derivedMediaTypes = getDerivedFeedMediaTypes(metadata);
  if (derivedMediaTypes.length > 0) {
    metadata.mediaTypes = derivedMediaTypes;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function buildQuotedTweetMetadata(
  quote: QuoteTweet,
  media: MediaItem[],
  mediaTypes: FeedMediaType[],
): FeedMetadata | null {
  const metadata: FeedMetadata = {};

  if (media.length > 0) {
    metadata.media = media;
    metadata.mediaTypes = mediaTypes;
  }

  if (quote.communityNote) {
    metadata.communityNote = quote.communityNote;
  }
  if (quote.linkCard) {
    metadata.linkCard = quote.linkCard;
  }
  if (quote.poll) {
    metadata.poll = quote.poll;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function buildQuotedTweetFeedItem(
  quote: QuoteTweet,
  parentItem: FeedItem | null,
  identifier: string,
): FeedItem {
  const normalizedMedia = Array.isArray(quote.media) ? quote.media : [];
  const { mediaUrls, mediaTypes } = getFeedMediaUrlsAndTypes(normalizedMedia);
  const routeId = quote.id?.trim() || identifier.trim() || quote.url?.trim() || randomUUID();
  const sourceId = quote.id?.trim() || quote.url?.trim() || identifier.trim() || null;
  const publishedAt = parentItem?.publishedAt ?? new Date().toISOString();
  const createdAt = parentItem?.createdAt ?? publishedAt;

  return {
    id: routeId,
    type: 'tweet',
    source: parentItem?.source ?? 'twitter',
    sourceId,
    parentId: null,
    relationship: null,
    title: null,
    text: quote.text,
    url: quote.url ?? null,
    excerpt: null,
    authorUsername: quote.author.username,
    authorDisplayName: quote.author.displayName || quote.author.name || null,
    reason: null,
    tags: [],
    mediaUrls,
    metrics: quote.metrics ?? {
      likes: 0,
      reposts: 0,
      replies: 0,
    },
    authorAvatarUrl: quote.author.avatarUrl ?? null,
    isLiked: false,
    isDisliked: false,
    analysisPresentation: null,
    metadata: buildQuotedTweetMetadata(quote, normalizedMedia, mediaTypes),
    publishedAt,
    createdAt,
  };
}

function buildQuotedTweetChildInput(parentItem: FeedItem, quote: QuoteTweet): FeedInsertInput | null {
  const normalizedMedia = Array.isArray(quote.media) ? quote.media : [];
  const { mediaUrls, mediaTypes } = getFeedMediaUrlsAndTypes(normalizedMedia);
  const quoteIdentifier = quote.id?.trim() || parseTweetStatusUrl(quote.url).id?.trim() || '';
  const sourceId = quoteIdentifier || quote.url?.trim() || null;

  if (!sourceId) {
    return null;
  }

  return {
    id: quoteIdentifier || randomUUID(),
    type: 'tweet',
    source: parentItem.source ?? 'twitter',
    sourceId,
    parentId: parentItem.id,
    relationship: 'child',
    title: null,
    text: quote.text.trim() || 'Quoted tweet',
    url: quote.url ?? null,
    excerpt: null,
    authorUsername: quote.author.username || null,
    authorDisplayName: quote.author.displayName || quote.author.name || null,
    authorAvatarUrl: quote.author.avatarUrl ?? null,
    reason: EMBEDDED_QUOTED_TWEET_REASON,
    tags: [],
    mediaUrls,
    metrics: quote.metrics ?? {
      likes: 0,
      reposts: 0,
      replies: 0,
    },
    metadata: buildQuotedTweetMetadata(quote, normalizedMedia, mediaTypes),
    publishedAt: parentItem.publishedAt,
  };
}

function parseIncidentExpiresAt(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return null;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isActiveIncidentSuggestionStatus(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (
    normalized === 'pending'
    || normalized === 'accepted'
    || normalized === 'dispatched'
    || normalized === 'running'
  );
}

export function getActiveFeedItemByIncidentKey(
  incidentKey: string,
  type?: FeedItemType | null,
): FeedItem | null {
  const normalizedKey = incidentKey.trim();
  if (!normalizedKey) {
    return null;
  }

  const db = getDb();
  const rows = type
    ? db.prepare(`
      SELECT *
      FROM feed
      WHERE type = @type
        AND json_extract(metadata, '$.incidentKey') = @incident_key
      ORDER BY created_at_ms DESC, created_at DESC, id DESC
    `).all({
      type,
      incident_key: normalizedKey,
    }) as FeedRow[]
    : db.prepare(`
      SELECT *
      FROM feed
      WHERE json_extract(metadata, '$.incidentKey') = @incident_key
      ORDER BY created_at_ms DESC, created_at DESC, id DESC
    `).all({
      incident_key: normalizedKey,
    }) as FeedRow[];

  const nowMs = Date.now();

  for (const row of rows) {
    const item = rowToFeedItem(row);
    if (item.type === 'notification') {
      const expiresAtMs = parseIncidentExpiresAt(item.metadata?.expiresAt);
      if (item.suggestionStatus === 'dismissed' || (expiresAtMs !== null && expiresAtMs <= nowMs)) {
        continue;
      }
      return item;
    }

    if (item.type === 'suggestion' && isActiveIncidentSuggestionStatus(item.suggestionStatus ?? item.metadata?.suggestionStatus)) {
      return item;
    }
  }

  return null;
}

function upsertQuotedTweetChild(parentItem: FeedItem, quote: QuoteTweet): FeedItem | null {
  const input = buildQuotedTweetChildInput(parentItem, quote);
  if (!input?.sourceId) {
    return null;
  }

  const existing = getFeedItemBySourceId(input.sourceId) ?? findTweetFeedItemByIdentifier(input.sourceId);
  if (!existing) {
    insertOrIgnoreFeedItem(input);
    return getFeedItemBySourceId(input.sourceId) ?? getFeedItemById(input.id ?? '');
  }

  const isManagedQuote = existing.reason === EMBEDDED_QUOTED_TWEET_REASON || existing.parentId === parentItem.id;
  if (!isManagedQuote) {
    return existing;
  }

  const existingMetadata = existing.metadata as Record<string, unknown> | null;
  const incomingMetadata = input.metadata as Record<string, unknown> | null;
  const mergedMetadata = incomingMetadata
    ? existingMetadata
      ? mergeRecordsDeep(existingMetadata, incomingMetadata)
      : incomingMetadata
    : existingMetadata;

  getDb().prepare(`
    UPDATE feed
    SET
      parent_id = COALESCE(parent_id, @parent_id),
      relationship = COALESCE(relationship, @relationship),
      text = @text,
      url = COALESCE(@url, url),
      author_username = COALESCE(@author_username, author_username),
      author_display_name = COALESCE(@author_display_name, author_display_name),
      author_avatar_url = COALESCE(@author_avatar_url, author_avatar_url),
      reason = @reason,
      tags = @tags,
      media_urls = @media_urls,
      metrics_likes = @metrics_likes,
      metrics_reposts = @metrics_reposts,
      metrics_replies = @metrics_replies,
      metrics_views = @metrics_views,
      metadata = @metadata
    WHERE id = @id
  `).run({
    id: existing.id,
    parent_id: existing.parentId ?? input.parentId,
    relationship: existing.relationship ?? input.relationship,
    text: input.text,
    url: input.url ?? null,
    author_username: input.authorUsername ?? null,
    author_display_name: input.authorDisplayName ?? null,
    author_avatar_url: input.authorAvatarUrl ?? null,
    reason: EMBEDDED_QUOTED_TWEET_REASON,
    tags: JSON.stringify(input.tags ?? []),
    media_urls: JSON.stringify(input.mediaUrls ?? []),
    metrics_likes: input.metrics?.likes ?? 0,
    metrics_reposts: input.metrics?.reposts ?? 0,
    metrics_replies: input.metrics?.replies ?? 0,
    metrics_views: typeof input.metrics?.views === 'number' ? input.metrics.views : null,
    metadata: mergedMetadata ? JSON.stringify(mergedMetadata) : null,
  });

  return getFeedItemById(existing.id);
}

function persistEmbeddedQuotedTweet(parentItem: FeedItem | null): FeedItem | null {
  const quote = parentItem?.metadata?.quotedTweet;
  if (!parentItem || !quote) {
    return null;
  }

  return upsertQuotedTweetChild(parentItem, quote);
}

function findQuotedTweetMatchByIdentifier(identifier: string): QuotedTweetMatch | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  const db = getDb();
  const tweetIdMatch = trimmed.match(/\/status\/(\d+)/);
  const tweetId = tweetIdMatch?.[1] ?? (/^\d+$/.test(trimmed) ? trimmed : null);
  const parsedIdentifierUrl = parseTweetStatusUrl(trimmed).url ?? null;

  const rows = db.prepare(`
    SELECT *
    FROM feed
    WHERE type = 'tweet'
      AND metadata IS NOT NULL
      AND lower(COALESCE(source, '')) IN ('twitter', 'x')
    ORDER BY created_at_ms DESC
  `).all() as FeedRow[];

  for (const row of rows) {
    const parentItem = rowToFeedItem(row);
    const quote = parentItem.metadata?.quotedTweet;
    if (!quote) continue;

    const quoteUrl = quote.url?.trim() ?? null;
    const quoteTweetId = quote.id?.trim()
      || (quoteUrl ? parseTweetStatusUrl(quoteUrl).id : undefined)
      || null;

    const isMatch = quoteTweetId === trimmed
      || Boolean(tweetId && quoteTweetId === tweetId)
      || quoteUrl === trimmed
      || (Boolean(parsedIdentifierUrl) && quoteUrl === parsedIdentifierUrl);

    if (!isMatch) continue;

    return {
      parentItem,
      quote,
    };
  }

  return null;
}

function findQuotedTweetFeedItemByIdentifier(identifier: string): FeedItem | null {
  const trimmed = identifier.trim();
  const match = findQuotedTweetMatchByIdentifier(trimmed);
  if (!match) return null;
  return buildQuotedTweetFeedItem(match.quote, match.parentItem, trimmed);
}

function rowToFeedItem(row: FeedRow): FeedItem {
  const metadata = normalizeMetadata(parseJsonRecord(row.metadata));
  const shouldShowThread = row.display_thread_active !== 0;

  return {
    id: row.id,
    type: row.type as FeedItemType,
    source: row.source,
    sourceId: row.source_id,
    originSessionId: row.origin_session_id,
    parentId: row.parent_id,
    relationship: normalizeRelationship(row.relationship),
    title: row.title,
    text: row.text,
    url: row.url,
    excerpt: row.excerpt,
    authorUsername: row.author_username,
    authorDisplayName: row.author_display_name,
    reason: row.reason,
    tags: parseJsonArray(row.tags),
    mediaUrls: parseJsonArray(row.media_urls),
    displayOrder: typeof row.display_order === 'number' ? row.display_order : null,
    threadId: shouldShowThread ? row.thread_id : null,
    displaySubtitle: row.display_subtitle,
    threadTitle: shouldShowThread ? row.display_thread_title ?? null : null,
    threadSubtitle: shouldShowThread ? row.display_thread_subtitle ?? null : null,
    metrics: {
      likes: toCount(row.metrics_likes),
      reposts: toCount(row.metrics_reposts),
      replies: toCount(row.metrics_replies),
      ...(typeof row.metrics_views === 'number' ? { views: toCount(row.metrics_views) } : {}),
    },
    authorAvatarUrl: row.author_avatar_url,
    isLiked: false,
    isDisliked: false,
    suggestionStatus: metadata?.suggestionStatus,
    analysisPresentation: null,
    metadata,
    publishedAt: normalizeUtcTimestamp(row.published_at),
    createdAt: normalizeUtcTimestamp(row.created_at),
  };
}

function normalizeMetrics(input: Record<string, unknown>): FeedMetrics {
  const rawMetrics = input.metrics && typeof input.metrics === 'object'
    ? input.metrics as Record<string, unknown>
    : null;

  const likes = toCount(
    rawMetrics?.likes
      ?? rawMetrics?.likeCount
      ?? input.metrics_likes
      ?? input.metricsLikes
      ?? input.likeCount
  );

  const reposts = toCount(
    rawMetrics?.reposts
      ?? rawMetrics?.retweets
      ?? rawMetrics?.retweetCount
      ?? input.metrics_reposts
      ?? input.metricsReposts
      ?? input.retweetCount
      ?? input.repostCount
  );

  const replies = toCount(
    rawMetrics?.replies
      ?? rawMetrics?.replyCount
      ?? input.metrics_replies
      ?? input.metricsReplies
      ?? input.replyCount
  );

  const viewsValue = rawMetrics?.views
    ?? rawMetrics?.viewCount
    ?? input.metrics_views
    ?? input.metricsViews
    ?? input.viewCount;

  const metrics: FeedMetrics = {
    likes,
    reposts,
    replies,
  };

  const parsedViews = toCount(viewsValue, -1);
  if (parsedViews >= 0) {
    metrics.views = parsedViews;
  }

  return metrics;
}

export function normalizeType(input: unknown): FeedItemType | null {
  const value = typeof input === 'string' ? input.toLowerCase() : '';
  if (allowedFeedTypes.includes(value as FeedItemType)) {
    return value as FeedItemType;
  }
  return null;
}

export function normalizeRelationship(input: unknown): FeedRelationship | null {
  const value = typeof input === 'string' ? input.toLowerCase().trim() : '';
  if (!value) return null;
  if (allowedRelationships.includes(value as FeedRelationship)) {
    return value as FeedRelationship;
  }
  return null;
}

export function normalizeStringArray(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        return parsed.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
      }
    } catch {
      return input
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function normalizeMetadataInput(input: unknown): FeedMetadata | null {
  if (!input) return null;
  if (typeof input === 'string') {
    try {
      return normalizeMetadata(JSON.parse(input));
    } catch {
      return null;
    }
  }
  return normalizeMetadata(input);
}

function parseMetadataRecordInput(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === 'string') {
    return parseJsonRecord(input);
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAgentCreatedSource(source: string | null | undefined): boolean {
  const normalized = source?.trim().toLowerCase() ?? '';
  const legacyAgentSourceHyphen = ['media', 'agent'].join('-');
  const legacyAgentSourceCompact = ['media', 'agent'].join('');
  const legacyAgentSourceUnderscore = ['media', 'agent'].join('_');
  return normalized === 'claude'
    || normalized === 'evogent'
    || normalized === legacyAgentSourceHyphen
    || normalized === legacyAgentSourceCompact
    || normalized === legacyAgentSourceUnderscore;
}

function getKnownAuthorAvatarUrl(
  authorUsername: string | null | undefined,
  source: string | null | undefined,
): string | null {
  const normalizedAuthorUsername = authorUsername?.trim();
  const normalizedSource = source?.trim();
  if (!normalizedAuthorUsername || !normalizedSource) {
    return null;
  }

  const row = getDb().prepare(`
    SELECT author_avatar_url
    FROM feed
    WHERE author_username = ?
      AND source = ?
      AND author_avatar_url IS NOT NULL
      AND author_avatar_url != ''
    ORDER BY created_at_ms DESC
    LIMIT 1
  `).get(normalizedAuthorUsername, normalizedSource) as { author_avatar_url: string | null } | undefined;

  return firstTrimmedString(row?.author_avatar_url);
}

function mergeRecordsDeep(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = merged[key];
    if (isPlainRecord(baseValue) && isPlainRecord(patchValue)) {
      merged[key] = mergeRecordsDeep(baseValue, patchValue);
    } else {
      merged[key] = patchValue;
    }
  }

  return merged;
}

export function normalizeFeedInput(input: unknown): FeedInsertInput | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;

  const type = normalizeType(raw.type);
  if (!type) return null;
  const source = typeof raw.source === 'string' ? raw.source : null;
  const isAgentCreatedContent = isAgentCreatedSource(source) || type === 'analysis';

  const publishedAtRaw = typeof raw.published_at === 'string'
    ? raw.published_at
    : typeof raw.publishedAt === 'string'
      ? raw.publishedAt
      : new Date().toISOString();

  const publishedAt = isAgentCreatedContent
    ? new Date().toISOString()
    : (() => {
      const parsedDate = new Date(publishedAtRaw);
      const clampedDate = Number.isNaN(parsedDate.getTime())
        ? new Date()
        : new Date(Math.min(parsedDate.getTime(), Date.now()));
      return clampedDate.toISOString();
    })();

  let sourceId = typeof raw.source_id === 'string'
    ? raw.source_id
    : typeof raw.sourceId === 'string'
      ? raw.sourceId
      : typeof raw.url === 'string'
        ? raw.url
        : null;
  if (type === 'tweet' && typeof sourceId === 'string') {
    sourceId = normalizeTweetSourceId(sourceId);
  }
  const parentId = typeof raw.parent_id === 'string'
    ? raw.parent_id
    : typeof raw.parentId === 'string'
      ? raw.parentId
      : null;

  const author = (raw.author && typeof raw.author === 'object') ? (raw.author as Record<string, unknown>) : null;
  let metadata = dedupeMetadataMedia(normalizeMetadataInput(raw.metadata));
  const fallbackMedia = metadata?.media ? getFeedMediaUrlsAndTypes(metadata.media) : null;

  const fallbackMediaUrls = dedupeFeedMediaUrls(fallbackMedia?.mediaUrls ?? []);

  const initialMediaUrls = dedupeFeedMediaUrls(normalizeStringArray(raw.media_urls ?? raw.mediaUrls));
  let mediaUrls = initialMediaUrls.length > 0 ? initialMediaUrls : fallbackMediaUrls;
  let url = typeof raw.url === 'string' ? raw.url : null;
  let title = typeof raw.title === 'string' ? raw.title : null;
  let excerpt = typeof raw.excerpt === 'string' ? raw.excerpt : null;
  let authorUsername = typeof raw.author_username === 'string'
    ? raw.author_username
    : typeof raw.authorUsername === 'string'
      ? raw.authorUsername
      : author && typeof author.username === 'string'
        ? author.username
        : null;
  let authorDisplayName = typeof raw.author_display_name === 'string'
    ? raw.author_display_name
    : typeof raw.authorDisplayName === 'string'
      ? raw.authorDisplayName
      : author && typeof author.display_name === 'string'
        ? author.display_name
        : author && typeof author.displayName === 'string'
          ? author.displayName
          : null;
  const incomingAuthorAvatarUrl = firstTrimmedString(
    raw.author_avatar_url,
    raw.authorAvatarUrl,
    author?.avatarUrl,
    author?.profileImageUrl,
  );
  const authorAvatarUrl = incomingAuthorAvatarUrl ?? getKnownAuthorAvatarUrl(authorUsername, source);

  const rawMetadataRecord = (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata))
    ? raw.metadata as Record<string, unknown>
    : null;
  const youtubeData = getYouTubeFeedData({
    source,
    sourceId,
    url,
    title,
    text,
    authorUsername,
    authorDisplayName,
    metadata: rawMetadataRecord ?? metadata,
    mediaUrls,
  });

  if (type === 'article' && isYouTubeSource(source) && youtubeData) {
    sourceId = youtubeData.videoId;
    url = youtubeData.canonicalUrl;
    if (!title && youtubeData.title) {
      title = youtubeData.title;
    }
    if (!excerpt && youtubeData.description) {
      excerpt = youtubeData.description;
    }
    if (!authorUsername && youtubeData.channelHandle) {
      authorUsername = youtubeData.channelHandle;
    }
    if (!authorDisplayName && youtubeData.channelName) {
      authorDisplayName = youtubeData.channelName;
    }
    if (mediaUrls.length === 0 && youtubeData.thumbnailUrl) {
      mediaUrls = [youtubeData.thumbnailUrl];
    }

    const youtubeMetadata = buildYouTubeFeedMetadata(youtubeData);
    metadata = metadata
      ? normalizeMetadata(mergeRecordsDeep(
          metadata as Record<string, unknown>,
          youtubeMetadata as Record<string, unknown>,
        ))
      : youtubeMetadata;
    metadata = dedupeMetadataMedia(metadata);
  }

  if (type === 'article' && source?.trim().toLowerCase() === 'hackernews') {
    const hnUrl = resolveHackerNewsDiscussionUrl({
      sourceId,
      url,
      metadata,
    });
    if (hnUrl && typeof metadata?.hnUrl !== 'string') {
      metadata = {
        ...(metadata ?? {}),
        hnUrl,
      };
    }
  }

  if (type === 'notification') {
    const notificationId = metadata?.notificationId ?? sourceId ?? null;
    metadata = {
      ...(metadata ?? {}),
      severity: metadata?.severity ?? 'info',
      dismissable: metadata?.dismissable ?? true,
      ...(notificationId ? { notificationId } : {}),
    };
  }

  if (type === 'tweet' && (!url || !url.trim())) {
    url = buildTweetStatusUrl(authorUsername, sourceId);
  }

  mediaUrls = dedupeFeedMediaUrls(mediaUrls);

  const normalized: FeedInsertInput = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : randomUUID(),
    type,
    source,
    sourceId,
    originSessionId: typeof raw.originSessionId === 'string'
      ? raw.originSessionId
      : typeof raw.origin_session_id === 'string'
        ? raw.origin_session_id
        : typeof raw.originConversationId === 'string'
          ? raw.originConversationId
          : typeof raw.origin_conversation_id === 'string'
            ? raw.origin_conversation_id
            : null,
    parentId,
    relationship: normalizeRelationship(raw.relationship),
    title,
    text,
    url,
    excerpt,
    authorUsername,
    authorDisplayName,
    authorAvatarUrl,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    tags: normalizeStringArray(raw.tags),
    mediaUrls,
    metrics: normalizeMetrics(raw),
    metadata,
    publishedAt,
  };

  return normalized;
}

export function insertOrIgnoreFeedItem(input: FeedInsertInput): boolean {
  const db = getDb();
  const incidentKey = typeof input.metadata?.incidentKey === 'string' ? input.metadata.incidentKey.trim() : '';

  if (incidentKey && (input.type === 'suggestion' || input.type === 'notification')) {
    const existingIncidentItem = getActiveFeedItemByIncidentKey(incidentKey, input.type);
    if (existingIncidentItem) {
      return false;
    }
  }

  const sourceId = input.type === 'tweet' && typeof input.sourceId === 'string'
    ? normalizeTweetSourceId(input.sourceId)
    : typeof input.sourceId === 'string'
      ? normalizeArticleSourceId(input.sourceId)
      : input.sourceId ?? null;
  const publishedAtMs = timestampToEpochMilliseconds(input.publishedAt);
  const createdAt = new Date().toISOString();
  const createdAtMs = timestampToEpochMilliseconds(createdAt, publishedAtMs);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO feed (
      id, type, source, source_id, origin_session_id, parent_id, relationship, title, text, url, excerpt,
      author_username, author_display_name, reason, tags, media_urls,
      metrics_likes, metrics_reposts, metrics_replies, metrics_views,
      author_avatar_url, metadata, published_at, published_at_ms, created_at, created_at_ms
    ) VALUES (
      @id, @type, @source, @source_id, @origin_session_id, @parent_id, @relationship, @title, @text, @url, @excerpt,
      @author_username, @author_display_name, @reason, @tags, @media_urls,
      @metrics_likes, @metrics_reposts, @metrics_replies, @metrics_views,
      @author_avatar_url, @metadata, @published_at, @published_at_ms, @created_at, @created_at_ms
    )
  `);

  const result = stmt.run({
    id: input.id,
    type: input.type,
    source: input.source ?? null,
    source_id: sourceId,
    origin_session_id: input.originSessionId ?? null,
    parent_id: input.parentId ?? null,
    relationship: input.relationship ?? null,
    title: input.title ?? null,
    text: input.text,
    url: input.url ?? null,
    excerpt: input.excerpt ?? null,
    author_username: input.authorUsername ?? null,
    author_display_name: input.authorDisplayName ?? null,
    reason: input.reason ?? null,
    tags: JSON.stringify(input.tags ?? []),
    media_urls: JSON.stringify(input.mediaUrls ?? []),
    metrics_likes: input.metrics?.likes ?? 0,
    metrics_reposts: input.metrics?.reposts ?? 0,
    metrics_replies: input.metrics?.replies ?? 0,
    metrics_views: typeof input.metrics?.views === 'number' ? input.metrics.views : null,
    author_avatar_url: input.authorAvatarUrl ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    published_at: input.publishedAt,
    published_at_ms: publishedAtMs,
    created_at: createdAt,
    created_at_ms: createdAtMs,
  });

  if (result.changes > 0 && input.type === 'tweet') {
    persistEmbeddedQuotedTweet(input.id ? getFeedItemById(input.id) : null);
  }

  return result.changes > 0;
}

export function updateFeedItemEnrichment(feedItemId: string, input: FeedEnrichmentInput): boolean {
  const existing = getFeedItemById(feedItemId);
  if (!existing) return false;

  const existingMetadata = existing.metadata as Record<string, unknown> | null;
  const incomingMetadata = input.metadata as Record<string, unknown> | null;
  const mergedMetadata = incomingMetadata
    ? existingMetadata
      ? mergeRecordsDeep(existingMetadata, incomingMetadata)
      : incomingMetadata
    : existingMetadata;
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE feed
    SET
      text = COALESCE(@text, text),
      metrics_likes = @metrics_likes,
      metrics_reposts = @metrics_reposts,
      metrics_replies = @metrics_replies,
      metrics_views = COALESCE(@metrics_views, metrics_views),
      media_urls = COALESCE(@media_urls, media_urls),
      author_avatar_url = COALESCE(@author_avatar_url, author_avatar_url),
      metadata = COALESCE(@metadata, metadata)
    WHERE id = @id
  `);

  const result = stmt.run({
    id: feedItemId,
    text: typeof input.text === 'string' && input.text.trim() ? input.text : null,
    metrics_likes: input.metrics.likes,
    metrics_reposts: input.metrics.reposts,
    metrics_replies: input.metrics.replies,
    metrics_views: typeof input.metrics.views === 'number' ? input.metrics.views : null,
    media_urls: Array.isArray(input.mediaUrls) ? JSON.stringify(input.mediaUrls) : null,
    author_avatar_url: input.authorAvatarUrl ?? null,
    metadata: mergedMetadata ? JSON.stringify(mergedMetadata) : null,
  });

  if (result.changes > 0) {
    persistEmbeddedQuotedTweet(getFeedItemById(feedItemId));
  }

  return result.changes > 0;
}

export function updateFeedItemFields(feedItemId: string, input: FeedItemPatchInput): FeedItem | null {
  const existing = getFeedItemById(feedItemId);
  if (!existing) return null;

  const hasOwn = (key: keyof FeedItemPatchInput) => Object.prototype.hasOwnProperty.call(input, key);
  const updates: string[] = [];
  const params: Record<string, unknown> = { id: feedItemId };

  if (hasOwn('author_username')) {
    updates.push('author_username = @author_username');
    params.author_username = input.author_username ?? null;
  }

  if (hasOwn('author_display_name')) {
    updates.push('author_display_name = @author_display_name');
    params.author_display_name = input.author_display_name ?? null;
  }

  if (hasOwn('text')) {
    updates.push('text = @text');
    params.text = input.text ?? existing.text;
  }

  if (hasOwn('title')) {
    updates.push('title = @title');
    params.title = input.title ?? null;
  }

  if (hasOwn('url')) {
    updates.push('url = @url');
    params.url = input.url ?? null;
  }

  if (hasOwn('excerpt')) {
    updates.push('excerpt = @excerpt');
    params.excerpt = input.excerpt ?? null;
  }

  if (hasOwn('reason')) {
    updates.push('reason = @reason');
    params.reason = input.reason ?? null;
  }

  if (hasOwn('tags')) {
    updates.push('tags = @tags');
    params.tags = JSON.stringify(input.tags === null ? [] : normalizeStringArray(input.tags));
  }

  if (hasOwn('media_urls')) {
    updates.push('media_urls = @media_urls');
    params.media_urls = JSON.stringify(input.media_urls === null ? [] : normalizeStringArray(input.media_urls));
  }

  if (hasOwn('author_avatar_url')) {
    updates.push('author_avatar_url = @author_avatar_url');
    params.author_avatar_url = input.author_avatar_url ?? null;
  }

  if (hasOwn('metrics_likes')) {
    updates.push('metrics_likes = @metrics_likes');
    params.metrics_likes = typeof input.metrics_likes === 'number' && Number.isFinite(input.metrics_likes)
      ? Math.max(0, Math.floor(input.metrics_likes))
      : 0;
  }

  if (hasOwn('metrics_reposts')) {
    updates.push('metrics_reposts = @metrics_reposts');
    params.metrics_reposts = typeof input.metrics_reposts === 'number' && Number.isFinite(input.metrics_reposts)
      ? Math.max(0, Math.floor(input.metrics_reposts))
      : 0;
  }

  if (hasOwn('metrics_replies')) {
    updates.push('metrics_replies = @metrics_replies');
    params.metrics_replies = typeof input.metrics_replies === 'number' && Number.isFinite(input.metrics_replies)
      ? Math.max(0, Math.floor(input.metrics_replies))
      : 0;
  }

  if (hasOwn('metrics_views')) {
    updates.push('metrics_views = @metrics_views');
    params.metrics_views = typeof input.metrics_views === 'number' && Number.isFinite(input.metrics_views)
      ? Math.max(0, Math.floor(input.metrics_views))
      : 0;
  }

  if (hasOwn('published_at')) {
    const parsed = input.published_at ? new Date(input.published_at) : null;
    const normalized = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : existing.publishedAt;
    updates.push('published_at = @published_at');
    params.published_at = normalized;
    if (!hasOwn('published_at_ms')) {
      updates.push('published_at_ms = @published_at_ms');
      params.published_at_ms = timestampToEpochMilliseconds(normalized);
    }
  }

  if (hasOwn('published_at_ms')) {
    updates.push('published_at_ms = @published_at_ms');
    params.published_at_ms = typeof input.published_at_ms === 'number' && Number.isFinite(input.published_at_ms)
      ? Math.max(0, Math.floor(input.published_at_ms))
      : timestampToEpochMilliseconds(existing.publishedAt);
  }

  if (hasOwn('metadata')) {
    updates.push('metadata = @metadata');
    if (input.metadata === null) {
      params.metadata = null;
    } else {
      const incomingMetadata = parseMetadataRecordInput(input.metadata);
      const existingMetadata = existing.metadata as Record<string, unknown> | null;
      const rawMergedMetadata = incomingMetadata
        ? existingMetadata
          ? mergeRecordsDeep(existingMetadata, incomingMetadata as Record<string, unknown>)
          : incomingMetadata
        : existingMetadata;
      const mergedMetadata = normalizeMetadataInput(rawMergedMetadata);
      params.metadata = mergedMetadata ? JSON.stringify(mergedMetadata) : null;
    }
  }

  if (updates.length === 0) {
    return existing;
  }

  const db = getDb();
  db.prepare(`
    UPDATE feed
    SET ${updates.join(', ')}
    WHERE id = @id
  `).run(params);

  const updated = getFeedItemById(feedItemId);
  if (updated?.type === 'tweet') {
    persistEmbeddedQuotedTweet(updated);
  }

  return getFeedItemById(feedItemId);
}

export function setFeedItemLiked(feedItemId: string, liked: boolean): void {
  setFeedItemInteraction(feedItemId, 'like', liked);
}

export function setFeedItemDisliked(feedItemId: string, disliked: boolean): void {
  setFeedItemInteraction(feedItemId, 'dislike', disliked);
}

export function setFeedItemSuggestionStatus(
  feedItemId: string,
  status: SuggestionStatus,
  metadataPatch?: Record<string, unknown>,
): void {
  updateFeedItemFields(feedItemId, {
    metadata: {
      suggestionStatus: status,
      ...(metadataPatch ?? {}),
    },
  });

  if (status === 'accepted') {
    setFeedItemInteraction(feedItemId, 'suggestion_accepted', true);
    setFeedItemInteraction(feedItemId, 'suggestion_dismissed', false);
    return;
  }

  if (status === 'dismissed') {
    setFeedItemInteraction(feedItemId, 'suggestion_dismissed', true);
    setFeedItemInteraction(feedItemId, 'suggestion_accepted', false);
    return;
  }

  setFeedItemInteraction(feedItemId, 'suggestion_accepted', false);
  setFeedItemInteraction(feedItemId, 'suggestion_dismissed', false);
}

function setFeedItemInteraction(feedItemId: string, action: string, enabled: boolean): void {
  const db = getDb();
  if (enabled) {
    db.prepare(`
      INSERT OR IGNORE INTO interactions (feed_item_id, action)
      VALUES (?, ?)
    `).run(feedItemId, action);
    return;
  }

  db.prepare(`
    DELETE FROM interactions
    WHERE feed_item_id = ? AND action = ?
  `).run(feedItemId, action);
}

export function hasFeedItemInteraction(feedItemId: string, action: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 AS present
    FROM interactions
    WHERE feed_item_id = ? AND action = ?
    LIMIT 1
  `).get(feedItemId, action) as { present: number } | undefined;

  return Boolean(row?.present);
}

export function recordFeedItemInteraction(feedItemId: string, action: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO interactions (feed_item_id, action)
    VALUES (?, ?)
  `).run(feedItemId, action);

  return result.changes > 0;
}

export function incrementFeedItemMetricLikes(feedItemId: string, amount = 1): boolean {
  const increment = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  if (increment <= 0) {
    return false;
  }

  const db = getDb();
  const result = db.prepare(`
    UPDATE feed
    SET metrics_likes = COALESCE(metrics_likes, 0) + ?
    WHERE id = ?
  `).run(increment, feedItemId);

  return result.changes > 0;
}

export function getInteractionStates(itemIds: string[]): Record<string, { liked: boolean; disliked: boolean }> {
  if (itemIds.length === 0) return {};

  const db = getDb();
  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT feed_item_id, action
    FROM interactions
    WHERE action IN ('like', 'dislike') AND feed_item_id IN (${placeholders})
  `).all(...itemIds) as Array<{ feed_item_id: string; action: string }>;

  const state: Record<string, { liked: boolean; disliked: boolean }> = {};
  for (const id of itemIds) {
    state[id] = { liked: false, disliked: false };
  }
  for (const row of rows) {
    if (row.action === 'like') {
      state[row.feed_item_id] = { ...state[row.feed_item_id], liked: true };
    } else if (row.action === 'dislike') {
      state[row.feed_item_id] = { ...state[row.feed_item_id], disliked: true };
    }
  }

  return state;
}

export function getSuggestionStates(itemIds: string[]): Record<string, SuggestionStatus> {
  if (itemIds.length === 0) return {};

  const items = getFeedItemsByIds(itemIds);
  const db = getDb();
  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT feed_item_id, action
    FROM interactions
    WHERE action IN ('suggestion_accepted', 'suggestion_dismissed')
      AND feed_item_id IN (${placeholders})
  `).all(...itemIds) as Array<{ feed_item_id: string; action: string }>;
  const activeCodeFixRows = db.prepare(`
    SELECT suggestion_id, status
    FROM code_fix_tasks
    WHERE status IN ('queued', 'dispatched', 'running')
      AND suggestion_id IN (${placeholders})
    ORDER BY id ASC
  `).all(...itemIds) as Array<{ suggestion_id: string; status: string }>;

  const state: Record<string, SuggestionStatus> = {};
  for (const id of itemIds) {
    state[id] = items[id]?.suggestionStatus ?? 'pending';
  }

  for (const row of rows) {
    if (row.action === 'suggestion_dismissed') {
      state[row.feed_item_id] = 'dismissed';
    } else if (row.action === 'suggestion_accepted' && state[row.feed_item_id] !== 'dismissed') {
      state[row.feed_item_id] = 'accepted';
    }
  }

  for (const row of activeCodeFixRows) {
    const normalized = row.status.trim().toLowerCase();
    const current = state[row.suggestion_id];
    if (current === 'merged' || current === 'failed' || current === 'dismissed') {
      continue;
    }
    state[row.suggestion_id] = normalized === 'running' ? 'running' : 'dispatched';
  }

  return state;
}

export function setCodeFixSuggestionTask(feedItemId: string, taskId: string, status: Extract<SuggestionStatus, 'dispatched' | 'running' | 'merged' | 'failed'>): FeedItem | null {
  setFeedItemSuggestionStatus(feedItemId, status);
  return updateFeedItemFields(feedItemId, {
    metadata: {
      taskId,
      suggestionStatus: status,
    },
  });
}

export function setCodeFixSuggestionStatusByTaskId(
  taskId: string,
  status: Extract<SuggestionStatus, 'running' | 'merged' | 'failed'>,
): number {
  const trimmedTaskId = taskId.trim();
  if (!trimmedTaskId) return 0;

  const db = getDb();
  const rows = db.prepare(`
    SELECT id
    FROM feed
    WHERE type = 'suggestion'
      AND json_extract(metadata, '$.taskId') = ?
  `).all(trimmedTaskId) as Array<{ id: string }>;

  for (const row of rows) {
    setFeedItemSuggestionStatus(row.id, status);
  }

  return rows.length;
}

export function getFeedItemById(id: string): FeedItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM feed WHERE id = ?').get(id) as FeedRow | undefined;
  return row ? rowToFeedItem(row) : null;
}

export function getFeedItemBySourceId(sourceId: string): FeedItem | null {
  const db = getDb();
  const candidates = getSourceIdLookupCandidates(sourceId);
  if (candidates.length === 0) {
    return null;
  }

  const placeholders = candidates.map((_, index) => `@source_id_${index}`).join(', ');
  const params = Object.fromEntries(candidates.map((candidate, index) => [`source_id_${index}`, candidate]));
  const row = db.prepare(`
    SELECT *
    FROM feed
    WHERE source_id IN (${placeholders})
    ORDER BY created_at_ms DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(params) as FeedRow | undefined;
  return row ? rowToFeedItem(row) : null;
}

export function listTopLevelItemsWithIncompleteEnrichment(limit = 30): FeedItem[] {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.floor(limit)))
    : 30;
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM feed
    WHERE parent_id IS NULL
      AND (
        (
          type = 'tweet'
          AND (
            COALESCE(TRIM(author_avatar_url), '') = ''
            OR COALESCE(media_urls, '[]') = '[]'
            OR json_extract(metadata, '$.quotedTweet') IS NULL
          )
        )
        OR (
          type = 'article'
          AND COALESCE(TRIM(url), '') <> ''
          AND json_extract(metadata, '$.articleEnrichment.skipReason') IS NULL
          AND COALESCE(json_extract(metadata, '$.articleEnrichment.status'), '') <> 'skipped'
          AND (
            COALESCE(json_extract(metadata, '$.articleEnrichment.status'), '') <> 'completed'
            OR COALESCE(json_extract(metadata, '$.articleEnrichment.retryEligible'), 0) = 1
          )
          AND (
            COALESCE(json_extract(metadata, '$.batchEnrichment.status'), '') <> 'completed'
            OR COALESCE(json_extract(metadata, '$.batchEnrichment.retryEligible'), 0) = 1
          )
        )
      )
    ORDER BY created_at_ms DESC, created_at DESC, id DESC
    LIMIT @limit
  `).all({ limit: normalizedLimit }) as FeedRow[];

  return rows.map(rowToFeedItem);
}

export function getFeedItemByTaskId(taskId: string): FeedItem | null {
  const trimmedTaskId = taskId.trim();
  if (!trimmedTaskId) {
    return null;
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM feed
    WHERE type = 'suggestion'
      AND json_extract(metadata, '$.taskId') = ?
    ORDER BY created_at_ms DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(trimmedTaskId) as FeedRow | undefined;

  return row ? rowToFeedItem(row) : null;
}

export function getFeedItemsByThreadId(threadId: string): FeedItem[] {
  const trimmedThreadId = threadId.trim();
  if (!trimmedThreadId) {
    return [];
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM feed
    WHERE json_extract(metadata, '$.thread.threadId') = ?
    ORDER BY created_at_ms ASC, created_at ASC, id ASC
  `).all(trimmedThreadId) as FeedRow[];

  return rows.map(rowToFeedItem);
}

export interface CodeFixSuggestionTaskResolution {
  item: FeedItem;
  currentTaskId: string | null;
  matchedVia: 'current_task_id' | 'code_fix_task_history';
}

function getSuggestionCurrentTaskId(item: FeedItem): string | null {
  const taskId = typeof item.metadata?.taskId === 'string' ? item.metadata.taskId.trim() : '';
  return taskId || null;
}

export function resolveCodeFixSuggestionByTaskId(taskId: string): CodeFixSuggestionTaskResolution | null {
  const trimmedTaskId = taskId.trim();
  if (!trimmedTaskId) {
    return null;
  }

  const directMatch = getFeedItemByTaskId(trimmedTaskId);
  if (directMatch) {
    return {
      item: directMatch,
      currentTaskId: getSuggestionCurrentTaskId(directMatch),
      matchedVia: 'current_task_id',
    };
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT feed.*
    FROM code_fix_tasks
    INNER JOIN feed
      ON feed.id = code_fix_tasks.suggestion_id
    WHERE code_fix_tasks.task_id = ?
      AND feed.type = 'suggestion'
    ORDER BY code_fix_tasks.id DESC, feed.created_at_ms DESC, feed.created_at DESC, feed.id DESC
    LIMIT 1
  `).get(trimmedTaskId) as FeedRow | undefined;

  if (!row) {
    return null;
  }

  const item = rowToFeedItem(row);
  return {
    item,
    currentTaskId: getSuggestionCurrentTaskId(item),
    matchedVia: 'code_fix_task_history',
  };
}

function getFeedItemsByIds(ids: string[]): Record<string, FeedItem> {
  if (ids.length === 0) {
    return {};
  }

  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM feed
    WHERE id IN (${placeholders})
  `).all(...ids) as FeedRow[];

  const itemsById: Record<string, FeedItem> = {};
  for (const row of rows) {
    const item = rowToFeedItem(row);
    itemsById[item.id] = item;
  }

  return itemsById;
}

function getSuggestionChildrenForItems(parentIds: string[]): Record<string, FeedItem[]> {
  if (parentIds.length === 0) {
    return {};
  }

  const db = getDb();
  const placeholders = parentIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM feed
    WHERE parent_id IN (${placeholders})
      AND type = 'suggestion'
      AND COALESCE(reason, '') <> ?
    ORDER BY parent_id, published_at_ms DESC, created_at_ms DESC
  `).all(...parentIds, EMBEDDED_QUOTED_TWEET_REASON) as FeedRow[];

  const suggestionsByParentId: Record<string, FeedItem[]> = {};
  for (const row of rows) {
    const parentId = row.parent_id;
    if (!parentId) {
      continue;
    }

    const current = suggestionsByParentId[parentId] ?? [];
    current.push(rowToFeedItem(row));
    suggestionsByParentId[parentId] = current;
  }

  return suggestionsByParentId;
}

export function resolvePersistedFeedItemByIdentifier(identifier: string): FeedItem | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  const byId = getFeedItemById(trimmed);
  if (byId) return byId;

  const bySourceId = getFeedItemBySourceId(trimmed);
  if (bySourceId) return bySourceId;

  const normalizedTweetSourceId = normalizeTweetSourceId(trimmed);
  if (normalizedTweetSourceId !== trimmed) {
    const byNormalizedSourceId = getFeedItemBySourceId(normalizedTweetSourceId);
    if (byNormalizedSourceId) return byNormalizedSourceId;
  }

  const byTweetIdentifier = findTweetFeedItemByIdentifier(trimmed);
  if (byTweetIdentifier) return byTweetIdentifier;

  const quoteMatch = findQuotedTweetMatchByIdentifier(trimmed);
  if (!quoteMatch) {
    return null;
  }

  return upsertQuotedTweetChild(quoteMatch.parentItem, quoteMatch.quote);
}

export function resolveFeedItemByIdentifier(identifier: string): FeedItem | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  const persisted = resolvePersistedFeedItemByIdentifier(trimmed);
  if (persisted) return persisted;

  return findQuotedTweetFeedItemByIdentifier(trimmed);
}

export function findTweetFeedItemByIdentifier(identifier: string): FeedItem | null {
  const db = getDb();
  const trimmed = identifier.trim();
  const normalizedIdentifier = normalizeTweetSourceId(trimmed);
  const tweetIdMatch = normalizedIdentifier.match(/\/status\/(\d+)/);
  const tweetId = tweetIdMatch?.[1] ?? (/^\d+$/.test(normalizedIdentifier) ? normalizedIdentifier : null);

  const row = db.prepare(`
    SELECT *
    FROM feed
    WHERE type = 'tweet'
      AND lower(COALESCE(source, '')) IN ('twitter', 'x')
      AND (
        source_id = @identifier
        OR source_id = @normalized_identifier
        OR (@tweet_id IS NOT NULL AND source_id LIKE @tweet_url_like)
        OR (@tweet_id IS NOT NULL AND url LIKE @tweet_url_like)
      )
    ORDER BY created_at_ms DESC
    LIMIT 1
  `).get({
    identifier: trimmed,
    normalized_identifier: normalizedIdentifier,
    tweet_id: tweetId,
    tweet_url_like: tweetId ? `%/status/${tweetId}%` : null,
  }) as FeedRow | undefined;

  return row ? rowToFeedItem(row) : null;
}

export function getFeedChildren(parentId: string): FeedItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM feed
    WHERE parent_id = ?
      AND COALESCE(reason, '') <> ?
    ORDER BY ${relationshipOrderSql}, published_at_ms ASC, created_at_ms ASC
  `).all(parentId, EMBEDDED_QUOTED_TWEET_REASON) as FeedRow[];

  return rows.map(rowToFeedItem);
}

export function getParentContextForItems(parentIds: string[]): Record<string, FeedItem> {
  if (parentIds.length === 0) return {};

  const db = getDb();
  const placeholders = parentIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM feed
    WHERE parent_id IN (${placeholders})
      AND relationship = 'parent'
    ORDER BY parent_id, published_at_ms DESC, created_at_ms DESC
  `).all(...parentIds) as FeedRow[];

  const parentsByItemId: Record<string, FeedItem> = {};
  for (const row of rows) {
    if (!row.parent_id || parentsByItemId[row.parent_id]) {
      continue;
    }
    parentsByItemId[row.parent_id] = rowToFeedItem(row);
  }

  return parentsByItemId;
}

export function getChildPreviewsForItems(parentIds: string[]): Record<string, { children: ChildPreview[]; total: number }> {
  if (parentIds.length === 0) return {};

  const db = getDb();
  const placeholders = parentIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT id, parent_id, type, relationship, title, text, source, author_username, author_display_name, author_avatar_url, published_at, reason
    FROM feed
    WHERE parent_id IN (${placeholders})
      AND COALESCE(reason, '') <> ?
    ORDER BY parent_id, ${childPreviewRelationshipOrderSql}, published_at_ms ASC, created_at_ms ASC
  `).all(...parentIds, EMBEDDED_QUOTED_TWEET_REASON) as ChildPreviewRow[];

  const grouped: Record<string, { children: ChildPreview[]; total: number }> = {};

  for (const row of rows) {
    const parentId = row.parent_id;
    const current = grouped[parentId] ?? { children: [], total: 0 };
    current.total += 1;
    const relationship = normalizeRelationship(row.relationship) ?? row.relationship ?? '';

    if (current.children.length < CHILD_PREVIEW_LIMIT) {
      current.children.push({
        id: row.id,
        type: row.type,
        relationship,
        title: row.title,
        text: (relationship === 'reply' || relationship === 'analysis') ? row.text : toChildPreviewText(row.text),
        source: row.source,
        authorUsername: row.author_username,
        authorDisplayName: row.author_display_name,
        authorAvatarUrl: row.author_avatar_url,
        publishedAt: row.published_at,
      });
    }

    grouped[parentId] = current;
  }

  return grouped;
}

export function groupFeedChildrenByRelationship(children: FeedItem[]): FeedChildrenByRelationship {
  const grouped: FeedChildrenByRelationship = {
    parent: [],
    child: [],
    reply: [],
    analysis: [],
    related: [],
    thread: [],
    unknown: [],
  };

  for (const child of children) {
    switch (child.relationship) {
      case 'parent':
        grouped.parent.push(child);
        break;
      case 'child':
        grouped.child.push(child);
        break;
      case 'reply':
        grouped.reply.push(child);
        break;
      case 'analysis':
        grouped.analysis.push(child);
        break;
      case 'related':
        grouped.related.push(child);
        break;
      case 'thread':
        grouped.thread.push(child);
        break;
      default:
        grouped.unknown.push(child);
        break;
    }
  }

  return grouped;
}

function dismissExpiredNotifications(): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, metadata
    FROM feed
    WHERE type = 'notification'
  `).all() as Array<{ id: string; metadata: string | null }>;

  if (rows.length === 0) {
    return;
  }

  const states = getSuggestionStates(rows.map((row) => row.id));
  const now = Date.now();

  for (const row of rows) {
    if (states[row.id] === 'dismissed') {
      continue;
    }

    const metadata = parseJsonRecord(row.metadata);
    const expiresAt = typeof metadata?.expiresAt === 'string' ? Date.parse(metadata.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      setFeedItemSuggestionStatus(row.id, 'dismissed');
    }
  }
}

interface FeedThreadRow {
  id: string;
  title: string;
  subtitle: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  active: number;
}

function rowToFeedThread(row: FeedThreadRow): FeedThread {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    active: row.active === 1,
  };
}

function trimToNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getActiveFeedThreads(): FeedThread[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, title, subtitle, created_at_ms, updated_at_ms, active
    FROM feed_threads
    WHERE active = 1
    ORDER BY updated_at_ms DESC, title ASC, id ASC
  `).all() as FeedThreadRow[];

  return rows.map(rowToFeedThread);
}

export function arrangeFeedDisplay(input: {
  ordering: FeedArrangeOrderingInput[];
  threads: FeedArrangeThreadInput[];
}): FeedArrangeResult {
  const db = getDb();
  const nowMs = Date.now();
  const updatedItemIds: string[] = [];

  const applyArrange = db.transaction(() => {
    const liveThreadIds = input.threads.map((thread) => thread.id);
    if (liveThreadIds.length === 0) {
      db.prepare(`
        UPDATE feed_threads
        SET active = 0, updated_at_ms = ?
        WHERE active != 0
      `).run(nowMs);
    } else {
      const placeholders = liveThreadIds.map(() => '?').join(', ');
      db.prepare(`
        UPDATE feed_threads
        SET active = 0, updated_at_ms = ?
        WHERE id NOT IN (${placeholders})
          AND active != 0
      `).run(nowMs, ...liveThreadIds);
    }

    const upsertThread = db.prepare(`
      INSERT INTO feed_threads (id, title, subtitle, created_at_ms, updated_at_ms, active)
      VALUES (@id, @title, @subtitle, @created_at_ms, @updated_at_ms, @active)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        subtitle = excluded.subtitle,
        updated_at_ms = excluded.updated_at_ms,
        active = excluded.active
    `);

    for (const thread of input.threads) {
      upsertThread.run({
        id: thread.id,
        title: thread.title,
        subtitle: trimToNullableText(thread.subtitle),
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
        active: thread.active ? 1 : 0,
      });
    }

    const updateFeedItem = db.prepare(`
      UPDATE feed
      SET
        display_order = @display_order,
        thread_id = @thread_id,
        display_subtitle = @display_subtitle
      WHERE id = @id
    `);

    for (const item of input.ordering) {
      const result = updateFeedItem.run({
        id: item.feedItemId,
        display_order: item.displayOrder,
        thread_id: trimToNullableText(item.threadId),
        display_subtitle: trimToNullableText(item.displaySubtitle),
      });
      if (result.changes > 0) {
        updatedItemIds.push(item.feedItemId);
      }
    }
  });

  applyArrange();

  return {
    updatedItemIds,
    activeThreads: getActiveFeedThreads(),
    orderingCount: input.ordering.length,
    threadCount: input.threads.length,
  };
}

function buildFeedSearchExpression(alias: string): string {
  return `lower(trim(
    coalesce(${alias}.title, '') || ' ' ||
    coalesce(${alias}.text, '') || ' ' ||
    coalesce(${alias}.excerpt, '') || ' ' ||
    coalesce(${alias}.reason, '') || ' ' ||
    coalesce(${alias}.url, '') || ' ' ||
    coalesce(${alias}.source_id, '') || ' ' ||
    coalesce(${alias}.author_username, '') || ' ' ||
    coalesce(${alias}.author_display_name, '') || ' ' ||
    coalesce(${alias}.tags, '') || ' ' ||
    coalesce(${alias}.metadata, '')
  ))`;
}

function buildSuggestionHasInteractionClause(alias: string, actions: readonly string[]): string {
  const actionList = actions.map((action) => `'${action}'`).join(', ');
  return `EXISTS (
    SELECT 1
    FROM interactions i
    WHERE i.feed_item_id = ${alias}.id
      AND i.action IN (${actionList})
  )`;
}

function buildSuggestionHasNoResolvedInteractionClause(alias: string): string {
  return `NOT ${buildSuggestionHasInteractionClause(alias, ['suggestion_accepted', 'suggestion_dismissed'])}`;
}

function buildPendingSuggestionClause(alias: string): string {
  return `(
    ${alias}.type = 'suggestion'
    AND COALESCE(json_extract(${alias}.metadata, '$.suggestionStatus'), 'pending') = 'pending'
    AND ${buildSuggestionHasNoResolvedInteractionClause(alias)}
  )`;
}

function buildFeedListWhereClause(
  query: Pick<FeedQuery, 'types' | 'sources' | 'search' | 'threadId'>,
  options?: {
    forcedTypes?: FeedItemType[];
    excludeDismissedSuggestions?: boolean;
  },
): { whereSql: string; values: Array<string | number> } {
  const whereClauses: string[] = [
    `NOT (
      f.type = 'notification'
      AND EXISTS (
        SELECT 1
        FROM interactions i
        WHERE i.feed_item_id = f.id
          AND i.action = 'suggestion_dismissed'
      )
    )`,
    `NOT EXISTS (
      SELECT 1
      FROM interactions i
      WHERE i.feed_item_id = f.id
        AND i.action = 'dislike'
    )`,
  ];
  const values: Array<string | number> = [];
  const effectiveTypes = options?.forcedTypes ?? query.types;
  const searchTokens = tokenizeSearchQuery(query.search);

  if (searchTokens.length === 0) {
    whereClauses.unshift("(f.parent_id IS NULL OR f.type = 'suggestion')");
  }

  if (options?.excludeDismissedSuggestions) {
    whereClauses.push(`NOT (
      f.type = 'suggestion'
      AND (
        COALESCE(json_extract(f.metadata, '$.suggestionStatus'), 'pending') = 'dismissed'
        OR ${buildSuggestionHasInteractionClause('f', ['suggestion_dismissed'])}
      )
    )`);
  }

  if (effectiveTypes.length > 0) {
    const placeholders = effectiveTypes.map(() => '?').join(', ');
    whereClauses.push(`f.type IN (${placeholders})`);
    values.push(...effectiveTypes);
  }

  if (query.sources.length > 0) {
    const placeholders = query.sources.map(() => '?').join(', ');
    whereClauses.push(`f.source IN (${placeholders})`);
    values.push(...query.sources);
  }

  const normalizedThreadId = query.threadId?.trim() ?? '';
  if (normalizedThreadId) {
    whereClauses.push('f.thread_id = ?');
    values.push(normalizedThreadId);
  }

  if (searchTokens.length > 0) {
    const searchExpr = buildFeedSearchExpression('f');
    const searchClauses = searchTokens.map(() => `${searchExpr} LIKE ? ESCAPE '\\'`);
    whereClauses.push(`(${searchClauses.join(' OR ')})`);
    values.push(...searchTokens.map((token) => `%${escapeSqlLikePattern(token)}%`));
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  return { whereSql, values };
}

export function getFeedPage(query: FeedQuery): { items: FeedItem[]; total: number; hasMore: boolean } {
  const db = getDb();
  dismissExpiredNotifications();

  const { whereSql, values } = buildFeedListWhereClause(query);
  const fallbackOrderBySql = query.sort === 'published'
    ? 'feed_with_state.published_at_ms DESC, feed_with_state.created_at_ms DESC'
    : 'feed_with_state.created_at_ms DESC, feed_with_state.published_at_ms DESC';
  const orderBySql = `
    CASE WHEN feed_with_state.display_order IS NULL THEN 1 ELSE 0 END ASC,
    feed_with_state.display_order ASC,
    ${fallbackOrderBySql},
    feed_with_state.id DESC
  `;

  const rows = db.prepare(`
    WITH feed_with_state AS (
      SELECT
        f.*,
        ft.title AS display_thread_title,
        ft.subtitle AS display_thread_subtitle,
        CASE WHEN f.thread_id IS NOT NULL AND ft.id IS NULL THEN 0 ELSE 1 END AS display_thread_active,
        CASE
          WHEN f.type = 'suggestion' AND NOT EXISTS (
            SELECT 1
            FROM interactions i
            WHERE i.feed_item_id = f.id
              AND i.action IN ('suggestion_accepted', 'suggestion_dismissed')
          ) THEN 1
          ELSE 0
        END AS is_pending_suggestion
      FROM feed f
      LEFT JOIN feed_threads ft ON ft.id = f.thread_id AND ft.active = 1
      ${whereSql}
    )
    SELECT feed_with_state.* FROM feed_with_state
    ORDER BY ${orderBySql}
  `).all(...values) as FeedRow[];

  const baseItems = rows.map(rowToFeedItem);
  const pageItems = getThreadAwareFeedPageItems(baseItems, query.offset, query.limit);
  const hasMore = baseItems.length > query.offset + pageItems.length;

  return {
    items: pageItems,
    total: baseItems.length,
    hasMore,
  };
}

export function getSuggestionFeedGroup(query: FeedQuery): FeedSuggestionGroup | null {
  if (query.types.length > 0 && !query.types.includes('suggestion')) {
    return null;
  }

  const db = getDb();
  dismissExpiredNotifications();

  const { whereSql, values } = buildFeedListWhereClause(query, {
    forcedTypes: ['suggestion'],
    excludeDismissedSuggestions: true,
  });
  const fallbackOrderBySql = query.sort === 'published'
    ? 'f.published_at_ms DESC, f.created_at_ms DESC'
    : 'f.created_at_ms DESC, f.published_at_ms DESC';
  const orderBySql = `
    CASE WHEN f.display_order IS NULL THEN 1 ELSE 0 END ASC,
    f.display_order ASC,
    ${fallbackOrderBySql},
    f.id DESC
  `;
  const rows = db.prepare(`
    SELECT
      f.*,
      ft.title AS display_thread_title,
      ft.subtitle AS display_thread_subtitle,
      CASE WHEN f.thread_id IS NOT NULL AND ft.id IS NULL THEN 0 ELSE 1 END AS display_thread_active
    FROM feed f
    LEFT JOIN feed_threads ft ON ft.id = f.thread_id AND ft.active = 1
    ${whereSql}
    ORDER BY ${orderBySql}
  `).all(...values) as FeedRow[];

  const items = buildSuggestionGroupItems(
    hydrateFeedItemsForList(rows.map(rowToFeedItem)),
    query.sort,
  );

  if (items.length === 0) {
    return null;
  }

  return {
    title: 'Suggestions',
    items,
    latestTimestamp: getSuggestionGroupLatestTimestamp(items),
    totalCount: rows.length,
  };
}

export function getPendingFeedCounts(): FeedPendingCounts {
  const db = getDb();
  dismissExpiredNotifications();

  const rows = db.prepare(`
    SELECT
      f.type AS type,
      COUNT(*) AS count
    FROM feed f
    WHERE (f.parent_id IS NULL OR f.type = 'suggestion')
      AND (
        (
          ${buildPendingSuggestionClause('f')}
        )
        OR (
          f.type = 'notification'
          AND NOT EXISTS (
            SELECT 1
            FROM interactions i
            WHERE i.feed_item_id = f.id
              AND i.action = 'suggestion_dismissed'
          )
        )
      )
    GROUP BY f.type
  `).all() as Array<{ type: FeedItemType; count: number }>;

  const counts = createEmptyPendingCounts();
  for (const row of rows) {
    counts[row.type] = Number(row.count) || 0;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// code_fix_tasks helpers
// ---------------------------------------------------------------------------

export interface CodeFixTaskRow {
  id: number;
  suggestion_id: string;
  task_id: string;
  status: string;
  phase: string | null;
  phase_detail: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export function upsertCodeFixTask(
  suggestionId: string,
  taskId: string,
  status: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO code_fix_tasks (suggestion_id, task_id, status)
    VALUES (?, ?, ?)
    ON CONFLICT(suggestion_id, task_id) DO UPDATE SET status = excluded.status
  `).run(suggestionId, taskId, status);
}

export function updateCodeFixTaskStatus(
  taskId: string,
  status: string,
  extra?: { phase?: string; phaseDetail?: string; error?: string; completedAt?: string },
): number {
  const db = getDb();
  const sets = ['status = ?'];
  const values: Array<string | null> = [status];

  if (extra?.phase !== undefined) {
    sets.push('phase = ?');
    values.push(extra.phase);
  }
  if (extra?.phaseDetail !== undefined) {
    sets.push('phase_detail = ?');
    values.push(extra.phaseDetail);
  }
  if (extra?.error !== undefined) {
    sets.push('error = ?');
    values.push(extra.error);
  }
  if (extra?.completedAt !== undefined) {
    sets.push('completed_at = ?');
    values.push(extra.completedAt);
  }

  values.push(taskId);
  const result = db.prepare(`UPDATE code_fix_tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...values);
  return result.changes;
}

export function getCodeFixTaskByTaskId(taskId: string): CodeFixTaskRow | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM code_fix_tasks WHERE task_id = ?').get(taskId) as CodeFixTaskRow | undefined) ?? null;
}

export function getCodeFixTaskBySuggestionId(suggestionId: string): CodeFixTaskRow | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM code_fix_tasks WHERE suggestion_id = ? ORDER BY id DESC LIMIT 1').get(suggestionId) as CodeFixTaskRow | undefined) ?? null;
}

export function getActiveCodeFixTasks(): CodeFixTaskRow[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM code_fix_tasks WHERE status IN ('dispatched', 'running', 'queued') ORDER BY id ASC`,
  ).all() as CodeFixTaskRow[];
}

export function getCodeFixTaskHistory(limit = 50): CodeFixTaskRow[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM code_fix_tasks WHERE status IN ('merged', 'failed', 'cancelled') ORDER BY id DESC LIMIT ?`,
  ).all(limit) as CodeFixTaskRow[];
}

export function deleteCodeFixTasksBySuggestionId(suggestionId: string): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM code_fix_tasks WHERE suggestion_id = ?').run(suggestionId);
  return result.changes;
}

export function hydrateFeedItemsForList(items: FeedItem[]): FeedItem[] {
  if (items.length === 0) {
    return [];
  }

  const itemIds = items
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (itemIds.length === 0) {
    return items.map((item) => ({
      ...item,
      parentItem: item.parentItem ?? null,
      children: item.children ?? [],
      childrenCount: item.childrenCount ?? 0,
    }));
  }

  const parentContextByItemId = getParentContextForItems(itemIds);
  const directParentIds = Array.from(new Set(
    items
      .map((item) => item.parentId)
      .filter((parentId): parentId is string => typeof parentId === 'string' && parentId.length > 0),
  ));
  const directParentsById = getFeedItemsByIds(directParentIds);
  const suggestionChildrenByParentId = getSuggestionChildrenForItems(itemIds);
  const suggestionChildIds = Object.values(suggestionChildrenByParentId).flatMap((children) => children.map((child) => child.id));
  const childPreviewsByParentId = getChildPreviewsForItems(itemIds);
  const interactionStates = getInteractionStates(itemIds);
  const suggestionStates = getSuggestionStates([...itemIds, ...suggestionChildIds]);
  const hydratedItems = items.map((item) => ({
    ...item,
    isLiked: interactionStates[item.id]?.liked ?? item.isLiked ?? false,
    isDisliked: interactionStates[item.id]?.disliked ?? item.isDisliked ?? false,
    suggestionStatus: item.type === 'suggestion' || item.type === 'notification'
      ? suggestionStates[item.id] ?? item.suggestionStatus ?? 'pending'
      : undefined,
    parentItem: parentContextByItemId[item.id] ?? (
      item.parentId ? (directParentsById[item.parentId] ?? item.parentItem ?? null) : (item.parentItem ?? null)
    ),
    children: childPreviewsByParentId[item.id]?.children ?? item.children ?? [],
    childrenCount: childPreviewsByParentId[item.id]?.total ?? item.childrenCount ?? 0,
    suggestionChildren: (suggestionChildrenByParentId[item.id] ?? item.suggestionChildren ?? []).map((child) => ({
      ...child,
      suggestionStatus: suggestionStates[child.id] ?? child.suggestionStatus ?? 'pending',
      parentItem: child.parentId === item.id ? item : (child.parentItem ?? null),
      children: child.children ?? [],
      childrenCount: child.childrenCount ?? 0,
      suggestionChildren: child.suggestionChildren ?? [],
    })),
  }));

  const analysisContextItems = Array.from(
    hydratedItems.reduce((map, item) => {
      map.set(item.id, item);
      if (item.parentItem) {
        map.set(item.parentItem.id, item.parentItem);
      }
      return map;
    }, new Map<string, FeedItem>()).values(),
  );

  return hydratedItems.map((item) => ({
    ...item,
    analysisPresentation: item.type === 'analysis'
      ? deriveAnalysisPresentation(item, analysisContextItems)
      : null,
  }));
}
