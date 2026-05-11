import { NextResponse } from 'next/server';
import { evaluateAdaptiveHeartbeat } from '@/lib/heartbeat-service';
import { hasCurationCapability } from '../../../../../../lib/cache-refresh-config.js';

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

  if (!hasCurationCapability(process.cwd())) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'no_curation_capability',
      triggered: false,
      checkedAt: new Date().toISOString(),
    });
  }

  try {
    const result = await evaluateAdaptiveHeartbeat({ triggeredBy });

    return NextResponse.json({
      ok: true,
      triggered: result.triggered,
      triggerReason: result.triggerReason,
      decisionReason: result.decision.reason,
      timeZone: result.decision.analysis.timeZone,
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
