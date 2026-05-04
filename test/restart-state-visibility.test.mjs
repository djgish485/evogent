import assert from 'node:assert/strict';
import test from 'node:test';

import restartStateVisibility from '../lib/restart-state-visibility.js';

const {
  COMPLETED_RESTART_STATE_TTL_MS,
  RECENT_RESTART_STATE_TTL_MS,
  isVisibleRecentRestartState,
} = restartStateVisibility;

test('consumed restart states expire quickly after service readiness', () => {
  const nowMs = Date.parse('2026-03-27T12:00:00.000Z');
  const state = {
    status: 'consumed',
    serviceReadyAt: new Date(nowMs - (COMPLETED_RESTART_STATE_TTL_MS + 1)).toISOString(),
    lastUpdatedAt: new Date(nowMs - (COMPLETED_RESTART_STATE_TTL_MS + 1)).toISOString(),
  };

  assert.equal(isVisibleRecentRestartState(state, nowMs), false);
});

test('consumed restart states remain briefly visible for reload handoff', () => {
  const nowMs = Date.parse('2026-03-27T12:00:00.000Z');
  const state = {
    status: 'consumed',
    serviceReadyAt: new Date(nowMs - Math.floor(COMPLETED_RESTART_STATE_TTL_MS / 2)).toISOString(),
    lastUpdatedAt: new Date(nowMs - Math.floor(COMPLETED_RESTART_STATE_TTL_MS / 2)).toISOString(),
  };

  assert.equal(isVisibleRecentRestartState(state, nowMs), true);
});

test('early consumed restart handoff expires before a long startup can answer', () => {
  const restartCommandMs = Date.parse('2026-04-28T05:43:28.000Z');
  const prematureServiceReadyMs = Date.parse('2026-04-28T05:43:29.998Z');
  const actualReadyMs = Date.parse('2026-04-28T05:45:07.000Z');
  const state = {
    status: 'consumed',
    restartCommandAt: new Date(restartCommandMs).toISOString(),
    serviceReadyAt: new Date(prematureServiceReadyMs).toISOString(),
    lastUpdatedAt: new Date(prematureServiceReadyMs).toISOString(),
  };

  assert.equal(isVisibleRecentRestartState(state, actualReadyMs), false);
});

test('consumed restart handoff stays visible when serviceReadyAt uses actual readiness', () => {
  const actualReadyMs = Date.parse('2026-04-28T05:45:07.000Z');
  const state = {
    status: 'consumed',
    restartCommandAt: '2026-04-28T05:43:28.000Z',
    serviceReadyAt: new Date(actualReadyMs).toISOString(),
    lastUpdatedAt: new Date(actualReadyMs).toISOString(),
  };

  assert.equal(isVisibleRecentRestartState(state, actualReadyMs + 1_000), true);
});

test('failed restart states still use the broader recent-state ttl', () => {
  const nowMs = Date.parse('2026-03-27T12:00:00.000Z');
  const visibleState = {
    status: 'failed',
    lastUpdatedAt: new Date(nowMs - (RECENT_RESTART_STATE_TTL_MS - 1_000)).toISOString(),
  };
  const expiredState = {
    status: 'failed',
    lastUpdatedAt: new Date(nowMs - (RECENT_RESTART_STATE_TTL_MS + 1_000)).toISOString(),
  };

  assert.equal(isVisibleRecentRestartState(visibleState, nowMs), true);
  assert.equal(isVisibleRecentRestartState(expiredState, nowMs), false);
});
