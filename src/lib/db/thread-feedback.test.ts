import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './client';
import { getRecentThreadFeedback, insertThreadFeedback } from './thread-feedback';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('thread feedback repository', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-thread-feedback-test-'));

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

  test('persists structured probe feedback with source item context', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at)
      VALUES ('probe-anchor', 'article', 'unit-test', 'Probe anchor', ?)
    `).run('2026-04-26T12:00:00.000Z');

    const inserted = insertThreadFeedback({
      threadId: 'thread-borderline',
      cycleId: 'cycle-1',
      feedItemId: 'probe-anchor',
      vote: 'less',
      threadTitle: 'Borderline lane',
      reason: 'too much of this source',
      category: 'source',
      probeReason: 'high quality but uncertain fit',
      probeUncertainty: 'source fatigue',
      sourceItemIds: ['probe-anchor', 'probe-anchor', 'source-2'],
      originSessionId: 'session-1',
      createdAt: '2026-04-26T12:01:00.000Z',
    });

    assert.strictEqual(inserted.threadId, 'thread-borderline');
    assert.strictEqual(inserted.vote, 'less');
    assert.deepStrictEqual(inserted.sourceItemIds, ['probe-anchor', 'source-2']);

    const recent = getRecentThreadFeedback(10);
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0]?.threadTitle, 'Borderline lane');
    assert.strictEqual(recent[0]?.probeUncertainty, 'source fatigue');
  });
});
