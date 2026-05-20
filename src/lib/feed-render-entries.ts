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
