import { NextResponse } from 'next/server';
import { appendChatAuditMessage, notifyChatUpdate } from '@/lib/chat-output';
import { getMostRecentActivity } from '@/lib/db/activity';
import { markChatMessageDelivered, normalizeAgentChatOutput, persistChatMessage } from '@/lib/db/chat';
import {
  getPushNotificationEventConfig,
  readPushNotificationConfig,
  sendPushNotification,
  shouldSuppressPushNotification,
} from '@/lib/push-notify';
import type { ChatMessage } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function queueChatReplyPushNotification(message: ChatMessage): void {
  void (async () => {
    try {
      const config = await readPushNotificationConfig();
      const eventConfig = getPushNotificationEventConfig(config, 'chat_reply');
      if (!eventConfig) return;

      const latestActivity = getMostRecentActivity();
      if (shouldSuppressPushNotification(latestActivity, eventConfig)) {
        return;
      }

      await sendPushNotification('chat_reply', message.text, {
        config,
        title: eventConfig.title,
      });
    } catch (error) {
      console.warn(`[chat-submit] failed to send push notification for chat ${message.id}`, error);
    }
  })();
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
    requireTaskIdForChat: true,
  });
  if (!normalized) {
    return NextResponse.json({
      ok: false,
      error: 'Payload must be a valid agent chat or agent_event message. Chat replies must include a taskId.',
    }, { status: 400 });
  }

  const persisted = persistChatMessage(normalized, { ignoreConflicts: true });
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

    try {
      await notifyChatUpdate([persisted.message]);
    } catch (error) {
      console.error('[chat-submit] failed to notify chat websocket server', error);
    }

    if (persisted.message.role === 'agent' && persisted.message.type === 'chat') {
      queueChatReplyPushNotification(persisted.message);
    }
  }

  return NextResponse.json({
    ok: true,
    inserted: persisted.inserted,
    duplicateOf: persisted.inserted ? null : persisted.message.id,
    item: persisted.message,
  });
}
