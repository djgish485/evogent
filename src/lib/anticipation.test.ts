import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  DEFAULT_ANTICIPATION_WEIGHTS,
  computeAnticipationScore,
  getUnresolvedMissTopics,
  insertAnticipationEvent,
  listAnticipationEvents,
  sanitizeTopics,
} from './anticipation';
import { getDb } from './db/client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('anticipation engine', () => {
  let tempDir: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-anticipation-test-'));
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      globalWithDb.evogentDb = undefined;
    }
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      globalWithDb.evogentDb = undefined;
    }
    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('sanitizeTopics lowercases, dedupes, and caps topics', () => {
    assert.deepStrictEqual(
      sanitizeTopics([' Regional Transit ', 'regional transit', 'Materials research', 42, '']),
      ['regional transit', 'materials research'],
    );
  });

  test('insert + list round-trips a demand event', () => {
    const event = insertAnticipationEvent({
      tier: 'miss',
      topics: ['regional transit schedule'],
      sourceHint: 'youtube',
      waitedMs: 240_000,
      note: 'requested schedule details; live browse needed',
    });
    assert.strictEqual(event.tier, 'miss');
    assert.deepStrictEqual(event.topics, ['regional transit schedule']);

    const events = listAnticipationEvents({ days: 1 });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].sourceHint, 'youtube');
    assert.strictEqual(events[0].waitedMs, 240_000);
  });

  test('score combines demand tiers and engagement with default weights', () => {
    insertAnticipationEvent({ tier: 'feed_hit', topics: ['topic alpha'] });
    insertAnticipationEvent({ tier: 'cache_hit', topics: ['topic beta'] });
    insertAnticipationEvent({ tier: 'miss', topics: ['regional transit schedule'] });

    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, title, text, published_at)
      VALUES ('feed-item-1', 'tweet', 'twitter', 't', 'body', datetime('now'))
    `).run();
    db.prepare(`INSERT INTO interactions (feed_item_id, action) VALUES ('feed-item-1', 'expand')`).run();
    db.prepare(`INSERT INTO interactions (feed_item_id, action) VALUES ('feed-item-1', 'thumbsup')`).run();
    db.prepare(`INSERT INTO interactions (feed_item_id, action) VALUES ('feed-item-1', 'view')`).run();

    const score = computeAnticipationScore({ days: 7 });
    const w = DEFAULT_ANTICIPATION_WEIGHTS;
    const expected = w.feedHit + w.cacheHit + w.miss + w.expand + w.thumbsup; // view is neutral
    assert.strictEqual(score.score, expected);
    assert.deepStrictEqual(
      { feedHits: score.demand.feedHits, cacheHits: score.demand.cacheHits, misses: score.demand.misses },
      { feedHits: 1, cacheHits: 1, misses: 1 },
    );
    assert.strictEqual(score.demand.demandHitRate, 0.67);
    assert.strictEqual(score.engagement.view, undefined);
    assert.strictEqual(score.engagement.expand, 1);
    // No cache rows inserted, so no pollution: adjusted equals raw.
    assert.strictEqual(score.adjustedScore, expected);
    assert.strictEqual(score.cache.total, 0);
    // feed_hit saves a full live browse (3 min); cache_hit here had no waited_ms so saves 3 min too.
    assert.strictEqual(score.timeSavedMinutes, 6);
  });

  test('cache pollution penalizes the adjusted score for wasted prefetches', () => {
    insertAnticipationEvent({ tier: 'feed_hit', topics: ['topic alpha'] });
    const db = getDb();
    const now = Date.now();
    // Two cached items: one consumed by curation, one expired unused (waste).
    db.prepare(`
      INSERT INTO browse_cache_items (source, source_id, payload_json, fetched_at_ms, expires_at_ms, seen_by_curation_at_ms)
      VALUES ('youtube', 'used-1', '{}', ?, ?, ?)
    `).run(now - 1000, now + 3_600_000, now);
    db.prepare(`
      INSERT INTO browse_cache_items (source, source_id, payload_json, fetched_at_ms, expires_at_ms, seen_by_curation_at_ms)
      VALUES ('youtube', 'wasted-1', '{}', ?, ?, NULL)
    `).run(now - 1000, now - 1);

    const score = computeAnticipationScore({ days: 7 });
    assert.strictEqual(score.cache.total, 2);
    assert.strictEqual(score.cache.wastedItems, 1);
    assert.strictEqual(score.cache.cachePollutionRate, 0.5);
    assert.strictEqual(score.adjustedScore, score.score - 0.5);
  });

  test('unresolved miss topics exclude topics later anticipated and rank by miss count', () => {
    insertAnticipationEvent({ tier: 'miss', topics: ['regional transit schedule'], sourceHint: 'youtube' });
    insertAnticipationEvent({ tier: 'miss', topics: ['regional transit schedule'] });
    insertAnticipationEvent({ tier: 'miss', topics: ['local weather alerts'] });
    // This topic was later served from cache — anticipation caught up; drop it from hints.
    insertAnticipationEvent({ tier: 'miss', topics: ['software release calendar'] });
    insertAnticipationEvent({ tier: 'cache_hit', topics: ['software release calendar'] });

    const missed = getUnresolvedMissTopics({ days: 3, limit: 5 });
    assert.deepStrictEqual(missed.map((entry) => entry.topic), ['regional transit schedule', 'local weather alerts']);
    assert.strictEqual(missed[0].missCount, 2);
    assert.strictEqual(missed[0].sourceHint, 'youtube');
  });
});
