import { NextResponse } from 'next/server';
import { evaluateAdaptiveHeartbeat } from '@/lib/heartbeat-service';

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

  try {
    const result = await evaluateAdaptiveHeartbeat({ triggeredBy });

    return NextResponse.json({
      ok: true,
      triggered: result.triggered,
      triggerReason: result.triggerReason,
      decisionReason: result.decision.reason,
      requestId: result.requestId,
      queueDepth: result.queueDepth,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      triggered: false,
      error: error instanceof Error ? error.message : 'adaptive heartbeat check failed',
    }, { status: 500 });
  }
}
