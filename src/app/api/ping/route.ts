import { NextResponse } from 'next/server';
import { enqueueOrchestratorMessage } from '@/lib/orchestrator';
import { insertUserActivity } from '@/lib/db/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const message = typeof (payload as { message?: unknown }).message === 'string'
    ? (payload as { message: string }).message
    : '';

  const trimmed = message.trim();
  if (!trimmed) {
    return NextResponse.json({ error: 'message must be a non-empty string' }, { status: 400 });
  }

  let result;
  try {
    const messageForBrain = trimmed.startsWith('/') ? trimmed : `User ping: ${trimmed}`;
    insertUserActivity('ping', { endpoint: '/api/ping' });
    result = await enqueueOrchestratorMessage({
      message: messageForBrain,
      priority: 'user_ping',
      source: 'user_ping',
      metadata: { endpoint: '/api/ping' },
    });
  } catch {
    return NextResponse.json({
      ok: false,
      enqueued: false,
      requestId: null,
      queueDepth: 0,
      message: 'Failed to queue message for evogent orchestrator',
    }, { status: 503 });
  }

  return NextResponse.json({
    ok: result.ok,
    enqueued: result.ok,
    requestId: result.requestId ?? null,
    queueDepth: result.queueDepth,
    message: result.ok
      ? 'Message queued for evogent orchestrator'
      : (result.error ?? 'Failed to queue message for evogent orchestrator'),
  }, { status: result.ok ? 200 : 503 });
}
