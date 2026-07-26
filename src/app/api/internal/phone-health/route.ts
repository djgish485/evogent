import { NextResponse } from 'next/server';
import { getOrchestratorStatus } from '@/lib/orchestrator';
import { readPhoneHealth } from '@/lib/phone-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const phone = readPhoneHealth();
  const orchestrator = await getOrchestratorStatus().catch(() => null);
  const brainReady = orchestrator?.brainAvailable !== false;
  const ok = phone.ok && orchestrator !== null && brainReady;

  return NextResponse.json({
    ...phone,
    ok,
    orchestrator: orchestrator
      ? {
          brainProvider: orchestrator.brainProvider ?? null,
          brainAvailable: brainReady,
          isProcessing: Boolean(orchestrator.isProcessing),
          currentTaskId: orchestrator.currentTask?.id ?? null,
          queueDepth: Array.isArray(orchestrator.queued) ? orchestrator.queued.length : 0,
        }
      : null,
    criticalProblems: [
      ...phone.criticalProblems,
      ...(!orchestrator ? ['orchestrator_unreachable'] : []),
      ...(orchestrator && !brainReady ? ['brain_unavailable'] : []),
    ],
  }, { status: ok ? 200 : 503 });
}
