import { NextResponse } from 'next/server';
import {
  getFeedItemById,
  getFeedItemBySourceId,
  setFeedItemSuggestionStatus,
} from '@/lib/db/feed';
import { notifyFeedUpdate } from '@/lib/curation-submit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const body = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
  const feedItemId = typeof body.feedItemId === 'string' ? body.feedItemId.trim() : '';
  const notificationId = typeof body.notificationId === 'string' ? body.notificationId.trim() : '';
  if (!feedItemId && !notificationId) {
    return NextResponse.json({ error: 'feedItemId or notificationId is required' }, { status: 400 });
  }

  const item = feedItemId
    ? getFeedItemById(feedItemId)
    : getFeedItemBySourceId(notificationId);
  if (!item || item.type !== 'notification') {
    return NextResponse.json({ ok: true, resolved: false });
  }

  setFeedItemSuggestionStatus(item.id, 'dismissed');
  const updated = getFeedItemById(item.id);
  if (updated) {
    await notifyFeedUpdate([updated]);
  }

  return NextResponse.json({ ok: true, resolved: true, feedItemId: item.id });
}
