import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const {
  PHONE_RESTART_CURATION_REASON,
  reconcileOrphanedPhoneCurations,
} = require('../lib/phone-startup-reconciliation.js');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE curation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      triggered_by TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      items_added INTEGER,
      feed_count_before INTEGER,
      completion_status TEXT,
      completion_reason TEXT
    );
  `);
  return db;
}

test('reconcileOrphanedPhoneCurations preserves evidence and aborts every ownerless row', () => {
  const db = createDb();
  const insert = db.prepare(`
    INSERT INTO curation_log (
      request_id,
      triggered_by,
      started_at,
      completed_at,
      items_added,
      feed_count_before,
      completion_status,
      completion_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'pending-one',
    'adaptive_heartbeat:test',
    '2026-07-25T10:00:00.000Z',
    null,
    null,
    41,
    null,
    null,
  );
  insert.run(
    'already-complete',
    'manual',
    '2026-07-25T09:00:00.000Z',
    '2026-07-25T09:05:00.000Z',
    3,
    38,
    'success',
    'submitted three items',
  );

  const changes = reconcileOrphanedPhoneCurations(db, {
    completedAt: '2026-07-25T10:05:00.000Z',
  });
  const rows = db.prepare(`
    SELECT request_id, started_at, completed_at, items_added, feed_count_before,
           completion_status, completion_reason
    FROM curation_log
    ORDER BY id
  `).all();

  assert.equal(changes, 1);
  assert.deepEqual(rows[0], {
    request_id: 'pending-one',
    started_at: '2026-07-25T10:00:00.000Z',
    completed_at: '2026-07-25T10:05:00.000Z',
    items_added: null,
    feed_count_before: 41,
    completion_status: 'aborted',
    completion_reason: PHONE_RESTART_CURATION_REASON,
  });
  assert.deepEqual(rows[1], {
    request_id: 'already-complete',
    started_at: '2026-07-25T09:00:00.000Z',
    completed_at: '2026-07-25T09:05:00.000Z',
    items_added: 3,
    feed_count_before: 38,
    completion_status: 'success',
    completion_reason: 'submitted three items',
  });
  db.close();
});

test('reconcileOrphanedPhoneCurations is a no-op before the schema exists', () => {
  const db = new Database(':memory:');

  assert.equal(reconcileOrphanedPhoneCurations(db), 0);

  db.close();
});
