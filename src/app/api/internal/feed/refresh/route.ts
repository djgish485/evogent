import { NextResponse } from 'next/server';
import { POST as submitPost } from '@/app/api/internal/curate/submit/route';
import { POST as rearrangePost } from '@/app/api/internal/feed/rearrange/route';
import { takeBenchItems, unconsumedBenchCount } from '@/lib/db/curation-bench';
import { harvestFreshToBench } from '@/lib/freshness-harvest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultPromoteLimit = 6;
let lastRefreshAtMs = 0;

/**
 * INSTANT feed refresh — the cheap real-time path (pull-to-refresh, app-open): promote the
 * curator's best benched near-misses into the feed through the real submit machinery
 * (validation, dedup, broadcast), then re-run the deterministic arrange. No brain calls;
 * sub-second. The expensive browse+curate cycle stays the background quality pass that
 * refills the bench. `minIntervalSeconds` lets automatic callers debounce themselves.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    // empty body is fine
  }

  const minIntervalSeconds = typeof body.minIntervalSeconds === 'number' ? body.minIntervalSeconds : 0;
  const nowMs = Date.now();
  if (minIntervalSeconds > 0 && nowMs - lastRefreshAtMs < minIntervalSeconds * 1000) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'refreshed_recently',
      secondsSinceLastRefresh: Math.round((nowMs - lastRefreshAtMs) / 1000),
    });
  }
  lastRefreshAtMs = nowMs;

  // Deterministic freshness floor: before promoting, score fresh unseen shippable cache rows
  // (tweets etc.) and bench the best. This is what keeps the feed self-fresh when the curator
  // ships nothing — the bench no longer depends on the curator to be populated. On by default;
  // pass harvest:false to promote only pre-existing bench items.
  let harvest: { scanned: number; benched: number; bySource: Record<string, number> } | null = null;
  if (body.harvest !== false) {
    try {
      // enrich (fetch og:description for link-post articles) only when the caller opts in — the
      // cycle does (latency-tolerant); on-open/pull leaves it false to stay instant.
      harvest = await harvestFreshToBench(
        typeof body.harvestLimit === 'number' ? body.harvestLimit : 12,
        { enrich: body.enrich === true },
      );
    } catch (error) {
      console.warn(`[feed-refresh] harvest failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const rawLimit = typeof body.limit === 'number' ? body.limit : defaultPromoteLimit;
  const limit = Math.max(1, Math.min(12, Math.round(rawLimit)));

  const taken = takeBenchItems(limit);
  let promoted = 0;
  let duplicates = 0;
  const submitErrors: unknown[] = [];
  if (taken.length > 0) {
    const items = taken.map((entry) => ({
      ...entry.item,
      metadata: {
        ...(entry.item.metadata && typeof entry.item.metadata === 'object' ? entry.item.metadata as Record<string, unknown> : {}),
        benchPromoted: true,
        ...(entry.reason ? { benchReason: entry.reason } : {}),
      },
    }));
    const origin = new URL(request.url).origin;
    const submitRequest = new Request(`${origin}/api/internal/curate/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, triggeredBy: 'feed-refresh-bench' }),
    });
    const submitResult = await submitPost(submitRequest);
    const submitPayload = await submitResult.json() as Record<string, unknown>;
    promoted = typeof submitPayload.accepted === 'number' ? submitPayload.accepted : 0;
    duplicates = typeof submitPayload.duplicates === 'number' ? submitPayload.duplicates : 0;
    if (Array.isArray(submitPayload.errors) && submitPayload.errors.length > 0) {
      submitErrors.push(...submitPayload.errors.slice(0, 3));
    }
  }

  const rearrangeRequest = new Request(new URL(request.url).origin + '/api/internal/feed/rearrange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const rearrangeResult = await rearrangePost(rearrangeRequest);
  const rearrangePayload = await rearrangeResult.json() as Record<string, unknown>;

  return NextResponse.json({
    ok: true,
    harvested: harvest,
    promoted,
    duplicates,
    benchTaken: taken.length,
    benchRemaining: unconsumedBenchCount(),
    submitErrors,
    rearranged: rearrangeResult.ok,
    arrangementRunId: rearrangePayload.arrangementRunId ?? null,
  });
}
