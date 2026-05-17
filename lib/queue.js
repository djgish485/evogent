/* eslint-disable @typescript-eslint/no-require-imports */
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const BACKGROUND_QUEUE_NAME = process.env.MEDIA_AGENT_BACKGROUND_QUEUE_NAME || 'evogent-background';
const BACKGROUND_JOB_NAMES = Object.freeze({
  REFLECTION: 'reflection',
  CACHE_REFRESH: 'cache_refresh',
  USER_CHAT: 'user_chat',
  POST_ENRICHMENT: 'post_enrichment',
  CONFIG_APPLY: 'config_apply',
});
const STALE_CACHE_REFRESH_JOB_MAX_AGE_MS = 30 * 60 * 1000;

let sharedProducerConnection = null;
let sharedQueue = null;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRedisUrl() {
  return process.env.MEDIA_AGENT_REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

function createQueueConnection({ forWorker = false } = {}) {
  return new IORedis(getRedisUrl(), {
    enableReadyCheck: false,
    maxRetriesPerRequest: forWorker ? null : 1,
  });
}

function getBackgroundQueue() {
  if (!sharedProducerConnection) {
    sharedProducerConnection = createQueueConnection();
  }

  if (!sharedQueue) {
    sharedQueue = new Queue(BACKGROUND_QUEUE_NAME, {
      connection: sharedProducerConnection,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
  }

  return sharedQueue;
}

async function getBackgroundQueueDepth() {
  const queue = getBackgroundQueue();
  const counts = await queue.getJobCounts('active', 'waiting', 'prioritized', 'delayed');
  return (counts.active || 0)
    + (counts.waiting || 0)
    + (counts.prioritized || 0)
    + (counts.delayed || 0);
}

async function hasPendingBackgroundJob(name) {
  const queue = getBackgroundQueue();
  const jobs = await queue.getJobs(['active', 'waiting', 'prioritized', 'delayed']);
  return jobs.some((job) => job.name === name);
}

async function hasPendingCacheRefreshJob(source) {
  const normalizedSource = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (!normalizedSource) {
    return false;
  }

  const queue = getBackgroundQueue();
  const jobs = await queue.getJobs(['active', 'waiting', 'prioritized', 'delayed']);
  return jobs.some((job) => {
    if (job.name !== BACKGROUND_JOB_NAMES.CACHE_REFRESH) {
      return false;
    }

    const metadata = job.data && typeof job.data.metadata === 'object' ? job.data.metadata : null;
    const jobSource = typeof metadata?.cacheSource === 'string'
      ? metadata.cacheSource.trim().toLowerCase()
      : '';
    return jobSource === normalizedSource;
  });
}

function normalizeBackgroundJobNames(names) {
  if (!Array.isArray(names)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const entry of names) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function getBackgroundJobId(job) {
  if (typeof job?.id === 'string' && job.id.trim()) {
    return job.id.trim();
  }
  if (job?.id == null) {
    return null;
  }
  return String(job.id);
}

function isLockedJobRemovalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /locked by another worker/i.test(message);
}

async function drainStaleCacheRefreshJobsForSource(source, {
  maxAgeMs = STALE_CACHE_REFRESH_JOB_MAX_AGE_MS,
} = {}) {
  const normalizedSource = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (!normalizedSource) return { removed: 0, jobIds: [] };

  const queue = getBackgroundQueue();
  const cutoffMs = Date.now() - (Number.isFinite(maxAgeMs) && maxAgeMs > 0
    ? maxAgeMs
    : STALE_CACHE_REFRESH_JOB_MAX_AGE_MS);
  const jobs = await queue.getJobs(['active', 'waiting', 'prioritized', 'delayed']);
  const removedJobIds = [];

  for (const job of jobs) {
    const metadata = job.data && typeof job.data.metadata === 'object' ? job.data.metadata : null;
    const jobSource = typeof metadata?.cacheSource === 'string'
      ? metadata.cacheSource.trim().toLowerCase()
      : '';
    const jobTimestampMs = Number(job.processedOn || job.timestamp || 0);
    if (job.name !== BACKGROUND_JOB_NAMES.CACHE_REFRESH || jobSource !== normalizedSource || jobTimestampMs >= cutoffMs) {
      continue;
    }

    try {
      await job.remove();
      const jobId = getBackgroundJobId(job);
      if (jobId) removedJobIds.push(jobId);
    } catch (error) {
      if (!isLockedJobRemovalError(error)) throw error;
    }
  }

  return { removed: removedJobIds.length, jobIds: removedJobIds };
}

async function drainStaleBackgroundJobs({
  names = [],
  maxLockWaitMs = 30_000,
  pollIntervalMs = 250,
} = {}) {
  const normalizedNames = normalizeBackgroundJobNames(names);
  if (normalizedNames.length === 0) {
    return {
      removed: 0,
      removedByState: { active: 0, waiting: 0 },
      jobIds: [],
    };
  }

  const queue = getBackgroundQueue();
  const nameSet = new Set(normalizedNames);
  const removedJobIds = [];
  const removedByState = {
    active: 0,
    waiting: 0,
  };

  const removeJobsForState = async (state) => {
    const jobs = await queue.getJobs([state]);
    const matchingJobs = jobs.filter((job) => nameSet.has(job.name));
    const lockedJobIds = [];

    for (const job of matchingJobs) {
      try {
        await job.remove();
        const jobId = getBackgroundJobId(job);
        if (jobId) {
          removedJobIds.push(jobId);
        }
        removedByState[state] += 1;
      } catch (error) {
        if (state === 'active' && isLockedJobRemovalError(error)) {
          const jobId = getBackgroundJobId(job);
          if (jobId) {
            lockedJobIds.push(jobId);
          }
          continue;
        }
        throw error;
      }
    }

    return lockedJobIds;
  };

  await removeJobsForState('waiting');

  const deadlineAt = Date.now() + Math.max(0, maxLockWaitMs);
  for (;;) {
    const lockedJobIds = await removeJobsForState('active');
    if (lockedJobIds.length === 0) {
      break;
    }

    if (Date.now() >= deadlineAt) {
      throw new Error(`Timed out draining stale active jobs: ${lockedJobIds.join(', ')}`);
    }

    await delay(Math.min(Math.max(1, pollIntervalMs), Math.max(1, deadlineAt - Date.now())));
  }

  return {
    removed: removedJobIds.length,
    removedByState,
    jobIds: removedJobIds,
  };
}

async function enqueueBackgroundJob(name, data, options = {}) {
  if (options.skipIfPending && await hasPendingBackgroundJob(name)) {
    return {
      ok: true,
      duplicate: true,
      jobId: null,
      queueDepth: await getBackgroundQueueDepth(),
    };
  }

  const queue = getBackgroundQueue();
  const job = await queue.add(name, data, {
    jobId: typeof options.jobId === 'string' && options.jobId.trim() ? options.jobId.trim() : undefined,
  });

  return {
    ok: true,
    duplicate: false,
    jobId: typeof job.id === 'string' ? job.id : (job.id == null ? null : String(job.id)),
    queueDepth: await getBackgroundQueueDepth(),
  };
}

async function closeBackgroundQueue() {
  if (sharedQueue) {
    await sharedQueue.close();
    sharedQueue = null;
  }

  if (sharedProducerConnection) {
    await sharedProducerConnection.quit();
    sharedProducerConnection = null;
  }
}

module.exports = {
  BACKGROUND_JOB_NAMES,
  BACKGROUND_QUEUE_NAME,
  closeBackgroundQueue,
  createQueueConnection,
  drainStaleCacheRefreshJobsForSource,
  drainStaleBackgroundJobs,
  enqueueBackgroundJob,
  getBackgroundQueue,
  getBackgroundQueueDepth,
  hasPendingBackgroundJob,
  hasPendingCacheRefreshJob,
};
