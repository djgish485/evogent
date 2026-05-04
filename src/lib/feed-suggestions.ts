import { getCodeFixFailureFeedback } from '@/lib/code-fix-repair';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

export interface SuggestionApplyRequestBody {
  suggestionIds: string[];
}

export interface SuggestionApplyResponse {
  ok?: boolean;
  content?: string;
  error?: string;
  message?: string;
  taskId?: string;
  taskIds?: string[];
  agentCount?: number;
  suggestionStatus?: SuggestionStatus;
}

export interface CodeFixSuggestionDescriptor {
  id: string;
  suggestionId: string;
  feedItemId: string;
  originSessionId?: string;
  title: string;
  text: string;
  proposedValue: string;
  configFile?: string;
}

const SUGGESTION_GROUP_PREVIEW_MAX_LENGTH = 80;

export function getFeedSuggestionType(item: FeedItem): string {
  return typeof item.metadata?.suggestionType === 'string'
    ? item.metadata.suggestionType.trim().toLowerCase()
    : '';
}

export function isCodeFixSuggestion(item: FeedItem): boolean {
  return getFeedSuggestionType(item) === 'code_fix';
}

export function toCodeFixSuggestionDescriptor(item: FeedItem): CodeFixSuggestionDescriptor | null {
  if (item.type !== 'suggestion' || !isCodeFixSuggestion(item)) {
    return null;
  }

  const proposedValue = typeof item.metadata?.proposedValue === 'string'
    ? item.metadata.proposedValue.trim()
    : '';
  if (!proposedValue) {
    return null;
  }

  const configFile = typeof item.metadata?.configFile === 'string'
    ? item.metadata.configFile.trim()
    : '';
  const originSessionId = typeof item.originSessionId === 'string' && item.originSessionId.trim()
    ? item.originSessionId.trim()
    : typeof item.metadata?.originSessionId === 'string'
      ? item.metadata.originSessionId.trim()
      : '';

  return {
    id: item.id,
    suggestionId: item.id,
    feedItemId: item.id,
    ...(originSessionId ? { originSessionId } : {}),
    title: item.title?.trim() ?? '',
    text: item.text.trim(),
    proposedValue,
    ...(configFile ? { configFile } : {}),
  };
}

export function getFeedSuggestionLabel(item: FeedItem): string {
  if (isCodeFixSuggestion(item)) return 'Code Fix';
  return 'Suggestion';
}

export function getFeedSuggestionTypeBadgeLabel(item: FeedItem): string {
  if (isCodeFixSuggestion(item)) return 'Code Fix';
  return 'Suggestion';
}

export function getFeedSuggestionDefaultTitle(item: FeedItem): string {
  if (isCodeFixSuggestion(item)) return 'Suggested code fix';
  return 'Suggested update';
}

export function getFeedSuggestionGroupPreview(item: FeedItem): string {
  const normalizedText = item.text.replace(/\s+/g, ' ').trim();
  if (!normalizedText) {
    return '';
  }

  const firstSentenceMatch = normalizedText.match(/^.+?[.!?](?=\s|$)/);
  const firstSentence = firstSentenceMatch?.[0]?.trim() ?? normalizedText;
  if (firstSentence.length <= SUGGESTION_GROUP_PREVIEW_MAX_LENGTH) {
    return firstSentence;
  }

  if (normalizedText.length <= SUGGESTION_GROUP_PREVIEW_MAX_LENGTH) {
    return normalizedText;
  }

  const truncatedText = normalizedText
    .slice(0, SUGGESTION_GROUP_PREVIEW_MAX_LENGTH)
    .trimEnd()
    .replace(/[.,;:!?-]+$/u, '');

  return `${truncatedText}...`;
}

export function getFeedSuggestionBatchSummary(items: FeedItem[]): string {
  let codeFixCount = 0;
  let otherCount = 0;

  for (const item of items) {
    if (isCodeFixSuggestion(item)) {
      codeFixCount += 1;
      continue;
    }

    otherCount += 1;
  }

  const parts: string[] = [];
  if (codeFixCount > 0) {
    parts.push(`${codeFixCount} code fix${codeFixCount === 1 ? '' : 'es'}`);
  }
  if (otherCount > 0) {
    parts.push(`${otherCount} suggestion${otherCount === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

export function getFeedSuggestionAcceptLabel(item: FeedItem, pending = false): string {
  if (pending) {
    if (isCodeFixSuggestion(item)) return 'Dispatching...';
    return 'Applying...';
  }

  if (isCodeFixSuggestion(item)) return 'Approve Fix';
  return 'Accept';
}

export function getFeedSuggestionAcceptedFeedback(item: FeedItem): string {
  if (isCodeFixSuggestion(item)) return 'Dev agent dispatched.';
  return 'Accepted.';
}

export function isSuggestionActionable(status: SuggestionStatus): boolean {
  return status === 'pending';
}

export function canHideSuggestion(status: SuggestionStatus): boolean {
  return status !== 'pending' && status !== 'dismissed';
}

export function getSuggestionStatusLabel(status: SuggestionStatus): string {
  switch (status) {
    case 'accepted':
      return 'Accepted';
    case 'dismissed':
      return 'Dismissed';
    case 'dispatched':
      return 'Dispatched';
    case 'running':
      return 'Running';
    case 'merged':
      return 'Merged';
    case 'failed':
      return 'Failed';
    default:
      return 'Needs review';
  }
}

export function getSuggestionStatusFeedback(item: FeedItem, status: SuggestionStatus): string | null {
  if (status === 'accepted') {
    return getFeedSuggestionAcceptedFeedback(item);
  }

  if (!isCodeFixSuggestion(item)) {
    return null;
  }

  switch (status) {
    case 'dispatched':
      return 'Dev agent dispatched.';
    case 'running':
      return 'Dev agent running.';
    case 'merged':
      return 'Dev agent merged.';
    case 'failed':
      return getCodeFixFailureFeedback(item) ?? 'Dev agent failed.';
    default:
      return null;
  }
}

export function buildSuggestionApplyRequest(item: FeedItem): SuggestionApplyRequestBody {
  if (!isCodeFixSuggestion(item)) {
    throw new Error('Only code_fix suggestions can be dispatched');
  }

  return {
    suggestionIds: [item.id],
  };
}

export function wasSuggestionApplySuccessful(result: SuggestionApplyResponse): boolean {
  return result.suggestionStatus === 'accepted'
    || result.suggestionStatus === 'dispatched'
    || result.suggestionStatus === 'running';
}

export function getSuggestionApplySuccessMessage(result: SuggestionApplyResponse): string {
  if (result.suggestionStatus === 'dispatched') {
    return typeof result.taskId === 'string' && result.taskId.trim()
      ? `Dev agent dispatched (${result.taskId.trim()}).`
      : 'Dev agent dispatched.';
  }

  if (result.suggestionStatus === 'running') {
    return 'Dev agent running.';
  }

  return 'Suggestion accepted.';
}

export async function readSuggestionActionErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  try {
    const payload = await response.json() as { error?: unknown; message?: unknown };
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    // Ignore invalid or empty response bodies and fall back to the default message.
  }

  return fallbackMessage;
}
