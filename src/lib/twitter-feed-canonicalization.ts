import type { FeedInsertInput } from '@/lib/db/feed';
import type { FeedMetadata } from '@/types/feed';

type CanonicalTweetEvidence =
  | 'twitter_source'
  | 'numeric_source_id'
  | 'status_url'
  | 'metadata_tweet_id'
  | 'browse_cache_payload';

export type TwitterCanonicalizationResult = {
  ok: true;
  item: FeedInsertInput;
  canonicalTweetId: string | null;
  converted: boolean;
} | {
  ok: false;
  error: string;
  sourceId: string | null;
};

interface TwitterCanonicalizationOptions {
  cachedPayload?: Record<string, unknown> | null;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTwitterSource(source: string | null | undefined): boolean {
  const normalized = trimToNull(source)?.toLowerCase();
  return normalized === 'twitter'
    || normalized === 'x'
    || normalized === 'x.com'
    || normalized === 'twitter.com';
}

export function extractTweetIdFromStatusUrl(value: string | null | undefined): string | null {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (
      hostname !== 'x.com'
      && hostname !== 'twitter.com'
      && hostname !== 'mobile.twitter.com'
    ) {
      return null;
    }

    const match = parsed.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeTweetId(value: string | null | undefined): string | null {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;

  const prefixed = trimmed.match(/^(?:tweet-|twitter:)(\d+)$/i);
  if (prefixed) return prefixed[1];

  const urlTweetId = extractTweetIdFromStatusUrl(trimmed);
  if (urlTweetId) return urlTweetId;

  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function getPayloadTweetId(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;

  const candidates = [
    payload.tweetId,
    payload.tweet_id,
    payload.id,
    payload.id_str,
    payload.restId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const normalized = normalizeTweetId(candidate);
      if (normalized) return normalized;
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      const normalized = normalizeTweetId(String(Math.floor(candidate)));
      if (normalized) return normalized;
    }
  }

  return null;
}

function getMetadataTweetId(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;

  const candidates = [
    metadata.tweetId,
    metadata.tweet_id,
    metadata.statusId,
    metadata.status_id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const normalized = normalizeTweetId(candidate);
      if (normalized) return normalized;
    }
  }

  return null;
}

function isTweetPayload(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false;
  if (getPayloadTweetId(payload)) return true;

  const hasText = typeof payload.text === 'string' && payload.text.trim().length > 0;
  const hasTweetFacts = isRecord(payload.author)
    || isRecord(payload.metrics)
    || Array.isArray(payload.media)
    || typeof payload.authorAvatarUrl === 'string'
    || typeof payload.authorUsername === 'string';

  return hasText && hasTweetFacts;
}

function pushId(
  idsByEvidence: Map<string, CanonicalTweetEvidence[]>,
  id: string | null,
  evidence: CanonicalTweetEvidence,
) {
  if (!id) return;
  const existing = idsByEvidence.get(id) ?? [];
  existing.push(evidence);
  idsByEvidence.set(id, existing);
}

function buildTweetStatusUrl(authorUsername: string | null | undefined, tweetId: string): string | null {
  const normalizedAuthor = trimToNull(authorUsername)?.replace(/^@+/, '').trim();
  if (!normalizedAuthor) return null;
  return `https://x.com/${normalizedAuthor}/status/${tweetId}`;
}

export function canonicalizeTwitterFeedItemForSubmit(
  item: FeedInsertInput,
  options: TwitterCanonicalizationOptions = {},
): TwitterCanonicalizationResult {
  if (item.type !== 'article' && item.type !== 'tweet') {
    return {
      ok: true,
      item,
      canonicalTweetId: null,
      converted: false,
    };
  }

  const twitterSource = isTwitterSource(item.source);
  const idsByEvidence = new Map<string, CanonicalTweetEvidence[]>();
  const sourceIdTweetId = normalizeTweetId(item.sourceId);
  const urlTweetId = extractTweetIdFromStatusUrl(item.url);
  const metadataTweetId = getMetadataTweetId(isRecord(item.metadata) ? item.metadata : null);
  const cachedPayload = options.cachedPayload ?? null;
  const cacheTweetId = getPayloadTweetId(cachedPayload);

  pushId(idsByEvidence, sourceIdTweetId, 'numeric_source_id');
  pushId(idsByEvidence, urlTweetId, 'status_url');
  pushId(idsByEvidence, metadataTweetId, 'metadata_tweet_id');
  pushId(idsByEvidence, cacheTweetId, 'browse_cache_payload');

  const distinctIds = [...idsByEvidence.keys()];
  if (distinctIds.length > 1) {
    return {
      ok: false,
      sourceId: item.sourceId ?? null,
      error: `Conflicting Twitter tweet evidence: ${distinctIds.join(', ')}`,
    };
  }

  const canonicalTweetId = distinctIds[0] ?? null;
  const evidence = new Set<CanonicalTweetEvidence>(canonicalTweetId ? idsByEvidence.get(canonicalTweetId) ?? [] : []);
  if (twitterSource) {
    evidence.add('twitter_source');
  }
  if (isTweetPayload(cachedPayload)) {
    evidence.add('browse_cache_payload');
  }

  const hasStructuralTweetEvidence = Boolean(
    urlTweetId
    || (twitterSource && sourceIdTweetId)
    || isTweetPayload(cachedPayload),
  );

  if (!hasStructuralTweetEvidence || !canonicalTweetId) {
    return {
      ok: true,
      item,
      canonicalTweetId: null,
      converted: false,
    };
  }

  const converted = item.type === 'article';
  const originalMetadata = isRecord(item.metadata) ? item.metadata : {};
  const canonicalMetadata: FeedMetadata | null = converted
    ? {
        ...originalMetadata,
        twitterCanonicalization: {
          originalType: item.type,
          originalSource: item.source ?? null,
          originalSourceId: item.sourceId ?? null,
          originalUrl: item.url ?? null,
          canonicalTweetId,
          evidence: [...evidence].sort(),
        },
      }
    : item.metadata ?? null;

  const statusUrl = extractTweetIdFromStatusUrl(item.url) === canonicalTweetId
    ? item.url
    : buildTweetStatusUrl(item.authorUsername, canonicalTweetId) ?? item.url;

  return {
    ok: true,
    converted,
    canonicalTweetId,
    item: {
      ...item,
      type: 'tweet',
      source: 'twitter',
      sourceId: canonicalTweetId,
      title: converted ? null : item.title,
      url: statusUrl,
      metadata: canonicalMetadata,
    },
  };
}
