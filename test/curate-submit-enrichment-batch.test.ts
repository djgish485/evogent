import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type SubmitRouteModule = {
  POST: (request: Request) => Promise<Response>;
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
    enrichmentMode?: string;
    itemCount?: number;
    postIds?: string[];
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
  let originalFetch: typeof fetch;
  let tempDir = '';
  let routeModule: SubmitRouteModule;
  let enqueuePayloads: EnqueuePayload[] = [];

  before(async () => {
    originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalStateDir = process.env.MEDIA_AGENT_STATE_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalPort = process.env.PORT;
    originalOrchestratorUrl = process.env.ORCHESTRATOR_INTERNAL_URL;
    originalFeedNotifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL;
    originalDisableBackgroundJobs = process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS;
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

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const routeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/internal/curate/submit/route.ts')).href}?case=${Date.now()}-${randomUUID()}`;
    routeModule = await import(routeModuleUrl) as SubmitRouteModule;
  });

  beforeEach(async () => {
    closeDb();
    enqueuePayloads = [];

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

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function writeBrainConfig(provider: 'claude' | 'codex', usageLevel: 'low' | 'medium') {
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

  async function submitTweets(count: number, provider: 'claude' | 'codex', usageLevel: 'low' | 'medium') {
    await writeBrainConfig(provider, usageLevel);

    const response = await routeModule.POST(new Request('http://127.0.0.1:3173/api/internal/curate/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: makeTweets(count) }),
    }));
    const body = await response.json() as SubmitResponse;

    assert.equal(response.status, 200);
    assert.equal(body.accepted, count);
    assert.deepEqual(body.errors, []);
    assert.equal(body.acceptedIds?.length, count);
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

  test('skips bulk enrichment for Low Claude', async () => {
    await submitTweets(16, 'claude', 'low');

    assert.deepEqual(enqueuePayloads, []);
  });

  test('skips bulk enrichment for Low Codex', async () => {
    await submitTweets(5, 'codex', 'low');

    assert.deepEqual(enqueuePayloads, []);
  });
});
