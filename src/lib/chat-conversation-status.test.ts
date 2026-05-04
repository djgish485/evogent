import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  doesChatTaskMatchConversation,
  getActiveChatTaskForConversation,
  getActiveChatTasks,
  getQueuedChatTasksForConversation,
  resolveConversationStatus,
} from './chat-conversation-status';
import type { ChatMessage } from '@/types/chat';
import type { OrchestratorStatusResponse, OrchestratorTaskStatus } from '@/lib/orchestrator';

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    type: 'chat',
    id: overrides.id ?? 'msg-1',
    role: overrides.role ?? 'user',
    inReplyTo: overrides.inReplyTo ?? null,
    sessionId: overrides.sessionId ?? 'session-1',
    text: overrides.text ?? 'hello',
    timestamp: overrides.timestamp ?? '2026-03-31T12:00:00.000Z',
    context: overrides.context ?? null,
    status: overrides.status ?? null,
    metadata: overrides.metadata ?? null,
    createdAt: overrides.createdAt ?? '2026-03-31T12:00:00.000Z',
  };
}

function createTask(overrides: Partial<OrchestratorTaskStatus> = {}): OrchestratorTaskStatus {
  return {
    id: overrides.id ?? 'task-1',
    source: overrides.source ?? 'user_chat',
    priority: overrides.priority ?? 'user_chat',
    chatMessageId: overrides.chatMessageId ?? 'msg-1',
    sessionId: overrides.sessionId ?? 'session-1',
    state: overrides.state ?? 'processing',
    enqueuedAt: overrides.enqueuedAt ?? '2026-03-31T12:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-03-31T12:00:01.000Z',
    sentAt: overrides.sentAt ?? null,
    completedAt: overrides.completedAt ?? null,
    error: overrides.error ?? null,
    paneTail: overrides.paneTail ?? null,
    logFile: overrides.logFile ?? null,
    messagePreview: overrides.messagePreview ?? 'Chat: test',
    responsePreview: overrides.responsePreview,
  };
}

function createStatus(overrides: Partial<OrchestratorStatusResponse> = {}): OrchestratorStatusResponse {
  return {
    sessionName: overrides.sessionName ?? 'evogent',
    queueDepth: overrides.queueDepth ?? 0,
    isProcessing: overrides.isProcessing ?? false,
    brain: overrides.brain ?? {
      sessionExists: true,
      working: true,
      paneTail: null,
      checkedAt: '2026-03-31T12:00:00.000Z',
    },
    currentTask: overrides.currentTask ?? null,
    activeChatTasks: overrides.activeChatTasks ?? [],
    queued: overrides.queued ?? [],
    history: overrides.history ?? [],
    updatedAt: overrides.updatedAt ?? '2026-03-31T12:00:00.000Z',
  };
}

describe('chat conversation status', () => {
  test('matches chat task by session id when present', () => {
    const messages = [createMessage()];
    assert.equal(
      doesChatTaskMatchConversation(createTask({ sessionId: 'session-1' }), 'session-1', messages),
      true,
    );
  });

  test('matches chat task by chat message id when session id is missing', () => {
    const messages = [createMessage({ id: 'msg-match', sessionId: 'session-1' })];
    assert.equal(
      doesChatTaskMatchConversation(createTask({ sessionId: null, chatMessageId: 'msg-match' }), 'session-1', messages),
      true,
    );
  });

  test('includes active chat tasks from currentTask and activeChatTasks without duplicates', () => {
    const shared = createTask({ id: 'task-shared' });
    const status = createStatus({
      currentTask: shared,
      activeChatTasks: [shared, createTask({ id: 'task-2', sessionId: 'session-2', chatMessageId: 'msg-2' })],
    });

    assert.deepEqual(
      getActiveChatTasks(status).map((task) => task.id).sort(),
      ['task-2', 'task-shared'],
    );
  });

  test('derives running from activeChatTasks when currentTask belongs to another session', () => {
    const messages = [createMessage({ id: 'msg-2', sessionId: 'session-2', status: 'queued' })];
    const active = createTask({ id: 'task-2', sessionId: 'session-2', chatMessageId: 'msg-2' });
    const status = createStatus({
      currentTask: createTask({ id: 'task-1', sessionId: 'session-1' }),
      activeChatTasks: [active],
    });

    assert.equal(getActiveChatTaskForConversation('session-2', messages, status)?.id, 'task-2');
    assert.equal(resolveConversationStatus('session-2', messages, status), 'running');
  });

  test('keeps same-session queued turns visible behind an active task', () => {
    const messages = [
      createMessage({ id: 'msg-active', sessionId: 'session-1', status: 'processing' }),
      createMessage({ id: 'msg-queued', sessionId: 'session-1', status: 'queued', timestamp: '2026-03-31T12:01:00.000Z', createdAt: '2026-03-31T12:01:00.000Z' }),
    ];
    const status = createStatus({
      activeChatTasks: [createTask({ id: 'task-active', sessionId: 'session-1', chatMessageId: 'msg-active' })],
      queued: [createTask({ id: 'task-queued', sessionId: 'session-1', chatMessageId: 'msg-queued', state: 'queued' })],
    });

    assert.equal(resolveConversationStatus('session-1', messages, status), 'running');
    assert.deepEqual(
      getQueuedChatTasksForConversation('session-1', messages, status).map((task) => task.id),
      ['task-queued'],
    );
  });

  test('falls back to persisted processing when orchestrator snapshot is missing', () => {
    const messages = [createMessage({ status: 'processing' })];
    assert.equal(resolveConversationStatus('session-1', messages, null), 'running');
  });
});
