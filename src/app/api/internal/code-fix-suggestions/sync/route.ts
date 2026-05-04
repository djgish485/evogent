import { NextResponse } from 'next/server';
import { cancelCodeFixSuggestionWork } from '@/lib/code-fix-orchestrator';
import { getFeedItemById, setFeedItemSuggestionStatus, updateFeedItemFields } from '@/lib/db/feed';
import { getFeedSuggestionType } from '@/lib/feed-suggestions';
import type { SuggestionStatus } from '@/types/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SuggestionSyncUpdate {
  id: string;
  suggestionStatus?: SuggestionStatus;
  taskId?: string | null;
  metadata?: Record<string, unknown>;
}

function normalizeUpdate(value: unknown): SuggestionSyncUpdate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    return null;
  }

  const update: SuggestionSyncUpdate = { id };

  if (typeof raw.suggestionStatus === 'string') {
    const suggestionStatus = raw.suggestionStatus.trim().toLowerCase();
    if (
      suggestionStatus === 'pending'
      || suggestionStatus === 'accepted'
      || suggestionStatus === 'dismissed'
      || suggestionStatus === 'dispatched'
      || suggestionStatus === 'running'
      || suggestionStatus === 'merged'
      || suggestionStatus === 'failed'
    ) {
      update.suggestionStatus = suggestionStatus;
    }
  }

  if (raw.taskId === null) {
    update.taskId = null;
  } else if (typeof raw.taskId === 'string' && raw.taskId.trim()) {
    update.taskId = raw.taskId.trim();
  }

  if (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    update.metadata = raw.metadata as Record<string, unknown>;
  }

  return update;
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const body = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
  const updates = Array.isArray(body.suggestions)
    ? body.suggestions.map(normalizeUpdate).filter((item): item is SuggestionSyncUpdate => item !== null)
    : [];

  if (updates.length === 0) {
    return NextResponse.json({ ok: false, error: 'suggestions must be a non-empty array' }, { status: 400 });
  }

  for (const update of updates) {
    const suggestion = getFeedItemById(update.id);
    const isCodeFixSuggestion = suggestion?.type === 'suggestion' && getFeedSuggestionType(suggestion) === 'code_fix';

    if (isCodeFixSuggestion && update.suggestionStatus === 'dismissed') {
      await cancelCodeFixSuggestionWork({
        suggestionId: update.id,
        taskId: update.taskId,
        suggestionStatus: 'dismissed',
        reason: 'Cancelled because the suggestion was dismissed during suggestion sync.',
      });
    }

    if (update.suggestionStatus) {
      setFeedItemSuggestionStatus(update.id, update.suggestionStatus);
    }

    const metadataUpdate: Record<string, unknown> = { ...update.metadata };
    if (update.taskId !== undefined) {
      metadataUpdate.taskId = update.taskId;
    }
    if (update.suggestionStatus) {
      metadataUpdate.suggestionStatus = update.suggestionStatus;
      metadataUpdate.codeFixOrchestratorStatus = update.suggestionStatus;
    }

    if (Object.keys(metadataUpdate).length > 0) {
      updateFeedItemFields(update.id, { metadata: metadataUpdate });
    }
  }

  return NextResponse.json({
    ok: true,
    updated: updates.length,
    suggestionIds: updates.map((item) => item.id),
  });
}
