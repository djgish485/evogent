function isCacheRefreshTask(task) {
  if (!task) return false;
  if (task.priority === 'cache_refresh') return true;
  return typeof task.message === 'string'
    && /^\/cache-refresh(?:\s|$)/i.test(task.message.trim());
}

function resolveCacheRefreshTaskSource(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  if (typeof metadata?.cacheSource === 'string' && metadata.cacheSource.trim()) {
    return metadata.cacheSource.trim().toLowerCase().split(/\s+/, 1)[0] || null;
  }

  const message = typeof task?.message === 'string' ? task.message.trim() : '';
  const match = message.match(/^\/cache-refresh\s+(\S+)/i);
  return match?.[1]?.trim().toLowerCase() || null;
}

function normalizeCompletedRun(row) {
  if (!row || typeof row !== 'object') return null;

  return {
    id: typeof row.id === 'string' ? row.id : null,
    status: typeof row.status === 'string' ? row.status : null,
    error: typeof row.error === 'string' ? row.error : null,
    itemsAdded: Number.isFinite(Number(row.itemsAdded)) ? Number(row.itemsAdded) : 0,
    completedAtMs: Number.isFinite(Number(row.completedAtMs)) ? Number(row.completedAtMs) : null,
  };
}

function readLatestTerminalCacheRefreshRun(task, {
  getDb,
  logger = console,
} = {}) {
  const source = resolveCacheRefreshTaskSource(task);
  if (!source || typeof getDb !== 'function') {
    return null;
  }

  const taskStartedAtMs = Date.parse(task?.startedAt || task?.enqueuedAt || '');
  const minRunTimestampMs = Number.isFinite(taskStartedAtMs)
    ? Math.max(0, taskStartedAtMs - (5 * 60 * 1000))
    : 0;

  try {
    const db = getDb();
    if (!db?.prepare) {
      return null;
    }

    const row = db.prepare(`
      SELECT id, status, error, items_added AS itemsAdded, completed_at_ms AS completedAtMs
      FROM browse_cache_refresh_runs
      WHERE source = ?
        AND LOWER(status) IN ('completed', 'failed')
        AND completed_at_ms IS NOT NULL
        AND (
          started_at_ms >= ?
          OR completed_at_ms >= ?
        )
      ORDER BY completed_at_ms DESC, id DESC
      LIMIT 1
    `).get(source, minRunTimestampMs, minRunTimestampMs);
    return normalizeCompletedRun(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[orchestrator] failed to inspect browse-cache refresh state for ${task?.id || 'unknown'}: ${message}`);
    return null;
  }
}

function buildCacheRefreshValidationFailure(task, run, baselineRun) {
  const source = resolveCacheRefreshTaskSource(task) || 'unknown';
  const baselineRunId = typeof baselineRun?.id === 'string' && baselineRun.id.trim()
    ? baselineRun.id.trim()
    : null;
  const runId = typeof run?.id === 'string' && run.id.trim() ? run.id.trim() : null;

  if (!run || (baselineRunId && runId === baselineRunId)) {
    return `Cache refresh for ${source} did not persist a new terminal browse-cache refresh run`;
  }

  const status = typeof run.status === 'string' ? run.status.trim().toLowerCase() : '';
  if (status === 'failed') {
    const detail = typeof run.error === 'string' && run.error.trim()
      ? `: ${run.error.trim()}`
      : '';
    return `Cache refresh for ${source} persisted failed run ${runId || 'unknown'}${detail}`;
  }

  if (status !== 'completed') {
    return `Cache refresh for ${source} persisted non-terminal run ${runId || 'unknown'} with status ${status || 'unknown'}`;
  }

  const itemsAdded = Number.isFinite(Number(run.itemsAdded)) ? Number(run.itemsAdded) : 0;
  if (itemsAdded <= 0) {
    return `Cache refresh for ${source} completed with 0 items added in browse-cache run ${runId || 'unknown'}`;
  }

  return null;
}

function validateCacheRefreshTaskResult(task, {
  baselineRun = null,
  getDb,
  logger = console,
} = {}) {
  if (!isCacheRefreshTask(task)) {
    return { ok: true, run: null, error: null };
  }

  const run = readLatestTerminalCacheRefreshRun(task, { getDb, logger });
  const error = buildCacheRefreshValidationFailure(task, run, baselineRun);
  return {
    ok: !error,
    run,
    error,
  };
}

module.exports = {
  buildCacheRefreshValidationFailure,
  isCacheRefreshTask,
  readLatestTerminalCacheRefreshRun,
  resolveCacheRefreshTaskSource,
  validateCacheRefreshTaskResult,
};
