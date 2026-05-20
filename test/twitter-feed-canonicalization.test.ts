import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { recordBrowseCacheRefresh } from '../src/lib/db/browse-cache';
import { getDb } from '../src/lib/db/client';
import { canonicalizeTwitterFeedItemForSubmit } from '../src/lib/twitter-feed-canonicalization';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type SubmitRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

const globalWithDb = globalThis as GlobalWithDb;

function closeDb() {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

describe('twitter feed canonicalization', () => {
  test('converts structurally tweet-shaped Twitter articles before persistence', () => {
    const result = canonicalizeTwitterFeedItemForSubmit({
      id: 'canonicalize-twitter-article',
      type: 'article',
      source: 'twitter',
      sourceId: '2030455675357143260',
      title: 'Untitled article',
      text: 'Tweet text from curation',
      url: 'https://x.com/example/status/2030455675357143260',
      authorUsername: 'example',
      publishedAt: '2026-04-28T01:03:00.000Z',
      metadata: {
        cycleId: 'curate-test',
      },
    }, {
      cachedPayload: {
        tweetId: '2030455675357143260',
        text: 'Cached tweet text',
        authorAvatarUrl: 'https://pbs.twimg.com/profile_images/example.jpg',
        metrics: { likes: 10 },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.item.type, 'tweet');
    assert.equal(result.item.source, 'twitter');
    assert.equal(result.item.sourceId, '2030455675357143260');
    assert.equal(result.item.title, null);
    assert.equal(result.item.url, 'https://x.com/example/status/2030455675357143260');
    assert.equal(result.converted, true);
    assert.deepEqual(result.item.metadata?.twitterCanonicalization, {
      originalType: 'article',
      originalSource: 'twitter',
      originalSourceId: '2030455675357143260',
      originalUrl: 'https://x.com/example/status/2030455675357143260',
      canonicalTweetId: '2030455675357143260',
      evidence: [
        'browse_cache_payload',
        'numeric_source_id',
        'status_url',
        'twitter_source',
      ],
    });
  });

  test('does not convert non-status x.com articles without tweet structure', () => {
    const result = canonicalizeTwitterFeedItemForSubmit({
      id: 'canonicalize-x-article',
      type: 'article',
      source: 'web',
      sourceId: 'https://x.com/i/trending',
      title: 'X trending page',
      text: 'A web article about a trending page',
      url: 'https://x.com/i/trending',
      publishedAt: '2026-04-28T01:03:00.000Z',
      metadata: {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.item.type, 'article');
    assert.equal(result.item.sourceId, 'https://x.com/i/trending');
    assert.equal(result.converted, false);
  });

  test('rejects conflicting tweet ids instead of guessing', () => {
    const result = canonicalizeTwitterFeedItemForSubmit({
      id: 'canonicalize-conflict',
      type: 'article',
      source: 'twitter',
      sourceId: '2030455675357143260',
      title: null,
      text: 'Conflicting tweet evidence',
      url: 'https://x.com/example/status/2030455675357143261',
      publishedAt: '2026-04-28T01:03:00.000Z',
      metadata: {},
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Conflicting Twitter tweet evidence/);
  });

  test('rejects cached tweet evidence that conflicts with the submitted status URL', () => {
    const result = canonicalizeTwitterFeedItemForSubmit({
      id: 'canonicalize-cache-conflict',
      type: 'article',
      source: 'twitter',
      sourceId: '2030455675357143260',
      title: null,
      text: 'Conflicting cache evidence',
      url: 'https://x.com/example/status/2030455675357143260',
      publishedAt: '2026-04-28T01:03:00.000Z',
      metadata: {},
    }, {
      cachedPayload: {
        tweetId: '2030455675357143269',
        text: 'Different tweet',
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /2030455675357143260/);
    assert.match(result.error, /2030455675357143269/);
  });
});

describe('twitter canonicalization submit route', { concurrency: false }, () => {
  let originalCwd = '';
  let originalDataDir: string | undefined;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalPort: string | undefined;
  let originalOrchestratorUrl: string | undefined;
  let originalFeedNotifyUrl: string | undefined;
  let originalFetch: typeof fetch;
  let tempDir = '';
  let enqueuePayloads: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalStateDir = process.env.MEDIA_AGENT_STATE_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalPort = process.env.PORT;
    originalOrchestratorUrl = process.env.ORCHESTRATOR_INTERNAL_URL;
    originalFeedNotifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL;
    originalFetch = globalThis.fetch;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-twitter-submit-test-'));
    closeDb();

    process.chdir(originalCwd);
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_STATE_DIR = path.join(tempDir, 'agent-state');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
    process.env.PORT = '3171';
    process.env.ORCHESTRATOR_INTERNAL_URL = 'http://127.0.0.1:3171';
    process.env.INTERNAL_FEED_NOTIFY_URL = 'http://127.0.0.1:3171/api/internal/feed-notify';
    enqueuePayloads = [];

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};

      if (url.endsWith('/api/orchestrator/enqueue')) {
        enqueuePayloads.push(body);
        return new Response(JSON.stringify({
          ok: true,
          requestId: body.requestId,
          priority: body.priority,
          queueDepth: 1,
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    closeDb();
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);

    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;

    if (originalStateDir === undefined) delete process.env.MEDIA_AGENT_STATE_DIR;
    else process.env.MEDIA_AGENT_STATE_DIR = originalStateDir;

    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;

    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;

    if (originalOrchestratorUrl === undefined) delete process.env.ORCHESTRATOR_INTERNAL_URL;
    else process.env.ORCHESTRATOR_INTERNAL_URL = originalOrchestratorUrl;

    if (originalFeedNotifyUrl === undefined) delete process.env.INTERNAL_FEED_NOTIFY_URL;
    else process.env.INTERNAL_FEED_NOTIFY_URL = originalFeedNotifyUrl;

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('persists tweet-shaped Twitter articles as tweets before cache enrichment and batch routing', async () => {
    const tweetId = `2030455675357${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;
    const now = Date.now();
    const cachedPublishedAt = '2026-04-28T01:02:00.000Z';
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now,
      completedAtMs: now,
      status: 'completed',
      items: [{
        source: 'twitter',
        sourceId: tweetId,
        url: `https://x.com/example/status/${tweetId}`,
        title: 'Cached tweet title',
        authorUsername: 'example',
        authorDisplayName: 'Example User',
        publishedAtMs: Date.parse(cachedPublishedAt),
        fetchedAtMs: now,
        expiresAtMs: now + 60_000,
        payload: {
          tweetId,
          text: 'Cached tweet text',
          authorAvatarUrl: 'https://pbs.twimg.com/profile_images/example.jpg',
          metrics: {
            likes: 42,
            repostCount: 7,
            replyCount: 3,
          },
        },
      }],
    });

    const routeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/internal/curate/submit/route.ts')).href}?case=${Date.now()}-${randomUUID()}`;
    const routeModule = await import(routeModuleUrl) as SubmitRouteModule;

    const response = await routeModule.POST(new Request('http://127.0.0.1:3171/api/internal/curate/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          id: `ma-submit-twitter-${randomUUID()}`,
          type: 'article',
          source: 'twitter',
          sourceId: tweetId,
          title: 'Untitled article',
          text: 'Tweet text from curation',
          url: `https://x.com/example/status/${tweetId}`,
          authorUsername: 'example',
          publishedAt: cachedPublishedAt,
          metadata: {
            cycleId: 'twitter-canonicalization-route-test',
          },
        }],
      }),
    }));
    const body = await response.json() as {
      accepted?: number;
      errors?: Array<{ error?: string }>;
      acceptedIds?: string[];
    };

    assert.equal(response.status, 200);
    assert.equal(body.accepted, 1);
    assert.deepEqual(body.errors, []);

    const row = getDb().prepare(`
      SELECT type, source, source_id, title, author_avatar_url, metrics_likes, metrics_reposts, metrics_replies, metadata
      FROM feed
      WHERE source_id = ?
    `).get(tweetId) as {
      type: string;
      source: string | null;
      source_id: string;
      title: string | null;
      author_avatar_url: string | null;
      metrics_likes: number | null;
      metrics_reposts: number | null;
      metrics_replies: number | null;
      metadata: string | null;
    } | undefined;

    assert.ok(row);
    assert.equal(row.type, 'tweet');
    assert.equal(row.source, 'twitter');
    assert.equal(row.title, 'Cached tweet title');
    assert.equal(row.author_avatar_url, 'https://pbs.twimg.com/profile_images/example.jpg');
    assert.equal(row.metrics_likes, 42);
    assert.equal(row.metrics_reposts, 7);
    assert.equal(row.metrics_replies, 3);

    const metadata = JSON.parse(row.metadata ?? '{}') as {
      twitterCanonicalization?: { canonicalTweetId?: string };
      batchEnrichment?: { requestId?: string; status?: string; itemCount?: number };
    };
    assert.equal(metadata.twitterCanonicalization?.canonicalTweetId, tweetId);
    assert.equal(metadata.batchEnrichment?.status, 'queued');
    assert.equal(metadata.batchEnrichment?.itemCount, 1);
    assert.equal(enqueuePayloads.length, 1);
    assert.equal(enqueuePayloads[0]?.source, 'curation_submit_feed_enrichment');
    assert.deepEqual((enqueuePayloads[0]?.metadata as { postIds?: string[] } | undefined)?.postIds, body.acceptedIds);
  });

  test('assigns a stable thread color when submitting a fresh thread id', async () => {
    const routeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/internal/curate/submit/route.ts')).href}?case=${Date.now()}-${randomUUID()}`;
    const routeModule = await import(routeModuleUrl) as SubmitRouteModule;
    const threadId = `route-thread-${randomUUID()}`;
    const firstItemId = `ma-submit-thread-first-${randomUUID()}`;
    const secondItemId = `ma-submit-thread-second-${randomUUID()}`;

    const response = await routeModule.POST(new Request('http://127.0.0.1:3171/api/internal/curate/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            id: firstItemId,
            type: 'analysis',
            source: 'evogent',
            text: 'First thread analysis item',
            publishedAt: new Date().toISOString(),
            metadata: {
              cycleId: 'thread-color-route-test-a',
              thread: { threadId, threadTitle: 'Route thread color test' },
            },
          },
          {
            id: secondItemId,
            type: 'analysis',
            source: 'evogent',
            text: 'Second thread analysis item',
            publishedAt: new Date().toISOString(),
            metadata: {
              cycleId: 'thread-color-route-test-b',
              thread: { threadId, threadTitle: 'Route thread color test' },
            },
          },
        ],
      }),
    }));
    const body = await response.json() as { accepted?: number; errors?: Array<{ error?: string }> };

    assert.equal(response.status, 200);
    assert.equal(body.accepted, 2);
    assert.deepEqual(body.errors, []);

    const threadRow = getDb().prepare(`
      SELECT color
      FROM threads
      WHERE thread_id = ?
    `).get(threadId) as { color: string } | undefined;
    assert.deepEqual(threadRow, { color: 'blue' });

    const feedRows = getDb().prepare(`
      SELECT id, metadata
      FROM feed
      WHERE id IN (?, ?)
      ORDER BY id ASC
    `).all(firstItemId, secondItemId) as Array<{ id: string; metadata: string | null }>;
    assert.equal(feedRows.length, 2);

    for (const row of feedRows) {
      const metadata = JSON.parse(row.metadata ?? '{}') as { thread?: { threadId?: string; color?: string } };
      assert.equal(metadata.thread?.threadId, threadId);
      assert.equal(metadata.thread?.color, 'blue');
    }
  });
});
