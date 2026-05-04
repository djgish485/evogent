import type { ChatMessage } from '@/types/chat';
import type { OrchestratorStatusResponse, OrchestratorTaskStatus } from '@/lib/orchestrator';

export type ConversationStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export function doesChatTaskMatchConversation(
  task: OrchestratorTaskStatus | null | undefined,
  sessionId: string,
  messages: ChatMessage[],
): boolean {
  if (!task || task.priority !== 'user_chat') {
    return false;
  }

  const taskSessionId = typeof task.sessionId === 'string' && task.sessionId.trim()
    ? task.sessionId.trim()
    : null;
  if (taskSessionId) {
    return taskSessionId === sessionId;
  }

  const chatMessageId = typeof task.chatMessageId === 'string' && task.chatMessageId.trim()
    ? task.chatMessageId.trim()
    : null;
  if (!chatMessageId) {
    return false;
  }

  return messages.some((message) => message.id === chatMessageId);
}

export function getActiveChatTasks(orchestratorStatus: OrchestratorStatusResponse | null): OrchestratorTaskStatus[] {
  if (!orchestratorStatus) {
    return [];
  }

  const activeTasks = new Map<string, OrchestratorTaskStatus>();
  const candidates = [
    orchestratorStatus.currentTask,
    ...(Array.isArray(orchestratorStatus.activeChatTasks) ? orchestratorStatus.activeChatTasks : []),
  ];

  for (const task of candidates) {
    if (!task || task.priority !== 'user_chat') {
      continue;
    }
    activeTasks.set(task.id, task);
  }

  return Array.from(activeTasks.values());
}

export function getActiveChatTaskForConversation(
  sessionId: string,
  messages: ChatMessage[],
  orchestratorStatus: OrchestratorStatusResponse | null,
): OrchestratorTaskStatus | null {
  return getActiveChatTasks(orchestratorStatus).find((task) => (
    doesChatTaskMatchConversation(task, sessionId, messages)
  )) ?? null;
}

export function getQueuedChatTasksForConversation(
  sessionId: string,
  messages: ChatMessage[],
  orchestratorStatus: OrchestratorStatusResponse | null,
): OrchestratorTaskStatus[] {
  return (orchestratorStatus?.queued ?? []).filter((task) => (
    doesChatTaskMatchConversation(task, sessionId, messages)
  ));
}

export function resolveConversationStatus(
  sessionId: string,
  messages: ChatMessage[],
  orchestratorStatus: OrchestratorStatusResponse | null,
): ConversationStatus {
  if (getActiveChatTaskForConversation(sessionId, messages, orchestratorStatus)) {
    return 'running';
  }

  if (getQueuedChatTasksForConversation(sessionId, messages, orchestratorStatus).length > 0) {
    return 'queued';
  }

  const latestMessage = messages.at(-1);
  if (latestMessage?.status === 'failed') return 'failed';
  if (latestMessage?.status === 'cancelled') return 'cancelled';
  if (latestMessage?.status === 'processing') return 'running';
  if (latestMessage?.status === 'queued' || latestMessage?.status === 'pending') return 'queued';
  return 'idle';
}
