import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  arrangeFeedBackstopForCycle,
  arrangeFeedDisplay,
  findTweetFeedItemByIdentifier,
  getActiveFeedThreads,
  getCurrentFeedArrangeInput,
  getFeedChildren,
  getFeedItemById,
  getFeedItemBySourceId,
  getLastArrangeAtMs,
  getPendingFeedCounts,
  getFeedPage,
  getSingletonShipmentThreadId,
  hydrateFeedItemsForList,
  insertOrIgnoreFeedItem,
  normalizeArticleSourceId,
  normalizeFeedInput,
  normalizeRelationship,
  normalizeType,
  recordFeedArrangementRun,
} from './feed';
import { getDb } from './client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('feed normalization', () => {
  test('normalizeFeedInput maps common fields', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      source_id: 'abc123',
      text: 'hello',
      tags: ['a', 'b'],
      media_urls: ['https://img.test/1.png'],
      published_at: '2026-02-27T10:00:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result?.type, 'tweet');
    assert.strictEqual(result?.sourceId, 'abc123');
    assert.strictEqual(result?.parentId, null);
    assert.strictEqual(result?.relationship, null);
    assert.deepStrictEqual(result?.tags, ['a', 'b']);
    assert.deepStrictEqual(result?.mediaUrls, ['https://img.test/1.png']);
  });

  test('normalizeFeedInput strips legacy tweet sourceId prefixes', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-2030455675357143260',
      text: 'hello',
      publishedAt: '2026-03-01T00:00:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result?.sourceId, '2030455675357143260');
  });

  test('normalizeFeedInput constructs tweet urls from authorUsername and sourceId when url is missing', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-2030455675357143260',
      authorUsername: '@example_author',
      text: 'hello',
      publishedAt: '2026-03-01T00:00:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result?.sourceId, '2030455675357143260');
    assert.strictEqual(result?.url, 'https://x.com/example_author/status/2030455675357143260');
  });

  test('normalizeFeedInput preserves flat curator thread metadata as nested thread metadata', () => {
    const result = normalizeFeedInput({
      type: 'article',
      source: 'web',
      text: 'hello',
      publishedAt: '2026-03-01T00:00:00.000Z',
      metadata: {
        threadId: 'flat-thread',
        threadTitle: 'Flat thread title',
        threadRationale: 'Flat thread rationale',
        bridge: 'Why this belongs here',
      },
    });

    assert.ok(result);
    assert.strictEqual(result?.metadata?.thread?.threadId, 'flat-thread');
    assert.strictEqual(result?.metadata?.thread?.threadTitle, 'Flat thread title');
    assert.strictEqual(result?.metadata?.thread?.threadRationale, 'Flat thread rationale');
    assert.strictEqual(result?.metadata?.bridge, 'Why this belongs here');
  });

  test('normalizeFeedInput falls back to bridge when top-level reason is missing', () => {
    const result = normalizeFeedInput({
      type: 'article',
      source: 'web',
      title: 'Important source',
      text: 'hello',
      publishedAt: '2026-03-01T00:00:00.000Z',
      metadata: {
        bridge: 'Why this belongs here',
      },
    });

    assert.ok(result);
    assert.strictEqual(result?.reason, 'Why this belongs here');
  });

  test('normalizeFeedInput keeps explicit reason ahead of bridge fallback', () => {
    const result = normalizeFeedInput({
      type: 'article',
      source: 'web',
      title: 'Important source',
      text: 'hello',
      reason: 'Explicit curation reason',
      publishedAt: '2026-03-01T00:00:00.000Z',
      metadata: {
        bridge: 'Bridge fallback',
      },
    });

    assert.ok(result);
    assert.strictEqual(result?.reason, 'Explicit curation reason');
  });

  test('normalizeFeedInput persists HN discussion URL metadata from sourceId', () => {
    const result = normalizeFeedInput({
      type: 'article',
      source: 'hackernews',
      sourceId: 'hn-100001',
      title: 'Synthetic systems paper',
      text: 'Synthetic systems paper',
      url: 'https://news.example.com/research/synthetic-systems-paper',
      publishedAt: '2026-04-25T00:00:00.000Z',
      metadata: {
        hnScore: 5,
        hnComments: 0,
      },
    });

    assert.ok(result);
    assert.strictEqual(result?.url, 'https://news.example.com/research/synthetic-systems-paper');
    assert.strictEqual(result?.metadata?.hnUrl, 'https://news.ycombinator.com/item?id=100001');
    assert.strictEqual(result?.metadata?.hnScore, 5);
    assert.strictEqual(result?.metadata?.hnComments, 0);
  });

  test('normalizeFeedInput preserves youtube video metadata and canonicalizes watch urls', () => {
    const result = normalizeFeedInput({
      type: 'article',
      source: 'youtube',
      sourceId: 'https://youtu.be/video12345?si=abc',
      title: 'Recovered YouTube title',
      text: 'Recovered YouTube title\nDetailed description from cache.',
      mediaUrls: [],
      publishedAt: '2026-03-01T00:00:00.000Z',
      metadata: {
        videoId: 'video12345',
        title: 'Recovered YouTube title',
        description: 'Detailed description from cache.',
        channelName: 'Recovered Channel',
        channelHandle: '@recovered',
        channelUrl: 'https://www.youtube.com/@recovered',
        thumbnailUrl: 'https://i.ytimg.com/vi/video12345/hqdefault.jpg',
        duration: '12:34',
        durationSeconds: 754,
        liveStatus: 'upcoming',
        scheduledStartText: 'Scheduled for Mar 28, 7:00 PM',
      },
    });

    assert.ok(result);
    assert.strictEqual(result?.sourceId, 'video12345');
    assert.strictEqual(result?.url, 'https://www.youtube.com/watch?v=video12345');
    assert.strictEqual(result?.authorDisplayName, 'Recovered Channel');
    assert.strictEqual(result?.authorUsername, '@recovered');
    assert.deepStrictEqual(result?.mediaUrls, ['https://i.ytimg.com/vi/video12345/hqdefault.jpg']);
    assert.strictEqual(result?.metadata?.linkCard?.videoId, 'video12345');
    assert.strictEqual(result?.metadata?.linkCard?.url, 'https://www.youtube.com/watch?v=video12345');
    assert.strictEqual(result?.metadata?.article?.videoId, 'video12345');
    assert.strictEqual(result?.metadata?.article?.channelName, 'Recovered Channel');
    assert.strictEqual(result?.metadata?.article?.duration, '12:34');
    assert.strictEqual(result?.metadata?.article?.liveStatus, 'upcoming');
    assert.strictEqual(result?.metadata?.article?.scheduledStartText, 'Scheduled for Mar 28, 7:00 PM');
  });

  test('normalizeArticleSourceId upgrades legacy newsletter source ids to canonical urls', () => {
    assert.strictEqual(
      normalizeArticleSourceId('journal.example.com:/p/synthetic-essay'),
      'https://journal.example.com/p/synthetic-essay',
    );
    assert.strictEqual(
      normalizeArticleSourceId('example-letter:/p/synthetic-essay'),
      'https://example-letter.substack.com/p/synthetic-essay',
    );
  });

  test('normalizeFeedInput rejects empty text', () => {
    const result = normalizeFeedInput({ type: 'article', text: '   ' });
    assert.strictEqual(result, null);
  });

  test('normalizeFeedInput maps metrics and metadata', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      sourceId: 'https://x.com/alice/status/123',
      text: 'hello https://t.co/test',
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/a.jpg',
      metrics: { likes: 10, reposts: 2, replies: 1, views: 200 },
      metadata: {
        likeCount: 42,
        repostCount: 7,
        replyCount: 3,
        isRetweet: true,
        retweetedBy: { username: 'bob' },
        media: [{ type: 'image', url: 'https://pbs.twimg.com/media/1.jpg', alt: 'Image alt text' }],
        mediaTypes: ['photo'],
        linkCard: {
          type: 'article',
          url: 'https://example.com/main-card',
          title: 'Main card',
          domain: 'example.com',
          imageUrl: 'https://example.com/main-card.jpg',
          imageAlt: 'Main card image',
        },
        poll: {
          options: [
            { label: 'Yes', voteCount: 3 },
            { label: 'No', voteCount: 2 },
          ],
          totalVotes: 5,
          durationMinutes: 45,
        },
        quotedTweet: {
          id: '555',
          text: 'quote',
          likeCount: 9,
          repostCount: 4,
          replyCount: 2,
          author: {
            username: 'charlie',
            name: 'Charlie',
          },
          linkCard: {
            type: 'article',
            url: 'https://example.com/quote-card',
            title: 'Quote card',
            domain: 'example.com',
            imageAlt: 'Quote card image',
          },
          poll: {
            options: [{ label: 'Quote option', voteCount: 1 }],
            totalVotes: 1,
            endsAt: '2026-03-01T01:00:00.000Z',
          },
        },
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metrics, { likes: 10, reposts: 2, replies: 1, views: 200 });
    assert.strictEqual(result?.authorAvatarUrl, 'https://pbs.twimg.com/profile_images/a.jpg');
    assert.strictEqual(result?.metadata?.likeCount, 42);
    assert.strictEqual(result?.metadata?.repostCount, 7);
    assert.strictEqual(result?.metadata?.replyCount, 3);
    assert.strictEqual(result?.metadata?.isRetweet, true);
    assert.strictEqual(result?.metadata?.retweetedBy?.username, 'bob');
    assert.strictEqual(result?.metadata?.media?.[0]?.alt, 'Image alt text');
    assert.deepStrictEqual(result?.metadata?.mediaTypes, ['photo']);
    assert.strictEqual(result?.metadata?.linkCard?.imageAlt, 'Main card image');
    assert.deepStrictEqual(result?.metadata?.poll, {
      options: [
        { label: 'Yes', voteCount: 3 },
        { label: 'No', voteCount: 2 },
      ],
      totalVotes: 5,
      durationMinutes: 45,
    });
    assert.strictEqual(result?.metadata?.quotedTweet?.author.displayName, 'Charlie');
    assert.strictEqual(result?.metadata?.quotedTweet?.linkCard?.imageAlt, 'Quote card image');
    assert.strictEqual(result?.metadata?.quotedTweet?.poll?.endsAt, '2026-03-01T01:00:00.000Z');
    assert.deepStrictEqual(result?.metadata?.quotedTweet?.metrics, {
      likes: 9,
      reposts: 4,
      replies: 2,
    });
  });

  test('normalizeFeedInput preserves reflectionCycle metadata on reflection analysis cards', () => {
    const result = normalizeFeedInput({
      type: 'analysis',
      source: 'claude',
      text: 'Reflection summary',
      metadata: {
        reflectionCycle: true,
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata, {
      reflectionCycle: true,
    });
  });

  test('normalizeFeedInput preserves validated prominence metadata', () => {
    const result = normalizeFeedInput({
      type: 'article',
      source: 'publisher',
      sourceId: 'https://publisher.example.com/example',
      title: 'Lead story',
      text: 'Lead story summary',
      publishedAt: '2026-04-25T12:00:00.000Z',
      metadata: {
        prominence: {
          level: 'lead',
          source: 'homepage',
          evidence: 'Large headline in the top homepage slot.',
        },
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.prominence, {
      level: 'lead',
      source: 'homepage',
      evidence: 'Large headline in the top homepage slot.',
    });
  });

  test('normalizeFeedInput preserves validated thread prominence metadata', () => {
    const result = normalizeFeedInput({
      type: 'article',
      source: 'publisher',
      sourceId: 'https://publisher.example.com/example-thread',
      title: 'Thread story',
      text: 'Thread story summary',
      publishedAt: '2026-04-25T12:00:00.000Z',
      metadata: {
        cycleId: 'cycle-1',
        thread: {
          threadId: 'thread-1',
          threadTitle: 'Major thread title',
          prominence: {
            level: 'Lead',
            source: 'homepage',
            evidence: 'Largest homepage headline.',
            homepageUrl: 'https://publisher.example.com/',
          },
        },
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.thread, {
      threadId: 'thread-1',
      threadTitle: 'Major thread title',
      prominence: {
        level: 'lead',
        source: 'homepage',
        evidence: 'Largest homepage headline.',
        homepageUrl: 'https://publisher.example.com/',
      },
    });
  });

  test('normalizeFeedInput defaults notification metadata fields', () => {
    const result = normalizeFeedInput({
      type: 'notification',
      source: 'system',
      sourceId: 'tweet-cache-auth-expired',
      text: 'Twitter cookies expired',
      metadata: {},
    });

    assert.ok(result);
    assert.strictEqual(result?.type, 'notification');
    assert.deepStrictEqual(result?.metadata, {
      severity: 'info',
      dismissable: true,
      notificationId: 'tweet-cache-auth-expired',
    });
  });

  test('normalizeFeedInput falls back to thumbnail urls for video metadata', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: 'video tweet https://t.co/test',
      metadata: {
        media: [
          {
            type: 'video',
            url: 'https://video.twimg.com/video.mp4',
            posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/1.jpg',
          },
          {
            type: 'image',
            url: 'https://pbs.twimg.com/media/photo.jpg',
          },
        ],
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.mediaUrls, [
      'https://pbs.twimg.com/ext_tw_video_thumb/1.jpg',
      'https://pbs.twimg.com/media/photo.jpg',
    ]);
    assert.deepStrictEqual(result?.metadata?.mediaTypes, ['video', 'photo']);
  });

  test('normalizeFeedInput deduplicates flat media urls', () => {
    const poster = 'https://pbs.twimg.com/amplify_video_thumb/1/img/test.jpg';
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: 'video tweet',
      media_urls: [poster, poster],
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.mediaUrls, [poster]);
  });

  test('normalizeFeedInput filters blob flat media urls', () => {
    const poster = 'https://pbs.twimg.com/amplify_video_thumb/1/img/test.jpg';
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: 'video tweet',
      media_urls: ['blob:https://x.com/session-video', poster],
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.mediaUrls, [poster]);
  });

  test('normalizeFeedInput deduplicates metadata media and derives media urls', () => {
    const poster = 'https://pbs.twimg.com/amplify_video_thumb/1/img/test.jpg';
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: 'video tweet',
      metadata: {
        media: [
          { type: 'video', url: 'blob:https://x.com/session-video', posterUrl: poster },
          { type: 'video', url: poster, posterUrl: poster },
        ],
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.mediaUrls, [poster]);
    assert.strictEqual(result?.metadata?.media?.length, 1);
    assert.strictEqual(result?.metadata?.media?.[0]?.type, 'video');
    assert.deepStrictEqual(result?.metadata?.mediaTypes, ['video']);
  });

  test('normalizeFeedInput preserves distinct metadata media in order', () => {
    const firstPoster = 'https://pbs.twimg.com/amplify_video_thumb/1/img/first.jpg';
    const secondPoster = 'https://pbs.twimg.com/amplify_video_thumb/2/img/second.jpg';
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: 'two video tweet',
      metadata: {
        media: [
          { type: 'video', url: firstPoster, posterUrl: firstPoster },
          { type: 'video', url: secondPoster, posterUrl: secondPoster },
        ],
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.mediaUrls, [firstPoster, secondPoster]);
    assert.deepStrictEqual(
      result?.metadata?.media?.map((entry) => entry.posterUrl),
      [firstPoster, secondPoster],
    );
    assert.deepStrictEqual(result?.metadata?.mediaTypes, ['video', 'video']);
  });

  test('normalizeFeedInput accepts flat quoted tweet metadata from curation output', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: 'Quoting a tweet https://t.co/quote',
      metadata: {
        quotedTweet: {
          text: 'Quoted tweet body',
          likeCount: 15,
          repostCount: 6,
          replyCount: 3,
          authorUsername: 'quoted_author',
          authorDisplayName: 'Quoted Author',
          authorAvatarUrl: 'https://pbs.twimg.com/profile_images/quoted.jpg',
          url: 'https://x.com/quoted_author/status/1234567890123456789',
        },
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.quotedTweet, {
      id: '1234567890123456789',
      text: 'Quoted tweet body',
      author: {
        username: 'quoted_author',
        displayName: 'Quoted Author',
        avatarUrl: 'https://pbs.twimg.com/profile_images/quoted.jpg',
      },
      metrics: {
        likes: 15,
        reposts: 6,
        replies: 3,
      },
      url: 'https://x.com/quoted_author/status/1234567890123456789',
    });
  });

  test('normalizeFeedInput preserves nested quoted tweet metrics from stored metadata', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: 'Quoting a tweet https://t.co/quote',
      metadata: {
        quotedTweet: {
          id: '1234567890123456789',
          text: 'Quoted tweet body',
          metrics: {
            replies: 12,
            reposts: 34,
            likes: 56,
          },
          author: {
            username: 'quoted_author',
            displayName: 'Quoted Author',
          },
          url: 'https://x.com/quoted_author/status/1234567890123456789',
        },
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.quotedTweet?.metrics, {
      likes: 56,
      reposts: 34,
      replies: 12,
    });
  });

  test('normalizeFeedInput preserves compatible replyCapture classifications', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: '@ExampleAccount reply context should survive normalization',
      metadata: {
        replyCapture: {
          source: 'timeline',
          classification: 'authored_timeline_entry',
          requestedHandle: 'ExampleAccount',
          authoredByRequestedAccount: true,
          visibleReplyBanner: true,
        },
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.replyCapture, {
      source: 'timeline',
      classification: 'candidate',
      requestedHandle: 'exampleaccount',
      authoredByRequestedAccount: true,
      visibleReplyBanner: true,
    });
  });

  test('normalizeFeedInput preserves rich link previews in metadata', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      text: 'hello',
      metadata: {
        linkPreviews: [
          {
            url: 'https://news-one.example.com/world/story',
            title: 'Story title',
            image: 'https://news-one.example.com/image.jpg',
            domain: 'news-one.example.com',
            description: 'Story summary',
          },
          {
            url: 'https://news-two.example.com/story',
            title: 'Second title',
            imageUrl: 'https://news-two.example.com/image.jpg',
            domain: 'news-two.example.com',
          },
        ],
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.linkPreviews, [
      {
        url: 'https://news-one.example.com/world/story',
        title: 'Story title',
        image: 'https://news-one.example.com/image.jpg',
        domain: 'news-one.example.com',
        description: 'Story summary',
      },
      {
        url: 'https://news-two.example.com/story',
        title: 'Second title',
        image: 'https://news-two.example.com/image.jpg',
        domain: 'news-two.example.com',
      },
    ]);
  });

  test('normalizeFeedInput maps parent and relationship', () => {
    const result = normalizeFeedInput({
      type: 'analysis',
      text: 'Thread context',
      parent_id: 'post-123',
      relationship: 'reply',
    });

    assert.ok(result);
    assert.strictEqual(result?.parentId, 'post-123');
    assert.strictEqual(result?.relationship, 'reply');
  });

  test('normalizeType returns null for unknown values', () => {
    assert.strictEqual(normalizeType('unknown-type'), null);
    assert.strictEqual(normalizeType(undefined), null);
  });

  test('normalizeFeedInput rejects unknown types', () => {
    const result = normalizeFeedInput({
      type: 'unknown-type',
      text: 'Should not normalize',
      publishedAt: '2026-03-01T09:30:00.000Z',
    });

    assert.strictEqual(result, null);
  });

  test('normalizeRelationship maps valid relationship values', () => {
    const values = ['parent', 'child', 'reply', 'analysis', 'related', 'thread'] as const;

    for (const value of values) {
      assert.strictEqual(normalizeRelationship(value), value);
    }
  });

  test('normalizeRelationship returns null for unknown values', () => {
    assert.strictEqual(normalizeRelationship('not-a-relationship'), null);
    assert.strictEqual(normalizeRelationship(undefined), null);
  });

  test('normalizeFeedInput handles camelCase fields', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      text: 'Camel case payload',
      authorUsername: 'alice',
      mediaUrls: ['https://img.test/2.png'],
      publishedAt: '2026-03-01T09:30:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result?.authorUsername, 'alice');
    assert.deepStrictEqual(result?.mediaUrls, ['https://img.test/2.png']);
    assert.strictEqual(result?.publishedAt, '2026-03-01T09:30:00.000Z');
  });

  test('normalizeFeedInput auto-generates UUID when id is missing', () => {
    const result = normalizeFeedInput({
      type: 'article',
      text: 'Generated id check',
      published_at: '2026-03-01T09:45:00.000Z',
    });

    assert.ok(result);
    assert.match(
      result?.id ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test('normalizeFeedInput overrides publishedAt for claude source', () => {
    const before = Date.now();
    const result = normalizeFeedInput({
      type: 'article',
      source: 'claude',
      text: 'Agent-authored content',
      published_at: '2020-01-01T00:00:00.000Z',
    });
    const after = Date.now();

    assert.ok(result);
    const publishedTime = new Date(result?.publishedAt ?? '').getTime();
    assert.ok(Number.isFinite(publishedTime));
    assert.ok(publishedTime >= before && publishedTime <= after);
  });

  test('normalizeFeedInput overrides publishedAt for analysis type', () => {
    const before = Date.now();
    const result = normalizeFeedInput({
      type: 'analysis',
      source: 'twitter',
      text: 'Agent analysis',
      published_at: '2020-01-01T00:00:00.000Z',
    });
    const after = Date.now();

    assert.ok(result);
    const publishedTime = new Date(result?.publishedAt ?? '').getTime();
    assert.ok(Number.isFinite(publishedTime));
    assert.ok(publishedTime >= before && publishedTime <= after);
  });
});

describe('feed timestamp persistence and ordering', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-test-'));

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

  test('insertOrIgnoreFeedItem stores text and millisecond timestamp columns', () => {
    const publishedAt = '2026-03-02T12:00:00.000Z';
    const inserted = insertOrIgnoreFeedItem({
      id: 'feed-ts-insert-1',
      type: 'article',
      source: 'unit_test',
      text: 'timestamp persistence check',
      publishedAt,
    });

    assert.strictEqual(inserted, true);

    const row = getDb().prepare(`
      SELECT published_at, published_at_ms, created_at, created_at_ms
      FROM feed
      WHERE id = 'feed-ts-insert-1'
    `).get() as
      | {
          published_at: string;
          published_at_ms: number;
          created_at: string;
          created_at_ms: number;
        }
      | undefined;

    assert.ok(row);
    assert.strictEqual(row?.published_at, publishedAt);
    assert.strictEqual(row?.published_at_ms, Date.parse(publishedAt));
    assert.ok(typeof row?.created_at === 'string' && row.created_at.length > 0);
    assert.ok(typeof row?.created_at_ms === 'number');
  });

  test('normalizeFeedInput reuses a known same-source author avatar when input is missing one', () => {
    const inserted = insertOrIgnoreFeedItem({
      id: 'known-twitter-avatar',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'known-twitter-avatar',
      text: 'Known avatar source row',
      authorUsername: 'evogent_ai',
      authorAvatarUrl: 'https://img.test/evogent-avatar.jpg',
      publishedAt: '2026-03-02T12:00:00.000Z',
    });
    assert.strictEqual(inserted, true);

    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-missing-avatar',
      text: 'Reply row missing avatar',
      author_username: 'evogent_ai',
      author_avatar_url: null,
      relationship: 'reply',
      publishedAt: '2026-03-02T12:05:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result.authorAvatarUrl, 'https://img.test/evogent-avatar.jpg');
  });

  test('normalizeFeedInput preserves an incoming author avatar instead of reusing an older one', () => {
    const inserted = insertOrIgnoreFeedItem({
      id: 'older-twitter-avatar',
      type: 'tweet',
      source: 'twitter',
      sourceId: 'older-twitter-avatar',
      text: 'Older avatar source row',
      authorUsername: 'evogent_ai',
      authorAvatarUrl: 'https://img.test/old-avatar.jpg',
      publishedAt: '2026-03-02T12:00:00.000Z',
    });
    assert.strictEqual(inserted, true);

    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-new-avatar',
      text: 'Reply row with a fresh avatar',
      author_username: 'evogent_ai',
      author_avatar_url: 'https://img.test/newer-avatar.jpg',
      relationship: 'reply',
      publishedAt: '2026-03-02T12:05:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result.authorAvatarUrl, 'https://img.test/newer-avatar.jpg');
  });

  test('normalizeFeedInput does not reuse author avatars across sources', () => {
    const inserted = insertOrIgnoreFeedItem({
      id: 'substack-avatar',
      type: 'article',
      source: 'substack',
      sourceId: 'substack-avatar',
      text: 'Substack avatar source row',
      authorUsername: 'evogent_ai',
      authorAvatarUrl: 'https://img.test/substack-avatar.jpg',
      publishedAt: '2026-03-02T12:00:00.000Z',
    });
    assert.strictEqual(inserted, true);

    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-cross-source-avatar',
      text: 'Reply row missing avatar',
      author_username: 'evogent_ai',
      author_avatar_url: null,
      relationship: 'reply',
      publishedAt: '2026-03-02T12:05:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result.authorAvatarUrl, null);
  });

  test('normalizeFeedInput leaves author avatar empty when no prior row matches', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-no-known-avatar',
      text: 'Reply row missing avatar',
      author_username: 'evogent_ai',
      author_avatar_url: null,
      relationship: 'reply',
      publishedAt: '2026-03-02T12:05:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result.authorAvatarUrl, null);
  });

  test('insertOrIgnoreFeedItem suppresses duplicate active incident suggestions', () => {
    const firstInsert = insertOrIgnoreFeedItem({
      id: 'incident-suggestion-1',
      type: 'suggestion',
      source: 'evogent',
      sourceId: 'suggestion-incident-1',
      text: 'First incident suggestion',
      publishedAt: '2026-03-02T12:00:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        proposedValue: 'Shared browse provider is hanging across multiple sources.',
        suggestionStatus: 'pending',
        incidentKey: 'browse:provider:shared_browser:provider_hung',
      },
    });
    const secondInsert = insertOrIgnoreFeedItem({
      id: 'incident-suggestion-2',
      type: 'suggestion',
      source: 'evogent',
      sourceId: 'suggestion-incident-2',
      text: 'Duplicate incident suggestion',
      publishedAt: '2026-03-02T12:01:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        proposedValue: 'Shared browse provider is hanging across multiple sources.',
        suggestionStatus: 'pending',
        incidentKey: 'browse:provider:shared_browser:provider_hung',
      },
    });

    assert.strictEqual(firstInsert, true);
    assert.strictEqual(secondInsert, false);

    const count = getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM feed
      WHERE json_extract(metadata, '$.incidentKey') = 'browse:provider:shared_browser:provider_hung'
    `).get() as { count: number };

    assert.strictEqual(count.count, 1);
  });

  test('getFeedPage sorts by integer timestamp columns when text formats differ', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('feed-space-newer', 'article', 'unit_test', 'space format newer', ?, ?)
    `).run('2026-03-02 12:00:00', '2026-03-02 12:30:00');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('feed-iso-older', 'article', 'unit_test', 'iso format older', ?, ?)
    `).run('2026-03-02T01:00:00.000Z', '2026-03-02T01:30:00.000Z');

    const publishedPage = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'published',
      search: null,
    });

    const createdPage = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(publishedPage.items.map((item) => item.id), ['feed-space-newer', 'feed-iso-older']);
    assert.deepStrictEqual(createdPage.items.map((item) => item.id), ['feed-space-newer', 'feed-iso-older']);
  });

  test('arrangeFeedDisplay stores curator order and live thread metadata', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, published_at, created_at)
      VALUES
        ('arrange-old', 'article', 'unit_test', 'older article', 'Older', '2026-03-02T08:00:00.000Z', '2026-03-02T08:00:00.000Z'),
        ('arrange-new', 'article', 'unit_test', 'newer article', 'Newer', '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z'),
        ('arrange-middle', 'article', 'unit_test', 'middle article', 'Middle', '2026-03-02T09:00:00.000Z', '2026-03-02T09:00:00.000Z')
    `).run();

    const firstResult = arrangeFeedDisplay({
      ordering: [
        {
          feedItemId: 'arrange-old',
          displayOrder: 1,
          threadId: 'thread-ai',
          displaySubtitle: 'matches the article you opened yesterday',
        },
      ],
      threads: [
        {
          id: 'thread-ai',
          title: 'Your AI tool stack drift this week',
          subtitle: 'Fresh items connected by tool changes',
          active: true,
        },
      ],
    });

    assert.deepStrictEqual(firstResult.updatedItemIds, ['arrange-old']);
    assert.strictEqual(firstResult.activeThreads.length, 1);

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(page.items.map((item) => item.id), ['arrange-old', 'arrange-new', 'arrange-middle']);
    assert.strictEqual(page.items[0]?.displayOrder, 1);
    assert.strictEqual(page.items[0]?.threadId, 'thread-ai');
    assert.strictEqual(page.items[0]?.threadTitle, 'Your AI tool stack drift this week');
    assert.strictEqual(page.items[0]?.threadSubtitle, 'Fresh items connected by tool changes');
    assert.strictEqual(page.items[0]?.displaySubtitle, 'matches the article you opened yesterday');

    arrangeFeedDisplay({
      ordering: [
        {
          feedItemId: 'arrange-new',
          displayOrder: 1,
          threadId: 'thread-current',
          displaySubtitle: 'freshly promoted now',
        },
      ],
      threads: [
        {
          id: 'thread-current',
          title: 'Current curation lane',
          subtitle: null,
          active: true,
        },
      ],
    });

    const refreshedPage = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(refreshedPage.items.map((item) => item.id), ['arrange-new', 'arrange-middle', 'arrange-old']);
    assert.strictEqual(refreshedPage.items[0]?.displayOrder, 1);
    assert.strictEqual(refreshedPage.items[0]?.threadId, 'thread-current');
    assert.strictEqual(refreshedPage.items[0]?.displaySubtitle, 'freshly promoted now');
    assert.strictEqual(refreshedPage.items[2]?.displayOrder, null);
    assert.strictEqual(refreshedPage.items[2]?.threadId, null);
    assert.strictEqual(refreshedPage.items[2]?.displaySubtitle, null);

    arrangeFeedDisplay({ ordering: [], threads: [] });
    assert.deepStrictEqual(getActiveFeedThreads(), []);

    const finalRows = db.prepare(`
      SELECT id, display_order, thread_id, display_subtitle
      FROM feed
      WHERE id IN ('arrange-old', 'arrange-new')
      ORDER BY id ASC
    `).all() as Array<{
      id: string;
      display_order: number | null;
      thread_id: string | null;
      display_subtitle: string | null;
    }>;

    assert.deepStrictEqual(finalRows, [
      { id: 'arrange-new', display_order: null, thread_id: null, display_subtitle: null },
      { id: 'arrange-old', display_order: null, thread_id: null, display_subtitle: null },
    ]);
  });

  test('migrates the retired shared carry-forward lane into stable solos and real multi-item threads', () => {
    const db = getDb();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    db.prepare(`
      INSERT INTO feed_threads (id, title, subtitle, created_at_ms, updated_at_ms, active)
      VALUES ('carry-forward-unread', 'Still worth seeing', NULL, ?, ?, 1)
    `).run(nowMs, nowMs);
    const insert = db.prepare(`
      INSERT INTO feed (
        id, type, source, text, title, metadata, display_order, thread_id,
        parent_id, published_at, created_at
      ) VALUES (?, 'article', 'unit_test', 'Body', ?, ?, ?, 'carry-forward-unread', NULL, ?, ?)
    `);
    insert.run(
      'legacy-solo-a',
      'Legacy solo A',
      JSON.stringify({ thread: { threadId: 'old-topic-a', threadTitle: 'Old topic A' } }),
      1,
      now,
      now,
    );
    insert.run(
      'legacy-solo-b',
      'Legacy solo B',
      JSON.stringify({ thread: { threadId: 'old-topic-b', threadTitle: 'Old topic B' } }),
      2,
      now,
      now,
    );
    for (const [id, order] of [['legacy-pair-a', 3], ['legacy-pair-b', 4]] as const) {
      insert.run(
        id,
        id,
        JSON.stringify({
          thread: {
            threadId: 'recovered-real-thread',
            threadTitle: 'Recovered real thread',
            threadRationale: 'Two real members still ship together.',
          },
        }),
        order,
        now,
        now,
      );
    }

    const input = getCurrentFeedArrangeInput();
    const orderingById = new Map(input.ordering.map((entry) => [entry.feedItemId, entry]));
    const soloAThreadId = getSingletonShipmentThreadId('legacy-solo-a');
    const soloBThreadId = getSingletonShipmentThreadId('legacy-solo-b');
    assert.strictEqual(orderingById.get('legacy-solo-a')?.threadId, soloAThreadId);
    assert.strictEqual(orderingById.get('legacy-solo-b')?.threadId, soloBThreadId);
    assert.notStrictEqual(soloAThreadId, soloBThreadId);
    assert.strictEqual(orderingById.get('legacy-pair-a')?.threadId, 'recovered-real-thread');
    assert.strictEqual(orderingById.get('legacy-pair-b')?.threadId, 'recovered-real-thread');
    assert.deepStrictEqual(input.threads.map((thread) => thread.id), ['recovered-real-thread']);

    arrangeFeedDisplay(input);
    const persisted = db.prepare(`
      SELECT id, thread_id
      FROM feed
      WHERE id LIKE 'legacy-%'
      ORDER BY display_order
    `).all() as Array<{ id: string; thread_id: string | null }>;
    assert.deepStrictEqual(persisted, [
      { id: 'legacy-solo-a', thread_id: soloAThreadId },
      { id: 'legacy-solo-b', thread_id: soloBThreadId },
      { id: 'legacy-pair-a', thread_id: 'recovered-real-thread' },
      { id: 'legacy-pair-b', thread_id: 'recovered-real-thread' },
    ]);
    assert.deepStrictEqual(getActiveFeedThreads().map((thread) => thread.id), ['recovered-real-thread']);

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    assert.strictEqual(page.items.find((item) => item.id === 'legacy-solo-a')?.threadId, null);
    assert.strictEqual(page.items.find((item) => item.id === 'legacy-solo-b')?.threadId, null);
    assert.strictEqual(
      page.items.find((item) => item.id === 'legacy-pair-a')?.threadId,
      'recovered-real-thread',
    );
  });

  test('keeps a threadless small arrangement fresh from its recorded receipt', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, published_at, created_at)
      VALUES
        ('threadless-arranged', 'article', 'unit_test', 'Judged first', 'Judged first', ?, ?),
        ('threadless-newer', 'article', 'unit_test', 'Newer by clock', 'Newer by clock', ?, ?)
    `).run(
      '2026-03-02T08:00:00.000Z',
      '2026-03-02T08:00:00.000Z',
      now,
      now,
    );
    const ordering = [{
      feedItemId: 'threadless-arranged',
      displayOrder: 1,
      threadId: null,
      displaySubtitle: null,
    }];
    const result = arrangeFeedDisplay({ ordering, threads: [] });
    assert.strictEqual(getLastArrangeAtMs(), null);
    assert.strictEqual(
      getCurrentFeedArrangeInput().ordering[0]?.threadId,
      getSingletonShipmentThreadId('threadless-arranged'),
    );

    const beforeReceiptMs = Date.now();
    recordFeedArrangementRun({
      source: 'curator',
      ordering,
      threads: [],
      updatedItemIds: result.updatedItemIds,
    });
    const lastArrangeAtMs = getLastArrangeAtMs();
    assert.ok(lastArrangeAtMs !== null && lastArrangeAtMs >= beforeReceiptMs - 1000);

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    assert.strictEqual(page.items[0]?.id, 'threadless-arranged');
    assert.strictEqual(page.items[0]?.displayOrder, 1);
  });

  test('getFeedPage suppresses stale metadata thread lanes after a live arrange', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, metadata, published_at, created_at)
      VALUES
        ('arranged-current', 'article', 'unit_test', 'current article', 'Current', NULL, '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z'),
        ('archive-old-thread', 'tweet', 'twitter', 'old metadata tweet', 'Old', ?, '2026-03-02T09:00:00.000Z', '2026-03-02T09:00:00.000Z')
    `).run(JSON.stringify({
      thread: {
        threadId: 'old-curator-thread',
        threadTitle: 'Old curator thread',
        threadRationale: 'This was from a previous curation pass.',
      },
    }));

    arrangeFeedDisplay({
      ordering: [
        {
          feedItemId: 'arranged-current',
          displayOrder: 1,
          threadId: 'current-thread',
          displaySubtitle: 'current bridge',
        },
      ],
      threads: [
        {
          id: 'current-thread',
          title: 'Current thread',
          subtitle: 'Current arrangement owns the visible thread lane.',
          active: true,
        },
      ],
    });

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    const archived = page.items.find((entry) => entry.id === 'archive-old-thread');
    assert.ok(archived);
    assert.strictEqual(archived.threadDisplayEnabled, false);
    assert.strictEqual(archived.threadId, null);
    assert.strictEqual(archived.threadTitle, null);
    assert.strictEqual(archived.threadSubtitle, null);
    assert.strictEqual(archived.metadata?.thread?.threadId, 'old-curator-thread');
  });

  test('arrangeFeedDisplay never leaves display metadata on child rows', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, text, title, display_order, thread_id, display_subtitle, published_at, created_at)
      VALUES
        ('arrange-child-parent', 'article', 'unit_test', NULL, 'parent article', 'Parent', NULL, NULL, NULL, '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z'),
        ('arrange-child-row', 'tweet', 'unit_test', 'arrange-child-parent', 'child reply', NULL, 1, 'stale-child-thread', 'stale child note', '2026-03-02T10:01:00.000Z', '2026-03-02T10:01:00.000Z')
    `).run();

    arrangeFeedDisplay({
      ordering: [
        {
          feedItemId: 'arrange-child-row',
          displayOrder: 1,
          threadId: 'bad-child-thread',
          displaySubtitle: 'bad child note',
        },
        {
          feedItemId: 'arrange-child-parent',
          displayOrder: 2,
          threadId: 'arrange-child-thread',
          displaySubtitle: 'parent note',
        },
      ],
      threads: [
        {
          id: 'arrange-child-thread',
          title: 'Parent thread',
          subtitle: null,
          active: true,
        },
      ],
    });

    const rows = db.prepare(`
      SELECT id, display_order, thread_id, display_subtitle
      FROM feed
      WHERE id IN ('arrange-child-parent', 'arrange-child-row')
      ORDER BY id
    `).all() as Array<{ id: string; display_order: number | null; thread_id: string | null; display_subtitle: string | null }>;

    assert.deepStrictEqual(rows, [
      {
        id: 'arrange-child-parent',
        display_order: 2,
        thread_id: 'arrange-child-thread',
        display_subtitle: 'parent note',
      },
      {
        id: 'arrange-child-row',
        display_order: null,
        thread_id: null,
        display_subtitle: null,
      },
    ]);
  });

  test('arrangeFeedBackstopForCycle clears stale child display slots without appending new items', () => {
    const db = getDb();
    const cycleStartMs = Date.now() - (5 * 60 * 1000);
    const beforeMs = cycleStartMs - (10 * 60 * 1000);
    const olderTextIso = new Date(beforeMs).toISOString();
    const cycleTextIso = new Date(cycleStartMs + 1000).toISOString();

    db.prepare(`
      INSERT INTO feed_threads (id, title, subtitle, created_at_ms, updated_at_ms, active)
      VALUES ('backstop-child-slot-thread', 'Existing thread', NULL, ?, ?, 1)
    `).run(beforeMs, beforeMs);

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, display_order, published_at, created_at)
      VALUES
        ('backstop-child-slot-existing', 'article', 'unit_test', 'previously arranged', 'Existing', 5, ?, ?),
        ('backstop-child-slot-new', 'article', 'unit_test', 'this cycle parent', 'Cycle Parent', NULL, ?, ?)
    `).run(olderTextIso, olderTextIso, cycleTextIso, cycleTextIso);
    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, text, title, display_order, thread_id, display_subtitle, published_at, created_at)
      VALUES ('backstop-child-slot-reply', 'tweet', 'unit_test', 'backstop-child-slot-existing', 'child reply', NULL, 99, 'bad-child-thread', 'bad child slot', ?, ?)
    `).run(cycleTextIso, cycleTextIso);

    const outcome = arrangeFeedBackstopForCycle(cycleStartMs);
    assert.strictEqual(outcome.fired, false);
    assert.strictEqual(outcome.itemCount, 0);
    assert.strictEqual(outcome.reason, 'curator_arrangement_authoritative');

    const rows = db.prepare(`
      SELECT id, display_order, thread_id, display_subtitle
      FROM feed
      WHERE id IN ('backstop-child-slot-existing', 'backstop-child-slot-new', 'backstop-child-slot-reply')
      ORDER BY id
    `).all() as Array<{ id: string; display_order: number | null; thread_id: string | null; display_subtitle: string | null }>;

    assert.deepStrictEqual(rows, [
      {
        id: 'backstop-child-slot-existing',
        display_order: 5,
        thread_id: null,
        display_subtitle: null,
      },
      {
        id: 'backstop-child-slot-new',
        display_order: null,
        thread_id: null,
        display_subtitle: null,
      },
      {
        id: 'backstop-child-slot-reply',
        display_order: null,
        thread_id: null,
        display_subtitle: null,
      },
    ]);
  });

  test('arrangeFeedBackstopForCycle leaves new items unarranged after an existing curator order', () => {
    const db = getDb();
    const cycleStartMs = Date.now() - (5 * 60 * 1000);
    const beforeMs = cycleStartMs - (10 * 60 * 1000);
    const olderTextIso = new Date(beforeMs).toISOString();
    const cycleATextIso = new Date(cycleStartMs + 1000).toISOString();
    const cycleBTextIso = new Date(cycleStartMs + 2000).toISOString();

    db.prepare(`
      INSERT INTO feed_threads (id, title, subtitle, created_at_ms, updated_at_ms, active)
      VALUES ('backstop-thread-old', 'Older thread', NULL, ?, ?, 1)
    `).run(beforeMs, beforeMs);

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, display_order, thread_id, published_at, created_at)
      VALUES
        ('backstop-existing', 'article', 'unit_test', 'previously arranged', 'Existing', 5, 'backstop-thread-old', ?, ?),
        ('backstop-cycle-a', 'article', 'unit_test', 'this cycle a', 'Cycle A', NULL, NULL, ?, ?),
        ('backstop-cycle-b', 'article', 'unit_test', 'this cycle b', 'Cycle B', NULL, NULL, ?, ?)
    `).run(olderTextIso, olderTextIso, cycleATextIso, cycleATextIso, cycleBTextIso, cycleBTextIso);

    const outcome = arrangeFeedBackstopForCycle(cycleStartMs);
    assert.strictEqual(outcome.fired, false);
    assert.strictEqual(outcome.itemCount, 0);
    assert.strictEqual(outcome.reason, 'curator_arrangement_authoritative');

    const threadAfter = db.prepare(`
      SELECT updated_at_ms
      FROM feed_threads
      WHERE id = 'backstop-thread-old'
    `).get() as { updated_at_ms: number };
    assert.strictEqual(threadAfter.updated_at_ms, beforeMs);

    const rows = db.prepare(`
      SELECT id, display_order, thread_id
      FROM feed
      WHERE id IN ('backstop-existing', 'backstop-cycle-a', 'backstop-cycle-b')
      ORDER BY id ASC
    `).all() as Array<{ id: string; display_order: number | null; thread_id: string | null }>;

    assert.deepStrictEqual(rows, [
      { id: 'backstop-cycle-a', display_order: null, thread_id: null },
      { id: 'backstop-cycle-b', display_order: null, thread_id: null },
      { id: 'backstop-existing', display_order: 5, thread_id: 'backstop-thread-old' },
    ]);
  });

  test('arrangeFeedBackstopForCycle leaves reflection analysis outside the live arrangement', () => {
    const db = getDb();
    const cycleStartMs = Date.now() - (5 * 60 * 1000);
    const beforeIso = new Date(cycleStartMs - 1000).toISOString();
    const articleIso = new Date(cycleStartMs + 1000).toISOString();
    const reflectionIso = new Date(cycleStartMs + 2000).toISOString();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, display_order, thread_id, published_at, created_at)
      VALUES ('backstop-reflection-existing', 'article', 'unit_test', 'existing arranged', 'Existing', 1, 'backstop-reflection-thread', ?, ?)
    `).run(beforeIso, beforeIso);

    db.prepare(`
      INSERT INTO feed_threads (id, title, subtitle, created_at_ms, updated_at_ms, active)
      VALUES ('backstop-reflection-thread', 'Existing thread', NULL, ?, ?, 1)
    `).run(cycleStartMs, cycleStartMs);

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, metadata, published_at, created_at)
      VALUES
        ('backstop-reflection-article', 'article', 'openclaw', 'cycle article', 'Cycle article', NULL, ?, ?),
        ('backstop-reflection-analysis', 'analysis', 'claude', 'reflection body', 'Reflection: source health', ?, ?, ?)
    `).run(
      articleIso,
      articleIso,
      JSON.stringify({ reflection: { sourceHealth: { primaryIssue: 'none' } } }),
      reflectionIso,
      reflectionIso,
    );

    const outcome = arrangeFeedBackstopForCycle(cycleStartMs);
    assert.strictEqual(outcome.fired, false);
    assert.strictEqual(outcome.itemCount, 0);
    assert.strictEqual(outcome.reason, 'curator_arrangement_authoritative');

    const rows = db.prepare(`
      SELECT id, display_order
      FROM feed
      WHERE id IN ('backstop-reflection-existing', 'backstop-reflection-article', 'backstop-reflection-analysis')
      ORDER BY id ASC
    `).all() as Array<{ id: string; display_order: number | null }>;

    assert.deepStrictEqual(rows, [
      { id: 'backstop-reflection-analysis', display_order: null },
      { id: 'backstop-reflection-article', display_order: null },
      { id: 'backstop-reflection-existing', display_order: 1 },
    ]);
  });

  test('arrangeFeedBackstopForCycle does not promote metadata threads into the live arrangement', () => {
    const db = getDb();
    const cycleStartMs = Date.now() - (5 * 60 * 1000);
    const beforeIso = new Date(cycleStartMs - 1000).toISOString();
    const newIso = new Date(cycleStartMs + 1000).toISOString();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, published_at, created_at)
      VALUES ('backstop-existing-threaded', 'article', 'unit_test', 'existing arranged', 'Existing arranged', ?, ?)
    `).run(beforeIso, beforeIso);

    arrangeFeedDisplay({
      ordering: [
        {
          feedItemId: 'backstop-existing-threaded',
          displayOrder: 1,
          threadId: 'arranged-thread',
          displaySubtitle: 'Curator picked this lane',
        },
      ],
      threads: [
        {
          id: 'arranged-thread',
          title: 'Arranged thread',
          subtitle: 'Curator-owned lane',
          active: true,
        },
      ],
    });

    db.prepare(`
      INSERT INTO feed (
        id, type, source, text, title, display_order, thread_id, metadata, published_at, created_at
      )
      VALUES
        ('backstop-metadata-thread', 'article', 'openclaw', 'new card', 'New metadata thread', NULL, NULL, ?, ?, ?)
    `).run(
      JSON.stringify({
        thread: {
          threadId: 'metadata-only-thread',
          threadTitle: 'Metadata-only thread',
          threadRationale: 'Should not become a live lane',
        },
      }),
      newIso,
      newIso,
    );

    const outcome = arrangeFeedBackstopForCycle(cycleStartMs);
    assert.strictEqual(outcome.fired, false);
    assert.strictEqual(outcome.itemCount, 0);
    assert.strictEqual(outcome.reason, 'curator_arrangement_authoritative');

    const row = db.prepare(`
      SELECT display_order, thread_id
      FROM feed
      WHERE id = 'backstop-metadata-thread'
    `).get() as { display_order: number | null; thread_id: string | null };
    assert.strictEqual(row.display_order, null);
    assert.strictEqual(row.thread_id, null);

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    const newItem = page.items.find((item) => item.id === 'backstop-metadata-thread');
    assert.ok(newItem);
    assert.strictEqual(newItem.displayOrder, null);
    assert.strictEqual(newItem.threadId, null);
    assert.strictEqual(newItem.threadTitle, null);
  });

  test('arrangeFeedBackstopForCycle is a no-op when curator already arranged during the cycle', () => {
    const db = getDb();
    const cycleStartMs = Date.now() - (5 * 60 * 1000);
    const cycleATextIso = new Date(cycleStartMs + 500).toISOString();
    const cycleBTextIso = new Date(cycleStartMs + 1000).toISOString();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, display_order, published_at, created_at)
      VALUES
        ('backstop-arranged-a', 'article', 'unit_test', 'cycle a', 'Cycle A', NULL, ?, ?),
        ('backstop-arranged-left-out', 'article', 'unit_test', 'cycle b', 'Cycle B', NULL, ?, ?)
    `).run(cycleATextIso, cycleATextIso, cycleBTextIso, cycleBTextIso);

    const ordering = [
      {
        feedItemId: 'backstop-arranged-a',
        displayOrder: 7,
        threadId: 'backstop-arranged-thread',
        displaySubtitle: null,
      },
    ];
    const threads = [
      {
        id: 'backstop-arranged-thread',
        title: 'Test thread that just got arranged',
        subtitle: null,
        active: true,
      },
    ];
    const result = arrangeFeedDisplay({ ordering, threads });
    recordFeedArrangementRun({
      source: 'curator',
      ordering,
      threads,
      updatedItemIds: result.updatedItemIds,
    });

    const outcome = arrangeFeedBackstopForCycle(cycleStartMs);
    assert.strictEqual(outcome.fired, false);
    assert.strictEqual(outcome.reason, 'curator_arrangement_authoritative');

    const rowsAfter = db.prepare(`
      SELECT id, display_order, thread_id
      FROM feed
      WHERE id IN ('backstop-arranged-a', 'backstop-arranged-left-out')
      ORDER BY id
    `).all() as Array<{ id: string; display_order: number | null; thread_id: string | null }>;
    assert.deepStrictEqual(rowsAfter, [
      { id: 'backstop-arranged-a', display_order: 7, thread_id: 'backstop-arranged-thread' },
      { id: 'backstop-arranged-left-out', display_order: null, thread_id: null },
    ]);
  });

  test('arrangeFeedBackstopForCycle preserves arranged rows inside a rolling lookback', () => {
    const db = getDb();
    const cycleStartMs = Date.now() - (30 * 60 * 1000);
    const olderIso = new Date(cycleStartMs - 1000).toISOString();
    const recentArrangedMs = cycleStartMs + 1000;
    const recentArrangedIso = new Date(recentArrangedMs).toISOString();
    const recentUnarrangedIso = new Date(cycleStartMs + 2000).toISOString();

    db.prepare(`
      INSERT INTO feed_threads (id, title, subtitle, created_at_ms, updated_at_ms, active)
      VALUES
        ('thread-old', 'Old thread', NULL, ?, ?, 1),
        ('thread-recent', 'Recent thread', NULL, ?, ?, 1)
    `).run(cycleStartMs, cycleStartMs, recentArrangedMs, recentArrangedMs);

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, display_order, thread_id, published_at, created_at)
      VALUES
        ('backstop-rolling-old', 'article', 'unit_test', 'old arranged', 'Old arranged', 10, 'thread-old', ?, ?),
        ('backstop-rolling-arranged', 'article', 'unit_test', 'recent arranged', 'Recent arranged', 11, 'thread-recent', ?, ?),
        ('backstop-rolling-new', 'article', 'unit_test', 'recent new', 'Recent new', NULL, NULL, ?, ?)
    `).run(
      olderIso,
      olderIso,
      recentArrangedIso,
      recentArrangedIso,
      recentUnarrangedIso,
      recentUnarrangedIso,
    );

    const outcome = arrangeFeedBackstopForCycle(cycleStartMs);
    assert.strictEqual(outcome.fired, false);
    assert.strictEqual(outcome.itemCount, 0);
    assert.strictEqual(outcome.reason, 'curator_arrangement_authoritative');

    const rows = db.prepare(`
      SELECT id, display_order, thread_id
      FROM feed
      WHERE id IN ('backstop-rolling-old', 'backstop-rolling-arranged', 'backstop-rolling-new')
      ORDER BY id ASC
    `).all() as Array<{ id: string; display_order: number | null; thread_id: string | null }>;

    assert.deepStrictEqual(rows, [
      { id: 'backstop-rolling-arranged', display_order: 11, thread_id: 'thread-recent' },
      { id: 'backstop-rolling-new', display_order: null, thread_id: null },
      { id: 'backstop-rolling-old', display_order: 10, thread_id: 'thread-old' },
    ]);
  });

  test('getFeedPage keeps persisted display order authoritative without wall-clock expiry', () => {
    const db = getDb();
    const staleArrangeAtMs = Date.now() - (13 * 60 * 60 * 1000);

    db.prepare(`
      INSERT INTO feed_threads (id, title, subtitle, created_at_ms, updated_at_ms, active)
      VALUES ('stale-thread', 'Stale thread', NULL, ?, ?, 1)
    `).run(staleArrangeAtMs, staleArrangeAtMs);

    db.prepare(`
      INSERT INTO feed (id, type, source, text, title, display_order, published_at, created_at)
      VALUES
        ('stale-pinned', 'article', 'unit_test', 'older pinned article', 'Older pinned', 1, '2026-03-02T08:00:00.000Z', '2026-03-02T08:00:00.000Z'),
        ('stale-new', 'article', 'unit_test', 'newer article', 'Newer', NULL, '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z')
    `).run();

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.strictEqual(getLastArrangeAtMs(), staleArrangeAtMs);
    assert.deepStrictEqual(page.items.map((item) => item.id), ['stale-pinned', 'stale-new']);
    assert.strictEqual(page.items.find((item) => item.id === 'stale-pinned')?.displayOrder, 1);
  });

  test('getFeedPage excludes items with persisted dislikes', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('kept-item', 'article', 'unit_test', 'kept article', ?, ?)
    `).run('2026-03-02T12:00:00.000Z', '2026-03-02T12:00:00.000Z');
    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('disliked-item', 'article', 'unit_test', 'disliked article', ?, ?)
    `).run('2026-03-02T13:00:00.000Z', '2026-03-02T13:00:00.000Z');
    db.prepare(`
      INSERT INTO interactions (feed_item_id, action)
      VALUES ('disliked-item', 'dislike')
    `).run();

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(page.items.map((item) => item.id), ['kept-item']);
    assert.strictEqual(page.total, 1);
  });

  test('getFeedPage includes child suggestions while still excluding child articles', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('batch-parent', 'analysis', 'claude', 'parent audit', ?, ?)
    `).run('2026-03-02T12:00:00.000Z', '2026-03-02T12:00:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, relationship, title, text, metadata, published_at, created_at)
      VALUES ('batch-suggestion-a', 'suggestion', 'claude', 'batch-parent', 'child', 'Fix A', 'suggestion A', ?, ?, ?)
    `).run(
      JSON.stringify({ suggestionType: 'code_fix', proposedValue: 'Fix issue A.' }),
      '2026-03-02T11:59:00.000Z',
      '2026-03-02T11:59:00.000Z',
    );

    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, relationship, title, text, metadata, published_at, created_at)
      VALUES ('batch-suggestion-b', 'suggestion', 'claude', 'batch-parent', 'child', 'Fix B', 'suggestion B', ?, ?, ?)
    `).run(
      JSON.stringify({ suggestionType: 'code_fix', proposedValue: 'Fix issue B.' }),
      '2026-03-02T11:58:00.000Z',
      '2026-03-02T11:58:00.000Z',
    );

    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, relationship, title, text, published_at, created_at)
      VALUES ('hidden-child-article', 'article', 'bbc', 'batch-parent', 'related', 'Hidden', 'hidden child', ?, ?)
    `).run('2026-03-02T11:57:00.000Z', '2026-03-02T11:57:00.000Z');

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    const hydratedPage = hydrateFeedItemsForList(page.items);

    assert.ok(page.items.some((item) => item.id === 'batch-parent'));
    assert.ok(page.items.some((item) => item.id === 'batch-suggestion-a'));
    assert.ok(page.items.some((item) => item.id === 'batch-suggestion-b'));
    assert.ok(!page.items.some((item) => item.id === 'hidden-child-article'));

    const hydratedParent = hydratedPage.find((item) => item.id === 'batch-parent');
    assert.ok(hydratedParent);
    assert.deepStrictEqual(
      hydratedParent?.suggestionChildren?.map((item) => item.id),
      ['batch-suggestion-a', 'batch-suggestion-b'],
    );
  });

  test('hydrateFeedItemsForList preserves existing suggestion parent context when the child points elsewhere', () => {
    const unrelatedParent = {
      id: 'actual-parent',
      type: 'analysis',
      source: 'claude',
      sourceId: 'actual-parent',
      parentId: null,
      relationship: null,
      title: 'Actual parent',
      text: 'Actual parent context',
      url: null,
      excerpt: null,
      authorUsername: null,
      authorDisplayName: null,
      reason: null,
      tags: [],
      mediaUrls: [],
      metrics: { likes: 0, reposts: 0, replies: 0 },
      authorAvatarUrl: null,
      isLiked: false,
      isDisliked: false,
      parentItem: null,
      children: [],
      childrenCount: 0,
      suggestionChildren: [],
      metadata: null,
      publishedAt: '2026-03-02T12:01:00.000Z',
      createdAt: '2026-03-02T12:01:00.000Z',
    };

    const hydrated = hydrateFeedItemsForList([{
      id: 'list-parent',
      type: 'analysis',
      source: 'claude',
      sourceId: 'list-parent',
      parentId: null,
      relationship: null,
      title: 'List parent',
      text: 'List parent context',
      url: null,
      excerpt: null,
      authorUsername: null,
      authorDisplayName: null,
      reason: null,
      tags: [],
      mediaUrls: [],
      metrics: { likes: 0, reposts: 0, replies: 0 },
      authorAvatarUrl: null,
      isLiked: false,
      isDisliked: false,
      parentItem: null,
      children: [],
      childrenCount: 0,
      suggestionChildren: [{
        id: 'suggestion-child',
        type: 'suggestion',
        source: 'claude',
        sourceId: 'suggestion-child',
        parentId: unrelatedParent.id,
        relationship: 'child',
        title: 'Fix something else',
        text: 'Suggestion body',
        url: null,
        excerpt: null,
        authorUsername: null,
        authorDisplayName: null,
        reason: null,
        tags: [],
        mediaUrls: [],
        metrics: { likes: 0, reposts: 0, replies: 0 },
        authorAvatarUrl: null,
        isLiked: false,
        isDisliked: false,
        parentItem: unrelatedParent,
        children: [],
        childrenCount: 0,
        suggestionChildren: [],
        metadata: { suggestionType: 'code_fix', proposedValue: 'Keep the actual parent.' },
        publishedAt: '2026-03-02T12:02:00.000Z',
        createdAt: '2026-03-02T12:02:00.000Z',
      }],
      metadata: null,
      publishedAt: '2026-03-02T12:00:00.000Z',
      createdAt: '2026-03-02T12:00:00.000Z',
    }]);

    assert.strictEqual(
      hydrated[0]?.suggestionChildren?.[0]?.parentItem?.id,
      unrelatedParent.id,
    );
  });

  test('getFeedPage sorts suggestions and notifications naturally by timestamp', () => {
    const db = getDb();

    for (let index = 1; index <= 7; index += 1) {
      const minute = String(31 - index).padStart(2, '0');
      const timestamp = `2026-03-02T12:${minute}:00.000Z`;
      db.prepare(`
        INSERT INTO feed (id, type, source, text, published_at, created_at)
        VALUES (?, 'suggestion', 'claude', ?, ?, ?)
      `).run(`suggestion-${index}`, `pending suggestion ${index}`, timestamp, timestamp);
    }

    for (let index = 1; index <= 6; index += 1) {
      const minute = String(24 - index).padStart(2, '0');
      const timestamp = `2026-03-02T12:${minute}:00.000Z`;
      db.prepare(`
        INSERT INTO feed (id, type, source, text, published_at, created_at)
        VALUES (?, 'notification', 'system', ?, ?, ?)
      `).run(`notification-${index}`, `notification ${index}`, timestamp, timestamp);
    }

    db.prepare(`
      INSERT INTO interactions (feed_item_id, action)
      VALUES ('notification-1', 'suggestion_dismissed')
    `).run();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('content-newer', 'article', 'unit_test', 'newer content', ?, ?)
    `).run('2026-03-02T12:24:30.000Z', '2026-03-02T12:24:30.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('content-older', 'article', 'unit_test', 'older content', ?, ?)
    `).run('2026-03-02T12:17:30.000Z', '2026-03-02T12:17:30.000Z');

    const page = getFeedPage({
      offset: 0,
      limit: 20,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(page.items.map((item) => item.id), [
      'suggestion-1',
      'suggestion-2',
      'suggestion-3',
      'suggestion-4',
      'suggestion-5',
      'suggestion-6',
      'content-newer',
      'suggestion-7',
      'notification-2',
      'notification-3',
      'notification-4',
      'notification-5',
      'notification-6',
      'content-older',
    ]);
  });

  test('getFeedPage honors the exact page boundary when a thread id appears later', () => {
    const db = getDb();
    const threadMetadata = JSON.stringify({
      cycleId: 'cycle-1',
      thread: {
        threadId: 'thread-1',
        threadTitle: 'Thread title',
      },
    });

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('page-lead', 'article', 'unit_test', 'lead item', ?, ?)
    `).run('2026-03-02T12:05:00.000Z', '2026-03-02T12:05:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('thread-member-1', 'tweet', 'twitter', 'thread member 1', ?, ?, ?)
    `).run(
      threadMetadata,
      '2026-03-02T12:04:00.000Z',
      '2026-03-02T12:04:00.000Z',
    );

    for (const [index, minute] of ['03', '02'].entries()) {
      db.prepare(`
        INSERT INTO feed (id, type, source, text, published_at, created_at)
        VALUES (?, 'article', 'unit_test', ?, ?, ?)
      `).run(
        `interleaved-item-${index + 1}`,
        `interleaved item ${index + 1}`,
        `2026-03-02T12:${minute}:00.000Z`,
        `2026-03-02T12:${minute}:00.000Z`,
      );
    }

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('thread-member-2', 'tweet', 'twitter', 'thread member 2', ?, ?, ?)
    `).run(
      threadMetadata,
      '2026-03-02T12:01:00.000Z',
      '2026-03-02T12:01:00.000Z',
    );

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('page-tail', 'article', 'unit_test', 'tail item', ?, ?)
    `).run('2026-03-02T12:00:00.000Z', '2026-03-02T12:00:00.000Z');

    const firstPage = getFeedPage({
      offset: 0,
      limit: 4,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    const secondPage = getFeedPage({
      offset: firstPage.items.length,
      limit: 3,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(firstPage.items.map((item) => item.id), [
      'page-lead',
      'thread-member-1',
      'interleaved-item-1',
      'interleaved-item-2',
    ]);
    assert.deepStrictEqual(secondPage.items.map((item) => item.id), [
      'thread-member-2',
      'page-tail',
    ]);
  });

  test('getFeedPage minimally extends a boundary through one contiguous arranged thread', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES
        ('contiguous-lead', 'article', 'unit_test', 'lead', '2026-03-02T12:04:00.000Z', '2026-03-02T12:04:00.000Z'),
        ('contiguous-thread-1', 'article', 'unit_test', 'thread 1', '2026-03-02T12:03:00.000Z', '2026-03-02T12:03:00.000Z'),
        ('contiguous-thread-2', 'article', 'unit_test', 'thread 2', '2026-03-02T12:02:00.000Z', '2026-03-02T12:02:00.000Z'),
        ('contiguous-tail', 'article', 'unit_test', 'tail', '2026-03-02T12:01:00.000Z', '2026-03-02T12:01:00.000Z')
    `).run();
    arrangeFeedDisplay({
      ordering: [
        { feedItemId: 'contiguous-lead', displayOrder: 1 },
        { feedItemId: 'contiguous-thread-1', displayOrder: 2, threadId: 'contiguous-thread' },
        { feedItemId: 'contiguous-thread-2', displayOrder: 3, threadId: 'contiguous-thread' },
        { feedItemId: 'contiguous-tail', displayOrder: 4 },
      ],
      threads: [{
        id: 'contiguous-thread',
        title: 'One contiguous arranged thread',
        active: true,
      }],
    });

    const firstPage = getFeedPage({
      offset: 0,
      limit: 2,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    assert.deepStrictEqual(firstPage.items.map((item) => item.id), [
      'contiguous-lead',
      'contiguous-thread-1',
      'contiguous-thread-2',
    ]);
    assert.strictEqual(firstPage.hasMore, true);

    const secondPage = getFeedPage({
      offset: firstPage.items.length,
      limit: 2,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    assert.deepStrictEqual(secondPage.items.map((item) => item.id), ['contiguous-tail']);
    assert.strictEqual(secondPage.hasMore, false);
  });

  test('getFeedPage does not scan past the requested limit for repeated thread ids', () => {
    const db = getDb();
    const metadataForThread = (threadId: string) => JSON.stringify({
      cycleId: 'cycle-cascade',
      thread: {
        threadId,
        threadTitle: threadId,
      },
    });

    const rows: Array<[string, string, string]> = [
      ['cascade-a-1', 'thread-a', '2026-03-02T12:06:00.000Z'],
      ['cascade-b-1', 'thread-b', '2026-03-02T12:05:00.000Z'],
      ['cascade-a-2', 'thread-a', '2026-03-02T12:04:00.000Z'],
      ['cascade-c-1', 'thread-c', '2026-03-02T12:03:00.000Z'],
      ['cascade-b-2', 'thread-b', '2026-03-02T12:02:00.000Z'],
      ['cascade-c-2', 'thread-c', '2026-03-02T12:01:00.000Z'],
    ];

    for (const [id, threadId, timestamp] of rows) {
      db.prepare(`
        INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
        VALUES (?, 'tweet', 'twitter', ?, ?, ?, ?)
      `).run(id, id, metadataForThread(threadId), timestamp, timestamp);
    }

    const firstPage = getFeedPage({
      offset: 0,
      limit: 2,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(firstPage.items.map((item) => item.id), [
      'cascade-a-1',
      'cascade-b-1',
    ]);
    assert.strictEqual(firstPage.hasMore, true);
  });

  test('getFeedPage leaves distant repeated thread ids outside the exact page limit', () => {
    const db = getDb();
    const threadMetadata = JSON.stringify({
      cycleId: 'cycle-distant',
      thread: {
        threadId: 'thread-distant',
        threadTitle: 'Thread distant',
      },
    });
    const baseMs = Date.parse('2026-03-02T13:00:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('distant-thread-top', 'tweet', 'twitter', 'top thread item', ?, ?, ?)
    `).run(threadMetadata, new Date(baseMs).toISOString(), new Date(baseMs).toISOString());

    for (let index = 0; index < 45; index += 1) {
      const timestamp = new Date(baseMs - ((index + 1) * 1000)).toISOString();
      db.prepare(`
        INSERT INTO feed (id, type, source, text, published_at, created_at)
        VALUES (?, 'article', 'unit_test', ?, ?, ?)
      `).run(`distant-filler-${index}`, `filler ${index}`, timestamp, timestamp);
    }

    const repeatedTimestamp = new Date(baseMs - (46 * 1000)).toISOString();
    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('distant-thread-repeat', 'tweet', 'twitter', 'distant repeat', ?, ?, ?)
    `).run(threadMetadata, repeatedTimestamp, repeatedTimestamp);

    const firstPage = getFeedPage({
      offset: 0,
      limit: 1,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(firstPage.items.map((item) => item.id), ['distant-thread-top']);
    assert.strictEqual(firstPage.hasMore, true);
  });

  test('getFeedPage filters flat thread metadata without resurrecting stale thread chrome', () => {
    const db = getDb();
    const flatThreadMetadata = JSON.stringify({
      threadId: 'flat-thread-1',
      threadTitle: 'Flat thread title',
      threadRationale: 'Flat thread rationale',
      bridge: 'Why this belongs here',
    });

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('flat-page-lead', 'article', 'unit_test', 'lead item', ?, ?)
    `).run('2026-03-02T12:05:00.000Z', '2026-03-02T12:05:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('flat-thread-member-1', 'tweet', 'twitter', 'thread member 1', ?, ?, ?)
    `).run(flatThreadMetadata, '2026-03-02T12:04:00.000Z', '2026-03-02T12:04:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('flat-interleaved', 'article', 'unit_test', 'interleaved item', ?, ?)
    `).run('2026-03-02T12:03:00.000Z', '2026-03-02T12:03:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('flat-thread-member-2', 'tweet', 'twitter', 'thread member 2', ?, ?, ?)
    `).run(flatThreadMetadata, '2026-03-02T12:02:00.000Z', '2026-03-02T12:02:00.000Z');

    const firstPage = getFeedPage({
      offset: 0,
      limit: 3,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });
    assert.deepStrictEqual(firstPage.items.map((item) => item.id), [
      'flat-page-lead',
      'flat-thread-member-1',
      'flat-interleaved',
    ]);
    assert.strictEqual(firstPage.items[1]?.metadata?.thread?.threadId, 'flat-thread-1');
    assert.strictEqual(firstPage.items[1]?.threadDisplayEnabled, false);
    assert.strictEqual(firstPage.items[1]?.threadId, null);
    assert.strictEqual(firstPage.items[1]?.threadTitle, null);
    assert.strictEqual(firstPage.items[1]?.threadSubtitle, null);
    assert.strictEqual(firstPage.items[1]?.displaySubtitle, 'Why this belongs here');

    const filteredPage = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
      threadId: 'flat-thread-1',
    });
    assert.deepStrictEqual(filteredPage.items.map((item) => item.id), ['flat-thread-member-1', 'flat-thread-member-2']);
    assert.ok(filteredPage.items.every((item) => item.metadata?.thread?.threadId === 'flat-thread-1'));
  });

  test('getFeedPage accepts comma-separated thread filters', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, text, thread_id, published_at, created_at)
      VALUES
        ('multi-thread-a', 'article', 'unit_test', 'first matched thread', 'thread-a', ?, ?),
        ('multi-thread-b', 'article', 'unit_test', 'second matched thread', 'thread-b', ?, ?),
        ('multi-thread-c', 'article', 'unit_test', 'unmatched thread', 'thread-c', ?, ?)
    `).run(
      '2026-03-02T12:01:00.000Z',
      '2026-03-02T12:01:00.000Z',
      '2026-03-02T12:02:00.000Z',
      '2026-03-02T12:02:00.000Z',
      '2026-03-02T12:03:00.000Z',
      '2026-03-02T12:03:00.000Z',
    );

    const page = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
      threadId: 'thread-a, thread-b',
    });

    assert.deepStrictEqual(page.items.map((item) => item.id), ['multi-thread-b', 'multi-thread-a']);
  });

  test('getFeedPage honors the exact limit when flat thread ids recur across curation days', () => {
    const db = getDb();
    const threadMetadata = JSON.stringify({
      threadId: 'one-offs',
      threadTitle: 'One-offs',
      threadRationale: 'Strong items outside today\u2019s lanes.',
      bridge: 'Why this current item belongs here',
    });
    const olderThreadMetadata = JSON.stringify({
      threadId: 'one-offs',
      threadTitle: 'One-offs',
      threadRationale: "Strong items outside today's lanes.",
      bridge: 'Why this older item belonged there',
    });

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('current-thread-member-1', 'tweet', 'twitter', 'current thread member 1', ?, ?, ?)
    `).run(threadMetadata, '2026-03-02T12:05:00.000Z', '2026-03-02T12:05:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, published_at, created_at)
      VALUES ('current-interleaved', 'article', 'unit_test', 'current interleaved item', ?, ?)
    `).run('2026-03-02T12:04:00.000Z', '2026-03-02T12:04:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('current-thread-member-2', 'tweet', 'twitter', 'current thread member 2', ?, ?, ?)
    `).run(threadMetadata, '2026-03-02T12:03:00.000Z', '2026-03-02T12:03:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('older-thread-member-1', 'tweet', 'twitter', 'older thread member 1', ?, ?, ?)
    `).run(olderThreadMetadata, '2026-03-01T12:02:00.000Z', '2026-03-01T12:02:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, published_at, created_at)
      VALUES ('older-thread-member-2', 'tweet', 'twitter', 'older thread member 2', ?, ?, ?)
    `).run(olderThreadMetadata, '2026-03-01T12:01:00.000Z', '2026-03-01T12:01:00.000Z');

    const firstPage = getFeedPage({
      offset: 0,
      limit: 2,
      types: [],
      sources: [],
      sort: 'created',
      search: null,
    });

    assert.deepStrictEqual(firstPage.items.map((item) => item.id), [
      'current-thread-member-1',
      'current-interleaved',
    ]);
  });

  test('getPendingFeedCounts returns pending suggestions and active notifications only', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, origin_session_id, published_at, created_at)
      VALUES
        ('suggestion-pending', 'suggestion', 'claude', 'pending suggestion', '{"suggestionStatus":"pending"}', NULL, ?, ?),
        ('suggestion-session', 'suggestion', 'claude', 'session suggestion', '{"suggestionStatus":"pending"}', 'session-123', ?, ?),
        ('suggestion-running', 'suggestion', 'claude', 'running suggestion', '{"suggestionStatus":"running"}', NULL, ?, ?),
        ('suggestion-accepted', 'suggestion', 'claude', 'accepted suggestion', '{"suggestionStatus":"pending"}', 'session-accepted', ?, ?),
        ('suggestion-dismissed', 'suggestion', 'claude', 'dismissed suggestion', '{"suggestionStatus":"pending"}', 'session-dismissed', ?, ?),
        ('notification-active', 'notification', 'system', 'active notification', '{"notificationId":"active"}', NULL, ?, ?),
        ('notification-expired', 'notification', 'system', 'expired notification', '{"notificationId":"expired","expiresAt":"2026-03-02T11:59:00.000Z"}', NULL, ?, ?)
    `).run(
      '2026-03-02T12:00:00.000Z',
      '2026-03-02T12:00:00.000Z',
      '2026-03-02T12:00:30.000Z',
      '2026-03-02T12:00:30.000Z',
      '2026-03-02T12:01:00.000Z',
      '2026-03-02T12:01:00.000Z',
      '2026-03-02T12:01:30.000Z',
      '2026-03-02T12:01:30.000Z',
      '2026-03-02T12:01:45.000Z',
      '2026-03-02T12:01:45.000Z',
      '2026-03-02T12:02:00.000Z',
      '2026-03-02T12:02:00.000Z',
      '2026-03-02T11:59:00.000Z',
      '2026-03-02T11:59:00.000Z',
    );

    db.prepare(`
      INSERT INTO interactions (feed_item_id, action)
      VALUES
        ('notification-active', 'suggestion_dismissed'),
        ('suggestion-accepted', 'suggestion_accepted'),
        ('suggestion-dismissed', 'suggestion_dismissed')
    `).run();

    const counts = getPendingFeedCounts();

    assert.deepStrictEqual(counts, {
      tweet: 0,
      article: 0,
      analysis: 0,
      suggestion: 2,
      notification: 0,
    });
  });

  test('getFeedPage search includes stored child/detail rows', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, title, text, published_at, created_at)
      VALUES ('search-parent', 'article', 'unit_test', 'Parent article', 'Top-level summary', ?, ?)
    `).run('2026-03-02T12:00:00.000Z', '2026-03-02T12:00:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, relationship, title, text, published_at, created_at)
      VALUES ('search-child-analysis', 'analysis', 'claude', 'search-parent', 'analysis', 'Deep dive', 'Orbital mechanics breakdown', ?, ?)
    `).run('2026-03-02T12:05:00.000Z', '2026-03-02T12:05:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, relationship, title, text, published_at, created_at)
      VALUES ('search-child-reply', 'tweet', 'twitter', 'search-parent', 'reply', 'Crew reply', 'Secondary launch window notes', ?, ?)
    `).run('2026-03-02T12:03:00.000Z', '2026-03-02T12:03:00.000Z');

    const searchPage = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: 'orbital window',
    });

    assert.deepStrictEqual(
      searchPage.items.map((item) => item.id),
      ['search-child-analysis', 'search-child-reply'],
    );
  });

  test('getFeedPage search does not match alphanumeric tokens inside longer words', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, title, text, published_at, created_at)
      VALUES ('search-rust', 'article', 'unit_test', 'Rust editions', 'Rust editions keep upgrades compatible', ?, ?)
    `).run('2026-03-02T12:02:00.000Z', '2026-03-02T12:02:00.000Z');

    db.prepare(`
      INSERT INTO feed (id, type, source, title, text, metadata, published_at, created_at)
      VALUES ('search-trust', 'article', 'unit_test', 'Mutual trust', 'A workflow needs mutual trust before delegation', ?, ?, ?)
    `).run(
      JSON.stringify({
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-search-rust-editions',
        },
      }),
      '2026-03-02T12:01:00.000Z',
      '2026-03-02T12:01:00.000Z',
    );

    const searchPage = getFeedPage({
      offset: 0,
      limit: 10,
      types: [],
      sources: [],
      sort: 'created',
      search: 'rust',
    });

    assert.deepStrictEqual(searchPage.items.map((item) => item.id), ['search-rust']);
  });

  test('findTweetFeedItemByIdentifier prefers the latest matching row by created_at_ms', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, url, text, published_at, created_at)
      VALUES ('tweet-match-older', 'tweet', 'twitter', 'tweet-match-older', ?, 'older tweet', ?, ?)
    `).run(
      'https://x.com/alice/status/123',
      '2026-03-02T01:00:00.000Z',
      '2026-03-02T01:30:00.000Z',
    );

    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, url, text, published_at, created_at)
      VALUES ('tweet-match-newer', 'tweet', 'twitter', 'tweet-match-newer', ?, 'newer tweet', ?, ?)
    `).run(
      'https://x.com/alice/status/123',
      '2026-03-02 12:00:00',
      '2026-03-02 12:30:00',
    );

    const match = findTweetFeedItemByIdentifier('123');

    assert.strictEqual(match?.id, 'tweet-match-newer');
  });

  test('getFeedItemBySourceId matches legacy and canonical article source-id variants in both directions', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, url, text, published_at, created_at)
      VALUES ('article-legacy', 'article', 'substack', ?, ?, 'legacy article', ?, ?)
    `).run(
      'journal.example.com:/p/synthetic-essay',
      'https://journal.example.com/p/synthetic-essay',
      '2026-03-02T01:00:00.000Z',
      '2026-03-02T01:30:00.000Z',
    );

    const byCanonical = getFeedItemBySourceId('https://journal.example.com/p/synthetic-essay');
    const byLegacy = getFeedItemBySourceId('journal.example.com:/p/synthetic-essay');

    assert.strictEqual(byCanonical?.id, 'article-legacy');
    assert.strictEqual(byLegacy?.id, 'article-legacy');
  });

  test('insertOrIgnoreFeedItem stores canonical article source ids for legacy newsletter inputs', () => {
    const inserted = insertOrIgnoreFeedItem({
      id: 'article-canonicalized',
      type: 'article',
      source: 'substack',
      sourceId: 'journal.example.com:/p/synthetic-essay',
      url: 'https://journal.example.com/p/synthetic-essay',
      text: 'canonical article',
      publishedAt: '2026-03-02T01:00:00.000Z',
    });

    assert.strictEqual(inserted, true);

    const row = getDb().prepare(`
      SELECT source_id AS sourceId
      FROM feed
      WHERE id = 'article-canonicalized'
    `).get() as { sourceId: string } | undefined;

    assert.strictEqual(row?.sourceId, 'https://journal.example.com/p/synthetic-essay');
  });

  test('getFeedChildren sorts by integer timestamp columns for mixed text formats', () => {
    const db = getDb();

    insertOrIgnoreFeedItem({
      id: 'feed-parent-1',
      type: 'article',
      source: 'unit_test',
      text: 'parent row',
      publishedAt: '2026-03-02T00:00:00.000Z',
    });

    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, relationship, text, published_at, created_at)
      VALUES ('child-space-later', 'tweet', 'twitter', 'feed-parent-1', 'child', 'space child', ?, ?)
    `).run('2026-03-02 12:00:00', '2026-03-02 12:05:00');

    db.prepare(`
      INSERT INTO feed (id, type, source, parent_id, relationship, text, published_at, created_at)
      VALUES ('child-iso-earlier', 'tweet', 'twitter', 'feed-parent-1', 'child', 'iso child', ?, ?)
    `).run('2026-03-02T01:00:00.000Z', '2026-03-02T01:05:00.000Z');

    const children = getFeedChildren('feed-parent-1');

    assert.deepStrictEqual(children.map((child) => child.id), ['child-iso-earlier', 'child-space-later']);
  });

  test('hydrateFeedItemsForList treats active code-fix task rows as non-actionable', () => {
    const db = getDb();

    const inserted = insertOrIgnoreFeedItem({
      id: 'code-fix-active-family-suggestion',
      type: 'suggestion',
      source: 'unit_test',
      text: 'Fix active family status drift.',
      publishedAt: '2026-04-28T12:00:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        suggestionStatus: 'pending',
        taskId: 'fix-active-family-status-1777374311131',
        codeFixTaskFamily: 'fix-active-family-status-1777374311131',
      },
    });
    assert.strictEqual(inserted, true);

    db.prepare(`
      INSERT INTO code_fix_tasks (suggestion_id, task_id, status, phase)
      VALUES ('code-fix-active-family-suggestion', 'fix-active-family-status-1777374311131', 'running', 'agent_execution')
    `).run();

    const item = getFeedItemById('code-fix-active-family-suggestion');
    assert.ok(item);
    assert.strictEqual(item.suggestionStatus, 'pending');

    const hydrated = hydrateFeedItemsForList([item]);
    assert.strictEqual(hydrated[0]?.suggestionStatus, 'running');
  });

  test('hydrateFeedItemsForList keeps merged code-fix retries non-actionable over stale active rows', () => {
    const db = getDb();

    const inserted = insertOrIgnoreFeedItem({
      id: 'code-fix-merged-retry-suggestion',
      type: 'suggestion',
      source: 'unit_test',
      text: 'Fix merged retry status drift.',
      publishedAt: '2026-04-28T12:00:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        suggestionStatus: 'merged',
        codeFixOrchestratorStatus: 'merged',
        taskId: 'fix-merged-retry-status-1777374311131-v2',
        codeFixTaskFamily: 'fix-merged-retry-status-1777374311131',
        codeFixAttemptNumber: 2,
      },
    });
    assert.strictEqual(inserted, true);

    db.prepare(`
      INSERT INTO code_fix_tasks (suggestion_id, task_id, status, phase)
      VALUES ('code-fix-merged-retry-suggestion', 'fix-merged-retry-status-1777374311131', 'running', 'agent_execution')
    `).run();
    db.prepare(`
      INSERT INTO code_fix_tasks (suggestion_id, task_id, status, phase)
      VALUES ('code-fix-merged-retry-suggestion', 'fix-merged-retry-status-1777374311131-v2', 'merged', 'merged')
    `).run();

    const item = getFeedItemById('code-fix-merged-retry-suggestion');
    assert.ok(item);
    assert.strictEqual(item.suggestionStatus, 'merged');

    const hydrated = hydrateFeedItemsForList([item]);
    assert.strictEqual(hydrated[0]?.suggestionStatus, 'merged');
  });
});
