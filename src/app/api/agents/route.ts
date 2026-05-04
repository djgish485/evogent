import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  await agentManager.ensureReady();
  const agents = agentManager.getRunningAgents();

  return NextResponse.json({
    agents,
    count: agents.length,
  });
}
