import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import {
  getCurationLogByRequestId,
  insertCurationLogStart,
} from '@/lib/db/activity';
import {
  getFeedItemBySourceId,
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

describe('/api/internal/curate/submit completion receipts', { concurrency: false }, () => {
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalFeedNotifyUrl: string | undefined;
  let notifyServer: http.Server | null = null;
  let suiteTempDir = '';
  let suiteDataDir = '';
  let testDbPath = '';
  let notifyBodies: Array<Record<string, unknown>> = [];

  before(async () => {
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalFeedNotifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL;
    suiteTempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'evogent-curate-submit-route-test-'),
    );
    suiteDataDir = path.join(suiteTempDir, 'data');
    await fs.promises.mkdir(suiteDataDir, { recursive: true });
    process.env.DATA_DIR = suiteDataDir;
    await fs.promises.writeFile(
      path.join(suiteDataDir, 'config.md'),
      '## Usage Level\nlow\n',
      'utf8',
    );
  });

  beforeEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    testDbPath = path.join(
      suiteDataDir,
      `media-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.MEDIA_AGENT_DB_PATH = testDbPath;
    notifyBodies = [];

    notifyServer = http.createServer((request, response) => {
      let rawBody = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        rawBody += chunk;
      });
      request.on('end', () => {
        if (rawBody) {
          const parsed = JSON.parse(rawBody) as Record<string, unknown>;
          notifyBodies.push(parsed);
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
      });
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

    if (testDbPath) {
      await fs.promises.rm(testDbPath, { force: true });
      await fs.promises.rm(`${testDbPath}-shm`, { force: true });
      await fs.promises.rm(`${testDbPath}-wal`, { force: true });
    }
  });

  after(async () => {
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

    if (suiteTempDir) {
      await fs.promises.rm(suiteTempDir, { recursive: true, force: true });
    }
  });

  async function importRoute(): Promise<RouteModule> {
    const routePath = path.join(process.cwd(), 'src/app/api/internal/curate/submit/route.ts');
    return import(`${pathToFileURL(routePath).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`) as Promise<RouteModule>;
  }

  async function importResolveRoute(): Promise<RouteModule> {
    const routePath = path.join(
      process.cwd(),
      'src/app/api/internal/notifications/resolve/route.ts',
    );
    return import(
      `${pathToFileURL(routePath).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
    ) as Promise<RouteModule>;
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

  function capabilityNotice(
    sourceId: string,
    options: {
      id?: string;
      type?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ) {
    return {
      id: options.id ?? `${sourceId}-row`,
      type: options.type ?? 'notification',
      source: options.source ?? 'phone',
      sourceId,
      title: 'Owner action required',
      text: 'Open the platform Settings control to restore this optional capability.',
      metadata: {
        notificationId: sourceId,
        incidentKey: `phone-capability-${sourceId}`,
        reactivateOnRepeat: true,
        userActionKind: 'android_accessibility_access',
        ...options.metadata,
      },
    };
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

  test('reactivatable system notice is visible again after resolve then recurrence', async () => {
    getDb();
    const { POST } = await importRoute();
    const { POST: resolveNotification } = await importResolveRoute();
    const item = {
      id: 'capability-notice-row',
      type: 'notification',
      source: 'phone',
      sourceId: 'capability-notice-source',
      title: 'Owner action required',
      text: 'Open the platform Settings control to restore this optional capability.',
      metadata: {
        notificationId: 'capability-notice-source',
        incidentKey: 'phone-capability-test',
        reactivateOnRepeat: true,
        userActionKind: 'android_accessibility_access',
      },
    };
    const submit = () => POST(new Request(
      'http://127.0.0.1/api/internal/curate/submit',
      { method: 'POST', body: JSON.stringify({ items: [item] }) },
    ));

    const first = await submit();
    assert.strictEqual(first.status, 200);
    assert.strictEqual((await first.json() as { accepted: number }).accepted, 1);
    const stored = getFeedItemBySourceId(item.sourceId);
    assert.ok(stored);
    const resolved = await resolveNotification(new Request(
      'http://127.0.0.1/api/internal/notifications/resolve',
      {
        method: 'POST',
        body: JSON.stringify({ notificationId: item.sourceId }),
      },
    ));
    assert.strictEqual(resolved.status, 200);
    assert.strictEqual(
      getFeedItemBySourceId(item.sourceId)?.suggestionStatus,
      'dismissed',
    );

    const broadcastsBeforeRecurrence = notifyBodies.length;
    const recurring = await submit();
    assert.strictEqual(recurring.status, 200);
    const recurringBody = await recurring.json() as {
      accepted: number;
      duplicates: number;
      reactivated: number;
    };
    assert.strictEqual(recurringBody.accepted, 0);
    assert.strictEqual(recurringBody.duplicates, 1);
    assert.strictEqual(recurringBody.reactivated, 1);
    assert.strictEqual(
      getFeedItemBySourceId(item.sourceId)?.suggestionStatus,
      'pending',
    );
    assert.strictEqual(notifyBodies.length, broadcastsBeforeRecurrence + 1);
    const recurrenceBroadcast = notifyBodies.at(-1) as {
      count?: unknown;
      items?: Array<{ id?: unknown; sourceId?: unknown; suggestionStatus?: unknown }>;
    };
    assert.strictEqual(recurrenceBroadcast.count, 1);
    assert.deepStrictEqual(
      recurrenceBroadcast.items?.map(({ id, sourceId, suggestionStatus }) => ({
        id,
        sourceId,
        suggestionStatus,
      })),
      [{
        id: item.id,
        sourceId: item.sourceId,
        suggestionStatus: 'pending',
      }],
    );

    const stillActive = await submit();
    const activeBody = await stillActive.json() as {
      accepted: number;
      duplicates: number;
      reactivated: number;
    };
    assert.strictEqual(activeBody.accepted, 0);
    assert.strictEqual(activeBody.duplicates, 1);
    assert.strictEqual(activeBody.reactivated, 0);
  });

  test('recurrence rejects every incomplete or mismatched capability identity guard', async () => {
    getDb();
    const { POST } = await importRoute();
    const { POST: resolveNotification } = await importResolveRoute();
    type Scenario = {
      name: string;
      incoming?: {
        type?: string;
        source?: string;
        metadata?: Record<string, unknown>;
      };
      mutateStored?: (stored: NonNullable<ReturnType<typeof getFeedItemBySourceId>>) => {
        type?: string;
        source?: string;
        metadata?: Record<string, unknown>;
      };
    };
    const scenarios: Scenario[] = [
      {
        name: 'incoming opt-in is absent',
        incoming: { metadata: { reactivateOnRepeat: undefined } },
      },
      {
        name: 'stored opt-in is absent',
        mutateStored: (stored) => ({
          metadata: { ...stored.metadata, reactivateOnRepeat: undefined },
        }),
      },
      {
        name: 'incoming type is not notification',
        incoming: { type: 'analysis' },
      },
      {
        name: 'stored type is not notification',
        mutateStored: () => ({ type: 'analysis' }),
      },
      {
        name: 'incoming source is not phone',
        incoming: { source: 'curation' },
      },
      {
        name: 'stored source is not phone',
        mutateStored: () => ({ source: 'curation' }),
      },
      {
        name: 'incoming action is not allowlisted',
        incoming: { metadata: { userActionKind: 'arbitrary_phone_action' } },
      },
      {
        name: 'stored action is not allowlisted',
        mutateStored: (stored) => ({
          metadata: { ...stored.metadata, userActionKind: 'arbitrary_phone_action' },
        }),
      },
      {
        name: 'incoming and stored allowlisted actions differ',
        incoming: { metadata: { userActionKind: 'phone_host_policy' } },
      },
      {
        name: 'incoming notification ID differs from canonical source ID',
        incoming: { metadata: { notificationId: 'different-notification-id' } },
      },
      {
        name: 'stored notification ID differs from canonical source ID',
        mutateStored: (stored) => ({
          metadata: { ...stored.metadata, notificationId: 'different-notification-id' },
        }),
      },
      {
        name: 'incoming incident key is absent',
        incoming: { metadata: { incidentKey: undefined } },
      },
      {
        name: 'incoming incident key differs',
        incoming: { metadata: { incidentKey: 'different-incident-key' } },
      },
      {
        name: 'stored incident key is absent',
        mutateStored: (stored) => ({
          metadata: { ...stored.metadata, incidentKey: undefined },
        }),
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const sourceId = `guarded-capability-${index}`;
      const initial = await POST(new Request(
        'http://127.0.0.1/api/internal/curate/submit',
        {
          method: 'POST',
          body: JSON.stringify({ items: [capabilityNotice(sourceId)] }),
        },
      ));
      assert.strictEqual(initial.status, 200, scenario.name);
      assert.strictEqual(
        (await initial.json() as { accepted: number }).accepted,
        1,
        scenario.name,
      );
      const resolved = await resolveNotification(new Request(
        'http://127.0.0.1/api/internal/notifications/resolve',
        {
          method: 'POST',
          body: JSON.stringify({ notificationId: sourceId }),
        },
      ));
      assert.strictEqual(resolved.status, 200, scenario.name);

      const stored = getFeedItemBySourceId(sourceId);
      assert.ok(stored, scenario.name);
      const storedMutation = scenario.mutateStored?.(stored);
      if (storedMutation) {
        getDb().prepare(`
          UPDATE feed
          SET type = ?, source = ?, metadata = ?
          WHERE id = ?
        `).run(
          storedMutation.type ?? stored.type,
          storedMutation.source ?? stored.source,
          JSON.stringify(storedMutation.metadata ?? stored.metadata),
          stored.id,
        );
      }

      const duplicate = capabilityNotice(sourceId, {
        id: `${sourceId}-duplicate`,
        type: scenario.incoming?.type,
        source: scenario.incoming?.source,
        metadata: scenario.incoming?.metadata,
      });
      const response = await POST(new Request(
        'http://127.0.0.1/api/internal/curate/submit',
        {
          method: 'POST',
          body: JSON.stringify({ items: [duplicate] }),
        },
      ));
      assert.strictEqual(response.status, 200, scenario.name);
      const body = await response.json() as {
        duplicates: number;
        reactivated: number;
      };
      assert.strictEqual(body.duplicates, 1, scenario.name);
      assert.strictEqual(body.reactivated, 0, scenario.name);
      assert.strictEqual(
        getFeedItemBySourceId(sourceId)?.suggestionStatus,
        'dismissed',
        scenario.name,
      );
    }
  });

  test('a valid automated-cycle receipt cannot reactivate a dismissed capability notice', async () => {
    getDb();
    const { POST } = await importRoute();
    const { POST: resolveNotification } = await importResolveRoute();
    const sourceId = 'rejected-cycle-capability-notice';
    const notice = {
      id: 'rejected-cycle-capability-row',
      type: 'notification',
      source: 'phone',
      sourceId,
      title: 'Owner action required',
      text: 'Open the platform Settings control to restore this optional capability.',
      metadata: {
        notificationId: sourceId,
        incidentKey: 'phone-capability-rejected-cycle',
        reactivateOnRepeat: true,
        userActionKind: 'phone_host_policy',
        interest: { score: 0.5, durability: 'dated' },
      },
    };
    await POST(new Request('http://127.0.0.1/api/internal/curate/submit', {
      method: 'POST',
      body: JSON.stringify({ items: [notice] }),
    }));
    await resolveNotification(new Request(
      'http://127.0.0.1/api/internal/notifications/resolve',
      { method: 'POST', body: JSON.stringify({ notificationId: sourceId }) },
    ));

    const cycleId = 'phone-curation-valid-capability-no-reactivation';
    startAutomatedCycle(cycleId, 1);

    const terminal = await POST(new Request(
      'http://127.0.0.1/api/internal/curate/submit',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [{ ...notice, id: 'automated-cycle-duplicate-row' }],
          cycleSummary: cycleSummary(cycleId, 1),
        }),
      },
    ));
    assert.strictEqual(terminal.status, 200);
    const terminalBody = await terminal.json() as {
      duplicates: number;
      reactivated: number;
      completionRejected: boolean;
    };
    assert.strictEqual(terminalBody.duplicates, 1);
    assert.strictEqual(terminalBody.reactivated, 0);
    assert.strictEqual(terminalBody.completionRejected, false);
    assert.strictEqual(
      getFeedItemBySourceId(sourceId)?.suggestionStatus,
      'dismissed',
    );
    assert.strictEqual(
      getCurationLogByRequestId(cycleId)?.completionStatus,
      'successful_empty',
    );
  });

  test('a mixed one-off request with an item error cannot reactivate a dismissed notice', async () => {
    getDb();
    const { POST } = await importRoute();
    const { POST: resolveNotification } = await importResolveRoute();
    const sourceId = 'mixed-error-capability-notice';

    const initial = await POST(new Request(
      'http://127.0.0.1/api/internal/curate/submit',
      {
        method: 'POST',
        body: JSON.stringify({ items: [capabilityNotice(sourceId)] }),
      },
    ));
    assert.strictEqual(initial.status, 200);
    const resolved = await resolveNotification(new Request(
      'http://127.0.0.1/api/internal/notifications/resolve',
      {
        method: 'POST',
        body: JSON.stringify({ notificationId: sourceId }),
      },
    ));
    assert.strictEqual(resolved.status, 200);

    const mixed = await POST(new Request(
      'http://127.0.0.1/api/internal/curate/submit',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [
            capabilityNotice(sourceId, { id: 'mixed-error-capability-duplicate' }),
            {
              id: 'mixed-error-invalid-item',
              type: 'not-a-feed-type',
              source: 'unit-test',
              sourceId: 'mixed-error-invalid-source',
              title: 'Invalid item',
              text: 'This item intentionally fails shape validation.',
            },
          ],
        }),
      },
    ));
    assert.strictEqual(mixed.status, 200);
    const mixedBody = await mixed.json() as {
      duplicates: number;
      reactivated: number;
      errors: Array<{ scope: string; index?: number }>;
    };
    assert.strictEqual(mixedBody.duplicates, 1);
    assert.strictEqual(mixedBody.reactivated, 0);
    assert.ok(mixedBody.errors.some((error) => (
      error.scope === 'item' && error.index === 1
    )));
    assert.strictEqual(
      getFeedItemBySourceId(sourceId)?.suggestionStatus,
      'dismissed',
    );
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
