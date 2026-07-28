import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { insertOrIgnoreFeedItem } from '@/lib/db/feed';
import { GET } from './route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/threads/[threadId] agent evidence boundary', { concurrency: false }, () => {
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-thread-route-test-'));

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

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('direct sessions remove notification roots and transitively hydrated parents while the WebView keeps them', async () => {
    const privateCanary = 'PRIVATE_NOTIFICATION_THREAD_CANARY_7306';
    insertOrIgnoreFeedItem({
      id: 'private-notification-thread-parent',
      type: 'notification',
      source: 'phone-notification',
      sourceId: 'phone-notification:thread-private',
      title: `Private title ${privateCanary}`,
      text: `Private body ${privateCanary}`,
      publishedAt: '2026-07-28T12:00:00.000Z',
      metadata: {
        thread: {
          threadId: 'mixed-private-thread',
          threadTitle: 'Mixed thread',
        },
      },
    });
    insertOrIgnoreFeedItem({
      id: 'ordinary-thread-child',
      type: 'article',
      source: 'publisher',
      sourceId: 'publisher:ordinary-thread-child',
      parentId: 'private-notification-thread-parent',
      relationship: 'related',
      title: 'Ordinary title',
      text: 'Ordinary body',
      publishedAt: '2026-07-28T12:01:00.000Z',
      metadata: {
        thread: {
          threadId: 'mixed-private-thread',
          threadTitle: 'Mixed thread',
        },
      },
    });

    const directResponse = await GET(
      new Request(
        'http://127.0.0.1/api/threads/mixed-private-thread',
        { headers: { Authorization: 'EvogentSession direct-runtime-test-token' } },
      ),
      { params: Promise.resolve({ threadId: 'mixed-private-thread' }) },
    );
    assert.strictEqual(directResponse.status, 200);
    const directText = await directResponse.text();
    assert.match(directText, /ordinary-thread-child/);
    assert.doesNotMatch(directText, /private-notification-thread-parent/);
    assert.doesNotMatch(directText, new RegExp(privateCanary));

    const webViewResponse = await GET(
      new Request('https://127.0.0.1/api/threads/mixed-private-thread'),
      { params: Promise.resolve({ threadId: 'mixed-private-thread' }) },
    );
    assert.strictEqual(webViewResponse.status, 200);
    const webViewText = await webViewResponse.text();
    assert.match(webViewText, /private-notification-thread-parent/);
    assert.match(webViewText, new RegExp(privateCanary));
  });
});
