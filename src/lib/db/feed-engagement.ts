import { getDb } from './client';

export type FeedEngagementPhase = 'open' | 'checkpoint' | 'close';

export interface FeedEngagementItemSnapshot {
  type?: string | null;
  source?: string | null;
  sourceId?: string | null;
  authorUsername?: string | null;
  title?: string | null;
  text?: string | null;
}

export interface FeedEngagementInput {
  sessionId: string;
  feedItemId: string;
  phase: FeedEngagementPhase;
  activeDwellMs?: number;
  scrollDepthPercent?: number;
  userScrolled?: boolean;
  surface?: string;
  itemSnapshot?: FeedEngagementItemSnapshot | null;
}

export interface FeedEngagementSession {
  sessionId: string;
  feedItemId: string;
  openedAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  activeDwellMs: number;
  maxScrollDepthPercent: number;
  userScrolled: boolean;
  isReturn: boolean;
  surface: string;
  itemSnapshot: FeedEngagementItemSnapshot | null;
}

interface FeedEngagementDbRow {
  session_id: string;
  feed_item_id: string;
  opened_at: string;
  last_seen_at: string;
  closed_at: string | null;
  active_dwell_ms: number;
  max_scroll_depth_pct: number;
  user_scrolled: number;
  is_return: number;
  surface: string;
  item_snapshot: string | null;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/;
const MAX_ACTIVE_DWELL_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_TEXT_LENGTH = 1_200;

function clampInteger(value: number | undefined, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function compactString(value: string | null | undefined, maxLength: number): string | null {
  const normalized = typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeSessionId(value: string): string {
  const normalized = value.trim();
  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error('Invalid engagement session id');
  }
  return normalized;
}

function normalizeFeedItemId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error('Invalid engagement feed item id');
  }
  return normalized;
}

function normalizeSurface(value: string | undefined): string {
  const normalized = compactString(value, 40)?.toLowerCase().replace(/[^a-z0-9:_-]+/g, '_') ?? '';
  return normalized || 'detail';
}

function normalizeSnapshot(value: FeedEngagementItemSnapshot | null | undefined): FeedEngagementItemSnapshot | null {
  if (!value) return null;
  const snapshot: FeedEngagementItemSnapshot = {
    type: compactString(value.type, 40),
    source: compactString(value.source, 100),
    sourceId: compactString(value.sourceId, 300),
    authorUsername: compactString(value.authorUsername, 100),
    title: compactString(value.title, 400),
    text: compactString(value.text, MAX_SNAPSHOT_TEXT_LENGTH),
  };

  return Object.values(snapshot).some((entry) => entry !== null) ? snapshot : null;
}

function parseSnapshot(value: string | null): FeedEngagementItemSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeSnapshot(parsed as FeedEngagementItemSnapshot);
  } catch {
    return null;
  }
}

function toSession(row: FeedEngagementDbRow): FeedEngagementSession {
  return {
    sessionId: row.session_id,
    feedItemId: row.feed_item_id,
    openedAt: row.opened_at,
    lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at,
    activeDwellMs: row.active_dwell_ms,
    maxScrollDepthPercent: row.max_scroll_depth_pct,
    userScrolled: row.user_scrolled === 1,
    isReturn: row.is_return === 1,
    surface: row.surface,
    itemSnapshot: parseSnapshot(row.item_snapshot),
  };
}

export function recordFeedEngagementSession(input: FeedEngagementInput): FeedEngagementSession {
  const db = getDb();
  const sessionId = normalizeSessionId(input.sessionId);
  const feedItemId = normalizeFeedItemId(input.feedItemId);
  const activeDwellMs = clampInteger(input.activeDwellMs, 0, MAX_ACTIVE_DWELL_MS);
  const scrollDepthPercent = clampInteger(input.scrollDepthPercent, 0, 100);
  const userScrolled = input.userScrolled === true;
  const surface = normalizeSurface(input.surface);
  const snapshot = normalizeSnapshot(input.itemSnapshot);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT *
      FROM feed_engagement_sessions
      WHERE session_id = ?
    `).get(sessionId) as FeedEngagementDbRow | undefined;

    if (existing && existing.feed_item_id !== feedItemId) {
      throw new Error('Engagement session id is already bound to another feed item');
    }

    if (!existing) {
      const priorVisit = db.prepare(`
        SELECT 1 AS present
        FROM feed_engagement_sessions
        WHERE feed_item_id = ?
        LIMIT 1
      `).get(feedItemId) as { present: number } | undefined;

      db.prepare(`
        INSERT INTO feed_engagement_sessions (
          session_id,
          feed_item_id,
          opened_at,
          last_seen_at,
          closed_at,
          active_dwell_ms,
          max_scroll_depth_pct,
          user_scrolled,
          is_return,
          surface,
          item_snapshot
        ) VALUES (
          @session_id,
          @feed_item_id,
          datetime('now'),
          datetime('now'),
          CASE WHEN @is_closed = 1 THEN datetime('now') ELSE NULL END,
          @active_dwell_ms,
          @max_scroll_depth_pct,
          @user_scrolled,
          @is_return,
          @surface,
          @item_snapshot
        )
      `).run({
        session_id: sessionId,
        feed_item_id: feedItemId,
        is_closed: input.phase === 'close' ? 1 : 0,
        active_dwell_ms: activeDwellMs,
        max_scroll_depth_pct: scrollDepthPercent,
        user_scrolled: userScrolled ? 1 : 0,
        is_return: priorVisit ? 1 : 0,
        surface,
        item_snapshot: snapshot ? JSON.stringify(snapshot) : null,
      });
    } else {
      db.prepare(`
        UPDATE feed_engagement_sessions
        SET
          last_seen_at = datetime('now'),
          closed_at = CASE
            WHEN @is_closed = 1 THEN datetime('now')
            ELSE closed_at
          END,
          active_dwell_ms = MAX(active_dwell_ms, @active_dwell_ms),
          max_scroll_depth_pct = MAX(max_scroll_depth_pct, @max_scroll_depth_pct),
          user_scrolled = MAX(user_scrolled, @user_scrolled),
          surface = CASE
            WHEN surface = 'detail' AND @surface != 'detail' THEN @surface
            ELSE surface
          END,
          item_snapshot = COALESCE(item_snapshot, @item_snapshot)
        WHERE session_id = @session_id
      `).run({
        session_id: sessionId,
        is_closed: input.phase === 'close' ? 1 : 0,
        active_dwell_ms: activeDwellMs,
        max_scroll_depth_pct: scrollDepthPercent,
        user_scrolled: userScrolled ? 1 : 0,
        surface,
        item_snapshot: snapshot ? JSON.stringify(snapshot) : null,
      });
    }

    const row = db.prepare(`
      SELECT *
      FROM feed_engagement_sessions
      WHERE session_id = ?
    `).get(sessionId) as FeedEngagementDbRow;

    return toSession(row);
  })();
}

export function getRecentFeedEngagementSessions(
  limit = 50,
  options: { agentEvidence?: boolean } = {},
): FeedEngagementSession[] {
  const safeLimit = clampInteger(limit, 1, 200);
  const rows = getDb().prepare(`
    SELECT sessions.*
    FROM feed_engagement_sessions AS sessions
    LEFT JOIN feed ON feed.id = sessions.feed_item_id
    WHERE (
      ? = 0
      OR NOT (
        COALESCE(
          feed.type,
          json_extract(
            CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
            '$.type'
          ),
          ''
        ) = 'notification'
        AND COALESCE(
          feed.source,
          json_extract(
            CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
            '$.source'
          ),
          ''
        ) = 'phone-notification'
      )
    )
    ORDER BY datetime(sessions.opened_at) DESC, sessions.rowid DESC
    LIMIT ?
  `).all(options.agentEvidence ? 1 : 0, safeLimit) as FeedEngagementDbRow[];

  return rows.map(toSession);
}
