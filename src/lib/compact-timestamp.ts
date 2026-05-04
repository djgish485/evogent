import type { FeedItem } from '@/types/feed';

type TimestampedFeedItem = Pick<FeedItem, 'createdAt' | 'publishedAt'>;

function normalizeTimestampValue(value?: string | null): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function getFeedItemCompactTimestampSource(item?: TimestampedFeedItem | null): string | null {
  return normalizeTimestampValue(item?.publishedAt) ?? normalizeTimestampValue(item?.createdAt);
}

export function formatCompactTimestamp(value?: string | null, now = Date.now()): string {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const diffMinutes = Math.floor((now - date.getTime()) / 60000);
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
