import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@/lib/data-dir';
import { getDb, getDbPath } from '@/lib/db/client';
import { areBackgroundJobsDisabled, getAdaptiveHeartbeatMode, getRuntimeProfile } from '@/lib/runtime-profile';

interface SourceCadence {
  cadenceHours?: unknown;
}

interface PhoneControlSourceStatus {
  outcome?: unknown;
  completedAt?: unknown;
  completedAtMs?: unknown;
  lastCompletedAtMs?: unknown;
}

interface PhoneControlOwnerStatus {
  state?: unknown;
  owner?: unknown;
  pid?: unknown;
  processStartTicks?: unknown;
  updatedAtMs?: unknown;
  completedAtMs?: unknown;
  lastCompletedAtMs?: unknown;
  detail?: unknown;
}

interface PhoneControlStatus {
  scheduler?: PhoneControlOwnerStatus;
  watchdog?: PhoneControlOwnerStatus;
  cycle?: PhoneControlOwnerStatus;
  sources?: Record<string, PhoneControlSourceStatus>;
  updatedAt?: unknown;
  updatedAtMs?: unknown;
}

const WATCHDOG_HEARTBEAT_MAX_AGE_MS = 3 * 60 * 1000;
const STATUS_FUTURE_SKEW_TOLERANCE_MS = 60 * 1000;
const BROWSE_REFRESH_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function getControlStatusPath(): string {
  return process.env.EVOGENT_PHONE_CONTROL_STATUS_PATH?.trim()
    || getDataPath('phone-control-status.json');
}

function readSourceCadences(): Record<string, SourceCadence> {
  for (const candidate of [
    getDataPath('source-cadence.json'),
    getDataPath('source-cadence.default.json'),
  ]) {
    const record = readJsonRecord(candidate);
    if (record) return record as Record<string, SourceCadence>;
  }
  return {};
}

function normalizePositiveNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeEpochMs(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function readProcessStartTicks(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const procRoot = process.env.EVOGENT_PROC_ROOT?.trim() || '/proc';
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    // proc(5): starttime is field 22. Removing "pid (comm) " leaves it at
    // zero-based offset 19, even when comm itself contains spaces or parentheses.
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    return Number.isSafeInteger(startTicks) && startTicks > 0 ? startTicks : null;
  } catch {
    return null;
  }
}

function summarizeOwnerStatus(
  status: PhoneControlOwnerStatus | undefined,
  nowMs: number,
  options: { maxHeartbeatAgeMs?: number } = {},
) {
  if (!status) {
    return {
      state: null,
      owner: null,
      pid: null,
      processStartTicks: null,
      processIdentityLive: false,
      heartbeatFresh: false,
      live: false,
      updatedAt: null,
      ageSeconds: null,
      detail: null,
    };
  }
  const pid = normalizePositiveNumber(status.pid);
  const expectedStart = normalizePositiveNumber(status.processStartTicks);
  const updatedAtMs = normalizeEpochMs(status.updatedAtMs);
  const actualStart = pid === null ? null : readProcessStartTicks(pid);
  const state = typeof status.state === 'string' ? status.state : null;
  const processIdentityLive = pid !== null
    && expectedStart !== null
    && actualStart !== null
    && actualStart === expectedStart;
  const rawAgeMs = updatedAtMs === null ? null : nowMs - updatedAtMs;
  const heartbeatFresh = options.maxHeartbeatAgeMs === undefined
    ? true
    : rawAgeMs !== null
      && rawAgeMs >= -STATUS_FUTURE_SKEW_TOLERANCE_MS
      && rawAgeMs <= options.maxHeartbeatAgeMs;
  return {
    state,
    owner: typeof status.owner === 'string' ? status.owner : null,
    pid,
    processStartTicks: expectedStart,
    processIdentityLive,
    heartbeatFresh,
    live: state === 'running' && processIdentityLive && heartbeatFresh,
    updatedAt: updatedAtMs === null ? null : new Date(updatedAtMs).toISOString(),
    ageSeconds: updatedAtMs === null
      ? null
      : Math.max(0, Math.round((nowMs - updatedAtMs) / 1000)),
    detail: typeof status.detail === 'string' ? status.detail : null,
  };
}

function readDbIntegrity(): {
  ok: boolean;
  result: string;
  bytes: number | null;
  error: string | null;
} {
  try {
    const rows = getDb().pragma('quick_check(1)') as Array<Record<string, unknown>>;
    const result = rows
      .flatMap((row) => Object.values(row))
      .find((value): value is string => typeof value === 'string') ?? 'unknown';
    let bytes: number | null = null;
    try {
      bytes = fs.statSync(getDbPath()).size;
    } catch {
      bytes = null;
    }
    return {
      ok: result.toLowerCase() === 'ok',
      result,
      bytes,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      result: 'error',
      bytes: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readQueueHealth() {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM curation_log WHERE completed_at IS NULL) AS pendingCuration,
      (SELECT COUNT(*) FROM chat_messages
        WHERE role = 'user'
          AND COALESCE(status, '') IN ('pending', 'queued', 'processing', 'running')) AS activeChat,
      (SELECT COUNT(*) FROM code_fix_tasks
        WHERE status = 'queued' AND phase = 'host_review') AS hostDevelopment,
      (SELECT COUNT(*) FROM code_fix_tasks
        WHERE status IN ('dispatched', 'running')) AS onPhoneDevelopment
  `).get() as {
    pendingCuration: number;
    activeChat: number;
    hostDevelopment: number;
    onPhoneDevelopment: number;
  };
  return row;
}

function readSourceHealth(nowMs: number, controlStatus: PhoneControlStatus | null) {
  const db = getDb();
  const cadences = readSourceCadences();
  const refreshTimestampUpperBoundMs = nowMs + BROWSE_REFRESH_TIMESTAMP_SKEW_MS;
  const cacheRows = db.prepare(`
    SELECT
      source,
      COUNT(*) AS itemCount,
      MAX(fetched_at_ms) AS latestFetchedAtMs
    FROM browse_cache_items
    GROUP BY source
  `).all() as Array<{
    source: string;
    itemCount: number;
    latestFetchedAtMs: number | null;
  }>;
  const refreshRows = db.prepare(`
    SELECT source, status, items_added AS itemsAdded, error, started_at_ms AS startedAtMs,
           completed_at_ms AS completedAtMs
    FROM (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY source
          ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC, id DESC
        ) AS sourceRank
      FROM browse_cache_refresh_runs
    )
    WHERE sourceRank = 1
  `).all() as Array<{
    source: string;
    status: string;
    itemsAdded: number;
    error: string | null;
    startedAtMs: number;
    completedAtMs: number | null;
  }>;
  const latestRunBySource = new Map(refreshRows.map((row) => [row.source, row]));
  const completedRefreshRows = db.prepare(`
    SELECT source, MAX(completed_at_ms) AS completedAtMs
    FROM browse_cache_refresh_runs
    WHERE LOWER(status) = 'completed'
      AND completed_at_ms IS NOT NULL
      AND completed_at_ms >= 0
      AND completed_at_ms <= ?
      AND started_at_ms >= 0
      AND started_at_ms <= ?
      AND completed_at_ms + ? >= started_at_ms
    GROUP BY source
  `).all(
    refreshTimestampUpperBoundMs,
    refreshTimestampUpperBoundMs,
    BROWSE_REFRESH_TIMESTAMP_SKEW_MS,
  ) as Array<{
    source: string;
    completedAtMs: number;
  }>;
  const latestCompletedRefreshBySource = new Map(
    completedRefreshRows.map((row) => [row.source, row.completedAtMs]),
  );
  const sourceNames = new Set([
    ...cacheRows.map((row) => row.source),
    ...refreshRows.map((row) => row.source),
    ...Object.keys(cadences),
    ...Object.keys(controlStatus?.sources ?? {}),
  ]);
  const cacheBySource = new Map(cacheRows.map((row) => [row.source, row]));

  return [...sourceNames].sort().map((source) => {
    const cache = cacheBySource.get(source);
    const latestRun = latestRunBySource.get(source);
    const control = controlStatus?.sources?.[source];
    const cadenceHours = normalizePositiveNumber(cadences[source]?.cadenceHours);
    const latestFetchedAtMs = cache?.latestFetchedAtMs ?? null;
    const latestCompletedRefreshAtMs = latestCompletedRefreshBySource.get(source) ?? null;
    // A completed zero-new/deduplicated run is still truthful evidence that the source was just
    // inspected. Cache-item fetch time remains visible independently; whichever evidence is newer
    // drives cadence freshness without pretending a failed/incomplete run succeeded.
    const freshnessReferenceAtMs = Math.max(
      latestFetchedAtMs ?? -1,
      latestCompletedRefreshAtMs ?? -1,
    );
    const normalizedFreshnessReferenceAtMs = freshnessReferenceAtMs >= 0
      ? freshnessReferenceAtMs
      : null;
    let freshnessReferenceKind: 'completed_refresh' | 'cache_item' | null = null;
    if (normalizedFreshnessReferenceAtMs !== null) {
      freshnessReferenceKind = latestCompletedRefreshAtMs !== null
        && latestCompletedRefreshAtMs >= (latestFetchedAtMs ?? -1)
        ? 'completed_refresh'
        : 'cache_item';
    }
    const ageMinutes = normalizedFreshnessReferenceAtMs === null
      ? null
      : Math.max(0, Math.round((nowMs - normalizedFreshnessReferenceAtMs) / 60_000));
    const overdue = cadenceHours !== null
      && ageMinutes !== null
      && ageMinutes > cadenceHours * 2 * 60;
    const latestRunFailed = Boolean(
      latestRun && latestRun.status.toLowerCase() !== 'completed',
    );
    const state = latestRunFailed
      ? 'mechanics_failed'
      : normalizedFreshnessReferenceAtMs === null
        ? 'empty'
        : overdue
          ? 'stale'
          : 'healthy';

    return {
      source,
      state,
      itemCount: cache?.itemCount ?? 0,
      latestFetchedAt: latestFetchedAtMs === null
        ? null
        : new Date(latestFetchedAtMs).toISOString(),
      latestCompletedRefreshAt: latestCompletedRefreshAtMs === null
        ? null
        : new Date(latestCompletedRefreshAtMs).toISOString(),
      freshnessReferenceAt: normalizedFreshnessReferenceAtMs === null
        ? null
        : new Date(normalizedFreshnessReferenceAtMs).toISOString(),
      freshnessReferenceKind,
      ageMinutes,
      cadenceHours,
      lastOutcome: typeof control?.outcome === 'string' ? control.outcome : null,
      lastOutcomeAt: (() => {
        if (typeof control?.completedAt === 'string') return control.completedAt;
        const completedAtMs = normalizeEpochMs(
          control?.completedAtMs ?? control?.lastCompletedAtMs,
        );
        return completedAtMs === null ? null : new Date(completedAtMs).toISOString();
      })(),
      latestRefresh: latestRun
        ? {
            status: latestRun.status,
            itemsAdded: latestRun.itemsAdded,
            completedAt: latestRun.completedAtMs === null
              ? null
              : new Date(latestRun.completedAtMs).toISOString(),
            error: latestRun.error,
          }
        : null,
    };
  });
}

export function readPhoneHealth(nowMs = Date.now()) {
  const db = readDbIntegrity();
  const controlStatus = readJsonRecord(getControlStatusPath()) as PhoneControlStatus | null;
  const queues = db.ok ? readQueueHealth() : null;
  const sources = db.ok ? readSourceHealth(nowMs, controlStatus) : [];
  const runtimeProfile = getRuntimeProfile();
  const phoneProfile = runtimeProfile === 'phone'
    || runtimeProfile === 'android'
    || runtimeProfile === 'pixel';
  const scheduler = summarizeOwnerStatus(controlStatus?.scheduler, nowMs);
  const watchdog = summarizeOwnerStatus(controlStatus?.watchdog, nowMs, {
    maxHeartbeatAgeMs: WATCHDOG_HEARTBEAT_MAX_AGE_MS,
  });
  const cycle = summarizeOwnerStatus(controlStatus?.cycle, nowMs);
  const cycleClaimsRunning = cycle.state === 'running';
  const criticalProblems = [
    ...(!db.ok ? ['database_integrity'] : []),
    ...(phoneProfile && !controlStatus ? ['phone_control_status_missing'] : []),
    ...(phoneProfile && controlStatus && !scheduler.live ? ['scheduler_owner_not_live'] : []),
    ...(phoneProfile && controlStatus && !watchdog.live
      ? [
          watchdog.state === 'running'
            && watchdog.processIdentityLive
            && !watchdog.heartbeatFresh
            ? 'watchdog_heartbeat_stale'
            : 'watchdog_owner_not_live',
        ]
      : []),
    ...(phoneProfile && cycleClaimsRunning && !cycle.live ? ['cycle_owner_not_live'] : []),
    ...(phoneProfile && (queues?.onPhoneDevelopment ?? 0) > 0 ? ['on_phone_development_active'] : []),
  ];

  return {
    ok: criticalProblems.length === 0,
    checkedAt: new Date(nowMs).toISOString(),
    runtime: {
      profile: runtimeProfile,
      backgroundJobsDisabled: areBackgroundJobsDisabled(),
      adaptiveHeartbeatMode: getAdaptiveHeartbeatMode(),
    },
    database: db,
    control: {
      registry: controlStatus,
      scheduler,
      watchdog,
      cycle,
    },
    queues,
    sources,
    criticalProblems,
  };
}
