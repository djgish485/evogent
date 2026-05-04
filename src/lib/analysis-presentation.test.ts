import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalysisRenderableEntries, deriveAnalysisPresentation } from '@/lib/analysis-presentation';
import type { FeedItem } from '@/types/feed';

function createFeedItem(overrides: Partial<FeedItem>): FeedItem {
  return {
    id: overrides.id ?? 'item-1',
    type: overrides.type ?? 'article',
    source: overrides.source ?? 'unit_test',
    sourceId: overrides.sourceId ?? overrides.id ?? 'item-1',
    originSessionId: overrides.originSessionId ?? null,
    parentId: overrides.parentId ?? null,
    relationship: overrides.relationship ?? null,
    title: overrides.title ?? null,
    text: overrides.text ?? 'Default text',
    url: overrides.url ?? null,
    excerpt: overrides.excerpt ?? null,
    authorUsername: overrides.authorUsername ?? null,
    authorDisplayName: overrides.authorDisplayName ?? null,
    reason: overrides.reason ?? null,
    tags: overrides.tags ?? [],
    mediaUrls: overrides.mediaUrls ?? [],
    metrics: overrides.metrics ?? { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: overrides.authorAvatarUrl ?? null,
    isLiked: overrides.isLiked ?? false,
    isDisliked: overrides.isDisliked ?? false,
    suggestionStatus: overrides.suggestionStatus,
    parentItem: overrides.parentItem ?? null,
    children: overrides.children ?? [],
    childrenCount: overrides.childrenCount ?? 0,
    suggestionChildren: overrides.suggestionChildren ?? [],
    analysisPresentation: overrides.analysisPresentation ?? null,
    metadata: overrides.metadata ?? null,
    publishedAt: overrides.publishedAt ?? '2026-03-08T00:00:00.000Z',
    createdAt: overrides.createdAt ?? '2026-03-08T00:00:00.000Z',
  };
}

test('deriveAnalysisPresentation inherits parent hero media for child analyses', () => {
  const parent = createFeedItem({
    id: 'tweet-1',
    type: 'tweet',
    source: 'twitter',
    sourceId: 'tweet-1',
    authorUsername: 'alice',
    authorDisplayName: 'Alice',
    text: 'Parent tweet text',
    mediaUrls: ['https://example.com/parent-hero.jpg'],
    metadata: {
      media: [{ type: 'image', url: 'https://example.com/parent-hero.jpg' }],
      mediaTypes: ['photo'],
    },
  });

  const analysis = createFeedItem({
    id: 'analysis-1',
    type: 'analysis',
    source: 'claude',
    parentId: parent.id,
    relationship: 'analysis',
    parentItem: parent,
    title: 'Parent tweet text',
    text: [
      '## Why this matters',
      '',
      'This analysis synthesizes the parent thread into a broader mechanism-level view with concrete implications.',
      '',
      '- First implication',
      '- Second implication',
    ].join('\n'),
  });

  const presentation = deriveAnalysisPresentation(analysis, [analysis, parent]);

  assert.ok(presentation);
  assert.deepStrictEqual(presentation?.heroMedia, [{ type: 'image', url: 'https://example.com/parent-hero.jpg' }]);
  assert.equal(presentation?.heroMediaSource?.id, parent.id);
  assert.notEqual(presentation?.conciseTitle, analysis.title);
});

test('buildAnalysisRenderableEntries uses the strongest lead item and bundles the remainder', () => {
  const parent = createFeedItem({
    id: 'article-1',
    type: 'article',
    title: 'The primary source story',
    text: 'Primary source story body',
  });

  const lead = createFeedItem({
    id: 'analysis-lead',
    type: 'analysis',
    relationship: 'analysis',
    parentId: parent.id,
    parentItem: parent,
    text: 'Lead analysis body',
    analysisPresentation: {
      conciseTitle: 'Lead synthesis',
      conciseLabel: 'Lead synthesis',
      promotionScore: 5,
      seriesKey: 'analysis-series:article-1',
      seriesLabel: 'The primary source story',
      heroMedia: [],
      heroMediaSource: null,
      sourceItems: [],
    },
  });

  const followUpOne = createFeedItem({
    id: 'analysis-follow-up-1',
    type: 'analysis',
    relationship: 'analysis',
    parentId: parent.id,
    parentItem: parent,
    text: 'Follow-up analysis one',
    createdAt: '2026-03-08T00:01:00.000Z',
    analysisPresentation: {
      conciseTitle: 'Follow-up angle one',
      conciseLabel: 'Follow-up angle one',
      promotionScore: 2,
      seriesKey: 'analysis-series:article-1',
      seriesLabel: 'The primary source story',
      heroMedia: [],
      heroMediaSource: null,
      sourceItems: [],
    },
  });

  const followUpTwo = createFeedItem({
    id: 'analysis-follow-up-2',
    type: 'analysis',
    relationship: 'analysis',
    parentId: parent.id,
    parentItem: parent,
    text: 'Follow-up analysis two',
    createdAt: '2026-03-08T00:02:00.000Z',
    analysisPresentation: {
      conciseTitle: 'Follow-up angle two',
      conciseLabel: 'Follow-up angle two',
      promotionScore: 1,
      seriesKey: 'analysis-series:article-1',
      seriesLabel: 'The primary source story',
      heroMedia: [],
      heroMediaSource: null,
      sourceItems: [],
    },
  });

  const entries = buildAnalysisRenderableEntries([lead, followUpOne, followUpTwo]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.kind, 'item');
  assert.equal(entries[1]?.kind, 'series');
  assert.deepStrictEqual(
    entries[1]?.kind === 'series' ? entries[1].items.map((item) => item.id) : [],
    ['analysis-follow-up-1', 'analysis-follow-up-2'],
  );
});
