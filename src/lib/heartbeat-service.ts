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
import { arrangeFeedBackstopForCycle } from '@/lib/db/feed';
import { notifyFeedArranged } from '@/lib/curation-submit';
import { getActiveFeedThreads } from '@/lib/db/feed';
import { getSourceReadiness } from '@/lib/setup-readiness';
import { submitChatMessage } from '@/lib/chat-submission';
import { getMostRecentCuratorChatSession } from '@/lib/db/chat-sessions';
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

  const baseline = typeof entry.feedCountBefore === 'number' ? entry.feedCountBefore : 0;
  const itemsAdded = Math.max(0, getFeedItemCount() - baseline);
  const completionStatus = input.completionStatus
    ?? (itemsAdded > 0 ? 'success' : 'empty');

  const completed = completeCurationLogByRequestId(trimmed, {
    completedAt: new Date().toISOString(),
    itemsAdded,
    completionStatus,
    completionReason: input.completionReason ?? null,
  });

  if (completed && itemsAdded > 0) {
    const startedAtMs = Date.parse(entry.startedAt);
    if (Number.isFinite(startedAtMs) && startedAtMs > 0) {
      try {
        const backstop = arrangeFeedBackstopForCycle(startedAtMs);
        if (backstop.fired) {
          console.log('[arrange-backstop] curator skipped evogent_feed_arrange; mechanical fallback applied', {
            requestId: trimmed,
            itemCount: backstop.itemCount,
          });
          void notifyFeedArranged({
            ordering: [],
            activeThreads: getActiveFeedThreads(),
            updatedItemIds: [],
            orderingCount: backstop.itemCount,
            threadCount: 0,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[arrange-backstop] backstop failed', { requestId: trimmed, error: message });
      }
    }
  }

  return completed;
}
