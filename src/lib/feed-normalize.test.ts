import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareThreadGroupItems } from './feed-normalize';
import type { FeedItem } from '@/types/feed';

function item(id: string, createdAt: string, displayOrder: number | null = null): FeedItem {
  return {
    id,
    type: 'article',
    source: 'unit_test',
    sourceId: null,
    originSessionId: null,
    parentId: null,
    relationship: null,
    title: id,
    text: id,
    url: null,
    excerpt: null,
    authorUsername: null,
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    displayOrder,
    threadId: 'thread-a',
    displaySubtitle: null,
    threadTitle: 'Thread A',
    threadSubtitle: null,
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    suggestionStatus: undefined,
    analysisPresentation: null,
    metadata: {},
    publishedAt: createdAt,
    createdAt,
  };
}

test('compareThreadGroupItems honors fresh curator display order inside threads', () => {
  const olderPromoted = item('older-promoted', '2026-05-01T00:00:00.000Z', 1);
  const newerLower = item('newer-lower', '2026-05-02T00:00:00.000Z', 2);

  assert.equal(compareThreadGroupItems(olderPromoted, newerLower, 'created', {
    lastArrangeAtMs: Date.now(),
  }), -1);
});

test('compareThreadGroupItems preserves chronological thread fallback without display order', () => {
  const older = item('older', '2026-05-01T00:00:00.000Z');
  const newer = item('newer', '2026-05-02T00:00:00.000Z');

  assert.equal(compareThreadGroupItems(older, newer, 'created'), -1);
});
