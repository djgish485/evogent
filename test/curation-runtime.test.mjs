import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCurationFailureErrorMessage,
  isCurationStatusMissingPidStale,
  resolveCurationPersistDeadlineAt,
  resolveCurationPersistReserveMs,
  resolveTaskDeadlineAt,
} from '../lib/curation-runtime.js';

test('resolve curation deadlines reserves the final persist window', () => {
  const startedAt = '2026-03-31T12:00:00.000Z';
  const timeoutMs = 20 * 60 * 1000;

  assert.equal(resolveTaskDeadlineAt(startedAt, timeoutMs), '2026-03-31T12:20:00.000Z');
  assert.equal(resolveCurationPersistReserveMs(timeoutMs), 2 * 60 * 1000);
  assert.equal(resolveCurationPersistDeadlineAt(startedAt, timeoutMs), '2026-03-31T12:18:00.000Z');
});

test('buildCurationFailureErrorMessage records the pre-submit phase', () => {
  const message = buildCurationFailureErrorMessage(
    {
      phase: 'selection_locked',
      phaseDetail: 'Locked 10 items; preparing submit payload',
      submittedAt: null,
    },
    'Task timed out after 1200s',
  );

  assert.equal(
    message,
    'Task timed out after 1200s during curation phase "selection_locked" (Locked 10 items; preparing submit payload) before submit',
  );
});

test('buildCurationFailureErrorMessage leaves post-submit failures marked after submit', () => {
  const message = buildCurationFailureErrorMessage(
    {
      phase: 'final_audit',
      phaseDetail: 'Writing final audit notes',
      submittedAt: '2026-03-31T12:16:45.000Z',
    },
    'Task timed out after 1200s',
  );

  assert.equal(
    message,
    'Task timed out after 1200s during curation phase "final_audit" (Writing final audit notes) after submit',
  );
});

test('isCurationStatusMissingPidStale only trips after the startup grace period', () => {
  assert.equal(
    isCurationStatusMissingPidStale({
      active: true,
      pid: null,
      startedAt: '2026-03-31T12:00:00.000Z',
    }, Date.parse('2026-03-31T12:01:59.999Z')),
    false,
  );

  assert.equal(
    isCurationStatusMissingPidStale({
      active: true,
      pid: null,
      startedAt: '2026-03-31T12:00:00.000Z',
    }, Date.parse('2026-03-31T12:02:00.001Z')),
    true,
  );
});

test('isCurationStatusMissingPidStale skips the missing-pid timeout during caching', () => {
  assert.equal(
    isCurationStatusMissingPidStale({
      active: true,
      pid: null,
      phase: 'caching',
      startedAt: '2026-03-31T12:00:00.000Z',
    }, Date.parse('2026-03-31T12:30:00.000Z')),
    false,
  );
});
