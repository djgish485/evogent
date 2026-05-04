import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db/client';
import { addPreferenceVector } from '@/lib/vectors/store';

export interface PreferenceInsert {
  feedItemId?: string;
  signalType: 'liked' | 'disliked' | 'hidden' | 'explicit';
  source: string;
  text: string;
  reason?: string;
  authorUsername?: string;
  weight?: number;
  sourceId?: string;
  createdAt?: string;
}

export interface PreferenceRow {
  id: string;
  feedItemId: string | null;
  signalType: string;
  source: string;
  text: string;
  reason: string | null;
  authorUsername: string | null;
  weight: number;
  sourceId: string | null;
  createdAt: string;
}

export interface PreferenceListRow extends PreferenceRow {
  feedTitle: string | null;
  feedText: string | null;
}

interface PreferenceDbRow {
  id: string;
  feed_item_id: string | null;
  signal_type: string;
  source: string;
  text: string;
  reason: string | null;
  author_username: string | null;
  weight: number;
  source_id: string | null;
  created_at: string;
}

interface PreferenceListDbRow extends PreferenceDbRow {
  feed_title: string | null;
  feed_text: string | null;
}

function toPreferenceRow(row: PreferenceDbRow): PreferenceRow {
  return {
    id: row.id,
    feedItemId: row.feed_item_id,
    signalType: row.signal_type,
    source: row.source,
    text: row.text,
    reason: row.reason,
    authorUsername: row.author_username,
    weight: row.weight,
    sourceId: row.source_id,
    createdAt: row.created_at,
  };
}

function toPreferenceListRow(row: PreferenceListDbRow): PreferenceListRow {
  return {
    ...toPreferenceRow(row),
    feedTitle: row.feed_title,
    feedText: row.feed_text,
  };
}

function normalizePreferenceFilterType(signalType: string): 'all' | 'liked' | 'disliked' | 'hidden' | 'raw' {
  const normalized = signalType.trim().toLowerCase();
  if (!normalized || normalized === 'all') return 'all';
  if (normalized === 'liked' || normalized === 'positive') return 'liked';
  if (normalized === 'disliked' || normalized === 'negative') return 'disliked';
  if (normalized === 'hidden') return 'hidden';
  return 'raw';
}

function appendSignalTypeFilter(sql: string, params: Array<string | number>, signalType: string): string {
  const filterType = normalizePreferenceFilterType(signalType);
  if (filterType === 'all') {
    return sql;
  }

  if (filterType === 'liked') {
    return `${sql}
      AND p.signal_type IN ('liked', 'bookmarked', 'explicit')
    `;
  }

  if (filterType === 'disliked') {
    return `${sql}
      AND p.signal_type = 'disliked'
    `;
  }

  if (filterType === 'hidden') {
    return `${sql}
      AND p.signal_type = 'hidden'
    `;
  }

  params.push(signalType.trim().toLowerCase());
  return `${sql}
      AND p.signal_type = ?
    `;
}

export function insertPreference(input: PreferenceInsert): string {
  const db = getDb();
  const id = randomUUID();
  const weight = input.weight ?? 1.0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO preferences (
      id,
      feed_item_id,
      signal_type,
      source,
      text,
      reason,
      author_username,
      weight,
      source_id
    ) VALUES (
      @id,
      @feed_item_id,
      @signal_type,
      @source,
      @text,
      @reason,
      @author_username,
      @weight,
      @source_id
    )
  `);

  const result = insert.run({
    id,
    feed_item_id: input.feedItemId ?? null,
    signal_type: input.signalType,
    source: input.source,
    text: input.text,
    reason: input.reason ?? null,
    author_username: input.authorUsername ?? null,
    weight,
    source_id: input.sourceId ?? null,
  });

  let insertedId: string = id;
  if (result.changes === 0 && input.sourceId) {
    const existing = db.prepare(`
      SELECT id
      FROM preferences
      WHERE source_id = ? AND signal_type = ?
      LIMIT 1
    `).get(input.sourceId, input.signalType) as { id: string } | undefined;

    if (existing?.id) {
      insertedId = existing.id;
    }
  }

  void addPreferenceVector(
    insertedId,
    input.text,
    input.signalType,
    input.source,
    weight,
    input.authorUsername ?? null,
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[preferences] Failed to add vector for ${insertedId}: ${message}`);
  });

  return insertedId;
}

export function bulkInsertPreferences(inputs: PreferenceInsert[]): number {
  if (inputs.length === 0) return 0;

  const db = getDb();
  const batchSize = 64;
  let insertedCount = 0;

  for (let index = 0; index < inputs.length; index += batchSize) {
    const batch = inputs.slice(index, index + batchSize);
    const vectorQueue: Array<{
      id: string;
      text: string;
      signalType: string;
      source: string;
      weight: number;
      authorUsername: string | null;
    }> = [];

    const runBatch = db.transaction((items: PreferenceInsert[]) => {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO preferences (
          id,
          feed_item_id,
          signal_type,
          source,
          text,
          reason,
          author_username,
          weight,
          source_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
      `);

      for (const item of items) {
        const prefId = randomUUID();
        const weight = item.weight ?? 1.0;
        const result = insert.run(
          prefId,
          item.feedItemId ?? null,
          item.signalType,
          item.source,
          item.text,
          item.reason ?? null,
          item.authorUsername ?? null,
          weight,
          item.sourceId ?? null,
          item.createdAt ?? null,
        );

        if (result.changes > 0) {
          insertedCount += 1;
          vectorQueue.push({
            id: prefId,
            text: item.text,
            signalType: item.signalType,
            source: item.source,
            weight,
            authorUsername: item.authorUsername ?? null,
          });
        }
      }
    });

    runBatch(batch);

    for (const item of vectorQueue) {
      void addPreferenceVector(
        item.id,
        item.text,
        item.signalType,
        item.source,
        item.weight,
        item.authorUsername,
      ).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[preferences] Failed to add vector for ${item.id}: ${message}`);
      });
    }
  }

  return insertedCount;
}

export function getPreferences(limit = 500): PreferenceRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM preferences
    ORDER BY weight DESC, created_at DESC
    LIMIT ?
  `).all(limit) as PreferenceDbRow[];

  return rows.map(toPreferenceRow);
}

export function getPreferencesBySignalType(signalType: string, limit = 500): PreferenceRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM preferences
    WHERE signal_type = ?
    ORDER BY weight DESC, created_at DESC
    LIMIT ?
  `).all(signalType, limit) as PreferenceDbRow[];

  return rows.map(toPreferenceRow);
}

export function getPositivePreferences(limit = 100): PreferenceRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM preferences
    WHERE signal_type IN ('liked', 'bookmarked', 'explicit')
    ORDER BY weight DESC, created_at DESC
    LIMIT ?
  `).all(limit) as PreferenceDbRow[];

  return rows.map(toPreferenceRow);
}

export function getNegativePreferences(limit = 50): PreferenceRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM preferences
    WHERE signal_type IN ('disliked', 'hidden')
    ORDER BY weight DESC, created_at DESC
    LIMIT ?
  `).all(limit) as PreferenceDbRow[];

  return rows.map(toPreferenceRow);
}

export interface PreferencesPageQuery {
  signalType?: string | null;
  limit?: number;
  offset?: number;
}

export interface PreferencesPageResult {
  items: PreferenceListRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function getPreferencesPage(query: PreferencesPageQuery = {}): PreferencesPageResult {
  const db = getDb();
  const signalType = typeof query.signalType === 'string' ? query.signalType : '';
  const limit = typeof query.limit === 'number' && Number.isFinite(query.limit)
    ? Math.max(1, Math.min(500, Math.floor(query.limit)))
    : 50;
  const offset = typeof query.offset === 'number' && Number.isFinite(query.offset)
    ? Math.max(0, Math.floor(query.offset))
    : 0;
  const params: Array<string | number> = [];

  let whereSql = `
    WHERE 1 = 1
  `;
  whereSql = appendSignalTypeFilter(whereSql, params, signalType);

  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM preferences p
    ${whereSql}
  `).get(...params) as { count: number };

  const rows = db.prepare(`
    SELECT
      p.*,
      f.title AS feed_title,
      f.text AS feed_text
    FROM preferences p
    LEFT JOIN feed f ON f.id = p.feed_item_id
    ${whereSql}
    ORDER BY datetime(p.created_at) DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as PreferenceListDbRow[];

  const items = rows.map(toPreferenceListRow);
  return {
    items,
    total: countRow.count,
    limit,
    offset,
    hasMore: offset + items.length < countRow.count,
  };
}

export interface RecentPreferenceQuery {
  limit?: number;
  signalType?: string | null;
  since?: string | null;
  onlyWithReason?: boolean;
}

export function getRecentPreferences(query: RecentPreferenceQuery = {}): PreferenceRow[] {
  const db = getDb();
  const limit = typeof query.limit === 'number' && Number.isFinite(query.limit)
    ? Math.max(1, Math.min(2000, Math.floor(query.limit)))
    : 250;
  const signalType = typeof query.signalType === 'string' ? query.signalType.trim().toLowerCase() : '';
  const since = typeof query.since === 'string' && query.since.trim() ? query.since.trim() : '';
  const onlyWithReason = query.onlyWithReason === true;
  const params: Array<string | number> = [];

  let sql = `
    SELECT *
    FROM preferences
    WHERE 1 = 1
  `;

  if (since) {
    sql += `
      AND datetime(created_at) >= datetime(?)
    `;
    params.push(since);
  }

  if (onlyWithReason) {
    sql += `
      AND reason IS NOT NULL
      AND trim(reason) <> ''
    `;
  }

  if (signalType) {
    if (signalType === 'liked' || signalType === 'positive') {
      sql += `
      AND signal_type IN ('liked', 'bookmarked', 'explicit')
    `;
    } else if (signalType === 'disliked' || signalType === 'negative') {
      sql += `
      AND signal_type IN ('disliked', 'hidden')
    `;
    } else {
      sql += `
      AND signal_type = ?
    `;
      params.push(signalType);
    }
  }

  sql += `
    ORDER BY
      CASE WHEN reason IS NOT NULL AND trim(reason) <> '' THEN 1 ELSE 0 END DESC,
      datetime(created_at) DESC,
      weight DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as PreferenceDbRow[];
  return rows.map(toPreferenceRow);
}

export function getPreferenceStats(): {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
} {
  const db = getDb();

  const total = db.prepare(`SELECT COUNT(*) AS count FROM preferences`).get() as { count: number };

  const byTypeRows = db.prepare(`
    SELECT signal_type, COUNT(*) AS count
    FROM preferences
    GROUP BY signal_type
  `).all() as Array<{ signal_type: string; count: number }>;

  const bySourceRows = db.prepare(`
    SELECT source, COUNT(*) AS count
    FROM preferences
    GROUP BY source
  `).all() as Array<{ source: string; count: number }>;

  return {
    total: total.count,
    byType: Object.fromEntries(byTypeRows.map((row) => [row.signal_type, row.count])),
    bySource: Object.fromEntries(bySourceRows.map((row) => [row.source, row.count])),
  };
}

export function deletePreferenceByFeedItem(feedItemId: string, signalType: string): boolean {
  const db = getDb();

  const ids = db.prepare(`
    SELECT id
    FROM preferences
    WHERE feed_item_id = ? AND signal_type = ?
  `).all(feedItemId, signalType) as Array<{ id: string }>;

  if (ids.length === 0) {
    return false;
  }

  const remove = db.transaction((prefIds: string[]) => {
    const hasPrefVec = !!db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'pref_vec'
      LIMIT 1
    `).get();

    const deletePreference = db.prepare(`
      DELETE FROM preferences
      WHERE feed_item_id = ? AND signal_type = ?
    `);

    const deleteVectorMeta = db.prepare(`DELETE FROM preference_vectors WHERE id = ?`);
    const deleteVector = hasPrefVec ? db.prepare(`DELETE FROM pref_vec WHERE id = ?`) : null;

    const deleted = deletePreference.run(feedItemId, signalType).changes > 0;

    for (const prefId of prefIds) {
      deleteVectorMeta.run(prefId);
      if (deleteVector) {
        deleteVector.run(prefId);
      }
    }

    return deleted;
  });

  return remove(ids.map((row) => row.id));
}

function getInteractionActionsForSignalType(signalType: string): string[] {
  const normalized = signalType.trim().toLowerCase();
  if (normalized === 'liked' || normalized === 'bookmarked' || normalized === 'explicit') {
    return ['like'];
  }
  if (normalized === 'disliked') {
    return ['dislike'];
  }
  if (normalized === 'hidden') {
    return ['hide', 'hidden'];
  }
  return [];
}

export function deletePreferenceById(preferenceId: string): PreferenceRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM preferences
    WHERE id = ?
    LIMIT 1
  `).get(preferenceId) as PreferenceDbRow | undefined;

  if (!row) {
    return null;
  }

  const hasPrefVec = !!db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'pref_vec'
    LIMIT 1
  `).get();

  const remove = db.transaction(() => {
    db.prepare(`
      DELETE FROM preferences
      WHERE id = ?
    `).run(preferenceId);

    db.prepare(`DELETE FROM preference_vectors WHERE id = ?`).run(preferenceId);
    if (hasPrefVec) {
      db.prepare(`DELETE FROM pref_vec WHERE id = ?`).run(preferenceId);
    }

    if (row.feed_item_id) {
      const actions = getInteractionActionsForSignalType(row.signal_type);
      if (actions.length > 0) {
        const placeholders = actions.map(() => '?').join(', ');
        db.prepare(`
          DELETE FROM interactions
          WHERE feed_item_id = ?
            AND action IN (${placeholders})
        `).run(row.feed_item_id, ...actions);
      }
    }
  });

  remove();
  return toPreferenceRow(row);
}

export function updatePreferenceReason(preferenceId: string, reason: string | null): PreferenceRow | null {
  const db = getDb();
  const normalizedReason = typeof reason === 'string' ? reason.trim() : null;
  const nextReason = normalizedReason && normalizedReason.length > 0 ? normalizedReason : null;

  const result = db.prepare(`
    UPDATE preferences
    SET reason = ?
    WHERE id = ?
  `).run(nextReason, preferenceId);

  if (result.changes === 0) {
    return null;
  }

  const row = db.prepare(`
    SELECT *
    FROM preferences
    WHERE id = ?
    LIMIT 1
  `).get(preferenceId) as PreferenceDbRow | undefined;

  if (!row) {
    return null;
  }

  return toPreferenceRow(row);
}

export function updatePreferenceReasonByFeedItem(
  feedItemId: string,
  signalType: string,
  reason: string,
): boolean {
  const db = getDb();
  const normalizedReason = reason.trim();

  if (!normalizedReason) {
    return false;
  }

  const result = db.prepare(`
    UPDATE preferences
    SET reason = @reason
    WHERE feed_item_id = @feed_item_id
      AND signal_type = @signal_type
  `).run({
    feed_item_id: feedItemId,
    signal_type: signalType,
    reason: normalizedReason,
  });

  return result.changes > 0;
}
