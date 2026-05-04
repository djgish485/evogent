'use strict';

const RECENT_RESTART_STATE_TTL_MS = 30 * 60 * 1000;
const COMPLETED_RESTART_STATE_TTL_MS = 8 * 1000;

function parseTimestampMs(value) {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : null;
}

function getRecentRestartStateTtlMs(state) {
  return state?.status === 'consumed'
    ? COMPLETED_RESTART_STATE_TTL_MS
    : RECENT_RESTART_STATE_TTL_MS;
}

function isVisibleRecentRestartState(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return false;
  }

  const ttlMs = getRecentRestartStateTtlMs(state);
  const timestamps = [
    state.serviceReadyAt,
    state.restartCommandAt,
    state.applyRequestedAt,
    state.pendingAt,
    state.lastUpdatedAt,
  ];

  for (const value of timestamps) {
    const parsed = parseTimestampMs(value);
    if (parsed !== null && (nowMs - parsed) <= ttlMs) {
      return true;
    }
  }

  return false;
}

module.exports = {
  RECENT_RESTART_STATE_TTL_MS,
  COMPLETED_RESTART_STATE_TTL_MS,
  isVisibleRecentRestartState,
};
