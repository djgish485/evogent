import type Database from 'better-sqlite3';

export interface ValidationFixtureCleanupInput {
  ids?: string[];
  sourceIds?: string[];
  originSessionIds?: string[];
}

export interface ValidationFixtureCleanupResult {
  matchedIds: string[];
  deletedFeedRows: number;
  deletedInteractionRows: number;
  deletedPreferenceRows: number;
  deletedCodeFixTaskRows: number;
}

function normalizeValues(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}

function buildNamedPlaceholders(
  values: string[],
  prefix: string,
  params: Record<string, string>,
): string {
  return values.map((value, index) => {
    const key = `${prefix}${index}`;
    params[key] = value;
    return `@${key}`;
  }).join(', ');
}

function collectFixtureIdsByWhereClause(
  db: Database.Database,
  whereClause: string,
  params: Record<string, string>,
): string[] {
  const rows = db.prepare(`
    WITH RECURSIVE fixture_roots(id) AS (
      SELECT DISTINCT id
      FROM feed
      WHERE ${whereClause}
    ),
    fixture_ids(id) AS (
      SELECT id
      FROM fixture_roots
      UNION
      SELECT child.id
      FROM feed AS child
      INNER JOIN fixture_ids AS fixtures
        ON child.parent_id = fixtures.id
    )
    SELECT DISTINCT id
    FROM fixture_ids
    WHERE id IS NOT NULL
  `).all(params) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

function deleteFixtureIds(
  db: Database.Database,
  fixtureIds: string[],
): ValidationFixtureCleanupResult {
  const normalizedIds = normalizeValues(fixtureIds);
  if (normalizedIds.length === 0) {
    return {
      matchedIds: [],
      deletedFeedRows: 0,
      deletedInteractionRows: 0,
      deletedPreferenceRows: 0,
      deletedCodeFixTaskRows: 0,
    };
  }

  const placeholders = normalizedIds.map(() => '?').join(', ');

  const runDelete = db.transaction((ids: string[]): ValidationFixtureCleanupResult => {
    const deletedInteractionRows = db.prepare(`
      DELETE FROM interactions
      WHERE feed_item_id IN (${placeholders})
    `).run(...ids).changes;

    const deletedPreferenceRows = db.prepare(`
      DELETE FROM preferences
      WHERE feed_item_id IN (${placeholders})
    `).run(...ids).changes;

    const deletedCodeFixTaskRows = db.prepare(`
      DELETE FROM code_fix_tasks
      WHERE suggestion_id IN (${placeholders})
    `).run(...ids).changes;

    const deletedFeedRows = db.prepare(`
      DELETE FROM feed
      WHERE id IN (${placeholders})
    `).run(...ids).changes;

    return {
      matchedIds: ids,
      deletedFeedRows,
      deletedInteractionRows,
      deletedPreferenceRows,
      deletedCodeFixTaskRows,
    };
  });

  return runDelete(normalizedIds);
}

export function deleteValidationFixtures(
  db: Database.Database,
  input: ValidationFixtureCleanupInput,
): ValidationFixtureCleanupResult {
  const ids = normalizeValues(input.ids);
  const sourceIds = normalizeValues(input.sourceIds);
  const originSessionIds = normalizeValues(input.originSessionIds);

  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (ids.length > 0) {
    conditions.push(`id IN (${buildNamedPlaceholders(ids, 'id', params)})`);
  }

  if (sourceIds.length > 0) {
    conditions.push(`source_id IN (${buildNamedPlaceholders(sourceIds, 'sourceId', params)})`);
  }

  if (originSessionIds.length > 0) {
    conditions.push(`origin_session_id IN (${buildNamedPlaceholders(originSessionIds, 'originSessionId', params)})`);
  }

  if (conditions.length === 0) {
    return {
      matchedIds: [],
      deletedFeedRows: 0,
      deletedInteractionRows: 0,
      deletedPreferenceRows: 0,
      deletedCodeFixTaskRows: 0,
    };
  }

  const fixtureIds = collectFixtureIdsByWhereClause(db, conditions.map((condition) => `(${condition})`).join(' OR '), params);
  return deleteFixtureIds(db, fixtureIds);
}

function collectKnownValidationFixtureIds(db: Database.Database): string[] {
  return collectFixtureIdsByWhereClause(db, `
    id LIKE 'ma-submit-%'
    OR id LIKE 'ma-ws-submit-%'
    OR id LIKE 'notif-test-%'
    OR id LIKE 'ws-chat-suggestion-%'
    OR id LIKE 'ws-code-fix-%'
    OR source_id LIKE 'curate-parent-%'
    OR source_id LIKE 'curate-child-%'
    OR source_id LIKE 'ws-curate-%'
    OR source_id LIKE 'ws-chat-suggestion-source-%'
    OR source_id LIKE 'ws-code-fix-source-%'
    OR source_id LIKE 'test-ping-%'
    OR source_id LIKE 'ping-test-%'
    OR source_id LIKE 'api-test-%'
    OR (
      type = 'notification'
      AND source_id LIKE 'ping-%'
      AND (
        title IN ('Ping received', 'Test Ping Received')
        OR reason LIKE 'User-initiated test ping%'
        OR reason LIKE 'User sent a test ping%'
      )
    )
    OR (
      title = 'Parent article'
      AND url LIKE 'https://example.com/articles/curate-parent-%'
    )
    OR (
      title = 'WebSocket submit'
      AND url LIKE 'https://example.com/ws/%'
    )
  `, {});
}

export function cleanupKnownValidationFixtures(db: Database.Database): ValidationFixtureCleanupResult {
  const fixtureIds = collectKnownValidationFixtureIds(db);
  return deleteFixtureIds(db, fixtureIds);
}
