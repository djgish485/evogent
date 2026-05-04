import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db/client';

export type ThreadFeedbackVote = 'more' | 'less';

export interface ThreadFeedbackInsert {
  threadId: string;
  cycleId?: string | null;
  feedItemId?: string | null;
  vote: ThreadFeedbackVote;
  threadTitle?: string | null;
  reason?: string | null;
  category?: string | null;
  probeReason?: string | null;
  probeUncertainty?: string | null;
  sourceItemIds?: string[];
  originSessionId?: string | null;
  createdAt?: string | null;
}

export interface ThreadFeedbackRow {
  id: string;
  threadId: string;
  cycleId: string | null;
  feedItemId: string | null;
  vote: ThreadFeedbackVote;
  threadTitle: string | null;
  reason: string | null;
  category: string | null;
  probeReason: string | null;
  probeUncertainty: string | null;
  sourceItemIds: string[];
  originSessionId: string | null;
  createdAt: string;
}

interface ThreadFeedbackDbRow {
  id: string;
  thread_id: string;
  cycle_id: string | null;
  feed_item_id: string | null;
  vote: ThreadFeedbackVote;
  thread_title: string | null;
  reason: string | null;
  category: string | null;
  probe_reason: string | null;
  probe_uncertainty: string | null;
  source_item_ids: string | null;
  origin_session_id: string | null;
  created_at: string;
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function normalizeSourceItemIds(input: string[] | null | undefined): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((entry) => entry.trim()).filter(Boolean)));
}

function parseSourceItemIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizeSourceItemIds(parsed.filter((entry): entry is string => typeof entry === 'string'))
      : [];
  } catch {
    return [];
  }
}

function toThreadFeedbackRow(row: ThreadFeedbackDbRow): ThreadFeedbackRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    cycleId: row.cycle_id,
    feedItemId: row.feed_item_id,
    vote: row.vote,
    threadTitle: row.thread_title,
    reason: row.reason,
    category: row.category,
    probeReason: row.probe_reason,
    probeUncertainty: row.probe_uncertainty,
    sourceItemIds: parseSourceItemIds(row.source_item_ids),
    originSessionId: row.origin_session_id,
    createdAt: row.created_at,
  };
}

export function insertThreadFeedback(input: ThreadFeedbackInsert): ThreadFeedbackRow {
  const threadId = input.threadId.trim();
  if (!threadId) {
    throw new Error('threadId is required');
  }

  const db = getDb();
  const id = randomUUID();
  const sourceItemIds = normalizeSourceItemIds(input.sourceItemIds);
  const vote = input.vote === 'less' ? 'less' : 'more';

  db.prepare(`
    INSERT INTO thread_feedback (
      id,
      thread_id,
      cycle_id,
      feed_item_id,
      vote,
      thread_title,
      reason,
      category,
      probe_reason,
      probe_uncertainty,
      source_item_ids,
      origin_session_id,
      created_at
    ) VALUES (
      @id,
      @thread_id,
      @cycle_id,
      @feed_item_id,
      @vote,
      @thread_title,
      @reason,
      @category,
      @probe_reason,
      @probe_uncertainty,
      @source_item_ids,
      @origin_session_id,
      COALESCE(@created_at, datetime('now'))
    )
  `).run({
    id,
    thread_id: threadId,
    cycle_id: trimToNull(input.cycleId),
    feed_item_id: trimToNull(input.feedItemId),
    vote,
    thread_title: trimToNull(input.threadTitle),
    reason: trimToNull(input.reason),
    category: trimToNull(input.category),
    probe_reason: trimToNull(input.probeReason),
    probe_uncertainty: trimToNull(input.probeUncertainty),
    source_item_ids: JSON.stringify(sourceItemIds),
    origin_session_id: trimToNull(input.originSessionId),
    created_at: trimToNull(input.createdAt),
  });

  const row = db.prepare(`
    SELECT *
    FROM thread_feedback
    WHERE id = ?
  `).get(id) as ThreadFeedbackDbRow;

  return toThreadFeedbackRow(row);
}

export function getRecentThreadFeedback(limit = 50): ThreadFeedbackRow[] {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(500, Math.floor(limit)))
    : 50;
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM thread_feedback
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(normalizedLimit) as ThreadFeedbackDbRow[];

  return rows.map(toThreadFeedbackRow);
}
