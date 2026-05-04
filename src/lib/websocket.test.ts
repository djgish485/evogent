import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import WebSocket from 'ws';
import { insertChatMessage } from '@/lib/db/chat';
import { createChatSession } from '@/lib/db/chat-sessions';
import {
  cleanupValidationFixtures,
  createValidationOriginSessionId,
  getIntegrationTestBaseUrl,
  getIntegrationTestWsBaseUrl,
} from '../../test/integration-fixture-helpers';

const INTEGRATION_SKIP_REASON = process.env.TEST_SERVER_URL
  && (process.env.TEST_SERVER_DATA_DIR || process.env.DATA_DIR)
  ? undefined
  : 'requires TEST_SERVER_URL plus TEST_SERVER_DATA_DIR or DATA_DIR for an isolated validation server';
const HTTP_BASE_URL = INTEGRATION_SKIP_REASON ? 'http://127.0.0.1' : getIntegrationTestBaseUrl();
const WS_BASE_URL = INTEGRATION_SKIP_REASON ? 'ws://127.0.0.1' : getIntegrationTestWsBaseUrl();

type WsPayload = Record<string, unknown>;

function connectWebSocket(pathname: string, timeoutMs = 5_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE_URL}${pathname}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out connecting to ${pathname}`));
    }, timeoutMs);

    const onOpen = () => {
      clearTimeout(timer);
      ws.off('error', onError);
      resolve(ws);
    };

    const onError = (error: Error) => {
      clearTimeout(timer);
      ws.off('open', onOpen);
      reject(error);
    };

    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

function closeWebSocket(ws: WebSocket, timeoutMs = 3_000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, timeoutMs);

    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });

    ws.close();
  });
}

function connectAndWaitForJsonMessage(
  pathname: string,
  predicate: (payload: WsPayload) => boolean,
  timeoutMs = 5_000,
): Promise<{ ws: WebSocket; payload: WsPayload }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE_URL}${pathname}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out waiting for initial message on ${pathname}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (rawData: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }

      const payload = parsed as WsPayload;
      if (!predicate(payload)) {
        return;
      }

      cleanup();
      resolve({ ws, payload });
    };

    ws.on('message', onMessage);
    ws.once('error', onError);
  });
}

function waitForJsonMessage(
  ws: WebSocket,
  predicate: (payload: WsPayload) => boolean,
  timeoutMs = 5_000,
): Promise<WsPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket message'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };

    const onMessage = (rawData: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }

      const payload = parsed as WsPayload;
      if (!predicate(payload)) {
        return;
      }

      cleanup();
      resolve(payload);
    };

    ws.on('message', onMessage);
  });
}

async function fetchWsStatus(): Promise<Record<string, unknown>> {
  const response = await fetch(`${HTTP_BASE_URL}/api/internal/ws-status`, { cache: 'no-store' });
  assert.strictEqual(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  return body;
}

async function waitForClientCount(
  predicate: (status: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const status = await fetchWsStatus();
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Timed out waiting for ws-status client counts');
}

describe('WebSocket Channel Tests', { concurrency: false, skip: INTEGRATION_SKIP_REASON }, () => {
  test('Connect to /ws/feed succeeds', async (t) => {
    const ws = await connectWebSocket('/ws/feed');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    assert.strictEqual(ws.readyState, WebSocket.OPEN);
  });

  test('Connect to /ws/chat receives chat_status trigger=connected', async (t) => {
    const { ws, payload } = await connectAndWaitForJsonMessage(
      '/ws/chat',
      (message) => message.type === 'chat_status' && message.trigger === 'connected',
    );
    t.after(async () => {
      await closeWebSocket(ws);
    });

    assert.strictEqual(payload.type, 'chat_status');
    assert.strictEqual(payload.trigger, 'connected');
  });

  test('Connect to /ws/orchestrator receives immediate orchestrator_status push', async (t) => {
    const { ws, payload } = await connectAndWaitForJsonMessage(
      '/ws/orchestrator',
      (message) => message.type === 'orchestrator_status',
    );
    t.after(async () => {
      await closeWebSocket(ws);
    });

    assert.strictEqual(payload.type, 'orchestrator_status');
    assert.ok(payload.status && typeof payload.status === 'object');
  });

  test('Connect to /ws/agent-progress succeeds', async (t) => {
    const ws = await connectWebSocket('/ws/agent-progress');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    assert.strictEqual(ws.readyState, WebSocket.OPEN);
  });

  test('All 4 channels connected simultaneously works', async (t) => {
    const sockets = await Promise.all([
      connectWebSocket('/ws/feed'),
      connectWebSocket('/ws/chat'),
      connectWebSocket('/ws/orchestrator'),
      connectWebSocket('/ws/agent-progress'),
    ]);

    t.after(async () => {
      await Promise.all(sockets.map((socket) => closeWebSocket(socket)));
    });

    assert.strictEqual(sockets.length, 4);
    sockets.forEach((socket) => {
      assert.strictEqual(socket.readyState, WebSocket.OPEN);
    });
  });

  test('code-fix orchestration broadcasts batch progress on /ws/agent-progress', async (t) => {
    const suggestionId = `ws-code-fix-${randomUUID()}`;
    const sourceId = `ws-code-fix-source-${randomUUID()}`;
    const proposedValue = 'Add src/app/api/ws-audit/route.ts for websocket audit status.';
    const originSessionId = createValidationOriginSessionId('ws-code-fix');

    t.after(async () => {
      await cleanupValidationFixtures({
        ids: [suggestionId],
        sourceIds: [sourceId],
        originSessionIds: [originSessionId],
      }, HTTP_BASE_URL);
    });

    const submitResponse = await fetch(`${HTTP_BASE_URL}/api/internal/curate/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originSessionId,
        items: [{
          id: suggestionId,
          type: 'suggestion',
          source: 'claude',
          sourceId,
          title: 'Add websocket audit endpoint',
          text: 'Create an API route for websocket audit status.',
          publishedAt: new Date().toISOString(),
          metadata: {
            suggestionType: 'code_fix',
            proposedValue,
          },
        }],
      }),
    });
    assert.strictEqual(submitResponse.status, 200);

    const { ws } = await connectAndWaitForJsonMessage(
      '/ws/agent-progress',
      (message) => message.type === 'agent_progress' && message.trigger === 'connected',
    );
    t.after(async () => {
      await closeWebSocket(ws);
    });

    const pendingEvent = waitForJsonMessage(
      ws,
      (payload) => {
        const event = payload.event as Record<string, unknown> | null;
        return payload.type === 'agent_progress'
          && payload.trigger === 'code_fix_orchestrator'
          && event?.event === 'code_fix_orchestrator_batch_dispatched'
          && Array.isArray(event.suggestionIds)
          && event.suggestionIds.includes(suggestionId);
      },
    );

    const applyResponse = await fetch(`${HTTP_BASE_URL}/api/suggestions/batch-accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        suggestionIds: [suggestionId],
      }),
    });
    assert.strictEqual(applyResponse.status, 200);
    const applyBody = await applyResponse.json() as Record<string, unknown>;
    assert.strictEqual(typeof applyBody.taskId, 'string');

    const progressEvent = await pendingEvent;
    const event = progressEvent.event as Record<string, unknown>;
    assert.strictEqual(event.event, 'code_fix_orchestrator_batch_dispatched');
    assert.strictEqual(event.taskId, applyBody.taskId);

    const lifecycleResponse = await fetch(`${HTTP_BASE_URL}/api/internal/code-fix-orchestrator/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: applyBody.taskId,
        status: 'merged',
      }),
    });
    assert.strictEqual(lifecycleResponse.status, 200);
  });

  test('POST /api/internal/curate/submit broadcasts code-fix chat suggestions on /ws/chat', async (t) => {
    const session = createChatSession();
    const ws = await connectWebSocket('/ws/chat');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    const suggestionId = `ws-chat-suggestion-${randomUUID()}`;
    const sourceId = `ws-chat-suggestion-source-${randomUUID()}`;
    t.after(async () => {
      await cleanupValidationFixtures({
        ids: [suggestionId],
        sourceIds: [sourceId],
        originSessionIds: [session.id],
      }, HTTP_BASE_URL);
    });

    const messagePromise = waitForJsonMessage(
      ws,
      (payload) => {
        const suggestion = payload.suggestion as Record<string, unknown> | undefined;
        return payload.type === 'chat_suggestion'
          && payload.originSessionId === session.id
          && suggestion?.id === suggestionId;
      },
    );

    const response = await fetch(`${HTTP_BASE_URL}/api/internal/curate/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originSessionId: session.id,
        items: [{
          id: suggestionId,
          type: 'suggestion',
          source: 'claude',
          sourceId,
          title: 'Add inline chat code fix card',
          text: 'Render code fix approvals inline in chat. Keep the summary short for the compact card.',
          publishedAt: new Date().toISOString(),
          metadata: {
            suggestionType: 'code_fix',
            proposedValue: 'Broadcast code_fix suggestions with originSessionId to chat and render inline approval cards.',
          },
        }],
      }),
    });
    assert.strictEqual(response.status, 200);

    const payload = await messagePromise;
    const suggestion = payload.suggestion as Record<string, unknown>;
    assert.strictEqual(payload.type, 'chat_suggestion');
    assert.strictEqual(payload.originSessionId, session.id);
    assert.strictEqual(payload.sessionId, session.id);
    assert.strictEqual(suggestion.id, suggestionId);
    assert.strictEqual(suggestion.title, 'Add inline chat code fix card');
    assert.strictEqual(suggestion.summary, 'Render code fix approvals inline in chat.');
    assert.strictEqual(suggestion.suggestionType, 'code_fix');
  });

  test('After connecting, /api/internal/ws-status reflects connected clients', async (t) => {
    const before = await fetchWsStatus();
    const beforeFeed = Number(before.feedClients ?? 0);
    const beforeChat = Number(before.chatClients ?? 0);
    const beforeOrchestrator = Number(before.orchestratorClients ?? 0);
    const beforeAgentProgress = Number(before.agentProgressClients ?? 0);

    const sockets = await Promise.all([
      connectWebSocket('/ws/feed'),
      connectWebSocket('/ws/chat'),
      connectWebSocket('/ws/orchestrator'),
      connectWebSocket('/ws/agent-progress'),
    ]);

    t.after(async () => {
      await Promise.all(sockets.map((socket) => closeWebSocket(socket)));
    });

    const after = await waitForClientCount((status) => (
      Number(status.feedClients ?? 0) >= beforeFeed + 1
      && Number(status.chatClients ?? 0) >= beforeChat + 1
      && Number(status.orchestratorClients ?? 0) >= beforeOrchestrator + 1
      && Number(status.agentProgressClients ?? 0) >= beforeAgentProgress + 1
    ));

    assert.strictEqual(typeof after.feedClients, 'number');
    assert.strictEqual(typeof after.chatClients, 'number');
    assert.strictEqual(typeof after.orchestratorClients, 'number');
    assert.strictEqual(typeof after.agentProgressClients, 'number');

    assert.ok(Number(after.feedClients) >= beforeFeed + 1);
    assert.ok(Number(after.chatClients) >= beforeChat + 1);
    assert.ok(Number(after.orchestratorClients) >= beforeOrchestrator + 1);
    assert.ok(Number(after.agentProgressClients) >= beforeAgentProgress + 1);
  });

  test('chat_research tasks broadcast research status updates on /ws/chat', async (t) => {
    const ws = await connectWebSocket('/ws/chat');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    const taskId = `test-research-${randomUUID()}`;
    const startedPromise = waitForJsonMessage(
      ws,
      (payload) => payload.type === 'research_started' && payload.taskId === taskId,
      10_000,
    );
    const completedPromise = waitForJsonMessage(
      ws,
      (payload) => (
        payload.taskId === taskId
        && (payload.type === 'research_completed' || payload.type === 'research_failed')
      ),
      10_000,
    );

    const response = await fetch(`${HTTP_BASE_URL}/api/orchestrator/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '[unit] Research and write a comprehensive analysis post about websocket status visibility. Submit a type=analysis feed item.',
        priority: 'user_ping',
        source: 'chat_research',
        requestId: taskId,
      }),
    });

    assert.strictEqual(response.status, 202);

    const started = await startedPromise;
    assert.strictEqual(started.type, 'research_started');
    assert.strictEqual(started.taskId, taskId);
    assert.strictEqual(started.topic, 'websocket status visibility');

    const completed = await completedPromise;
    assert.strictEqual(completed.taskId, taskId);
    assert.ok(completed.type === 'research_completed' || completed.type === 'research_failed');
  });

  test('resetting a chat session broadcasts chat_session_reset on /ws/chat', async (t) => {
    const session = createChatSession();
    insertChatMessage({
      id: `ws-reset-${randomUUID()}`,
      role: 'user',
      sessionId: session.id,
      text: 'reset websocket test',
      status: 'delivered',
    });

    const ws = await connectWebSocket('/ws/chat');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    const resetPromise = waitForJsonMessage(
      ws,
      (payload) => payload.type === 'chat_session_reset' && payload.sessionId === session.id,
    );

    const response = await fetch(`${HTTP_BASE_URL}/api/chat/sessions/${encodeURIComponent(session.id)}/reset`, {
      method: 'POST',
    });
    assert.strictEqual(response.status, 200);

    const payload = await resetPromise;
    assert.strictEqual(payload.type, 'chat_session_reset');
    assert.strictEqual(payload.sessionId, session.id);
  });

  test('deleting a chat session broadcasts chat_session_deleted on /ws/chat', async (t) => {
    const firstSession = createChatSession();
    const secondSession = createChatSession();
    insertChatMessage({
      id: `ws-delete-${randomUUID()}`,
      role: 'user',
      sessionId: secondSession.id,
      text: 'delete websocket test',
      status: 'delivered',
    });

    const ws = await connectWebSocket('/ws/chat');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    const deletedPromise = waitForJsonMessage(
      ws,
      (payload) => payload.type === 'chat_session_deleted' && payload.sessionId === secondSession.id,
    );

    const response = await fetch(`${HTTP_BASE_URL}/api/chat/sessions/${encodeURIComponent(secondSession.id)}`, {
      method: 'DELETE',
    });
    assert.strictEqual(response.status, 200);

    const payload = await deletedPromise;
    assert.strictEqual(payload.type, 'chat_session_deleted');
    assert.strictEqual(payload.sessionId, secondSession.id);
    assert.strictEqual(payload.nextSessionId, firstSession.id);
  });

  test('updating a chat session broadcasts chat_session_updated on /ws/chat', async (t) => {
    const session = createChatSession({
      title: 'Unsorted',
    });

    const ws = await connectWebSocket('/ws/chat');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    const updatedPromise = waitForJsonMessage(
      ws,
      (payload) => payload.type === 'chat_session_updated' && payload.sessionId === session.id,
    );

    const response = await fetch(`${HTTP_BASE_URL}/api/chat/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Configured' }),
    });
    assert.strictEqual(response.status, 200);

    const payload = await updatedPromise;
    assert.strictEqual(payload.type, 'chat_session_updated');
    assert.strictEqual(payload.sessionId, session.id);
  });

  test('POST /api/internal/curate/submit broadcasts accepted items to /ws/feed', async (t) => {
    const ws = await connectWebSocket('/ws/feed');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    const sourceId = `ws-curate-${Date.now()}`;
    const originSessionId = createValidationOriginSessionId('ws-feed-submit');
    t.after(async () => {
      await cleanupValidationFixtures({
        sourceIds: [sourceId],
        originSessionIds: [originSessionId],
      }, HTTP_BASE_URL);
    });

    const messagePromise = waitForJsonMessage(
      ws,
      (payload) => (
        payload.type === 'feed_update'
        && Array.isArray(payload.items)
        && payload.items.some((item) => (
          item
          && typeof item === 'object'
          && (item as { sourceId?: unknown }).sourceId === sourceId
        ))
      ),
    );

    const response = await fetch(`${HTTP_BASE_URL}/api/internal/curate/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originSessionId,
        items: [
          {
            id: `ma-ws-submit-${randomUUID()}`,
            type: 'article',
            source: 'publication-slug',
            sourceId,
            parentId: null,
            relationship: 'parent',
            title: 'WebSocket submit',
            text: 'This item should be pushed over the feed websocket.',
            url: `https://example.com/ws/${sourceId}`,
            excerpt: 'ws excerpt',
            authorUsername: 'websocket',
            authorDisplayName: 'WebSocket Test',
            authorAvatarUrl: null,
            reason: 'Exercise feed websocket broadcast',
            tags: ['test'],
            mediaUrls: [],
            publishedAt: '2026-03-08T12:00:00.000Z',
            metadata: {},
          },
        ],
      }),
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.strictEqual(body.accepted, 1);
    assert.strictEqual(body.duplicates, 0);

    const payload = await messagePromise;
    assert.strictEqual(payload.type, 'feed_update');
    assert.strictEqual(payload.count, 1);
    assert.ok(Array.isArray(payload.items));
  });

  test('POST /api/internal/curate/submit broadcasts tweet inserts without auto-queueing agent enrichment', async (t) => {
    const ws = await connectWebSocket('/ws/feed');
    t.after(async () => {
      await closeWebSocket(ws);
    });

    const tweetId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const originSessionId = createValidationOriginSessionId('ws-feed-enrich');
    t.after(async () => {
      await cleanupValidationFixtures({
        sourceIds: [tweetId],
        originSessionIds: [originSessionId],
      }, HTTP_BASE_URL);
    });

    const messagePromise = waitForJsonMessage(
      ws,
      (payload) => (
        payload.type === 'feed_update'
        && Array.isArray(payload.items)
        && payload.items.some((item) => (
          item
          && typeof item === 'object'
          && (item as { sourceId?: unknown }).sourceId === tweetId
        ))
      ),
    );

    const response = await fetch(`${HTTP_BASE_URL}/api/internal/curate/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originSessionId,
        items: [
          {
            id: `ma-ws-submit-enrich-${randomUUID()}`,
            type: 'tweet',
            source: 'twitter',
            sourceId: tweetId,
            parentId: null,
            relationship: 'parent',
            title: null,
            text: 'This tweet should be enriched before websocket broadcast.',
            url: `https://x.com/websocket/status/${tweetId}`,
            excerpt: null,
            authorUsername: 'websocket',
            authorDisplayName: 'WebSocket Test',
            authorAvatarUrl: null,
            reason: 'Exercise tweet websocket enrichment',
            tags: ['test'],
            mediaUrls: [],
            publishedAt: '2026-03-08T12:00:00.000Z',
            metadata: {},
          },
        ],
      }),
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.strictEqual(body.accepted, 1);
    assert.strictEqual(body.duplicates, 0);
    assert.ok(Array.isArray(body.acceptedIds));

    const payload = await messagePromise;
    assert.strictEqual(payload.type, 'feed_update');
    assert.strictEqual(payload.count, 1);
    assert.ok(Array.isArray(payload.items));

    const payloadItems = Array.isArray(payload.items) ? payload.items : [];
    const enrichedTweet = payloadItems.find((item) => (
      item
      && typeof item === 'object'
      && (item as { sourceId?: unknown }).sourceId === tweetId
    )) as Record<string, unknown> | undefined;

    assert.ok(enrichedTweet, 'Expected enriched tweet in websocket payload');
    assert.strictEqual(enrichedTweet.authorAvatarUrl, null);
  });
});
