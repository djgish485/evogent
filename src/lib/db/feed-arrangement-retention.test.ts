import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { describe, test } from 'node:test';
import { compactFeedArrangementRuns } from './feed-arrangement-retention';

describe('feed arrangement retention', () => {
  test('keeps recent full snapshots and a bounded lightweight run ledger', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE feed_arrangement_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ordering_snapshot TEXT,
          thread_snapshot TEXT
        );
      `);
      const insert = db.prepare(`
        INSERT INTO feed_arrangement_runs (ordering_snapshot, thread_snapshot)
        VALUES (?, ?)
      `);
      for (let index = 1; index <= 12; index += 1) {
        insert.run(`ordering-${index}`, `threads-${index}`);
      }

      const result = compactFeedArrangementRuns(db, {
        fullSnapshotLimit: 3,
        summaryLimit: 8,
      });
      assert.deepStrictEqual(result, {
        snapshotsCompacted: 5,
        rowsDeleted: 4,
      });

      const rows = db.prepare(`
        SELECT id, ordering_snapshot, thread_snapshot
        FROM feed_arrangement_runs
        ORDER BY id
      `).all() as Array<{
        id: number;
        ordering_snapshot: string | null;
        thread_snapshot: string | null;
      }>;
      assert.deepStrictEqual(rows.map((row) => row.id), [5, 6, 7, 8, 9, 10, 11, 12]);
      assert.ok(rows.slice(0, 5).every(
        (row) => row.ordering_snapshot === null && row.thread_snapshot === null,
      ));
      assert.ok(rows.slice(5).every(
        (row) => row.ordering_snapshot !== null && row.thread_snapshot !== null,
      ));
    } finally {
      db.close();
    }
  });
});
