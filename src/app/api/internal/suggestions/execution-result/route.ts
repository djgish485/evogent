import { NextResponse } from 'next/server';
import { getFeedItemById, setFeedItemSuggestionStatus } from '@/lib/db/feed';

/**
 * The report-back half of approve-to-execute: the life-actions agent POSTs its outcome here
 * and the originating card renders it. Without this, an approved action's only output landed
 * in a retired chat session — the user saw a button vanish and nothing happen.
 */
export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const feedItemId = typeof payload.feedItemId === 'string' ? payload.feedItemId.trim() : '';
  const statusRaw = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  const result = typeof payload.result === 'string' ? payload.result.trim() : '';
  const resultUrlRaw = typeof payload.resultUrl === 'string' ? payload.resultUrl.trim() : '';

  if (!feedItemId || !getFeedItemById(feedItemId)) {
    return NextResponse.json({ error: 'Unknown feedItemId' }, { status: 404 });
  }
  if (!['completed', 'blocked', 'failed'].includes(statusRaw)) {
    return NextResponse.json({ error: 'status must be completed, blocked, or failed' }, { status: 400 });
  }
  if (!result) {
    return NextResponse.json({ error: 'result text is required — it is what the user reads on the card' }, { status: 400 });
  }
  // Only tappable schemes; a mailto: opens the mail app's compose with the draft prefilled.
  const resultUrl = /^(https?:|mailto:)/i.test(resultUrlRaw) ? resultUrlRaw : null;

  setFeedItemSuggestionStatus(
    feedItemId,
    statusRaw === 'failed' ? 'failed' : 'accepted',
    {
      executionResult: result,
      executionResultStatus: statusRaw,
      ...(resultUrl ? { executionResultUrl: resultUrl } : {}),
      executionResultAtMs: Date.now(),
    },
  );
  // No push needed: the client's foreground reconcile / pull-to-refresh picks up the card
  // change, and the flip from "Working on it" to the result happens on the next feed read.
  return NextResponse.json({ ok: true });
}
