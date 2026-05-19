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

function sanitizeRunIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown';
}

function isSetupSourceSmokeTask(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  return metadata?.setupSourceSmoke === true
    || metadata?.triggerSource === 'setup-source'
    || task?.source === 'setup-source';
}

function resolveCacheRefreshRunId(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  for (const key of ['cacheRefreshRunId', 'runId']) {
    if (typeof metadata?.[key] === 'string' && metadata[key].trim()) {
      return sanitizeRunIdPart(metadata[key]);
    }
  }

  const taskId = sanitizeRunIdPart(task?.id || task?.requestId || 'unknown');
  if (isSetupSourceSmokeTask(task)) {
    const source = sanitizeRunIdPart(resolveCacheRefreshTaskSource(task) || 'source');
    return `setup-source-${source}-${taskId}`;
  }

  return taskId;
}

function resolveCacheRefreshTriggeredBy(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  if (isSetupSourceSmokeTask(task)) {
    return 'setup-source-smoke';
  }
  if (typeof metadata?.triggeredBy === 'string' && metadata.triggeredBy.trim()) {
    return metadata.triggeredBy.trim();
  }
  if (typeof metadata?.triggerSource === 'string' && metadata.triggerSource.trim()) {
    return metadata.triggerSource.trim();
  }
  return 'cache_refresh';
}

function resolveCacheRefreshStartedAtMs(task, completedAtMs) {
  const parsed = Date.parse(task?.startedAt || task?.enqueuedAt || '');
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return completedAtMs;
}

function normalizeFailureMessage(value, fallback = 'cache refresh failed before recording a terminal run') {
  const message = value instanceof Error ? value.message : String(value || '');
  return message.replace(/\s+/g, ' ').trim().slice(0, 1000) || fallback;
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

function readTableColumns(db, tableName) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set(rows.map((row) => row?.name).filter((name) => typeof name === 'string'));
  } catch {
    return new Set();
  }
}

function persistFailedCacheRefreshRun(task, {
  getDb,
  errorMessage,
  completedAtMs = Date.now(),
  logger = console,
} = {}) {
  const source = resolveCacheRefreshTaskSource(task);
  if (!source || typeof getDb !== 'function') {
    return null;
  }

  const completedMs = Number.isFinite(Number(completedAtMs)) ? Math.floor(Number(completedAtMs)) : Date.now();
  const startedAtMs = resolveCacheRefreshStartedAtMs(task, completedMs);
  const runId = resolveCacheRefreshRunId(task);
  const error = normalizeFailureMessage(errorMessage);

  try {
    const db = getDb();
    if (!db?.prepare) {
      return null;
    }

    const table = db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'browse_cache_refresh_runs'
      LIMIT 1
    `).get();
    if (!table) {
      return null;
    }

    const existing = db.prepare(`
      SELECT id, status, error, items_added AS itemsAdded, completed_at_ms AS completedAtMs
      FROM browse_cache_refresh_runs
      WHERE id = ?
      LIMIT 1
    `).get(runId);
    const existingStatus = typeof existing?.status === 'string' ? existing.status.trim().toLowerCase() : '';
    if (existingStatus === 'failed' || existingStatus === 'completed') {
      return normalizeCompletedRun(existing);
    }

    const columns = readTableColumns(db, 'browse_cache_refresh_runs');
    const insertColumns = [
      'id',
      'source',
      'triggered_by',
      'started_at_ms',
      'completed_at_ms',
      'status',
      'items_added',
      'error',
    ];
    const values = [
      runId,
      source,
      resolveCacheRefreshTriggeredBy(task),
      startedAtMs,
      completedMs,
      'failed',
      0,
      error,
    ];

    if (columns.has('metadata_json')) {
      insertColumns.push('metadata_json');
      values.push(JSON.stringify({
        taskId: typeof task?.id === 'string' ? task.id : null,
        requestId: typeof task?.requestId === 'string' ? task.requestId : null,
        taskSource: typeof task?.source === 'string' ? task.source : null,
        validation: 'no_terminal_run_recorded',
      }));
    }

    const placeholders = insertColumns.map(() => '?').join(', ');
    const updates = insertColumns
      .filter((column) => column !== 'id')
      .map((column) => `${column} = excluded.${column}`)
      .join(', ');

    db.prepare(`
      INSERT INTO browse_cache_refresh_runs (${insertColumns.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updates}
      WHERE LOWER(COALESCE(browse_cache_refresh_runs.status, '')) != 'completed'
        OR COALESCE(browse_cache_refresh_runs.items_added, 0) <= 0
    `).run(...values);

    const row = db.prepare(`
      SELECT id, status, error, items_added AS itemsAdded, completed_at_ms AS completedAtMs
      FROM browse_cache_refresh_runs
      WHERE id = ?
      LIMIT 1
    `).get(runId);
    return normalizeCompletedRun(row);
  } catch (error_) {
    const message = error_ instanceof Error ? error_.message : String(error_);
    logger?.warn?.(`[orchestrator] failed to persist failed browse-cache refresh run for ${task?.id || task?.requestId || 'unknown'}: ${message}`);
    return null;
  }
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

function isMissingTerminalRun(run, baselineRun) {
  const baselineRunId = typeof baselineRun?.id === 'string' && baselineRun.id.trim()
    ? baselineRun.id.trim()
    : null;
  const runId = typeof run?.id === 'string' && run.id.trim() ? run.id.trim() : null;
  return !run || (baselineRunId && runId === baselineRunId);
}

function validateCacheRefreshTaskResult(task, {
  baselineRun = null,
  getDb,
  logger = console,
  persistNoRunFailure = false,
  failureCause = null,
  completedAtMs = Date.now(),
} = {}) {
  if (!isCacheRefreshTask(task)) {
    return { ok: true, run: null, error: null };
  }

  let run = readLatestTerminalCacheRefreshRun(task, { getDb, logger });
  let error = buildCacheRefreshValidationFailure(task, run, baselineRun);

  if (error && persistNoRunFailure && isMissingTerminalRun(run, baselineRun)) {
    const source = resolveCacheRefreshTaskSource(task) || 'unknown';
    const cause = failureCause ? `; worker error: ${normalizeFailureMessage(failureCause)}` : '';
    const persistedError = `Cache refresh for ${source} did not persist a new terminal browse-cache refresh run${cause}`;
    run = persistFailedCacheRefreshRun(task, {
      getDb,
      logger,
      completedAtMs,
      errorMessage: persistedError,
    }) || run;
    error = buildCacheRefreshValidationFailure(task, run, baselineRun) || persistedError;
  }

  return {
    ok: !error,
    run,
    error,
  };
}

module.exports = {
  buildCacheRefreshValidationFailure,
  isCacheRefreshTask,
  persistFailedCacheRefreshRun,
  readLatestTerminalCacheRefreshRun,
  resolveCacheRefreshTaskSource,
  validateCacheRefreshTaskResult,
};
