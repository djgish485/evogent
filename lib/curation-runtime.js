const DEFAULT_CURATION_PERSIST_RESERVE_MS = 2 * 60 * 1000;
const MIN_CURATION_PERSIST_RESERVE_MS = 30 * 1000;
const MISSING_CURATION_PID_STALE_MS = 2 * 60 * 1000;

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsedMs = Date.parse(value.trim());
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

function resolveTaskDeadlineAt(startedAt, timeoutMs) {
  const startedAtMs = parseIsoTimestamp(startedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }

  return new Date(startedAtMs + Math.floor(timeoutMs)).toISOString();
}

function resolveCurationPersistReserveMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_CURATION_PERSIST_RESERVE_MS;
  }

  return Math.max(
    MIN_CURATION_PERSIST_RESERVE_MS,
    Math.min(DEFAULT_CURATION_PERSIST_RESERVE_MS, Math.floor(timeoutMs / 3)),
  );
}

function resolveCurationPersistDeadlineAt(startedAt, timeoutMs) {
  const deadlineAt = resolveTaskDeadlineAt(startedAt, timeoutMs);
  const deadlineAtMs = parseIsoTimestamp(deadlineAt);
  if (!Number.isFinite(deadlineAtMs)) {
    return null;
  }

  return new Date(deadlineAtMs - resolveCurationPersistReserveMs(timeoutMs)).toISOString();
}

function isCurationStatusMissingPidStale(status, now = Date.now()) {
  if (!status || typeof status !== 'object' || status.active !== true || status.pid) {
    return false;
  }

  if (status.phase === 'caching') {
    return false;
  }

  const startedAtMs = parseIsoTimestamp(status.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return false;
  }

  return (now - startedAtMs) > MISSING_CURATION_PID_STALE_MS;
}

function summarizeCurationFailurePhase(status) {
  if (!status || typeof status !== 'object') {
    return null;
  }

  const phase = typeof status.phase === 'string' && status.phase.trim()
    ? status.phase.trim()
    : null;
  const phaseDetail = typeof status.phaseDetail === 'string' && status.phaseDetail.trim()
    ? status.phaseDetail.trim()
    : null;
  const submittedAt = typeof status.submittedAt === 'string' && status.submittedAt.trim()
    ? status.submittedAt.trim()
    : null;

  if (!phase && !phaseDetail && !submittedAt) {
    return null;
  }

  return {
    phase,
    phaseDetail,
    submittedAt,
    beforeSubmit: !submittedAt,
  };
}

function buildCurationFailureErrorMessage(status, message, options = {}) {
  const baseMessage = typeof message === 'string' && message.trim()
    ? message.trim()
    : Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? `Task timed out after ${Math.round(options.timeoutMs / 1000)}s`
      : 'Curation task failed';

  if (/\bduring curation phase\b/.test(baseMessage) && /\b(before|after) submit\b/.test(baseMessage)) {
    return baseMessage;
  }

  const summary = summarizeCurationFailurePhase(status);

  if (!summary) {
    return baseMessage;
  }

  const parts = [baseMessage];
  if (summary.phase) {
    parts.push(`during curation phase "${summary.phase}"`);
  }
  if (summary.phaseDetail) {
    parts.push(`(${summary.phaseDetail})`);
  }
  parts.push(summary.beforeSubmit ? 'before submit' : 'after submit');

  return parts.join(' ');
}

module.exports = {
  DEFAULT_CURATION_PERSIST_RESERVE_MS,
  MIN_CURATION_PERSIST_RESERVE_MS,
  MISSING_CURATION_PID_STALE_MS,
  buildCurationFailureErrorMessage,
  isCurationStatusMissingPidStale,
  parseIsoTimestamp,
  resolveCurationPersistDeadlineAt,
  resolveCurationPersistReserveMs,
  resolveTaskDeadlineAt,
  summarizeCurationFailurePhase,
};
