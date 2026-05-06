const { readBackgroundSourceBrowsingEnabled } = require('./brain-config');
const { listInstalledCacheSources } = require('./cache-refresh-config');
const {
  BACKGROUND_JOB_NAMES,
  enqueueBackgroundJob,
  hasPendingCacheRefreshJob,
} = require('./queue');

const PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS = 15 * 60 * 1000;
const PRE_CURATION_CACHE_REFRESH_POLL_INTERVAL_MS = 1_000;

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
  const command = typeof metadata?.curationCommand === 'string'
    ? metadata.curationCommand.trim().toLowerCase()
    : '';

  if (command) {
    return command === '/curate';
  }

  const message = typeof task?.message === 'string' ? task.message.trim().toLowerCase() : '';
  if (message === '/curate' || message.startsWith('/curate ')) return true;
  if (message === '/curate-latest' || message.startsWith('/curate-latest ')) return false;

  if (metadata?.automatedCuration === true) return true;
  if (task?.priority === 'heartbeat') return true;
  return task?.priority === 'user_ping'
    && (message.startsWith('heartbeat:') || message.includes('curation cycle'));
}

async function waitForCacheRefreshSources(sources, {
  timeoutMs = PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS,
  pollIntervalMs = PRE_CURATION_CACHE_REFRESH_POLL_INTERVAL_MS,
} = {}) {
  const pendingSources = new Set(sources);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS;
  const deadlineAtMs = Date.now() + timeout;

  while (pendingSources.size > 0) {
    for (const source of [...pendingSources]) {
      if (!await hasPendingCacheRefreshJob(source)) {
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

async function enqueueCacheRefreshForCuration(task, {
  rootDir = process.cwd(),
  configPath = `${process.cwd()}/data/config.md`,
  timeoutMs = PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS,
} = {}) {
  if (!isCacheBackedCurationTask(task)) {
    return { skipped: true, reason: 'not_cache_backed_curation', queuedSources: [], waitedSources: [] };
  }

  if (!readBackgroundSourceBrowsingEnabled(configPath)) {
    return { skipped: true, reason: 'background_source_browsing_disabled', queuedSources: [], waitedSources: [] };
  }

  const sources = listInstalledCacheSources(rootDir);
  if (sources.length === 0) {
    return { skipped: true, reason: 'no_cache_sources', queuedSources: [], waitedSources: [] };
  }

  const now = Date.now();
  const queuedSources = [];
  const waitedSources = new Set();

  for (const source of sources) {
    if (await hasPendingCacheRefreshJob(source)) {
      waitedSources.add(source);
      continue;
    }

    const requestId = buildCacheRefreshRequestId(source, task, now);
    await enqueueBackgroundJob(BACKGROUND_JOB_NAMES.CACHE_REFRESH, {
      requestId,
      message: `/cache-refresh ${source}`,
      priority: 'cache_refresh',
      source: `pre_curation:${source}`.slice(0, 96),
      metadata: {
        cacheSource: source,
        triggerSource: 'pre_curation',
        curationTaskId: typeof task?.id === 'string' ? task.id : null,
      },
    }, {
      jobId: requestId,
    });

    queuedSources.push(source);
    waitedSources.add(source);
  }

  const waitResult = await waitForCacheRefreshSources([...waitedSources], { timeoutMs });
  return {
    skipped: false,
    queuedSources,
    waitedSources: [...waitedSources],
    ...waitResult,
  };
}

module.exports = {
  PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS,
  enqueueCacheRefreshForCuration,
  isCacheBackedCurationTask,
  waitForCacheRefreshSources,
};
