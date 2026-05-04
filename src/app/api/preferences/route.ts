import { NextResponse } from 'next/server';
import {
  getPreferencesPage,
  getRecentPreferences,
  getPreferenceStats,
} from '@/lib/db/preferences';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseLimit(raw: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || String(fallback), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(2000, parsed)) : fallback;
}

function parsePageLimit(raw: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || String(fallback), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : fallback;
}

function parseOffset(raw: string | null | undefined): number {
  const parsed = Number.parseInt(raw || '0', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseIsoTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = (searchParams.get('type') || '').trim().toLowerCase();
  const limit = parsePageLimit(searchParams.get('limit'), 50);
  const offset = parseOffset(searchParams.get('offset'));
  const page = getPreferencesPage({
    signalType: type,
    limit,
    offset,
  });
  const stats = getPreferenceStats();

  return NextResponse.json({
    items: page.items,
    count: page.items.length,
    stats,
    pagination: {
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.hasMore,
      nextOffset: page.offset + page.items.length,
    },
    filters: {
      type: type || 'all',
    },
  });
}

export async function POST(request: Request) {
  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const type = typeof payload.type === 'string' ? payload.type.trim().toLowerCase() : '';
  const limit = typeof payload.limit === 'number'
    ? Math.max(1, Math.min(2000, Math.floor(payload.limit)))
    : parseLimit(typeof payload.limit === 'string' ? payload.limit : null, 250);
  const onlyWithReason = payload.onlyWithReason === true;

  const hours = typeof payload.hours === 'number'
    ? Math.max(1, Math.floor(payload.hours))
    : Number.parseInt(typeof payload.hours === 'string' ? payload.hours : '48', 10);
  const sinceFromBody = parseIsoTimestamp(payload.since);
  const since = sinceFromBody || new Date(Date.now() - (Number.isFinite(hours) ? Math.max(1, hours) : 48) * 60 * 60 * 1000).toISOString();

  const items = getRecentPreferences({
    limit,
    signalType: type || null,
    since,
    onlyWithReason,
  });

  const stats = getPreferenceStats();
  const reasonedCount = items.filter((item) => typeof item.reason === 'string' && item.reason.trim()).length;

  return NextResponse.json({
    items,
    count: items.length,
    reasonedCount,
    stats,
    filters: {
      type: type || null,
      since,
      onlyWithReason,
      limit,
    },
  });
}
