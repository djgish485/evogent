import { type ChatMessage } from '@/types/chat';
import { type FeedItem, type SuggestionStatus } from '@/types/feed';

export interface InlineCodeFixChatSuggestion {
  id: string;
  title: string;
  summary: string;
  suggestionType: 'code_fix';
  proposedValue: string;
  status: SuggestionStatus;
}

export function buildInlineCodeFixChatMessage({
  originSessionId,
  suggestion,
  timestamp,
}: {
  originSessionId: string;
  suggestion: InlineCodeFixChatSuggestion;
  timestamp?: string;
}): ChatMessage {
  const createdAt = timestamp && timestamp.trim() ? timestamp : new Date().toISOString();

  return {
    type: 'agent_event',
    id: `chat-suggestion:${suggestion.id}`,
    role: 'agent',
    inReplyTo: null,
    sessionId: originSessionId,
    text: suggestion.summary,
    timestamp: createdAt,
    context: null,
    status: 'delivered',
    metadata: {
      event: 'chat_suggestion',
      originSessionId,
      suggestionId: suggestion.id,
      suggestionTitle: suggestion.title,
      suggestionSummary: suggestion.summary,
      suggestionType: suggestion.suggestionType,
      proposedValue: suggestion.proposedValue,
      suggestionStatus: suggestion.status,
    },
    createdAt,
  };
}

export function buildInlineCodeFixChatSummary(item: FeedItem): string {
  const rawSummary = item.text.replace(/\s+/g, ' ').trim()
    || (typeof item.metadata?.proposedValue === 'string' ? item.metadata.proposedValue.replace(/\s+/g, ' ').trim() : '');
  if (!rawSummary) {
    return 'Suggested code fix';
  }

  const firstSentenceMatch = rawSummary.match(/^.+?[.!?](?=\s|$)/);
  const firstLine = (firstSentenceMatch?.[0] ?? rawSummary).trim();
  if (firstLine.length <= 140) {
    return firstLine;
  }

  return `${firstLine.slice(0, 137).trimEnd()}...`;
}

export function buildInlineCodeFixSuggestionFromFeedItem(item: FeedItem): InlineCodeFixChatSuggestion | null {
  const suggestionType = typeof item.metadata?.suggestionType === 'string'
    ? item.metadata.suggestionType.trim().toLowerCase()
    : '';
  const proposedValue = typeof item.metadata?.proposedValue === 'string'
    ? item.metadata.proposedValue.trim()
    : '';

  if (item.type !== 'suggestion' || suggestionType !== 'code_fix' || !proposedValue) {
    return null;
  }

  return {
    id: item.id,
    title: item.title?.trim() || 'Suggested code fix',
    summary: buildInlineCodeFixChatSummary(item),
    suggestionType: 'code_fix',
    proposedValue,
    status: item.suggestionStatus ?? 'pending',
  };
}

export function buildInlineCodeFixChatMessagesFromFeedItems(feedItems: FeedItem[]): ChatMessage[] {
  return feedItems.flatMap((item) => {
    const sessionId = typeof item.originSessionId === 'string' ? item.originSessionId.trim() : '';
    const suggestion = buildInlineCodeFixSuggestionFromFeedItem(item);

    if (!sessionId || !suggestion) {
      return [];
    }

    return [
      buildInlineCodeFixChatMessage({
        originSessionId: sessionId,
        suggestion,
        timestamp: item.createdAt,
      }),
    ];
  });
}

export function getInlineCodeFixSuggestion(message: ChatMessage): InlineCodeFixChatSuggestion | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  if (metadata.event !== 'chat_suggestion') {
    return null;
  }

  const id = typeof metadata.suggestionId === 'string' ? metadata.suggestionId.trim() : '';
  const title = typeof metadata.suggestionTitle === 'string' ? metadata.suggestionTitle.trim() : '';
  const summary = typeof metadata.suggestionSummary === 'string' ? metadata.suggestionSummary.trim() : '';
  const suggestionType = typeof metadata.suggestionType === 'string' ? metadata.suggestionType.trim().toLowerCase() : '';
  const proposedValue = typeof metadata.proposedValue === 'string' ? metadata.proposedValue.trim() : '';
  const status = typeof metadata.suggestionStatus === 'string' ? metadata.suggestionStatus.trim().toLowerCase() : 'pending';

  if (!id || !title || !summary || suggestionType !== 'code_fix' || !proposedValue) {
    return null;
  }

  const normalizedStatus: SuggestionStatus = status === 'accepted'
    || status === 'dismissed'
    || status === 'dispatched'
    || status === 'running'
    || status === 'merged'
    || status === 'failed'
    ? status
    : 'pending';

  return {
    id,
    title,
    summary,
    suggestionType: 'code_fix',
    proposedValue,
    status: normalizedStatus,
  };
}
