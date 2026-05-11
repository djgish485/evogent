import { randomUUID } from 'node:crypto';
import type { OrchestratorStatusResponse } from '@/lib/orchestrator';
import { getOrchestratorStatus } from '@/lib/orchestrator';
import type { ActivitySample, TriggerDecision } from '@/lib/heartbeat';
import { getTriggerDecision } from '@/lib/heartbeat';
import { readHeartbeatConfig } from '@/lib/heartbeat-config';
import { submitChatMessage } from '@/lib/chat-submission';
import {
  completeCurationLogByRequestId,
  deletePendingCurationLogByRequestId,
  type CurationLogCompletionStatus,
  getCurationLogByRequestId,
  getFeedItemCount,
  getLatestAutomatedCurationCancellation,
  getLatestSuccessfulCurationTime,
  getMostRecentActivity,
  getRecentUserActivity,
  hasPendingCurationCycle,
  insertCurationLogStart,
} from '@/lib/db/activity';
import { getMostRecentCuratorChatSession } from '@/lib/db/chat-sessions';
import { getSourceReadiness } from '@/lib/setup-readiness';
import { resolveRuntimeWorkingDirectory } from '@/lib/runtime-working-directory';
const adaptiveHeartbeatDisabled = process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS === '1';

export interface EvaluateAdaptiveHeartbeatInput {
  triggeredBy: string;
  latestActivity?: ActivitySample | null;
}

export interface EvaluateAdaptiveHeartbeatResult {
  triggered: boolean;
  triggerReason: string;
  decision: TriggerDecision;
  requestId: string | null;
  queueDepth: number;
}

export interface CompleteAdaptiveHeartbeatInput {
  completionStatus?: CurationLogCompletionStatus | null;
  completionReason?: string | null;
}

interface CuratorAgentSessionResolution {
  sessionId: string;
  reusedSessionId: string | null;
  createdSessionId: string | null;
}

function hasQueuedHeartbeat(status: OrchestratorStatusResponse): boolean {
  const isQueuedCuratorCurationTask = (task: { priority?: string | null; messagePreview?: string | null; sessionId?: string | null } | null | undefined): boolean => {
    if (!task) return false;
    if (task.priority === 'heartbeat') return true;
    return typeof task.sessionId === 'string'
      && task.sessionId.trim().length > 0
      && typeof task.messagePreview === 'string'
      && /\b\/curate(?:\s|$)/i.test(task.messagePreview);
  };

  if (typeof status.activeCurationAgent === 'string' && status.activeCurationAgent.trim()) {
    return true;
  }

  if ((status.activeChatTasks ?? []).some((task) => isQueuedCuratorCurationTask(task))) {
    return true;
  }

  if (isQueuedCuratorCurationTask(status.currentTask)) {
    return true;
  }

  return status.queued.some((task) => isQueuedCuratorCurationTask(task));
}

function sanitizeTriggerSource(triggeredBy: string): string {
  const trimmed = triggeredBy.trim();
  if (!trimmed) return 'adaptive_heartbeat';
  return `adaptive_heartbeat:${trimmed}`.slice(0, 96);
}

function resolveCuratorAgentSession(): CuratorAgentSessionResolution | null {
  const existing = getMostRecentCuratorChatSession();
  if (existing) {
    console.info('[heartbeat] curator session lookup', {
      id: existing.id,
      title: existing.title,
      sessionType: existing.sessionType,
      workingDirectory: existing.workingDirectory,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    });
    return {
      sessionId: existing.id,
      reusedSessionId: existing.id,
      createdSessionId: null,
    };
  }

  console.info('[heartbeat] skipping automatic curation because no Curator Agent chat session exists');
  return null;
}

export async function evaluateAdaptiveHeartbeat(
  input: EvaluateAdaptiveHeartbeatInput,
): Promise<EvaluateAdaptiveHeartbeatResult> {
  const now = new Date().toISOString();
  const heartbeatConfig = readHeartbeatConfig();
  const history = getRecentUserActivity(1000)
    .map((row) => ({ event: row.event, timestamp: row.timestamp }));
  const latest = input.latestActivity ?? getMostRecentActivity();
  const decision = getTriggerDecision({
    now,
    activityHistory: history,
    latestActivity: latest ? { event: latest.event, timestamp: latest.timestamp } : null,
    lastCurationAt: getLatestSuccessfulCurationTime(),
    minIntervalMinutes: heartbeatConfig.minIntervalMinutes,
    maxIntervalMinutes: heartbeatConfig.maxIntervalMinutes,
    timeZone: heartbeatConfig.timeZone,
    recentAutomatedCancellation: getLatestAutomatedCurationCancellation(),
    automaticCancellationCooldownMinutes: heartbeatConfig.minIntervalMinutes,
  });

  if (!decision.trigger) {
    return {
      triggered: false,
      triggerReason: decision.reason,
      decision,
      requestId: null,
      queueDepth: 0,
    };
  }

  if (adaptiveHeartbeatDisabled) {
    return {
      triggered: false,
      triggerReason: 'adaptive_heartbeat_disabled',
      decision,
      requestId: null,
      queueDepth: 0,
    };
  }

  if (!heartbeatConfig.automaticCurationEnabled) {
    return {
      triggered: false,
      triggerReason: 'automatic_curation_disabled',
      decision,
      requestId: null,
      queueDepth: 0,
    };
  }

  const sourceReadiness = await getSourceReadiness();
  if (!sourceReadiness.ready) {
    return {
      triggered: false,
      triggerReason: 'content_source_not_configured',
      decision,
      requestId: null,
      queueDepth: 0,
    };
  }

  if (hasPendingCurationCycle()) {
    return {
      triggered: false,
      triggerReason: 'curation_cycle_pending',
      decision,
      requestId: null,
      queueDepth: 0,
    };
  }

  const orchestratorStatus = await getOrchestratorStatus().catch(() => null);
  if (orchestratorStatus && hasQueuedHeartbeat(orchestratorStatus)) {
    return {
      triggered: false,
      triggerReason: 'heartbeat_already_queued',
      decision,
      requestId: null,
      queueDepth: orchestratorStatus.queueDepth,
    };
  }

  const heartbeatWorkingDirectory = resolveRuntimeWorkingDirectory();
  const sessionResolution = resolveCuratorAgentSession();
  if (!sessionResolution) {
    return {
      triggered: false,
      triggerReason: 'curator_session_missing',
      decision,
      requestId: null,
      queueDepth: 0,
    };
  }

  const queueRequestId = `chat-queue-heartbeat-${randomUUID()}`;
  const triggerSource = sanitizeTriggerSource(input.triggeredBy);
  const curationTriggeredBy = `${triggerSource}:${decision.reason}`;

  insertCurationLogStart({
    requestId: queueRequestId,
    triggeredBy: curationTriggeredBy,
    startedAt: now,
    feedCountBefore: getFeedItemCount(),
  });

  try {
    const enqueueResult = await submitChatMessage({
      message: '/curate',
      sessionId: sessionResolution.sessionId,
      workingDirectory: heartbeatWorkingDirectory,
      priority: 'user_chat',
      source: triggerSource,
      requestId: queueRequestId,
      metadata: {
        triggerSource,
        heartbeatTriggeredBy: input.triggeredBy,
        triggerReason: decision.reason,
        predictedWindow: decision.predictedWindow,
        timeZone: heartbeatConfig.timeZone,
        minutesSinceLastCuration: decision.minutesSinceLastCuration,
        peakHours: decision.analysis.peakHours,
        automatedCuration: true,
        heartbeatSessionResolution: {
          reusedSessionId: sessionResolution.reusedSessionId,
          createdSessionId: sessionResolution.createdSessionId,
          workingDirectory: heartbeatWorkingDirectory,
        },
      },
    });

    if (!enqueueResult.ok || !enqueueResult.requestId) {
      deletePendingCurationLogByRequestId(queueRequestId);
      return {
        triggered: false,
        triggerReason: enqueueResult.message || 'enqueue_failed',
        decision,
        requestId: null,
        queueDepth: enqueueResult.queueDepth,
      };
    }

    return {
      triggered: true,
      triggerReason: decision.reason,
      decision,
      requestId: enqueueResult.requestId,
      queueDepth: enqueueResult.queueDepth,
    };
  } catch (error) {
    deletePendingCurationLogByRequestId(queueRequestId);
    throw error;
  }
}

export function completeAdaptiveHeartbeat(requestId: string, input: CompleteAdaptiveHeartbeatInput = {}): boolean {
  const trimmed = requestId.trim();
  if (!trimmed) return false;

  const entry = getCurationLogByRequestId(trimmed);
  if (!entry || entry.completedAt) {
    return false;
  }

  const baseline = typeof entry.feedCountBefore === 'number' ? entry.feedCountBefore : 0;
  const itemsAdded = Math.max(0, getFeedItemCount() - baseline);
  const completionStatus = input.completionStatus
    ?? (itemsAdded > 0 ? 'success' : 'empty');

  return completeCurationLogByRequestId(trimmed, {
    completedAt: new Date().toISOString(),
    itemsAdded,
    completionStatus,
    completionReason: input.completionReason ?? null,
  });
}
