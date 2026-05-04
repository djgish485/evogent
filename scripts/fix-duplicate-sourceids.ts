import Database from 'better-sqlite3';
import path from 'node:path';
import { getDefaultDbPath } from '../src/lib/data-dir';

interface FeedDuplicateRow {
  id: string;
  source_id: string;
  created_at: string;
  child_count: number;
}

interface Summary {
  duplicateGroups: number;
  duplicateRowsDeleted: number;
  parentRefsMoved: number;
  interactionRefsMoved: number;
  preferenceRefsMoved: number;
  sourceIdsNormalized: number;
}

function normalizeTweetSourceId(sourceId: string): string {
  const trimmed = sourceId.trim();
  const match = trimmed.match(/^tweet-(\d+)$/i);
  return match?.[1] ?? trimmed;
}

function isTweetSourceIdCandidate(sourceId: string | null | undefined): sourceId is string {
  return typeof sourceId === 'string' && (/^\d+$/.test(sourceId) || /^tweet-\d+$/i.test(sourceId));
}

function getDbPath(args: string[]): string {
  const explicitPath = args.find((arg) => !arg.startsWith('--'));
  if (explicitPath) return path.resolve(explicitPath);
  return process.env.MEDIA_AGENT_DB_PATH || getDefaultDbPath();
}

function chooseSurvivor(rows: FeedDuplicateRow[], canonicalSourceId: string): FeedDuplicateRow {
  return [...rows].sort((left, right) => {
    const childCountDiff = right.child_count - left.child_count;
    if (childCountDiff !== 0) return childCountDiff;

    const bareScoreLeft = left.source_id === canonicalSourceId ? 1 : 0;
    const bareScoreRight = right.source_id === canonicalSourceId ? 1 : 0;
    const bareScoreDiff = bareScoreRight - bareScoreLeft;
    if (bareScoreDiff !== 0) return bareScoreDiff;

    const createdAtDiff = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    if (createdAtDiff !== 0) return createdAtDiff;

    return left.id.localeCompare(right.id);
  })[0];
}

function findDuplicateGroups(db: Database.Database): Map<string, FeedDuplicateRow[]> {
  const rows = db.prepare(`
    SELECT
      f.id,
      f.source_id,
      f.created_at,
      (
        SELECT COUNT(*)
        FROM feed AS child
        WHERE child.parent_id = f.id
      ) AS child_count
    FROM feed AS f
    WHERE f.type = 'tweet'
      AND f.source_id IS NOT NULL
  `).all() as FeedDuplicateRow[];

  const groups = new Map<string, FeedDuplicateRow[]>();
  for (const row of rows) {
    if (!isTweetSourceIdCandidate(row.source_id)) continue;
    const canonicalSourceId = normalizeTweetSourceId(row.source_id);
    const group = groups.get(canonicalSourceId) ?? [];
    group.push(row);
    groups.set(canonicalSourceId, group);
  }

  for (const [canonicalSourceId, group] of groups.entries()) {
    if (group.length < 2) {
      groups.delete(canonicalSourceId);
    }
  }

  return groups;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbPath = getDbPath(args);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const feedTableExists = db.prepare(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
    AND name = 'feed'
`).get() as { name: string } | undefined;

if (!feedTableExists) {
  console.error(`[fix-duplicate-sourceids] Feed table not found in ${dbPath}.`);
  db.close();
  process.exit(1);
}

const summary: Summary = {
  duplicateGroups: 0,
  duplicateRowsDeleted: 0,
  parentRefsMoved: 0,
  interactionRefsMoved: 0,
  preferenceRefsMoved: 0,
  sourceIdsNormalized: 0,
};

const duplicateGroups = findDuplicateGroups(db);
summary.duplicateGroups = duplicateGroups.size;

const runCleanup = db.transaction(() => {
  const moveChildrenStmt = db.prepare(`
    UPDATE feed
    SET parent_id = ?
    WHERE parent_id = ?
  `);
  const deleteDuplicateInteractionsStmt = db.prepare(`
    DELETE FROM interactions
    WHERE feed_item_id = ?
      AND action IN (
        SELECT action
        FROM interactions
        WHERE feed_item_id = ?
      )
  `);
  const moveInteractionsStmt = db.prepare(`
    UPDATE interactions
    SET feed_item_id = ?
    WHERE feed_item_id = ?
  `);
  const movePreferencesStmt = db.prepare(`
    UPDATE preferences
    SET feed_item_id = ?
    WHERE feed_item_id = ?
  `);
  const deleteFeedRowStmt = db.prepare(`
    DELETE FROM feed
    WHERE id = ?
  `);
  const updateSourceIdStmt = db.prepare(`
    UPDATE feed
    SET source_id = ?
    WHERE id = ?
  `);
  const selectPrefixedRowsStmt = db.prepare(`
    SELECT id, source_id
    FROM feed
    WHERE type = 'tweet'
      AND source_id IS NOT NULL
  `);

  for (const [canonicalSourceId, group] of duplicateGroups.entries()) {
    const survivor = chooseSurvivor(group, canonicalSourceId);
    const duplicates = group.filter((row) => row.id !== survivor.id);

    for (const duplicate of duplicates) {
      summary.parentRefsMoved += moveChildrenStmt.run(survivor.id, duplicate.id).changes;
      deleteDuplicateInteractionsStmt.run(duplicate.id, survivor.id);
      summary.interactionRefsMoved += moveInteractionsStmt.run(survivor.id, duplicate.id).changes;
      summary.preferenceRefsMoved += movePreferencesStmt.run(survivor.id, duplicate.id).changes;
      summary.duplicateRowsDeleted += deleteFeedRowStmt.run(duplicate.id).changes;
    }

    if (survivor.source_id !== canonicalSourceId) {
      summary.sourceIdsNormalized += updateSourceIdStmt.run(canonicalSourceId, survivor.id).changes;
    }
  }

  const remainingRows = selectPrefixedRowsStmt.all() as Array<{ id: string; source_id: string }>;
  for (const row of remainingRows) {
    if (!/^tweet-\d+$/i.test(row.source_id)) continue;
    const canonicalSourceId = normalizeTweetSourceId(row.source_id);
    summary.sourceIdsNormalized += updateSourceIdStmt.run(canonicalSourceId, row.id).changes;
  }
});

if (dryRun) {
  console.log(`[fix-duplicate-sourceids] Dry run: ${summary.duplicateGroups} duplicate tweet sourceId group(s) found in ${dbPath}.`);
} else {
  runCleanup();
}

const remainingDuplicateGroups = findDuplicateGroups(db);
const remainingPrefixedCount = db.prepare(`
  SELECT COUNT(*) AS count
  FROM feed
  WHERE type = 'tweet'
    AND source_id IS NOT NULL
`).get() as { count: number };

const prefixedRows = db.prepare(`
  SELECT source_id
  FROM feed
  WHERE type = 'tweet'
    AND source_id IS NOT NULL
`).all() as Array<{ source_id: string }>;

const remainingPrefixedSourceIds = prefixedRows.filter((row) => /^tweet-\d+$/i.test(row.source_id)).length;

console.log(`[fix-duplicate-sourceids] Database: ${dbPath}`);
console.log(`[fix-duplicate-sourceids] Duplicate groups found: ${summary.duplicateGroups}`);
if (!dryRun) {
  console.log(`[fix-duplicate-sourceids] Duplicate rows deleted: ${summary.duplicateRowsDeleted}`);
  console.log(`[fix-duplicate-sourceids] Child parent refs moved: ${summary.parentRefsMoved}`);
  console.log(`[fix-duplicate-sourceids] Interaction refs moved: ${summary.interactionRefsMoved}`);
  console.log(`[fix-duplicate-sourceids] Preference refs moved: ${summary.preferenceRefsMoved}`);
  console.log(`[fix-duplicate-sourceids] Source IDs normalized: ${summary.sourceIdsNormalized}`);
}
console.log(`[fix-duplicate-sourceids] Remaining duplicate groups: ${remainingDuplicateGroups.size}`);
console.log(`[fix-duplicate-sourceids] Remaining prefixed tweet source IDs: ${remainingPrefixedSourceIds}`);
console.log(`[fix-duplicate-sourceids] Total tweet rows scanned: ${remainingPrefixedCount.count}`);

db.close();
