import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { canonicalizeTwitterFeedItemForSubmit } from './twitter-feed-canonicalization';
import type { FeedInsertInput } from './db/feed';

function tweet(overrides: Partial<FeedInsertInput> = {}): FeedInsertInput {
  return {
    type: 'tweet',
    source: 'twitter',
    sourceId: 'phone-twitter-display-name-provisional',
    parentId: null,
    relationship: null,
    title: null,
    text: 'A complete source-owned post captured from the phone.',
    url: null,
    excerpt: null,
    authorUsername: 'display_name_guess',
    authorDisplayName: 'Display Name',
    reason: null,
    tags: [],
    mediaUrls: [],
    metadata: null,
    publishedAt: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

describe('Twitter submit identity evidence', () => {
  test('cached uncertain identity removes a forged profile URL and preserves the flag', () => {
    const result = canonicalizeTwitterFeedItemForSubmit(tweet({
      url: 'https://x.com/display_name_guess',
    }), {
      cachedPayload: {
        type: 'tweet',
        text: 'A complete source-owned post captured from the phone.',
        authorUsername: 'display_name_guess',
        handleUncertain: true,
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.item.url, null);
    assert.strictEqual(result.item.metadata?.handleUncertain, true);
  });

  test('exact tweet id remains linkable without putting a guessed handle in the URL', () => {
    const result = canonicalizeTwitterFeedItemForSubmit(tweet({
      sourceId: '1888990011223344556',
      url: 'https://x.com/display_name_guess/status/1888990011223344556',
    }), {
      cachedPayload: {
        tweetId: '1888990011223344556',
        text: 'A complete source-owned post captured from the phone.',
        authorUsername: 'display_name_guess',
        handleUncertain: true,
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.item.url, 'https://x.com/i/web/status/1888990011223344556');
    assert.strictEqual(result.item.metadata?.handleUncertain, true);
  });

  test('observed profile URL remains usable when no uncertainty evidence exists', () => {
    const result = canonicalizeTwitterFeedItemForSubmit(tweet({
      authorUsername: 'observed_handle',
      url: 'https://x.com/observed_handle',
    }));

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.item.url, 'https://x.com/observed_handle');
    assert.strictEqual(result.item.metadata, null);
  });
});
