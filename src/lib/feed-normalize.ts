import { type FeedFilter } from '@/lib/feed-filters';
import { getStrongestFeedProminence } from '@/lib/feed-prominence';
import { shouldSuppressFeedSystemNotice } from '@/lib/system-notices';
import { type FeedItem, type FeedPendingCounts, type FeedProminence } from '@/types/feed';

export type FeedSortOrder = 'created' | 'published';

export function normalizeFeedItems(items: FeedItem[]) {
  const map = new Map<string, FeedItem>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

export function isPrimaryFeedItem(item: FeedItem) {
  return (item.type === 'tweet' || item.type === 'article' || item.type === 'analysis')
    && !shouldSuppressFeedSystemNotice(item);
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

export function shouldIncludeConversationTimelineEntry({
  selectedFilter,
  oldestLoadedPrimaryFeedItemTimestamp,
  conversationLastTimestamp,
}: {
  selectedFilter: FeedFilter;
  oldestLoadedPrimaryFeedItemTimestamp: string | null;
  conversationLastTimestamp: string;
}): boolean {
  if (selectedFilter === 'agent') {
    return true;
  }

  return oldestLoadedPrimaryFeedItemTimestamp === null
    || conversationLastTimestamp.localeCompare(oldestLoadedPrimaryFeedItemTimestamp) >= 0;
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

export function compareFeedItems(left: FeedItem, right: FeedItem, sortOrder: FeedSortOrder): number {
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

export function getThreadGroupIdentity(item: FeedItem): { key: string; threadId: string; cycleId: string } | null {
  const threadId = readTrimmedMetadataString(item.metadata?.thread?.threadId);
  const cycleId = readTrimmedMetadataString(item.metadata?.cycleId);
  if (!threadId || !cycleId) {
    return null;
  }

  return {
    key: `${threadId}::${cycleId}`,
    threadId,
    cycleId,
  };
}

export function getThreadGroupProminence(items: FeedItem[]): FeedProminence | null {
  return getStrongestFeedProminence(items.map((item) => item.metadata?.thread?.prominence));
}
