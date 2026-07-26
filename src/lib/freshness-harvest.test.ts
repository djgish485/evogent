import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { recordBrowseCacheRefresh, listBrowseCacheItems } from '@/lib/db/browse-cache';
import { getDb } from '@/lib/db/client';
import { unconsumedBenchCount } from '@/lib/db/curation-bench';
import {
  harvestFreshToBench,
  stableShipmentId,
  type FreshnessShipmentJudgment,
} from '@/lib/freshness-harvest';

const SCHEMA = 'evogent.freshness-shipment.v1' as const;

function judgment(
  decision: 'ship' | 'hold',
  rank: number,
  reason: string,
  cluster?: { key: string; title: string },
): FreshnessShipmentJudgment {
  return { schema: SCHEMA, decision, rank, reason, ...(cluster ? { cluster } : {}) };
}

function closeDb() {
  const globalWithDb = globalThis as typeof globalThis & {
    evogentDb?: { close: () => void };
  };
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

function twitterItem(
  sourceId: string,
  now: number,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    source: 'twitter',
    sourceId,
    url: `https://x.com/example/status/${sourceId.replace(/\D/g, '') || '1234567890'}`,
    authorUsername: 'example',
    authorDisplayName: 'Example',
    publishedAtMs: now - 10 * 60 * 1000,
    fetchedAtMs: now - 5 * 60 * 1000,
    expiresAtMs: now + 24 * 60 * 60 * 1000,
    payload,
    ...extra,
  };
}

function benchRows(): Array<{ source: string; source_id: string; score: number; reason: string; item_json: string }> {
  return getDb().prepare(`
    SELECT source, source_id, score, reason, item_json
    FROM curation_bench
    WHERE consumed_at_ms IS NULL
    ORDER BY score DESC, source_id ASC
  `).all() as Array<{ source: string; source_id: string; score: number; reason: string; item_json: string }>;
}

describe('runtime-agent freshness shipments', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    closeDb();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-freshness-shipment-'));
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    getDb();
  });

  afterEach(async () => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('ships only an explicit v1 decision; numeric-only and malformed rows keep waiting', async () => {
    const now = Date.now();
    const publicReason = 'A concrete update with enough substance to be useful on its own.';
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 6 * 60 * 1000,
      completedAtMs: now - 5 * 60 * 1000,
      status: 'completed',
      itemsAdded: 5,
      items: [
        twitterItem('1001', now, {
          text: 'A substantial item explicitly approved by the runtime agent.',
          shipmentJudgment: judgment('ship', 0.82, publicReason),
        }),
        twitterItem('1002', now, {
          text: 'A complete item the runtime agent explicitly chose to hold.',
          shipmentJudgment: judgment('hold', 0.99, 'This does not add enough substance yet.'),
        }),
        twitterItem('1003', now, {
          text: 'A legacy item with a high number but no actual shipment decision.',
          tasteScore: 10,
        }),
        twitterItem('1004', now, {
          text: 'A fresh item that no runtime agent has evaluated yet.',
        }),
        twitterItem('1005', now, {
          text: 'A malformed judgment cannot cross the mechanical boundary.',
          shipmentJudgment: {
            schema: SCHEMA,
            decision: 'ship',
            rank: 0.91,
            reason: 'Private evidence:\nshould never become a public reason.',
          },
        }),
      ],
    });

    const result = await harvestFreshToBench(12);

    assert.deepStrictEqual(result, {
      scanned: 5,
      awaitingJudgment: 3,
      heldByAgent: 1,
      benched: 1,
      bySource: { twitter: 1 },
    });
    const rows = listBrowseCacheItems({ source: 'twitter', includeExpired: true, limit: 10 });
    const seenById = new Map(rows.map((row) => [row.sourceId, row.seenByCurationAtMs]));
    assert.ok(seenById.get('1001'));
    assert.strictEqual(seenById.get('1002'), null);
    assert.strictEqual(seenById.get('1003'), null);
    assert.strictEqual(seenById.get('1004'), null);
    assert.strictEqual(seenById.get('1005'), null);

    const [bench] = benchRows();
    const item = JSON.parse(bench.item_json) as {
      metadata: {
        interest: { score: number; reason: string };
        shipment: { id: string; decision: string; rank: number; reason: string };
        thread?: unknown;
        tasteScore?: unknown;
        freshnessRankingScore?: unknown;
      };
    };
    assert.strictEqual(bench.score, 0.82);
    assert.strictEqual(bench.reason, publicReason);
    assert.deepStrictEqual(item.metadata.interest, { score: 0.82, reason: publicReason });
    assert.deepStrictEqual(item.metadata.shipment, {
      id: stableShipmentId({ source: 'twitter', sourceId: '1001' }),
      decision: 'ship',
      rank: 0.82,
      reason: publicReason,
    });
    assert.strictEqual(item.metadata.thread, undefined);
    assert.strictEqual(item.metadata.tasteScore, undefined);
    assert.strictEqual(item.metadata.freshnessRankingScore, undefined);
  });

  test('uses only the agent rank, not recency, popularity, source, account, or content type', async () => {
    const now = Date.now();
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: 1,
      items: [
        twitterItem('2001', now, {
          text: 'A viral and extremely recent item with a lower explicit shipment rank.',
          metrics: { likeCount: 10_000_000, repostCount: 2_000_000, viewCount: 500_000_000 },
          shipmentJudgment: judgment('ship', 0.1, 'Useful, but less valuable than the other candidate.'),
        }),
      ],
    });
    recordBrowseCacheRefresh({
      source: 'hackernews',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: 1,
      items: [{
        source: 'hackernews',
        sourceId: 'hn-older-low-engagement',
        url: 'https://example.com/older-article',
        title: 'A grounded older article',
        authorUsername: 'unknown',
        publishedAtMs: now - 30 * 60 * 60 * 1000,
        fetchedAtMs: now - 5 * 60 * 1000,
        expiresAtMs: now + 24 * 60 * 60 * 1000,
        payload: {
          linkedArticleSynopsis: 'This is a sufficiently detailed synopsis of the article and the concrete result it reports.',
          score: 0,
          shipmentJudgment: judgment('ship', 0.9, 'The reported result is concrete and unusually informative.'),
        },
      }],
    });

    const result = await harvestFreshToBench(1);
    assert.strictEqual(result.benched, 1);
    const [bench] = benchRows();
    assert.strictEqual(bench.source, 'hackernews');
    assert.strictEqual(bench.score, 0.9);
  });

  test('an old unexpired judged row reaches the bench despite sustained newer arrivals', async () => {
    const now = Date.now();
    const oldId = 'old-unexpired-judged-row';
    const newer = Array.from({ length: 150 }, (_, index) => twitterItem(
      `new-arrival-${6000 + index}`,
      now,
      {
        text: `Newer eligible arrival ${index} with a lower explicit agent rank.`,
        shipmentJudgment: judgment(
          'ship',
          0.1,
          `Newer arrival ${index} is usable but ranks below the older evidence.`,
        ),
      },
      { fetchedAtMs: now - (150 - index) * 1000 },
    ));
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: newer.length + 1,
      items: [
        twitterItem(oldId, now, {
          text: 'Older source evidence remains valid and carries the highest explicit judgment.',
          shipmentJudgment: judgment(
            'ship',
            0.99,
            'The agent judged this durable evidence most valuable.',
          ),
        }, {
          publishedAtMs: now - 90 * 24 * 60 * 60 * 1000,
          fetchedAtMs: now - 89 * 24 * 60 * 60 * 1000,
          expiresAtMs: now + 24 * 60 * 60 * 1000,
        }),
        ...newer,
      ],
    });

    const result = await harvestFreshToBench(1);
    assert.strictEqual(result.scanned, 151);
    assert.strictEqual(result.benched, 1);
    const [bench] = benchRows();
    assert.strictEqual(bench.source_id, oldId);
    assert.strictEqual(bench.score, 0.99);
  });

  test('allows zero output when the agent holds every candidate', async () => {
    const now = Date.now();
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: 2,
      items: [
        twitterItem('3001', now, {
          text: 'A complete but low-value candidate the agent may hold.',
          shipmentJudgment: judgment('hold', 1, 'This repeats material already covered elsewhere.'),
        }),
        twitterItem('3002', now, {
          text: 'Another complete candidate that does not require quota padding.',
          shipmentJudgment: judgment('hold', 0, 'This lacks enough content to reward attention.'),
        }),
      ],
    });

    assert.deepStrictEqual(await harvestFreshToBench(50), {
      scanned: 2,
      awaitingJudgment: 0,
      heldByAgent: 2,
      benched: 0,
      bySource: {},
    });
    assert.strictEqual(unconsumedBenchCount(), 0);
  });

  test('ships an approved uncertain-handle tweet without fabricating a profile URL', async () => {
    const now = Date.now();
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: 1,
      items: [
        twitterItem('phone-twitter-display-name-provisional', now, {
          text: 'A complete phone-captured post whose display name did not expose a verified handle.',
          authorUsername: 'display_name_guess',
          handleUncertain: true,
          shipmentJudgment: judgment(
            'ship',
            0.8,
            'The source-owned post is useful even though its outbound identity remains unresolved.',
          ),
        }, {
          url: null,
          authorUsername: 'display_name_guess',
        }),
      ],
    });

    const result = await harvestFreshToBench(1);
    assert.strictEqual(result.benched, 1);
    const [bench] = benchRows();
    const item = JSON.parse(bench.item_json) as {
      url: string | null;
      metadata: { handleUncertain?: boolean };
    };
    assert.strictEqual(item.url, null);
    assert.strictEqual(item.metadata.handleUncertain, true);
  });

  test('keeps agent-approved short, media-only, quote-only, promotional, and concise evidence', async () => {
    const now = Date.now();
    const ship = (reason: string) => judgment('ship', 0.8, reason);
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: 5,
      items: [
        twitterItem('5101', now, {
          text: 'Hi.',
          shipmentJudgment: ship('The agent judged the short post useful in context.'),
        }),
        twitterItem('5102', now, {
          text: '',
          quotedTweet: { author: { username: 'quoted' }, text: 'Inner source evidence.' },
          shipmentJudgment: ship('The quote itself is the relevant source evidence.'),
        }),
        twitterItem('5103', now, {
          text: '',
          mediaUrls: ['https://pbs.twimg.com/media/example.jpg'],
          shipmentJudgment: ship('The source-owned image is the content.'),
        }),
        twitterItem('5104', now, {
          text: '',
          mediaDescription: 'Visible chart showing the measured result.',
          shipmentJudgment: ship('The visible media evidence is useful.'),
        }),
        twitterItem('5105', now, {
          text: 'Sponsored: a concrete source claim the agent chose to keep.',
          observedSignals: { promotionLabel: true, language: 'es' },
          shipmentJudgment: ship('The claim remains useful despite its observed label.'),
        }),
      ],
    });
    recordBrowseCacheRefresh({
      source: 'instagram',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: 1,
      items: [{
        source: 'instagram',
        sourceId: 'ig-promotion-observed',
        authorUsername: 'example_ig',
        authorDisplayName: 'Example IG',
        fetchedAtMs: now - 5 * 60_000,
        expiresAtMs: now + 24 * 60 * 60_000,
        payload: {
          text: 'Sponsored partnership with a concrete event announcement.',
          observedSignals: { promotionLabel: true },
          shipmentJudgment: ship('The agent judged the announcement worth showing.'),
        },
      }],
    });
    recordBrowseCacheRefresh({
      source: 'hackernews',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: 1,
      items: [{
        source: 'hackernews',
        sourceId: 'hn-concise-synopsis',
        title: 'Concise source',
        url: 'https://example.com/concise',
        publishedAtMs: now - 10 * 60_000,
        fetchedAtMs: now - 5 * 60_000,
        expiresAtMs: now + 24 * 60 * 60_000,
        payload: {
          linkedArticleSynopsis: 'Brief but complete.',
          shipmentJudgment: ship('The concise source is structurally complete.'),
        },
      }],
    });

    const result = await harvestFreshToBench(10);
    assert.strictEqual(result.benched, 6);
    const shipped = new Map(benchRows().map((row) => [
      row.source_id,
      JSON.parse(row.item_json) as {
        text: string;
        mediaUrls?: string[];
        metadata?: { quotedTweet?: unknown; mediaDescription?: string };
      },
    ]));
    assert.strictEqual(shipped.get('5101')?.text, 'Hi.');
    assert.ok(shipped.get('5102')?.metadata?.quotedTweet);
    assert.deepStrictEqual(shipped.get('5103')?.mediaUrls, ['https://pbs.twimg.com/media/example.jpg']);
    assert.strictEqual(shipped.has('5104'), false);
    assert.ok(shipped.has('5105'));
    assert.ok(shipped.has('ig-promotion-observed'));
    assert.strictEqual(shipped.get('hn-concise-synopsis')?.text, 'Brief but complete.');
  });

  test('adds a stable thread only to two or more members of a real agent cluster', async () => {
    const now = Date.now();
    const shared = { key: 'specific-release', title: 'Specific release' };
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: 3,
      items: [
        twitterItem('4001', now, {
          text: 'The first detailed angle on the same specific release.',
          shipmentJudgment: judgment('ship', 0.9, 'This explains the first concrete consequence.', shared),
        }),
        twitterItem('4002', now, {
          text: 'The second detailed angle on the same specific release.',
          shipmentJudgment: judgment('ship', 0.8, 'This adds a distinct implementation consequence.', shared),
        }),
        twitterItem('4003', now, {
          text: 'A singleton topic should keep identity without receiving a banner.',
          shipmentJudgment: judgment(
            'ship',
            0.7,
            'This is useful independently.',
            { key: 'unmatched-topic', title: 'Unmatched topic' },
          ),
        }),
      ],
    });

    const result = await harvestFreshToBench(3);
    assert.strictEqual(result.benched, 3);
    const items = new Map(benchRows().map((row) => [
      row.source_id,
      JSON.parse(row.item_json) as {
        metadata: { shipment: { id: string }; thread?: { threadId: string; threadTitle: string } };
      },
    ]));
    const firstThread = items.get('4001')?.metadata.thread;
    const secondThread = items.get('4002')?.metadata.thread;
    assert.ok(firstThread);
    assert.deepStrictEqual(secondThread, firstThread);
    assert.strictEqual(firstThread.threadTitle, 'Specific release');
    assert.match(firstThread.threadId, /^shipment-cluster-[a-f0-9]{20}$/);
    assert.strictEqual(items.get('4003')?.metadata.thread, undefined);
    assert.strictEqual(
      items.get('4003')?.metadata.shipment.id,
      stableShipmentId({ source: 'twitter', sourceId: '4003' }),
    );
  });

  test('hard-caps a fallback harvest at fifty global shipments', async () => {
    const now = Date.now();
    const items = Array.from({ length: 55 }, (_, index) => {
      const id = String(5000 + index);
      return twitterItem(id, now, {
        text: `Unique explicitly approved candidate number ${index} with sufficient substantive text.`,
        shipmentJudgment: judgment(
          'ship',
          (55 - index) / 55,
          `Concrete candidate ${index} is worth attention on its own merits.`,
        ),
      });
    });
    recordBrowseCacheRefresh({
      source: 'twitter',
      triggeredBy: 'test',
      startedAtMs: now - 60_000,
      completedAtMs: now - 30_000,
      status: 'completed',
      itemsAdded: items.length,
      items,
    });

    const result = await harvestFreshToBench(999);
    assert.strictEqual(result.scanned, 55);
    assert.strictEqual(result.benched, 50);
    assert.strictEqual(unconsumedBenchCount(), 50);
  });
});
