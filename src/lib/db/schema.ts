import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { generateSessionTitle } from '@/lib/chat-session-title';
import { scrubChatAuditMessages } from '@/lib/chat-output';
import { getDataPath } from '@/lib/data-dir';
import { POST_CONTEXT_SEPARATOR } from '@/lib/page-constants';
import { pickNextThreadColor, sanitizeThreadColor } from '@/lib/thread-colors';
import { readBrainConfig } from '../../../lib/brain-config.js';
import { scrubLegacyPhoneNotificationRuntimeArtifacts } from '../../../lib/phone-notification-chat-artifact-cleanup.js';
import { ensureConfigApplyTasksTable } from '../config-apply-tasks.js';
import { compactFeedArrangementRuns } from './feed-arrangement-retention';

const BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export const PREFERENCE_SIGNAL_TYPES = ['liked', 'disliked', 'hidden', 'explicit'] as const;
export const PREFERENCE_SOURCES = [
  'app_thumbsup',
  'app_thumbsdown',
  'app_thread_feedback_probe',
  'twitter_archive_like',
  'twitter_archive_tweet',
  'twitter_archive_interest',
  'twitter_archive_following',
  'twitter_archive_bookmark',
  'twitter_archive_block',
  'twitter_archive_mute',
  'twitter_like',
  'twitter_bookmark',
] as const;

function epochMillisecondsSql(valueSql: string): string {
  return `CAST(ROUND((julianday(${valueSql}) - 2440587.5) * 86400000) AS INTEGER)`;
}

export const createFeedTableSql = `
CREATE TABLE IF NOT EXISTS feed (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT,
  source_id TEXT,
  origin_session_id TEXT,
  parent_id TEXT REFERENCES feed(id),
  relationship TEXT,
  title TEXT,
  text TEXT NOT NULL,
  url TEXT,
  excerpt TEXT,
  author_username TEXT,
  author_display_name TEXT,
  reason TEXT,
  tags TEXT,
  media_urls TEXT,
  display_order INTEGER,
  thread_id TEXT,
  display_subtitle TEXT,
  published_at TEXT NOT NULL,
  published_at_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  created_at_ms INTEGER DEFAULT (${epochMillisecondsSql(`'now'`)})
);
`;

const createIndexesSql = [
  `CREATE INDEX IF NOT EXISTS feed_published_at_idx ON feed (published_at DESC);`,
  `CREATE INDEX IF NOT EXISTS feed_published_at_ms_idx ON feed (published_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS feed_created_at_ms_idx ON feed (created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS feed_type_idx ON feed (type);`,
  `CREATE INDEX IF NOT EXISTS feed_source_idx ON feed (source);`,
  `CREATE INDEX IF NOT EXISTS feed_origin_session_id_idx ON feed (origin_session_id, created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS feed_parent_id_idx ON feed (parent_id);`,
  `CREATE INDEX IF NOT EXISTS feed_relationship_idx ON feed (relationship);`,
  `CREATE INDEX IF NOT EXISTS feed_display_order_idx ON feed (display_order ASC, created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS feed_thread_id_idx ON feed (thread_id);`,
];

const createFeedSourceIdUniqueIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS feed_source_id_unique_idx
ON feed (source_id)
WHERE source_id IS NOT NULL;
`;

const alterFeedTimestampColumnsSql = [
  `ALTER TABLE feed ADD COLUMN published_at_ms INTEGER;`,
  `ALTER TABLE feed ADD COLUMN created_at_ms INTEGER;`,
];

const alterFeedTableSql = [
  `ALTER TABLE feed ADD COLUMN origin_session_id TEXT;`,
  `ALTER TABLE feed ADD COLUMN parent_id TEXT REFERENCES feed(id);`,
  `ALTER TABLE feed ADD COLUMN relationship TEXT;`,
  `ALTER TABLE feed ADD COLUMN metrics_likes INTEGER DEFAULT 0;`,
  `ALTER TABLE feed ADD COLUMN metrics_reposts INTEGER DEFAULT 0;`,
  `ALTER TABLE feed ADD COLUMN metrics_replies INTEGER DEFAULT 0;`,
  `ALTER TABLE feed ADD COLUMN metrics_views INTEGER;`,
  `ALTER TABLE feed ADD COLUMN author_avatar_url TEXT;`,
  `ALTER TABLE feed ADD COLUMN metadata TEXT;`,
  `ALTER TABLE feed ADD COLUMN display_order INTEGER;`,
  `ALTER TABLE feed ADD COLUMN thread_id TEXT;`,
  `ALTER TABLE feed ADD COLUMN display_subtitle TEXT;`,
];

const createFeedThreadsTableSql = `
CREATE TABLE IF NOT EXISTS feed_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
`;

const createFeedThreadIndexesSql = [
  `CREATE INDEX IF NOT EXISTS feed_threads_active_updated_idx ON feed_threads (active, updated_at_ms DESC);`,
];

const createFeedArrangementRunsTableSql = `
CREATE TABLE IF NOT EXISTS feed_arrangement_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'curator',
  created_at TEXT DEFAULT (datetime('now')),
  created_at_ms INTEGER DEFAULT (${epochMillisecondsSql(`'now'`)}),
  ordering_count INTEGER NOT NULL DEFAULT 0,
  thread_count INTEGER NOT NULL DEFAULT 0,
  updated_item_count INTEGER NOT NULL DEFAULT 0,
  carry_forward_audit TEXT,
  curator_carry_forward_audit TEXT,
  ordering_snapshot TEXT,
  thread_snapshot TEXT
);
`;

const createFeedArrangementRunIndexesSql = [
  `CREATE INDEX IF NOT EXISTS feed_arrangement_runs_created_idx ON feed_arrangement_runs (created_at_ms DESC);`,
];

const createInteractionsTableSql = `
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_item_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (feed_item_id) REFERENCES feed(id)
);
`;

const createInteractionIndexesSql = [
  `CREATE INDEX IF NOT EXISTS idx_interactions_feed ON interactions(feed_item_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_feed_action ON interactions(feed_item_id, action);`,
];

// One row per human detail-view session. Unlike `interactions`, which intentionally stores
// idempotent yes/no facts such as "this item was expanded", this ledger preserves repeated
// visits and their measured attention. The item snapshot keeps the private evidence useful after
// ordinary feed retention removes the source row.
const createFeedEngagementSessionsTableSql = `
CREATE TABLE IF NOT EXISTS feed_engagement_sessions (
  session_id TEXT PRIMARY KEY,
  feed_item_id TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  active_dwell_ms INTEGER NOT NULL DEFAULT 0,
  max_scroll_depth_pct INTEGER NOT NULL DEFAULT 0,
  user_scrolled INTEGER NOT NULL DEFAULT 0,
  is_return INTEGER NOT NULL DEFAULT 0,
  surface TEXT NOT NULL DEFAULT 'detail',
  item_snapshot TEXT
);
`;

const alterFeedEngagementSessionsTableSql = [
  `ALTER TABLE feed_engagement_sessions ADD COLUMN user_scrolled INTEGER NOT NULL DEFAULT 0;`,
];

const createFeedEngagementSessionIndexesSql = [
  `CREATE INDEX IF NOT EXISTS feed_engagement_sessions_item_opened_idx
    ON feed_engagement_sessions(feed_item_id, opened_at DESC);`,
  `CREATE INDEX IF NOT EXISTS feed_engagement_sessions_opened_idx
    ON feed_engagement_sessions(opened_at DESC);`,
];

const createChatMessagesTableSql = `
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'chat',
  role TEXT NOT NULL,
  in_reply_to TEXT,
  task_id TEXT,
  session_id TEXT NOT NULL DEFAULT 'legacy-session',
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  context TEXT,
  suggestions TEXT,
  status TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

const createChatSessionsTableSql = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'claude',
  provider_session_id TEXT NOT NULL,
  claude_session_id TEXT NOT NULL DEFAULT '',
  title TEXT,
  color TEXT,
  session_type TEXT,
  working_directory TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

const createChatSessionBrainSettingsTableSql = `
CREATE TABLE IF NOT EXISTS chat_session_brain_settings (
  session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  claude_reasoning_effort TEXT NOT NULL DEFAULT 'high',
  codex_reasoning_effort TEXT NOT NULL DEFAULT 'high',
  codex_fast_mode INTEGER DEFAULT 0,
  latest_context_tokens INTEGER,
  latest_context_window INTEGER,
  latest_context_model TEXT,
  latest_context_updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

const createClaudeTaskUsageTableSql = `
CREATE TABLE IF NOT EXISTS claude_task_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  priority TEXT NOT NULL,
  source_label TEXT,
  model TEXT,
  effort TEXT,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0
);
`;

const createClaudeTaskUsageIndexesSql = [
  `CREATE INDEX IF NOT EXISTS claude_task_usage_priority_started_idx ON claude_task_usage (priority, started_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS claude_task_usage_task_id_idx ON claude_task_usage (task_id);`,
];

const alterChatSessionBrainSettingsTableSql = [
  `ALTER TABLE chat_session_brain_settings ADD COLUMN claude_reasoning_effort TEXT NOT NULL DEFAULT 'high';`,
  `ALTER TABLE chat_session_brain_settings ADD COLUMN codex_fast_mode INTEGER DEFAULT 0;`,
  `ALTER TABLE chat_session_brain_settings ADD COLUMN latest_context_tokens INTEGER;`,
  `ALTER TABLE chat_session_brain_settings ADD COLUMN latest_context_window INTEGER;`,
  `ALTER TABLE chat_session_brain_settings ADD COLUMN latest_context_model TEXT;`,
  `ALTER TABLE chat_session_brain_settings ADD COLUMN latest_context_updated_at TEXT;`,
];

const createChatIndexesSql = [
  `CREATE INDEX IF NOT EXISTS chat_messages_timestamp_idx ON chat_messages (timestamp DESC);`,
  `CREATE INDEX IF NOT EXISTS chat_messages_in_reply_to_idx ON chat_messages (in_reply_to);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_agent_task_reply_unique_idx ON chat_messages (task_id, in_reply_to) WHERE role = 'agent' AND type = 'chat' AND task_id IS NOT NULL AND in_reply_to IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages (session_id, timestamp DESC);`,
];

const createChatSessionIndexesSql = [
  `CREATE INDEX IF NOT EXISTS chat_sessions_updated_at_idx ON chat_sessions (updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS chat_sessions_created_at_idx ON chat_sessions (created_at ASC);`,
];

const alterChatMessagesTableSql = [
  `ALTER TABLE chat_messages ADD COLUMN task_id TEXT;`,
  `ALTER TABLE chat_messages ADD COLUMN session_id TEXT;`,
];

const alterChatSessionsTableSql = [
  `ALTER TABLE chat_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';`,
  `ALTER TABLE chat_sessions ADD COLUMN provider_session_id TEXT;`,
  `ALTER TABLE chat_sessions ADD COLUMN title TEXT;`,
  `ALTER TABLE chat_sessions ADD COLUMN color TEXT;`,
  `ALTER TABLE chat_sessions ADD COLUMN session_type TEXT;`,
  `ALTER TABLE chat_sessions ADD COLUMN working_directory TEXT;`,
];

const backfillChatSessionsSql = `
INSERT OR IGNORE INTO chat_sessions (id, provider, provider_session_id, claude_session_id, created_at, updated_at)
SELECT
  session_id,
  'claude',
  session_id,
  session_id,
  MIN(COALESCE(created_at, timestamp, datetime('now'))),
  MAX(COALESCE(timestamp, created_at, datetime('now')))
FROM chat_messages
WHERE COALESCE(TRIM(session_id), '') != ''
  AND EXISTS (
    SELECT 1
    FROM chat_messages AS user_messages
    WHERE user_messages.session_id = chat_messages.session_id
      AND user_messages.role = 'user'
      AND user_messages.type = 'chat'
  )
GROUP BY session_id;
`;

const cleanupOrphanedReplayOnlyChatRowsSql = `
CREATE TEMP TABLE IF NOT EXISTS orphaned_replay_only_chat_sessions (
  id TEXT PRIMARY KEY
);

DELETE FROM orphaned_replay_only_chat_sessions;

INSERT OR IGNORE INTO orphaned_replay_only_chat_sessions (id)
SELECT s.id
FROM chat_sessions AS s
WHERE EXISTS (
    SELECT 1
    FROM chat_messages AS replay_messages
    WHERE replay_messages.session_id = s.id
      AND replay_messages.role = 'agent'
      AND replay_messages.type = 'chat'
      AND json_valid(COALESCE(replay_messages.metadata, '{}'))
      AND json_extract(COALESCE(replay_messages.metadata, '{}'), '$.source') = 'chat-output.jsonl'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM chat_messages AS user_messages
    WHERE user_messages.session_id = s.id
      AND user_messages.role = 'user'
      AND user_messages.type = 'chat'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM feed AS session_feed
    WHERE session_feed.origin_session_id = s.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM chat_messages AS non_replay_messages
    WHERE non_replay_messages.session_id = s.id
      AND NOT (
        non_replay_messages.role = 'agent'
        AND non_replay_messages.type = 'chat'
        AND json_valid(COALESCE(non_replay_messages.metadata, '{}'))
        AND json_extract(COALESCE(non_replay_messages.metadata, '{}'), '$.source') = 'chat-output.jsonl'
      )
  );

DELETE FROM chat_messages
WHERE session_id IN (
  SELECT id FROM orphaned_replay_only_chat_sessions
);

DELETE FROM chat_session_brain_settings
WHERE session_id IN (
  SELECT id FROM orphaned_replay_only_chat_sessions
);

DELETE FROM chat_sessions
WHERE id IN (
  SELECT id FROM orphaned_replay_only_chat_sessions
);

DROP TABLE IF EXISTS orphaned_replay_only_chat_sessions;
`;

const backfillChatSessionProviderSql = `
UPDATE chat_sessions
SET provider = 'claude'
WHERE COALESCE(NULLIF(TRIM(provider), ''), '') = '';

-- Only CLAUDE sessions get a client-chosen provider_session_id backfilled: claude accepts
-- a chosen --session-id. Codex thread ids are SERVER-assigned rollout ids, so a codex
-- session must keep an EMPTY id until its first turn opens a real rollout (thread.started);
-- fabricating one here made every boot re-poison a cleared codex session ("no rollout found").
UPDATE chat_sessions
SET provider_session_id = CASE
  WHEN COALESCE(NULLIF(TRIM(claude_session_id), ''), '') != '' THEN TRIM(claude_session_id)
  ELSE id
END
WHERE COALESCE(NULLIF(TRIM(provider_session_id), ''), '') = ''
  AND COALESCE(NULLIF(TRIM(provider), ''), 'claude') = 'claude';

UPDATE chat_sessions
SET claude_session_id = CASE
  WHEN COALESCE(NULLIF(TRIM(provider), ''), 'claude') = 'claude'
    THEN COALESCE(NULLIF(TRIM(claude_session_id), ''), NULLIF(TRIM(provider_session_id), ''), id)
  ELSE COALESCE(NULLIF(TRIM(claude_session_id), ''), '')
END;
`;

function backfillChatSessionTitles(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, title
    FROM chat_sessions
    ORDER BY datetime(created_at) ASC, id ASC
  `).all() as Array<{ id: string; title: string | null }>;

  const updateTitle = db.prepare(`
    UPDATE chat_sessions
    SET title = ?
    WHERE id = ?
  `);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (typeof row.title === 'string' && row.title.trim()) {
      continue;
    }
    updateTitle.run(generateSessionTitle(index), row.id);
  }
}

function readThreadColorCounts(db: Database.Database): Record<string, number> {
  const rows = db.prepare(`
    SELECT color, COUNT(*) AS count
    FROM threads
    GROUP BY color
  `).all() as Array<{ color: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const color = sanitizeThreadColor(row.color);
    if (!color) {
      continue;
    }
    counts[color] = (counts[color] ?? 0) + row.count;
  }
  return counts;
}

function readThreadIdFromMetadata(metadata: Record<string, unknown>): string | null {
  const thread = metadata.thread;
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) {
    return null;
  }

  const threadId = (thread as Record<string, unknown>).threadId;
  return typeof threadId === 'string' && threadId.trim() ? threadId.trim() : null;
}

function backfillThreadColors(db: Database.Database): void {
  const missingThreads = db.prepare(`
    SELECT
      TRIM(json_extract(metadata, '$.thread.threadId')) AS metadata_thread_id,
      MIN(COALESCE(created_at_ms, published_at_ms)) AS first_seen_ms
    FROM feed
    WHERE metadata IS NOT NULL
      AND json_valid(metadata)
      AND COALESCE(NULLIF(TRIM(json_extract(metadata, '$.thread.threadId')), ''), '') != ''
      AND NOT EXISTS (
        SELECT 1
        FROM threads
        WHERE threads.thread_id = TRIM(json_extract(feed.metadata, '$.thread.threadId'))
      )
    GROUP BY metadata_thread_id
    ORDER BY first_seen_ms ASC, metadata_thread_id ASC
  `).all() as Array<{ metadata_thread_id: string; first_seen_ms: number | null }>;

  const colorCounts = readThreadColorCounts(db);
  const insertThread = db.prepare(`
    INSERT OR IGNORE INTO threads (thread_id, color, created_at_ms)
    VALUES (?, ?, ?)
  `);
  const now = Date.now();

  for (const row of missingThreads) {
    const threadId = row.metadata_thread_id.trim();
    if (!threadId) {
      continue;
    }

    const color = pickNextThreadColor(colorCounts);
    const firstSeenMs = typeof row.first_seen_ms === 'number' && Number.isFinite(row.first_seen_ms)
      ? row.first_seen_ms
      : now;
    insertThread.run(threadId, color, firstSeenMs);
    colorCounts[color] = (colorCounts[color] ?? 0) + 1;
  }

  const threadRows = db.prepare(`
    SELECT thread_id, color
    FROM threads
  `).all() as Array<{ thread_id: string; color: string }>;
  const colorByThreadId = new Map<string, string>();
  for (const row of threadRows) {
    const color = sanitizeThreadColor(row.color);
    if (row.thread_id.trim() && color) {
      colorByThreadId.set(row.thread_id.trim(), color);
    }
  }

  const feedRows = db.prepare(`
    SELECT id, metadata
    FROM feed
    WHERE metadata IS NOT NULL
      AND json_valid(metadata)
      AND COALESCE(NULLIF(TRIM(json_extract(metadata, '$.thread.threadId')), ''), '') != ''
  `).all() as Array<{ id: string; metadata: string }>;
  const updateMetadata = db.prepare(`
    UPDATE feed
    SET metadata = ?
    WHERE id = ?
  `);

  for (const row of feedRows) {
    let metadata: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      metadata = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const threadId = readThreadIdFromMetadata(metadata);
    if (!threadId) {
      continue;
    }

    const color = colorByThreadId.get(threadId);
    const thread = metadata.thread;
    if (!color || !thread || typeof thread !== 'object' || Array.isArray(thread)) {
      continue;
    }

    const threadMetadata = thread as Record<string, unknown>;
    if (threadMetadata.color === color) {
      continue;
    }

    threadMetadata.color = color;
    updateMetadata.run(JSON.stringify(metadata), row.id);
  }
}

function backfillChatSessionBrainSettings(db: Database.Database): void {
  const brainConfig = readBrainConfig(getDataPath('config.md'));
  db.prepare(`
    INSERT OR IGNORE INTO chat_session_brain_settings (session_id, claude_reasoning_effort, codex_reasoning_effort)
    SELECT id, ?, ? FROM chat_sessions
  `).run(brainConfig.claudeReasoningEffort, brainConfig.codexReasoningEffort);
}

function runOptionalSchemaStep(stepName: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[db] ensureFeedSchema skipped optional step ${stepName}: ${message}`);
  }
}

function removeOrphanChatSessionBrainSettings(db: Database.Database): number {
  const result = db.prepare(`
    DELETE FROM chat_session_brain_settings
    WHERE NOT EXISTS (
      SELECT 1
      FROM chat_sessions
      WHERE chat_sessions.id = chat_session_brain_settings.session_id
    )
  `).run();
  return result.changes;
}

function chatSessionBrainSettingsUsesCascade(db: Database.Database): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(chat_session_brain_settings)`).all() as Array<{
    table?: string;
    from?: string;
    on_delete?: string;
  }>;
  return rows.some((row) => row.table === 'chat_sessions'
    && row.from === 'session_id'
    && row.on_delete?.toUpperCase() === 'CASCADE');
}

function ensureChatSessionBrainSettingsConstraint(db: Database.Database): void {
  const removedOrphans = removeOrphanChatSessionBrainSettings(db);
  if (removedOrphans > 0) {
    console.warn(`[db] removed ${removedOrphans} orphan chat_session_brain_settings rows`);
  }

  if (chatSessionBrainSettingsUsesCascade(db)) {
    return;
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE chat_session_brain_settings_next (
        session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
        claude_reasoning_effort TEXT NOT NULL DEFAULT 'high',
        codex_reasoning_effort TEXT NOT NULL DEFAULT 'high',
        codex_fast_mode INTEGER DEFAULT 0,
        latest_context_tokens INTEGER,
        latest_context_window INTEGER,
        latest_context_model TEXT,
        latest_context_updated_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      INSERT INTO chat_session_brain_settings_next (
        session_id,
        claude_reasoning_effort,
        codex_reasoning_effort,
        codex_fast_mode,
        latest_context_tokens,
        latest_context_window,
        latest_context_model,
        latest_context_updated_at,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        COALESCE(claude_reasoning_effort, 'high'),
        COALESCE(codex_reasoning_effort, 'high'),
        COALESCE(codex_fast_mode, 0),
        latest_context_tokens,
        latest_context_window,
        latest_context_model,
        latest_context_updated_at,
        created_at,
        updated_at
      FROM chat_session_brain_settings
      WHERE EXISTS (
        SELECT 1
        FROM chat_sessions
        WHERE chat_sessions.id = chat_session_brain_settings.session_id
      );

      DROP TABLE chat_session_brain_settings;
      ALTER TABLE chat_session_brain_settings_next RENAME TO chat_session_brain_settings;
    `);
  })();
}

function clearInvalidCodexContextMetrics(db: Database.Database): void {
  db.prepare(`
    UPDATE chat_session_brain_settings
    SET
      latest_context_tokens = NULL,
      latest_context_window = NULL,
      latest_context_updated_at = datetime('now'),
      updated_at = datetime('now')
    WHERE session_id IN (
      SELECT bs.session_id
      FROM chat_session_brain_settings AS bs
      INNER JOIN chat_sessions AS s
        ON s.id = bs.session_id
      WHERE LOWER(COALESCE(s.provider, '')) = 'codex'
        AND bs.latest_context_tokens IS NOT NULL
        AND (
          bs.latest_context_window IS NULL
          OR bs.latest_context_window >= 900000
          OR (
            bs.latest_context_window > 0
            AND bs.latest_context_tokens > bs.latest_context_window * 2
          )
        )
    )
  `).run();
}

const syncAgentPublishedAtSql = `
UPDATE feed
SET published_at = created_at
WHERE LOWER(COALESCE(source, '')) IN ('claude', 'evogent', 'media' || '-' || 'agent', 'media' || 'agent', 'media' || '_' || 'agent')
  AND published_at != created_at;
`;

const backfillFeedTimestampMsSql = `
UPDATE feed
SET
  published_at_ms = CASE
    WHEN julianday(published_at) IS NOT NULL THEN ${epochMillisecondsSql('published_at')}
    ELSE published_at_ms
  END,
  created_at_ms = CASE
    WHEN julianday(COALESCE(created_at, published_at)) IS NOT NULL
      THEN ${epochMillisecondsSql('COALESCE(created_at, published_at)')}
    ELSE created_at_ms
  END
WHERE published_at IS NOT NULL;
`;

const repairArticlePublishedTimesFromMetadataSql = `
UPDATE feed
SET
  published_at = strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(metadata, '$.article.datePublished')),
  published_at_ms = ${epochMillisecondsSql("json_extract(metadata, '$.article.datePublished')")},
  metadata = json_set(
    metadata,
    '$.publishEvidence',
    json_object(
      'status', 'verified',
      'source', 'metadata.article.datePublished',
      'publishedAt', strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(metadata, '$.article.datePublished')),
      'repairedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      'repairReason', 'restore source-owned publish time from article metadata'
    )
  )
WHERE type = 'article'
  AND json_valid(metadata)
  AND julianday(json_extract(metadata, '$.article.datePublished')) IS NOT NULL
  AND (
    published_at != strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(metadata, '$.article.datePublished'))
    OR published_at_ms IS NULL
    OR published_at_ms != ${epochMillisecondsSql("json_extract(metadata, '$.article.datePublished')")}
  );
`;

const createFeedTimestampInsertTriggerSql = `
CREATE TRIGGER IF NOT EXISTS feed_set_timestamp_ms_after_insert
AFTER INSERT ON feed
BEGIN
  UPDATE feed
  SET
    published_at_ms = CASE
      WHEN julianday(NEW.published_at) IS NOT NULL THEN ${epochMillisecondsSql('NEW.published_at')}
      ELSE published_at_ms
    END,
    created_at_ms = CASE
      WHEN julianday(COALESCE(NEW.created_at, NEW.published_at)) IS NOT NULL
        THEN ${epochMillisecondsSql('COALESCE(NEW.created_at, NEW.published_at)')}
      ELSE created_at_ms
    END
  WHERE id = NEW.id;
END;
`;

const createFeedTimestampUpdateTriggerSql = `
CREATE TRIGGER IF NOT EXISTS feed_set_timestamp_ms_after_update
AFTER UPDATE OF published_at, created_at ON feed
BEGIN
  UPDATE feed
  SET
    published_at_ms = CASE
      WHEN julianday(NEW.published_at) IS NOT NULL THEN ${epochMillisecondsSql('NEW.published_at')}
      ELSE published_at_ms
    END,
    created_at_ms = CASE
      WHEN julianday(COALESCE(NEW.created_at, NEW.published_at)) IS NOT NULL
        THEN ${epochMillisecondsSql('COALESCE(NEW.created_at, NEW.published_at)')}
      ELSE created_at_ms
    END
  WHERE id = NEW.id;
END;
`;

const dropFeedTimestampTriggersSql = [
  `DROP TRIGGER IF EXISTS feed_set_timestamp_ms_after_insert;`,
  `DROP TRIGGER IF EXISTS feed_set_timestamp_ms_after_update;`,
];

const backfillTweetMetricsFromMetadataSql = `
UPDATE feed
SET
  metrics_likes = CAST(json_extract(metadata, '$.likeCount') AS INTEGER),
  metrics_reposts = CAST(json_extract(metadata, '$.repostCount') AS INTEGER),
  metrics_replies = CAST(json_extract(metadata, '$.replyCount') AS INTEGER)
WHERE type = 'tweet'
  AND metrics_likes = 0
  AND metadata IS NOT NULL
  AND json_extract(metadata, '$.likeCount') IS NOT NULL;
`;

const backfillOpenClawChatCuratorSourceSql = `
UPDATE feed
SET source = 'openclaw'
WHERE LOWER(TRIM(COALESCE(source, ''))) = 'curation'
  OR (
    source IS NULL
    AND metadata IS NOT NULL
    AND json_valid(metadata)
    AND json_extract(metadata, '$.source') = 'chat-curator'
  );
`;

const clampFutureChatTimestampsSql = `
UPDATE chat_messages
SET timestamp = datetime('now')
WHERE datetime(timestamp) > datetime('now');
`;

const fixOutOfOrderAgentRepliesSql = `
UPDATE chat_messages
SET timestamp = datetime(
  (SELECT timestamp FROM chat_messages AS u WHERE u.id = chat_messages.in_reply_to),
  '+1 second'
)
WHERE role = 'agent'
AND in_reply_to IS NOT NULL
AND timestamp < (SELECT timestamp FROM chat_messages AS u WHERE u.id = chat_messages.in_reply_to);
`;

const createUserActivityTableSql = `
CREATE TABLE IF NOT EXISTS user_activity (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT
);
`;

const createUserActivityIndexesSql = [
  `CREATE INDEX IF NOT EXISTS idx_user_activity_timestamp ON user_activity(timestamp DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_user_activity_event_timestamp ON user_activity(event, timestamp DESC);`,
];

const purgeLegacyForegroundHeartbeatActivitySql = `
DELETE FROM user_activity
WHERE event = 'foreground'
  AND metadata IS NOT NULL
  AND json_valid(metadata)
  AND json_extract(metadata, '$.heartbeat') = 1;
`;

const createAppPresenceTableSql = `
CREATE TABLE IF NOT EXISTS app_presence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('foreground', 'background')),
  client_id TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  server_epoch TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_sequence INTEGER NOT NULL CHECK (generation_sequence > 0),
  generation_order INTEGER NOT NULL
);
`;

const alterAppPresenceTableSql = [
  `ALTER TABLE app_presence ADD COLUMN server_epoch TEXT;`,
  `ALTER TABLE app_presence ADD COLUMN generation_id TEXT;`,
  `ALTER TABLE app_presence ADD COLUMN generation_sequence INTEGER;`,
  `ALTER TABLE app_presence ADD COLUMN generation_order INTEGER;`,
];

const createAppPresenceGenerationsTableSql = `
CREATE TABLE IF NOT EXISTS app_presence_generations (
  generation_order INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id TEXT NOT NULL UNIQUE
);
`;

const createCurationLogTableSql = `
CREATE TABLE IF NOT EXISTS curation_log (
  id INTEGER PRIMARY KEY,
  request_id TEXT UNIQUE,
  triggered_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  items_added INTEGER,
  feed_count_before INTEGER,
  completion_status TEXT,
  completion_reason TEXT
);
`;

const alterCurationLogTableSql = [
  `ALTER TABLE curation_log ADD COLUMN completion_status TEXT;`,
  `ALTER TABLE curation_log ADD COLUMN completion_reason TEXT;`,
];

const createCurationLogIndexesSql = [
  `CREATE INDEX IF NOT EXISTS idx_curation_log_started_at ON curation_log(started_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_curation_log_completed_at ON curation_log(completed_at DESC);`,
];

const createPreferencesTableSql = `
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY,
  feed_item_id TEXT,
  signal_type TEXT NOT NULL,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT,
  author_username TEXT,
  weight REAL DEFAULT 1.0,
  source_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, signal_type)
);
`;

const createPreferenceIndexesSql = [
  `CREATE INDEX IF NOT EXISTS preferences_signal_type_idx ON preferences (signal_type);`,
  `CREATE INDEX IF NOT EXISTS preferences_source_idx ON preferences (source);`,
  `CREATE INDEX IF NOT EXISTS preferences_created_at_idx ON preferences (created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS preferences_feed_item_id_idx ON preferences (feed_item_id);`,
];

const createPreferenceVectorsTableSql = `
CREATE TABLE IF NOT EXISTS preference_vectors (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  source TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  author_username TEXT
);
`;

const createPreferenceVectorIndexesSql = [
  `CREATE INDEX IF NOT EXISTS preference_vectors_signal_type_idx ON preference_vectors (signal_type);`,
  `CREATE INDEX IF NOT EXISTS preference_vectors_source_idx ON preference_vectors (source);`,
];

const createThreadFeedbackTableSql = `
CREATE TABLE IF NOT EXISTS thread_feedback (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  cycle_id TEXT,
  feed_item_id TEXT,
  vote TEXT NOT NULL CHECK (vote IN ('more', 'less')),
  thread_title TEXT,
  reason TEXT,
  category TEXT,
  probe_reason TEXT,
  probe_uncertainty TEXT,
  source_item_ids TEXT,
  origin_session_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (feed_item_id) REFERENCES feed(id)
);
`;

const createThreadFeedbackIndexesSql = [
  `CREATE INDEX IF NOT EXISTS thread_feedback_thread_id_idx ON thread_feedback (thread_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS thread_feedback_created_at_idx ON thread_feedback (created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS thread_feedback_origin_session_id_idx ON thread_feedback (origin_session_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS thread_feedback_feed_item_id_idx ON thread_feedback (feed_item_id);`,
];

const createThreadsTableSql = `
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  color TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
`;

const createThreadIndexesSql = [
  `CREATE INDEX IF NOT EXISTS idx_threads_color ON threads(color);`,
];

const createCodeFixTasksTableSql = `
CREATE TABLE IF NOT EXISTS code_fix_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'dispatched',
  phase TEXT,
  phase_detail TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT,
  UNIQUE(suggestion_id, task_id)
);
`;

const createCodeFixTasksIndexesSql = [
  `CREATE INDEX IF NOT EXISTS code_fix_tasks_suggestion_id_idx ON code_fix_tasks (suggestion_id);`,
  `CREATE INDEX IF NOT EXISTS code_fix_tasks_task_id_idx ON code_fix_tasks (task_id);`,
  `CREATE INDEX IF NOT EXISTS code_fix_tasks_status_idx ON code_fix_tasks (status);`,
];

const createAgentsTableSql = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  pid INTEGER,
  log_file TEXT,
  prompt_preview TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  timeout_ms INTEGER,
  timeout_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  error TEXT,
  progress_count INTEGER DEFAULT 0,
  last_event_at TEXT
);
`;

const createAgentIndexesSql = [
  `CREATE INDEX IF NOT EXISTS agents_status_started_at_idx ON agents (status, started_at DESC);`,
  `CREATE INDEX IF NOT EXISTS agents_log_file_idx ON agents (log_file);`,
];

const createBrowseCacheItemsTableSql = `
CREATE TABLE IF NOT EXISTS browse_cache_items (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  author_username TEXT,
  author_display_name TEXT,
  published_at_ms INTEGER,
  payload_json TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  seen_by_curation_at_ms INTEGER,
  PRIMARY KEY (source, source_id)
);
`;

const createBrowseCacheItemIndexesSql = [
  `CREATE INDEX IF NOT EXISTS browse_cache_items_source_expires_idx ON browse_cache_items (source, expires_at_ms ASC);`,
  `CREATE INDEX IF NOT EXISTS browse_cache_items_source_published_idx ON browse_cache_items (source, published_at_ms DESC, fetched_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS browse_cache_items_source_seen_idx ON browse_cache_items (source, seen_by_curation_at_ms ASC, expires_at_ms DESC);`,
];

// The curator's bench: ranked near-misses from each curation cycle — items that passed the
// quality bar but lost on slate slots. Pull-to-refresh / app-open promotes the best of them
// into the feed INSTANTLY (no brain call): the curator already made the decision at cycle
// time, shipping was just deferred. item_json holds a full curate/submit-ready item.
const createCurationBenchTableSql = `
CREATE TABLE IF NOT EXISTS curation_bench (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id TEXT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  reason TEXT,
  item_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  quarantined_at_ms INTEGER,
  last_error TEXT,
  UNIQUE (source, source_id)
);
`;

const alterCurationBenchTableSql = [
  `ALTER TABLE curation_bench ADD COLUMN quarantined_at_ms INTEGER;`,
  `ALTER TABLE curation_bench ADD COLUMN last_error TEXT;`,
];

const createCurationBenchIndexesSql = [
  `CREATE INDEX IF NOT EXISTS curation_bench_unconsumed_idx ON curation_bench (consumed_at_ms, score DESC, created_at_ms DESC);`,
];

const createBrowseCacheRefreshRunsTableSql = `
CREATE TABLE IF NOT EXISTS browse_cache_refresh_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  status TEXT NOT NULL,
  items_added INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  metadata_json TEXT
);
`;

const alterBrowseCacheRefreshRunsTableSql = [
  `ALTER TABLE browse_cache_refresh_runs ADD COLUMN metadata_json TEXT;`,
];

const createBrowseCacheRefreshRunIndexesSql = [
  `CREATE INDEX IF NOT EXISTS browse_cache_refresh_runs_source_started_idx ON browse_cache_refresh_runs (source, started_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS browse_cache_refresh_runs_source_status_idx ON browse_cache_refresh_runs (source, status, started_at_ms DESC);`,
];

// The anticipation demand ledger: one row per user "ask" for content or an action, classified
// by how well the system had anticipated it. feed_hit = it was already in the feed;
// cache_hit = not in the feed but the browse cache had it (seconds of wait, not minutes);
// miss = a live browse/search was needed. Engagement signals are NOT duplicated here — the
// score reads them from `interactions`. Misses feed the next browse cycle as prefetch hints.
const createAnticipationEventsTableSql = `
CREATE TABLE IF NOT EXISTS anticipation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  tier TEXT NOT NULL CHECK (tier IN ('feed_hit', 'cache_hit', 'miss')),
  topics TEXT NOT NULL DEFAULT '[]',
  source_hint TEXT,
  session_id TEXT,
  message_id TEXT,
  waited_ms INTEGER,
  note TEXT
);
`;

const createAnticipationEventIndexesSql = [
  `CREATE INDEX IF NOT EXISTS anticipation_events_ts_idx ON anticipation_events (ts DESC);`,
  `CREATE INDEX IF NOT EXISTS anticipation_events_tier_ts_idx ON anticipation_events (tier, ts DESC);`,
];

const createSetupReadinessStateTableSql = `
CREATE TABLE IF NOT EXISTS setup_readiness_state (
  id TEXT PRIMARY KEY,
  last_ready INTEGER NOT NULL,
  welcome_notification_handled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const repairImpossibleBrowseCacheRefreshRunTimestampsSql = `
UPDATE browse_cache_refresh_runs
SET started_at_ms = completed_at_ms
WHERE completed_at_ms IS NOT NULL
  AND completed_at_ms >= 0
  AND completed_at_ms <= (${epochMillisecondsSql(`'now'`)} + ${BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS})
  AND (
    started_at_ms < 0
    OR started_at_ms > (${epochMillisecondsSql(`'now'`)} + ${BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS})
    OR completed_at_ms + ${BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS} < started_at_ms
  );
`;

// Builds before the content-free source watermark stored notification title/body
// inside model-facing browse-cache rows. Purge that bounded legacy shape at
// startup so deploying the privacy fix does not leave old content available
// until its normal cache expiry.
const purgeLegacyNotificationBrowseSignalsSql = `
DELETE FROM browse_cache_items
WHERE source_id LIKE 'notif-%'
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.type') = 'notification-signal'
  AND json_extract(payload_json, '$.captureMethod') = 'phone-notification-listener';

DELETE FROM browse_cache_refresh_runs
WHERE triggered_by = 'phone-notification-listener';
`;

const PHONE_NOTIFICATION_WITHHELD_CONTEXT =
  'The selected phone notification is a local, model-free card. Its title and body are intentionally unavailable to runtime agents.';
const PHONE_NOTIFICATION_DERIVED_REPLY_WITHHELD_TEXT =
  'This earlier reply was withheld because it may have been derived from local phone-notification content.';
const PHONE_NOTIFICATION_DERIVED_REPLY_WITHHELD_CONTEXT =
  'Local phone-notification context and any reply derived from it are unavailable to runtime agents.';

type LegacyPhoneNotificationChatRoot = {
  message_id: string;
  session_id: string;
  message_rowid: number;
  timestamp: string;
};

type LegacyPhoneNotificationAffectedSession = {
  id: string;
  provider: string | null;
};

const createLegacyPhoneNotificationChatRootsSql = `
CREATE TEMP TABLE IF NOT EXISTS legacy_phone_notification_chat_roots (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_rowid INTEGER NOT NULL,
  timestamp TEXT NOT NULL
);
`;

function populateLegacyPhoneNotificationChatRoots(
  db: Database.Database,
  completedMarker: 'phoneNotificationSessionEvidencePurged' | 'phoneNotificationAuditEvidencePurged',
): LegacyPhoneNotificationChatRoot[] {
  db.exec(createLegacyPhoneNotificationChatRootsSql);
  db.exec(`DELETE FROM legacy_phone_notification_chat_roots;`);
  db.exec(`
    INSERT OR IGNORE INTO legacy_phone_notification_chat_roots (
      message_id,
      session_id,
      message_rowid,
      timestamp
    )
    SELECT
      chat_messages.id,
      chat_messages.session_id,
      chat_messages.rowid,
      chat_messages.timestamp
    FROM chat_messages
    WHERE json_valid(chat_messages.metadata)
      AND json_extract(chat_messages.metadata, '$.contextKind') = 'post'
      AND COALESCE(
        json_extract(chat_messages.metadata, '$.${completedMarker}'),
        0
      ) != 1
      AND EXISTS (
        SELECT 1
        FROM feed
        WHERE feed.id = json_extract(chat_messages.metadata, '$.contextRefId')
          AND feed.type = 'notification'
          AND feed.source = 'phone-notification'
      );
  `);

  return db.prepare(`
    SELECT message_id, session_id, message_rowid, timestamp
    FROM legacy_phone_notification_chat_roots
    ORDER BY message_rowid ASC
  `).all() as LegacyPhoneNotificationChatRoot[];
}

function legacyPhoneNotificationDerivedMessageIds(
  db: Database.Database,
): string[] {
  return (
    db.prepare(`
      SELECT DISTINCT chat_messages.id
      FROM chat_messages
      WHERE chat_messages.role = 'agent'
        AND EXISTS (
          SELECT 1
          FROM legacy_phone_notification_chat_roots AS roots
          WHERE chat_messages.in_reply_to = roots.message_id
            OR (
              COALESCE(TRIM(chat_messages.session_id), '') != ''
              AND chat_messages.session_id = roots.session_id
              AND (
                chat_messages.rowid > roots.message_rowid
                OR (
                  julianday(chat_messages.timestamp) IS NOT NULL
                  AND julianday(roots.timestamp) IS NOT NULL
                  AND julianday(chat_messages.timestamp) >= julianday(roots.timestamp)
                )
              )
            )
        )
      ORDER BY chat_messages.rowid ASC
    `).all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function scrubLegacyPhoneNotificationChatAudit(db: Database.Database): void {
  const roots = populateLegacyPhoneNotificationChatRoots(
    db,
    'phoneNotificationAuditEvidencePurged',
  );
  if (roots.length === 0) return;

  const affectedMessageIds = [
    ...roots.map((root) => root.message_id),
    ...legacyPhoneNotificationDerivedMessageIds(db),
  ];

  try {
    scrubChatAuditMessages(affectedMessageIds);
  } catch (error) {
    // The database evidence is already scrubbed. Leave the audit marker unset
    // so the next startup retries the durable audit rewrite.
    console.warn(
      '[db] failed to scrub legacy phone-notification chat audit; will retry on next startup',
      error,
    );
    return;
  }

  db.exec(`
    UPDATE chat_messages
    SET metadata = json_set(
      CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
      '$.phoneNotificationAuditEvidencePurged',
      json('true')
    )
    WHERE id IN (
      SELECT message_id
      FROM legacy_phone_notification_chat_roots
    );
  `);
}

/**
 * Remove evidence artifacts written by builds that treated phone-notification
 * cards like ordinary feed content. The feed rows themselves remain intact for
 * the deterministic user UI. A notification dismissal is also retained because
 * it contains no notification text and is the UI's local lifecycle state.
 */
function purgeLegacyPhoneNotificationAgentEvidence(db: Database.Database): void {
  scrubLegacyPhoneNotificationRuntimeArtifacts({
    db,
    dataDir: getDataPath(),
  });

  const hasPreferenceVectorTable = Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'pref_vec'
    LIMIT 1
  `).get());
  const preferencesHaveSourceId = (
    db.prepare(`PRAGMA table_info(preferences)`).all() as Array<{ name: string }>
  ).some((column) => column.name === 'source_id');
  const phonePreferencePredicate = `
    (
      feed.type = 'notification'
      AND feed.source = 'phone-notification'
    )
    ${preferencesHaveSourceId
    ? `OR COALESCE(preferences.source_id, '') LIKE 'phone-notification:%'`
    : ''}
  `;

  db.transaction(() => {
    if (hasPreferenceVectorTable) {
      db.exec(`
        DELETE FROM pref_vec
        WHERE id IN (
          SELECT preferences.id
          FROM preferences
          LEFT JOIN feed ON feed.id = preferences.feed_item_id
          WHERE ${phonePreferencePredicate}
        );
      `);
    }

    db.exec(`
      DELETE FROM preference_vectors
      WHERE id IN (
        SELECT preferences.id
        FROM preferences
        LEFT JOIN feed ON feed.id = preferences.feed_item_id
        WHERE ${phonePreferencePredicate}
      );

      DELETE FROM preferences
      WHERE id IN (
        SELECT preferences.id
        FROM preferences
        LEFT JOIN feed ON feed.id = preferences.feed_item_id
        WHERE ${phonePreferencePredicate}
      );

      DELETE FROM thread_feedback
      WHERE feed_item_id IN (
        SELECT id
        FROM feed
        WHERE type = 'notification'
          AND source = 'phone-notification'
      )
      OR (
        json_valid(source_item_ids)
        AND EXISTS (
          SELECT 1
          FROM json_each(thread_feedback.source_item_ids) AS source_item
          JOIN feed ON feed.id = source_item.value
          WHERE feed.type = 'notification'
            AND feed.source = 'phone-notification'
        )
      );

      DELETE FROM feed_engagement_sessions
      WHERE feed_item_id IN (
        SELECT id
        FROM feed
        WHERE type = 'notification'
          AND source = 'phone-notification'
      )
      OR (
        json_valid(item_snapshot)
        AND json_extract(item_snapshot, '$.type') = 'notification'
        AND json_extract(item_snapshot, '$.source') = 'phone-notification'
      );

      DELETE FROM interactions
      WHERE action != 'suggestion_dismissed'
        AND feed_item_id IN (
          SELECT id
          FROM feed
          WHERE type = 'notification'
            AND source = 'phone-notification'
        );
    `);

    const roots = populateLegacyPhoneNotificationChatRoots(
      db,
      'phoneNotificationSessionEvidencePurged',
    );
    const affectedSessions = roots.length > 0
      ? db.prepare(`
          SELECT DISTINCT chat_sessions.id, chat_sessions.provider
          FROM chat_sessions
          INNER JOIN legacy_phone_notification_chat_roots AS roots
            ON roots.session_id = chat_sessions.id
          ORDER BY chat_sessions.id ASC
        `).all() as LegacyPhoneNotificationAffectedSession[]
      : [];

    // Rotate every future resume pointer before removing local derived evidence.
    // Claude accepts a fresh client-chosen UUID; Codex rollout IDs are
    // server-assigned, so both of its stored pointers must be cleared. This
    // intentionally does not claim to delete provider-owned transcript files.
    const rotateSession = db.prepare(`
      UPDATE chat_sessions
      SET
        provider_session_id = ?,
        claude_session_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const session of affectedSessions) {
      const provider = session.provider?.trim().toLowerCase() || 'claude';
      const nextProviderSessionId = provider === 'claude' ? randomUUID() : '';
      rotateSession.run(
        nextProviderSessionId,
        provider === 'claude' ? nextProviderSessionId : '',
        session.id,
      );
    }

    if (roots.length === 0) return;

    db.prepare(`
      UPDATE chat_messages
      SET
        text = @derived_text,
        context = @derived_context,
        suggestions = NULL,
        metadata = json_object(
          'phoneNotificationDerivedContentWithheld',
          json('true')
        )
      WHERE role = 'agent'
        AND EXISTS (
          SELECT 1
          FROM legacy_phone_notification_chat_roots AS roots
          WHERE chat_messages.in_reply_to = roots.message_id
            OR (
              COALESCE(TRIM(chat_messages.session_id), '') != ''
              AND chat_messages.session_id = roots.session_id
              AND (
                chat_messages.rowid > roots.message_rowid
                OR (
                  julianday(chat_messages.timestamp) IS NOT NULL
                  AND julianday(roots.timestamp) IS NOT NULL
                  AND julianday(chat_messages.timestamp) >= julianday(roots.timestamp)
                )
              )
            )
        )
    `).run({
      derived_text: PHONE_NOTIFICATION_DERIVED_REPLY_WITHHELD_TEXT,
      derived_context: PHONE_NOTIFICATION_DERIVED_REPLY_WITHHELD_CONTEXT,
    });

    db.prepare(`
      UPDATE chat_messages
      SET
        text = CASE
          WHEN instr(text, @separator) > 0
            THEN trim(substr(text, 1, instr(text, @separator) - 1))
          ELSE text
        END,
        context = @withheld_context,
        suggestions = NULL,
        metadata = json_object(
          'contextKind',
          'post',
          'contextRefId',
          json_extract(metadata, '$.contextRefId'),
          'phoneNotificationContentWithheld',
          json('true'),
          'phoneNotificationSessionEvidencePurged',
          json('true'),
          'phoneNotificationOrchestratorEvidencePurged',
          json('true')
        )
      WHERE id IN (
        SELECT message_id
        FROM legacy_phone_notification_chat_roots
      )
    `).run({
      separator: POST_CONTEXT_SEPARATOR,
      withheld_context: PHONE_NOTIFICATION_WITHHELD_CONTEXT,
    });
  })();

  scrubLegacyPhoneNotificationChatAudit(db);
}

const repairPrefixedTwitterBrowseCacheSourceIdsSql = `
DELETE FROM browse_cache_items
WHERE LOWER(source) = 'twitter'
  AND LOWER(source_id) LIKE 'twitter:%'
  AND SUBSTR(source_id, 9) != ''
  AND SUBSTR(source_id, 9) NOT GLOB '*[^0-9]*'
  AND EXISTS (
    SELECT 1
    FROM browse_cache_items AS bare
    WHERE bare.source = browse_cache_items.source
      AND bare.source_id = SUBSTR(browse_cache_items.source_id, 9)
  );

DELETE FROM browse_cache_items
WHERE LOWER(source) = 'twitter'
  AND LOWER(source_id) LIKE 'tweet-%'
  AND SUBSTR(source_id, 7) != ''
  AND SUBSTR(source_id, 7) NOT GLOB '*[^0-9]*'
  AND EXISTS (
    SELECT 1
    FROM browse_cache_items AS duplicate
    WHERE duplicate.source = browse_cache_items.source
      AND (
        duplicate.source_id = SUBSTR(browse_cache_items.source_id, 7)
        OR LOWER(duplicate.source_id) = 'twitter:' || SUBSTR(browse_cache_items.source_id, 7)
      )
  );

UPDATE browse_cache_items
SET source_id = SUBSTR(source_id, 9)
WHERE LOWER(source) = 'twitter'
  AND LOWER(source_id) LIKE 'twitter:%'
  AND SUBSTR(source_id, 9) != ''
  AND SUBSTR(source_id, 9) NOT GLOB '*[^0-9]*';

UPDATE browse_cache_items
SET source_id = SUBSTR(source_id, 7)
WHERE LOWER(source) = 'twitter'
  AND LOWER(source_id) LIKE 'tweet-%'
  AND SUBSTR(source_id, 7) != ''
  AND SUBSTR(source_id, 7) NOT GLOB '*[^0-9]*';
`;

const repairStructurallyMisclassifiedTwitterRowsSql = `
UPDATE feed
SET
  type = 'tweet',
  source = 'twitter',
  title = NULL,
  metadata = json_patch(
    CASE
      WHEN metadata IS NOT NULL AND json_valid(metadata) THEN metadata
      ELSE '{}'
    END,
    json_object(
      'twitterCanonicalization',
      json_object(
        'legacyRepair', 1,
        'originalType', 'article',
        'originalSource', source,
        'originalSourceId', source_id,
        'originalUrl', url,
        'canonicalTweetId', source_id,
        'evidence', json_array('twitter_source', 'numeric_source_id', 'status_url'),
        'incident', 'legacy-twitter-article-canonicalization'
      )
    )
  )
WHERE type = 'article'
  AND LOWER(COALESCE(source, '')) IN ('twitter', 'x', 'x.com', 'twitter.com')
  AND COALESCE(source_id, '') != ''
  AND source_id NOT GLOB '*[^0-9]*'
  AND (
    LOWER(COALESCE(url, '')) LIKE 'https://x.com/%/status/' || source_id
    OR LOWER(COALESCE(url, '')) LIKE 'https://x.com/%/status/' || source_id || '/%'
    OR LOWER(COALESCE(url, '')) LIKE 'https://x.com/%/status/' || source_id || '?%'
    OR LOWER(COALESCE(url, '')) LIKE 'https://x.com/%/status/' || source_id || '#%'
    OR LOWER(COALESCE(url, '')) LIKE 'https://twitter.com/%/status/' || source_id
    OR LOWER(COALESCE(url, '')) LIKE 'https://twitter.com/%/status/' || source_id || '/%'
    OR LOWER(COALESCE(url, '')) LIKE 'https://twitter.com/%/status/' || source_id || '?%'
    OR LOWER(COALESCE(url, '')) LIKE 'https://twitter.com/%/status/' || source_id || '#%'
  );
`;

const createTweetCachePriorityAccountsTableSql = `
CREATE TABLE IF NOT EXISTS tweet_cache_priority_accounts (
  source TEXT NOT NULL DEFAULT 'twitter',
  handle TEXT NOT NULL,
  include_replies INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, handle)
);
`;

const createTweetCachePriorityAccountsIndexesSql = [
  `CREATE INDEX IF NOT EXISTS tweet_cache_priority_accounts_updated_idx ON tweet_cache_priority_accounts (source, updated_at DESC);`,
];

const createTweetCacheFetchStateTableSql = `
CREATE TABLE IF NOT EXISTS tweet_cache_fetch_state (
  source TEXT NOT NULL DEFAULT 'twitter',
  scope_kind TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  since_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, scope_kind, scope_value)
);
`;

const createTweetCacheFetchStateIndexesSql = [
  `CREATE INDEX IF NOT EXISTS tweet_cache_fetch_state_updated_idx ON tweet_cache_fetch_state (source, updated_at DESC);`,
];

const createCurationLabSnapshotsTableSql = `
CREATE TABLE IF NOT EXISTS curation_lab_snapshots (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'twitter',
  label TEXT,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  snapshot_items_json TEXT NOT NULL,
  recent_user_feedback_json TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  review_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT
);
`;

const alterCurationLabSnapshotsTableSql = [
  `ALTER TABLE curation_lab_snapshots ADD COLUMN recent_user_feedback_json TEXT;`,
];

const createCurationLabSnapshotsIndexesSql = [
  `CREATE INDEX IF NOT EXISTS curation_lab_snapshots_created_at_idx ON curation_lab_snapshots (created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS curation_lab_snapshots_rating_idx ON curation_lab_snapshots (rating, reviewed_at DESC);`,
];

const createCurationLabRunsTableSql = `
CREATE TABLE IF NOT EXISTS curation_lab_runs (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  average_rating REAL,
  comparison_summary_json TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);
`;

const createCurationLabRunsIndexesSql = [
  `CREATE INDEX IF NOT EXISTS curation_lab_runs_created_at_idx ON curation_lab_runs (created_at DESC);`,
];

const createCurationLabRunSnapshotsTableSql = `
CREATE TABLE IF NOT EXISTS curation_lab_run_snapshots (
  run_id TEXT NOT NULL REFERENCES curation_lab_runs(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES curation_lab_snapshots(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, snapshot_id)
);
`;

const createCurationLabRunSnapshotsIndexesSql = [
  `CREATE INDEX IF NOT EXISTS curation_lab_run_snapshots_snapshot_idx ON curation_lab_run_snapshots (snapshot_id, run_id);`,
];

type FeedSourceIdRow = {
  id: string;
  source_id: string;
  origin_session_id: string | null;
  parent_id: string | null;
  relationship: string | null;
  title: string | null;
  text: string;
  url: string | null;
  excerpt: string | null;
  author_username: string | null;
  author_display_name: string | null;
  reason: string | null;
  media_urls: string | null;
  metrics_likes: number | null;
  metrics_reposts: number | null;
  metrics_replies: number | null;
  metrics_views: number | null;
  author_avatar_url: string | null;
  metadata: string | null;
  published_at: string;
  published_at_ms: number | null;
  created_at: string | null;
  created_at_ms: number | null;
};

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseJsonArrayLength(value: string | null): number {
  if (!value) {
    return 0;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function scoreFeedSourceIdRow(row: FeedSourceIdRow): number {
  let score = 0;

  if (trimToNull(row.origin_session_id)) score += 1;
  if (trimToNull(row.parent_id)) score += 1;
  if (trimToNull(row.relationship)) score += 1;
  if (trimToNull(row.title)) score += 1;
  if (trimToNull(row.url)) score += 1;
  if (trimToNull(row.excerpt)) score += 1;
  if (trimToNull(row.author_username)) score += 1;
  if (trimToNull(row.author_display_name)) score += 1;
  if (trimToNull(row.reason)) score += 1;
  if (trimToNull(row.author_avatar_url)) score += 1;
  if (trimToNull(row.metadata)) score += 4;
  if (parseJsonArrayLength(row.media_urls) > 0) score += 2;
  if ((row.metrics_likes ?? 0) > 0) score += 1;
  if ((row.metrics_reposts ?? 0) > 0) score += 1;
  if ((row.metrics_replies ?? 0) > 0) score += 1;
  if ((row.metrics_views ?? 0) > 0) score += 1;

  return score;
}

function rowSortTimestamp(row: FeedSourceIdRow): number {
  if (typeof row.created_at_ms === 'number' && Number.isFinite(row.created_at_ms)) {
    return row.created_at_ms;
  }
  if (typeof row.published_at_ms === 'number' && Number.isFinite(row.published_at_ms)) {
    return row.published_at_ms;
  }

  const createdAtMs = row.created_at ? Date.parse(row.created_at) : Number.NaN;
  if (Number.isFinite(createdAtMs)) {
    return createdAtMs;
  }

  const publishedAtMs = Date.parse(row.published_at);
  return Number.isFinite(publishedAtMs) ? publishedAtMs : Number.MAX_SAFE_INTEGER;
}

function chooseFeedSourceIdSurvivor(rows: FeedSourceIdRow[]): FeedSourceIdRow {
  const [survivor] = [...rows].sort((left, right) => {
    const scoreDelta = scoreFeedSourceIdRow(right) - scoreFeedSourceIdRow(left);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    const timestampDelta = rowSortTimestamp(left) - rowSortTimestamp(right);
    if (timestampDelta !== 0) {
      return timestampDelta;
    }

    return left.id.localeCompare(right.id);
  });

  if (!survivor) {
    throw new Error('Cannot select a survivor from an empty duplicate feed row set');
  }

  return survivor;
}

function chooseOldestFeedSourceIdRow(rows: FeedSourceIdRow[]): FeedSourceIdRow {
  const [survivor] = [...rows].sort((left, right) => {
    const timestampDelta = rowSortTimestamp(left) - rowSortTimestamp(right);
    if (timestampDelta !== 0) {
      return timestampDelta;
    }

    return left.id.localeCompare(right.id);
  });

  if (!survivor) {
    throw new Error('Cannot select the oldest row from an empty duplicate feed row set');
  }

  return survivor;
}

function canonicalArticleSourceIdFromLegacyShape(sourceId: string): string | null {
  const match = sourceId.trim().match(/^([^:/?#\s]+):(\/p\/[^?#\s]+)$/i);
  if (!match) {
    return null;
  }
  const hostOrSlug = match[1];
  const host = hostOrSlug.includes('.') ? hostOrSlug : `${hostOrSlug}.substack.com`;
  return `https://${host}${match[2]}`;
}

function createSelectFeedRowsForSourceIdsStmt(db: Database.Database): Database.Statement {
  return db.prepare(`
    SELECT
      id,
      source_id,
      origin_session_id,
      parent_id,
      relationship,
      title,
      text,
      url,
      excerpt,
      author_username,
      author_display_name,
      reason,
      media_urls,
      metrics_likes,
      metrics_reposts,
      metrics_replies,
      metrics_views,
      author_avatar_url,
      metadata,
      published_at,
      published_at_ms,
      created_at,
      created_at_ms
    FROM feed
    WHERE source_id IN (${Array.from({ length: 2 }, (_, index) => `@source_id_${index}`).join(', ')})
  `);
}

function createSelectRowsForSingleSourceIdStmt(db: Database.Database): Database.Statement {
  return db.prepare(`
    SELECT
      id,
      source_id,
      origin_session_id,
      parent_id,
      relationship,
      title,
      text,
      url,
      excerpt,
      author_username,
      author_display_name,
      reason,
      media_urls,
      metrics_likes,
      metrics_reposts,
      metrics_replies,
      metrics_views,
      author_avatar_url,
      metadata,
      published_at,
      published_at_ms,
      created_at,
      created_at_ms
    FROM feed
    WHERE source_id = ?
  `);
}

function mergeFeedRows(
  db: Database.Database,
  survivorId: string,
  duplicateIds: string[],
): number {
  const relinkChildrenStmt = db.prepare(`UPDATE feed SET parent_id = ? WHERE parent_id = ?`);
  const mergeInteractionsStmt = db.prepare(`
    INSERT OR IGNORE INTO interactions (feed_item_id, action, created_at)
    SELECT ?, action, created_at
    FROM interactions
    WHERE feed_item_id = ?
  `);
  const deleteInteractionsStmt = db.prepare(`DELETE FROM interactions WHERE feed_item_id = ?`);
  const reassignPreferencesStmt = db.prepare(`
    UPDATE preferences
    SET feed_item_id = ?
    WHERE feed_item_id = ?
  `);
  const mergeCodeFixTasksStmt = db.prepare(`
    INSERT OR IGNORE INTO code_fix_tasks (
      suggestion_id,
      task_id,
      status,
      phase,
      phase_detail,
      started_at,
      completed_at,
      error
    )
    SELECT
      ?,
      task_id,
      status,
      phase,
      phase_detail,
      started_at,
      completed_at,
      error
    FROM code_fix_tasks
    WHERE suggestion_id = ?
  `);
  const deleteCodeFixTasksStmt = db.prepare(`DELETE FROM code_fix_tasks WHERE suggestion_id = ?`);
  const deleteFeedRowStmt = db.prepare(`DELETE FROM feed WHERE id = ?`);

  let removedCount = 0;

  for (const duplicateId of duplicateIds) {
    if (duplicateId === survivorId) {
      continue;
    }

    relinkChildrenStmt.run(survivorId, duplicateId);
    mergeInteractionsStmt.run(survivorId, duplicateId);
    deleteInteractionsStmt.run(duplicateId);
    reassignPreferencesStmt.run(survivorId, duplicateId);
    mergeCodeFixTasksStmt.run(survivorId, duplicateId);
    deleteCodeFixTasksStmt.run(duplicateId);
    deleteFeedRowStmt.run(duplicateId);
    removedCount += 1;
  }

  return removedCount;
}

function mergeDuplicateFeedSourceIds(db: Database.Database): void {
  const duplicateSourceIds = db.prepare(`
    SELECT source_id
    FROM feed
    WHERE source_id IS NOT NULL
    GROUP BY source_id
    HAVING COUNT(*) > 1
  `).all() as Array<{ source_id: string }>;

  if (duplicateSourceIds.length === 0) {
    return;
  }

  const selectRowsForSourceIdStmt = createSelectRowsForSingleSourceIdStmt(db);
  let removedCount = 0;

  for (const { source_id } of duplicateSourceIds) {
    const rows = selectRowsForSourceIdStmt.all(source_id) as FeedSourceIdRow[];
    if (rows.length < 2) {
      continue;
    }

    const survivor = chooseFeedSourceIdSurvivor(rows);
    removedCount += mergeFeedRows(
      db,
      survivor.id,
      rows.map((row) => row.id),
    );
  }

  if (removedCount > 0) {
    console.log(`[db] merged ${removedCount} duplicate feed rows before enforcing source_id uniqueness`);
  }
}

function mergeEquivalentArticleSourceIdPairs(db: Database.Database): void {
  const legacySourceIds = db.prepare(`
    SELECT DISTINCT source_id
    FROM feed
    WHERE type = 'article'
      AND source_id IS NOT NULL
      AND source_id NOT LIKE 'http://%'
      AND source_id NOT LIKE 'https://%'
  `).all() as Array<{ source_id: string }>;
  const selectRowsForSourceIdsStmt = createSelectFeedRowsForSourceIdsStmt(db);
  let removedCount = 0;

  for (const { source_id: legacySourceId } of legacySourceIds) {
    const canonicalSourceId = canonicalArticleSourceIdFromLegacyShape(legacySourceId);
    if (!canonicalSourceId) {
      continue;
    }
    const rows = selectRowsForSourceIdsStmt.all({
      source_id_0: legacySourceId,
      source_id_1: canonicalSourceId,
    }) as FeedSourceIdRow[];
    if (rows.length < 2) {
      continue;
    }

    const survivor = chooseOldestFeedSourceIdRow(rows);
    removedCount += mergeFeedRows(
      db,
      survivor.id,
      rows.map((row) => row.id),
    );
  }

  if (removedCount > 0) {
    console.log(`[db] merged ${removedCount} equivalent article source_id duplicates`);
  }
}

function purgeLegacySuggestionTypes(db: Database.Database): void {
  db.exec(`
    DELETE FROM code_fix_tasks
    WHERE suggestion_id IN (
      SELECT id
      FROM feed
      WHERE type = 'suggestion'
        AND LOWER(COALESCE(json_extract(metadata, '$.suggestionType'), '')) != 'code_fix'
        AND COALESCE(json_extract(metadata, '$.configFile'), '') IN ('data/config.md', 'data/curation-prompt.md')
    );

    DELETE FROM feed
    WHERE type = 'suggestion'
      AND LOWER(COALESCE(json_extract(metadata, '$.suggestionType'), '')) != 'code_fix'
      AND COALESCE(json_extract(metadata, '$.configFile'), '') IN ('data/config.md', 'data/curation-prompt.md')
      AND id NOT IN (
        SELECT suggestion_id
        FROM config_apply_tasks
      );

    UPDATE chat_messages
    SET suggestions = NULL
    WHERE suggestions IS NOT NULL;
  `);
}

function normalizeLegacySuggestionStatuses(db: Database.Database): void {
  db.exec(`
    UPDATE feed
    SET metadata = json_set(
      CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
      '$.suggestionStatus',
      'pending'
    )
    WHERE type = 'suggestion'
      AND COALESCE(TRIM(json_extract(
        CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
        '$.suggestionStatus'
      )), '') = '';
  `);
}

function quarantineImplausibleSourceDates(db: Database.Database): void {
  const twitterEpochMs = Date.UTC(2006, 2, 21);
  const youtubeEpochMs = Date.UTC(2005, 3, 23);
  const instagramEpochMs = Date.UTC(2010, 9, 6);
  db.prepare(`
    UPDATE feed
    SET metadata = json_set(
          CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
          '$.quarantine.reason',
          'implausible_publish_date'
        ),
        display_order = NULL,
        thread_id = NULL,
        display_subtitle = NULL
    WHERE parent_id IS NULL
      AND published_at_ms IS NOT NULL
      AND (
        (type = 'tweet' AND published_at_ms < ?)
        OR (LOWER(COALESCE(source, '')) = 'youtube' AND published_at_ms < ?)
        OR (LOWER(COALESCE(source, '')) = 'instagram' AND published_at_ms < ?)
      );
  `).run(twitterEpochMs, youtubeEpochMs, instagramEpochMs);
}

function ensureFeedSourceIdUniqueIndex(db: Database.Database): void {
  db.transaction(() => {
    mergeEquivalentArticleSourceIdPairs(db);
    mergeDuplicateFeedSourceIds(db);
    db.exec(createFeedSourceIdUniqueIndexSql);
  })();
}

export function ensureFeedSchema(db: Database.Database): void {
  db.exec(createFeedTableSql);
  for (const stmt of alterFeedTimestampColumnsSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of alterFeedTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of createIndexesSql) {
    db.exec(stmt);
  }
  db.exec(syncAgentPublishedAtSql);
  db.exec(backfillFeedTimestampMsSql);
  db.exec(repairArticlePublishedTimesFromMetadataSql);
  for (const stmt of dropFeedTimestampTriggersSql) {
    db.exec(stmt);
  }
  db.exec(createFeedTimestampInsertTriggerSql);
  db.exec(createFeedTimestampUpdateTriggerSql);
  db.exec(backfillTweetMetricsFromMetadataSql);
  db.exec(backfillOpenClawChatCuratorSourceSql);
  runOptionalSchemaStep('normalizeLegacySuggestionStatuses', () => {
    normalizeLegacySuggestionStatuses(db);
  });
  runOptionalSchemaStep('quarantineImplausibleSourceDates', () => {
    quarantineImplausibleSourceDates(db);
  });
  db.exec(createFeedThreadsTableSql);
  for (const stmt of createFeedThreadIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createFeedArrangementRunsTableSql);
  for (const stmt of createFeedArrangementRunIndexesSql) {
    db.exec(stmt);
  }
  runOptionalSchemaStep('compactFeedArrangementRuns', () => {
    compactFeedArrangementRuns(db);
  });
  db.exec(createInteractionsTableSql);
  for (const stmt of createInteractionIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createFeedEngagementSessionsTableSql);
  for (const stmt of alterFeedEngagementSessionsTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of createFeedEngagementSessionIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createChatMessagesTableSql);
  db.exec(createChatSessionsTableSql);
  db.exec(createChatSessionBrainSettingsTableSql);
  db.exec(createClaudeTaskUsageTableSql);
  for (const stmt of alterChatSessionBrainSettingsTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of alterChatMessagesTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of alterChatSessionsTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of createChatIndexesSql) {
    db.exec(stmt);
  }
  for (const stmt of createChatSessionIndexesSql) {
    db.exec(stmt);
  }
  for (const stmt of createClaudeTaskUsageIndexesSql) {
    db.exec(stmt);
  }
  ensureChatSessionBrainSettingsConstraint(db);
  runOptionalSchemaStep('backfillChatSessions', () => {
    db.exec(backfillChatSessionsSql);
  });
  runOptionalSchemaStep('backfillChatSessionProvider', () => {
    db.exec(backfillChatSessionProviderSql);
  });
  runOptionalSchemaStep('backfillChatSessionTitles', () => {
    backfillChatSessionTitles(db);
  });
  runOptionalSchemaStep('backfillChatSessionBrainSettings', () => {
    backfillChatSessionBrainSettings(db);
  });
  runOptionalSchemaStep('cleanupLeakedSetupReadinessChatRows', () => {
    db.exec(cleanupOrphanedReplayOnlyChatRowsSql);
  });
  ensureChatSessionBrainSettingsConstraint(db);
  runOptionalSchemaStep('clearInvalidCodexContextMetrics', () => {
    clearInvalidCodexContextMetrics(db);
  });
  db.exec(clampFutureChatTimestampsSql);
  db.exec(fixOutOfOrderAgentRepliesSql);
  db.exec(createUserActivityTableSql);
  for (const stmt of createUserActivityIndexesSql) {
    db.exec(stmt);
  }
  // Older builds appended a synthetic foreground row every 75 seconds. Those
  // transport heartbeats are presence, not behavioral evidence, and otherwise
  // crowd real opens/pulls out of the adaptive-cadence history window.
  db.exec(purgeLegacyForegroundHeartbeatActivitySql);
  db.exec(createAppPresenceTableSql);
  for (const stmt of alterAppPresenceTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  db.exec(createAppPresenceGenerationsTableSql);
  db.exec(createCurationLogTableSql);
  for (const stmt of alterCurationLogTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of createCurationLogIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createPreferencesTableSql);
  for (const stmt of createPreferenceIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createPreferenceVectorsTableSql);
  for (const stmt of createPreferenceVectorIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createThreadFeedbackTableSql);
  for (const stmt of createThreadFeedbackIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createThreadsTableSql);
  for (const stmt of createThreadIndexesSql) {
    db.exec(stmt);
  }
  runOptionalSchemaStep('backfillThreadColors', () => {
    backfillThreadColors(db);
  });
  db.exec(`DROP TABLE IF EXISTS setup_steps;`);
  db.exec(createCodeFixTasksTableSql);
  for (const stmt of createCodeFixTasksIndexesSql) {
    db.exec(stmt);
  }
  ensureConfigApplyTasksTable(db);
  ensureFeedSourceIdUniqueIndex(db);
  purgeLegacySuggestionTypes(db);
  db.exec(createAgentsTableSql);
  for (const stmt of createAgentIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createBrowseCacheItemsTableSql);
  for (const stmt of createBrowseCacheItemIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createAnticipationEventsTableSql);
  for (const stmt of createAnticipationEventIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createBrowseCacheRefreshRunsTableSql);
  for (const stmt of alterBrowseCacheRefreshRunsTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of createBrowseCacheRefreshRunIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createSetupReadinessStateTableSql);
  purgeLegacyPhoneNotificationAgentEvidence(db);
  db.exec(purgeLegacyNotificationBrowseSignalsSql);
  db.exec(repairImpossibleBrowseCacheRefreshRunTimestampsSql);
  db.exec(repairPrefixedTwitterBrowseCacheSourceIdsSql);
  db.exec(repairStructurallyMisclassifiedTwitterRowsSql);
  db.exec(createTweetCachePriorityAccountsTableSql);
  for (const stmt of createTweetCachePriorityAccountsIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createTweetCacheFetchStateTableSql);
  for (const stmt of createTweetCacheFetchStateIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createCurationLabSnapshotsTableSql);
  for (const stmt of alterCurationLabSnapshotsTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of createCurationLabSnapshotsIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createCurationLabRunsTableSql);
  for (const stmt of createCurationLabRunsIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createCurationLabRunSnapshotsTableSql);
  for (const stmt of createCurationLabRunSnapshotsIndexesSql) {
    db.exec(stmt);
  }
  db.exec(createCurationBenchTableSql);
  for (const stmt of alterCurationBenchTableSql) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the column already exists.
    }
  }
  for (const stmt of createCurationBenchIndexesSql) {
    db.exec(stmt);
  }
}
