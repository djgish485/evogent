import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveHackerNewsDiscussionUrl } from './hacker-news';
import type { FeedMetadata } from '@/types/feed';

describe('resolveHackerNewsDiscussionUrl', () => {
  test('prefers metadata.hnUrl', () => {
    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: 'hn-47897953',
        url: 'https://devin.ai/terminal',
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
        sourceId: 'hn-47897953',
        url: 'https://devin.ai/terminal',
        metadata: null,
      }),
      'https://news.ycombinator.com/item?id=47897953',
    );
  });

  test('derives the discussion URL from bare numeric sourceId', () => {
    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: '47897953',
        url: 'https://devin.ai/terminal',
        metadata: null,
      }),
      'https://news.ycombinator.com/item?id=47897953',
    );
  });

  test('uses item.url only when it is already an HN item URL', () => {
    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: null,
        url: 'https://news.ycombinator.com/item?id=47897953',
        metadata: null,
      }),
      'https://news.ycombinator.com/item?id=47897953',
    );

    assert.equal(
      resolveHackerNewsDiscussionUrl({
        sourceId: null,
        url: 'https://devin.ai/terminal',
        metadata: null,
      }),
      null,
    );
  });
});
