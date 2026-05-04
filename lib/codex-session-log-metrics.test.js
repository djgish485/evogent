const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  backfillCodexSessionContextMetrics,
  extractTokenCountMetrics,
  readLatestCodexSessionLogContextMetrics,
} = require('./codex-session-log-metrics');

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-codex-session-log-'));
  try {
    run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createSessionLog(root, sessionId, lines) {
  const logDir = path.join(root, '2026', '04', '26');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(logPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return logPath;
}

function createTaskLog(root, taskId, lines) {
  fs.mkdirSync(root, { recursive: true });
  const logPath = path.join(root, `${taskId}.jsonl`);
  fs.writeFileSync(logPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return logPath;
}

function createChatDb() {
  const db = new Database(':memory:');
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
      codex_fast_mode INTEGER DEFAULT 0,
      latest_context_tokens INTEGER,
      latest_context_window INTEGER,
      latest_context_model TEXT,
      latest_context_updated_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

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
  `);
  return db;
}

test('Codex session-log token_count uses last_token_usage input tokens and reported window', () => {
  assert.deepStrictEqual(extractTokenCountMetrics({
    type: 'event_msg',
    timestamp: '2026-04-26T10:15:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 174_104,
          cached_input_tokens: 10_000,
        },
        total_token_usage: {
          input_tokens: 1_907_408,
        },
        model_context_window: 258_400,
        model: 'gpt-5.5',
      },
    },
  }), {
    latestContextTokens: 174_104,
    latestContextWindow: 258_400,
    latestContextModel: 'gpt-5.5',
    latestContextUpdatedAt: '2026-04-26T10:15:00.000Z',
  });
});

test('Codex session-log reader ignores turn.completed usage and returns latest token_count', () => {
  withTempDir((sessionsRoot) => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    createSessionLog(sessionsRoot, sessionId, [
      {
        type: 'thread.started',
        thread_id: sessionId,
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1_907_408,
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-04-26T10:16:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 174_104,
            },
            total_token_usage: {
              input_tokens: 3_531_600,
            },
            model_context_window: 258_400,
          },
        },
      },
    ]);

    const metrics = readLatestCodexSessionLogContextMetrics({
      sessionId,
      sessionsRoot,
      fallbackModelId: 'gpt-5.5',
    });

    assert.deepStrictEqual(metrics && {
      latestContextTokens: metrics.latestContextTokens,
      latestContextWindow: metrics.latestContextWindow,
      latestContextModel: metrics.latestContextModel,
      latestContextUpdatedAt: metrics.latestContextUpdatedAt,
    }, {
      latestContextTokens: 174_104,
      latestContextWindow: 258_400,
      latestContextModel: 'gpt-5.5',
      latestContextUpdatedAt: '2026-04-26T10:16:00.000Z',
    });
  });
});

test('Codex context metric backfill repairs existing sessions from recent session logs', () => {
  withTempDir((sessionsRoot) => {
    const db = createChatDb();
    const appSessionId = '22222222-2222-4222-8222-222222222222';
    const providerSessionId = '33333333-3333-4333-8333-333333333333';
    try {
      db.exec(`
        INSERT INTO chat_sessions (id, provider, provider_session_id)
        VALUES ('${appSessionId}', 'codex', '${providerSessionId}');
        INSERT INTO chat_session_brain_settings (
          session_id,
          latest_context_tokens,
          latest_context_window,
          latest_context_model
        ) VALUES ('${appSessionId}', NULL, NULL, 'gpt-5.5');
      `);

      createSessionLog(sessionsRoot, providerSessionId, [
        {
          type: 'thread.started',
          thread_id: providerSessionId,
        },
        {
          type: 'event_msg',
          timestamp: '2026-04-26T10:17:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 174_104,
              },
              model_context_window: 258_400,
            },
          },
        },
      ]);

      assert.deepStrictEqual(backfillCodexSessionContextMetrics(db, { sessionsRoot }), [appSessionId]);

      const row = db.prepare(`
        SELECT latest_context_tokens, latest_context_window, latest_context_model
        FROM chat_session_brain_settings
        WHERE session_id = ?
      `).get(appSessionId);

      assert.deepStrictEqual(row, {
        latest_context_tokens: 174_104,
        latest_context_window: 258_400,
        latest_context_model: 'gpt-5.5',
      });
    } finally {
      db.close();
    }
  });
});

test('Codex context metric backfill uses chat task provenance when provider session id differs from rollout id', () => {
  withTempDir((tempDir) => {
    const sessionsRoot = path.join(tempDir, 'sessions');
    const taskLogsDir = path.join(tempDir, 'task-logs');
    const db = createChatDb();
    const appSessionId = 'b0ec7d67-b14e-4d53-b4f8-5c32de32a483';
    const wrongProviderSessionId = '8f6595cb-66c9-45d6-b4dc-dc48382fdd2a';
    const rolloutSessionId = '019dc8cf-a6de-74b2-9e62-dea6920bbdf4';
    const userMessageId = 'msg-e2564cf2-fb9d-42ae-8511-1a3900ae954c';
    const taskId = `chat-queue-${userMessageId}`;
    try {
      db.prepare(`
        INSERT INTO chat_sessions (id, provider, provider_session_id)
        VALUES (?, 'codex', ?)
      `).run(appSessionId, wrongProviderSessionId);
      db.prepare(`
        INSERT INTO chat_session_brain_settings (
          session_id,
          latest_context_tokens,
          latest_context_window,
          latest_context_model
        ) VALUES (?, NULL, NULL, 'gpt-5.5')
      `).run(appSessionId);
      db.prepare(`
        INSERT INTO chat_messages (id, role, session_id, text, timestamp, metadata)
        VALUES (?, 'user', ?, 'continue', '2026-04-26T08:02:20.000Z', ?)
      `).run(userMessageId, appSessionId, JSON.stringify({ sessionId: appSessionId }));

      createTaskLog(taskLogsDir, taskId, [
        {
          type: 'thread.started',
          thread_id: rolloutSessionId,
        },
      ]);
      createSessionLog(sessionsRoot, rolloutSessionId, [
        {
          type: 'thread.started',
          thread_id: rolloutSessionId,
        },
        {
          type: 'event_msg',
          timestamp: '2026-04-26T08:02:25.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 115_637,
                cached_input_tokens: 45_000,
              },
              total_token_usage: {
                input_tokens: 1_500_000,
              },
              model_context_window: 258_400,
              model: 'gpt-5.5',
            },
          },
        },
      ]);

      assert.strictEqual(readLatestCodexSessionLogContextMetrics({
        sessionId: wrongProviderSessionId,
        sessionsRoot,
      }), null);
      assert.deepStrictEqual(backfillCodexSessionContextMetrics(db, {
        sessionsRoot,
        taskLogsDir,
      }), [appSessionId]);

      const row = db.prepare(`
        SELECT latest_context_tokens, latest_context_window, latest_context_model
        FROM chat_session_brain_settings
        WHERE session_id = ?
      `).get(appSessionId);

      assert.deepStrictEqual(row, {
        latest_context_tokens: 115_637,
        latest_context_window: 258_400,
        latest_context_model: 'gpt-5.5',
      });
    } finally {
      db.close();
    }
  });
});

function countSessionLogReads(sessionsRoot, run) {
  const originalReadFileSync = fs.readFileSync;
  let count = 0;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (typeof filePath === 'string' && filePath.startsWith(sessionsRoot)) {
      count += 1;
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    run();
    return count;
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

test('Codex context metric backfill skips stale incomplete sessions before scanning logs', () => {
  withTempDir((sessionsRoot) => {
    const db = createChatDb();
    const appSessionId = '44444444-4444-4444-8444-444444444444';
    const providerSessionId = '55555555-5555-4555-8555-555555555555';
    const nowMs = Date.parse('2026-04-28T12:00:00.000Z');
    try {
      db.prepare(`
        INSERT INTO chat_sessions (id, provider, provider_session_id, created_at, updated_at)
        VALUES (?, 'codex', ?, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z')
      `).run(appSessionId, providerSessionId);
      db.prepare(`INSERT INTO chat_session_brain_settings (session_id, latest_context_tokens, latest_context_window, latest_context_model) VALUES (?, NULL, NULL, 'gpt-5.5')`).run(appSessionId);
      const logPath = createSessionLog(sessionsRoot, providerSessionId, [
        { type: 'thread.started', thread_id: providerSessionId },
        {
          type: 'event_msg',
          timestamp: '2026-04-28T10:17:00.000Z',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 180_000 }, model_context_window: 258_400 },
          },
        },
      ]);
      fs.utimesSync(logPath, new Date(nowMs), new Date(nowMs));

      const sessionLogReads = countSessionLogReads(sessionsRoot, () => {
        assert.deepStrictEqual(backfillCodexSessionContextMetrics(db, {
          sessionsRoot,
          nowMs,
          maxSessionAgeMs: 7 * 24 * 60 * 60 * 1000,
        }), []);
      });
      assert.equal(sessionLogReads, 0);
    } finally {
      db.close();
    }
  });
});

test('Codex context metric backfill does not rescan logs for every missing session', () => {
  withTempDir((sessionsRoot) => {
    const db = createChatDb();
    const nowMs = Date.parse('2026-04-28T12:00:00.000Z');
    try {
      for (let index = 0; index < 3; index += 1) {
        db.prepare(`
          INSERT INTO chat_sessions (id, provider, provider_session_id, created_at, updated_at)
          VALUES (?, 'codex', ?, '2026-04-28T11:00:00.000Z', '2026-04-28T11:00:00.000Z')
        `).run(`app-session-${index}`, `missing-provider-session-${index}`);
        db.prepare(`INSERT INTO chat_session_brain_settings (session_id, latest_context_tokens, latest_context_window, latest_context_model) VALUES (?, NULL, NULL, 'gpt-5.5')`).run(`app-session-${index}`);
      }

      for (let index = 0; index < 5; index += 1) {
        const logPath = createSessionLog(sessionsRoot, `unrelated-session-${index}`, [
          { type: 'thread.started', thread_id: `unrelated-session-${index}` },
        ]);
        fs.utimesSync(logPath, new Date(nowMs - index * 1_000), new Date(nowMs - index * 1_000));
      }

      const sessionLogReads = countSessionLogReads(sessionsRoot, () => {
        assert.deepStrictEqual(backfillCodexSessionContextMetrics(db, {
          sessionsRoot,
          nowMs,
          maxSessions: 3,
          maxFiles: 5,
          maxBroadLogSearches: 1,
        }), []);
      });
      assert.equal(sessionLogReads, 5);
    } finally {
      db.close();
    }
  });
});
