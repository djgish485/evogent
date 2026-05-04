import type { ReplyCaptureMetadata } from '@/types/feed';

const REPLY_CAPTURE_SOURCES = new Set<ReplyCaptureMetadata['source']>([
  'timeline',
  'search',
  'profile_tweets',
  'profile_with_replies',
  'status_thread',
  'status_replies',
]);

const REPLY_CAPTURE_CLASSIFICATION_ALIASES: Record<string, ReplyCaptureMetadata['classification']> = {
  confirmed: 'confirmed',
  candidate: 'candidate',
  none: 'none',
  authored_timeline_entry: 'candidate',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHandle(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().replace(/^@+/, '').toLowerCase();
  return trimmed || null;
}

export function normalizeReplyCaptureClassification(value: unknown): ReplyCaptureMetadata['classification'] | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return REPLY_CAPTURE_CLASSIFICATION_ALIASES[normalized] ?? null;
}

export function normalizeReplyCaptureMetadata(value: unknown): ReplyCaptureMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const source = typeof value.source === 'string' ? value.source.trim() : '';
  const classification = normalizeReplyCaptureClassification(value.classification);
  if (!REPLY_CAPTURE_SOURCES.has(source as ReplyCaptureMetadata['source']) || !classification) {
    return null;
  }

  const requestedHandle = normalizeHandle(value.requestedHandle);
  const authoredByRequestedAccount = typeof value.authoredByRequestedAccount === 'boolean'
    ? value.authoredByRequestedAccount
    : undefined;
  const visibleReplyBanner = typeof value.visibleReplyBanner === 'boolean'
    ? value.visibleReplyBanner
    : undefined;

  return {
    source: source as ReplyCaptureMetadata['source'],
    classification,
    ...(requestedHandle ? { requestedHandle } : {}),
    ...(typeof authoredByRequestedAccount === 'boolean' ? { authoredByRequestedAccount } : {}),
    ...(typeof visibleReplyBanner === 'boolean' ? { visibleReplyBanner } : {}),
  };
}
