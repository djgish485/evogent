import { NextResponse } from 'next/server';
import { cancelBrowseCacheSource } from '@/lib/db/browse-cache';
import {
  getFeedItemById,
  getFeedItemBySourceId,
  setFeedItemSuggestionStatus,
} from '@/lib/db/feed';
import { notifyFeedUpdate } from '@/lib/curation-submit';
import { withFeedMutationLock } from '@/lib/feed-mutation-lock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function postUnlocked(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const source = (
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && typeof (payload as { source?: unknown }).source === 'string'
  )
    ? (payload as { source: string }).source.trim()
    : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
    return NextResponse.json(
      { ok: false, error: 'A canonical source slug is required' },
      { status: 400 },
    );
  }

  const cancellation = cancelBrowseCacheSource(source);
  const successNotice = getFeedItemBySourceId(`source-discovery-${source}`);
  let resolved = false;
  if (successNotice?.type === 'notification') {
    setFeedItemSuggestionStatus(successNotice.id, 'dismissed');
    const updated = getFeedItemById(successNotice.id);
    if (updated) {
      await notifyFeedUpdate([updated]);
    }
    resolved = true;
  }

  return NextResponse.json({
    ok: true,
    source,
    deleted: cancellation.deleted,
    stagedDeleted: cancellation.stagedDeleted,
    resolved,
    ...(resolved ? { feedItemId: successNotice?.id } : {}),
  });
}

export async function POST(request: Request) {
  return withFeedMutationLock(() => postUnlocked(request));
}
