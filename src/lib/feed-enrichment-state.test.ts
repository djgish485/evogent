import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getFeedItemBatchEnrichmentState } from './feed-enrichment-state';
import type { FeedItem } from '@/types/feed';

function buildFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'feed-item-1',
    type: 'tweet',
    source: 'twitter',
    sourceId: 'tweet-1',
    parentId: null,
    relationship: null,
    title: null,
    text: 'hello',
    url: 'https://x.com/example/status/1',
    excerpt: null,
    authorUsername: 'example',
    authorDisplayName: 'Example',
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    metadata: null,
    publishedAt: '2026-04-22T00:00:00.000Z',
    createdAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('feed enrichment state helpers', () => {
  test('ignores stale full enrichment request ids without batch enrichment', () => {
    const item = buildFeedItem({
      metadata: {
        fullEnrichmentRequestId: 'enrich-post-1',
      },
    });

    assert.equal(getFeedItemBatchEnrichmentState(item), 'none');
  });

  test('reports automatic batch enrichment without a full request id', () => {
    const item = buildFeedItem({
      metadata: {
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-1',
          status: 'queued',
        },
      },
    });

    assert.equal(getFeedItemBatchEnrichmentState(item), 'enriching');
  });

  test('stale queued batch enrichment falls back to failed instead of enriching forever', () => {
    const item = buildFeedItem({
      children: [{
        id: 'related-context',
        type: 'article',
        relationship: 'related',
        title: 'Related context',
        text: 'context',
        source: 'youtube',
        authorUsername: null,
        authorDisplayName: null,
        authorAvatarUrl: null,
      }],
      metadata: {
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-1',
          status: 'queued',
          queuedAt: '2026-04-27T04:52:16.682Z',
          retryEligible: true,
        },
      },
    });

    assert.equal(
      getFeedItemBatchEnrichmentState(item, { nowMs: Date.parse('2026-04-27T06:49:00.000Z') }),
      'failed',
    );
  });

  test('expired running batch deadline falls back to failed', () => {
    const item = buildFeedItem({
      metadata: {
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-1',
          status: 'running',
          queuedAt: '2026-04-27T04:52:16.682Z',
          startedAt: '2026-04-27T04:52:18.000Z',
          deadlineAt: '2026-04-27T05:22:18.000Z',
          retryEligible: true,
        },
      },
    });

    assert.equal(
      getFeedItemBatchEnrichmentState(item, { nowMs: Date.parse('2026-04-27T05:22:18.001Z') }),
      'failed',
    );
  });

  test('metrics patched without a terminal reply audit is still incomplete', () => {
    const item = buildFeedItem({
      metrics: {
        likes: 12,
        reposts: 2,
        replies: 4,
        views: 1200,
      },
      metadata: {
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-1',
          status: 'completed',
        },
      },
    });

    assert.equal(getFeedItemBatchEnrichmentState(item), 'incomplete');
  });

  test('completed batch with only related children and no terminal reply audit is incomplete', () => {
    const item = buildFeedItem({
      children: [{
        id: 'related-context',
        type: 'article',
        relationship: 'related',
        title: 'Related context',
        text: 'context',
        source: 'youtube',
        authorUsername: null,
        authorDisplayName: null,
        authorAvatarUrl: null,
      }],
      metadata: {
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-1',
          status: 'completed',
          completedAt: '2026-04-27T05:00:00.000Z',
          retryEligible: false,
        },
      },
    });

    assert.equal(getFeedItemBatchEnrichmentState(item), 'incomplete');
  });

  test('accepts a terminal no-useful-replies receipt as complete', () => {
    const item = buildFeedItem({
      metrics: {
        likes: 12,
        reposts: 2,
        replies: 4,
      },
      metadata: {
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-1',
          status: 'completed',
          replyAudit: {
            batchRequestId: 'curation-submit-enrichment-batch-1',
            inspectedReplySurface: true,
            visibleReplyCount: 4,
            savedReplyCount: 0,
            savedReplyIds: [],
            noMeaningfulRepliesReason: 'Visible replies did not add durable signal.',
            inspectedAt: '2026-04-25T15:20:00.000Z',
          },
        },
      },
    });

    assert.equal(getFeedItemBatchEnrichmentState(item), 'complete');
  });

  test('failed partial batch leaves unfinished items recoverable', () => {
    const completedItem = buildFeedItem({
      id: 'completed',
      metadata: {
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-1',
          status: 'completed',
          retryEligible: false,
          replyAudit: {
            batchRequestId: 'curation-submit-enrichment-batch-1',
            inspectedCommentSurface: true,
            savedReplyCount: 2,
            savedReplyIds: ['reply-1', 'reply-2'],
            inspectedAt: '2026-04-25T15:21:00.000Z',
          },
        },
      },
    });
    const unfinishedItem = buildFeedItem({
      id: 'unfinished',
      metadata: {
        batchEnrichment: {
          requestId: 'curation-submit-enrichment-batch-1',
          status: 'failed',
          retryEligible: true,
          failedAt: '2026-04-25T15:26:20.000Z',
          failureReason: 'Batch process exited before this item wrote a terminal reply audit.',
        },
      },
    });

    assert.equal(getFeedItemBatchEnrichmentState(completedItem), 'complete');
    assert.equal(getFeedItemBatchEnrichmentState(unfinishedItem), 'failed');
    assert.equal(unfinishedItem.metadata?.batchEnrichment?.retryEligible, true);
  });
});
