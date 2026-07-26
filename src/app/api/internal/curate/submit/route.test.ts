import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import {
  getCurationLogByRequestId,
  insertCurationLogStart,
} from '@/lib/db/activity';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type RouteModule = {
  POST: (request: Request) => Promise<Response>;
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/curate/submit completion receipts', { concurrency: false }, () => {
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalFeedNotifyUrl: string | undefined;
  let notifyServer: http.Server | null = null;
  let tempDir = '';

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalFeedNotifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-curate-submit-route-test-'));
    await fs.promises.mkdir(path.join(tempDir, 'data'), { recursive: true });

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
    await fs.promises.writeFile(
      path.join(tempDir, 'data', 'config.md'),
      '## Usage Level\nlow\n',
      'utf8',
    );

    notifyServer = http.createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => {
      notifyServer?.listen(0, '127.0.0.1', resolve);
    });
    const address = notifyServer.address();
    assert.ok(address && typeof address === 'object');
    process.env.INTERNAL_FEED_NOTIFY_URL = `http://127.0.0.1:${address.port}/notify`;
  });

  afterEach(async () => {
    if (notifyServer) {
      await new Promise<void>((resolve, reject) => {
        notifyServer?.close((error) => (error ? reject(error) : resolve()));
      });
      notifyServer = null;
    }

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }

    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }

    if (originalFeedNotifyUrl === undefined) {
      delete process.env.INTERNAL_FEED_NOTIFY_URL;
    } else {
      process.env.INTERNAL_FEED_NOTIFY_URL = originalFeedNotifyUrl;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function importRoute(): Promise<RouteModule> {
    const routePath = path.join(process.cwd(), 'src/app/api/internal/curate/submit/route.ts');
    return import(`${pathToFileURL(routePath).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`) as Promise<RouteModule>;
  }

  function curatedItem(id: string, threadId?: string) {
    return {
      id,
      type: 'article',
      source: 'curation',
      sourceId: id,
      title: `Curated item ${id}`,
      text: 'This curator item has enough body text to pass normalization.',
      reason: 'The agent judged this item useful for the current slate.',
      publishedAt: '2026-06-07T00:00:00.000Z',
      metadata: {
        source: 'chat-curator',
        bridge: 'The agent selected this item on its merits.',
        interest: { score: 0.7, durability: 'dated' },
        ...(threadId ? {
          thread: {
            threadId,
            threadTitle: 'A stable editorial thread',
            threadRationale: 'These items form one coherent shipment.',
          },
        } : {}),
      },
    };
  }

  function cycleSummary(
    cycleId: string,
    selected: number,
    options: { considered?: number; topRejectionReasons?: string[] } = {},
  ) {
    const considered = options.considered ?? selected;
    return {
      cycleId,
      considered,
      selected,
      rejected: Math.max(0, considered - selected),
      topRejectionReasons: options.topRejectionReasons ?? [],
      metadata: {
        mode: 'full-cycle',
      },
    };
  }

  function startAutomatedCycle(requestId: string, feedCountBefore = 0) {
    insertCurationLogStart({
      requestId,
      triggeredBy: 'adaptive_heartbeat:unit-test:max_interval_elapsed',
      startedAt: '2026-06-07T12:00:00.000Z',
      feedCountBefore,
    });
  }

  test('accepts cache-derived publishedAtMs for source-owned publish dates', async () => {
    getDb();

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [{
          id: 'published-ms-hn-item',
          type: 'article',
          source: 'hackernews',
          sourceId: 'published-ms-hn-source',
          url: 'https://news.ycombinator.com/item?id=48431981',
          title: 'HN item with cache timestamp',
          text: 'This Hacker News item passes through publishedAtMs from browse cache.',
          reason: 'Regression coverage for cache timestamp fields',
          publishedAtMs: Date.parse('2026-06-06T12:00:00.000Z'),
        }],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as { accepted: number; errors?: unknown[] };
    assert.strictEqual(body.accepted, 1);
    assert.deepStrictEqual(body.errors, []);

    const row = getDb().prepare('SELECT published_at FROM feed WHERE id = ?')
      .get('published-ms-hn-item') as { published_at: string } | undefined;
    assert.strictEqual(row?.published_at, '2026-06-06T12:00:00.000Z');
  });

  test('rejects an article URL that reaches a loopback service', async () => {
    getDb();
    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [{
          ...curatedItem('loopback-article'),
          url: 'http://127.0.0.1:3001/api/internal/phone-health',
          metadata: {
            ...curatedItem('loopback-article').metadata,
            urlPreValidated: true,
          },
        }],
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      accepted: number;
      errors: Array<{ scope: string; error: string }>;
    };
    assert.strictEqual(body.accepted, 0);
    assert.ok(body.errors.some((error) => (
      error.scope === 'item'
      && /public HTTP destination/.test(error.error)
    )));
  });

  test('a truthful one-item automated cycle succeeds without a volume exception', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-one-item-cycle';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('one-item-cycle')],
        cycleSummary: cycleSummary(requestId, 1),
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      accepted: number;
      completionRejected: boolean;
      completionDeferred: boolean;
    };
    assert.strictEqual(body.accepted, 1);
    assert.strictEqual(body.completionRejected, false);
    assert.strictEqual(body.completionDeferred, false);

    const completed = getCurationLogByRequestId(requestId);
    assert.ok(completed?.completedAt);
    assert.strictEqual(completed?.completionStatus, 'success');
    assert.strictEqual(completed?.itemsAdded, 1);
  });

  test('rejects selected=0 when the terminal call would accept one item', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-selected-zero-with-accepted';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('selected-zero-with-accepted')],
        cycleSummary: cycleSummary(requestId, 0, {
          considered: 1,
          topRejectionReasons: ['The receipt incorrectly claims the submitted item was rejected.'],
        }),
      }),
    }));

    assert.strictEqual(response.status, 422);
    const body = await response.json() as {
      accepted: number;
      wouldAccept: number;
      completionRejected: boolean;
      completionRejectedReason: string | null;
    };
    assert.strictEqual(body.accepted, 0);
    assert.strictEqual(body.wouldAccept, 1);
    assert.strictEqual(body.completionRejected, true);
    assert.match(
      body.completionRejectedReason ?? '',
      /selected=0 does not match durable cycle selection evidence=1/,
    );
    const persisted = getDb().prepare('SELECT COUNT(*) AS count FROM feed WHERE id = ?')
      .get('selected-zero-with-accepted') as { count: number };
    assert.strictEqual(persisted.count, 0);
    assert.strictEqual(getCurationLogByRequestId(requestId)?.completedAt, null);
  });

  test('rejects a selected count larger than accepted durable evidence', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-selected-too-large';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('selected-too-large')],
        cycleSummary: cycleSummary(requestId, 2),
      }),
    }));

    assert.strictEqual(response.status, 422);
    const body = await response.json() as {
      accepted: number;
      completionRejectedReason: string | null;
    };
    assert.strictEqual(body.accepted, 0);
    assert.match(
      body.completionRejectedReason ?? '',
      /selected=2 does not match durable cycle selection evidence=1/,
    );
    assert.strictEqual(getCurationLogByRequestId(requestId)?.completedAt, null);
  });

  test('duplicate evidence is included in the terminal selected count', async () => {
    getDb();
    const { POST } = await importRoute();
    const existingResponse = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('duplicate-selection-evidence')],
      }),
    }));
    assert.strictEqual(existingResponse.status, 200);
    assert.strictEqual((await existingResponse.json() as { accepted: number }).accepted, 1);

    const requestId = 'chat-queue-heartbeat-duplicate-selection-evidence';
    startAutomatedCycle(requestId, 1);
    const terminalResponse = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('duplicate-selection-evidence')],
        cycleSummary: cycleSummary(requestId, 0, {
          considered: 1,
          topRejectionReasons: ['The receipt incorrectly omits the duplicate selection evidence.'],
        }),
      }),
    }));

    assert.strictEqual(terminalResponse.status, 422);
    const body = await terminalResponse.json() as {
      completionRejectedReason: string | null;
    };
    assert.match(
      body.completionRejectedReason ?? '',
      /selected=0 does not match durable cycle selection evidence=1.*0 accepted \+ 1 duplicate/,
    );
    assert.strictEqual(getCurationLogByRequestId(requestId)?.completedAt, null);
  });

  test('one-off submits do not close a pending automated cycle', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-one-off-during-pending';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('one-off-during-pending')],
      }),
    }));

    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json() as { accepted: number }).accepted, 1);

    const pending = getCurationLogByRequestId(requestId);
    assert.strictEqual(pending?.completedAt, null);
    assert.strictEqual(pending?.completionStatus, null);
  });

  test('an exact receipt closes its own cycle rather than the latest pending cycle', async () => {
    getDb();
    const earlierCycleId = 'phone-curation-exact-earlier-cycle';
    const laterCycleId = 'phone-curation-exact-later-cycle';
    startAutomatedCycle(earlierCycleId);
    startAutomatedCycle(laterCycleId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        cycleSummary: cycleSummary(earlierCycleId, 0, {
          considered: 1,
          topRejectionReasons: ['The reviewed candidate did not add useful evidence.'],
        }),
      }),
    }));

    assert.strictEqual(response.status, 200);
    assert.strictEqual(getCurationLogByRequestId(earlierCycleId)?.completionStatus, 'successful_empty');
    assert.strictEqual(getCurationLogByRequestId(laterCycleId)?.completedAt, null);
  });

  test('a wrong cycle receipt cannot insert items or close another pending cycle', async () => {
    getDb();
    const pendingCycleId = 'phone-curation-pending-exact-match';
    startAutomatedCycle(pendingCycleId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('wrong-cycle-item')],
        cycleSummary: cycleSummary('phone-curation-wrong-cycle-id', 1),
      }),
    }));
    const body = await response.json() as {
      accepted: number;
      completionRejected: boolean;
      errors: Array<{ scope: string; error: string }>;
    };

    assert.strictEqual(response.status, 422);
    assert.strictEqual(body.accepted, 0);
    assert.strictEqual(body.completionRejected, true);
    assert.ok(body.errors.some((error) => (
      error.scope === 'cycleSummary'
      && /must match the pending automated cycle exactly/.test(error.error)
    )));
    assert.strictEqual(getCurationLogByRequestId(pendingCycleId)?.completedAt, null);
    assert.equal(
      getDb().prepare('SELECT id FROM feed WHERE id = ?').get('wrong-cycle-item'),
      undefined,
    );
  });

  test('candidate receipts must carry the same exact cycle identity as the terminal summary', async () => {
    getDb();
    const cycleId = 'phone-curation-candidate-exact-match';
    startAutomatedCycle(cycleId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        candidates: [{
          cycleId: 'phone-curation-different-candidate-cycle',
          sourceId: 'candidate-wrong-cycle',
          authorUsername: null,
          text: 'Candidate evidence from a different cycle.',
          reason: 'It was reviewed.',
          rejectionReason: 'It did not add useful evidence.',
          timestamp: '2026-07-25T00:00:00.000Z',
        }],
        cycleSummary: cycleSummary(cycleId, 0, {
          considered: 1,
          topRejectionReasons: ['The reviewed candidate did not add useful evidence.'],
        }),
      }),
    }));
    const body = await response.json() as {
      accepted: number;
      errors: Array<{ scope: string; error: string }>;
    };

    assert.strictEqual(response.status, 422);
    assert.strictEqual(body.accepted, 0);
    assert.ok(body.errors.some((error) => (
      error.scope === 'candidate'
      && /must exactly match terminal cycleSummary\.cycleId/.test(error.error)
    )));
    assert.strictEqual(getCurationLogByRequestId(cycleId)?.completedAt, null);
  });

  test('a completed cycle identity is terminal and cannot be reused', async () => {
    getDb();
    const cycleId = 'phone-curation-terminal-id-reuse';
    startAutomatedCycle(cycleId);
    const { POST } = await importRoute();

    const first = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        cycleSummary: cycleSummary(cycleId, 0, {
          considered: 1,
          topRejectionReasons: ['The reviewed candidate did not add useful evidence.'],
        }),
      }),
    }));
    assert.strictEqual(first.status, 200);

    const second = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('terminal-reuse-item')],
        cycleSummary: cycleSummary(cycleId, 1),
      }),
    }));
    const body = await second.json() as {
      accepted: number;
      errors: Array<{ scope: string; error: string }>;
    };
    assert.strictEqual(second.status, 422);
    assert.strictEqual(body.accepted, 0);
    assert.ok(body.errors.some((error) => (
      error.scope === 'cycleSummary' && /already terminal/.test(error.error)
    )));
    assert.equal(
      getDb().prepare('SELECT id FROM feed WHERE id = ?').get('terminal-reuse-item'),
      undefined,
    );
  });

  test('batch size alone never turns a one-off submit into an automated completion receipt', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-large-one-off';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: Array.from({ length: 26 }, (_, index) => curatedItem(`large-one-off-${index + 1}`)),
      }),
    }));

    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json() as { accepted: number }).accepted, 26);

    const pending = getCurationLogByRequestId(requestId);
    assert.strictEqual(pending?.completedAt, null);
    assert.strictEqual(pending?.completionStatus, null);
  });

  test('a receipt-only terminal chunk closes the cycle after earlier items were persisted', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-chunked-terminal-receipt';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const chunkResponse = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('chunked-cycle-item')],
      }),
    }));
    assert.strictEqual(chunkResponse.status, 200);
    assert.strictEqual((await chunkResponse.json() as { accepted: number }).accepted, 1);
    assert.strictEqual(getCurationLogByRequestId(requestId)?.completedAt, null);

    const receiptResponse = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        cycleSummary: cycleSummary(requestId, 1, {
          considered: 2,
          topRejectionReasons: ['One other candidate was stale relative to the accepted item.'],
        }),
      }),
    }));
    assert.strictEqual(receiptResponse.status, 200);
    const receiptBody = await receiptResponse.json() as {
      accepted: number;
      completionRejected: boolean;
      completionDeferred: boolean;
    };
    assert.strictEqual(receiptBody.accepted, 0);
    assert.strictEqual(receiptBody.completionRejected, false);
    assert.strictEqual(receiptBody.completionDeferred, false);

    const completed = getCurationLogByRequestId(requestId);
    assert.ok(completed?.completedAt);
    assert.strictEqual(completed?.completionStatus, 'success');
    assert.strictEqual(completed?.itemsAdded, 1);
  });

  test('receipt-only selected count must match the durable prior-cycle delta', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-chunked-receipt-mismatch';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const chunkResponse = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('chunked-receipt-mismatch-item')],
      }),
    }));
    assert.strictEqual(chunkResponse.status, 200);

    const receiptResponse = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        cycleSummary: cycleSummary(requestId, 0, {
          considered: 1,
          topRejectionReasons: ['The receipt incorrectly omits the earlier durable selection.'],
        }),
      }),
    }));

    assert.strictEqual(receiptResponse.status, 422);
    const body = await receiptResponse.json() as {
      completionRejectedReason: string | null;
    };
    assert.match(
      body.completionRejectedReason ?? '',
      /selected=0 does not match durable cycle selection evidence=1.*1 prior-cycle persisted/,
    );
    assert.strictEqual(getCurationLogByRequestId(requestId)?.completedAt, null);
  });

  test('a selected-item receipt without persisted or duplicate evidence is rejected', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-selected-without-evidence';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        cycleSummary: cycleSummary(requestId, 1),
      }),
    }));

    assert.strictEqual(response.status, 422);
    const body = await response.json() as {
      completionRejected: boolean;
      completionRejectedReason: string | null;
    };
    assert.strictEqual(body.completionRejected, true);
    assert.match(
      body.completionRejectedReason ?? '',
      /selected=1 does not match durable cycle selection evidence=0/,
    );
    assert.strictEqual(getCurationLogByRequestId(requestId)?.completedAt, null);
  });

  test('full-cycle submits preserve a real thread and leave an unrelated item singleton', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-thread-and-singleton';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          curatedItem('thread-member', 'stable-thread'),
          curatedItem('standalone-item'),
        ],
        cycleSummary: cycleSummary(requestId, 2),
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as { accepted: number; completionRejected: boolean };
    assert.strictEqual(body.accepted, 2);
    assert.strictEqual(body.completionRejected, false);

    const rows = getDb().prepare(`
      SELECT id, json_extract(metadata, '$.thread.threadId') AS thread_id
      FROM feed
      WHERE id IN ('thread-member', 'standalone-item')
      ORDER BY id
    `).all() as Array<{ id: string; thread_id: string | null }>;
    assert.deepStrictEqual(rows, [
      { id: 'standalone-item', thread_id: null },
      { id: 'thread-member', thread_id: 'stable-thread' },
    ]);
  });

  test('a small single-source, single-type full cycle is accepted on agent judgment', async () => {
    getDb();

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          curatedItem('same-shape-one'),
          curatedItem('same-shape-two'),
          curatedItem('same-shape-three'),
        ],
        cycleSummary: cycleSummary('cycle-same-shape', 3),
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as { accepted: number; completionRejected: boolean };
    assert.strictEqual(body.accepted, 3);
    assert.strictEqual(body.completionRejected, false);
  });

  test('a zero-item cycle with a complete judgment receipt closes successfully empty', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-truthful-empty';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        cycleSummary: cycleSummary(requestId, 0, {
          considered: 0,
          topRejectionReasons: ['The complete source and carry-forward review found no qualified new items.'],
        }),
      }),
    }));

    assert.strictEqual(response.status, 200);
    const body = await response.json() as {
      accepted: number;
      completionRejected: boolean;
      completionDeferred: boolean;
    };
    assert.strictEqual(body.accepted, 0);
    assert.strictEqual(body.completionRejected, false);
    assert.strictEqual(body.completionDeferred, false);

    const completed = getCurationLogByRequestId(requestId);
    assert.ok(completed?.completedAt);
    assert.strictEqual(completed?.completionStatus, 'successful_empty');
    assert.strictEqual(completed?.itemsAdded, 0);
  });

  test('a zero-item cycle without documented agent judgment is rejected', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-undocumented-empty';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        cycleSummary: cycleSummary(requestId, 0),
      }),
    }));

    assert.strictEqual(response.status, 422);
    const body = await response.json() as {
      accepted: number;
      completionRejected: boolean;
      completionRejectedReason: string | null;
    };
    assert.strictEqual(body.accepted, 0);
    assert.strictEqual(body.completionRejected, true);
    assert.match(body.completionRejectedReason ?? '', /concrete rejection reason/);

    const pending = getCurationLogByRequestId(requestId);
    assert.strictEqual(pending?.completedAt, null);
    assert.strictEqual(pending?.completionStatus, null);
  });

  test('an invalid cycle summary rejects the terminal batch and leaves completion pending', async () => {
    getDb();
    const requestId = 'chat-queue-heartbeat-invalid-receipt';
    startAutomatedCycle(requestId);

    const { POST } = await importRoute();
    const response = await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({
        items: [curatedItem('invalid-receipt-item')],
        cycleSummary: {
          cycleId: 'cycle-invalid-receipt',
          selected: 1,
          topRejectionReasons: [],
        },
      }),
    }));

    assert.strictEqual(response.status, 422);
    const body = await response.json() as {
      accepted: number;
      completionRejected: boolean;
      completionRejectedReason: string | null;
      errors: Array<{ scope: string; error: string }>;
    };
    assert.strictEqual(body.accepted, 0);
    assert.strictEqual(body.completionRejected, true);
    assert.match(body.completionRejectedReason ?? '', /completion receipt is invalid/);
    assert.ok(body.errors.some((error) => error.scope === 'cycleSummary'));
    assert.equal(
      getDb().prepare('SELECT id FROM feed WHERE id = ?').get('invalid-receipt-item'),
      undefined,
    );

    const pending = getCurationLogByRequestId(requestId);
    assert.strictEqual(pending?.completedAt, null);
    assert.strictEqual(pending?.completionStatus, null);
  });
});
