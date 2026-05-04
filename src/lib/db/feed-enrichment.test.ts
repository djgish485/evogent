import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './client';
import {
  getFeedItemById,
  insertOrIgnoreFeedItem,
  normalizeFeedInput,
  resolveFeedItemByIdentifier,
  resolvePersistedFeedItemByIdentifier,
  updateFeedItemEnrichment,
  updateFeedItemFields,
} from './feed';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('feed enrichment persistence', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-enrichment-test-'));

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

  test('updateFeedItemEnrichment stores media_urls for enriched tweets', () => {
    insertOrIgnoreFeedItem({
      id: 'tweet-enrichment-1',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-1',
      text: 'Original tweet',
      mediaUrls: [],
      publishedAt: '2026-03-07T12:00:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
    });

    const updated = updateFeedItemEnrichment('tweet-enrichment-1', {
      text: 'Original tweet https://t.co/abcd1234',
      mediaUrls: [
        'https://pbs.twimg.com/media/HCzms1gbAAA6T52.jpg',
        'https://pbs.twimg.com/media/HCzms1EWEAAspfP.jpg',
      ],
      metrics: {
        likes: 55,
        reposts: 5,
        replies: 4,
      },
      metadata: {
        media: [
          { type: 'image', url: 'https://pbs.twimg.com/media/HCzms1gbAAA6T52.jpg' },
          { type: 'image', url: 'https://pbs.twimg.com/media/HCzms1EWEAAspfP.jpg' },
        ],
      },
    });

    assert.equal(updated, true);

    const row = getDb().prepare('SELECT media_urls FROM feed WHERE id = ?').get('tweet-enrichment-1') as { media_urls: string };
    assert.equal(
      row.media_urls,
      JSON.stringify([
        'https://pbs.twimg.com/media/HCzms1gbAAA6T52.jpg',
        'https://pbs.twimg.com/media/HCzms1EWEAAspfP.jpg',
      ]),
    );

    const feedItem = getFeedItemById('tweet-enrichment-1');
    assert.deepStrictEqual(feedItem?.mediaUrls, [
      'https://pbs.twimg.com/media/HCzms1gbAAA6T52.jpg',
      'https://pbs.twimg.com/media/HCzms1EWEAAspfP.jpg',
    ]);
  });

  test('persists and reloads flat quoted tweet metadata in canonical form', () => {
    const input = normalizeFeedInput({
      id: 'tweet-quote-1',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-quote-1',
      text: 'Quoting another tweet',
      publishedAt: '2026-03-07T12:00:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
      metadata: {
        quotedTweet: {
          text: 'Original quoted tweet',
          likeCount: 17,
          repostCount: 8,
          replyCount: 5,
          authorUsername: 'quoted_user',
          authorDisplayName: 'Quoted User',
          authorAvatarUrl: 'https://pbs.twimg.com/profile_images/quoted-user.jpg',
          url: 'https://x.com/quoted_user/status/9876543210',
        },
      },
    });
    assert.ok(input);

    insertOrIgnoreFeedItem(input);

    const row = getDb().prepare('SELECT metadata FROM feed WHERE id = ?').get('tweet-quote-1') as { metadata: string };
    assert.match(row.metadata, /quotedTweet/);

    const feedItem = getFeedItemById('tweet-quote-1');
    assert.deepStrictEqual(feedItem?.metadata?.quotedTweet, {
      id: '9876543210',
      text: 'Original quoted tweet',
      author: {
        username: 'quoted_user',
        displayName: 'Quoted User',
        avatarUrl: 'https://pbs.twimg.com/profile_images/quoted-user.jpg',
      },
      metrics: {
        likes: 17,
        reposts: 8,
        replies: 5,
      },
      url: 'https://x.com/quoted_user/status/9876543210',
    });
  });

  test('patching metadata persists main tweet community notes in canonical form', () => {
    insertOrIgnoreFeedItem({
      id: 'tweet-community-note-main',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-community-note-main',
      text: 'Main tweet with Readers added context',
      mediaUrls: [],
      publishedAt: '2026-03-07T12:00:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
    });

    const updated = updateFeedItemFields('tweet-community-note-main', {
      metadata: {
        communityNote: {
          text: 'This market resolves for any local, state, or national moratorium.',
          sourceUrl: 'https://example.com/community-note-source',
        },
      },
    });

    assert.deepStrictEqual(updated?.metadata?.communityNote, {
      text: 'This market resolves for any local, state, or national moratorium.',
      sourceUrl: 'https://example.com/community-note-source',
    });
  });

  test('patching quotedTweet.communityNote preserves quote metadata and backfills the quote row', () => {
    insertOrIgnoreFeedItem({
      id: 'tweet-community-note-quote-parent',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-community-note-quote-parent',
      text: 'Parent quoting another tweet',
      mediaUrls: [],
      publishedAt: '2026-03-07T12:00:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
      metadata: {
        quotedTweet: {
          id: '777888999000',
          text: 'Quoted market tweet',
          author: {
            username: 'polymarket',
            displayName: 'Polymarket',
          },
          url: 'https://x.com/polymarket/status/777888999000',
        },
      },
    });

    const updated = updateFeedItemFields('tweet-community-note-quote-parent', {
      metadata: {
        quotedTweet: {
          communityNote: {
            text: 'The market applies to local, state, and national moratoriums.',
            sourceUrl: 'https://example.com/quoted-community-note-source',
          },
        },
      },
    });

    assert.deepStrictEqual(updated?.metadata?.quotedTweet?.communityNote, {
      text: 'The market applies to local, state, and national moratoriums.',
      sourceUrl: 'https://example.com/quoted-community-note-source',
    });
    assert.equal(updated?.metadata?.quotedTweet?.text, 'Quoted market tweet');

    const quoteRow = getFeedItemById('777888999000');
    assert.equal(quoteRow?.parentId, 'tweet-community-note-quote-parent');
    assert.deepStrictEqual(quoteRow?.metadata?.communityNote, {
      text: 'The market applies to local, state, and national moratoriums.',
      sourceUrl: 'https://example.com/quoted-community-note-source',
    });
  });

  test('inserting a quote tweet parent creates a persisted quote row for the embedded tweet', () => {
    insertOrIgnoreFeedItem({
      id: 'tweet-quote-parent-row',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-quote-parent-row',
      text: 'Quoting another tweet',
      url: 'https://x.com/parent/status/111',
      authorUsername: 'parent',
      authorDisplayName: 'Parent',
      mediaUrls: [],
      publishedAt: '2026-03-07T12:00:00.000Z',
      metrics: {
        likes: 3,
        reposts: 1,
        replies: 2,
      },
      metadata: {
        quotedTweet: {
          id: '9876543210',
          text: 'Original quoted tweet',
          likeCount: 17,
          repostCount: 8,
          replyCount: 5,
          author: {
            username: 'quoted_user',
            displayName: 'Quoted User',
            avatarUrl: 'https://pbs.twimg.com/profile_images/quoted-user.jpg',
          },
          url: 'https://x.com/quoted_user/status/9876543210',
        },
      },
    });

    const quoteRow = getFeedItemById('9876543210');
    assert.equal(quoteRow?.id, '9876543210');
    assert.equal(quoteRow?.parentId, 'tweet-quote-parent-row');
    assert.equal(quoteRow?.relationship, 'child');
    assert.equal(quoteRow?.text, 'Original quoted tweet');
    assert.deepStrictEqual(quoteRow?.metrics, {
      likes: 17,
      reposts: 8,
      replies: 5,
    });
  });

  test('resolveFeedItemByIdentifier synthesizes quoted tweets from parent metadata', () => {
    const input = normalizeFeedInput({
      id: 'tweet-quote-parent',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-quote-parent',
      text: 'Quoting another tweet',
      publishedAt: '2026-03-07T12:00:00.000Z',
      metrics: {
        likes: 3,
        reposts: 1,
        replies: 2,
      },
      metadata: {
        quotedTweet: {
          text: 'Original quoted tweet',
          authorUsername: 'quoted_user',
          authorDisplayName: 'Quoted User',
          authorAvatarUrl: 'https://pbs.twimg.com/profile_images/quoted-user.jpg',
          url: 'https://x.com/quoted_user/status/9876543210',
        },
      },
    });
    assert.ok(input);

    insertOrIgnoreFeedItem(input);

    const byId = resolveFeedItemByIdentifier('9876543210');
    assert.equal(byId?.id, '9876543210');
    assert.equal(byId?.sourceId, '9876543210');
    assert.equal(byId?.text, 'Original quoted tweet');
    assert.equal(byId?.authorUsername, 'quoted_user');
    assert.equal(byId?.authorDisplayName, 'Quoted User');
    assert.equal(byId?.authorAvatarUrl, 'https://pbs.twimg.com/profile_images/quoted-user.jpg');
    assert.equal(byId?.url, 'https://x.com/quoted_user/status/9876543210');
    assert.equal(byId?.publishedAt, '2026-03-07T12:00:00.000Z');

    const byUrl = resolveFeedItemByIdentifier('https://x.com/quoted_user/status/9876543210');
    assert.equal(byUrl?.id, '9876543210');
    assert.equal(byUrl?.text, 'Original quoted tweet');
  });

  test('resolveFeedItemByIdentifier prefers persisted quote rows over synthesized metadata', () => {
    insertOrIgnoreFeedItem({
      id: 'tweet-quote-row',
      type: 'tweet',
      source: 'twitter',
      sourceId: '9876543210',
      text: 'Persisted quote row',
      url: 'https://x.com/quoted_user/status/9876543210',
      authorUsername: 'quoted_user',
      authorDisplayName: 'Quoted User',
      mediaUrls: [],
      publishedAt: '2026-03-08T12:00:00.000Z',
      metrics: {
        likes: 10,
        reposts: 4,
        replies: 1,
      },
    });

    const resolved = resolveFeedItemByIdentifier('9876543210');
    assert.equal(resolved?.id, 'tweet-quote-row');
    assert.equal(resolved?.text, 'Persisted quote row');
  });

  test('direct inserts canonicalize prefixed tweet sourceIds and preserve prefixed lookups', () => {
    const inserted = insertOrIgnoreFeedItem({
      id: 'tweet-canonical-source-id',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-1234567890',
      text: 'Canonical source id test',
      url: 'https://x.com/example/status/1234567890',
      mediaUrls: [],
      publishedAt: '2026-03-08T12:00:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
    });

    assert.equal(inserted, true);

    const storedRow = getDb().prepare('SELECT source_id FROM feed WHERE id = ?').get('tweet-canonical-source-id') as {
      source_id: string;
    };
    assert.equal(storedRow.source_id, '1234567890');

    const resolved = resolveFeedItemByIdentifier('tweet-1234567890');
    assert.equal(resolved?.id, 'tweet-canonical-source-id');
    assert.equal(resolved?.sourceId, '1234567890');

    const twitterPrefixedResolved = resolveFeedItemByIdentifier('twitter:1234567890');
    assert.equal(twitterPrefixedResolved?.id, 'tweet-canonical-source-id');
    assert.equal(twitterPrefixedResolved?.sourceId, '1234567890');
  });

  test('resolvePersistedFeedItemByIdentifier maps source ids to persisted row ids', () => {
    insertOrIgnoreFeedItem({
      id: 'parent-uuid-1',
      type: 'tweet',
      source: 'twitter',
      sourceId: '2030297403669004300',
      text: 'Parent tweet',
      mediaUrls: [],
      publishedAt: '2026-03-08T12:10:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
    });

    const resolved = resolvePersistedFeedItemByIdentifier('2030297403669004300');
    assert.equal(resolved?.id, 'parent-uuid-1');
  });

  test('resolvePersistedFeedItemByIdentifier materializes embedded quoted tweets as persisted rows', () => {
    insertOrIgnoreFeedItem({
      id: 'parent-uuid-quote',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'root-quote-parent',
      text: 'Quote tweet parent',
      mediaUrls: [],
      publishedAt: '2026-03-08T12:20:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
      metadata: {
        quotedTweet: {
          id: '9876543210',
          text: 'Embedded quoted tweet',
          author: {
            username: 'quoted_user',
            displayName: 'Quoted User',
          },
          url: 'https://x.com/quoted_user/status/9876543210',
        },
      },
    });

    const resolved = resolvePersistedFeedItemByIdentifier('9876543210');
    assert.equal(resolved?.id, '9876543210');
    assert.equal(resolved?.parentId, 'parent-uuid-quote');
    assert.equal(resolved?.relationship, 'child');
  });

  test('updateFeedItemEnrichment backfills a persisted quoted tweet row', () => {
    insertOrIgnoreFeedItem({
      id: 'tweet-enrichment-parent',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-enrichment-parent',
      text: 'Main tweet',
      mediaUrls: [],
      publishedAt: '2026-03-08T12:00:00.000Z',
      metrics: {
        likes: 1,
        reposts: 0,
        replies: 0,
      },
    });

    const updated = updateFeedItemEnrichment('tweet-enrichment-parent', {
      text: 'Main tweet',
      metrics: {
        likes: 2,
        reposts: 1,
        replies: 1,
      },
      metadata: {
        quotedTweet: {
          id: '444555666777',
          text: 'Backfilled quote',
          likeCount: 21,
          repostCount: 13,
          replyCount: 8,
          author: {
            username: 'backfilled_quote',
            displayName: 'Backfilled Quote',
          },
          url: 'https://x.com/backfilled_quote/status/444555666777',
        },
      },
    });

    assert.equal(updated, true);

    const quoteRow = getFeedItemById('444555666777');
    assert.equal(quoteRow?.parentId, 'tweet-enrichment-parent');
    assert.deepStrictEqual(quoteRow?.metrics, {
      likes: 21,
      reposts: 13,
      replies: 8,
    });
  });
});
