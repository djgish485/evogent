import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './db/client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type FeedWatcherModule = {
  startFeedWatcher: () => Promise<void>;
  stopFeedWatcher: () => void;
};

const globalWithDb = globalThis as GlobalWithDb;

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for watcher state');
}

describe('feed watcher startup notifications', { concurrency: false }, () => {
  let originalCwd = '';
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalFeedWatcherStartupImport: string | undefined;
  let originalFetch: typeof fetch;
  let tempDir = '';
  let watcherModule: FeedWatcherModule | null = null;
  let notifyPayloads: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalFeedWatcherStartupImport = process.env.MEDIA_AGENT_ENABLE_FEED_WATCHER_STARTUP_IMPORT;
    originalFetch = globalThis.fetch;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-watcher-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.chdir(tempDir);
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
    process.env.MEDIA_AGENT_ENABLE_FEED_WATCHER_STARTUP_IMPORT = '1';
    notifyPayloads = [];

    globalThis.fetch = (async (_input, init) => {
      const rawBody = init?.body;
      const body = typeof rawBody === 'string'
        ? JSON.parse(rawBody) as Record<string, unknown>
        : {};
      notifyPayloads.push(body);

      return new Response(
        JSON.stringify({ ok: true, deliveredToClients: 0 }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    await fs.promises.mkdir(path.join(tempDir, 'data'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, 'data', 'feed-output.jsonl'),
      `${JSON.stringify({
        type: 'article',
        source: 'rss',
        source_id: 'existing-item',
        text: 'existing post',
        published_at: '2026-03-08T12:00:00.000Z',
      })}\n`,
      'utf8',
    );

    const watcherModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/lib/watcher.ts')).href}?case=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    watcherModule = await import(watcherModuleUrl) as FeedWatcherModule;
  });

  afterEach(async () => {
    watcherModule?.stopFeedWatcher();
    watcherModule = null;

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

    if (originalFeedWatcherStartupImport === undefined) {
      delete process.env.MEDIA_AGENT_ENABLE_FEED_WATCHER_STARTUP_IMPORT;
    } else {
      process.env.MEDIA_AGENT_ENABLE_FEED_WATCHER_STARTUP_IMPORT = originalFeedWatcherStartupImport;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('initial read populates the DB without notifying, then appended items notify', async () => {
    assert.ok(watcherModule);

    await watcherModule.startFeedWatcher();

    const db = getDb();
    const existingRows = db.prepare('SELECT source_id AS sourceId, text FROM feed ORDER BY text').all() as Array<{
      sourceId: string | null;
      text: string;
    }>;

    assert.deepStrictEqual(existingRows, [
      { sourceId: 'existing-item', text: 'existing post' },
    ]);
    assert.strictEqual(notifyPayloads.length, 0);

    await fs.promises.appendFile(
      path.join(tempDir, 'data', 'feed-output.jsonl'),
      `${JSON.stringify({
        type: 'article',
        source: 'rss',
        source_id: 'new-item',
        text: 'new post',
        published_at: '2026-03-08T12:05:00.000Z',
      })}\n`,
      'utf8',
    );

    await waitFor(() => notifyPayloads.length === 1, 7_000);

    const payload = notifyPayloads[0];
    assert.strictEqual(payload.count, 1);
    assert.ok(Array.isArray(payload.items));
    assert.strictEqual((payload.items as Array<{ text: string }>)[0]?.text, 'new post');

    const rows = db.prepare('SELECT source_id AS sourceId, text FROM feed ORDER BY text').all() as Array<{
      sourceId: string | null;
      text: string;
    }>;

    assert.deepStrictEqual(rows, [
      { sourceId: 'existing-item', text: 'existing post' },
      { sourceId: 'new-item', text: 'new post' },
    ]);
  });

  test('skips re-importing API audit lines for feed rows that already exist', async () => {
    assert.ok(watcherModule);

    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, text, published_at, created_at)
      VALUES ('api-item-id', 'article', 'rss', 'api-item-source', 'persisted api item', ?, ?)
    `).run('2026-03-08T12:10:00.000Z', '2026-03-08T12:10:30.000Z');

    await watcherModule.startFeedWatcher();

    await fs.promises.appendFile(
      path.join(tempDir, 'data', 'feed-output.jsonl'),
      `${JSON.stringify({
        id: 'api-item-id',
        type: 'article',
        source: 'rss',
        source_id: 'api-item-source',
        text: 'persisted api item',
        published_at: '2026-03-08T12:10:00.000Z',
      })}\n`,
      'utf8',
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = db.prepare(`
      SELECT id, source_id AS sourceId
      FROM feed
      WHERE source_id = 'api-item-source'
      ORDER BY id
    `).all() as Array<{ id: string; sourceId: string | null }>;

    assert.deepStrictEqual(rows, [
      { id: 'api-item-id', sourceId: 'api-item-source' },
    ]);
    assert.strictEqual(notifyPayloads.length, 0);
  });

  test('does not import or notify chat-output audit lines', async () => {
    assert.ok(watcherModule);

    await fs.promises.writeFile(path.join(tempDir, 'data', 'chat-output.jsonl'), '', 'utf8');
    await watcherModule.startFeedWatcher();

    await fs.promises.appendFile(
      path.join(tempDir, 'data', 'chat-output.jsonl'),
      `${JSON.stringify({
        type: 'chat',
        id: 'chat-audit-only',
        inReplyTo: 'msg-missing',
        taskId: 'task-audit-only',
        sessionId: '00000000-0000-4000-8000-000000000099',
        text: 'audit only',
        timestamp: '2026-03-08T12:01:00.000Z',
      })}\n`,
      'utf8',
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const db = getDb();
    const messageCount = db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number };
    const sessionCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_sessions
      WHERE id = '00000000-0000-4000-8000-000000000099'
    `).get() as { count: number };

    assert.strictEqual(messageCount.count, 0);
    assert.strictEqual(sessionCount.count, 0);
    assert.strictEqual(notifyPayloads.length, 0);
  });
});
