import type { SuggestionStatus } from '@/types/feed';

export type GroupedCardSummaryType = 'suggestion' | 'notification';

export interface GroupedCardSummaryItem {
  id: string;
  type: string;
  source: string | null;
  originSessionId?: string | null;
  suggestionStatus?: SuggestionStatus | null;
  title: string | null;
  text: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

export interface GroupedCardSummaryRequest {
  groupType: GroupedCardSummaryType;
  items: GroupedCardSummaryItem[];
}

export interface GroupedCardSummary {
  title: string;
  text: string;
  countLabel: string;
  breakdown: string;
  status: string;
  origin: string;
  nextStep: string;
}

const SUMMARY_METADATA_KEYS = [
  'autoResolveCondition',
  'chatMessageId',
  'configField',
  'configFile',
  'dismissable',
  'expiresAt',
  'notificationId',
  'proposedValue',
  'reflectionCycle',
  'severity',
  'suggestionStatus',
  'suggestionType',
] as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeWhitespace(value);
  return normalized || null;
}

function pickSummaryMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  const summaryMetadata: Record<string, unknown> = {};
  for (const key of SUMMARY_METADATA_KEYS) {
    const value = metadata[key];
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === 'string') {
      const normalized = normalizeWhitespace(value);
      if (!normalized) {
        continue;
      }
      summaryMetadata[key] = normalized;
      continue;
    }

    summaryMetadata[key] = value;
  }

  return Object.keys(summaryMetadata).length > 0 ? summaryMetadata : null;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeys(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
      return accumulator;
    }, {});
}

function normalizeItemForSignature(item: GroupedCardSummaryItem): Record<string, unknown> {
  return {
    id: normalizeWhitespace(item.id),
    type: normalizeWhitespace(item.type),
    source: normalizeOptionalString(item.source),
    originSessionId: normalizeOptionalString(item.originSessionId),
    suggestionStatus: normalizeOptionalString(item.suggestionStatus),
    title: normalizeOptionalString(item.title),
    text: normalizeWhitespace(item.text),
    reason: normalizeOptionalString(item.reason),
    metadata: pickSummaryMetadata(item.metadata),
  };
}

export function serializeGroupedCardSummaryRequest(request: GroupedCardSummaryRequest): string {
  const normalized = {
    groupType: request.groupType,
    items: request.items
      .map((item) => normalizeItemForSignature(item))
      .sort((left, right) => {
        const leftId = String(left.id);
        const rightId = String(right.id);
        return leftId.localeCompare(rightId);
      }),
  };

  return JSON.stringify(sortObjectKeys(normalized));
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinPhrases(parts: string[]): string {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return '';
  if (filtered.length === 1) return filtered[0]!;
  if (filtered.length === 2) return `${filtered[0]} and ${filtered[1]}`;
  return `${filtered.slice(0, -1).join(', ')}, and ${filtered[filtered.length - 1]}`;
}

function countBy<T extends string>(values: Iterable<T>): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function formatCountSummary(parts: Array<{ count: number; singular: string; plural?: string }>): string {
  const visibleParts = parts
    .filter((part) => part.count > 0)
    .map((part) => pluralize(part.count, part.singular, part.plural));
  return joinPhrases(visibleParts);
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function resolveSuggestionType(item: GroupedCardSummaryItem): string {
  const rawValue = typeof item.metadata?.suggestionType === 'string'
    ? item.metadata.suggestionType
    : '';
  return normalizeWhitespace(rawValue).toLowerCase();
}

function resolveSuggestionStatus(item: GroupedCardSummaryItem): SuggestionStatus {
  const rawValue = normalizeOptionalString(item.suggestionStatus)
    ?? normalizeOptionalString(item.metadata?.suggestionStatus);
  switch (rawValue?.toLowerCase()) {
    case 'accepted':
    case 'dismissed':
    case 'dispatched':
    case 'running':
    case 'merged':
    case 'failed':
      return rawValue.toLowerCase() as SuggestionStatus;
    default:
      return 'pending';
  }
}

function resolveSuggestionOrigin(item: GroupedCardSummaryItem): 'chat' | 'reflection' | 'agent' | 'system' | 'other' {
  if (normalizeOptionalString(item.originSessionId) || normalizeOptionalString(item.metadata?.chatMessageId)) {
    return 'chat';
  }
  if (item.metadata?.reflectionCycle === true) {
    return 'reflection';
  }

  const source = normalizeOptionalString(item.source)?.toLowerCase() ?? '';
  if (source === 'claude' || source === 'codex') {
    return 'agent';
  }
  if (source === 'system') {
    return 'system';
  }
  return 'other';
}

function buildSuggestionGroupHeadline(
  counts: {
    pendingCount: number;
    failedCount: number;
    inProgressCount: number;
  },
): string {
  if (counts.pendingCount > 0) {
    return ['Awaiting', 'approval'].join(' ');
  }
  if (counts.failedCount > 0) {
    return ['Needs', 'attention'].join(' ');
  }
  if (counts.inProgressCount > 0) {
    return ['In', 'progress'].join(' ');
  }
  return ['Recent', 'updates'].join(' ');
}

function describeDominantCategory<T extends string>(
  counts: Map<T, number>,
  labels: Record<T, string>,
): string {
  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return String(left[0]).localeCompare(String(right[0]));
  });

  if (ranked.length === 0) {
    return '';
  }

  const total = ranked.reduce((sum, [, count]) => sum + count, 0);
  const [topKey, topCount] = ranked[0]!;
  if (topCount === total) {
    return `From ${labels[topKey]}`;
  }
  if (topCount > total / 2) {
    return `Mostly ${labels[topKey]}`;
  }

  const leadingLabels = ranked.slice(0, 2).map(([key]) => labels[key]);
  return `Mix of ${joinPhrases(leadingLabels)}`;
}

function describeDominantPurpose<T extends string>(
  counts: Map<T, number>,
  labels: Record<T, string>,
): string {
  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return String(left[0]).localeCompare(String(right[0]));
  });

  if (ranked.length === 0) {
    return '';
  }

  const total = ranked.reduce((sum, [, count]) => sum + count, 0);
  const [topKey, topCount] = ranked[0]!;
  if (topCount === total || topCount > total / 2) {
    return `about ${labels[topKey]}`;
  }

  const leadingLabels = ranked.slice(0, 2).map(([key]) => labels[key]);
  return `covering ${joinPhrases(leadingLabels)}`;
}

function resolveSuggestionPurpose(items: GroupedCardSummaryItem[]): string {
  const codeFixCount = items.filter((item) => resolveSuggestionType(item) === 'code_fix').length;
  if (codeFixCount === 0) {
    return '';
  }

  const configTargets = countBy(items.map((item) => {
    const configFile = normalizeOptionalString(item.metadata?.configFile);
    if (configFile === 'data/config.md') {
      return 'app-config' as const;
    }
    if (configFile === 'data/curation-prompt.md') {
      return 'curation-prompt' as const;
    }
    return 'other-config' as const;
  }));

  const appConfigCount = configTargets.get('app-config') ?? 0;
  const curationPromptCount = configTargets.get('curation-prompt') ?? 0;
  const otherConfigCount = configTargets.get('other-config') ?? 0;

  if (appConfigCount > 0 && curationPromptCount === 0 && otherConfigCount === 0) {
    return 'touching app config';
  }
  if (curationPromptCount > 0 && appConfigCount === 0 && otherConfigCount === 0) {
    return 'touching the curation prompt';
  }
  if (appConfigCount > 0 && curationPromptCount > 0 && otherConfigCount === 0) {
    return 'touching app config and the curation prompt';
  }
  return 'focused on code updates';
}

function buildSuggestionOriginSummary(items: GroupedCardSummaryItem[]): string {
  const origin = describeDominantCategory(
    countBy(items.map(resolveSuggestionOrigin)),
    {
      agent: 'agent suggestions',
      chat: 'chat follow-ups',
      other: 'feed suggestions',
      reflection: 'reflection runs',
      system: 'system suggestions',
    },
  );
  const purpose = resolveSuggestionPurpose(items);

  if (origin && purpose) {
    return `${origin} ${purpose}`;
  }
  return origin || purpose;
}

function buildSuggestionNextStep(parts: {
  codeFixCount: number;
  pendingCount: number;
  inProgressCount: number;
  failedCount: number;
  resolvedCount: number;
}): string {
  if (parts.failedCount > 0) {
    return parts.codeFixCount > 0
      ? 'Check failures first, then retry or dismiss the blocked fixes'
      : 'Check failures first, then retry or dismiss the blocked suggestions';
  }

  if (parts.pendingCount > 0 || parts.inProgressCount > 0) {
    if (parts.codeFixCount > 0) {
      return 'Approve open fixes or open the group to track progress';
    }
    return 'Review the open items or open the group for details';
  }

  if (parts.resolvedCount > 0) {
    return 'Open the group to review the recent outcomes';
  }

  return 'Open the group for details';
}

function buildSuggestionSummary(items: GroupedCardSummaryItem[]): GroupedCardSummary {
  const countLabel = pluralize(items.length, 'suggestion');
  const codeFixCount = items.filter((item) => resolveSuggestionType(item) === 'code_fix').length;
  const otherCount = Math.max(0, items.length - codeFixCount);

  const breakdown = formatCountSummary([
    { count: codeFixCount, singular: 'code fix', plural: 'code fixes' },
    { count: otherCount, singular: 'other suggestion', plural: 'other suggestions' },
  ]);

  let pendingCount = 0;
  let inProgressCount = 0;
  let failedCount = 0;
  let resolvedCount = 0;
  for (const item of items) {
    switch (resolveSuggestionStatus(item)) {
      case 'failed':
        failedCount += 1;
        break;
      case 'dispatched':
      case 'running':
        inProgressCount += 1;
        break;
      case 'accepted':
      case 'merged':
        resolvedCount += 1;
        break;
      case 'dismissed':
        break;
      default:
        pendingCount += 1;
        break;
    }
  }

  const status = formatCountSummary([
    { count: pendingCount, singular: 'pending', plural: 'pending' },
    { count: inProgressCount, singular: 'in progress', plural: 'in progress' },
    { count: failedCount, singular: 'failed', plural: 'failed' },
    { count: resolvedCount, singular: 'resolved', plural: 'resolved' },
  ]);
  const origin = buildSuggestionOriginSummary(items);
  const nextStep = buildSuggestionNextStep({
    codeFixCount,
    pendingCount,
    inProgressCount,
    failedCount,
    resolvedCount,
  });
  const title = buildSuggestionGroupHeadline({
    pendingCount,
    failedCount,
    inProgressCount,
  });

  return {
    title,
    text: '',
    countLabel,
    breakdown,
    status,
    origin,
    nextStep,
  };
}

function resolveNotificationSeverity(item: GroupedCardSummaryItem): 'info' | 'warning' | 'error' {
  const severity = normalizeOptionalString(item.metadata?.severity)?.toLowerCase();
  if (severity === 'warning' || severity === 'error') {
    return severity;
  }
  return 'info';
}

function resolveNotificationSource(item: GroupedCardSummaryItem): 'system' | 'agent' | 'app' | 'other' {
  const source = normalizeOptionalString(item.source)?.toLowerCase() ?? '';
  if (source === 'system') return 'system';
  if (source === 'claude' || source === 'codex') return 'agent';
  if (source === 'app' || source === 'nextjs' || source === 'next') return 'app';
  return 'other';
}

function resolveNotificationPurpose(item: GroupedCardSummaryItem): 'auth' | 'runtime' | 'updates' | 'system-state' {
  const haystack = [
    item.title,
    item.text,
    item.reason,
    typeof item.metadata?.notificationId === 'string' ? item.metadata.notificationId : '',
    item.source,
  ].filter(Boolean).join(' ').toLowerCase();

  const hasAuth = /\bauth\b|cookie|token|credential|login|401/.test(haystack);
  if (hasAuth) return 'auth';
  if (/restart|build|deploy|merge|update|upgrade/.test(haystack)) return 'updates';
  if (/queue|orchestrator|heartbeat|websocket|task|sync/.test(haystack)) return 'runtime';
  return 'system-state';
}

function buildNotificationOriginSummary(items: GroupedCardSummaryItem[]): string {
  const sourceSummary = describeDominantCategory(
    countBy(items.map(resolveNotificationSource)),
    {
      agent: 'agent alerts',
      app: 'app alerts',
      other: 'runtime alerts',
      system: 'system alerts',
    },
  );
  const purposeSummary = describeDominantPurpose(
    countBy(items.map(resolveNotificationPurpose)),
    {
      auth: 'authentication',
      runtime: 'runtime status',
      'system-state': 'system state',
      updates: 'app updates',
    },
  );

  if (sourceSummary && purposeSummary) {
    return `${sourceSummary} ${purposeSummary}`;
  }
  return sourceSummary || purposeSummary;
}

function buildNotificationNextStep(parts: {
  errorCount: number;
  warningCount: number;
}): string {
  if (parts.errorCount > 0) {
    return 'Address the errors first or dismiss alerts that are already handled';
  }
  if (parts.warningCount > 0) {
    return 'Review the warnings and dismiss anything already handled';
  }
  return 'Open the group for details or dismiss handled notices';
}

function buildNotificationSummary(items: GroupedCardSummaryItem[]): GroupedCardSummary {
  const countLabel = pluralize(items.length, 'notification');
  const errorCount = items.filter((item) => resolveNotificationSeverity(item) === 'error').length;
  const warningCount = items.filter((item) => resolveNotificationSeverity(item) === 'warning').length;
  const infoCount = Math.max(0, items.length - errorCount - warningCount);

  const breakdown = formatCountSummary([
    { count: errorCount, singular: 'error', plural: 'errors' },
    { count: warningCount, singular: 'warning', plural: 'warnings' },
    { count: infoCount, singular: 'info notice', plural: 'info notices' },
  ]);
  const origin = buildNotificationOriginSummary(items);
  const nextStep = buildNotificationNextStep({ errorCount, warningCount });
  const text = [
    breakdown ? `${countLabel}: ${breakdown}` : countLabel,
    origin,
    nextStep,
  ].map(sentence).filter(Boolean).join(' ');

  return {
    title: countLabel,
    text,
    countLabel,
    breakdown,
    status: breakdown,
    origin,
    nextStep,
  };
}

export function buildGroupedCardSummary(request: GroupedCardSummaryRequest): GroupedCardSummary {
  if (request.groupType === 'suggestion') {
    return buildSuggestionSummary(request.items);
  }

  return buildNotificationSummary(request.items);
}
