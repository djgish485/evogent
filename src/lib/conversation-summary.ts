import { type BrainProviderName } from '@/lib/brain-provider';
import { type ConversationStatus, getActiveChatTaskForConversation, getActiveChatTasks, getQueuedChatTasksForConversation, resolveConversationStatus } from '@/lib/chat-conversation-status';
import { getChatMessageAttachments, getRenderableChatMessageText, mergeChatMessages, readMessageContextRefId } from '@/lib/chat-messages';
import { shouldHideConversationOperationalMessage } from '@/lib/chat-streaming-display';
import { buildInlineCodeFixChatMessagesFromFeedItems } from '@/lib/inline-code-fix-messages';
import { type OrchestratorStatusResponse } from '@/lib/orchestrator';
import { POST_CONTEXT_SEPARATOR } from '@/lib/page-constants';
import { buildSearchSnippet, textMatchesSearchQuery } from '@/lib/search-utils';
import { type ChatMessage } from '@/types/chat';
import { type ConversationSessionSummary, type ConversationSessionType } from '@/types/conversation';
import { type ChatSessionSearchMatch, type FeedItem } from '@/types/feed';

const OPENCLAW_SESSION_PREFIX = 'openclaw:';

export type ConversationContextKind = 'global' | 'post';

export type ChatAuthorMessage = {
  role: 'user' | 'agent';
  metadata?: Record<string, unknown> | null;
  status?: string | null;
  timestamp?: string;
};

export interface ConversationCardViewModel {
  sessionId: string;
  sessionType: ConversationSessionType | null;
  provider: BrainProviderName | null;
  messages: ChatMessage[];
  previewMessages: ChatMessage[];
  feedItems: FeedItem[];
  title: string;
  color: string | null;
  workingDirectory: string;
  summary: string;
  lastActor: 'user' | 'agent';
  lastMessage: ChatAuthorMessage | null;
  lastTimestamp: string;
  messageCount: number;
  queuePosition: number | null;
  pendingCount: number;
  queuedTaskCount: number;
  status: ConversationStatus;
  activeTaskId: string | null;
  chatTaskId: string | null;
  contextKind: ConversationContextKind;
  contextRefId: string | null;
  searchMatchMessageId: string | null;
  searchMatchTimestamp: string | null;
}

export function buildConversationFallbackTitle(
  sessionTitle: string | null,
  contextKind: ConversationContextKind,
  lastTimestamp: string,
  messages: ChatMessage[],
): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const firstAgentChatMessage = messages.find((message) => message.role === 'agent' && message.type === 'chat');
  const firstUserText = getRenderableChatMessageText(firstUserMessage);
  const firstAgentText = getRenderableChatMessageText(firstAgentChatMessage);

  const storedTitle = sessionTitle?.trim();
  const raw = (storedTitle && !/^recovered\s+conversation$/i.test(storedTitle) ? storedTitle : null)
    || firstUserText.split(POST_CONTEXT_SEPARATOR)[0]?.replace(/^Chat:\s*/i, '').trim()
    || firstAgentText.split(POST_CONTEXT_SEPARATOR)[0]?.replace(/^Chat:\s*/i, '').split(/[.!?\n]/)[0]?.trim()
    || (contextKind === 'post' ? 'Post conversation' : formatConversationDateTitle(lastTimestamp));
  return raw.length > 96 ? `${raw.slice(0, 93).trimEnd()}...` : raw;
}

export function formatConversationDateTitle(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) return 'Chat';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `Chat \u2013 ${months[date.getMonth()]} ${date.getDate()}`;
  } catch {
    return 'Chat';
  }
}

export function buildConversationFallbackSummary(messages: ChatMessage[]): string {
  const latestAgentMessage = [...messages].reverse().find((message) => message.role === 'agent' && message.type === 'chat');
  const latestMessage = latestAgentMessage ?? [...messages].reverse().find((message) => message.type === 'chat') ?? null;
  const latestMessageText = getRenderableChatMessageText(latestMessage);
  const raw = latestMessageText.split(POST_CONTEXT_SEPARATOR)[0]?.replace(/^Chat:\s*/i, '').trim()
    || 'Conversation ready';
  return raw.length > 180 ? `${raw.slice(0, 177).trimEnd()}...` : raw;
}

export function resolveChatSessionIdFromInReplyTo(messages: ChatMessage[], inReplyTo: string | null): string | null {
  if (!inReplyTo) {
    return null;
  }

  const sourceMessage = messages.find((message) => message.id === inReplyTo);
  const sessionId = sourceMessage?.sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
}

export function buildConversationPreviewMessages(messages: ChatMessage[], searchQuery: string | null = null): ChatMessage[] {
  const chatMessages = messages.filter((message) => message.type === 'chat');
  if (searchQuery) {
    const matchingMessages = chatMessages
      .filter((message) => textMatchesSearchQuery(getRenderableChatMessageText(message), searchQuery))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 3);

    if (matchingMessages.length > 0) {
      return matchingMessages;
    }
  }

  return [...chatMessages.slice(-3)].reverse();
}

export function buildConversationPreviewText(
  message: ChatMessage | { role: 'user' | 'agent'; type: 'chat' | 'agent_event'; text: string },
  searchQuery: string | null = null,
): string {
  const body = getRenderableChatMessageText(message)
    .split(POST_CONTEXT_SEPARATOR)[0]
    ?.replace(/^Chat:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (body) {
    if (searchQuery) {
      const snippet = buildSearchSnippet(body, searchQuery, 160);
      if (snippet.hasMatch) {
        return snippet.text;
      }
    }
    return body.length > 140 ? `${body.slice(0, 137).trimEnd()}...` : body;
  }

  const attachments = 'metadata' in message ? getChatMessageAttachments(message) : [];
  if (attachments.length > 0) {
    return attachments.length === 1 ? 'Shared an attachment' : `Shared ${attachments.length} attachments`;
  }

  return message.role === 'user' ? 'Sent a message' : 'Replied';
}

export function compareConversationSessions(left: ConversationSessionSummary, right: ConversationSessionSummary): number {
  const timestampCompare = right.lastMaterialActivityAt.localeCompare(left.lastMaterialActivityAt);
  if (timestampCompare !== 0) {
    return timestampCompare;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

export function mergeConversationSessions(
  current: ConversationSessionSummary[],
  incoming: ConversationSessionSummary[],
): ConversationSessionSummary[] {
  const bySessionId = new Map<string, ConversationSessionSummary>();

  for (const session of current) {
    bySessionId.set(session.sessionId, session);
  }

  for (const session of incoming) {
    bySessionId.set(session.sessionId, session);
  }

  return Array.from(bySessionId.values()).sort(compareConversationSessions);
}

export function mergeChatSessionSearchMatches(
  current: ChatSessionSearchMatch[],
  incoming: ChatSessionSearchMatch[],
): ChatSessionSearchMatch[] {
  const bySessionId = new Map<string, ChatSessionSearchMatch>();
  for (const match of current) {
    bySessionId.set(match.sessionId, match);
  }
  for (const match of incoming) {
    bySessionId.set(match.sessionId, match);
  }

  return Array.from(bySessionId.values()).sort((left, right) => {
    const timestampCompare = right.latestMessageTimestamp.localeCompare(left.latestMessageTimestamp);
    if (timestampCompare !== 0) {
      return timestampCompare;
    }
    return left.sessionId.localeCompare(right.sessionId);
  });
}

export function conversationStatusLabel(status: ConversationStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Idle';
  }
}

export function buildSessionCards(
  messages: ChatMessage[],
  feedItems: FeedItem[],
  sessions: ConversationSessionSummary[],
  orchestratorStatus: OrchestratorStatusResponse | null,
  searchContext: {
    searchQuery?: string | null;
    chatSessionMatches?: ChatSessionSearchMatch[];
  } = {},
): ConversationCardViewModel[] {
  const messagesBySessionId = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    if (!message.sessionId) continue;
    if (message.sessionId.startsWith(OPENCLAW_SESSION_PREFIX)) continue;
    const existing = messagesBySessionId.get(message.sessionId) ?? [];
    existing.push(message);
    messagesBySessionId.set(message.sessionId, existing);
  }

  const searchQuery = searchContext.searchQuery ?? null;
  const chatSessionMatches = searchContext.chatSessionMatches ?? [];
  const chatSessionMatchById = new Map(chatSessionMatches.map((match) => [match.sessionId, match]));

  const feedItemsBySessionId = new Map<string, FeedItem[]>();
  for (const item of feedItems) {
    if (!item.originSessionId) continue;
    const existing = feedItemsBySessionId.get(item.originSessionId) ?? [];
    existing.push(item);
    feedItemsBySessionId.set(item.originSessionId, existing);
  }

  const queuePositions = new Map<string, number>();
  const queuedTaskIds = new Map<string, string>();
  let pendingIndex = 1;
  for (const task of orchestratorStatus?.queued ?? []) {
    if (task.priority !== 'user_chat' || !task.sessionId) continue;
    queuePositions.set(task.sessionId, pendingIndex);
    queuedTaskIds.set(task.sessionId, task.id);
    pendingIndex += 1;
  }

  for (const task of getActiveChatTasks(orchestratorStatus)) {
    if (task.sessionId) {
      queuePositions.set(task.sessionId, 0);
    }
  }

  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const sessionIds = new Set<string>([
    ...messagesBySessionId.keys(),
    ...feedItemsBySessionId.keys(),
    ...sessions.map((session) => session.sessionId),
    ...chatSessionMatches.map((match) => match.sessionId),
  ]);

  return Array.from(sessionIds)
    .filter((sessionId) => !sessionId.startsWith(OPENCLAW_SESSION_PREFIX))
    .map((sessionId): ConversationCardViewModel | null => {
      const producedFeedItems = (feedItemsBySessionId.get(sessionId) ?? [])
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const sessionSummary = sessionById.get(sessionId) ?? null;
      const chatSessionMatch = chatSessionMatchById.get(sessionId) ?? null;
      const persistedSessionMessages = (messagesBySessionId.get(sessionId) ?? [])
        .filter((message) => !shouldHideConversationOperationalMessage(message));
      const sessionMessages = mergeChatMessages(
        mergeChatMessages(persistedSessionMessages, chatSessionMatch?.messages ?? []),
        buildInlineCodeFixChatMessagesFromFeedItems(producedFeedItems),
      );
      if (!sessionSummary && sessionMessages.length === 0 && producedFeedItems.length === 0) {
        return null;
      }

      const latestMessage = sessionMessages.at(-1) ?? null;
      const latestSummaryPreviewMessage = (sessionSummary?.previewMessages ?? []).reduce<ChatAuthorMessage | null>(
        (latest, message) => {
          if (!latest) {
            return message;
          }
          return message.timestamp > (latest.timestamp ?? '') ? message : latest;
        },
        null,
      );
      const latestConversationMessage = latestMessage ?? latestSummaryPreviewMessage;
      const contextRefId = readMessageContextRefId(latestMessage)
        ?? sessionSummary?.contextRefId
        ?? [...sessionMessages].reverse().map(readMessageContextRefId).find(Boolean)
        ?? null;
      const contextKind: ConversationContextKind = sessionSummary?.contextKind === 'post' && contextRefId
        ? 'post'
        : contextRefId
          ? 'post'
          : 'global';
      const lastTimestamp = [
        latestMessage?.timestamp ?? '',
        producedFeedItems[0]?.createdAt ?? '',
        sessionSummary?.lastMaterialActivityAt ?? '',
      ].sort().at(-1) ?? latestMessage?.timestamp ?? producedFeedItems[0]?.createdAt ?? new Date().toISOString();
      const pendingCount = sessionMessages.filter((message) => message.status === 'queued' || message.status === 'pending').length;
      const activeTask = getActiveChatTaskForConversation(sessionId, sessionMessages, orchestratorStatus);
      const queuedTasks = getQueuedChatTasksForConversation(sessionId, sessionMessages, orchestratorStatus);
      const queuedTask = queuedTasks[0] ?? null;
      const previewMessages = sessionMessages.length > 0
        ? buildConversationPreviewMessages(sessionMessages, searchQuery)
        : sessionSummary?.previewMessages
          .filter((message) => message.type === 'chat')
          .map((message) => ({
            type: message.type,
            id: message.id,
            role: message.role,
            inReplyTo: null,
            sessionId,
            text: message.text,
            timestamp: message.timestamp,
            context: null,
            metadata: message.metadata ?? null,
            createdAt: message.timestamp,
          })) ?? [];
      const summary = previewMessages.length > 0
        ? buildConversationFallbackSummary(previewMessages)
        : 'Conversation ready';
      const messageCount = Math.max(sessionSummary?.messageCount ?? 0, persistedSessionMessages.length, sessionMessages.length);
      const lastActor = latestConversationMessage?.role
        ?? sessionSummary?.lastActor
        ?? 'agent';

      return {
        sessionId,
        sessionType: sessionSummary?.sessionType ?? null,
        provider: sessionSummary?.provider ?? null,
        messages: sessionMessages,
        previewMessages,
        feedItems: producedFeedItems,
        title: buildConversationFallbackTitle(sessionSummary?.title ?? null, contextKind, lastTimestamp, sessionMessages),
        color: sessionSummary?.color ?? null,
        workingDirectory: sessionSummary?.workingDirectory ?? '',
        summary,
        lastActor,
        lastMessage: latestConversationMessage,
        lastTimestamp,
        messageCount,
        queuePosition: queuePositions.get(sessionId) ?? null,
        pendingCount,
        queuedTaskCount: queuedTasks.length,
        status: resolveConversationStatus(sessionId, sessionMessages, orchestratorStatus),
        activeTaskId: activeTask?.id ?? null,
        chatTaskId: activeTask?.id ?? queuedTask?.id ?? queuedTaskIds.get(sessionId) ?? null,
        contextKind,
        contextRefId,
        searchMatchMessageId: chatSessionMatch?.latestMessageId ?? null,
        searchMatchTimestamp: chatSessionMatch?.latestMessageTimestamp ?? null,
      } satisfies ConversationCardViewModel;
    })
    .filter((entry): entry is ConversationCardViewModel => entry !== null)
    .sort((left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp));
}
