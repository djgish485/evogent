import assert from 'node:assert';
import { describe, test } from 'node:test';
import { mergeChatMessages } from './chat-messages';
import { type ChatMessage } from '@/types/chat';

function chatMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    type: 'chat',
    id: 'msg-1',
    role: 'user',
    inReplyTo: null,
    sessionId: 'openclaw:session-a',
    text: 'hello',
    timestamp: '2026-05-18T12:00:00.000Z',
    context: null,
    status: 'delivered',
    metadata: null,
    createdAt: '2026-05-18T12:00:00.000Z',
    ...overrides,
  };
}

describe('mergeChatMessages', () => {
  test('dedupes OpenClaw optimistic and confirmed user messages by idempotency key', () => {
    const optimistic = chatMessage({
      id: 'openclaw-user-evogent-1',
      metadata: {
        source: 'openclaw',
        openclawSessionKey: 'session-a',
        idempotencyKey: 'evogent-1',
      },
    });
    const confirmed = chatMessage({
      id: 'openclaw-confirmed-1',
      metadata: {
        source: 'openclaw',
        openclawSessionKey: 'session-a',
        idempotencyKey: 'evogent-1',
      },
    });

    assert.deepStrictEqual(mergeChatMessages([optimistic], [confirmed]), [confirmed]);
    assert.deepStrictEqual(mergeChatMessages([confirmed], [optimistic]), [confirmed]);
  });

  test('keeps matching idempotency keys separate across sessions', () => {
    const first = chatMessage({
      id: 'openclaw-user-evogent-1',
      sessionId: 'openclaw:session-a',
      metadata: {
        source: 'openclaw',
        openclawSessionKey: 'session-a',
        idempotencyKey: 'evogent-1',
      },
    });
    const second = chatMessage({
      id: 'openclaw-user-evogent-1-session-b',
      sessionId: 'openclaw:session-b',
      metadata: {
        source: 'openclaw',
        openclawSessionKey: 'session-b',
        idempotencyKey: 'evogent-1',
      },
    });

    assert.strictEqual(mergeChatMessages([first], [second]).length, 2);
  });
});
