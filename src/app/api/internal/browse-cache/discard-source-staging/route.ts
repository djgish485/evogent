import { NextResponse } from 'next/server';
import { discardUnactivatedSourceDiscoveryRun } from '@/lib/db/browse-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  try {
    const discarded = discardUnactivatedSourceDiscoveryRun(source, runId);
    return NextResponse.json({ ok: true, source, runId, discarded });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to discard source discovery staging',
    }, { status: 400 });
  }
}
