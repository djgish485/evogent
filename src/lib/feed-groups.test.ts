import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildSuggestionGroupItems,
  getSuggestionGroupLatestTimestamp,
  getSuggestionGroupPreviewItems,
  getSuggestionGroupTitle,
} from './feed-groups';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

function createSuggestion(
  id: string,
  status: SuggestionStatus,
  createdAt: string,
): FeedItem {
  return {
    id,
    type: 'suggestion',
    source: 'claude',
    sourceId: id,
    parentId: null,
    relationship: null,
    title: id,
    text: `${id} summary`,
    url: null,
    excerpt: null,
    authorUsername: null,
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: {
      likes: 0,
      reposts: 0,
      replies: 0,
    },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    suggestionStatus: status,
    metadata: {
      suggestionType: 'code_fix',
      suggestionStatus: status,
      proposedValue: `${id} proposed value`,
    },
    publishedAt: createdAt,
    createdAt,
  };
}

describe('feed-groups', () => {
  test('keeps all current suggestions and caps resolved history including failed suggestions', () => {
    const items = [
      createSuggestion('pending-1', 'pending', '2026-03-20T12:00:00.000Z'),
      createSuggestion('pending-2', 'pending', '2026-03-20T10:30:00.000Z'),
      createSuggestion('running-1', 'running', '2026-03-20T11:00:00.000Z'),
      createSuggestion('running-2', 'running', '2026-03-20T12:30:00.000Z'),
      createSuggestion('dispatched-1', 'dispatched', '2026-03-20T14:00:00.000Z'),
      createSuggestion('dispatched-2', 'dispatched', '2026-03-20T13:30:00.000Z'),
      createSuggestion('failed-1', 'failed', '2026-03-20T13:00:00.000Z'),
      createSuggestion('merged-1', 'merged', '2026-03-20T10:00:00.000Z'),
      createSuggestion('merged-2', 'merged', '2026-03-20T09:00:00.000Z'),
      createSuggestion('accepted-1', 'accepted', '2026-03-20T08:00:00.000Z'),
      createSuggestion('accepted-2', 'accepted', '2026-03-20T07:00:00.000Z'),
    ];

    const grouped = buildSuggestionGroupItems(items, 'created', 2);

    assert.deepStrictEqual(
      grouped.map((item) => item.id),
      ['running-1', 'running-2', 'dispatched-2', 'dispatched-1', 'pending-2', 'pending-1', 'failed-1', 'merged-1'],
    );
  });

  test('derives suggestion group title and timestamp from the selected set', () => {
    const items = buildSuggestionGroupItems([
      createSuggestion('pending-1', 'pending', '2026-03-20T12:00:00.000Z'),
      createSuggestion('merged-1', 'merged', '2026-03-20T09:00:00.000Z'),
      createSuggestion('accepted-1', 'accepted', '2026-03-20T08:00:00.000Z'),
    ], 'created', 2);

    assert.strictEqual(getSuggestionGroupTitle(items), '1 open, 2 recent resolved');
    assert.strictEqual(getSuggestionGroupLatestTimestamp(items), '2026-03-20T12:00:00.000Z');
  });

  test('limits preview items to suggestions already loaded on the client while preserving group order', () => {
    const groupedItems = buildSuggestionGroupItems([
      createSuggestion('pending-1', 'pending', '2026-03-20T12:00:00.000Z'),
      createSuggestion('running-1', 'running', '2026-03-20T11:00:00.000Z'),
      createSuggestion('merged-1', 'merged', '2026-03-20T10:00:00.000Z'),
      createSuggestion('accepted-1', 'accepted', '2026-03-20T09:00:00.000Z'),
    ], 'created', 4);

    const loadedItems: FeedItem[] = [
      createSuggestion('merged-1', 'merged', '2026-03-20T10:00:00.000Z'),
      {
        ...createSuggestion('analysis-1', 'pending', '2026-03-20T08:00:00.000Z'),
        id: 'analysis-1',
        type: 'analysis',
        suggestionStatus: undefined,
        metadata: null,
      },
      createSuggestion('pending-1', 'pending', '2026-03-20T12:00:00.000Z'),
    ];

    assert.deepStrictEqual(
      getSuggestionGroupPreviewItems(groupedItems, loadedItems).map((item) => item.id),
      ['pending-1', 'merged-1'],
    );
  });
});
