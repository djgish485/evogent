import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import {
  listFeedCarryForwardCandidates,
  recordCarryForwardPromotions,
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

  test('returns the complete unseen set in prior agent shipment then evidence order', () => {
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
        created_at_ms,
        metrics_likes,
        metrics_reposts,
        metrics_replies,
        metrics_views
      )
      VALUES (?, ?, ?, ?, ?, 'Body', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCandidate = (
      id: string,
      type: 'tweet' | 'article' | 'analysis',
      displayOrder: number | null,
      metadata: Record<string, unknown>,
      metrics: [number, number, number, number],
      createdAtMs: number,
    ) => {
      const createdAt = new Date(createdAtMs).toISOString();
      insert.run(
        id,
        type,
        `source-${id}`,
        `source-id-${id}`,
        `Title ${id}`,
        `Reason ${id}`,
        JSON.stringify(metadata),
        displayOrder,
        createdAt,
        createdAt,
        createdAtMs,
        ...metrics,
      );
    };

    // Never-arranged evidence sequence begins here. It deliberately carries
    // every legacy "high value" proxy so the test proves those fields do not
    // move it ahead of prior explicit shipment order.
    insertCandidate(
      'evidence-first',
      'tweet',
      null,
      {
        preferenceMatch: { relevanceScore: 1 },
        relevanceScore: 1,
        prominence: { level: 'major' },
        tasteScore: 10,
        interest: { score: 1, durability: 'evergreen' },
        carryForward: { promotedCount: 0 },
      },
      [1_000_000, 500_000, 100_000, 10_000_000],
      nowMs,
    );
    insertCandidate(
      'prior-second',
      'analysis',
      2,
      {
        preferenceMatch: { relevanceScore: 0 },
        prominence: { level: 'low' },
        tasteScore: 1,
        interest: { score: 0.05, durability: 'news' },
        carryForward: { promotedCount: 99 },
      },
      [0, 0, 0, 0],
      nowMs - 200 * 24 * 60 * 60 * 1000,
    );
    insertCandidate(
      'prior-first',
      'article',
      1,
      {
        preferenceMatch: { relevanceScore: 0 },
        tasteScore: 1,
        interest: { score: 0.01, durability: 'news' },
      },
      [0, 0, 0, 0],
      nowMs - 300 * 24 * 60 * 60 * 1000,
    );
    insertCandidate(
      'evidence-second',
      'article',
      null,
      {
        preferenceMatch: { relevanceScore: 0.99 },
        interest: { score: 0.99, durability: 'evergreen' },
      },
      [2_000_000, 1_000_000, 500_000, 20_000_000],
      nowMs + 60_000,
    );

    const candidates = listFeedCarryForwardCandidates({
      includeAllUnviewed: true,
      includeDisplayed: true,
      // Complete-set mode deliberately ignores shortlist knobs.
      limit: 1,
      reviewLimit: 1,
      nowMs,
    });

    assert.strictEqual(candidates.review.includeAllUnviewed, true);
    assert.strictEqual(candidates.review.includeDisplayed, true);
    assert.strictEqual(candidates.review.eligibleCount, 4);
    assert.strictEqual(candidates.review.reviewedCount, 4);
    assert.strictEqual(candidates.review.returnedCount, 4);
    assert.strictEqual(candidates.review.queryLimit, 4);
    assert.strictEqual(candidates.review.reviewLimit, 4);
    assert.strictEqual(
      candidates.review.orderBasis,
      'prior_agent_shipment_then_evidence_sequence',
    );
    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.id),
      ['prior-first', 'prior-second', 'evidence-first', 'evidence-second'],
    );
    assert.deepStrictEqual(
      candidates.review.candidateIds,
      ['prior-first', 'prior-second', 'evidence-first', 'evidence-second'],
    );
    assert.strictEqual(candidates[0]?.interestScore, 0.01);
    assert.strictEqual(candidates[0]?.interestDurability, 'news');
  });

  test('complete-set mode has no candidate cap and applies only structural eligibility', () => {
    const db = getDb();
    const nowMs = Date.UTC(2026, 5, 8, 12, 0, 0);
    const insert = db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, reason, metadata,
        display_order, parent_id, published_at, created_at, created_at_ms
      )
      VALUES (?, ?, 'unit-test', ?, ?, 'Body', 'Reason', ?, NULL, ?, ?, ?, ?)
    `);

    for (let index = 0; index < 61; index += 1) {
      const id = `eligible-${String(index).padStart(2, '0')}`;
      const createdAtMs = nowMs + index;
      const createdAt = new Date(createdAtMs).toISOString();
      insert.run(
        id,
        index % 3 === 0 ? 'tweet' : index % 3 === 1 ? 'article' : 'analysis',
        id,
        `Title ${id}`,
        JSON.stringify({
          preferenceMatch: { relevanceScore: index % 2 },
          interest: {
            score: index / 100,
            durability: index % 2 ? 'evergreen' : 'news',
          },
        }),
        null,
        createdAt,
        createdAt,
        createdAtMs,
      );
    }

    const excludedAt = new Date(nowMs + 1000).toISOString();
    insert.run(
      'reflection-excluded',
      'analysis',
      'reflection-excluded',
      'Reflection',
      JSON.stringify({ reflectionCycle: 'cycle' }),
      null,
      excludedAt,
      excludedAt,
      nowMs + 1000,
    );
    insert.run(
      'child-excluded',
      'article',
      'child-excluded',
      'Child',
      '{}',
      'eligible-00',
      excludedAt,
      excludedAt,
      nowMs + 1001,
    );
    insert.run(
      'suggestion-excluded',
      'suggestion',
      'suggestion-excluded',
      'Suggestion',
      '{}',
      null,
      excludedAt,
      excludedAt,
      nowMs + 1002,
    );
    db.prepare(`
      INSERT INTO interactions (feed_item_id, action)
      VALUES ('eligible-00', 'view')
    `).run();

    const candidates = listFeedCarryForwardCandidates({
      includeAllUnviewed: true,
      includeDisplayed: true,
      limit: 2,
      reviewLimit: 2,
      nowMs,
    });

    assert.strictEqual(candidates.review.eligibleCount, 60);
    assert.strictEqual(candidates.review.reviewedCount, 60);
    assert.strictEqual(candidates.review.returnedCount, 60);
    assert.strictEqual(candidates.length, 60);
    assert.ok(!candidates.some((candidate) => candidate.id === 'eligible-00'));
    assert.ok(!candidates.some((candidate) => candidate.id === 'reflection-excluded'));
    assert.ok(!candidates.some((candidate) => candidate.id === 'child-excluded'));
    assert.ok(!candidates.some((candidate) => candidate.id === 'suggestion-excluded'));
  });

  test('recovers a real metadata thread behind a hidden singleton shipment id', () => {
    const db = getDb();
    const createdAt = '2026-06-08T12:00:00.000Z';
    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, reason, metadata,
        display_order, thread_id, parent_id, published_at, created_at, created_at_ms
      )
      VALUES (
        'thread-candidate',
        'article',
        'unit-test',
        'thread-candidate',
        'Thread candidate',
        'Body',
        'Reason',
        ?,
        1,
        'shipment-singleton:thread-candidate',
        NULL,
        ?,
        ?,
        ?
      )
    `).run(
      JSON.stringify({
        thread: {
          threadId: 'agent-thread',
          threadTitle: 'Agent thread',
          threadRationale: 'Explicit historical shipment evidence.',
        },
      }),
      createdAt,
      createdAt,
      Date.parse(createdAt),
    );

    const candidates = listFeedCarryForwardCandidates({
      includeAllUnviewed: true,
      includeDisplayed: true,
    });

    assert.strictEqual(candidates[0]?.threadId, 'agent-thread');
    assert.strictEqual(candidates[0]?.threadTitle, 'Agent thread');
  });

  test('recordCarryForwardPromotions keeps a truthful shipment receipt', () => {
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
