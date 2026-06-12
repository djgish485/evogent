import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SuggestionStatusLane } from './suggestion-status-lane';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

function createSuggestion(
  id: string,
  suggestionStatus: SuggestionStatus,
  suggestionType = 'code_fix',
): FeedItem {
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
      suggestionType,
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

  test('splits the pending lane into personal and dev sections when both exist', () => {
    const markup = renderToStaticMarkup(
      <SuggestionStatusLane
        lane="pending"
        items={[
          createSuggestion('life-admin-1', 'pending', 'life_admin'),
          createSuggestion('code-fix-1', 'pending'),
          createSuggestion('code-fix-2', 'pending'),
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

    assert.match(markup, /data-testid="suggestion-lane-personal-section"/);
    assert.match(markup, /data-testid="suggestion-lane-dev-section"/);
    assert.match(markup, /<h3[^>]*>For you<\/h3>/);
    assert.match(markup, /<h3[^>]*>Dev backlog<\/h3>/);
    const personalIndex = markup.indexOf('Suggestion life-admin-1');
    const devIndex = markup.indexOf('Suggestion code-fix-1');
    assert.ok(personalIndex >= 0 && devIndex >= 0 && personalIndex < devIndex);
  });

  test('renders a flat pending lane when only code fixes are present', () => {
    const markup = renderToStaticMarkup(
      <SuggestionStatusLane
        lane="pending"
        items={[
          createSuggestion('code-fix-1', 'pending'),
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

    assert.doesNotMatch(markup, /data-testid="suggestion-lane-personal-section"/);
    assert.doesNotMatch(markup, /For you/);
  });
});
