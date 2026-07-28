import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@/lib/data-dir';
import type { ChatMessage } from '@/types/chat';

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
  const chatOutputPath = getDataPath('chat-output.jsonl');
  await fs.promises.mkdir(path.dirname(chatOutputPath), { recursive: true });
  await fs.promises.appendFile(chatOutputPath, `${JSON.stringify(buildChatAuditRecord(message))}\n`, 'utf8');
}

/**
 * Remove startup-migration targets from the local append-only chat audit.
 *
 * Normal operation remains append-only. A privacy migration is the exceptional
 * case where retaining an old line is less safe than atomically replacing the
 * file. The replacement is synchronized before this returns so a database
 * marker can be committed only after the matching audit lines are durably gone.
 */
export function scrubChatAuditMessages(messageIds: Iterable<string>): number {
  const targetIds = new Set(
    [...messageIds]
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (targetIds.size === 0) return 0;

  const chatOutputPath = getDataPath('chat-output.jsonl');
  let original: string;
  try {
    original = fs.readFileSync(chatOutputPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  let removedCount = 0;
  const retainedLines = original.split('\n').filter((line) => {
    if (!line.trim()) return true;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === 'string' && targetIds.has(parsed.id.trim())) {
        removedCount += 1;
        return false;
      }
    } catch {
      // A crash can leave the final append incomplete. Its leading object
      // fields still contain the writer's exact message ID, so remove it when
      // that ID is an explicit migration target; preserve unrelated damage.
      const rawIdLiteral = line.match(
        /(?:^|[{,])\s*"id"\s*:\s*("(?:\\.|[^"\\])*")/,
      )?.[1];
      if (rawIdLiteral) {
        try {
          const rawId = JSON.parse(rawIdLiteral) as unknown;
          if (typeof rawId === 'string' && targetIds.has(rawId.trim())) {
            removedCount += 1;
            return false;
          }
        } catch {
          // Preserve a line whose ID itself is not valid JSON.
        }
      }
    }
    return true;
  });

  if (removedCount === 0) return 0;

  const replacement = retainedLines.join('\n');
  const temporaryPath = `${chatOutputPath}.privacy-${process.pid}-${randomUUID()}.tmp`;
  let temporaryDescriptor: number | null = null;
  try {
    temporaryDescriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(temporaryDescriptor, replacement, 'utf8');
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = null;

    fs.renameSync(temporaryPath, chatOutputPath);
    fs.chmodSync(chatOutputPath, 0o600);

    const finalDescriptor = fs.openSync(chatOutputPath, 'r');
    try {
      fs.fsyncSync(finalDescriptor);
    } finally {
      fs.closeSync(finalDescriptor);
    }

    const directoryDescriptor = fs.openSync(path.dirname(chatOutputPath), 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (temporaryDescriptor !== null) {
      fs.closeSync(temporaryDescriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return removedCount;
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
