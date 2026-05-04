import { type OrchestratorStatusResponse } from '@/lib/orchestrator';
import { formatDetailedTimestamp } from '@/lib/timestamps';
import { type ChatMessage } from '@/types/chat';

export interface BrainTranscriptEvent {
  taskId?: string;
  paneLines?: string[];
}

export interface AgentProgressLogEntry {
  id: string;
  type: string;
  createdAt: string;
  message?: string;
  toolName?: string;
  toolUseId?: string;
  durationMs?: number;
  isError?: boolean;
}

export interface AgentTranscriptData {
  id: string;
  type: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  progress: AgentProgressLogEntry[];
}

export interface AgentEventMetadata {
  agentId: string | null;
  logFile: string | null;
  event: string | null;
  status: string | null;
  hasTranscript: boolean;
  taskId: string | null;
}

export interface AgentTranscriptTarget {
  key: string;
  agentId: string | null;
  logFile: string | null;
  taskId?: string | null;
}

export interface AgentTranscriptState {
  loading: boolean;
  error: string | null;
  agent: AgentTranscriptData | null;
  text: string | null;
  source: 'agent' | 'log_file' | null;
}

export interface TaskTranscriptFallbackState {
  loading: boolean;
  error: string | null;
  text: string | null;
  source?: 'log_file' | 'history' | null;
}

export interface CurationTaskState {
  taskId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  itemsAdded: number | null;
  error: string | null;
  transcriptTarget: AgentTranscriptTarget | null;
}

export function sanitizeTerminalOutput(value?: string | null): string {
  if (!value) return '';
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F-\u009F]/g, '')
    .replace(/\r/g, '')
    .trimEnd();
}

export function getTranscriptTail(text: string, lineCount: number): { value: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length <= lineCount) {
    return { value: normalized, truncated: false };
  }
  return {
    value: lines.slice(-lineCount).join('\n'),
    truncated: true,
  };
}

export function getAgentEventMetadata(message: ChatMessage): AgentEventMetadata | null {
  if (message.type !== 'agent_event') return null;

  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {
      agentId: null,
      logFile: null,
      event: null,
      status: null,
      hasTranscript: false,
      taskId: null,
    };
  }

  const agentIdCandidate = typeof metadata.agentId === 'string'
    ? metadata.agentId
    : typeof metadata.agent_id === 'string'
      ? metadata.agent_id
      : null;
  const agentId = typeof agentIdCandidate === 'string' && agentIdCandidate.trim()
    ? agentIdCandidate.trim()
    : null;
  const logFileCandidate = typeof metadata.logFile === 'string'
    ? metadata.logFile
    : typeof metadata.log_file === 'string'
      ? metadata.log_file
      : null;
  const logFile = typeof logFileCandidate === 'string' && logFileCandidate.trim()
    ? logFileCandidate.trim()
    : null;
  const event = typeof metadata.event === 'string' && metadata.event.trim()
    ? metadata.event.trim()
    : null;
  const status = typeof metadata.status === 'string' && metadata.status.trim()
    ? metadata.status.trim()
    : null;
  const hasTranscript = metadata.hasTranscript === true || metadata.has_transcript === true;
  const taskIdCandidate = typeof metadata.taskId === 'string'
    ? metadata.taskId
    : typeof metadata.task_id === 'string'
      ? metadata.task_id
      : null;
  const taskId = typeof taskIdCandidate === 'string' && taskIdCandidate.trim()
    ? taskIdCandidate.trim()
    : null;

  return {
    agentId,
    logFile,
    event,
    status,
    hasTranscript,
    taskId,
  };
}

export function resolveAgentTranscriptTarget(metadata: AgentEventMetadata | null): AgentTranscriptTarget | null {
  if (!metadata || !metadata.hasTranscript) return null;
  if (metadata.taskId) {
    return {
      key: `task:${metadata.taskId}`,
      agentId: metadata.agentId || null,
      logFile: metadata.logFile || null,
      taskId: metadata.taskId,
    };
  }
  if (metadata.logFile) {
    return {
      key: `log:${metadata.logFile}`,
      agentId: metadata.agentId,
      logFile: metadata.logFile,
      taskId: null,
    };
  }
  if (metadata.agentId) {
    return {
      key: `agent:${metadata.agentId}`,
      agentId: metadata.agentId,
      logFile: null,
      taskId: null,
    };
  }
  return null;
}

export function isCurationStartEvent(metadata: AgentEventMetadata | null): boolean {
  return metadata?.event === 'curation_started';
}

export function isCurationTerminalEvent(metadata: AgentEventMetadata | null): boolean {
  if (!metadata?.taskId) return false;
  return metadata.event === 'curation_finished'
    || metadata.event === 'curation_completed'
    || metadata.event === 'curation_failed'
    || metadata.status === 'completed'
    || metadata.status === 'failed';
}

export function resolveCurationTaskStatus(metadata: AgentEventMetadata | null): CurationTaskState['status'] {
  if (metadata?.event === 'curation_failed' || metadata?.status === 'failed') {
    return 'failed';
  }
  if (metadata?.event === 'curation_completed' || metadata?.event === 'curation_finished' || metadata?.status === 'completed') {
    return 'completed';
  }
  return 'running';
}

export function parseCountValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Math.max(0, Number.parseInt(value.trim(), 10));
  }
  return null;
}

export function extractCurationItemsAdded(message: ChatMessage): number | null {
  const metadata = message.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const candidates = [
      metadata.itemsAdded,
      metadata.items_added,
      metadata.itemCount,
      metadata.item_count,
      metadata.newItems,
      metadata.new_items,
      metadata.newItemCount,
      metadata.new_item_count,
    ];
    for (const candidate of candidates) {
      const parsed = parseCountValue(candidate);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  const textMatch = message.text.match(/(\d+)\s+new items curated/i);
  if (textMatch) {
    return Number.parseInt(textMatch[1], 10);
  }

  return null;
}

export function extractAgentEventError(message: ChatMessage): string | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  return typeof metadata.error === 'string' && metadata.error.trim()
    ? metadata.error.trim()
    : null;
}

export function formatCurationItemsAdded(itemsAdded: number): string {
  return `${itemsAdded} new ${itemsAdded === 1 ? 'item' : 'items'} curated`;
}

export function findOrchestratorTask(
  orchestrator: OrchestratorStatusResponse | null,
  taskId: string | null | undefined,
): OrchestratorStatusResponse['currentTask'] | OrchestratorStatusResponse['history'][number] | OrchestratorStatusResponse['queued'][number] | null {
  if (!orchestrator || !taskId) return null;

  if (orchestrator.currentTask?.id === taskId) {
    return orchestrator.currentTask;
  }

  return [
    ...orchestrator.history,
    ...orchestrator.queued,
  ].find((task) => task.id === taskId) ?? null;
}

export function resolveTaskTranscriptTarget(
  taskId: string,
  orchestrator: OrchestratorStatusResponse | null,
): AgentTranscriptTarget {
  const matchedTask = findOrchestratorTask(orchestrator, taskId);
  return {
    key: `task:${taskId}`,
    agentId: null,
    logFile: matchedTask?.logFile ?? null,
    taskId,
  };
}

export function formatAgentProgressLine(event: AgentProgressLogEntry): string {
  const timestamp = `[${formatDetailedTimestamp(event.createdAt)}]`;
  const text = event.message?.trim() || '';

  if (event.type === 'tool_call') {
    const label = event.toolName ? `tool ${event.toolName}` : 'tool call';
    const suffix = text ? `: ${text}` : '';
    return `${timestamp} ${label}${suffix}`;
  }

  if (event.type === 'tool_result') {
    const label = event.isError ? 'tool error' : 'tool result';
    const suffix = text ? `: ${text}` : '';
    return `${timestamp} ${label}${suffix}`;
  }

  if (event.type === 'text') {
    return `${timestamp} assistant${text ? `: ${text}` : ''}`;
  }

  if (event.type === 'completion') {
    const duration = typeof event.durationMs === 'number' ? ` (${event.durationMs}ms)` : '';
    return `${timestamp} completion${duration}${text ? `: ${text}` : ''}`;
  }

  return `${timestamp} ${event.type || 'event'}${text ? ` ${text}` : ''}`;
}
