import { type FeedFilter } from '@/lib/feed-filters';
import { getStrongestFeedProminence } from '@/lib/feed-prominence';
import { shouldSuppressFeedSystemNotice } from '@/lib/system-notices';
import { getThreadDisplayGroupKey } from '@/lib/thread-display';
import { type FeedItem, type FeedPendingCounts, type FeedProminence } from '@/types/feed';

export type FeedSortOrder = 'created' | 'published';

export const FEED_DISPLAY_ORDER_FRESHNESS_MS = 12 * 60 * 60 * 1000;

export function isFeedDisplayOrderFresh(
  lastArrangeAtMs: number | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = FEED_DISPLAY_ORDER_FRESHNESS_MS,
): boolean {
  return typeof lastArrangeAtMs === 'number'
    && Number.isFinite(lastArrangeAtMs)
    && Number.isFinite(nowMs)
    && nowMs - lastArrangeAtMs <= maxAgeMs;
}

export function normalizeFeedItems(items: FeedItem[]) {
  const map = new Map<string, FeedItem>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

export function mergeFeedItemsForPendingReveal(
  currentItems: FeedItem[],
  pendingItems: FeedItem[],
  sortOrder: FeedSortOrder,
  options: { lastArrangeAtMs?: number | null; nowMs?: number } = {},
): FeedItem[] {
  return Array.from(normalizeFeedItems([...currentItems, ...pendingItems]).values())
    .sort((left, right) => compareFeedItems(left, right, sortOrder, options));
}

export function isPrimaryFeedItem(item: FeedItem) {
  return (item.type === 'tweet' || item.type === 'article' || item.type === 'analysis')
    && !shouldSuppressFeedSystemNotice(item);
}

export function isReflectionFeedItem(item: FeedItem): boolean {
  if (item.type !== 'analysis') {
    return false;
  }
  // Reflection rows have drifted across three metadata shapes over time;
  // detect all of them so process notices never pass as editorial analysis.
  return item.metadata?.reflectionCycle === true
    || readTrimmedMetadataString(item.metadata?.mode)?.toLowerCase() === 'reflection'
    || item.id.startsWith('reflection-');
}

export function countPrimaryFeedItems(items: FeedItem[]) {
  return items.filter((item) => isPrimaryFeedItem(item)).length;
}

export function getOldestLoadedPrimaryFeedItemTimestamp(
  items: FeedItem[],
  shouldRenderItem: (item: FeedItem) => boolean,
): string | null {
  return items.reduce<string | null>((oldest, item) => {
    if (!shouldRenderItem(item) || !isPrimaryFeedItem(item)) {
      return oldest;
    }

    if (!oldest || item.createdAt.localeCompare(oldest) < 0) {
      return item.createdAt;
    }

    return oldest;
  }, null);
}

export const CONVERSATION_TIMELINE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function shouldIncludeConversationTimelineEntry({
  selectedFilter,
  oldestLoadedPrimaryFeedItemTimestamp,
  conversationLastTimestamp,
  conversationMessageCount = null,
  isInitialPrimaryFeedLoading = false,
  nowMs = Date.now(),
}: {
  selectedFilter: FeedFilter;
  oldestLoadedPrimaryFeedItemTimestamp: string | null;
  conversationLastTimestamp: string;
  conversationMessageCount?: number | null;
  isInitialPrimaryFeedLoading?: boolean;
  nowMs?: number;
}): boolean {
  if (selectedFilter === 'agent') {
    return true;
  }

  if (isInitialPrimaryFeedLoading) {
    return false;
  }

  // With no curated content loaded at all (fresh install), sessions are the
  // only surface the user has — keep them visible.
  if (oldestLoadedPrimaryFeedItemTimestamp === null) {
    return true;
  }

  // Once content exists, sessions earn a timeline slot only with real,
  // recent activity: empty shells and long-idle dev sessions otherwise pile
  // up below the curated feed and push the load-more sentinel out of reach.
  if (typeof conversationMessageCount === 'number' && conversationMessageCount <= 0) {
    return false;
  }

  const lastActivityMs = Date.parse(conversationLastTimestamp);
  if (Number.isFinite(lastActivityMs) && nowMs - lastActivityMs > CONVERSATION_TIMELINE_MAX_AGE_MS) {
    return false;
  }

  return conversationLastTimestamp.localeCompare(oldestLoadedPrimaryFeedItemTimestamp) >= 0;
}

export function shouldRenderFeedEmptyState({
  isLoading,
  visibleFeedEntryCount,
}: {
  isLoading: boolean;
  visibleFeedEntryCount: number;
}): boolean {
  return !isLoading && visibleFeedEntryCount === 0;
}

export function createEmptyPendingCounts(): FeedPendingCounts {
  return {
    tweet: 0,
    article: 0,
    analysis: 0,
    suggestion: 0,
    notification: 0,
  };
}

export function normalizePendingCounts(counts?: Partial<FeedPendingCounts> | null): FeedPendingCounts {
  return {
    ...createEmptyPendingCounts(),
    ...(counts ?? {}),
  };
}

export function compareFeedItems(
  left: FeedItem,
  right: FeedItem,
  sortOrder: FeedSortOrder,
  options: { lastArrangeAtMs?: number | null; nowMs?: number } = {},
): number {
  const useDisplayOrder = options.lastArrangeAtMs === undefined
    || isFeedDisplayOrderFresh(options.lastArrangeAtMs, options.nowMs);
  const leftHasDisplayOrder = typeof left.displayOrder === 'number';
  const rightHasDisplayOrder = typeof right.displayOrder === 'number';
  if (useDisplayOrder) {
    if (leftHasDisplayOrder !== rightHasDisplayOrder) {
      return leftHasDisplayOrder ? -1 : 1;
    }
    if (leftHasDisplayOrder && rightHasDisplayOrder) {
      const byDisplayOrder = (left.displayOrder ?? 0) - (right.displayOrder ?? 0);
      if (byDisplayOrder !== 0) return byDisplayOrder;
    }
  }

  if (sortOrder === 'published') {
    const byPublished = right.publishedAt.localeCompare(left.publishedAt);
    if (byPublished !== 0) return byPublished;
    return right.createdAt.localeCompare(left.createdAt);
  }

  const byCreated = right.createdAt.localeCompare(left.createdAt);
  if (byCreated !== 0) return byCreated;
  return right.publishedAt.localeCompare(left.publishedAt);
}

export function readTrimmedMetadataString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeThreadGroupKeyPart(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized || null;
}

function readThreadGroupDateScope(item: FeedItem): string | null {
  const curatedAt = readTrimmedMetadataString(item.metadata?.curatedAt);
  const candidate = curatedAt || item.createdAt || item.publishedAt;
  const match = candidate.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

export function getThreadGroupIdentity(item: FeedItem): { key: string; threadId: string } | null {
  if (item.threadDisplayEnabled === false) {
    return null;
  }

  const arrangedThreadId = item.threadId?.trim() || null;
  if (item.threadDisplayEnabled === true && !arrangedThreadId) {
    return null;
  }

  const flatThreadId = readTrimmedMetadataString(item.metadata?.threadId);
  const threadId = arrangedThreadId
    || readTrimmedMetadataString(item.metadata?.thread?.threadId)
    || flatThreadId;
  if (!threadId) {
    return null;
  }

  const cycleId = readTrimmedMetadataString(item.metadata?.cycleId);
  const threadTitle = item.threadTitle?.trim()
    || readTrimmedMetadataString(item.metadata?.thread?.threadTitle)
    || readTrimmedMetadataString(item.metadata?.threadTitle);
  const threadRationale = item.threadSubtitle?.trim()
    || readTrimmedMetadataString(item.metadata?.thread?.threadRationale)
    || readTrimmedMetadataString(item.metadata?.threadRationale);
  const scopeParts = cycleId
    ? [`cycle:${cycleId}`]
    : [
      threadTitle ? `title:${threadTitle}` : null,
      threadRationale ? `why:${threadRationale}` : null,
      flatThreadId ? `day:${readThreadGroupDateScope(item) ?? ''}` : null,
    ];
  const scope = scopeParts
    .map(normalizeThreadGroupKeyPart)
    .filter((part): part is string => Boolean(part))
    .join('|');

  return {
    key: scope ? `${threadId}::${scope}` : threadId,
    threadId,
  };
}

export function getThreadDisplayGroupIdentity(item: FeedItem): { key: string; threadId: string } | null {
  const identity = getThreadGroupIdentity(item);
  if (!identity) {
    return null;
  }

  const threadTitle = item.threadTitle?.trim()
    || readTrimmedMetadataString(item.metadata?.thread?.threadTitle)
    || readTrimmedMetadataString(item.metadata?.threadTitle);
  const threadRationale = item.threadSubtitle?.trim()
    || readTrimmedMetadataString(item.metadata?.thread?.threadRationale)
    || readTrimmedMetadataString(item.metadata?.threadRationale);

  return {
    key: getThreadDisplayGroupKey({
      threadId: identity.threadId,
      title: threadTitle,
      subtitle: threadRationale,
    }),
    threadId: identity.threadId,
  };
}

export function getThreadGroupProminence(items: FeedItem[]): FeedProminence | null {
  return getStrongestFeedProminence(items.map((item) => item.metadata?.thread?.prominence));
}
