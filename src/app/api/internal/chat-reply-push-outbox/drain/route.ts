import { NextResponse } from 'next/server';
import { startChatReplyPushOutbox } from '@/lib/chat-reply-push-outbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  startChatReplyPushOutbox();
  return NextResponse.json({ ok: true, started: true });
}
