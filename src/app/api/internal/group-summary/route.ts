import { NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  buildGroupedCardSummary,
  serializeGroupedCardSummaryRequest,
  type GroupedCardSummary,
  type GroupedCardSummaryRequest,
} from '@/lib/grouped-card-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const summaryCache = new Map<string, { summary: GroupedCardSummary; createdAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function computeCacheKey(request: GroupedCardSummaryRequest): string {
  return crypto
    .createHash('sha256')
    .update(serializeGroupedCardSummaryRequest(request))
    .digest('hex')
    .slice(0, 16);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as GroupedCardSummaryRequest;

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json({ error: 'items array required' }, { status: 400 });
    }

    if (body.groupType !== 'suggestion' && body.groupType !== 'notification') {
      return NextResponse.json({ error: 'groupType must be suggestion or notification' }, { status: 400 });
    }

    const cacheKey = computeCacheKey(body);

    const cached = summaryCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return NextResponse.json({ summary: cached.summary, cached: true });
    }

    const summary = buildGroupedCardSummary(body);

    summaryCache.set(cacheKey, { summary, createdAt: Date.now() });

    if (summaryCache.size > 100) {
      const now = Date.now();
      for (const [key, val] of summaryCache) {
        if (now - val.createdAt > CACHE_TTL_MS) {
          summaryCache.delete(key);
        }
      }
    }

    return NextResponse.json({ summary, cached: false });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
