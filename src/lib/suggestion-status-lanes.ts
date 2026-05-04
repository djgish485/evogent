import type { FeedItem, SuggestionStatus } from '@/types/feed';

export type SuggestionLifecycleLane = 'pending' | 'active' | 'complete';

export function getSuggestionLifecycleLane(status: SuggestionStatus): SuggestionLifecycleLane {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'dispatched':
    case 'running':
      return 'active';
    case 'accepted':
    case 'dismissed':
    case 'merged':
    case 'failed':
      return 'complete';
    default:
      return 'pending';
  }
}

export function partitionSuggestionItemsByLifecycle<T extends FeedItem>(
  items: T[],
  resolveSuggestionStatus: (item: T) => SuggestionStatus,
): Record<SuggestionLifecycleLane, T[]> {
  const lanes: Record<SuggestionLifecycleLane, T[]> = {
    pending: [],
    active: [],
    complete: [],
  };

  for (const item of items) {
    if (item.type !== 'suggestion') {
      continue;
    }

    lanes[getSuggestionLifecycleLane(resolveSuggestionStatus(item))].push(item);
  }

  return lanes;
}
