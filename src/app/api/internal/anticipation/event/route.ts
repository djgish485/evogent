import { NextResponse } from 'next/server';
import {
  computeAnticipationScore,
  insertAnticipationEvent,
  listAnticipationEvents,
  sanitizeAnticipationTier,
  sanitizeTopics,
} from '@/lib/anticipation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sanitizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// The chat agent reports one demand event after serving a request for content or an action:
// feed_hit (it was already in the feed), cache_hit (browse cache had it), or miss (a live
// browse/search was needed). Misses become prefetch hints for the next browse cycle.
export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const tier = sanitizeAnticipationTier(payload.tier);
  if (!tier) {
    return NextResponse.json({ error: "tier must be 'feed_hit', 'cache_hit', or 'miss'" }, { status: 400 });
  }

  const waitedMsRaw = Number(payload.waitedMs);
  const event = insertAnticipationEvent({
    tier,
    topics: sanitizeTopics(payload.topics),
    sourceHint: sanitizeOptionalText(payload.sourceHint),
    sessionId: sanitizeOptionalText(payload.sessionId),
    messageId: sanitizeOptionalText(payload.messageId),
    waitedMs: Number.isFinite(waitedMsRaw) ? waitedMsRaw : null,
    note: sanitizeOptionalText(payload.note),
  });

  return NextResponse.json({
    ok: true,
    event,
    score: computeAnticipationScore().score,
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = Number(searchParams.get('days') ?? '7');
  const limit = Number(searchParams.get('limit') ?? '100');
  const events = listAnticipationEvents({
    days: Number.isFinite(days) ? days : 7,
    limit: Number.isFinite(limit) ? limit : 100,
  });
  return NextResponse.json({ ok: true, events, count: events.length });
}
