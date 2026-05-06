import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadOnDemandModule({
  backgroundSourceBrowsingEnabled = true,
  sources = [],
  hasPendingCacheRefreshJob = async () => false,
  enqueueBackgroundJob = async () => ({ ok: true, jobId: 'job' }),
} = {}) {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/cache-refresh-on-demand.js'), 'utf8');
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    process: { cwd: () => process.cwd() },
    setTimeout,
    require: (specifier) => {
      if (specifier === './brain-config') {
        return { readBackgroundSourceBrowsingEnabled: () => backgroundSourceBrowsingEnabled };
      }
      if (specifier === './cache-refresh-config') {
        return { listInstalledCacheSources: () => sources };
      }
      if (specifier === './queue') {
        return {
          BACKGROUND_JOB_NAMES: { CACHE_REFRESH: 'cache_refresh' },
          enqueueBackgroundJob,
          hasPendingCacheRefreshJob,
        };
      }
      throw new Error(`Unexpected require in on-demand cache refresh test: ${specifier}`);
    },
  };

  vm.runInNewContext(source, sandbox, { filename: 'cache-refresh-on-demand.js' });
  return cjsModule.exports;
}

function extractRunCurationTimerTick(source) {
  const start = source.indexOf('async function runCurationTimerTick');
  const end = source.indexOf('\n\nfunction createBackgroundWorker', start);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to locate runCurationTimerTick in worker.js');
  }

  return source.slice(start, end);
}

test('enqueueCacheRefreshForCuration queues installed sources before /curate and reuses pending source jobs', async () => {
  const enqueued = [];
  let youtubePendingInitialCheck = true;
  const {
    enqueueCacheRefreshForCuration,
  } = loadOnDemandModule({
    sources: ['twitter', 'youtube'],
    hasPendingCacheRefreshJob: async (source) => {
      if (source === 'youtube' && youtubePendingInitialCheck) {
        youtubePendingInitialCheck = false;
        return true;
      }
      return false;
    },
    enqueueBackgroundJob: async (name, payload, options) => {
      enqueued.push({ name, payload, options });
      return { ok: true, jobId: options.jobId };
    },
  });

  const result = await enqueueCacheRefreshForCuration({
    id: 'curate-task-1',
    priority: 'user_chat',
    metadata: { curationCommand: '/curate' },
  }, {
    rootDir: '/repo',
    configPath: '/repo/data/config.md',
    timeoutMs: 10,
  });

  assert.deepStrictEqual(enqueued.map((job) => ({
    name: job.name,
    message: job.payload.message,
    priority: job.payload.priority,
    cacheSource: job.payload.metadata.cacheSource,
    triggerSource: job.payload.metadata.triggerSource,
  })), [{
    name: 'cache_refresh',
    message: '/cache-refresh twitter',
    priority: 'cache_refresh',
    cacheSource: 'twitter',
    triggerSource: 'pre_curation',
  }]);
  assert.deepStrictEqual([...result.queuedSources], ['twitter']);
  assert.deepStrictEqual([...result.waitedSources], ['twitter', 'youtube']);
  assert.strictEqual(result.timedOut, false);
});

test('enqueueCacheRefreshForCuration skips non-cache curation and disabled source browsing', async () => {
  const disabled = loadOnDemandModule({
    backgroundSourceBrowsingEnabled: false,
    sources: ['twitter'],
  });
  const disabledResult = await disabled.enqueueCacheRefreshForCuration({
    id: 'curate-task-2',
    priority: 'user_chat',
    metadata: { curationCommand: '/curate' },
  });
  assert.strictEqual(disabledResult.skipped, true);
  assert.strictEqual(disabledResult.reason, 'background_source_browsing_disabled');
  assert.deepStrictEqual([...disabledResult.queuedSources], []);
  assert.deepStrictEqual([...disabledResult.waitedSources], []);

  const enabled = loadOnDemandModule({
    backgroundSourceBrowsingEnabled: true,
    sources: ['twitter'],
  });
  const latestResult = await enabled.enqueueCacheRefreshForCuration({
    id: 'latest-task-1',
    priority: 'user_chat',
    metadata: { curationCommand: '/curate-latest' },
  });
  assert.strictEqual(latestResult.skipped, true);
  assert.strictEqual(latestResult.reason, 'not_cache_backed_curation');
  assert.deepStrictEqual([...latestResult.queuedSources], []);
  assert.deepStrictEqual([...latestResult.waitedSources], []);
});

test('waitForCacheRefreshSources returns timedOut instead of blocking curation indefinitely', async () => {
  const {
    waitForCacheRefreshSources,
  } = loadOnDemandModule({
    hasPendingCacheRefreshJob: async () => true,
  });

  const result = await waitForCacheRefreshSources(['twitter'], {
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  assert.strictEqual(result.timedOut, true);
  assert.deepStrictEqual([...result.pendingSources], ['twitter']);
});

test('cache-backed curation detection includes full /curate but excludes /curate-latest', () => {
  const { isCacheBackedCurationTask } = loadOnDemandModule();

  assert.strictEqual(isCacheBackedCurationTask({
    priority: 'user_chat',
    metadata: { curationCommand: '/curate' },
  }), true);
  assert.strictEqual(isCacheBackedCurationTask({
    priority: 'user_chat',
    metadata: { curationCommand: '/curate-latest' },
  }), false);
  assert.strictEqual(isCacheBackedCurationTask({
    priority: 'heartbeat',
    message: 'Heartbeat: run curation cycle',
  }), true);
});

test('worker timer no longer runs periodic cache refresh checks', () => {
  const workerSource = fs.readFileSync(path.join(process.cwd(), 'worker.js'), 'utf8');
  const timerTickSource = extractRunCurationTimerTick(workerSource);

  assert.doesNotMatch(workerSource, /runCacheRefreshSchedulerCheck/);
  assert.doesNotMatch(timerTickSource, /CACHE_REFRESH|cache_refresh|Cache refresh/);
  assert.doesNotMatch(workerSource, /Cache refresh timer enabled in worker/);
});

test('brain orchestrator runs pre-curation setup for chat-backed /curate', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/brain-orchestrator.js'), 'utf8');

  assert.match(source, /function isChatBackedCurateTask\(task\)/);
  assert.match(source, /if \(isChatBackedCurateTask\(task\)\) \{\s+await regeneratePreferenceContextBeforeCuration\(task\);/);
});

test('pending worker restart drains cache-refresh work before checking idle state', () => {
  const workerSource = fs.readFileSync(path.join(process.cwd(), 'worker.js'), 'utf8');
  const drainIndex = workerSource.indexOf('await backgroundOrchestrator.prepareForWorkerRestart();');
  const statusIndex = workerSource.indexOf('const status = backgroundOrchestrator.getStatus();', drainIndex);

  assert.notStrictEqual(drainIndex, -1);
  assert.notStrictEqual(statusIndex, -1);
  assert.ok(drainIndex < statusIndex);
  assert.match(workerSource, /drained cache-refresh work for pending worker restart/);
});

test('brain orchestrator restart drain is scoped to cache refresh and preserves active chat', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/brain-orchestrator.js'), 'utf8');

  assert.match(source, /async prepareForWorkerRestart\(\{ graceMs = 5_000 \} = \{\}\)/);
  assert.match(source, /activeUserChatTasks: this\.activeChatTasks\.size/);
  assert.doesNotMatch(source, /this\.activeChatTasks\.clear\(\)/);
  assert.match(source, /_getTerminalBrowseCacheRefreshRun\(task\)/);
  assert.match(source, /LOWER\(status\) IN \('completed', 'failed'\)/);
  assert.match(source, /this\._signalProcessGroup\(pid, 'SIGTERM'\)/);
  assert.match(source, /this\._signalProcessGroup\(pid, 'SIGKILL'\)/);
  assert.match(source, /Cache refresh skipped by worker restart before it started/);
});
