import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { insertChatMessage } from '@/lib/db/chat';
import { createChatSession } from '@/lib/db/chat-sessions';
import { getDb } from '@/lib/db/client';

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
});
