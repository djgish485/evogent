import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GroupDetailView } from './group-detail-view';
import type { FeedItem } from '@/types/feed';

function createSuggestionItem(id: string): FeedItem {
  return {
    id,
    type: 'suggestion',
    source: 'claude',
    sourceId: id,
    parentId: null,
    relationship: null,
    title: `Suggestion ${id}`,
    text: `Suggestion ${id} summary`,
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
      suggestionType: 'code_fix',
      proposedValue: 'Keep suggestions in a normal scrolling list.',
    },
    publishedAt: '2026-03-27T00:00:00.000Z',
    createdAt: '2026-03-27T00:00:00.000Z',
  };
}

function createNotificationItem(id: string, severity: 'info' | 'warning' | 'error', createdAt: string): FeedItem {
  return {
    id,
    type: 'notification',
    source: 'system',
    sourceId: id,
    parentId: null,
    relationship: null,
    title: `Notification ${id}`,
    text: `Notification ${id} body`,
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
    suggestionStatus: undefined,
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    analysisPresentation: null,
    notificationTaskContext: null,
    metadata: {
      severity,
      dismissable: true,
    },
    publishedAt: createdAt,
    createdAt,
  };
}

describe('GroupDetailView', () => {
  test('renders suggestion detail actions without history toggle controls', () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.parse('2026-03-29T00:00:00.000Z');

    const items = [createSuggestionItem('suggestion-1')];
    try {
      const markup = renderToStaticMarkup(
        <GroupDetailView
          groupId="suggestions"
          groupType="suggestion"
          title="Suggestions"
          items={items}
          onClose={() => {}}
          resolveSuggestionStatus={(item) => item.suggestionStatus ?? 'pending'}
          onSuggestionAccept={() => {}}
          onSuggestionDismiss={() => {}}
          onSuggestionBatchAccept={() => {}}
          onSuggestionBatchDismiss={() => {}}
        />,
      );

      assert.match(markup, /Accept All/);
      assert.match(markup, /Dismiss All/);
      assert.match(markup, /<time[^>]*dateTime=\"2026-03-27T00:00:00.000Z\"[^>]*>2d<\/time>/);
      assert.doesNotMatch(markup, /Showing 1 suggestion in this group\./);
      assert.doesNotMatch(markup, /Show all suggestions/i);
      assert.doesNotMatch(markup, /Show recent suggestions/i);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('renders notification detail cards with compact relative timestamps', () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.parse('2026-03-29T12:00:00.000Z');

    const items = [
      createNotificationItem('notification-1', 'error', '2026-03-29T11:54:00.000Z'),
      createNotificationItem('notification-2', 'warning', '2026-03-29T09:00:00.000Z'),
    ];

    try {
      const markup = renderToStaticMarkup(
        <GroupDetailView
          groupId="notifications"
          groupType="notification"
          title="Notifications"
          items={items}
          onClose={() => {}}
          onNotificationDismiss={() => {}}
        />,
      );

      assert.match(markup, /Notification notification-1/);
      assert.match(markup, /Notification notification-2/);
      assert.match(markup, /<time[^>]*dateTime=\"2026-03-29T11:54:00.000Z\"[^>]*>6m<\/time>/);
      assert.match(markup, /<time[^>]*dateTime=\"2026-03-29T09:00:00.000Z\"[^>]*>3h<\/time>/);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('renders notification task context when durable task detail is available', () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.parse('2026-03-29T12:00:00.000Z');

    const item = createNotificationItem('notification-task', 'info', '2026-03-29T11:54:00.000Z');
    item.notificationTaskContext = {
      taskId: 'curation-123',
      state: 'completed',
      updatedAt: '2026-03-29T11:58:00.000Z',
      summary: 'Queued curation finished and persisted new feed items.',
      lines: [
        'Opened the source queue and selected the next curation window.',
        'Persisted 4 new items to the feed.',
      ],
    };

    try {
      const markup = renderToStaticMarkup(
        <GroupDetailView
          groupId="notifications"
          groupType="notification"
          title="Notifications"
          items={[item]}
          onClose={() => {}}
          onNotificationDismiss={() => {}}
        />,
      );

      assert.match(markup, /Task curation-123/);
      assert.match(markup, /Completed/);
      assert.match(markup, /Queued curation finished and persisted new feed items\./);
      assert.match(markup, /Persisted 4 new items to the feed\./);
      assert.match(markup, /<time[^>]*dateTime=\"2026-03-29T11:58:00.000Z\"[^>]*>2m<\/time>/);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
