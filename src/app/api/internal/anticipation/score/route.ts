import { NextResponse } from 'next/server';
import { computeAnticipationScore } from '@/lib/anticipation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The anticipation scorecard: net score over a rolling window, demand hit/miss breakdown,
// engagement counts, daily trend, and the unresolved missed topics driving the next prefetch.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = Number(searchParams.get('days') ?? '7');
  const score = computeAnticipationScore({ days: Number.isFinite(days) ? days : 7 });
  return NextResponse.json({ ok: true, ...score });
}
