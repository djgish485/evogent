import { NextResponse } from 'next/server';
import { getConversationSessions, resetChatSessionMessages } from '@/lib/db/chat-sessions';
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
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  const session = resetChatSessionMessages(normalizedSessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const sessions = getConversationSessions();

  const response = await fetch(`${getInternalBaseUrl()}/api/internal/chat-session-broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      type: 'chat_session_reset',
      sessionId: normalizedSessionId,
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: 'Failed to broadcast chat session reset' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    sessionId: normalizedSessionId,
    sessions,
  });
}
