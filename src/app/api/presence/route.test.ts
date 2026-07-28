import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { insertUserActivity } from '@/lib/db/activity';
import { getDb } from '@/lib/db/client';
import { getAppPresence } from '@/lib/db/presence';
import { getServerProcessEpoch } from '@/lib/server-process-epoch';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type PresenceRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

const globalWithDb = globalThis as GlobalWithDb;

const OLD_GENERATION = '00000000-0000-4000-8000-000000000001';
const NEW_GENERATION = '00000000-0000-4000-8000-000000000002';
const RESTART_GENERATION = '00000000-0000-4000-8000-000000000003';

function rawPresenceRequest(payload: unknown): Request {
  return new Request('http://127.0.0.1/api/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function presenceRequest(
  state: unknown,
  generationId: unknown,
  sequence: unknown,
): Request {
  return rawPresenceRequest({ state, generationId, sequence });
}

describe('presence route', { concurrency: false }, () => {
  let originalCwd = '';
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let tempDir = '';
  let routeModule: PresenceRouteModule | null = null;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-presence-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.chdir(tempDir);
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');

    const routeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/presence/route.ts')).href}?case=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    routeModule = await import(routeModuleUrl) as PresenceRouteModule;
  });

  afterEach(async () => {
    routeModule = null;

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.chdir(originalCwd);
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
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('coalesces heartbeats outside behavioral history', async () => {
    assert.ok(routeModule);

    for (let index = 0; index < 4; index += 1) {
      const response: Response = await routeModule.POST(
        presenceRequest('foreground', OLD_GENERATION, index + 1),
      );
      assert.strictEqual(response.status, 200);
    }
    insertUserActivity('app_open');
    insertUserActivity('pull_refresh');
    insertUserActivity('ping');

    const db = getDb();
    const presenceRows = db.prepare(`
      SELECT
        state,
        client_id,
        server_epoch,
        generation_id,
        generation_sequence,
        generation_order
      FROM app_presence
    `).all();
    const activityEvents = db.prepare(`
      SELECT event
      FROM user_activity
      ORDER BY id
    `).all();

    assert.deepStrictEqual(presenceRows, [
      {
        state: 'foreground',
        client_id: OLD_GENERATION,
        server_epoch: getServerProcessEpoch(),
        generation_id: OLD_GENERATION,
        generation_sequence: 4,
        generation_order: 1,
      },
    ]);
    assert.deepStrictEqual(
      db.prepare(`
        SELECT generation_id, generation_order
        FROM app_presence_generations
      `).all(),
      [{ generation_id: OLD_GENERATION, generation_order: 1 }],
    );
    assert.deepStrictEqual(activityEvents, [
      { event: 'app_open' },
      { event: 'pull_refresh' },
      { event: 'ping' },
    ]);
  });

  test('ignores every delayed report from an older page after a newer page owns the lease', async () => {
    assert.ok(routeModule);

    await routeModule.POST(presenceRequest('foreground', OLD_GENERATION, 1));
    await routeModule.POST(presenceRequest('foreground', NEW_GENERATION, 1));
    const staleBackgroundResponse = await routeModule.POST(
      presenceRequest('background', OLD_GENERATION, 3),
    );
    const staleForegroundResponse = await routeModule.POST(
      presenceRequest('foreground', OLD_GENERATION, 2),
    );
    const staleBackgroundBody = await staleBackgroundResponse.json() as { updated?: boolean };
    const staleForegroundBody = await staleForegroundResponse.json() as { updated?: boolean };

    assert.strictEqual(staleBackgroundBody.updated, false);
    assert.strictEqual(staleForegroundBody.updated, false);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, generation_id, generation_sequence
        FROM app_presence
        WHERE id = 1
      `).get(),
      {
        state: 'foreground',
        generation_id: NEW_GENERATION,
        generation_sequence: 1,
      },
    );

    const ownerResponse = await routeModule.POST(
      presenceRequest('background', NEW_GENERATION, 2),
    );
    const ownerBody = await ownerResponse.json() as { updated?: boolean };
    assert.strictEqual(ownerBody.updated, true);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, generation_id, generation_sequence
        FROM app_presence
        WHERE id = 1
      `).get(),
      {
        state: 'background',
        generation_id: NEW_GENERATION,
        generation_sequence: 2,
      },
    );
  });

  test('an early background report prevents its delayed first foreground from suppressing pushes', async () => {
    assert.ok(routeModule);

    await routeModule.POST(presenceRequest('foreground', OLD_GENERATION, 1));
    const earlyBackground = await routeModule.POST(
      presenceRequest('background', RESTART_GENERATION, 2),
    );
    const delayedFirstForeground = await routeModule.POST(
      presenceRequest('foreground', RESTART_GENERATION, 1),
    );

    assert.strictEqual(
      (await earlyBackground.json() as { updated?: boolean }).updated,
      true,
    );
    assert.strictEqual(
      (await delayedFirstForeground.json() as { updated?: boolean }).updated,
      false,
    );
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, generation_id, generation_sequence
        FROM app_presence
        WHERE id = 1
      `).get(),
      {
        state: 'background',
        generation_id: RESTART_GENERATION,
        generation_sequence: 2,
      },
    );
  });

  test('a delayed same-page heartbeat cannot reverse a later background report', async () => {
    assert.ok(routeModule);

    await routeModule.POST(presenceRequest('foreground', OLD_GENERATION, 1));
    const background = await routeModule.POST(
      presenceRequest('background', OLD_GENERATION, 3),
    );
    const delayedHeartbeat = await routeModule.POST(
      presenceRequest('foreground', OLD_GENERATION, 2),
    );

    assert.strictEqual((await background.json() as { updated?: boolean }).updated, true);
    assert.strictEqual(
      (await delayedHeartbeat.json() as { updated?: boolean }).updated,
      false,
    );
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, generation_id, generation_sequence
        FROM app_presence
        WHERE id = 1
      `).get(),
      {
        state: 'background',
        generation_id: OLD_GENERATION,
        generation_sequence: 3,
      },
    );
  });

  test('rejects malformed presence without touching either store', async () => {
    assert.ok(routeModule);

    const responses = await Promise.all([
      routeModule.POST(presenceRequest('visible', OLD_GENERATION, 1)),
      routeModule.POST(presenceRequest('foreground', '', 1)),
      routeModule.POST(presenceRequest('foreground', OLD_GENERATION, 0)),
      routeModule.POST(presenceRequest('foreground', OLD_GENERATION, 1.5)),
      routeModule.POST(presenceRequest('foreground', OLD_GENERATION, '2')),
      routeModule.POST(rawPresenceRequest({
        state: 'foreground',
        clientId: OLD_GENERATION,
      })),
      routeModule.POST(rawPresenceRequest(null)),
      routeModule.POST(rawPresenceRequest([])),
    ]);

    assert.deepStrictEqual(responses.map((response) => response.status), Array(8).fill(400));
    const db = getDb();
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) AS count FROM app_presence').get() as { count: number }).count,
      0,
    );
    assert.strictEqual(
      (
        db.prepare('SELECT COUNT(*) AS count FROM app_presence_generations')
          .get() as { count: number }
      ).count,
      0,
    );
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) AS count FROM user_activity').get() as { count: number }).count,
      0,
    );
  });

  test('never trusts a foreground lease from a previous server process', async () => {
    assert.ok(routeModule);

    const currentEpoch = getServerProcessEpoch();
    getDb().prepare(`
      INSERT INTO app_presence_generations (generation_id)
      VALUES (?)
    `).run(OLD_GENERATION);
    const oldOrder = (
      getDb().prepare(`
        SELECT generation_order
        FROM app_presence_generations
        WHERE generation_id = ?
      `).get(OLD_GENERATION) as { generation_order: number }
    ).generation_order;
    getDb().prepare(`
      INSERT INTO app_presence (
        id,
        state,
        client_id,
        last_seen_at,
        server_epoch,
        generation_id,
        generation_sequence,
        generation_order
      ) VALUES (
        1,
        'foreground',
        @generation_id,
        @last_seen_at,
        'previous-server-process',
        @generation_id,
        4,
        @generation_order
      )
    `).run({
      generation_id: OLD_GENERATION,
      generation_order: oldOrder,
      last_seen_at: new Date().toISOString(),
    });

    assert.strictEqual(getAppPresence(), null);

    getDb().exec(`
      CREATE TRIGGER fail_presence_refresh
      BEFORE UPDATE ON app_presence
      BEGIN
        SELECT RAISE(ABORT, 'simulated presence persistence failure');
      END;
    `);
    await assert.rejects(
      routeModule.POST(presenceRequest('foreground', RESTART_GENERATION, 1)),
      /simulated presence persistence failure/,
    );
    getDb().exec('DROP TRIGGER fail_presence_refresh;');
    assert.strictEqual(getAppPresence(), null);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT
          state,
          generation_id,
          generation_sequence,
          generation_order,
          server_epoch
        FROM app_presence
        WHERE id = 1
      `).get(),
      {
        state: 'foreground',
        generation_id: OLD_GENERATION,
        generation_sequence: 4,
        generation_order: oldOrder,
        server_epoch: 'previous-server-process',
      },
    );
    assert.strictEqual(
      (
        getDb().prepare('SELECT COUNT(*) AS count FROM app_presence_generations')
          .get() as { count: number }
      ).count,
      1,
      'failed refresh must roll back registration of the new page generation',
    );
    assert.strictEqual(
      (getDb().prepare('SELECT COUNT(*) AS count FROM user_activity').get() as { count: number }).count,
      0,
      'failed restart refresh must not create activity history',
    );

    const refreshed = await routeModule.POST(
      presenceRequest('foreground', RESTART_GENERATION, 1),
    );
    assert.strictEqual(refreshed.status, 200);
    assert.deepStrictEqual(getAppPresence(), {
      state: 'foreground',
      clientId: RESTART_GENERATION,
      lastSeenAt: (
        getDb().prepare('SELECT last_seen_at FROM app_presence WHERE id = 1').get() as {
          last_seen_at: string;
        }
      ).last_seen_at,
    });
    assert.strictEqual(
      (
        getDb().prepare('SELECT server_epoch FROM app_presence WHERE id = 1').get() as {
          server_epoch: string;
        }
      ).server_epoch,
      currentEpoch,
    );

    const delayedOldPage = await routeModule.POST(
      presenceRequest('foreground', OLD_GENERATION, 5),
    );
    assert.strictEqual(
      (await delayedOldPage.json() as { updated?: boolean }).updated,
      false,
    );
    assert.strictEqual(getAppPresence()?.clientId, RESTART_GENERATION);
  });
});
