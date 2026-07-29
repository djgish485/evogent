import { NextResponse } from 'next/server';
import { listBrowseCacheItems } from '@/lib/db/browse-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseInteger(value: string | null, fallback: number | null = null): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function parseBoolean(value: string | null): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source');
  const freshAfterMs = parseInteger(searchParams.get('freshAfterMs'));
  const limit = parseInteger(searchParams.get('limit'), 200) ?? 200;
  const includeExpired = searchParams.get('includeExpired') === '1';
  const requirePublishedAt = parseBoolean(searchParams.get('requirePublishedAt'));
  const excludeFeedDuplicates = parseBoolean(searchParams.get('excludeFeedDuplicates'));
  const unseenFirst = parseBoolean(searchParams.get('unseenFirst'));
  const eligibleForCuration = parseBoolean(searchParams.get('eligibleForCuration'));
  const items = listBrowseCacheItems({
    source,
    freshAfterMs,
    includeExpired,
    requirePublishedAt,
    excludeFeedDuplicates,
    unseenFirst,
    eligibleForCuration,
    limit,
  });

  return NextResponse.json({
    ok: true,
    count: items.length,
    items,
  });
}
