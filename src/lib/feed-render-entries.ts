import { type GroupType } from '@/components/feed/grouped-items-card';
import { type AnalysisSeriesBundleEntry } from '@/lib/analysis-presentation';
import { type ConversationCardViewModel } from '@/lib/conversation-summary';
import { type FeedbackProbeMetadata, type FeedItem, type FeedProminence } from '@/types/feed';

export interface GroupedItemsRenderEntry {
  kind: 'group';
  groupId: string;
  groupType: GroupType;
  title: string;
  items: FeedItem[];
  previewItems?: FeedItem[];
  latestTimestamp: string | null;
}

export interface FeedItemRenderEntry {
  kind: 'item';
  item: FeedItem;
}

export interface AnalysisSeriesRenderEntry {
  kind: 'analysis-series';
  series: AnalysisSeriesBundleEntry;
}

export interface ThreadGroupRenderEntry {
  kind: 'thread-group';
  groupId: string;
  threadId: string;
  threadTitle: string;
  threadSubtitle: string | null;
  threadProminence: FeedProminence | null;
  feedbackProbe: FeedbackProbeMetadata | null;
  sourceItemIds: string[];
  continuing: boolean;
  analysisItems: FeedItem[];
  items: FeedItem[];
  latestTimestamp: string;
}

export interface ConversationRenderEntry {
  kind: 'conversation';
  conversationId: string;
}

export type FeedRenderEntry =
  | FeedItemRenderEntry
  | GroupedItemsRenderEntry
  | AnalysisSeriesRenderEntry
  | ThreadGroupRenderEntry
  | ConversationRenderEntry;

/** Thread chrome makes a relational claim, so duplicate or singleton rows remain plain cards. */
export function hasTruthfulThreadMembers(
  items: readonly Pick<FeedItem, 'id'>[],
): boolean {
  return new Set(items.map((item) => item.id).filter(Boolean)).size >= 2;
}

function minDisplayOrder(items: FeedItem[]): number | null {
  let current: number | null = null;
  for (const item of items) {
    if (typeof item.displayOrder !== 'number') {
      continue;
    }
    current = current === null ? item.displayOrder : Math.min(current, item.displayOrder);
  }
  return current;
}

export function getFeedEntryDisplayOrder(entry: FeedRenderEntry): number | null {
  if (entry.kind === 'item') {
    return typeof entry.item.displayOrder === 'number' ? entry.item.displayOrder : null;
  }
  if (entry.kind === 'group') {
    return minDisplayOrder(entry.items);
  }
  if (entry.kind === 'analysis-series') {
    return minDisplayOrder(entry.series.items);
  }
  if (entry.kind === 'thread-group') {
    return minDisplayOrder([...entry.analysisItems, ...entry.items]);
  }
  return null;
}

export function getFeedEntryTimestamp(entry: FeedRenderEntry, conversations: Record<string, ConversationCardViewModel>): string {
  if (entry.kind === 'conversation') {
    const conversation = conversations[entry.conversationId];
    return conversation?.searchMatchTimestamp ?? conversation?.lastTimestamp ?? '';
  }
  if (entry.kind === 'group') {
    return entry.latestTimestamp ?? '';
  }
  if (entry.kind === 'analysis-series') {
    return entry.series.latestTimestamp;
  }
  if (entry.kind === 'thread-group') {
    return entry.latestTimestamp;
  }
  return entry.item.createdAt;
}

export function compareTimelineEntries(
  left: FeedRenderEntry,
  right: FeedRenderEntry,
  conversations: Record<string, ConversationCardViewModel>,
): number {
  const leftDisplayOrder = getFeedEntryDisplayOrder(left);
  const rightDisplayOrder = getFeedEntryDisplayOrder(right);
  if (leftDisplayOrder !== null || rightDisplayOrder !== null) {
    if (leftDisplayOrder === null) return 1;
    if (rightDisplayOrder === null) return -1;
    const byDisplayOrder = leftDisplayOrder - rightDisplayOrder;
    if (byDisplayOrder !== 0) return byDisplayOrder;
  }

  return getFeedEntryTimestamp(right, conversations).localeCompare(getFeedEntryTimestamp(left, conversations));
}

export function compareThreadGroupItems(left: FeedItem, right: FeedItem): number {
  const leftDisplayOrder = typeof left.displayOrder === 'number' ? left.displayOrder : null;
  const rightDisplayOrder = typeof right.displayOrder === 'number' ? right.displayOrder : null;
  if (leftDisplayOrder !== null || rightDisplayOrder !== null) {
    if (leftDisplayOrder === null) return 1;
    if (rightDisplayOrder === null) return -1;
    const byDisplayOrder = leftDisplayOrder - rightDisplayOrder;
    if (byDisplayOrder !== 0) return byDisplayOrder;
  }

  const byCreated = right.createdAt.localeCompare(left.createdAt);
  if (byCreated !== 0) {
    return byCreated;
  }
  const byPublished = right.publishedAt.localeCompare(left.publishedAt);
  if (byPublished !== 0) {
    return byPublished;
  }
  return left.id.localeCompare(right.id);
}

export function mergeFeedItemsInServerOrder(serverItems: FeedItem[], currentItems: FeedItem[]): FeedItem[] {
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const merged: FeedItem[] = [];

  for (const item of serverItems) {
    const existing = currentById.get(item.id);
    merged.push(existing ? { ...existing, ...item } : item);
    seen.add(item.id);
  }

  // Keep locally-known items the snapshot doesn't cover ONLY when they sit beyond the
  // snapshot's window (deep-scroll pagination tail). An item that WAS inside the window and is
  // now absent has been REMOVED server-side (dismissed / disliked / expired) — re-appending it
  // resurrects dismissed cards indefinitely on the glass. Removed is removed; the tail is
  // preserved.
  const windowSize = serverItems.length;
  currentItems.forEach((item, index) => {
    if (!seen.has(item.id) && index >= windowSize) {
      merged.push(item);
      seen.add(item.id);
    }
  });

  return merged;
}

export function pinVisibleFeedItems(nextItems: FeedItem[], currentItems: FeedItem[], pinnedItemIds: Set<string>): FeedItem[] {
  if (pinnedItemIds.size === 0) {
    return nextItems;
  }

  const nextById = new Map(nextItems.map((item) => [item.id, item]));
  const remaining = nextItems.filter((item) => !pinnedItemIds.has(item.id));
  const used = new Set<string>();
  const pinnedOutput: FeedItem[] = [];
  let remainingIndex = 0;

  for (const currentItem of currentItems) {
    if (pinnedItemIds.has(currentItem.id)) {
      const nextPinnedItem = nextById.get(currentItem.id);
      if (nextPinnedItem) {
        pinnedOutput.push(nextPinnedItem);
        used.add(currentItem.id);
      }
      continue;
    }

    while (remainingIndex < remaining.length && used.has(remaining[remainingIndex]!.id)) {
      remainingIndex += 1;
    }

    const nextItem = remaining[remainingIndex];
    if (nextItem) {
      pinnedOutput.push(nextItem);
      used.add(nextItem.id);
      remainingIndex += 1;
    }
  }

  for (const item of nextItems) {
    if (!used.has(item.id)) {
      pinnedOutput.push(item);
      used.add(item.id);
    }
  }

  return pinnedOutput;
}

const FEED_PRESENTATION_FIELDS = [
  'displayOrder',
  'threadDisplayEnabled',
  'threadId',
  'displaySubtitle',
  'threadTitle',
  'threadSubtitle',
] as const;

/**
 * Reconcile removals and fresh item content without changing the timeline's shape. A live arrange
 * can resolve between pointer-down and click; applying even the new displayOrder fields would let
 * the render-entry sort move or regroup the element under the finger despite array-level pinning.
 * New snapshot-only items also wait for the explicit "Show new order" action.
 */
export function stageFeedArrangementItems(
  nextItems: FeedItem[],
  currentItems: FeedItem[],
): FeedItem[] {
  const nextById = new Map(nextItems.map((item) => [item.id, item]));

  return currentItems.flatMap((currentItem) => {
    const nextItem = nextById.get(currentItem.id);
    if (!nextItem) {
      // A server-side removal is authoritative and applies immediately.
      return [];
    }

    const stagedItem: FeedItem = { ...currentItem, ...nextItem };
    for (const field of FEED_PRESENTATION_FIELDS) {
      Object.assign(stagedItem, { [field]: currentItem[field] });
    }
    return [stagedItem];
  });
}

export function countFeedPresentationChanges(
  nextItems: FeedItem[],
  currentItems: FeedItem[],
): number {
  const currentIndexById = new Map(currentItems.map((item, index) => [item.id, index]));
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  let count = 0;

  nextItems.forEach((item, index) => {
    const currentItem = currentById.get(item.id);
    if (!currentItem) {
      count += 1;
      return;
    }
    const moved = currentIndexById.get(item.id) !== index;
    const presentationChanged = FEED_PRESENTATION_FIELDS.some(
      (field) => currentItem[field] !== item[field],
    );
    if (moved || presentationChanged) {
      count += 1;
    }
  });

  return count;
}

export function countReorganizedItems(nextItems: FeedItem[], currentItems: FeedItem[], pinnedItemIds = new Set<string>()): number {
  const currentIndexById = new Map(currentItems.map((item, index) => [item.id, index]));
  let count = 0;

  nextItems.forEach((item, index) => {
    if (pinnedItemIds.has(item.id)) {
      return;
    }
    const previousIndex = currentIndexById.get(item.id);
    if (previousIndex !== undefined && previousIndex !== index) {
      count += 1;
    }
  });

  return count;
}

export function shouldStageVisibleFeedReorder(
  visibleItemCount: number,
  forceApply = false,
): boolean {
  return !forceApply && visibleItemCount > 0;
}
