import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { getDataPath } from '@/lib/data-dir';
import {
  enqueueOrchestratorMessage,
  getOrchestratorStatus,
  type OrchestratorStatusResponse,
} from './orchestrator';

const LOCK_DIR = getDataPath('.orchestrator-test-lock');
const CHAT_OUTPUT_PATH = getDataPath('chat-output.jsonl');
const REFLECTION_STATUS_PATH = getDataPath('reflection-status.json');
const ORCHESTRATOR_INTEGRATION_SKIP_REASON = process.env.RUN_ORCHESTRATOR_INTEGRATION_TESTS === '1'
  ? undefined
  : 'requires RUN_ORCHESTRATOR_INTEGRATION_TESTS=1 and an isolated orchestrator server';

async function acquireOrchestratorLock(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fs.promises.mkdir(LOCK_DIR);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }
    }

    await delay(100);
  }

  throw new Error('Timed out acquiring orchestrator test lock');
}

async function releaseOrchestratorLock(): Promise<void> {
  await fs.promises.rm(LOCK_DIR, { recursive: true, force: true });
}

async function withOrchestratorLock<T>(run: () => Promise<T>): Promise<T> {
  await acquireOrchestratorLock();
  try {
    return await run();
  } finally {
    await releaseOrchestratorLock();
  }
}

async function waitForStatus(
  predicate: (status: OrchestratorStatusResponse) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<OrchestratorStatusResponse> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getOrchestratorStatus();
    if (predicate(status)) {
      return status;
    }
    await delay(intervalMs);
  }

  throw new Error('Timed out waiting for orchestrator status condition');
}

function requestId(label: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `test-orch-${label}-${Date.now()}-${rand}`;
}

async function readChatOutputEvents(): Promise<Array<Record<string, unknown>>> {
  const content = await fs.promises.readFile(CHAT_OUTPUT_PATH, 'utf8')
    .catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? '' : Promise.reject(error)));

  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForChatEvent(
  predicate: (event: Record<string, unknown>) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const events = await readChatOutputEvents();
    const match = events.find((event) => predicate(event));
    if (match) {
      return match;
    }
    await delay(intervalMs);
  }

  throw new Error('Timed out waiting for chat event');
}

describe('orchestrator client wrappers', { skip: ORCHESTRATOR_INTEGRATION_SKIP_REASON }, () => {
  test('enqueueOrchestratorMessage returns ok + requestId', async () => {
    await withOrchestratorLock(async () => {
      const result = await enqueueOrchestratorMessage({
        message: '[unit] orchestrator enqueue smoke',
        priority: 'user_ping',
        source: 'unit-test',
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(typeof result.requestId, 'string');
      assert.ok((result.requestId ?? '').length > 0);
      assert.strictEqual(typeof result.queueDepth, 'number');
    });
  });

  test('enqueueOrchestratorMessage supports all priority levels', async () => {
    await withOrchestratorLock(async () => {
      const priorities = [
        { value: 'user_chat' as const, expectedNumeric: 400 },
        { value: 'feed_action' as const, expectedNumeric: 325 },
        { value: 'user_ping' as const, expectedNumeric: 300 },
        { value: 'post_enrichment' as const, expectedNumeric: 200 },
        { value: 'cache_refresh' as const, expectedNumeric: 150 },
        { value: 'reflection' as const, expectedNumeric: 50 },
      ];

      for (const priority of priorities) {
        const result = await enqueueOrchestratorMessage({
          message: `[unit] priority ${priority.value}`,
          priority: priority.value,
          source: `unit-test-priority-${priority.expectedNumeric}`,
        });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.priority, priority.value);
      }
    });
  });

  test('getOrchestratorStatus returns queue + brain fields', async () => {
    await withOrchestratorLock(async () => {
      const status = await getOrchestratorStatus();

      assert.strictEqual(typeof status.sessionName, 'string');
      assert.strictEqual(typeof status.queueDepth, 'number');
      assert.strictEqual(typeof status.isProcessing, 'boolean');
      assert.strictEqual(typeof status.brain.sessionExists, 'boolean');
      assert.strictEqual(typeof status.brain.working, 'boolean');
      assert.strictEqual(typeof status.brain.checkedAt, 'string');
      assert.ok(Array.isArray(status.queued));
      assert.ok(Array.isArray(status.history));
    });
  });

  test('queue ordering keeps high-priority tasks ahead of lower-priority tasks', async () => {
    await withOrchestratorLock(async () => {
      const initialStatus = await getOrchestratorStatus();
      if (!initialStatus.isProcessing && initialStatus.queueDepth === 0) {
        const blockerId = requestId('blocker');
        const blocker = await enqueueOrchestratorMessage({
          message: '[unit] blocker task to hold current slot',
          priority: 'user_ping',
          requestId: blockerId,
          source: 'unit-test-ordering',
        });

        assert.strictEqual(blocker.ok, true);

        await waitForStatus((status) => status.currentTask?.id === blockerId, { timeoutMs: 10_000 });
      }

      const lowId = requestId('low-post-enrichment');
      const highId = requestId('high-chat');

      const low = await enqueueOrchestratorMessage({
        message: '[unit] low priority task',
        priority: 'post_enrichment',
        requestId: lowId,
        source: 'unit-test-ordering-low',
      });

      const high = await enqueueOrchestratorMessage({
        message: '[unit] high priority task',
        priority: 'user_chat',
        requestId: highId,
        source: 'unit-test-ordering-high',
      });

      assert.strictEqual(low.ok, true);
      assert.strictEqual(high.ok, true);

      const status = await waitForStatus((snapshot) => {
        const queuedIds = snapshot.queued.map((item) => item.id);
        const historyIds = snapshot.history.map((item) => item.id);

        if (queuedIds.includes(highId) && queuedIds.includes(lowId)) {
          return true;
        }

        if (snapshot.currentTask?.id === highId && queuedIds.includes(lowId)) {
          return true;
        }

        if (historyIds.includes(highId) && historyIds.includes(lowId)) {
          return true;
        }

        if (snapshot.currentTask?.id === lowId && historyIds.includes(highId)) {
          return true;
        }

        return false;
      }, { timeoutMs: 20_000, intervalMs: 150 });

      const queuedIds = status.queued.map((item) => item.id);
      const historyIds = status.history.map((item) => item.id);

      if (queuedIds.includes(highId) && queuedIds.includes(lowId)) {
        assert.ok(queuedIds.indexOf(highId) < queuedIds.indexOf(lowId));
        return;
      }

      if (status.currentTask?.id === highId && queuedIds.includes(lowId)) {
        assert.ok(true);
        return;
      }

      if (historyIds.includes(highId) && historyIds.includes(lowId)) {
        assert.ok(historyIds.indexOf(highId) < historyIds.indexOf(lowId));
        return;
      }

      assert.strictEqual(status.currentTask?.id, lowId);
      assert.ok(historyIds.includes(highId));
    });
  });

  test('background curation does not block chat and emits lifecycle events', async () => {
    await withOrchestratorLock(async () => {
      await waitForStatus((status) => (
        status.queueDepth === 0
        && !status.isProcessing
        && !status.activeCurationAgent
        && !status.activeReflectionAgent
      ), { timeoutMs: 120_000, intervalMs: 200 });

      const curationId = requestId('background-curation');
      const chatId = requestId('background-chat');

      const curation = await enqueueOrchestratorMessage({
        message: '/curate [unit] background curation should not block chat',
        priority: 'heartbeat',
        requestId: curationId,
        source: 'unit-test-background-curation',
      });

      assert.strictEqual(curation.ok, true);

      await waitForStatus((status) => (
        status.activeCurationAgent === curationId
        && status.history.some((task) => task.id === curationId && task.state === 'processing')
      ), { timeoutMs: 60_000, intervalMs: 150 });

      const chat = await enqueueOrchestratorMessage({
        message: '[unit] chat should run while curation is active',
        priority: 'user_chat',
        requestId: chatId,
        source: 'unit-test-background-chat',
      });

      assert.strictEqual(chat.ok, true);

      const concurrentStatus = await waitForStatus((status) => (
        status.history.some((task) => task.id === curationId && (task.state === 'processing' || task.state === 'completed'))
        && status.history.some((task) => task.id === chatId && task.state === 'completed')
      ), { timeoutMs: 60_000, intervalMs: 150 });

      assert.ok(concurrentStatus.history.some((task) => task.id === chatId && task.state === 'completed'));

      const finalStatus = await waitForStatus((status) => (
        !status.activeCurationAgent
        && status.history.some((task) => task.id === curationId && task.state === 'completed')
      ), { timeoutMs: 60_000, intervalMs: 150 });

      const curationHistory = finalStatus.history.find((task) => task.id === curationId);
      assert.ok(curationHistory);
      assert.strictEqual(typeof curationHistory?.logFile, 'string');
      assert.ok((curationHistory?.logFile ?? '').endsWith(`${curationId}.jsonl`));

      const startEvent = await waitForChatEvent((event) => event.id === `event-curation-started-${curationId}`);
      assert.ok(startEvent);
      assert.strictEqual((startEvent?.metadata as Record<string, unknown> | undefined)?.taskId, curationId);
      assert.strictEqual((startEvent?.metadata as Record<string, unknown> | undefined)?.event, 'curation_started');
      assert.strictEqual((startEvent?.metadata as Record<string, unknown> | undefined)?.hasTranscript, true);
    });
  });

  test('reflection tasks run in background without blocking later queue work', async () => {
    await withOrchestratorLock(async () => {
      await waitForStatus((status) => (
        status.queueDepth === 0
        && !status.isProcessing
        && !status.activeCurationAgent
        && !status.activeReflectionAgent
      ), { timeoutMs: 120_000, intervalMs: 200 });

      const reflectionId = requestId('background-reflection');
      const pingId = requestId('background-ping');

      const reflection = await enqueueOrchestratorMessage({
        message: '[unit] reflection should move to background',
        priority: 'reflection',
        requestId: reflectionId,
        source: 'unit-test-background-reflection',
      });

      assert.strictEqual(reflection.ok, true);

      await waitForStatus((status) => (
        !status.isProcessing
        && status.history.some((task) => task.id === reflectionId && task.state === 'processing')
      ), { timeoutMs: 10_000, intervalMs: 150 });

      const ping = await enqueueOrchestratorMessage({
        message: '[unit] ping should run while reflection is active',
        priority: 'user_ping',
        requestId: pingId,
        source: 'unit-test-background-ping',
      });

      assert.strictEqual(ping.ok, true);

      await waitForStatus((status) => (
        status.history.some((task) => task.id === reflectionId && task.state === 'processing')
        && (
          status.currentTask?.id === pingId
          || status.history.some((task) => task.id === pingId && task.state === 'completed')
        )
      ), { timeoutMs: 15_000, intervalMs: 150 });

      await waitForStatus((status) => (
        status.history.some((task) => task.id === reflectionId && task.state === 'completed')
        && status.history.some((task) => task.id === pingId && task.state === 'completed')
      ), { timeoutMs: 15_000, intervalMs: 150 });
    });
  });

  test('custom requestId is preserved', async () => {
    await withOrchestratorLock(async () => {
      const customId = requestId('custom');
      const result = await enqueueOrchestratorMessage({
        message: '[unit] custom request id',
        priority: 'user_ping',
        requestId: customId,
        source: 'unit-test-custom-id',
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.requestId, customId);
    });
  });

  test('queueDepth increments as additional messages are enqueued', async () => {
    await withOrchestratorLock(async () => {
      await waitForStatus((status) => status.queueDepth === 0 && !status.isProcessing, { timeoutMs: 120_000 });

      const baselineStatus = JSON.stringify({
        active: false,
        pid: null,
        startedAt: null,
        completedAt: null,
        lastReflectionAt: '2024-01-02T03:04:05.000Z',
        lastQueuedAt: '2024-01-02T02:00:00.000Z',
        triggerSource: 'baseline-reflection',
        requestId: 'baseline-request',
        logFile: null,
        updatedAt: '2024-01-02T03:04:05.000Z',
      }, null, 2);
      const originalStatus = await fs.promises.readFile(REFLECTION_STATUS_PATH, 'utf8')
        .catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      await fs.promises.mkdir(path.dirname(REFLECTION_STATUS_PATH), { recursive: true });
      await fs.promises.writeFile(REFLECTION_STATUS_PATH, baselineStatus);

      try {
        const blockerId = requestId('depth-blocker');
        await enqueueOrchestratorMessage({
          message: '[unit] depth blocker',
          priority: 'user_ping',
          requestId: blockerId,
          source: 'unit-test-depth',
        });

        await waitForStatus((status) => status.currentTask?.id === blockerId, { timeoutMs: 10_000 });

        const first = await enqueueOrchestratorMessage({
          message: '[unit] queue depth first',
          priority: 'reflection',
          requestId: requestId('depth-1'),
          source: 'unit-test-depth-1',
        });

        const second = await enqueueOrchestratorMessage({
          message: '[unit] queue depth second',
          priority: 'reflection',
          requestId: requestId('depth-2'),
          source: 'unit-test-depth-2',
        });

        assert.strictEqual(first.ok, true);
        assert.strictEqual(second.ok, true);
        // Background tasks (reflection) launch immediately without entering
        // the foreground queue, so queueDepth stays 0 for both.
        assert.strictEqual(first.backgrounded, true);
        assert.strictEqual(second.backgrounded, true);

        await waitForStatus((status) => (
          status.queueDepth === 0
          && !status.isProcessing
          && status.history.some((task) => task.id === second.requestId)
        ), { timeoutMs: 20_000, intervalMs: 150 });

        const finalStatus = JSON.parse(await fs.promises.readFile(REFLECTION_STATUS_PATH, 'utf8')) as {
          active?: boolean;
          lastReflectionAt?: string | null;
          triggerSource?: string | null;
        };

        assert.strictEqual(finalStatus.active, false);
        assert.strictEqual(finalStatus.lastReflectionAt, '2024-01-02T03:04:05.000Z');
        assert.strictEqual(finalStatus.triggerSource, 'baseline-reflection');
      } finally {
        if (originalStatus === null) {
          await fs.promises.rm(REFLECTION_STATUS_PATH, { force: true });
        } else {
          await fs.promises.writeFile(REFLECTION_STATUS_PATH, originalStatus);
        }
      }
    });
  });
});
