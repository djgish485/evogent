import { NextResponse } from 'next/server';
import { enqueueCacheRefreshForCuration } from '../../../../../../lib/cache-refresh-on-demand.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultTimeoutMs = 60_000;
const maxTimeoutMs = 4 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTimeoutMs(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return defaultTimeoutMs;
  }
  return Math.min(maxTimeoutMs, Math.max(1, Math.floor(parsed)));
}

export async function POST(request: Request) {
  let payload: unknown = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const body = isRecord(payload) ? payload : {};
  const task = isRecord(body.task) ? body.task : {};
  const waitForCompletion = body.waitForCompletion === true;
  const timeoutMs = normalizeTimeoutMs(body.timeoutMs);

  try {
    const result = await enqueueCacheRefreshForCuration(task, {
      rootDir: process.cwd(),
      configPath: `${process.cwd()}/data/config.md`,
      timeoutMs,
      waitForCompletion,
    });

    return NextResponse.json({
      ok: true,
      triggered: result.skipped !== true,
      ...result,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      triggered: false,
      error: error instanceof Error ? error.message : 'pre-curation cache refresh failed',
    }, { status: 500 });
  }
}
