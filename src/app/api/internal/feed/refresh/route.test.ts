import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { insertBenchItems, unconsumedBenchCount } from '@/lib/db/curation-bench';
import { getDb } from '@/lib/db/client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: { close: () => void };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/feed/refresh durable bench handoff', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-refresh-'));
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    getDb();
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  async function importRoute() {
    return import(`./route?t=${Date.now()}-${Math.random().toString(36).slice(2)}`) as Promise<{
      POST: (request: Request) => Promise<Response>;
    }>;
  }

  test('acknowledges a bench row only after its feed item is durable', async () => {
    const publishedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertBenchItems([{
      cycleId: 'bench-test',
      source: 'twitter',
      sourceId: '9876543210',
      score: 0.8,
      reason: 'Agent approved',
      itemJson: JSON.stringify({
        type: 'tweet',
        source: 'twitter',
        sourceId: '9876543210',
        url: 'https://x.com/example/status/9876543210',
        authorUsername: 'example',
        authorDisplayName: 'Example',
        publishedAt,
        text: 'A substantial agent-approved item for durable refresh testing.',
        metadata: {
          interest: { score: 0.8, durability: 'news', reason: 'Agent approved' },
          thread: {
            threadId: 'refresh-test-thread',
            threadTitle: 'Refresh test',
            threadRationale: 'Agent-approved near misses.',
          },
        },
      }),
    }]);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/feed/refresh', {
      method: 'POST',
      body: JSON.stringify({ harvest: false, limit: 1 }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ok: boolean;
      promoted: number;
      benchAcknowledged: number;
      benchRetained: number;
    };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.promoted, 1);
    assert.strictEqual(body.benchAcknowledged, 1);
    assert.strictEqual(body.benchRetained, 0);
    assert.strictEqual(unconsumedBenchCount(), 0);
  });

  test('quarantines a permanently rejected legacy bench row without blocking refresh', async () => {
    insertBenchItems([{
      cycleId: 'bench-test',
      source: 'twitter',
      sourceId: 'invalid-bench-row',
      score: 0.9,
      reason: 'Incomplete fixture',
      itemJson: JSON.stringify({
        type: 'tweet',
        source: 'twitter',
        sourceId: 'invalid-bench-row',
      }),
    }]);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/feed/refresh', {
      method: 'POST',
      body: JSON.stringify({ harvest: false, limit: 1 }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ok: boolean;
      benchAcknowledged: number;
      benchQuarantined: number;
      benchRetained: number;
    };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.benchAcknowledged, 0);
    assert.strictEqual(body.benchQuarantined, 1);
    assert.strictEqual(body.benchRetained, 0);
    assert.strictEqual(unconsumedBenchCount(), 0);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT quarantined_at_ms IS NOT NULL AS quarantined, last_error
        FROM curation_bench
        WHERE source_id = 'invalid-bench-row'
      `).get(),
      {
        quarantined: 1,
        last_error: 'Submission missing real publish date. Source <twitter> requires a published_at from the original source. Pull it from browse_cache_items.published_at_ms or fetch it from the URL before submitting.',
      },
    );
  });

  test('retains an unproven row when submit cannot attribute a permanent item error', async () => {
    insertBenchItems([{
      cycleId: 'bench-test',
      source: 'legacy',
      sourceId: 'unattributed-row',
      score: 0.9,
      reason: 'Legacy malformed row',
      itemJson: JSON.stringify({ type: 'tweet' }),
    }]);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/feed/refresh', {
      method: 'POST',
      body: JSON.stringify({ harvest: false, limit: 1 }),
    }));

    assert.strictEqual(response.status, 502);
    const body = await response.json() as {
      ok: boolean;
      benchQuarantined: number;
      benchRetained: number;
    };
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.benchQuarantined, 0);
    assert.strictEqual(body.benchRetained, 1);
    assert.strictEqual(unconsumedBenchCount(), 1);
  });
});
