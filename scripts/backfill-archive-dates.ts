import Database from 'better-sqlite3';
import { getDefaultDbPath } from '../src/lib/data-dir';

interface ArchivePreferenceRow {
  id: string;
  source_id: string;
}

const dbPath = process.env.MEDIA_AGENT_DB_PATH || getDefaultDbPath();
const db = new Database(dbPath);
const TWITTER_EPOCH = BigInt('1288834974657');
const TWITTER_SNOWFLAKE_SHIFT = BigInt(22);

function snowflakeToDate(id: string): string | null {
  try {
    const ts = Number((BigInt(id) >> TWITTER_SNOWFLAKE_SHIFT) + TWITTER_EPOCH);
    if (ts > 0 && ts < Date.now() + 86_400_000) {
      return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
    }
  } catch {}
  return null;
}

function main() {
  const rows = db.prepare(`
    SELECT id, source_id
    FROM preferences
    WHERE source IN ('twitter_archive_like', 'twitter_archive_tweet')
      AND source_id IS NOT NULL
  `).all() as ArchivePreferenceRow[];

  const updateCreatedAt = db.prepare(`
    UPDATE preferences
    SET created_at = ?
    WHERE id = ?
  `);

  let updated = 0;
  const runBackfill = db.transaction((items: ArchivePreferenceRow[]) => {
    for (const row of items) {
      const createdAt = snowflakeToDate(row.source_id);
      if (!createdAt) {
        continue;
      }

      const result = updateCreatedAt.run(createdAt, row.id);
      updated += result.changes;
    }
  });

  runBackfill(rows);

  console.log(`[backfill-archive-dates] Scanned: ${rows.length}`);
  console.log(`[backfill-archive-dates] Updated: ${updated}`);
}

try {
  main();
} finally {
  db.close();
}
