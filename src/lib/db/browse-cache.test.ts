import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './client';
import {
  SOURCE_SETUP_REFRESH_TRIGGERED_BY,
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
