import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeFeedInput } from './feed';

describe('feed metadata thread fields', () => {
  test('preserves reply-chain metadata needed by the detail view', () => {
    const result = normalizeFeedInput({
      type: 'tweet',
      source: 'twitter',
      sourceId: 'tweet-1',
      text: 'reply tweet',
      publishedAt: '2026-03-08T00:00:00.000Z',
      metadata: {
        inReplyToStatusId: 'tweet-0',
        conversationId: 'tweet-0',
      },
    });

    assert.ok(result);
    assert.equal(result?.metadata?.inReplyToStatusId, 'tweet-0');
    assert.equal(result?.metadata?.conversationId, 'tweet-0');
  });
});
