import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildChatInstruction, buildCuratorChatInstruction } from '@/lib/chat-instruction';
import { getDb } from '@/lib/db/client';
import { insertChatMessage, updateChatMessageStatus } from '@/lib/db/chat';
import { ensureChatSession } from '@/lib/db/chat-sessions';
import { enqueueOrchestratorMessage } from '@/lib/orchestrator';
import { checkProviderAvailability } from '@/lib/setup-readiness';
import type { ChatAttachment, ChatMessage } from '@/types/chat';
import type { ChatSessionRecord } from '@/lib/db/chat-sessions';

export type ChatContextKind = 'global' | 'post';
export type ChatOriginView = 'feed' | 'post_detail' | 'feed/setup_card' | 'feed/source_health_button';

export interface SubmitChatMessageInput {
  message: string;
  sessionId: string;
  workingDirectory?: string | null;
  context?: string | null;
  inReplyTo?: string | null;
  contextKind?: ChatContextKind;
  contextRefId?: string | null;
  originView?: ChatOriginView;
  metadata?: Record<string, unknown> | null;
  attachments?: ChatAttachment[];
  source?: string;
  priority?: 'user_chat' | 'heartbeat';
  requestId?: string;
}

export interface SubmitChatMessageResult {
  ok: boolean;
  enqueued: boolean;
  requestId: string | null;
  queueDepth: number;
  message: string;
  userMessage: ChatMessage;
  sessionId: string;
}

function getCuratorCurationCommand(session: ChatSessionRecord, message: string): '/curate' | '/curate-latest' | null {
  if (session.sessionType !== 'curator') return null;
  const normalized = message.trim().toLowerCase();
  if (normalized === '/curate' || normalized.startsWith('/curate ')) return '/curate';
  if (normalized === '/curate-latest' || normalized.startsWith('/curate-latest ')) return '/curate-latest';
  return null;
}

function getPersistedUserChatMessageRow(messageId: string): {
  id: string;
  role: string;
  type: string;
  session_id: string;
} | null {
  const row = getDb().prepare(`
    SELECT id, role, type, session_id
    FROM chat_messages
    WHERE id = ?
  `).get(messageId) as {
    id: string;
    role: string;
    type: string;
    session_id: string;
  } | undefined;

  return row ?? null;
}

function buildCurationLogMetadata(
  input: SubmitChatMessageInput,
  session: ChatSessionRecord,
  queueRequestId: string,
): Record<string, unknown> | null {
  const curationCommand = getCuratorCurationCommand(session, input.message);
  if (!curationCommand) {
    return null;
  }

  const metadata = input.metadata ?? {};
  const triggerSource = typeof metadata.triggerSource === 'string' && metadata.triggerSource.trim()
    ? metadata.triggerSource.trim()
    : input.priority === 'heartbeat'
      ? (typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'adaptive_heartbeat')
      : 'curator_chat';
  const triggerReason = typeof metadata.triggerReason === 'string' && metadata.triggerReason.trim()
    ? metadata.triggerReason.trim()
    : null;

  return {
    curationCommand,
    curationLogRequestId: queueRequestId,
    curationTriggeredBy: triggerReason ? `${triggerSource}:${triggerReason}` : triggerSource,
  };
}

export async function resolveExistingAttachments(payload: unknown): Promise<ChatAttachment[]> {
  const attachments = Array.isArray(payload) ? payload as ChatAttachment[] : [];
  if (attachments.length === 0) return [];

  const existing = await Promise.all(attachments.map(async (attachment) => {
    try {
      await fs.promises.stat(attachment.filePath);
      return attachment;
    } catch {
      return null;
    }
  }));

  return existing.filter((attachment): attachment is ChatAttachment => attachment !== null);
}

export async function submitChatMessage(input: SubmitChatMessageInput): Promise<SubmitChatMessageResult> {
  const session = ensureChatSession(input.sessionId);
  const userMessageId = `msg-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const attachments = input.attachments ?? [];
  const sessionMessageCount = Number(
    (getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM chat_messages
      WHERE session_id = ?
    `).get(session.id) as { count?: number } | undefined)?.count ?? 0,
  );
  const forceFreshChatSession = sessionMessageCount === 0;
  const queueRequestId = input.requestId?.trim() || `chat-queue-${userMessageId}`;
  const curationLogMetadata = buildCurationLogMetadata(input, session, queueRequestId);
  const providerAvailability = await checkProviderAvailability(session.provider);
  if (!providerAvailability.available) {
    throw new Error(`Install ${providerAvailability.providerDisplayName} before queueing agent work: ${providerAvailability.error ?? 'provider unavailable'}`);
  }

  const userMessage = insertChatMessage({
    id: userMessageId,
    role: 'user',
    inReplyTo: input.inReplyTo ?? null,
    sessionId: session.id,
    text: input.message,
    context: input.context ?? null,
    timestamp,
    status: 'pending',
    metadata: {
      ...(input.metadata ?? {}),
      ...(curationLogMetadata ?? {}),
      endpoint: '/api/chat',
      sessionId: session.id,
      contextKind: input.contextKind ?? 'global',
      contextRefId: input.contextRefId ?? null,
      originView: input.originView ?? 'feed',
      attachments,
    },
  });

  if (!userMessage) {
    throw new Error('Failed to persist chat message');
  }

  const persistedUserMessage = getPersistedUserChatMessageRow(userMessageId);
  if (
    !persistedUserMessage
    || persistedUserMessage.role !== 'user'
    || persistedUserMessage.type !== 'chat'
    || persistedUserMessage.session_id !== session.id
  ) {
    throw new Error('Failed to verify persisted chat message before queueing');
  }

  try {
    const attachmentPaths = attachments.map((attachment) => attachment.filePath);
    const taskWorkingDirectory = typeof input.workingDirectory === 'string' && input.workingDirectory.trim()
      ? input.workingDirectory.trim()
      : session.workingDirectory;
    const taskPrompt = session.sessionType === 'curator'
      ? buildCuratorChatInstruction({
          message: input.message,
          context: input.context ?? null,
          inReplyTo: input.inReplyTo ?? null,
          messageId: userMessageId,
          sessionId: session.id,
          sessionTitle: session.title,
          attachmentPaths,
        })
      : buildChatInstruction({
          message: input.message,
          context: input.context ?? null,
          inReplyTo: input.inReplyTo ?? null,
          messageId: userMessageId,
          sessionId: session.id,
          attachmentPaths,
          cwd: taskWorkingDirectory || process.cwd(),
        });

    const result = await enqueueOrchestratorMessage({
      message: taskPrompt,
      priority: input.priority ?? 'user_chat',
      source: input.source ?? 'user_chat',
      metadata: {
        ...(input.metadata ?? {}),
        endpoint: '/api/chat',
        chatMessageId: userMessageId,
        sessionId: session.id,
        provider: session.provider,
        claudeReasoningEffort: session.claudeReasoningEffort,
        codexReasoningEffort: session.codexReasoningEffort,
        codexFastMode: session.codexFastMode,
        providerSessionId: session.providerSessionId,
        claudeSessionId: session.claudeSessionId,
        workingDirectory: taskWorkingDirectory,
        forceFreshChatSession,
        inReplyTo: input.inReplyTo ?? null,
        attachments: attachmentPaths,
        sessionType: session.sessionType,
        requiresBrowserTools: session.sessionType === 'curator',
        ...(curationLogMetadata ?? {}),
      },
      requestId: queueRequestId,
    });

    updateChatMessageStatus(userMessageId, result.ok ? 'queued' : 'failed');

    return {
      ok: result.ok,
      enqueued: result.ok,
      requestId: result.requestId ?? null,
      queueDepth: result.queueDepth,
      message: result.ok
        ? 'Message queued for evogent orchestrator'
        : (result.error ?? 'Failed to queue chat message'),
      userMessage: {
        ...userMessage,
        status: result.ok ? 'queued' : 'failed',
      },
      sessionId: session.id,
    };
  } catch {
    updateChatMessageStatus(userMessageId, 'failed');
    throw new Error('Failed to queue message for evogent orchestrator');
  }
}
