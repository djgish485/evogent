import { NextResponse } from 'next/server';
import {
  getFeedPage,
  getActiveFeedThreads,
  getLastArrangeAtMs,
  getPendingFeedCounts,
  hydrateFeedItemsForList,
  getSuggestionFeedGroup,
} from '@/lib/db/feed';
import { getChatSessionSearchMatches } from '@/lib/db/chat-search';
import { parseLimit, parseOffset, parseSearchQuery, parseSort, parseSourceFilter, parseThreadFilter, parseTypeFilter } from '@/lib/feed-query';
import { enrichFeedItemsWithNotificationTaskContext } from '@/lib/notification-task-context';
import { getThreadDisplayGroupKey, normalizeThreadDisplayPart } from '@/lib/thread-display';
import type { FeedItem, FeedThread } from '@/types/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FEED_THREAD_NAVIGATION_LIMIT = 100;
const FEED_THREAD_NAVIGATION_MAX_ENTRIES = 12;

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function getThreadNavigationGroupKey(input: {
  threadId: string;
  title?: string | null;
  subtitle?: string | null;
}): string {
  const normalizedTitle = normalizeThreadDisplayPart(input.title);
  if (normalizedTitle === 'one-offs') {
    return `display:${normalizedTitle}`;
  }

  return getThreadDisplayGroupKey(input);
}

function buildFeedThreadNavigation(items: FeedItem[], fallbackThreads: FeedThread[]): FeedThread[] {
  const fallbackThreadById = new Map(fallbackThreads.map((thread) => [thread.id, thread]));
  const entries = new Map<string, {
    thread: FeedThread;
    threadIds: string[];
    firstIndex: number;
    latestTimestampMs: number;
  }>();

  items.forEach((item, index) => {
    const threadId = item.threadId?.trim()
      || readTrimmedString(item.metadata?.thread?.threadId)
      || readTrimmedString(item.metadata?.threadId);
    if (!threadId) return;

    const fallbackThread = fallbackThreadById.get(threadId);
    const title = item.threadTitle?.trim()
      || readTrimmedString(item.metadata?.thread?.threadTitle)
      || readTrimmedString(item.metadata?.threadTitle)
      || fallbackThread?.title?.trim()
      || threadId;
    const subtitle = item.threadSubtitle?.trim()
      || readTrimmedString(item.metadata?.thread?.threadRationale)
      || readTrimmedString(item.metadata?.threadRationale)
      || fallbackThread?.subtitle?.trim()
      || null;
    const displayGroupKey = getThreadNavigationGroupKey({ threadId, title, subtitle });
    const timestampMs = parseTimestampMs(item.createdAt)
      ?? parseTimestampMs(item.publishedAt)
      ?? fallbackThread?.updatedAtMs
      ?? Date.now();
    const existing = entries.get(displayGroupKey);

    if (!existing) {
      entries.set(displayGroupKey, {
        thread: {
          id: threadId,
          threadIds: [threadId],
          title,
          subtitle,
          createdAtMs: fallbackThread?.createdAtMs ?? timestampMs,
          updatedAtMs: Math.max(fallbackThread?.updatedAtMs ?? timestampMs, timestampMs),
          active: true,
        },
        threadIds: [threadId],
        firstIndex: index,
        latestTimestampMs: timestampMs,
      });
      return;
    }

    existing.latestTimestampMs = Math.max(existing.latestTimestampMs, timestampMs);
    existing.thread.updatedAtMs = Math.max(existing.thread.updatedAtMs, timestampMs);
    if (!existing.threadIds.includes(threadId)) {
      existing.threadIds.push(threadId);
      existing.thread.threadIds = [...existing.threadIds];
    }
    if (!existing.thread.subtitle && subtitle) {
      existing.thread.subtitle = subtitle;
    }
  });

  if (entries.size === 0) {
    return fallbackThreads.filter((thread) => thread.active);
  }

  return Array.from(entries.values())
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .slice(0, FEED_THREAD_NAVIGATION_MAX_ENTRIES)
    .map((entry) => entry.thread);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const offset = parseOffset(searchParams.get('offset'));
  const limit = parseLimit(searchParams.get('limit'));
  const types = parseTypeFilter(searchParams.get('type'));
  const sources = parseSourceFilter(searchParams.get('source'));
  const sort = parseSort(searchParams.get('sort'));
  const search = parseSearchQuery(searchParams.get('q'));
  const threadId = parseThreadFilter(searchParams.get('thread'));
  const lastArrangeAtMs = getLastArrangeAtMs();
  const orderFreshness = { lastArrangeAtMs };

  const page = getFeedPage({ offset, limit, types, sources, sort, search, threadId }, orderFreshness);
  const items = await enrichFeedItemsWithNotificationTaskContext(hydrateFeedItemsForList(page.items));
  const pendingCounts = getPendingFeedCounts();
  const suggestionGroup = getSuggestionFeedGroup({ offset, limit, types, sources, sort, search, threadId }, orderFreshness);
  const chatSessionMatches = search && offset === 0 && types.length === 0 && sources.length === 0
    ? getChatSessionSearchMatches(search)
    : [];
  const storedActiveThreads = getActiveFeedThreads();
  const threadNavigationPage = getFeedPage({
    offset: 0,
    limit: FEED_THREAD_NAVIGATION_LIMIT,
    types: [],
    sources: [],
    sort,
    search: null,
    threadId: null,
  }, orderFreshness);
  const activeThreads = buildFeedThreadNavigation(threadNavigationPage.items, storedActiveThreads);

  return NextResponse.json({
    items,
    total: page.total,
    offset,
    limit,
    hasMore: page.hasMore,
    pendingCounts,
    suggestionGroup,
    chatSessionMatches,
    activeThreads,
    lastArrangeAtMs,
  });
}
