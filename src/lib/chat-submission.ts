import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildChatInstruction, buildCuratorChatInstruction } from '@/lib/chat-instruction';
import { getDb } from '@/lib/db/client';
import { insertChatMessage, updateChatMessageStatus } from '@/lib/db/chat';
import { ensureChatSession, maybeResetIdleMainSession } from '@/lib/db/chat-sessions';
import { enqueueOrchestratorMessage } from '@/lib/orchestrator';
import { POST_CONTEXT_SEPARATOR } from '@/lib/page-constants';
import { getDurableChatRequestMetadata } from '@/lib/screen-chat-privacy';
import { checkProviderAvailability } from '@/lib/setup-readiness';
import type { ChatAttachment, ChatMessage } from '@/types/chat';

export type ChatContextKind = 'global' | 'post' | 'screen';
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
  priority?: 'user_chat';
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

function isPhoneNotificationContext(input: SubmitChatMessageInput): boolean {
  const contextRefId = input.contextRefId?.trim();
  if (input.contextKind !== 'post' || !contextRefId) return false;
  return Boolean(getDb().prepare(`
    SELECT 1
    FROM feed
    WHERE id = ?
      AND type = 'notification'
      AND source = 'phone-notification'
    LIMIT 1
  `).get(contextRefId));
}

function stripAppendedFeedContext(message: string): string {
  const separatorIndex = message.indexOf(POST_CONTEXT_SEPARATOR);
  const userText = (separatorIndex >= 0 ? message.slice(0, separatorIndex) : message)
    .trim()
    .replace(/^Chat:\s*/i, '')
    .trim();
  return userText || 'Question about a private phone notification';
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
  // Idle main sessions get a fresh provider context (same thread in the UI) before this
  // turn is queued, so a morning quick question doesn't resume yesterday's conversation.
  const session = maybeResetIdleMainSession(ensureChatSession(input.sessionId));
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
  const phoneNotificationContext = isPhoneNotificationContext(input);
  const safeMessage = phoneNotificationContext
    ? stripAppendedFeedContext(input.message)
    : input.message;
  const safeContext = phoneNotificationContext
    ? 'The selected phone notification is a local, model-free card. Its title and body are intentionally unavailable to runtime agents.'
    : input.context ?? null;
  const transientScreenContext = input.contextKind === 'screen'
    && typeof safeContext === 'string'
    && safeContext.trim()
      ? safeContext.trim()
      : null;
  const durableContext = input.contextKind === 'screen' ? null : safeContext;
  const durableRequestMetadata = getDurableChatRequestMetadata(
    input.contextKind ?? 'global',
    input.metadata,
  );
  const providerAvailability = await checkProviderAvailability(session.provider);
  if (!providerAvailability.available) {
    throw new Error(`Install ${providerAvailability.providerDisplayName} before queueing agent work: ${providerAvailability.error ?? 'provider unavailable'}`);
  }

  const userMessage = insertChatMessage({
    id: userMessageId,
    role: 'user',
    inReplyTo: input.inReplyTo ?? null,
    sessionId: session.id,
    text: safeMessage,
    context: durableContext,
    timestamp,
    status: 'pending',
    metadata: {
      ...durableRequestMetadata,
      endpoint: '/api/chat',
      sessionId: session.id,
      contextKind: input.contextKind ?? 'global',
      contextRefId: input.contextRefId ?? null,
      originView: input.originView ?? 'feed',
      attachments,
      ...(phoneNotificationContext ? {
        phoneNotificationContentWithheld: true,
        phoneNotificationSessionEvidencePurged: true,
        phoneNotificationAuditEvidencePurged: true,
        phoneNotificationOrchestratorEvidencePurged: true,
      } : {}),
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
    const taskInstruction = session.sessionType === 'curator'
      ? buildCuratorChatInstruction({
          message: safeMessage,
          context: durableContext,
          inReplyTo: input.inReplyTo ?? null,
          messageId: userMessageId,
          sessionId: session.id,
          sessionTitle: session.title,
          automatedCycleId: typeof durableRequestMetadata.curationCycleId === 'string'
            ? durableRequestMetadata.curationCycleId.trim() || null
            : null,
          attachmentPaths,
        })
      : buildChatInstruction({
          message: safeMessage,
          context: durableContext,
          inReplyTo: input.inReplyTo ?? null,
          messageId: userMessageId,
          sessionId: session.id,
          attachmentPaths,
          cwd: taskWorkingDirectory || process.cwd(),
        });

    const result = await enqueueOrchestratorMessage({
      message: taskInstruction.prompt,
      priority: input.priority ?? 'user_chat',
      source: input.source ?? 'user_chat',
      metadata: {
        ...durableRequestMetadata,
        endpoint: '/api/chat',
        chatMessageId: userMessageId,
        sessionId: session.id,
        contextKind: input.contextKind ?? 'global',
        contextRefId: input.contextRefId ?? null,
        originView: input.originView ?? 'feed',
        provider: session.provider,
        claudeReasoningEffort: session.claudeReasoningEffort,
        codexReasoningEffort: session.codexReasoningEffort,
        codexFastMode: session.codexFastMode,
        // Interactive "do something on my phone now" surfaces run the fast model tier —
        // latency beats depth. That's the durable main session and every overlay session
        // (the anywhere bubble's "ask about this screen" threads).
        ...((session.sessionType === 'main' || durableRequestMetadata.overlay === true)
          ? { claudeModel: 'haiku' }
          : {}),
        providerSessionId: session.providerSessionId,
        claudeSessionId: session.claudeSessionId,
        workingDirectory: taskWorkingDirectory,
        forceFreshChatSession,
        inReplyTo: input.inReplyTo ?? null,
        attachments: attachmentPaths,
        appendSystemPrompt: taskInstruction.appendSystemPrompt,
        sessionType: session.sessionType,
        requiresBrowserTools: session.sessionType === 'curator',
      },
      ...(transientScreenContext ? { transientScreenContext } : {}),
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
