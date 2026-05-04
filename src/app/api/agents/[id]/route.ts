import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent-manager';
import { cancelCurrentOrchestratorTask, getOrchestratorStatus } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getOrchestratorTaskAgent(id: string) {
  const status = await getOrchestratorStatus().catch(() => null);
  if (!status) {
    return null;
  }

  const tasks = [
    status.currentTask,
    ...(Array.isArray(status.queued) ? status.queued : []),
    ...(Array.isArray(status.history) ? status.history : []),
  ];
  const match = tasks.find((task) => task && typeof task === 'object' && task.id === id);
  if (!match) {
    return null;
  }

  return {
    id,
    type: match.priority === 'post_enrichment' ? 'enrichment' : 'task',
    status: match.state === 'failed'
      ? 'failed'
      : match.state === 'completed'
        ? 'completed'
        : 'running',
    logFile: match.logFile ?? null,
    startedAt: match.startedAt ?? match.enqueuedAt,
    completedAt: match.completedAt ?? null,
    error: match.error ?? null,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await agentManager.ensureReady();
  const { id } = await context.params;
  const status = agentManager.getAgentStatus(id) ?? await getOrchestratorTaskAgent(id);

  if (!status) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  return NextResponse.json({ agent: status });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await agentManager.ensureReady();
  const { id } = await context.params;

  const killed = await agentManager.killAgent(id);
  const status = agentManager.getAgentStatus(id) ?? await getOrchestratorTaskAgent(id);

  if (!killed) {
    const orchestratorCancel = await cancelCurrentOrchestratorTask(id).catch(() => ({ ok: false }));
    if (orchestratorCancel.ok) {
      return NextResponse.json({
        ok: true,
        message: 'Cancel signal sent',
        agent: await getOrchestratorTaskAgent(id),
      });
    }

    if (status) {
      return NextResponse.json({
        ok: false,
        error: `Agent is not running (current status: ${status.status})`,
        agent: status,
      }, { status: 409 });
    }

    return NextResponse.json({ ok: false, error: 'Agent not found' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    message: 'Kill signal sent',
    agent: status,
  });
}
