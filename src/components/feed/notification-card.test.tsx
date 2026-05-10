import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotificationCard } from './notification-card';
import type { FeedItem } from '@/types/feed';

function createNotificationItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'notification-1',
    type: 'notification',
    source: 'system',
    sourceId: 'notification-1',
    parentId: null,
    relationship: null,
    title: 'Notification',
    text: '## Priority\n\n**Sarah Kim** needs a reply.\n\n- Review the brief\n\n[Open](https://example.com)',
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
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    analysisPresentation: null,
    metadata: {
      severity: 'info',
      dismissable: true,
    },
    publishedAt: '2026-04-10T00:00:00.000Z',
    createdAt: '2026-04-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('NotificationCard', () => {
  test('renders notification body markdown instead of raw markdown characters', () => {
    const markup = renderToStaticMarkup(
      <NotificationCard
        item={createNotificationItem()}
        pendingAction={null}
        onDismiss={() => {}}
      />,
    );

    assert.match(markup, /<h2/);
    assert.match(markup, /<strong>Sarah Kim<\/strong>/);
    assert.match(markup, /<li/);
    assert.match(markup, /href="https:\/\/example\.com"/);
    assert.doesNotMatch(markup, /## Priority/);
    assert.doesNotMatch(markup, /\*\*Sarah Kim\*\*/);
  });

  test('renders mcpAppHtml instead of the plain notification body when present', () => {
    const markup = renderToStaticMarkup(
      <NotificationCard
        item={createNotificationItem({
          text: 'Plain notification fallback',
          metadata: {
            severity: 'info',
            dismissable: true,
            mcpAppHtml: '<button data-evogent-action="x.follow">Follow</button>',
          },
        })}
        pendingAction={null}
        onDismiss={() => {}}
      />,
    );

    assert.match(markup, /data-testid="mcp-app-frame"/);
    assert.match(markup, /x\.follow/);
    assert.match(markup, /Follow/);
    assert.doesNotMatch(markup, /Plain notification fallback/);
  });
});
