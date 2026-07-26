import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { predictNextOpen } from '@/lib/anticipation-schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultLeadMinutes = 35; // expected cycle duration + buffer: finish just before the open
const historyDays = 14;

/**
 * Scheduling directive for the on-device cycle loop: when should the NEXT browse+curate
 * cycle start so it completes just before the user's predicted next app open? The scheduler
 * polls this while sleeping, so fresh opens reshape the plan without a restart.
 */
const activeWindowMs = 20 * 60 * 1000; // "user is here right now" if active within 20 min

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const leadRaw = Number(searchParams.get('leadMinutes') ?? String(defaultLeadMinutes));
  const leadMinutes = Number.isFinite(leadRaw) && leadRaw > 0 ? Math.min(leadRaw, 180) : defaultLeadMinutes;
  const minIntervalRaw = Number(searchParams.get('minIntervalMinutes') ?? '120');
  const minIntervalMs = (Number.isFinite(minIntervalRaw) && minIntervalRaw > 0 ? minIntervalRaw : 120) * 60 * 1000;

  const db = getDb();
  const sinceIso = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT timestamp FROM user_activity
    WHERE event IN ('app_open', 'foreground')
      AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(sinceIso) as Array<{ timestamp: string }>;
  const openTimestampsMs = rows
    .map((row) => Date.parse(row.timestamp))
    .filter((ms) => Number.isFinite(ms));

  const nowMs = Date.now();
  const prediction = predictNextOpen(nowMs, openTimestampsMs);
  const predictedOpenAtMs = prediction.predictedOpenAtMs;
  const recommendedStartAtMs = predictedOpenAtMs === null
    ? null
    : Math.max(nowMs, predictedOpenAtMs - leadMinutes * 60 * 1000);

  // Active-use freshness: the open-aware predictor optimizes for the NEXT arrival, but an
  // active session with stale visible content needs a cycle now,
  // not at the predicted next open. activeRefreshDue fires when the user is active right now,
  // the last cycle is older than the min interval (battery floor still respected), and the
  // newest CONTENT on screen is itself stale past that interval. The scheduler treats this as
  // due regardless of the prediction.
  const lastActivityMs = openTimestampsMs.length > 0 ? openTimestampsMs[openTimestampsMs.length - 1] : 0;
  const activeNow = nowMs - lastActivityMs <= activeWindowMs;

  const lastCycleRow = db.prepare(`
    SELECT completed_at FROM curation_log
    WHERE completed_at IS NOT NULL AND completion_status IN ('success', 'successful_empty')
    ORDER BY completed_at DESC LIMIT 1
  `).get() as { completed_at: string } | undefined;
  const lastCycleMs = lastCycleRow ? Date.parse(lastCycleRow.completed_at) : 0;
  const cycleAgeMs = nowMs - (Number.isFinite(lastCycleMs) ? lastCycleMs : 0);

  const newestContentRow = db.prepare(`
    SELECT created_at_ms FROM feed
    WHERE parent_id IS NULL AND type IN ('tweet', 'article', 'analysis')
    ORDER BY created_at_ms DESC LIMIT 1
  `).get() as { created_at_ms: number } | undefined;
  const contentAgeMs = newestContentRow ? nowMs - newestContentRow.created_at_ms : Number.POSITIVE_INFINITY;

  const activeRefreshDue = activeNow && cycleAgeMs > minIntervalMs && contentAgeMs > minIntervalMs;

  return NextResponse.json({
    ok: true,
    predictedOpenAt: predictedOpenAtMs === null ? null : new Date(predictedOpenAtMs).toISOString(),
    recommendedStartAt: recommendedStartAtMs === null ? null : new Date(recommendedStartAtMs).toISOString(),
    minutesUntilRecommendedStart: recommendedStartAtMs === null
      ? null
      : Math.max(0, Math.round((recommendedStartAtMs - nowMs) / 60000)),
    leadMinutes,
    activeRefreshDue,
    activeUse: {
      activeNow,
      minutesSinceLastActivity: lastActivityMs ? Math.round((nowMs - lastActivityMs) / 60000) : null,
      minutesSinceLastCycle: lastCycleMs ? Math.round(cycleAgeMs / 60000) : null,
      contentAgeMinutes: Number.isFinite(contentAgeMs) ? Math.round(contentAgeMs / 60000) : null,
    },
    basis: prediction.basis,
  });
}
