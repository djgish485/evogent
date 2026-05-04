import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { recordBrowseCacheRefresh } from './db/browse-cache';
import { getDb } from './db/client';
import { getFeedItemById, insertOrIgnoreFeedItem } from './db/feed';
import {
  applyCachedItemEnrichment,
  applyCachedTweetEnrichment,
  feedEnrichmentConverters,
  itemIsStillIncomplete,
  queueBatchEnrichment,
} from './feed-enrichment';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

function closeDb() {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

function cacheTweet(sourceId: string, payload: Record<string, unknown>, extra: {
  source?: string;
  url?: string | null;
  title?: string | null;
  authorUsername?: string | null;
  authorDisplayName?: string | null;
  publishedAtMs?: number | null;
  fetchedAtMs?: number;
  expiresAtMs?: number;
} = {}) {
  const now = Date.now();
  recordBrowseCacheRefresh({
    source: extra.source ?? 'twitter',
    triggeredBy: 'test',
    startedAtMs: now,
    completedAtMs: now,
    status: 'completed',
    items: [{
      source: extra.source ?? 'twitter',
      sourceId,
      url: extra.url ?? null,
      title: extra.title ?? null,
      authorUsername: extra.authorUsername ?? null,
      authorDisplayName: extra.authorDisplayName ?? null,
      publishedAtMs: extra.publishedAtMs ?? null,
      payload,
      fetchedAtMs: extra.fetchedAtMs ?? now,
      expiresAtMs: extra.expiresAtMs ?? now + 60_000,
    }],
  });
}

function insertTweet(id: string, overrides: Parameters<typeof insertOrIgnoreFeedItem>[0] = {}) {
  insertOrIgnoreFeedItem({
    id,
    type: 'tweet',
    source: 'twitter',
    sourceId: id,
    text: 'tweet text',
    publishedAt: '2026-04-25T09:04:00.000Z',
    metrics: {
      likes: 0,
      reposts: 0,
      replies: 0,
    },
    ...overrides,
  });
  const item = getFeedItemById(id);
  assert.ok(item);
  return item;
}

describe('cached tweet enrichment reconciliation', () => {
  let originalDbPath: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalFetch = globalThis.fetch;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-cache-test-'));
    closeDb();
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    closeDb();
    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }
    globalThis.fetch = originalFetch;
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('queues automatic batch enrichment metadata on each target without full enrichment request ids', async () => {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        requestId?: string;
        metadata?: { postIds?: string[]; enrichmentMode?: string };
      };
      assert.equal(body.requestId, 'batch-enrichment-test');
      assert.equal(body.metadata?.enrichmentMode, 'batch');
      assert.deepEqual(body.metadata?.postIds, ['tweet-batch-target', 'hn-batch-target']);

      return new Response(JSON.stringify({
        ok: true,
        queueDepth: 1,
        requestId: body.requestId,
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const tweet = insertTweet('tweet-batch-target');
    insertOrIgnoreFeedItem({
      id: 'hn-batch-target',
      type: 'article',
      source: 'hackernews',
      sourceId: 'hn-batch-target',
      title: 'HN batch target',
      text: 'HN item',
      url: 'https://news.ycombinator.com/item?id=123',
      publishedAt: '2026-04-25T09:05:00.000Z',
      metrics: {
        likes: 0,
        reposts: 0,
        replies: 0,
      },
    });
    const hackerNewsItem = getFeedItemById('hn-batch-target');
    assert.ok(hackerNewsItem);

    const result = await queueBatchEnrichment([tweet, hackerNewsItem], {
      requestId: 'batch-enrichment-test',
    });

    assert.equal(result.ok, true);
    const updatedTweet = getFeedItemById('tweet-batch-target');
    const updatedHn = getFeedItemById('hn-batch-target');
    assert.equal(updatedTweet?.metadata?.fullEnrichmentRequestId, undefined);
    assert.equal(updatedHn?.metadata?.fullEnrichmentRequestId, undefined);
    assert.equal(updatedTweet?.metadata?.batchEnrichment?.requestId, 'batch-enrichment-test');
    assert.equal(updatedHn?.metadata?.batchEnrichment?.requestId, 'batch-enrichment-test');
    assert.equal(updatedTweet?.metadata?.batchEnrichment?.status, 'queued');
    assert.equal(updatedHn?.metadata?.batchEnrichment?.status, 'queued');
    assert.equal(updatedTweet?.metadata?.batchEnrichment?.retryEligible, true);
    assert.equal(updatedHn?.metadata?.batchEnrichment?.retryEligible, true);
    assert.equal(typeof updatedTweet?.metadata?.batchEnrichment?.deadlineAt, 'string');
    assert.equal(typeof updatedHn?.metadata?.batchEnrichment?.deadlineAt, 'string');
  });

  test('fills a blank author avatar from exact cache without overwriting an existing avatar', () => {
    cacheTweet('tweet-avatar-1', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/cache-avatar.jpg',
    });
    const blankAvatar = insertTweet('tweet-avatar-1', { authorAvatarUrl: null });

    const patched = applyCachedTweetEnrichment(blankAvatar);
    assert.equal(patched?.authorAvatarUrl, 'https://pbs.twimg.com/profile_images/cache-avatar.jpg');

    cacheTweet('tweet-avatar-2', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/cache-avatar-2.jpg',
    });
    const existingAvatar = insertTweet('tweet-avatar-2', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/existing-avatar.jpg',
    });

    const unchanged = applyCachedTweetEnrichment(existingAvatar);
    assert.equal(unchanged?.authorAvatarUrl, 'https://pbs.twimg.com/profile_images/existing-avatar.jpg');
  });

  test('merges allowlisted cache facts without deleting richer feed fields', () => {
    cacheTweet('tweet-rich-1', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/author.jpg',
      media: [
        { url: 'https://pbs.twimg.com/media/existing.jpg' },
        { posterUrl: 'https://pbs.twimg.com/media/new-poster.jpg' },
      ],
      mediaUrls: [
        'https://pbs.twimg.com/media/new-poster.jpg',
        'https://pbs.twimg.com/media/new-legacy.jpg',
      ],
      metrics: {
        likes: 42,
        repostCount: 7,
        replyCount: 3,
        viewCount: 900,
      },
      quotedTweet: {
        text: 'cache quote text',
        authorUsername: 'cache_quote_user',
        authorDisplayName: 'Cache Quote User',
        authorAvatarUrl: 'https://pbs.twimg.com/profile_images/quote.jpg',
        url: 'https://x.com/cache_quote_user/status/999',
      },
      publishedAt: '2026-04-25T07:44:30.000Z',
      publishedAtMs: Date.parse('2026-04-25T07:44:30.000Z'),
    }, {
      url: 'https://x.com/author/status/tweet-rich-1',
      title: 'Cached title',
      authorUsername: 'author',
      authorDisplayName: 'Cached Author',
      publishedAtMs: Date.parse('2026-04-25T07:44:30.000Z'),
    });

    const item = insertTweet('tweet-rich-1', {
      title: null,
      url: null,
      authorUsername: null,
      authorDisplayName: null,
      mediaUrls: ['https://pbs.twimg.com/media/existing.jpg'],
      metadata: {
        bridge: 'keep me',
        quotedTweet: {
          text: 'existing quote text',
          authorUsername: 'existing_quote_user',
        },
      },
    });

    const patched = applyCachedTweetEnrichment(item);
    assert.equal(patched?.title, 'Cached title');
    assert.equal(patched?.url, 'https://x.com/author/status/tweet-rich-1');
    assert.equal(patched?.authorUsername, 'author');
    assert.equal(patched?.authorDisplayName, 'Cached Author');
    assert.deepEqual(patched?.mediaUrls, [
      'https://pbs.twimg.com/media/existing.jpg',
      'https://pbs.twimg.com/media/new-poster.jpg',
      'https://pbs.twimg.com/media/new-legacy.jpg',
    ]);
    assert.deepEqual(patched?.metrics, {
      likes: 42,
      reposts: 7,
      replies: 3,
      views: 900,
    });
    assert.equal(patched?.metadata?.bridge, 'keep me');
    assert.equal(patched?.metadata?.quotedTweet?.text, 'existing quote text');
    assert.equal(patched?.metadata?.quotedTweet?.author.username, 'existing_quote_user');
    assert.equal(patched?.metadata?.quotedTweet?.author.displayName, 'Cache Quote User');
    assert.equal(patched?.metadata?.quotedTweet?.author.avatarUrl, 'https://pbs.twimg.com/profile_images/quote.jpg');
  });

  test('fills a missing author avatar from latest fresh same-author cache without an exact tweet row', () => {
    const now = Date.now();
    cacheTweet('same-author-old', { authorAvatarUrl: 'https://pbs.twimg.com/profile_images/old.jpg' }, {
      authorUsername: 'vlada_mc', authorDisplayName: 'Old Display', fetchedAtMs: now - 10_000, expiresAtMs: now + 60_000,
    });
    cacheTweet('same-author-new', { authorAvatarUrl: 'https://pbs.twimg.com/profile_images/new.jpg' }, {
      authorUsername: 'vlada_mc', authorDisplayName: 'Vladimir Milosevic', fetchedAtMs: now, expiresAtMs: now + 60_000,
    });
    insertTweet('tw-2046943557345550711', {
      sourceId: '2046943557345550711', authorUsername: 'vlada_mc', authorDisplayName: null, authorAvatarUrl: null, metadata: { directBrowse: true },
    });

    const patched = applyCachedTweetEnrichment('tw-2046943557345550711');
    assert.equal(patched?.authorAvatarUrl, 'https://pbs.twimg.com/profile_images/new.jpg');
    assert.equal(patched?.authorDisplayName, 'Vladimir Milosevic');
    assert.equal(patched ? itemIsStillIncomplete(patched) : true, false);
  });

  test('backfills exact-cache external link card metadata for an existing tweet', () => {
    cacheTweet('2047982647264059734', {
      text: 'Built clawsweeper in a browser tab.',
      linkCard: {
        type: 'article',
        url: 'https://github.com/openclaw/clawsweeper',
        title: 'GitHub - openclaw/clawsweeper',
        domain: 'github.com',
        imageUrl: 'https://opengraph.githubassets.com/example/openclaw/clawsweeper',
        description: 'Minesweeper built with Claw.',
      },
      linkPreviews: [{
        url: 'https://github.com/openclaw/clawsweeper',
        title: 'GitHub - openclaw/clawsweeper',
        domain: 'github.com',
        image: 'https://opengraph.githubassets.com/example/openclaw/clawsweeper',
        description: 'Minesweeper built with Claw.',
      }],
      urlEntities: [{
        url: 'https://t.co/clawsweeper',
        expandedUrl: 'https://github.com/openclaw/clawsweeper',
        displayUrl: 'github.com/openclaw/clawsweeper',
      }],
    });
    const item = insertTweet('66f4db51-8722-4ad3-8c48-102aaa318b9e', {
      sourceId: '2047982647264059734',
      authorUsername: 'steipete',
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/steipete.jpg',
      metadata: { bridge: 'keep me' },
    });

    assert.equal(itemIsStillIncomplete(item), true);
    const patched = applyCachedTweetEnrichment('66f4db51-8722-4ad3-8c48-102aaa318b9e');

    assert.equal(patched?.metadata?.bridge, 'keep me');
    assert.equal(patched?.metadata?.linkCard?.url, 'https://github.com/openclaw/clawsweeper');
    assert.equal(patched?.metadata?.linkCard?.title, 'GitHub - openclaw/clawsweeper');
    assert.equal(patched?.metadata?.linkPreviews?.[0]?.url, 'https://github.com/openclaw/clawsweeper');
    assert.equal(patched?.metadata?.urlEntities?.[0]?.expandedUrl, 'https://github.com/openclaw/clawsweeper');
    assert.equal(patched ? itemIsStillIncomplete(patched) : true, false);
  });

  test('backfills exact-cache media alt text, poll metadata, and quoted tweet link cards', () => {
    const mediaUrl = 'https://pbs.twimg.com/media/siemens.jpg';
    cacheTweet('tweet-visible-fields', {
      text: 'Visible fields test.',
      media: [{
        type: 'image',
        url: mediaUrl,
        alt: 'Siemens SGT5-8000H gas turbine in assembly',
      }],
      linkCard: {
        type: 'article',
        url: 'https://www.bbc.com/news/example',
        title: 'BBC example',
        domain: 'bbc.com',
        imageUrl: 'https://ichef.bbci.co.uk/news/example.jpg',
        imageAlt: 'BBC card image description',
      },
      poll: {
        options: [
          { label: 'Yes', voteCount: 60 },
          { label: 'No', voteCount: 40 },
        ],
        totalVotes: 100,
        durationMinutes: 30,
      },
      quotedTweet: {
        id: 'quoted-visible-fields',
        text: 'Quoted tweet with a card and poll.',
        authorUsername: 'quoted_author',
        authorDisplayName: 'Quoted Author',
        url: 'https://x.com/quoted_author/status/quoted-visible-fields',
        linkCard: {
          type: 'article',
          url: 'https://example.com/quoted-card',
          title: 'Quoted card',
          domain: 'example.com',
          imageUrl: 'https://example.com/quoted-card.jpg',
          imageAlt: 'Quoted card image',
        },
        poll: {
          options: [
            { label: 'Ship it', voteCount: 9 },
            { label: 'Wait', voteCount: 1 },
          ],
          totalVotes: 10,
          endsAt: '2026-04-25T10:04:00.000Z',
        },
      },
    });
    const item = insertTweet('tweet-visible-fields', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/author.jpg',
      mediaUrls: [mediaUrl],
      metadata: {
        media: [{ type: 'image', url: mediaUrl }],
        linkCard: {
          type: 'article',
          url: 'https://www.bbc.com/news/example',
          title: 'BBC example',
          domain: 'bbc.com',
        },
        quotedTweet: {
          id: 'quoted-visible-fields',
          text: 'Quoted tweet with a card and poll.',
          author: {
            username: 'quoted_author',
            displayName: 'Quoted Author',
          },
          url: 'https://x.com/quoted_author/status/quoted-visible-fields',
        },
      },
    });

    assert.equal(itemIsStillIncomplete(item), true);
    const patched = applyCachedTweetEnrichment(item);

    assert.equal(patched?.metadata?.media?.length, 1);
    assert.equal(patched?.metadata?.media?.[0]?.alt, 'Siemens SGT5-8000H gas turbine in assembly');
    assert.equal(patched?.metadata?.linkCard?.imageAlt, 'BBC card image description');
    assert.deepEqual(patched?.metadata?.poll, {
      options: [
        { label: 'Yes', voteCount: 60 },
        { label: 'No', voteCount: 40 },
      ],
      totalVotes: 100,
      durationMinutes: 30,
    });
    assert.equal(patched?.metadata?.quotedTweet?.linkCard?.imageAlt, 'Quoted card image');
    assert.equal(patched?.metadata?.quotedTweet?.poll?.totalVotes, 10);
    assert.equal(patched ? itemIsStillIncomplete(patched) : true, false);

    const quoteRow = getFeedItemById('quoted-visible-fields');
    assert.equal(quoteRow?.metadata?.linkCard?.imageAlt, 'Quoted card image');
    assert.equal(quoteRow?.metadata?.poll?.options[0]?.label, 'Ship it');
  });

  test('backfills exact-cache community notes for main and quoted tweets', () => {
    cacheTweet('tweet-community-note-cache', {
      communityNote: {
        text: 'Main tweet Readers added context.',
        sourceUrl: 'https://example.com/main-community-note',
      },
      quotedTweet: {
        id: '888999000111',
        text: 'Quoted tweet text',
        authorUsername: 'quoted_author',
        authorDisplayName: 'Quoted Author',
        url: 'https://x.com/quoted_author/status/888999000111',
        communityNote: {
          text: 'Quoted tweet Readers added context.',
          sourceUrl: 'https://example.com/quoted-community-note',
        },
      },
    });
    const item = insertTweet('tweet-community-note-cache', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/author.jpg',
      metadata: {
        quotedTweet: {
          id: '888999000111',
          text: 'Quoted tweet text',
          author: {
            username: 'quoted_author',
            displayName: 'Quoted Author',
          },
          url: 'https://x.com/quoted_author/status/888999000111',
        },
      },
    });

    assert.equal(itemIsStillIncomplete(item), true);
    const patched = applyCachedTweetEnrichment(item);

    assert.deepEqual(patched?.metadata?.communityNote, {
      text: 'Main tweet Readers added context.',
      sourceUrl: 'https://example.com/main-community-note',
    });
    assert.deepEqual(patched?.metadata?.quotedTweet?.communityNote, {
      text: 'Quoted tweet Readers added context.',
      sourceUrl: 'https://example.com/quoted-community-note',
    });
    assert.equal(patched ? itemIsStillIncomplete(patched) : true, false);

    const quoteRow = getFeedItemById('888999000111');
    assert.deepEqual(quoteRow?.metadata?.communityNote, {
      text: 'Quoted tweet Readers added context.',
      sourceUrl: 'https://example.com/quoted-community-note',
    });
  });

  test('same-author fallback never copies tweet-scoped fields from a different tweet', () => {
    cacheTweet('same-author-rich-source', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/author-only.jpg',
      mediaUrls: ['https://pbs.twimg.com/media/other.jpg'],
      metrics: { likes: 999, repostCount: 99, replyCount: 9, viewCount: 9000 },
      quotedTweet: { text: 'other quote', authorUsername: 'other_quote_user' },
      linkCard: {
        type: 'article',
        url: 'https://example.com/other-tweet-card',
        title: 'Other tweet card',
        domain: 'example.com',
      },
      linkPreviews: [{
        url: 'https://example.com/other-tweet-card',
        title: 'Other tweet card',
        domain: 'example.com',
      }],
      urlEntities: [{
        url: 'https://t.co/other',
        expandedUrl: 'https://example.com/other-tweet-card',
      }],
      publishedAt: '2026-04-24T00:00:00.000Z',
      publishedAtMs: Date.parse('2026-04-24T00:00:00.000Z'),
    }, {
      url: 'https://x.com/vlada_mc/status/same-author-rich-source',
      title: 'Other tweet title',
      authorUsername: 'vlada_mc',
      authorDisplayName: 'Vladimir Milosevic',
      publishedAtMs: Date.parse('2026-04-24T00:00:00.000Z'),
    });
    const item = insertTweet('different-tweet-by-author', {
      sourceId: '1111111111111111111',
      authorUsername: 'vlada_mc',
      authorDisplayName: null,
      authorAvatarUrl: null,
      title: null,
      url: null,
      mediaUrls: [],
      metrics: { likes: 0, reposts: 0, replies: 0 },
      metadata: null,
      publishedAt: '2026-04-25T09:04:00.000Z',
    });

    const patched = applyCachedTweetEnrichment(item);
    assert.equal(patched?.authorAvatarUrl, 'https://pbs.twimg.com/profile_images/author-only.jpg');
    assert.equal(patched?.authorDisplayName, 'Vladimir Milosevic');
    assert.equal(patched?.title, null);
    assert.equal(patched?.url, null);
    assert.deepEqual(patched?.mediaUrls, []);
    assert.deepEqual(patched?.metrics, { likes: 0, reposts: 0, replies: 0 });
    assert.equal(patched?.metadata?.quotedTweet, undefined);
    assert.equal(patched?.metadata?.linkCard, undefined);
    assert.equal(patched?.metadata?.linkPreviews, undefined);
    assert.equal(patched?.metadata?.urlEntities, undefined);
    assert.equal(patched?.publishedAt, '2026-04-25T09:04:00.000Z');
  });

  test('same-author fallback ignores expired, missing-username, and mismatched author rows', () => {
    const now = Date.now();
    cacheTweet('same-author-expired', { authorAvatarUrl: 'https://pbs.twimg.com/profile_images/expired.jpg' }, {
      authorUsername: 'vlada_mc', fetchedAtMs: now, expiresAtMs: now - 1_000,
    });
    cacheTweet('same-display-different-author', { authorAvatarUrl: 'https://pbs.twimg.com/profile_images/wrong-author.jpg' }, {
      authorUsername: 'alice', authorDisplayName: 'Vladimir Milosevic',
    });
    const expired = insertTweet('same-author-expired-target', { authorUsername: 'vlada_mc', authorAvatarUrl: null });
    const missingUsername = insertTweet('missing-username-target', {
      authorUsername: null,
      authorDisplayName: 'Vladimir Milosevic',
      authorAvatarUrl: null,
    });
    assert.equal(applyCachedTweetEnrichment(missingUsername)?.authorAvatarUrl, null);

    const mismatchedUsername = insertTweet('mismatched-username-target', {
      authorUsername: 'vlada_mc',
      authorDisplayName: 'Vladimir Milosevic',
      authorAvatarUrl: null,
    });
    assert.equal(applyCachedTweetEnrichment(expired)?.authorAvatarUrl, null);
    assert.equal(applyCachedTweetEnrichment(mismatchedUsername)?.authorAvatarUrl, null);
  });

  test('cache miss, malformed payload, non-twitter, and child tweet cases are no-ops', () => {
    const cacheMiss = insertTweet('tweet-cache-miss', { authorAvatarUrl: null });
    assert.equal(applyCachedTweetEnrichment(cacheMiss)?.authorAvatarUrl, null);

    getDb().prepare(`
      INSERT INTO browse_cache_items (
        source,
        source_id,
        payload_json,
        fetched_at_ms,
        expires_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run('twitter', 'tweet-malformed', '{', Date.now(), Date.now() + 60_000);
    const malformed = insertTweet('tweet-malformed', { authorAvatarUrl: null });
    assert.equal(applyCachedTweetEnrichment(malformed)?.authorAvatarUrl, null);

    cacheTweet('tweet-non-twitter', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/non-twitter.jpg',
    });
    const nonTwitter = insertTweet('tweet-non-twitter', {
      source: 'youtube',
      authorAvatarUrl: null,
    });
    assert.equal(applyCachedTweetEnrichment(nonTwitter)?.authorAvatarUrl, null);

    cacheTweet('tweet-child', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/child.jpg',
    });
    insertTweet('tweet-parent', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/parent.jpg',
    });
    const child = insertTweet('tweet-child', {
      parentId: 'tweet-parent',
      relationship: 'child',
      authorAvatarUrl: null,
    });
    assert.equal(applyCachedTweetEnrichment(child)?.authorAvatarUrl, null);
  });

  test('cache reconciliation can make a tweet complete for automatic enrichment checks', () => {
    cacheTweet('tweet-complete-after-cache', {
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/cache-avatar.jpg',
      media: [{ url: 'https://pbs.twimg.com/media/cache.jpg' }],
      quotedTweet: {
        text: 'quoted',
        authorUsername: 'quoted_author',
      },
    });
    const item = insertTweet('tweet-complete-after-cache', {
      authorAvatarUrl: null,
      mediaUrls: [],
      metadata: null,
    });

    assert.equal(itemIsStillIncomplete(item), true);
    const patched = applyCachedTweetEnrichment(item);
    assert.equal(patched ? itemIsStillIncomplete(patched) : true, false);
  });

  test('named converter library handles explicit conversions only', () => {
    assert.equal(feedEnrichmentConverters.secondsToMs(42, {} as never), 42_000);
    assert.equal(feedEnrichmentConverters.parseShortNumber('1.2K', {} as never), 1200);
    assert.equal(feedEnrichmentConverters.trimToNull('  hello  ', {} as never), 'hello');
    assert.deepEqual(feedEnrichmentConverters.appendDedupe(['a', ' ', 'b'], {} as never), ['a', 'b']);
    assert.deepEqual(feedEnrichmentConverters.deepMerge({ nested: true }, {} as never), { nested: true });
    assert.equal(feedEnrichmentConverters.youtubeHandle('  @example  ', {} as never), '@example');
    assert.equal(feedEnrichmentConverters.passthrough(0, {} as never), 0);
  });

  test('follows cache parent reference and carries quoted video metadata on the sibling row', () => {
    cacheTweet('2050428855463325762', {
      text: 'Most humans are completely not creative.',
      authorUsername: 'ToKTeacher',
      authorDisplayName: 'Brett Hall',
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/brett.jpg',
      quotedTweet: {
        id: 'iai-video',
        authorUsername: 'IAI_TV',
        authorDisplayName: 'Institute of Art and Ideas',
        text: 'Anything a human can do intellectually will be done better.',
        media: [{
          type: 'video',
          url: 'https://pbs.twimg.com/ext_tw_video_thumb/iai.jpg',
          posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/iai.jpg',
        }],
      },
      media: [{ type: 'image', url: 'https://pbs.twimg.com/media/parent.jpg' }],
    });
    cacheTweet('2050428858533654869', {
      text: 'To elevate how impressive AI is many will jump straight to bringing down actual people.',
      authorUsername: 'ToKTeacher',
      authorDisplayName: 'Brett Hall',
      inReplyToStatusId: '2050428855463325762',
    });
    const item = insertTweet('ma-curate-20260502T0630Z-tw-2050428858533654869', {
      sourceId: '2050428858533654869',
      authorUsername: 'ToKTeacher',
    });

    applyCachedItemEnrichment(item);

    const parent = getDb().prepare(`
      SELECT *
      FROM feed
      WHERE parent_id = ?
        AND relationship = 'parent'
        AND source_id = ?
    `).get(item.id, '2050428855463325762') as { metadata: string | null } | undefined;
    assert.ok(parent);
    const metadata = JSON.parse(parent.metadata ?? '{}') as {
      quotedTweet?: { author?: { username?: string }; media?: Array<{ type?: string; url?: string }> };
    };
    assert.equal(metadata.quotedTweet?.author?.username, 'IAI_TV');
    assert.equal(metadata.quotedTweet?.media?.[0]?.type, 'video');
  });

  test('preserves quoted tweet metadata when quote username is missing in timeline cache', () => {
    cacheTweet('2049754629823705589', {
      text: 'The entire problem of climate change is actually limited to dumping gasses into the atmosphere only.',
      authorUsername: 'vlada_mc',
      quotedTweet: {
        authorUsername: null,
        authorDisplayName: 'Dr. Matthew M. Wielicki',
        text: 'They capture their CO2? Yeah... in the atmosphere.',
      },
    });
    const vlada = insertTweet('2049754629823705589', {
      sourceId: '2049754629823705589',
      authorUsername: 'vlada_mc',
      metadata: null,
    });

    const patchedVlada = applyCachedItemEnrichment(vlada);
    assert.equal(patchedVlada?.metadata?.quotedTweet?.text, 'They capture their CO2? Yeah... in the atmosphere.');
    assert.equal(patchedVlada?.metadata?.quotedTweet?.author.displayName, 'Dr. Matthew M. Wielicki');

    cacheTweet('2049708377140539785', {
      text: 'I worry deeply already about companies controlling access to very powerful AI.',
      authorUsername: 'natolambert',
      quotedTweet: {
        authorUsername: null,
        authorDisplayName: null,
        text: 'The White House is against a proposal from Anthropic to more than double access to Mythos.',
      },
      raw_data: {
        rawText: 'Nathan Lambert\n@natolambert\nQuote\nAndrew Curran\n@AndrewCurran_\nThe White House is against a proposal from Anthropic to more than double access to Mythos.',
      },
    });
    const nato = insertTweet('2049708377140539785', {
      sourceId: '2049708377140539785',
      authorUsername: 'natolambert',
      metadata: null,
    });

    const patchedNato = applyCachedItemEnrichment(nato);
    assert.equal(patchedNato?.metadata?.quotedTweet?.author.username, 'AndrewCurran_');
    assert.equal(
      patchedNato?.metadata?.quotedTweet?.text,
      'The White House is against a proposal from Anthropic to more than double access to Mythos.',
    );
  });

  test('cache reference following detects cycles and does not loop', () => {
    cacheTweet('cycle-root', {
      text: 'root',
      authorUsername: 'cycle',
      inReplyToStatusId: 'cycle-a',
    });
    cacheTweet('cycle-a', {
      text: 'a',
      authorUsername: 'cycle',
      inReplyToStatusId: 'cycle-b',
    });
    cacheTweet('cycle-b', {
      text: 'b',
      authorUsername: 'cycle',
      inReplyToStatusId: 'cycle-a',
    });
    const root = insertTweet('cycle-root', { sourceId: 'cycle-root', authorUsername: 'cycle' });

    applyCachedItemEnrichment(root);

    const rows = getDb().prepare(`
      SELECT source_id AS sourceId
      FROM feed
      WHERE parent_id = ?
        AND relationship = 'parent'
      ORDER BY source_id ASC
    `).all(root.id) as Array<{ sourceId: string }>;
    assert.deepEqual(rows.map((row) => row.sourceId), ['cycle-a', 'cycle-b']);
  });

  test('missing and different-source references are graceful no-ops', () => {
    cacheTweet('missing-ref-root', {
      text: 'root',
      authorUsername: 'root',
      inReplyToStatusId: 'missing-parent',
    });
    const missingRoot = insertTweet('missing-ref-root', { sourceId: 'missing-ref-root', authorUsername: 'root' });
    applyCachedItemEnrichment(missingRoot);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM feed WHERE parent_id = ?').get(missingRoot.id)?.count, 0);

    cacheTweet('numeric-collision-root', {
      text: 'root',
      authorUsername: 'root',
      inReplyToStatusId: '123',
    });
    cacheTweet('123', {
      title: 'HN numeric collision',
      by: 'hn-user',
      score: 10,
    }, { source: 'hackernews' });
    const collisionRoot = insertTweet('numeric-collision-root', {
      sourceId: 'numeric-collision-root',
      authorUsername: 'root',
    });
    applyCachedItemEnrichment(collisionRoot);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM feed WHERE parent_id = ?').get(collisionRoot.id)?.count, 0);
  });
});
