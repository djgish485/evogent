import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { OrchestratorStatusResponse } from '@/lib/orchestrator';
import {
  getActiveCurationPipelinePhase,
  getActiveCurationTaskId,
  hasActiveCurationTask,
  shouldAutoCompleteStaleCurationTask,
  STALE_CURATION_COMPLETION_MS,
} from './curation-status';

function createStatus(overrides: Partial<OrchestratorStatusResponse> = {}): OrchestratorStatusResponse {
  return {
    sessionName: 'test-session',
    queueDepth: 0,
    isProcessing: false,
    activeCurationAgent: null,
    activeReflectionAgent: null,
    curationStatus: null,
    brain: {
      sessionExists: true,
      working: false,
      paneTail: null,
      checkedAt: '2026-03-10T00:00:00.000Z',
    },
    currentTask: null,
    queued: [],
    history: [],
    updatedAt: '2026-03-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('curation status helpers', () => {
  test('detects active curation from activeCurationAgent', () => {
    const status = createStatus({ activeCurationAgent: 'curation-agent-1' });
    assert.strictEqual(hasActiveCurationTask(status), true);
    assert.strictEqual(getActiveCurationPipelinePhase(status), 'curating');
  });

  test('detects active curation from heartbeat current task', () => {
    const status = createStatus({
      currentTask: {
        id: 'curation-task-1',
        source: 'heartbeat',
        priority: 'heartbeat',
        state: 'processing',
        enqueuedAt: '2026-03-10T00:00:00.000Z',
        startedAt: '2026-03-10T00:00:05.000Z',
        sentAt: '2026-03-10T00:00:06.000Z',
        logFile: '/tmp/curation-task-1.jsonl',
        messagePreview: 'Heartbeat: curation cycle',
      },
    });

    assert.strictEqual(hasActiveCurationTask(status), true);
    assert.strictEqual(getActiveCurationPipelinePhase(status), 'curating');
  });

  test('detects active curation from curate-latest current task', () => {
    const status = createStatus({
      currentTask: {
        id: 'curate-latest-task-1',
        source: 'chat_background_routing',
        priority: 'user_ping',
        state: 'processing',
        enqueuedAt: '2026-03-10T00:00:00.000Z',
        startedAt: '2026-03-10T00:00:05.000Z',
        sentAt: '2026-03-10T00:00:06.000Z',
        logFile: '/tmp/curate-latest-task-1.jsonl',
        messagePreview: '/curate-latest policy',
      },
    });

    assert.strictEqual(hasActiveCurationTask(status), true);
    assert.strictEqual(getActiveCurationPipelinePhase(status), 'curating');
    assert.strictEqual(getActiveCurationTaskId(status), 'curate-latest-task-1');
  });

  test('ignores unrelated current tasks', () => {
    const status = createStatus({
      currentTask: {
        id: 'chat-task-1',
        source: 'user_chat',
        priority: 'user_chat',
        state: 'processing',
        enqueuedAt: '2026-03-10T00:00:00.000Z',
        startedAt: '2026-03-10T00:00:05.000Z',
        sentAt: '2026-03-10T00:00:06.000Z',
        logFile: null,
        messagePreview: 'Summarize this article',
      },
    });

    assert.strictEqual(hasActiveCurationTask(status), false);
    assert.strictEqual(getActiveCurationPipelinePhase(status), null);
  });

  test('uses durable curation status for caching and task id', () => {
    const status = createStatus({
      curationStatus: {
        active: true,
        requestId: 'curate-task-1',
        phase: 'caching',
      },
    });

    assert.strictEqual(hasActiveCurationTask(status), true);
    assert.strictEqual(getActiveCurationPipelinePhase(status), 'caching');
    assert.strictEqual(getActiveCurationTaskId(status), 'curate-task-1');
  });

  test('maps enrichment phase separately from curating', () => {
    const status = createStatus({
      curationStatus: {
        active: true,
        requestId: 'enrich-task-1',
        phase: 'enriching',
      },
    });

    assert.strictEqual(getActiveCurationPipelinePhase(status), 'enriching');
    assert.strictEqual(getActiveCurationTaskId(status), 'enrich-task-1');
  });

  test('auto-completes stale curation tasks once no active curation remains', () => {
    const startedAt = '2026-03-10T00:00:00.000Z';
    const nowMs = Date.parse(startedAt) + STALE_CURATION_COMPLETION_MS + 1_000;

    assert.strictEqual(
      shouldAutoCompleteStaleCurationTask(startedAt, createStatus(), nowMs),
      true,
    );
  });

  test('keeps curation tasks running before the stale timeout', () => {
    const startedAt = '2026-03-10T00:00:00.000Z';
    const nowMs = Date.parse(startedAt) + STALE_CURATION_COMPLETION_MS - 1_000;

    assert.strictEqual(
      shouldAutoCompleteStaleCurationTask(startedAt, createStatus(), nowMs),
      false,
    );
  });

  test('does not auto-complete while curation is still active', () => {
    const startedAt = '2026-03-10T00:00:00.000Z';
    const nowMs = Date.parse(startedAt) + STALE_CURATION_COMPLETION_MS + 5_000;

    assert.strictEqual(
      shouldAutoCompleteStaleCurationTask(
        startedAt,
        createStatus({ activeCurationAgent: 'curation-agent-1' }),
        nowMs,
      ),
      false,
    );
  });
});
