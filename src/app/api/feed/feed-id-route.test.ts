import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import { insertOrIgnoreFeedItem } from '@/lib/db/feed';
import { GET, PATCH } from './[id]/route';
import { GET as GET_CHILDREN } from './[id]/children/route';
import { POST as POST_ENRICH } from './[id]/enrich/route';

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

  test('direct runtime-agent sessions cannot read or patch phone-notification content by id', async () => {
    const privateCanary = 'PRIVATE_NOTIFICATION_DETAIL_CANARY_4392';
    insertOrIgnoreFeedItem({
      id: 'private-phone-notification-detail',
      type: 'notification',
      source: 'phone-notification',
      sourceId: 'phone-notification:detail-private',
      title: `Private title ${privateCanary}`,
      text: `Private body ${privateCanary}`,
      publishedAt: '2026-07-28T12:00:00.000Z',
    });
    const directHeaders = {
      Authorization: 'EvogentSession direct-runtime-test-token',
    };

    const agentGet = await GET(
      new Request(
        'http://127.0.0.1/api/feed/private-phone-notification-detail',
        { headers: directHeaders },
      ),
      { params: Promise.resolve({ id: 'private-phone-notification-detail' }) },
    );
    assert.equal(agentGet.status, 404);
    assert.doesNotMatch(await agentGet.text(), new RegExp(privateCanary));

    const agentPatch = await PATCH(
      new Request(
        'http://127.0.0.1/api/feed/private-phone-notification-detail',
        {
          method: 'PATCH',
          headers: {
            ...directHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Runtime rewrite' }),
        },
      ),
      { params: Promise.resolve({ id: 'private-phone-notification-detail' }) },
    );
    assert.equal(agentPatch.status, 404);

    const userGet = await GET(
      new Request('https://127.0.0.1/api/feed/private-phone-notification-detail'),
      { params: Promise.resolve({ id: 'private-phone-notification-detail' }) },
    );
    assert.equal(userGet.status, 200);
    assert.match(await userGet.text(), new RegExp(privateCanary));

    const enrichment = await POST_ENRICH(
      new Request(
        'https://127.0.0.1/api/feed/private-phone-notification-detail/enrich',
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: 'private-phone-notification-detail' }) },
    );
    assert.equal(enrichment.status, 404);
    assert.doesNotMatch(await enrichment.text(), new RegExp(privateCanary));
  });

  test('direct runtime-agent detail and children routes transitively remove phone-notification children', async () => {
    const privateCanary = 'PRIVATE_NOTIFICATION_CHILD_CANARY_5276';
    insertOrIgnoreFeedItem({
      id: 'ordinary-parent',
      type: 'article',
      source: 'publisher',
      sourceId: 'publisher:ordinary-parent',
      title: 'Ordinary parent',
      text: 'Ordinary safe body',
      publishedAt: '2026-07-28T12:00:00.000Z',
    });
    insertOrIgnoreFeedItem({
      id: 'private-notification-child',
      type: 'notification',
      source: 'phone-notification',
      sourceId: 'phone-notification:private-child',
      parentId: 'ordinary-parent',
      relationship: 'related',
      title: `Private child title ${privateCanary}`,
      text: `Private child body ${privateCanary}`,
      publishedAt: '2026-07-28T12:01:00.000Z',
    });
    const directRequest = () => new Request(
      'http://127.0.0.1/api/feed/ordinary-parent',
      { headers: { Authorization: 'EvogentSession direct-runtime-test-token' } },
    );

    const agentDetail = await GET(
      directRequest(),
      { params: Promise.resolve({ id: 'ordinary-parent' }) },
    );
    assert.equal(agentDetail.status, 200);
    const agentDetailText = await agentDetail.text();
    assert.doesNotMatch(agentDetailText, new RegExp(privateCanary));
    assert.doesNotMatch(agentDetailText, /private-notification-child/);

    const agentChildren = await GET_CHILDREN(
      directRequest(),
      { params: Promise.resolve({ id: 'ordinary-parent' }) },
    );
    assert.equal(agentChildren.status, 200);
    const agentChildrenText = await agentChildren.text();
    assert.doesNotMatch(agentChildrenText, new RegExp(privateCanary));
    assert.doesNotMatch(agentChildrenText, /private-notification-child/);

    const userDetail = await GET(
      new Request('https://127.0.0.1/api/feed/ordinary-parent'),
      { params: Promise.resolve({ id: 'ordinary-parent' }) },
    );
    assert.match(await userDetail.text(), new RegExp(privateCanary));
  });
});
