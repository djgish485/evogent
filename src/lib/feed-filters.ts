import { type FeedItemType, type FeedPendingCounts } from '@/types/feed';

export type PrimaryFeedFilter = Exclude<FeedItemType, 'notification'>;

export type FeedFilter = 'all' | PrimaryFeedFilter | 'agent' | 'notification' | (string & {});

export type FeedFilterOption = { value: FeedFilter; label: string; testId: string };

export type FeedSourceOption = { value: string; label: string };

const ALWAYS_FEED_FILTERS: FeedFilterOption[] = [
  { value: 'all', label: 'All', testId: 'type-filter-all' },
  { value: 'agent', label: 'Agent', testId: 'type-filter-agent' },
  { value: 'suggestion', label: 'Suggestion', testId: 'type-filter-suggestion' },
  { value: 'notification', label: 'Notification', testId: 'type-filter-notification' },
];

const TWEET_FEED_FILTER: FeedFilterOption = { value: 'tweet', label: 'Tweet', testId: 'type-filter-tweet' };
const CURATION_FEED_FILTERS: FeedFilterOption[] = [
  { value: 'article', label: 'Article', testId: 'type-filter-article' },
  { value: 'analysis', label: 'Analysis', testId: 'type-filter-analysis' },
];
const RESERVED_FEED_FILTER_VALUES = new Set<FeedFilter>([
  ...ALWAYS_FEED_FILTERS.map((filter) => filter.value),
  TWEET_FEED_FILTER.value,
  ...CURATION_FEED_FILTERS.map((filter) => filter.value),
]);

export const SOURCE_FILTER_TYPE_ALIASES: Record<string, FeedItemType> = {
  twitter: 'tweet',
  'twitter.com': 'tweet',
  x: 'tweet',
  'x.com': 'tweet',
};

export function normalizeFeedSourceValue(value: string): string {
  return value.trim().toLowerCase();
}

export function hasTweetFeedSource(feedSources: FeedSourceOption[]): boolean {
  return feedSources.some((source) => {
    const value = normalizeFeedSourceValue(source.value);
    return value === 'tweet' || SOURCE_FILTER_TYPE_ALIASES[value] === 'tweet';
  });
}

export function buildBaseFeedFilters(input: { hasTweetSource: boolean; hasCuratorSession: boolean }): FeedFilterOption[] {
  return [
    ALWAYS_FEED_FILTERS[0]!,
    ALWAYS_FEED_FILTERS[1]!,
    ALWAYS_FEED_FILTERS[2]!,
    ...(input.hasTweetSource ? [TWEET_FEED_FILTER] : []),
    ...(input.hasCuratorSession ? [CURATION_FEED_FILTERS[0]!] : []),
    ...(input.hasCuratorSession ? [CURATION_FEED_FILTERS[1]!] : []),
    ALWAYS_FEED_FILTERS[3]!,
  ];
}

export function buildHeaderFeedFilters(feedFilters: FeedFilterOption[]): FeedFilterOption[] {
  return feedFilters.filter((filter) => filter.value !== 'notification');
}

export function buildDynamicFeedSourceFilters(feedSources: FeedSourceOption[]): FeedFilterOption[] {
  const seen = new Set<string>();
  const sourceFilters: FeedFilterOption[] = [];

  for (const source of feedSources) {
    const value = normalizeFeedSourceValue(source.value);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);

    const dedupeValue = SOURCE_FILTER_TYPE_ALIASES[value] ?? value;
    if (RESERVED_FEED_FILTER_VALUES.has(dedupeValue as FeedFilter)) {
      continue;
    }

    sourceFilters.push({
      value: value as FeedFilter,
      label: source.label?.trim() || value,
      testId: `type-filter-${value}`,
    });
  }

  return sourceFilters;
}

export function appendFeedFilterToFeedQuery(
  query: URLSearchParams,
  filter: FeedFilter,
  sourceFilterValues: ReadonlySet<string>,
): void {
  if (filter === 'all' || filter === 'agent') {
    return;
  }
  if (sourceFilterValues.has(filter)) {
    query.set('source', filter);
    return;
  }
  query.set('type', filter);
}

export function resolveFeedFilterClickAction(input: {
  selectedFilter: FeedFilter;
  nextFilter: FeedFilter;
  isFeedSurfaceVisible: boolean;
}): { shouldUpdateFilter: boolean; shouldScrollFeedToTop: boolean } {
  const shouldUpdateFilter = input.nextFilter !== input.selectedFilter;

  return {
    shouldUpdateFilter,
    shouldScrollFeedToTop: !shouldUpdateFilter && input.isFeedSurfaceVisible,
  };
}

export function getFeedFilterBadgeCount(filter: FeedFilter, pendingCounts: FeedPendingCounts): number {
  if (filter === 'suggestion') {
    return pendingCounts.suggestion;
  }
  if (filter === 'notification') {
    return pendingCounts.notification;
  }
  return 0;
}
