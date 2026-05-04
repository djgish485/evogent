const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { upsertChatSessionContextMetrics } = require('./chat-session-context-metrics');

function withDb(run) {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE chat_session_brain_settings (
        session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
        latest_context_tokens INTEGER,
        latest_context_window INTEGER,
        latest_context_model TEXT,
        latest_context_updated_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    run(db);
  } finally {
    db.close();
  }
}

test('upsertChatSessionContextMetrics persists metrics when the parent session exists', () => {
  withDb((db) => {
    db.prepare(`INSERT INTO chat_sessions (id) VALUES (?)`).run('session-1');

    const changed = upsertChatSessionContextMetrics(db, {
      sessionId: 'session-1',
      latestContextTokens: 12345,
      latestContextWindow: 200000,
      latestContextModel: 'claude-sonnet',
    });

    assert.equal(changed, true);
    const row = db.prepare(`
      SELECT latest_context_tokens, latest_context_window, latest_context_model
      FROM chat_session_brain_settings
      WHERE session_id = ?
    `).get('session-1');
    assert.deepEqual(row, {
      latest_context_tokens: 12345,
      latest_context_window: 200000,
      latest_context_model: 'claude-sonnet',
    });
  });
});

test('upsertChatSessionContextMetrics skips missing parent sessions without throwing', () => {
  withDb((db) => {
    const changed = upsertChatSessionContextMetrics(db, {
      sessionId: 'missing-session',
      latestContextTokens: 42,
      latestContextWindow: 1000,
      latestContextModel: 'claude-sonnet',
    });

    assert.equal(changed, false);
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_session_brain_settings
    `).get();
    assert.equal(row.count, 0);
  });
});
