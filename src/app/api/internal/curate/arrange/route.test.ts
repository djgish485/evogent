import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import {
  getCurationLogByRequestId,
  insertCurationLogStart,
} from '@/lib/db/activity';
import {
  getCurrentFeedArrangeInput,
  getFeedPage,
  getSingletonShipmentThreadId,
} from '@/lib/db/feed';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type RouteModule = {
  POST: (request: Request) => Promise<Response>;
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/curate/arrange', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-arrange-route-test-'));

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

  async function importRoute(): Promise<RouteModule> {
    return import(`./route?t=${Date.now()}-${Math.random().toString(36).slice(2)}`) as Promise<RouteModule>;
  }

  test('caps the primary slate without splitting a thread shipment', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, reason, metadata,
        display_order, parent_id, published_at, created_at
      ) VALUES (?, 'article', 'unit-test', ?, ?, 'Body', 'Fresh', ?, NULL, NULL, ?, ?)
    `);
    const ordering = [];
    for (let index = 0; index < 51; index += 1) {
      const id = `slate-cap-${index}`;
      const inTailThread = index >= 48;
      insert.run(
        id,
        id,
        `Slate item ${index}`,
        JSON.stringify(inTailThread ? { thread: { threadId: 'slate-cap-thread' } } : {}),
        now,
        now,
      );
      ordering.push({
        feedItemId: id,
        displayOrder: index + 1,
        ...(inTailThread ? { threadId: 'slate-cap-thread' } : {}),
      });
    }

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering,
        threads: [{ id: 'slate-cap-thread', title: 'Bounded slate', active: true }],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      orderingCount: number;
      ordering: unknown[];
      slateCap: {
        maxItems: number;
        beforeCount: number;
        afterCount: number;
        droppedCount: number;
        quarantinedCount: number;
      };
    };
    assert.strictEqual(body.orderingCount, 48);
    assert.strictEqual(body.ordering.length, 48);
    assert.deepStrictEqual(body.slateCap, {
      maxItems: 50,
      beforeCount: 51,
      afterCount: 48,
      droppedCount: 3,
      droppedShipmentUnitCount: 1,
      quarantinedCount: 0,
      nonPrimarySuggestionCount: 0,
    });
    const displayed = db.prepare('SELECT COUNT(*) AS count FROM feed WHERE display_order IS NOT NULL').get() as { count: number };
    assert.strictEqual(displayed.count, 48);
    const partialThread = db.prepare(`
      SELECT COUNT(*) AS count
      FROM feed
      WHERE display_order IS NOT NULL
        AND json_extract(metadata, '$.thread.threadId') = 'slate-cap-thread'
    `).get() as { count: number };
    assert.strictEqual(partialThread.count, 0);
  });

  test('pending suggestions do not consume the 50-item primary content slate', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, reason, metadata,
        display_order, parent_id, published_at, created_at, created_at_ms
      ) VALUES (?, ?, 'unit-test', ?, ?, 'Body', 'Fresh', ?, NULL, NULL, ?, ?, ?)
    `);
    const ordering = [];
    for (let index = 0; index < 50; index += 1) {
      const id = `content-cap-${index}`;
      insert.run(
        id,
        'article',
        id,
        `Content ${index}`,
        JSON.stringify({ interest: { score: 0.5, durability: 'dated' } }),
        now,
        now,
        Date.now() + index,
      );
      ordering.push({ feedItemId: id, displayOrder: index + 1 });
    }
    insert.run(
      'pending-suggestion-beyond-content-cap',
      'suggestion',
      'pending-suggestion-beyond-content-cap',
      'Pending suggestion',
      JSON.stringify({
        suggestionStatus: 'pending',
        suggestionType: 'life_admin',
        importance: 'high',
      }),
      now,
      now,
      Date.now() + 100,
    );

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({ ordering, threads: [] }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ordering: Array<{ feedItemId: string }>;
      slateCap: {
        afterCount: number;
        nonPrimarySuggestionCount: number;
      };
    };
    assert.strictEqual(body.slateCap.afterCount, 50);
    assert.strictEqual(body.slateCap.nonPrimarySuggestionCount, 1);
    assert.strictEqual(body.ordering.length, 51);
    assert.strictEqual(
      body.ordering[0]?.feedItemId,
      'pending-suggestion-beyond-content-cap',
    );
    assert.strictEqual(
      body.ordering.filter((entry) => entry.feedItemId.startsWith('content-cap-')).length,
      50,
    );
  });

  test('old pending suggestions retain explicit placement until resolved or explicitly expired', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const oldCreatedAtMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, metadata,
        display_order, parent_id, published_at, created_at, created_at_ms
      ) VALUES
        ('old-pending-suggestion', 'suggestion', 'unit-test', 'old-pending-suggestion',
         'Old but unresolved', 'Still explicitly pending',
         ?, NULL, NULL, ?, ?, ?),
        ('old-suggestion-content', 'article', 'unit-test', 'old-suggestion-content',
         'Current content', 'Current content body',
         '{}', NULL, NULL, ?, ?, ?)
    `).run(
      JSON.stringify({
        suggestionStatus: 'pending',
        suggestionType: 'life_admin',
        importance: 'high',
      }),
      now,
      now,
      oldCreatedAtMs,
      now,
      now,
      Date.now(),
    );

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [{ feedItemId: 'old-suggestion-content', displayOrder: 1 }],
        threads: [],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ordering: Array<{ feedItemId: string }>;
      suggestionPlacement: { topCount: number; backlogCount: number };
    };
    assert.strictEqual(body.ordering[0]?.feedItemId, 'old-pending-suggestion');
    assert.deepStrictEqual(body.suggestionPlacement, {
      topCount: 1,
      inlineCount: 0,
      backlogCount: 0,
    });
  });

  test('rejects a thread that cannot fit as one primary-slate shipment', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, reason, metadata,
        display_order, parent_id, published_at, created_at
      ) VALUES (?, 'article', 'unit-test', ?, ?, 'Body', 'Fresh', ?, NULL, NULL, ?, ?)
    `);
    const ordering = [];
    for (let index = 0; index < 60; index += 1) {
      const id = `oversized-thread-${index}`;
      insert.run(
        id,
        id,
        `Oversized thread item ${index}`,
        JSON.stringify({ thread: { threadId: 'oversized-thread' } }),
        now,
        now,
      );
      ordering.push({
        feedItemId: id,
        displayOrder: index + 1,
        threadId: 'oversized-thread',
      });
    }

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering,
        threads: [{ id: 'oversized-thread', title: 'Too large', active: true }],
      }),
    }));

    assert.strictEqual(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, /revise the thread as an editorial unit/);
    const displayed = db.prepare('SELECT COUNT(*) AS count FROM feed WHERE display_order IS NOT NULL').get() as { count: number };
    assert.strictEqual(displayed.count, 0);
  });

  test('never promotes a quarantined source item back into the primary slate', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, reason, metadata,
        display_order, parent_id, published_at, created_at
      ) VALUES
        ('safe-item', 'article', 'unit-test', 'safe-item', 'Safe', 'Body', 'Fresh', '{}', NULL, NULL, ?, ?),
        ('quarantined-item', 'tweet', 'twitter', 'quarantined-item', 'Bad date', 'Body', 'Fresh',
         '{"quarantine":{"reason":"implausible_publish_date"}}', 1, NULL, ?, ?)
    `).run(now, now, now, now);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [
          { feedItemId: 'quarantined-item', displayOrder: 1 },
          { feedItemId: 'safe-item', displayOrder: 2 },
        ],
        threads: [],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ordering: Array<{ feedItemId: string }>;
      slateCap: { quarantinedCount: number };
    };
    assert.deepStrictEqual(body.ordering.map((entry) => entry.feedItemId), ['safe-item']);
    assert.strictEqual(body.slateCap.quarantinedCount, 1);

    const rows = db.prepare(
      'SELECT id, display_order FROM feed WHERE id IN (?, ?) ORDER BY id',
    ).all('quarantined-item', 'safe-item') as Array<{ id: string; display_order: number | null }>;
    assert.deepStrictEqual(rows, [
      { id: 'quarantined-item', display_order: null },
      { id: 'safe-item', display_order: 1 },
    ]);
  });

  test('does not let arrange-only calls close an automated cycle without a submit receipt', async () => {
    const db = getDb();
    const now = '2026-06-07T18:15:00.000Z';
    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at)
      VALUES
        ('arrange-only-a', 'article', 'unit-test', 'arrange-only-a', 'Arrange A', 'Body', 'Fresh', ?, NULL, NULL, ?, ?),
        ('arrange-only-b', 'article', 'unit-test', 'arrange-only-b', 'Arrange B', 'Body', 'Fresh', ?, NULL, NULL, ?, ?)
    `).run(
      JSON.stringify({}),
      now,
      now,
      JSON.stringify({}),
      now,
      now,
    );
    const requestId = 'chat-queue-heartbeat-arrange-only';
    insertCurationLogStart({
      requestId,
      triggeredBy: 'adaptive_heartbeat:unit-test:max_interval_elapsed',
      startedAt: now,
      feedCountBefore: 2,
    });

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [
          {
            feedItemId: 'arrange-only-a',
            displayOrder: 1,
            threadId: 'arrange-only-thread',
          },
          {
            feedItemId: 'arrange-only-b',
            displayOrder: 2,
            threadId: 'arrange-only-thread',
          },
        ],
        threads: [
          {
            id: 'arrange-only-thread',
            title: 'Arrange-only thread',
            active: true,
          },
        ],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ok: boolean;
      completedPendingAutomatedCuration: boolean;
    };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.completedPendingAutomatedCuration, false);

    const pendingEntry = getCurationLogByRequestId(requestId);
    assert.ok(pendingEntry);
    assert.strictEqual(pendingEntry?.completionStatus, null);
    assert.strictEqual(pendingEntry?.itemsAdded, null);
    assert.strictEqual(pendingEntry?.completedAt, null);
  });

  test('preserves judged score order even when it creates a same-source run', async () => {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at)
      VALUES (?, 'article', ?, ?, ?, 'Body', 'Fresh', ?, NULL, NULL, ?, ?)
    `);
    const items: Array<[string, string, number]> = [
      ['diversity-hn-1', 'hackernews', 0.9],
      ['diversity-hn-2', 'hackernews', 0.89],
      ['diversity-hn-3', 'hackernews', 0.88],
      ['diversity-substack-1', 'substack', 0.87],
    ];
    for (const [id, source, score] of items) {
      insert.run(
        id,
        source,
        id,
        `Title ${id}`,
        JSON.stringify({ interest: { score, durability: 'evergreen' } }),
        nowIso,
        nowIso,
      );
    }

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: items.map(([id], index) => ({
          feedItemId: id,
          displayOrder: index + 1,
          threadId: `diversity-thread-${index + 1}`,
        })),
        threads: items.map((_, index) => ({
          id: `diversity-thread-${index + 1}`,
          title: `Diversity thread ${index + 1}`,
          active: true,
        })),
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ordering: Array<{ feedItemId: string; threadId?: string | null }>;
      activeThreads: Array<{ id: string }>;
    };
    assert.deepStrictEqual(body.activeThreads, []);
    for (const [id] of items) {
      assert.strictEqual(
        body.ordering.find((item) => item.feedItemId === id)?.threadId,
        getSingletonShipmentThreadId(id),
      );
    }

    const rows = db.prepare(
      "SELECT id FROM feed WHERE id LIKE 'diversity-%' AND display_order IS NOT NULL ORDER BY display_order",
    ).all() as Array<{ id: string }>;
    assert.deepStrictEqual(
      rows.map((row) => row.id),
      ['diversity-hn-1', 'diversity-hn-2', 'diversity-hn-3', 'diversity-substack-1'],
    );
  });

  test('keeps one stable thread as an unsplit shipment when input rows are interleaved', async () => {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at)
      VALUES (?, 'article', 'unit-test', ?, ?, 'Body', 'Fresh', ?, NULL, NULL, ?, ?)
    `);
    insert.run(
      'stable-thread-first',
      'stable-thread-first',
      'First thread member',
      JSON.stringify({ interest: { score: 0.9, durability: 'evergreen' } }),
      nowIso,
      nowIso,
    );
    insert.run(
      'interleaved-singleton',
      'interleaved-singleton',
      'Standalone item',
      JSON.stringify({ interest: { score: 0.89, durability: 'evergreen' } }),
      nowIso,
      nowIso,
    );
    insert.run(
      'stable-thread-second',
      'stable-thread-second',
      'Second thread member',
      JSON.stringify({ interest: { score: 0.88, durability: 'evergreen' } }),
      nowIso,
      nowIso,
    );

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [
          { feedItemId: 'stable-thread-first', displayOrder: 1, threadId: 'stable-thread' },
          { feedItemId: 'interleaved-singleton', displayOrder: 2 },
          { feedItemId: 'stable-thread-second', displayOrder: 3, threadId: 'stable-thread' },
        ],
        threads: [
          { id: 'stable-thread', title: 'Stable thread', active: true },
        ],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ordering: Array<{ feedItemId: string; threadId?: string | null }>;
      activeThreads: Array<{ id: string }>;
    };
    const singletonShipmentId = getSingletonShipmentThreadId('interleaved-singleton');
    assert.strictEqual(
      body.ordering.find((item) => item.feedItemId === 'interleaved-singleton')?.threadId,
      singletonShipmentId,
    );
    assert.deepStrictEqual(body.activeThreads.map((thread) => thread.id), ['stable-thread']);
    const rows = db.prepare(`
      SELECT id, thread_id
      FROM feed
      WHERE id IN ('stable-thread-first', 'stable-thread-second', 'interleaved-singleton')
      ORDER BY display_order
    `).all() as Array<{ id: string; thread_id: string | null }>;
    assert.deepStrictEqual(rows, [
      { id: 'stable-thread-first', thread_id: 'stable-thread' },
      { id: 'stable-thread-second', thread_id: 'stable-thread' },
      {
        id: 'interleaved-singleton',
        thread_id: singletonShipmentId,
      },
    ]);

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    assert.strictEqual(
      page.items.find((item) => item.id === 'interleaved-singleton')?.threadId,
      null,
    );
  });

  test('preserves explicit agent shipment order without a seen-state re-rank', async () => {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at)
      VALUES (?, 'article', ?, ?, ?, 'Body', 'Fresh', ?, NULL, NULL, ?, ?)
    `);
    // A high-interest thread the user already VIEWED, plus lower-interest unseen items.
    const items: Array<[string, string, number]> = [
      ['seen-top-1', 'hackernews', 0.95],
      ['seen-top-2', 'twitter', 0.94],
      ['unseen-mid-1', 'substack', 0.6],
      ['unseen-mid-2', 'youtube', 0.55],
    ];
    for (const [id, source, score] of items) {
      insert.run(
        id,
        source,
        id,
        `Title ${id}`,
        JSON.stringify({ interest: { score, durability: 'evergreen' } }),
        nowIso,
        nowIso,
      );
    }
    db.prepare("INSERT INTO interactions (feed_item_id, action) VALUES ('seen-top-1', 'view')").run();
    db.prepare("INSERT INTO interactions (feed_item_id, action) VALUES ('seen-top-2', 'view')").run();

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [
          { feedItemId: 'seen-top-1', displayOrder: 1, threadId: 'seen-thread' },
          { feedItemId: 'seen-top-2', displayOrder: 2, threadId: 'seen-thread' },
          { feedItemId: 'unseen-mid-1', displayOrder: 3, threadId: 'unseen-thread' },
          { feedItemId: 'unseen-mid-2', displayOrder: 4, threadId: 'unseen-thread' },
        ],
        threads: [
          { id: 'seen-thread', title: 'Seen thread', active: true },
          { id: 'unseen-thread', title: 'Unseen thread', active: true },
        ],
      }),
    }));
    assert.strictEqual(response.status, 200);
    const rows = db.prepare(
      "SELECT id FROM feed WHERE (id LIKE 'seen-top-%' OR id LIKE 'unseen-mid-%') AND display_order IS NOT NULL ORDER BY display_order",
    ).all() as Array<{ id: string }>;
    // Read state is evidence for the runtime agent, not permission for a
    // deterministic arrange pass to rewrite the agent's explicit shipment.
    assert.deepStrictEqual(
      rows.map((row) => row.id),
      ['seen-top-1', 'seen-top-2', 'unseen-mid-1', 'unseen-mid-2'],
    );
  });

  test('auto-promotes older accepted-but-unviewed carry-forward items when the curator omits them', async () => {
    const db = getDb();
    const now = Date.now();
    const current = new Date(now - 5 * 60 * 1000).toISOString();
    const prior = new Date(now - 6 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at)
      VALUES
        ('curate-20260601T0158Z-new-a', 'article', 'unit-test', 'new-a', 'New A', 'Body', 'Fresh', ?, NULL, NULL, ?, ?),
        ('curate-20260601T0158Z-new-b', 'article', 'unit-test', 'new-b', 'New B', 'Body', 'Fresh', ?, NULL, NULL, ?, ?),
        ('curate-20260601T0158Z-new-omitted', 'article', 'unit-test', 'new-omitted', 'New omitted', 'Body', 'Same cycle', ?, NULL, NULL, ?, ?),
        ('reflection-20260531T2300Z-summary', 'analysis', 'claude', 'reflection-summary', 'Reflection summary', 'Reflection body', 'Do not carry forward analysis', ?, NULL, NULL, ?, ?),
        ('curate-20260531T2235Z-old-unread', 'article', 'unit-test', 'old-unread', 'Old unread', 'Body', 'Still matters', ?, 42, NULL, ?, ?),
        ('curate-20260531T2235Z-old-viewed', 'article', 'unit-test', 'old-viewed', 'Old viewed', 'Body', 'Seen already', ?, NULL, NULL, ?, ?)
    `).run(
      JSON.stringify({}),
      current,
      current,
      JSON.stringify({}),
      current,
      current,
      JSON.stringify({}),
      current,
      current,
      JSON.stringify({}),
      prior,
      prior,
      JSON.stringify({
        bridge: 'The user has not seen this accepted card.',
        thread: {
          threadId: 'older-important-thread',
          threadTitle: 'Older signal still matters',
          threadRationale: 'Accepted earlier and still unread',
        },
      }),
      prior,
      prior,
      JSON.stringify({}),
      prior,
      prior,
    );

    db.prepare(`
      INSERT INTO interactions (feed_item_id, action, created_at)
      VALUES ('curate-20260531T2235Z-old-viewed', 'view', ?)
    `).run(prior);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [
          {
            feedItemId: 'curate-20260601T0158Z-new-a',
            displayOrder: 1,
            threadId: 'fresh-thread',
          },
          {
            feedItemId: 'curate-20260601T0158Z-new-b',
            displayOrder: 2,
            threadId: 'fresh-thread',
          },
        ],
        threads: [
          {
            id: 'fresh-thread',
            title: 'Fresh thread',
            active: true,
          },
        ],
      }),
    }));
    assert.strictEqual(response.status, 200);

    const body = await response.json() as {
      ok: boolean;
      arrangementRunId: number;
      ordering: Array<{ feedItemId: string; displayOrder: number; threadId?: string }>;
      activeThreads: Array<{ id: string }>;
      carryForwardAudit: {
        mode: string;
        eligibleCount: number;
        reviewedCount: number;
        includeAllUnviewed: boolean;
        includeDisplayed: boolean;
        promotedIds: string[];
        skippedCurrentCycleIds: string[];
        candidateIds: string[];
      };
    };

    assert.strictEqual(body.ok, true);
    assert.strictEqual(typeof body.arrangementRunId, 'number');
    assert.strictEqual(body.carryForwardAudit.mode, 'auto-injected');
    assert.strictEqual(body.carryForwardAudit.includeAllUnviewed, true);
    assert.strictEqual(body.carryForwardAudit.includeDisplayed, true);
    assert.strictEqual(body.carryForwardAudit.eligibleCount, 4);
    assert.strictEqual(body.carryForwardAudit.reviewedCount, 4);
    assert.ok(body.carryForwardAudit.candidateIds.includes('curate-20260531T2235Z-old-unread'));
    assert.deepStrictEqual(body.carryForwardAudit.promotedIds, ['curate-20260531T2235Z-old-unread']);
    assert.deepStrictEqual(body.carryForwardAudit.skippedCurrentCycleIds, ['curate-20260601T0158Z-new-omitted']);
    assert.deepStrictEqual(body.ordering.map((item) => item.feedItemId), [
      'curate-20260601T0158Z-new-a',
      'curate-20260601T0158Z-new-b',
      'curate-20260531T2235Z-old-unread',
    ]);
    const oldUnreadSingletonThreadId = getSingletonShipmentThreadId(
      'curate-20260531T2235Z-old-unread',
    );
    assert.strictEqual(
      body.ordering.find((item) => item.feedItemId === 'curate-20260531T2235Z-old-unread')?.threadId,
      oldUnreadSingletonThreadId,
    );
    assert.deepStrictEqual(body.activeThreads.map((thread) => thread.id), ['fresh-thread']);

    const rows = db.prepare(`
      SELECT id, display_order, thread_id, display_subtitle
      FROM feed
      WHERE id IN (
        'curate-20260601T0158Z-new-a',
        'curate-20260601T0158Z-new-b',
        'curate-20260601T0158Z-new-omitted',
        'curate-20260531T2235Z-old-unread',
        'curate-20260531T2235Z-old-viewed',
        'reflection-20260531T2300Z-summary'
      )
      ORDER BY display_order IS NULL, display_order, id
    `).all() as Array<{ id: string; display_order: number | null; thread_id: string | null; display_subtitle: string | null }>;

    assert.deepStrictEqual(rows.map((row) => [row.id, row.display_order, row.thread_id]), [
      ['curate-20260601T0158Z-new-a', 1, 'fresh-thread'],
      ['curate-20260601T0158Z-new-b', 2, 'fresh-thread'],
      // A lone carry-forward has a stable shipment boundary without a shared
      // display lane or its old one-item banner.
      ['curate-20260531T2235Z-old-unread', 3, oldUnreadSingletonThreadId],
      ['curate-20260531T2235Z-old-viewed', null, null],
      ['curate-20260601T0158Z-new-omitted', null, null],
      ['reflection-20260531T2300Z-summary', null, null],
    ]);
    assert.match(rows[2]?.display_subtitle ?? '', /^Still unread:/);

    const backstopInput = getCurrentFeedArrangeInput();
    assert.strictEqual(
      backstopInput.ordering.find(
        (item) => item.feedItemId === 'curate-20260531T2235Z-old-unread',
      )?.threadId,
      oldUnreadSingletonThreadId,
    );
    assert.ok(!backstopInput.threads.some((thread) => thread.id === oldUnreadSingletonThreadId));

    const visiblePage = getFeedPage({
      offset: 0,
      limit: 20,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    }, {
      lastArrangeAtMs: Date.now(),
      nowMs: Date.now(),
    });
    const visibleOldUnread = visiblePage.items.find(
      (item) => item.id === 'curate-20260531T2235Z-old-unread',
    );
    assert.ok(visibleOldUnread);
    assert.strictEqual(visibleOldUnread.threadId, null);
    assert.strictEqual(visibleOldUnread.threadTitle, null);

    const auditRow = db.prepare(`
      SELECT source, ordering_count, thread_count, updated_item_count, carry_forward_audit, ordering_snapshot
      FROM feed_arrangement_runs
      WHERE id = ?
    `).get(body.arrangementRunId) as {
      source: string;
      ordering_count: number;
      thread_count: number;
      updated_item_count: number;
      carry_forward_audit: string | null;
      ordering_snapshot: string | null;
    } | undefined;
    assert.ok(auditRow);
    assert.strictEqual(auditRow.source, 'curator');
    assert.strictEqual(auditRow.ordering_count, 3);
    assert.strictEqual(auditRow.thread_count, 1);
    assert.strictEqual(auditRow.updated_item_count, 3);
    const carryForwardAudit = JSON.parse(auditRow.carry_forward_audit ?? '{}') as {
      includeAllUnviewed: boolean;
      eligibleCount: number;
      reviewedCount: number;
      promotedIds: string[];
    };
    assert.strictEqual(carryForwardAudit.includeAllUnviewed, true);
    assert.strictEqual(carryForwardAudit.eligibleCount, 4);
    assert.strictEqual(carryForwardAudit.reviewedCount, 4);
    assert.deepStrictEqual(carryForwardAudit.promotedIds, ['curate-20260531T2235Z-old-unread']);
    assert.deepStrictEqual(
      JSON.parse(auditRow.ordering_snapshot ?? '[]').map((item: { feedItemId: string }) => item.feedItemId),
      [
        'curate-20260601T0158Z-new-a',
        'curate-20260601T0158Z-new-b',
        'curate-20260531T2235Z-old-unread',
      ],
    );

    db.prepare(`
      INSERT INTO interactions (feed_item_id, action, created_at)
      VALUES
        ('curate-20260601T0158Z-new-a', 'view', ?),
        ('curate-20260601T0158Z-new-b', 'view', ?),
        ('curate-20260601T0158Z-new-omitted', 'view', ?)
    `).run(current, current, current);

    const nextCurrent = new Date(now + 5 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at)
      VALUES
        ('curate-20260601T0400Z-new-c', 'article', 'unit-test', 'new-c', 'New C', 'Body', 'Fresh', ?, NULL, NULL, ?, ?),
        ('curate-20260601T0400Z-new-d', 'article', 'unit-test', 'new-d', 'New D', 'Body', 'Fresh', ?, NULL, NULL, ?, ?)
    `).run(
      JSON.stringify({}),
      nextCurrent,
      nextCurrent,
      JSON.stringify({}),
      nextCurrent,
      nextCurrent,
    );

    const secondResponse = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [
          {
            feedItemId: 'curate-20260601T0400Z-new-c',
            displayOrder: 1,
            threadId: 'next-fresh-thread',
          },
          {
            feedItemId: 'curate-20260601T0400Z-new-d',
            displayOrder: 2,
            threadId: 'next-fresh-thread',
          },
        ],
        threads: [
          {
            id: 'next-fresh-thread',
            title: 'Next fresh thread',
            active: true,
          },
        ],
      }),
    }));
    assert.strictEqual(secondResponse.status, 200);

    const secondBody = await secondResponse.json() as {
      ok: boolean;
      arrangementRunId: number;
      ordering: Array<{ feedItemId: string; displayOrder: number; threadId?: string }>;
      carryForwardAudit: {
        mode: string;
        eligibleCount: number;
        reviewedCount: number;
        includeAllUnviewed: boolean;
        promotedIds: string[];
        skippedCurrentCycleIds: string[];
      };
    };

    assert.strictEqual(secondBody.ok, true);
    assert.strictEqual(secondBody.carryForwardAudit.mode, 'auto-injected');
    assert.strictEqual(secondBody.carryForwardAudit.includeAllUnviewed, true);
    assert.strictEqual(secondBody.carryForwardAudit.eligibleCount, 3);
    assert.strictEqual(secondBody.carryForwardAudit.reviewedCount, 3);
    assert.deepStrictEqual(secondBody.carryForwardAudit.promotedIds, ['curate-20260531T2235Z-old-unread']);
    assert.deepStrictEqual(secondBody.ordering.map((item) => item.feedItemId), [
      'curate-20260601T0400Z-new-c',
      'curate-20260601T0400Z-new-d',
      'curate-20260531T2235Z-old-unread',
    ]);

    const secondRows = db.prepare(`
      SELECT id, display_order, thread_id, display_subtitle
      FROM feed
      WHERE id IN (
        'curate-20260601T0400Z-new-c',
        'curate-20260601T0400Z-new-d',
        'curate-20260531T2235Z-old-unread',
        'curate-20260601T0158Z-new-a',
        'curate-20260601T0158Z-new-b'
      )
      ORDER BY display_order IS NULL, display_order, id
    `).all() as Array<{ id: string; display_order: number | null; thread_id: string | null; display_subtitle: string | null }>;

    assert.deepStrictEqual(secondRows.map((row) => [row.id, row.display_order, row.thread_id]), [
      ['curate-20260601T0400Z-new-c', 1, 'next-fresh-thread'],
      ['curate-20260601T0400Z-new-d', 2, 'next-fresh-thread'],
      ['curate-20260531T2235Z-old-unread', 3, oldUnreadSingletonThreadId],
      ['curate-20260601T0158Z-new-a', null, null],
      ['curate-20260601T0158Z-new-b', null, null],
    ]);
    assert.match(secondRows[2]?.display_subtitle ?? '', /^Still unread:/);

    const runCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM feed_arrangement_runs
    `).get() as { count: number };
    assert.strictEqual(runCount.count, 2);
  });

  test('interest, durability, and age do not re-rank explicit agent shipments', async () => {
    const db = getDb();
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at, created_at_ms)
      VALUES (?, 'article', 'unit-test', ?, ?, 'Body', ?, ?, NULL, NULL, ?, ?, ?)
    `);

    const currentAt = new Date(now - 5 * 60 * 1000).toISOString();
    for (const suffix of ['a', 'b'] as const) {
      const id = `curate-20260611T0300Z-new-${suffix}`;
      insert.run(id, id, `New ${suffix}`, 'Fresh', JSON.stringify({}), currentAt, currentAt, now - 5 * 60 * 1000);
    }

    const oldMs = now - 40 * 24 * 60 * 60 * 1000;
    const oldAt = new Date(oldMs).toISOString();
    insert.run(
      'evergreen-gem',
      'evergreen-gem',
      'Deutsch on error correction',
      'A hard-to-vary explanation that still lands.',
      JSON.stringify({ interest: { score: 0.95, durability: 'evergreen', scoredBy: 'claude-bootstrap-20260611' } }),
      oldAt,
      oldAt,
      oldMs,
    );
    insert.run(
      'stale-news-item',
      'stale-news-item',
      'Model release day reactions',
      'Breaking coverage from six weeks ago.',
      JSON.stringify({ interest: { score: 0.9, durability: 'news', scoredBy: 'claude-bootstrap-20260611' } }),
      oldAt,
      oldAt,
      oldMs,
    );

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [
          { feedItemId: 'curate-20260611T0300Z-new-a', displayOrder: 1, threadId: 'fresh-thread' },
          { feedItemId: 'curate-20260611T0300Z-new-b', displayOrder: 2, threadId: 'fresh-thread' },
        ],
        threads: [
          { id: 'fresh-thread', title: 'Fresh thread', active: true },
        ],
      }),
    }));
    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      ok: boolean;
      ordering: Array<{ feedItemId: string; displayOrder: number; threadId?: string | null }>;
      activeThreads: Array<{ id: string }>;
    };
    assert.strictEqual(body.ok, true);

    // The explicit fresh shipment stays first. Omitted eligible rows append in
    // durable evidence order; neither evergreen/news labels nor age move them.
    assert.deepStrictEqual(body.ordering.map((item) => item.feedItemId), [
      'curate-20260611T0300Z-new-a',
      'curate-20260611T0300Z-new-b',
      'evergreen-gem',
      'stale-news-item',
    ]);
    const evergreenSingletonId = getSingletonShipmentThreadId('evergreen-gem');
    const staleNewsSingletonId = getSingletonShipmentThreadId('stale-news-item');
    assert.strictEqual(body.ordering[2]?.threadId, evergreenSingletonId);
    assert.strictEqual(body.ordering[3]?.threadId, staleNewsSingletonId);
    assert.notStrictEqual(evergreenSingletonId, staleNewsSingletonId);
    assert.deepStrictEqual(body.activeThreads.map((thread) => thread.id), ['fresh-thread']);
  });

  test('appends the full eligible unseen set without fixed or away-gap subsets', async () => {
    const db = getDb();
    const now = Date.now();
    const lastAppOpenAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO user_activity (event, timestamp, metadata)
      VALUES ('app_open', ?, NULL)
    `).run(lastAppOpenAt);

    const insert = db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, reason, metadata, display_order, parent_id, published_at, created_at, created_at_ms)
      VALUES (?, 'article', 'unit-test', ?, ?, 'Body', ?, ?, NULL, NULL, ?, ?, ?)
    `);

    const currentAt = new Date(now - 5 * 60 * 1000).toISOString();
    for (const suffix of ['a', 'b'] as const) {
      const id = `curate-20260610T2000Z-new-${suffix}`;
      insert.run(id, id, `New ${suffix}`, 'Fresh', JSON.stringify({}), currentAt, currentAt, now - 5 * 60 * 1000);
    }

    const strongMetadata = {
      bridge: 'High-signal framing that scores near the ceiling.',
      thread: {
        threadId: 'ancient-strong-thread',
        threadTitle: 'Ancient strong thread',
        threadRationale: 'Long-standing high scorers that dominate ranking.',
        prominence: { level: 'high' },
      },
      preferenceMatch: { relevanceScore: 0.95 },
    };
    const ancientMs = now - 35 * 24 * 60 * 60 * 1000;
    const ancientAt = new Date(ancientMs).toISOString();
    for (let index = 0; index < 8; index += 1) {
      const id = `ancient-strong-${index}`;
      insert.run(id, id, `Ancient strong ${index}`, 'Still a very strong durable story.', JSON.stringify(strongMetadata), ancientAt, ancientAt, ancientMs + index);
    }

    const gapMs = now - 24 * 60 * 60 * 1000;
    const gapAt = new Date(gapMs).toISOString();
    for (const suffix of ['one', 'two'] as const) {
      const id = `gap-item-${suffix}`;
      insert.run(
        id,
        id,
        `Accepted while away ${suffix}`,
        'Accepted while the user was away.',
        JSON.stringify({ bridge: 'Accepted during the away gap.' }),
        gapAt,
        gapAt,
        gapMs,
      );
    }

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/arrange', {
      method: 'POST',
      body: JSON.stringify({
        ordering: [
          { feedItemId: 'curate-20260610T2000Z-new-a', displayOrder: 1, threadId: 'fresh-thread' },
          { feedItemId: 'curate-20260610T2000Z-new-b', displayOrder: 2, threadId: 'fresh-thread' },
        ],
        threads: [
          { id: 'fresh-thread', title: 'Fresh thread', active: true },
        ],
      }),
    }));
    assert.strictEqual(response.status, 200);

    const body = await response.json() as {
      ok: boolean;
      ordering: Array<{ feedItemId: string; displayOrder: number; threadId?: string | null }>;
      activeThreads: Array<{ id: string }>;
      carryForwardAudit: {
        mode: string;
        promotedIds: string[];
        candidateIds: string[];
        orderBasis: string;
        deferredBySlateCapIds: string[];
      };
    };

    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.carryForwardAudit.mode, 'auto-injected');
    // Every structurally eligible unseen row is retained. App-open age and
    // proxy strength do not reserve or scale a mechanical subset.
    assert.strictEqual(body.carryForwardAudit.promotedIds.length, 10);
    assert.strictEqual(body.carryForwardAudit.candidateIds.length, 12);
    assert.strictEqual(
      body.carryForwardAudit.orderBasis,
      'prior_agent_shipment_then_evidence_sequence',
    );
    assert.deepStrictEqual(body.carryForwardAudit.deferredBySlateCapIds, []);
    assert.ok(body.carryForwardAudit.promotedIds.includes('gap-item-one'));
    assert.ok(body.carryForwardAudit.promotedIds.includes('gap-item-two'));
    const ancientEntries = body.ordering.filter((item) => item.feedItemId.startsWith('ancient-strong-'));
    assert.strictEqual(ancientEntries.length, 8);
    assert.ok(ancientEntries.every((item) => item.threadId === 'ancient-strong-thread'));
    assert.ok(body.activeThreads.some((thread) => thread.id === 'ancient-strong-thread'));
    assert.strictEqual(
      body.ordering.find((item) => item.feedItemId === 'gap-item-one')?.threadId,
      getSingletonShipmentThreadId('gap-item-one'),
    );
    assert.strictEqual(
      body.ordering.find((item) => item.feedItemId === 'gap-item-two')?.threadId,
      getSingletonShipmentThreadId('gap-item-two'),
    );

    const promotedRows = db.prepare(`
      SELECT id, CAST(json_extract(metadata, '$.carryForward.promotedCount') AS INTEGER) AS promoted_count
      FROM feed
      WHERE CAST(json_extract(metadata, '$.carryForward.promotedCount') AS INTEGER) IS NOT NULL
    `).all() as Array<{ id: string; promoted_count: number }>;
    assert.strictEqual(promotedRows.length, 10);
    for (const row of promotedRows) {
      assert.strictEqual(row.promoted_count, 1);
      assert.ok(body.carryForwardAudit.promotedIds.includes(row.id));
    }
  });
});
