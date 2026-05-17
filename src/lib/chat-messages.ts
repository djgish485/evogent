import { shouldDisplayAgentEventInChat } from '@/lib/chat-agent-events';
import { parseChatAttachments } from '@/lib/chat-attachment-metadata';
import { normalizeChatMessageText } from '@/lib/chat-text';
import { type ChatAuthorMessage } from '@/lib/conversation-summary';
import { type ChatAttachment, type ChatMessage } from '@/types/chat';

export function mergeComposerAttachments(current: ChatAttachment[], incoming: ChatAttachment[]): ChatAttachment[] {
  const merged = new Map<string, ChatAttachment>();
  for (const attachment of current) {
    merged.set(attachment.filePath, attachment);
  }
  for (const attachment of incoming) {
    merged.set(attachment.filePath, attachment);
  }
  return Array.from(merged.values());
}

export function getChatMessageAttachments(message: ChatMessage): ChatAttachment[] {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [];
  }
  return parseChatAttachments(metadata.attachments);
}

export function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>();

  for (const item of current) {
    if (!shouldDisplayAgentEventInChat(item)) {
      continue;
    }
    map.set(item.id, item);
  }

  for (const item of incoming) {
    if (!shouldDisplayAgentEventInChat(item)) {
      continue;
    }
    map.set(item.id, item);
  }

  return Array.from(map.values()).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function updateChatMessageStatus(
  messages: ChatMessage[],
  chatMessageId: string | null | undefined,
  nextStatus: ChatMessage['status'],
  allowedStatuses: ChatMessage['status'][] = [],
): ChatMessage[] {
  const normalizedChatMessageId = typeof chatMessageId === 'string' ? chatMessageId.trim() : '';
  if (!normalizedChatMessageId) {
    return messages;
  }

  let changed = false;
  const nextMessages = messages.map((message) => {
    if (message.id !== normalizedChatMessageId) {
      return message;
    }
    if (allowedStatuses.length > 0 && !allowedStatuses.includes(message.status ?? null)) {
      return message;
    }
    if (message.status === nextStatus) {
      return message;
    }

    changed = true;
    return {
      ...message,
      status: nextStatus,
    };
  });

  return changed ? nextMessages : messages;
}

export function shouldPersistChatProgress(tool: string, activity: string): boolean {
  const normalizedTool = tool.trim() || 'Thinking';
  const normalizedActivity = activity.trim();
  return normalizedActivity !== '' && normalizedTool !== 'Thinking' && normalizedActivity !== 'Thinking...';
}

export function readMessageContextRefId(message: ChatMessage | null | undefined): string | null {
  const metadata = message?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  return typeof metadata.contextRefId === 'string' && metadata.contextRefId.trim()
    ? metadata.contextRefId.trim()
    : null;
}

export function getRenderableChatMessageText(message: { role: 'user' | 'agent'; type: 'chat' | 'agent_event'; text: string } | null | undefined): string {
  if (!message) {
    return '';
  }
  return normalizeChatMessageText(message.text, message);
}

export function isPostMergeReviewCallbackMessage(message: ChatAuthorMessage): boolean {
  return message.role === 'user'
    && message.metadata?.source === 'post_merge_review';
}

export function getChatMessageAuthorLabel(
  message: ChatAuthorMessage,
  agentName: string,
  options: { isCancelled?: boolean } = {},
): string {
  if (message.role === 'agent') {
    return agentName;
  }

  const baseLabel = isPostMergeReviewCallbackMessage(message)
    ? 'Code fix callback'
    : 'You';
  const isCancelled = options.isCancelled ?? message.status === 'cancelled';
  return isCancelled ? `${baseLabel} • Cancelled` : baseLabel;
}
