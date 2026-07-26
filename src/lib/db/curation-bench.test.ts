import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './client';
import {
  ackBenchItems,
  insertBenchItems,
  peekBenchItems,
  quarantineBenchItems,
  unconsumedBenchCount,
} from './curation-bench';

function closeDb() {
  const globalWithDb = globalThis as typeof globalThis & {
    evogentDb?: { close: () => void };
  };
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

describe('curation bench acknowledgement', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    closeDb();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-bench-test-'));
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    getDb();
  });

  afterEach(async () => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('peek is retry-safe and acknowledgement is explicit', () => {
    insertBenchItems([{
      cycleId: 'cycle',
      source: 'twitter',
      sourceId: 'retry-safe',
      score: 0.8,
      reason: 'Agent approved',
      itemJson: JSON.stringify({ source: 'twitter', sourceId: 'retry-safe' }),
    }]);

    const first = peekBenchItems(10);
    const second = peekBenchItems(10);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(second.length, 1);
    assert.strictEqual(first[0].id, second[0].id);
    assert.strictEqual(unconsumedBenchCount(), 1);

    assert.strictEqual(ackBenchItems([first[0].id]), 1);
    assert.strictEqual(ackBenchItems([first[0].id]), 0);
    assert.strictEqual(unconsumedBenchCount(), 0);
  });

  test('malformed stored JSON is discarded without hiding valid rows', () => {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO curation_bench
        (cycle_id, source, source_id, score, reason, item_json, created_at_ms, consumed_at_ms)
      VALUES
        ('cycle', 'twitter', 'poison', 1, NULL, '{', ?, NULL),
        ('cycle', 'twitter', 'valid', 0.8, NULL, '{}', ?, NULL)
    `).run(now, now);

    const items = peekBenchItems(10);
    assert.deepStrictEqual(items.map((entry) => entry.sourceId), ['valid']);
    assert.strictEqual(unconsumedBenchCount(), 1);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT quarantined_at_ms IS NOT NULL AS quarantined, last_error
        FROM curation_bench
        WHERE source_id = 'poison'
      `).get(),
      { quarantined: 1, last_error: 'Malformed persisted item_json' },
    );
  });

  test('quarantine retains a rejection receipt and a corrected upsert reopens the row', () => {
    insertBenchItems([{
      cycleId: 'cycle',
      source: 'source',
      sourceId: 'repairable',
      score: 0.7,
      reason: 'First judgment',
      itemJson: '{}',
    }]);
    const [item] = peekBenchItems(1);
    assert.strictEqual(quarantineBenchItems([{ id: item.id, error: 'Permanent validation error' }]), 1);
    assert.strictEqual(unconsumedBenchCount(), 0);

    insertBenchItems([{
      cycleId: 'cycle-2',
      source: 'source',
      sourceId: 'repairable',
      score: 0.9,
      reason: 'Corrected judgment',
      itemJson: '{"fixed":true}',
    }]);

    assert.strictEqual(unconsumedBenchCount(), 1);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT quarantined_at_ms, last_error
        FROM curation_bench
        WHERE source_id = 'repairable'
      `).get(),
      { quarantined_at_ms: null, last_error: null },
    );
  });
});
