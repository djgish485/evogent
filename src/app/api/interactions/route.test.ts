import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/interactions thread feedback', () => {
  let originalDbPath: string | undefined;
  let originalDataDir: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalDataDir = process.env.DATA_DIR;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-thread-feedback-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.DATA_DIR = tempDir;
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

    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('persists structured thread feedback and mirrors it to preferences', async () => {
    const { POST } = await import(`./route?t=${Date.now()}`);
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at)
      VALUES ('probe-item-1', 'article', 'unit-test', 'Probe item body', ?, ?)
    `).run(
      JSON.stringify({
        cycleId: 'cycle-1',
        thread: {
          threadId: 'thread-1',
          threadTitle: 'Probe thread',
        },
        feedbackProbe: {
          reason: 'Good but uncertain.',
          uncertainty: 'topic fit',
        },
      }),
      '2026-04-26T12:00:00.000Z',
    );

    const response = await POST(new Request('http://127.0.0.1/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedItemId: 'probe-item-1',
        action: 'thread_feedback',
        threadFeedback: {
          threadId: 'thread-1',
          cycleId: 'cycle-1',
          vote: 'less',
          threadTitle: 'Probe thread',
          reason: 'too much of this lane',
          category: 'topic',
          probeReason: 'Good but uncertain.',
          probeUncertainty: 'topic fit',
          sourceItemIds: ['probe-item-1', 'probe-item-2'],
          originSessionId: 'session-1',
        },
      }),
    }));

    assert.strictEqual(response.status, 200);

    const feedbackRow = db.prepare(`
      SELECT thread_id, vote, reason, category, probe_uncertainty, source_item_ids
      FROM thread_feedback
      WHERE thread_id = 'thread-1'
    `).get() as {
      thread_id: string;
      vote: string;
      reason: string;
      category: string;
      probe_uncertainty: string;
      source_item_ids: string;
    };

    assert.strictEqual(feedbackRow.vote, 'less');
    assert.strictEqual(feedbackRow.reason, 'too much of this lane');
    assert.strictEqual(feedbackRow.category, 'topic');
    assert.strictEqual(feedbackRow.probe_uncertainty, 'topic fit');
    assert.deepStrictEqual(JSON.parse(feedbackRow.source_item_ids), ['probe-item-1', 'probe-item-2']);

    const preferenceRow = db.prepare(`
      SELECT signal_type, source, text, reason
      FROM preferences
      WHERE source = 'app_thread_feedback_probe'
    `).get() as {
      signal_type: string;
      source: string;
      text: string;
      reason: string;
    };

    assert.strictEqual(preferenceRow.signal_type, 'disliked');
    assert.match(preferenceRow.text, /Feedback probe on thread "Probe thread"/);
    assert.match(preferenceRow.text, /Uncertainty: topic fit/);
    assert.strictEqual(preferenceRow.reason, 'too much of this lane');

    const context = await fs.promises.readFile(path.join(tempDir, 'preferences-context.md'), 'utf8');
    assert.match(context, /Thread Feedback Evidence \(newest first\)/);
    assert.match(context, /\[LESS\] "Probe thread"/);

    await delay(500);
  });

  test('records passive view and expand interactions idempotently', async () => {
    const { POST } = await import(`./route?t=${Date.now()}`);
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at)
      VALUES ('passive-item-1', 'article', 'unit-test', 'Passive item body', ?)
    `).run('2026-04-26T12:00:00.000Z');

    for (const action of ['view', 'view', 'expand'] as const) {
      const response = await POST(new Request('http://127.0.0.1/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: 'passive-item-1',
          action,
        }),
      }));

      assert.strictEqual(response.status, 200);
    }

    const rows = db.prepare(`
      SELECT action, COUNT(*) AS count
      FROM interactions
      WHERE feed_item_id = 'passive-item-1'
      GROUP BY action
      ORDER BY action
    `).all() as Array<{ action: string; count: number }>;

    assert.deepStrictEqual(rows, [
      { action: 'expand', count: 1 },
      { action: 'view', count: 1 },
    ]);
  });

  test('keeps source undo actionable when authoritative cancellation fails', async () => {
    const { POST } = await import(`./route?t=${Date.now()}`);
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, metadata, published_at
      ) VALUES (
        'source-undo-failure', 'suggestion', 'phone', 'source-scout-v2-example',
        'Adding Example as a source', 'Source setup', ?, ?
      )
    `).run(
      JSON.stringify({
        suggestionType: 'source_setup',
        suggestionStatus: 'pending',
        sourceName: 'example',
        sourcePackage: 'com.example.app',
      }),
      '2026-04-26T12:00:00.000Z',
    );
    db.exec(`
      CREATE TRIGGER reject_test_source_optout
      BEFORE INSERT ON browse_cache_source_optouts
      BEGIN
        SELECT RAISE(ABORT, 'simulated tombstone failure');
      END;
    `);

    const response = await POST(new Request('http://127.0.0.1/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedItemId: 'source-undo-failure',
        action: 'dismiss_suggestion',
        userInitiated: true,
      }),
    }));

    assert.strictEqual(response.status, 500);
    const row = db.prepare(`
      SELECT metadata
      FROM feed
      WHERE id = 'source-undo-failure'
    `).get() as { metadata: string };
    assert.strictEqual(JSON.parse(row.metadata).suggestionStatus, 'pending');
    assert.deepStrictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM browse_cache_source_optouts
        WHERE source = 'example'
      `).get(),
      { count: 0 },
    );
  });

  test('"Not this app" commits source cancellation before dismissing the card', async () => {
    const { POST } = await import(`./route?t=${Date.now()}`);
    const db = getDb();
    const sourceRoot = path.join(tempDir, 'phone-sources');
    fs.mkdirSync(path.join(sourceRoot, '.queue'), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(sourceRoot, 'manual-example.txt'),
      'validated recipe fixture\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(sourceRoot, '.queue', 'discovery-v2-manual-example.json'),
      '{}\n',
      { mode: 0o600 },
    );
    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, metadata, published_at
      ) VALUES (
        'manual-source-decline', 'suggestion', 'phone', 'source-scout-v2-example',
        'Add Example as a source?', 'Source setup', ?, ?
      )
    `).run(
      JSON.stringify({
        suggestionType: 'source_setup',
        suggestionStatus: 'pending',
        sourceName: 'manual-example',
        sourcePackage: 'com.example.manual',
        actions: [
          {
            label: 'Set Example up as a source',
            kind: 'execute',
            instruction: 'Queue discovery.',
          },
          { label: 'Not this app', kind: 'cancel_source' },
        ],
      }),
      '2026-04-26T12:00:00.000Z',
    );

    const response = await POST(new Request('http://127.0.0.1/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedItemId: 'manual-source-decline',
        action: 'accept_suggestion',
        chosenAction: { label: 'Not this app' },
      }),
    }));

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      ok: true,
      suggestionStatus: 'dismissed',
      source: 'manual-example',
    });
    assert.deepStrictEqual(
      db.prepare(`
        SELECT source
        FROM browse_cache_source_optouts
        WHERE source = 'manual-example'
      `).get(),
      { source: 'manual-example' },
    );
    const row = db.prepare(`
      SELECT metadata
      FROM feed
      WHERE id = 'manual-source-decline'
    `).get() as { metadata: string };
    assert.strictEqual(JSON.parse(row.metadata).suggestionStatus, 'dismissed');
    assert.strictEqual(
      fs.readFileSync(path.join(sourceRoot, '.optout'), 'utf8'),
      'manual-example com.example.manual\n',
    );
    assert.strictEqual(
      fs.existsSync(path.join(sourceRoot, 'manual-example.txt')),
      false,
    );
    assert.strictEqual(
      fs.existsSync(
        path.join(sourceRoot, '.queue', 'discovery-v2-manual-example.json'),
      ),
      false,
    );
  });

  test('"Not this app" stays pending when its tombstone cannot commit', async () => {
    const { POST } = await import(`./route?t=${Date.now()}`);
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, metadata, published_at
      ) VALUES (
        'manual-source-decline-failure', 'suggestion', 'phone',
        'source-scout-v2-reject', 'Add Reject as a source?', 'Source setup', ?, ?
      )
    `).run(
      JSON.stringify({
        suggestionType: 'source_setup',
        suggestionStatus: 'pending',
        sourceName: 'manual-reject',
        sourcePackage: 'com.example.reject',
        actions: [{ label: 'Not this app', kind: 'cancel_source' }],
      }),
      '2026-04-26T12:00:00.000Z',
    );
    db.exec(`
      CREATE TRIGGER reject_manual_source_optout
      BEFORE INSERT ON browse_cache_source_optouts
      BEGIN
        SELECT RAISE(ABORT, 'simulated tombstone failure');
      END;
    `);

    const response = await POST(new Request('http://127.0.0.1/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedItemId: 'manual-source-decline-failure',
        action: 'accept_suggestion',
        chosenAction: { label: 'Not this app' },
      }),
    }));

    assert.strictEqual(response.status, 500);
    const row = db.prepare(`
      SELECT metadata
      FROM feed
      WHERE id = 'manual-source-decline-failure'
    `).get() as { metadata: string };
    assert.strictEqual(JSON.parse(row.metadata).suggestionStatus, 'pending');
    assert.deepStrictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM browse_cache_source_optouts
        WHERE source = 'manual-reject'
      `).get(),
      { count: 0 },
    );
  });

  test('records validated detail engagement sessions separately from explicit interactions', async () => {
    const { POST } = await import(`./route?t=${Date.now()}`);
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, title, text, published_at)
      VALUES ('detail-item-1', 'article', 'unit-test', 'Detail title', 'Detail body', ?)
    `).run('2026-04-26T12:00:00.000Z');

    for (const engagement of [
      {
        sessionId: 'detail:item:session-1',
        phase: 'open',
        activeDwellMs: 0,
        scrollDepthPercent: 0,
        surface: 'detail_overlay',
      },
      {
        sessionId: 'detail:item:session-1',
        phase: 'close',
        activeDwellMs: 18_500,
        scrollDepthPercent: 72,
        userScrolled: true,
        surface: 'detail_overlay',
      },
    ]) {
      const response = await POST(new Request('http://127.0.0.1/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: 'detail-item-1',
          action: 'engagement',
          engagement,
        }),
      }));
      assert.strictEqual(response.status, 200);
    }

    const row = db.prepare(`
      SELECT active_dwell_ms, max_scroll_depth_pct, user_scrolled, closed_at, item_snapshot
      FROM feed_engagement_sessions
      WHERE session_id = 'detail:item:session-1'
    `).get() as {
      active_dwell_ms: number;
      max_scroll_depth_pct: number;
      user_scrolled: number;
      closed_at: string | null;
      item_snapshot: string;
    };

    assert.strictEqual(row.active_dwell_ms, 18_500);
    assert.strictEqual(row.max_scroll_depth_pct, 72);
    assert.strictEqual(row.user_scrolled, 1);
    assert.ok(row.closed_at);
    assert.strictEqual(JSON.parse(row.item_snapshot).title, 'Detail title');
    assert.deepStrictEqual(
      db.prepare(`SELECT COUNT(*) AS count FROM interactions`).get() as { count: number },
      { count: 0 },
    );

    const invalidResponse = await POST(new Request('http://127.0.0.1/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedItemId: 'detail-item-1',
        action: 'engagement',
        engagement: {
          sessionId: 'short',
          phase: 'close',
        },
      }),
    }));
    assert.strictEqual(invalidResponse.status, 400);
  });

  test('acknowledges phone-notification UI interactions without creating agent evidence', async () => {
    const { POST } = await import(`./route?t=${Date.now()}`);
    const db = getDb();
    const privateCanary = 'PRIVATE_NOTIFICATION_INTERACTION_WRITE_CANARY_8372';
    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, published_at
      ) VALUES (
        'private-phone-notification', 'notification', 'phone-notification',
        'phone-notification:private-interaction', ?, ?, ?
      )
    `).run(
      `Private title ${privateCanary}`,
      `Private body ${privateCanary}`,
      '2026-07-28T12:00:00.000Z',
    );

    const actions = [
      'like',
      'unlike',
      'thumbsup',
      'thumbsdown',
      'undo_thumbsup',
      'undo_thumbsdown',
      'accept_suggestion',
      'dismiss_suggestion',
      'undo_suggestion',
      'thread_feedback',
      'view',
      'expand',
      'engagement',
    ];
    for (const action of actions) {
      const response = await POST(new Request('http://127.0.0.1/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: 'private-phone-notification',
          action,
          reason: privateCanary,
          engagement: {
            sessionId: 'private:notification:session',
            phase: 'close',
            activeDwellMs: 50_000,
          },
          threadFeedback: {
            threadId: 'private-notification-thread',
            vote: 'more',
            reason: privateCanary,
          },
        }),
      }));
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        ok: true,
        action,
        ignoredForAgentEvidence: true,
      });
    }

    for (const tableName of [
      'interactions',
      'feed_engagement_sessions',
      'preferences',
      'preference_vectors',
      'thread_feedback',
    ]) {
      assert.deepStrictEqual(
        db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get(),
        { count: 0 },
      );
    }
    assert.strictEqual(
      fs.existsSync(path.join(tempDir, 'preferences-context.md')),
      false,
    );
  });
});
