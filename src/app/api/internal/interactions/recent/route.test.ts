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
  GET: (request: Request) => Promise<Response>;
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/interactions/recent', { concurrency: false }, () => {
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-recent-interactions-route-test-'));

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

  test('returns recent interactions joined to feed item titles', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, author_username, published_at)
      VALUES
        ('feed-old', 'article', 'unit-test', 'source-old', 'Older title', 'Older body', 'old_author', ?),
        ('feed-new', 'article', 'unit-test', 'source-new', 'Newer title', 'Newer body', 'new_author', ?)
    `).run('2026-05-01T10:00:00.000Z', '2026-05-01T11:00:00.000Z');

    db.prepare(`
      INSERT INTO interactions (feed_item_id, action, created_at)
      VALUES
        ('feed-old', 'thumbsup', '2026-05-01 10:30:00'),
        ('feed-new', 'thumbsdown', '2026-05-01 11:30:00')
    `).run();

    const { GET } = await importRoute();
    const response = await GET(new Request('http://127.0.0.1/api/internal/interactions/recent?limit=1'));
    assert.strictEqual(response.status, 200);

    const body = await response.json() as {
      ok: boolean;
      count: number;
      interactions: Array<{
        feedItemId: string;
        action: string;
        feedItem: {
          title: string | null;
          sourceId: string | null;
          authorUsername: string | null;
        };
      }>;
    };

    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.interactions[0]?.feedItemId, 'feed-new');
    assert.strictEqual(body.interactions[0]?.action, 'thumbsdown');
    assert.strictEqual(body.interactions[0]?.feedItem.title, 'Newer title');
    assert.strictEqual(body.interactions[0]?.feedItem.sourceId, 'source-new');
    assert.strictEqual(body.interactions[0]?.feedItem.authorUsername, 'new_author');
  });
});
