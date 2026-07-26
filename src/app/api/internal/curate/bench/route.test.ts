import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: { close: () => void };
};

const globalWithDb = globalThis as GlobalWithDb;

function closeDb() {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

describe('/api/internal/curate/bench', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    closeDb();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-bench-route-'));
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    getDb();
  });

  afterEach(async () => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('persists judged, submit-ready singleton near-misses without inventing threads', async () => {
    const { POST } = await import(`./route?t=${Date.now()}`);
    const validItem = {
      type: 'article',
      source: 'unit-test',
      sourceId: 'near-miss-valid',
      title: 'A qualified near miss',
      text: 'A substantive source-owned synopsis that is ready for later submission.',
      publishedAt: '2026-07-24T12:00:00.000Z',
      metadata: {
        interest: { score: 0.83, durability: 'dated' },
      },
    };

    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cycleId: 'cycle-test-1',
        items: [
          { item: validItem, score: 0.83, reason: 'Qualified, but the current slate had no slot.' },
          {
            item: {
              ...validItem,
              sourceId: 'score-mismatch',
            },
            score: 0.5,
            reason: 'The ranking score cannot contradict the persisted judgment.',
          },
          {
            item: {
              ...validItem,
              sourceId: 'invalid-published-at',
              publishedAt: 'not-a-date',
            },
            score: 0.83,
            reason: 'Invalid source time is not submit-ready.',
          },
        ],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const result = await response.json() as {
      ok: boolean;
      benched: number;
      rejected: number;
      errors: string[];
    };
    assert.deepStrictEqual(
      { ok: result.ok, benched: result.benched, rejected: result.rejected },
      { ok: false, benched: 1, rejected: 2 },
    );
    assert.match(result.errors.join('\n'), /must match/);
    assert.match(result.errors.join('\n'), /publishedAt/);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT source_id, score, json_extract(item_json, '$.metadata.thread') AS thread
        FROM curation_bench
        WHERE consumed_at_ms IS NULL
      `).all(),
      [{ source_id: 'near-miss-valid', score: 0.83, thread: null }],
    );
  });

  test('rejects an untraceable cycle and out-of-range score', async () => {
    const { POST } = await import(`./route?t=${Date.now() + 1}`);
    const missingCycle = await POST(new Request('http://127.0.0.1/api/internal/curate/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{}] }),
    }));
    assert.strictEqual(missingCycle.status, 400);

    const nullBody = await POST(new Request('http://127.0.0.1/api/internal/curate/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    }));
    assert.strictEqual(nullBody.status, 400);

    const tooMany = await POST(new Request('http://127.0.0.1/api/internal/curate/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cycleId: 'cycle-too-many',
        items: Array.from({ length: 26 }, () => ({})),
      }),
    }));
    assert.strictEqual(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /at most 25/);

    const invalidScore = await POST(new Request('http://127.0.0.1/api/internal/curate/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cycleId: 'cycle-test-2',
        items: [{
          score: 1.2,
          reason: 'Invalid ranking.',
          item: {
            type: 'tweet',
            source: 'unit-test',
            sourceId: 'too-high',
            text: 'A sufficiently substantive test post.',
            metadata: {
              interest: { score: 1, durability: 'news' },
              threadId: 'singleton-too-high',
            },
          },
        }],
      }),
    }));
    assert.strictEqual(invalidScore.status, 200);
    assert.deepStrictEqual(
      await invalidScore.json(),
      {
        ok: false,
        benched: 0,
        rejected: 1,
        errors: ['items[0].score must be a number between 0 and 1'],
        unconsumedBenchCount: 0,
      },
    );
  });
});
