import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import { listFeedCarryForwardCandidates } from './feed-carry-forward';

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
});
