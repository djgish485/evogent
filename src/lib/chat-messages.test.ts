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
    sessionId: 'session-a',
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
  test('dedupes messages sharing an id, keeping the incoming copy', () => {
    const original = chatMessage({ id: 'msg-1', text: 'queued text', status: 'queued' });
    const updated = chatMessage({ id: 'msg-1', text: 'delivered text', status: 'delivered' });

    assert.deepStrictEqual(mergeChatMessages([original], [updated]), [updated]);
  });

  test('keeps distinct message ids separate', () => {
    const first = chatMessage({ id: 'msg-1', sessionId: 'session-a' });
    const second = chatMessage({ id: 'msg-2', sessionId: 'session-b' });

    assert.strictEqual(mergeChatMessages([first], [second]).length, 2);
  });
});
