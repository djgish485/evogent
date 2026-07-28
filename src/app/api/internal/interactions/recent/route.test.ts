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
    db.prepare(`
      INSERT INTO feed_engagement_sessions (
        session_id, feed_item_id, opened_at, last_seen_at, closed_at,
        active_dwell_ms, max_scroll_depth_pct, is_return, surface, item_snapshot
      ) VALUES (
        'detail:feed-new:session', 'feed-new', '2026-05-01 11:35:00',
        '2026-05-01 11:36:00', '2026-05-01 11:36:00',
        61000, 84, 1, 'detail_overlay', '{"title":"Newer title"}'
      )
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
      engagementSessionCount: number;
      engagementSessions: Array<{
        feedItemId: string;
        activeDwellMs: number;
        maxScrollDepthPercent: number;
        isReturn: boolean;
      }>;
    };

    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.interactions[0]?.feedItemId, 'feed-new');
    assert.strictEqual(body.interactions[0]?.action, 'thumbsdown');
    assert.strictEqual(body.interactions[0]?.feedItem.title, 'Newer title');
    assert.strictEqual(body.interactions[0]?.feedItem.sourceId, 'source-new');
    assert.strictEqual(body.interactions[0]?.feedItem.authorUsername, 'new_author');
    assert.strictEqual(body.engagementSessionCount, 1);
    assert.strictEqual(body.engagementSessions[0]?.feedItemId, 'feed-new');
    assert.strictEqual(body.engagementSessions[0]?.activeDwellMs, 61000);
    assert.strictEqual(body.engagementSessions[0]?.maxScrollDepthPercent, 84);
    assert.strictEqual(body.engagementSessions[0]?.isReturn, true);
  });

  test('omits phone-notification interactions and engagement snapshots from agent evidence', async () => {
    const db = getDb();
    const privateCanary = 'PRIVATE_NOTIFICATION_INTERACTION_CANARY_9024';
    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, published_at)
      VALUES
        ('phone-private', 'notification', 'phone-notification', 'phone-notification:private', ?, ?, ?),
        ('article-safe', 'article', 'publisher', 'article:safe', 'Safe title', 'Safe body', ?)
    `).run(
      `Private title ${privateCanary}`,
      `Private body ${privateCanary}`,
      '2026-05-01T12:00:00.000Z',
      '2026-05-01T11:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO interactions (feed_item_id, action, created_at)
      VALUES
        ('phone-private', 'expand', '2026-05-01 12:30:00'),
        ('article-safe', 'thumbsup', '2026-05-01 11:30:00')
    `).run();
    db.prepare(`
      INSERT INTO feed_engagement_sessions (
        session_id, feed_item_id, opened_at, last_seen_at, closed_at,
        active_dwell_ms, max_scroll_depth_pct, is_return, surface, item_snapshot
      ) VALUES
        (
          'detail:phone-private:session', 'phone-private', '2026-05-01 12:31:00',
          '2026-05-01 12:32:00', '2026-05-01 12:32:00',
          61000, 84, 0, 'detail_overlay', ?
        ),
        (
          'detail:article-safe:session', 'article-safe', '2026-05-01 11:31:00',
          '2026-05-01 11:32:00', '2026-05-01 11:32:00',
          30000, 50, 0, 'detail_overlay', '{"title":"Safe title"}'
        ),
        (
          'detail:phone-orphan:session', 'deleted-phone-private', '2026-05-01 12:33:00',
          '2026-05-01 12:34:00', '2026-05-01 12:34:00',
          40000, 70, 0, 'detail_overlay', ?
        )
    `).run(
      JSON.stringify({
        type: 'notification',
        source: 'phone-notification',
        title: `Private title ${privateCanary}`,
        text: `Private body ${privateCanary}`,
      }),
      JSON.stringify({
        type: 'notification',
        source: 'phone-notification',
        title: `Orphan private title ${privateCanary}`,
        text: `Orphan private body ${privateCanary}`,
      }),
    );

    const { GET } = await importRoute();
    const response = await GET(new Request(
      'http://127.0.0.1/api/internal/interactions/recent?limit=10',
    ));
    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      interactions: Array<{ feedItemId: string }>;
      engagementSessions: Array<{ feedItemId: string }>;
    };

    assert.deepStrictEqual(body.interactions.map((entry) => entry.feedItemId), ['article-safe']);
    assert.deepStrictEqual(
      body.engagementSessions.map((entry) => entry.feedItemId),
      ['article-safe'],
    );
    assert.doesNotMatch(JSON.stringify(body), new RegExp(privateCanary));
  });
});
