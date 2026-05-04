import { NextResponse } from 'next/server';
import { toCodeFixSuggestionDescriptor } from '@/lib/feed-suggestions';
import type { CodeFixSuggestionDescriptor } from '@/lib/feed-suggestions';
import { getFeedItemById } from '@/lib/db/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BatchCodeFixResponse {
  ok?: boolean;
  taskId?: string | null;
  taskIds?: string[];
  agentCount?: number;
  suggestionStatus?: string;
}

export function normalizeBatchCodeFixSuggestionStatus(result: BatchCodeFixResponse): 'accepted' | 'dispatched' | 'running' {
  return result.suggestionStatus === 'running'
    ? 'running'
    : result.suggestionStatus === 'dispatched'
      ? 'dispatched'
      : 'accepted';
}

function normalizeSuggestionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const uniqueIds = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return [];
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      return [];
    }
    uniqueIds.add(trimmed);
  }

  return Array.from(uniqueIds);
}

function getInternalBaseUrl(): string {
  return process.env.ORCHESTRATOR_INTERNAL_URL
    ?? `http://127.0.0.1:${process.env.PORT || '3001'}`;
}

async function enqueueCodeFixSuggestions(payload: Record<string, unknown>): Promise<BatchCodeFixResponse> {
  const response = await fetch(`${getInternalBaseUrl()}/api/internal/code-fix-orchestrator/enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });

  const parsed = await response.json().catch(() => ({})) as BatchCodeFixResponse & { error?: string };
  if (!response.ok) {
    throw new Error(parsed.error || 'Failed to enqueue code fix suggestions');
  }

  return parsed;
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const body = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
  const suggestionIds = normalizeSuggestionIds(body.suggestionIds);

  if (suggestionIds.length === 0) {
    return NextResponse.json({ error: 'suggestionIds must be a non-empty array of strings' }, { status: 400 });
  }

  const suggestions: CodeFixSuggestionDescriptor[] = [];
  for (const suggestionId of suggestionIds) {
    const item = getFeedItemById(suggestionId);
    if (!item) {
      return NextResponse.json({ error: `Suggestion not found: ${suggestionId}` }, { status: 404 });
    }

    const normalized = toCodeFixSuggestionDescriptor(item);
    if (!normalized) {
      return NextResponse.json({
        error: `Suggestion ${suggestionId} must be type=suggestion with suggestionType=code_fix and proposedValue`,
      }, { status: 400 });
    }

    suggestions.push(normalized);
  }

  try {
    const result = await enqueueCodeFixSuggestions({
      suggestions,
    });

    const taskId = typeof result.taskId === 'string' ? result.taskId : null;
    const taskIds = Array.isArray(result.taskIds)
      ? result.taskIds.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const suggestionStatus = normalizeBatchCodeFixSuggestionStatus(result);

    return NextResponse.json({
      ok: true,
      ...(taskId ? { taskId } : {}),
      ...(taskIds.length > 0 ? { taskIds } : {}),
      agentCount: typeof result.agentCount === 'number' ? result.agentCount : taskIds.length,
      suggestionStatus,
    });
  } catch (error) {
    console.warn('[suggestions.batch-accept] code_fix dispatch failed', error);
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Failed to enqueue code fix suggestions';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
