import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  validateCacheRefreshTaskResult,
} from '../lib/cache-refresh-task-result.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE browse_cache_refresh_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      status TEXT NOT NULL,
      items_added INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )
  `);
  return db;
}

function createTask(overrides = {}) {
  return {
    id: 'cache-refresh-twitter-unit',
    priority: 'cache_refresh',
    message: '/cache-refresh twitter',
    metadata: { cacheSource: 'twitter' },
    enqueuedAt: '2026-05-18T23:40:00.000Z',
    startedAt: '2026-05-18T23:40:00.000Z',
    ...overrides,
  };
}

function insertRun(db, {
  id,
  source = 'twitter',
  startedAtMs = Date.parse('2026-05-18T23:40:05.000Z'),
  completedAtMs = Date.parse('2026-05-18T23:40:10.000Z'),
  status = 'completed',
  itemsAdded = 1,
  error = null,
}) {
  db.prepare(`
    INSERT INTO browse_cache_refresh_runs (
      id, source, triggered_by, started_at_ms, completed_at_ms, status, items_added, error
    ) VALUES (?, ?, 'cache_refresh', ?, ?, ?, ?, ?)
  `).run(id, source, startedAtMs, completedAtMs, status, itemsAdded, error);
}

test('cache refresh validation fails when no new terminal run is recorded', () => {
  const db = createDb();
  try {
    const task = createTask();
    const baselineRun = {
      id: 'old-twitter-run',
      status: 'completed',
      itemsAdded: 12,
      completedAtMs: Date.parse('2026-05-18T23:39:00.000Z'),
    };
    insertRun(db, {
      id: baselineRun.id,
      startedAtMs: Date.parse('2026-05-18T23:39:00.000Z'),
      completedAtMs: baselineRun.completedAtMs,
      itemsAdded: baselineRun.itemsAdded,
    });

    const result = validateCacheRefreshTaskResult(task, {
      baselineRun,
      getDb: () => db,
      logger: null,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /did not persist a new terminal browse-cache refresh run/);
  } finally {
    db.close();
  }
});

test('cache refresh validation fails completed runs with zero added rows', () => {
  const db = createDb();
  try {
    insertRun(db, { id: 'zero-row-twitter-run', itemsAdded: 0 });

    const result = validateCacheRefreshTaskResult(createTask(), {
      getDb: () => db,
      logger: null,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /completed with 0 items added/);
  } finally {
    db.close();
  }
});

test('cache refresh validation propagates failed refresh run errors', () => {
  const db = createDb();
  try {
    insertRun(db, {
      id: 'failed-twitter-run',
      status: 'failed',
      itemsAdded: 0,
      error: 'chrome_login: signed out',
    });

    const result = validateCacheRefreshTaskResult(createTask(), {
      getDb: () => db,
      logger: null,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /chrome_login: signed out/);
  } finally {
    db.close();
  }
});

test('cache refresh validation accepts completed runs with added rows', () => {
  const db = createDb();
  try {
    insertRun(db, { id: 'fresh-twitter-run', itemsAdded: 7 });

    const result = validateCacheRefreshTaskResult(createTask(), {
      getDb: () => db,
      logger: null,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.run?.id, 'fresh-twitter-run');
  } finally {
    db.close();
  }
});
