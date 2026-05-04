/* eslint-disable @typescript-eslint/no-require-imports */
require('dotenv').config({ path: '.env.local' });

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const { createServer, request: httpRequest } = require('http');
const Database = require('better-sqlite3');
const next = require('next');
const { WebSocketServer } = require('ws');
const { isVisibleRecentRestartState } = require('./lib/restart-state-visibility');
const { getRuntimeDeploymentSnapshot } = require('./lib/runtime-deployment');
const { extractChatProgressFromEvent } = require('./src/lib/chat-progress.js');
const { buildSessionResetHistoryBlock, getRecentChatMessages } = require('./src/lib/chat-session-rehydrate.js');
const { extractStreamingChatTextFromEvent, summarizeStreamingChatEvent } = require('./src/lib/chat-streaming.js');
const { regeneratePreferenceContext } = require('./src/lib/preferences-context-runtime.js');
const { failStaleQueuedChatMessages } = require('./lib/chat-message-cleanup.js');
const { createBrainOrchestrator } = require('./lib/brain-orchestrator');
const { resolveBrainProviderByName } = require('./lib/brain-provider');
const { dispatchCodeFixSuggestionsInBackground } = require('./lib/code-fix-dispatch');
const { isCurationStatusMissingPidStale } = require('./lib/curation-runtime');
const { buildRuntimeTaskPrompt } = require('./lib/runtime-tasks');
const { upsertChatSessionContextMetrics } = require('./lib/chat-session-context-metrics');
const { stopDevAgentUnit } = require('./lib/agent-self-orchestrate');
const {
  BACKGROUND_JOB_NAMES,
  enqueueBackgroundJob,
  hasPendingBackgroundJob,
  hasPendingCacheRefreshJob,
} = require('./lib/queue');
const {
  markFailedBatchEnrichmentItems,
} = require('./lib/batch-enrichment-finalizer');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '3001', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const internalBaseUrl = process.env.ORCHESTRATOR_INTERNAL_URL || `http://127.0.0.1:${port}`;
const backgroundJobsDisabled = process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS === '1';
const trustNetwork = process.env.MEDIA_AGENT_TRUST_NETWORK === '1' || process.env.MEDIA_AGENT_TRUST_NETWORK === 'true';
const cloudflareAccessTeamDomain = normalizeCloudflareAccessTeamDomain(process.env.MEDIA_AGENT_CF_ACCESS_TEAM_DOMAIN);
const cloudflareAccessIssuer = cloudflareAccessTeamDomain ? `https://${cloudflareAccessTeamDomain}` : '';
const cloudflareAccessAudience = normalizeOptionalEnv(process.env.MEDIA_AGENT_CF_ACCESS_AUD);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const evogentStateDir = process.env.MEDIA_AGENT_STATE_DIR || path.join(__dirname, 'data', 'agent-state');
const dataPath = (...segments) => path.join(dataDir, ...segments);
const curationStatusPath = dataPath('curation-status.json');
const reflectionStatusPath = dataPath('reflection-status.json');
const pendingRestartPath = dataPath('pending-restart.json');
const pendingWorkerRestartPath = dataPath('pending-worker-restart.json');
const restartStatePath = dataPath('restart-state.json');
const EXECUTION_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RESTART_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const WEB_RESTART_SERVICE_UNIT = 'evogent.service';
const WORKER_RESTART_SERVICE_UNIT = 'evogent-worker.service';
const TASK_TIMEOUT_MS_BY_PRIORITY = Object.freeze({
  user_chat: EXECUTION_TASK_TIMEOUT_MS,
  code_fix_spawn: EXECUTION_TASK_TIMEOUT_MS,
  user_ping: EXECUTION_TASK_TIMEOUT_MS,
  post_enrichment: EXECUTION_TASK_TIMEOUT_MS,
  cache_refresh: EXECUTION_TASK_TIMEOUT_MS,
  heartbeat: EXECUTION_TASK_TIMEOUT_MS,
  reflection: EXECUTION_TASK_TIMEOUT_MS,
});
const CLAUDE_SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'CLAUDE.md');
const CHAT_SESSION_PATH = dataPath('orchestrator-chat-session.json');
const DEFAULT_CLAUDE_ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS || 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch';
const DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS = process.env.CLAUDE_CURATION_ALLOWED_TOOLS
  || `${DEFAULT_CLAUDE_ALLOWED_TOOLS},Browser,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_tabs,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_fill_form,mcp__playwright__browser_evaluate,mcp__playwright__browser_press_key,mcp__playwright__browser_select_option,mcp__playwright__browser_hover,mcp__playwright__browser_wait_for`;
const DEFAULT_CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'dontAsk';
const MAX_TRANSCRIPT_LINES = 240;
const TASK_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const taskLogsDir = dataPath('task-logs');
const defaultDbPath = dataPath('media-agent.db');
const runtimeDeploymentSnapshot = getRuntimeDeploymentSnapshot();
let chatStatusDb = null;
let cloudflareAccessJwks = null;
let joseImportPromise = null;
let lastCloudflareAccessJwtWarningAt = 0;

/** @typedef {'user_chat' | 'user_ping' | 'code_fix_spawn' | 'post_enrichment' | 'cache_refresh' | 'heartbeat' | 'reflection'} OrchestratorPriority */

const PRIORITY_VALUES = Object.freeze({
  user_chat: 400,
  code_fix_spawn: 350,
  user_ping: 300,
  post_enrichment: 200,
  cache_refresh: 150,
  heartbeat: 100,
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
  hb: 'heartbeat',
  reflect: 'reflection',
  code_fix: 'code_fix_spawn',
  codefix: 'code_fix_spawn',
  'code-fix': 'code_fix_spawn',
});

/**
 * @typedef {Object} QueueTask
 * @property {string} id
 * @property {number} sequence
 * @property {string} source
 * @property {string} message
 * @property {OrchestratorPriority} priority
 * @property {number} priorityValue
 * @property {number | null | undefined} timeoutMs
 * @property {Record<string, unknown> | null} metadata
 * @property {'queued' | 'processing' | 'completed' | 'failed'} state
 * @property {string} enqueuedAt
 * @property {string | null} startedAt
 * @property {string | null} sentAt
 * @property {string | null} completedAt
 * @property {string | null} error
 * @property {string | null} response
 * @property {string | null} paneTail
 * @property {string | null} logFile
 */

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildRestartServicesCommand() {
  return `systemctl restart ${WEB_RESTART_SERVICE_UNIT}`;
}

function buildCodeFixTaskSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

function buildCodeFixTaskIdFromSuggestion(suggestion) {
  const slugSource = typeof suggestion?.title === 'string' && suggestion.title.trim()
    ? suggestion.title.trim()
    : typeof suggestion?.proposedValue === 'string'
      ? suggestion.proposedValue.trim()
      : '';
  const slug = buildCodeFixTaskSlug(slugSource) || 'suggestion';
  return `fix-${slug}-${Date.now()}`;
}

function normalizeCodeFixCancelSuggestionStatus(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return [
    'pending',
    'accepted',
    'dismissed',
    'dispatched',
    'running',
    'merged',
    'failed',
  ].includes(normalized)
    ? normalized
    : 'pending';
}

function getCodeFixCancelTargets(db, { suggestionId, taskId }) {
  const clauses = [];
  const values = [];
  if (suggestionId) {
    clauses.push('t.suggestion_id = ?');
    values.push(suggestionId);
  }
  if (taskId) {
    clauses.push('t.task_id = ?');
    values.push(taskId);
  }
  if (clauses.length === 0) {
    return [];
  }

  return db.prepare(`
    SELECT
      t.task_id AS taskId,
      t.suggestion_id AS suggestionId,
      f.origin_session_id AS originSessionId
    FROM code_fix_tasks AS t
    LEFT JOIN feed AS f ON f.id = t.suggestion_id
    WHERE t.status IN ('dispatched', 'running')
      AND (${clauses.join(' OR ')})
    ORDER BY t.id ASC
  `).all(...values);
}

function resolveCodeFixRepoDirForOriginSession(db, originSessionId) {
  const trimmedOriginSessionId = typeof originSessionId === 'string' ? originSessionId.trim() : '';
  if (!trimmedOriginSessionId) return process.cwd();

  const row = db.prepare(`
    SELECT working_directory AS workingDirectory
    FROM chat_sessions
    WHERE id = ?
    LIMIT 1
  `).get(trimmedOriginSessionId);
  if (!row) return process.cwd();

  const workingDirectory = typeof row.workingDirectory === 'string' ? row.workingDirectory.trim() : '';
  return workingDirectory || process.cwd();
}

function dispatchCodeFixSuggestionsForResolvedRepos(suggestions, { db, internalBaseUrl: resolvedInternalBaseUrl }) {
  const groupsByRepoDir = new Map();
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    const repoDir = resolveCodeFixRepoDirForOriginSession(db, suggestion?.originSessionId);
    const group = groupsByRepoDir.get(repoDir) || [];
    group.push(suggestion);
    groupsByRepoDir.set(repoDir, group);
  }

  for (const [repoDir, group] of groupsByRepoDir.entries()) {
    dispatchCodeFixSuggestionsInBackground(group, {
      repoDir,
      internalBaseUrl: resolvedInternalBaseUrl,
    });
  }
}

function cleanupCodeFixTaskGitState(taskId, repoDir) {
  const trimmedRepoDir = typeof repoDir === 'string' ? repoDir.trim() : '';
  if (!trimmedRepoDir) {
    console.warn(`[code-fix-cancel] skipping git cleanup for ${taskId}: missing repoDir`);
    return;
  }

  const worktreesRoot = path.resolve(`${trimmedRepoDir}-worktrees`);
  const worktreePath = path.resolve(worktreesRoot, taskId);
  if (!worktreePath.startsWith(`${worktreesRoot}${path.sep}`)) {
    console.warn(`[code-fix-cancel] refusing to remove worktree outside ${worktreesRoot}: ${worktreePath}`);
    return;
  }

  console.log(`[code-fix-cancel] cleaning git state for ${taskId} in ${trimmedRepoDir}: ${worktreePath}`);
  try {
    execFileSync('git', ['-C', trimmedRepoDir, 'worktree', 'remove', '--force', worktreePath], {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch (error) {
    const output = [
      error?.stdout,
      error?.stderr,
      error instanceof Error ? error.message : String(error),
    ].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
    if (!/not a working tree|no such file|not found/i.test(output)) {
      console.warn(`[code-fix-cancel] git worktree remove failed for ${worktreePath}: ${output}`);
    }
  }

  try {
    execFileSync('git', ['-C', trimmedRepoDir, 'branch', '-D', taskId], {
      stdio: 'pipe',
      timeout: 15_000,
    });
  } catch (error) {
    const output = [
      error?.stdout,
      error?.stderr,
      error instanceof Error ? error.message : String(error),
    ].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
    if (!/branch .* not found|not found|not a valid branch name/i.test(output)) {
      console.warn(`[code-fix-cancel] git branch delete failed for ${taskId}: ${output}`);
    }
  }
}

function buildCodeFixCancellationChatMessage({ taskId, suggestionId, title, reason, suggestionStatus }) {
  const suggestionLabel = title ? ` (${title})` : '';
  return [
    `Code-fix task ${taskId} was cancelled for suggestion ${suggestionId}${suggestionLabel}.`,
    `Reason: ${reason || 'Cancelled by request'}.`,
    `The suggestion is now ${suggestionStatus}.`,
  ].join('\n');
}

async function postCodeFixCancellationChatNote({ db, taskId, suggestionId, reason, suggestionStatus }) {
  let row = null;
  try {
    row = db.prepare(`
      SELECT title, metadata, origin_session_id AS originSessionId
      FROM feed
      WHERE id = ?
      LIMIT 1
    `).get(suggestionId) || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[code-fix-cancel] failed to resolve feed row for ${suggestionId}: ${message}`);
    return;
  }

  if (!row) return;

  let metadata = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }

  const originSessionId = typeof row.originSessionId === 'string' && row.originSessionId.trim()
    ? row.originSessionId.trim()
    : typeof metadata.originSessionId === 'string' && metadata.originSessionId.trim()
      ? metadata.originSessionId.trim()
      : '';
  if (!originSessionId) return;

  const title = typeof row.title === 'string' ? row.title : '';
  try {
    await postInternal('/api/internal/chat/submit', {
      type: 'chat',
      text: buildCodeFixCancellationChatMessage({ taskId, suggestionId, title, reason, suggestionStatus }),
      sessionId: originSessionId,
      taskId,
      metadata: {
        source: 'code_fix_cancelled',
        taskId,
        suggestionId,
        status: 'cancelled',
        phase: 'cancelled',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[code-fix-cancel] failed to post chat cancellation note for ${taskId}: ${message}`);
  }
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
    console.warn(`[orchestrator] failed to clean up task logs: ${message}`);
  }
}

function retireOrphanedQueuedChatMessagesOnStartup() {
  try {
    const changes = failStaleQueuedChatMessages(getChatStatusDb());
    if (changes > 0) {
      console.warn(`[chat-cleanup] Marked ${changes} stale queued chat message${changes === 1 ? '' : 's'} as failed on startup`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[chat-cleanup] Failed to retire stale queued chat messages: ${message}`);
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

function appendTaskLogEntry(logFile, entry) {
  if (typeof logFile !== 'string' || !logFile.trim() || !entry || typeof entry !== 'object') {
    return false;
  }

  try {
    ensureTaskLogsDir();
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, '', 'utf8');
    }
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orchestrator] failed to append task log entry: ${message}`);
    return false;
  }
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
    const raw = fs.readFileSync(curationStatusPath, 'utf8');
    const status = normalizeCurationStatus(JSON.parse(raw));
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
    const existing = readStatusFileObject(curationStatusPath);
    const merged = {
      ...existing,
      ...status,
      updatedAt: new Date().toISOString(),
    };
    const normalized = normalizeCurationStatus(merged);
    fs.writeFileSync(curationStatusPath, JSON.stringify({
      ...merged,
      ...normalized,
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orchestrator] failed to persist curation status: ${message}`);
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeRestartState(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalizedStatus = parseStatusString(raw.status);
  const status = normalizedStatus === 'pending'
    || normalizedStatus === 'applying'
    || normalizedStatus === 'restarting'
    || normalizedStatus === 'consumed'
    || normalizedStatus === 'failed'
    ? normalizedStatus
    : 'pending';

  return {
    status,
    commit: parseStatusString(raw.commit),
    commitFull: parseStatusString(raw.commitFull),
    summary: parseStatusString(raw.summary) || 'Code update',
    pendingSource: parseStatusString(raw.pendingSource) || 'post-merge-hook',
    mergedAt: parseStatusString(raw.mergedAt),
    pendingAt: parseStatusString(raw.pendingAt),
    applyRequestedAt: parseStatusString(raw.applyRequestedAt),
    buildStartedAt: parseStatusString(raw.buildStartedAt),
    buildCompletedAt: parseStatusString(raw.buildCompletedAt),
    restartCommandAt: parseStatusString(raw.restartCommandAt),
    workerRestartStatus: parseStatusString(raw.workerRestartStatus),
    workerRestartRequestedAt: parseStatusString(raw.workerRestartRequestedAt),
    serviceReadyAt: parseStatusString(raw.serviceReadyAt),
    requestedBy: parseStatusString(raw.requestedBy),
    triggerSource: parseStatusString(raw.triggerSource),
    requestReferer: parseStatusString(raw.requestReferer),
    requestUserAgent: parseStatusString(raw.requestUserAgent),
    requestRemoteAddress: parseStatusString(raw.requestRemoteAddress),
    requestForwardedFor: parseStatusString(raw.requestForwardedFor),
    error: parseStatusString(raw.error),
    lastUpdatedAt: parseStatusString(raw.lastUpdatedAt) || new Date().toISOString(),
  };
}

function readPendingRestartFlag() {
  if (!fs.existsSync(pendingRestartPath)) {
    return null;
  }

  const raw = readJsonFile(pendingRestartPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  return {
    commit: parseStatusString(raw.commit),
    commitFull: parseStatusString(raw.commitFull),
    summary: parseStatusString(raw.summary) || 'Code update',
    mergedAt: parseStatusString(raw.mergedAt),
    pendingAt: parseStatusString(raw.pendingAt) || parseStatusString(raw.mergedAt),
    pendingSource: parseStatusString(raw.pendingSource) || 'post-merge-hook',
  };
}

function readRestartState() {
  const raw = readJsonFile(restartStatePath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  return normalizeRestartState(raw);
}

function writeRestartState(state) {
  const normalized = normalizeRestartState(state);
  writeJsonFile(restartStatePath, normalized);
  return normalized;
}

function writePendingWorkerRestartRequest({ restartState, requester, requestedAt }) {
  const request = {
    status: 'pending',
    reason: 'apply-restart',
    requestedAt,
    requestedBy: requester.requestedBy,
    triggerSource: requester.triggerSource,
    commit: restartState.commit || null,
    commitFull: restartState.commitFull || null,
    summary: restartState.summary || 'Code update',
  };
  writeJsonFile(pendingWorkerRestartPath, request);
  return request;
}

function buildPendingRestartState(flag, previousState) {
  return normalizeRestartState({
    ...previousState,
    status: 'pending',
    commit: flag.commit || previousState?.commit || null,
    commitFull: flag.commitFull || previousState?.commitFull || null,
    summary: flag.summary || previousState?.summary || 'Code update',
    pendingSource: flag.pendingSource || previousState?.pendingSource || 'post-merge-hook',
    mergedAt: flag.mergedAt || previousState?.mergedAt || null,
    pendingAt: flag.pendingAt || previousState?.pendingAt || flag.mergedAt || null,
    error: null,
    lastUpdatedAt: new Date().toISOString(),
  });
}

function getVisibleRestartState(nowMs = Date.now()) {
  const flag = readPendingRestartFlag();
  const storedState = readRestartState();

  if (flag) {
    const pendingState = buildPendingRestartState(flag, storedState);
    if (!storedState || JSON.stringify(storedState) !== JSON.stringify(pendingState)) {
      writeRestartState(pendingState);
    }
    return pendingState;
  }

  if (!storedState) {
    return null;
  }

  if (storedState.status === 'pending') {
    return null;
  }

  if (isVisibleRecentRestartState(storedState, nowMs)) {
    return storedState;
  }

  return null;
}

function getDeploymentStatus(nowMs = Date.now()) {
  return {
    running: { ...runtimeDeploymentSnapshot },
    pendingRestart: getVisibleRestartState(nowMs),
  };
}

function getRestartRequester(req, body) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const requestedBy = parseStatusString(payload.requestedBy)
    || parseStatusString(req.headers['x-requested-by'])
    || 'unknown';
  const triggerSource = parseStatusString(payload.triggerSource)
    || parseStatusString(req.headers['x-restart-source'])
    || 'unknown';
  const referer = parseStatusString(req.headers.referer);
  const userAgent = parseStatusString(req.headers['user-agent']);
  const forwardedFor = parseStatusString(req.headers['x-forwarded-for']);
  const remoteAddress = parseStatusString(req.socket?.remoteAddress);

  return {
    requestedBy,
    triggerSource,
    referer,
    userAgent,
    forwardedFor,
    remoteAddress,
  };
}

function markRestartStateReadyOnStartup() {
  const state = readRestartState();
  if (!state) {
    return;
  }

  if (state.status !== 'applying' && state.status !== 'restarting') {
    return;
  }

  writeRestartState({
    ...state,
    status: 'consumed',
    serviceReadyAt: state.serviceReadyAt || new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  });
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
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function readReflectionStatus() {
  try {
    const raw = fs.readFileSync(reflectionStatusPath, 'utf8');
    return normalizeReflectionStatus(JSON.parse(raw));
  } catch {
    return normalizeReflectionStatus(null);
  }
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
    console.warn(`[adaptive-reflection] failed to persist reflection status: ${message}`);
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

function normalizeOptionalEnv(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCloudflareAccessTeamDomain(value) {
  const trimmed = normalizeOptionalEnv(value);
  if (!trimmed) return '';

  return trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function hasCloudflareForwardedHeaders(req) {
  return Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

function hasCloudflareAccessHeaderPresence(req) {
  return Boolean(
    req.headers['cf-access-jwt-assertion'] ||
      req.headers['cf-access-authenticated-user-email']
  );
}

function getHeaderString(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim());
    return first ? first.trim() : '';
  }

  return typeof value === 'string' ? value.trim() : '';
}

async function loadJose() {
  joseImportPromise ||= import('jose');
  return joseImportPromise;
}

async function fetchCloudflareAccessJwks(url, options) {
  const response = await fetch(url, options);

  if (response.status === 429 || response.status >= 500) {
    const error = new Error(`Cloudflare Access JWKS temporarily unavailable (HTTP ${response.status})`);
    error.code = 'EVOGENT_CF_ACCESS_JWKS_TRANSIENT';
    throw error;
  }

  return response;
}

async function getCloudflareAccessJwks() {
  if (!cloudflareAccessJwks) {
    const { createRemoteJWKSet, customFetch } = await loadJose();
    cloudflareAccessJwks = createRemoteJWKSet(
      new URL(`https://${cloudflareAccessTeamDomain}/cdn-cgi/access/certs`),
      {
        cacheMaxAge: 60 * 60 * 1000,
        timeoutDuration: 5000,
        [customFetch]: fetchCloudflareAccessJwks,
      }
    );
  }

  return cloudflareAccessJwks;
}

function getCloudflareAccessJwtVerifyOptions() {
  const options = {
    issuer: cloudflareAccessIssuer,
    clockTolerance: 60,
    requiredClaims: ['exp'],
  };

  if (cloudflareAccessAudience) {
    options.audience = cloudflareAccessAudience;
  }

  return options;
}

function isCloudflareAccessJwksRefreshError(error) {
  return Boolean(error && (
    error.code === 'ERR_JWKS_NO_MATCHING_KEY' ||
      error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'
  ));
}

function isCloudflareAccessJwksTransientError(error) {
  return Boolean(error && (
    error.code === 'EVOGENT_CF_ACCESS_JWKS_TRANSIENT' ||
      error.code === 'ERR_JWKS_TIMEOUT' ||
      error instanceof TypeError
  ));
}

function logCloudflareAccessJwtWarning(reason, error) {
  const now = Date.now();
  if (now - lastCloudflareAccessJwtWarningAt < 60 * 1000) {
    return;
  }

  lastCloudflareAccessJwtWarningAt = now;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`> Evogent Cloudflare Access JWT verification ${reason}: ${message}`);
}

async function verifyCloudflareAccessJwt(assertion) {
  const { jwtVerify } = await loadJose();
  const verifyOptions = getCloudflareAccessJwtVerifyOptions();
  const jwks = await getCloudflareAccessJwks();

  try {
    await jwtVerify(assertion, jwks, verifyOptions);
  } catch (error) {
    if (!isCloudflareAccessJwksRefreshError(error)) {
      throw error;
    }

    cloudflareAccessJwks = null;
    const refreshedJwks = await getCloudflareAccessJwks();

    try {
      await jwtVerify(assertion, refreshedJwks, verifyOptions);
    } catch (refreshError) {
      if (isCloudflareAccessJwksTransientError(refreshError)) {
        throw error;
      }
      throw refreshError;
    }
  }
}

async function hasCloudflareAccessIdentity(req) {
  if (!cloudflareAccessTeamDomain) {
    return hasCloudflareAccessHeaderPresence(req);
  }

  const assertion = getHeaderString(req, 'cf-access-jwt-assertion');
  if (!assertion) {
    return false;
  }

  try {
    await verifyCloudflareAccessJwt(assertion);
    return true;
  } catch (error) {
    if (isCloudflareAccessJwksTransientError(error)) {
      logCloudflareAccessJwtWarning('temporarily unavailable; falling back to header presence', error);
      return hasCloudflareAccessHeaderPresence(req);
    }

    logCloudflareAccessJwtWarning('failed; treating request as anonymous', error);
    return false;
  }
}

async function isTrustedSocket(req) {
  if (hasCloudflareForwardedHeaders(req)) {
    // Trust Cloudflare tunnel traffic only after Access authenticated the user.
    // Bypass-policy traffic does not carry these headers, so it still uses the
    // public read allowlist.
    return hasCloudflareAccessIdentity(req);
  }
  return isLocalRequest(req);
}

function isPublicReadPath(method, pathname) {
  if (pathname === '/ws/feed') return true;
  if (method !== 'GET' && method !== 'HEAD') return false;

  if (!pathname.startsWith('/api/') && !pathname.startsWith('/ws/')) return true;
  if (pathname === '/api/feed' || pathname.startsWith('/api/feed/')) return true;
  if (pathname === '/api/threads' || pathname.startsWith('/api/threads/')) return true;
  if (pathname === '/api/setup-readiness' || pathname === '/api/status' || pathname === '/api/ping') return true;
  if (pathname === '/api/brain-provider' || pathname === '/api/commands' || pathname === '/api/skills') return true;
  if (pathname === '/api/activity') return true;
  if (pathname === '/api/chat/messages' || pathname === '/api/chat/sessions') return true;

  return false;
}

function normalizePriority(priority) {
  if (typeof priority !== 'string') return 'heartbeat';

  const trimmed = priority.trim();
  if (!trimmed) return 'heartbeat';

  const lowered = trimmed.toLowerCase();
  const mapped = PRIORITY_ALIASES[lowered] || lowered;

  if (Object.hasOwn(PRIORITY_VALUES, mapped)) {
    return /** @type {OrchestratorPriority} */ (mapped);
  }

  return 'heartbeat';
}

function sanitizeMessage(message) {
  if (typeof message !== 'string') return '';
  return message.replace(/\r\n/g, '\n').trim();
}

function getDbPath() {
  return process.env.MEDIA_AGENT_DB_PATH || defaultDbPath;
}

function ensureCurationLogCompletionColumns(db) {
  for (const stmt of [
    'ALTER TABLE curation_log ADD COLUMN completion_status TEXT',
    'ALTER TABLE curation_log ADD COLUMN completion_reason TEXT',
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // SQLite throws if the table is absent or the column already exists.
    }
  }
}

function getChatStatusDb() {
  if (!chatStatusDb) {
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    chatStatusDb = new Database(dbPath);
    chatStatusDb.pragma('journal_mode = WAL');
    chatStatusDb.pragma('synchronous = NORMAL');
    ensureCurationLogCompletionColumns(chatStatusDb);
  }

  return chatStatusDb;
}

function isCuratorCurationLifecycleEvent(event) {
  return event
    && typeof event === 'object'
    && event.curationCommand === '/curate'
    && typeof event.curationLogRequestId === 'string'
    && event.curationLogRequestId.trim();
}

function insertCurationLogForTaskStart(event) {
  if (!isCuratorCurationLifecycleEvent(event)) {
    return false;
  }

  try {
    const db = getChatStatusDb();
    const feedCountBefore = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM feed').get() || {}).count || 0,
    );
    db.prepare(`
      INSERT OR IGNORE INTO curation_log (request_id, triggered_by, started_at, feed_count_before)
      VALUES (?, ?, ?, ?)
    `).run(
      event.curationLogRequestId.trim(),
      typeof event.curationTriggeredBy === 'string' && event.curationTriggeredBy.trim()
        ? event.curationTriggeredBy.trim()
        : 'curator_chat',
      new Date().toISOString(),
      feedCountBefore,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[curation-log] Failed to insert curation start for ${event.curationLogRequestId}: ${message}`);
    return false;
  }
}

function getCurationTaskChatStatus(db, event) {
  const chatMessageId = typeof event?.chatMessageId === 'string' && event.chatMessageId.trim()
    ? event.chatMessageId.trim()
    : null;
  if (!chatMessageId) {
    return null;
  }

  try {
    const row = db.prepare(`
      SELECT status
      FROM chat_messages
      WHERE id = ?
      LIMIT 1
    `).get(chatMessageId) || null;
    return typeof row?.status === 'string' && row.status.trim()
      ? row.status.trim().toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function classifyCurationLogCompletion({ event, chatStatus, itemsAdded }) {
  if (itemsAdded > 0) {
    return {
      status: 'success',
      reason: null,
    };
  }

  if (chatStatus === 'cancelled') {
    return {
      status: 'cancelled',
      reason: 'chat message was cancelled before curation output',
    };
  }

  if (chatStatus === 'failed') {
    return {
      status: 'failed',
      reason: 'chat message failed before curation output',
    };
  }

  const taskState = typeof event?.state === 'string' ? event.state.trim().toLowerCase() : '';
  const taskError = typeof event?.error === 'string' && event.error.trim()
    ? event.error.trim()
    : null;

  if (taskState === 'failed') {
    return {
      status: 'failed',
      reason: taskError || 'task failed before curation output',
    };
  }

  if (taskError && /abort|cancel/i.test(taskError)) {
    return {
      status: 'aborted',
      reason: taskError,
    };
  }

  return {
    status: 'empty',
    reason: 'task completed without feed output',
  };
}

function completeCurationLogForTask(event) {
  if (!isCuratorCurationLifecycleEvent(event)) {
    return false;
  }

  try {
    const db = getChatStatusDb();
    const row = db.prepare(`
      SELECT completed_at, feed_count_before
      FROM curation_log
      WHERE request_id = ?
      LIMIT 1
    `).get(event.curationLogRequestId.trim()) || null;

    if (!row || row.completed_at) {
      return false;
    }

    const feedCount = Number((db.prepare('SELECT COUNT(*) AS count FROM feed').get() || {}).count || 0);
    const baseline = Number.isFinite(row.feed_count_before) ? Number(row.feed_count_before) : 0;
    const itemsAdded = Math.max(0, feedCount - baseline);
    const completion = classifyCurationLogCompletion({
      event,
      chatStatus: getCurationTaskChatStatus(db, event),
      itemsAdded,
    });

    db.prepare(`
      UPDATE curation_log
      SET completed_at = ?, items_added = ?, completion_status = ?, completion_reason = ?
      WHERE request_id = ?
    `).run(
      new Date().toISOString(),
      itemsAdded,
      completion.status,
      completion.reason,
      event.curationLogRequestId.trim(),
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[curation-log] Failed to complete curation ${event.curationLogRequestId}: ${message}`);
    return false;
  }
}

function upsertCodeFixTaskRow(db, {
  suggestionId,
  taskId,
  status,
  phase = undefined,
  phaseDetail = undefined,
  error = undefined,
  completedAt = undefined,
}) {
  const sets = ['status = excluded.status'];
  if (phase !== undefined) sets.push('phase = excluded.phase');
  if (phaseDetail !== undefined) sets.push('phase_detail = excluded.phase_detail');
  if (error !== undefined) sets.push('error = excluded.error');
  if (completedAt !== undefined) sets.push('completed_at = excluded.completed_at');
  if (status === 'queued' || status === 'dispatched' || status === 'running') {
    sets.push('completed_at = NULL');
  }

  db.prepare(`
    INSERT INTO code_fix_tasks (
      suggestion_id,
      task_id,
      status,
      phase,
      phase_detail,
      completed_at,
      error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(suggestion_id, task_id) DO UPDATE SET
      ${sets.join(', ')}
  `).run(
    suggestionId,
    taskId,
    status,
    phase ?? null,
    phaseDetail ?? null,
    completedAt ?? null,
    error ?? null,
  );
}

function updateCodeFixTaskRowByTaskId(db, taskId, {
  status = undefined,
  phase = undefined,
  phaseDetail = undefined,
  error = undefined,
  completedAt = undefined,
}) {
  const sets = [];
  const values = [];

  if (status !== undefined) {
    sets.push('status = ?');
    values.push(status);
    if (status === 'queued' || status === 'dispatched' || status === 'running') {
      sets.push('completed_at = NULL');
    }
  }
  if (phase !== undefined) {
    sets.push('phase = ?');
    values.push(phase);
  }
  if (phaseDetail !== undefined) {
    sets.push('phase_detail = ?');
    values.push(phaseDetail);
  }
  if (error !== undefined) {
    sets.push('error = ?');
    values.push(error);
  }
  if (completedAt !== undefined) {
    sets.push('completed_at = ?');
    values.push(completedAt);
  }

  if (sets.length === 0) {
    return 0;
  }

  values.push(taskId);
  const result = db.prepare(`UPDATE code_fix_tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...values);
  return result.changes;
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
  const sessionId = metadata && typeof metadata.sessionId === 'string' && metadata.sessionId.trim()
    ? metadata.sessionId.trim()
    : '';
  if (sessionId) return sessionId;

  const messageText = typeof task?.message === 'string' ? task.message : '';
  const match = messageText.match(/^SessionId:\s*(\S+)/m);
  const parsedId = match?.[1]?.trim() || '';

  return parsedId || null;
}

function getTaskProviderSessionId(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  const providerSessionId = metadata && typeof metadata.providerSessionId === 'string' && metadata.providerSessionId.trim()
    ? metadata.providerSessionId.trim()
    : metadata && typeof metadata.claudeSessionId === 'string' && metadata.claudeSessionId.trim()
      ? metadata.claudeSessionId.trim()
    : '';
  return isUuid(providerSessionId) ? providerSessionId : null;
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
    console.warn(`[orchestrator] Failed to resolve chat session ID (${sessionId}): ${message}`);
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
    console.warn(`[orchestrator] Failed to update chat session ID (${sessionId}): ${message}`);
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
    console.warn(`[orchestrator] Failed to update chat session context metrics (${sessionId}): ${message}`);
    return false;
  }
}

function getChatSessionRuntimeInfo(sessionId) {
  if (!isUuid(sessionId)) {
    return null;
  }

  try {
    const db = getChatStatusDb();
    const row = db.prepare(`
      SELECT
        id,
        provider,
        provider_session_id,
        claude_session_id,
        working_directory,
        bs.latest_context_window AS latest_context_window,
        bs.latest_context_model AS latest_context_model
      FROM chat_sessions AS s
      LEFT JOIN chat_session_brain_settings AS bs
        ON bs.session_id = s.id
      WHERE s.id = ?
    `).get(sessionId) || null;

    if (!row) {
      return null;
    }

    const provider = typeof row.provider === 'string' && row.provider.trim()
      ? row.provider.trim().toLowerCase()
      : 'claude';
    const providerSessionId = typeof row.provider_session_id === 'string' && row.provider_session_id.trim()
      ? row.provider_session_id.trim()
      : typeof row.claude_session_id === 'string' && row.claude_session_id.trim()
        ? row.claude_session_id.trim()
        : null;

    return {
      sessionId,
      provider,
      providerSessionId: isUuid(providerSessionId) ? providerSessionId : null,
      workingDirectory: typeof row.working_directory === 'string' && row.working_directory.trim()
        ? row.working_directory.trim()
        : process.cwd(),
      latestContextWindow: Number.isFinite(row.latest_context_window) ? Number(row.latest_context_window) : null,
      latestContextModel: typeof row.latest_context_model === 'string' && row.latest_context_model.trim()
        ? row.latest_context_model.trim()
        : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orchestrator] Failed to read chat session runtime info (${sessionId}): ${message}`);
    return null;
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
        AND status IN ('pending', 'queued', 'processing')
    `).run(chatMessageId.trim());
    return result.changes > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orchestrator] Failed to mark chat message delivered (${chatMessageId}): ${message}`);
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
    console.warn(`[orchestrator] Failed to mark chat message cancelled (${chatMessageId}): ${message}`);
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
    console.warn(`[orchestrator] Failed to mark chat message failed (${chatMessageId}): ${message}`);
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
    console.warn(`[orchestrator] Failed to mark chat message processing (${chatMessageId}): ${message}`);
    return false;
  }
}

function summarizeMessage(message, maxLength = 180) {
  if (!message) return '';
  if (message.length <= maxLength) return message;
  return `${message.slice(0, Math.max(0, maxLength - 3))}...`;
}

function sanitizeChatEventText(text) {
  if (typeof text !== 'string') return '';
  return text.trim();
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

function normalizeAgentEventMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const normalized = { ...metadata };

  const agentId = typeof normalized.agentId === 'string' && normalized.agentId.trim()
    ? normalized.agentId.trim()
    : typeof normalized.agent_id === 'string' && normalized.agent_id.trim()
      ? normalized.agent_id.trim()
      : null;
  const logFile = typeof normalized.logFile === 'string' && normalized.logFile.trim()
    ? normalized.logFile.trim()
    : typeof normalized.log_file === 'string' && normalized.log_file.trim()
      ? normalized.log_file.trim()
      : null;
  const taskId = typeof normalized.taskId === 'string' && normalized.taskId.trim()
    ? normalized.taskId.trim()
    : typeof normalized.task_id === 'string' && normalized.task_id.trim()
      ? normalized.task_id.trim()
      : null;
  const event = typeof normalized.event === 'string' && normalized.event.trim()
    ? normalized.event.trim()
    : null;
  const status = typeof normalized.status === 'string' && normalized.status.trim()
    ? normalized.status.trim()
    : null;
  const hasTranscript = normalized.hasTranscript === true || normalized.has_transcript === true;

  if (agentId) normalized.agentId = agentId;
  if (logFile) normalized.logFile = logFile;
  if (taskId) normalized.taskId = taskId;
  if (event) normalized.event = event;
  if (status) normalized.status = status;
  if (hasTranscript) normalized.hasTranscript = true;

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

  try {
    const response = await fetch(`${internalBaseUrl}/api/internal/chat/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body || 'failed to submit chat agent event'}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orchestrator] Failed to submit agent event chat output: ${message}`);
  }
}

function isUuid(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function readStoredChatProviderSessionId(providerName) {
  try {
    const raw = fs.readFileSync(CHAT_SESSION_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const storedProvider = typeof parsed?.provider === 'string' && parsed.provider.trim()
      ? parsed.provider.trim().toLowerCase()
      : 'claude';
    const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId.trim() : '';
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
    console.warn(`[orchestrator] failed to persist chat session id: ${message}`);
  }
}

function isCurationInstruction(message) {
  if (typeof message !== 'string') return false;
  const normalized = message.trim().toLowerCase();
  return normalized === '/curate'
    || normalized.startsWith('/curate ')
    || normalized === '/curate-latest'
    || normalized.startsWith('/curate-latest ')
    || normalized.startsWith('heartbeat:')
    || normalized.includes('curation cycle');
}

function resolveTaskTimeoutMs(task) {
  if (Number.isInteger(task?.timeoutMs) && task.timeoutMs > 0) {
    return Math.min(task.timeoutMs, TASK_TIMEOUT_MS_BY_PRIORITY.heartbeat);
  }

  if (task?.source === 'chat_research' || task?.source === 'chat_background_routing') {
    return TASK_TIMEOUT_MS_BY_PRIORITY.heartbeat;
  }

  const priorityTimeout = TASK_TIMEOUT_MS_BY_PRIORITY[task.priority];
  if (typeof priorityTimeout === 'number' && Number.isFinite(priorityTimeout) && priorityTimeout > 0) {
    if (task.priority === 'user_ping' && isCurationInstruction(task.message)) {
      return TASK_TIMEOUT_MS_BY_PRIORITY.heartbeat;
    }
    return priorityTimeout;
  }

  return 5 * 60 * 1000;
}

function isCurationTask(task) {
  if (!task || typeof task !== 'object') return false;
  if (getTaskChatMessageId(task) && getTaskSessionId(task)) return false;
  return task.priority === 'heartbeat'
    || (task.priority === 'user_ping' && isCurationInstruction(task.message));
}

function resolveBackgroundTaskKind(task) {
  if (isCurationTask(task)) {
    return BACKGROUND_JOB_NAMES.CURATION;
  }

  if (task?.priority === 'reflection') {
    return BACKGROUND_JOB_NAMES.REFLECTION;
  }

  if (false && task?.priority === 'user_chat') {
    return BACKGROUND_JOB_NAMES.USER_CHAT;
  }

  if (task?.priority === 'post_enrichment') {
    return BACKGROUND_JOB_NAMES.POST_ENRICHMENT;
  }

  if (task?.priority === 'cache_refresh') {
    return BACKGROUND_JOB_NAMES.CACHE_REFRESH;
  }

  return null;
}

async function enqueueRedisBackgroundTask({
  message,
  priority,
  source,
  metadata,
  requestId,
  timeoutMs,
}) {
  const normalizedMessage = sanitizeMessage(message);
  if (!normalizedMessage) {
    return {
      ok: false,
      error: 'message must be a non-empty string',
      queueDepth: 0,
    };
  }

  const normalizedPriority = normalizePriority(priority);
  const taskLike = {
    message: normalizedMessage,
    priority: normalizedPriority,
    metadata: metadata && typeof metadata === 'object' ? metadata : null,
  };
  const backgroundTaskKind = resolveBackgroundTaskKind(taskLike);

  if (!backgroundTaskKind) {
    return null;
  }

  if (backgroundTaskKind === BACKGROUND_JOB_NAMES.CURATION) {
    if (readCurationStatus().active || await hasPendingBackgroundJob(BACKGROUND_JOB_NAMES.CURATION)) {
      return {
        ok: false,
        error: 'Curation already in progress or queued',
        queueDepth: 0,
      };
    }
  }

  if (backgroundTaskKind === BACKGROUND_JOB_NAMES.REFLECTION) {
    if (readReflectionStatus().active || await hasPendingBackgroundJob(BACKGROUND_JOB_NAMES.REFLECTION)) {
      return {
        ok: false,
        error: 'Reflection already in progress or queued',
        queueDepth: 0,
      };
    }
  }

  if (backgroundTaskKind === BACKGROUND_JOB_NAMES.CACHE_REFRESH) {
    const cacheSource = typeof metadata?.cacheSource === 'string' ? metadata.cacheSource.trim() : '';
    if (cacheSource && await hasPendingCacheRefreshJob(cacheSource)) {
      return {
        ok: false,
        error: `Cache refresh for ${cacheSource} already in progress or queued`,
        queueDepth: 0,
      };
    }
  }

  const acceptedAt = new Date().toISOString();
  const id = typeof requestId === 'string' && requestId.trim() ? requestId.trim() : randomUUID();
  const enqueueResult = await enqueueBackgroundJob(backgroundTaskKind, {
    requestId: id,
    message: normalizedMessage,
    priority: normalizedPriority,
    source: typeof source === 'string' && source.trim() ? source.trim() : 'internal',
    metadata: metadata && typeof metadata === 'object' ? metadata : null,
    ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  }, {
    jobId: id,
  });

  return {
    ok: true,
    requestId: id,
    priority: normalizedPriority,
    queueDepth: enqueueResult.queueDepth,
    position: 0,
    acceptedAt,
    backgrounded: true,
  };
}

// --- Skill background routing ---

const _skillChatRoutingCache = new Map();
let _skillChatRoutingCacheAt = 0;
const SKILL_ROUTING_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Parse YAML frontmatter from a markdown file's content.
 * Returns an object of key/value pairs, supporting one level of nesting.
 */
function parseSimpleYamlFrontmatter(content) {
  if (typeof content !== 'string') return {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result = {};
  const stack = [result];
  const indentStack = [-1];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.search(/\S/);
    const kvMatch = line.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    // Pop stack back to current indent level
    while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]) {
      stack.pop();
      indentStack.pop();
    }

    const target = stack[stack.length - 1];
    if (value === '' || value === '{}') {
      // Nested object
      target[key] = {};
      stack.push(target[key]);
      indentStack.push(indent);
    } else {
      // Scalar — strip surrounding quotes
      target[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return result;
}

/**
 * Check whether a slash command name has `chat-routing: background` in its
 * skill or command frontmatter. Returns true if the command should be routed
 * to a background ping task instead of running inline in chat.
 */
function isBackgroundRoutedCommand(commandName) {
  if (typeof commandName !== 'string' || !commandName.trim()) return false;
  const name = commandName.trim().toLowerCase();

  const now = Date.now();
  if (now - _skillChatRoutingCacheAt > SKILL_ROUTING_CACHE_TTL_MS) {
    _skillChatRoutingCache.clear();
    _skillChatRoutingCacheAt = now;
  }

  if (_skillChatRoutingCache.has(name)) {
    return _skillChatRoutingCache.get(name);
  }

  let isBackground = false;
  const candidates = [
    path.join(process.cwd(), '.claude', 'skills', name, 'SKILL.md'),
    path.join(process.cwd(), '.claude', 'commands', `${name}.md`),
  ];

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const frontmatter = parseSimpleYamlFrontmatter(content);
      const chatRouting = frontmatter?.metadata?.['evogent']?.['chat-routing'];
      if (chatRouting === 'background') {
        isBackground = true;
        break;
      }
    } catch {
      // File doesn't exist or can't be read — skip.
    }
  }

  _skillChatRoutingCache.set(name, isBackground);
  return isBackground;
}

/**
 * Extract slash command name from a chat message text.
 * Returns null if the message doesn't start with '/'.
 */
function extractSlashCommandName(message) {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function isUnitTestTask(task) {
  const source = typeof task?.source === 'string' ? task.source : '';
  const message = typeof task?.message === 'string' ? task.message : '';

  return source.startsWith('unit-test')
    || message.startsWith('[unit]')
    || (source.includes('unit-test') && source.startsWith('adaptive_heartbeat'));
}

function stringifyUnknown(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
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
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeParseJsonLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
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

  const sessionObject = rawEvent.session && typeof rawEvent.session === 'object'
    ? rawEvent.session
    : null;
  const nested = sessionObject && typeof sessionObject.id === 'string'
    ? sessionObject.id.trim()
    : '';
  if (isUuid(nested)) return nested;

  return null;
}

function collectAssistantText(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return [];

  if (rawEvent.type === 'stream_event') {
    const streamEvent = rawEvent.event && typeof rawEvent.event === 'object'
      ? rawEvent.event
      : null;
    if (!streamEvent) return [];

    if (streamEvent.type === 'content_block_start') {
      const contentBlock = streamEvent.content_block && typeof streamEvent.content_block === 'object'
        ? streamEvent.content_block
        : null;
      if (contentBlock?.type !== 'text') return [];
      return typeof contentBlock.text === 'string' && contentBlock.text
        ? [contentBlock.text]
        : [];
    }

    if (streamEvent.type === 'content_block_delta') {
      const delta = streamEvent.delta && typeof streamEvent.delta === 'object'
        ? streamEvent.delta
        : null;
      if (delta?.type !== 'text_delta') return [];
      return typeof delta.text === 'string' && delta.text
        ? [delta.text]
        : [];
    }

    return [];
  }

  if (rawEvent.type !== 'assistant') return [];

  const message = rawEvent.message && typeof rawEvent.message === 'object'
    ? rawEvent.message
    : null;
  const content = Array.isArray(message?.content) ? message.content : [];

  return content
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      if (entry.type !== 'text') return '';
      return typeof entry.text === 'string' ? entry.text.trim() : '';
    })
    .filter(Boolean);
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

function extractClaudeErrorText(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return '';
  }

  if (rawEvent.type === 'error') {
    const errorObject = rawEvent.error && typeof rawEvent.error === 'object'
      ? rawEvent.error
      : null;
    const directMessage = typeof rawEvent.message === 'string' ? rawEvent.message.trim() : '';
    const nestedMessage = typeof errorObject?.message === 'string' ? errorObject.message.trim() : '';
    const errorPayload = errorObject || rawEvent.error || rawEvent.message || '';
    const fallback = truncateText(stringifyUnknown(errorPayload), 620);
    return directMessage || nestedMessage || fallback || '';
  }

  if (rawEvent.type === 'result' && rawEvent.is_error) {
    return truncateText(stringifyUnknown(rawEvent.result), 620);
  }

  return '';
}

function formatTranscriptLines(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return [];
  }

  const errorText = extractClaudeErrorText(rawEvent);
  if (errorText) {
    return [`[error] ${errorText}`];
  }

  if (rawEvent.type === 'assistant') {
    const lines = [];
    const texts = collectAssistantText(rawEvent);
    for (const text of texts) {
      lines.push(truncateText(text, 620));
    }

    const message = rawEvent.message && typeof rawEvent.message === 'object'
      ? rawEvent.message
      : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type !== 'tool_use') continue;

      const toolName = typeof entry.name === 'string' ? entry.name.trim() : 'tool';
      const toolInput = entry.input && typeof entry.input === 'object'
        ? truncateText(stringifyUnknown(entry.input), 420)
        : '';
      lines.push(toolInput ? `tool ${toolName}: ${toolInput}` : `tool ${toolName}`);
    }

    return lines;
  }

  if (rawEvent.type === 'user') {
    const message = rawEvent.message && typeof rawEvent.message === 'object'
      ? rawEvent.message
      : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    return content
      .filter((entry) => entry && typeof entry === 'object' && entry.type === 'tool_result')
      .map((entry) => {
        const toolResult = truncateText(stringifyUnknown(entry.content), 420);
        const isError = Boolean(entry.is_error);
        if (!toolResult) return isError ? 'tool error' : 'tool result';
        return isError ? `tool error: ${toolResult}` : `tool result: ${toolResult}`;
      });
  }

  if (rawEvent.type === 'result') {
    const resultText = truncateText(stringifyUnknown(rawEvent.result), 620);
    if (!resultText) return ['completed'];
    return [`completed: ${resultText}`];
  }

  if (rawEvent.type === 'system') {
    const subtype = typeof rawEvent.subtype === 'string' ? rawEvent.subtype.trim() : '';
    if (!subtype) return [];
    return [`system: ${subtype}`];
  }

  return [];
}

function extractFinalResultText(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return '';

  if (rawEvent.type === 'result' && !rawEvent.is_error) {
    return truncateText(stringifyUnknown(rawEvent.result), 5000);
  }

  return '';
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

function buildTaskPrompt(task) {
  const resolvedTaskMessage = buildRuntimeTaskPrompt(task, {
    rootDir: process.cwd(),
    dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
    internalBaseUrl,
    startedAt: task?.startedAt || task?.enqueuedAt || null,
    timeoutMs: resolveTaskTimeoutMs(task),
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
  broadcastChatSessionReset,
  broadcastChatSessionLifecycle,
  broadcastChatStreaming,
  broadcastChatTyping,
  broadcastChatUpdate,
  buildSessionResetHistoryBlock,
  buildTaskPrompt,
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
  isCurationInstruction,
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
  regeneratePreferenceContextBeforeCuration,
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

/** @type {Set<import('ws').WebSocket>} */
const feedClients = new Set();
/** @type {Set<import('ws').WebSocket>} */
const orchestratorClients = new Set();
/** @type {Set<import('ws').WebSocket>} */
const chatClients = new Set();
const chatSSESubscribers = new Map(); // messageId → Set of HTTP response objects
/** @type {Set<import('ws').WebSocket>} */
const agentProgressClients = new Set();
const compactingChatSessions = new Map();
const pendingCompactRequests = new Set();

const orchestrator = new BrainOrchestrator('evogent-ephemeral');
let workerOrchestratorStatus = null;

function parseStatusTime(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function sortTasksByTimeDesc(left, right) {
  const leftTime = parseStatusTime(left?.completedAt)
    || parseStatusTime(left?.startedAt)
    || parseStatusTime(left?.enqueuedAt);
  const rightTime = parseStatusTime(right?.completedAt)
    || parseStatusTime(right?.startedAt)
    || parseStatusTime(right?.enqueuedAt);
  return rightTime - leftTime;
}

function dedupeTasks(tasks, limit = 20) {
  const seen = new Set();
  const deduped = [];

  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const taskId = typeof task.id === 'string' ? task.id.trim() : '';
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    deduped.push(task);
  }

  deduped.sort(sortTasksByTimeDesc);
  return deduped.slice(0, limit);
}

function pickCurrentTask(candidates) {
  const valid = candidates.filter((task) => task && typeof task === 'object');
  if (valid.length === 0) return null;
  valid.sort(sortTasksByTimeDesc);
  return valid[0] || null;
}

function pickStatusBrain(localStatus, workerStatus) {
  if (workerStatus?.brain?.working) return workerStatus.brain;
  if (localStatus?.brain?.working) return localStatus.brain;
  return parseStatusTime(workerStatus?.updatedAt) > parseStatusTime(localStatus?.updatedAt)
    ? (workerStatus?.brain || localStatus?.brain)
    : (localStatus?.brain || workerStatus?.brain);
}

function getCombinedOrchestratorStatus() {
  const localStatus = orchestrator.getStatus();
  const workerStatus = workerOrchestratorStatus;
  const curationStatus = getCurrentCurationProgressSnapshot();

  if (!workerStatus || typeof workerStatus !== 'object') {
    return {
      ...localStatus,
      curationStatus,
    };
  }

  const brainProvider = workerStatus.brainProvider || localStatus.brainProvider || 'claude';
  const brainProviderLabel = workerStatus.brainProviderLabel || localStatus.brainProviderLabel || 'Claude';

  const activeChatTasks = dedupeTasks([
    ...(Array.isArray(workerStatus.activeChatTasks) ? workerStatus.activeChatTasks : []),
    ...(Array.isArray(localStatus.activeChatTasks) ? localStatus.activeChatTasks : []),
  ], 100);
  const queued = dedupeTasks([
    ...(Array.isArray(workerStatus.queued) ? workerStatus.queued : []),
    ...(Array.isArray(localStatus.queued) ? localStatus.queued : []),
  ]);
  const history = dedupeTasks([
    ...(Array.isArray(workerStatus.history) ? workerStatus.history : []),
    ...(Array.isArray(localStatus.history) ? localStatus.history : []),
  ]);
  const currentTask = pickCurrentTask([
    workerStatus.currentTask,
    localStatus.currentTask,
    ...activeChatTasks,
  ]);
  const workerHasActiveTasks = Boolean(
    workerStatus.currentTask
    || workerStatus.isProcessing
    || (Array.isArray(workerStatus.activeChatTasks) && workerStatus.activeChatTasks.length > 0),
  );

  return {
    sessionName: workerHasActiveTasks ? workerStatus.sessionName : localStatus.sessionName,
    brainProvider,
    brainProviderLabel,
    brainAvailable: localStatus.brainAvailable === false || workerStatus.brainAvailable === false
      ? false
      : (typeof workerStatus.brainAvailable === 'boolean' ? workerStatus.brainAvailable : localStatus.brainAvailable),
    consecutiveSpawnFailures: Math.max(
      Number.isFinite(localStatus.consecutiveSpawnFailures) ? localStatus.consecutiveSpawnFailures : 0,
      Number.isFinite(workerStatus.consecutiveSpawnFailures) ? workerStatus.consecutiveSpawnFailures : 0,
    ),
    queueDepth: queued.length,
    isProcessing: Boolean(localStatus.isProcessing || workerStatus.isProcessing),
    activeCurationAgent: workerStatus.activeCurationAgent || localStatus.activeCurationAgent || null,
    activeReflectionAgent: workerStatus.activeReflectionAgent || localStatus.activeReflectionAgent || null,
    brain: pickStatusBrain(localStatus, workerStatus),
    currentTask,
    curationStatus,
    activeChatTasks,
    queued,
    history,
    updatedAt: new Date(Math.max(
      parseStatusTime(localStatus.updatedAt),
      parseStatusTime(workerStatus.updatedAt),
      Date.now(),
    )).toISOString(),
  };
}

function getFinishedTaskFromStatus(status, event) {
  const finishedTaskId = typeof event?.taskId === 'string' && event.taskId.trim()
    ? event.taskId.trim()
    : null;

  return finishedTaskId && Array.isArray(status?.history)
    ? status.history.find((task) => task && typeof task === 'object' && task.id === finishedTaskId) ?? null
    : Array.isArray(status?.history) && status.history.length > 0
      ? status.history[0]
      : null;
}

function parseUrl(urlString) {
  const url = new URL(urlString, `http://${hostname}:${port}`);
  const query = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  return {
    pathname: url.pathname,
    query,
    searchParams: url.searchParams,
  };
}

function sendSSEToSubscribers(messageId, eventType, payload) {
  if (!messageId) return;
  const subs = chatSSESubscribers.get(messageId);
  if (!subs || subs.size === 0) return;
  for (const res of subs) {
    try {
      res.write(`event: ${eventType}\ndata: ${payload}\n\n`);
    } catch { /* client disconnected */ }
  }
}

function sendToClients(clients, payload) {
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastFeedUpdate(items) {
  if (!Array.isArray(items) || items.length === 0) return;

  const payload = JSON.stringify({
    type: 'feed_update',
    items,
    count: items.length,
    ts: new Date().toISOString(),
  });

  sendToClients(feedClients, payload);
}

function broadcastChatUpdate(items) {
  if (!Array.isArray(items) || items.length === 0) return;

  const payload = JSON.stringify({
    type: 'chat_update',
    items,
    count: items.length,
    ts: new Date().toISOString(),
  });

  sendToClients(chatClients, payload);

  const hasAgentMessage = items.some((item) => item && typeof item === 'object' && item.role === 'agent');
  if (hasAgentMessage) {
    broadcastChatTyping(false);
  }

  // Send final message to SSE subscribers and close their streams
  for (const item of items) {
    if (item && item.role === 'agent' && item.type === 'chat' && item.inReplyTo) {
      const subs = chatSSESubscribers.get(item.inReplyTo);
      if (subs) {
        const donePayload = JSON.stringify({ type: 'chat_done', item });
        for (const res of subs) {
          try {
            res.write(`event: chat_done\ndata: ${donePayload}\n\n`);
            res.end();
          } catch { /* client disconnected */ }
        }
        chatSSESubscribers.delete(item.inReplyTo);
      }
    }
  }
}

function broadcastChatStreaming(text, inReplyTo, sessionId = null) {
  const payload = JSON.stringify({
    type: 'chat_streaming',
    text: typeof text === 'string' ? text : '',
    inReplyTo: inReplyTo || null,
    sessionId: isUuid(sessionId) ? sessionId.trim() : null,
    ts: new Date().toISOString(),
  });

  sendToClients(chatClients, payload);
  sendSSEToSubscribers(inReplyTo, 'chat_streaming', payload);
}

function broadcastChatProgress(activity, tool, inReplyTo, sessionId = null) {
  if (typeof activity !== 'string' || !activity.trim()) {
    return;
  }

  const payload = JSON.stringify({
    type: 'chat_progress',
    activity: activity.trim(),
    tool: typeof tool === 'string' && tool.trim() ? tool.trim() : 'Working',
    inReplyTo: inReplyTo || null,
    sessionId: isUuid(sessionId) ? sessionId.trim() : null,
    ts: new Date().toISOString(),
  });

  sendToClients(chatClients, payload);
  sendSSEToSubscribers(inReplyTo, 'chat_progress', payload);
}

function broadcastChatTyping(typing) {
  const payload = JSON.stringify({
    type: 'chat_typing',
    typing: Boolean(typing),
    ts: new Date().toISOString(),
  });

  sendToClients(chatClients, payload);
}

function broadcastChatSessionReset(reason, newSessionId, sessionId = null) {
  if (typeof reason !== 'string' || !reason.trim() || !isUuid(newSessionId)) {
    return;
  }

  const payload = JSON.stringify({
    type: 'session_reset',
    reason: reason.trim(),
    newSessionId: newSessionId.trim(),
    sessionId: isUuid(sessionId) ? sessionId.trim() : null,
    ts: new Date().toISOString(),
  });

  sendToClients(chatClients, payload);
}

function broadcastChatSessionLifecycle(type, {
  sessionId,
  nextSessionId = null,
  error = null,
} = {}) {
  if (
    (
      type !== 'chat_session_reset'
      && type !== 'chat_session_created'
      && type !== 'chat_session_deleted'
      && type !== 'chat_session_updated'
      && type !== 'chat_session_compacting'
      && type !== 'chat_session_compacted'
      && type !== 'chat_session_compact_failed'
    )
    || !isUuid(sessionId)
  ) {
    return;
  }

  const payload = {
    type,
    sessionId: sessionId.trim(),
    nextSessionId: isUuid(nextSessionId) ? nextSessionId.trim() : null,
    ts: new Date().toISOString(),
  };

  if (typeof error === 'string' && error.trim()) {
    payload.error = error.trim();
  }

  sendToClients(chatClients, JSON.stringify(payload));
}

function getActiveChatTaskForSession(sessionId) {
  if (!isUuid(sessionId)) {
    return null;
  }

  const status = getCombinedOrchestratorStatus();
  const candidates = [
    status.currentTask,
    ...(Array.isArray(status.activeChatTasks) ? status.activeChatTasks : []),
  ];

  for (const task of candidates) {
    if (
      task
      && task.priority === 'user_chat'
      && typeof task.sessionId === 'string'
      && task.sessionId.trim() === sessionId
      && (task.state === 'queued' || task.state === 'processing' || task.state == null)
    ) {
      return task;
    }
  }

  return null;
}

function processPendingCompactRequests(trigger = 'status') {
  if (pendingCompactRequests.size === 0) {
    return;
  }

  for (const sessionId of Array.from(pendingCompactRequests)) {
    if (!isUuid(sessionId)) {
      pendingCompactRequests.delete(sessionId);
      continue;
    }

    if (compactingChatSessions.has(sessionId)) {
      pendingCompactRequests.delete(sessionId);
      continue;
    }

    if (getActiveChatTaskForSession(sessionId)) {
      continue;
    }

    const result = startChatSessionCompaction(sessionId, { allowQueue: false });

    if (result.ok || compactingChatSessions.has(sessionId)) {
      pendingCompactRequests.delete(sessionId);
      continue;
    }

    if (result.status === 409 && result.error === 'Cannot compact while this session is handling an active task') {
      continue;
    }

    pendingCompactRequests.delete(sessionId);
    broadcastChatSessionLifecycle('chat_session_compact_failed', {
      sessionId,
      error: result.error || `Queued compact could not start after ${trigger}`,
    });
  }
}

function startChatSessionCompaction(sessionId, { allowQueue = true } = {}) {
  if (!isUuid(sessionId)) {
    return { ok: false, status: 400, error: 'Invalid session ID' };
  }

  if (compactingChatSessions.has(sessionId)) {
    return { ok: false, status: 409, error: 'Session compaction is already running' };
  }

  const activeTask = getActiveChatTaskForSession(sessionId);
  if (activeTask) {
    if (allowQueue) {
      pendingCompactRequests.add(sessionId);
      return {
        ok: true,
        status: 202,
        sessionId,
        queued: true,
        message: 'Compact queued. It will start when the current chat turn finishes.',
      };
    }
    return { ok: false, status: 409, error: 'Cannot compact while this session is handling an active task' };
  }

  const session = getChatSessionRuntimeInfo(sessionId);
  if (!session) {
    return { ok: false, status: 404, error: 'Session not found' };
  }
  if (!isUuid(session.providerSessionId)) {
    return { ok: false, status: 409, error: 'This session does not have a resumable provider session' };
  }

  const provider = resolveBrainProviderByName({
    DEFAULT_CLAUDE_ALLOWED_TOOLS,
    DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS,
    DEFAULT_CLAUDE_PERMISSION_MODE,
    collectAssistantText,
    extractChatProgressFromEvent,
    extractFinalResultText,
    extractSessionIdFromStreamEvent,
    extractStreamingChatTextFromEvent,
    formatTranscriptLines,
    isCurationTask,
    isFreshAssistantStreamingSignal,
    summarizeStreamingChatEvent,
  }, dataPath('config.md'), session.provider);

  if (typeof provider.supportsManualCompaction !== 'function' || !provider.supportsManualCompaction()) {
    return { ok: false, status: 409, error: `${provider.displayName} manual compact is not supported yet` };
  }

  pendingCompactRequests.delete(sessionId);
  const invocation = provider.buildCompactionInvocation({
    sessionId: session.providerSessionId,
  });

  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: session.workingDirectory || process.cwd(),
      env: {
        ...process.env,
        ...(invocation.env || {}),
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 500, error: `Failed to start session compact: ${message}` };
  }

  compactingChatSessions.set(sessionId, {
    pid: Number.isInteger(child.pid) ? child.pid : null,
    startedAt: new Date().toISOString(),
  });
  broadcastChatSessionLifecycle('chat_session_compacting', { sessionId });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let latestContextTokens = null;
  let latestContextWindow = session.latestContextWindow;
  let latestContextModel = session.latestContextModel;
  let compactSucceeded = false;
  let compactResultError = null;

  const processLine = (line) => {
    const trimmed = typeof line === 'string' ? line.trim() : '';
    if (!trimmed) {
      return;
    }

    const parsedEvent = safeParseJsonLine(trimmed);
    if (!parsedEvent || typeof parsedEvent !== 'object') {
      return;
    }

    if (typeof provider.extractCompactionMetrics === 'function') {
      const compactMetrics = provider.extractCompactionMetrics(parsedEvent);
      if (compactMetrics && Number.isFinite(compactMetrics.postTokens)) {
        latestContextTokens = Math.max(0, Math.floor(Number(compactMetrics.postTokens)));
      }
    }

    if (typeof provider.extractContextMetrics === 'function') {
      const contextMetrics = provider.extractContextMetrics(parsedEvent);
      if (contextMetrics && Number.isFinite(contextMetrics.contextWindow)) {
        latestContextWindow = Math.max(1, Math.floor(Number(contextMetrics.contextWindow)));
      }
      if (contextMetrics && typeof contextMetrics.modelId === 'string' && contextMetrics.modelId.trim()) {
        latestContextModel = contextMetrics.modelId.trim();
      }
    }

    if (
      parsedEvent.type === 'system'
      && parsedEvent.subtype === 'status'
      && parsedEvent.compact_result === 'success'
    ) {
      compactSucceeded = true;
    }

    if (parsedEvent.type === 'result' && parsedEvent.is_error) {
      const errors = Array.isArray(parsedEvent.errors) ? parsedEvent.errors.filter((value) => typeof value === 'string' && value.trim()) : [];
      compactResultError = errors[0] || (typeof parsedEvent.result === 'string' && parsedEvent.result.trim() ? parsedEvent.result.trim() : 'Compact failed');
    }
  };

  const consumeChunk = (chunk, streamName) => {
    const raw = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (streamName === 'stderr') {
      stderrBuffer += raw;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
      return;
    }

    stdoutBuffer += raw;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  };

  const finalize = (error = null) => {
    if (!compactingChatSessions.has(sessionId)) {
      return;
    }

    compactingChatSessions.delete(sessionId);
    if (stdoutBuffer.trim()) {
      processLine(stdoutBuffer);
      stdoutBuffer = '';
    }
    if (stderrBuffer.trim()) {
      processLine(stderrBuffer);
      stderrBuffer = '';
    }

    if (!error && !compactResultError && compactSucceeded && Number.isFinite(latestContextTokens)) {
      updateChatSessionContextMetrics(sessionId, {
        latestContextTokens,
        latestContextWindow,
        latestContextModel,
      });
      broadcastChatSessionLifecycle('chat_session_compacted', { sessionId });
      return;
    }

    const message = error instanceof Error
      ? error.message
      : typeof compactResultError === 'string' && compactResultError.trim()
        ? compactResultError.trim()
        : 'Session compact failed';
    broadcastChatSessionLifecycle('chat_session_compact_failed', {
      sessionId,
      error: message,
    });
  };

  child.stdout?.on('data', (chunk) => consumeChunk(chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => consumeChunk(chunk, 'stderr'));
  child.once('error', (error) => finalize(error));
  child.once('close', (code) => {
    if (typeof code === 'number' && code !== 0 && !compactSucceeded) {
      finalize(new Error(`Compact exited with code ${code}`));
      return;
    }
    finalize(null);
  });

  return {
    ok: true,
    status: 202,
    sessionId,
  };
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

  sendToClients(chatClients, JSON.stringify(payload));
}

function broadcastChatSuggestion({
  originSessionId,
  sessionId,
  suggestion,
} = {}) {
  const resolvedOriginSessionId = typeof originSessionId === 'string' && originSessionId.trim()
    ? originSessionId.trim()
    : typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : '';

  if (!isUuid(resolvedOriginSessionId) || !suggestion || typeof suggestion !== 'object') {
    return;
  }

  const id = typeof suggestion.id === 'string' ? suggestion.id.trim() : '';
  const title = typeof suggestion.title === 'string' ? suggestion.title.trim() : '';
  const summary = typeof suggestion.summary === 'string' ? suggestion.summary.trim() : '';
  const suggestionType = typeof suggestion.suggestionType === 'string' ? suggestion.suggestionType.trim() : '';
  const proposedValue = typeof suggestion.proposedValue === 'string' ? suggestion.proposedValue.trim() : '';
  const status = typeof suggestion.status === 'string' ? suggestion.status.trim() : 'pending';

  if (!id || !title || !summary || !suggestionType || !proposedValue) {
    return;
  }

  const payload = {
    type: 'chat_suggestion',
    originSessionId: resolvedOriginSessionId,
    sessionId: resolvedOriginSessionId,
    suggestion: {
      id,
      title,
      summary,
      suggestionType,
      proposedValue,
      status,
    },
    ts: new Date().toISOString(),
  };

  sendToClients(chatClients, JSON.stringify(payload));
}

function dispatchChatNotifyEvent(event) {
  if (!event || typeof event !== 'object') {
    return;
  }

  switch (event.type) {
    case 'chat_update':
      broadcastChatUpdate(Array.isArray(event.items) ? event.items : []);
      return;
    case 'chat_streaming':
      broadcastChatStreaming(event.text, event.inReplyTo);
      return;
    case 'chat_progress':
      broadcastChatProgress(event.activity, event.tool, event.inReplyTo, event.sessionId);
      return;
    case 'chat_typing':
      broadcastChatTyping(event.typing);
      return;
    case 'session_reset':
      broadcastChatSessionReset(event.reason, event.newSessionId, event.sessionId);
      return;
    case 'research_started':
    case 'research_completed':
    case 'research_failed':
      broadcastChatResearchStatus(event.type, event);
      return;
    case 'chat_suggestion':
      broadcastChatSuggestion(event);
      return;
    default:
      return;
  }
}

function broadcastOrchestratorStatus(status = getCombinedOrchestratorStatus(), trigger = 'status', event = null) {
  const message = {
    type: 'orchestrator_status',
    trigger,
    status,
    ts: new Date().toISOString(),
  };
  if (event && typeof event === 'object') {
    message.event = event;
  }
  const payload = JSON.stringify(message);

  sendToClients(orchestratorClients, payload);
}

function broadcastAgentProgress(body, trigger = 'progress') {
  const payload = JSON.stringify({
    type: 'agent_progress',
    trigger,
    event: body?.event ?? null,
    agent: body?.agent ?? null,
    ts: new Date().toISOString(),
  });

  sendToClients(agentProgressClients, payload);
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

async function regeneratePreferenceContextBeforeCuration(task) {
  console.log(`[preferences] pre-curation context refresh starting for task ${task.id}`);

  try {
    await regeneratePreferenceContext();
    console.log(`[preferences] pre-curation context refresh completed for task ${task.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[preferences] pre-curation context refresh failed for task ${task.id}: ${message}`);
  }
}

function getCurrentCurationProgressSnapshot() {
  return normalizeCurationStatus(readCurationStatus());
}

function recordCurationPhaseUpdate(body) {
  const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
  const phase = typeof body?.phase === 'string' ? body.phase.trim() : '';
  const detail = typeof body?.detail === 'string' && body.detail.trim()
    ? body.detail.trim()
    : null;

  if (!taskId) {
    return { ok: false, statusCode: 400, error: 'taskId is required' };
  }

  if (!phase) {
    return { ok: false, statusCode: 400, error: 'phase is required' };
  }

  const currentStatus = getCurrentCurationProgressSnapshot();
  if (!currentStatus.active || currentStatus.requestId !== taskId) {
    return { ok: false, statusCode: 404, error: 'No active curation task matches taskId' };
  }

  if (
    currentStatus.phase === 'enriching'
    && currentStatus.phaseTaskId
    && currentStatus.phaseTaskId !== taskId
  ) {
    return {
      ok: true,
      statusCode: 200,
      taskId,
      phase: currentStatus.phase,
      detail: currentStatus.phaseDetail,
      deadlineAt: currentStatus.deadlineAt,
      persistDeadlineAt: currentStatus.persistDeadlineAt,
      remainingMs: null,
      persistRemainingMs: null,
    };
  }

  const nowIso = new Date().toISOString();
  const nextStatus = {
    requestId: taskId,
    phaseTaskId: taskId,
    phase,
    phaseDetail: detail,
    phaseUpdatedAt: nowIso,
  };

  if (!currentStatus.selectionLockedAt && (phase === 'selection_locked' || body?.selectionLocked === true)) {
    nextStatus.selectionLockedAt = nowIso;
  }

  if (!currentStatus.submittedAt && (phase === 'submitted' || body?.submitted === true)) {
    nextStatus.submittedAt = nowIso;
    nextStatus.failedBeforeSubmit = false;
    nextStatus.lastFailureAt = null;
    nextStatus.lastFailurePhase = null;
    nextStatus.lastFailureDetail = null;
  }

  writeCurationStatus(nextStatus);

  appendTaskLogEntry(currentStatus.logFile, {
    type: 'curation_phase',
    taskId,
    phase,
    detail,
    timestamp: nowIso,
    beforeSubmit: !(currentStatus.submittedAt || nextStatus.submittedAt),
  });

  const updatedStatus = getCurrentCurationProgressSnapshot();
  const deadlineAtMs = Date.parse(updatedStatus.deadlineAt || '');
  const persistDeadlineAtMs = Date.parse(updatedStatus.persistDeadlineAt || '');

  return {
    ok: true,
    statusCode: 200,
    taskId,
    phase,
    detail,
    deadlineAt: updatedStatus.deadlineAt,
    persistDeadlineAt: updatedStatus.persistDeadlineAt,
    remainingMs: Number.isFinite(deadlineAtMs) ? Math.max(0, deadlineAtMs - Date.now()) : null,
    persistRemainingMs: Number.isFinite(persistDeadlineAtMs) ? Math.max(0, persistDeadlineAtMs - Date.now()) : null,
  };
}

orchestrator.onStatus((status, trigger, event) => {
  broadcastOrchestratorStatus(getCombinedOrchestratorStatus(), trigger, event);

  if (trigger === 'task_started') {
    insertCurationLogForTaskStart(event);
    return;
  }

  if (trigger !== 'task_finished') return;

  completeCurationLogForTask(event);

  const finishedTask = getFinishedTaskFromStatus(status, event);

  if (!finishedTask) return;
  if (finishedTask.state !== 'completed' && finishedTask.state !== 'failed') return;

  if (finishedTask.state === 'failed') {
    markFailedBatchEnrichmentItems(finishedTask, { internalBaseUrl }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[orchestrator] failed to mark batch enrichment failures: ${message}`);
    });
  }

  if (pendingCompactRequests.size > 0) {
    processPendingCompactRequests(`local:${trigger}`);
  }
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

async function regeneratePreferenceContextOnStartup() {
  try {
    await regeneratePreferenceContext();
    console.log('> Preference context regenerated');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`> Preference context regeneration skipped: ${message}`);
  }
}

async function initializeWatchersOnStartup() {
  try {
    const response = await fetch(`${internalBaseUrl}/api/internal/watchers/start`, {
      method: 'POST',
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body || 'failed to initialize watchers'}`);
    }

    console.log('> Feed watcher initialized');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`> Watcher startup initialization failed: ${message}`);
  }
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    const parsedUrl = parseUrl(req.url || '/');

    if (!isPublicReadPath(req.method, parsedUrl.pathname) && !trustNetwork && !(await isTrustedSocket(req))) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: false,
        error: 'Forbidden — set MEDIA_AGENT_TRUST_NETWORK=1 only after fronting Evogent with an auth proxy',
        message: "You don't have permission to do this. Sign in to continue.",
      }));
      return;
    }

    if ((parsedUrl.pathname.startsWith('/api/internal/') || parsedUrl.pathname.startsWith('/api/orchestrator/')) && !isLocalRequest(req)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden — internal endpoint' }));
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/feed-notify') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const items = Array.isArray(body.items) ? body.items : [];

        broadcastFeedUpdate(items);

        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, deliveredToClients: feedClients.size, count: items.length }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
      return;
    }

    // Check for pending restart and notify clients
    if (req.method === 'GET' && parsedUrl.pathname === '/api/internal/pending-restart') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const state = getVisibleRestartState();
        res.end(JSON.stringify({
          pending: state?.status === 'pending',
          state,
          ...(state || {}),
        }));
      } catch {
        res.end(JSON.stringify({ pending: false, state: null }));
      }
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/internal/deployment-status') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const deployment = getDeploymentStatus();
        res.end(JSON.stringify(deployment));
      } catch {
        res.end(JSON.stringify({
          running: { ...runtimeDeploymentSnapshot },
          pendingRestart: null,
        }));
      }
      return;
    }

    // Apply pending restart — user triggered
    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/apply-restart') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const body = await readJsonBody(req);
        const pendingFlag = readPendingRestartFlag();
        if (!pendingFlag) {
          res.statusCode = 409;
          res.end(JSON.stringify({ ok: false, error: 'No pending restart is available.' }));
          return;
        }

        const requester = getRestartRequester(req, body);
        const pendingState = buildPendingRestartState(pendingFlag, readRestartState());
        const applyingState = writeRestartState({
          ...pendingState,
          status: 'applying',
          applyRequestedAt: new Date().toISOString(),
          requestedBy: requester.requestedBy,
          triggerSource: requester.triggerSource,
          requestReferer: requester.referer,
          requestUserAgent: requester.userAgent,
          requestRemoteAddress: requester.remoteAddress,
          requestForwardedFor: requester.forwardedFor,
          error: null,
          lastUpdatedAt: new Date().toISOString(),
        });

        console.log('[apply-restart] Restart triggered at', new Date().toISOString(), {
          requestedBy: requester.requestedBy,
          triggerSource: requester.triggerSource,
          referer: requester.referer || '',
          userAgent: requester.userAgent || '',
          remoteAddress: requester.remoteAddress || '',
          forwardedFor: requester.forwardedFor || '',
          commit: applyingState.commit || '',
          summary: applyingState.summary || '',
        });

        if (fs.existsSync(pendingRestartPath)) {
          fs.unlinkSync(pendingRestartPath);
        }

        res.end(JSON.stringify({ ok: true, message: 'Building and restarting...', state: applyingState }));

        // Build then restart after response is sent
        setTimeout(() => {
          const { execSync } = require('node:child_process');
          try {
            const currentState = readRestartState() || applyingState;
            writeRestartState({
              ...currentState,
              status: 'applying',
              buildStartedAt: new Date().toISOString(),
              lastUpdatedAt: new Date().toISOString(),
            });
            execSync('npm run build', { cwd: process.cwd(), stdio: 'pipe', timeout: RESTART_BUILD_TIMEOUT_MS });
            const postBuildState = readRestartState() || applyingState;
            const workerRestartRequestedAt = new Date().toISOString();
            writePendingWorkerRestartRequest({
              restartState: postBuildState,
              requester,
              requestedAt: workerRestartRequestedAt,
            });
            console.log('[apply-restart] worker restart deferred until idle', {
              service: WORKER_RESTART_SERVICE_UNIT,
              commit: applyingState.commit || '',
              requestedBy: applyingState.requestedBy || '',
              triggerSource: applyingState.triggerSource || '',
            });
            writeRestartState({
              ...postBuildState,
              status: 'restarting',
              workerRestartStatus: 'deferred_until_idle',
              workerRestartRequestedAt,
              buildCompletedAt: new Date().toISOString(),
              restartCommandAt: new Date().toISOString(),
              lastUpdatedAt: new Date().toISOString(),
            });
            execSync(buildRestartServicesCommand(), { stdio: 'pipe' });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failedState = readRestartState() || applyingState;
            writeRestartState({
              ...failedState,
              status: 'failed',
              error: message,
              lastUpdatedAt: new Date().toISOString(),
            });
            console.error('[apply-restart] Restart failed', {
              commit: applyingState.commit || '',
              requestedBy: applyingState.requestedBy || '',
              triggerSource: applyingState.triggerSource || '',
              error: message,
            });
          }
        }, 500);
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err?.message || 'Restart failed' }));
      }
      return;
    }

    // SSE endpoint for chat streaming — client connects after POST /api/chat
    if (req.method === 'GET' && parsedUrl.pathname === '/api/chat/events') {
      const messageId = parsedUrl.query?.messageId;
      if (!messageId || typeof messageId !== 'string') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'messageId query parameter required' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ messageId })}\n\n`);

      // Register this response as a subscriber for this messageId
      if (!chatSSESubscribers.has(messageId)) {
        chatSSESubscribers.set(messageId, new Set());
      }
      chatSSESubscribers.get(messageId).add(res);

      // Send keepalive pings every 15s to prevent proxy timeouts
      const pingTimer = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(pingTimer); }
      }, 15000);

      // Cleanup on disconnect
      req.on('close', () => {
        clearInterval(pingTimer);
        const subs = chatSSESubscribers.get(messageId);
        if (subs) {
          subs.delete(res);
          if (subs.size === 0) chatSSESubscribers.delete(messageId);
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        try {
          res.write(`event: timeout\ndata: ${JSON.stringify({ messageId })}\n\n`);
          res.end();
        } catch { /* already closed */ }
      }, 5 * 60 * 1000);

      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/chat-notify') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const events = Array.isArray(body.events) ? body.events : [];

        if (items.length > 0) {
          broadcastChatUpdate(items);
        }
        for (const event of events) {
          dispatchChatNotifyEvent(event);
        }
        if (pendingCompactRequests.size > 0) {
          processPendingCompactRequests('chat_notify');
        }

        res.statusCode = 200;
        res.end(JSON.stringify({
          ok: true,
          deliveredToClients: chatClients.size,
          count: items.length + events.length,
        }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/orchestrator-status') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const status = body.status && typeof body.status === 'object' ? body.status : null;
        if (!status) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'status is required' }));
          return;
        }

        workerOrchestratorStatus = status;
        broadcastOrchestratorStatus(
          getCombinedOrchestratorStatus(),
          typeof body.trigger === 'string' ? body.trigger : 'status',
          body.event && typeof body.event === 'object' ? body.event : null,
        );
        if (body.trigger === 'task_finished') {
          completeCurationLogForTask(body.event && typeof body.event === 'object' ? body.event : null);
          const finishedTask = getFinishedTaskFromStatus(
            status,
            body.event && typeof body.event === 'object' ? body.event : null,
          );
          if (finishedTask?.state === 'failed') {
            markFailedBatchEnrichmentItems(finishedTask, { internalBaseUrl }).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`[orchestrator] failed to mark worker batch enrichment failures: ${message}`);
            });
          }
        }
        if (pendingCompactRequests.size > 0) {
          processPendingCompactRequests(`worker:${typeof body.trigger === 'string' ? body.trigger : 'status'}`);
        }

        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, deliveredToClients: orchestratorClients.size }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/chat-session-broadcast') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const type = typeof body.type === 'string' ? body.type.trim() : '';
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const nextSessionId = typeof body.nextSessionId === 'string' ? body.nextSessionId.trim() : null;
        const error = typeof body.error === 'string' ? body.error.trim() : null;

        if (
          (
            type !== 'chat_session_reset'
            && type !== 'chat_session_created'
            && type !== 'chat_session_deleted'
            && type !== 'chat_session_updated'
            && type !== 'chat_session_compacting'
            && type !== 'chat_session_compacted'
            && type !== 'chat_session_compact_failed'
          )
          || !isUuid(sessionId)
        ) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'type and sessionId are required' }));
          return;
        }

        broadcastChatSessionLifecycle(type, { sessionId, nextSessionId, error });

        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, deliveredToClients: chatClients.size }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/chat-session-compact') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const result = startChatSessionCompaction(sessionId);

        res.statusCode = result.status;
        res.end(JSON.stringify(result));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/agent-progress') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        broadcastAgentProgress(body, typeof body.trigger === 'string' ? body.trigger : 'progress');

        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, deliveredToClients: agentProgressClients.size }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/curation/progress') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const result = recordCurationPhaseUpdate(body);
        if (result.ok) {
          broadcastOrchestratorStatus(getCombinedOrchestratorStatus(), 'curation_phase', {
            event: 'curation_phase',
            taskId: result.taskId,
            phase: result.phase,
            detail: result.detail ?? null,
          });
        }
        res.statusCode = result.statusCode;
        res.end(JSON.stringify(result));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/code-fix-orchestrator/enqueue') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
        const valid = suggestions
          .filter((s) => s && typeof s === 'object')
          .map((s) => ({
            id: String(s.id || '').trim(),
            suggestionId: String(s.suggestionId || s.id || '').trim(),
            feedItemId: String(s.feedItemId || s.suggestionId || s.id || '').trim(),
            originSessionId: String(s.originSessionId || '').trim(),
            title: String(s.title || '').trim(),
            text: String(s.text || '').trim(),
            proposedValue: String(s.proposedValue || '').trim(),
          }))
          .filter((s) => s.id && s.proposedValue);

        if (valid.length === 0) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'suggestions must be a non-empty array' }));
          return;
        }

        const db = getChatStatusDb();
        const taskIds = [];
        const queuedSuggestions = [];
        const responseStatuses = [];

        for (const suggestion of valid) {
          let feedOriginSessionId = '';
          try {
            const row = db.prepare(`SELECT origin_session_id AS originSessionId FROM feed WHERE id = ?`).get(suggestion.id);
            feedOriginSessionId = typeof row?.originSessionId === 'string' && row.originSessionId.trim()
              ? row.originSessionId.trim()
              : '';
          } catch {
            feedOriginSessionId = '';
          }

          const activeTaskRow = db.prepare(
            `SELECT task_id AS taskId, status FROM code_fix_tasks
             WHERE suggestion_id = ? AND status IN ('queued', 'dispatched', 'running')
             ORDER BY id DESC LIMIT 1`,
          ).get(suggestion.id);
          if (activeTaskRow && typeof activeTaskRow.taskId === 'string' && activeTaskRow.taskId.trim()) {
            taskIds.push(activeTaskRow.taskId);
            responseStatuses.push(activeTaskRow.status);
            continue;
          }

          const taskId = buildCodeFixTaskIdFromSuggestion(suggestion);
          const originSessionId = suggestion.originSessionId || feedOriginSessionId;
          suggestion.originSessionId = originSessionId;
          taskIds.push(taskId);
          responseStatuses.push('dispatched');

          try {
            db.prepare(
              `UPDATE feed
               SET metadata = json_set(
                 COALESCE(metadata, '{}'),
                 '$.suggestionStatus', ?,
                 '$.codeFixOrchestratorStatus', ?,
                 '$.taskId', ?
               )
               WHERE id = ?`,
            ).run('dispatched', 'dispatched', taskId, suggestion.id);
          } catch (err) {
            console.warn(`[code-fix] Failed to update feed metadata for ${suggestion.id}:`, err?.message || err);
          }

          upsertCodeFixTaskRow(db, {
            suggestionId: suggestion.id,
            taskId,
            status: 'dispatched',
            phase: 'queued',
            phaseDetail: 'Queued for direct dev-task dispatch',
            error: null,
            completedAt: null,
          });

          broadcastAgentProgress({
            event: {
              event: 'code_fix_orchestrator_batch_dispatched',
              taskId,
              suggestionIds: [suggestion.id],
            },
          }, 'code_fix_orchestrator');

          queuedSuggestions.push({
            ...suggestion,
            suggestionId: suggestion.suggestionId || suggestion.id,
            feedItemId: suggestion.feedItemId || suggestion.id,
            taskId,
          });
        }

        if (queuedSuggestions.length > 0) {
          dispatchCodeFixSuggestionsForResolvedRepos(queuedSuggestions, {
            db,
            internalBaseUrl,
          });
        }

        const responseSuggestionStatus = responseStatuses.includes('dispatched')
          ? 'dispatched'
          : responseStatuses.includes('running')
            ? 'running'
            : 'dispatched';

        res.statusCode = queuedSuggestions.length > 0 ? 202 : 200;
        res.end(JSON.stringify({
          ok: true,
          suggestionStatus: responseSuggestionStatus,
          taskId: taskIds.length === 1 ? taskIds[0] : null,
          taskIds,
          agentCount: queuedSuggestions.length,
        }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to enqueue code fix suggestions',
        }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/code-fix-orchestrator/cancel') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId.trim() : '';
        const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
        const reason = typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : 'Cancelled by request.';
        const suggestionStatus = normalizeCodeFixCancelSuggestionStatus(body.suggestionStatus);

        if (!suggestionId && !taskId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'suggestionId or taskId is required' }));
          return;
        }

        const db = getChatStatusDb();
        const targets = getCodeFixCancelTargets(db, { suggestionId, taskId });
        if (targets.length === 0) {
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, cancelled: false, taskIds: [], suggestionIds: [] }));
          return;
        }

        const nowIso = new Date().toISOString();
        const taskIds = [...new Set(targets.map((target) => target.taskId).filter(Boolean))];
        const suggestionIds = [...new Set(targets.map((target) => target.suggestionId).filter(Boolean))];

        for (const target of targets) {
          const stopResult = stopDevAgentUnit(target.taskId);
          if (!stopResult.ok && !stopResult.skipped) {
            console.warn(`[code-fix-cancel] failed to stop ${stopResult.unit}: ${stopResult.error || 'unknown error'}`);
          }

          db.prepare(`
            UPDATE code_fix_tasks
            SET status = 'cancelled',
                phase = 'cancelled',
                phase_detail = ?,
                error = NULL,
                completed_at = ?
            WHERE task_id = ?
              AND suggestion_id = ?
              AND status IN ('dispatched', 'running')
          `).run(reason.slice(0, 500), nowIso, target.taskId, target.suggestionId);

          const originSessionId = typeof target.originSessionId === 'string' ? target.originSessionId.trim() : '';
          if (!originSessionId) {
            console.warn(`[code-fix-cancel] skipping git cleanup for ${target.taskId}: missing origin session id`);
          } else {
            try {
              cleanupCodeFixTaskGitState(
                target.taskId,
                resolveCodeFixRepoDirForOriginSession(db, originSessionId),
              );
            } catch (err) {
              console.warn(`[code-fix-cancel] skipping git cleanup for ${target.taskId}: ${err?.message || err}`);
            }
          }
          await postCodeFixCancellationChatNote({
            db,
            taskId: target.taskId,
            suggestionId: target.suggestionId,
            reason,
            suggestionStatus,
          });

          broadcastAgentProgress({
            event: {
              event: 'code_fix_progress',
              taskId: target.taskId,
              suggestionId: target.suggestionId,
              phase: 'cancelled',
              detail: reason,
            },
          }, 'code_fix_orchestrator');
        }

        for (const cancelledSuggestionId of suggestionIds) {
          db.prepare(`
            UPDATE feed
            SET metadata = json_set(
              COALESCE(metadata, '{}'),
              '$.suggestionStatus', ?,
              '$.codeFixOrchestratorStatus', 'cancelled',
              '$.codeFixCancellationReason', ?,
              '$.codeFixPhase', 'cancelled',
              '$.codeFixPhaseDetail', ?,
              '$.codeFixLastReportAt', ?
            )
            WHERE id = ?
          `).run(suggestionStatus, reason, reason.slice(0, 500), nowIso, cancelledSuggestionId);
        }

        broadcastAgentProgress({
          event: {
            event: 'code_fix_orchestrator_batch_cancelled',
            taskId: taskIds.length === 1 ? taskIds[0] : null,
            taskIds,
            suggestionIds,
            suggestionStatus,
            reason,
          },
        }, 'code_fix_orchestrator');

        res.statusCode = 200;
        res.end(JSON.stringify({
          ok: true,
          cancelled: true,
          taskIds,
          suggestionIds,
        }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to cancel code fix task',
        }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/internal/config-apply-orchestrator/enqueue') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const task = body.task && typeof body.task === 'object' ? body.task : null;
        const taskId = String(task?.taskId || '').trim();
        const suggestionId = String(task?.suggestionId || '').trim();
        const target = String(task?.target || '').trim();
        const sectionName = String(task?.sectionName || '').trim();
        const proposedValue = String(task?.proposedValue || '');
        const diff = typeof task?.diff === 'string' ? task.diff : '';

        if (!taskId || !suggestionId || !['config', 'curation-prompt'].includes(target) || !sectionName || !proposedValue.trim()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'taskId, suggestionId, target, sectionName, and proposedValue are required' }));
          return;
        }

        const db = getChatStatusDb();
        db.prepare(`
          INSERT INTO config_apply_tasks (suggestion_id, task_id, target, status, phase, phase_detail)
          VALUES (?, ?, ?, 'dispatched', 'queued', ?)
          ON CONFLICT(suggestion_id, task_id) DO UPDATE SET
            target = excluded.target,
            status = 'dispatched',
            phase = 'queued',
            phase_detail = excluded.phase_detail,
            error = NULL,
            result_json = NULL,
            completed_at = NULL
        `).run(suggestionId, taskId, target, `Queued apply for ${target}`);

        db.prepare(
          `UPDATE feed SET metadata = json_set(COALESCE(metadata, '{}'), '$.suggestionStatus', ?, '$.configApplyStatus', ?, '$.taskId', ?, '$.configApplyError', NULL) WHERE id = ?`,
        ).run('dispatched', 'dispatched', taskId, suggestionId);

        await enqueueBackgroundJob(BACKGROUND_JOB_NAMES.CONFIG_APPLY, {
          task: {
            taskId,
            suggestionId,
            target,
            relativePath: target === 'config' ? 'data/config.md' : 'data/curation-prompt.md',
            sectionName,
            proposedValue,
            ...(diff ? { diff } : {}),
          },
        }, {
          jobId: `config-apply-${taskId}`,
        });

        res.statusCode = 202;
        res.end(JSON.stringify({
          ok: true,
          taskId,
          suggestionStatus: 'dispatched',
        }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to enqueue config apply task',
        }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/orchestrator/enqueue') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const message = typeof body.message === 'string' ? body.message : '';
        let timeoutMs;

        if (Object.hasOwn(body, 'timeoutMs')) {
          if (!Number.isInteger(body.timeoutMs) || body.timeoutMs <= 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'timeoutMs must be a positive integer' }));
            return;
          }
          timeoutMs = Math.min(body.timeoutMs, TASK_TIMEOUT_MS_BY_PRIORITY.heartbeat);
        }

        if (!backgroundJobsDisabled) {
          const backgroundResult = await enqueueRedisBackgroundTask({
            message,
            priority: typeof body.priority === 'string' ? body.priority : undefined,
            source: typeof body.source === 'string' ? body.source : undefined,
            metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : null,
            requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
            timeoutMs,
          });

          if (backgroundResult) {
            res.statusCode = backgroundResult.ok ? 202 : 400;
            res.end(JSON.stringify(backgroundResult));
            return;
          }
        }

        const result = orchestrator.enqueue({
          message,
          priority: typeof body.priority === 'string' ? body.priority : undefined,
          source: typeof body.source === 'string' ? body.source : undefined,
          metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : null,
          requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
          timeoutMs,
        });

        if (!result.ok) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: result.error || 'Invalid enqueue request' }));
          return;
        }

        res.statusCode = 202;
        res.end(JSON.stringify(result));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/orchestrator/status') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify(getCombinedOrchestratorStatus()));
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/orchestrator/cancel') {
      res.setHeader('Content-Type', 'application/json');

      try {
        const body = await readJsonBody(req);
        const taskId = typeof body.taskId === 'string' ? body.taskId : null;
        const result = orchestrator.cancelCurrentTask(taskId);
        res.statusCode = result.ok ? 200 : 409;
        res.end(JSON.stringify(result));
      } catch {
        const result = orchestrator.cancelCurrentTask(null);
        res.statusCode = result.ok ? 200 : 409;
        res.end(JSON.stringify(result));
      }
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/orchestrator/history/')) {
      res.setHeader('Content-Type', 'application/json');
      let taskId = '';
      try {
        taskId = decodeURIComponent(parsedUrl.pathname.replace('/api/orchestrator/history/', '').trim());
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'Invalid task id' }));
        return;
      }
      const task = orchestrator.history.find((item) => item.id === taskId);

      if (!task) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: 'Task not found' }));
        return;
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        id: task.id,
        source: task.source,
        priority: task.priority,
        state: task.state,
        message: task.message,
        response: task.response,
        enqueuedAt: task.enqueuedAt,
        startedAt: task.startedAt,
        sentAt: task.sentAt,
        completedAt: task.completedAt,
        logFile: task.logFile,
        error: task.error,
      }));
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/internal/ws-status') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({
        clients: feedClients.size + orchestratorClients.size + chatClients.size + agentProgressClients.size,
        feedClients: feedClients.size,
        orchestratorClients: orchestratorClients.size,
        chatClients: chatClients.size,
        agentProgressClients: agentProgressClients.size,
      }));
      return;
    }

    return handle(req, res, parsedUrl);
  });
  server.requestTimeout = 0;

  const feedWss = new WebSocketServer({ noServer: true });
  const orchestratorWss = new WebSocketServer({ noServer: true });
  const chatWss = new WebSocketServer({ noServer: true });
  const agentProgressWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    const { pathname } = parseUrl(request.url || '/');

    if (pathname !== '/ws/feed' && !trustNetwork && !(await isTrustedSocket(request))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pathname !== '/ws/feed') {
      const origin = request.headers.origin;
      const host = request.headers.host;

      if (origin && host) {
        let originHost = '';

        try {
          originHost = new URL(origin).host;
        } catch {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        if (originHost !== host) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    }

    if (pathname === '/ws/feed') {
      feedWss.handleUpgrade(request, socket, head, (ws) => {
        feedWss.emit('connection', ws, request);
      });
      return;
    }

    if (pathname === '/ws/orchestrator') {
      orchestratorWss.handleUpgrade(request, socket, head, (ws) => {
        orchestratorWss.emit('connection', ws, request);
      });
      return;
    }

    if (pathname === '/ws/chat') {
      chatWss.handleUpgrade(request, socket, head, (ws) => {
        chatWss.emit('connection', ws, request);
      });
      return;
    }

    if (pathname === '/ws/agent-progress') {
      agentProgressWss.handleUpgrade(request, socket, head, (ws) => {
        agentProgressWss.emit('connection', ws, request);
      });
      return;
    }

    socket.destroy();
  });

  feedWss.on('connection', (ws) => {
    feedClients.add(ws);

    ws.on('close', () => {
      feedClients.delete(ws);
    });

    ws.on('error', () => {
      feedClients.delete(ws);
    });
  });

  orchestratorWss.on('connection', (ws) => {
    orchestratorClients.add(ws);

    ws.send(JSON.stringify({
      type: 'orchestrator_status',
      trigger: 'connected',
      status: getCombinedOrchestratorStatus(),
      ts: new Date().toISOString(),
    }));

    ws.on('close', () => {
      orchestratorClients.delete(ws);
    });

    ws.on('error', () => {
      orchestratorClients.delete(ws);
    });
  });

  chatWss.on('connection', (ws) => {
    chatClients.add(ws);

    ws.send(JSON.stringify({
      type: 'chat_status',
      trigger: 'connected',
      ts: new Date().toISOString(),
    }));

    ws.on('close', () => {
      chatClients.delete(ws);
    });

    ws.on('error', () => {
      chatClients.delete(ws);
    });
  });

  agentProgressWss.on('connection', (ws) => {
    agentProgressClients.add(ws);

    ws.send(JSON.stringify({
      type: 'agent_progress',
      trigger: 'connected',
      event: null,
      agent: null,
      ts: new Date().toISOString(),
    }));

    ws.on('close', () => {
      agentProgressClients.delete(ws);
    });

    ws.on('error', () => {
      agentProgressClients.delete(ws);
    });
  });

  retireOrphanedQueuedChatMessagesOnStartup();

  // Watchdog for silent dev-agent death: every 60s, scan code_fix_tasks rows
  // with status='running' and check whether their systemd unit is still active.
  // If a row's unit has exited without the agent posting a terminal report,
  // synthesize a 'failed' report so the chat callback fires and the row closes.
  // Grace period: 90s after row creation (let the unit come up).
  function checkCodeFixSilentDeath() {
    let runningTasks;
    try {
      const db = getChatStatusDb();
      runningTasks = db.prepare(`
        SELECT task_id AS taskId, suggestion_id AS suggestionId, started_at AS startedAt,
               phase, phase_detail AS phaseDetail
        FROM code_fix_tasks
        WHERE status IN ('running', 'dispatched')
          AND (julianday('now') - julianday(started_at)) * 86400 > 90
      `).all();
    } catch (err) {
      console.warn('[code-fix-watchdog] db read failed:', err?.message || err);
      return;
    }

    if (!Array.isArray(runningTasks) || runningTasks.length === 0) {
      return;
    }

    const { execSync } = require('node:child_process');
    const baseUrl = `http://127.0.0.1:${port}`;

    for (const task of runningTasks) {
      const unit = `evogent-dev-agent-${task.taskId}.service`;
      let active = false;
      try {
        execSync(`systemctl is-active --quiet ${JSON.stringify(unit)}`, { stdio: 'pipe', timeout: 5000 });
        active = true;
      } catch {
        active = false;
      }
      if (active) continue;

      // Capacity-queued or never-spawned tasks are NOT silent deaths.
      // They are waiting for a slot; the re-dispatch sweep handles them.
      const phase = typeof task.phase === 'string' ? task.phase : '';
      if (phase === 'queued' || phase === 'agent_dispatch') {
        continue;
      }

      console.warn(`[code-fix-watchdog] silent death detected: task=${task.taskId} suggestion=${task.suggestionId} unit=${unit}`);
      void fetch(`${baseUrl}/api/internal/code-fix/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.taskId,
          suggestionId: task.suggestionId,
          phase: 'watchdog_silent_death',
          status: 'failed',
          reason: `Dev-agent systemd unit (${unit}) exited without sending a terminal report. The agent likely hit RuntimeMaxSec, OOM, or crashed mid-work. Inspect /root/evogent-worktrees/${task.taskId} if it still exists.`,
        }),
      }).catch((err) => {
        console.warn('[code-fix-watchdog] failed to post synthetic failure:', err?.message || err);
      });
    }
  }

  function startCodeFixSilentDeathWatchdog() {
    setTimeout(() => { checkCodeFixSilentDeath(); }, 30_000);
    const timer = setInterval(checkCodeFixSilentDeath, 60_000);
    timer.unref();
    console.log('> Code-fix silent-death watchdog scheduled (60s interval)');
  }

  // Periodic janitor for code-fix worktrees. Worktrees from failed dev-agent
  // runs are intentionally kept for inspection, but with no janitor they
  // accumulate forever. This sweep removes orphans older than a grace period,
  // while preserving live (systemd-active) work and worktrees whose branch
  // still exists in their source repo (work-in-progress / pending).
  function checkWorktreeJanitor() {
    const graceHours = Number(process.env.MEDIA_AGENT_WORKTREE_JANITOR_GRACE_HOURS) || 24;
    const graceMs = graceHours * 60 * 60 * 1000;

    let repoRows;
    try {
      const db = getChatStatusDb();
      repoRows = db.prepare(`
        SELECT DISTINCT s.working_directory AS repoDir
        FROM code_fix_tasks AS t
        JOIN feed AS f ON f.id = t.suggestion_id
        JOIN chat_sessions AS s ON s.id = f.origin_session_id
        WHERE (t.status IN ('queued', 'dispatched', 'running')
            OR datetime(t.started_at) >= datetime('now', '-30 days'))
          AND COALESCE(TRIM(s.working_directory), '') != ''
      `).all();
    } catch (err) {
      console.warn('[code-fix-janitor] db read failed:', err?.message || err);
      return;
    }

    const repoDirs = [...new Set(repoRows
      .map(({ repoDir }) => (typeof repoDir === 'string' ? repoDir.trim() : ''))
      .filter(Boolean))];
    if (repoDirs.length === 0) return;

    console.log(`[code-fix-janitor] sweeping worktree bases: ${repoDirs.map((repoDir) => `${repoDir}-worktrees`).join(', ')}`);
    const now = Date.now();

    for (const repoDir of repoDirs) {
      const worktreesRoot = path.resolve(`${repoDir}-worktrees`);
      let entries;
      try {
        entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
      } catch (err) {
        if (err?.code !== 'ENOENT') console.warn(`[code-fix-janitor] readdir failed for ${worktreesRoot}:`, err?.message || err);
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        const fullPath = path.resolve(worktreesRoot, name);
        if (!fullPath.startsWith(`${worktreesRoot}${path.sep}`)) {
          console.warn(`[code-fix-janitor] refusing to remove worktree outside ${worktreesRoot}: ${fullPath}`);
          continue;
        }

        const unit = `evogent-dev-agent-${name}.service`;
        try {
          execFileSync('systemctl', ['is-active', '--quiet', unit], { stdio: 'pipe', timeout: 5000 });
          continue;
        } catch {}

        try {
          execFileSync('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`], { stdio: 'pipe', timeout: 5000 });
          continue;
        } catch {}

        let mtimeMs;
        try {
          const stat = fs.statSync(fullPath);
          mtimeMs = stat.mtimeMs;
        } catch (err) {
          console.warn(`[code-fix-janitor] stat failed for ${fullPath}:`, err?.message || err);
          continue;
        }
        const ageMs = now - mtimeMs;
        if (ageMs < graceMs) continue;

        const ageHours = (ageMs / 3_600_000).toFixed(1);
        console.log(`[code-fix-janitor] removing orphan worktree ${fullPath} (age=${ageHours}h, grace=${graceHours}h)`);
        try {
          execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', fullPath], { stdio: 'pipe', timeout: 30_000 });
        } catch (err) {
          console.warn(`[code-fix-janitor] git worktree remove failed for ${fullPath}: ${err?.message || err}`);
        }
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[code-fix-janitor] rm -rf failed for ${fullPath}: ${err?.message || err}`);
        }
      }
    }
  }

  function startWorktreeJanitor() {
    setTimeout(() => { checkWorktreeJanitor(); }, 60_000);
    const timer = setInterval(checkWorktreeJanitor, 5 * 60_000);
    timer.unref();
    const graceHours = Number(process.env.MEDIA_AGENT_WORKTREE_JANITOR_GRACE_HOURS) || 24;
    console.log(`> Worktree janitor scheduled (5min interval, ${graceHours}h grace)`);
  }

  // Re-dispatch sweep: when a code-fix task was queued (status='dispatched' phase='queued')
  // OR rejected by the concurrency cap (phase='agent_dispatch' with capacity reason),
  // and no live systemd unit exists for it, retry the dispatch so queued work doesn't stall.
  function checkCodeFixRedispatch() {
    let db;
    let queuedTasks;
    try {
      db = getChatStatusDb();
      queuedTasks = db.prepare(`
        SELECT t.task_id AS taskId, t.suggestion_id AS suggestionId,
               t.phase AS phase, t.phase_detail AS phaseDetail, t.status AS status,
               t.started_at AS startedAt,
               f.title AS title, f.text AS text, f.origin_session_id AS originSessionId,
               f.metadata AS metadata
        FROM code_fix_tasks t
        LEFT JOIN feed f ON f.id = t.suggestion_id
        WHERE t.status IN ('running', 'dispatched')
          AND (t.phase = 'queued' OR t.phase = 'agent_dispatch')
          AND (julianday('now') - julianday(t.started_at)) * 86400 > 120
      `).all();
    } catch (err) {
      console.warn('[code-fix-redispatch] db read failed:', err?.message || err);
      return;
    }

    if (!Array.isArray(queuedTasks) || queuedTasks.length === 0) return;

    const { execSync } = require('node:child_process');
    const { countActiveDevAgentUnits, getMaxConcurrentDevAgents } = require('./lib/agent-self-orchestrate');

    let activeCount = 0;
    try { activeCount = countActiveDevAgentUnits(); } catch { activeCount = 0; }
    const cap = getMaxConcurrentDevAgents();
    let availableSlots = Math.max(0, cap - activeCount);
    if (availableSlots <= 0) return;

    const fs = require('node:fs');
    const path = require('node:path');
    const toDispatch = [];
    for (const task of queuedTasks) {
      if (availableSlots <= 0) break;
      const unit = `evogent-dev-agent-${task.taskId}.service`;
      let active = false;
      try {
        execSync(`systemctl is-active --quiet ${JSON.stringify(unit)}`, { stdio: 'pipe', timeout: 5000 });
        active = true;
      } catch {
        active = false;
      }
      if (active) continue;
      // If a worktree directory exists, an in-flight dispatcher is mid-setup. Skip.
      let repoDir;
      try {
        repoDir = resolveCodeFixRepoDirForOriginSession(
          db,
          typeof task.originSessionId === 'string' ? task.originSessionId : '',
        );
      } catch (err) {
        console.warn(`[code-fix-redispatch] skipping ${task.taskId}: ${err?.message || err}`);
        continue;
      }
      try {
        const worktreesBase = `${repoDir}-worktrees`;
        if (fs.existsSync(path.join(worktreesBase, task.taskId))) continue;
      } catch { /* fall through */ }

      let metadata = {};
      if (typeof task.metadata === 'string' && task.metadata.trim()) {
        try { metadata = JSON.parse(task.metadata); } catch { metadata = {}; }
      }
      const proposedValue = typeof metadata?.proposedValue === 'string' ? metadata.proposedValue.trim() : '';
      if (!proposedValue) continue;

      toDispatch.push({
        id: task.suggestionId,
        suggestionId: task.suggestionId,
        feedItemId: task.suggestionId,
        originSessionId: typeof task.originSessionId === 'string' ? task.originSessionId : '',
        title: typeof task.title === 'string' ? task.title : '',
        text: typeof task.text === 'string' ? task.text : '',
        proposedValue,
        taskId: task.taskId,
      });
      availableSlots -= 1;
    }

    if (toDispatch.length === 0) return;

    console.log(`[code-fix-redispatch] re-dispatching ${toDispatch.length} queued task(s) (cap=${cap}, active=${activeCount})`);
    try {
      dispatchCodeFixSuggestionsForResolvedRepos(toDispatch, {
        db,
        internalBaseUrl: `http://127.0.0.1:${port}`,
      });
    } catch (err) {
      console.warn('[code-fix-redispatch] dispatch failed:', err?.message || err);
    }
  }

  function startCodeFixRedispatchSweep() {
    setTimeout(() => { checkCodeFixRedispatch(); }, 15_000);
    const timer = setInterval(checkCodeFixRedispatch, 30_000);
    timer.unref();
    console.log('> Code-fix re-dispatch sweep scheduled (30s interval)');
  }

  server.listen(port, hostname, async () => {
    await initializeWatchersOnStartup();
    await orchestrator.checkBrainAvailability();

    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket feed updates at ws://${hostname}:${port}/ws/feed`);
    console.log(`> WebSocket orchestrator updates at ws://${hostname}:${port}/ws/orchestrator`);
    console.log(`> WebSocket chat updates at ws://${hostname}:${port}/ws/chat`);
    console.log(`> WebSocket agent progress at ws://${hostname}:${port}/ws/agent-progress`);
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && !trustNetwork) {
      console.log(`> Evogent listening on ${hostname}:${port}. Chat / write / agent-spawn APIs default to loopback-only; front the app with cloudflared+Cloudflare Access (recommended) or set MEDIA_AGENT_TRUST_NETWORK=1 only after putting an auth proxy in place. See docs/security.md.`);
    }
    if (trustNetwork) {
      console.log('> MEDIA_AGENT_TRUST_NETWORK=1 is set. DANGEROUS unless an authenticated reverse proxy is in front.');
      console.log('> Evogent trusts the network to authenticate users. Make sure you have Cloudflare Access (or an equivalent auth proxy)');
      console.log('> in front of every hostname that reaches this app. Without that, chat / agent-spawn endpoints are reachable from the internet. See docs/security.md.');
    }
    markRestartStateReadyOnStartup();

    ensureReflectionStatusFile();

    if (backgroundJobsDisabled) {
      console.log('> Background startup jobs disabled by MEDIA_AGENT_DISABLE_BACKGROUND_JOBS=1');
      return;
    }

    console.log('> Background timers moved to worker.js');
    void regeneratePreferenceContextOnStartup();
    startCodeFixSilentDeathWatchdog();
    startWorktreeJanitor();
    startCodeFixRedispatchSweep();
  });
});
