import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpenClawVariantCard, resolveOpenClawCardVariant } from './openclaw-variant-card';
import type { FeedItem } from '@/types/feed';

function createFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'openclaw-demo-email-digest',
    type: 'analysis',
    source: 'openclaw',
    sourceId: 'openclaw-demo-email-digest',
    parentId: null,
    relationship: null,
    title: 'Inbox triage',
    text: '## Priority (2)\n\n- **Sarah Kim**: Launch review - needs a yes/no today\n- **Ops**: Invoice approval - due before close',
    url: null,
    excerpt: null,
    authorUsername: null,
    authorDisplayName: 'OpenClaw',
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    analysisPresentation: null,
    metadata: null,
    publishedAt: '2026-04-10T00:00:00.000Z',
    createdAt: '2026-04-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveOpenClawCardVariant', () => {
  test('prefers metadata cardVariant for known variants', () => {
    assert.equal(
      resolveOpenClawCardVariant(createFeedItem({
        id: 'feed-item-1',
        metadata: { cardVariant: 'pr-review' },
      })),
      'pr-review',
    );
  });

  test('infers stable openclaw-demo ids as a demo bridge', () => {
    assert.equal(resolveOpenClawCardVariant(createFeedItem()), 'email-digest');
  });

  test('returns null for unknown or non-demo variants', () => {
    assert.equal(
      resolveOpenClawCardVariant(createFeedItem({
        id: 'feed-item-2',
        metadata: { cardVariant: 'unknown-kind' },
      })),
      null,
    );
  });
});

describe('OpenClawVariantCard', () => {
  test('renders email digest with OpenClaw chrome and without raw markdown markers', () => {
    const markup = renderToStaticMarkup(
      <OpenClawVariantCard
        item={createFeedItem()}
        variant="email-digest"
      />,
    );

    assert.match(markup, /data-openclaw-variant="email-digest"/);
    assert.match(markup, />OpenClaw</);
    assert.match(markup, />Email digest</);
    assert.match(markup, />Sarah Kim</);
    assert.match(markup, />Launch review</);
    assert.doesNotMatch(markup, /## Priority/);
    assert.doesNotMatch(markup, /\*\*Sarah Kim\*\*/);
  });
});
