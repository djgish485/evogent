import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import {
  getFeedItemBySourceId,
  insertOrIgnoreFeedItem,
} from '@/lib/db/feed';
import { POST as submitCuration } from '@/app/api/internal/curate/submit/route';
import { POST as cancelSourceCache } from './route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/browse-cache/cancel-source source-discovery cancellation', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalFetch = globalThis.fetch;
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'evogent-browse-cache-cancel-route-test-'),
    );

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    globalThis.fetch = async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
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

  function seedCache(source: string, sourceId: string): void {
    const nowMs = Date.now();
    getDb().prepare(`
      INSERT INTO browse_cache_items (
        source,
        source_id,
        url,
        title,
        published_at_ms,
        payload_json,
        fetched_at_ms,
        expires_at_ms,
        seen_by_curation_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      source,
      sourceId,
      `https://example.test/${sourceId}`,
      `Cached ${sourceId}`,
      nowMs,
      JSON.stringify({ text: `Cached evidence ${sourceId}` }),
      nowMs,
      nowMs + 60_000,
    );
  }

  function seedSuccessNotification(source: string): void {
    const notificationId = `source-discovery-${source}`;
    const inserted = insertOrIgnoreFeedItem({
      id: `${notificationId}-row`,
      type: 'notification',
      source: 'phone',
      sourceId: notificationId,
      title: 'Source discovery succeeded',
      text: 'The attempt-bound source evidence and repeatable recipe were validated.',
      metadata: {
        notificationId,
        severity: 'info',
        suggestionStatus: 'pending',
      },
      publishedAt: new Date().toISOString(),
    });
    assert.equal(inserted, true);
  }

  async function runCancellationEndpoints(source: string): Promise<{
    deleted: number;
    resolved: boolean;
  }> {
    const cacheResponse = await cancelSourceCache(new Request(
      'http://127.0.0.1/api/internal/browse-cache/cancel-source',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      },
    ));
    assert.equal(cacheResponse.status, 200);
    const cacheReceipt = await cacheResponse.json() as {
      ok: boolean;
      source: string;
      deleted: number;
      resolved: boolean;
    };
    assert.equal(cacheReceipt.ok, true);
    assert.equal(cacheReceipt.source, source);

    return {
      deleted: cacheReceipt.deleted,
      resolved: cacheReceipt.resolved,
    };
  }

  test('worker cancellation deletes only the opted-out source and dismisses its success notice', async () => {
    const source = 'cancelled-source';
    seedCache(source, 'cancelled-one');
    seedCache(source, 'cancelled-two');
    seedCache('retained-source', 'retained-one');
    seedSuccessNotification(source);

    assert.equal(getFeedItemBySourceId(`source-discovery-${source}`)?.suggestionStatus, 'pending');
    assert.deepEqual(await runCancellationEndpoints(source), {
      deleted: 2,
      resolved: true,
    });
    assert.deepEqual(
      getDb().prepare('SELECT COUNT(*) AS count FROM browse_cache_items WHERE source = ?')
        .get(source) as { count: number } | undefined,
      { count: 0 },
    );
    assert.deepEqual(
      getDb().prepare('SELECT COUNT(*) AS count FROM browse_cache_items WHERE source = ?')
        .get('retained-source') as { count: number } | undefined,
      { count: 1 },
    );
    assert.equal(
      getFeedItemBySourceId(`source-discovery-${source}`)?.suggestionStatus,
      'dismissed',
    );
  });

  test('a cancellation before notice publication prevents the late success notice', async () => {
    const source = 'racing-source';
    seedCache(source, 'before-cancel');

    assert.deepEqual(await runCancellationEndpoints(source), {
      deleted: 1,
      resolved: false,
    });
    assert.equal(getFeedItemBySourceId(`source-discovery-${source}`), null);

    const noticeId = `source-discovery-${source}`;
    const lateSubmit = await submitCuration(new Request(
      'http://127.0.0.1/api/internal/curate/submit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{
            type: 'notification',
            source: 'phone',
            sourceId: noticeId,
            title: 'Source discovery succeeded',
            text: 'The attempt-bound source evidence and repeatable recipe were validated.',
            metadata: {
              notificationId: noticeId,
              notificationKind: 'source_discovery_success',
              sourceName: source,
              severity: 'info',
            },
          }],
        }),
      },
    ));
    assert.equal(lateSubmit.status, 200);
    assert.deepEqual(await lateSubmit.json(), {
      accepted: 0,
      reactivated: 0,
      duplicates: 1,
      errors: [],
      acceptedIds: [],
      completionDeferred: false,
      completionDeferredReason: null,
      completionRejected: false,
      completionRejectedReason: null,
      duplicateSourceIds: [noticeId],
    });
    assert.equal(getFeedItemBySourceId(noticeId), null);
  });

  test('rejects a non-canonical source without deleting cache rows', async () => {
    seedCache('retained-source', 'retained-one');
    const response = await cancelSourceCache(new Request(
      'http://127.0.0.1/api/internal/browse-cache/cancel-source',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: '../retained-source' }),
      },
    ));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'A canonical source slug is required',
    });
    const remaining = getDb()
      .prepare('SELECT COUNT(*) AS count FROM browse_cache_items')
      .get() as { count: number };
    assert.equal(
      remaining.count,
      1,
    );
  });
});
