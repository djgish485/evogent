export type OrchestratorPriority = 'user_chat' | 'user_ping' | 'feed_action' | 'post_enrichment' | 'cache_refresh' | 'reflection';

export interface EnqueueOrchestratorRequest {
  message: string;
  priority?: OrchestratorPriority | string;
  source?: string;
  metadata?: Record<string, unknown> | null;
  requestId?: string;
  timeoutMs?: number;
}

export interface EnqueueOrchestratorResponse {
  ok: boolean;
  requestId?: string;
  priority?: OrchestratorPriority;
  queueDepth: number;
  position?: number;
  acceptedAt?: string;
  backgrounded?: boolean;
  error?: string;
}

export interface OrchestratorTaskStatus {
  id: string;
  source: string;
  priority: OrchestratorPriority;
  chatMessageId?: string | null;
  sessionId?: string | null;
  state?: 'queued' | 'processing' | 'completed' | 'failed';
  enqueuedAt: string;
  startedAt?: string | null;
  sentAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  paneTail?: string | null;
  logFile?: string | null;
  messagePreview: string;
  responsePreview?: string;
}

export interface CurationStatusSnapshot {
  active: boolean;
  pid?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  triggerSource?: string | null;
  requestId?: string | null;
  phaseTaskId?: string | null;
  logFile?: string | null;
  phase?: string | null;
  phaseDetail?: string | null;
  phaseUpdatedAt?: string | null;
  deadlineAt?: string | null;
  persistDeadlineAt?: string | null;
  selectionLockedAt?: string | null;
  submittedAt?: string | null;
  lastFailureAt?: string | null;
  lastFailurePhase?: string | null;
  lastFailureDetail?: string | null;
  failedBeforeSubmit?: boolean;
  cancelRequestedAt?: string | null;
  cancelRequestedTaskId?: string | null;
  cacheSkipRequestedAt?: string | null;
  updatedAt?: string;
}

export interface OrchestratorStatusResponse {
  sessionName: string;
  brainProvider?: string;
  brainProviderLabel?: string;
  brainAvailable?: boolean;
  consecutiveSpawnFailures?: number;
  queueDepth: number;
  isProcessing: boolean;
  activeCurationAgent?: string | null;
  activeReflectionAgent?: string | null;
  curationStatus?: CurationStatusSnapshot | null;
  brain: {
    sessionExists: boolean;
    working: boolean;
    paneTail: string | null;
    checkedAt: string;
  };
  currentTask: OrchestratorTaskStatus | null;
  activeChatTasks?: OrchestratorTaskStatus[];
  queued: OrchestratorTaskStatus[];
  history: OrchestratorTaskStatus[];
  updatedAt: string;
}

function getInternalBaseUrl(): string {
  if (process.env.ORCHESTRATOR_INTERNAL_URL) {
    return process.env.ORCHESTRATOR_INTERNAL_URL;
  }

  const internalPort = process.env.PORT || '3001';
  return `http://127.0.0.1:${internalPort}`;
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

export async function enqueueOrchestratorMessage(
  payload: EnqueueOrchestratorRequest,
): Promise<EnqueueOrchestratorResponse> {
  const response = await fetch(`${getInternalBaseUrl()}/api/orchestrator/enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });

  const parsed = await parseJson<EnqueueOrchestratorResponse & { error?: string }>(response);

  if (!response.ok) {
    return {
      ok: false,
      queueDepth: parsed.queueDepth ?? 0,
      error: parsed.error || `Failed to enqueue message (${response.status})`,
    };
  }

  return parsed;
}

export async function getOrchestratorStatus(): Promise<OrchestratorStatusResponse> {
  const response = await fetch(`${getInternalBaseUrl()}/api/orchestrator/status`, {
    method: 'GET',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch orchestrator status (${response.status})`);
  }

  return parseJson<OrchestratorStatusResponse>(response);
}

export async function cancelCurrentOrchestratorTask(taskId?: string | null): Promise<{
  ok: boolean;
  error?: string;
  dequeued?: boolean;
  taskId?: string;
  chatMessageId?: string | null;
  sessionId?: string | null;
}> {
  const response = await fetch(`${getInternalBaseUrl()}/api/orchestrator/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(taskId ? { taskId } : {}),
  });

  return parseJson(response);
}
