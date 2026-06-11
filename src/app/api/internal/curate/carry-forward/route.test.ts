import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import { GET } from './route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/curate/carry-forward', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-carry-forward-route-test-'));

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

  test('defaults to reviewing all unviewed candidates instead of a recency window', async () => {
    const db = getDb();
    const oldCreatedAt = '2026-02-01T10:00:00.000Z';

    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, excerpt, reason, metadata, display_order, published_at, created_at, created_at_ms
      )
      VALUES (
        'old-unviewed-signal',
        'tweet',
        'twitter',
        'old-unviewed-signal-source',
        'Old but important signal',
        'An older unviewed item still has enough curator and preference context to be reviewed.',
        'An older unviewed item remains important.',
        'Still connects to the user intent.',
        ?,
        7,
        ?,
        ?,
        ?
      )
    `).run(
      JSON.stringify({
        bridge: 'Still unread: this older item remains directly relevant.',
        preferenceMatch: { relevanceScore: 0.92 },
        thread: {
          threadId: 'old-important-thread',
          threadTitle: 'Older important work',
          threadRationale: 'Age should not exclude an unviewed item from review.',
        },
      }),
      oldCreatedAt,
      oldCreatedAt,
      Date.parse(oldCreatedAt),
    );

    const response = await GET(new Request('http://127.0.0.1/api/internal/curate/carry-forward?limit=5'));
    assert.equal(response.status, 200);

    const body = await response.json() as {
      queriedWindowHours: number | null;
      review?: {
        includeAllUnviewed?: boolean;
        includeDisplayed?: boolean;
        cutoffMs?: number | null;
        topCandidateIds?: string[];
      };
      candidates?: Array<{ id: string }>;
    };

    assert.equal(body.queriedWindowHours, null);
    assert.equal(body.review?.includeAllUnviewed, true);
    assert.equal(body.review?.includeDisplayed, true);
    assert.equal(body.review?.cutoffMs, null);
    assert.ok(body.review?.topCandidateIds?.includes('old-unviewed-signal'));
    assert.deepEqual(body.candidates?.map((candidate) => candidate.id), ['old-unviewed-signal']);
  });
});
