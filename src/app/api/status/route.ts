import { NextResponse } from 'next/server';
import { getOrchestratorStatus } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DeploymentStatusResponse {
  running: {
    startedAt: string;
    nodeEnv: string | null;
    version: string | null;
    buildId: string | null;
    commit: string | null;
    commitFull: string | null;
  };
  pendingRestart: Record<string, unknown> | null;
}

function getInternalBaseUrl(): string {
  if (process.env.ORCHESTRATOR_INTERNAL_URL) {
    return process.env.ORCHESTRATOR_INTERNAL_URL;
  }

  const internalPort = process.env.PORT || '3001';
  return `http://127.0.0.1:${internalPort}`;
}

async function getDeploymentStatus(): Promise<DeploymentStatusResponse | null> {
  const response = await fetch(`${getInternalBaseUrl()}/api/internal/deployment-status`, {
    method: 'GET',
    cache: 'no-store',
  });

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<DeploymentStatusResponse>;
}

export async function GET() {
  const [orchestrator, deployment] = await Promise.all([
    getOrchestratorStatus().catch(() => null),
    getDeploymentStatus().catch(() => null),
  ]);
  const sessionExists = Boolean(orchestrator);
  const working = Boolean(orchestrator?.isProcessing);
  const paneTail = orchestrator?.brain?.paneTail ?? null;

  return NextResponse.json({
    sessionExists,
    working,
    brainProvider: orchestrator?.brainProvider ?? null,
    brainProviderLabel: orchestrator?.brainProviderLabel ?? null,
    brainAvailable: orchestrator?.brainAvailable ?? true,
    paneTail,
    orchestrator,
    deployment,
    checkedAt: new Date().toISOString(),
  });
}
