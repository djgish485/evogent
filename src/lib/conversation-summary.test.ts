import assert from 'node:assert';
import { describe, test } from 'node:test';
import { buildSessionCards } from './conversation-summary';
import type { ConversationSessionSummary } from '@/types/conversation';
import type { FeedItem } from '@/types/feed';

function createFeedItem(originSessionId: string | null): FeedItem {
  const timestamp = '2026-05-18T02:00:00.000Z';
  return {
    id: `feed-${originSessionId ?? 'none'}`,
    type: 'article',
    source: 'substack',
    sourceId: `source-${originSessionId ?? 'none'}`,
    originSessionId,
    parentId: null,
    relationship: null,
    title: 'Submitted item',
    text: 'A feed item submitted by the curator.',
    url: 'https://example.com/item',
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
    metadata: null,
    publishedAt: timestamp,
    createdAt: timestamp,
  };
}

function createSessionSummary(sessionId: string): ConversationSessionSummary {
  return {
    sessionId,
    provider: 'claude',
    claudeReasoningEffort: 'medium',
    codexReasoningEffort: 'medium',
    codexFastMode: false,
    latestContextTokens: null,
    latestContextWindow: null,
    latestContextModel: null,
    latestContextUpdatedAt: null,
    title: 'Real session',
    color: null,
    sessionType: null,
    workingDirectory: '/tmp',
    lastMaterialActivityAt: '2026-05-18T01:00:00.000Z',
    conversationCount: 1,
    messageCount: 0,
    feedItemCount: 1,
    previewText: null,
    previewMessages: [],
    lastActor: null,
    contextKind: 'global',
    contextRefId: null,
  };
}

describe('buildSessionCards', () => {
  test('does not synthesize session cards from feed-only originSessionId values', () => {
    const cards = buildSessionCards(
      [],
      [createFeedItem('curator-webchat-2026-05-18T02:00Z')],
      [],
      null,
    );

    assert.deepStrictEqual(cards, []);
  });

  test('keeps feed items attached to real session summaries', () => {
    const sessionId = 'real-session';
    const cards = buildSessionCards(
      [],
      [createFeedItem(sessionId)],
      [createSessionSummary(sessionId)],
      null,
    );

    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].sessionId, sessionId);
    assert.strictEqual(cards[0].feedItems.length, 1);
  });
});
