import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { recordBrowseCacheRefresh } from '../src/lib/db/browse-cache';
import { getFeedItemById } from '../src/lib/db/feed';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type SubmitRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

type ManualEnrichRouteModule = {
  POST: (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
};

type SubmitResponse = {
  accepted?: number;
  errors?: Array<{ error?: string }>;
  acceptedIds?: string[];
};

type EnqueuePayload = {
  requestId?: string;
  priority?: string;
  source?: string;
  metadata?: {
    endpoint?: string;
    enrichmentMode?: string;
    itemCount?: number;
    postIds?: string[];
    trigger?: string;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

function closeDb() {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

describe('curate submit batch enrichment dispatch', { concurrency: false }, () => {
  let originalCwd = '';
  let originalDataDir: string | undefined;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalPort: string | undefined;
  let originalOrchestratorUrl: string | undefined;
  let originalFeedNotifyUrl: string | undefined;
  let originalDisableBackgroundJobs: string | undefined;
  let originalRuntimeProfile: string | undefined;
  let originalLegacyRuntimeProfile: string | undefined;
  let originalFetch: typeof fetch;
  let tempDir = '';
  let routeModule: SubmitRouteModule;
  let manualEnrichRouteModule: ManualEnrichRouteModule;
  let enqueuePayloads: EnqueuePayload[] = [];
  let feedNotifyPayloads: Array<Record<string, unknown>> = [];

  before(async () => {
    originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalStateDir = process.env.MEDIA_AGENT_STATE_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalPort = process.env.PORT;
    originalOrchestratorUrl = process.env.ORCHESTRATOR_INTERNAL_URL;
    originalFeedNotifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL;
    originalDisableBackgroundJobs = process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS;
    originalRuntimeProfile = process.env.EVOGENT_RUNTIME_PROFILE;
    originalLegacyRuntimeProfile = process.env.MEDIA_AGENT_RUNTIME_PROFILE;
    originalFetch = globalThis.fetch;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-curate-submit-enrichment-test-'));
    closeDb();

    process.chdir(originalCwd);
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_STATE_DIR = path.join(tempDir, 'agent-state');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
    process.env.PORT = '3173';
    process.env.ORCHESTRATOR_INTERNAL_URL = 'http://127.0.0.1:3173';
    process.env.INTERNAL_FEED_NOTIFY_URL = 'http://127.0.0.1:3173/api/internal/feed-notify';
    delete process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS;
    delete process.env.EVOGENT_RUNTIME_PROFILE;
    delete process.env.MEDIA_AGENT_RUNTIME_PROFILE;

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith('/api/orchestrator/enqueue')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as EnqueuePayload;
        enqueuePayloads.push(body);
        return new Response(JSON.stringify({
          ok: true,
          requestId: body.requestId,
          priority: body.priority,
          queueDepth: enqueuePayloads.length,
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/api/internal/feed-notify')) {
        feedNotifyPayloads.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const routeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/internal/curate/submit/route.ts')).href}?case=${Date.now()}-${randomUUID()}`;
    routeModule = await import(routeModuleUrl) as SubmitRouteModule;
    const manualEnrichRouteModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/feed/[id]/enrich/route.ts')).href}?case=${Date.now()}-${randomUUID()}`;
    manualEnrichRouteModule = await import(manualEnrichRouteModuleUrl) as ManualEnrichRouteModule;
  });

  beforeEach(async () => {
    closeDb();
    enqueuePayloads = [];
    feedNotifyPayloads = [];
    delete process.env.EVOGENT_RUNTIME_PROFILE;
    delete process.env.MEDIA_AGENT_RUNTIME_PROFILE;

    const dbPath = process.env.MEDIA_AGENT_DB_PATH;
    if (dbPath) {
      await fs.promises.rm(dbPath, { force: true });
      await fs.promises.rm(`${dbPath}-shm`, { force: true });
      await fs.promises.rm(`${dbPath}-wal`, { force: true });
    }
  });

  after(async () => {
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

    if (originalDisableBackgroundJobs === undefined) delete process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS;
    else process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS = originalDisableBackgroundJobs;

    if (originalRuntimeProfile === undefined) delete process.env.EVOGENT_RUNTIME_PROFILE;
    else process.env.EVOGENT_RUNTIME_PROFILE = originalRuntimeProfile;

    if (originalLegacyRuntimeProfile === undefined) delete process.env.MEDIA_AGENT_RUNTIME_PROFILE;
    else process.env.MEDIA_AGENT_RUNTIME_PROFILE = originalLegacyRuntimeProfile;

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function writeBrainConfig(provider: 'claude' | 'codex', usageLevel: 'low' | 'medium' | 'high') {
    const configPath = path.join(process.env.DATA_DIR ?? '', 'config.md');
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, [
      '# Evogent Test Config',
      '',
      '## Brain Provider',
      provider === 'codex' ? 'Codex CLI' : 'Claude Code',
      '',
      '## Usage Level',
      usageLevel,
      '',
    ].join('\n'), 'utf8');
  }

  function makeTweets(count: number) {
    const batchId = randomUUID();
    return Array.from({ length: count }, (_value, index) => {
      const itemId = `batch-enrichment-${batchId}-${index + 1}`;
      return {
        id: itemId,
        type: 'tweet',
        source: 'twitter',
        sourceId: itemId,
        text: `Tweet ${index + 1} for batch enrichment routing`,
        authorUsername: `author_${index + 1}`,
        publishedAt: '2026-04-25T09:04:00.000Z',
        metrics: {
          likes: 0,
          reposts: 0,
          replies: 0,
        },
        metadata: {
          cycleId: `batch-enrichment-test-${batchId}`,
        },
      };
    });
  }

  async function submitItems(
    items: ReturnType<typeof makeTweets>,
    provider: 'claude' | 'codex',
    usageLevel: 'low' | 'medium' | 'high',
  ): Promise<SubmitResponse> {
    await writeBrainConfig(provider, usageLevel);

    const response = await routeModule.POST(new Request('http://127.0.0.1:3173/api/internal/curate/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }));
    const body = await response.json() as SubmitResponse;

    assert.equal(response.status, 200);
    assert.equal(body.accepted, items.length);
    assert.deepEqual(body.errors, []);
    assert.equal(body.acceptedIds?.length, items.length);
    return body;
  }

  async function submitTweets(
    count: number,
    provider: 'claude' | 'codex',
    usageLevel: 'low' | 'medium' | 'high',
  ): Promise<SubmitResponse> {
    return submitItems(makeTweets(count), provider, usageLevel);
  }

  function assertEnqueueChunks(expectedItemCounts: number[]) {
    assert.equal(enqueuePayloads.length, expectedItemCounts.length);
    assert.deepEqual(
      enqueuePayloads.map((payload) => payload.metadata?.itemCount),
      expectedItemCounts,
    );
    assert.equal(
      new Set(enqueuePayloads.map((payload) => payload.requestId)).size,
      expectedItemCounts.length,
    );

    for (const [index, payload] of enqueuePayloads.entries()) {
      assert.equal(payload.priority, 'post_enrichment');
      assert.equal(payload.source, 'curation_submit_feed_enrichment');
      assert.equal(payload.metadata?.enrichmentMode, 'batch');
      assert.equal(payload.metadata?.postIds?.length, expectedItemCounts[index]);
      assert.match(payload.requestId ?? '', new RegExp(`chunk-${index + 1}-of-${expectedItemCounts.length}$`));
    }
  }

  test('splits 16 Medium Claude enrichment targets into four chunks', async () => {
    await submitTweets(16, 'claude', 'medium');

    assertEnqueueChunks([4, 4, 4, 4]);
  });

  test('splits 5 Medium Claude enrichment targets into 4 plus 1', async () => {
    await submitTweets(5, 'claude', 'medium');

    assertEnqueueChunks([4, 1]);
  });

  test('queues one chunk for one Medium Claude enrichment target', async () => {
    await submitTweets(1, 'claude', 'medium');

    assertEnqueueChunks([1]);
  });

  test('keeps non-phone High enrichment dispatch chunked', async () => {
    await submitTweets(5, 'codex', 'high');

    assertEnqueueChunks([4, 1]);
  });

  test('skips automatic Medium enrichment agents on phone while still delivering primary cards', async () => {
    process.env.EVOGENT_RUNTIME_PROFILE = 'phone';
    const body = await submitTweets(5, 'claude', 'medium');

    assert.deepEqual(enqueuePayloads, []);
    assert.equal(feedNotifyPayloads.length, 1);
    const deliveredItems = feedNotifyPayloads[0]?.items;
    assert.ok(Array.isArray(deliveredItems));
    assert.equal(deliveredItems.length, 5);
    assert.match(String((deliveredItems[0] as { text?: unknown }).text), /batch enrichment routing/);
    for (const id of body.acceptedIds ?? []) {
      const stored = getFeedItemById(id);
      assert.ok(stored);
      assert.equal((stored.metadata as Record<string, unknown> | null)?.batchEnrichment, undefined);
    }
  });

  test('skips automatic High enrichment agents on phone without queued metadata', async () => {
    process.env.EVOGENT_RUNTIME_PROFILE = 'phone';
    const body = await submitTweets(5, 'codex', 'high');

    assert.deepEqual(enqueuePayloads, []);
    for (const id of body.acceptedIds ?? []) {
      const stored = getFeedItemById(id);
      assert.ok(stored);
      assert.equal((stored.metadata as Record<string, unknown> | null)?.batchEnrichment, undefined);
    }
  });

  test('skips bulk enrichment for Low Claude', async () => {
    const body = await submitTweets(16, 'claude', 'low');

    assert.deepEqual(enqueuePayloads, []);
    for (const id of body.acceptedIds ?? []) {
      const stored = getFeedItemById(id);
      assert.ok(stored);
      assert.equal((stored.metadata as Record<string, unknown> | null)?.batchEnrichment, undefined);
    }
  });

  test('skips bulk enrichment for Low Codex', async () => {
    await submitTweets(5, 'codex', 'low');

    assert.deepEqual(enqueuePayloads, []);
  });

  test('excludes targets made complete by deterministic cache enrichment before dispatch', async () => {
    const items = makeTweets(3);
    const now = Date.now();
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now,
      completedAtMs: now,
      status: 'completed',
      items: items.map((item, index) => ({
        source: 'twitter',
        sourceId: item.sourceId,
        payload: {
          authorAvatarUrl: `https://example.com/avatar-${index + 1}.jpg`,
        },
        fetchedAtMs: now,
        expiresAtMs: now + 60_000,
      })),
    });

    const body = await submitItems(items, 'claude', 'medium');

    assert.deepEqual(enqueuePayloads, []);
    for (const [index, id] of (body.acceptedIds ?? []).entries()) {
      const stored = getFeedItemById(id);
      assert.ok(stored);
      assert.equal(stored.authorAvatarUrl, `https://example.com/avatar-${index + 1}.jpg`);
      assert.equal((stored.metadata as Record<string, unknown> | null)?.batchEnrichment, undefined);
    }
  });

  test('keeps manual full enrichment available on phone and queues it exactly once', async () => {
    process.env.EVOGENT_RUNTIME_PROFILE = 'phone';
    const body = await submitTweets(1, 'claude', 'medium');
    const id = body.acceptedIds?.[0];
    assert.ok(id);
    assert.deepEqual(enqueuePayloads, []);

    const response = await manualEnrichRouteModule.POST(
      new Request(`http://127.0.0.1:3173/api/feed/${encodeURIComponent(id)}/enrich`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ id }) },
    );
    const result = await response.json() as { ok?: boolean; postId?: string };

    assert.equal(response.status, 202);
    assert.equal(result.ok, true);
    assert.equal(result.postId, id);
    assert.equal(enqueuePayloads.length, 1);
    assert.equal(enqueuePayloads[0]?.metadata?.enrichmentMode, 'full');
    assert.equal(enqueuePayloads[0]?.metadata?.trigger, 'on_demand_enrichment');
  });
});
