import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  arrangeFeedDisplay,
  findTweetFeedItemByIdentifier,
  getActiveFeedThreads,
  getFeedChildren,
  getFeedItemById,
  getFeedItemBySourceId,
  getPendingFeedCounts,
  getFeedPage,
  hydrateFeedItemsForList,
  insertOrIgnoreFeedItem,
  normalizeArticleSourceId,
  normalizeFeedInput,
  normalizeRelationship,
  normalizeType,
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
      authorUsername: '@OpenAI',
      text: 'hello',
      publishedAt: '2026-03-01T00:00:00.000Z',
    });

    assert.ok(result);
    assert.strictEqual(result?.sourceId, '2030455675357143260');
    assert.strictEqual(result?.url, 'https://x.com/OpenAI/status/2030455675357143260');
  });

  test('normalizeFeedInput persists HN discussion URL metadata from sourceId', () => {
    const result = normalizeFeedInput({
      type: 'article',
      source: 'hackernews',
      sourceId: 'hn-47897953',
      title: 'Devin for Terminal',
      text: 'Devin for Terminal',
      url: 'https://devin.ai/terminal',
      publishedAt: '2026-04-25T00:00:00.000Z',
      metadata: {
        hnScore: 5,
        hnComments: 0,
      },
    });

    assert.ok(result);
    assert.strictEqual(result?.url, 'https://devin.ai/terminal');
    assert.strictEqual(result?.metadata?.hnUrl, 'https://news.ycombinator.com/item?id=47897953');
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
      normalizeArticleSourceId('www.persuasion.community:/p/ai-cant-deal-with-the-real-world'),
      'https://www.persuasion.community/p/ai-cant-deal-with-the-real-world',
    );
    assert.strictEqual(
      normalizeArticleSourceId('chipkin:/p/death-by-intuition'),
      'https://chipkin.substack.com/p/death-by-intuition',
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
      source: 'nytimes',
      sourceId: 'https://www.nytimes.com/example',
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
      source: 'nytimes',
      sourceId: 'https://www.nytimes.com/example-thread',
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
            homepageUrl: 'https://www.nytimes.com/',
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
        homepageUrl: 'https://www.nytimes.com/',
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
          authorUsername: 'juicystar1908',
          authorDisplayName: 'juicystar1908',
          authorAvatarUrl: 'https://pbs.twimg.com/profile_images/quoted.jpg',
          url: 'https://x.com/juicystar1908/status/1234567890123456789',
        },
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.quotedTweet, {
      id: '1234567890123456789',
      text: 'Quoted tweet body',
      author: {
        username: 'juicystar1908',
        displayName: 'juicystar1908',
        avatarUrl: 'https://pbs.twimg.com/profile_images/quoted.jpg',
      },
      metrics: {
        likes: 15,
        reposts: 6,
        replies: 3,
      },
      url: 'https://x.com/juicystar1908/status/1234567890123456789',
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
            username: 'juicystar1908',
            displayName: 'juicystar1908',
          },
          url: 'https://x.com/juicystar1908/status/1234567890123456789',
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
      text: '@wk reply context should survive normalization',
      metadata: {
        replyCapture: {
          source: 'timeline',
          classification: 'authored_timeline_entry',
          requestedHandle: 'DavidDeutschOxf',
          authoredByRequestedAccount: true,
          visibleReplyBanner: true,
        },
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.replyCapture, {
      source: 'timeline',
      classification: 'candidate',
      requestedHandle: 'daviddeutschoxf',
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
            url: 'https://www.reuters.com/world/story',
            title: 'Story title',
            image: 'https://www.reuters.com/image.jpg',
            domain: 'reuters.com',
            description: 'Story summary',
          },
          {
            url: 'https://www.nytimes.com/story',
            title: 'Second title',
            imageUrl: 'https://www.nytimes.com/image.jpg',
            domain: 'nytimes.com',
          },
        ],
      },
    });

    assert.ok(result);
    assert.deepStrictEqual(result?.metadata?.linkPreviews, [
      {
        url: 'https://www.reuters.com/world/story',
        title: 'Story title',
        image: 'https://www.reuters.com/image.jpg',
        domain: 'reuters.com',
        description: 'Story summary',
      },
      {
        url: 'https://www.nytimes.com/story',
        title: 'Second title',
        image: 'https://www.nytimes.com/image.jpg',
        domain: 'nytimes.com',
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

    arrangeFeedDisplay({ ordering: [], threads: [] });
    assert.deepStrictEqual(getActiveFeedThreads(), []);
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

  test('getFeedPage keeps thread-group members on the same page when a boundary lands mid-thread', () => {
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
      'thread-member-2',
    ]);
    assert.deepStrictEqual(secondPage.items.map((item) => item.id), ['page-tail']);
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
      'chipkin.substack.com:/p/death-by-intuition',
      'https://chipkin.substack.com/p/death-by-intuition',
      '2026-03-02T01:00:00.000Z',
      '2026-03-02T01:30:00.000Z',
    );

    const byCanonical = getFeedItemBySourceId('https://chipkin.substack.com/p/death-by-intuition');
    const byLegacy = getFeedItemBySourceId('chipkin.substack.com:/p/death-by-intuition');

    assert.strictEqual(byCanonical?.id, 'article-legacy');
    assert.strictEqual(byLegacy?.id, 'article-legacy');
  });

  test('insertOrIgnoreFeedItem stores canonical article source ids for legacy newsletter inputs', () => {
    const inserted = insertOrIgnoreFeedItem({
      id: 'article-canonicalized',
      type: 'article',
      source: 'substack',
      sourceId: 'chipkin.substack.com:/p/death-by-intuition',
      url: 'https://chipkin.substack.com/p/death-by-intuition',
      text: 'canonical article',
      publishedAt: '2026-03-02T01:00:00.000Z',
    });

    assert.strictEqual(inserted, true);

    const row = getDb().prepare(`
      SELECT source_id AS sourceId
      FROM feed
      WHERE id = 'article-canonicalized'
    `).get() as { sourceId: string } | undefined;

    assert.strictEqual(row?.sourceId, 'https://chipkin.substack.com/p/death-by-intuition');
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
