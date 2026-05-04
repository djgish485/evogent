import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SuggestionCard } from './suggestion-card';
import type { FeedItem } from '@/types/feed';

function createSuggestionItem(
  suggestionType: 'code_fix' | 'other',
  overrides: Partial<FeedItem> = {},
): FeedItem {
  return {
    id: `${suggestionType}-suggestion-1`,
    type: 'suggestion',
    source: 'claude',
    sourceId: `${suggestionType}-source-1`,
    originSessionId: 'originSessionId' in overrides ? overrides.originSessionId ?? null : 'origin-session-1',
    parentId: null,
    relationship: null,
    title: suggestionType === 'code_fix' ? 'Suggested code fix' : 'Suggested update',
    text: 'Suggestion summary',
    url: null,
    excerpt: null,
    authorUsername: null,
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    suggestionStatus: 'pending',
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    analysisPresentation: null,
    metadata: {
      suggestionType,
      proposedValue: 'Update the target value.',
    },
    publishedAt: '2026-04-10T00:00:00.000Z',
    createdAt: '2026-04-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('SuggestionCard', () => {
  test('renders chat button for pending suggestions with an origin session when chat is available', () => {
    const markup = renderToStaticMarkup(
      <SuggestionCard
        item={createSuggestionItem('code_fix')}
        status="pending"
        pendingAction={null}
        onAccept={() => {}}
        onDismiss={() => {}}
        onChatAboutSuggestion={() => {}}
      />,
    );

    assert.match(markup, /suggestion-chat-button/);
    assert.match(markup, /aria-label="Chat about this suggestion"/);
  });

  test('renders chat button for pending suggestions without an origin session when chat is available', () => {
    const markup = renderToStaticMarkup(
      <SuggestionCard
        item={createSuggestionItem('code_fix', { originSessionId: null })}
        status="pending"
        pendingAction={null}
        onAccept={() => {}}
        onDismiss={() => {}}
        onChatAboutSuggestion={() => {}}
      />,
    );

    assert.match(markup, /suggestion-chat-button/);
    assert.match(markup, /aria-label="Chat about this suggestion"/);
  });

  test('does not render chat button when suggestion chat is unavailable', () => {
    const markup = renderToStaticMarkup(
      <SuggestionCard
        item={createSuggestionItem('code_fix')}
        status="pending"
        pendingAction={null}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );

    assert.doesNotMatch(markup, /suggestion-chat-button/);
    assert.doesNotMatch(markup, />Chat about this</);
  });

  test('does not render Approve Fix for an active code-fix suggestion', () => {
    const markup = renderToStaticMarkup(
      <SuggestionCard
        item={createSuggestionItem('code_fix')}
        status="running"
        pendingAction={null}
        codeFixProgress={{ phase: 'running', detail: 'Agent working' }}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );

    assert.doesNotMatch(markup, />Approve Fix</);
    assert.match(markup, />Running</);
    assert.match(markup, /Agent working/);
  });

  test('renders a chat-originated session title as the creator subtitle', () => {
    const item = createSuggestionItem('code_fix', {
      originSessionId: 'session-lark-1',
      source: 'chat',
    });
    const markup = renderToStaticMarkup(
      <SuggestionCard
        item={item}
        status="pending"
        pendingAction={null}
        creatorSessionTitles={{ 'session-lark-1': 'Lark' }}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );

    assert.match(markup, /suggestion-creator-subtitle/);
    assert.match(markup, />Lark</);
    assert.doesNotMatch(markup, /session-lark-1/);
  });

  test('renders enrichment suggestions with the enrichment agent label', () => {
    const markup = renderToStaticMarkup(
      <SuggestionCard
        item={createSuggestionItem('code_fix', { source: 'enrichment' })}
        status="pending"
        pendingAction={null}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );

    assert.match(markup, /suggestion-creator-subtitle/);
    assert.match(markup, />Enrichment Agent</);
  });

  test('hides the creator subtitle when a chat session title and source fallback are unavailable', () => {
    const item = createSuggestionItem('code_fix', {
      originSessionId: 'missing-session-id',
      source: null,
    });
    const markup = renderToStaticMarkup(
      <SuggestionCard
        item={item}
        status="pending"
        pendingAction={null}
        creatorSessionTitles={{}}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );

    assert.doesNotMatch(markup, /suggestion-creator-subtitle/);
    assert.doesNotMatch(markup, /missing-session-id/);
    assert.doesNotMatch(markup, /Unknown/);
  });

  test('falls back to a readable title-cased source label', () => {
    const markup = renderToStaticMarkup(
      <SuggestionCard
        item={createSuggestionItem('code_fix', { source: 'custom_pipeline' })}
        status="pending"
        pendingAction={null}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );

    assert.match(markup, /suggestion-creator-subtitle/);
    assert.match(markup, />Custom Pipeline</);
  });
});
