import { NextResponse } from 'next/server';
import { markBrowseCacheItemsSeen } from '@/lib/db/browse-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const items = Array.isArray((payload as { items?: unknown }).items)
    ? (payload as { items: Array<{ source: string; sourceId: string }> }).items
    : [];
  const seenAtMs = typeof (payload as { seenAtMs?: unknown }).seenAtMs === 'number'
    ? (payload as { seenAtMs: number }).seenAtMs
    : Date.now();

  return NextResponse.json({
    ok: true,
    changed: markBrowseCacheItemsSeen(items, seenAtMs),
  });
}
