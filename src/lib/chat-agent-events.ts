import type { ChatMessage } from '@/types/chat';

type AgentEventLike = Pick<ChatMessage, 'type' | 'inReplyTo' | 'sessionId' | 'metadata'>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readTrimmedString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasStringValue(record: Record<string, unknown> | null, key: string): boolean {
  return readTrimmedString(record, key) !== null;
}

export function shouldDisplayAgentEventInChat(message: AgentEventLike): boolean {
  if (message.type !== 'agent_event') {
    return true;
  }

  const metadata = asRecord(message.metadata);
  if (!metadata) {
    return false;
  }

  const source = readTrimmedString(metadata, 'source');
  const event = readTrimmedString(metadata, 'event');
  const status = readTrimmedString(metadata, 'status');
  const severity = readTrimmedString(metadata, 'severity');
  const sessionId = typeof message.sessionId === 'string' && message.sessionId.trim()
    ? message.sessionId.trim()
    : readTrimmedString(metadata, 'sessionId');
  const hasReplyTarget = typeof message.inReplyTo === 'string' && message.inReplyTo.trim().length > 0;
  const targetsConversation = hasReplyTarget || sessionId !== null || hasStringValue(metadata, 'originSessionId');
  const hasSuggestionPayload = event === 'chat_suggestion'
    || hasStringValue(metadata, 'suggestionId')
    || hasStringValue(metadata, 'suggestionType')
    || hasStringValue(metadata, 'proposedValue');

  if (source === 'chat_progress' || hasStringValue(metadata, 'progressKind')) {
    return true;
  }

  if (metadata.chatVisible === true || metadata.actionable === true || metadata.requiresAction === true) {
    return true;
  }

  if (hasSuggestionPayload) {
    return true;
  }

  const failureLike = status === 'failed'
    || status === 'cancelled'
    || severity === 'warning'
    || severity === 'error'
    || metadata.isError === true
    || hasStringValue(metadata, 'error');

  if (failureLike) {
    return true;
  }

  if (!targetsConversation) {
    return false;
  }

  const routineLifecycleEvent = event !== null
    && /(?:^|_)(started|running|queued|completed|finished|succeeded|success|done)$/.test(event);
  const routineStatus = status === 'running' || status === 'queued' || status === 'completed';

  if (routineLifecycleEvent || routineStatus) {
    return false;
  }

  return false;
}
