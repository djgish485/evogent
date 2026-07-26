import type Database from 'better-sqlite3';

export const FEED_ARRANGEMENT_FULL_SNAPSHOT_LIMIT = 100;
export const FEED_ARRANGEMENT_SUMMARY_LIMIT = 1_000;

export interface FeedArrangementRetentionResult {
  snapshotsCompacted: number;
  rowsDeleted: number;
}

function readRetentionCutoffId(
  db: Database.Database,
  keepCount: number,
): number | null {
  const row = db.prepare(`
    SELECT id
    FROM feed_arrangement_runs
    ORDER BY id DESC
    LIMIT 1 OFFSET ?
  `).get(Math.max(0, keepCount - 1)) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Preserve enough full snapshots for near-term debugging while retaining a much longer,
 * lightweight run ledger. Historical snapshots are redundant once their live arrangement has
 * been superseded; keeping every JSON copy made this single audit table dominate the phone DB.
 */
export function compactFeedArrangementRuns(
  db: Database.Database,
  options: {
    fullSnapshotLimit?: number;
    summaryLimit?: number;
  } = {},
): FeedArrangementRetentionResult {
  const fullSnapshotLimit = Math.max(
    1,
    Math.floor(options.fullSnapshotLimit ?? FEED_ARRANGEMENT_FULL_SNAPSHOT_LIMIT),
  );
  const summaryLimit = Math.max(
    fullSnapshotLimit,
    Math.floor(options.summaryLimit ?? FEED_ARRANGEMENT_SUMMARY_LIMIT),
  );

  const compactBeforeId = readRetentionCutoffId(db, fullSnapshotLimit);
  const deleteBeforeId = readRetentionCutoffId(db, summaryLimit);

  const rowsDeleted = deleteBeforeId === null
    ? 0
    : db.prepare(`
      DELETE FROM feed_arrangement_runs
      WHERE id < ?
    `).run(deleteBeforeId).changes;

  const snapshotsCompacted = compactBeforeId === null
    ? 0
    : db.prepare(`
      UPDATE feed_arrangement_runs
      SET ordering_snapshot = NULL,
          thread_snapshot = NULL
      WHERE id < ?
        AND (ordering_snapshot IS NOT NULL OR thread_snapshot IS NOT NULL)
    `).run(compactBeforeId).changes;

  return { snapshotsCompacted, rowsDeleted };
}
