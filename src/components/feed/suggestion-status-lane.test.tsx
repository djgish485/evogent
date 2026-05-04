import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SuggestionStatusLane } from './suggestion-status-lane';
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
      proposedValue: 'Keep the default suggestion screen free of helper copy.',
    },
    publishedAt: '2026-03-31T00:00:00.000Z',
    createdAt: '2026-03-31T00:00:00.000Z',
  };
}

describe('SuggestionStatusLane', () => {
  test('renders header labels and counts without visible lane summaries', () => {
    const markup = renderToStaticMarkup(
      <SuggestionStatusLane
        lane="complete"
        items={[
          createSuggestion('failed-1', 'failed'),
          createSuggestion('merged-1', 'merged'),
          createSuggestion('dismissed-1', 'dismissed'),
        ]}
        resolveSuggestionStatus={(item) => item.suggestionStatus ?? 'pending'}
        getSuggestionPendingAction={() => null}
        getSuggestionFeedback={() => null}
        codeFixProgressMap={{}}
        onSuggestionAccept={() => {}}
        onSuggestionDismiss={() => {}}
        onSuggestionChat={() => {}}
        onSuggestionRetry={() => {}}
        onSuggestionCancel={() => {}}
      />,
    );

    assert.match(markup, /<h2[^>]*>Complete<\/h2>/);
    assert.match(markup, />3<\/span>/);
    assert.doesNotMatch(markup, /3 from Test/);
    assert.doesNotMatch(markup, /Completed suggestions will appear here\./);
    assert.doesNotMatch(markup, /Merged, accepted, dismissed, and failed suggestions stay available for history/);
  });
});
