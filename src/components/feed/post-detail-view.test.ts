import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  buildConversationPosts,
  didEnrichmentAddChildren,
  resolveDetailBottomPadding,
  shouldRenderConversationConnector,
  shouldShowThreadAncestors,
  shouldShowPostDetailEnrichButton,
} from './post-detail-view';
import type { FeedItem } from '@/types/feed';

const postDetailViewSource = readFileSync(new URL('./post-detail-view.tsx', import.meta.url), 'utf8');

function createFeedItem({
  id = 'tweet-1',
  relationship = null,
  metadata = null,
}: {
  id?: string;
  relationship?: FeedItem['relationship'];
  metadata?: FeedItem['metadata'];
} = {}): FeedItem {
  return {
    id,
    type: 'tweet',
    source: 'twitter',
    sourceId: id,
    parentId: null,
    relationship,
    title: null,
    text: 'hello',
    url: 'https://x.com/alice/status/1',
    excerpt: null,
    authorUsername: 'alice',
    authorDisplayName: 'Alice',
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
    analysisPresentation: null,
    metadata,
    publishedAt: '2026-03-08T00:00:00.000Z',
    createdAt: '2026-03-08T00:00:00.000Z',
  };
}

describe('shouldShowThreadAncestors', () => {
  test('returns false for standalone quote tweets', () => {
    const item = createFeedItem({
      metadata: {
        quotedTweet: {
          id: 'quoted-1',
          text: 'quoted',
          author: { username: 'quoted-user' },
        },
      },
    });

    assert.equal(shouldShowThreadAncestors(item), false);
  });

  test('returns true for reply tweets in a conversation', () => {
    const item = createFeedItem({
      metadata: {
        inReplyToStatusId: 'tweet-0',
        conversationId: 'tweet-0',
      },
    });

    assert.equal(shouldShowThreadAncestors(item), true);
  });
});

describe('buildConversationPosts', () => {
  test('excludes replies from the connected conversation sequence', () => {
    const ancestor = createFeedItem({ id: 'ancestor', relationship: 'parent' });
    const main = createFeedItem({ id: 'main' });
    const continuation = createFeedItem({ id: 'continuation', relationship: 'child' });

    const conversation = buildConversationPosts({
      threadAncestors: [],
      parentPosts: [ancestor],
      item: main,
      continuationPosts: [continuation],
    });

    assert.deepEqual(
      conversation.map((entry) => entry.id),
      ['ancestor', 'main', 'continuation'],
    );
  });
});

describe('full enrichment detail state', () => {
  test('only reports added context when new child ids appear', () => {
    const existingReply = createFeedItem({ id: 'reply-1', relationship: 'reply' });
    const addedAnalysis = createFeedItem({ id: 'analysis-1', relationship: 'analysis' });

    assert.equal(didEnrichmentAddChildren([existingReply], [existingReply]), false);
    assert.equal(didEnrichmentAddChildren([existingReply], [existingReply, addedAnalysis]), true);
  });

  test('keeps the manual enrich button visible after a prior full-enrichment request', () => {
    const item = createFeedItem({
      metadata: {
        fullEnrichmentRequestId: 'request-1',
      },
    });

    assert.equal(
      shouldShowPostDetailEnrichButton({ item, isChatMode: false, isLoading: false }),
      true,
    );
  });

  test('hides the manual enrich button while loading, in chat mode, or without an item', () => {
    const item = createFeedItem();

    assert.equal(shouldShowPostDetailEnrichButton({ item, isChatMode: false, isLoading: true }), false);
    assert.equal(shouldShowPostDetailEnrichButton({ item, isChatMode: true, isLoading: false }), false);
    assert.equal(shouldShowPostDetailEnrichButton({ item: null, isChatMode: false, isLoading: false }), false);
  });
});

describe('detail enrich action placement', () => {
  test('keeps the manual enrich action out of the header and below the main item sections', () => {
    const headerStart = postDetailViewSource.indexOf('data-testid="post-detail-header"');
    const headerEnd = postDetailViewSource.indexOf('if (isLoading)', headerStart);
    const headerMarkup = postDetailViewSource.slice(headerStart, headerEnd);
    const postMainSection = postDetailViewSource.indexOf('data-testid="post-main-section"');
    const enrichButton = postDetailViewSource.indexOf('data-testid="post-detail-enrich-button"', postMainSection);
    const enrichmentBanner = postDetailViewSource.indexOf('data-testid="enrichment-banner"', enrichButton);
    const repliesSection = postDetailViewSource.indexOf('data-testid="post-replies-section"', enrichmentBanner);
    const enrichButtonMarkup = postDetailViewSource.slice(enrichButton, enrichmentBanner);

    assert.notEqual(headerStart, -1);
    assert.notEqual(headerEnd, -1);
    assert.equal(headerMarkup.includes('data-testid="post-detail-enrich-button"'), false);
    assert.match(headerMarkup, /headerActions/);
    assert.notEqual(postMainSection, -1);
    assert.notEqual(enrichButton, -1);
    assert.notEqual(enrichmentBanner, -1);
    assert.notEqual(repliesSection, -1);
    assert.ok(postMainSection < enrichButton);
    assert.ok(enrichButton < enrichmentBanner);
    assert.ok(enrichmentBanner < repliesSection);
    assert.match(enrichButtonMarkup, /Curate Additional Context/);
    assert.match(enrichButtonMarkup, /Enriching\.\.\./);
    assert.match(enrichButtonMarkup, /disabled=\{isEnriching\}/);
    assert.match(enrichButtonMarkup, /onClick=\{handleEnrichClick\}/);
  });
});

describe('detail Hacker News score placement', () => {
  test('keeps the HN points indicator available in the sticky detail header', () => {
    const headerStart = postDetailViewSource.indexOf('data-testid="post-detail-header"');
    const headerEnd = postDetailViewSource.indexOf('if (isLoading)', headerStart);
    const headerMarkup = postDetailViewSource.slice(headerStart, headerEnd);

    assert.notEqual(headerStart, -1);
    assert.notEqual(headerEnd, -1);
    assert.match(headerMarkup, /detailHeaderHackerNewsPoints/);
    assert.match(headerMarkup, /HackerNewsPointsIndicator/);
  });
});

describe('shouldRenderConversationConnector', () => {
  test('connects an ancestor to the main post', () => {
    const ancestor = createFeedItem({ id: 'ancestor', relationship: 'parent' });
    const main = createFeedItem({ id: 'main' });

    assert.equal(shouldRenderConversationConnector(ancestor, main, 'main'), true);
  });

  test('does not connect the main post to child tweets', () => {
    const main = createFeedItem({ id: 'main' });
    const continuation = createFeedItem({ id: 'continuation', relationship: 'child' });
    const reply = createFeedItem({ id: 'reply', relationship: 'reply' });

    assert.equal(shouldRenderConversationConnector(main, continuation, 'main'), false);
    assert.equal(shouldRenderConversationConnector(main, reply, 'main'), false);
  });

  test('does not connect a continuation child to a reply', () => {
    const continuation = createFeedItem({ id: 'continuation', relationship: 'child' });
    const reply = createFeedItem({ id: 'reply', relationship: 'reply' });

    assert.equal(shouldRenderConversationConnector(continuation, reply, 'main'), false);
  });
});

describe('resolveDetailBottomPadding', () => {
  test('uses the static minimum when no composer height is provided', () => {
    assert.equal(resolveDetailBottomPadding(), 176);
  });

  test('uses the measured composer height when it exceeds the static minimum', () => {
    assert.equal(resolveDetailBottomPadding(204), 204);
  });
});
