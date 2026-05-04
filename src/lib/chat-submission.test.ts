import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { submitChatMessage } from './chat-submission';
import { createChatSession } from './db/chat-sessions';

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
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-submit-test-'));

  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }

  process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  process.env.DATA_DIR = tempDir;
  const binDir = path.join(tempDir, 'bin');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(path.join(binDir, 'claude'), '#!/usr/bin/env sh\necho claude-test\n', { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  enqueuePayload = null;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith('/api/orchestrator/enqueue')) {
      throw new Error(`Unexpected fetch in chat-submission.test: ${url}`);
    }

    enqueuePayload = init?.body && typeof init.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;

    return new Response(JSON.stringify({
      ok: true,
      requestId: 'chat-queue-unit-test',
      priority: 'user_chat',
      queueDepth: 1,
      position: 1,
      acceptedAt: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
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

  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }

  globalThis.fetch = originalFetch;

  if (tempDir) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('submitChatMessage tags curator /curate tasks for unified curation logging', async () => {
  const session = createChatSession({
    sessionType: 'curator',
    title: 'Curator',
  });

  const result = await submitChatMessage({
    message: '/curate',
    sessionId: session.id,
    requestId: 'chat-queue-unit-test',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.requestId, 'chat-queue-unit-test');
  assert.ok(enqueuePayload);
  assert.strictEqual(enqueuePayload?.priority, 'user_chat');
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationCommand,
    '/curate',
  );
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationLogRequestId,
    'chat-queue-unit-test',
  );
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationTriggeredBy,
    'curator_chat',
  );
  assert.match(String(enqueuePayload?.message ?? ''), /Follow the curator instruction document below directly for this turn/);
});

test('submitChatMessage queues automated curator /curate as chat-backed user_chat with heartbeat provenance', async () => {
  const session = createChatSession({
    sessionType: 'curator',
    title: 'Curator',
  });

  const result = await submitChatMessage({
    message: '/curate',
    sessionId: session.id,
    requestId: 'chat-queue-automated-curate',
    priority: 'user_chat',
    source: 'adaptive_heartbeat:unit-test',
    metadata: {
      automatedCuration: true,
      triggerSource: 'adaptive_heartbeat:unit-test',
      triggerReason: 'pull_refresh_immediate',
    },
  });

  assert.strictEqual(result.ok, true);
  assert.ok(enqueuePayload);
  assert.strictEqual(enqueuePayload?.priority, 'user_chat');
  assert.strictEqual(enqueuePayload?.source, 'adaptive_heartbeat:unit-test');
  assert.match(String(enqueuePayload?.message ?? ''), /Chat: \/curate/);
  assert.match(String(enqueuePayload?.message ?? ''), /Follow the curator instruction document below directly for this turn/);
  assert.doesNotMatch(String(enqueuePayload?.message ?? ''), /built-in runtime task \/curate/i);
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.automatedCuration,
    true,
  );
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationCommand,
    '/curate',
  );
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationTriggeredBy,
    'adaptive_heartbeat:unit-test:pull_refresh_immediate',
  );
});

test('submitChatMessage tags curator /curate-latest tasks for unified curation logging', async () => {
  const session = createChatSession({
    sessionType: 'curator',
    title: 'Curator',
  });

  const result = await submitChatMessage({
    message: '/curate-latest',
    sessionId: session.id,
    requestId: 'chat-queue-unit-test',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.requestId, 'chat-queue-unit-test');
  assert.ok(enqueuePayload);
  assert.strictEqual(enqueuePayload?.priority, 'user_chat');
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationCommand,
    '/curate-latest',
  );
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationLogRequestId,
    'chat-queue-unit-test',
  );
  assert.strictEqual(
    (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationTriggeredBy,
    'curator_chat',
  );
});

test('submitChatMessage queues Codex xhigh reasoning and Fast mode metadata from the session', async () => {
  const session = createChatSession({
    provider: 'codex',
    codexReasoningEffort: 'xhigh',
    codexFastMode: true,
    title: 'Codex XHigh',
  });

  const result = await submitChatMessage({
    message: 'Use the selected Codex settings.',
    sessionId: session.id,
  });

  assert.strictEqual(result.ok, true);
  const metadata = enqueuePayload?.metadata as Record<string, unknown> | undefined;
  assert.strictEqual(metadata?.provider, 'codex');
  assert.strictEqual(metadata?.codexReasoningEffort, 'xhigh');
  assert.strictEqual(metadata?.codexFastMode, true);
});
