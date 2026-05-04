import { NextResponse } from 'next/server';
import { getChatSession } from '@/lib/db/chat-sessions';
import { getInternalBaseUrl } from '@/lib/internal-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  const normalizedSessionId = sessionId.trim();

  if (!isUuid(normalizedSessionId)) {
    return NextResponse.json({ ok: false, error: 'Invalid session ID' }, { status: 400 });
  }

  const session = getChatSession(normalizedSessionId);
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 });
  }

  if (session.provider !== 'claude') {
    return NextResponse.json({ ok: false, error: 'Manual compact is only available for Claude sessions right now' }, { status: 409 });
  }

  const response = await fetch(`${getInternalBaseUrl()}/api/internal/chat-session-compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ sessionId: normalizedSessionId }),
  });
  const data = await response.json() as {
    ok?: boolean;
    error?: string;
    sessionId?: string;
    queued?: boolean;
    message?: string;
  };

  if (!response.ok || !data.ok) {
    return NextResponse.json({
      ok: false,
      error: data.error || `Failed to compact session (${response.status})`,
    }, { status: response.status || 500 });
  }

  return NextResponse.json({
    ok: true,
    sessionId: data.sessionId ?? normalizedSessionId,
    queued: data.queued === true,
    message: typeof data.message === 'string' ? data.message : null,
  }, { status: 202 });
}
