import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { ensureFeedSchema } from './schema';

function withSchemaDb(run: (db: Database.Database) => void): void {
  const db = new Database(':memory:');
  try {
    ensureFeedSchema(db);
    run(db);
  } finally {
    db.close();
  }
}

describe('ensureFeedSchema', () => {
  test('creates all required tables', () => {
    withSchemaDb((db) => {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const tables = new Set(rows.map((row) => row.name));

      assert.ok(tables.has('feed'));
      assert.ok(tables.has('interactions'));
      assert.ok(tables.has('chat_messages'));
      assert.ok(tables.has('user_activity'));
      assert.ok(tables.has('curation_log'));
      assert.ok(tables.has('preferences'));
      assert.ok(tables.has('preference_vectors'));
      assert.ok(tables.has('thread_feedback'));
      assert.ok(tables.has('threads'));
      assert.ok(tables.has('agents'));
      assert.ok(tables.has('browse_cache_items'));
      assert.ok(tables.has('browse_cache_refresh_runs'));
      assert.ok(tables.has('setup_readiness_state'));
      assert.ok(tables.has('tweet_cache_priority_accounts'));
      assert.ok(tables.has('tweet_cache_fetch_state'));
      assert.ok(tables.has('curation_lab_snapshots'));
      assert.ok(tables.has('curation_lab_runs'));
      assert.ok(tables.has('curation_lab_run_snapshots'));
    });
  });

  test('chat session schema backfill ignores agent-only orphan messages', () => {
    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE chat_messages (
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

        INSERT INTO chat_messages (
          id, type, role, task_id, session_id, text, timestamp, status, metadata
        ) VALUES (
          'chat-agent-only', 'chat', 'agent', 'task-agent-only', 'session-agent-only', 'audit replay', '2026-04-26T09:50:03.000Z', 'delivered', '{"source":"chat-output.jsonl"}'
        );

        INSERT INTO chat_messages (
          id, type, role, session_id, text, timestamp, status
        ) VALUES (
          'msg-user-backed', 'chat', 'user', 'session-user-backed', 'hello', '2026-04-26T09:49:00.000Z', 'delivered'
        );
      `);

      ensureFeedSchema(db);

      const sessions = db.prepare(`
        SELECT id
        FROM chat_sessions
        ORDER BY id ASC
      `).all() as Array<{ id: string }>;

      assert.deepStrictEqual(sessions, [{ id: 'session-user-backed' }]);
    } finally {
      db.close();
    }
  });

  test('schema cleanup removes only the bounded setup-readiness chat leak', () => {
    withSchemaDb((db) => {
      db.exec(`
        INSERT INTO chat_sessions (
          id, provider, provider_session_id, claude_session_id, title, created_at, updated_at
        ) VALUES
          ('00000000-0000-4000-8000-000000000001', 'claude', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Main', '2026-04-26 09:51:46', '2026-04-26 09:52:00'),
          ('00000000-0000-4000-8000-000000000002', 'claude', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'Curator', '2026-04-26 09:51:46', '2026-04-26 09:52:00'),
          ('00000000-0000-4000-8000-000000000075', 'claude', '00000000-0000-4000-8000-000000000075', '00000000-0000-4000-8000-000000000075', 'Session 75', '2026-04-26 09:50:03', '2026-04-26 09:50:03'),
          ('00000000-0000-4000-8000-000000000076', 'claude', '00000000-0000-4000-8000-000000000076', '00000000-0000-4000-8000-000000000076', 'Session 76', '2026-04-26 09:50:03', '2026-04-26 09:50:03'),
          ('00000000-0000-4000-8000-000000000077', 'claude', '00000000-0000-4000-8000-000000000077', '00000000-0000-4000-8000-000000000077', 'Session 77', '2026-04-26 09:50:03', '2026-04-26 09:50:03');

        INSERT INTO chat_session_brain_settings (session_id)
        VALUES
          ('00000000-0000-4000-8000-000000000001'),
          ('00000000-0000-4000-8000-000000000002'),
          ('00000000-0000-4000-8000-000000000075'),
          ('00000000-0000-4000-8000-000000000076'),
          ('00000000-0000-4000-8000-000000000077');

        INSERT INTO chat_messages (
          id, type, role, task_id, session_id, text, timestamp, status, metadata
        ) VALUES
          ('chat-session-75', 'chat', 'agent', 'task-session-75', '00000000-0000-4000-8000-000000000075', 'audit replay', '2026-04-26T09:50:03.000Z', 'delivered', '{"source":"chat-output.jsonl"}'),
          ('chat-session-76-agent', 'chat', 'agent', 'task-session-76', '00000000-0000-4000-8000-000000000076', 'real reply', '2026-04-26T09:50:03.000Z', 'delivered', '{"source":"chat-output.jsonl"}'),
          ('msg-session-76-user', 'chat', 'user', NULL, '00000000-0000-4000-8000-000000000076', 'real user message', '2026-04-26T09:49:30.000Z', 'delivered', NULL),
          ('chat-session-77', 'chat', 'agent', 'task-session-77', '00000000-0000-4000-8000-000000000077', 'feed-backed reply', '2026-04-26T09:50:03.000Z', 'delivered', '{"source":"chat-output.jsonl"}');

        INSERT INTO feed (
          id, type, source, origin_session_id, text, published_at
        ) VALUES (
          'feed-session-77', 'analysis', 'unit-test', '00000000-0000-4000-8000-000000000077', 'feed-backed', '2026-04-26T09:51:00.000Z'
        );
      `);

      ensureFeedSchema(db);

      const remainingSessions = db.prepare(`
        SELECT id
        FROM chat_sessions
        ORDER BY id ASC
      `).all() as Array<{ id: string }>;
      const remainingMessages = db.prepare(`
        SELECT id
        FROM chat_messages
        ORDER BY id ASC
      `).all() as Array<{ id: string }>;

      assert.deepStrictEqual(remainingSessions.map((row) => row.id), [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000076',
        '00000000-0000-4000-8000-000000000077',
      ]);
      assert.deepStrictEqual(remainingMessages.map((row) => row.id), [
        'chat-session-76-agent',
        'chat-session-77',
        'msg-session-76-user',
      ]);
    });
  });

  test('schema startup keeps an existing empty curator session available for heartbeat reuse', () => {
    withSchemaDb((db) => {
      db.exec(`
        INSERT INTO chat_sessions (
          id, provider, provider_session_id, claude_session_id, title, session_type, created_at, updated_at
        ) VALUES (
          '181ee6ea-e31f-4aed-a934-bd106006732b',
          'claude',
          '181ee6ea-e31f-4aed-a934-bd106006732b',
          '181ee6ea-e31f-4aed-a934-bd106006732b',
          'Automated Curator',
          'curator',
          '2026-04-26 11:07:36',
          '2026-04-26 11:07:36'
        );

        INSERT INTO chat_session_brain_settings (session_id)
        VALUES ('181ee6ea-e31f-4aed-a934-bd106006732b');
      `);

      ensureFeedSchema(db);

      const rows = db.prepare(`
        SELECT id, session_type
        FROM chat_sessions
        WHERE session_type = 'curator'
      `).all() as Array<{ id: string; session_type: string | null }>;

      assert.deepStrictEqual(rows, [{
        id: '181ee6ea-e31f-4aed-a934-bd106006732b',
        session_type: 'curator',
      }]);
    });
  });

  test('feed table includes expected columns', () => {
    withSchemaDb((db) => {
      const rows = db.prepare("PRAGMA table_info('feed')").all() as Array<{ name: string }>;
      const columns = new Set(rows.map((row) => row.name));

      const expected = [
        'id',
        'type',
        'source',
        'source_id',
        'parent_id',
        'relationship',
        'title',
        'text',
        'url',
        'excerpt',
        'author_username',
        'author_display_name',
        'reason',
        'tags',
        'media_urls',
        'published_at',
        'published_at_ms',
        'created_at',
        'created_at_ms',
        'metrics_likes',
        'metrics_reposts',
        'metrics_replies',
        'metrics_views',
        'author_avatar_url',
        'metadata',
      ];

      for (const column of expected) {
        assert.ok(columns.has(column), `missing feed column: ${column}`);
      }
    });
  });

  test('backfills thread colors into threads table and feed metadata', () => {
    withSchemaDb((db) => {
      db.prepare(`
        INSERT INTO threads (thread_id, color, created_at_ms)
        VALUES (?, ?, ?)
      `).run('thread-existing', 'rose', 50);

      const insertFeed = db.prepare(`
        INSERT INTO feed (id, type, text, published_at, created_at, metadata)
        VALUES (?, 'article', ?, '2026-04-25T12:00:00.000Z', ?, ?)
      `);
      insertFeed.run(
        'feed-existing-thread',
        'existing thread item',
        '2026-04-25T12:00:00.075Z',
        JSON.stringify({
          cycleId: 'cycle-1',
          thread: { threadId: 'thread-existing', threadTitle: 'Existing thread' },
        }),
      );
      insertFeed.run(
        'feed-new-thread-a',
        'new thread item a',
        '2026-04-25T12:00:00.100Z',
        JSON.stringify({
          cycleId: 'cycle-1',
          thread: { threadId: 'thread-new-a', threadTitle: 'New thread A' },
        }),
      );
      insertFeed.run(
        'feed-new-thread-b',
        'new thread item b',
        '2026-04-25T12:00:00.200Z',
        JSON.stringify({
          cycleId: 'cycle-2',
          thread: { threadId: 'thread-new-b', threadTitle: 'New thread B' },
        }),
      );

      ensureFeedSchema(db);

      const threads = db.prepare(`
        SELECT thread_id, color, created_at_ms
        FROM threads
        ORDER BY thread_id ASC
      `).all() as Array<{ thread_id: string; color: string; created_at_ms: number }>;
      assert.deepStrictEqual(threads, [
        { thread_id: 'thread-existing', color: 'rose', created_at_ms: 50 },
        { thread_id: 'thread-new-a', color: 'blue', created_at_ms: Date.parse('2026-04-25T12:00:00.100Z') },
        { thread_id: 'thread-new-b', color: 'purple', created_at_ms: Date.parse('2026-04-25T12:00:00.200Z') },
      ]);

      const rows = db.prepare(`
        SELECT id, metadata
        FROM feed
        WHERE id IN ('feed-existing-thread', 'feed-new-thread-a', 'feed-new-thread-b')
        ORDER BY id ASC
      `).all() as Array<{ id: string; metadata: string }>;
      const colorsById = Object.fromEntries(rows.map((row) => {
        const metadata = JSON.parse(row.metadata) as { thread?: { color?: string } };
        return [row.id, metadata.thread?.color ?? null];
      }));
      assert.deepStrictEqual(colorsById, {
        'feed-existing-thread': 'rose',
        'feed-new-thread-a': 'blue',
        'feed-new-thread-b': 'purple',
      });

      ensureFeedSchema(db);

      const threadsAfterSecondEnsure = db.prepare(`
        SELECT thread_id, color, created_at_ms
        FROM threads
        ORDER BY thread_id ASC
      `).all();
      assert.deepStrictEqual(threadsAfterSecondEnsure, threads);
    });
  });

  test('legacy setup_steps checklist table is dropped', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE setup_steps (
          id TEXT PRIMARY KEY,
          step_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending'
        );
        INSERT INTO setup_steps (id, step_key, status)
        VALUES ('setup-step-first-curation', 'first_curation', 'pending');
      `);
      ensureFeedSchema(db);
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'setup_steps'").get();
      assert.equal(row, undefined);
    } finally {
      db.close();
    }
  });

  test('setup_steps table is not recreated for new databases', () => {
    withSchemaDb((db) => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'setup_steps'").get();
      assert.equal(row, undefined);
    });
  });

  test('curation_log table includes terminal completion columns', () => {
    withSchemaDb((db) => {
      const rows = db.prepare("PRAGMA table_info('curation_log')").all() as Array<{ name: string }>;
      const columns = new Set(rows.map((row) => row.name));

      assert.ok(columns.has('completion_status'));
      assert.ok(columns.has('completion_reason'));
    });
  });

  test('curation_log terminal completion columns are added to existing databases', () => {
    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE curation_log (
          id INTEGER PRIMARY KEY,
          request_id TEXT UNIQUE,
          triggered_by TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          items_added INTEGER,
          feed_count_before INTEGER
        );
      `);

      ensureFeedSchema(db);

      const rows = db.prepare("PRAGMA table_info('curation_log')").all() as Array<{ name: string }>;
      const columns = new Set(rows.map((row) => row.name));

      assert.ok(columns.has('completion_status'));
      assert.ok(columns.has('completion_reason'));
    } finally {
      db.close();
    }
  });

  test('removes orphan chat session brain settings rows and enforces ON DELETE CASCADE', () => {
    const db = new Database(':memory:');

    try {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL DEFAULT 'claude',
          provider_session_id TEXT NOT NULL DEFAULT '',
          claude_session_id TEXT NOT NULL DEFAULT '',
          title TEXT,
          color TEXT,
          working_directory TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE chat_session_brain_settings (
          session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id),
          claude_reasoning_effort TEXT NOT NULL DEFAULT 'high',
          codex_reasoning_effort TEXT NOT NULL DEFAULT 'high',
          latest_context_tokens INTEGER,
          latest_context_window INTEGER,
          latest_context_model TEXT,
          latest_context_updated_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        INSERT INTO chat_sessions (id) VALUES ('session-live');
        INSERT INTO chat_session_brain_settings (session_id, latest_context_tokens) VALUES ('session-live', 123);
        INSERT INTO chat_session_brain_settings (session_id, latest_context_tokens) VALUES ('session-orphan', 456);
      `);
      db.pragma('foreign_keys = ON');

      ensureFeedSchema(db);

      const rows = db.prepare(`
        SELECT session_id, codex_fast_mode, latest_context_tokens
        FROM chat_session_brain_settings
        ORDER BY session_id ASC
      `).all() as Array<{ session_id: string; codex_fast_mode: number | null; latest_context_tokens: number | null }>;
      assert.deepStrictEqual(rows, [{ session_id: 'session-live', codex_fast_mode: 0, latest_context_tokens: 123 }]);

      const fkRows = db.prepare(`PRAGMA foreign_key_list(chat_session_brain_settings)`).all() as Array<{
        from: string;
        table: string;
        on_delete: string;
      }>;
      assert.ok(fkRows.some((row) => (
        row.from === 'session_id'
        && row.table === 'chat_sessions'
        && row.on_delete === 'CASCADE'
      )));

      db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run('session-live');
      const countRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM chat_session_brain_settings
      `).get() as { count: number };
      assert.strictEqual(countRow.count, 0);
    } finally {
      db.close();
    }
  });

  test('clears legacy Codex context metrics that came from cumulative usage', () => {
    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL DEFAULT 'claude',
          provider_session_id TEXT NOT NULL DEFAULT '',
          claude_session_id TEXT NOT NULL DEFAULT '',
          title TEXT,
          color TEXT,
          working_directory TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE chat_session_brain_settings (
          session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
          claude_reasoning_effort TEXT NOT NULL DEFAULT 'high',
          codex_reasoning_effort TEXT NOT NULL DEFAULT 'high',
          latest_context_tokens INTEGER,
          latest_context_window INTEGER,
          latest_context_model TEXT,
          latest_context_updated_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        INSERT INTO chat_sessions (id, provider) VALUES ('codex-bad', 'codex');
        INSERT INTO chat_sessions (id, provider) VALUES ('codex-good', 'codex');
        INSERT INTO chat_sessions (id, provider) VALUES ('claude-large', 'claude');
        INSERT INTO chat_session_brain_settings (
          session_id,
          latest_context_tokens,
          latest_context_window,
          latest_context_model
        ) VALUES
          ('codex-bad', 3531600, 1000000, 'gpt-5.5'),
          ('codex-good', 177111, 258400, 'gpt-5.5'),
          ('claude-large', 900000, 1000000, 'claude-opus-4-7[1m]');
      `);

      ensureFeedSchema(db);

      const rows = db.prepare(`
        SELECT session_id, latest_context_tokens, latest_context_window, latest_context_model
        FROM chat_session_brain_settings
        WHERE session_id IN ('codex-bad', 'codex-good', 'claude-large')
        ORDER BY session_id ASC
      `).all() as Array<{
        session_id: string;
        latest_context_tokens: number | null;
        latest_context_window: number | null;
        latest_context_model: string | null;
      }>;

      assert.deepStrictEqual(rows, [
        {
          session_id: 'claude-large',
          latest_context_tokens: 900000,
          latest_context_window: 1000000,
          latest_context_model: 'claude-opus-4-7[1m]',
        },
        {
          session_id: 'codex-bad',
          latest_context_tokens: null,
          latest_context_window: null,
          latest_context_model: 'gpt-5.5',
        },
        {
          session_id: 'codex-good',
          latest_context_tokens: 177111,
          latest_context_window: 258400,
          latest_context_model: 'gpt-5.5',
        },
      ]);
    } finally {
      db.close();
    }
  });

  test('chat_sessions and browse cache tables include curator/cache columns', () => {
    withSchemaDb((db) => {
      const sessionColumns = new Set((db.prepare("PRAGMA table_info('chat_sessions')").all() as Array<{ name: string }>).map((row) => row.name));
      assert.ok(sessionColumns.has('session_type'));

      const browseCacheItemColumns = new Set((db.prepare("PRAGMA table_info('browse_cache_items')").all() as Array<{ name: string }>).map((row) => row.name));
      assert.ok(browseCacheItemColumns.has('payload_json'));
      assert.ok(browseCacheItemColumns.has('fetched_at_ms'));
      assert.ok(browseCacheItemColumns.has('expires_at_ms'));
      assert.ok(browseCacheItemColumns.has('seen_by_curation_at_ms'));

      const browseCacheRunColumns = new Set((db.prepare("PRAGMA table_info('browse_cache_refresh_runs')").all() as Array<{ name: string }>).map((row) => row.name));
      assert.ok(browseCacheRunColumns.has('triggered_by'));
      assert.ok(browseCacheRunColumns.has('started_at_ms'));
      assert.ok(browseCacheRunColumns.has('completed_at_ms'));
      assert.ok(browseCacheRunColumns.has('items_added'));
      assert.ok(browseCacheRunColumns.has('metadata_json'));
    });
  });

  test('documented browse cache SQLite verification snippets match the schema', () => {
    withSchemaDb((db) => {
      const newerFetchedAtMs = Date.UTC(2026, 3, 26, 12, 0, 0);
      const olderFetchedAtMs = Date.UTC(2026, 3, 26, 11, 0, 0);
      const insert = db.prepare(`
        INSERT INTO browse_cache_items (
          source,
          source_id,
          url,
          title,
          author_username,
          author_display_name,
          published_at_ms,
          payload_json,
          fetched_at_ms,
          expires_at_ms,
          seen_by_curation_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('twitter', 'tweet-older', 'https://x.com/example/status/1', 'Older item', 'example', 'Example', olderFetchedAtMs, '{}', olderFetchedAtMs, olderFetchedAtMs + 86_400_000, null);
      insert.run('twitter', 'tweet-newer', 'https://x.com/example/status/2', 'Newer item', 'example', 'Example', newerFetchedAtMs, '{}', newerFetchedAtMs, newerFetchedAtMs + 86_400_000, null);
      insert.run('youtube', 'video-newer', 'https://www.youtube.com/watch?v=video-newer', 'Other source item', 'channel', 'Channel', newerFetchedAtMs + 1, '{}', newerFetchedAtMs + 1, newerFetchedAtMs + 86_400_000, null);

      const docPaths = ['.claude/commands/setup-source.md', 'docs/reference/runtime-recipes.md'];
      const snippets = docPaths.flatMap((docPath) => {
        const doc = fs.readFileSync(path.join(process.cwd(), docPath), 'utf8');
        return Array.from(doc.matchAll(/sqlite3 [^\n]*"\n([\s\S]*?)\n"\n```/g))
          .map((match) => ({ docPath, sql: match[1] }))
          .filter(({ sql }) => /FROM\s+browse_cache_items/i.test(sql));
      });
      assert.ok(snippets.length >= 2, 'expected documented browse-cache SQLite verification snippets');

      for (const { docPath, sql } of snippets) {
        const rows = db.prepare(sql.replaceAll('$SOURCE', 'twitter')).all() as Array<{
          source: string;
          source_id: string;
          fetched_at_ms: number;
          fetched_at_utc: string;
        }>;

        assert.equal(rows.length, 2, docPath);
        assert.deepEqual(rows.map((row) => row.source), ['twitter', 'twitter'], docPath);
        assert.deepEqual(rows.map((row) => row.source_id), ['tweet-newer', 'tweet-older'], docPath);
        assert.deepEqual(rows.map((row) => row.fetched_at_ms), [newerFetchedAtMs, olderFetchedAtMs], docPath);
        assert.equal(rows[0].fetched_at_utc, '2026-04-26 12:00:00', docPath);
      }
    });
  });

  test('curation lab tables include snapshot review and run comparison columns', () => {
    withSchemaDb((db) => {
      const snapshotColumns = new Set((db.prepare("PRAGMA table_info('curation_lab_snapshots')").all() as Array<{ name: string }>).map((row) => row.name));
      assert.ok(snapshotColumns.has('prompt'));
      assert.ok(snapshotColumns.has('model'));
      assert.ok(snapshotColumns.has('reasoning_effort'));
      assert.ok(snapshotColumns.has('snapshot_items_json'));
      assert.ok(snapshotColumns.has('recent_user_feedback_json'));
      assert.ok(snapshotColumns.has('rating'));

      const runColumns = new Set((db.prepare("PRAGMA table_info('curation_lab_runs')").all() as Array<{ name: string }>).map((row) => row.name));
      assert.ok(runColumns.has('model'));
      assert.ok(runColumns.has('comparison_summary_json'));

      const priorityColumns = new Set((db.prepare("PRAGMA table_info('tweet_cache_priority_accounts')").all() as Array<{ name: string }>).map((row) => row.name));
      assert.ok(priorityColumns.has('handle'));
      assert.ok(priorityColumns.has('include_replies'));

      const fetchStateColumns = new Set((db.prepare("PRAGMA table_info('tweet_cache_fetch_state')").all() as Array<{ name: string }>).map((row) => row.name));
      assert.ok(fetchStateColumns.has('scope_kind'));
      assert.ok(fetchStateColumns.has('since_id'));
    });
  });

  test('enforces UNIQUE constraints on feed.source_id, curation_log.request_id, and preferences(source_id, signal_type)', () => {
    withSchemaDb((db) => {
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO feed (id, type, text, published_at, source_id)
        VALUES ('feed-1', 'article', 'first', @published_at, 'source-dup')
      `).run({ published_at: now });

      assert.throws(() => {
        db.prepare(`
          INSERT INTO feed (id, type, text, published_at, source_id)
          VALUES ('feed-2', 'article', 'second', @published_at, 'source-dup')
        `).run({ published_at: now });
      }, /UNIQUE constraint failed: feed\.source_id/);

      db.prepare(`
        INSERT INTO curation_log (request_id, triggered_by, started_at)
        VALUES ('req-dup', 'unit-test', @started_at)
      `).run({ started_at: now });

      assert.throws(() => {
        db.prepare(`
          INSERT INTO curation_log (request_id, triggered_by, started_at)
          VALUES ('req-dup', 'unit-test-2', @started_at)
        `).run({ started_at: now });
      }, /UNIQUE constraint failed: curation_log\.request_id/);

      db.prepare(`
        INSERT INTO preferences (id, signal_type, source, text, source_id)
        VALUES ('pref-1', 'liked', 'app_thumbsup', 'hello', 'source-pref-dup')
      `).run();

      assert.throws(() => {
        db.prepare(`
          INSERT INTO preferences (id, signal_type, source, text, source_id)
          VALUES ('pref-2', 'liked', 'app_thumbsup', 'hello again', 'source-pref-dup')
        `).run();
      }, /UNIQUE constraint failed: preferences\.source_id, preferences\.signal_type/);

    });
  });

  test('creates expected indexes', () => {
    withSchemaDb((db) => {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
      const indexes = new Set(rows.map((row) => row.name));

      const expected = [
        'feed_source_id_unique_idx',
        'feed_published_at_idx',
        'feed_published_at_ms_idx',
        'feed_created_at_ms_idx',
        'feed_type_idx',
        'feed_source_idx',
        'feed_parent_id_idx',
        'feed_relationship_idx',
        'idx_interactions_feed',
        'idx_interactions_feed_action',
        'chat_messages_timestamp_idx',
        'chat_messages_in_reply_to_idx',
        'chat_messages_agent_task_reply_unique_idx',
        'idx_user_activity_timestamp',
        'idx_user_activity_event_timestamp',
        'idx_curation_log_started_at',
        'idx_curation_log_completed_at',
        'preferences_signal_type_idx',
        'preferences_source_idx',
        'preferences_created_at_idx',
        'preferences_feed_item_id_idx',
        'preference_vectors_signal_type_idx',
        'preference_vectors_source_idx',
        'agents_status_started_at_idx',
        'agents_log_file_idx',
        'browse_cache_items_source_expires_idx',
        'browse_cache_items_source_published_idx',
        'browse_cache_items_source_seen_idx',
        'browse_cache_refresh_runs_source_started_idx',
        'browse_cache_refresh_runs_source_status_idx',
        'tweet_cache_priority_accounts_updated_idx',
        'tweet_cache_fetch_state_updated_idx',
        'curation_lab_snapshots_created_at_idx',
        'curation_lab_snapshots_rating_idx',
        'curation_lab_runs_created_at_idx',
        'curation_lab_run_snapshots_snapshot_idx',
      ];

      for (const name of expected) {
        assert.ok(indexes.has(name), `missing index: ${name}`);
      }
    });
  });

  test('clamps existing future-dated chat timestamps during schema ensure', () => {
    withSchemaDb((db) => {
      const futureTimestamp = '2999-01-01T00:00:00.000Z';
      db.prepare(`
        INSERT INTO chat_messages (id, role, text, timestamp)
        VALUES ('chat-future', 'agent', 'future message', ?)
      `).run(futureTimestamp);

      ensureFeedSchema(db);

      const row = db.prepare(`
        SELECT
          timestamp,
          datetime(timestamp) <= datetime('now') AS is_clamped
        FROM chat_messages
        WHERE id = 'chat-future'
      `).get() as { timestamp: string; is_clamped: number } | undefined;

      assert.ok(row);
      assert.notStrictEqual(row?.timestamp, futureTimestamp);
      assert.strictEqual(row?.is_clamped, 1);
    });
  });

  test('repairs impossible browse cache refresh start timestamps during schema ensure', () => {
    withSchemaDb((db) => {
      const now = Date.now();
      const completedAtMs = now - 60_000;
      const impossibleStartedAtMs = now + 5 * 24 * 60 * 60 * 1000;

      db.prepare(`
        INSERT INTO browse_cache_refresh_runs (
          id,
          source,
          triggered_by,
          started_at_ms,
          completed_at_ms,
          status,
          items_added
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'browse-cache-refresh-impossible-start',
        'substack',
        'test',
        impossibleStartedAtMs,
        completedAtMs,
        'completed',
        10,
      );

      ensureFeedSchema(db);

      const row = db.prepare(`
        SELECT started_at_ms, completed_at_ms
        FROM browse_cache_refresh_runs
        WHERE id = 'browse-cache-refresh-impossible-start'
      `).get() as { started_at_ms: number; completed_at_ms: number } | undefined;

      assert.ok(row);
      assert.strictEqual(row.started_at_ms, completedAtMs);
      assert.strictEqual(row.completed_at_ms, completedAtMs);
    });
  });

  test('narrowly repairs known Twitter article rows from the affected curation windows', () => {
    withSchemaDb((db) => {
      db.exec(`
        INSERT INTO feed (
          id, type, source, source_id, title, text, url, published_at, created_at, metadata
        ) VALUES
          (
            'legacy-twitter-article-0103',
            'article',
            'twitter',
            '2030455675357143260',
            'Untitled article',
            'tweet-shaped article from the affected cycle',
            'https://x.com/example/status/2030455675357143260',
            '2026-04-28T01:02:00.000Z',
            '2026-04-28T01:03:22.000Z',
            '{"cycleId":"curate-0103"}'
          ),
          (
            'legacy-twitter-article-0517',
            'article',
            'twitter',
            '2030455675357143261',
            'Untitled article',
            'tweet-shaped article from the second affected cycle',
            'https://twitter.com/example/status/2030455675357143261',
            '2026-04-28T05:16:00.000Z',
            '2026-04-28T05:17:12.000Z',
            '{"cycleId":"curate-0517"}'
          ),
          (
            'twitter-article-outside-window',
            'article',
            'twitter',
            '2030455675357143262',
            'Leave this article alone',
            'outside the affected windows',
            'https://x.com/example/status/2030455675357143262',
            '2026-04-28T06:00:00.000Z',
            '2026-04-28T06:00:12.000Z',
            '{}'
          ),
          (
            'twitter-status-prefix-only',
            'article',
            'twitter',
            '203045567535714326',
            'Leave prefix-only IDs alone',
            'status URL does not exactly match source_id',
            'https://x.com/example/status/2030455675357143269',
            '2026-04-28T01:03:00.000Z',
            '2026-04-28T01:03:30.000Z',
            '{}'
          ),
          (
            'x-web-article',
            'article',
            'web',
            'https://x.com/i/trending',
            'Leave this non-status page alone',
            'not a status url',
            'https://x.com/i/trending',
            '2026-04-28T01:03:00.000Z',
            '2026-04-28T01:03:30.000Z',
            '{}'
          );
      `);

      ensureFeedSchema(db);

      const rows = db.prepare(`
        SELECT id, type, source, source_id, title, metadata
        FROM feed
        WHERE id IN (
          'legacy-twitter-article-0103',
          'legacy-twitter-article-0517',
          'twitter-article-outside-window',
          'twitter-status-prefix-only',
          'x-web-article'
        )
        ORDER BY id ASC
      `).all() as Array<{
        id: string;
        type: string;
        source: string | null;
        source_id: string | null;
        title: string | null;
        metadata: string | null;
      }>;

      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of ['legacy-twitter-article-0103', 'legacy-twitter-article-0517']) {
        const row = byId.get(id);
        assert.ok(row, `expected row ${id}`);
        assert.strictEqual(row.type, 'tweet');
        assert.strictEqual(row.source, 'twitter');
        assert.strictEqual(row.title, null);
        const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
        assert.deepStrictEqual(metadata.twitterCanonicalization, {
          legacyRepair: 1,
          originalType: 'article',
          originalSource: 'twitter',
          originalSourceId: row.source_id,
          originalUrl: id === 'legacy-twitter-article-0103'
            ? 'https://x.com/example/status/2030455675357143260'
            : 'https://twitter.com/example/status/2030455675357143261',
          canonicalTweetId: row.source_id,
          evidence: ['twitter_source', 'numeric_source_id', 'status_url'],
          incident: 'fix-retry-canonicalize-twitter-items-before-1777367388424',
        });
      }

      assert.strictEqual(byId.get('twitter-article-outside-window')?.type, 'article');
      assert.strictEqual(byId.get('twitter-status-prefix-only')?.type, 'article');
      assert.strictEqual(byId.get('x-web-article')?.type, 'article');
    });
  });

  test('enforces one delivered agent chat reply per task and reply target', () => {
    withSchemaDb((db) => {
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO chat_messages (id, type, role, text, timestamp, session_id)
        VALUES ('msg-user-1', 'chat', 'user', 'hello', ?, 'session-1')
      `).run(now);

      db.prepare(`
        INSERT INTO chat_messages (id, type, role, in_reply_to, task_id, session_id, text, timestamp)
        VALUES ('chat-agent-1', 'chat', 'agent', 'msg-user-1', 'task-1', 'session-1', 'first reply', ?)
      `).run(now);

      assert.throws(() => {
        db.prepare(`
          INSERT INTO chat_messages (id, type, role, in_reply_to, task_id, session_id, text, timestamp)
          VALUES ('chat-agent-2', 'chat', 'agent', 'msg-user-1', 'task-1', 'session-1', 'duplicate reply', ?)
        `).run(now);
      }, /UNIQUE constraint failed: chat_messages\.task_id, chat_messages\.in_reply_to/);

      db.prepare(`
        INSERT INTO chat_messages (id, type, role, in_reply_to, task_id, session_id, text, timestamp)
        VALUES ('chat-agent-3', 'chat', 'agent', 'msg-user-1', 'task-2', 'session-1', 'retry from new task', ?)
      `).run(now);
    });
  });

  test('syncs published_at to created_at for existing claude rows', () => {
    withSchemaDb((db) => {
      const stalePublishedAt = '2026-03-01T09:00:00.000Z';

      db.prepare(`
        INSERT INTO feed (id, type, source, text, published_at)
        VALUES ('analysis-claude-1', 'analysis', 'claude', 'analysis row', ?)
      `).run(stalePublishedAt);

      db.prepare(`
        INSERT INTO feed (id, type, source, text, published_at)
        VALUES ('article-twitter-1', 'article', 'twitter', 'article row', ?)
      `).run(stalePublishedAt);

      ensureFeedSchema(db);

      const claudeRow = db.prepare(`
        SELECT published_at, created_at
        FROM feed
        WHERE id = 'analysis-claude-1'
      `).get() as { published_at: string; created_at: string } | undefined;

      const twitterRow = db.prepare(`
        SELECT published_at, created_at
        FROM feed
        WHERE id = 'article-twitter-1'
      `).get() as { published_at: string; created_at: string } | undefined;

      assert.ok(claudeRow);
      assert.strictEqual(claudeRow?.published_at, claudeRow?.created_at);

      assert.ok(twitterRow);
      assert.strictEqual(twitterRow?.published_at, stalePublishedAt);
      assert.notStrictEqual(twitterRow?.published_at, twitterRow?.created_at);
    });
  });

  test('repairs known AP article rows with source publish evidence', () => {
    withSchemaDb((db) => {
      db.prepare(`
        INSERT INTO feed (id, type, source, source_id, text, metadata, published_at, created_at)
        VALUES (
          'ma-curate-20260428051600-apnews-apnews-com-article-trump-correspondents-dinner-shooting-suspect-d4111facf965aaaa10334eb5c1',
          'article',
          'apnews',
          'https://apnews.com/article/trump-correspondents-dinner-shooting-suspect-d4111facf965aaaa10334eb5c1',
          'AP article',
          '{}',
          '2026-04-28T05:17:09.461Z',
          '2026-04-28T05:17:12.222Z'
        )
      `).run();

      db.prepare(`
        INSERT INTO feed (id, type, source, source_id, text, metadata, published_at, created_at)
        VALUES (
          'ma-curate-20260428051600-apnews-sibling',
          'article',
          'apnews',
          'https://apnews.com/article/sibling',
          'Sibling AP article',
          '{"article":{"datePublished":"2026-04-27T19:49:07Z"}}',
          '2026-04-28T05:17:09.461Z',
          '2026-04-28T05:17:12.222Z'
        )
      `).run();

      ensureFeedSchema(db);

      const rows = db.prepare(`
        SELECT id, published_at, published_at_ms, metadata
        FROM feed
        ORDER BY id
      `).all() as Array<{
        id: string;
        published_at: string;
        published_at_ms: number;
        metadata: string | null;
      }>;

      assert.strictEqual(rows[0]?.published_at, '2026-04-27T16:32:46.000Z');
      assert.strictEqual(rows[0]?.published_at_ms, Date.parse('2026-04-27T16:32:46.000Z'));
      assert.strictEqual(rows[1]?.published_at, '2026-04-27T19:49:07.000Z');
      assert.strictEqual(rows[1]?.published_at_ms, Date.parse('2026-04-27T19:49:07.000Z'));

      const firstMetadata = JSON.parse(rows[0]?.metadata ?? '{}') as Record<string, unknown>;
      const siblingMetadata = JSON.parse(rows[1]?.metadata ?? '{}') as Record<string, unknown>;
      assert.deepStrictEqual((firstMetadata.publishEvidence as Record<string, unknown>)?.publishedAt, '2026-04-27T16:32:46.000Z');
      assert.deepStrictEqual((siblingMetadata.publishEvidence as Record<string, unknown>)?.publishedAt, '2026-04-27T19:49:07.000Z');
    });
  });

  test('moves out-of-order agent replies to after their parent user message', () => {
    withSchemaDb((db) => {
      const userTimestamp = '2026-03-02T17:13:00.000Z';
      const agentTimestamp = '2026-03-02T17:01:00.000Z';

      db.prepare(`
        INSERT INTO chat_messages (id, role, text, timestamp)
        VALUES ('msg-user-1', 'user', 'question', ?)
      `).run(userTimestamp);

      db.prepare(`
        INSERT INTO chat_messages (id, role, in_reply_to, text, timestamp)
        VALUES ('chat-agent-1', 'agent', 'msg-user-1', 'answer', ?)
      `).run(agentTimestamp);

      ensureFeedSchema(db);

      const row = db.prepare(`
        SELECT
          datetime(timestamp) = datetime((SELECT timestamp FROM chat_messages WHERE id = 'msg-user-1'), '+1 second') AS is_fixed
        FROM chat_messages
        WHERE id = 'chat-agent-1'
      `).get() as { is_fixed: number } | undefined;

      assert.ok(row);
      assert.strictEqual(row?.is_fixed, 1);
    });
  });

  test('agents table includes expected columns', () => {
    withSchemaDb((db) => {
      const rows = db.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>;
      const columns = new Set(rows.map((row) => row.name));

      const expected = [
        'id',
        'type',
        'status',
        'pid',
        'log_file',
        'prompt_preview',
        'started_at',
        'completed_at',
        'timeout_ms',
        'timeout_at',
        'exit_code',
        'signal',
        'error',
        'progress_count',
        'last_event_at',
      ];

      for (const column of expected) {
        assert.ok(columns.has(column), `missing agents column: ${column}`);
      }
    });
  });

  test('backfills tweet metrics columns from metadata', () => {
    withSchemaDb((db) => {
      db.prepare(`
        INSERT INTO feed (
          id, type, source, text, published_at, metrics_likes, metrics_reposts, metrics_replies, metadata
        )
        VALUES (
          'tweet-backfill-1',
          'tweet',
          'twitter',
          'tweet body',
          '2026-03-01T00:00:00.000Z',
          0,
          0,
          0,
          '{"likeCount":12,"repostCount":4,"replyCount":3}'
        )
      `).run();

      ensureFeedSchema(db);

      const row = db.prepare(`
        SELECT metrics_likes, metrics_reposts, metrics_replies
        FROM feed
        WHERE id = 'tweet-backfill-1'
      `).get() as { metrics_likes: number; metrics_reposts: number; metrics_replies: number } | undefined;

      assert.ok(row);
      assert.strictEqual(row?.metrics_likes, 12);
      assert.strictEqual(row?.metrics_reposts, 4);
      assert.strictEqual(row?.metrics_replies, 3);
    });
  });

  test('removes legacy config suggestion rows during schema ensure', () => {
    const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-config-suggestion-backfill-'));
    const originalDataDir = process.env.DATA_DIR;

    try {
      process.env.DATA_DIR = tempDataDir;
      fs.writeFileSync(path.join(tempDataDir, 'config.md'), [
        '# Evogent Config',
        '',
        '## Usage Level',
        '',
        'High',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(tempDataDir, 'curation-prompt.md'), [
        '# Curation Prompt',
        '',
        '## Analysis Style Preferences',
        '',
        '- Explain mechanisms before predictions.',
        '- Include direct hyperlinks in sources.',
        '',
      ].join('\n'));

      withSchemaDb((db) => {
        db.prepare(`
          INSERT INTO feed (id, type, text, published_at, metadata)
          VALUES (?, 'suggestion', ?, ?, ?)
        `).run(
          'config-applied-1',
          'Raise usage level.',
          '2026-03-18T00:00:00.000Z',
          JSON.stringify({
            suggestionType: 'config_change',
            configField: 'Usage Level',
            configFile: 'data/config.md',
            proposedValue: 'High',
          }),
        );

        db.prepare(`
          INSERT INTO feed (id, type, text, published_at, metadata)
          VALUES (?, 'suggestion', ?, ?, ?)
        `).run(
          'config-applied-2',
          'Add hyperlink guidance.',
          '2026-03-18T00:01:00.000Z',
          JSON.stringify({
            suggestionType: 'config_change',
            configField: 'Analysis Style',
            configFile: 'data/curation-prompt.md',
            proposedValue: '- Include direct hyperlinks in sources.',
          }),
        );

        db.prepare(`
          INSERT INTO feed (id, type, text, published_at, metadata)
          VALUES (?, 'suggestion', ?, ?, ?)
        `).run(
          'config-pending-1',
          'Add a missing rule.',
          '2026-03-18T00:02:00.000Z',
          JSON.stringify({
            suggestionType: 'config_change',
            configField: 'Analysis Style',
            configFile: 'data/curation-prompt.md',
            proposedValue: '- Add an unimplemented rule.',
          }),
        );

        ensureFeedSchema(db);

        const rows = db.prepare(`
          SELECT id
          FROM feed
          WHERE id IN ('config-applied-1', 'config-applied-2', 'config-pending-1')
          ORDER BY id
        `).all() as Array<{ id: string }>;

        assert.deepStrictEqual(rows, []);

        const interactions = db.prepare(`
          SELECT feed_item_id, action
          FROM interactions
          WHERE feed_item_id IN ('config-applied-1', 'config-applied-2', 'config-pending-1')
          ORDER BY feed_item_id, action
        `).all() as Array<{ feed_item_id: string; action: string }>;

        assert.deepStrictEqual(interactions, []);
      });
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.DATA_DIR;
      } else {
        process.env.DATA_DIR = originalDataDir;
      }
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  test('backfills feed millisecond timestamps from legacy text columns', () => {
    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE feed (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          source TEXT,
          source_id TEXT,
          parent_id TEXT,
          title TEXT,
          text TEXT NOT NULL,
          url TEXT,
          excerpt TEXT,
          author_username TEXT,
          author_display_name TEXT,
          reason TEXT,
          tags TEXT,
          media_urls TEXT,
          published_at TEXT NOT NULL,
          created_at TEXT,
          UNIQUE(source_id)
        );
      `);

      db.prepare(`
        INSERT INTO feed (id, type, text, published_at, created_at)
        VALUES ('legacy-space', 'article', 'space timestamp', ?, ?)
      `).run('2026-03-02 12:00:00', '2026-03-02 12:30:00');

      db.prepare(`
        INSERT INTO feed (id, type, text, published_at, created_at)
        VALUES ('legacy-iso', 'article', 'iso timestamp', ?, ?)
      `).run('2026-03-02T01:00:00.000Z', '2026-03-02T01:30:00.000Z');

      ensureFeedSchema(db);

      const rows = db.prepare(`
        SELECT id, published_at_ms, created_at_ms
        FROM feed
        ORDER BY published_at_ms DESC, created_at_ms DESC
      `).all() as Array<{ id: string; published_at_ms: number; created_at_ms: number }>;

      assert.deepStrictEqual(rows.map((row) => row.id), ['legacy-space', 'legacy-iso']);
      assert.strictEqual(rows[0]?.published_at_ms, Date.parse('2026-03-02T12:00:00.000Z'));
      assert.strictEqual(rows[0]?.created_at_ms, Date.parse('2026-03-02T12:30:00.000Z'));
      assert.strictEqual(rows[1]?.published_at_ms, Date.parse('2026-03-02T01:00:00.000Z'));
      assert.strictEqual(rows[1]?.created_at_ms, Date.parse('2026-03-02T01:30:00.000Z'));
    } finally {
      db.close();
    }
  });

  test('deduplicates legacy feed rows before adding the source_id unique index', () => {
    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE feed (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          source TEXT,
          source_id TEXT,
          parent_id TEXT,
          title TEXT,
          text TEXT NOT NULL,
          url TEXT,
          excerpt TEXT,
          author_username TEXT,
          author_display_name TEXT,
          reason TEXT,
          tags TEXT,
          media_urls TEXT,
          published_at TEXT NOT NULL,
          created_at TEXT
        );

        CREATE TABLE interactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          feed_item_id TEXT NOT NULL,
          action TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE preferences (
          id TEXT PRIMARY KEY,
          signal_type TEXT NOT NULL,
          source TEXT NOT NULL,
          text TEXT NOT NULL,
          feed_item_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE code_fix_tasks (
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

      `);

      db.prepare(`
        INSERT INTO feed (id, type, source, source_id, text, published_at, created_at)
        VALUES
          ('feed-original', 'article', 'rss', 'legacy-dup', 'original row', '2026-03-02T12:00:00.000Z', '2026-03-02T12:01:00.000Z'),
          ('feed-duplicate', 'article', 'rss', 'legacy-dup', 'duplicate row', '2026-03-02T12:00:00.000Z', '2026-03-02T12:02:00.000Z'),
          ('feed-child', 'analysis', 'claude', 'child-row', 'child row', '2026-03-02T12:03:00.000Z', '2026-03-02T12:03:30.000Z')
      `).run();

      db.prepare(`
        INSERT INTO interactions (feed_item_id, action)
        VALUES ('feed-duplicate', 'like')
      `).run();

      db.prepare(`
        INSERT INTO preferences (id, signal_type, source, text, feed_item_id)
        VALUES ('pref-dup', 'liked', 'app_thumbsup', 'pref row', 'feed-duplicate')
      `).run();

      db.prepare(`
        INSERT INTO code_fix_tasks (suggestion_id, task_id, status)
        VALUES ('feed-duplicate', 'task-1', 'running')
      `).run();

      db.prepare(`
        UPDATE feed
        SET parent_id = 'feed-duplicate'
        WHERE id = 'feed-child'
      `).run();

      ensureFeedSchema(db);

      const dedupedRows = db.prepare(`
        SELECT id
        FROM feed
        WHERE source_id = 'legacy-dup'
        ORDER BY id
      `).all() as Array<{ id: string }>;

      assert.deepStrictEqual(dedupedRows, [{ id: 'feed-original' }]);

      const childRow = db.prepare(`
        SELECT parent_id
        FROM feed
        WHERE id = 'feed-child'
      `).get() as { parent_id: string | null } | undefined;
      assert.strictEqual(childRow?.parent_id, 'feed-original');

      const interactionRow = db.prepare(`
        SELECT feed_item_id, action
        FROM interactions
        WHERE action = 'like'
      `).get() as { feed_item_id: string; action: string } | undefined;
      assert.deepStrictEqual(interactionRow, { feed_item_id: 'feed-original', action: 'like' });

      const preferenceRow = db.prepare(`
        SELECT feed_item_id
        FROM preferences
        WHERE id = 'pref-dup'
      `).get() as { feed_item_id: string | null } | undefined;
      assert.strictEqual(preferenceRow?.feed_item_id, 'feed-original');

      const codeFixRow = db.prepare(`
        SELECT suggestion_id, task_id
        FROM code_fix_tasks
        WHERE task_id = 'task-1'
      `).get() as { suggestion_id: string; task_id: string } | undefined;
      assert.deepStrictEqual(codeFixRow, { suggestion_id: 'feed-original', task_id: 'task-1' });

      const configApplyTable = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'config_apply_tasks'
      `).get() as { name?: string } | undefined;
      assert.strictEqual(configApplyTable?.name, undefined);

      const indexRows = db.prepare(`PRAGMA index_list('feed')`).all() as Array<{ name: string; unique: number }>;
      assert.ok(indexRows.some((row) => row.name === 'feed_source_id_unique_idx' && row.unique === 1));

      assert.throws(() => {
        db.prepare(`
          INSERT INTO feed (id, type, source, source_id, text, published_at)
          VALUES ('feed-post-migration-dup', 'article', 'rss', 'legacy-dup', 'after migration', '2026-03-02T12:05:00.000Z')
        `).run();
      }, /UNIQUE constraint failed|UNIQUE constraint/);
    } finally {
      db.close();
    }
  });

  test('merges the known historical article source-id duplicate pairs while keeping the older rows', () => {
    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE feed (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          source TEXT,
          source_id TEXT,
          origin_session_id TEXT,
          parent_id TEXT,
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
          published_at TEXT NOT NULL,
          created_at TEXT
        );

        CREATE TABLE interactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          feed_item_id TEXT NOT NULL,
          action TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE preferences (
          id TEXT PRIMARY KEY,
          signal_type TEXT NOT NULL,
          source TEXT NOT NULL,
          text TEXT NOT NULL,
          feed_item_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE code_fix_tasks (
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
      `);

      db.prepare(`
        INSERT INTO feed (id, type, source, source_id, title, text, url, published_at, created_at)
        VALUES
          ('legacy-hypists', 'article', 'persuasion', 'www.persuasion.community:/p/ai-cant-deal-with-the-real-world', 'What AI Hypists Miss', 'older legacy row', 'https://www.persuasion.community/p/ai-cant-deal-with-the-real-world', '2026-03-01T00:00:00.000Z', '2026-03-01T00:01:00.000Z'),
          ('url-hypists', 'article', 'persuasion', 'https://www.persuasion.community/p/ai-cant-deal-with-the-real-world', 'What AI Hypists Miss', 'newer canonical row', 'https://www.persuasion.community/p/ai-cant-deal-with-the-real-world', '2026-03-01T00:00:00.000Z', '2026-03-01T00:02:00.000Z'),
          ('legacy-alignment', 'article', 'persuasion', 'www.persuasion.community:/p/ai-alignment-is-impossible', 'AI Alignment Is Impossible', 'older legacy row', 'https://www.persuasion.community/p/ai-alignment-is-impossible', '2026-03-02T00:00:00.000Z', '2026-03-02T00:01:00.000Z'),
          ('url-alignment', 'article', 'persuasion', 'https://www.persuasion.community/p/ai-alignment-is-impossible', 'AI Alignment Is Impossible', 'newer canonical row', 'https://www.persuasion.community/p/ai-alignment-is-impossible', '2026-03-02T00:00:00.000Z', '2026-03-02T00:02:00.000Z'),
          ('legacy-chipkin', 'article', 'substack', 'chipkin.substack.com:/p/death-by-intuition', 'Death by Intuition', 'older legacy row', 'https://chipkin.substack.com/p/death-by-intuition', '2026-03-03T00:00:00.000Z', '2026-03-03T00:01:00.000Z'),
          ('url-chipkin', 'article', 'substack', 'https://chipkin.substack.com/p/death-by-intuition', 'Death by Intuition', 'newer canonical row', 'https://chipkin.substack.com/p/death-by-intuition', '2026-03-03T00:00:00.000Z', '2026-03-03T00:02:00.000Z'),
          ('child-row', 'analysis', 'claude', 'child-row', 'Child', 'child row', NULL, '2026-03-03T00:03:00.000Z', '2026-03-03T00:03:30.000Z')
      `).run();

      db.prepare(`
        INSERT INTO interactions (feed_item_id, action)
        VALUES ('url-chipkin', 'like')
      `).run();

      db.prepare(`
        INSERT INTO preferences (id, signal_type, source, text, feed_item_id)
        VALUES ('pref-chipkin', 'liked', 'app_thumbsup', 'pref row', 'url-chipkin')
      `).run();

      db.prepare(`
        INSERT INTO code_fix_tasks (suggestion_id, task_id, status)
        VALUES ('url-chipkin', 'task-1', 'running')
      `).run();

      db.prepare(`
        UPDATE feed
        SET parent_id = 'url-chipkin'
        WHERE id = 'child-row'
      `).run();

      ensureFeedSchema(db);

      const rows = db.prepare(`
        SELECT id, source_id
        FROM feed
        WHERE title IN ('What AI Hypists Miss', 'AI Alignment Is Impossible', 'Death by Intuition')
        ORDER BY id
      `).all() as Array<{ id: string; source_id: string }>;

      assert.deepStrictEqual(rows, [
        { id: 'legacy-alignment', source_id: 'www.persuasion.community:/p/ai-alignment-is-impossible' },
        { id: 'legacy-chipkin', source_id: 'chipkin.substack.com:/p/death-by-intuition' },
        { id: 'legacy-hypists', source_id: 'www.persuasion.community:/p/ai-cant-deal-with-the-real-world' },
      ]);

      const childRow = db.prepare(`
        SELECT parent_id
        FROM feed
        WHERE id = 'child-row'
      `).get() as { parent_id: string | null } | undefined;
      assert.strictEqual(childRow?.parent_id, 'legacy-chipkin');

      const interactionRow = db.prepare(`
        SELECT feed_item_id, action
        FROM interactions
        WHERE action = 'like'
      `).get() as { feed_item_id: string; action: string } | undefined;
      assert.deepStrictEqual(interactionRow, { feed_item_id: 'legacy-chipkin', action: 'like' });

      const preferenceRow = db.prepare(`
        SELECT feed_item_id
        FROM preferences
        WHERE id = 'pref-chipkin'
      `).get() as { feed_item_id: string | null } | undefined;
      assert.strictEqual(preferenceRow?.feed_item_id, 'legacy-chipkin');

      const codeFixRow = db.prepare(`
        SELECT suggestion_id, task_id
        FROM code_fix_tasks
        WHERE task_id = 'task-1'
      `).get() as { suggestion_id: string; task_id: string } | undefined;
      assert.deepStrictEqual(codeFixRow, { suggestion_id: 'legacy-chipkin', task_id: 'task-1' });
    } finally {
      db.close();
    }
  });

  test('populates feed millisecond timestamps for direct inserts after schema ensure', () => {
    withSchemaDb((db) => {
      db.prepare(`
        INSERT INTO feed (id, type, text, published_at, created_at)
        VALUES ('feed-direct-insert', 'article', 'direct insert row', ?, ?)
      `).run('2026-03-03 04:05:06', '2026-03-03T04:06:07.000Z');

      const row = db.prepare(`
        SELECT published_at_ms, created_at_ms
        FROM feed
        WHERE id = 'feed-direct-insert'
      `).get() as { published_at_ms: number; created_at_ms: number } | undefined;

      assert.ok(row);
      assert.strictEqual(row?.published_at_ms, Date.parse('2026-03-03T04:05:06.000Z'));
      assert.strictEqual(row?.created_at_ms, Date.parse('2026-03-03T04:06:07.000Z'));
    });
  });
});
