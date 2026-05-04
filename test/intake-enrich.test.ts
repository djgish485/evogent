import assert from 'node:assert';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { parseArgs, processItem } from '../scripts/intake-enrich';
import { recordBrowseCacheRefresh } from '../src/lib/db/browse-cache';
import { getFeedItemById, insertOrIgnoreFeedItem } from '../src/lib/db/feed';
import {
  shouldAutoQueueFeedItemEnrichment,
} from '../src/lib/feed-enrichment';
import type { FeedItem } from '../src/types/feed';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

function closeDb() {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

function insertTweet(id: string, overrides: Partial<FeedItem> = {}) {
  insertOrIgnoreFeedItem({
    id,
    type: 'tweet',
    source: 'twitter',
    sourceId: id,
    text: 'tweet text',
    publishedAt: '2026-04-06T00:00:00.000Z',
    metrics: {
      likes: 0,
      reposts: 0,
      replies: 0,
    },
    ...overrides,
  });
  const item = getFeedItemById(id);
  assert.ok(item);
  return item;
}

describe('intake enrich fallback', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-intake-enrich-test-'));
    closeDb();
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    closeDb();
    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('parseArgs accepts --id forms', () => {
    assert.deepStrictEqual(parseArgs(['--id', 'feed-item-1']), { id: 'feed-item-1' });
    assert.deepStrictEqual(parseArgs(['--id=feed-item-2']), { id: 'feed-item-2' });
    assert.deepStrictEqual(parseArgs([]), {});
  });

  test('only top-level tweets are auto-queued for enrichment', () => {
    assert.strictEqual(shouldAutoQueueFeedItemEnrichment({
      id: 'tweet-top-level',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-1',
      parentId: null,
      relationship: 'parent',
      title: null,
      text: 'Top-level tweet',
      url: 'https://x.com/example/status/1',
      excerpt: null,
      authorUsername: 'example',
      authorDisplayName: 'Example',
      reason: null,
      tags: [],
      mediaUrls: [],
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
      authorAvatarUrl: null,
      isLiked: false,
      isDisliked: false,
      metadata: null,
      publishedAt: '2026-04-06T00:00:00.000Z',
      createdAt: '2026-04-06T00:00:00.000Z',
    }), true);

    assert.strictEqual(shouldAutoQueueFeedItemEnrichment({
      id: 'tweet-child',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-2',
      parentId: 'feed-parent',
      relationship: 'reply',
      title: null,
      text: 'Reply child',
      url: 'https://x.com/example/status/2',
      excerpt: null,
      authorUsername: 'example',
      authorDisplayName: 'Example',
      reason: null,
      tags: [],
      mediaUrls: [],
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
      authorAvatarUrl: null,
      isLiked: false,
      isDisliked: false,
      metadata: null,
      publishedAt: '2026-04-06T00:00:00.000Z',
      createdAt: '2026-04-06T00:00:00.000Z',
    }), false);
  });

  test('processItem skips agent enrichment once exact cache facts make a tweet complete', async () => {
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: Date.now(),
      completedAtMs: Date.now(),
      status: 'completed',
      items: [{
        source: 'twitter',
        sourceId: 'tweet-cache-complete',
        payload: {
          authorAvatarUrl: 'https://pbs.twimg.com/profile_images/cache.jpg',
          media: [{ url: 'https://pbs.twimg.com/media/cache.jpg' }],
          quotedTweet: {
            text: 'quoted',
            authorUsername: 'quoted_author',
          },
        },
        fetchedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      }],
    });
    const item = insertTweet('tweet-cache-complete', {
      authorAvatarUrl: null,
      mediaUrls: [],
      metadata: null,
    });
    let queued = false;

    const result = await processItem(item, async () => {
      queued = true;
      return {
        ok: true,
        alreadyRunning: false,
        postId: item.id,
      };
    });

    assert.strictEqual(result.status, 'skipped');
    assert.match(result.detail, /enrichment no longer needed/);
    assert.strictEqual(queued, false);
  });

  test('processItem still queues when exact cache lacks required facts', async () => {
    const item = insertTweet('tweet-cache-incomplete', {
      authorAvatarUrl: null,
      mediaUrls: [],
      metadata: null,
    });
    let queued = false;

    const result = await processItem(item, async () => {
      queued = true;
      return {
        ok: true,
        alreadyRunning: false,
        postId: item.id,
      };
    });

    assert.strictEqual(result.status, 'queued');
    assert.strictEqual(queued, true);
  });
});
