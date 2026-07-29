import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './client';
import {
  PHONE_BENCHMARK_SHARE_REFRESH_TRIGGERED_BY,
  PHONE_SOURCE_RECURRING_REFRESH_TRIGGERED_BY,
  SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY,
  SOURCE_SETUP_REFRESH_TRIGGERED_BY,
  activateSourceDiscoveryRun,
  cancelBrowseCacheSource,
  deleteBrowseCacheItemsForSource,
  discardUnactivatedSourceDiscoveryRun,
  getLatestBrowseCacheRefreshRun,
  getLatestBrowseCacheSourceSetupRun,
  listBrowseCacheItems,
  recordBrowseCacheRefresh,
} from './browse-cache';
function closeDb() {
  const globalWithDb = globalThis as typeof globalThis & { evogentDb?: { close: () => void } };
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

describe('browse cache refresh run timestamps', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';
  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    closeDb();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-browse-cache-test-'));
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('latest refresh ignores future-start rows that would hide newer valid rows', () => {
    const now = Date.now();
    const db = getDb();

    db.prepare(`
      INSERT INTO browse_cache_refresh_runs
        (id, source, triggered_by, started_at_ms, completed_at_ms, status, items_added)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'browse-cache-refresh-poison',
      'substack',
      'test',
      now + 5 * 24 * 60 * 60 * 1000,
      now - 2 * 24 * 60 * 60 * 1000,
      'completed',
      60,
    );

    const validRun = recordBrowseCacheRefresh({
      runId: 'browse-cache-refresh-valid',
      source: 'substack',
      triggeredBy: 'test',
      startedAtMs: now - 6 * 60 * 1000,
      completedAtMs: now - 5 * 60 * 1000,
      status: 'completed',
      itemsAdded: 12,
    });

    const latest = getLatestBrowseCacheRefreshRun('substack');
    assert.strictEqual(latest?.id, validRun.id);
    assert.strictEqual(latest?.completedAtMs, validRun.completedAtMs);
  });

  test('latest refresh ignores setup-smoke rows but setup evidence still sees them', () => {
    const now = Date.now();

    recordBrowseCacheRefresh({
      runId: 'setup-source-twitter-task-123',
      source: 'twitter',
      triggeredBy: SOURCE_SETUP_REFRESH_TRIGGERED_BY,
      startedAtMs: now - 10_000,
      completedAtMs: now - 9_000,
      status: 'completed',
      itemsAdded: 4,
    });

    assert.strictEqual(getLatestBrowseCacheRefreshRun('twitter'), null);

    const evidence = getLatestBrowseCacheSourceSetupRun('twitter');
    assert.strictEqual(evidence?.id, 'setup-source-twitter-task-123');

    const realRun = recordBrowseCacheRefresh({
      runId: 'browse-cache-refresh-twitter-real',
      source: 'twitter',
      triggeredBy: 'cache_scheduler:timer:twitter',
      startedAtMs: now - 1_000,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 20,
    });

    const latest = getLatestBrowseCacheRefreshRun('twitter');
    assert.strictEqual(latest?.id, realRun.id);
    assert.strictEqual(latest?.completedAtMs, realRun.completedAtMs);
  });

  test('recordBrowseCacheRefresh rejects impossible future, inverted, and incomplete runs', () => {
    const now = Date.now();

    assert.throws(() => {
      recordBrowseCacheRefresh({
        source: 'youtube',
        triggeredBy: 'test',
        startedAtMs: now + 10 * 60 * 1000,
        completedAtMs: now + 10 * 60 * 1000,
        status: 'completed',
      });
    }, /startedAtMs must not be more than 5 minutes in the future/);

    assert.throws(() => {
      recordBrowseCacheRefresh({
        source: 'hackernews',
        triggeredBy: 'test',
        startedAtMs: now,
        completedAtMs: now - 10 * 60 * 1000,
        status: 'completed',
      });
    }, /completedAtMs must not be before startedAtMs by more than 5 minutes/);

    assert.throws(() => {
      recordBrowseCacheRefresh({
        source: 'twitter',
        triggeredBy: 'test',
        startedAtMs: now,
        completedAtMs: null,
        status: 'completed',
      });
    }, /Completed browse cache refresh runs require completedAtMs/);
  });

  test('source discovery receipt counts server-accepted rows, not a declared count', () => {
    const now = Date.now();
    const runId = `source-discovery-${randomUUID()}`;
    getDb().prepare(`
      INSERT INTO browse_cache_items (
        source, source_id, title, payload_json, fetched_at_ms, expires_at_ms,
        seen_by_curation_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-source',
      'accepted-one',
      'Previously seen item',
      JSON.stringify({ text: 'Previously seen item' }),
      now - 10_000,
      now + 60_000,
      now - 5_000,
    );
    const run = recordBrowseCacheRefresh({
      runId,
      source: 'test-source',
      triggeredBy: SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY,
      startedAtMs: now - 1_000,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 999,
      items: [{
        source: 'test-source',
        sourceId: 'accepted-one',
        title: 'One server-accepted item',
        payload: {
          type: 'test-source',
          text: 'One server-accepted item',
          captureMethod: 'phone-source-discovery',
          discoveryRunId: runId,
        },
        fetchedAtMs: now,
        expiresAtMs: now + 60_000,
      }, {
        source: 'test-source',
        sourceId: '',
        title: 'Rejected because sourceId is empty',
        payload: { type: 'test-source' },
        fetchedAtMs: now,
        expiresAtMs: now + 60_000,
      }],
    });

    assert.strictEqual(run.itemsAdded, 1);
    assert.throws(() => recordBrowseCacheRefresh({
      runId,
      source: 'test-source',
      triggeredBy: SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY,
      startedAtMs: now,
      completedAtMs: now + 1,
      status: 'completed',
      items: [{
        source: 'test-source',
        sourceId: 'replacement',
        title: 'A replay must roll back this row',
        payload: {
          type: 'test-source',
          text: 'A replay must roll back this row',
          captureMethod: 'phone-source-discovery',
          discoveryRunId: runId,
        },
        fetchedAtMs: now,
        expiresAtMs: now + 60_000,
      }],
    }), /UNIQUE constraint failed: browse_cache_refresh_runs\.id/);
    assert.throws(() => recordBrowseCacheRefresh({
      runId,
      source: 'test-source',
      triggeredBy: 'phone-browse',
      startedAtMs: now,
      completedAtMs: now + 1,
      status: 'completed',
      itemsAdded: 42,
    }), /Browse cache refresh run identity is immutable/);
    const persistedRun = getLatestBrowseCacheRefreshRun('test-source');
    assert.strictEqual(persistedRun?.id, runId);
    assert.strictEqual(persistedRun?.itemsAdded, 1);
    assert.deepStrictEqual(
      listBrowseCacheItems({ source: 'test-source', includeExpired: true, limit: 10 }),
      [{
        source: 'test-source',
        sourceId: 'accepted-one',
        url: null,
        title: 'Previously seen item',
        authorUsername: null,
        authorDisplayName: null,
        publishedAtMs: null,
        payload: { text: 'Previously seen item' },
        fetchedAtMs: now - 10_000,
        expiresAtMs: now + 60_000,
        seenByCurationAtMs: now - 5_000,
      }],
      'unactivated discovery evidence must not replace the prior live row',
    );
    assert.strictEqual(
      (getDb().prepare(`
        SELECT COUNT(*) AS value
        FROM browse_cache_source_discovery_staging
        WHERE run_id = ?
      `).get(runId) as { value: number }).value,
      1,
    );
    const activation = activateSourceDiscoveryRun({
      source: 'test-source',
      runId,
      recipeSha256: 'a'.repeat(64),
    });
    assert.strictEqual(activation.itemsActivated, 1);
    assert.deepStrictEqual(
      listBrowseCacheItems({ source: 'test-source', includeExpired: true, limit: 10 })
        .map((entry) => ({
          sourceId: entry.sourceId,
          seenByCurationAtMs: entry.seenByCurationAtMs,
        })),
      [{ sourceId: 'accepted-one', seenByCurationAtMs: null }],
      'a newly activated capture must not inherit a prior row’s seen state',
    );
  });

  test('source discovery rejects cross-source, stale, expired, and empty completed evidence', () => {
    const now = Date.now();
    const base = {
      source: 'test-source',
      triggeredBy: SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY,
      startedAtMs: now - 1_000,
      completedAtMs: now,
      status: 'completed',
    };
    const item = {
      source: 'test-source',
      sourceId: 'attempt-bound',
      title: 'Attempt-bound item',
      payload: { type: 'test-source', text: 'Attempt-bound item' },
      fetchedAtMs: now - 500,
      expiresAtMs: now + 60_000,
    };

    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: `source-discovery-${randomUUID()}`,
      items: [{ ...item, source: 'other-source' }],
    }), /must match the attempt source/);
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: `source-discovery-${randomUUID()}`,
      items: [{ ...item, fetchedAtMs: now - 2_000 }],
    }), /must be fetched during the current attempt/);
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: `source-discovery-${randomUUID()}`,
      items: [{ ...item, expiresAtMs: now }],
    }), /must remain live after attempt completion/);
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: `source-discovery-${randomUUID()}`,
      items: [],
    }), /requires at least one valid current-attempt item/);

    const evidenceRunId = `source-discovery-${randomUUID()}`;
    const evidenceItem = {
      ...item,
      payload: {
        type: 'test-source',
        text: 'Attempt-bound item',
        captureMethod: 'phone-source-discovery',
        discoveryRunId: evidenceRunId,
      },
    };
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: evidenceRunId,
      items: [{
        ...evidenceItem,
        payload: { ...evidenceItem.payload, discoveryRunId: 'another-attempt' },
      }],
    }), /must carry the exact discovery run identity/);
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: evidenceRunId,
      items: [{
        ...evidenceItem,
        payload: { ...evidenceItem.payload, captureMethod: 'unknown' },
      }],
    }), /must carry the exact capture method/);
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: evidenceRunId,
      items: [{
        ...evidenceItem,
        title: '',
        payload: { ...evidenceItem.payload, text: '' },
      }],
    }), /must contain real title or text evidence/);
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: evidenceRunId,
      status: 'failed',
      items: [evidenceItem],
    }), /Non-completed source discovery runs may not publish cache items/);
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: evidenceRunId,
      error: 'contradictory completed error',
      items: [evidenceItem],
    }), /Completed source discovery runs may not carry an error/);
    assert.throws(() => recordBrowseCacheRefresh({
      ...base,
      runId: evidenceRunId,
      items: Array.from({ length: 101 }, (_, index) => ({
        ...evidenceItem,
        sourceId: `too-many-${index}`,
      })),
    }), /may submit at most 100 items/);
  });

  test('source opt-out removes every cached row for only the cancelled source', () => {
    const now = Date.now();
    for (const [source, sourceId] of [
      ['cancelled-source', 'cancelled-one'],
      ['kept-source', 'kept-one'],
    ]) {
      recordBrowseCacheRefresh({
        source,
        triggeredBy: 'phone-browse',
        startedAtMs: now - 1_000,
        completedAtMs: now,
        status: 'completed',
        items: [{
          source,
          sourceId,
          payload: { type: source, text: sourceId },
          fetchedAtMs: now,
          expiresAtMs: now + 60_000,
        }],
      });
    }

    assert.strictEqual(deleteBrowseCacheItemsForSource('cancelled-source'), 1);
    assert.deepStrictEqual(
      listBrowseCacheItems({ source: 'cancelled-source', includeExpired: true }),
      [],
    );
    assert.deepStrictEqual(
      listBrowseCacheItems({ source: 'kept-source', includeExpired: true })
        .map((entry) => entry.sourceId),
      ['kept-one'],
    );
  });

  test('source cancellation tombstone defeats late generic submits and activation', () => {
    const now = Date.now();
    const runId = `source-discovery-${randomUUID()}`;
    recordBrowseCacheRefresh({
      runId,
      source: 'cancelled-source',
      triggeredBy: SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY,
      startedAtMs: now - 1_000,
      completedAtMs: now,
      status: 'completed',
      items: [{
        source: 'cancelled-source',
        sourceId: 'staged-before-cancel',
        title: 'Staged before cancellation',
        payload: {
          text: 'Staged before cancellation',
          captureMethod: 'phone-source-discovery',
          discoveryRunId: runId,
        },
        fetchedAtMs: now - 100,
        expiresAtMs: now + 60_000,
      }],
    });
    const cancellation = cancelBrowseCacheSource('cancelled-source');
    assert.strictEqual(cancellation.stagedDeleted, 1);

    assert.throws(() => recordBrowseCacheRefresh({
      source: 'cancelled-source',
      triggeredBy: 'phone-browse',
      startedAtMs: now,
      completedAtMs: now + 1,
      status: 'completed',
      items: [{
        source: 'cancelled-source',
        sourceId: 'late-generic-row',
        title: 'Must not return after cancellation',
        payload: { text: 'Must not return after cancellation' },
        fetchedAtMs: now,
        expiresAtMs: now + 60_000,
      }],
    }), /Cancelled sources cannot publish browse-cache evidence/);
    assert.throws(() => activateSourceDiscoveryRun({
      source: 'cancelled-source',
      runId,
      recipeSha256: 'c'.repeat(64),
    }), /Cancelled sources cannot activate discovery evidence/);
    assert.deepStrictEqual(
      listBrowseCacheItems({ source: 'cancelled-source', includeExpired: true }),
      [],
    );
  });

  test('source discovery discard is exact and stale staging cannot activate', () => {
    const now = Date.now();
    const createStagedRun = (runId: string, sourceId: string) => recordBrowseCacheRefresh({
      runId,
      source: 'staged-source',
      triggeredBy: SOURCE_DISCOVERY_REFRESH_TRIGGERED_BY,
      startedAtMs: now - 1_000,
      completedAtMs: now,
      status: 'completed',
      items: [{
        source: 'staged-source',
        sourceId,
        title: sourceId,
        payload: {
          text: sourceId,
          captureMethod: 'phone-source-discovery',
          discoveryRunId: runId,
        },
        fetchedAtMs: now - 100,
        expiresAtMs: now + 60_000,
      }],
    });
    const firstRunId = `source-discovery-${randomUUID()}`;
    const secondRunId = `source-discovery-${randomUUID()}`;
    createStagedRun(firstRunId, 'first');
    createStagedRun(secondRunId, 'second');

    assert.strictEqual(
      discardUnactivatedSourceDiscoveryRun('staged-source', secondRunId),
      1,
    );
    assert.strictEqual(
      (getDb().prepare(`
        SELECT COUNT(*) AS value
        FROM browse_cache_source_discovery_staging
        WHERE run_id = ?
      `).get(firstRunId) as { value: number }).value,
      1,
    );

    getDb().prepare(`
      UPDATE browse_cache_source_discovery_staging
      SET expires_at_ms = ?
      WHERE run_id = ?
    `).run(now - 1, firstRunId);
    assert.throws(() => activateSourceDiscoveryRun({
      source: 'staged-source',
      runId: firstRunId,
      recipeSha256: 'd'.repeat(64),
    }), /incomplete, expired, or already consumed/);
  });

  test('recurring discovered sources require distinct exact worker-owned receipts', () => {
    const now = Date.now();
    const recordRecurring = (runId: string, startedAtMs: number, sourceId: string) => (
      recordBrowseCacheRefresh({
        runId,
        source: 'recurring-source',
        triggeredBy: PHONE_SOURCE_RECURRING_REFRESH_TRIGGERED_BY,
        startedAtMs,
        completedAtMs: startedAtMs + 100,
        status: 'completed',
        itemsAdded: 999,
        items: [{
          source: 'recurring-source',
          sourceId,
          title: sourceId,
          payload: {
            text: sourceId,
            captureMethod: 'phone-source-recurring',
            recurringRunId: runId,
          },
          fetchedAtMs: startedAtMs + 50,
          expiresAtMs: now + 60_000,
        }],
      })
    );
    const firstRunId = `phone-source-recurring-${randomUUID()}`;
    const secondRunId = `phone-source-recurring-${randomUUID()}`;
    assert.strictEqual(recordRecurring(firstRunId, now - 1_000, 'first').itemsAdded, 1);
    assert.strictEqual(recordRecurring(secondRunId, now - 500, 'second').itemsAdded, 1);
    assert.notStrictEqual(firstRunId, secondRunId);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT id
        FROM browse_cache_refresh_runs
        WHERE source = ?
        ORDER BY started_at_ms
      `).all('recurring-source'),
      [{ id: firstRunId }, { id: secondRunId }],
    );
    assert.throws(
      () => recordRecurring(firstRunId, now - 100, 'replay'),
      /UNIQUE constraint|immutable/,
    );
  });

  test('benchmark share receipts are insert-only and replay rolls back its item mutation', () => {
    const now = Date.now();
    const runId = `benchmark-share-${'a'.repeat(64)}`;
    const sourceId = 'AAAAAAAAAAA';
    const originalTitle = 'Original token-bound benchmark video';
    const replayTitle = 'Replay must not overwrite this cache row';
    const item = {
      source: 'youtube',
      sourceId,
      url: `https://www.youtube.com/watch?v=${sourceId}`,
      title: originalTitle,
      payload: { type: 'youtube', videoId: sourceId, title: originalTitle },
      fetchedAtMs: now,
      expiresAtMs: now + 60_000,
    };

    recordBrowseCacheRefresh({
      runId,
      source: 'youtube',
      triggeredBy: PHONE_BENCHMARK_SHARE_REFRESH_TRIGGERED_BY,
      startedAtMs: now,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 1,
      items: [item],
      metadata: { benchmarkShareProof: { tokenDigest: 'a'.repeat(64) } },
    });

    assert.throws(() => {
      recordBrowseCacheRefresh({
        runId,
        source: 'youtube',
        triggeredBy: PHONE_BENCHMARK_SHARE_REFRESH_TRIGGERED_BY,
        startedAtMs: now + 1,
        completedAtMs: now + 1,
        status: 'completed',
        itemsAdded: 1,
        items: [{
          ...item,
          title: replayTitle,
          payload: { ...item.payload, title: replayTitle },
          fetchedAtMs: now + 1,
        }],
        metadata: { benchmarkShareProof: { tokenDigest: 'b'.repeat(64) } },
      });
    }, /UNIQUE constraint failed: browse_cache_refresh_runs\.id/);
    assert.throws(() => {
      recordBrowseCacheRefresh({
        runId,
        source: 'youtube',
        // A replayer cannot bypass immutability by changing its incoming trigger.
        triggeredBy: 'phone-browse',
        startedAtMs: now + 2,
        completedAtMs: now + 2,
        status: 'completed',
        itemsAdded: 1,
        items: [{
          ...item,
          title: replayTitle,
          payload: { ...item.payload, title: replayTitle },
          fetchedAtMs: now + 2,
        }],
      });
    }, /Browse cache refresh run identity is immutable/);

    const persistedItem = listBrowseCacheItems({
      source: 'youtube',
      includeExpired: true,
      limit: 10,
    })[0];
    assert.strictEqual(persistedItem?.title, originalTitle);
    assert.strictEqual(persistedItem?.fetchedAtMs, now);
    const persistedRun = getDb().prepare(`
      SELECT started_at_ms, metadata_json
      FROM browse_cache_refresh_runs
      WHERE id = ?
    `).get(runId) as { started_at_ms: number; metadata_json: string };
    assert.strictEqual(persistedRun.started_at_ms, now);
    assert.deepStrictEqual(JSON.parse(persistedRun.metadata_json), {
      benchmarkShareProof: { tokenDigest: 'a'.repeat(64) },
    });
  });

  test('ordinary refresh run ids retain idempotent upsert semantics', () => {
    const now = Date.now();
    const runId = 'ordinary-idempotent-refresh';
    recordBrowseCacheRefresh({
      runId,
      source: 'youtube',
      triggeredBy: 'phone-browse',
      startedAtMs: now - 1,
      completedAtMs: now - 1,
      status: 'completed',
      itemsAdded: 1,
    });
    recordBrowseCacheRefresh({
      runId,
      source: 'youtube',
      triggeredBy: 'phone-browse',
      startedAtMs: now,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 2,
    });

    const persisted = getDb().prepare(`
      SELECT started_at_ms, items_added
      FROM browse_cache_refresh_runs
      WHERE id = ?
    `).get(runId) as { started_at_ms: number; items_added: number };
    assert.deepStrictEqual(persisted, {
      started_at_ms: now,
      items_added: 2,
    });
  });

  test('source setup evidence only accepts completed setup-smoke runs with rows', () => {
    const now = Date.now();

    recordBrowseCacheRefresh({
      runId: 'manual-local-scraper',
      source: 'twitter',
      triggeredBy: 'manual',
      startedAtMs: now - 5_000,
      completedAtMs: now - 4_000,
      status: 'completed',
      itemsAdded: 8,
    });
    recordBrowseCacheRefresh({
      runId: 'setup-source-twitter-empty',
      source: 'twitter',
      triggeredBy: SOURCE_SETUP_REFRESH_TRIGGERED_BY,
      startedAtMs: now - 3_000,
      completedAtMs: now - 2_000,
      status: 'completed',
      itemsAdded: 0,
    });
    recordBrowseCacheRefresh({
      runId: 'setup-source-twitter-task-123',
      source: 'twitter',
      triggeredBy: SOURCE_SETUP_REFRESH_TRIGGERED_BY,
      startedAtMs: now - 1_000,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 3,
    });

    const evidence = getLatestBrowseCacheSourceSetupRun('twitter');
    assert.strictEqual(evidence?.id, 'setup-source-twitter-task-123');
    assert.strictEqual(evidence?.itemsAdded, 3);
  });

  test('unfiltered item listing balances source slices and honors limits above 500', () => {
    const now = Date.now();
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO browse_cache_items (
        source,
        source_id,
        title,
        published_at_ms,
        payload_json,
        fetched_at_ms,
        expires_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const seed = (source: string, count: number, newestPublishedAtMs: number) => {
      for (let index = 0; index < count; index += 1) {
        const sourceId = `${source}-${index}`;
        insert.run(
          source,
          sourceId,
          `${source} item ${index}`,
          newestPublishedAtMs - index,
          JSON.stringify({ sourceId }),
          now - index,
          now + 60_000,
        );
      }
    };

    seed('twitter', 700, now + 3_000_000);
    seed('youtube', 650, now + 2_000_000);
    seed('substack', 220, now - 2_000_000);
    seed('hackernews', 154, now - 3_000_000);

    const items = listBrowseCacheItems({ limit: 1200 });
    const counts = items.reduce<Record<string, number>>((memo, item) => {
      memo[item.source] = (memo[item.source] ?? 0) + 1;
      return memo;
    }, {});

    assert.strictEqual(counts.twitter, 300);
    assert.strictEqual(counts.youtube, 300);
    assert.strictEqual(counts.substack, 220);
    assert.strictEqual(counts.hackernews, 154);
    assert.strictEqual(items.length, 974);

    const twitterOnly = listBrowseCacheItems({ source: 'twitter', limit: 600 });
    assert.strictEqual(twitterOnly.length, 600);
    assert.deepStrictEqual(
      twitterOnly.slice(0, 3).map((item) => item.sourceId),
      ['twitter-0', 'twitter-1', 'twitter-2'],
    );
  });

  test('submittable item listing can require published timestamps and exclude feed duplicates', () => {
    const now = Date.now();
    const db = getDb();
    const insertCacheItem = db.prepare(`
      INSERT INTO browse_cache_items (
        source,
        source_id,
        title,
        published_at_ms,
        payload_json,
        fetched_at_ms,
        expires_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertCacheItem.run(
      'hackernews',
      'fresh-unique',
      'Fresh unique story',
      now - 1_000,
      JSON.stringify({ sourceId: 'fresh-unique' }),
      now,
      now + 60_000,
    );
    insertCacheItem.run(
      'hackernews',
      'missing-published',
      'Missing published story',
      null,
      JSON.stringify({ sourceId: 'missing-published' }),
      now - 1,
      now + 60_000,
    );
    insertCacheItem.run(
      'hackernews',
      'already-in-feed',
      'Already in feed story',
      now - 2_000,
      JSON.stringify({ sourceId: 'already-in-feed' }),
      now - 2,
      now + 60_000,
    );
    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, url, published_at, created_at)
      VALUES (?, 'article', 'hackernews', 'already-in-feed', 'Existing feed story', 'Already accepted', 'https://example.com/already-in-feed', '2026-06-07T20:00:00.000Z', '2026-06-07T20:01:00.000Z')
    `).run(`existing-feed-${randomUUID()}`);

    const rawItems = listBrowseCacheItems({ source: 'hackernews', includeExpired: true, limit: 20 });
    assert.deepStrictEqual(
      new Set(rawItems.map((item) => item.sourceId)),
      new Set(['fresh-unique', 'missing-published', 'already-in-feed']),
    );

    const submittableItems = listBrowseCacheItems({
      source: 'hackernews',
      includeExpired: true,
      requirePublishedAt: true,
      excludeFeedDuplicates: true,
      limit: 20,
    });
    assert.deepStrictEqual(submittableItems.map((item) => item.sourceId), ['fresh-unique']);
  });

  test('twitter refresh canonicalizes prefixed source ids and keeps complete status-page text', () => {
    const now = Date.now();
    const tweetId = '2050638495291768849';

    const run = recordBrowseCacheRefresh({
      runId: 'browse-cache-refresh-twitter-text-audit',
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 1_000,
      completedAtMs: now,
      status: 'completed',
      metadata: {
        cycleSummary: {
          textCompletenessAudit: {
            tweetRowsAudited: 2,
            statusPageRecovered: 1,
            skippedIncomplete: 0,
            deduped: 1,
          },
        },
      },
      items: [
        {
          source: 'twitter',
          sourceId: `twitter:${tweetId}`,
          title: 'Timeline snippet',
          fetchedAtMs: now - 500,
          expiresAtMs: now + 60_000,
          payload: {
            text: 'There are some obvious ways culture can change but',
            textCapture: {
              textSource: 'timeline_card',
              completeness: 'incomplete',
            },
            cacheAudit: {
              textCompleteness: 'incomplete',
              recoveryFailed: true,
            },
          },
        },
        {
          source: 'twitter',
          sourceId: tweetId,
          title: 'Recovered status text',
          fetchedAtMs: now,
          expiresAtMs: now + 60_000,
          payload: {
            text: 'There are some obvious ways culture can change, but the mechanism is slower than people expect.',
            textCapture: {
              textSource: 'status_page',
              completeness: 'complete',
            },
          },
        },
      ],
    });

    assert.deepStrictEqual(run.metadata?.cycleSummary, {
      textCompletenessAudit: {
        tweetRowsAudited: 2,
        statusPageRecovered: 1,
        skippedIncomplete: 0,
        deduped: 1,
      },
    });
    assert.deepStrictEqual(run.metadata?.dedupeAudit, {
      canonicalSourceIdDuplicates: 1,
    });

    const items = listBrowseCacheItems({ source: 'twitter', includeExpired: true, limit: 20 });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0]?.sourceId, tweetId);
    assert.strictEqual(items[0]?.payload.sourceId, tweetId);
    assert.strictEqual(items[0]?.payload.text, 'There are some obvious ways culture can change, but the mechanism is slower than people expect.');
    assert.deepStrictEqual(items[0]?.payload.textCapture, {
      textSource: 'status_page',
      completeness: 'complete',
    });
  });
});
