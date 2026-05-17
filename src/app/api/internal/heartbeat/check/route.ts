import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const triggeredByRaw = (payload as { triggeredBy?: unknown }).triggeredBy;
  const triggeredBy = typeof triggeredByRaw === 'string' && triggeredByRaw.trim()
    ? triggeredByRaw.trim()
    : 'timer';

  return NextResponse.json({
    ok: true,
    skipped: true,
    reason: 'openclaw_curator_managed',
    triggered: false,
    triggerReason: 'openclaw_curator_managed',
    decisionReason: 'openclaw_curator_managed',
    requestId: null,
    queueDepth: 0,
    triggeredBy,
    checkedAt: new Date().toISOString(),
  });
}
