import { NextResponse } from 'next/server';
import { getChatMessagesPage } from '@/lib/db/chat';
import { getConversationSessions as getPersistedConversationSessions } from '@/lib/db/chat-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sanitizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitRaw = searchParams.get('limit');
  const offsetRaw = searchParams.get('offset');
  const sessionId = sanitizeOptionalText(searchParams.get('sessionId'));
  const parsedLimit = limitRaw ? Number(limitRaw) : 150;
  const parsedOffset = offsetRaw ? Number(offsetRaw) : 0;
  const page = getChatMessagesPage({
    sessionId,
    limit: Number.isFinite(parsedLimit) ? parsedLimit : 150,
    offset: Number.isFinite(parsedOffset) ? parsedOffset : 0,
  });
  return NextResponse.json({
    items: page.items,
    count: page.items.length,
    totalCount: page.totalCount,
    hasMore: page.hasMore,
    offset: page.offset,
    sessionId,
    sessions: getPersistedConversationSessions(),
  });
}
