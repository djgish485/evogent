const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertChatSessionContextMetrics } = require('./chat-session-context-metrics');

const DEFAULT_MAX_SESSION_FILES = 500;
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_CHAT_MESSAGES = 80;
const DEFAULT_MAX_FILE_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024;
const DEFAULT_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BACKFILL_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BROAD_LOG_SEARCHES = 4;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonNegativeInteger(value) {
  if (typeof value === 'string' && !value.trim()) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

function normalizePositiveInteger(value) {
  const numeric = normalizeNonNegativeInteger(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function getCodexSessionsRoot(inputRoot) {
  if (typeof inputRoot === 'string' && inputRoot.trim()) {
    return inputRoot.trim();
  }
  return path.join(os.homedir(), '.codex', 'sessions');
}

function safeParseJsonLine(line) {
  if (typeof line !== 'string') {
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getEventSessionIdCandidates(rawEvent) {
  if (!isRecord(rawEvent)) {
    return [];
  }
  const payload = isRecord(rawEvent.payload) ? rawEvent.payload : null;
  return [
    rawEvent.thread_id,
    rawEvent.session_id,
    rawEvent.sessionId,
    rawEvent.conversation_id,
    rawEvent.conversationId,
    payload?.thread_id,
    payload?.session_id,
    payload?.sessionId,
    payload?.conversation_id,
    payload?.conversationId,
  ].filter((candidate) => typeof candidate === 'string' && candidate.trim())
    .map((candidate) => candidate.trim());
}

function eventContainsSessionId(rawEvent, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return false;
  }

  return getEventSessionIdCandidates(rawEvent).some((candidate) => candidate === sessionId);
}

function extractTokenCountPayload(rawEvent) {
  if (!isRecord(rawEvent)) {
    return null;
  }

  if (rawEvent.type === 'event_msg' && isRecord(rawEvent.payload) && rawEvent.payload.type === 'token_count') {
    return rawEvent.payload;
  }

  if (rawEvent.type === 'token_count') {
    return rawEvent;
  }

  return null;
}

function extractTokenCountMetrics(rawEvent, fallbackModelId = null) {
  const payload = extractTokenCountPayload(rawEvent);
  if (!payload) {
    return null;
  }

  const info = isRecord(payload.info) ? payload.info : null;
  const usage = isRecord(info?.last_token_usage)
    ? info.last_token_usage
    : isRecord(payload.last_token_usage)
      ? payload.last_token_usage
      : null;
  const latestContextTokens = normalizeNonNegativeInteger(
    usage?.input_tokens
    ?? usage?.inputTokens,
  );
  const latestContextWindow = normalizePositiveInteger(
    info?.model_context_window
    ?? info?.context_window
    ?? payload.model_context_window
    ?? payload.context_window,
  );

  if (latestContextTokens === null || latestContextWindow === null) {
    return null;
  }

  const modelId = [
    info?.model,
    info?.model_id,
    info?.modelId,
    payload.model,
    payload.model_id,
    payload.modelId,
    rawEvent.model,
    rawEvent.model_id,
    rawEvent.modelId,
    fallbackModelId,
  ].find((candidate) => typeof candidate === 'string' && candidate.trim());

  return {
    latestContextTokens,
    latestContextWindow,
    latestContextModel: typeof modelId === 'string' ? modelId.trim() : null,
    latestContextUpdatedAt: normalizeIsoTimestamp(rawEvent.timestamp)
      ?? normalizeIsoTimestamp(payload.timestamp)
      ?? null,
  };
}

function readBoundedText(filePath, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxFileBytes) {
    return fs.readFileSync(filePath, 'utf8');
  }

  const headBytes = Math.min(512 * 1024, stat.size);
  const tailBytes = Math.min(Math.max(0, maxFileBytes - headBytes), stat.size - headBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(headBytes);
    fs.readSync(fd, head, 0, headBytes, 0);

    const tail = Buffer.alloc(tailBytes);
    fs.readSync(fd, tail, 0, tailBytes, stat.size - tailBytes);

    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    fs.closeSync(fd);
  }
}

function listRecentCodexSessionJsonlFiles({
  sessionsRoot,
  maxFiles = DEFAULT_MAX_SESSION_FILES,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  recentWindowMs = DEFAULT_RECENT_WINDOW_MS,
  nowMs = Date.now(),
} = {}) {
  const root = getCodexSessionsRoot(sessionsRoot);
  if (!fs.existsSync(root)) {
    return [];
  }

  const cutoffMs = nowMs - recentWindowMs;
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  let visitedDirs = 0;

  while (stack.length > 0 && visitedDirs < 2000) {
    const current = stack.pop();
    visitedDirs += 1;

    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 8) {
          stack.push({ dir: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      try {
        const stat = fs.statSync(entryPath);
        if (stat.mtimeMs < cutoffMs) {
          continue;
        }
        files.push({
          filePath: entryPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        // Ignore files that disappear during a concurrent Codex write.
      }
    }
  }

  const boundedMaxFiles = Math.max(1, maxFiles);
  const boundedMaxScanBytes = normalizePositiveInteger(maxScanBytes) ?? DEFAULT_MAX_SCAN_BYTES;
  const selected = [];
  let selectedBytes = 0;

  for (const file of files.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
    if (selected.length >= boundedMaxFiles) {
      break;
    }
    if (selected.length > 0 && selectedBytes >= boundedMaxScanBytes) {
      break;
    }
    selected.push(file);
    selectedBytes += Math.max(0, file.size);
  }

  return selected;
}

function safeParseJsonRecord(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listRecentChatTaskIdsForSession(db, sessionId, maxChatMessages = DEFAULT_MAX_CHAT_MESSAGES) {
  if (!db || typeof sessionId !== 'string' || !sessionId.trim()) {
    return [];
  }

  let rows;
  try {
    rows = db.prepare(`
      SELECT id, role, task_id, metadata
      FROM chat_messages
      WHERE session_id = ?
      ORDER BY datetime(COALESCE(timestamp, created_at, '1970-01-01')) DESC
      LIMIT ?
    `).all(sessionId.trim(), Math.max(1, Math.floor(maxChatMessages)));
  } catch {
    return [];
  }

  const seen = new Set();
  const taskIds = [];
  for (const row of rows) {
    const metadata = safeParseJsonRecord(row?.metadata);
    const messageId = typeof row?.id === 'string' ? row.id.trim() : '';
    const candidates = [
      row?.task_id,
      metadata?.taskId,
      metadata?.curationLogRequestId,
      row?.role === 'user' && messageId ? `chat-queue-${messageId}` : null,
    ].filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim());

    for (const taskId of candidates) {
      if (seen.has(taskId)) {
        continue;
      }
      seen.add(taskId);
      taskIds.push(taskId);
    }
  }

  return taskIds;
}

function readCodexSessionIdsFromTaskLog(taskLogPath, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
  let text;
  try {
    text = readBoundedText(taskLogPath, maxFileBytes);
  } catch {
    return [];
  }

  const seen = new Set();
  const sessionIds = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = safeParseJsonLine(line);
    if (!parsed) {
      continue;
    }

    for (const candidate of getEventSessionIdCandidates(parsed)) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      sessionIds.push(candidate);
    }
  }

  return sessionIds;
}

function listCodexSessionLogIdsFromChatTaskLogs(db, sessionId, {
  taskLogsDir = null,
  maxChatMessages = DEFAULT_MAX_CHAT_MESSAGES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
} = {}) {
  const dataDir = typeof process.env.DATA_DIR === 'string' && process.env.DATA_DIR.trim()
    ? process.env.DATA_DIR.trim()
    : path.join(process.cwd(), 'data');
  const root = typeof taskLogsDir === 'string' && taskLogsDir.trim()
    ? taskLogsDir.trim()
    : path.join(dataDir, 'task-logs');
  const seen = new Set();
  const sessionIds = [];

  for (const taskId of listRecentChatTaskIdsForSession(db, sessionId, maxChatMessages)) {
    const taskLogPath = path.join(root, `${taskId}.jsonl`);
    for (const candidate of readCodexSessionIdsFromTaskLog(taskLogPath, maxFileBytes)) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      sessionIds.push(candidate);
    }
  }

  return sessionIds;
}

function readLatestCodexSessionLogContextMetrics({
  sessionId,
  sessionLogPath = null,
  sessionsRoot = null,
  fallbackModelId = null,
  maxFiles = DEFAULT_MAX_SESSION_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  recentWindowMs = DEFAULT_RECENT_WINDOW_MS,
  nowMs = Date.now(),
} = {}) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) {
    return null;
  }

  const candidateFiles = sessionLogPath
    ? [{ filePath: sessionLogPath, mtimeMs: 0, size: 0 }]
    : listRecentCodexSessionJsonlFiles({ sessionsRoot, maxFiles, maxScanBytes, recentWindowMs, nowMs });

  for (const candidate of candidateFiles) {
    const filePath = candidate.filePath;
    const pathMatchesSession = filePath.includes(normalizedSessionId);
    let text;
    try {
      text = readBoundedText(filePath, maxFileBytes);
    } catch {
      continue;
    }

    let logMatchesSession = pathMatchesSession;
    let latestMetrics = null;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const parsed = safeParseJsonLine(line);
      if (!parsed) {
        continue;
      }

      if (!logMatchesSession && eventContainsSessionId(parsed, normalizedSessionId)) {
        logMatchesSession = true;
      }

      const metrics = extractTokenCountMetrics(parsed, fallbackModelId);
      if (metrics) {
        latestMetrics = metrics;
      }
    }

    if (logMatchesSession && latestMetrics) {
      return {
        ...latestMetrics,
        sessionLogPath: filePath,
      };
    }
  }

  return null;
}

function listCodexSessionsNeedingContextBackfill(db, {
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxSessionAgeMs = DEFAULT_BACKFILL_SESSION_WINDOW_MS,
  nowMs = Date.now(),
} = {}) {
  if (!db) {
    return [];
  }

  const normalizedMaxSessionAgeMs = normalizePositiveInteger(maxSessionAgeMs);
  const cutoffIso = normalizedMaxSessionAgeMs
    ? new Date(nowMs - normalizedMaxSessionAgeMs).toISOString()
    : null;

  return db.prepare(`
    SELECT
      s.id AS sessionId,
      s.provider_session_id AS providerSessionId,
      bs.latest_context_model AS latestContextModel
    FROM chat_sessions AS s
    LEFT JOIN chat_session_brain_settings AS bs
      ON bs.session_id = s.id
    WHERE LOWER(COALESCE(s.provider, '')) = 'codex'
      AND (
        bs.session_id IS NULL
        OR bs.latest_context_tokens IS NULL
        OR bs.latest_context_window IS NULL
      )
      AND (
        ? IS NULL
        OR strftime('%s', COALESCE(s.updated_at, s.created_at, '1970-01-01')) >= strftime('%s', ?)
      )
    ORDER BY datetime(COALESCE(bs.latest_context_updated_at, s.updated_at, s.created_at, '1970-01-01')) DESC
    LIMIT ?
  `).all(cutoffIso, cutoffIso, Math.max(1, Math.floor(maxSessions)));
}

function backfillCodexSessionContextMetrics(db, {
  sessionsRoot = null,
  taskLogsDir = null,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxFiles = DEFAULT_MAX_SESSION_FILES,
  maxChatMessages = DEFAULT_MAX_CHAT_MESSAGES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  maxSessionAgeMs = DEFAULT_BACKFILL_SESSION_WINDOW_MS,
  maxBroadLogSearches = DEFAULT_MAX_BROAD_LOG_SEARCHES,
  recentWindowMs = DEFAULT_RECENT_WINDOW_MS,
  nowMs = Date.now(),
} = {}) {
  const rows = listCodexSessionsNeedingContextBackfill(db, {
    maxSessions,
    maxSessionAgeMs,
    nowMs,
  });
  const updatedSessionIds = [];
  const boundedMaxBroadLogSearches = Math.max(0, Math.floor(maxBroadLogSearches));
  let broadLogSearches = 0;

  for (const row of rows) {
    const providerSessionId = typeof row.providerSessionId === 'string' && row.providerSessionId.trim()
      ? row.providerSessionId.trim()
      : typeof row.sessionId === 'string' && row.sessionId.trim()
        ? row.sessionId.trim()
        : '';
    if (!providerSessionId) {
      continue;
    }

    const candidateSessionIds = [
      ...listCodexSessionLogIdsFromChatTaskLogs(db, row.sessionId, {
        taskLogsDir,
        maxChatMessages,
        maxFileBytes,
      }),
      providerSessionId,
      row.sessionId,
    ].filter((value, index, array) => (
      typeof value === 'string'
      && value.trim()
      && array.indexOf(value) === index
    ));

    let metrics = null;
    for (const candidateSessionId of candidateSessionIds) {
      if (broadLogSearches >= boundedMaxBroadLogSearches) {
        break;
      }
      broadLogSearches += 1;
      metrics = readLatestCodexSessionLogContextMetrics({
        sessionId: candidateSessionId,
        sessionsRoot,
        fallbackModelId: row.latestContextModel,
        maxFiles,
        maxFileBytes,
        maxScanBytes,
        recentWindowMs,
        nowMs,
      });
      if (metrics) {
        break;
      }
    }

    if (!metrics) {
      continue;
    }

    const changed = upsertChatSessionContextMetrics(db, {
      sessionId: row.sessionId,
      latestContextTokens: metrics.latestContextTokens,
      latestContextWindow: metrics.latestContextWindow,
      latestContextModel: metrics.latestContextModel,
      latestContextUpdatedAt: metrics.latestContextUpdatedAt,
    });
    if (changed) {
      updatedSessionIds.push(row.sessionId);
    }
  }

  return updatedSessionIds;
}

module.exports = {
  backfillCodexSessionContextMetrics,
  extractTokenCountMetrics,
  listCodexSessionsNeedingContextBackfill,
  listRecentCodexSessionJsonlFiles,
  readLatestCodexSessionLogContextMetrics,
};
