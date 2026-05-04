import { NextResponse } from 'next/server';
import { getFeedItemsByThreadId, hydrateFeedItemsForList } from '@/lib/db/feed';
import { enrichFeedItemsWithNotificationTaskContext } from '@/lib/notification-task-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const items = getFeedItemsByThreadId(threadId);

  return NextResponse.json(
    await enrichFeedItemsWithNotificationTaskContext(hydrateFeedItemsForList(items)),
  );
}
