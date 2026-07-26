import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  failPendingAutomatedCurationWithoutReceipt,
  getAutomatedCurationCycleIdFromTaskEvent,
} from '../lib/curation-runtime.js';

function createReceiptDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE feed (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE curation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT UNIQUE,
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

function insertCycle(db, requestId, options = {}) {
  db.prepare(`
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
  `).run(
    requestId,
    options.triggeredBy ?? 'phone_scheduler:cycle',
    '2026-07-25T00:00:00.000Z',
    options.completedAt ?? null,
    options.itemsAdded ?? null,
    options.feedCountBefore ?? 0,
    options.completionStatus ?? null,
    options.completionReason ?? null,
  );
}

test('task lifecycle resolver uses the explicit exact cycle identity', () => {
  const cycleId = 'phone-curation-11111111-1111-4111-8111-111111111111';
  assert.equal(getAutomatedCurationCycleIdFromTaskEvent({
    taskId: 'chat-queue-msg-unrelated',
    curationCycleId: cycleId,
    state: 'completed',
  }), cycleId);
  assert.equal(getAutomatedCurationCycleIdFromTaskEvent({
    taskId: 'chat-queue-msg-unrelated',
    metadata: { curationCycleId: cycleId },
  }), cycleId);
  assert.equal(getAutomatedCurationCycleIdFromTaskEvent({
    taskId: 'chat-queue-msg-unrelated',
    curationCycleId: '../not-a-cycle',
  }), '');
});

test('task completion without a receipt fails only the exact pending cycle', () => {
  const db = createReceiptDb();
  try {
    const exactCycleId = 'phone-curation-22222222-2222-4222-8222-222222222222';
    const otherCycleId = 'phone-curation-33333333-3333-4333-8333-333333333333';
    insertCycle(db, exactCycleId);
    insertCycle(db, otherCycleId);
    db.prepare('INSERT INTO feed (id) VALUES (?)').run('feed-one');

    assert.equal(failPendingAutomatedCurationWithoutReceipt(db, {
      taskId: 'chat-queue-msg-exact',
      curationCycleId: exactCycleId,
      state: 'completed',
    }, '2026-07-25T00:01:00.000Z'), true);

    const exact = db.prepare(`
      SELECT completed_at, items_added, completion_status, completion_reason
      FROM curation_log WHERE request_id = ?
    `).get(exactCycleId);
    assert.deepEqual(exact, {
      completed_at: '2026-07-25T00:01:00.000Z',
      items_added: 1,
      completion_status: 'failed',
      completion_reason: 'missing_validated_cycle_receipt',
    });

    const other = db.prepare(`
      SELECT completed_at, completion_status
      FROM curation_log WHERE request_id = ?
    `).get(otherCycleId);
    assert.deepEqual(other, {
      completed_at: null,
      completion_status: null,
    });
  } finally {
    db.close();
  }
});

test('task completion cannot overwrite an already validated terminal receipt', () => {
  const db = createReceiptDb();
  try {
    const cycleId = 'phone-curation-44444444-4444-4444-8444-444444444444';
    insertCycle(db, cycleId, {
      completedAt: '2026-07-25T00:01:00.000Z',
      itemsAdded: 0,
      completionStatus: 'successful_empty',
      completionReason: 'validated agent receipt',
    });

    assert.equal(failPendingAutomatedCurationWithoutReceipt(db, {
      taskId: 'chat-queue-msg-validated',
      curationCycleId: cycleId,
      state: 'completed',
    }), false);

    const row = db.prepare(`
      SELECT completed_at, items_added, completion_status, completion_reason
      FROM curation_log WHERE request_id = ?
    `).get(cycleId);
    assert.deepEqual(row, {
      completed_at: '2026-07-25T00:01:00.000Z',
      items_added: 0,
      completion_status: 'successful_empty',
      completion_reason: 'validated agent receipt',
    });
  } finally {
    db.close();
  }
});

test('orchestrator lifecycle and both server completion paths carry the exact receipt identity', () => {
  const orchestratorSource = fs.readFileSync(
    path.join(process.cwd(), 'lib', 'brain-orchestrator.js'),
    'utf8',
  );
  const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

  assert.match(orchestratorSource, /_buildTaskLifecycleEvent\(task\)[\s\S]*curationCycleId/);
  assert.match(orchestratorSource, /task\?\.metadata\?\.curationCycleId/);
  assert.match(
    serverSource,
    /orchestrator\.onStatus[\s\S]*completeCurationLogForTask\(event\)[\s\S]*broadcastOrchestratorStatus/,
  );
  assert.match(
    serverSource,
    /workerOrchestratorStatus = status;[\s\S]*completeCurationLogForTask[\s\S]*broadcastOrchestratorStatus/,
  );
});
