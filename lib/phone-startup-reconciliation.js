const PHONE_RESTART_CURATION_REASON =
  'Phone runtime restarted without a live in-process curation owner';

function hasTable(db, tableName) {
  const row = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
    LIMIT 1
  `).get(tableName);
  return Boolean(row);
}

function normalizeCompletedAt(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('completedAt must be a valid date');
  }
  return date.toISOString();
}

/**
 * A phone server owns its curation agent in-process. After that server exits there is no
 * recoverable owner for an unfinished curation_log row, so leaving it pending would suppress
 * every later adaptive cycle. Preserve the row as evidence, but give it an explicit terminal
 * state instead of guessing that the curation succeeded or produced an empty result.
 */
function reconcileOrphanedPhoneCurations(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A SQLite database handle is required');
  }
  if (!hasTable(db, 'curation_log')) {
    return 0;
  }

  const result = db.prepare(`
    UPDATE curation_log
    SET completed_at = @completed_at,
        completion_status = 'aborted',
        completion_reason = @completion_reason
    WHERE completed_at IS NULL
  `).run({
    completed_at: normalizeCompletedAt(options.completedAt),
    completion_reason: PHONE_RESTART_CURATION_REASON,
  });

  return Number(result?.changes || 0);
}

module.exports = {
  PHONE_RESTART_CURATION_REASON,
  reconcileOrphanedPhoneCurations,
};
