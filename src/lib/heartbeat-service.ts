import { randomUUID } from 'node:crypto';
import type { ActivitySample, TriggerDecision } from '@/lib/heartbeat';
import { getTriggerDecision } from '@/lib/heartbeat';
import { readHeartbeatConfig } from '@/lib/heartbeat-config';
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
import { getSourceReadiness } from '@/lib/setup-readiness';
import { submitChatMessage } from '@/lib/chat-submission';
import { getMostRecentCuratorChatSession } from '@/lib/db/chat-sessions';
import { resolveRuntimeWorkingDirectory } from '@/lib/runtime-working-directory';
import { requestPhoneCycle } from '@/lib/phone-cycle-signal';
import { getAdaptiveHeartbeatMode } from '@/lib/runtime-profile';

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

function sanitizeTriggerSource(triggeredBy: string): string {
  const trimmed = triggeredBy.trim();
  if (!trimmed) return 'adaptive_heartbeat';
  return `adaptive_heartbeat:${trimmed}`.slice(0, 96);
}

interface CuratorAgentSessionResolution {
  sessionId: string;
  workingDirectory: string;
}

/** Resolve the Curator Agent chat session the heartbeat dispatches `/curate` to. Direct
 *  claude/codex curation runs in a real chat session (the pre-OpenClaw model); we reuse the
 *  most-recent curator session and never auto-create one — no session means skip this cycle. */
function resolveCuratorAgentSession(): CuratorAgentSessionResolution | null {
  const existing = getMostRecentCuratorChatSession();
  if (!existing) {
    console.info('[heartbeat] skipping automatic curation because no Curator Agent chat session exists');
    return null;
  }
  return {
    sessionId: existing.id,
    workingDirectory: existing.workingDirectory || resolveRuntimeWorkingDirectory(),
  };
}

function markCurationEnqueueFailed(requestId: string, reason: string): void {
  const completed = completeCurationLogByRequestId(requestId, {
    completedAt: new Date().toISOString(),
    itemsAdded: 0,
    completionStatus: 'failed',
    completionReason: reason,
  });
  if (!completed) {
    deletePendingCurationLogByRequestId(requestId);
  }
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

  const heartbeatMode = getAdaptiveHeartbeatMode();
  if (heartbeatMode === 'off') {
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

  if (heartbeatMode === 'signal') {
    const signal = requestPhoneCycle({
      reason: decision.reason,
      triggeredBy: input.triggeredBy,
    });
    return {
      triggered: !signal.duplicate,
      triggerReason: signal.duplicate ? 'phone_cycle_already_requested' : decision.reason,
      decision,
      requestId: signal.request.id,
      queueDepth: 1,
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
    // Direct claude/codex curation: dispatch `/curate` into the Curator Agent chat session
    // (the same path a user typing /curate takes), which the orchestrator runs on claude/codex.
    const enqueueResult = await submitChatMessage({
      message: '/curate',
      sessionId: sessionResolution.sessionId,
      workingDirectory: sessionResolution.workingDirectory,
      priority: 'user_chat',
      source: triggerSource,
      requestId: queueRequestId,
      metadata: {
        triggerSource,
        heartbeatTriggeredBy: input.triggeredBy,
        triggerReason: decision.reason,
        timeZone: heartbeatConfig.timeZone,
        automatedCuration: true,
        curationCycleId: queueRequestId,
      },
    });

    if (!enqueueResult.ok || !enqueueResult.requestId) {
      markCurationEnqueueFailed(queueRequestId, enqueueResult.message || 'enqueue_failed');
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
    markCurationEnqueueFailed(queueRequestId, error instanceof Error ? error.message : String(error));
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

  const baseline = typeof entry.feedCountBefore === 'number'
    ? Math.max(0, entry.feedCountBefore)
    : getFeedItemCount();
  const itemsAdded = Math.max(0, getFeedItemCount() - baseline);

  // Compatibility endpoint for an older worker cannot prove an agent-authored
  // terminal receipt. It may close an orphan so the scheduler can retry, but it
  // must never manufacture success from a feed-count delta.
  return completeCurationLogByRequestId(trimmed, {
    completedAt: new Date().toISOString(),
    itemsAdded,
    completionStatus: 'failed',
    completionReason: input.completionReason?.trim()
      ? `missing_validated_cycle_receipt: ${input.completionReason.trim()}`
      : 'missing_validated_cycle_receipt',
  });
}
