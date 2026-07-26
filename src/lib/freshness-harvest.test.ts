import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { recordBrowseCacheRefresh, listBrowseCacheItems } from '@/lib/db/browse-cache';
import { getDb } from '@/lib/db/client';
import { unconsumedBenchCount } from '@/lib/db/curation-bench';
import { harvestFreshToBench } from '@/lib/freshness-harvest';

function closeDb() {
  const globalWithDb = globalThis as typeof globalThis & {
    evogentDb?: { close: () => void };
  };
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

describe('agent-judged freshness floor', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    closeDb();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-freshness-floor-'));
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    getDb();
  });

  afterEach(async () => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('benches only positively agent-judged rows and leaves the rest unconsumed', async () => {
    const now = Date.now();
    const common = {
      source: 'twitter',
      url: 'https://x.com/example/status/1234567890',
      authorUsername: 'example',
      authorDisplayName: 'Example',
      publishedAtMs: now - 10 * 60 * 1000,
      fetchedAtMs: now - 5 * 60 * 1000,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
    };
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 6 * 60 * 1000,
      completedAtMs: now - 5 * 60 * 1000,
      status: 'completed',
      itemsAdded: 3,
      items: [
        {
          ...common,
          sourceId: 'agent-approved',
          payload: { text: 'A substantial item the taste agent judged positively.', tasteScore: 8 },
        },
        {
          ...common,
          sourceId: 'agent-rejected',
          payload: { text: 'A low-value item the taste agent explicitly scored down.', tasteScore: 3 },
        },
        {
          ...common,
          sourceId: 'awaiting-agent',
          payload: { text: 'A fresh item that no agent has evaluated yet.' },
        },
      ],
    });

    const result = await harvestFreshToBench(12);

    assert.deepStrictEqual(result, {
      scanned: 3,
      awaitingJudgment: 1,
      withheldBelowThreshold: 1,
      benched: 1,
      bySource: { twitter: 1 },
    });
    assert.strictEqual(unconsumedBenchCount(), 1);

    const rows = listBrowseCacheItems({ source: 'twitter', includeExpired: true, limit: 10 });
    const seenById = new Map(rows.map((row) => [row.sourceId, row.seenByCurationAtMs]));
    assert.ok(seenById.get('agent-approved'));
    assert.strictEqual(seenById.get('agent-rejected'), null);
    assert.strictEqual(seenById.get('awaiting-agent'), null);

    const bench = getDb().prepare(`
      SELECT item_json
      FROM curation_bench
      WHERE consumed_at_ms IS NULL
    `).get() as { item_json: string };
    const item = JSON.parse(bench.item_json) as {
      metadata: { interest: { score: number }; tasteScore: number };
    };
    assert.strictEqual(item.metadata.interest.score, 0.8);
    assert.strictEqual(item.metadata.tasteScore, 8);
  });
});
