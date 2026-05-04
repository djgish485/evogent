import type { FeedItem } from '@/types/feed';

type FeedItemEnrichmentCarrier = Pick<FeedItem, 'metadata' | 'metrics' | 'children'> | null;
export type FeedItemBatchEnrichmentState = 'none' | 'enriching' | 'complete' | 'failed' | 'incomplete';

const fallbackBatchEnrichmentDeadlineMs = 30 * 60 * 1000;

function hasReplyChildren(item: FeedItemEnrichmentCarrier): boolean {
  if (!item) return false;

  return Array.isArray(item.children) && item.children.some((child) => child.relationship === 'reply');
}

function hasTerminalReplyAudit(item: FeedItemEnrichmentCarrier): boolean {
  const audit = item?.metadata?.batchEnrichment?.replyAudit;
  if (!audit || typeof audit !== 'object') {
    return false;
  }

  if (typeof audit.savedReplyCount === 'number' && audit.savedReplyCount > 0) {
    return true;
  }

  if (Array.isArray(audit.savedReplyIds) && audit.savedReplyIds.length > 0) {
    return true;
  }

  if (typeof audit.noMeaningfulRepliesReason === 'string' && audit.noMeaningfulRepliesReason.trim().length > 0) {
    return true;
  }

  return (audit.inspectedReplySurface === true || audit.inspectedCommentSurface === true)
    && typeof audit.inspectedAt === 'string'
    && audit.inspectedAt.trim().length > 0;
}

export function isAwaitingFullEnrichmentMetrics(item: FeedItemEnrichmentCarrier): boolean {
  if (
    !item
    || typeof item.metadata?.fullEnrichmentRequestId !== 'string'
    || item.metadata.fullEnrichmentRequestId.trim().length === 0
  ) {
    return false;
  }

  const likes = typeof item.metrics.likes === 'number' ? item.metrics.likes : 0;
  const views = item.metrics.views;

  return likes <= 0 && (typeof views !== 'number' || views <= 0);
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isExpiredBatchEnrichment(batch: NonNullable<FeedItem['metadata']>['batchEnrichment'], nowMs: number): boolean {
  if (!batch || (batch.status !== 'queued' && batch.status !== 'running')) {
    return false;
  }

  const deadlineAtMs = parseTimestampMs(batch.deadlineAt);
  if (deadlineAtMs !== null) {
    return nowMs >= deadlineAtMs;
  }

  const queuedAtMs = parseTimestampMs(batch.startedAt) ?? parseTimestampMs(batch.queuedAt);
  return queuedAtMs !== null && nowMs >= queuedAtMs + fallbackBatchEnrichmentDeadlineMs;
}

export function getFeedItemBatchEnrichmentState(
  item: FeedItemEnrichmentCarrier,
  options: { nowMs?: number } = {},
): FeedItemBatchEnrichmentState {
  const batch = item?.metadata?.batchEnrichment;
  const requestId = typeof batch?.requestId === 'string' ? batch.requestId.trim() : '';
  if (!requestId) {
    return 'none';
  }

  if (hasReplyChildren(item) || hasTerminalReplyAudit(item)) {
    return 'complete';
  }

  if (batch?.status === 'failed') {
    return 'failed';
  }

  if (isExpiredBatchEnrichment(batch, options.nowMs ?? Date.now())) {
    return 'failed';
  }

  if (batch?.status === 'completed') {
    return 'incomplete';
  }

  return 'enriching';
}
