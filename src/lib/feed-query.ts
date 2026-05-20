import type { FeedItemType } from '@/types/feed';

const feedTypes: FeedItemType[] = ['tweet', 'article', 'analysis', 'suggestion', 'notification'];
export type FeedSortOrder = 'created' | 'published';

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseTypeFilter(raw: string | null): FeedItemType[] {
  const requested = parseList(raw)
    .map((value) => value.toLowerCase())
    .filter((value): value is FeedItemType => feedTypes.includes(value as FeedItemType));

  return Array.from(new Set(requested));
}

export function parseSourceFilter(raw: string | null): string[] {
  return Array.from(new Set(parseList(raw)));
}

export function parseOffset(raw: string | null): number {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function parseLimit(raw: string | null): number {
  const value = Number(raw ?? 20);
  if (!Number.isFinite(value) || value <= 0) return 20;
  return Math.min(100, Math.floor(value));
}

export function parseSort(raw: string | null): FeedSortOrder {
  return raw?.toLowerCase() === 'published' ? 'published' : 'created';
}

export function parseSearchQuery(raw: string | null): string | null {
  if (!raw) return null;

  const normalized = raw
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);

  return normalized || null;
}

export function parseThreadFilter(raw: string | null): string | null {
  if (!raw) return null;

  const normalized = raw.trim().slice(0, 200);
  return normalized || null;
}
