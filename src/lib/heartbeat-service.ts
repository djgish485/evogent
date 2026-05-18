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

const adaptiveHeartbeatDisabled = process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS === '1';
const DEFAULT_OPENCLAW_CURATOR_SESSION_KEY = 'agent:curator:main';
const OPENCLAW_CURATOR_MESSAGE = 'Run a full curation cycle now.';

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

function resolveInternalBaseUrl(): string {
  const explicit = process.env.MEDIA_AGENT_INTERNAL_BASE_URL?.trim()
    || process.env.ORCHESTRATOR_INTERNAL_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.PORT || '3001'}`;
}

function resolveOpenClawCuratorSessionKey(): string {
  const configured = process.env.OPENCLAW_CURATOR_SESSION_KEY?.trim()
    || process.env.OPENCLAW_CURATOR_SESSION?.trim();
  return configured || DEFAULT_OPENCLAW_CURATOR_SESSION_KEY;
}

async function triggerOpenClawCuratorSession(requestId: string): Promise<{ ok: boolean; error: string | null }> {
  const sessionKey = resolveOpenClawCuratorSessionKey();
  const url = `${resolveInternalBaseUrl()}/api/openclaw/chat/${encodeURIComponent(sessionKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: OPENCLAW_CURATOR_MESSAGE,
      idempotencyKey: requestId,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      error: `OpenClaw curator enqueue failed (${response.status})${body ? `: ${body}` : ''}`,
    };
  }

  return { ok: true, error: null };
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

  const queueRequestId = `openclaw-heartbeat-${randomUUID()}`;
  const triggerSource = sanitizeTriggerSource(input.triggeredBy);
  const curationTriggeredBy = `${triggerSource}:${decision.reason}`;

  insertCurationLogStart({
    requestId: queueRequestId,
    triggeredBy: curationTriggeredBy,
    startedAt: now,
    feedCountBefore: getFeedItemCount(),
  });

  try {
    const enqueueResult = await triggerOpenClawCuratorSession(queueRequestId);

    if (!enqueueResult.ok) {
      deletePendingCurationLogByRequestId(queueRequestId);
      return {
        triggered: false,
        triggerReason: enqueueResult.error || 'openclaw_enqueue_failed',
        decision,
        requestId: null,
        queueDepth: 0,
      };
    }

    return {
      triggered: true,
      triggerReason: decision.reason,
      decision,
      requestId: queueRequestId,
      queueDepth: 1,
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
