import { NextResponse } from 'next/server';
import {
  insertAnticipationEvent,
  sanitizeAnticipationTier,
  sanitizeTopics,
} from '@/lib/anticipation';
import { appendChatAuditMessage, notifyChatUpdate } from '@/lib/chat-output';
import {
  markChatMessageDelivered,
  normalizeAgentChatOutput,
  persistChatMessage,
  type ChatMessageInsertInput,
} from '@/lib/db/chat';
import { getDb } from '@/lib/db/client';
import {
  kickChatReplyPushOutbox,
  recordChatReplyPushReceipt,
  scheduleChatReplyPushOutboxMaintenance,
} from '@/lib/chat-reply-push-outbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MISSING_SESSION_ROUTING_ERROR = 'submit payload requires resolvable sessionId, inReplyTo, or originSessionId';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readTrimmedString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function chatSessionExists(db: ReturnType<typeof getDb>, sessionId: string | null): sessionId is string {
  if (!sessionId) return false;
  return Boolean(db.prepare('SELECT 1 FROM chat_sessions WHERE id = ?').get(sessionId));
}

function resolveSubmitSessionId(input: ChatMessageInsertInput, rawBody: unknown): string | null {
  const db = getDb();
  const directSessionId = input.sessionId?.trim() || null;
  if (chatSessionExists(db, directSessionId)) {
    return directSessionId;
  }

  const replyTarget = input.inReplyTo
    ? db.prepare('SELECT session_id FROM chat_messages WHERE id = ?')
      .get(input.inReplyTo) as { session_id: string | null } | undefined
    : undefined;
  const replySessionId = replyTarget?.session_id?.trim() || null;
  if (chatSessionExists(db, replySessionId)) {
    return replySessionId;
  }

  const raw = asRecord(rawBody);
  const metadata = asRecord(raw?.metadata) ?? asRecord(input.metadata);
  const originSessionId = readTrimmedString(raw, 'originSessionId')
    ?? readTrimmedString(metadata, 'originSessionId');
  return chatSessionExists(db, originSessionId) ? originSessionId : null;
}

// The demand event rides ON the chat reply the agent reliably submits, rather than being a
// separate POST the model tends to skip after it's already answered (the self-report
// unreliability we saw in testing). If the reply body carries `anticipation: {tier, topics,
// ...}`, record it here — one event per reply, tied to the answered ask.
function recordAnticipationFromSubmit(rawBody: unknown, sessionId: string, messageId: string | null): void {
  try {
    const raw = asRecord(rawBody);
    const anticipation = asRecord(raw?.anticipation) ?? asRecord(asRecord(raw?.metadata)?.anticipation);
    if (!anticipation) return;
    const tier = sanitizeAnticipationTier(anticipation.tier);
    if (!tier) return;
    const waitedRaw = Number(anticipation.waitedMs);
    insertAnticipationEvent({
      tier,
      topics: sanitizeTopics(anticipation.topics),
      sourceHint: typeof anticipation.sourceHint === 'string' ? anticipation.sourceHint : null,
      sessionId,
      messageId,
      waitedMs: Number.isFinite(waitedRaw) ? waitedRaw : null,
      note: typeof anticipation.note === 'string' ? anticipation.note : null,
    });
  } catch (error) {
    console.warn('[chat-submit] failed to record anticipation event', error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const taskIdHeader = request.headers.get('x-evogent-task-id');
  const normalized = normalizeAgentChatOutput(body, {
    defaultTaskId: taskIdHeader,
    requireTaskIdForChat: false,
  });
  if (!normalized) {
    return NextResponse.json({
      ok: false,
      error: 'Payload must be a valid agent chat or agent_event message.',
    }, { status: 400 });
  }

  const sessionId = resolveSubmitSessionId(normalized, body);
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: MISSING_SESSION_ROUTING_ERROR }, { status: 400 });
  }

  if (normalized.type === 'chat' && !normalized.taskId) {
    return NextResponse.json({
      ok: false,
      error: 'Payload must be a valid agent chat message. Chat replies must include a taskId.',
    }, { status: 400 });
  }

  const persisted = persistChatMessage({ ...normalized, sessionId }, { ignoreConflicts: true });
  if (!persisted) {
    return NextResponse.json({ ok: false, error: 'Failed to persist chat output' }, { status: 500 });
  }

  if (persisted.message.inReplyTo) {
    markChatMessageDelivered(persisted.message.inReplyTo);
  }

  if (persisted.inserted) {
    try {
      await appendChatAuditMessage(persisted.message);
    } catch (error) {
      console.warn('[chat-submit] failed to append chat audit line', error);
    }

    const isAgentChatReply = persisted.message.role === 'agent' && persisted.message.type === 'chat';
    if (isAgentChatReply) {
      // The receipt is committed only after the reply row is durable and the audit append
      // has been attempted. It contains only the chat-row id; native network delivery starts
      // immediately but remains detached from the submit response. A receipt-storage fault
      // must not make the already-durable chat look failed and provoke a duplicate model
      // submission; the primary reply and WebSocket fanout remain successful.
      try {
        const pushReceipt = await recordChatReplyPushReceipt(persisted.message.id);
        if (pushReceipt.state === 'pending') {
          kickChatReplyPushOutbox();
        } else {
          scheduleChatReplyPushOutboxMaintenance();
        }
      } catch {
        console.error('[chat-submit] push receipt persistence failed after durable chat commit');
      }
    }

    void notifyChatUpdate([persisted.message]).catch((error) => {
      console.error('[chat-submit] failed to notify chat websocket server', error);
    });

    if (isAgentChatReply) {
      recordAnticipationFromSubmit(body, sessionId, persisted.message.inReplyTo);
    }
  }

  return NextResponse.json({
    ok: true,
    inserted: persisted.inserted,
    duplicateOf: persisted.inserted ? null : persisted.message.id,
    item: persisted.message,
  });
}
