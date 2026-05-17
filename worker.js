/* eslint-disable @typescript-eslint/no-require-imports */
require('dotenv').config({ path: '.env.local' });

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { request: httpRequest } = require('http');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Worker } = require('bullmq');
const { extractChatProgressFromEvent } = require('./src/lib/chat-progress.js');
const { buildSessionResetHistoryBlock, getRecentChatMessages } = require('./src/lib/chat-session-rehydrate.js');
const { extractStreamingChatTextFromEvent, summarizeStreamingChatEvent } = require('./src/lib/chat-streaming.js');
const { createBrainOrchestrator } = require('./lib/brain-orchestrator');
const { readConfigUsageLevel } = require('./lib/cache-refresh-config');
const { isCurationStatusMissingPidStale } = require('./lib/curation-runtime');
const { upsertChatSessionContextMetrics } = require('./lib/chat-session-context-metrics');
const { buildRuntimeTaskPrompt } = require('./lib/runtime-tasks');
const {
  BACKGROUND_JOB_NAMES,
  BACKGROUND_QUEUE_NAME,
  closeBackgroundQueue,
  createQueueConnection,
  enqueueBackgroundJob,
  hasPendingBackgroundJob,
} = require('./lib/queue');

const port = Number.parseInt(process.env.PORT || '3001', 10);
const internalBaseUrl = process.env.ORCHESTRATOR_INTERNAL_URL || `http://127.0.0.1:${port}`;
const backgroundJobsDisabled = process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS === '1';
const REFLECTION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REFLECTION_MESSAGE = 'Reflection: review recent feedback and consider config suggestions';
const REFLECTION_INTERVAL_MS_BY_FREQUENCY = Object.freeze({
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
});
const DEFAULT_QUIET_HOURS_UTC = Object.freeze([4, 5, 6, 7]);
const EXECUTION_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TASK_TIMEOUT_MS_BY_PRIORITY = Object.freeze({
  user_chat: EXECUTION_TASK_TIMEOUT_MS,
  code_fix_spawn: EXECUTION_TASK_TIMEOUT_MS,
  user_ping: EXECUTION_TASK_TIMEOUT_MS,
  post_enrichment: EXECUTION_TASK_TIMEOUT_MS,
  cache_refresh: EXECUTION_TASK_TIMEOUT_MS,
  reflection: EXECUTION_TASK_TIMEOUT_MS,
});
const PRIORITY_VALUES = Object.freeze({
  user_chat: 400,
  code_fix_spawn: 350,
  user_ping: 300,
  post_enrichment: 200,
  cache_refresh: 150,
  reflection: 50,
});
const PRIORITY_ALIASES = Object.freeze({
  chat: 'user_chat',
  'user-chat': 'user_chat',
  userchat: 'user_chat',
  ping: 'user_ping',
  'user-ping': 'user_ping',
  userping: 'user_ping',
  enrichment: 'post_enrichment',
  enrich: 'post_enrichment',
  'post-enrichment': 'post_enrichment',
  postenrichment: 'post_enrichment',
  cache: 'cache_refresh',
  'cache-refresh': 'cache_refresh',
  cacherefresh: 'cache_refresh',
  reflect: 'reflection',
  code_fix: 'code_fix_spawn',
  codefix: 'code_fix_spawn',
  'code-fix': 'code_fix_spawn',
});
const CLAUDE_SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'CLAUDE.md');
const DEFAULT_CLAUDE_ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS || 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch';
const DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS = process.env.CLAUDE_CURATION_ALLOWED_TOOLS
  || `${DEFAULT_CLAUDE_ALLOWED_TOOLS},Browser,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_tabs,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_fill_form,mcp__playwright__browser_evaluate,mcp__playwright__browser_press_key,mcp__playwright__browser_select_option,mcp__playwright__browser_hover,mcp__playwright__browser_wait_for`;
const DEFAULT_CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'dontAsk';
const MAX_TRANSCRIPT_LINES = 240;
const TASK_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const dataPath = (...segments) => path.join(dataDir, ...segments);
const chatOutputPath = dataPath('chat-output.jsonl');
const CHAT_SESSION_PATH = dataPath('orchestrator-chat-session.json');
const curationStatusPath = dataPath('curation-status.json');
const reflectionStatusPath = dataPath('reflection-status.json');
const pendingWorkerRestartPath = dataPath('pending-worker-restart.json');
const taskLogsDir = dataPath('task-logs');
const defaultDbPath = dataPath('media-agent.db');

let chatStatusDb = null;
let reflectionCheckInFlight = false;
const timerHandles = [];
const workerConnection = createQueueConnection({ forWorker: true });
let backgroundWorker = null;
let pendingWorkerRestartLogged = false;
let idleWorkerRestartInProgress = false;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseTimestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  const ms = parsed.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function parseStatusString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseStatusPid(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeCurationStatus(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  return {
    active: raw.active === true,
    pid: parseStatusPid(raw.pid),
    startedAt: parseStatusString(raw.startedAt),
    completedAt: parseStatusString(raw.completedAt),
    triggerSource: parseStatusString(raw.triggerSource),
    requestId: parseStatusString(raw.requestId),
    phaseTaskId: parseStatusString(raw.phaseTaskId),
    logFile: parseStatusString(raw.logFile),
    phase: parseStatusString(raw.phase),
    phaseDetail: parseStatusString(raw.phaseDetail),
    phaseUpdatedAt: parseStatusString(raw.phaseUpdatedAt),
    deadlineAt: parseStatusString(raw.deadlineAt),
    persistDeadlineAt: parseStatusString(raw.persistDeadlineAt),
    selectionLockedAt: parseStatusString(raw.selectionLockedAt),
    submittedAt: parseStatusString(raw.submittedAt),
    lastFailureAt: parseStatusString(raw.lastFailureAt),
    lastFailurePhase: parseStatusString(raw.lastFailurePhase),
    lastFailureDetail: parseStatusString(raw.lastFailureDetail),
    failedBeforeSubmit: raw.failedBeforeSubmit === true,
    cancelRequestedAt: parseStatusString(raw.cancelRequestedAt),
    cancelRequestedTaskId: parseStatusString(raw.cancelRequestedTaskId),
    cacheSkipRequestedAt: parseStatusString(raw.cacheSkipRequestedAt),
    updatedAt: parseStatusString(raw.updatedAt) || new Date().toISOString(),
  };
}

function readCurationStatus() {
  try {
    const status = normalizeCurationStatus(JSON.parse(fs.readFileSync(curationStatusPath, 'utf8')));
    const hasStalePid = status.active && status.pid && !isPidRunning(status.pid);
    if (hasStalePid || isCurationStatusMissingPidStale(status)) {
      const nextStatus = {
        ...status,
        active: false,
        pid: null,
      };
      writeCurationStatus(nextStatus);
      return normalizeCurationStatus(nextStatus);
    }

    return status;
  } catch {
    return normalizeCurationStatus(null);
  }
}

function writeCurationStatus(status) {
  try {
    fs.mkdirSync(path.dirname(curationStatusPath), { recursive: true });
    fs.writeFileSync(curationStatusPath, JSON.stringify(normalizeCurationStatus({
      ...status,
      updatedAt: new Date().toISOString(),
    }), null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to persist curation status: ${message}`);
  }
}

function ensureCurationStatusFile() {
  if (fs.existsSync(curationStatusPath)) {
    return;
  }

  writeCurationStatus({
    active: false,
    pid: null,
    startedAt: null,
    completedAt: null,
    triggerSource: null,
    requestId: null,
    phaseTaskId: null,
    logFile: null,
    phase: null,
    phaseDetail: null,
    phaseUpdatedAt: null,
    deadlineAt: null,
    persistDeadlineAt: null,
    selectionLockedAt: null,
    submittedAt: null,
    lastFailureAt: null,
    lastFailurePhase: null,
    lastFailureDetail: null,
    failedBeforeSubmit: false,
    cancelRequestedAt: null,
    cancelRequestedTaskId: null,
    cacheSkipRequestedAt: null,
  });
}

function normalizeReflectionStatus(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  return {
    active: raw.active === true,
    pid: parseStatusPid(raw.pid),
    startedAt: parseStatusString(raw.startedAt),
    completedAt: parseStatusString(raw.completedAt),
    lastReflectionAt: parseStatusString(raw.lastReflectionAt),
    lastQueuedAt: parseStatusString(raw.lastQueuedAt),
    triggerSource: parseStatusString(raw.triggerSource),
    requestId: parseStatusString(raw.requestId),
    logFile: parseStatusString(raw.logFile),
    updatedAt: parseStatusString(raw.updatedAt) || new Date().toISOString(),
  };
}

function readStatusFileObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readReflectionStatus() {
  try {
    return normalizeReflectionStatus(JSON.parse(fs.readFileSync(reflectionStatusPath, 'utf8')));
  } catch {
    return normalizeReflectionStatus(null);
  }
}

function readPendingWorkerRestartRequest() {
  try {
    const request = JSON.parse(fs.readFileSync(pendingWorkerRestartPath, 'utf8'));
    return request && typeof request === 'object' && !Array.isArray(request) && request.status === 'pending'
      ? request
      : null;
  } catch {
    return null;
  }
}

function clearPendingWorkerRestartRequest() {
  try {
    fs.rmSync(pendingWorkerRestartPath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to clear pending worker restart request: ${message}`);
  }
}

function isWorkerIdleForRestart(status) {
  return !status?.currentTask
    && status?.isProcessing !== true
    && (!Array.isArray(status?.activeChatTasks) || status.activeChatTasks.length === 0)
    && (!Array.isArray(status?.queued) || status.queued.length === 0)
    && !status?.activeCurationAgent
    && !status?.activeReflectionAgent
    && status?.brain?.working !== true;
}

function writeReflectionStatus(status) {
  try {
    fs.mkdirSync(path.dirname(reflectionStatusPath), { recursive: true });
    const existing = readStatusFileObject(reflectionStatusPath);
    const merged = {
      ...existing,
      ...status,
      updatedAt: new Date().toISOString(),
    };
    const normalized = normalizeReflectionStatus(merged);
    fs.writeFileSync(reflectionStatusPath, JSON.stringify({
      ...merged,
      ...normalized,
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to persist reflection status: ${message}`);
  }
}

function ensureReflectionStatusFile() {
  if (fs.existsSync(reflectionStatusPath)) {
    return;
  }

  writeReflectionStatus({
    active: false,
    pid: null,
    startedAt: null,
    completedAt: null,
    lastReflectionAt: null,
    lastQueuedAt: null,
    triggerSource: null,
    requestId: null,
    logFile: null,
  });
}

function ensureTaskLogsDir() {
  fs.mkdirSync(taskLogsDir, { recursive: true });
}

function cleanupExpiredTaskLogs(nowMs = Date.now()) {
  try {
    ensureTaskLogsDir();
    for (const entry of fs.readdirSync(taskLogsDir, { withFileTypes: true })) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jsonl') {
        continue;
      }

      const filePath = path.join(taskLogsDir, entry.name);
      const stat = fs.statSync(filePath);
      if ((nowMs - stat.mtimeMs) > TASK_LOG_RETENTION_MS) {
        fs.rmSync(filePath, { force: true });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to clean up task logs: ${message}`);
  }
}

function resolveTaskLogFilePath(taskId) {
  return path.join(taskLogsDir, `${taskId}.jsonl`);
}

function assignTaskLogFile(task) {
  if (!task?.id) return null;
  if (typeof task.logFile === 'string' && task.logFile.trim()) {
    return task.logFile;
  }

  const logFile = resolveTaskLogFilePath(task.id);
  task.logFile = logFile;
  return logFile;
}

function normalizePriority(priority) {
  if (typeof priority !== 'string') return 'user_ping';

  const trimmed = priority.trim();
  if (!trimmed) return 'user_ping';

  const lowered = trimmed.toLowerCase();
  const mapped = PRIORITY_ALIASES[lowered] || lowered;
  return Object.hasOwn(PRIORITY_VALUES, mapped) ? mapped : 'user_ping';
}

function sanitizeMessage(message) {
  return typeof message === 'string' ? message.replace(/\r\n/g, '\n').trim() : '';
}

function getDbPath() {
  return process.env.MEDIA_AGENT_DB_PATH || defaultDbPath;
}

function getChatStatusDb() {
  if (!chatStatusDb) {
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    chatStatusDb = new Database(dbPath);
    chatStatusDb.pragma('journal_mode = WAL');
    chatStatusDb.pragma('synchronous = NORMAL');
  }

  return chatStatusDb;
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function getTaskChatMessageId(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  const metadataId = metadata && typeof metadata.chatMessageId === 'string' && metadata.chatMessageId.trim()
    ? metadata.chatMessageId.trim()
    : '';
  if (metadataId) return metadataId;

  const messageText = typeof task?.message === 'string' ? task.message : '';
  const match = messageText.match(/^ChatMessageId:\s*(\S+)/m);
  const parsedId = match?.[1]?.trim() || '';

  return parsedId || null;
}

function getTaskSessionId(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  const sessionId = metadata && typeof metadata.sessionId === 'string' ? metadata.sessionId.trim() : '';
  return sessionId || null;
}

function getTaskProviderSessionId(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  const providerSessionId = metadata && typeof metadata.providerSessionId === 'string'
    ? metadata.providerSessionId.trim()
    : metadata && typeof metadata.claudeSessionId === 'string'
      ? metadata.claudeSessionId.trim()
    : '';
  return isUuid(providerSessionId) ? providerSessionId : null;
}

function readStoredChatProviderSessionId(providerName) {
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_SESSION_PATH, 'utf8'));
    const storedProvider = typeof raw?.provider === 'string' && raw.provider.trim()
      ? raw.provider.trim().toLowerCase()
      : 'claude';
    const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId.trim() : '';
    if (!isUuid(sessionId)) {
      return null;
    }
    return storedProvider === providerName ? sessionId : null;
  } catch {
    return null;
  }
}

function writeStoredChatProviderSessionId(providerName, sessionId) {
  if (typeof providerName !== 'string' || !providerName.trim() || !isUuid(sessionId)) return;

  try {
    fs.mkdirSync(path.dirname(CHAT_SESSION_PATH), { recursive: true });
    fs.writeFileSync(CHAT_SESSION_PATH, JSON.stringify({
      provider: providerName.trim().toLowerCase(),
      sessionId: sessionId.trim(),
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to persist chat session id: ${message}`);
  }
}

function summarizeMessage(message, maxLength = 180) {
  if (!message) return '';
  return message.length <= maxLength ? message : `${message.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stringifyUnknown(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(value, maxLength = 420) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeParseJsonLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractSessionIdFromStreamEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return null;

  const direct = typeof rawEvent.session_id === 'string'
    ? rawEvent.session_id.trim()
    : (typeof rawEvent.sessionId === 'string' ? rawEvent.sessionId.trim() : '');
  if (isUuid(direct)) return direct;

  const sessionObject = rawEvent.session && typeof rawEvent.session === 'object' ? rawEvent.session : null;
  const nested = sessionObject && typeof sessionObject.id === 'string' ? sessionObject.id.trim() : '';
  return isUuid(nested) ? nested : null;
}

function collectAssistantText(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return [];

  if (rawEvent.type === 'stream_event') {
    const streamEvent = rawEvent.event && typeof rawEvent.event === 'object' ? rawEvent.event : null;
    if (!streamEvent) return [];

    if (streamEvent.type === 'content_block_start') {
      const contentBlock = streamEvent.content_block && typeof streamEvent.content_block === 'object'
        ? streamEvent.content_block
        : null;
      return contentBlock?.type === 'text' && typeof contentBlock.text === 'string' ? [contentBlock.text] : [];
    }

    if (streamEvent.type === 'content_block_delta') {
      const delta = streamEvent.delta && typeof streamEvent.delta === 'object' ? streamEvent.delta : null;
      return delta?.type === 'text_delta' && typeof delta.text === 'string' ? [delta.text] : [];
    }

    return [];
  }

  if (rawEvent.type !== 'assistant') return [];

  const message = rawEvent.message && typeof rawEvent.message === 'object' ? rawEvent.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];

  return content
    .map((entry) => entry && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string'
      ? entry.text.trim()
      : '')
    .filter(Boolean);
}

function formatTranscriptLines(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return [];
  }

  if (rawEvent.type === 'assistant') {
    const lines = collectAssistantText(rawEvent).map((text) => truncateText(text, 620));
    const message = rawEvent.message && typeof rawEvent.message === 'object' ? rawEvent.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    for (const entry of content) {
      if (!entry || typeof entry !== 'object' || entry.type !== 'tool_use') continue;
      const toolName = typeof entry.name === 'string' ? entry.name.trim() : 'tool';
      const toolInput = entry.input && typeof entry.input === 'object'
        ? truncateText(stringifyUnknown(entry.input), 420)
        : '';
      lines.push(toolInput ? `tool ${toolName}: ${toolInput}` : `tool ${toolName}`);
    }

    return lines;
  }

  if (rawEvent.type === 'user') {
    const message = rawEvent.message && typeof rawEvent.message === 'object' ? rawEvent.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    return content
      .filter((entry) => entry && typeof entry === 'object' && entry.type === 'tool_result')
      .map((entry) => {
        const toolResult = truncateText(stringifyUnknown(entry.content), 420);
        return entry.is_error
          ? (toolResult ? `tool error: ${toolResult}` : 'tool error')
          : (toolResult ? `tool result: ${toolResult}` : 'tool result');
      });
  }

  if (rawEvent.type === 'result') {
    const resultText = truncateText(stringifyUnknown(rawEvent.result), 620);
    return [resultText ? `completed: ${resultText}` : 'completed'];
  }

  if (rawEvent.type === 'system') {
    const subtype = typeof rawEvent.subtype === 'string' ? rawEvent.subtype.trim() : '';
    return subtype ? [`system: ${subtype}`] : [];
  }

  return [];
}

function extractFinalResultText(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return '';
  return rawEvent.type === 'result' ? truncateText(stringifyUnknown(rawEvent.result), 5000) : '';
}

function buildTaskPrompt(task) {
  const resolvedTaskMessage = buildRuntimeTaskPrompt(task, {
    rootDir: process.cwd(),
    dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
    internalBaseUrl,
  });

  return [
    'You are an ephemeral Evogent task. Complete this task and exit.',
    `Task ID: ${task.id}`,
    `Priority: ${task.priority}`,
    `Source: ${task.source}`,
    `Timestamp (UTC): ${task.enqueuedAt || new Date().toISOString()}`,
    resolvedTaskMessage,
  ].join('\n\n');
}

function sanitizeChatEventText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

function normalizeAgentEventMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const normalized = { ...metadata };
  if (typeof normalized.agent_id === 'string' && !normalized.agentId) normalized.agentId = normalized.agent_id;
  if (typeof normalized.log_file === 'string' && !normalized.logFile) normalized.logFile = normalized.log_file;
  if (typeof normalized.task_id === 'string' && !normalized.taskId) normalized.taskId = normalized.task_id;
  if (normalized.has_transcript === true && normalized.hasTranscript !== true) normalized.hasTranscript = true;
  delete normalized.agent_id;
  delete normalized.log_file;
  delete normalized.task_id;
  delete normalized.has_transcript;
  return normalized;
}

async function appendAgentEventToChatOutput({
  id,
  text,
  sessionId = null,
  metadata = null,
}) {
  const normalizedText = sanitizeChatEventText(text);
  if (!normalizedText) return;

  const payload = {
    id: typeof id === 'string' && id.trim() ? id.trim() : `chat-${randomUUID()}`,
    role: 'assistant',
    type: 'agent_event',
    text: normalizedText,
    timestamp: new Date().toISOString(),
    ...(isUuid(sessionId) ? { sessionId: sessionId.trim() } : {}),
  };

  const normalizedMetadata = normalizeAgentEventMetadata(metadata);
  const payloadMetadata = normalizedMetadata
    ? { ...normalizedMetadata }
    : {};
  if (isUuid(sessionId)) {
    payloadMetadata.sessionId = sessionId.trim();
  }
  if (Object.keys(payloadMetadata).length > 0) {
    payload.metadata = payloadMetadata;
  }

  await fs.promises.mkdir(path.dirname(chatOutputPath), { recursive: true });
  await fs.promises.appendFile(chatOutputPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function postInternal(pathname, payload, { signal } = {}) {
  const target = new URL(pathname, internalBaseUrl);
  const requestBody = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = httpRequest(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        abortHandler?.();

        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Internal POST ${pathname} failed (${response.statusCode || 0}) ${responseBody}`));
          return;
        }

        if (!responseBody.trim()) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(responseBody));
        } catch {
          resolve({});
        }
      });
    });

    request.on('error', (error) => {
      abortHandler?.();
      reject(error);
    });

    let abortHandler = null;
    if (signal) {
      const handleAbort = () => {
        request.destroy(signal.reason instanceof Error ? signal.reason : new Error('This operation was aborted'));
      };

      if (signal.aborted) {
        handleAbort();
        return;
      }

      signal.addEventListener('abort', handleAbort, { once: true });
      abortHandler = () => {
        signal.removeEventListener('abort', handleAbort);
      };
    }

    request.write(requestBody);
    request.end();
  });
}

async function postAgentProgress(payload, trigger = 'progress') {
  try {
    await postInternal('/api/internal/agent-progress', {
      ...payload,
      trigger,
      ts: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] agent progress delivery failed: ${message}`);
  }
}

const CHAT_NOTIFY_THROTTLE_MS = 100;
let pendingChatNotifyItems = [];
let pendingChatNotifyEvents = [];
let pendingChatNotifyTimer = null;
let lastChatNotifyPostAt = 0;

function queueChatNotifyUpdate({ items = null, event = null } = {}) {
  if (Array.isArray(items) && items.length > 0) {
    pendingChatNotifyItems.push(...items);
  }

  if (event && typeof event === 'object') {
    pendingChatNotifyEvents.push(event);
  }

  if (pendingChatNotifyTimer) {
    return;
  }

  const delayMs = Math.max(0, CHAT_NOTIFY_THROTTLE_MS - (Date.now() - lastChatNotifyPostAt));
  pendingChatNotifyTimer = setTimeout(() => {
    pendingChatNotifyTimer = null;
    void flushChatNotifyQueue();
  }, delayMs);

  if (typeof pendingChatNotifyTimer.unref === 'function') {
    pendingChatNotifyTimer.unref();
  }
}

async function flushChatNotifyQueue() {
  if (pendingChatNotifyItems.length === 0 && pendingChatNotifyEvents.length === 0) {
    return;
  }

  const items = pendingChatNotifyItems.splice(0);
  const events = pendingChatNotifyEvents.splice(0);
  lastChatNotifyPostAt = Date.now();

  try {
    await postInternal('/api/internal/chat-notify', {
      ...(items.length > 0 ? { items } : {}),
      ...(events.length > 0 ? { events } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] chat notify delivery failed: ${message}`);
  }
}

async function postOrchestratorStatus(status, trigger, event = null) {
  try {
    await postInternal('/api/internal/orchestrator-status', {
      status,
      trigger,
      event,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] orchestrator status delivery failed: ${message}`);
  }
}

function isCurationTask() {
  return false;
}

function resolveBackgroundTaskKind(task) {
  if (task?.priority === 'reflection') {
    return 'reflection';
  }

  return null;
}

function resolveTaskTimeoutMs(task) {
  if (Number.isInteger(task?.timeoutMs) && task.timeoutMs > 0) {
    return Math.min(task.timeoutMs, EXECUTION_TASK_TIMEOUT_MS);
  }

  const priorityTimeout = TASK_TIMEOUT_MS_BY_PRIORITY[task?.priority];
  if (typeof priorityTimeout === 'number' && priorityTimeout > 0) {
    return priorityTimeout;
  }

  return 5 * 60 * 1000;
}

function isUnitTestTask(task) {
  const source = typeof task?.source === 'string' ? task.source : '';
  const message = typeof task?.message === 'string' ? task.message : '';
  return source.startsWith('unit-test')
    || message.startsWith('[unit]');
}

function readUsageLevel() {
  return readConfigUsageLevel(dataPath('config.md'));
}

function getReflectionIntervalConfig() {
  const usageLevel = readUsageLevel();
  const reflectionFrequency = usageLevel === 'low' ? 'weekly' : 'daily';
  const minIntervalMs = REFLECTION_INTERVAL_MS_BY_FREQUENCY[reflectionFrequency];

  return {
    usageLevel,
    reflectionFrequency,
    minIntervalMs,
    minIntervalHours: Math.round(minIntervalMs / (60 * 60 * 1000)),
  };
}

function sanitizeReflectionTriggerSource(triggeredBy) {
  if (typeof triggeredBy !== 'string') {
    return 'adaptive_reflection';
  }

  const trimmed = triggeredBy.trim();
  if (!trimmed) return 'adaptive_reflection';
  return `adaptive_reflection:${trimmed}`.slice(0, 96);
}

function getQuietHours() {
  let db = null;

  try {
    db = new Database(getDbPath(), { readonly: true });
    const rows = db.prepare('SELECT event, timestamp FROM user_activity ORDER BY timestamp DESC LIMIT 1000').all();
    if (rows.length < 20) {
      return [...DEFAULT_QUIET_HOURS_UTC];
    }

    const hourlyCounts = Array(24).fill(0);
    const activityWeights = {
      app_open: 2,
      pull_refresh: 3,
      ping: 2,
      foreground: 2,
      background: 1,
    };

    for (const row of rows) {
      const date = new Date(row.timestamp);
      if (Number.isNaN(date.getTime())) continue;
      hourlyCounts[date.getUTCHours()] += activityWeights[row.event] || 1;
    }

    return hourlyCounts
      .map((count, hour) => ({ hour, count }))
      .sort((left, right) => left.count - right.count)
      .slice(0, 4)
      .map((entry) => entry.hour);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to compute quiet hours: ${message}`);
    return [...DEFAULT_QUIET_HOURS_UTC];
  } finally {
    db?.close();
  }
}

function getProviderSessionIdForChatSession(sessionId, providerName) {
  if (!isUuid(sessionId) || typeof providerName !== 'string' || !providerName.trim()) {
    return null;
  }

  try {
    const db = getChatStatusDb();
    const row = db.prepare(`
      SELECT provider, provider_session_id, claude_session_id
      FROM chat_sessions
      WHERE id = ?
    `).get(sessionId) || null;
    const normalizedProvider = typeof row?.provider === 'string' && row.provider.trim()
      ? row.provider.trim().toLowerCase()
      : 'claude';
    const providerSessionId = typeof row?.provider_session_id === 'string' ? row.provider_session_id.trim() : '';
    const fallbackClaudeSessionId = typeof row?.claude_session_id === 'string' ? row.claude_session_id.trim() : '';

    if (normalizedProvider === providerName && isUuid(providerSessionId)) {
      return providerSessionId;
    }

    if (providerName === 'claude' && isUuid(fallbackClaudeSessionId)) {
      return fallbackClaudeSessionId;
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to resolve chat session ID (${sessionId}): ${message}`);
    return null;
  }
}

function updateChatSessionProviderSessionId(sessionId, providerName, providerSessionId) {
  if (!isUuid(sessionId) || typeof providerName !== 'string' || !providerName.trim() || !isUuid(providerSessionId)) {
    return false;
  }

  try {
    const db = getChatStatusDb();
    const result = db.prepare(`
      UPDATE chat_sessions
      SET
        provider = ?,
        provider_session_id = ?,
        claude_session_id = CASE
          WHEN ? = 'claude' THEN ?
          ELSE claude_session_id
        END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(providerName, providerSessionId, providerName, providerSessionId, sessionId);
    return result.changes > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to update chat session ID (${sessionId}): ${message}`);
    return false;
  }
}

function updateChatSessionContextMetrics(sessionIdOrInput, metricsInput = {}) {
  const sessionId = typeof sessionIdOrInput === 'object' && sessionIdOrInput !== null
    ? sessionIdOrInput.sessionId
    : sessionIdOrInput;
  const metrics = typeof sessionIdOrInput === 'object' && sessionIdOrInput !== null
    ? sessionIdOrInput
    : metricsInput;
  const {
    latestContextTokens,
    latestContextWindow = null,
    latestContextModel = null,
    latestContextUpdatedAt = null,
  } = metrics;

  if (!isUuid(sessionId)) {
    return false;
  }

  try {
    const db = getChatStatusDb();
    return upsertChatSessionContextMetrics(db, {
      sessionId,
      latestContextTokens,
      latestContextWindow,
      latestContextModel,
      latestContextUpdatedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to update chat session context metrics (${sessionId}): ${message}`);
    return false;
  }
}

function markChatMessageCancelledIfQueued(chatMessageId) {
  if (typeof chatMessageId !== 'string' || !chatMessageId.trim()) {
    return false;
  }

  try {
    const db = getChatStatusDb();
    const result = db.prepare(`
      UPDATE chat_messages
      SET status = 'cancelled'
      WHERE id = ?
        AND status IN ('pending', 'queued')
    `).run(chatMessageId.trim());
    return result.changes > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to mark chat message cancelled (${chatMessageId}): ${message}`);
    return false;
  }
}

function markChatMessageDeliveredIfPendingOrQueued(chatMessageId) {
  if (typeof chatMessageId !== 'string' || !chatMessageId.trim()) {
    return false;
  }

  try {
    const db = getChatStatusDb();
    const result = db.prepare(`
      UPDATE chat_messages
      SET status = 'delivered'
      WHERE id = ?
        AND status IN ('pending', 'queued')
    `).run(chatMessageId.trim());
    return result.changes > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to mark chat message delivered (${chatMessageId}): ${message}`);
    return false;
  }
}

function markChatMessageFailedIfPendingOrQueued(chatMessageId) {
  if (typeof chatMessageId !== 'string' || !chatMessageId.trim()) {
    return false;
  }

  try {
    const db = getChatStatusDb();
    const result = db.prepare(`
      UPDATE chat_messages
      SET status = 'failed'
      WHERE id = ?
        AND status IN ('pending', 'queued', 'processing')
    `).run(chatMessageId.trim());
    return result.changes > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to mark chat message failed (${chatMessageId}): ${message}`);
    return false;
  }
}

function markChatMessageProcessing(chatMessageId) {
  if (typeof chatMessageId !== 'string' || !chatMessageId.trim()) {
    return false;
  }

  try {
    const db = getChatStatusDb();
    const result = db.prepare(`
      UPDATE chat_messages
      SET status = 'processing'
      WHERE id = ?
        AND status IN ('pending', 'queued')
    `).run(chatMessageId.trim());
    return result.changes > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to mark chat message processing (${chatMessageId}): ${message}`);
    return false;
  }
}

function isChatResearchSource(source) {
  return typeof source === 'string' && source.trim() === 'chat_research';
}

function extractResearchTopic(message) {
  if (typeof message !== 'string') return 'requested topic';

  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'requested topic';

  const patterns = [
    /Research and write a comprehensive analysis post about\s+(.+?)\.\s+Submit\b/i,
    /analysis post about\s+(.+?)(?:\.\s+Submit\b|$)/i,
    /Researching\s+(.+?)(?:\s+[-—]\s+|$)/i,
  ];

  for (const pattern of patterns) {
    const topic = normalized.match(pattern)?.[1]
      ?.trim()
      .replace(/^["'[]+/, '')
      .replace(/["'\]]+$/, '')
      .trim();
    if (topic) {
      return truncateText(topic, 180);
    }
  }

  return truncateText(normalized, 180) || 'requested topic';
}

function extractAcceptedFeedItemId(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  const acceptedIdsMatch = value.match(/"acceptedIds"\s*:\s*\[\s*"([^"]+)"/i);
  if (acceptedIdsMatch?.[1]) {
    return acceptedIdsMatch[1].trim();
  }

  const acceptedIdMatch = value.match(/"acceptedId"\s*:\s*"([^"]+)"/i);
  if (acceptedIdMatch?.[1]) {
    return acceptedIdMatch[1].trim();
  }

  return null;
}

function resolveResearchFeedItemId(transcriptLines, responseText) {
  const candidates = [];
  if (typeof responseText === 'string' && responseText.trim()) {
    candidates.push(responseText);
  }
  if (Array.isArray(transcriptLines)) {
    for (let index = transcriptLines.length - 1; index >= 0; index -= 1) {
      candidates.push(transcriptLines[index]);
    }
  }

  for (const candidate of candidates) {
    const feedItemId = extractAcceptedFeedItemId(candidate);
    if (feedItemId) {
      return feedItemId;
    }
  }

  return null;
}

function broadcastChatProgress(activity, tool, inReplyTo) {
  if (typeof activity !== 'string' || !activity.trim()) {
    return;
  }

  queueChatNotifyUpdate({
    event: {
      type: 'chat_progress',
      activity: activity.trim(),
      tool: typeof tool === 'string' && tool.trim() ? tool.trim() : 'Working',
      inReplyTo: inReplyTo || null,
    },
  });
}

function broadcastChatResearchStatus(type, {
  taskId,
  topic,
  timestamp,
  feedItemId = null,
  error = null,
} = {}) {
  if (
    (type !== 'research_started' && type !== 'research_completed' && type !== 'research_failed')
    || typeof taskId !== 'string'
    || !taskId.trim()
  ) {
    return;
  }

  const payload = {
    type,
    taskId: taskId.trim(),
    timestamp: typeof timestamp === 'string' && timestamp.trim() ? timestamp.trim() : new Date().toISOString(),
  };

  if (type === 'research_started') {
    payload.topic = typeof topic === 'string' && topic.trim() ? topic.trim() : 'requested topic';
  }

  if (type === 'research_completed') {
    payload.feedItemId = typeof feedItemId === 'string' && feedItemId.trim() ? feedItemId.trim() : null;
  }

  if (type === 'research_failed' && typeof error === 'string' && error.trim()) {
    payload.error = error.trim();
  }

  queueChatNotifyUpdate({ event: payload });
}

function broadcastChatSessionReset(reason, newSessionId, sessionId = null) {
  if (typeof reason !== 'string' || !reason.trim() || !isUuid(newSessionId)) {
    return;
  }

  queueChatNotifyUpdate({
    event: {
      type: 'session_reset',
      reason: reason.trim(),
      newSessionId: newSessionId.trim(),
      sessionId: isUuid(sessionId) ? sessionId.trim() : null,
    },
  });
}

function broadcastChatStreaming(text, inReplyTo) {
  queueChatNotifyUpdate({
    event: {
      type: 'chat_streaming',
      text: typeof text === 'string' ? text : '',
      inReplyTo: inReplyTo || null,
    },
  });
}

function broadcastChatTyping(typing) {
  queueChatNotifyUpdate({
    event: {
      type: 'chat_typing',
      typing: Boolean(typing),
    },
  });
}

function broadcastChatUpdate(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  queueChatNotifyUpdate({ items });
}

function isBackgroundRoutedCommand() {
  return false;
}

function isFreshAssistantStreamingSignal(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object' || rawEvent.type !== 'stream_event') {
    return false;
  }

  const streamEvent = rawEvent.event && typeof rawEvent.event === 'object'
    ? rawEvent.event
    : null;
  if (!streamEvent) {
    return false;
  }

  if (streamEvent.type === 'content_block_start') {
    const contentBlock = streamEvent.content_block && typeof streamEvent.content_block === 'object'
      ? streamEvent.content_block
      : null;
    return contentBlock?.type === 'tool_use' || contentBlock?.type === 'thinking';
  }

  if (streamEvent.type === 'content_block_delta') {
    const delta = streamEvent.delta && typeof streamEvent.delta === 'object'
      ? streamEvent.delta
      : null;
    return delta?.type === 'input_json_delta' || delta?.type === 'thinking_delta';
  }

  return false;
}

function extractSlashCommandName(message) {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

const BrainOrchestrator = createBrainOrchestrator({
  CLAUDE_SYSTEM_PROMPT_PATH,
  DEFAULT_CLAUDE_ALLOWED_TOOLS,
  DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  MAX_TRANSCRIPT_LINES,
  PRIORITY_VALUES,
  TASK_TIMEOUT_MS_BY_PRIORITY,
  appendAgentEventToChatOutput,
  assignTaskLogFile,
  broadcastChatProgress,
  broadcastChatResearchStatus,
  broadcastChatSessionLifecycle(type, payload = {}) {
    if (type !== 'chat_session_updated') {
      return;
    }

    void postInternal('/api/internal/chat-session-broadcast', {
      type,
      sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
      nextSessionId: typeof payload.nextSessionId === 'string' ? payload.nextSessionId : null,
      error: typeof payload.error === 'string' ? payload.error : null,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[worker] failed to broadcast chat session update: ${message}`);
    });
  },
  broadcastChatSessionReset,
  broadcastChatStreaming,
  broadcastChatTyping,
  broadcastChatUpdate,
  buildSessionResetHistoryBlock,
  buildTaskPrompt,
  chatOutputPath,
  cleanupExpiredTaskLogs,
  collectAssistantText,
  dataPath,
  delay,
  ensureCurationStatusFile,
  ensureReflectionStatusFile,
  ensureTaskLogsDir,
  extractChatProgressFromEvent,
  extractFinalResultText,
  extractResearchTopic,
  extractSessionIdFromStreamEvent,
  extractSlashCommandName,
  extractStreamingChatTextFromEvent,
  formatTranscriptLines,
  fs,
  getChatStatusDb,
  getProviderSessionIdForChatSession,
  getRecentChatMessages,
  getTaskChatMessageId,
  getTaskProviderSessionId,
  getTaskSessionId,
  isBackgroundRoutedCommand,
  isChatResearchSource,
  isCurationTask,
  isFreshAssistantStreamingSignal,
  isPidRunning,
  isUnitTestTask,
  isUuid,
  markChatMessageCancelledIfQueued,
  markChatMessageDeliveredIfPendingOrQueued,
  markChatMessageFailedIfPendingOrQueued,
  markChatMessageProcessing,
  normalizePriority,
  path,
  postInternal,
  randomUUID,
  readCurationStatus,
  readReflectionStatus,
  readStoredChatProviderSessionId,
  resolveBackgroundTaskKind,
  resolveResearchFeedItemId,
  resolveTaskTimeoutMs,
  safeParseJsonLine,
  sanitizeMessage,
  spawn,
  stringifyUnknown,
  summarizeMessage,
  summarizeStreamingChatEvent,
  truncateText,
  updateChatSessionContextMetrics,
  updateChatSessionProviderSessionId,
  writeCurationStatus,
  writeReflectionStatus,
  writeStoredChatProviderSessionId,
});

const backgroundOrchestrator = new BrainOrchestrator('evogent-background-worker');

async function maybeApplyPendingWorkerRestart(trigger = 'status') {
  if (idleWorkerRestartInProgress || shuttingDown) {
    return;
  }

  const request = readPendingWorkerRestartRequest();
  if (!request) {
    pendingWorkerRestartLogged = false;
    return;
  }

  const drainResult = await backgroundOrchestrator.prepareForWorkerRestart();
  if (
    drainResult.finalizedCompletedCacheRefresh > 0
    || drainResult.failedCacheRefresh > 0
    || drainResult.removedQueuedCacheRefresh > 0
  ) {
    console.log('[worker] drained cache-refresh work for pending worker restart', drainResult);
  }

  const status = backgroundOrchestrator.getStatus();
  if (!isWorkerIdleForRestart(status)) {
    if (!pendingWorkerRestartLogged) {
      pendingWorkerRestartLogged = true;
      console.log('[worker] worker restart deferred until idle', {
        trigger,
        currentTask: status.currentTask?.id || null,
        activeChatTasks: Array.isArray(status.activeChatTasks) ? status.activeChatTasks.length : 0,
        queued: Array.isArray(status.queued) ? status.queued.length : 0,
      });
    }
    return;
  }

  idleWorkerRestartInProgress = true;
  console.log('[worker] applying deferred worker restart now that worker is idle', {
    trigger,
    requestedAt: typeof request.requestedAt === 'string' ? request.requestedAt : null,
    commit: typeof request.commit === 'string' ? request.commit : null,
  });

  try {
    if (backgroundWorker) {
      await backgroundWorker.close();
      backgroundWorker = null;
    }

    const postCloseStatus = backgroundOrchestrator.getStatus();
    if (!isWorkerIdleForRestart(postCloseStatus)) {
      idleWorkerRestartInProgress = false;
      console.log('[worker] worker restart deferred until idle', {
        trigger: `${trigger}:post-close-active`,
        currentTask: postCloseStatus.currentTask?.id || null,
      });
      return;
    }

    clearPendingWorkerRestartRequest();
    await shutdown('idle-worker-restart');
  } catch (error) {
    idleWorkerRestartInProgress = false;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] failed to apply deferred worker restart: ${message}`);
  }
}

backgroundOrchestrator.onStatus((status, trigger, event) => {
  void postOrchestratorStatus(status, trigger, event);
  void maybeApplyPendingWorkerRestart(`orchestrator:${trigger}`);
});

async function runReflectionSchedulerCheck(triggeredBy = 'timer') {
  if (reflectionCheckInFlight) return;
  reflectionCheckInFlight = true;

  try {
    const reflectionConfig = getReflectionIntervalConfig();
    let status = readReflectionStatus();
    const now = Date.now();

    if (status.active && status.pid && !isPidRunning(status.pid)) {
      status = {
        ...status,
        active: false,
        pid: null,
      };
      writeReflectionStatus(status);
    }

    if (status.active || await hasPendingBackgroundJob(BACKGROUND_JOB_NAMES.REFLECTION)) {
      return;
    }

    const lastReflectionMs = parseTimestampMs(status.lastReflectionAt)
      ?? parseTimestampMs(status.completedAt)
      ?? parseTimestampMs(status.startedAt);

    if (lastReflectionMs !== null && (now - lastReflectionMs) < reflectionConfig.minIntervalMs) {
      return;
    }

    const quietHours = getQuietHours();
    if (!quietHours.includes(new Date().getUTCHours())) {
      return;
    }

    const requestId = randomUUID();
    const enqueueResult = await enqueueBackgroundJob(BACKGROUND_JOB_NAMES.REFLECTION, {
      requestId,
      message: REFLECTION_MESSAGE,
      priority: 'reflection',
      source: sanitizeReflectionTriggerSource(triggeredBy),
      metadata: {
        triggerSource: triggeredBy,
        usageLevel: reflectionConfig.usageLevel,
        reflectionFrequency: reflectionConfig.reflectionFrequency,
        minIntervalHours: reflectionConfig.minIntervalHours,
        lastReflectionAt: status.lastReflectionAt || null,
      },
    }, {
      jobId: requestId,
      skipIfPending: true,
    });

    if (enqueueResult.duplicate) {
      return;
    }

    const queuedAt = new Date().toISOString();
    writeReflectionStatus({
      ...status,
      lastQueuedAt: queuedAt,
      triggerSource: typeof triggeredBy === 'string' ? triggeredBy : 'timer',
      requestId,
    });

    console.log(`[adaptive-reflection] queued reflection task ${requestId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[adaptive-reflection] check failed: ${message}`);
  } finally {
    reflectionCheckInFlight = false;
  }
}

async function runReflectionTimerTick(triggeredBy = 'timer') {
  await runReflectionSchedulerCheck(triggeredBy);
}

function createBackgroundWorker() {
  const worker = new Worker(BACKGROUND_QUEUE_NAME, async (job) => {
    if (
      job.name === BACKGROUND_JOB_NAMES.USER_CHAT
      || job.name === BACKGROUND_JOB_NAMES.POST_ENRICHMENT
      || job.name === BACKGROUND_JOB_NAMES.CACHE_REFRESH
    ) {
      const enqueueResult = backgroundOrchestrator.enqueue(job.data);
      if (!enqueueResult?.ok) {
        throw new Error(enqueueResult?.error || `Failed to enqueue ${job.name} task`);
      }
      if (typeof enqueueResult.requestId !== 'string' || !enqueueResult.requestId.trim()) {
        throw new Error(`Failed to resolve orchestrator task id for ${job.name} job ${job.id}`);
      }
      const completedTask = await backgroundOrchestrator.waitForTaskCompletion(enqueueResult.requestId);
      return {
        ...enqueueResult,
        completedAt: completedTask.completedAt || null,
        state: completedTask.state,
      };
    }

    if (job.name === BACKGROUND_JOB_NAMES.REFLECTION) {
      return backgroundOrchestrator.runBackgroundTask(job.data);
    }

    if (job.name === BACKGROUND_JOB_NAMES.CONFIG_APPLY) {
      return postInternal('/api/internal/config-apply-tasks/execute', {
        task: job.data?.task,
      });
    }

    throw new Error(`Unsupported background job: ${job.name}`);
  }, {
    autorun: false,
    connection: workerConnection,
    concurrency: 8,
    removeOnComplete: {
      count: 100,
    },
    removeOnFail: {
      count: 100,
    },
  });

  worker.on('completed', (job) => {
    console.log(`[worker] completed ${job.name} job ${job.id}`);
    void maybeApplyPendingWorkerRestart(`job_completed:${job.name}`);
  });

  worker.on('failed', (job, error) => {
    const jobLabel = job ? `${job.name} job ${job.id}` : 'unknown job';
    console.warn(`[worker] failed ${jobLabel}: ${error?.message || error}`);
    void maybeApplyPendingWorkerRestart(job ? `job_failed:${job.name}` : 'job_failed');
  });

  worker.on('error', (error) => {
    console.error(`[worker] BullMQ worker error: ${error.message}`);
  });

  return worker;
}

function resetStaleCurationStatusOnStartup() {
  const status = readCurationStatus();
  if (!status.active) {
    return false;
  }

  writeCurationStatus({
    ...status,
    active: false,
    pid: null,
    completedAt: status.completedAt || new Date().toISOString(),
  });
  return true;
}

async function runStartupStateCleanup() {
  if (resetStaleCurationStatusOnStartup()) {
    console.log('[worker] reset stale curation-status.json before startup');
  }
}

async function start() {
  ensureCurationStatusFile();
  ensureReflectionStatusFile();
  ensureTaskLogsDir();
  cleanupExpiredTaskLogs();

  getChatStatusDb();
  await runStartupStateCleanup();

  if (!backgroundJobsDisabled) {
    backgroundWorker = createBackgroundWorker();
    void backgroundWorker.run().catch((error) => {
      if (shuttingDown) {
        return;
      }
      console.error(`[worker] BullMQ worker run failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const pendingWorkerRestartTimer = setInterval(() => {
    void maybeApplyPendingWorkerRestart('timer');
  }, 15_000);
  if (typeof pendingWorkerRestartTimer.unref === 'function') pendingWorkerRestartTimer.unref();
  timerHandles.push(pendingWorkerRestartTimer);
  void maybeApplyPendingWorkerRestart('startup');

  if (backgroundJobsDisabled) {
    console.log('> Background worker timers disabled by MEDIA_AGENT_DISABLE_BACKGROUND_JOBS=1');
    return;
  }

  await runReflectionTimerTick('startup');

  const reflectionTimer = setInterval(() => {
    void runReflectionTimerTick('timer');
  }, REFLECTION_CHECK_INTERVAL_MS);
  if (typeof reflectionTimer.unref === 'function') reflectionTimer.unref();
  timerHandles.push(reflectionTimer);

  console.log('> Reflection timer enabled in worker (quiet-hour scheduling)');
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[worker] shutting down (${signal})`);
  for (const timer of timerHandles) {
    clearInterval(timer);
  }

  try {
    if (backgroundWorker) {
      await backgroundWorker.close();
      backgroundWorker = null;
    }
  } catch (error) {
    console.warn(`[worker] failed to close BullMQ worker: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await closeBackgroundQueue();
  } catch (error) {
    console.warn(`[worker] failed to close BullMQ producer queue: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await workerConnection.quit();
  } catch (error) {
    console.warn(`[worker] failed to close Redis worker connection: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (chatStatusDb) {
    chatStatusDb.close();
    chatStatusDb = null;
  }

  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

void start().catch((error) => {
  console.error(`[worker] startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
