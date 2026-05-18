import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  getChatMessagesPage,
  insertChatMessage,
  markChatMessageDelivered,
  normalizeAgentChatOutput,
  persistChatMessage,
} from './chat';
import {
  countChatSessions,
  createChatSession,
  deleteChatSession,
  getChatSession,
  getMostRecentCuratorChatSession,
  getConversationSessionPage,
  getConversationSessionSummary,
  getConversationSessions,
  resetChatSessionMessages,
  updateChatSession,
  updateChatSessionBrainSettings,
  updateChatSessionContextMetrics,
} from './chat-sessions';
import { getDb } from './client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('chat output normalization', () => {
  test('normalizeAgentChatOutput parses valid agent payload', () => {
    const result = normalizeAgentChatOutput({
      type: 'chat',
      id: 'chat-1',
      inReplyTo: 'msg-1',
      taskId: 'task-1',
      text: 'hello',
      timestamp: '2026-03-01T12:00:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result?.role, 'agent');
    assert.strictEqual(result?.status, 'delivered');
    assert.strictEqual(result?.id, 'chat-1');
    assert.strictEqual(result?.inReplyTo, 'msg-1');
  });

  test('normalizeAgentChatOutput ignores provided timestamps and uses now', () => {
    const before = Date.now();
    const stale = new Date(before - 10 * 60 * 1000).toISOString();

    const result = normalizeAgentChatOutput({
      type: 'chat',
      taskId: 'task-timestamp',
      text: 'timestamp payload',
      timestamp: stale,
    });

    assert.ok(result?.timestamp);
    const normalizedTs = new Date(result.timestamp).getTime();
    const after = Date.now();

    assert.notStrictEqual(result.timestamp, stale);
    assert.ok(normalizedTs >= before);
    assert.ok(normalizedTs <= after);
  });

  test('normalizeAgentChatOutput defaults missing timestamp to now', () => {
    const before = Date.now();

    const result = normalizeAgentChatOutput({
      type: 'chat',
      taskId: 'task-no-timestamp',
      text: 'no timestamp payload',
    });

    assert.ok(result?.timestamp);
    const normalizedTs = new Date(result.timestamp).getTime();
    const after = Date.now();

    assert.ok(normalizedTs >= before);
    assert.ok(normalizedTs <= after);
  });

  test('normalizeAgentChatOutput rejects malformed payload', () => {
    const result = normalizeAgentChatOutput({
      type: 'analysis',
      text: 'wrong type',
    });

    assert.strictEqual(result, null);
  });

  test('normalizeAgentChatOutput returns null for empty text', () => {
    const result = normalizeAgentChatOutput({
      type: 'chat',
      taskId: 'task-empty',
      text: '   ',
    });

    assert.strictEqual(result, null);
  });

  test('normalizeAgentChatOutput returns null when type is missing', () => {
    const result = normalizeAgentChatOutput({
      text: 'hello without type',
    });

    assert.strictEqual(result, null);
  });

  test('normalizeAgentChatOutput ignores legacy suggestions arrays', () => {
    const result = normalizeAgentChatOutput({
      type: 'chat',
      taskId: 'task-suggestions',
      text: 'Suggestion payload',
      suggestions: [
        {
          type: 'legacy-suggestion',
          description: 'Enable more geopolitical analysis',
          diff: '--- a/data/config.md\n+++ b/data/config.md',
        },
      ],
    });

    assert.ok(result);
    assert.ok(!('suggestions' in (result ?? {})));
  });

  test('normalizeAgentChatOutput normalizes escaped formatting in agent replies', () => {
    const result = normalizeAgentChatOutput({
      type: 'chat',
      taskId: 'task-formatting',
      text: '## Plan\\n- Inspect importer\\n- Patch renderer',
    });

    assert.ok(result);
    assert.strictEqual(result?.text, '## Plan\n- Inspect importer\n- Patch renderer');
  });

  test('normalizeAgentChatOutput normalizes escaped label-block agent replies', () => {
    const result = normalizeAgentChatOutput({
      type: 'chat',
      taskId: 'task-label-formatting',
      text: 'Review clean overall.\\nRequest fit: matches the task.\\nPhilosophy fit: no runtime workaround.\\nUnintended revert risk: none found.',
    });

    assert.ok(result);
    assert.strictEqual(
      result?.text,
      'Review clean overall.\nRequest fit: matches the task.\nPhilosophy fit: no runtime workaround.\nUnintended revert risk: none found.',
    );
  });

  test('normalizeAgentChatOutput suppresses routine operational agent_event payloads', () => {
    const result = normalizeAgentChatOutput({
      type: 'agent_event',
      id: 'event-curation-finished-1',
      role: 'assistant',
      text: 'Curation cycle complete.',
      timestamp: '2026-03-01T13:00:00.000Z',
      metadata: {
        agentId: 'curation-abc123',
        event: 'curation_finished',
        status: 'completed',
        hasTranscript: true,
      },
    });

    assert.strictEqual(result, null);
  });

  test('normalizeAgentChatOutput keeps actionable or failed agent_event payloads', () => {
    const result = normalizeAgentChatOutput({
      type: 'agent_event',
      id: 'event-chat-failed-1',
      role: 'assistant',
      text: 'Message could not be delivered. Please try again.',
      timestamp: '2026-03-01T13:00:00.000Z',
      inReplyTo: 'msg-1',
      metadata: {
        event: 'chat_task_failed',
        status: 'failed',
        error: 'tool timeout',
      },
    });

    assert.ok(result);
    assert.strictEqual(result?.type, 'agent_event');
    assert.strictEqual(result?.id, 'event-chat-failed-1');
    assert.strictEqual(result?.metadata?.event, 'chat_task_failed');
    assert.strictEqual(result?.metadata?.source, 'chat-output.jsonl');
  });

  test('normalizeAgentChatOutput rejects chat payloads without a taskId', () => {
    const result = normalizeAgentChatOutput({
      type: 'chat',
      inReplyTo: 'msg-1',
      text: 'hello',
    });

    assert.strictEqual(result, null);
  });

  test('normalizeAgentChatOutput rejects chat-output audit records so they are not replayed', () => {
    const result = normalizeAgentChatOutput({
      type: 'chat',
      id: 'chat-audit-replay',
      inReplyTo: 'msg-1',
      taskId: 'task-audit-replay',
      sessionId: '00000000-0000-4000-8000-000000000077',
      text: 'already persisted audit line',
      metadata: {
        taskId: 'task-audit-replay',
        source: 'chat-output.jsonl',
      },
    });

    assert.strictEqual(result, null);
  });
});

describe('chat status updates', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('markChatMessageDelivered updates pending, queued, and processing messages', () => {
    insertChatMessage({
      id: 'msg-pending',
      role: 'user',
      text: 'pending',
      status: 'pending',
    });

    insertChatMessage({
      id: 'msg-queued',
      role: 'user',
      text: 'queued',
      status: 'queued',
    });

    insertChatMessage({
      id: 'msg-processing',
      role: 'user',
      text: 'processing',
      status: 'processing',
    });

    assert.strictEqual(markChatMessageDelivered('msg-pending'), true);
    assert.strictEqual(markChatMessageDelivered('msg-queued'), true);
    assert.strictEqual(markChatMessageDelivered('msg-processing'), true);

    const db = getDb();
    const rows = db.prepare(`
      SELECT id, status
      FROM chat_messages
      WHERE id IN ('msg-pending', 'msg-processing', 'msg-queued')
      ORDER BY id
    `).all() as Array<{ id: string; status: string | null }>;

    assert.deepStrictEqual(rows, [
      { id: 'msg-pending', status: 'delivered' },
      { id: 'msg-processing', status: 'delivered' },
      { id: 'msg-queued', status: 'delivered' },
    ]);
  });

  test('persistChatMessage persists standalone agent chat replies with no user message', () => {
    const result = persistChatMessage({
      id: 'chat-agent-orphan',
      role: 'agent',
      type: 'chat',
      sessionId: '00000000-0000-4000-8000-000000000077',
      taskId: 'task-agent-orphan',
      text: 'orphan reply',
      status: 'delivered',
    });

    assert.ok(result);
    assert.strictEqual(result?.message.id, 'chat-agent-orphan');
    assert.strictEqual(result?.message.role, 'agent');
    assert.strictEqual(result?.message.sessionId, '00000000-0000-4000-8000-000000000077');

    const db = getDb();
    const messageCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_messages
    `).get() as { count: number };
    const sessionCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_sessions
      WHERE id = '00000000-0000-4000-8000-000000000077'
    `).get() as { count: number };

    assert.strictEqual(messageCount.count, 1);
    assert.strictEqual(sessionCount.count, 1);
  });

  test('markChatMessageDelivered does not override non-queued statuses', () => {
    insertChatMessage({
      id: 'msg-failed',
      role: 'user',
      text: 'failed',
      status: 'failed',
    });

    assert.strictEqual(markChatMessageDelivered('msg-failed'), false);

    const db = getDb();
    const row = db.prepare(`
      SELECT status
      FROM chat_messages
      WHERE id = 'msg-failed'
    `).get() as { status: string | null } | undefined;

    assert.ok(row);
    assert.strictEqual(row?.status, 'failed');
  });
});

describe('chat message persistence normalization', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-persist-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('insertChatMessage stores agent replies with consistent newline formatting', () => {
    const formattedReply = '## Plan\n- Inspect importer\n- Patch renderer';
    const literalBackslashReply = 'Use \\n when documenting JSON strings or paths like C:\\new\\notes.';
    const user = insertChatMessage({
      id: 'msg-format-parent',
      role: 'user',
      text: 'formatting question',
      status: 'delivered',
    });
    assert.ok(user);

    const escaped = insertChatMessage({
      id: 'chat-escaped',
      role: 'agent',
      inReplyTo: user.id,
      text: '## Plan\\n- Inspect importer\\n- Patch renderer',
      status: 'delivered',
    });
    const real = insertChatMessage({
      id: 'chat-real',
      role: 'agent',
      inReplyTo: user.id,
      text: formattedReply,
      status: 'delivered',
    });
    const literal = insertChatMessage({
      id: 'chat-literal',
      role: 'agent',
      inReplyTo: user.id,
      text: literalBackslashReply,
      status: 'delivered',
    });

    assert.strictEqual(escaped?.text, formattedReply);
    assert.strictEqual(real?.text, formattedReply);
    assert.strictEqual(literal?.text, literalBackslashReply);

    const db = getDb();
    const rows = db.prepare(`
      SELECT id, text
      FROM chat_messages
      WHERE id IN ('chat-escaped', 'chat-real', 'chat-literal')
      ORDER BY id
    `).all() as Array<{ id: string; text: string }>;

    assert.deepStrictEqual(rows, [
      { id: 'chat-escaped', text: formattedReply },
      { id: 'chat-literal', text: literalBackslashReply },
      { id: 'chat-real', text: formattedReply },
    ]);
  });

  test('chat reads and session previews normalize legacy escaped agent replies', () => {
    const session = createChatSession({ title: 'Legacy' });
    const legacyReply = '## Plan\\n- Inspect importer\\n- Patch renderer';
    const normalizedReply = '## Plan\n- Inspect importer\n- Patch renderer';
    const legacyLabelReply = 'Review clean overall.\\nRequest fit: matches the task.\\nPhilosophy fit: no runtime workaround.\\nUnintended revert risk: none found.';
    const normalizedLabelReply = 'Review clean overall.\nRequest fit: matches the task.\nPhilosophy fit: no runtime workaround.\nUnintended revert risk: none found.';
    const db = getDb();

    db.prepare(`
      INSERT INTO chat_messages (
        id, type, role, in_reply_to, session_id, text, timestamp, context, suggestions, status, metadata
      ) VALUES (
        @id, 'chat', 'agent', NULL, @sessionId, @text, @timestamp, NULL, NULL, 'delivered', NULL
      )
    `).run({
      id: 'chat-legacy',
      sessionId: session.id,
      text: legacyReply,
      timestamp: '2026-03-01T10:00:00.000Z',
    });
    db.prepare(`
      INSERT INTO chat_messages (
        id, type, role, in_reply_to, session_id, text, timestamp, context, suggestions, status, metadata
      ) VALUES (
        @id, 'chat', 'agent', NULL, @sessionId, @text, @timestamp, NULL, NULL, 'delivered', NULL
      )
    `).run({
      id: 'chat-legacy-labels',
      sessionId: session.id,
      text: legacyLabelReply,
      timestamp: '2026-03-01T10:01:00.000Z',
    });

    const page = getChatMessagesPage({ sessionId: session.id });
    assert.strictEqual(page.items[0]?.text, normalizedReply);
    assert.strictEqual(page.items[1]?.text, normalizedLabelReply);

    const summary = getConversationSessionSummary(session.id);
    assert.strictEqual(summary?.previewMessages.at(-1)?.text, normalizedLabelReply);
    assert.strictEqual(summary?.previewText, 'Review clean overall. Request fit: matches the task. Philosophy fit: no runtime workaround. Unintended revert risk: none found.');
  });

  test('persistChatMessage treats duplicate agent replies for the same task and reply target as idempotent', () => {
    insertChatMessage({
      id: 'msg-user-parent',
      role: 'user',
      text: 'Question',
      sessionId: 'session-dup',
      status: 'queued',
    });

    const first = persistChatMessage({
      id: 'chat-first',
      role: 'agent',
      type: 'chat',
      inReplyTo: 'msg-user-parent',
      taskId: 'task-dup',
      sessionId: 'session-dup',
      text: 'First answer',
      status: 'delivered',
      metadata: {
        taskId: 'task-dup',
      },
    }, { ignoreConflicts: true });

    const second = persistChatMessage({
      id: 'chat-second',
      role: 'agent',
      type: 'chat',
      inReplyTo: 'msg-user-parent',
      taskId: 'task-dup',
      sessionId: 'session-dup',
      text: 'Second answer',
      status: 'delivered',
      metadata: {
        taskId: 'task-dup',
      },
    }, { ignoreConflicts: true });

    assert.ok(first);
    assert.ok(second);
    assert.strictEqual(first?.inserted, true);
    assert.strictEqual(second?.inserted, false);
    assert.strictEqual(first?.message.id, 'chat-first');
    assert.strictEqual(second?.message.id, 'chat-first');

    const db = getDb();
    const rows = db.prepare(`
      SELECT id, task_id AS taskId, in_reply_to AS inReplyTo, text
      FROM chat_messages
      WHERE task_id = 'task-dup'
    `).all() as Array<{ id: string; taskId: string | null; inReplyTo: string | null; text: string }>;

    assert.deepStrictEqual(rows, [
      { id: 'chat-first', taskId: 'task-dup', inReplyTo: 'msg-user-parent', text: 'First answer' },
    ]);
  });
});

describe('user chat queries', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-query-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

});

describe('chat sessions', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-session-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('resetChatSessionMessages clears messages and keeps the session', () => {
    const session = createChatSession();

    insertChatMessage({
      id: 'msg-reset-target',
      role: 'user',
      sessionId: session.id,
      text: 'reset me',
      status: 'delivered',
    });

    const reset = resetChatSessionMessages(session.id);
    assert.ok(reset);
    assert.strictEqual(reset?.id, session.id);
    assert.notStrictEqual(reset?.claudeSessionId, session.claudeSessionId);

    const db = getDb();
    const remainingMessages = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_messages
      WHERE session_id = ?
    `).get(session.id) as { count: number };

    assert.strictEqual(remainingMessages.count, 0);

    const sessions = getConversationSessions();
    const summary = sessions.find((entry) => entry.sessionId === session.id);
    assert.ok(summary);
    assert.strictEqual(summary?.title, 'General Agent');
    assert.strictEqual(summary?.messageCount, 0);
  });

  test('createChatSession persists provided titles and fallback titles', () => {
    const firstSession = createChatSession();
    const secondSession = createChatSession({
      title: 'Night Notes',
      color: 'rose',
      workingDirectory: '/root/other-project',
    });
    const thirdSession = createChatSession();

    assert.strictEqual(firstSession.title, 'General Agent');
    assert.strictEqual(secondSession.title, 'Night Notes');
    assert.strictEqual(secondSession.color, 'rose');
    assert.strictEqual(secondSession.workingDirectory, '/root/other-project');
    assert.strictEqual(thirdSession.title, 'Nova');
    assert.strictEqual(getChatSession(secondSession.id)?.title, 'Night Notes');
    assert.strictEqual(getChatSession(secondSession.id)?.color, 'rose');
    assert.strictEqual(getChatSession(secondSession.id)?.workingDirectory, '/root/other-project');

    const sessions = getConversationSessions();
    assert.strictEqual(sessions.find((entry) => entry.sessionId === firstSession.id)?.title, 'General Agent');
    assert.strictEqual(sessions.find((entry) => entry.sessionId === secondSession.id)?.title, 'Night Notes');
    assert.strictEqual(sessions.find((entry) => entry.sessionId === secondSession.id)?.color, 'rose');
    assert.strictEqual(sessions.find((entry) => entry.sessionId === secondSession.id)?.workingDirectory, '/root/other-project');
    assert.strictEqual(sessions.find((entry) => entry.sessionId === thirdSession.id)?.title, 'Nova');
    assert.strictEqual(sessions.find((entry) => entry.sessionId === firstSession.id)?.workingDirectory, process.cwd());
  });

  test('chat session codex reasoning persists across summaries and resets', () => {
    const session = createChatSession({
      provider: 'codex',
      codexReasoningEffort: 'medium',
      codexFastMode: true,
      title: 'Codex Medium',
    });

    assert.strictEqual(session.codexReasoningEffort, 'medium');
    assert.strictEqual(session.codexFastMode, true);
    assert.strictEqual(getChatSession(session.id)?.codexReasoningEffort, 'medium');
    assert.strictEqual(getChatSession(session.id)?.codexFastMode, true);
    assert.strictEqual(getConversationSessionSummary(session.id)?.codexReasoningEffort, 'medium');
    assert.strictEqual(getConversationSessionSummary(session.id)?.codexFastMode, true);

    const updated = updateChatSessionBrainSettings({
      sessionId: session.id,
      codexReasoningEffort: 'xhigh',
      codexFastMode: false,
    });
    assert.strictEqual(updated?.codexReasoningEffort, 'xhigh');
    assert.strictEqual(updated?.codexFastMode, false);
    assert.strictEqual(getConversationSessionSummary(session.id)?.codexReasoningEffort, 'xhigh');
    assert.strictEqual(getConversationSessionSummary(session.id)?.codexFastMode, false);

    const reset = resetChatSessionMessages(session.id);
    assert.strictEqual(reset?.codexReasoningEffort, 'xhigh');
    assert.strictEqual(reset?.codexFastMode, false);
    assert.strictEqual(getChatSession(session.id)?.codexReasoningEffort, 'xhigh');
    assert.strictEqual(getChatSession(session.id)?.codexFastMode, false);
  });

  test('chat session Claude reasoning persists across summaries and resets', () => {
    const session = createChatSession({
      provider: 'claude',
      claudeReasoningEffort: 'max',
      title: 'Claude Max',
    });

    assert.strictEqual(session.claudeReasoningEffort, 'max');
    assert.strictEqual(getChatSession(session.id)?.claudeReasoningEffort, 'max');
    assert.strictEqual(getConversationSessionSummary(session.id)?.claudeReasoningEffort, 'max');

    const updated = updateChatSessionBrainSettings({
      sessionId: session.id,
      claudeReasoningEffort: 'medium',
    });
    assert.strictEqual(updated?.claudeReasoningEffort, 'medium');
    assert.strictEqual(getConversationSessionSummary(session.id)?.claudeReasoningEffort, 'medium');

    const reset = resetChatSessionMessages(session.id);
    assert.strictEqual(reset?.claudeReasoningEffort, 'medium');
    assert.strictEqual(getChatSession(session.id)?.claudeReasoningEffort, 'medium');
  });

  test('chat session metadata updates persist across record and summary reads', () => {
    const session = createChatSession({
      title: 'Scratchpad',
      color: 'blue',
      workingDirectory: '/root/evogent',
    });

    const updated = updateChatSession({
      sessionId: session.id,
      title: 'Release Notes',
      color: 'amber',
      workingDirectory: '/root/evogent/docs',
      updateTitle: true,
      updateColor: true,
      updateWorkingDirectory: true,
    });

    assert.strictEqual(updated?.title, 'Release Notes');
    assert.strictEqual(updated?.color, 'amber');
    assert.strictEqual(updated?.workingDirectory, '/root/evogent/docs');
    assert.strictEqual(getChatSession(session.id)?.title, 'Release Notes');
    assert.strictEqual(getConversationSessionSummary(session.id)?.color, 'amber');
    assert.strictEqual(getConversationSessionSummary(session.id)?.workingDirectory, '/root/evogent/docs');
  });

  test('chat session context metrics persist across record and summary reads and reset with the session', () => {
    const session = createChatSession({
      provider: 'claude',
      title: 'Long Session',
    });

    const updated = updateChatSessionContextMetrics({
      sessionId: session.id,
      latestContextTokens: 564_000,
      latestContextWindow: 1_000_000,
      latestContextModel: 'claude-opus-4-7[1m]',
      latestContextUpdatedAt: '2026-04-19T12:00:00.000Z',
    });

    assert.strictEqual(updated?.latestContextTokens, 564_000);
    assert.strictEqual(updated?.latestContextWindow, 1_000_000);
    assert.strictEqual(updated?.latestContextModel, 'claude-opus-4-7[1m]');
    assert.strictEqual(getConversationSessionSummary(session.id)?.latestContextTokens, 564_000);
    assert.strictEqual(getConversationSessionSummary(session.id)?.latestContextWindow, 1_000_000);

    const reset = resetChatSessionMessages(session.id);
    assert.strictEqual(reset?.latestContextTokens, null);
    assert.strictEqual(reset?.latestContextWindow, null);
    assert.strictEqual(reset?.latestContextModel, null);
    assert.strictEqual(getChatSession(session.id)?.latestContextTokens, null);
  });

  test('conversation session pages use persisted totals instead of the loaded message subset', () => {
    const oldestSession = createChatSession({ title: 'Oldest' });
    const middleSession = createChatSession({ title: 'Middle' });
    const newestSession = createChatSession({ title: 'Newest' });
    const db = getDb();

    insertChatMessage({
      id: 'msg-oldest-user',
      role: 'user',
      sessionId: oldestSession.id,
      text: 'oldest question',
      timestamp: '2026-03-01T10:00:00.000Z',
      status: 'delivered',
    });
    insertChatMessage({
      id: 'msg-oldest-agent',
      role: 'agent',
      sessionId: oldestSession.id,
      text: 'oldest answer',
      timestamp: '2026-03-01T10:01:00.000Z',
      status: 'delivered',
    });
    insertChatMessage({
      id: 'msg-middle-user',
      role: 'user',
      sessionId: middleSession.id,
      text: 'middle question',
      timestamp: '2026-03-02T10:00:00.000Z',
      status: 'delivered',
    });
    insertChatMessage({
      id: 'msg-newest-user',
      role: 'user',
      sessionId: newestSession.id,
      text: 'newest question',
      timestamp: '2026-03-03T10:00:00.000Z',
      status: 'delivered',
    });

    db.prepare(`
      INSERT INTO feed (id, type, source, origin_session_id, text, published_at)
      VALUES ('feed-middle-1', 'analysis', 'unit-test', ?, 'middle result', '2026-03-02T10:05:00.000Z')
    `).run(middleSession.id);

    const firstPage = getConversationSessionPage({ limit: 2, offset: 0 });
    assert.strictEqual(firstPage.count, 2);
    assert.strictEqual(firstPage.totalCount, 3);
    assert.strictEqual(firstPage.hasMore, true);
    assert.strictEqual(firstPage.nextOffset, 2);
    assert.deepStrictEqual(firstPage.sessions.map((session) => session.sessionId), [
      newestSession.id,
      middleSession.id,
    ]);

    const middleSummary = getConversationSessionSummary(middleSession.id);
    assert.ok(middleSummary);
    assert.strictEqual(middleSummary?.messageCount, 1);
    assert.strictEqual(middleSummary?.feedItemCount, 1);
    assert.strictEqual(middleSummary?.previewText, 'middle question');
    assert.strictEqual(middleSummary?.lastActor, 'user');

    const secondPage = getConversationSessionPage({ limit: 2, offset: 2 });
    assert.strictEqual(secondPage.count, 1);
    assert.strictEqual(secondPage.hasMore, false);
    assert.strictEqual(secondPage.sessions[0]?.sessionId, oldestSession.id);
    assert.strictEqual(secondPage.sessions[0]?.messageCount, 2);
    assert.strictEqual(secondPage.sessions[0]?.previewText, 'oldest answer');
  });

  test('conversation session pages exclude OpenClaw-backed session rows', () => {
    const nativeSession = createChatSession({ title: 'Native Chat' });
    const openClawSessionId = 'openclaw:agent:curator:main';
    const db = getDb();

    db.prepare(`
      INSERT INTO chat_sessions (
        id,
        provider,
        provider_session_id,
        claude_session_id,
        title,
        session_type,
        created_at,
        updated_at
      ) VALUES (?, 'claude', ?, ?, 'OpenClaw Curator', 'curator', '2026-05-18 10:00:00', '2026-05-18 10:00:00')
    `).run(openClawSessionId, openClawSessionId, openClawSessionId);

    insertChatMessage({
      id: 'msg-native-user',
      role: 'user',
      sessionId: nativeSession.id,
      text: 'native question',
      timestamp: '2026-05-18T10:01:00.000Z',
      status: 'delivered',
    });
    insertChatMessage({
      id: 'msg-openclaw-user',
      role: 'user',
      sessionId: openClawSessionId,
      text: 'openclaw question',
      timestamp: '2026-05-18T10:02:00.000Z',
      status: 'delivered',
    });

    const page = getConversationSessionPage({ limit: 10, offset: 0 });
    assert.strictEqual(page.totalCount, 1);
    assert.deepStrictEqual(page.sessions.map((session) => session.sessionId), [nativeSession.id]);
    assert.strictEqual(getConversationSessionSummary(openClawSessionId), null);
  });

  test('deleteChatSession removes the session row and its messages', () => {
    const firstSession = createChatSession();
    const secondSession = createChatSession();

    insertChatMessage({
      id: 'msg-delete-target',
      role: 'user',
      sessionId: secondSession.id,
      text: 'delete me',
      status: 'delivered',
    });

    assert.strictEqual(countChatSessions(), 2);
    assert.strictEqual(deleteChatSession(secondSession.id), true);
    assert.strictEqual(countChatSessions(), 1);

    const db = getDb();
    const remainingMessages = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_messages
      WHERE session_id = ?
    `).get(secondSession.id) as { count: number };

    assert.strictEqual(remainingMessages.count, 0);
    assert.ok(getConversationSessions().every((entry) => entry.sessionId !== secondSession.id));
    assert.ok(getConversationSessions().some((entry) => entry.sessionId === firstSession.id));
  });

  test('legacy agent-only orphan sessions are hidden without mutating session rows on read', () => {
    const activeCurator = createChatSession({
      title: 'Active Curator',
      sessionType: 'curator',
    });
    const orphanSessionId = '00000000-0000-4000-8000-000000000068';
    const db = getDb();

    db.prepare(`
      INSERT INTO chat_sessions (
        id,
        provider,
        provider_session_id,
        claude_session_id,
        title,
        session_type,
        created_at,
        updated_at
      ) VALUES (?, 'claude', ?, ?, 'Session 68', 'curator', '2026-04-23 17:31:39', '2026-04-23 17:31:39')
    `).run(orphanSessionId, orphanSessionId, orphanSessionId);
    db.prepare(`
      INSERT INTO chat_messages (
        id, type, role, in_reply_to, task_id, session_id, text, timestamp, context, suggestions, status, metadata
      ) VALUES (
        'chat-orphan-68', 'chat', 'agent', NULL, 'task-orphan-68', ?, 'Shipped 1 tweet.', '2026-04-23T17:31:39.000Z', NULL, NULL, 'delivered', NULL
      )
    `).run(orphanSessionId);

    const mostRecentCurator = getMostRecentCuratorChatSession();
    assert.strictEqual(mostRecentCurator?.id, activeCurator.id);

    const orphanRow = db.prepare(`
      SELECT session_type
      FROM chat_sessions
      WHERE id = ?
    `).get(orphanSessionId) as { session_type: string | null } | undefined;
    assert.strictEqual(orphanRow?.session_type, 'curator');

    assert.ok(getConversationSessions().every((entry) => entry.sessionId !== orphanSessionId));
    assert.strictEqual(getConversationSessionSummary(orphanSessionId), null);
    assert.ok(getChatMessagesPage().items.every((message) => message.sessionId !== orphanSessionId));
    assert.strictEqual(getChatMessagesPage({ sessionId: orphanSessionId }).totalCount, 0);
  });
});
