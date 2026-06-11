const { readBackgroundSourceBrowsingEnabled } = require('./brain-config');
const { listInstalledCacheSources, readConfigUsageLevel } = require('./cache-refresh-config');
const {
  BACKGROUND_JOB_NAMES,
  drainStaleCacheRefreshJobsForSource,
  enqueueBackgroundJob,
  hasPendingCacheRefreshJob,
} = require('./queue');

const PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS = 15 * 60 * 1000;
const PRE_CURATION_CACHE_REFRESH_POLL_INTERVAL_MS = 1_000;
const PRE_CURATION_STALE_CACHE_REFRESH_JOB_MAX_AGE_MS = 30 * 60 * 1000;
const PRE_CURATION_FRESH_CACHE_MIN_AGE_MS = 6 * 60 * 60 * 1000;
const PRE_CURATION_FRESH_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRE_CURATION_FRESH_CACHE_TTL_FRACTION = 1 / 8;
const SOURCE_SETUP_REFRESH_TRIGGERED_BY = 'setup-source-smoke';
const SOURCE_CACHE_POLICIES = Object.freeze({
  hackernews: require('../data/hackernews-cache-policy.json'),
  substack: require('../data/substack-cache-policy.json'),
  twitter: require('../data/tweet-cache-policy.json'),
  youtube: require('../data/youtube-cache-policy.json'),
});

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCacheBackedCurationTask(task) {
  const metadata = isPlainObject(task?.metadata) ? task.metadata : null;
  const message = typeof task?.message === 'string' ? task.message.trim().toLowerCase() : '';
  const command = typeof metadata?.curationCommand === 'string'
    ? metadata.curationCommand.trim().toLowerCase()
    : '';

  // Always skip /curate-latest (lightweight, cache-only).
  if (command === '/curate-latest' || message === '/curate-latest' || message.startsWith('/curate-latest ')) {
    return false;
  }

  // Skip user-triggered /curate so manual runs feel instant. Only automated/background
  // curation gets the pre-cycle cache refresh.
  if (task?.priority === 'user_chat' || task?.priority === 'user_ping') {
    // user_ping with heartbeat-relayed metadata still counts as automated.
    if (metadata?.automatedCuration === true) return true;
    if (message.startsWith('heartbeat:') || message.includes('curation cycle')) return true;
    return false;
  }

  // Heartbeat-priority tasks are always automated.
  if (task?.priority === 'heartbeat') return true;
  if (metadata?.automatedCuration === true) return true;

  // Anything else (unknown priority, but tagged with /curate command) - default skip.
  return false;
}

async function waitForCacheRefreshSources(sources, {
  timeoutMs = PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS,
  pollIntervalMs = PRE_CURATION_CACHE_REFRESH_POLL_INTERVAL_MS,
  rootDir = process.cwd(),
  completedAfterMs = null,
  isPendingCacheRefreshJob = hasPendingCacheRefreshJob,
} = {}) {
  const pendingSources = new Set(sources);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS;
  const deadlineAtMs = Date.now() + timeout;
  const completedAfter = Number.isFinite(completedAfterMs) ? Number(completedAfterMs) : null;

  while (pendingSources.size > 0) {
    for (const source of [...pendingSources]) {
      const completedRun = completedAfter === null
        ? null
        : readLatestCompletedCacheRefreshRun(source, rootDir);
      const completedAtMs = Number(completedRun?.completedAtMs);
      if (Number.isFinite(completedAtMs) && completedAfter !== null && completedAtMs >= completedAfter) {
        pendingSources.delete(source);
        continue;
      }

      if (!await isPendingCacheRefreshJob(source)) {
        pendingSources.delete(source);
      }
    }

    if (pendingSources.size === 0) {
      return { timedOut: false, pendingSources: [] };
    }

    if (Date.now() >= deadlineAtMs) {
      return { timedOut: true, pendingSources: [...pendingSources] };
    }

    const remainingMs = Math.max(1, deadlineAtMs - Date.now());
    await delay(Math.min(Math.max(1, pollIntervalMs), remainingMs));
  }

  return { timedOut: false, pendingSources: [] };
}

function buildCacheRefreshRequestId(source, task, now) {
  const taskId = typeof task?.id === 'string' && task.id.trim() ? task.id.trim() : String(now);
  return `cache-refresh-${source}-${taskId}`.slice(0, 128);
}

function resolveCacheRefreshDbPath(rootDir) {
  const env = typeof process !== 'undefined' && process.env && typeof process.env === 'object' ? process.env : {};
  const trimPath = (value) => String(value || '').replace(/\/+$/, '');
  if (typeof env.TEST_SERVER_DATA_DIR === 'string' && env.TEST_SERVER_DATA_DIR.trim()) return `${trimPath(env.TEST_SERVER_DATA_DIR.trim())}/media-agent.db`;
  if (typeof env.MEDIA_AGENT_DB_PATH === 'string' && env.MEDIA_AGENT_DB_PATH.trim()) return env.MEDIA_AGENT_DB_PATH.trim();
  if (typeof env.DATA_DIR === 'string' && env.DATA_DIR.trim()) {
    const dataDir = env.DATA_DIR.trim();
    return dataDir.startsWith('/') ? `${trimPath(dataDir)}/media-agent.db` : `${trimPath(rootDir)}/${trimPath(dataDir)}/media-agent.db`;
  }
  return `${trimPath(rootDir)}/data/media-agent.db`;
}

function readLatestCacheRefreshRun(source, rootDir) {
  const normalizedSource = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (!normalizedSource) {
    return null;
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(resolveCacheRefreshDbPath(rootDir), { readonly: true, fileMustExist: true });
    try {
      return db.prepare(`
        SELECT id, status, error, started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs
        FROM browse_cache_refresh_runs
        WHERE source = ?
          AND triggered_by != ?
        ORDER BY started_at_ms DESC, id DESC
        LIMIT 1
      `).get(normalizedSource, SOURCE_SETUP_REFRESH_TRIGGERED_BY) || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readLatestCompletedCacheRefreshRun(source, rootDir) {
  const normalizedSource = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (!normalizedSource) {
    return null;
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(resolveCacheRefreshDbPath(rootDir), { readonly: true, fileMustExist: true });
    try {
      return db.prepare(`
        SELECT id, status, error, started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs
        FROM browse_cache_refresh_runs
        WHERE source = ?
          AND triggered_by != ?
          AND LOWER(COALESCE(status, '')) = 'completed'
          AND completed_at_ms IS NOT NULL
        ORDER BY completed_at_ms DESC, started_at_ms DESC, id DESC
        LIMIT 1
      `).get(normalizedSource, SOURCE_SETUP_REFRESH_TRIGGERED_BY) || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readSourcePolicyTtlHours(source, configPath) {
  const policy = SOURCE_CACHE_POLICIES[source];
  if (!policy) return null;

  try {
    const usageLevel = readConfigUsageLevel(configPath);
    const ttlHours = Number(policy?.profiles?.[usageLevel]?.ttlHours);
    return Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : null;
  } catch {
    return null;
  }
}

function resolvePreCurationFreshCacheMaxAgeMs(source, rootDir, configPath) {
  const ttlHours = readSourcePolicyTtlHours(source, configPath);
  if (!ttlHours) {
    return PRE_CURATION_FRESH_CACHE_MIN_AGE_MS;
  }

  const policyBasedMs = ttlHours * 60 * 60 * 1000 * PRE_CURATION_FRESH_CACHE_TTL_FRACTION;
  return Math.min(
    PRE_CURATION_FRESH_CACHE_MAX_AGE_MS,
    Math.max(PRE_CURATION_FRESH_CACHE_MIN_AGE_MS, Math.floor(policyBasedMs)),
  );
}

function isFreshCompletedCacheRefreshRun(run, nowMs, maxAgeMs) {
  const completedAtMs = Number(run?.completedAtMs);
  if (!Number.isFinite(completedAtMs) || completedAtMs <= 0) {
    return false;
  }

  const ageMs = nowMs - completedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function cleanLogValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function safeLog(level, message) {
  const logger = typeof console !== 'undefined' && console && typeof console[level] === 'function'
    ? console[level]
    : null;
  if (logger) logger.call(console, message);
}

function logPreCurationSource(sourceResult, field) {
  const staleSuffix = field === 'action' && sourceResult.staleJobsRemoved > 0 ? ` stale_removed=${sourceResult.staleJobsRemoved}` : '';
  const runSuffix = sourceResult.runId ? ` run_id=${sourceResult.runId}` : '';
  const statusSuffix = sourceResult.status ? ` status=${cleanLogValue(sourceResult.status)}` : '';
  const errorSuffix = sourceResult.error ? ` ${field === 'action' ? 'reason' : 'error'}=${cleanLogValue(sourceResult.error)}` : '';
  const freshSuffix = sourceResult.result === 'fresh' && sourceResult.freshnessMs ? ` freshness_ms=${sourceResult.freshnessMs}` : '';
  const actionSuffix = field === 'result' ? ` action=${sourceResult.action}` : '';
  const shouldWarn = sourceResult.action === 'enqueue_failed'
    || (field === 'result' && !['run_recorded', 'fresh'].includes(sourceResult.result));
  safeLog(shouldWarn ? 'warn' : 'log', `[cache-refresh] pre_curation source=${sourceResult.source} ${field}=${sourceResult[field]}${actionSuffix} request_id=${sourceResult.requestId}${staleSuffix}${runSuffix}${statusSuffix}${freshSuffix}${errorSuffix}`);
}

async function enqueueCacheRefreshForCuration(task, {
  rootDir = process.cwd(),
  configPath = `${process.cwd()}/data/config.md`,
  timeoutMs = PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS,
  waitForCompletion = true,
} = {}) {
  if (!isCacheBackedCurationTask(task)) {
    return { skipped: true, reason: 'not_cache_backed_curation', queuedSources: [], waitedSources: [], sourceResults: [] };
  }

  if (!readBackgroundSourceBrowsingEnabled(configPath)) {
    return { skipped: true, reason: 'background_source_browsing_disabled', queuedSources: [], waitedSources: [], sourceResults: [] };
  }

  const sources = listInstalledCacheSources(rootDir);
  if (sources.length === 0) {
    return { skipped: true, reason: 'no_cache_sources', queuedSources: [], waitedSources: [], sourceResults: [] };
  }

  const now = Date.now();
  const queuedSources = [];
  const waitedSources = new Set();
  const sourceResults = [];
  const baselineRuns = new Map(sources.map((source) => [
    source,
    readLatestCacheRefreshRun(source, rootDir),
  ]));

  for (const source of sources) {
    const sourceResult = {
      source,
      requestId: buildCacheRefreshRequestId(source, task, now),
      action: null,
      result: null,
      runId: null,
      status: null,
      error: null,
      staleJobsRemoved: 0,
      completedAtMs: null,
      freshnessMs: null,
    };
    sourceResults.push(sourceResult);

    try {
      const freshnessMs = resolvePreCurationFreshCacheMaxAgeMs(source, rootDir, configPath);
      const completedRun = readLatestCompletedCacheRefreshRun(source, rootDir);
      if (isFreshCompletedCacheRefreshRun(completedRun, now, freshnessMs)) {
        sourceResult.action = 'skipped_fresh';
        sourceResult.result = 'fresh';
        sourceResult.runId = typeof completedRun.id === 'string' ? completedRun.id : null;
        sourceResult.status = 'completed';
        sourceResult.completedAtMs = Number(completedRun.completedAtMs);
        sourceResult.freshnessMs = freshnessMs;
        logPreCurationSource(sourceResult, 'action');
        continue;
      }

      let hasPendingJob = await hasPendingCacheRefreshJob(source);
      if (hasPendingJob && typeof drainStaleCacheRefreshJobsForSource === 'function') {
        const drainResult = await drainStaleCacheRefreshJobsForSource(source, {
          maxAgeMs: PRE_CURATION_STALE_CACHE_REFRESH_JOB_MAX_AGE_MS,
        });
        sourceResult.staleJobsRemoved = drainResult.removed || 0;
        if (sourceResult.staleJobsRemoved > 0) {
          hasPendingJob = await hasPendingCacheRefreshJob(source);
        }
      }

      if (hasPendingJob) {
        sourceResult.action = 'already_pending';
        waitedSources.add(source);
        logPreCurationSource(sourceResult, 'action');
        continue;
      }

      const enqueueResult = await enqueueBackgroundJob(BACKGROUND_JOB_NAMES.CACHE_REFRESH, {
        requestId: sourceResult.requestId,
        message: `/cache-refresh ${source}`,
        priority: 'cache_refresh',
        source: `pre_curation:${source}`.slice(0, 96),
        metadata: {
          cacheSource: source,
          triggerSource: 'pre_curation',
          curationTaskId: typeof task?.id === 'string' ? task.id : null,
        },
      }, {
        jobId: sourceResult.requestId,
      });

      if (!enqueueResult || enqueueResult.ok === false) {
        throw new Error('BullMQ enqueue returned a non-ok result');
      }

      sourceResult.action = 'enqueued';
      queuedSources.push(source);
      waitedSources.add(source);
      logPreCurationSource(sourceResult, 'action');
    } catch (error) {
      sourceResult.action = 'enqueue_failed';
      sourceResult.result = 'enqueue_failed';
      sourceResult.error = error instanceof Error ? error.message : String(error);
      logPreCurationSource(sourceResult, 'action');
    }
  }

  if (waitForCompletion === false) {
    for (const sourceResult of sourceResults) {
      if (sourceResult.result === 'fresh') {
        logPreCurationSource(sourceResult, 'result');
        continue;
      }
      if (sourceResult.result === 'enqueue_failed') {
        logPreCurationSource(sourceResult, 'result');
        continue;
      }
      sourceResult.result = sourceResult.action === 'already_pending'
        ? 'already_pending_not_waited'
        : 'enqueued_not_waited';
      logPreCurationSource(sourceResult, 'result');
    }

    return {
      skipped: false,
      queuedSources,
      waitedSources: [...waitedSources],
      sourceResults,
      timedOut: false,
      pendingSources: [...waitedSources],
      waitingSkipped: true,
    };
  }

  const waitResult = await waitForCacheRefreshSources([...waitedSources], {
    timeoutMs,
    rootDir,
    completedAfterMs: now,
  });
  for (const sourceResult of sourceResults) {
    if (sourceResult.result === 'fresh') {
      logPreCurationSource(sourceResult, 'result');
      continue;
    }

    if (sourceResult.result === 'enqueue_failed') {
      logPreCurationSource(sourceResult, 'result');
      continue;
    }

    const latestRun = readLatestCacheRefreshRun(sourceResult.source, rootDir);
    const baselineRun = baselineRuns.get(sourceResult.source);
    const run = latestRun && (!baselineRun || latestRun.id !== baselineRun.id) ? latestRun : null;
    if (!run) {
      sourceResult.result = 'no_run_recorded';
      logPreCurationSource(sourceResult, 'result');
      continue;
    }

    const status = typeof run.status === 'string' ? run.status.trim().toLowerCase() : '';
    sourceResult.runId = typeof run.id === 'string' ? run.id : null;
    sourceResult.status = status || null;
    if (status === 'failed') {
      sourceResult.result = 'failed';
      sourceResult.error = run.error || null;
    } else {
      sourceResult.result = 'run_recorded';
    }
    logPreCurationSource(sourceResult, 'result');
  }

  return {
    skipped: false,
    queuedSources,
    waitedSources: [...waitedSources],
    sourceResults,
    ...waitResult,
  };
}

module.exports = {
  PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS,
  PRE_CURATION_FRESH_CACHE_MIN_AGE_MS,
  PRE_CURATION_FRESH_CACHE_MAX_AGE_MS,
  enqueueCacheRefreshForCuration,
  isCacheBackedCurationTask,
  isFreshCompletedCacheRefreshRun,
  resolvePreCurationFreshCacheMaxAgeMs,
  waitForCacheRefreshSources,
};
