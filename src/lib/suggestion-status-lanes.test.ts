import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getSuggestionLifecycleLane, partitionSuggestionItemsByLifecycle } from './suggestion-status-lanes';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

function createSuggestion(id: string, suggestionStatus: SuggestionStatus): FeedItem {
  return {
    id,
    type: 'suggestion',
    source: 'test',
    sourceId: id,
    parentId: null,
    relationship: null,
    title: `Suggestion ${id}`,
    text: `Suggestion ${id} summary.`,
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
    suggestionStatus,
    metadata: {
      suggestionStatus,
      suggestionType: 'code_fix',
    },
    publishedAt: '2026-03-31T00:00:00.000Z',
    createdAt: '2026-03-31T00:00:00.000Z',
  };
}

describe('suggestion lifecycle lanes', () => {
  test('maps each lifecycle status to the correct lane', () => {
    assert.equal(getSuggestionLifecycleLane('pending'), 'pending');
    assert.equal(getSuggestionLifecycleLane('dispatched'), 'active');
    assert.equal(getSuggestionLifecycleLane('running'), 'active');
    assert.equal(getSuggestionLifecycleLane('merged'), 'complete');
    assert.equal(getSuggestionLifecycleLane('accepted'), 'complete');
    assert.equal(getSuggestionLifecycleLane('dismissed'), 'complete');
    assert.equal(getSuggestionLifecycleLane('failed'), 'complete');
  });

  test('partitions suggestion items without changing their in-lane order', () => {
    const items = [
      createSuggestion('pending-1', 'pending'),
      createSuggestion('running-1', 'running'),
      createSuggestion('failed-1', 'failed'),
      createSuggestion('dispatched-1', 'dispatched'),
      createSuggestion('merged-1', 'merged'),
      createSuggestion('accepted-1', 'accepted'),
      createSuggestion('pending-2', 'pending'),
    ];

    const lanes = partitionSuggestionItemsByLifecycle(items, (item) => item.suggestionStatus ?? 'pending');

    assert.deepEqual(lanes.pending.map((item) => item.id), ['pending-1', 'pending-2']);
    assert.deepEqual(lanes.active.map((item) => item.id), ['running-1', 'dispatched-1']);
    assert.deepEqual(lanes.complete.map((item) => item.id), ['failed-1', 'merged-1', 'accepted-1']);
  });
});
