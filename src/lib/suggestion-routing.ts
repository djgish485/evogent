import { isCurrentSuggestionStatus } from '@/lib/feed-groups';
import { readTrimmedMetadataString } from '@/lib/feed-normalize';
import { getFeedSuggestionDefaultTitle, getFeedSuggestionTypeBadgeLabel, getSuggestionStatusLabel, isCodeFixSuggestion } from '@/lib/feed-suggestions';
import { type ConversationSessionSummary } from '@/types/conversation';
import { type FeedItem, type SuggestionStatus } from '@/types/feed';

export interface SuggestionChatContextPayload {
  message: string;
  context: string;
}

export type SuggestionChatDestination = {
  mode: 'origin';
  sessionId: string;
} | {
  mode: 'fallback';
  sessionId: string | null;
  reason: string;
};

export function getSuggestionOriginSessionId(item: FeedItem): string | null {
  return readTrimmedMetadataString(item.originSessionId)
    ?? readTrimmedMetadataString(item.metadata?.originSessionId);
}

export function getFirstMetadataString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() ? value.trim() : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  for (const entry of value) {
    const trimmed = readTrimmedMetadataString(entry);
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

export function getSuggestionSourceReference(items: FeedItem[]): string {
  for (const item of items) {
    const feedId = getFirstMetadataString(item.metadata?.feedIds);
    const sourceUrl = getFirstMetadataString(item.metadata?.sourceUrls);
    if (feedId && sourceUrl) {
      return `${feedId} / ${sourceUrl}`;
    }
    if (feedId) {
      return feedId;
    }
    if (sourceUrl) {
      return sourceUrl;
    }
    if (item.sourceId?.trim()) {
      return item.sourceId.trim();
    }
    if (item.url?.trim()) {
      return item.url.trim();
    }
    if (item.id.trim()) {
      return item.id.trim();
    }
  }
  return 'unknown';
}

export function buildSuggestionChatFallbackReason(items: FeedItem[], originSessionIds: string[]): string {
  const sourceReference = getSuggestionSourceReference(items);
  const sourceSuffix = ` Source: ${sourceReference}.`;

  if (originSessionIds.length > 0) {
    if (items.length === 1 && originSessionIds.length === 1) {
      return `This suggestion was discussed in origin session ${originSessionIds[0]}, but that session is not currently available.${sourceSuffix}`;
    }
    return `These suggestions do not share one available origin chat session (${originSessionIds.join(', ')}).${sourceSuffix}`;
  }

  if (items.length === 1) {
    return `This suggestion does not have an origin chat session. It likely came from the enrichment pipeline.${sourceSuffix}`;
  }

  return `These suggestions do not have an origin chat session. They likely came from the enrichment pipeline.${sourceSuffix}`;
}

export function resolveSuggestionChatDestination({
  items,
  conversationSessions,
  targetSessionId,
}: {
  items: FeedItem[];
  conversationSessions: Pick<ConversationSessionSummary, 'sessionId'>[];
  targetSessionId: string | null;
}): SuggestionChatDestination {
  const sessionIds = new Set(conversationSessions.map((session) => session.sessionId));
  const originSessionIdsByItem = items.map((item) => getSuggestionOriginSessionId(item));
  const uniqueOriginSessionIds = Array.from(new Set(
    originSessionIdsByItem.filter((sessionId): sessionId is string => Boolean(sessionId)),
  ));
  const singleOriginSessionId = uniqueOriginSessionIds.length === 1 ? uniqueOriginSessionIds[0] : null;
  const everyItemUsesSingleOrigin = Boolean(singleOriginSessionId)
    && originSessionIdsByItem.length > 0
    && originSessionIdsByItem.every((sessionId) => sessionId === singleOriginSessionId);

  if (singleOriginSessionId && everyItemUsesSingleOrigin && sessionIds.has(singleOriginSessionId)) {
    return {
      mode: 'origin',
      sessionId: singleOriginSessionId,
    };
  }

  return {
    mode: 'fallback',
    sessionId: targetSessionId,
    reason: buildSuggestionChatFallbackReason(items, uniqueOriginSessionIds),
  };
}

export function applySuggestionChatFallbackReason(
  payload: SuggestionChatContextPayload,
  reason: string,
): SuggestionChatContextPayload {
  return {
    message: `${reason}\n\n${payload.message}`,
    context: `${reason}\n\n${payload.context}`,
  };
}

export function getSuggestionChatContext(item: FeedItem, status: SuggestionStatus): SuggestionChatContextPayload {
  const title = item.title?.trim() || getFeedSuggestionDefaultTitle(item);
  const summary = item.text.trim() || 'No summary provided.';
  const proposedValue = typeof item.metadata?.proposedValue === 'string' && item.metadata.proposedValue.trim()
    ? item.metadata.proposedValue.trim()
    : summary;
  const suggestionLabel = getFeedSuggestionTypeBadgeLabel(item);
  const messageLabel = isCodeFixSuggestion(item) ? 'code fix suggestion' : 'suggestion';

  return {
    message: `Let's discuss ${messageLabel} ${item.id} (${title}).\n\n`,
    context: [
      `${suggestionLabel} context:`,
      `Suggestion ID: ${item.id}`,
      `Type: ${suggestionLabel}`,
      `Title: ${title}`,
      `Status: ${getSuggestionStatusLabel(status)}`,
      `Summary: ${summary}`,
      `Proposed value: ${proposedValue}`,
    ].join('\n'),
  };
}

export function getGroupedCodeFixSuggestionChatContext(
  items: FeedItem[],
  resolveSuggestionStatus: (item: FeedItem) => SuggestionStatus,
): SuggestionChatContextPayload | null {
  const codeFixItems = items.filter((item) => isCodeFixSuggestion(item));
  const currentCodeFixItems = codeFixItems.filter((item) => isCurrentSuggestionStatus(resolveSuggestionStatus(item)));
  const focusItems = (currentCodeFixItems.length > 0 ? currentCodeFixItems : codeFixItems).slice(0, 6);

  if (focusItems.length === 0) {
    return null;
  }

  const lines = [
    'Code fix suggestion group context:',
    `Focused suggestions: ${focusItems.length}`,
  ];

  for (const item of focusItems) {
    const status = resolveSuggestionStatus(item);
    const title = item.title?.trim() || getFeedSuggestionDefaultTitle(item);
    const summary = item.text.trim() || 'No summary provided.';
    const proposedValue = typeof item.metadata?.proposedValue === 'string' && item.metadata.proposedValue.trim()
      ? item.metadata.proposedValue.trim()
      : summary;

    lines.push('');
    lines.push(`Suggestion ID: ${item.id}`);
    lines.push(`Title: ${title}`);
    lines.push(`Status: ${getSuggestionStatusLabel(status)}`);
    lines.push(`Summary: ${summary}`);
    lines.push(`Proposed value: ${proposedValue}`);
  }

  const totalFocusedCount = currentCodeFixItems.length > 0 ? currentCodeFixItems.length : codeFixItems.length;
  const remainingCount = totalFocusedCount - focusItems.length;
  if (remainingCount > 0) {
    lines.push('');
    lines.push(`${remainingCount} additional code fix suggestion${remainingCount === 1 ? '' : 's'} omitted for brevity.`);
  }

  return {
    message: `Let's review the current code fix suggestions.\n\n`,
    context: lines.join('\n'),
  };
}
