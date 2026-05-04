import { NextResponse } from 'next/server';
import { agentManager, type SubAgentType } from '@/lib/agent-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SpawnBody {
  type?: unknown;
  prompt?: unknown;
  options?: {
    timeoutMs?: unknown;
    appendSystemPrompt?: unknown;
    cwd?: unknown;
  } | null;
}

const allowedTypes: SubAgentType[] = ['curation', 'enrichment', 'research'];

function isSubAgentType(value: unknown): value is SubAgentType {
  return typeof value === 'string' && allowedTypes.includes(value as SubAgentType);
}

export async function POST(request: Request) {
  let body: SpawnBody;

  try {
    body = await request.json() as SpawnBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!isSubAgentType(body.type)) {
    return NextResponse.json({ error: 'type must be one of: curation, enrichment, research' }, { status: 400 });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return NextResponse.json({ error: 'prompt must be a non-empty string' }, { status: 400 });
  }

  const timeoutMs = typeof body.options?.timeoutMs === 'number' && Number.isFinite(body.options.timeoutMs)
    ? body.options.timeoutMs
    : undefined;

  const appendSystemPrompt = typeof body.options?.appendSystemPrompt === 'string'
    ? body.options.appendSystemPrompt
    : undefined;

  const cwd = typeof body.options?.cwd === 'string' && body.options.cwd.trim()
    ? body.options.cwd.trim()
    : undefined;

  try {
    const agent = await agentManager.spawnAgent({
      type: body.type,
      prompt,
      options: {
        timeoutMs,
        appendSystemPrompt,
        cwd,
      },
    });

    return NextResponse.json({ ok: true, agent }, { status: 202 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to spawn sub-agent',
    }, { status: 500 });
  }
}
