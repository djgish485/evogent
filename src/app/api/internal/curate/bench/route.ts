import { NextResponse } from 'next/server';
import {
  preflightCurateSubmitItemShape,
  preflightCurateSubmitItemUrl,
} from '@/app/api/internal/curate/submit/route';
import { insertBenchItems, unconsumedBenchCount, type BenchInsertInput } from '@/lib/db/curation-bench';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const maxBenchItemsPerSubmit = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The curator submits its ranked NEAR-MISSES here at the end of each cycle: items that passed
 * the quality bar but lost on slate slots. Each entry carries the exact item shape it would
 * have sent to /api/internal/curate/submit, plus a score and reason. Instant-refresh paths
 * (pull-to-refresh, app-open) later promote the best of them with zero brain latency.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!isRecord(body)) {
    return NextResponse.json({ ok: false, error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const record = body;
  const cycleId = typeof record.cycleId === 'string' ? record.cycleId.trim() || null : null;
  const rawItems = Array.isArray(record.items) ? record.items : null;
  if (!cycleId || cycleId.length > 160) {
    return NextResponse.json({ ok: false, error: 'cycleId is required and must be 160 characters or fewer' }, { status: 400 });
  }
  if (!rawItems || rawItems.length === 0) {
    return NextResponse.json({ ok: false, error: 'items array is required' }, { status: 400 });
  }
  if (rawItems.length > maxBenchItemsPerSubmit) {
    return NextResponse.json({
      ok: false,
      error: `items may contain at most ${maxBenchItemsPerSubmit} entries`,
    }, { status: 400 });
  }

  const requestReceivedAtMs = Date.now();
  const results = await Promise.all(rawItems.map(async (raw, index): Promise<
    { input: BenchInsertInput; error: null } | { input: null; error: string }
  > => {
    if (!isRecord(raw)) {
      return { input: null, error: `items[${index}] must be an object` };
    }
    const entry = raw;
    const item = isRecord(entry.item) ? entry.item : null;
    if (!item) {
      return { input: null, error: `items[${index}].item must be a curate/submit-shaped object` };
    }
    const score = typeof entry.score === 'number' && Number.isFinite(entry.score)
      ? entry.score
      : Number.NaN;
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      return { input: null, error: `items[${index}].score must be a number between 0 and 1` };
    }
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() || null : null;
    if (!reason || reason.length > 280) {
      return { input: null, error: `items[${index}].reason is required and must be 280 characters or fewer` };
    }

    const shape = preflightCurateSubmitItemShape(
      item,
      index,
      requestReceivedAtMs,
      { requireInterest: true, requirePrimaryRoot: true },
    );
    if (!shape.ok) {
      return { input: null, error: `items[${index}].item: ${shape.error.error}` };
    }

    const normalized = shape.normalized;
    const source = typeof normalized.source === 'string' ? normalized.source.trim() : '';
    const sourceId = typeof normalized.sourceId === 'string' ? normalized.sourceId.trim() : '';
    if (!source || !sourceId) {
      return {
        input: null,
        error: `items[${index}].item must normalize to non-empty source and sourceId`,
      };
    }

    const metadata = isRecord(normalized.metadata) ? normalized.metadata : null;
    const interest = metadata && isRecord(metadata.interest) ? metadata.interest : null;
    if (!interest || typeof interest.durability !== 'string') {
      return {
        input: null,
        error: `items[${index}].item requires submit-ready metadata.interest with score and durability`,
      };
    }
    if (Math.abs((interest.score as number) - score) > Number.EPSILON) {
      return {
        input: null,
        error: `items[${index}].score must match items[${index}].item.metadata.interest.score`,
      };
    }

    const urlResult = await preflightCurateSubmitItemUrl(normalized, index);
    if (!urlResult.ok) {
      return { input: null, error: `items[${index}].item: ${urlResult.error.error}` };
    }

    return {
      error: null,
      input: {
        cycleId,
        source,
        sourceId,
        score,
        reason,
        itemJson: JSON.stringify(normalized),
      },
    };
  }));

  const inputs = results.flatMap((result) => result.input ? [result.input] : []);
  const errors = results.flatMap((result) => result.error ? [result.error] : []);
  const inserted = inputs.length > 0 ? insertBenchItems(inputs) : 0;
  return NextResponse.json({
    ok: errors.length === 0,
    benched: inserted,
    rejected: errors.length,
    errors: errors.slice(0, 5),
    unconsumedBenchCount: unconsumedBenchCount(),
  });
}
