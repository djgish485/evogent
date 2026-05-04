import { shouldDisplayAgentEventInChat } from '@/lib/chat-agent-events';
import { type ConversationCardViewModel } from '@/lib/conversation-summary';
import { type OrchestratorStatusResponse } from '@/lib/orchestrator';
import { STREAMING_PREVIEW_MAX_CHARS } from '@/lib/page-constants';
import { type ChatMessage } from '@/types/chat';

export interface StreamingChatState {
  text: string;
  inReplyTo: string | null;
  sessionId: string | null;
}

export interface ChatProgressState {
  activity: string;
  tool: string;
  inReplyTo: string | null;
  sessionId: string | null;
}

export type LiveActivityStatus = 'queued' | 'running' | 'stalled';

export interface LiveActivitySnapshot {
  label: string;
  detail: string;
  badge: string | null;
  status: LiveActivityStatus;
}

export function hasDeliveredStreamingReply(
  messages: ChatMessage[],
  streaming: StreamingChatState | null,
  isSuperseded = false,
): boolean {
  if (!streaming?.text) {
    return false;
  }

  if (!streaming.inReplyTo) {
    return isSuperseded;
  }

  return messages.some((message) => (
    message.role === 'agent'
    && message.type === 'chat'
    && message.inReplyTo === streaming.inReplyTo
  ));
}

export function hasPendingAgentReply(messages: ChatMessage[]): boolean {
  const lastUserMessage = [...messages].reverse().find((message) => (
    message.role === 'user'
    && message.type === 'chat'
  ));

  if (!lastUserMessage) {
    return false;
  }

  return !messages.some((message) => (
    message.role === 'agent'
    && message.type === 'chat'
    && message.inReplyTo === lastUserMessage.id
  ));
}

export function shouldIgnoreSupersededLiveUpdate(
  messages: ChatMessage[],
  inReplyTo: string | null,
  isSuperseded: boolean,
): boolean {
  if (isSuperseded) {
    return true;
  }

  if (inReplyTo) {
    return messages.some((message) => (
      message.role === 'agent'
      && message.type === 'chat'
      && message.inReplyTo === inReplyTo
    ));
  }

  return !hasPendingAgentReply(messages);
}

export function getStreamingPreviewLine(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.replace(/\s+/g, ' ').trim();
    if (line) {
      if (line.length <= STREAMING_PREVIEW_MAX_CHARS) {
        return line;
      }
      return `...${line.slice(-(STREAMING_PREVIEW_MAX_CHARS - 3))}`;
    }
  }
  return '';
}

export function doesLiveStateBelongToConversation(
  conversation: ConversationCardViewModel,
  liveState: { sessionId: string | null; inReplyTo: string | null } | null,
): boolean {
  if (!liveState) {
    return false;
  }

  if (liveState.sessionId && liveState.sessionId === conversation.sessionId) {
    return true;
  }

  if (!liveState.inReplyTo) {
    return false;
  }

  return conversation.messages.some((message) => message.id === liveState.inReplyTo);
}

export function getFallbackChatProgress(orchestratorStatus: OrchestratorStatusResponse | null): ChatProgressState | null {
  const activeChatTask = orchestratorStatus?.currentTask?.priority === 'user_chat'
    ? orchestratorStatus.currentTask
    : null;
  const paneTail = orchestratorStatus?.brain.paneTail?.trim() ?? '';
  const toolName = paneTail.match(/^tool\s+([^:]+):\s*\{/i)?.[1]?.trim() ?? '';
  if (!activeChatTask || !toolName) {
    return null;
  }

  return {
    tool: toolName,
    activity: 'Running...',
    inReplyTo: activeChatTask.chatMessageId?.trim() || null,
    sessionId: activeChatTask.sessionId?.trim() || null,
  };
}

export function getQueuedConversationLabel(conversation: ConversationCardViewModel): string {
  if (conversation.pendingCount > 1) {
    return `${conversation.pendingCount} messages queued`;
  }
  return 'Message queued';
}

export function getQueuedConversationDetail(conversation: ConversationCardViewModel): string {
  if (conversation.queuePosition !== null && conversation.queuePosition > 0) {
    return `Queue position ${conversation.queuePosition}`;
  }
  return 'Waiting for the agent to start';
}

export function shouldHideConversationOperationalMessage(message: ChatMessage): boolean {
  return !shouldDisplayAgentEventInChat(message);
}
