import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import { insertOrIgnoreFeedItem } from '@/lib/db/feed';
import { PATCH } from './[id]/route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;
const originalFetch = globalThis.fetch;

describe('/api/feed/[id] PATCH community notes', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-patch-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
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

  test('accepts main and quoted tweet community note metadata', async () => {
    insertOrIgnoreFeedItem({
      id: 'route-community-note-parent',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'route-community-note-parent',
      text: 'Parent tweet',
      mediaUrls: [],
      publishedAt: '2026-04-29T10:00:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
      metadata: {
        quotedTweet: {
          id: '1234567890123456789',
          text: 'Quoted tweet',
          author: {
            username: 'quoted',
            displayName: 'Quoted',
          },
          url: 'https://x.com/quoted/status/1234567890123456789',
        },
      },
    });

    const response = await PATCH(
      new Request('http://127.0.0.1/api/feed/route-community-note-parent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: {
            communityNote: {
              text: 'Main tweet note text',
              sourceUrl: 'https://example.com/main-note',
            },
            quotedTweet: {
              communityNote: {
                text: 'Quoted tweet note text',
                sourceUrl: 'https://example.com/quoted-note',
              },
            },
          },
        }),
      }),
      { params: Promise.resolve({ id: 'route-community-note-parent' }) },
    );

    assert.equal(response.status, 200);
    const payload = await response.json() as { item?: { metadata?: Record<string, unknown> } };
    const metadata = payload.item?.metadata as {
      communityNote?: unknown;
      quotedTweet?: { communityNote?: unknown };
    } | undefined;

    assert.deepStrictEqual(metadata?.communityNote, {
      text: 'Main tweet note text',
      sourceUrl: 'https://example.com/main-note',
    });
    assert.deepStrictEqual(metadata?.quotedTweet?.communityNote, {
      text: 'Quoted tweet note text',
      sourceUrl: 'https://example.com/quoted-note',
    });

    const quoteRow = getDb().prepare('SELECT metadata FROM feed WHERE id = ?').get('1234567890123456789') as {
      metadata: string;
    };
    assert.match(quoteRow.metadata, /Quoted tweet note text/);
  });
});
