import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './client';
import {
  getRecentFeedEngagementSessions,
  recordFeedEngagementSession,
} from './feed-engagement';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('feed engagement session ledger', { concurrency: false }, () => {
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-engagement-ledger-'));

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
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('keeps monotonic raw dwell/depth and labels later visits as returns', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, title, text, author_username, published_at)
      VALUES ('engaged-item', 'article', 'unit-test', 'A durable title', 'Body', 'author', ?)
    `).run('2026-07-25T12:00:00.000Z');

    const firstOpen = recordFeedEngagementSession({
      sessionId: 'detail:engaged:first',
      feedItemId: 'engaged-item',
      phase: 'open',
      surface: 'detail_overlay',
      itemSnapshot: {
        type: 'article',
        source: 'unit-test',
        title: '  A durable   title ',
        text: 'Body',
      },
    });
    assert.strictEqual(firstOpen.isReturn, false);
    assert.strictEqual(firstOpen.itemSnapshot?.title, 'A durable title');

    recordFeedEngagementSession({
      sessionId: 'detail:engaged:first',
      feedItemId: 'engaged-item',
      phase: 'checkpoint',
      activeDwellMs: 12_000,
      scrollDepthPercent: 45,
      userScrolled: true,
    });
    const firstClose = recordFeedEngagementSession({
      sessionId: 'detail:engaged:first',
      feedItemId: 'engaged-item',
      phase: 'close',
      activeDwellMs: 10_000,
      scrollDepthPercent: 30,
    });

    assert.strictEqual(firstClose.activeDwellMs, 12_000);
    assert.strictEqual(firstClose.maxScrollDepthPercent, 45);
    assert.strictEqual(firstClose.userScrolled, true);
    assert.ok(firstClose.closedAt);

    const secondOpen = recordFeedEngagementSession({
      sessionId: 'detail:engaged:second',
      feedItemId: 'engaged-item',
      phase: 'open',
    });
    assert.strictEqual(secondOpen.isReturn, true);
    assert.deepStrictEqual(
      getRecentFeedEngagementSessions().map((row) => row.sessionId),
      ['detail:engaged:second', 'detail:engaged:first'],
    );
  });
});
