const DEFAULT_CURATION_PERSIST_RESERVE_MS = 2 * 60 * 1000;
const MIN_CURATION_PERSIST_RESERVE_MS = 30 * 1000;
const MISSING_CURATION_PID_STALE_MS = 2 * 60 * 1000;
const AUTOMATED_CURATION_CYCLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const MISSING_VALIDATED_CYCLE_RECEIPT_REASON = 'missing_validated_cycle_receipt';

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

function readNonEmptyString(record, key) {
  return record && typeof record[key] === 'string' && record[key].trim()
    ? record[key].trim()
    : '';
}

/**
 * Resolve the durable curation-cycle identity carried by a task lifecycle event.
 *
 * New orchestrators expose the explicit metadata value at the top level. The
 * metadata lookup supports status relays that preserve the task metadata object.
 * The heartbeat task id fallback is deliberately narrow and only exists for an
 * in-flight task created by the preceding release.
 */
function getAutomatedCurationCycleIdFromTaskEvent(event) {
  const payload = event && typeof event === 'object' && !Array.isArray(event) ? event : null;
  if (!payload) return '';

  const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
    ? payload.metadata
    : null;
  const explicitCandidates = [
    readNonEmptyString(payload, 'curationCycleId'),
    readNonEmptyString(payload, 'curation_cycle_id'),
    readNonEmptyString(metadata, 'curationCycleId'),
    readNonEmptyString(metadata, 'curation_cycle_id'),
  ];
  const explicit = explicitCandidates.find((value) => AUTOMATED_CURATION_CYCLE_ID_PATTERN.test(value));
  if (explicit) return explicit;

  const taskId = readNonEmptyString(payload, 'taskId')
    || readNonEmptyString(payload, 'requestId')
    || readNonEmptyString(payload, 'request_id');
  return /^chat-queue-heartbeat-[A-Za-z0-9._:-]+$/.test(taskId)
    && AUTOMATED_CURATION_CYCLE_ID_PATTERN.test(taskId)
    ? taskId
    : '';
}

/**
 * A worker/task terminal event is not a curation outcome receipt. If the exact
 * cycle is still pending when the task exits, close it as a failure. A valid
 * /api/internal/curate/submit receipt has already made the row terminal and is
 * therefore left untouched.
 */
function failPendingAutomatedCurationWithoutReceipt(db, event, completedAt = new Date().toISOString()) {
  const requestId = getAutomatedCurationCycleIdFromTaskEvent(event);
  if (!requestId) return false;

  const row = db.prepare(`
    SELECT id, feed_count_before, completed_at
    FROM curation_log
    WHERE request_id = ?
    LIMIT 1
  `).get(requestId);
  if (!row || row.completed_at) return false;

  const feedCountRow = db.prepare('SELECT COUNT(*) AS count FROM feed').get();
  const currentFeedCount = Number.isFinite(feedCountRow?.count)
    ? Math.max(0, Math.floor(feedCountRow.count))
    : 0;
  const baseline = Number.isFinite(row.feed_count_before)
    ? Math.max(0, Math.floor(row.feed_count_before))
    : currentFeedCount;
  const itemsAdded = Math.max(0, currentFeedCount - baseline);

  const result = db.prepare(`
    UPDATE curation_log
    SET
      completed_at = @completed_at,
      items_added = @items_added,
      completion_status = 'failed',
      completion_reason = @completion_reason
    WHERE id = @id
      AND completed_at IS NULL
  `).run({
    id: row.id,
    completed_at: completedAt,
    items_added: itemsAdded,
    completion_reason: MISSING_VALIDATED_CYCLE_RECEIPT_REASON,
  });

  return result.changes > 0;
}

module.exports = {
  AUTOMATED_CURATION_CYCLE_ID_PATTERN,
  DEFAULT_CURATION_PERSIST_RESERVE_MS,
  MISSING_VALIDATED_CYCLE_RECEIPT_REASON,
  MIN_CURATION_PERSIST_RESERVE_MS,
  MISSING_CURATION_PID_STALE_MS,
  buildCurationFailureErrorMessage,
  failPendingAutomatedCurationWithoutReceipt,
  getAutomatedCurationCycleIdFromTaskEvent,
  isCurationStatusMissingPidStale,
  parseIsoTimestamp,
  resolveCurationPersistDeadlineAt,
  resolveCurationPersistReserveMs,
  resolveTaskDeadlineAt,
  summarizeCurationFailurePhase,
};
