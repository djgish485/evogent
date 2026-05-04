import assert from 'node:assert/strict';
import test from 'node:test';

import cleanupModule from '../lib/chat-message-cleanup.js';

const { failStaleQueuedChatMessages } = cleanupModule;

function createDb() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      if (!sql.includes('UPDATE chat_messages')) {
        throw new Error(`Unexpected SQL in test double: ${sql}`);
      }

      return {
        run() {
          let changes = 0;
          for (const row of rows) {
            const hasReply = rows.some((candidate) => (
              candidate.in_reply_to === row.id
              && candidate.role === 'agent'
              && candidate.type === 'chat'
            ));
            const shouldFail = row.role === 'user'
              && row.type === 'chat'
              && ['pending', 'queued', 'processing'].includes(row.status)
              && !hasReply;
            if (shouldFail) {
              row.status = 'failed';
              changes += 1;
            }
          }
          return { changes };
        },
      };
    },
  };
}

test('failStaleQueuedChatMessages fails orphaned queued user chat rows', () => {
  const db = createDb();
  db.rows.push({
    id: 'msg-queued',
    type: 'chat',
    role: 'user',
    in_reply_to: null,
    text: 'queued text',
    timestamp: '2026-03-26T06:46:09.624Z',
    status: 'queued',
  });

  const changes = failStaleQueuedChatMessages(db);
  const row = db.rows.find((entry) => entry.id === 'msg-queued');

  assert.equal(changes, 1);
  assert.equal(row?.status, 'failed');
});

test('failStaleQueuedChatMessages preserves queued messages that already have a reply', () => {
  const db = createDb();
  db.rows.push({
    id: 'msg-queued',
    type: 'chat',
    role: 'user',
    in_reply_to: null,
    text: 'queued text',
    timestamp: '2026-03-26T06:46:09.624Z',
    status: 'queued',
  });
  db.rows.push({
    id: 'msg-reply',
    type: 'chat',
    role: 'agent',
    in_reply_to: 'msg-queued',
    text: 'reply text',
    timestamp: '2026-03-26T06:46:20.000Z',
    status: 'delivered',
  });

  const changes = failStaleQueuedChatMessages(db);
  const row = db.rows.find((entry) => entry.id === 'msg-queued');

  assert.equal(changes, 0);
  assert.equal(row?.status, 'queued');
});
