import type { FeedSortOrder } from '@/lib/feed-query';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

export const SUGGESTION_GROUP_RESOLVED_HISTORY_LIMIT = 8;

function compareFeedItemsBySortOrder(left: FeedItem, right: FeedItem, sortOrder: FeedSortOrder): number {
  if (sortOrder === 'published') {
    const byPublished = right.publishedAt.localeCompare(left.publishedAt);
    if (byPublished !== 0) return byPublished;
    return right.createdAt.localeCompare(left.createdAt);
  }

  const byCreated = right.createdAt.localeCompare(left.createdAt);
  if (byCreated !== 0) return byCreated;
  return right.publishedAt.localeCompare(left.publishedAt);
}

export function getSuggestionGroupStatus(item: FeedItem): SuggestionStatus {
  const metadataStatus = typeof item.metadata?.suggestionStatus === 'string'
    ? item.metadata.suggestionStatus.trim().toLowerCase()
    : '';
  const status = item.suggestionStatus ?? metadataStatus ?? 'pending';

  switch (status) {
    case 'accepted':
    case 'dismissed':
    case 'dispatched':
    case 'running':
    case 'merged':
    case 'failed':
      return status;
    default:
      return 'pending';
  }
}

export function isCurrentSuggestionStatus(status: SuggestionStatus): boolean {
  return status === 'pending'
    || status === 'dispatched'
    || status === 'running';
}

export function isResolvedSuggestionStatus(status: SuggestionStatus): boolean {
  return status === 'accepted' || status === 'merged' || status === 'failed';
}

function getSuggestionStatusRank(status: SuggestionStatus): number {
  switch (status) {
    case 'failed':
      return 4;
    case 'running':
      return 1;
    case 'dispatched':
      return 2;
    case 'pending':
      return 3;
    case 'merged':
      return 4;
    case 'accepted':
      return 5;
    case 'dismissed':
      return 6;
  }
}

export function sortSuggestionGroupItems(items: FeedItem[], sortOrder: FeedSortOrder): FeedItem[] {
  return [...items].sort((left, right) => {
    const leftStatus = getSuggestionGroupStatus(left);
    const rightStatus = getSuggestionGroupStatus(right);
    const statusRank = getSuggestionStatusRank(leftStatus) - getSuggestionStatusRank(rightStatus);
    if (statusRank !== 0) {
      return statusRank;
    }

    if (isCurrentSuggestionStatus(leftStatus) && isCurrentSuggestionStatus(rightStatus)) {
      return left.createdAt.localeCompare(right.createdAt)
        || left.publishedAt.localeCompare(right.publishedAt)
        || left.id.localeCompare(right.id);
    }

    return compareFeedItemsBySortOrder(left, right, sortOrder);
  });
}

export function buildSuggestionGroupItems(
  items: FeedItem[],
  sortOrder: FeedSortOrder,
  resolvedHistoryLimit = SUGGESTION_GROUP_RESOLVED_HISTORY_LIMIT,
): FeedItem[] {
  const deduped = Array.from(
    items
      .filter((item) => item.type === 'suggestion')
      .reduce((map, item) => {
        map.set(item.id, item);
        return map;
      }, new Map<string, FeedItem>())
      .values(),
  ).filter((item) => getSuggestionGroupStatus(item) !== 'dismissed');

  const currentItems = deduped.filter((item) => isCurrentSuggestionStatus(getSuggestionGroupStatus(item)));
  const resolvedItems = sortSuggestionGroupItems(
    deduped.filter((item) => isResolvedSuggestionStatus(getSuggestionGroupStatus(item))),
    sortOrder,
  ).slice(0, Math.max(0, resolvedHistoryLimit));

  return sortSuggestionGroupItems([...currentItems, ...resolvedItems], sortOrder);
}

export function getSuggestionGroupPreviewItems(groupItems: FeedItem[], loadedItems: FeedItem[]): FeedItem[] {
  const loadedSuggestionIds = new Set(
    loadedItems
      .filter((item) => item.type === 'suggestion')
      .map((item) => item.id),
  );

  if (loadedSuggestionIds.size === 0) {
    return [];
  }

  return groupItems.filter((item) => loadedSuggestionIds.has(item.id));
}

export function getSuggestionGroupLatestTimestamp(items: FeedItem[]): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestTimestamp: string | null = null;

  for (const item of items) {
    const candidate = item.createdAt || item.publishedAt || '';
    const candidateMs = Date.parse(candidate);
    if (!Number.isFinite(candidateMs) || candidateMs <= latestMs) {
      continue;
    }
    latestMs = candidateMs;
    latestTimestamp = candidate;
  }

  return latestTimestamp;
}

export function getSuggestionGroupTitle(items: FeedItem[]): string {
  const currentCount = items.filter((item) => isCurrentSuggestionStatus(getSuggestionGroupStatus(item))).length;
  const resolvedCount = items.filter((item) => isResolvedSuggestionStatus(getSuggestionGroupStatus(item))).length;

  if (currentCount > 0 && resolvedCount > 0) {
    return `${currentCount} open, ${resolvedCount} recent resolved`;
  }
  if (currentCount > 0) {
    return `${currentCount} open`;
  }
  if (resolvedCount > 0) {
    return `${resolvedCount} recent resolved`;
  }

  return 'Suggestions';
}
