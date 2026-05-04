import { NextResponse } from 'next/server';
import { recordBrowseCacheRefresh, type UpsertBrowseCacheItemInput } from '@/lib/db/browse-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRunMetadata(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.metadata !== undefined && !isRecord(payload.metadata)) {
    throw new Error('Field "metadata" must be a JSON object when provided');
  }

  if (payload.cycleSummary !== undefined && !isRecord(payload.cycleSummary)) {
    throw new Error('Field "cycleSummary" must be a JSON object when provided');
  }

  const metadata = isRecord(payload.metadata) ? { ...payload.metadata } : {};
  if (isRecord(payload.cycleSummary)) {
    metadata.cycleSummary = payload.cycleSummary;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const items = Array.isArray((payload as { items?: unknown }).items)
    ? (payload as { items: UpsertBrowseCacheItemInput[] }).items
    : [];

  try {
    const metadata = readRunMetadata(payload as Record<string, unknown>);
    const run = recordBrowseCacheRefresh({
      runId: typeof (payload as { runId?: unknown }).runId === 'string' ? (payload as { runId: string }).runId : null,
      source: typeof (payload as { source?: unknown }).source === 'string' ? (payload as { source: string }).source : '',
      triggeredBy: typeof (payload as { triggeredBy?: unknown }).triggeredBy === 'string'
        ? (payload as { triggeredBy: string }).triggeredBy
        : 'cache_refresh',
      startedAtMs: Number((payload as { startedAtMs?: unknown }).startedAtMs),
      completedAtMs: typeof (payload as { completedAtMs?: unknown }).completedAtMs === 'number'
        ? (payload as { completedAtMs: number }).completedAtMs
        : Date.now(),
      status: typeof (payload as { status?: unknown }).status === 'string' ? (payload as { status: string }).status : 'completed',
      itemsAdded: typeof (payload as { itemsAdded?: unknown }).itemsAdded === 'number'
        ? (payload as { itemsAdded: number }).itemsAdded
        : undefined,
      error: typeof (payload as { error?: unknown }).error === 'string' ? (payload as { error: string }).error : null,
      items,
      metadata,
    });

    return NextResponse.json({
      ok: true,
      run,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to persist browse cache refresh',
    }, { status: 400 });
  }
}
