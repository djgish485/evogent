import { CHAT_SESSION_COMPACTION_STALE_TIMEOUT_MS } from '@/lib/page-constants';

export type SessionCompactionPhase = 'queued' | 'running';

export interface ChatSessionCompactionState {
  phase: SessionCompactionPhase;
  updatedAt: number;
}

export interface CompactFeedbackState {
  id: number;
  tone: 'info' | 'error';
  message: string;
  sessionId: string | null;
}

export function isChatSessionCompactionStateStale(
  state: ChatSessionCompactionState | null | undefined,
  now = Date.now(),
): boolean {
  if (!state || !Number.isFinite(state.updatedAt)) {
    return true;
  }

  return now - state.updatedAt >= CHAT_SESSION_COMPACTION_STALE_TIMEOUT_MS;
}
