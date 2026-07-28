import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import { SCREEN_CHAT_SESSION_TITLE } from '@/lib/screen-chat-privacy';
import { POST } from './route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

let originalDbPath: string | undefined;
let originalDataDir: string | undefined;
let originalPath: string | undefined;
let originalFetch: typeof fetch;
let tempDir = '';
let enqueuePayload: Record<string, unknown> | null = null;

beforeEach(async () => {
  originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
  originalDataDir = process.env.DATA_DIR;
  originalPath = process.env.PATH;
  originalFetch = globalThis.fetch;
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-screen-chat-route-test-'));

  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }

  process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  process.env.DATA_DIR = tempDir;
  await fs.promises.writeFile(
    path.join(tempDir, 'config.md'),
    '# Test config\n\n## Brain Provider\nCodex CLI\n',
  );

  const binDir = path.join(tempDir, 'bin');
  await fs.promises.mkdir(binDir, { recursive: true });
  for (const binary of ['claude', 'codex']) {
    await fs.promises.writeFile(
      path.join(binDir, binary),
      `#!/usr/bin/env sh\necho "${binary} test"\n`,
      { mode: 0o755 },
    );
  }
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;

  enqueuePayload = null;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (!url.endsWith('/api/orchestrator/enqueue')) {
      throw new Error(`Unexpected fetch in screen chat route test: ${url}`);
    }

    enqueuePayload = init?.body && typeof init.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;
    return new Response(JSON.stringify({
      ok: true,
      requestId: 'screen-route-contract-task',
      priority: 'user_chat',
      queueDepth: 1,
      position: 1,
      acceptedAt: new Date().toISOString(),
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }

  if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
  else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  globalThis.fetch = originalFetch;

  if (tempDir) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('screen chat route uses a generic session title and strips native and arbitrary metadata', async () => {
  const screenApp = 'com.private.example.reader';
  const metadataCanary = 'PRIVATE_SCREEN_ROUTE_METADATA_CANARY_4829';
  const screenCanary = 'PRIVATE_SCREEN_ROUTE_CONTEXT_CANARY_7351';
  const transientContext = `The user is viewing ${screenApp}. Visible screen content:\n${screenCanary}`;

  const response = await POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Summarize this screen.',
      context: transientContext,
      contextKind: 'screen',
      contextRefId: 'current-overlay-screen',
      originView: 'feed',
      newSession: true,
      metadata: {
        overlay: true,
        screenApp,
        arbitrary: metadataCanary,
        nested: { value: metadataCanary },
      },
    }),
  }));
  const body = await response.json() as {
    ok?: boolean;
    sessionId?: string;
    userMessage?: Record<string, unknown>;
  };

  assert.strictEqual(response.status, 202);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(typeof body.sessionId, 'string');
  assert.doesNotMatch(JSON.stringify(body.userMessage), new RegExp(`${screenApp}|${metadataCanary}|${screenCanary}`));

  const session = getDb().prepare(`
    SELECT *
    FROM chat_sessions
    WHERE id = ?
  `).get(body.sessionId) as Record<string, unknown> | undefined;
  assert.ok(session);
  assert.strictEqual(session.title, SCREEN_CHAT_SESSION_TITLE);
  assert.doesNotMatch(JSON.stringify(session), new RegExp(`${screenApp}|${metadataCanary}|${screenCanary}`));

  const chatRow = getDb().prepare(`
    SELECT text, context, metadata
    FROM chat_messages
    WHERE session_id = ?
  `).get(body.sessionId) as Record<string, unknown> | undefined;
  assert.ok(chatRow);
  assert.strictEqual(chatRow.context, null);
  assert.doesNotMatch(JSON.stringify(chatRow), new RegExp(`${screenApp}|${metadataCanary}|${screenCanary}`));

  assert.ok(enqueuePayload);
  assert.strictEqual(enqueuePayload.transientScreenContext, transientContext);
  const { transientScreenContext, ...durableTaskPayload } = enqueuePayload;
  assert.strictEqual(transientScreenContext, transientContext);
  assert.doesNotMatch(
    JSON.stringify(durableTaskPayload),
    new RegExp(`${screenApp}|${metadataCanary}|${screenCanary}`),
  );
  const taskMetadata = enqueuePayload.metadata as Record<string, unknown>;
  assert.strictEqual(taskMetadata.overlay, true);
  assert.strictEqual(taskMetadata.contextKind, 'screen');
  assert.ok(!Object.hasOwn(taskMetadata, 'screenApp'));
  assert.ok(!Object.hasOwn(taskMetadata, 'arbitrary'));
  assert.ok(!Object.hasOwn(taskMetadata, 'nested'));
});
