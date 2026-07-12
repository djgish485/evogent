import { getDb } from './client';

export type ActivityEvent = 'app_open' | 'pull_refresh' | 'ping' | 'foreground' | 'background';

export interface UserActivityRecord {
  id: number;
  event: ActivityEvent;
  timestamp: string;
  metadata: Record<string, unknown> | null;
}

export interface CurationLogRecord {
  id: number;
  requestId: string | null;
  triggeredBy: string;
  startedAt: string;
  completedAt: string | null;
  itemsAdded: number | null;
  feedCountBefore: number | null;
  completionStatus: CurationLogCompletionStatus | null;
  completionReason: string | null;
}

export interface AutomatedCurationCancellationRecord {
  requestId: string | null;
  triggeredBy: string;
  cancelledAt: string;
  cancellationReason: string | null;
}

export interface CurationLogStartInput {
  requestId: string;
  triggeredBy: string;
  startedAt?: string;
  feedCountBefore?: number | null;
}

export interface CurationLogCompleteInput {
  completedAt?: string;
  itemsAdded?: number | null;
  completionStatus?: CurationLogCompletionStatus | null;
  completionReason?: string | null;
}

export type CurationLogCompletionStatus = 'success' | 'successful_empty' | 'empty' | 'cancelled' | 'failed' | 'aborted';

const validCompletionStatuses: CurationLogCompletionStatus[] = [
  'success',
  'successful_empty',
  'empty',
  'cancelled',
  'failed',
  'aborted',
];

const validActivityEvents: ActivityEvent[] = ['app_open', 'pull_refresh', 'ping', 'foreground', 'background'];

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function toIso(timestamp: string | undefined): string {
  if (!timestamp) return new Date().toISOString();
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function toPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeCompletionStatus(value: CurationLogCompletionStatus | null | undefined): CurationLogCompletionStatus | null {
  if (typeof value !== 'string') return null;
  return validCompletionStatuses.includes(value) ? value : null;
}

function normalizeCompletionReason(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 500);
}

export function isActivityEvent(value: unknown): value is ActivityEvent {
  return typeof value === 'string' && validActivityEvents.includes(value as ActivityEvent);
}

export function insertUserActivity(event: ActivityEvent, metadata: Record<string, unknown> | null = null, timestamp?: string): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO user_activity (event, timestamp, metadata)
    VALUES (@event, @timestamp, @metadata)
  `).run({
    event,
    timestamp: toIso(timestamp),
    metadata: metadata ? JSON.stringify(metadata) : null,
  });

  return Number(result.lastInsertRowid);
}

export function getRecentUserActivity(limit = 500): UserActivityRecord[] {
  const db = getDb();
  const safeLimit = toPositiveInt(limit, 500);
  const rows = db.prepare(`
    SELECT id, event, timestamp, metadata
    FROM user_activity
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(safeLimit) as Array<{
    id: number;
    event: ActivityEvent;
    timestamp: string;
    metadata: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    timestamp: row.timestamp,
    metadata: parseJsonRecord(row.metadata),
  }));
}

export function getMostRecentActivity(): UserActivityRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, event, timestamp, metadata
    FROM user_activity
    ORDER BY timestamp DESC
    LIMIT 1
  `).get() as {
    id: number;
    event: ActivityEvent;
    timestamp: string;
    metadata: string | null;
  } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    event: row.event,
    timestamp: row.timestamp,
    metadata: parseJsonRecord(row.metadata),
  };
}

export function getLastAppOpenAtMs(): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT timestamp
    FROM user_activity
    WHERE event = 'app_open'
    ORDER BY timestamp DESC
    LIMIT 1
  `).get() as { timestamp: string } | undefined;

  if (!row?.timestamp) return null;
  const parsedMs = Date.parse(row.timestamp);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

export function insertCurationLogStart(input: CurationLogStartInput): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO curation_log (request_id, triggered_by, started_at, feed_count_before)
    VALUES (@request_id, @triggered_by, @started_at, @feed_count_before)
  `).run({
    request_id: input.requestId,
    triggered_by: input.triggeredBy,
    started_at: toIso(input.startedAt),
    feed_count_before: typeof input.feedCountBefore === 'number' ? Math.max(0, Math.floor(input.feedCountBefore)) : null,
  });

  return Number(result.lastInsertRowid);
}

export function completeCurationLogByRequestId(requestId: string, input: CurationLogCompleteInput): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE curation_log
    SET
      completed_at = @completed_at,
      items_added = @items_added,
      completion_status = @completion_status,
      completion_reason = @completion_reason
    WHERE request_id = @request_id
  `).run({
    request_id: requestId,
    completed_at: toIso(input.completedAt),
    items_added: typeof input.itemsAdded === 'number' ? Math.max(0, Math.floor(input.itemsAdded)) : null,
    completion_status: normalizeCompletionStatus(input.completionStatus),
    completion_reason: normalizeCompletionReason(input.completionReason),
  });

  return result.changes > 0;
}

export function completeLatestPendingAutomatedCurationCycle(input: CurationLogCompleteInput = {}): boolean {
  const db = getDb();
  const pendingRow = db.prepare(`
    SELECT id, feed_count_before
    FROM curation_log
    WHERE completed_at IS NULL
      AND triggered_by LIKE 'adaptive_heartbeat:%'
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT 1
  `).get() as { id: number; feed_count_before: number | null } | undefined;

  if (!pendingRow) return false;

  const submittedItemsAdded = typeof input.itemsAdded === 'number'
    ? Math.max(0, Math.floor(input.itemsAdded))
    : 0;
  const baseline = typeof pendingRow.feed_count_before === 'number'
    ? Math.max(0, Math.floor(pendingRow.feed_count_before))
    : null;
  const feedDelta = baseline === null
    ? 0
    : Math.max(0, getFeedItemCount() - baseline);
  const itemsAdded = Math.max(submittedItemsAdded, feedDelta);
  const completionStatus: CurationLogCompletionStatus = normalizeCompletionStatus(input.completionStatus)
    ?? (itemsAdded > 0 ? 'success' : 'successful_empty');
  const resolvedCompletionStatus = itemsAdded > 0 && completionStatus === 'successful_empty'
    ? 'success'
    : completionStatus;

  const result = db.prepare(`
    UPDATE curation_log
    SET
      completed_at = @completed_at,
      items_added = @items_added,
      completion_status = @completion_status,
      completion_reason = @completion_reason
    WHERE id = @id
      AND completed_at IS NULL
  `).run({
    id: pendingRow.id,
    completed_at: toIso(input.completedAt),
    items_added: itemsAdded,
    completion_status: resolvedCompletionStatus,
    completion_reason: normalizeCompletionReason(input.completionReason),
  });

  return result.changes > 0;
}

export function deletePendingCurationLogByRequestId(requestId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM curation_log
    WHERE request_id = @request_id
      AND completed_at IS NULL
  `).run({
    request_id: requestId,
  });

  return result.changes > 0;
}

export function getRecentCurationLogs(limit = 200): CurationLogRecord[] {
  const db = getDb();
  const safeLimit = toPositiveInt(limit, 200);
  const rows = db.prepare(`
    SELECT id, request_id, triggered_by, started_at, completed_at, items_added, feed_count_before, completion_status, completion_reason
    FROM curation_log
    ORDER BY started_at DESC
    LIMIT ?
  `).all(safeLimit) as Array<{
    id: number;
    request_id: string | null;
    triggered_by: string;
    started_at: string;
    completed_at: string | null;
    items_added: number | null;
    feed_count_before: number | null;
    completion_status: CurationLogCompletionStatus | null;
    completion_reason: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    requestId: row.request_id,
    triggeredBy: row.triggered_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    itemsAdded: row.items_added,
    feedCountBefore: row.feed_count_before,
    completionStatus: normalizeCompletionStatus(row.completion_status),
    completionReason: row.completion_reason,
  }));
}

export function getCurationLogByRequestId(requestId: string): CurationLogRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, request_id, triggered_by, started_at, completed_at, items_added, feed_count_before, completion_status, completion_reason
    FROM curation_log
    WHERE request_id = ?
    LIMIT 1
  `).get(requestId) as {
    id: number;
    request_id: string | null;
    triggered_by: string;
    started_at: string;
    completed_at: string | null;
    items_added: number | null;
    feed_count_before: number | null;
    completion_status: CurationLogCompletionStatus | null;
    completion_reason: string | null;
  } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    triggeredBy: row.triggered_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    itemsAdded: row.items_added,
    feedCountBefore: row.feed_count_before,
    completionStatus: normalizeCompletionStatus(row.completion_status),
    completionReason: row.completion_reason,
  };
}

// A curate turn that is genuinely alive replies well inside this window; anything older is a
// crashed run whose incomplete row must not block new curations. The old 3-hour window turned
// one crashed turn into a 3-hour feed outage during active use (2026-07-11: a codex turn died
// under memory pressure at 18:03 and every app-open trigger until ~21:03 was silently ignored).
const pendingCurationStaleMs = 25 * 60 * 1000;

export function hasPendingCurationCycle(): boolean {
  const db = getDb();
  const curationLogRow = db.prepare(`
    SELECT id, started_at
    FROM curation_log
    WHERE completed_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `).get() as { id: number; started_at: string } | undefined;

  if (curationLogRow) {
    const startedAt = new Date(curationLogRow.started_at);
    const ageMs = Number.isNaN(startedAt.getTime())
      ? Number.POSITIVE_INFINITY
      : Date.now() - startedAt.getTime();
    if (ageMs <= pendingCurationStaleMs) {
      return true;
    }
    // Self-heal: the run is dead (crashed without completing its row). Close it out so it
    // stops matching this query instead of lingering as NULL forever.
    db.prepare(`
      UPDATE curation_log
      SET completed_at = datetime('now'),
          completion_status = 'aborted',
          completion_reason = 'auto-closed: run exceeded the pending window without completing (crashed turn)'
      WHERE completed_at IS NULL
    `).run();
  }

  const queuedChatRow = db.prepare(`
    SELECT m.timestamp
    FROM chat_messages AS m
    INNER JOIN chat_sessions AS s
      ON s.id = m.session_id
    WHERE s.session_type = 'curator'
      AND m.type = 'chat'
      AND m.role = 'user'
      AND lower(trim(m.text)) IN ('/curate', '/curate-latest')
      AND COALESCE(m.status, '') IN ('pending', 'queued', 'processing', 'running')
      AND datetime(m.timestamp) >= datetime('now', '-25 minutes')
    ORDER BY datetime(m.timestamp) DESC, datetime(m.created_at) DESC
    LIMIT 1
  `).get() as { timestamp: string } | undefined;

  return Boolean(queuedChatRow);
}

export function getLatestCompletedCurationTime(): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT completed_at
    FROM curation_log
    WHERE completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `).get() as { completed_at: string } | undefined;

  if (!row) return null;
  return row.completed_at;
}

export function getLatestSuccessfulCurationTime(): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT completed_at
    FROM curation_log
    WHERE completed_at IS NOT NULL
      AND (
        COALESCE(items_added, 0) > 0
        OR completion_status = 'successful_empty'
      )
      AND COALESCE(completion_status, '') NOT IN ('cancelled', 'failed', 'aborted', 'empty')
    ORDER BY completed_at DESC
    LIMIT 1
  `).get() as { completed_at: string } | undefined;

  if (!row) return null;
  return row.completed_at;
}

export function getLatestAutomatedCurationCancellation(): AutomatedCurationCancellationRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT request_id, triggered_by, completed_at, completion_reason
    FROM curation_log
    WHERE completed_at IS NOT NULL
      AND completion_status = 'cancelled'
      AND triggered_by LIKE 'adaptive_heartbeat:%'
    ORDER BY datetime(completed_at) DESC, id DESC
    LIMIT 1
  `).get() as {
    request_id: string | null;
    triggered_by: string;
    completed_at: string;
    completion_reason: string | null;
  } | undefined;

  if (!row) return null;
  return {
    requestId: row.request_id,
    triggeredBy: row.triggered_by,
    cancelledAt: row.completed_at,
    cancellationReason: row.completion_reason,
  };
}

export function getFeedItemCount(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as count FROM feed`).get() as { count: number };
  return row.count;
}
