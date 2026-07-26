import { NextResponse } from 'next/server';
import { POST as submitPost } from '@/app/api/internal/curate/submit/route';
import { POST as rearrangePost } from '@/app/api/internal/feed/rearrange/route';
import {
  ackBenchItems,
  peekBenchItems,
  quarantineBenchItems,
  unconsumedBenchCount,
} from '@/lib/db/curation-bench';
import { getFeedItemBySourceId } from '@/lib/db/feed';
import { harvestFreshToBench } from '@/lib/freshness-harvest';
import { withFeedMutationLock } from '@/lib/feed-mutation-lock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultPromoteLimit = 6;
let lastRefreshAtMs = 0;

/**
 * INSTANT feed refresh — the cheap real-time path (pull-to-refresh, app-open): promote
 * previously agent-judged bench items through the real submit machinery (validation, dedup,
 * broadcast), then re-run deterministic arrangement. It never performs fresh editorial
 * judgment in the request path. `minIntervalSeconds` lets automatic callers debounce.
 */
async function postUnlocked(request: Request) {
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
  // Agent-judged freshness floor: before promoting, rank only cache rows already stamped by
  // the on-phone taste agent. Unjudged rows remain private cache evidence for the full curator.
  // Pass harvest:false to promote only pre-existing bench items.
  let harvest: {
    scanned: number;
    awaitingJudgment: number;
    withheldBelowThreshold: number;
    benched: number;
    bySource: Record<string, number>;
  } | null = null;
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

  const taken = peekBenchItems(limit);
  let promoted = 0;
  let duplicates = 0;
  const submitErrors: unknown[] = [];
  const permanentSubmitErrorBySourceId = new Map<string, string>();
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
      for (const error of submitPayload.errors) {
        if (!error || typeof error !== 'object' || Array.isArray(error)) continue;
        const record = error as Record<string, unknown>;
        const sourceId = typeof record.sourceId === 'string' ? record.sourceId.trim() : '';
        const message = typeof record.error === 'string' ? record.error.trim() : '';
        if (sourceId && message) permanentSubmitErrorBySourceId.set(sourceId, message);
      }
    }
  }

  // Submit is source-id idempotent. Acknowledge only rows whose durable feed
  // record can now be read, whether this attempt inserted it or found a prior
  // duplicate. Failed/unproven rows remain on the bench for retry.
  const durableSourceIds = new Set(taken
    .filter((entry) => Boolean(getFeedItemBySourceId(entry.sourceId)))
    .map((entry) => entry.sourceId));
  const durableBenchIds = taken
    .filter((entry) => durableSourceIds.has(entry.sourceId))
    .map((entry) => entry.id);
  const benchAcknowledged = ackBenchItems(durableBenchIds);
  const benchQuarantined = quarantineBenchItems(taken.flatMap((entry) => {
    if (durableSourceIds.has(entry.sourceId)) return [];
    const error = permanentSubmitErrorBySourceId.get(entry.sourceId);
    return error ? [{ id: entry.id, error }] : [];
  }));

  const rearrangeRequest = new Request(new URL(request.url).origin + '/api/internal/feed/rearrange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const rearrangeResult = await rearrangePost(rearrangeRequest);
  const rearrangePayload = await rearrangeResult.json() as Record<string, unknown>;
  const handledBenchItems = benchAcknowledged + benchQuarantined;
  const ok = handledBenchItems === taken.length
    && rearrangeResult.ok;
  if (ok) lastRefreshAtMs = nowMs;

  return NextResponse.json({
    ok,
    harvested: harvest,
    promoted,
    duplicates,
    benchTaken: taken.length,
    benchAcknowledged,
    benchQuarantined,
    benchRetained: Math.max(0, taken.length - handledBenchItems),
    benchRemaining: unconsumedBenchCount(),
    submitErrors,
    rearranged: rearrangeResult.ok,
    arrangementRunId: rearrangePayload.arrangementRunId ?? null,
    ...(!ok ? { error: 'Feed refresh did not complete durably; unacknowledged bench items were retained for retry' } : {}),
  }, { status: ok ? 200 : 502 });
}

export async function POST(request: Request) {
  return withFeedMutationLock(() => postUnlocked(request));
}
