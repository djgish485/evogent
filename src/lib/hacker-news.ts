import type { FeedMetadata } from '@/types/feed';

const HACKER_NEWS_HOST = 'news.ycombinator.com';

function trimToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readMetadataString(metadata: FeedMetadata | null | undefined, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const directValue = trimToNull((metadata as Record<string, unknown>)[key]);
  if (directValue) {
    return directValue;
  }

  const article = metadata.article && typeof metadata.article === 'object' && !Array.isArray(metadata.article)
    ? metadata.article as Record<string, unknown>
    : null;
  return trimToNull(article?.[key]);
}

export function normalizeHackerNewsSourceId(sourceId: string | null | undefined): string | null {
  const trimmed = sourceId?.trim();
  if (!trimmed) {
    return null;
  }

  const prefixedMatch = trimmed.match(/^hn-(\d+)$/i);
  if (prefixedMatch?.[1]) {
    return prefixedMatch[1];
  }

  return /^\d+$/.test(trimmed) ? trimmed : null;
}

export function resolveHackerNewsItemUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== HACKER_NEWS_HOST || parsed.pathname !== '/item') {
      return null;
    }

    const id = parsed.searchParams.get('id')?.trim();
    if (!id || !/^\d+$/.test(id)) {
      return null;
    }

    return `https://${HACKER_NEWS_HOST}/item?id=${id}`;
  } catch {
    return null;
  }
}

export function buildHackerNewsDiscussionUrl(sourceId: string | null | undefined): string | null {
  const id = normalizeHackerNewsSourceId(sourceId);
  return id ? `https://${HACKER_NEWS_HOST}/item?id=${id}` : null;
}

export function resolveHackerNewsDiscussionUrl(item: {
  sourceId?: string | null;
  url?: string | null;
  metadata?: FeedMetadata | null;
}): string | null {
  const metadataCandidates = [
    readMetadataString(item.metadata, 'hnUrl'),
    readMetadataString(item.metadata, 'discussionUrl'),
    readMetadataString(item.metadata, 'hackerNewsUrl'),
  ];

  for (const candidate of metadataCandidates) {
    const hnItemUrl = resolveHackerNewsItemUrl(candidate);
    if (hnItemUrl) {
      return hnItemUrl;
    }

    if (candidate) {
      return candidate;
    }
  }

  return buildHackerNewsDiscussionUrl(item.sourceId)
    ?? resolveHackerNewsItemUrl(item.url);
}
