import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  ensureChatReplyPushOutboxSchema,
  resetChatReplyPushOutboxRuntimeForTests,
  waitForChatReplyPushOutboxIdleForTests,
} from '@/lib/chat-reply-push-outbox';
import { insertUserActivity } from '@/lib/db/activity';
import { insertChatMessage } from '@/lib/db/chat';
import { createChatSession } from '@/lib/db/chat-sessions';
import { getDb } from '@/lib/db/client';
import { recordAppPresence } from '@/lib/db/presence';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type ChatSubmitRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

const globalWithDb = globalThis as GlobalWithDb;

describe('internal chat submit route', { concurrency: false }, () => {
  let originalCwd = '';
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalFetch: typeof fetch;
  let tempDir = '';
  let routeModule: ChatSubmitRouteModule | null = null;
  let notifyPayloads: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalFetch = globalThis.fetch;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-submit-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.chdir(tempDir);
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
    notifyPayloads = [];

    globalThis.fetch = (async (_input, init) => {
      const rawBody = init?.body;
      notifyPayloads.push(typeof rawBody === 'string' ? JSON.parse(rawBody) as Record<string, unknown> : {});

      return new Response(
        JSON.stringify({ ok: true, deliveredToClients: 0 }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const routeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/internal/chat/submit/route.ts')).href}?case=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    routeModule = await import(routeModuleUrl) as ChatSubmitRouteModule;
  });

  afterEach(async () => {
    routeModule = null;
    await waitForChatReplyPushOutboxIdleForTests();
    resetChatReplyPushOutboxRuntimeForTests();

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);

    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
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

  test('rejects submissions without resolvable session routing before persistence', async () => {
    assert.ok(routeModule);

    const response = await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-unrouted',
        role: 'agent',
        text: 'Answer without a route',
        timestamp: '2026-05-21T19:21:00.000Z',
      }),
    }));
    const body = await response.json() as { error?: string };

    assert.strictEqual(response.status, 400);
    assert.strictEqual(body.error, 'submit payload requires resolvable sessionId, inReplyTo, or originSessionId');

    const unknownSessionId = randomUUID();
    const unknownSessionResponse = await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-unknown-session',
        taskId: 'task-submit-unknown-session',
        sessionId: unknownSessionId,
        text: 'Answer for a missing session',
      }),
    }));
    const unknownSessionBody = await unknownSessionResponse.json() as { error?: string };

    assert.strictEqual(unknownSessionResponse.status, 400);
    assert.strictEqual(unknownSessionBody.error, 'submit payload requires resolvable sessionId, inReplyTo, or originSessionId');

    const db = getDb();
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM chat_messages) AS messageCount,
        (SELECT COUNT(*) FROM chat_sessions) AS sessionCount
    `).get() as { messageCount: number; sessionCount: number };
    const phantomRow = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(unknownSessionId);

    assert.strictEqual(counts.messageCount, 0);
    assert.strictEqual(counts.sessionCount, 0);
    assert.strictEqual(phantomRow, undefined);
  });

  test('routes submissions by real inReplyTo or originSessionId without creating sessions', async () => {
    assert.ok(routeModule);

    const session = createChatSession({ id: randomUUID(), title: 'Route Lookup' });
    const userMessage = insertChatMessage({
      id: 'msg-submit-route-lookup',
      role: 'user',
      sessionId: session.id,
      text: 'Question',
      status: 'queued',
    });
    assert.ok(userMessage);

    const beforeSessionCount = (
      getDb().prepare('SELECT COUNT(*) AS count FROM chat_sessions').get() as { count: number }
    ).count;
    const replyResponse = await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-route-lookup',
        inReplyTo: userMessage.id,
        taskId: 'task-submit-route-lookup',
        text: 'Answer routed by reply target',
      }),
    }));
    const replyBody = await replyResponse.json() as { item?: { sessionId?: string | null } };

    assert.strictEqual(replyResponse.status, 200);
    assert.strictEqual(replyBody.item?.sessionId, session.id);

    const originResponse = await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-origin-route',
        taskId: 'task-submit-origin-route',
        originSessionId: session.id,
        text: 'Answer routed by origin session',
      }),
    }));
    const originBody = await originResponse.json() as { item?: { sessionId?: string | null } };

    assert.strictEqual(originResponse.status, 200);
    assert.strictEqual(originBody.item?.sessionId, session.id);

    const afterSessionCount = (
      getDb().prepare('SELECT COUNT(*) AS count FROM chat_sessions').get() as { count: number }
    ).count;
    assert.strictEqual(afterSessionCount, beforeSessionCount);
  });

  test('persists one agent reply, audits, broadcasts, marks delivered, and dedups by task reply target', async () => {
    assert.ok(routeModule);

    const session = createChatSession({ id: randomUUID(), title: 'Route Submit' });
    const userMessage = insertChatMessage({
      id: 'msg-submit-route',
      role: 'user',
      sessionId: session.id,
      text: 'Question',
      status: 'queued',
    });
    assert.ok(userMessage);

    const firstResponse = await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-route-first',
        inReplyTo: userMessage.id,
        taskId: 'task-submit-route',
        sessionId: session.id,
        text: 'Answer',
      }),
    }));
    const firstBody = await firstResponse.json() as { inserted?: boolean; duplicateOf?: string | null };

    assert.strictEqual(firstResponse.status, 200);
    assert.strictEqual(firstBody.inserted, true);
    assert.strictEqual(firstBody.duplicateOf, null);

    const secondResponse = await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-route-second',
        inReplyTo: userMessage.id,
        taskId: 'task-submit-route',
        sessionId: session.id,
        text: 'Duplicate answer',
      }),
    }));
    const secondBody = await secondResponse.json() as { inserted?: boolean; duplicateOf?: string | null };

    assert.strictEqual(secondResponse.status, 200);
    assert.strictEqual(secondBody.inserted, false);
    assert.strictEqual(secondBody.duplicateOf, 'chat-submit-route-first');

    const db = getDb();
    const userRow = db.prepare(`
      SELECT status
      FROM chat_messages
      WHERE id = ?
    `).get(userMessage.id) as { status: string | null } | undefined;
    assert.strictEqual(userRow?.status, 'delivered');

    const agentRows = db.prepare(`
      SELECT id, text
      FROM chat_messages
      WHERE role = 'agent'
      ORDER BY id
    `).all() as Array<{ id: string; text: string }>;
    assert.deepStrictEqual(agentRows, [
      { id: 'chat-submit-route-first', text: 'Answer' },
    ]);

    const auditPath = path.join(tempDir, 'data', 'chat-output.jsonl');
    const auditLines = (await fs.promises.readFile(auditPath, 'utf8')).trim().split('\n');
    assert.strictEqual(auditLines.length, 1);
    assert.strictEqual(JSON.parse(auditLines[0] ?? '{}').id, 'chat-submit-route-first');

    assert.strictEqual(notifyPayloads.length, 1);
    assert.deepStrictEqual(
      (notifyPayloads[0]?.items as Array<{ id: string }> | undefined)?.map((item) => item.id),
      ['chat-submit-route-first'],
    );
  });

  test('an outbox receipt fault cannot fail or duplicate an already-durable reply', async () => {
    assert.ok(routeModule);

    const dataDir = path.join(tempDir, 'data');
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'push-notifications.json'), JSON.stringify({
      enabled: true,
      provider: 'ntfy',
      ntfy: {
        topic: 'chat-submit-receipt-fault',
        server: 'https://ntfy.example.com',
      },
      events: {
        chat_reply: {
          enabled: true,
          suppressWhenForeground: false,
        },
      },
    }), 'utf8');

    const session = createChatSession({ id: randomUUID(), title: 'Receipt Fault' });
    const userMessage = insertChatMessage({
      id: 'msg-submit-receipt-fault',
      role: 'user',
      sessionId: session.id,
      text: 'Question',
      status: 'queued',
    });
    assert.ok(userMessage);

    ensureChatReplyPushOutboxSchema();
    getDb().exec(`
      CREATE TRIGGER fail_test_chat_reply_push_receipt
      BEFORE INSERT ON chat_reply_push_outbox
      BEGIN
        SELECT RAISE(FAIL, 'synthetic receipt failure');
      END;
    `);

    const originalConsoleError = console.error;
    const loggedErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args.map(String).join(' '));
    };
    try {
      const payload = {
        type: 'chat',
        id: 'chat-submit-receipt-fault',
        inReplyTo: userMessage.id,
        taskId: 'task-submit-receipt-fault',
        sessionId: session.id,
        text: 'Durable despite optional delivery fault',
      };
      const first = await routeModule.POST(new Request(
        'http://127.0.0.1/api/internal/chat/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      ));
      const duplicate = await routeModule.POST(new Request(
        'http://127.0.0.1/api/internal/chat/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      ));

      assert.strictEqual(first.status, 200);
      assert.strictEqual(duplicate.status, 200);
      assert.strictEqual(
        (await duplicate.json() as { inserted?: boolean }).inserted,
        false,
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.strictEqual(
      (getDb().prepare(`
        SELECT COUNT(*) AS count
        FROM chat_messages
        WHERE id = 'chat-submit-receipt-fault'
      `).get() as { count: number }).count,
      1,
    );
    const auditLines = (
      await fs.promises.readFile(path.join(dataDir, 'chat-output.jsonl'), 'utf8')
    ).trim().split('\n');
    assert.strictEqual(auditLines.length, 1);
    assert.strictEqual(notifyPayloads.length, 1);
    assert.ok(loggedErrors.some((line) => line.includes('push receipt persistence failed')));
  });

  test('queues native push after audit without waiting for WebSocket delivery', async () => {
    assert.ok(routeModule);

    const dataDir = path.join(tempDir, 'data');
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'push-notifications.json'), JSON.stringify({
      enabled: true,
      provider: 'ntfy',
      ntfy: {
        topic: 'chat-submit-order',
        server: 'https://ntfy.example.com',
      },
      events: {
        chat_reply: {
          enabled: true,
          suppressWhenForeground: false,
        },
      },
    }), 'utf8');

    let releaseWebSocket!: (response: Response) => void;
    const webSocketGate = new Promise<Response>((resolve) => {
      releaseWebSocket = resolve;
    });
    let markWebSocketStarted!: () => void;
    const webSocketStarted = new Promise<void>((resolve) => {
      markWebSocketStarted = resolve;
    });
    let markPushStarted!: (auditWasDurable: boolean) => void;
    const pushStarted = new Promise<boolean>((resolve) => {
      markPushStarted = resolve;
    });

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === 'https://ntfy.example.com/chat-submit-order') {
        const audit = await fs.promises.readFile(path.join(dataDir, 'chat-output.jsonl'), 'utf8');
        const receipt = getDb().prepare(`
          SELECT state
          FROM chat_reply_push_outbox
          WHERE message_id = 'chat-submit-push-order'
        `).get() as { state?: string } | undefined;
        markPushStarted(
          audit.includes('"id":"chat-submit-push-order"')
          && receipt?.state === 'pending',
        );
        return new Response(null, { status: 200 });
      }

      const rawBody = init?.body;
      notifyPayloads.push(typeof rawBody === 'string' ? JSON.parse(rawBody) as Record<string, unknown> : {});
      markWebSocketStarted();
      return webSocketGate;
    }) as typeof fetch;

    const session = createChatSession({ id: randomUUID(), title: 'Push Ordering' });
    const userMessage = insertChatMessage({
      id: 'msg-submit-push-order',
      role: 'user',
      sessionId: session.id,
      text: 'Question',
      status: 'queued',
    });
    assert.ok(userMessage);

    const responsePromise = routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-push-order',
        inReplyTo: userMessage.id,
        taskId: 'task-submit-push-order',
        sessionId: session.id,
        text: 'Answer ready for native push',
      }),
    }));

    await webSocketStarted;
    let pushWaitTimer!: ReturnType<typeof setTimeout>;
    const pushBeforeWebSocketRelease = await Promise.race([
      pushStarted,
      new Promise<false>((resolve) => {
        pushWaitTimer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    clearTimeout(pushWaitTimer);

    let responseTimer!: ReturnType<typeof setTimeout>;
    const responseBeforeWebSocket = await Promise.race([
      responsePromise,
      new Promise<null>((resolve) => {
        responseTimer = setTimeout(() => resolve(null), 1_000);
      }),
    ]);
    clearTimeout(responseTimer);

    releaseWebSocket(new Response(
      JSON.stringify({ ok: true, deliveredToClients: 0 }),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    assert.ok(responseBeforeWebSocket);
    assert.strictEqual(responseBeforeWebSocket.status, 200);
    assert.strictEqual(pushBeforeWebSocketRelease, true);
    assert.strictEqual(notifyPayloads.length, 1);
  });

  test('a hanging native push cannot delay the durable chat submit response', async () => {
    assert.ok(routeModule);

    const dataDir = path.join(tempDir, 'data');
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'push-notifications.json'), JSON.stringify({
      enabled: true,
      provider: 'ntfy',
      ntfy: {
        topic: 'chat-submit-hanging-push',
        server: 'https://ntfy.example.com',
      },
      events: {
        chat_reply: {
          enabled: true,
          suppressWhenForeground: false,
        },
      },
    }), 'utf8');

    let markPushStarted!: () => void;
    const pushStarted = new Promise<void>((resolve) => {
      markPushStarted = resolve;
    });
    let releasePush!: (response: Response) => void;
    const pushGate = new Promise<Response>((resolve) => {
      releasePush = resolve;
    });

    globalThis.fetch = (async (input) => {
      if (String(input) === 'https://ntfy.example.com/chat-submit-hanging-push') {
        markPushStarted();
        return pushGate;
      }
      return new Response(
        JSON.stringify({ ok: true, deliveredToClients: 0 }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const session = createChatSession({ id: randomUUID(), title: 'Nonblocking Push' });
    const userMessage = insertChatMessage({
      id: 'msg-submit-hanging-push',
      role: 'user',
      sessionId: session.id,
      text: 'Question',
      status: 'queued',
    });
    assert.ok(userMessage);

    const responsePromise = routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-hanging-push',
        inReplyTo: userMessage.id,
        taskId: 'task-submit-hanging-push',
        sessionId: session.id,
        text: 'Reply whose native delivery is still pending',
      }),
    }));

    await pushStarted;
    let responseTimer!: ReturnType<typeof setTimeout>;
    const responseBeforePush = await Promise.race([
      responsePromise,
      new Promise<null>((resolve) => {
        responseTimer = setTimeout(() => resolve(null), 1_000);
      }),
    ]);
    clearTimeout(responseTimer);

    assert.ok(responseBeforePush);
    assert.strictEqual(responseBeforePush.status, 200);
    releasePush(new Response(null, { status: 200 }));
  });

  test('suppresses push from presence even when later behavioral events are newer', async () => {
    assert.ok(routeModule);

    const dataDir = path.join(tempDir, 'data');
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'push-notifications.json'), JSON.stringify({
      enabled: true,
      provider: 'ntfy',
      ntfy: {
        topic: 'chat-submit-presence',
        server: 'https://ntfy.example.com',
      },
      events: {
        chat_reply: {
          enabled: true,
          suppressWhenForeground: true,
          suppressWindowSeconds: 120,
        },
      },
    }), 'utf8');

    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        JSON.stringify({ ok: true, deliveredToClients: 0 }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const session = createChatSession({ id: randomUUID(), title: 'Presence Suppression' });
    const userMessage = insertChatMessage({
      id: 'msg-submit-presence',
      role: 'user',
      sessionId: session.id,
      text: 'Question while visible',
      status: 'queued',
    });
    assert.ok(userMessage);

    recordAppPresence('foreground', randomUUID(), 1);
    insertUserActivity('pull_refresh');
    insertUserActivity('ping');

    const response = await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-submit-presence',
        inReplyTo: userMessage.id,
        taskId: 'task-submit-presence',
        sessionId: session.id,
        text: 'Visible reply',
      }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(response.status, 200);
    assert.strictEqual(
      requestedUrls.filter((url) => url === 'https://ntfy.example.com/chat-submit-presence').length,
      0,
    );
    assert.strictEqual(
      (getDb().prepare('SELECT COUNT(*) AS count FROM user_activity').get() as { count: number }).count,
      2,
      'presence must not add a behavioral-history row',
    );
  });

  test('records a demand event when the agent reply carries an anticipation field', async () => {
    assert.ok(routeModule);

    const session = createChatSession({ id: randomUUID(), title: 'Anticipation Submit' });
    const userMessage = insertChatMessage({
      id: 'msg-anticipation-submit',
      role: 'user',
      sessionId: session.id,
      text: 'Any RL videos?',
      status: 'queued',
    });
    assert.ok(userMessage);

    const response = await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-anticipation-submit',
        inReplyTo: userMessage.id,
        taskId: 'task-anticipation-submit',
        text: 'Here are two from your feed.',
        anticipation: { tier: 'feed_hit', topics: ['Reinforcement Learning'], sourceHint: 'youtube', waitedMs: 1200 },
      }),
    }));
    assert.strictEqual(response.status, 200);

    const eventRow = getDb().prepare(`
      SELECT tier, topics, source_hint, session_id, message_id, waited_ms
      FROM anticipation_events
      ORDER BY id DESC
      LIMIT 1
    `).get() as { tier: string; topics: string; source_hint: string | null; session_id: string | null; message_id: string | null; waited_ms: number | null } | undefined;

    assert.ok(eventRow);
    assert.strictEqual(eventRow.tier, 'feed_hit');
    assert.deepStrictEqual(JSON.parse(eventRow.topics), ['reinforcement learning']);
    assert.strictEqual(eventRow.source_hint, 'youtube');
    assert.strictEqual(eventRow.session_id, session.id);
    assert.strictEqual(eventRow.message_id, userMessage.id);
    assert.strictEqual(eventRow.waited_ms, 1200);
  });

  test('does not record a demand event for a plain reply with no anticipation field', async () => {
    assert.ok(routeModule);

    const session = createChatSession({ id: randomUUID(), title: 'No Anticipation' });
    const userMessage = insertChatMessage({
      id: 'msg-no-anticipation',
      role: 'user',
      sessionId: session.id,
      text: 'hello',
      status: 'queued',
    });
    assert.ok(userMessage);

    await routeModule.POST(new Request('http://127.0.0.1/api/internal/chat/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        id: 'chat-no-anticipation',
        inReplyTo: userMessage.id,
        taskId: 'task-no-anticipation',
        text: 'Hi there.',
      }),
    }));

    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM anticipation_events').get() as { c: number }).c;
    assert.strictEqual(count, 0);
  });
});
