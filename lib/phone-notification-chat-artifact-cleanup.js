const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ORCHESTRATOR_EVIDENCE_PURGED_MARKER =
  'phoneNotificationOrchestratorEvidencePurged';

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName));
}

function normalizeStrings(values) {
  return new Set(
    [...values]
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function writePrivateFileAtomically(filePath, contents, {
  fsImpl = fs,
  pathImpl = path,
  randomUUIDImpl = randomUUID,
} = {}) {
  fsImpl.mkdirSync(pathImpl.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath =
    `${filePath}.privacy-${process.pid}-${randomUUIDImpl()}.tmp`;
  let temporaryDescriptor = null;
  try {
    temporaryDescriptor = fsImpl.openSync(temporaryPath, 'wx', 0o600);
    fsImpl.writeFileSync(temporaryDescriptor, contents, 'utf8');
    fsImpl.fsyncSync(temporaryDescriptor);
    fsImpl.closeSync(temporaryDescriptor);
    temporaryDescriptor = null;

    fsImpl.renameSync(temporaryPath, filePath);
    fsImpl.chmodSync(filePath, 0o600);

    const finalDescriptor = fsImpl.openSync(filePath, 'r');
    try {
      fsImpl.fsyncSync(finalDescriptor);
    } finally {
      fsImpl.closeSync(finalDescriptor);
    }

    const directoryDescriptor = fsImpl.openSync(pathImpl.dirname(filePath), 'r');
    try {
      fsImpl.fsyncSync(directoryDescriptor);
    } finally {
      fsImpl.closeSync(directoryDescriptor);
    }
  } finally {
    if (temporaryDescriptor !== null) {
      fsImpl.closeSync(temporaryDescriptor);
    }
    try {
      fsImpl.unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function isPathInside(parentPath, candidatePath, pathImpl = path) {
  const relative = pathImpl.relative(parentPath, candidatePath);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${pathImpl.sep}`)
    && !pathImpl.isAbsolute(relative);
}

function unlinkTaskLogsDurably(taskIds, historyLogPaths, dataDir, {
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const taskLogsDir = pathImpl.resolve(dataDir, 'task-logs');
  const candidatePaths = new Set();

  for (const taskId of taskIds) {
    const resolved = pathImpl.resolve(taskLogsDir, `${taskId}.jsonl`);
    if (isPathInside(taskLogsDir, resolved, pathImpl)) {
      candidatePaths.add(resolved);
    }
  }

  for (const logPath of historyLogPaths) {
    if (typeof logPath !== 'string' || !logPath.trim()) continue;
    const resolved = pathImpl.resolve(logPath.trim());
    if (isPathInside(taskLogsDir, resolved, pathImpl)) {
      candidatePaths.add(resolved);
    }
  }

  let removedCount = 0;
  for (const candidatePath of candidatePaths) {
    try {
      fsImpl.unlinkSync(candidatePath);
      removedCount += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  if (removedCount > 0) {
    const directoryDescriptor = fsImpl.openSync(taskLogsDir, 'r');
    try {
      fsImpl.fsyncSync(directoryDescriptor);
    } finally {
      fsImpl.closeSync(directoryDescriptor);
    }
  }

  return removedCount;
}

function unlinkAllTaskLogsDurably(dataDir, {
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const taskLogsDir = pathImpl.resolve(dataDir, 'task-logs');
  let entries;
  try {
    entries = fsImpl.readdirSync(taskLogsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }

  let removedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || pathImpl.extname(entry.name).toLowerCase() !== '.jsonl') {
      continue;
    }
    fsImpl.unlinkSync(pathImpl.join(taskLogsDir, entry.name));
    removedCount += 1;
  }

  if (removedCount > 0) {
    const directoryDescriptor = fsImpl.openSync(taskLogsDir, 'r');
    try {
      fsImpl.fsyncSync(directoryDescriptor);
    } finally {
      fsImpl.closeSync(directoryDescriptor);
    }
  }

  return removedCount;
}

function readHistoryDocument(historyPath, fsImpl = fs) {
  let serialized;
  try {
    serialized = fsImpl.readFileSync(historyPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        document: null,
        history: [],
        legacyArray: false,
        malformed: false,
      };
    }
    throw error;
  }

  let document;
  try {
    document = JSON.parse(serialized);
  } catch {
    return {
      exists: true,
      document: {
        history: [],
        reflectionSession: null,
      },
      history: [],
      legacyArray: false,
      malformed: true,
    };
  }
  if (Array.isArray(document)) {
    return {
      exists: true,
      document,
      history: document,
      legacyArray: true,
      malformed: false,
    };
  }
  if (document && typeof document === 'object' && !Array.isArray(document)) {
    return {
      exists: true,
      document,
      history: Array.isArray(document.history) ? document.history : [],
      legacyArray: false,
      malformed: false,
    };
  }

  return {
    exists: true,
    document: {
      history: [],
      reflectionSession: null,
    },
    history: [],
    legacyArray: false,
    malformed: true,
  };
}

function scrubRuntimeFiles({
  dataDir,
  messageIds,
  sessionIds,
  providerSessionIds,
  taskIds,
  fsImpl = fs,
  pathImpl = path,
  randomUUIDImpl = randomUUID,
}) {
  const historyPath = pathImpl.join(dataDir, 'orchestrator-history.json');
  const historyDocument = readHistoryDocument(historyPath, fsImpl);
  const identifiers = normalizeStrings([
    ...messageIds,
    ...sessionIds,
    ...providerSessionIds,
    ...taskIds,
  ]);

  const removedHistory = [];
  const retainedHistory = [];
  for (const entry of historyDocument.history) {
    let serialized = '';
    try {
      serialized = JSON.stringify(entry);
    } catch {
      // An unserializable entry cannot be written back by the orchestrator and
      // cannot be proven unrelated to the affected session. Remove it.
      removedHistory.push(entry);
      continue;
    }
    if ([...identifiers].some((identifier) => serialized.includes(identifier))) {
      removedHistory.push(entry);
    } else {
      retainedHistory.push(entry);
    }
  }

  const allTaskIds = normalizeStrings(taskIds);
  const historyLogPaths = [];
  for (const entry of removedHistory) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.id === 'string' && entry.id.trim()) {
      allTaskIds.add(entry.id.trim());
    }
    if (typeof entry.logFile === 'string' && entry.logFile.trim()) {
      historyLogPaths.push(entry.logFile.trim());
    }
  }

  // Logs go first. If history replacement then fails, the intact history lets
  // the next startup rediscover every history-only task and retry safely.
  const removedTaskLogs = historyDocument.malformed
    ? unlinkAllTaskLogsDurably(dataDir, { fsImpl, pathImpl })
    : unlinkTaskLogsDurably(
        allTaskIds,
        historyLogPaths,
        dataDir,
        { fsImpl, pathImpl },
      );

  if (
    historyDocument.exists
    && (removedHistory.length > 0 || historyDocument.malformed)
  ) {
    const nextDocument = historyDocument.legacyArray
      ? retainedHistory
      : {
          ...historyDocument.document,
          history: retainedHistory,
        };
    writePrivateFileAtomically(
      historyPath,
      JSON.stringify(nextDocument, null, 2),
      { fsImpl, pathImpl, randomUUIDImpl },
    );
  }

  return {
    removedHistoryEntries: removedHistory.length,
    removedTaskLogs,
    resetMalformedHistory: historyDocument.malformed,
  };
}

function populateRoots(db) {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS legacy_phone_notification_runtime_roots (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_rowid INTEGER NOT NULL,
      timestamp TEXT NOT NULL
    );
    DELETE FROM legacy_phone_notification_runtime_roots;
  `);
  db.exec(`
    INSERT OR IGNORE INTO legacy_phone_notification_runtime_roots (
      message_id,
      session_id,
      message_rowid,
      timestamp
    )
    SELECT
      chat_messages.id,
      chat_messages.session_id,
      chat_messages.rowid,
      chat_messages.timestamp
    FROM chat_messages
    WHERE json_valid(chat_messages.metadata)
      AND json_extract(chat_messages.metadata, '$.contextKind') = 'post'
      AND COALESCE(
        json_extract(
          chat_messages.metadata,
          '$.${ORCHESTRATOR_EVIDENCE_PURGED_MARKER}'
        ),
        0
      ) != 1
      AND EXISTS (
        SELECT 1
        FROM feed
        WHERE feed.id = json_extract(chat_messages.metadata, '$.contextRefId')
          AND feed.type = 'notification'
          AND feed.source = 'phone-notification'
      );
  `);
  return db.prepare(`
    SELECT message_id, session_id, message_rowid, timestamp
    FROM legacy_phone_notification_runtime_roots
    ORDER BY message_rowid ASC
  `).all();
}

function readDerivedMessages(db) {
  return db.prepare(`
    SELECT DISTINCT
      chat_messages.id,
      chat_messages.task_id
    FROM chat_messages
    WHERE chat_messages.role = 'agent'
      AND EXISTS (
        SELECT 1
        FROM legacy_phone_notification_runtime_roots AS roots
        WHERE chat_messages.in_reply_to = roots.message_id
          OR (
            COALESCE(TRIM(chat_messages.session_id), '') != ''
            AND chat_messages.session_id = roots.session_id
            AND (
              chat_messages.rowid > roots.message_rowid
              OR (
                julianday(chat_messages.timestamp) IS NOT NULL
                AND julianday(roots.timestamp) IS NOT NULL
                AND julianday(chat_messages.timestamp) >= julianday(roots.timestamp)
              )
            )
          )
      )
    ORDER BY chat_messages.rowid ASC
  `).all();
}

function scrubLegacyPhoneNotificationRuntimeArtifacts({
  db,
  dataDir,
  fsImpl = fs,
  pathImpl = path,
  randomUUIDImpl = randomUUID,
}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('db is required');
  }
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('dataDir is required');
  }

  db.pragma('busy_timeout = 10000');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!tableExists(db, 'feed') || !tableExists(db, 'chat_messages')) {
      db.exec('COMMIT');
      return {
        affectedRoots: 0,
        removedHistoryEntries: 0,
        removedTaskLogs: 0,
      };
    }

    const roots = populateRoots(db);
    if (roots.length === 0) {
      db.exec('COMMIT');
      return {
        affectedRoots: 0,
        removedHistoryEntries: 0,
        removedTaskLogs: 0,
      };
    }

    const derivedMessages = readDerivedMessages(db);
    const affectedSessions = tableExists(db, 'chat_sessions')
      ? db.prepare(`
          SELECT DISTINCT
            chat_sessions.id,
            chat_sessions.provider_session_id,
            chat_sessions.claude_session_id
          FROM chat_sessions
          INNER JOIN legacy_phone_notification_runtime_roots AS roots
            ON roots.session_id = chat_sessions.id
        `).all()
      : [];

    const result = scrubRuntimeFiles({
      dataDir: pathImpl.resolve(dataDir),
      messageIds: [
        ...roots.map((root) => root.message_id),
        ...derivedMessages.map((message) => message.id),
      ],
      sessionIds: roots.map((root) => root.session_id),
      providerSessionIds: affectedSessions.flatMap((session) => [
        session.provider_session_id,
        session.claude_session_id,
      ]),
      taskIds: derivedMessages.map((message) => message.task_id),
      fsImpl,
      pathImpl,
      randomUUIDImpl,
    });

    db.exec(`
      UPDATE chat_messages
      SET metadata = json_set(
        CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
        '$.${ORCHESTRATOR_EVIDENCE_PURGED_MARKER}',
        json('true')
      )
      WHERE id IN (
        SELECT message_id
        FROM legacy_phone_notification_runtime_roots
      );
    `);
    db.exec('COMMIT');
    return {
      affectedRoots: roots.length,
      ...result,
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original cleanup error.
    }
    throw error;
  }
}

module.exports = {
  ORCHESTRATOR_EVIDENCE_PURGED_MARKER,
  scrubLegacyPhoneNotificationRuntimeArtifacts,
  scrubRuntimeFiles,
};
