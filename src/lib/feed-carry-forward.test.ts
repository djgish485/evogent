import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import {
  type FeedCarryForwardCandidate,
  listFeedCarryForwardCandidates,
  recordCarryForwardPromotions,
  selectCarryForwardPromotions,
} from './feed-carry-forward';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('listFeedCarryForwardCandidates', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-carry-forward-test-'));

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

  test('reviews all unviewed rows and ranks older high-signal items above newer bland rows', () => {
    const db = getDb();
    const nowMs = Date.UTC(2026, 5, 7, 12, 0, 0);
    const insert = db.prepare(`
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
        parent_id,
        published_at,
        created_at,
        created_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `);

    for (let index = 0; index < 60; index += 1) {
      const createdAtMs = nowMs - (index + 1) * 60 * 1000;
      const createdAt = new Date(createdAtMs).toISOString();
      insert.run(
        `newer-bland-${String(index).padStart(2, '0')}`,
        'article',
        'unit-test',
        `newer-${index}`,
        `Newer bland ${index}`,
        'Body',
        'Fresh',
        JSON.stringify({}),
        null,
        createdAt,
        createdAt,
        createdAtMs,
      );
    }

    const olderCreatedAtMs = nowMs - 120 * 24 * 60 * 60 * 1000;
    const olderCreatedAt = new Date(olderCreatedAtMs).toISOString();
    insert.run(
      'older-high-signal',
      'article',
      'unit-test',
      'older-high-signal-source',
      'Older high-signal item',
      'Body',
      'This directly matches a durable user preference and still needs attention.',
      JSON.stringify({
        bridge: 'Unseen but important background for the current feed.',
        thread: {
          threadId: 'durable-old-signal',
          threadTitle: 'Durable old signal',
          threadRationale: 'Accepted earlier and still unread despite being older.',
          prominence: { level: 'high' },
        },
        preferenceMatch: { relevanceScore: 0.92 },
      }),
      42,
      olderCreatedAt,
      olderCreatedAt,
      olderCreatedAtMs,
    );

    const candidates = listFeedCarryForwardCandidates({
      includeAllUnviewed: true,
      includeDisplayed: true,
      limit: 5,
      nowMs,
    });

    assert.strictEqual(candidates.review.includeAllUnviewed, true);
    assert.strictEqual(candidates.review.includeDisplayed, true);
    assert.strictEqual(candidates.review.eligibleCount, 61);
    assert.strictEqual(candidates.review.reviewedCount, 61);
    assert.strictEqual(candidates.review.returnedCount, 5);
    assert.strictEqual(candidates[0]?.id, 'older-high-signal');
    assert.ok((candidates[0]?.score ?? 0) > (candidates[1]?.score ?? 0));
    assert.deepStrictEqual(candidates.review.topCandidateIds[0], 'older-high-signal');
  });

  test('includeAllUnviewed reviews every eligible row even when reviewLimit is smaller', () => {
    const db = getDb();
    const nowMs = Date.UTC(2026, 5, 7, 12, 0, 0);
    const insert = db.prepare(`
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
        parent_id,
        published_at,
        created_at,
        created_at_ms
      )
      VALUES (?, 'article', 'unit-test', ?, ?, 'Body', ?, ?, NULL, NULL, ?, ?, ?)
    `);

    for (let index = 0; index < 6; index += 1) {
      const createdAtMs = nowMs - index * 60 * 1000;
      const createdAt = new Date(createdAtMs).toISOString();
      insert.run(
        `newer-low-${index}`,
        `newer-low-${index}`,
        `Newer low signal ${index}`,
        'Fresh but thin.',
        JSON.stringify({}),
        createdAt,
        createdAt,
        createdAtMs,
      );
    }

    const olderCreatedAtMs = nowMs - 180 * 24 * 60 * 60 * 1000;
    const olderCreatedAt = new Date(olderCreatedAtMs).toISOString();
    insert.run(
      'very-old-high-signal',
      'very-old-high-signal-source',
      'Very old high signal',
      'This older unviewed item should still be scored before a shortlist is returned.',
      JSON.stringify({
        bridge: 'Old but still directly relevant.',
        preferenceMatch: { relevanceScore: 0.95 },
        thread: {
          threadId: 'very-old-signal',
          threadTitle: 'Very old signal',
          threadRationale: 'Every unviewed row must be reviewed before ranking.',
          prominence: { level: 'high' },
        },
      }),
      olderCreatedAt,
      olderCreatedAt,
      olderCreatedAtMs,
    );

    const candidates = listFeedCarryForwardCandidates({
      includeAllUnviewed: true,
      reviewLimit: 2,
      limit: 3,
      nowMs,
    });

    assert.strictEqual(candidates.review.eligibleCount, 7);
    assert.strictEqual(candidates.review.reviewedCount, 7);
    assert.strictEqual(candidates.review.reviewLimit, 7);
    assert.strictEqual(candidates.review.returnedCount, 3);
    assert.strictEqual(candidates[0]?.id, 'very-old-high-signal');
    assert.deepStrictEqual(candidates.review.topCandidateIds[0], 'very-old-high-signal');
  });

  test('curator interest outranks sheer age once the age curve plateaus', () => {
    const db = getDb();
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const insert = db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at, created_at_ms)
      VALUES (?, 'article', 'unit-test', ?, ?, 'Body', ?, ?, NULL, NULL, ?, ?, ?)
    `);

    const richMetadata = {
      bridge: 'Shared editorial framing for both items.',
      thread: {
        threadId: 'shared-thread',
        threadTitle: 'Shared thread',
        threadRationale: 'Both items carry the same editorial weight.',
      },
      preferenceMatch: { relevanceScore: 0.8 },
    };

    const ancientMs = nowMs - 120 * 24 * 60 * 60 * 1000;
    const ancientAt = new Date(ancientMs).toISOString();
    insert.run(
      'ancient-no-interest',
      'ancient-no-interest',
      'Ancient item without curator interest',
      'This item has waited a very long time without being viewed.',
      JSON.stringify(richMetadata),
      ancientAt,
      ancientAt,
      ancientMs,
    );

    const recentMs = nowMs - 2 * 24 * 60 * 60 * 1000;
    const recentAt = new Date(recentMs).toISOString();
    insert.run(
      'recent-high-interest',
      'recent-high-interest',
      'Recent item the curator rated durable',
      'This item directly matches a durable interest of the user.',
      JSON.stringify({ ...richMetadata, interest: { score: 0.9, reason: 'durable mechanism story' } }),
      recentAt,
      recentAt,
      recentMs,
    );

    const candidates = listFeedCarryForwardCandidates({ includeAllUnviewed: true, limit: 5, nowMs });
    assert.strictEqual(candidates[0]?.id, 'recent-high-interest');
    assert.ok((candidates[0]?.scoreBreakdown.curatorInterest ?? 0) > 0.8);
    // Beyond the 48h plateau both items have the same age score.
    assert.strictEqual(candidates[0]?.scoreBreakdown.age, candidates[1]?.scoreBreakdown.age);
  });

  test('repeated unviewed promotions decay an item behind an equal fresh competitor', () => {
    const db = getDb();
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const insert = db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at, created_at_ms)
      VALUES (?, 'article', 'unit-test', ?, ?, 'Body', ?, ?, NULL, NULL, ?, ?, ?)
    `);

    const createdMs = nowMs - 30 * 24 * 60 * 60 * 1000;
    const createdAt = new Date(createdMs).toISOString();
    const sharedMetadata = {
      bridge: 'Identical editorial framing for the rotation test.',
      preferenceMatch: { relevanceScore: 0.85 },
    };
    insert.run(
      'promoted-three-times',
      'promoted-three-times',
      'Already promoted repeatedly',
      'Strong reason that has not earned a view in three promotions.',
      JSON.stringify({ ...sharedMetadata, carryForward: { promotedCount: 3, lastPromotedAtMs: nowMs - 1000 } }),
      createdAt,
      createdAt,
      createdMs,
    );
    insert.run(
      'never-promoted',
      'never-promoted',
      'Never promoted before',
      'Equally strong reason that has never had a slate slot.',
      JSON.stringify(sharedMetadata),
      createdAt,
      createdAt,
      createdMs,
    );

    const candidates = listFeedCarryForwardCandidates({ includeAllUnviewed: true, limit: 5, nowMs });
    assert.strictEqual(candidates[0]?.id, 'never-promoted');
    assert.strictEqual(candidates[1]?.id, 'promoted-three-times');
    assert.ok((candidates[1]?.scoreBreakdown.promotedPenalty ?? 0) < -1);
  });

  test('selectCarryForwardPromotions reserves slots for away-gap candidates', () => {
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const gapStartMs = nowMs - 3 * 24 * 60 * 60 * 1000;
    const makeCandidate = (id: string, score: number, createdAtMs: number): FeedCarryForwardCandidate => ({
      id,
      type: 'article',
      source: 'unit-test',
      sourceId: id,
      title: id,
      text: null,
      excerpt: null,
      reason: null,
      url: null,
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
      publishedAt: new Date(createdAtMs).toISOString(),
      displayOrder: null,
      score,
      scoreBreakdown: {
        editorial: 0,
        preference: 0,
        curatorInterest: 0,
        prominence: 0,
        engagement: 0,
        age: 0,
        promotedPenalty: 0,
        itemType: 0,
        total: score,
      },
      threadId: null,
      threadTitle: null,
      threadRationale: null,
      bridge: null,
      carryForward: true,
    });

    const ancientMs = nowMs - 40 * 24 * 60 * 60 * 1000;
    const gapMs = nowMs - 24 * 60 * 60 * 1000;
    const ranked = [
      makeCandidate('ancient-1', 9, ancientMs),
      makeCandidate('ancient-2', 8, ancientMs),
      makeCandidate('ancient-3', 7, ancientMs),
      makeCandidate('ancient-4', 6, ancientMs),
      makeCandidate('gap-1', 3, gapMs),
      makeCandidate('gap-2', 2, gapMs),
    ];

    const selection = selectCarryForwardPromotions(ranked, { slots: 4, gapStartMs });
    assert.strictEqual(selection.promoted.length, 4);
    assert.deepStrictEqual(selection.gapPromotedIds.sort(), ['gap-1', 'gap-2']);
    assert.strictEqual(selection.gapCandidateCount, 2);
    const promotedIds = selection.promoted.map((candidate) => candidate.id);
    assert.ok(promotedIds.includes('gap-1'));
    assert.ok(promotedIds.includes('gap-2'));
    assert.ok(promotedIds.includes('ancient-1'));
    assert.ok(promotedIds.includes('ancient-2'));
    assert.ok(!promotedIds.includes('ancient-3'));

    const noGapSelection = selectCarryForwardPromotions(ranked, { slots: 4, gapStartMs: null });
    assert.deepStrictEqual(
      noGapSelection.promoted.map((candidate) => candidate.id),
      ['ancient-1', 'ancient-2', 'ancient-3', 'ancient-4'],
    );
  });

  test('recordCarryForwardPromotions increments the persisted promotion count', () => {
    const db = getDb();
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const createdAt = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at)
      VALUES ('promotion-counter', 'article', 'unit-test', 'promotion-counter', 'Counter', 'Body', 'Reason', ?, NULL, NULL, ?, ?)
    `).run(JSON.stringify({ bridge: 'existing metadata survives' }), createdAt, createdAt);

    assert.strictEqual(recordCarryForwardPromotions(['promotion-counter'], nowMs), 1);
    assert.strictEqual(recordCarryForwardPromotions(['promotion-counter', 'missing-row'], nowMs + 1000), 1);

    const row = db.prepare(`
      SELECT
        CAST(json_extract(metadata, '$.carryForward.promotedCount') AS INTEGER) AS promoted_count,
        CAST(json_extract(metadata, '$.carryForward.lastPromotedAtMs') AS INTEGER) AS last_promoted_at_ms,
        json_extract(metadata, '$.bridge') AS bridge
      FROM feed
      WHERE id = 'promotion-counter'
    `).get() as { promoted_count: number; last_promoted_at_ms: number; bridge: string };
    assert.strictEqual(row.promoted_count, 2);
    assert.strictEqual(row.last_promoted_at_ms, nowMs + 1000);
    assert.strictEqual(row.bridge, 'existing metadata survives');
  });
});
