import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@/lib/data-dir';
import type { ChatMessage } from '@/types/chat';

const chatOutputPath = getDataPath('chat-output.jsonl');
const defaultChatNotifyUrl = `http://127.0.0.1:${process.env.PORT || '3001'}/api/internal/chat-notify`;

function buildChatAuditRecord(message: ChatMessage): Record<string, unknown> {
  return {
    type: message.type,
    id: message.id,
    role: message.role,
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    text: message.text,
    timestamp: message.timestamp,
    ...(message.metadata ? { metadata: message.metadata } : {}),
  };
}

export async function appendChatAuditMessage(message: ChatMessage): Promise<void> {
  await fs.promises.mkdir(path.dirname(chatOutputPath), { recursive: true });
  await fs.promises.appendFile(chatOutputPath, `${JSON.stringify(buildChatAuditRecord(message))}\n`, 'utf8');
}

export async function notifyChatUpdate(
  items: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (items.length === 0) return;

  const notifyUrl = process.env.INTERNAL_CHAT_NOTIFY_URL || defaultChatNotifyUrl;
  await fetchImpl(notifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, count: items.length }),
  });
}
