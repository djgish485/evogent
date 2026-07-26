const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_APPLY_TARGET_PATHS = Object.freeze({
  config: 'data/config.md',
  'curation-prompt': 'data/curation-prompt.md',
});

const REQUIRED_COLUMNS = new Set([
  'task_id',
  'suggestion_id',
  'target',
  'section_name',
  'proposed_value',
  'diff',
  'payload_sha256',
  'status',
  'result_json',
]);

const JOURNAL_COLUMNS = Object.freeze({
  pre_content_sha256: 'TEXT',
  post_content_sha256: 'TEXT',
});

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS config_apply_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL UNIQUE,
    suggestion_id TEXT NOT NULL UNIQUE,
    target TEXT NOT NULL CHECK(target IN ('config', 'curation-prompt')),
    section_name TEXT NOT NULL,
    proposed_value TEXT NOT NULL,
    diff TEXT,
    payload_sha256 TEXT NOT NULL,
    pre_content_sha256 TEXT,
    post_content_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued', 'running', 'applied', 'failed')),
    phase TEXT,
    phase_detail TEXT,
    error TEXT,
    result_json TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (suggestion_id) REFERENCES feed(id) ON DELETE CASCADE
  );
`;

const CREATE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS config_apply_tasks_status_idx
    ON config_apply_tasks(status, created_at);
  CREATE INDEX IF NOT EXISTS config_apply_tasks_suggestion_id_idx
    ON config_apply_tasks(suggestion_id);
`;

const CREATE_IMMUTABILITY_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS config_apply_tasks_payload_immutable
  BEFORE UPDATE OF
    task_id,
    suggestion_id,
    target,
    section_name,
    proposed_value,
    diff,
    payload_sha256
  ON config_apply_tasks
  WHEN NEW.task_id IS NOT OLD.task_id
    OR NEW.suggestion_id IS NOT OLD.suggestion_id
    OR NEW.target IS NOT OLD.target
    OR NEW.section_name IS NOT OLD.section_name
    OR NEW.proposed_value IS NOT OLD.proposed_value
    OR NEW.diff IS NOT OLD.diff
    OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  BEGIN
    SELECT RAISE(ABORT, 'config apply task payload is immutable');
  END;
`;

const CREATE_JOURNAL_IMMUTABILITY_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS config_apply_tasks_journal_immutable
  BEFORE UPDATE OF
    pre_content_sha256,
    post_content_sha256,
    result_json
  ON config_apply_tasks
  WHEN
    (OLD.pre_content_sha256 IS NOT NULL
      AND NEW.pre_content_sha256 IS NOT OLD.pre_content_sha256)
    OR (OLD.post_content_sha256 IS NOT NULL
      AND NEW.post_content_sha256 IS NOT OLD.post_content_sha256)
    OR (OLD.pre_content_sha256 IS NOT NULL
      AND NEW.result_json IS NOT OLD.result_json)
  BEGIN
    SELECT RAISE(ABORT, 'config apply task journal is immutable');
  END;
`;

class ConfigApplyTaskError extends Error {
  constructor(message, statusCode = 400, code = 'CONFIG_APPLY_INVALID') {
    super(message);
    this.name = 'ConfigApplyTaskError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function ensureConfigApplyTasksTable(db) {
  const existing = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'config_apply_tasks'
  `).get();

  if (existing) {
    const columns = db.prepare(`PRAGMA table_info('config_apply_tasks')`).all();
    const columnNames = new Set(columns.map((column) => column.name));
    const isAuthoritativeSchema = [...REQUIRED_COLUMNS].every((column) => columnNames.has(column));
    if (!isAuthoritativeSchema) {
      // Legacy rows did not contain the payload needed to verify a write. They cannot be
      // migrated into executable tasks safely, so retire that table instead of blessing them.
      db.exec('DROP TABLE config_apply_tasks;');
    } else {
      for (const [column, definition] of Object.entries(JOURNAL_COLUMNS)) {
        if (!columnNames.has(column)) {
          db.exec(`ALTER TABLE config_apply_tasks ADD COLUMN ${column} ${definition};`);
        }
      }
    }
  }

  db.exec(CREATE_TABLE_SQL);
  db.exec(CREATE_INDEXES_SQL);
  // Recreate these definitions on upgrade so an existing database receives every
  // newly protected journal column without dropping its durable queue.
  db.exec('DROP TRIGGER IF EXISTS config_apply_tasks_payload_immutable;');
  db.exec('DROP TRIGGER IF EXISTS config_apply_tasks_journal_immutable;');
  db.exec(CREATE_IMMUTABILITY_TRIGGER_SQL);
  db.exec(CREATE_JOURNAL_IMMUTABILITY_TRIGGER_SQL);
}

function normalizeRequiredString(value, field, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new ConfigApplyTaskError(`${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new ConfigApplyTaskError(`${field} is too long`);
  }
  return normalized;
}

function normalizeTaskInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigApplyTaskError('Config apply task must be an object');
  }

  const taskId = normalizeRequiredString(input.taskId, 'taskId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId)) {
    throw new ConfigApplyTaskError('taskId contains unsupported characters');
  }

  const suggestionId = normalizeRequiredString(input.suggestionId, 'suggestionId', 256);
  const target = normalizeRequiredString(input.target, 'target', 32);
  if (!Object.hasOwn(CONFIG_APPLY_TARGET_PATHS, target)) {
    throw new ConfigApplyTaskError('target must be config or curation-prompt');
  }

  const sectionName = normalizeRequiredString(input.sectionName, 'sectionName', 256);
  const proposedValue = normalizeRequiredString(input.proposedValue, 'proposedValue', 65_536);
  const diff = typeof input.diff === 'string' && input.diff.trim()
    ? input.diff.trim()
    : null;
  if (diff && diff.length > 131_072) {
    throw new ConfigApplyTaskError('diff is too long');
  }

  return {
    taskId,
    suggestionId,
    target,
    relativePath: CONFIG_APPLY_TARGET_PATHS[target],
    sectionName,
    proposedValue,
    diff,
  };
}

function parseMetadata(rawMetadata) {
  try {
    const parsed = JSON.parse(typeof rawMetadata === 'string' ? rawMetadata : '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function payloadHash(task) {
  const canonicalPayload = JSON.stringify({
    taskId: task.taskId,
    suggestionId: task.suggestionId,
    target: task.target,
    relativePath: task.relativePath,
    sectionName: task.sectionName,
    proposedValue: task.proposedValue,
    diff: task.diff,
  });
  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

function configContentHash(content) {
  const normalized = `${String(content ?? '').replace(/\r\n/g, '\n').trimEnd()}\n`;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function rowToTask(row) {
  return {
    taskId: row.task_id,
    suggestionId: row.suggestion_id,
    target: row.target,
    relativePath: CONFIG_APPLY_TARGET_PATHS[row.target],
    sectionName: row.section_name,
    proposedValue: row.proposed_value,
    diff: row.diff ?? null,
    payloadSha256: row.payload_sha256,
    preContentSha256: row.pre_content_sha256 ?? null,
    postContentSha256: row.post_content_sha256 ?? null,
    status: row.status,
    phase: row.phase ?? null,
    phaseDetail: row.phase_detail ?? null,
    error: row.error ?? null,
    result: parseMetadata(row.result_json),
  };
}

function normalizeExecutionJournal(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    throw new ConfigApplyTaskError(
      'Config apply execution journal is required',
      409,
      'CONFIG_APPLY_INTEGRITY',
    );
  }
  const preContentSha256 = typeof journal.preContentSha256 === 'string'
    ? journal.preContentSha256.trim().toLowerCase()
    : '';
  const postContentSha256 = typeof journal.postContentSha256 === 'string'
    ? journal.postContentSha256.trim().toLowerCase()
    : '';
  if (
    !/^[a-f0-9]{64}$/.test(preContentSha256)
    || !/^[a-f0-9]{64}$/.test(postContentSha256)
  ) {
    throw new ConfigApplyTaskError(
      'Config apply execution journal hashes are invalid',
      409,
      'CONFIG_APPLY_INTEGRITY',
    );
  }
  const result = journal.result && typeof journal.result === 'object' && !Array.isArray(journal.result)
    ? journal.result
    : {};
  const resultJson = JSON.stringify(result);
  if (resultJson.length > 16_384) {
    throw new ConfigApplyTaskError(
      'Config apply execution result is too large',
      409,
      'CONFIG_APPLY_INTEGRITY',
    );
  }
  return {
    preContentSha256,
    postContentSha256,
    result,
    resultJson,
  };
}

function getTaskRow(db, taskId) {
  return db.prepare(`
    SELECT *
    FROM config_apply_tasks
    WHERE task_id = ?
  `).get(taskId);
}

function readSuggestion(db, suggestionId) {
  const row = db.prepare(`
    SELECT id, type, metadata
    FROM feed
    WHERE id = ?
  `).get(suggestionId);
  if (!row) {
    throw new ConfigApplyTaskError('Config suggestion was not found', 404, 'CONFIG_APPLY_NOT_FOUND');
  }
  if (row.type !== 'suggestion') {
    throw new ConfigApplyTaskError('Config apply task must reference a suggestion');
  }

  const metadata = parseMetadata(row.metadata);
  if (!metadata) {
    throw new ConfigApplyTaskError('Config suggestion metadata is invalid');
  }
  const suggestionType = typeof metadata.suggestionType === 'string'
    ? metadata.suggestionType.trim().toLowerCase()
    : '';
  if (suggestionType !== 'config' && suggestionType !== 'config_change') {
    throw new ConfigApplyTaskError('Suggestion is not a config change');
  }
  return { row, metadata };
}

function buildAuthoritativeTask(input, metadata) {
  const expectedPath = CONFIG_APPLY_TARGET_PATHS[input.target];
  const configFile = typeof metadata.configFile === 'string' ? metadata.configFile.trim() : '';
  const configField = typeof metadata.configField === 'string' ? metadata.configField.trim() : '';
  const proposedValue = typeof metadata.proposedValue === 'string' ? metadata.proposedValue.trim() : '';
  const diff = typeof metadata.diff === 'string' && metadata.diff.trim()
    ? metadata.diff.trim()
    : null;

  if (configFile !== expectedPath) {
    throw new ConfigApplyTaskError('Task target does not match suggestion configFile');
  }
  if (!configField || configField !== input.sectionName) {
    throw new ConfigApplyTaskError('Task sectionName does not match suggestion configField');
  }
  if (!proposedValue || proposedValue !== input.proposedValue) {
    throw new ConfigApplyTaskError('Task proposedValue does not match suggestion metadata');
  }
  if (input.diff !== diff) {
    throw new ConfigApplyTaskError('Task diff does not match suggestion metadata');
  }

  return {
    ...input,
    relativePath: expectedPath,
    sectionName: configField,
    proposedValue,
    diff,
  };
}

function verifyStoredTask(task, metadata, options = {}) {
  let authoritative;
  try {
    authoritative = buildAuthoritativeTask(task, metadata);
  } catch {
    throw new ConfigApplyTaskError(
      'Stored config apply payload no longer matches its suggestion',
      409,
      'CONFIG_APPLY_INTEGRITY',
    );
  }
  if (payloadHash(authoritative) !== task.payloadSha256) {
    throw new ConfigApplyTaskError(
      'Stored config apply payload failed its integrity check',
      409,
      'CONFIG_APPLY_INTEGRITY',
    );
  }

  if (options.requireDispatchIdentity) {
    const metadataTaskId = typeof metadata.taskId === 'string' ? metadata.taskId.trim() : '';
    if (metadataTaskId !== task.taskId) {
      throw new ConfigApplyTaskError(
        'Suggestion is not dispatched for this config task',
        409,
        'CONFIG_APPLY_CONFLICT',
      );
    }
  }
}

function enqueueConfigApplyTask(db, input) {
  ensureConfigApplyTasksTable(db);
  const normalized = normalizeTaskInput(input);

  return db.transaction(() => {
    const existingByTaskId = getTaskRow(db, normalized.taskId);
    const existingBySuggestion = db.prepare(`
      SELECT *
      FROM config_apply_tasks
      WHERE suggestion_id = ?
    `).get(normalized.suggestionId);
    const existing = existingByTaskId || existingBySuggestion;

    const { metadata } = readSuggestion(db, normalized.suggestionId);
    const authoritative = buildAuthoritativeTask(normalized, metadata);
    const hash = payloadHash(authoritative);

    if (existing) {
      const existingTask = rowToTask(existing);
      if (
        existingTask.taskId !== authoritative.taskId
        || existingTask.suggestionId !== authoritative.suggestionId
        || existingTask.payloadSha256 !== hash
      ) {
        throw new ConfigApplyTaskError(
          'Config suggestion is already bound to a different immutable task',
          409,
          'CONFIG_APPLY_CONFLICT',
        );
      }
      verifyStoredTask(existingTask, metadata);
      return { duplicate: true, task: existingTask };
    }

    const suggestionStatus = typeof metadata.suggestionStatus === 'string'
      ? metadata.suggestionStatus.trim().toLowerCase()
      : '';
    if (suggestionStatus && suggestionStatus !== 'pending') {
      throw new ConfigApplyTaskError(
        `Config suggestion cannot be enqueued from ${suggestionStatus} status`,
        409,
        'CONFIG_APPLY_CONFLICT',
      );
    }

    db.prepare(`
      INSERT INTO config_apply_tasks (
        task_id,
        suggestion_id,
        target,
        section_name,
        proposed_value,
        diff,
        payload_sha256,
        status,
        phase,
        phase_detail
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?)
    `).run(
      authoritative.taskId,
      authoritative.suggestionId,
      authoritative.target,
      authoritative.sectionName,
      authoritative.proposedValue,
      authoritative.diff,
      hash,
      `Queued apply for ${authoritative.relativePath}`,
    );

    const feedUpdate = db.prepare(`
      UPDATE feed
      SET metadata = json_set(
        CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
        '$.suggestionStatus', 'dispatched',
        '$.configApplyStatus', 'queued',
        '$.taskId', ?,
        '$.configApplyError', NULL
      )
      WHERE id = ?
    `).run(authoritative.taskId, authoritative.suggestionId);
    if (feedUpdate.changes !== 1) {
      throw new ConfigApplyTaskError('Failed to bind config task to its suggestion', 409);
    }

    return { duplicate: false, task: rowToTask(getTaskRow(db, authoritative.taskId)) };
  })();
}

function getConfigApplyTaskForExecution(db, taskIdInput) {
  ensureConfigApplyTasksTable(db);
  const taskId = normalizeRequiredString(taskIdInput, 'taskId', 128);
  const row = getTaskRow(db, taskId);
  if (!row) {
    throw new ConfigApplyTaskError('Config apply task was not found', 404, 'CONFIG_APPLY_NOT_FOUND');
  }
  const task = rowToTask(row);
  const { metadata } = readSuggestion(db, task.suggestionId);
  verifyStoredTask(task, metadata, { requireDispatchIdentity: true });
  if (task.status !== 'queued' && task.status !== 'applied') {
    throw new ConfigApplyTaskError(
      `Config apply task is already ${task.status}`,
      409,
      'CONFIG_APPLY_CONFLICT',
    );
  }
  return task;
}

function claimConfigApplyTask(db, taskIdInput, journalInput) {
  ensureConfigApplyTasksTable(db);
  const taskId = normalizeRequiredString(taskIdInput, 'taskId', 128);
  const journal = normalizeExecutionJournal(journalInput);

  return db.transaction(() => {
    const row = getTaskRow(db, taskId);
    if (!row) {
      throw new ConfigApplyTaskError('Config apply task was not found', 404, 'CONFIG_APPLY_NOT_FOUND');
    }
    const task = rowToTask(row);
    const { metadata } = readSuggestion(db, task.suggestionId);
    verifyStoredTask(task, metadata, { requireDispatchIdentity: true });

    if (task.status === 'applied') {
      return { state: 'applied', task };
    }
    if (task.status !== 'queued') {
      throw new ConfigApplyTaskError(
        `Config apply task is already ${task.status}`,
        409,
        'CONFIG_APPLY_CONFLICT',
      );
    }
    if (
      (task.preContentSha256 && task.preContentSha256 !== journal.preContentSha256)
      || (task.postContentSha256 && task.postContentSha256 !== journal.postContentSha256)
      || (task.preContentSha256
        && JSON.stringify(task.result ?? {}) !== journal.resultJson)
    ) {
      throw new ConfigApplyTaskError(
        'Config apply execution journal does not match its durable transition',
        409,
        'CONFIG_APPLY_INTEGRITY',
      );
    }

    const claimed = db.prepare(`
      UPDATE config_apply_tasks
      SET status = 'running',
          phase = 'applying',
          phase_detail = 'Applying the authoritative config payload',
          pre_content_sha256 = ?,
          post_content_sha256 = ?,
          result_json = ?,
          started_at = datetime('now'),
          completed_at = NULL,
          error = NULL,
          updated_at = datetime('now')
      WHERE task_id = ? AND status = 'queued'
    `).run(
      journal.preContentSha256,
      journal.postContentSha256,
      journal.resultJson,
      task.taskId,
    );
    if (claimed.changes !== 1) {
      throw new ConfigApplyTaskError(
        'Config apply task could not be claimed',
        409,
        'CONFIG_APPLY_CONFLICT',
      );
    }

    db.prepare(`
      UPDATE feed
      SET metadata = json_set(
        CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
        '$.configApplyStatus', 'running',
        '$.configApplyError', NULL
      )
      WHERE id = ?
    `).run(task.suggestionId);

    return { state: 'claimed', task: rowToTask(getTaskRow(db, task.taskId)) };
  })();
}

function completeConfigApplyTask(db, taskIdInput, result) {
  ensureConfigApplyTasksTable(db);
  const taskId = normalizeRequiredString(taskIdInput, 'taskId', 128);

  return db.transaction(() => {
    const row = getTaskRow(db, taskId);
    if (!row) {
      throw new ConfigApplyTaskError('Config apply task was not found', 404, 'CONFIG_APPLY_NOT_FOUND');
    }
    const task = rowToTask(row);
    if (task.status !== 'running') {
      throw new ConfigApplyTaskError(
        `Config apply task cannot complete from ${task.status} status`,
        409,
        'CONFIG_APPLY_CONFLICT',
      );
    }
    const resultJson = JSON.stringify(result && typeof result === 'object' ? result : {});
    if (
      !task.preContentSha256
      || !task.postContentSha256
      || JSON.stringify(task.result ?? {}) !== resultJson
    ) {
      throw new ConfigApplyTaskError(
        'Config apply completion does not match its durable execution journal',
        409,
        'CONFIG_APPLY_INTEGRITY',
      );
    }

    const completed = db.prepare(`
      UPDATE config_apply_tasks
      SET status = 'applied',
          phase = 'completed',
          phase_detail = 'Config apply completed',
          error = NULL,
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE task_id = ? AND status = 'running'
    `).run(task.taskId);
    if (completed.changes !== 1) {
      throw new ConfigApplyTaskError('Config apply task completion raced with another writer', 409);
    }

    const changed = result && result.changed ? 1 : 0;
    const method = result && typeof result.method === 'string' ? result.method : null;
    const feedUpdate = db.prepare(`
      UPDATE feed
      SET metadata = json_set(
        CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
        '$.suggestionStatus', 'accepted',
        '$.configApplyStatus', 'applied',
        '$.configApplyError', NULL,
        '$.configApplyMethod', ?,
        '$.configApplyChanged', ?,
        '$.taskId', ?
      )
      WHERE id = ?
        AND json_extract(
          CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
          '$.taskId'
        ) = ?
    `).run(method, changed, task.taskId, task.suggestionId, task.taskId);
    if (feedUpdate.changes !== 1) {
      throw new ConfigApplyTaskError('Config suggestion lost its task binding during completion', 409);
    }

    return rowToTask(getTaskRow(db, task.taskId));
  })();
}

function requeueConfigApplyTask(db, taskIdInput) {
  ensureConfigApplyTasksTable(db);
  const taskId = normalizeRequiredString(taskIdInput, 'taskId', 128);

  return db.transaction(() => {
    const row = getTaskRow(db, taskId);
    if (!row || row.status !== 'running') {
      return row ? rowToTask(row) : null;
    }
    db.prepare(`
      UPDATE config_apply_tasks
      SET status = 'queued',
          phase = 'recovered',
          phase_detail = 'Recovered before the durable config write',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          updated_at = datetime('now')
      WHERE task_id = ? AND status = 'running'
    `).run(taskId);
    db.prepare(`
      UPDATE feed
      SET metadata = json_set(
        CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
        '$.suggestionStatus', 'dispatched',
        '$.configApplyStatus', 'queued',
        '$.configApplyError', NULL,
        '$.taskId', ?
      )
      WHERE id = ?
        AND json_extract(
          CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
          '$.taskId'
        ) = ?
    `).run(taskId, row.suggestion_id, taskId);
    return rowToTask(getTaskRow(db, taskId));
  })();
}

function reconcileConfigApplyTask(db, taskIdInput, options = {}) {
  ensureConfigApplyTasksTable(db);
  const taskId = normalizeRequiredString(taskIdInput, 'taskId', 128);
  const row = getTaskRow(db, taskId);
  if (!row) {
    throw new ConfigApplyTaskError(
      'Config apply task was not found',
      404,
      'CONFIG_APPLY_NOT_FOUND',
    );
  }
  const task = rowToTask(row);
  if (task.status !== 'running') {
    return { taskId: task.taskId, action: 'unchanged', task };
  }

  const dataDir = path.resolve(
    options.dataDir
      || process.env.DATA_DIR
      || path.join(process.cwd(), 'data'),
  );
  const readCurrentHash = typeof options.readCurrentHash === 'function'
    ? options.readCurrentHash
    : (candidate) => {
        const relative = CONFIG_APPLY_TARGET_PATHS[candidate.target];
        const filename = relative.replace(/^data\//, '');
        return configContentHash(fs.readFileSync(path.join(dataDir, filename), 'utf8'));
      };

  let currentHash = '';
  try {
    currentHash = readCurrentHash(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'config target could not be read';
    const failed = failConfigApplyTask(
      db,
      task.taskId,
      `Interrupted config apply conflict: ${message}`,
    );
    return { taskId: task.taskId, action: 'conflict', task: failed };
  }
  if (
    !/^[a-f0-9]{64}$/.test(task.preContentSha256 || '')
    || !/^[a-f0-9]{64}$/.test(task.postContentSha256 || '')
    || !task.result
  ) {
    const failed = failConfigApplyTask(
      db,
      task.taskId,
      'Interrupted config apply has no valid durable journal',
    );
    return { taskId: task.taskId, action: 'conflict', task: failed };
  }
  if (currentHash === task.postContentSha256) {
    const completed = completeConfigApplyTask(db, task.taskId, task.result);
    return { taskId: task.taskId, action: 'completed', task: completed };
  }
  if (currentHash === task.preContentSha256) {
    const requeued = requeueConfigApplyTask(db, task.taskId);
    return { taskId: task.taskId, action: 'requeued', task: requeued };
  }
  const failed = failConfigApplyTask(
    db,
    task.taskId,
    'Interrupted config apply stopped because the config changed outside its journal',
  );
  return { taskId: task.taskId, action: 'conflict', task: failed };
}

function reconcileRunningConfigApplyTasks(db, options = {}) {
  const table = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'config_apply_tasks'
  `).get();
  if (!table) {
    return { actions: [], queuedTaskIds: [] };
  }
  ensureConfigApplyTasksTable(db);

  const actions = [];
  const runningRows = db.prepare(`
    SELECT *
    FROM config_apply_tasks
    WHERE status = 'running'
    ORDER BY id ASC
  `).all();

  for (const row of runningRows) {
    try {
      const recovery = reconcileConfigApplyTask(db, row.task_id, options);
      actions.push({ taskId: recovery.taskId, action: recovery.action });
    } catch {
      // A transient DB/feed-binding failure must never become a false terminal "failed"
      // state after the postimage is durable. Leave the task running for the next retry.
      actions.push({ taskId: row.task_id, action: 'deferred' });
    }
  }

  const queuedTaskIds = db.prepare(`
    SELECT task_id AS taskId
    FROM config_apply_tasks
    WHERE status = 'queued'
    ORDER BY id ASC
  `).all().map((row) => row.taskId);
  return { actions, queuedTaskIds };
}

function failConfigApplyTask(db, taskIdInput, errorMessage) {
  ensureConfigApplyTasksTable(db);
  const taskId = normalizeRequiredString(taskIdInput, 'taskId', 128);
  const message = String(errorMessage || 'Config apply failed').slice(0, 500);

  return db.transaction(() => {
    const row = getTaskRow(db, taskId);
    if (!row || row.status === 'applied' || row.status === 'failed') {
      return row ? rowToTask(row) : null;
    }

    db.prepare(`
      UPDATE config_apply_tasks
      SET status = 'failed',
          phase = 'failed',
          phase_detail = 'Config apply failed',
          error = ?,
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE task_id = ? AND status IN ('queued', 'running')
    `).run(message, taskId);

    db.prepare(`
      UPDATE feed
      SET metadata = json_set(
        CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
        '$.suggestionStatus', 'pending',
        '$.configApplyStatus', 'failed',
        '$.configApplyError', ?
      )
      WHERE id = ?
        AND json_extract(
          CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
          '$.taskId'
        ) = ?
    `).run(message, row.suggestion_id, taskId);

    return rowToTask(getTaskRow(db, taskId));
  })();
}

module.exports = {
  CONFIG_APPLY_TARGET_PATHS,
  ConfigApplyTaskError,
  claimConfigApplyTask,
  completeConfigApplyTask,
  configContentHash,
  enqueueConfigApplyTask,
  ensureConfigApplyTasksTable,
  failConfigApplyTask,
  getConfigApplyTaskForExecution,
  payloadHash,
  reconcileConfigApplyTask,
  reconcileRunningConfigApplyTasks,
  requeueConfigApplyTask,
};
