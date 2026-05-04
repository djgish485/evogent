import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const {
  buildSessionResetHistoryBlock,
  getRecentChatMessages,
} = require('./chat-session-rehydrate.js') as {
  buildSessionResetHistoryBlock: (
    messages: Array<{ role: string; text: string; timestamp: string }>,
    options?: { perMessageCharLimit?: number; maxBlockChars?: number },
  ) => string;
  getRecentChatMessages: (
    db: Database.Database,
    options?: { limit?: number; sessionId?: string | null; excludeMessageId?: string | null },
  ) => Array<{ id: string; role: string; text: string; timestamp: string }>;
};

function createChatDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      role TEXT NOT NULL,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

test('getRecentChatMessages returns the most recent chat rows in chronological order and excludes the current message', () => {
  const db = createChatDb();

  db.prepare(`
    INSERT INTO chat_messages (id, type, role, session_id, text, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg-1', 'chat', 'user', 'session-a', 'first question', '2026-03-13T14:30:00.000Z', '2026-03-13T14:30:00.000Z');
  db.prepare(`
    INSERT INTO chat_messages (id, type, role, session_id, text, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg-2', 'chat', 'agent', 'session-a', 'first answer', '2026-03-13T14:31:00.000Z', '2026-03-13T14:31:00.000Z');
  db.prepare(`
    INSERT INTO chat_messages (id, type, role, session_id, text, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('event-1', 'agent_event', 'agent', 'session-a', 'internal event', '2026-03-13T14:32:00.000Z', '2026-03-13T14:32:00.000Z');
  db.prepare(`
    INSERT INTO chat_messages (id, type, role, session_id, text, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg-3', 'chat', 'user', 'session-a', 'latest question', '2026-03-13T14:33:00.000Z', '2026-03-13T14:33:00.000Z');

  const messages = getRecentChatMessages(db, {
    limit: 3,
    sessionId: 'session-a',
    excludeMessageId: 'msg-3',
  });

  assert.deepStrictEqual(messages, [
    {
      id: 'msg-1',
      role: 'user',
      text: 'first question',
      timestamp: '2026-03-13T14:30:00.000Z',
    },
    {
      id: 'msg-2',
      role: 'agent',
      text: 'first answer',
      timestamp: '2026-03-13T14:31:00.000Z',
    },
  ]);

  db.close();
});

test('getRecentChatMessages only returns rows from the active session when sessions are interleaved', () => {
  const db = createChatDb();

  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (id, type, role, session_id, text, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertMessage.run('a-1', 'chat', 'user', 'session-a', 'atlas question', '2026-04-01T10:00:00.000Z', '2026-04-01T10:00:00.000Z');
  insertMessage.run('b-1', 'chat', 'user', 'session-b', 'pulse question', '2026-04-01T10:01:00.000Z', '2026-04-01T10:01:00.000Z');
  insertMessage.run('a-2', 'chat', 'agent', 'session-a', 'atlas answer', '2026-04-01T10:02:00.000Z', '2026-04-01T10:02:00.000Z');
  insertMessage.run('c-1', 'chat', 'user', 'session-c', 'drift question', '2026-04-01T10:03:00.000Z', '2026-04-01T10:03:00.000Z');
  insertMessage.run('a-3', 'chat', 'user', 'session-a', 'atlas retry source', '2026-04-01T10:04:00.000Z', '2026-04-01T10:04:00.000Z');
  insertMessage.run('b-2', 'chat', 'agent', 'session-b', 'pulse answer', '2026-04-01T10:05:00.000Z', '2026-04-01T10:05:00.000Z');

  const messages = getRecentChatMessages(db, {
    limit: 10,
    sessionId: 'session-a',
    excludeMessageId: 'a-3',
  });

  assert.deepStrictEqual(messages, [
    {
      id: 'a-1',
      role: 'user',
      text: 'atlas question',
      timestamp: '2026-04-01T10:00:00.000Z',
    },
    {
      id: 'a-2',
      role: 'agent',
      text: 'atlas answer',
      timestamp: '2026-04-01T10:02:00.000Z',
    },
  ]);

  assert.deepStrictEqual(getRecentChatMessages(db, {
    limit: 10,
    excludeMessageId: 'a-3',
  }), []);

  db.close();
});

test('buildSessionResetHistoryBlock truncates long messages and keeps the most recent lines within budget', () => {
  const history = buildSessionResetHistoryBlock([
    {
      role: 'user',
      text: 'older context that should be dropped when the budget is tight',
      timestamp: '2026-03-13T14:28:00.000Z',
    },
    {
      role: 'agent',
      text: 'another older message that should also fall off first',
      timestamp: '2026-03-13T14:29:00.000Z',
    },
    {
      role: 'user',
      text: 'one more older line to ensure the helper trims from the front',
      timestamp: '2026-03-13T14:30:00.000Z',
    },
    {
      role: 'agent',
      text: 'A'.repeat(120),
      timestamp: '2026-03-13T14:31:00.000Z',
    },
    {
      role: 'user',
      text: 'latest follow up',
      timestamp: '2026-03-13T14:32:00.000Z',
    },
  ], {
    perMessageCharLimit: 40,
    maxBlockChars: 500,
  });

  assert.match(history, /^\[Session was reset - prior conversation history for context:\]/);
  assert.match(history, /\[End of prior history\. Current message follows\.\]$/);
  assert.doesNotMatch(history, /older context that should be dropped/);
  assert.match(history, /Agent \(2026-03-13 14:29 UTC\): another older message that should also fall off first/);
  assert.match(history, /Agent \(2026-03-13 14:31 UTC\): A+\.\.\./);
  assert.match(history, /User \(2026-03-13 14:32 UTC\): latest follow up/);
});
