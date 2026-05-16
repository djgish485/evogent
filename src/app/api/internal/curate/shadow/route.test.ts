import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type RouteModule = {
  POST: (request: Request) => Promise<Response>;
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/curate/shadow', { concurrency: false }, () => {
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-shadow-curate-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.DATA_DIR = tempDir;
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

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

  async function importRoute(): Promise<RouteModule> {
    return import(`./route?t=${Date.now()}-${Math.random().toString(36).slice(2)}`) as Promise<RouteModule>;
  }

  test('writes accepted items to the daily shadow log without inserting feed rows', async () => {
    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/shadow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originSessionId: 'shadow-session-1',
        items: [
          {
            id: 'shadow-item-1',
            type: 'article',
            source: 'unit-test',
            sourceId: 'unit-source-1',
            title: 'Shadow item',
            text: 'A candidate selected by the OpenClaw shadow curator.',
            publishedAt: '2026-05-01T12:00:00.000Z',
          },
        ],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as { accepted: number; duplicates: number; acceptedIds: string[]; errors: unknown[] };
    assert.strictEqual(body.accepted, 1);
    assert.strictEqual(body.duplicates, 0);
    assert.deepStrictEqual(body.acceptedIds, ['shadow-item-1']);
    assert.deepStrictEqual(body.errors, []);

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tempDir, 'shadow-curator-log', `${today}.jsonl`);
    const lines = (await fs.promises.readFile(logPath, 'utf8')).trim().split('\n');
    assert.strictEqual(lines.length, 1);

    const logEntry = JSON.parse(lines[0]) as { originSessionId?: string; items?: Array<{ id?: string; sourceId?: string }> };
    assert.strictEqual(logEntry.originSessionId, 'shadow-session-1');
    assert.strictEqual(logEntry.items?.[0]?.id, 'shadow-item-1');
    assert.strictEqual(logEntry.items?.[0]?.sourceId, 'unit-source-1');

    const feedCount = getDb().prepare('SELECT COUNT(*) AS count FROM feed').get() as { count: number };
    assert.strictEqual(feedCount.count, 0);
  });

  test('reports duplicate live source ids and does not log them as accepted', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, published_at)
      VALUES ('existing-item', 'article', 'unit-test', 'duplicate-source', 'Existing', 'Existing body', ?)
    `).run('2026-05-01T10:00:00.000Z');

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/shadow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            id: 'shadow-duplicate',
            type: 'article',
            source: 'unit-test',
            sourceId: 'duplicate-source',
            title: 'Duplicate',
            text: 'This should be reported as a duplicate of the live feed.',
            publishedAt: '2026-05-01T12:00:00.000Z',
          },
        ],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as { accepted: number; duplicates: number; duplicateSourceIds: string[] };
    assert.strictEqual(body.accepted, 0);
    assert.strictEqual(body.duplicates, 1);
    assert.deepStrictEqual(body.duplicateSourceIds, ['duplicate-source']);
  });

  test('rejects malformed submit envelopes', async () => {
    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/shadow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: 'not-an-array' }),
    }));

    assert.strictEqual(response.status, 400);
    const body = await response.json() as { error?: string };
    assert.strictEqual(body.error, 'Field "items" must be an array');
  });
});
