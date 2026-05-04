import { NextResponse } from 'next/server';
import { getFeedItemById, setFeedItemSuggestionStatus, updateFeedItemFields } from '@/lib/db/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const body = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
  const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId.trim() : '';

  if (!suggestionId) {
    return NextResponse.json({ error: 'suggestionId is required' }, { status: 400 });
  }

  const item = getFeedItemById(suggestionId);
  if (!item) {
    return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
  }

  if (item.type !== 'suggestion') {
    return NextResponse.json({ error: 'Item is not a suggestion' }, { status: 400 });
  }

  // Reset the suggestion status to pending
  setFeedItemSuggestionStatus(suggestionId, 'pending');

  // Clear code fix metadata
  const previousTaskId = typeof item.metadata?.taskId === 'string' && item.metadata.taskId.trim()
    ? item.metadata.taskId.trim()
    : typeof item.metadata?.codeFixPreviousTaskId === 'string' && item.metadata.codeFixPreviousTaskId.trim()
      ? item.metadata.codeFixPreviousTaskId.trim()
      : null;
  updateFeedItemFields(suggestionId, {
    metadata: {
      suggestionStatus: 'pending',
      taskId: null,
      codeFixOrchestratorStatus: null,
      codeFixRetryOfTaskId: null,
      codeFixPreviousTaskId: previousTaskId,
    },
  });

  return NextResponse.json({ ok: true, suggestionId, status: 'pending' });
}
