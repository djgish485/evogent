import { NextResponse } from 'next/server';
import { getFeedItemsByThreadId, hydrateFeedItemsForList } from '@/lib/db/feed';
import { enrichFeedItemsWithNotificationTaskContext } from '@/lib/notification-task-context';
import {
  filterPhoneNotificationAgentEvidence,
  isPhoneNotificationFeedItem,
  isRuntimeAgentEvidenceRequest,
} from '@/lib/agent-evidence-boundary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const items = getFeedItemsByThreadId(threadId);
  const evidenceItems = isRuntimeAgentEvidenceRequest(request)
    ? items.filter((item) => !isPhoneNotificationFeedItem(item))
    : items;

  const hydratedItems = await enrichFeedItemsWithNotificationTaskContext(
    hydrateFeedItemsForList(evidenceItems),
  );
  return NextResponse.json(
    isRuntimeAgentEvidenceRequest(request)
      ? filterPhoneNotificationAgentEvidence(hydratedItems)
      : hydratedItems,
  );
}
