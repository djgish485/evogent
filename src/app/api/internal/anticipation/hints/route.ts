import { NextResponse } from 'next/server';
import { getUnresolvedMissTopics } from '@/lib/anticipation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Prefetch directives for the browse cycle: topics the user recently asked for that nothing
// had anticipated. The browse agents search for these while filling the cache, so a repeat
// ask upgrades from a minutes-long miss to a seconds-long cache hit.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = Number(searchParams.get('days') ?? '3');
  const limit = Number(searchParams.get('limit') ?? '8');
  const missed = getUnresolvedMissTopics({
    days: Number.isFinite(days) ? days : 3,
    limit: Number.isFinite(limit) ? limit : 8,
  });
  return NextResponse.json({
    ok: true,
    topics: missed.map((entry) => entry.topic),
    detail: missed,
  });
}
