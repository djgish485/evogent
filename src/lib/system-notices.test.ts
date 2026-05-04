import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { FeedItem } from '@/types/feed';
import { isLowValueReflectionSummary, isOperationalSetupProgressNotice, shouldSuppressFeedSystemNotice } from './system-notices';

function buildFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'feed-item-1',
    type: 'analysis',
    source: 'evogent',
    sourceId: 'reflection-summary-1',
    originSessionId: null,
    parentId: null,
    relationship: null,
    title: 'Reflection: What I learned',
    text: 'Reflection complete — no new patterns detected. Current insights remain accurate.',
    url: null,
    excerpt: null,
    authorUsername: 'evogent',
    authorDisplayName: 'Evogent',
    reason: null,
    tags: ['reflection', 'meta'],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    metadata: { reflectionCycle: true },
    publishedAt: '2026-03-28T00:00:00.000Z',
    createdAt: '2026-03-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('system notice helpers', () => {
  test('suppresses no-op reflection summaries', () => {
    const item = buildFeedItem();

    assert.strictEqual(isLowValueReflectionSummary(item), true);
    assert.strictEqual(shouldSuppressFeedSystemNotice(item), true);
  });

  test('keeps reflection summaries that report meaningful changes', () => {
    const item = buildFeedItem({
      text: 'I promoted a new cluster of biotech and chip-manufacturing sources after repeated positive signals this week.',
    });

    assert.strictEqual(isLowValueReflectionSummary(item), false);
    assert.strictEqual(shouldSuppressFeedSystemNotice(item), false);
  });

  test('does not suppress unrelated analyses', () => {
    const item = buildFeedItem({
      metadata: null,
      title: 'Analysis: Semiconductor supply chain update',
      text: 'TSMC signaled tighter packaging capacity through Q4.',
    });

    assert.strictEqual(isLowValueReflectionSummary(item), false);
    assert.strictEqual(shouldSuppressFeedSystemNotice(item), false);
  });

  test('suppresses operational setup-progress notices from zero-item first curation', () => {
    const item = buildFeedItem({
      type: 'notification',
      source: 'system',
      sourceId: 'setup-progress:first-curation',
      title: 'Setup in progress',
      text: 'Setup in progress -- feed pool is still too thin for curation.',
      metadata: {
        notificationId: 'setup-progress:first-curation',
        severity: 'info',
      },
    });

    assert.strictEqual(isOperationalSetupProgressNotice(item), true);
    assert.strictEqual(shouldSuppressFeedSystemNotice(item), true);
  });

  test('keeps real setup failure notifications visible', () => {
    const item = buildFeedItem({
      type: 'notification',
      source: 'system',
      sourceId: 'setup-progress:provider-required',
      title: 'Setup required',
      text: 'Provider unavailable. REQUIRED brain_provider must be fixed before setup is complete.',
      metadata: {
        notificationId: 'setup-progress:provider-required',
        severity: 'error',
      },
    });

    assert.strictEqual(isOperationalSetupProgressNotice(item), false);
    assert.strictEqual(shouldSuppressFeedSystemNotice(item), false);
  });
});
