import { getInternalBaseUrl } from '@/lib/internal-api';
import type { SuggestionStatus } from '@/types/feed';

interface CancelCodeFixWorkInput {
  suggestionId?: string | null;
  taskId?: string | null;
  suggestionStatus?: SuggestionStatus | null;
  reason?: string | null;
}

interface CancelCodeFixWorkResponse {
  ok: boolean;
  cancelled?: boolean;
  taskIds?: string[];
  suggestionIds?: string[];
  error?: string;
}

function normalizeString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function cancelCodeFixSuggestionWork(input: CancelCodeFixWorkInput): Promise<CancelCodeFixWorkResponse> {
  const suggestionId = normalizeString(input.suggestionId);
  const taskId = normalizeString(input.taskId);
  if (!suggestionId && !taskId) {
    return { ok: true, cancelled: false, taskIds: [], suggestionIds: [] };
  }

  const response = await fetch(`${getInternalBaseUrl()}/api/internal/code-fix-orchestrator/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({
      ...(suggestionId ? { suggestionId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(input.suggestionStatus ? { suggestionStatus: input.suggestionStatus } : {}),
      ...(normalizeString(input.reason) ? { reason: normalizeString(input.reason) } : {}),
    }),
  });

  const parsed = await response.json().catch(() => ({})) as CancelCodeFixWorkResponse;
  if (!response.ok) {
    const error = typeof parsed.error === 'string' && parsed.error.trim()
      ? parsed.error.trim()
      : 'Failed to cancel code-fix task';
    throw new Error(error);
  }

  return parsed;
}
