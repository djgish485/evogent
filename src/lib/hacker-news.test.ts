import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveHackerNewsDiscussionUrl } from './hacker-news';
import type { FeedMetadata } from '@/types/feed';

describe('resolveHackerNewsDiscussionUrl', () => {
  test('prefers metadata.hnUrl', () => {
    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: 'hn-100001',
        url: 'https://news.example.com/research/synthetic-systems-paper',
        metadata: {
          hnUrl: 'https://news.ycombinator.com/item?id=101',
        } as FeedMetadata,
      }),
      'https://news.ycombinator.com/item?id=101',
    );
  });

  test('derives the discussion URL from hn-prefixed sourceId', () => {
    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: 'hn-100001',
        url: 'https://news.example.com/research/synthetic-systems-paper',
        metadata: null,
      }),
      'https://news.ycombinator.com/item?id=100001',
    );
  });

  test('derives the discussion URL from bare numeric sourceId', () => {
    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: '100001',
        url: 'https://news.example.com/research/synthetic-systems-paper',
        metadata: null,
      }),
      'https://news.ycombinator.com/item?id=100001',
    );
  });

  test('uses item.url only when it is already an HN item URL', () => {
    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: null,
        url: 'https://news.ycombinator.com/item?id=100001',
        metadata: null,
      }),
      'https://news.ycombinator.com/item?id=100001',
    );

    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: null,
        url: 'https://news.example.com/research/synthetic-systems-paper',
        metadata: null,
      }),
      null,
    );
  });
});
