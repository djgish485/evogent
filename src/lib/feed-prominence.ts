import type { FeedItem, FeedProminence, FeedProminenceLevel } from '@/types/feed';

const allowedProminenceLevels: FeedProminenceLevel[] = ['prominent', 'lead'];
const prominenceRank: Record<FeedProminenceLevel, number> = {
  prominent: 1,
  lead: 2,
};

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeFeedProminence(input: unknown): FeedProminence | null {
  if (!isRecord(input)) {
    return null;
  }

  const level = readTrimmedString(input.level)?.toLowerCase();
  if (!allowedProminenceLevels.includes(level as FeedProminenceLevel)) {
    return null;
  }

  const prominence: FeedProminence = {
    level: level as FeedProminenceLevel,
  };

  const label = readTrimmedString(input.label);
  if (label) prominence.label = label;

  const source = readTrimmedString(input.source);
  if (source) prominence.source = source;

  const evidence = readTrimmedString(input.evidence);
  if (evidence) prominence.evidence = evidence;

  const homepageUrl = readTrimmedString(input.homepageUrl);
  if (homepageUrl) prominence.homepageUrl = homepageUrl;

  return prominence;
}

export function validateFeedProminenceInput(
  input: unknown,
  fieldPath = 'metadata.prominence',
  options: { requiredSource?: string } = {},
): string | null {
  if (!isRecord(input)) {
    return `${fieldPath} must be a JSON object when provided`;
  }

  const level = readTrimmedString(input.level)?.toLowerCase();
  if (!allowedProminenceLevels.includes(level as FeedProminenceLevel)) {
    return `${fieldPath}.level must be one of: ${allowedProminenceLevels.join(', ')}`;
  }

  for (const field of ['label', 'source', 'evidence', 'homepageUrl']) {
    const value = input[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `${fieldPath}.${field} must be a string when provided`;
    }
  }

  if (options.requiredSource) {
    const source = readTrimmedString(input.source)?.toLowerCase();
    if (source !== options.requiredSource) {
      return `${fieldPath}.source must be "${options.requiredSource}"`;
    }
  }

  return null;
}

export function getStrongestFeedProminence(prominences: Array<FeedProminence | null | undefined>): FeedProminence | null {
  let strongest: FeedProminence | null = null;

  for (const input of prominences) {
    const prominence = normalizeFeedProminence(input);
    if (!prominence) {
      continue;
    }

    if (!strongest || prominenceRank[prominence.level] > prominenceRank[strongest.level]) {
      strongest = prominence;
    }
  }

  return strongest;
}

export function getFeedProminenceLevel(item: Pick<FeedItem, 'metadata'>): FeedProminenceLevel | null {
  return item.metadata?.prominence?.level ?? null;
}

export function isProminentFeedItem(item: Pick<FeedItem, 'metadata'>): boolean {
  return getFeedProminenceLevel(item) !== null;
}
