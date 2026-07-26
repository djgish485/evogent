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
      consumed_at_ms = NULL,
      quarantined_at_ms = NULL,
      last_error = NULL
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

/** Best unconsumed bench items. Stale rows (>48h) are skipped and purged.
 *
 * Reading is deliberately not an acknowledgement: the caller must prove each
 * item reached durable feed storage before calling `ackBenchItems`. Source-id
 * deduplication makes concurrent peeks safe, while failed submits remain
 * available for a later retry instead of disappearing.
 */
export function peekBenchItems(limit: number): BenchTakenItem[] {
  const db = getDb();
  const staleBeforeMs = Date.now() - 48 * 60 * 60 * 1000;
  const taken: BenchTakenItem[] = [];
  const peek = db.transaction(() => {
    db.prepare('DELETE FROM curation_bench WHERE consumed_at_ms IS NULL AND created_at_ms < ?')
      .run(staleBeforeMs);
    const rows = db.prepare(`
      SELECT id, source, source_id, score, reason, item_json
      FROM curation_bench
      WHERE consumed_at_ms IS NULL
      ORDER BY score DESC, created_at_ms DESC
      LIMIT ?
    `).all(limit) as Array<{ id: number; source: string; source_id: string; score: number; reason: string | null; item_json: string }>;
    const discardPoison = db.prepare(`
      UPDATE curation_bench
      SET consumed_at_ms = ?, quarantined_at_ms = ?, last_error = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      let item: Record<string, unknown>;
      try {
        item = JSON.parse(row.item_json) as Record<string, unknown>;
      } catch {
        // Malformed persisted JSON can never become a valid submit on retry. A later curator
        // upsert of the same source item resets consumed_at_ms and supplies corrected bytes.
        const nowMs = Date.now();
        discardPoison.run(nowMs, nowMs, 'Malformed persisted item_json', row.id);
        continue;
      }
      taken.push({ id: row.id, source: row.source, sourceId: row.source_id, score: row.score, reason: row.reason, item });
    }
  });
  peek();
  return taken;
}

export interface BenchQuarantineInput {
  id: number;
  error: string;
}

/** Permanently rejected submit shapes leave the active bench but retain an auditable receipt. */
export function quarantineBenchItems(items: BenchQuarantineInput[]): number {
  const normalized = new Map<number, string>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0) continue;
    const error = typeof item.error === 'string'
      ? item.error.replace(/\s+/g, ' ').trim().slice(0, 500)
      : '';
    if (error) normalized.set(item.id, error);
  }
  if (normalized.size === 0) return 0;

  const db = getDb();
  const update = db.prepare(`
    UPDATE curation_bench
    SET
      consumed_at_ms = @now_ms,
      quarantined_at_ms = @now_ms,
      last_error = @last_error
    WHERE id = @id AND consumed_at_ms IS NULL
  `);
  let quarantined = 0;
  db.transaction(() => {
    const nowMs = Date.now();
    for (const [id, error] of normalized) {
      quarantined += update.run({ id, now_ms: nowMs, last_error: error }).changes;
    }
  })();
  return quarantined;
}

/** Acknowledge only bench rows whose source item is already durable in the feed. */
export function ackBenchItems(ids: number[]): number {
  const normalized = Array.from(new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)));
  if (normalized.length === 0) return 0;
  const db = getDb();
  const markConsumed = db.prepare(`
    UPDATE curation_bench
    SET consumed_at_ms = ?
    WHERE id = ? AND consumed_at_ms IS NULL
  `);
  let acknowledged = 0;
  const run = db.transaction(() => {
    const nowMs = Date.now();
    for (const id of normalized) {
      acknowledged += markConsumed.run(nowMs, id).changes;
    }
  });
  run();
  return acknowledged;
}

export function unconsumedBenchCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM curation_bench WHERE consumed_at_ms IS NULL').get() as { n: number };
  return row.n;
}
