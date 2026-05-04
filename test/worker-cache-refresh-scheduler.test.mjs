import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import Database from 'better-sqlite3';

function extractLatestBrowseCacheRefresh(source) {
  const start = source.indexOf('const BROWSE_CACHE_REFRESH_TIMESTAMP_SKEW_MS');
  const end = source.indexOf('\n\nfunction getLatestUserActivityAtMs');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to locate latest browse-cache refresh helper in worker.js');
  }

  return source.slice(start, end);
}

function extractCacheRefreshScheduler(source) {
  const start = source.indexOf('async function runCacheRefreshSchedulerCheck');
  const end = source.indexOf('\n\nfunction createBackgroundWorker', start);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to locate cache refresh scheduler in worker.js');
  }

  return source.slice(start, end);
}

function loadCacheRefreshScheduler(sandbox) {
  const workerSource = fs.readFileSync(path.join(process.cwd(), 'worker.js'), 'utf8');
  vm.runInNewContext(
    `let cacheRefreshCheckInFlight = false;
${extractCacheRefreshScheduler(workerSource)}
globalThis.runCacheRefreshSchedulerCheck = runCacheRefreshSchedulerCheck;`,
    sandbox,
  );

  return sandbox.runCacheRefreshSchedulerCheck;
}

function loadLatestBrowseCacheRefresh(sandbox) {
  const workerSource = fs.readFileSync(path.join(process.cwd(), 'worker.js'), 'utf8');
  vm.runInNewContext(
    `${extractLatestBrowseCacheRefresh(workerSource)}
globalThis.getLatestBrowseCacheRefreshAtMs = getLatestBrowseCacheRefreshAtMs;`,
    sandbox,
  );

  return sandbox.getLatestBrowseCacheRefreshAtMs;
}

function createRefreshRunDb(rows) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE browse_cache_refresh_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      status TEXT NOT NULL,
      items_added INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
  `);

  const insert = db.prepare(`
    INSERT INTO browse_cache_refresh_runs (
      id,
      source,
      triggered_by,
      started_at_ms,
      completed_at_ms,
      status,
      items_added,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  for (const row of rows) {
    insert.run(
      row.id,
      row.source,
      row.triggeredBy ?? 'test',
      row.startedAtMs ?? null,
      row.completedAtMs ?? null,
      row.status ?? 'completed',
      row.itemsAdded ?? 0,
    );
  }

  return db;
}

function createSchedulerSandbox({
  now,
  enqueued,
  activityMultiplier = 1,
  latestRefreshAtMs = null,
  pending = false,
  backgroundSourceBrowsingEnabled = true,
  sources,
  intervals,
  db = null,
}) {
  return {
    BACKGROUND_JOB_NAMES: { CACHE_REFRESH: 'cache_refresh' },
    Date: { now: () => now },
    console: { log: () => {}, warn: () => {} },
    dataPath: () => '/tmp/config.md',
    enqueueBackgroundJob: async (_name, payload) => { enqueued.push(payload); },
    getCacheRefreshActivityMultiplier: () => activityMultiplier,
    getChatStatusDb: () => db,
    getLatestBrowseCacheRefreshAtMs: () => latestRefreshAtMs,
    hasPendingCacheRefreshJob: async () => pending,
    listInstalledCacheSources: () => sources,
    process: { cwd: () => process.cwd() },
    readBackgroundSourceBrowsingEnabled: () => backgroundSourceBrowsingEnabled,
    readCacheRefreshIntervals: () => intervals,
  };
}

test('runCacheRefreshSchedulerCheck keeps explicit cache interval overrides', async () => {
  const enqueued = [];
  const now = 1_700_000_000_000;
  const sandbox = createSchedulerSandbox({
    now,
    enqueued,
    sources: ['twitter', 'youtube'],
    intervals: { twitter: 10, youtube: 240 },
  });

  const runCacheRefreshSchedulerCheck = loadCacheRefreshScheduler(sandbox);
  await runCacheRefreshSchedulerCheck('timer');

  assert.deepStrictEqual(
    enqueued.map((job) => ({
      source: job.metadata.cacheSource,
      baseIntervalMinutes: job.metadata.baseIntervalMinutes,
      intervalMinutes: job.metadata.intervalMinutes,
    })),
    [
      { source: 'twitter', baseIntervalMinutes: 10, intervalMinutes: 10 },
      { source: 'youtube', baseIntervalMinutes: 240, intervalMinutes: 240 },
    ],
  );
});

test('runCacheRefreshSchedulerCheck multiplies intervals during idle windows', async () => {
  const now = 1_700_000_000_000;
  const enqueued = [];
  const sandbox = createSchedulerSandbox({
    now,
    enqueued,
    activityMultiplier: 2,
    latestRefreshAtMs: now - (59 * 60 * 1000),
    sources: ['twitter'],
    intervals: { twitter: 30 },
  });

  const runCacheRefreshSchedulerCheck = loadCacheRefreshScheduler(sandbox);
  await runCacheRefreshSchedulerCheck('timer');

  assert.strictEqual(enqueued.length, 0);
});

for (const [name, poisonedStartedAt] of [
  ['future-start', '2026-05-02T02:39:16.471Z'],
  ['inverted', '2026-04-27T08:00:00.000Z'],
]) {
  test(`runCacheRefreshSchedulerCheck ignores ${name} rows that would hide newer valid refreshes`, async () => {
    const now = Date.parse('2026-04-27T08:01:00.000Z');
    const db = createRefreshRunDb([
      {
        id: `browse-cache-refresh-${name}`,
        source: 'substack',
        startedAtMs: Date.parse(poisonedStartedAt),
        completedAtMs: Date.parse('2026-04-25T06:41:28.870Z'),
        itemsAdded: 60,
      },
      {
        id: 'browse-cache-refresh-fresh',
        source: 'substack',
        startedAtMs: Date.parse('2026-04-27T07:54:42.000Z'),
        completedAtMs: Date.parse('2026-04-27T07:55:12.043Z'),
        itemsAdded: 12,
      },
    ]);
    const enqueued = [];
    const sandbox = createSchedulerSandbox({
      now,
      enqueued,
      db,
      sources: ['substack'],
      intervals: { substack: 120 },
    });

    loadLatestBrowseCacheRefresh(sandbox);
    const runCacheRefreshSchedulerCheck = loadCacheRefreshScheduler(sandbox);
    await runCacheRefreshSchedulerCheck('timer');

    assert.strictEqual(enqueued.length, 0);
    db.close();
  });
}

test('runCacheRefreshSchedulerCheck ignores setup-smoke rows when deciding cadence', async () => {
  const now = Date.parse('2026-04-29T09:25:00.000Z');
  const db = createRefreshRunDb([
    {
      id: 'setup-source-twitter-task-123',
      source: 'twitter',
      triggeredBy: 'setup-source-smoke',
      startedAtMs: Date.parse('2026-04-29T09:18:00.000Z'),
      completedAtMs: Date.parse('2026-04-29T09:18:55.000Z'),
      itemsAdded: 4,
    },
  ]);
  const enqueued = [];
  const sandbox = createSchedulerSandbox({
    now,
    enqueued,
    db,
    sources: ['twitter'],
    intervals: { twitter: 30 },
  });

  const getLatestBrowseCacheRefreshAtMs = loadLatestBrowseCacheRefresh(sandbox);
  assert.strictEqual(getLatestBrowseCacheRefreshAtMs('twitter'), null);

  const runCacheRefreshSchedulerCheck = loadCacheRefreshScheduler(sandbox);
  await runCacheRefreshSchedulerCheck('timer');

  assert.strictEqual(enqueued.length, 1);
  assert.strictEqual(enqueued[0].metadata.cacheSource, 'twitter');
  db.close();
});

test('runCacheRefreshSchedulerCheck skips enqueue when a cache job is already pending', async () => {
  const now = 1_700_000_000_000;
  const enqueued = [];
  const sandbox = createSchedulerSandbox({
    now,
    enqueued,
    pending: true,
    sources: ['youtube'],
    intervals: { youtube: 120 },
  });

  const runCacheRefreshSchedulerCheck = loadCacheRefreshScheduler(sandbox);
  await runCacheRefreshSchedulerCheck('timer');

  assert.strictEqual(enqueued.length, 0);
});

test('runCacheRefreshSchedulerCheck skips automatic cache refreshes when background source browsing is disabled', async () => {
  const now = 1_700_000_000_000;
  const enqueued = [];
  const sandbox = createSchedulerSandbox({
    now,
    enqueued,
    backgroundSourceBrowsingEnabled: false,
    sources: ['twitter', 'hackernews'],
    intervals: { twitter: 30, hackernews: 60 },
  });

  const runCacheRefreshSchedulerCheck = loadCacheRefreshScheduler(sandbox);
  await runCacheRefreshSchedulerCheck('startup');

  assert.strictEqual(enqueued.length, 0);
});

test('pending worker restart drains cache-refresh work before checking idle state', () => {
  const workerSource = fs.readFileSync(path.join(process.cwd(), 'worker.js'), 'utf8');
  const drainIndex = workerSource.indexOf('await backgroundOrchestrator.prepareForWorkerRestart();');
  const statusIndex = workerSource.indexOf('const status = backgroundOrchestrator.getStatus();', drainIndex);

  assert.notStrictEqual(drainIndex, -1);
  assert.notStrictEqual(statusIndex, -1);
  assert.ok(drainIndex < statusIndex);
  assert.match(workerSource, /drained cache-refresh work for pending worker restart/);
});

test('brain orchestrator restart drain is scoped to cache refresh and preserves active chat', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/brain-orchestrator.js'), 'utf8');

  assert.match(source, /async prepareForWorkerRestart\(\{ graceMs = 5_000 \} = \{\}\)/);
  assert.match(source, /activeUserChatTasks: this\.activeChatTasks\.size/);
  assert.doesNotMatch(source, /this\.activeChatTasks\.clear\(\)/);
  assert.match(source, /_getTerminalBrowseCacheRefreshRun\(task\)/);
  assert.match(source, /LOWER\(status\) IN \('completed', 'failed'\)/);
  assert.match(source, /this\._signalProcessGroup\(pid, 'SIGTERM'\)/);
  assert.match(source, /this\._signalProcessGroup\(pid, 'SIGKILL'\)/);
  assert.match(source, /Cache refresh skipped by worker restart before it started/);
});
