import type { FeedItem } from '@/types/feed';

const QUOTED_TWEET_STATUS_URL_PATTERN = /https:\/\/(?:x\.com|twitter\.com)\/\w+\/status\/\d+(?:\?[^\s]*)?(?:#[^\s]*)?/gi;
const URL_TOKEN_PATTERN = /https?:\/\/[^\s]+/g;
const TRAILING_TWEET_MEDIA_URL_PATTERN = /(?:\s+https:\/\/t\.co\/[A-Za-z0-9]+)+\s*$/i;

export function stripTrailingTweetMediaUrls(text: string): string {
  return text.replace(TRAILING_TWEET_MEDIA_URL_PATTERN, '').trimEnd();
}

export function stripQuotedTweetUrlsForDisplay(item: Pick<FeedItem, 'type' | 'text' | 'metadata' | 'mediaUrls'>): string {
  let text = item.text;

  if (item.type === 'tweet' && item.metadata?.quotedTweet) {
    text = text.replace(QUOTED_TWEET_STATUS_URL_PATTERN, '').trimEnd();
  }

  const hasInlineMedia = item.type === 'tweet' && (
    (Array.isArray(item.metadata?.media) && item.metadata.media.length > 0)
    || (Array.isArray(item.mediaUrls) && item.mediaUrls.length > 0)
  );

  return hasInlineMedia ? stripTrailingTweetMediaUrls(text) : text;
}

export function stripLeadingReplyMentions(text: string): string {
  const stripped = text.replace(/^(?:@\w+\s*)+/, '').trimStart();
  return stripped || text;
}

function trimUrlToken(value: string): { url: string; trailing: string } {
  const match = value.match(/^(.*?)([),.!?:;]+)$/);
  if (!match) {
    return { url: value, trailing: '' };
  }

  return { url: match[1], trailing: match[2] };
}

function normalizeUrlForComparison(value: string): string {
  const { url } = trimUrlToken(value.trim());
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return url.endsWith('/') ? url.slice(0, -1) : url;
  }
}

function collectLinkPreviewUrls(item: Pick<FeedItem, 'type' | 'metadata'>): Set<string> {
  if (item.type !== 'tweet') {
    return new Set();
  }

  const urls = new Set<string>();
  const linkPreviews = item.metadata?.linkPreviews ?? [];

  for (const preview of linkPreviews) {
    if (typeof preview.url === 'string' && preview.url.trim()) {
      urls.add(normalizeUrlForComparison(preview.url));
    }
  }

  if (typeof item.metadata?.linkCard?.url === 'string' && item.metadata.linkCard.url.trim()) {
    urls.add(normalizeUrlForComparison(item.metadata.linkCard.url));
  }

  if (urls.size === 0) {
    return urls;
  }

  for (const entity of item.metadata?.urlEntities ?? []) {
    if (typeof entity.url === 'string' && entity.url.trim()) {
      urls.add(normalizeUrlForComparison(entity.url));
    }
    if (typeof entity.expandedUrl === 'string' && entity.expandedUrl.trim()) {
      urls.add(normalizeUrlForComparison(entity.expandedUrl));
    }
  }

  return urls;
}

export function stripLinkPreviewUrlsForDisplay(
  item: Pick<FeedItem, 'type' | 'text' | 'metadata'>,
  text = item.text,
): string {
  const removableUrls = collectLinkPreviewUrls(item);
  if (removableUrls.size === 0 || !text) {
    return text;
  }

  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(URL_TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    const { url, trailing } = trimUrlToken(token);

    result += text.slice(lastIndex, index);

    if (removableUrls.has(normalizeUrlForComparison(url))) {
      const previousChar = index > 0 ? text[index - 1] : '';
      const nextChar = text[index + token.length] ?? '';
      if ((index === 0 || previousChar === '\n') && nextChar === '\n' && !trailing) {
        lastIndex = index + token.length + 1;
        continue;
      }

      result += trailing;
    } else {
      result += token;
    }

    lastIndex = index + token.length;
  }

  result += text.slice(lastIndex);

  return result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([),.!?:;])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function getLineCutIndex(text: string, lineLimit: number): number {
  if (lineLimit < 1) {
    return 0;
  }

  let lineCount = 1;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') {
      continue;
    }

    lineCount += 1;
    if (lineCount > lineLimit) {
      return index;
    }
  }

  return text.length;
}

function findSafeUrlCutIndex(text: string, cutIndex: number): number {
  if (cutIndex >= text.length) {
    return text.length;
  }

  for (const match of text.matchAll(URL_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    const token = match[0];
    const { url } = trimUrlToken(token);
    const end = index + url.length;

    if (index < cutIndex && cutIndex < end) {
      return index;
    }
  }

  return cutIndex;
}

export function truncateTextForCollapsedDisplay(
  text: string,
  options: { charLimit: number; lineLimit: number },
): string {
  const charCutIndex = Math.min(text.length, options.charLimit);
  const lineCutIndex = getLineCutIndex(text, options.lineLimit);
  const cutIndex = Math.min(charCutIndex, lineCutIndex);

  if (cutIndex >= text.length) {
    return text;
  }

  return text.slice(0, findSafeUrlCutIndex(text, cutIndex)).trimEnd();
}
