import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupedItemsCard, type StatusCounts } from './grouped-items-card';
import type { FeedItem } from '@/types/feed';

function createSuggestionItem(id: string, overrides: Partial<FeedItem> = {}): FeedItem {
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
      proposedValue: 'Restore grouped suggestion detail behavior.',
    },
    publishedAt: '2026-03-27T00:00:00.000Z',
    createdAt: '2026-03-27T00:00:00.000Z',
    ...overrides,
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
    metadata: {
      severity,
      dismissable: true,
    },
    publishedAt: createdAt,
    createdAt,
  };
}

function renderSuggestionCardWithStatusCounts(statusCounts: StatusCounts): string {
  const itemCount = Object.values(statusCounts).reduce((total, count) => total + count, 0);

  return renderToStaticMarkup(
    <GroupedItemsCard
      groupId="group-header-count"
      groupType="suggestion"
      title="Suggestions"
      summary="Suggestions"
      items={[]}
      itemCount={itemCount}
      statusCounts={statusCounts}
      onOpenDetail={() => {}}
      resolveSuggestionStatus={(item) => item.suggestionStatus ?? 'pending'}
    />,
  );
}

describe('GroupedItemsCard', () => {
  test('renders only active suggestion rows and keeps completed totals in the status summary', () => {
    const suggestionOne = createSuggestionItem('suggestion-1');
    const suggestionTwo = createSuggestionItem('suggestion-2');
    const suggestionThree = createSuggestionItem('suggestion-3');
    suggestionOne.title = 'Pending fix 1';
    suggestionTwo.title = 'Pending fix 2';
    suggestionThree.title = 'Merged fix 3';
    suggestionThree.suggestionStatus = 'merged';

    const markup = renderToStaticMarkup(
      <GroupedItemsCard
        groupId="group-1"
        groupType="suggestion"
        title="Suggestions"
        summary="3 open suggestions need review."
        items={[suggestionOne, suggestionTwo, suggestionThree]}
        previewItems={[suggestionOne]}
        itemCount={3}
        statusCounts={{
          pending: 2,
          dispatched: 0,
          running: 0,
          merged: 1,
          failed: 0,
          accepted: 0,
        }}
        onOpenDetail={() => {}}
        resolveSuggestionStatus={(item) => item.suggestionStatus ?? 'pending'}
      />,
    );

    assert.match(markup, /grouped-items-open-detail/);
    assert.match(markup, /<p class="truncate font-semibold text-zinc-100">2 pending<\/p>/);
    assert.doesNotMatch(markup, />Evogent</);
    assert.doesNotMatch(markup, /<p class=\"truncate text-zinc-500\">Suggestions<\/p>/);
    assert.match(markup, /Pending fix 1/);
    assert.match(markup, /Pending fix 2/);
    assert.doesNotMatch(markup, /Merged fix 3/);
    assert.doesNotMatch(markup, /<h3/);
    assert.match(markup, />Needs review</);
    assert.match(markup, /1 merged/);
    assert.equal(markup.match(/data-testid=\"grouped-suggestion-row\"/g)?.length ?? 0, 2);
    assert.doesNotMatch(markup, /3 open suggestions need review\./);
    assert.doesNotMatch(markup, /line-clamp-4/);
    assert.doesNotMatch(markup, /\+1 more/);
    assert.doesNotMatch(markup, /grouped-suggestion-chat-button/);
    assert.doesNotMatch(markup, /Chat with agent/);
  });

  test('uses actionable status counts in suggestion headers', () => {
    const cases: Array<{ label: string; statusCounts: StatusCounts; expected: string; unexpected?: string }> = [
      { label: 'pending dominant', statusCounts: { pending: 3, dispatched: 1, running: 0, merged: 2, failed: 4, accepted: 0 }, expected: '3 pending', unexpected: '10 suggestions' },
      { label: 'failed dominant', statusCounts: { pending: 0, dispatched: 1, running: 2, merged: 0, failed: 4, accepted: 0 }, expected: '4 failed' },
      { label: 'in-progress dominant', statusCounts: { pending: 0, dispatched: 2, running: 3, merged: 1, failed: 0, accepted: 0 }, expected: '5 in progress' },
      { label: 'only resolved', statusCounts: { pending: 0, dispatched: 0, running: 0, merged: 2, failed: 0, accepted: 1 }, expected: '3 recent', unexpected: '0 pending' },
    ];

    for (const { label, statusCounts, expected, unexpected } of cases) {
      const markup = renderSuggestionCardWithStatusCounts(statusCounts);
      assert.match(markup, new RegExp(`<p class="truncate font-semibold text-zinc-100">${expected}</p>`), label);
      if (unexpected) {
        assert.doesNotMatch(markup, new RegExp(`<p class="truncate font-semibold text-zinc-100">${unexpected}</p>`), label);
      }
    }
  });

  test('counts only hidden active suggestions in the preview overflow row', () => {
    const activeItems = Array.from({ length: 9 }, (_, index) => {
      const item = createSuggestionItem(`active-${index + 1}`);
      item.title = `Active suggestion ${index + 1}`;
      item.suggestionStatus = index >= 7 ? 'running' : 'pending';
      return item;
    });
    const mergedItems = Array.from({ length: 4 }, (_, index) => {
      const item = createSuggestionItem(`merged-${index + 1}`);
      item.title = `Merged suggestion ${index + 1}`;
      item.suggestionStatus = 'merged';
      return item;
    });

    const markup = renderToStaticMarkup(
      <GroupedItemsCard
        groupId="group-active-overflow"
        groupType="suggestion"
        title="Suggestions"
        summary="13 suggestions"
        items={[...activeItems, ...mergedItems]}
        itemCount={13}
        statusCounts={{
          pending: 7,
          dispatched: 0,
          running: 2,
          merged: 4,
          failed: 0,
          accepted: 0,
        }}
        onOpenDetail={() => {}}
        resolveSuggestionStatus={(item) => item.suggestionStatus ?? 'pending'}
      />,
    );

    assert.equal(markup.match(/data-testid=\"grouped-suggestion-row\"/g)?.length ?? 0, 4);
    assert.match(markup, /\+5 more/);
    assert.doesNotMatch(markup, /Merged suggestion 1/);
    assert.match(markup, /4 merged/);
    assert.match(markup, /2 in progress/);
  });

  test('falls back to recent completed suggestions when no active rows remain', () => {
    const completedItems = Array.from({ length: 4 }, (_, index) => {
      const item = createSuggestionItem(`merged-${index + 1}`);
      item.title = `Merged fix ${index + 1}`;
      item.suggestionStatus = 'merged';
      return item;
    });

    const markup = renderToStaticMarkup(
      <GroupedItemsCard
        groupId="group-recent-updates"
        groupType="suggestion"
        title="Suggestions"
        summary="4 merged suggestions"
        items={completedItems}
        itemCount={4}
        statusCounts={{
          pending: 0,
          dispatched: 0,
          running: 0,
          merged: 4,
          failed: 0,
          accepted: 0,
        }}
        onOpenDetail={() => {}}
        resolveSuggestionStatus={(item) => item.suggestionStatus ?? 'pending'}
      />,
    );

    assert.match(markup, /Merged fix 1/);
    assert.match(markup, /Merged fix 2/);
    assert.match(markup, /Merged fix 3/);
    assert.doesNotMatch(markup, /Merged fix 4/);
    assert.doesNotMatch(markup, /<h3/);
    assert.equal(markup.match(/data-testid=\"grouped-suggestion-row\"/g)?.length ?? 0, 3);
    assert.doesNotMatch(markup, /\+\d+ more/);
  });

  test('renders per-notification relative timestamps in grouped preview rows', () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.parse('2026-03-29T12:00:00.000Z');

    try {
      const newest = createNotificationItem('notification-1', 'error', '2026-03-29T11:54:00.000Z');
      const older = createNotificationItem('notification-2', 'warning', '2026-03-29T09:00:00.000Z');
      const markup = renderToStaticMarkup(
        <GroupedItemsCard
          groupId="notifications"
          groupType="notification"
          title="Notifications"
          summary="2 notifications need attention."
          items={[newest, older]}
          itemCount={2}
          timestamp={newest.createdAt}
          onOpenDetail={() => {}}
        />,
      );

      assert.match(markup, /Notification notification-1/);
      assert.match(markup, /Notification notification-2/);
      assert.match(markup, /Error/);
      assert.match(markup, /Warning/);
      assert.match(markup, /<time[^>]*dateTime=\"2026-03-29T11:54:00.000Z\"[^>]*>6m<\/time>/);
      assert.match(markup, /<time[^>]*dateTime=\"2026-03-29T09:00:00.000Z\"[^>]*>3h<\/time>/);
      assert.doesNotMatch(markup, /2 notifications need attention\./);
      assert.doesNotMatch(markup, /<h3/);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
