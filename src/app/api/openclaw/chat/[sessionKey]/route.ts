import { NextResponse } from 'next/server';
import {
  getOpenClawHistory,
  sendOpenClawMessage,
} from '@/lib/openclaw/sessions';
import { isOpenClawHeartbeatMessage } from '@/lib/openclaw/heartbeat';
import { getChatMessagesPage, persistChatMessage } from '@/lib/db/chat';
import { mergeChatMessages } from '@/lib/chat-messages';
import { normalizeGatewayErrorMessage } from '@/lib/openclaw/gateway-client';
import { type ChatMessage } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function decodeSessionKey(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

function sanitizeMessage(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readIdempotencyKey(message: ChatMessage): string {
  const value = message.metadata?.idempotencyKey;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function copyLocalIdempotencyKeys(remoteMessages: ChatMessage[], localMessages: ChatMessage[]): ChatMessage[] {
  const localUserMessages = localMessages.filter((message) => (
    message.role === 'user'
    && message.type === 'chat'
    && readIdempotencyKey(message)
  ));

  return remoteMessages.map((message) => {
    if (message.role !== 'user' || message.type !== 'chat' || readIdempotencyKey(message)) {
      return message;
    }

    const matches = localUserMessages.filter((localMessage) => (
      localMessage.sessionId === message.sessionId
      && localMessage.text === message.text
    ));
    if (matches.length !== 1) {
      return message;
    }

    return {
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        idempotencyKey: readIdempotencyKey(matches[0]),
      },
    };
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionKey: string }> },
) {
  const { sessionKey } = await context.params;
  const key = decodeSessionKey(sessionKey);
  if (!key) {
    return NextResponse.json({ ok: false, error: 'OpenClaw session key is required' }, { status: 400 });
  }

  try {
    const history = await getOpenClawHistory(key);
    const persistedMessages = getChatMessagesPage({
      sessionId: history.sessionId,
      limit: 5_000,
    }).items;
    const historyMessages = copyLocalIdempotencyKeys(
      Array.isArray(history.messages) ? history.messages : [],
      persistedMessages,
    );

    const messages = mergeChatMessages(persistedMessages, historyMessages)
      .filter((message) => !isOpenClawHeartbeatMessage(message));

    return NextResponse.json({
      ok: true,
      ...history,
      messages,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: normalizeGatewayErrorMessage(error),
      sessionKey: key,
      messages: [],
    }, { status: 503 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionKey: string }> },
) {
  const { sessionKey } = await context.params;
  const key = decodeSessionKey(sessionKey);
  if (!key) {
    return NextResponse.json({ ok: false, error: 'OpenClaw session key is required' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const message = sanitizeMessage((payload as { message?: unknown }).message);
  if (!message) {
    return NextResponse.json({ ok: false, error: 'message must be a non-empty string' }, { status: 400 });
  }

  try {
    const result = await sendOpenClawMessage(key, message);
    const userMessage = result.userMessage as ChatMessage;
    const persisted = persistChatMessage({
      id: userMessage.id,
      type: userMessage.type,
      role: userMessage.role,
      inReplyTo: userMessage.inReplyTo,
      sessionId: userMessage.sessionId,
      text: userMessage.text,
      timestamp: userMessage.timestamp,
      context: userMessage.context,
      status: userMessage.status,
      metadata: userMessage.metadata,
    }, { ignoreConflicts: true });

    return NextResponse.json({
      ...result,
      userMessage: persisted?.message ?? userMessage,
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: normalizeGatewayErrorMessage(error),
      sessionKey: key,
    }, { status: 503 });
  }
}
