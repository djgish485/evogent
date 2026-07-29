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

// Agent-authored approval buttons on a suggestion card. The emitter describes the concrete
// actions it thinks the user may want ("Send this reply", "Turn off auto-renew") instead of a
// generic Accept; each tap approves exactly that one action.
export interface SuggestionAction {
  label: string;
  instruction?: string;
  // 'link' = open a URL and DON'T touch the card (the mission's "one decisive tap to the
  // page" — an invoice payment page, a Google security alert). Before this existed the parser
  // silently downgraded link actions to 'acknowledge' and dropped the url, so every "Open …"
  // button just marked the card handled and vanished without ever opening the page.
  kind: 'execute' | 'acknowledge' | 'link' | 'cancel_source';
  url?: string;
}

const SUGGESTION_ACTION_MAX_COUNT = 3;
const SUGGESTION_ACTION_LABEL_MAX_LENGTH = 48;
const SUGGESTION_ACTION_INSTRUCTION_MAX_LENGTH = 2000;

export function parseSuggestionActions(raw: unknown): SuggestionAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: SuggestionAction[] = [];
  for (const entry of raw) {
    if (actions.length >= SUGGESTION_ACTION_MAX_COUNT) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!label || label.length > SUGGESTION_ACTION_LABEL_MAX_LENGTH) continue;
    const instruction = typeof record.instruction === 'string'
      ? record.instruction.trim().slice(0, SUGGESTION_ACTION_INSTRUCTION_MAX_LENGTH)
      : '';
    const kindRaw = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : '';
    const rawUrl = typeof record.url === 'string' ? record.url.trim() : '';
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
    if (kindRaw === 'link' && url) {
      actions.push({ label, kind: 'link', url });
      continue;
    }
    if (kindRaw === 'cancel_source') {
      actions.push({ label, kind: 'cancel_source' });
      continue;
    }
    const kind: SuggestionAction['kind'] = kindRaw === 'acknowledge' || !instruction
      ? 'acknowledge'
      : 'execute';
    actions.push({ label, ...(instruction ? { instruction } : {}), kind });
  }
  return actions;
}

export function getSuggestionActions(item: FeedItem): SuggestionAction[] {
  return parseSuggestionActions(item.metadata?.actions);
}

// Emitters mark time-critical / money-at-stake cards as high importance; arrange places
// those above content so urgent action is not buried.
export function getSuggestionImportance(item: Pick<FeedItem, 'metadata'>): 'high' | 'normal' {
  const raw = typeof item.metadata?.importance === 'string'
    ? item.metadata.importance.trim().toLowerCase()
    : '';
  return raw === 'high' || raw === 'urgent' ? 'high' : 'normal';
}

export function getFeedSuggestionType(item: FeedItem): string {
  return typeof item.metadata?.suggestionType === 'string'
    ? item.metadata.suggestionType.trim().toLowerCase()
    : '';
}

export function isCodeFixSuggestion(item: FeedItem): boolean {
  return getFeedSuggestionType(item) === 'code_fix';
}

export function isLifeAdminSuggestion(item: FeedItem): boolean {
  return getFeedSuggestionType(item) === 'life_admin';
}

export function isSourceSetupSuggestion(item: FeedItem): boolean {
  return getFeedSuggestionType(item) === 'source_setup';
}

// Personal recommendations (life admin, ideas) surface above the code-fix dev backlog.
export function isPersonalSuggestion(item: FeedItem): boolean {
  return !isCodeFixSuggestion(item);
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
  if (isLifeAdminSuggestion(item)) return 'Life Admin';
  if (isSourceSetupSuggestion(item)) return 'New Source';
  return 'Suggestion';
}

export function getFeedSuggestionTypeBadgeLabel(item: FeedItem): string {
  if (isCodeFixSuggestion(item)) return 'Code Fix';
  if (isLifeAdminSuggestion(item)) return 'Life Admin';
  if (isSourceSetupSuggestion(item)) return 'New Source';
  return 'Suggestion';
}

export function getFeedSuggestionDefaultTitle(item: FeedItem): string {
  if (isCodeFixSuggestion(item)) return 'Suggested code fix';
  if (isLifeAdminSuggestion(item)) return 'Life admin task';
  if (isSourceSetupSuggestion(item)) return 'Suggested new source';
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
  let lifeAdminCount = 0;
  let otherCount = 0;

  for (const item of items) {
    if (isCodeFixSuggestion(item)) {
      codeFixCount += 1;
      continue;
    }
    if (isLifeAdminSuggestion(item)) {
      lifeAdminCount += 1;
      continue;
    }

    otherCount += 1;
  }

  const parts: string[] = [];
  if (lifeAdminCount > 0) {
    parts.push(`${lifeAdminCount} life admin task${lifeAdminCount === 1 ? '' : 's'}`);
  }
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
    if (isCodeFixSuggestion(item)) return 'Queueing...';
    if (isLifeAdminSuggestion(item)) return 'Approving...';
    return 'Applying...';
  }

  if (isCodeFixSuggestion(item)) return 'Queue for development';
  if (isLifeAdminSuggestion(item)) return 'Approve';
  return 'Accept';
}

export function getFeedSuggestionAcceptedFeedback(item: FeedItem): string {
  if (isCodeFixSuggestion(item)) return 'Queued for development.';
  if (isLifeAdminSuggestion(item)) return 'Approved.';
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
