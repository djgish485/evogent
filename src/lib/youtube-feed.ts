import type { FeedMetadata } from '@/types/feed';

const YOUTUBE_HOSTNAMES = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export interface YouTubeFeedData {
  videoId: string;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  channelName: string | null;
  channelHandle: string | null;
  channelUrl: string | null;
  thumbnailUrl: string | null;
  publishDate: string | null;
  publishDateText: string | null;
  viewCount: number | null;
  viewCountText: string | null;
  duration: string | null;
  durationSeconds: number | null;
  liveStatus: 'live' | 'upcoming' | null;
  scheduledStartAt: string | null;
  scheduledStartText: string | null;
}

export interface YouTubeCanonicalSourceFields {
  videoId: string;
  canonicalUrl: string;
  thumbnailUrl: string | null;
  publishDate: string | null;
  publishDateText: string | null;
  publishedAt: string | null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === 'no' || normalized === '0') {
      return false;
    }
  }

  return null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Fallback only when the runtime could not populate publishDate from the video page.
function normalizeRelativeYouTubePublishDateLabel(value: string | null | undefined) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;

  if (/^today$/i.test(trimmed)) {
    return new Date().toISOString();
  }

  if (/^yesterday$/i.test(trimmed)) {
    return new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();
  }

  const normalized = trimmed
    .replace(/^(streamed|premiered|posted|updated)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (!match) {
    return null;
  }

  const quantity = Number.parseInt(match[1], 10);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }

  const unitMs = match[2].toLowerCase() === 'minute'
    ? 60 * 1000
    : match[2].toLowerCase() === 'hour'
      ? 60 * 60 * 1000
      : match[2].toLowerCase() === 'day'
        ? 24 * 60 * 60 * 1000
        : match[2].toLowerCase() === 'week'
          ? 7 * 24 * 60 * 60 * 1000
          : match[2].toLowerCase() === 'month'
            ? 30 * 24 * 60 * 60 * 1000
            : 365 * 24 * 60 * 60 * 1000;

  return new Date(Date.now() - (quantity * unitMs)).toISOString();
}

function normalizeYouTubePublishTimestamp(value: string | null | undefined) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return normalizeRelativeYouTubePublishDateLabel(trimmed);
  }

  return parsed.toISOString();
}

function normalizeLiveStatus(value: unknown): 'live' | 'upcoming' | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (
    normalized === 'live'
    || normalized === 'live now'
    || normalized === 'currently live'
    || normalized === 'streaming'
    || normalized === 'streaming now'
    || normalized === 'on air'
    || normalized === 'is_live'
  ) {
    return 'live';
  }

  if (
    normalized === 'upcoming'
    || normalized === 'scheduled'
    || normalized === 'scheduled_live'
    || normalized === 'premiere'
    || normalized === 'premieres'
    || normalized === 'is_upcoming'
  ) {
    return 'upcoming';
  }

  return null;
}

export function isYouTubeSource(source: string | null | undefined): boolean {
  return source?.trim().toLowerCase() === 'youtube';
}

export function buildCanonicalYouTubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function extractYouTubeVideoId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const bareIdMatch = trimmed.match(/^[a-zA-Z0-9_-]{6,}$/);
  if (bareIdMatch) {
    return bareIdMatch[0];
  }

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOSTNAMES.has(hostname)) {
      return null;
    }

    if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
      const shortId = parsed.pathname.split('/').filter(Boolean)[0];
      return shortId && /^[a-zA-Z0-9_-]{6,}$/.test(shortId) ? shortId : null;
    }

    const watchId = parsed.searchParams.get('v');
    if (watchId && /^[a-zA-Z0-9_-]{6,}$/.test(watchId)) {
      return watchId;
    }

    const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{6,})/);
    return pathMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

export function canonicalizeYouTubeWatchUrl(value: string | null | undefined): string | null {
  const videoId = extractYouTubeVideoId(value);
  return videoId ? buildCanonicalYouTubeWatchUrl(videoId) : null;
}

export function resolveYouTubePublishedAt(input: {
  publishDate?: unknown;
  publishDateText?: unknown;
}) {
  return normalizeYouTubePublishTimestamp(normalizeString(input.publishDate))
    ?? normalizeYouTubePublishTimestamp(normalizeString(input.publishDateText));
}

export function getYouTubeCanonicalSourceFields(input: {
  sourceId?: string | null;
  url?: string | null;
  metadata?: FeedMetadata | Record<string, unknown> | null;
  mediaUrls?: string[] | null;
}): YouTubeCanonicalSourceFields | null {
  const metadata = isRecord(input.metadata) ? input.metadata : null;
  const article = metadata?.article;
  const articleRecord = isRecord(article) ? article : null;
  const linkCard = metadata?.linkCard;
  const linkCardRecord = isRecord(linkCard) ? linkCard : null;

  const videoId = normalizeString(articleRecord?.videoId)
    ?? normalizeString(metadata?.videoId)
    ?? normalizeString(linkCardRecord?.videoId)
    ?? extractYouTubeVideoId(input.url)
    ?? extractYouTubeVideoId(normalizeString(input.sourceId))
    ?? extractYouTubeVideoId(normalizeString(metadata?.canonicalUrl))
    ?? extractYouTubeVideoId(normalizeString(metadata?.url))
    ?? extractYouTubeVideoId(normalizeString(articleRecord?.canonicalUrl))
    ?? extractYouTubeVideoId(normalizeString(articleRecord?.url))
    ?? extractYouTubeVideoId(normalizeString(linkCardRecord?.url));

  if (!videoId) {
    return null;
  }

  const canonicalUrl = normalizeString(articleRecord?.canonicalUrl)
    ?? normalizeString(metadata?.canonicalUrl)
    ?? canonicalizeYouTubeWatchUrl(input.url)
    ?? canonicalizeYouTubeWatchUrl(normalizeString(metadata?.url))
    ?? canonicalizeYouTubeWatchUrl(normalizeString(articleRecord?.url))
    ?? canonicalizeYouTubeWatchUrl(normalizeString(linkCardRecord?.url))
    ?? buildCanonicalYouTubeWatchUrl(videoId);

  const thumbnailUrl = normalizeString(articleRecord?.thumbnailUrl)
    ?? normalizeString(metadata?.thumbnailUrl)
    ?? normalizeString(metadata?.imageUrl)
    ?? normalizeString(linkCardRecord?.imageUrl)
    ?? input.mediaUrls?.find((entry) => typeof entry === 'string' && entry.trim())?.trim()
    ?? null;
  const publishDate = normalizeString(articleRecord?.publishDate)
    ?? normalizeString(metadata?.publishDate)
    ?? null;
  const publishDateText = normalizeString(articleRecord?.publishDateText)
    ?? normalizeString(metadata?.publishDateText)
    ?? normalizeString(articleRecord?.publishedText)
    ?? normalizeString(metadata?.publishedText)
    ?? null;

  return {
    videoId,
    canonicalUrl,
    thumbnailUrl,
    publishDate,
    publishDateText,
    publishedAt: resolveYouTubePublishedAt({
      publishDate,
      publishDateText,
    }),
  };
}

export function getYouTubeFeedData(input: {
  source?: string | null;
  sourceId?: string | null;
  url?: string | null;
  title?: string | null;
  text?: string | null;
  authorUsername?: string | null;
  authorDisplayName?: string | null;
  metadata?: FeedMetadata | Record<string, unknown> | null;
  mediaUrls?: string[] | null;
}): YouTubeFeedData | null {
  const metadata = isRecord(input.metadata) ? input.metadata : null;
  const article = metadata?.article;
  const articleRecord = isRecord(article) ? article : null;
  const linkCard = metadata?.linkCard;
  const linkCardRecord = isRecord(linkCard) ? linkCard : null;
  const canonicalSourceFields = getYouTubeCanonicalSourceFields(input);

  const liveStatus = normalizeLiveStatus(articleRecord?.liveStatus)
    ?? normalizeLiveStatus(articleRecord?.broadcastStatus)
    ?? normalizeLiveStatus(metadata?.liveStatus)
    ?? normalizeLiveStatus(metadata?.broadcastStatus)
    ?? normalizeLiveStatus(linkCardRecord?.liveStatus)
    ?? ((normalizeBoolean(articleRecord?.isLive) ?? normalizeBoolean(metadata?.isLive) ?? false) ? 'live' : null)
    ?? ((normalizeBoolean(articleRecord?.isUpcoming) ?? normalizeBoolean(metadata?.isUpcoming) ?? false) ? 'upcoming' : null);

  const scheduledStartAt = normalizeTimestamp(articleRecord?.scheduledStartAt)
    ?? normalizeTimestamp(articleRecord?.scheduledStartTime)
    ?? normalizeTimestamp(articleRecord?.scheduledFor)
    ?? normalizeTimestamp(articleRecord?.startTime)
    ?? normalizeTimestamp(metadata?.scheduledStartAt)
    ?? normalizeTimestamp(metadata?.scheduledStartTime)
    ?? normalizeTimestamp(metadata?.scheduledFor)
    ?? normalizeTimestamp(metadata?.startTime);

  const scheduledStartText = normalizeString(articleRecord?.scheduledStartText)
    ?? normalizeString(articleRecord?.scheduledLabel)
    ?? normalizeString(articleRecord?.scheduledFor)
    ?? normalizeString(articleRecord?.scheduledStartTime)
    ?? normalizeString(metadata?.scheduledStartText)
    ?? normalizeString(metadata?.scheduledLabel)
    ?? normalizeString(metadata?.scheduledFor)
    ?? normalizeString(metadata?.scheduledStartTime);
  const resolvedLiveStatus = liveStatus ?? ((scheduledStartAt || scheduledStartText) ? 'upcoming' : null);

  const videoId = canonicalSourceFields?.videoId ?? null;

  if (!videoId && !isYouTubeSource(input.source)) {
    return null;
  }

  if (!videoId) {
    return null;
  }

  const canonicalUrl = canonicalSourceFields?.canonicalUrl ?? buildCanonicalYouTubeWatchUrl(videoId);

  return {
    videoId,
    canonicalUrl,
    title: normalizeString(input.title)
      ?? normalizeString(articleRecord?.title)
      ?? normalizeString(metadata?.title)
      ?? normalizeString(linkCardRecord?.title),
    description: normalizeString(articleRecord?.description)
      ?? normalizeString(metadata?.description)
      ?? normalizeString(linkCardRecord?.description)
      ?? null,
    channelName: normalizeString(articleRecord?.channelName)
      ?? normalizeString(metadata?.channelName)
      ?? normalizeString(input.authorDisplayName),
    channelHandle: normalizeString(articleRecord?.channelHandle)
      ?? normalizeString(metadata?.channelHandle)
      ?? normalizeString(input.authorUsername),
    channelUrl: normalizeString(articleRecord?.channelUrl)
      ?? normalizeString(metadata?.channelUrl),
    thumbnailUrl: canonicalSourceFields?.thumbnailUrl ?? null,
    publishDate: canonicalSourceFields?.publishDate ?? null,
    publishDateText: canonicalSourceFields?.publishDateText ?? null,
    viewCount: normalizeNumber(articleRecord?.viewCount)
      ?? normalizeNumber(metadata?.viewCount),
    viewCountText: normalizeString(articleRecord?.viewCountText)
      ?? normalizeString(metadata?.viewCountText),
    duration: normalizeString(articleRecord?.duration)
      ?? normalizeString(metadata?.duration),
    durationSeconds: normalizeNumber(articleRecord?.durationSeconds)
      ?? normalizeNumber(metadata?.durationSeconds),
    liveStatus: resolvedLiveStatus,
    scheduledStartAt,
    scheduledStartText,
  };
}

export function buildYouTubeFeedMetadata(input: YouTubeFeedData): FeedMetadata {
  return {
    article: {
      platform: 'youtube',
      kind: 'video',
      videoId: input.videoId,
      canonicalUrl: input.canonicalUrl,
      ...(input.title ? { title: input.title } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.channelName ? { channelName: input.channelName } : {}),
      ...(input.channelHandle ? { channelHandle: input.channelHandle } : {}),
      ...(input.channelUrl ? { channelUrl: input.channelUrl } : {}),
      ...(input.thumbnailUrl ? { thumbnailUrl: input.thumbnailUrl } : {}),
      ...(input.publishDate ? { publishDate: input.publishDate } : {}),
      ...(input.publishDateText ? { publishDateText: input.publishDateText } : {}),
      ...(typeof input.viewCount === 'number' ? { viewCount: input.viewCount } : {}),
      ...(input.viewCountText ? { viewCountText: input.viewCountText } : {}),
      ...(input.duration ? { duration: input.duration } : {}),
      ...(typeof input.durationSeconds === 'number' ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.liveStatus ? { liveStatus: input.liveStatus } : {}),
      ...(input.scheduledStartAt ? { scheduledStartAt: input.scheduledStartAt } : {}),
      ...(input.scheduledStartText ? { scheduledStartText: input.scheduledStartText } : {}),
      url: input.canonicalUrl,
    },
    ...(typeof input.viewCount === 'number' ? { viewCount: input.viewCount } : {}),
    ...(input.viewCountText ? { viewCountText: input.viewCountText } : {}),
    linkCard: {
      type: 'video',
      url: input.canonicalUrl,
      title: input.title ?? 'YouTube video',
      domain: 'youtube.com',
      ...(input.thumbnailUrl ? { imageUrl: input.thumbnailUrl } : {}),
      ...(input.videoId ? { videoId: input.videoId } : {}),
      ...(input.description ? { description: input.description } : {}),
    },
  };
}
