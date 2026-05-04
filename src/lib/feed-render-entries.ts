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
  cycleId: string;
  threadTitle: string;
  threadRationale: string | null;
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
  return getFeedEntryTimestamp(right, conversations).localeCompare(getFeedEntryTimestamp(left, conversations));
}
