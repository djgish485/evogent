import { NextResponse } from 'next/server';
import { evaluateAdaptiveHeartbeat } from '@/lib/heartbeat-service';
import { hasPendingCurationCycle, insertUserActivity, isActivityEvent } from '@/lib/db/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INLINE_HEARTBEAT_DEBOUNCE_MS = 30_000;
let lastInlineHeartbeatEvaluationAt = 0;
let inlineHeartbeatEvaluationInFlight = false;

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const event = (payload as { event?: unknown }).event;
  if (!isActivityEvent(event)) {
    return NextResponse.json({
      error: 'event must be one of: app_open, pull_refresh, ping, foreground, background',
    }, { status: 400 });
  }

  const metadataRaw = (payload as { metadata?: unknown }).metadata;
  const metadata = metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw)
    ? metadataRaw as Record<string, unknown>
    : null;

  const timestamp = new Date().toISOString();
  const activityId = insertUserActivity(event, metadata, timestamp);
  const nowMs = Date.now();

  // Instant freshness on arrival: an app open promotes the curator's benched near-misses and
  // re-arranges — sub-second, no brain — so the user never stares at hours-old top-of-feed
  // while the (minutes-long) heartbeat curation catches up. Self-debounced server-side.
  if (event === 'app_open' || event === 'foreground') {
    const origin = new URL(request.url).origin;
    void fetch(`${origin}/api/internal/feed/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minIntervalSeconds: 300, limit: 6 }),
    }).catch(() => { /* freshness is best-effort; activity logging must never fail on it */ });
  }
  const recentlyEvaluated = nowMs - lastInlineHeartbeatEvaluationAt < INLINE_HEARTBEAT_DEBOUNCE_MS;

  if ((inlineHeartbeatEvaluationInFlight || recentlyEvaluated) && !hasPendingCurationCycle()) {
    return NextResponse.json({
      ok: true,
      logged: true,
      activityId,
      heartbeat: {
        triggered: false,
        triggerReason: 'inline_heartbeat_debounced',
        decisionReason: 'inline_heartbeat_debounced',
        requestId: null,
      },
    });
  }

  try {
    inlineHeartbeatEvaluationInFlight = true;
    lastInlineHeartbeatEvaluationAt = nowMs;
    const heartbeat = await evaluateAdaptiveHeartbeat({
      triggeredBy: `activity:${event}`,
      latestActivity: { event, timestamp },
    });

    return NextResponse.json({
      ok: true,
      logged: true,
      activityId,
      heartbeat: {
        triggered: heartbeat.triggered,
        triggerReason: heartbeat.triggerReason,
        decisionReason: heartbeat.decision.reason,
        requestId: heartbeat.requestId,
      },
    });
  } catch {
    return NextResponse.json({
      ok: true,
      logged: true,
      activityId,
      heartbeat: {
        triggered: false,
        triggerReason: 'heartbeat_evaluation_failed',
      },
    });
  } finally {
    inlineHeartbeatEvaluationInFlight = false;
    lastInlineHeartbeatEvaluationAt = Date.now();
  }
}
