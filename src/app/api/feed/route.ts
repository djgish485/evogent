import { NextResponse } from 'next/server';
import {
  getFeedPage,
  getPendingFeedCounts,
  hydrateFeedItemsForList,
  getSuggestionFeedGroup,
} from '@/lib/db/feed';
import { getChatSessionSearchMatches } from '@/lib/db/chat-search';
import { parseLimit, parseOffset, parseSearchQuery, parseSort, parseSourceFilter, parseTypeFilter } from '@/lib/feed-query';
import { enrichFeedItemsWithNotificationTaskContext } from '@/lib/notification-task-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const offset = parseOffset(searchParams.get('offset'));
  const limit = parseLimit(searchParams.get('limit'));
  const types = parseTypeFilter(searchParams.get('type'));
  const sources = parseSourceFilter(searchParams.get('source'));
  const sort = parseSort(searchParams.get('sort'));
  const search = parseSearchQuery(searchParams.get('q'));

  const page = getFeedPage({ offset, limit, types, sources, sort, search });
  const items = await enrichFeedItemsWithNotificationTaskContext(hydrateFeedItemsForList(page.items));
  const pendingCounts = getPendingFeedCounts();
  const suggestionGroup = getSuggestionFeedGroup({ offset, limit, types, sources, sort, search });
  const chatSessionMatches = search && offset === 0 && types.length === 0 && sources.length === 0
    ? getChatSessionSearchMatches(search)
    : [];

  return NextResponse.json({
    items,
    total: page.total,
    offset,
    limit,
    hasMore: page.hasMore,
    pendingCounts,
    suggestionGroup,
    chatSessionMatches,
  });
}
