import { getDb } from './client';

/**
 * The curator's bench: ranked near-misses persisted at each curation cycle so instant-refresh
 * paths (pull-to-refresh, app-open) can promote pre-approved items without a brain call.
 * "Every feed item is a curator decision" holds — the decision happened at cycle time.
 */

export interface BenchInsertInput {
  cycleId: string | null;
  source: string;
  sourceId: string;
  score: number;
  reason: string | null;
  itemJson: string;
}

export interface BenchTakenItem {
  id: number;
  source: string;
  sourceId: string;
  score: number;
  reason: string | null;
  item: Record<string, unknown>;
}

export function insertBenchItems(items: BenchInsertInput[]): number {
  const db = getDb();
  const nowMs = Date.now();
  const upsert = db.prepare(`
    INSERT INTO curation_bench (cycle_id, source, source_id, score, reason, item_json, created_at_ms, consumed_at_ms)
    VALUES (@cycle_id, @source, @source_id, @score, @reason, @item_json, @created_at_ms, NULL)
    ON CONFLICT(source, source_id) DO UPDATE SET
      cycle_id = excluded.cycle_id,
      score = excluded.score,
      reason = excluded.reason,
      item_json = excluded.item_json,
      created_at_ms = excluded.created_at_ms,
      consumed_at_ms = NULL
  `);
  let inserted = 0;
  const run = db.transaction(() => {
    for (const item of items) {
      upsert.run({
        cycle_id: item.cycleId,
        source: item.source,
        source_id: item.sourceId,
        score: item.score,
        reason: item.reason,
        item_json: item.itemJson,
        created_at_ms: nowMs,
      });
      inserted += 1;
    }
  });
  run();
  return inserted;
}

/** Best unconsumed bench items, marked consumed atomically. Stale rows (>48h) are skipped
 *  and purged — a near-miss from two days ago is no longer "fresh content". */
export function takeBenchItems(limit: number): BenchTakenItem[] {
  const db = getDb();
  const nowMs = Date.now();
  const staleBeforeMs = nowMs - 48 * 60 * 60 * 1000;
  const taken: BenchTakenItem[] = [];
  const take = db.transaction(() => {
    db.prepare('DELETE FROM curation_bench WHERE consumed_at_ms IS NULL AND created_at_ms < ?')
      .run(staleBeforeMs);
    const rows = db.prepare(`
      SELECT id, source, source_id, score, reason, item_json
      FROM curation_bench
      WHERE consumed_at_ms IS NULL
      ORDER BY score DESC, created_at_ms DESC
      LIMIT ?
    `).all(limit) as Array<{ id: number; source: string; source_id: string; score: number; reason: string | null; item_json: string }>;
    const markConsumed = db.prepare('UPDATE curation_bench SET consumed_at_ms = ? WHERE id = ?');
    for (const row of rows) {
      let item: Record<string, unknown>;
      try {
        item = JSON.parse(row.item_json) as Record<string, unknown>;
      } catch {
        markConsumed.run(nowMs, row.id); // poison row; consume so it stops blocking the queue
        continue;
      }
      markConsumed.run(nowMs, row.id);
      taken.push({ id: row.id, source: row.source, sourceId: row.source_id, score: row.score, reason: row.reason, item });
    }
  });
  take();
  return taken;
}

export function unconsumedBenchCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM curation_bench WHERE consumed_at_ms IS NULL').get() as { n: number };
  return row.n;
}
