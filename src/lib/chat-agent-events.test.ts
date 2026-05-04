import assert from 'node:assert';
import { describe, test } from 'node:test';
import { shouldDisplayAgentEventInChat } from './chat-agent-events';
import type { ChatMessage } from '@/types/chat';

function createAgentEvent(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    type: 'agent_event',
    id: 'event-1',
    role: 'agent',
    inReplyTo: null,
    sessionId: null,
    text: 'event',
    timestamp: '2026-03-29T00:00:00.000Z',
    context: null,
    status: 'delivered',
    metadata: {},
    createdAt: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('shouldDisplayAgentEventInChat', () => {
  test('suppresses routine operational completion events', () => {
    const result = shouldDisplayAgentEventInChat(createAgentEvent({
      text: 'Curation cycle complete.',
      metadata: {
        event: 'curation_finished',
        status: 'completed',
        taskId: 'curation-1',
      },
    }));

    assert.strictEqual(result, false);
  });

  test('suppresses routine operational running events', () => {
    const result = shouldDisplayAgentEventInChat(createAgentEvent({
      text: 'Intake enrichment sub-agent started.',
      metadata: {
        event: 'intake_started',
        status: 'running',
        hasTranscript: true,
      },
    }));

    assert.strictEqual(result, false);
  });

  test('keeps actionable chat suggestion events', () => {
    const result = shouldDisplayAgentEventInChat(createAgentEvent({
      sessionId: 'session-1',
      metadata: {
        event: 'chat_suggestion',
        suggestionId: 'suggestion-1',
        suggestionType: 'code_fix',
        proposedValue: 'Fix the broken pipeline.',
      },
    }));

    assert.strictEqual(result, true);
  });

  test('keeps persisted chat progress events', () => {
    const result = shouldDisplayAgentEventInChat(createAgentEvent({
      sessionId: 'session-1',
      metadata: {
        source: 'chat_progress',
        progressKind: 'tool_call',
        toolName: 'Read',
      },
    }));

    assert.strictEqual(result, true);
  });

  test('keeps failure events tied to a conversation', () => {
    const result = shouldDisplayAgentEventInChat(createAgentEvent({
      inReplyTo: 'msg-1',
      metadata: {
        event: 'chat_task_failed',
        status: 'failed',
        error: 'tool timeout',
      },
    }));

    assert.strictEqual(result, true);
  });

  test('suppresses agent events without chat-relevant metadata', () => {
    const result = shouldDisplayAgentEventInChat(createAgentEvent({
      metadata: null,
    }));

    assert.strictEqual(result, false);
  });
});
