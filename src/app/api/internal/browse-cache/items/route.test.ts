import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { GET as getCarryForward } from '@/app/api/internal/curate/carry-forward/route';
import { getDb } from '@/lib/db/client';
import { insertBenchItems } from '@/lib/db/curation-bench';
import { GET } from './route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/browse-cache/items curation eligibility', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-browse-cache-items-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
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

  test('server-owned eligibility is read-only and preserves pending editorial state', async () => {
    const db = getDb();
    const nowMs = Date.now();
    const freshExpiryMs = nowMs + 10 * 60 * 1000;
    const acceptedSourceId = 'accepted-carry-forward-source';
    const insertCache = db.prepare(`
      INSERT INTO browse_cache_items (
        source,
        source_id,
        url,
        title,
        published_at_ms,
        payload_json,
        fetched_at_ms,
        expires_at_ms,
        seen_by_curation_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const addCache = (
      source: string,
      sourceId: string,
      payload: Record<string, unknown>,
      options: {
        expiresAtMs?: number;
        fetchedAtMs?: number;
        publishedAtMs?: number | null;
        seenAtMs?: number | null;
      } = {},
    ) => {
      const {
        expiresAtMs = freshExpiryMs,
        fetchedAtMs = nowMs - 1_000,
        publishedAtMs = nowMs - 2_000,
        seenAtMs = null,
      } = options;
      return insertCache.run(
        source,
        sourceId,
        `https://example.com/${sourceId}`,
        `Title ${sourceId}`,
        publishedAtMs,
        JSON.stringify(payload),
        fetchedAtMs,
        expiresAtMs,
        seenAtMs,
      );
    };

    addCache('twitter', 'eligible-held', {
      text: 'A fresh candidate explicitly held for the full curator.',
      shipmentJudgment: {
        decision: 'hold',
        rank: 0.75,
        reason: 'The lightweight pass left the final decision to the full curator.',
      },
    }, {
      fetchedAtMs: nowMs - 4_000,
      publishedAtMs: nowMs - 9_000,
    });
    addCache('twitter', 'eligible-unjudged', {
      text: 'A fresh candidate still awaiting any shipment judgment.',
    }, {
      fetchedAtMs: nowMs - 8_000,
      publishedAtMs: nowMs - 100,
    });
    addCache('twitter', 'eligible-null-published', {
      text: 'A fresh candidate remains eligible even without optional publish metadata.',
    }, {
      fetchedAtMs: nowMs - 6_000,
      publishedAtMs: null,
    });
    addCache('hackernews', 'eligible-other-source', {
      text: 'A fresh unseen candidate from another source.',
    }, {
      fetchedAtMs: nowMs - 2_000,
      publishedAtMs: nowMs - 500,
    });
    addCache('twitter', 'excluded-seen', {
      text: 'This candidate was already consumed by curation.',
    }, {
      fetchedAtMs: nowMs - 7_000,
      seenAtMs: nowMs - 500,
    });
    addCache('twitter', 'excluded-expired', {
      text: 'This unseen candidate is outside the cache eligibility window.',
    }, {
      expiresAtMs: nowMs - 1,
      fetchedAtMs: nowMs - 10_000,
    });
    addCache('twitter', acceptedSourceId, {
      text: 'This source item is already represented by a durable feed row.',
    }, {
      fetchedAtMs: nowMs - 3_000,
    });

    const createdAt = new Date(nowMs - 3_000).toISOString();
    db.prepare(`
      INSERT INTO feed (
        id,
        type,
        source,
        source_id,
        title,
        text,
        reason,
        metadata,
        display_order,
        published_at,
        created_at,
        created_at_ms
      )
      VALUES (?, 'tweet', 'twitter', ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      'accepted-carry-forward-feed',
      acceptedSourceId,
      'A durable accepted item',
      'The accepted source evidence remains available as carry-forward.',
      'The prior curator explicitly shipped it.',
      JSON.stringify({
        interest: { score: 0.9, durability: 'evergreen' },
        shipment: {
          id: 'shipment-accepted-carry-forward-source',
          decision: 'ship',
          rank: 0.9,
          reason: 'The prior curator explicitly shipped it.',
        },
      }),
      createdAt,
      createdAt,
      nowMs - 3_000,
    );

    insertBenchItems([{
      cycleId: 'curation-cycle-pending-bench',
      source: 'hackernews',
      sourceId: 'pending-bench-source',
      score: 0.8,
      reason: 'Qualified near-miss retained for the next deterministic refresh.',
      itemJson: JSON.stringify({
        type: 'article',
        source: 'hackernews',
        sourceId: 'pending-bench-source',
        title: 'Pending bench item',
        text: 'A submit-ready bench item must not be consumed by a cache GET.',
      }),
    }]);

    const cacheBefore = db.prepare(`
      SELECT
        source_id,
        published_at_ms,
        fetched_at_ms,
        expires_at_ms,
        seen_by_curation_at_ms,
        payload_json
      FROM browse_cache_items
      ORDER BY source_id
    `).all();
    const benchBefore = db.prepare(`
      SELECT source, source_id, consumed_at_ms, quarantined_at_ms, last_error
      FROM curation_bench
      ORDER BY source_id
    `).all();
    const carryBeforeResponse = await getCarryForward(
      new Request('http://127.0.0.1/api/internal/curate/carry-forward?limit=5'),
    );
    const carryBefore = await carryBeforeResponse.json() as {
      candidates: Array<{ id: string }>;
    };

    const response = await GET(new Request(
      'http://127.0.0.1/api/internal/browse-cache/items'
      + '?eligibleForCuration=1'
      + '&source=twitter'
      + '&includeExpired=1'
      + `&freshAfterMs=${nowMs + 24 * 60 * 60 * 1000}`
      + '&unseenFirst=1'
      + '&excludeFeedDuplicates=false'
      + '&requirePublishedAt=1'
      + '&limit=1',
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      ok: boolean;
      count: number;
      items: Array<{
        sourceId: string;
        publishedAtMs: number | null;
        seenByCurationAtMs: number | null;
        payload: Record<string, unknown>;
      }>;
    };

    assert.equal(body.ok, true);
    assert.equal(body.count, 4);
    assert.deepEqual(
      body.items.map((item) => item.sourceId),
      [
        'eligible-unjudged',
        'eligible-null-published',
        'eligible-held',
        'eligible-other-source',
      ],
    );
    assert.notDeepEqual(
      body.items.map((item) => item.sourceId),
      [
        'eligible-unjudged',
        'eligible-other-source',
        'eligible-null-published',
        'eligible-held',
      ],
      'eligibleForCuration must use stable fetched-at evidence order, not unseenFirst newest order',
    );
    assert.ok(body.items.every((item) => item.seenByCurationAtMs === null));
    assert.equal(
      body.items.find((item) => item.sourceId === 'eligible-null-published')?.publishedAtMs,
      null,
      'requirePublishedAt is a hostile legacy hint and cannot narrow the full curator evidence set',
    );
    const futureCutoffResponse = await GET(new Request(
      'http://127.0.0.1/api/internal/browse-cache/items'
      + '?eligibleForCuration=1'
      + `&freshAfterMs=${nowMs + 24 * 60 * 60 * 1000}`
      + '&unseenFirst=1'
      + '&requirePublishedAt=1'
      + '&limit=1',
    ));
    assert.equal(futureCutoffResponse.status, 200);
    const futureCutoffBody = await futureCutoffResponse.json() as {
      items: Array<{ sourceId: string }>;
    };
    assert.deepEqual(
      futureCutoffBody.items.map((item) => item.sourceId),
      body.items.map((item) => item.sourceId),
      'a future legacy freshness cutoff cannot suppress server-owned curation evidence',
    );
    const held = body.items.find((item) => item.sourceId === 'eligible-held');
    const unjudged = body.items.find((item) => item.sourceId === 'eligible-unjudged');
    assert.equal(
      (held?.payload.shipmentJudgment as { decision?: unknown } | undefined)?.decision,
      'hold',
    );
    assert.equal(unjudged?.payload.shipmentJudgment, undefined);

    const legacyResponse = await GET(new Request(
      'http://127.0.0.1/api/internal/browse-cache/items'
      + '?source=twitter&includeExpired=1&limit=20',
    ));
    const legacyBody = await legacyResponse.json() as {
      items: Array<{ sourceId: string }>;
    };
    assert.deepEqual(
      new Set(legacyBody.items.map((item) => item.sourceId)),
      new Set([
        'eligible-held',
        'eligible-unjudged',
        'eligible-null-published',
        'excluded-seen',
        'excluded-expired',
        acceptedSourceId,
      ]),
    );

    const carryAfterResponse = await getCarryForward(
      new Request('http://127.0.0.1/api/internal/curate/carry-forward?limit=5'),
    );
    const carryAfter = await carryAfterResponse.json() as {
      candidates: Array<{ id: string }>;
    };
    const cacheAfter = db.prepare(`
      SELECT
        source_id,
        published_at_ms,
        fetched_at_ms,
        expires_at_ms,
        seen_by_curation_at_ms,
        payload_json
      FROM browse_cache_items
      ORDER BY source_id
    `).all();
    const benchAfter = db.prepare(`
      SELECT source, source_id, consumed_at_ms, quarantined_at_ms, last_error
      FROM curation_bench
      ORDER BY source_id
    `).all();

    assert.deepEqual(cacheAfter, cacheBefore);
    assert.deepEqual(benchAfter, benchBefore);
    assert.deepEqual(carryAfter.candidates, carryBefore.candidates);
    assert.deepEqual(
      carryAfter.candidates.map((candidate) => candidate.id),
      ['accepted-carry-forward-feed'],
    );
  });
});
