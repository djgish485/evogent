import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { getDataPath } from '@/lib/data-dir';
import { inferAgentOutcomeFromLogContent, parseAgentLogEvents } from '@/lib/agent-log-events';
import {
  spawnSubAgent,
  type SpawnSubAgentOptions,
  type SubAgentStatus,
  type SubAgentType,
} from '@/lib/sub-agent';
import { getDb } from '@/lib/db/client';

export type AgentProgressEventType =
  | 'status'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'completion'
  | 'system'
  | 'error';

export interface AgentProgressEvent {
  id: string;
  agentId: string;
  type: AgentProgressEventType;
  createdAt: string;
  message?: string;
  toolName?: string;
  toolUseId?: string;
  isError?: boolean;
  durationMs?: number;
  rawType?: string;
  details?: Record<string, unknown>;
}

export interface AgentSnapshot {
  id: string;
  type: SubAgentType;
  status: SubAgentStatus;
  logFile: string;
  pid: number | null;
  startedAt: string;
  completedAt: string | null;
  timeoutMs: number;
  timeoutAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  progressCount: number;
  lastEventAt: string | null;
}

export interface AgentDetail extends AgentSnapshot {
  progress: AgentProgressEvent[];
}

export interface SpawnManagedAgentRequest {
  type: SubAgentType;
  prompt: string;
  options?: SpawnSubAgentOptions & {
    timeoutMs?: number;
  };
}

interface RuntimeAgentRecord {
  id: string;
  pid: number | null;
  process: ChildProcess | null;
  logFile: string | null;
  timeoutMs: number;
  timeoutAt: string;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  finalizing: boolean;
}

interface LogReaderState {
  logFile: string;
  agentId: string;
  readOffset: number;
  partialLineBuffer: string;
  flushScheduled: boolean;
}

interface AgentDbRow {
  id: string;
  type: string;
  status: string;
  pid: number | null;
  logFile: string | null;
  startedAt: string;
  completedAt: string | null;
  timeoutMs: number | null;
  timeoutAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  progressCount: number;
  lastEventAt: string | null;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_PROGRESS_EVENTS = 600;
const MAX_EVENT_MESSAGE_CHARS = 320;
const PID_MONITOR_INTERVAL_MS = 10_000;
const AGENT_LOGS_DIR = getDataPath('agent-logs');
const defaultNotifyUrl = `http://127.0.0.1:${process.env.PORT || '3001'}/api/internal/agent-progress`;

const AGENT_SELECT_COLUMNS = `
  id,
  type,
  status,
  pid,
  log_file AS logFile,
  started_at AS startedAt,
  completed_at AS completedAt,
  timeout_ms AS timeoutMs,
  timeout_at AS timeoutAt,
  exit_code AS exitCode,
  signal,
  error,
  COALESCE(progress_count, 0) AS progressCount,
  last_event_at AS lastEventAt
`;

function randomEventId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyContent(entry)).join('\n');
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable object]';
    }
  }

  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function truncateMessage(value: string, maxLength = MAX_EVENT_MESSAGE_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function truncatePromptPreview(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function resolveEventTimestamp(raw: Record<string, unknown>): string {
  const candidates = [
    raw.timestamp,
    raw.createdAt,
    raw.created_at,
    raw.ts,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

function summarizeToolInput(input?: Record<string, unknown>): string | undefined {
  if (!input) {
    return undefined;
  }

  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const pathValue = typeof input.file_path === 'string'
    ? input.file_path.trim()
    : (typeof input.path === 'string' ? input.path.trim() : '');
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';

  const summaryParts = [];
  if (query) summaryParts.push(query);
  if (command) summaryParts.push(command);
  if (prompt) summaryParts.push(prompt);
  if (url) summaryParts.push(url);
  if (pathValue) summaryParts.push(pathValue);
  if (pattern) summaryParts.push(pattern);
  if (description) summaryParts.push(description);

  if (summaryParts.length > 0) {
    return truncateMessage(summaryParts.join(' | '));
  }

  const fallback = stringifyContent(input);
  if (!fallback) {
    return undefined;
  }

  return truncateMessage(fallback);
}

function parseStreamJsonEvents(agentId: string, raw: Record<string, unknown>): AgentProgressEvent[] {
  return parseAgentLogEvents(raw).map((event) => ({
    id: randomEventId(),
    agentId,
    ...event,
  }));
}

function isPidAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

class AgentManager {
  private initialized = false;

  private runtimeAgents = new Map<string, RuntimeAgentRecord>();

  private progressEvents = new Map<string, AgentProgressEvent[]>();

  private logFileToAgentId = new Map<string, string>();

  private logReaders = new Map<string, LogReaderState>();

  private directoryWatcher: fs.FSWatcher | null = null;

  private pollTimer: NodeJS.Timeout | null = null;

  private pidMonitorTimer: NodeJS.Timeout | null = null;

  async ensureReady() {
    if (this.initialized) {
      return;
    }

    await fs.promises.mkdir(AGENT_LOGS_DIR, { recursive: true });

    this.directoryWatcher = fs.watch(AGENT_LOGS_DIR, (_eventType, maybeFileName) => {
      const fileName = typeof maybeFileName === 'string' ? maybeFileName : '';
      if (!fileName.endsWith('.jsonl')) {
        return;
      }

      const logFile = path.join(AGENT_LOGS_DIR, fileName);
      const reader = this.findOrCreateLogReader(logFile);
      this.scheduleLogRead(reader);
    });

    this.directoryWatcher.on('error', (error) => {
      console.warn('[agent-manager] log watcher error', error);
    });

    this.directoryWatcher.unref();

    this.pollTimer = setInterval(() => {
      this.scanAgentLogsDir();
    }, 5000);
    this.pollTimer.unref();

    this.pidMonitorTimer = setInterval(() => {
      void this.checkRuntimeAgents();
    }, PID_MONITOR_INTERVAL_MS);
    this.pidMonitorTimer.unref();

    await this.recoverRunningAgents();

    this.initialized = true;
  }

  async spawnAgent(request: SpawnManagedAgentRequest): Promise<AgentSnapshot> {
    await this.ensureReady();

    const timeoutMs = request.options?.timeoutMs && request.options.timeoutMs > 0
      ? request.options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

    const typedSpawnOptions: SpawnSubAgentOptions = { ...(request.options ?? {}) };
    delete (typedSpawnOptions as SpawnSubAgentOptions & { timeoutMs?: number }).timeoutMs;

    const handle = await spawnSubAgent(request.type, request.prompt, typedSpawnOptions);
    const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();

    getDb().prepare(`
      INSERT INTO agents (
        id,
        type,
        status,
        pid,
        log_file,
        prompt_preview,
        started_at,
        completed_at,
        timeout_ms,
        timeout_at,
        exit_code,
        signal,
        error,
        progress_count,
        last_event_at
      ) VALUES (
        @id,
        @type,
        'running',
        @pid,
        @logFile,
        @promptPreview,
        @startedAt,
        NULL,
        @timeoutMs,
        @timeoutAt,
        NULL,
        NULL,
        NULL,
        0,
        NULL
      )
    `).run({
      id: handle.id,
      type: request.type,
      pid: handle.process.pid ?? null,
      logFile: handle.logFile,
      promptPreview: truncatePromptPreview(request.prompt),
      startedAt: handle.startedAt,
      timeoutMs,
      timeoutAt,
    });

    const runtime = this.registerRuntimeAgent({
      id: handle.id,
      pid: handle.process.pid ?? null,
      process: handle.process,
      logFile: handle.logFile,
      timeoutMs,
      timeoutAt,
    });

    handle.process.once('error', (error) => {
      getDb().prepare('UPDATE agents SET error = @error WHERE id = @id').run({
        id: handle.id,
        error: error.message,
      });
      this.pushStatusEvent(handle.id, 'error', error.message);
    });

    handle.process.once('exit', (code, signal) => {
      void this.onRuntimeExit(runtime.id, code, signal);
    });

    this.pushStatusEvent(handle.id, 'status', `Agent spawned (${request.type})`);

    const snapshot = this.getAgentSnapshot(handle.id);
    if (!snapshot) {
      throw new Error('Failed to persist spawned agent');
    }

    return snapshot;
  }

  listAgents(): AgentSnapshot[] {
    const rows = getDb().prepare(`
      SELECT ${AGENT_SELECT_COLUMNS}
      FROM agents
      ORDER BY started_at DESC
    `).all() as AgentDbRow[];

    return rows.map((row) => this.toSnapshot(row));
  }

  getRunningAgents(): AgentSnapshot[] {
    const rows = getDb().prepare(`
      SELECT ${AGENT_SELECT_COLUMNS}
      FROM agents
      WHERE status = 'running'
      ORDER BY started_at DESC
    `).all() as AgentDbRow[];

    return rows.map((row) => this.toSnapshot(row));
  }

  getAgentStatus(id: string): AgentDetail | null {
    const snapshot = this.getAgentSnapshot(id);
    if (!snapshot) {
      return null;
    }

    return {
      ...snapshot,
      progress: [...(this.progressEvents.get(id) ?? [])],
    };
  }

  async killAgent(id: string, reason: 'killed' | 'timed_out' = 'killed'): Promise<boolean> {
    const row = this.getAgentRow(id);
    if (!row || row.status !== 'running') {
      return false;
    }

    const timeoutError = `Agent exceeded timeout (${Math.round(this.resolveTimeoutMs(row) / 1000)}s)`;
    const nextError = reason === 'timed_out' ? timeoutError : row.error;
    const nextStatus = reason;

    getDb().prepare(`
      UPDATE agents
      SET
        status = @status,
        error = @error,
        completed_at = COALESCE(completed_at, @completedAt)
      WHERE id = @id
    `).run({
      id,
      status: nextStatus,
      error: nextError,
      completedAt: new Date().toISOString(),
    });

    if (reason === 'timed_out') {
      this.pushStatusEvent(id, 'error', timeoutError);
    } else {
      this.pushStatusEvent(id, 'status', 'Agent kill requested');
    }

    const runtime = this.runtimeAgents.get(id);
    const pid = runtime?.pid ?? row.pid;

    try {
      if (!pid) {
        throw new Error('Agent process PID is unavailable');
      }

      process.kill(pid, 'SIGTERM');

      const killTimer = setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // No-op: process likely already exited.
        }
      }, 5000);

      if (runtime) {
        if (runtime.killTimer) {
          clearTimeout(runtime.killTimer);
        }
        runtime.killTimer = killTimer;
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to kill process';
      getDb().prepare('UPDATE agents SET error = @error WHERE id = @id').run({
        id,
        error: message,
      });
      this.pushStatusEvent(id, 'error', message);
      return false;
    }
  }

  private async recoverRunningAgents() {
    const rows = getDb().prepare(`
      SELECT ${AGENT_SELECT_COLUMNS}
      FROM agents
      WHERE status = 'running'
      ORDER BY started_at ASC
    `).all() as AgentDbRow[];

    for (const row of rows) {
      if (!isPidAlive(row.pid)) {
        getDb().prepare(`
          UPDATE agents
          SET
            status = 'failed',
            error = 'process died during restart',
            completed_at = COALESCE(completed_at, @completedAt)
          WHERE id = @id
        `).run({
          id: row.id,
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      this.registerRuntimeAgent({
        id: row.id,
        pid: row.pid,
        process: null,
        logFile: row.logFile,
        timeoutMs: this.resolveTimeoutMs(row),
        timeoutAt: this.resolveTimeoutAt(row),
        startReaderAtEnd: true,
      });
    }
  }

  private registerRuntimeAgent(params: {
    id: string;
    pid: number | null;
    process: ChildProcess | null;
    logFile: string | null;
    timeoutMs: number;
    timeoutAt: string;
    startReaderAtEnd?: boolean;
  }): RuntimeAgentRecord {
    const existing = this.runtimeAgents.get(params.id);
    if (existing) {
      this.clearRuntimeTimers(existing);
      this.runtimeAgents.delete(params.id);
    }

    const runtime: RuntimeAgentRecord = {
      id: params.id,
      pid: params.pid,
      process: params.process,
      logFile: params.logFile,
      timeoutMs: params.timeoutMs,
      timeoutAt: params.timeoutAt,
      timeoutTimer: null,
      killTimer: null,
      finalizing: false,
    };

    if (runtime.logFile) {
      this.logFileToAgentId.set(runtime.logFile, runtime.id);
      const reader = this.findOrCreateLogReader(runtime.logFile, runtime.id);
      if (params.startReaderAtEnd) {
        void this.seekReaderToEnd(reader);
      } else {
        this.scheduleLogRead(reader);
      }
    }

    this.scheduleTimeout(runtime);
    this.runtimeAgents.set(runtime.id, runtime);
    return runtime;
  }

  private async checkRuntimeAgents() {
    const ids = [...this.runtimeAgents.keys()];
    for (const id of ids) {
      const runtime = this.runtimeAgents.get(id);
      if (!runtime || runtime.finalizing) {
        continue;
      }

      const row = this.getAgentRow(id);
      if (!row || row.status !== 'running') {
        this.removeRuntimeAgent(id);
        continue;
      }

      if (!isPidAlive(runtime.pid)) {
        await this.handleRuntimeProcessGone(id);
      }
    }
  }

  private async handleRuntimeProcessGone(id: string) {
    const runtime = this.runtimeAgents.get(id);
    if (!runtime || runtime.finalizing) {
      return;
    }

    runtime.finalizing = true;

    if (runtime.logFile) {
      const reader = this.findOrCreateLogReader(runtime.logFile, id);
      this.scheduleLogRead(reader);
      await this.readLogDelta(reader);
    }

    const row = this.getAgentRow(id);
    if (!row) {
      this.removeRuntimeAgent(id);
      return;
    }

    let status = row.status as SubAgentStatus;
    let error = row.error;
    let exitCode = row.exitCode;

    if (row.status === 'running') {
      const inferred = await this.inferResultFromLogFile(row.logFile);
      if (inferred) {
        status = inferred.status;
        error = inferred.error;
        exitCode = inferred.exitCode;
      } else {
        status = 'failed';
        error = 'process died during restart';
        exitCode = null;
      }
    }

    getDb().prepare(`
      UPDATE agents
      SET
        status = @status,
        completed_at = COALESCE(completed_at, @completedAt),
        exit_code = @exitCode,
        signal = COALESCE(signal, @signal),
        error = @error
      WHERE id = @id
    `).run({
      id,
      status,
      completedAt: new Date().toISOString(),
      exitCode,
      signal: row.signal,
      error,
    });

    this.removeRuntimeAgent(id);

    if (status === 'completed') {
      this.pushStatusEvent(id, 'status', 'Agent completed');
    } else if (status === 'killed') {
      this.pushStatusEvent(id, 'status', 'Agent stopped');
    } else {
      this.pushStatusEvent(id, 'error', error || 'Agent stopped');
    }
  }

  private async onRuntimeExit(
    id: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) {
    const runtime = this.runtimeAgents.get(id);
    if (!runtime || runtime.finalizing) {
      return;
    }

    runtime.finalizing = true;
    if (runtime.logFile) {
      const reader = this.findOrCreateLogReader(runtime.logFile, id);
      this.scheduleLogRead(reader);
      await this.readLogDelta(reader);
    }

    const row = this.getAgentRow(id);
    if (!row) {
      this.removeRuntimeAgent(id);
      return;
    }

    let status = row.status as SubAgentStatus;
    let error = row.error;

    if (status !== 'killed' && status !== 'timed_out') {
      if (code === 0) {
        status = 'completed';
        error = null;
      } else {
        status = 'failed';
        if (!error) {
          error = `Agent exited with code ${code ?? 'unknown'}`;
        }
      }
    }

    getDb().prepare(`
      UPDATE agents
      SET
        status = @status,
        completed_at = COALESCE(completed_at, @completedAt),
        exit_code = @exitCode,
        signal = @signal,
        error = @error
      WHERE id = @id
    `).run({
      id,
      status,
      completedAt: new Date().toISOString(),
      exitCode: code,
      signal,
      error,
    });

    this.removeRuntimeAgent(id);

    if (status === 'completed') {
      this.pushStatusEvent(id, 'status', 'Agent completed');
    } else {
      this.pushStatusEvent(id, 'error', error || 'Agent stopped');
    }
  }

  private removeRuntimeAgent(id: string) {
    const runtime = this.runtimeAgents.get(id);
    if (!runtime) {
      return;
    }

    this.clearRuntimeTimers(runtime);
    this.runtimeAgents.delete(id);
  }

  private clearRuntimeTimers(runtime: RuntimeAgentRecord) {
    if (runtime.timeoutTimer) {
      clearTimeout(runtime.timeoutTimer);
      runtime.timeoutTimer = null;
    }

    if (runtime.killTimer) {
      clearTimeout(runtime.killTimer);
      runtime.killTimer = null;
    }
  }

  private scheduleTimeout(runtime: RuntimeAgentRecord) {
    const timeoutAtMs = Date.parse(runtime.timeoutAt);
    if (!Number.isFinite(timeoutAtMs)) {
      return;
    }

    const remainingMs = timeoutAtMs - Date.now();
    if (remainingMs <= 0) {
      void this.killAgent(runtime.id, 'timed_out');
      return;
    }

    runtime.timeoutTimer = setTimeout(() => {
      void this.killAgent(runtime.id, 'timed_out');
    }, remainingMs);
  }

  private resolveTimeoutMs(row: AgentDbRow): number {
    if (typeof row.timeoutMs === 'number' && row.timeoutMs > 0) {
      return row.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private resolveTimeoutAt(row: AgentDbRow): string {
    if (typeof row.timeoutAt === 'string' && row.timeoutAt) {
      return row.timeoutAt;
    }

    const timeoutMs = this.resolveTimeoutMs(row);
    const startedAtMs = Date.parse(row.startedAt);
    const fallback = Number.isFinite(startedAtMs)
      ? new Date(startedAtMs + timeoutMs)
      : new Date(Date.now() + timeoutMs);
    return fallback.toISOString();
  }

  private getAgentRow(id: string): AgentDbRow | null {
    const row = getDb().prepare(`
      SELECT ${AGENT_SELECT_COLUMNS}
      FROM agents
      WHERE id = ?
      LIMIT 1
    `).get(id) as AgentDbRow | undefined;

    return row ?? null;
  }

  private getAgentSnapshot(id: string): AgentSnapshot | null {
    const row = this.getAgentRow(id);
    if (!row) {
      return null;
    }
    return this.toSnapshot(row);
  }

  private toSnapshot(row: AgentDbRow): AgentSnapshot {
    const timeoutMs = this.resolveTimeoutMs(row);
    const timeoutAt = this.resolveTimeoutAt(row);

    return {
      id: row.id,
      type: row.type as SubAgentType,
      status: row.status as SubAgentStatus,
      logFile: row.logFile || '',
      pid: row.pid,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      timeoutMs,
      timeoutAt,
      exitCode: row.exitCode,
      signal: row.signal as NodeJS.Signals | null,
      error: row.error,
      progressCount: row.progressCount,
      lastEventAt: row.lastEventAt,
    };
  }

  private pushStatusEvent(agentId: string, type: 'status' | 'error', message: string) {
    const event: AgentProgressEvent = {
      id: randomEventId(),
      agentId,
      type,
      createdAt: new Date().toISOString(),
      message,
      isError: type === 'error',
    };

    this.persistEvent(agentId, event);
  }

  private persistEvent(agentId: string, event: AgentProgressEvent) {
    const list = this.progressEvents.get(agentId) ?? [];
    list.push(event);
    if (list.length > MAX_PROGRESS_EVENTS) {
      list.splice(0, list.length - MAX_PROGRESS_EVENTS);
    }
    this.progressEvents.set(agentId, list);

    getDb().prepare(`
      UPDATE agents
      SET
        progress_count = COALESCE(progress_count, 0) + 1,
        last_event_at = @lastEventAt
      WHERE id = @id
    `).run({
      id: agentId,
      lastEventAt: event.createdAt,
    });

    const snapshot = this.getAgentSnapshot(agentId);
    void this.notifyProgress({
      event,
      agent: snapshot ?? {
        id: agentId,
        status: 'running',
        logFile: null,
      },
    });
  }

  private async notifyProgress(payload: Record<string, unknown>) {
    const notifyUrl = process.env.INTERNAL_AGENT_PROGRESS_NOTIFY_URL || defaultNotifyUrl;

    try {
      await fetch(notifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.warn('[agent-manager] failed to notify websocket server', error);
    }
  }

  private scanAgentLogsDir() {
    for (const runtime of this.runtimeAgents.values()) {
      if (!runtime.logFile) {
        continue;
      }
      const reader = this.findOrCreateLogReader(runtime.logFile, runtime.id);
      this.scheduleLogRead(reader);
    }
  }

  private findOrCreateLogReader(logFile: string, knownAgentId?: string): LogReaderState {
    const existing = this.logReaders.get(logFile);
    if (existing) {
      if (knownAgentId && existing.agentId !== knownAgentId) {
        existing.agentId = knownAgentId;
        existing.readOffset = 0;
        existing.partialLineBuffer = '';
      }
      return existing;
    }

    const inferredAgentId = knownAgentId || this.lookupAgentByLogFile(logFile);

    const state: LogReaderState = {
      logFile,
      agentId: inferredAgentId,
      readOffset: 0,
      partialLineBuffer: '',
      flushScheduled: false,
    };

    this.logReaders.set(logFile, state);
    return state;
  }

  private lookupAgentByLogFile(logFile: string): string {
    const mapped = this.logFileToAgentId.get(logFile);
    if (mapped) {
      return mapped;
    }

    const row = getDb().prepare('SELECT id FROM agents WHERE log_file = ? LIMIT 1').get(logFile) as { id: string } | undefined;
    if (row?.id) {
      this.logFileToAgentId.set(logFile, row.id);
      return row.id;
    }

    const basename = path.basename(logFile, '.jsonl');
    return `log:${basename}`;
  }

  private scheduleLogRead(state: LogReaderState) {
    if (state.flushScheduled) {
      return;
    }

    state.flushScheduled = true;

    setTimeout(() => {
      state.flushScheduled = false;
      void this.readLogDelta(state);
    }, 30);
  }

  private async seekReaderToEnd(state: LogReaderState) {
    try {
      const stat = await fs.promises.stat(state.logFile);
      state.readOffset = stat.size;
      state.partialLineBuffer = '';
    } catch {
      // Ignore missing files during startup recovery.
    }
  }

  private async readLogDelta(state: LogReaderState) {
    try {
      const stat = await fs.promises.stat(state.logFile);

      if (stat.size < state.readOffset) {
        state.readOffset = 0;
        state.partialLineBuffer = '';
      }

      if (stat.size === state.readOffset) {
        return;
      }

      const bytesToRead = stat.size - state.readOffset;
      const file = await fs.promises.open(state.logFile, 'r');

      try {
        const chunk = Buffer.alloc(bytesToRead);
        await file.read(chunk, 0, bytesToRead, state.readOffset);
        state.readOffset = stat.size;

        const merged = state.partialLineBuffer + chunk.toString('utf8');
        const lines = merged.split('\n');
        state.partialLineBuffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          let parsed: Record<string, unknown>;
          try {
            const unknownParsed = JSON.parse(line) as unknown;
            if (!unknownParsed || typeof unknownParsed !== 'object') {
              continue;
            }
            parsed = unknownParsed as Record<string, unknown>;
          } catch {
            const fallbackEvent: AgentProgressEvent = {
              id: randomEventId(),
              agentId: state.agentId,
              type: 'error',
              createdAt: new Date().toISOString(),
              message: `Invalid JSON log line: ${line.slice(0, 160)}`,
              isError: true,
            };

            this.persistEvent(state.agentId, fallbackEvent);
            continue;
          }

          const parsedEvents = parseStreamJsonEvents(state.agentId, parsed);
          for (const event of parsedEvents) {
            this.persistEvent(state.agentId, event);
          }
        }
      } finally {
        await file.close();
      }
    } catch {
      // The file may disappear during writes/rotation; ignore transient errors.
    }
  }

  private async inferResultFromLogFile(logFile: string | null): Promise<{
    status: 'completed' | 'failed';
    exitCode: number | null;
    error: string | null;
  } | null> {
    if (!logFile) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(logFile, 'utf8');
      return inferAgentOutcomeFromLogContent(content);
    } catch {
      return null;
    }
  }
}

const globalForAgentManager = globalThis as typeof globalThis & {
  __evogentManager?: AgentManager;
};

export const agentManager = globalForAgentManager.__evogentManager ?? new AgentManager();

if (!globalForAgentManager.__evogentManager) {
  globalForAgentManager.__evogentManager = agentManager;
}

export type { SubAgentType } from '@/lib/sub-agent';
