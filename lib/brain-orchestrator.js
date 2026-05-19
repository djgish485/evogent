const { resolveBrainProvider, resolveBrainProviderByName } = require('./brain-provider');
const {
  isCacheRefreshTask,
  readLatestTerminalCacheRefreshRun,
  resolveCacheRefreshTaskSource,
  validateCacheRefreshTaskResult,
} = require('./cache-refresh-task-result');
const { estimateClaudeCostUsd } = require('./claude-prices');
const { readLatestCodexSessionLogContextMetrics } = require('./codex-session-log-metrics');
const { getUnsupportedChatCommandMessage, isChatCommandSupported } = require('./runtime-tasks');
const { resolveTaskDeadlineAt } = require('./curation-runtime');

function attachBrainTaskFailureDetails(error, details) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  normalizedError.brainTaskFailureDetails = details;
  return normalizedError;
}

function getBrainTaskFailureDetails(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const details = error.brainTaskFailureDetails;
  return details && typeof details === 'object' ? details : null;
}

function isPostEnrichmentTask(task) {
  return task?.priority === 'post_enrichment';
}

function readInvocationArg(args, flag) {
  if (!Array.isArray(args)) return null;
  const index = args.indexOf(flag);
  if (index === -1 || index >= args.length - 1) return null;
  const value = args[index + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeUsageTokenCount(value) {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : 0;
}

function applyClaudeTaskUsageMetrics(usage, metrics) {
  if (!usage || !metrics || typeof metrics !== 'object') {
    return;
  }

  const metricModel = typeof metrics.modelId === 'string' && metrics.modelId.trim()
    ? metrics.modelId.trim()
    : null;
  if (metricModel && !usage.model) {
    usage.model = metricModel;
  }

  const nextTokens = {
    inputTokens: normalizeUsageTokenCount(metrics.inputTokens),
    outputTokens: normalizeUsageTokenCount(metrics.outputTokens),
    cacheReadTokens: normalizeUsageTokenCount(metrics.cacheReadTokens),
    cacheCreateTokens: normalizeUsageTokenCount(metrics.cacheCreateTokens),
  };
  const hasTokenUsage = nextTokens.inputTokens
    + nextTokens.outputTokens
    + nextTokens.cacheReadTokens
    + nextTokens.cacheCreateTokens > 0;
  if (!hasTokenUsage) {
    return;
  }

  if (metrics.usageSource === 'result') {
    usage.inputTokens = nextTokens.inputTokens;
    usage.outputTokens = nextTokens.outputTokens;
    usage.cacheReadTokens = nextTokens.cacheReadTokens;
    usage.cacheCreateTokens = nextTokens.cacheCreateTokens;
    usage.resultUsageSeen = true;
    return;
  }

  if (usage.resultUsageSeen) {
    return;
  }

  usage.inputTokens += nextTokens.inputTokens;
  usage.outputTokens += nextTokens.outputTokens;
  usage.cacheReadTokens += nextTokens.cacheReadTokens;
  usage.cacheCreateTokens += nextTokens.cacheCreateTokens;
}

function persistClaudeTaskUsage(db, usage, completedAtMs) {
  const inputTokens = normalizeUsageTokenCount(usage.inputTokens);
  const outputTokens = normalizeUsageTokenCount(usage.outputTokens);
  const cacheReadTokens = normalizeUsageTokenCount(usage.cacheReadTokens);
  const cacheCreateTokens = normalizeUsageTokenCount(usage.cacheCreateTokens);
  db.prepare(`
    INSERT INTO claude_task_usage (
      task_id, priority, source_label, model, effort, started_at_ms, completed_at_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, estimated_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    usage.taskId,
    usage.priority,
    usage.sourceLabel,
    usage.model,
    usage.effort,
    Math.floor(usage.startedAtMs),
    Math.max(Math.floor(usage.startedAtMs), Math.floor(completedAtMs)),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    estimateClaudeCostUsd({
      model: usage.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read: cacheReadTokens,
      cache_create: cacheCreateTokens,
    }),
  );
}

function createBrainOrchestrator(deps) {
  const {
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
    broadcastChatStreaming,
    broadcastChatTyping,
    broadcastChatUpdate,
    buildSessionResetHistoryBlock,
    buildTaskPrompt,
    broadcastChatSessionLifecycle = () => {},
    cleanupExpiredTaskLogs,
    collectAssistantText,
    dataPath,
    delay,
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
    getChatSessionRuntimeInfo = () => null,
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
    recoverClaudeSessionPoison = () => ({ detected: false, truncated: false }),
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
    updateChatSessionContextMetrics = () => {},
    updateChatSessionProviderSessionId = () => {},
    writeCurationStatus,
    writeReflectionStatus,
    writeStoredChatProviderSessionId,
  } = deps;

  class BrainOrchestrator {
    constructor(sessionName = 'evogent-ephemeral') {
      this.sessionName = sessionName;
      this.historyFile = dataPath('orchestrator-history.json');
      this.configPath = dataPath('config.md');
      this.preferencesContextPath = dataPath('preferences-context.md');
      this.backgroundSessionMaxAgeMs = this._resolveBackgroundSessionMaxAgeMs();
      const persistedState = this._loadPersistedState();
      /** @type {QueueTask[]} */
      this.queue = [];
      /** @type {QueueTask | null} */
      this.currentTask = null;
      /** @type {Map<string, QueueTask>} */
      this.activeChatTasks = new Map();
      /** @type {QueueTask[]} */
      this.history = persistedState.history;
      this.sequence = this.history.length > 0
        ? Math.max(...this.history.map((t) => t.sequence || 0)) + 1
        : 0;
      this.processingPromise = null;
      this.processLoopRequested = false;
      /** @type {Set<(status: ReturnType<BrainOrchestrator['getStatus']>, trigger: string, event: Record<string, unknown> | null) => void>} */
      this.listeners = new Set();
      /** @type {Set<string>} */
      this.activeBackgroundTaskIds = new Set();
      /** @type {Map<string, Array<{ resolve: (task: QueueTask) => void, reject: (error: Error) => void }>>} */
      this.taskCompletionWaiters = new Map();
      this.chatSessionIds = new Map();
      this.reflectionSession = this._normalizeBackgroundSessionState(persistedState.reflectionSession);
      this.reflectionSessionId = this.reflectionSession?.id || null;
      /** @type {Map<string, { pid: number | null, paneTail: string | null, forceFinalize: (() => void) | null, updatedAt: string }>} */
      this.activeClaudeRuns = new Map();
      this.cancelRequestedTaskIds = new Set();
      this.forcedTaskFailureMessages = new Map();
      /** @type {boolean} Whether the configured brain CLI binary is available */
      this.brainAvailable = true;
      /** @type {number} Consecutive spawn/task failures */
      this.consecutiveSpawnFailures = 0;
      this.lastBrainState = {
        mode: 'ephemeral',
        sessionExists: true,
        working: false,
        paneTail: null,
        pid: null,
        checkedAt: new Date().toISOString(),
      };
      ensureReflectionStatusFile();
      cleanupExpiredTaskLogs();
    }

    _getBrainProvider() {
      return resolveBrainProvider({
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
      }, this.configPath);
    }

    _getBrainProviderForTask(task) {
      const requestedProvider = this._isChatBackedTask(task)
        && task?.metadata
        && typeof task.metadata === 'object'
        && typeof task.metadata.provider === 'string'
        && task.metadata.provider.trim()
          ? task.metadata.provider.trim()
          : null;

      if (!requestedProvider) {
        return this._getBrainProvider();
      }

      return resolveBrainProviderByName({
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
      }, this.configPath, requestedProvider);
    }

    _getStoredChatSessionId(providerName) {
      const inMemorySessionId = this.chatSessionIds.get(providerName);
      if (isUuid(inMemorySessionId)) {
        return inMemorySessionId;
      }

      const persistedSessionId = readStoredChatProviderSessionId(providerName);
      if (isUuid(persistedSessionId)) {
        this.chatSessionIds.set(providerName, persistedSessionId);
        return persistedSessionId;
      }

      return null;
    }

    _setStoredChatSessionId(providerName, sessionId) {
      if (!providerName || !isUuid(sessionId)) {
        return;
      }

      this.chatSessionIds.set(providerName, sessionId);
      writeStoredChatProviderSessionId(providerName, sessionId);
    }

    /**
     * Check if the configured brain CLI is available by running `<binary> --version`.
     * Sets this.brainAvailable accordingly and logs warnings.
     */
    async checkBrainAvailability() {
      const provider = this._getBrainProvider();
      const availabilityCheck = provider.buildAvailabilityCheck();

      return new Promise((resolve) => {
        try {
          const child = spawn(availabilityCheck.command, availabilityCheck.args, {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
          });

          let stdout = '';
          child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

          child.on('error', (err) => {
            this.brainAvailable = false;
            console.error(`[orchestrator] WARNING: ${provider.displayName} not found in PATH. Chat will not work. (${err.message})`);
            this.emitStatus('brain_availability_changed');
            resolve(false);
          });

          child.on('close', (code) => {
            if (code === 0) {
              this.brainAvailable = true;
              console.log(`[orchestrator] ${provider.displayName} available: ${stdout.trim()}`);
            } else {
              this.brainAvailable = false;
              console.error(`[orchestrator] WARNING: ${provider.displayName} check failed (exit code ${code}). Chat will not work.`);
            }
            this.emitStatus('brain_availability_changed');
            resolve(this.brainAvailable);
          });
        } catch (err) {
          this.brainAvailable = false;
          console.error(`[orchestrator] WARNING: ${provider.displayName} not found in PATH. Chat will not work. (${err.message})`);
          this.emitStatus('brain_availability_changed');
          resolve(false);
        }
      });
    }

    async checkClaudeAvailability() {
      return this.checkBrainAvailability();
    }

    /**
     * Record a task spawn/completion failure. After 3 consecutive failures,
     * submit a notification feed item.
     */
    async _recordSpawnFailure() {
      this.consecutiveSpawnFailures++;
      if (this.consecutiveSpawnFailures >= 3) {
        await this._submitFailureNotification();
      }
    }

    /**
     * Reset the consecutive failure counter after a successful task.
     * Auto-resolve any existing failure notification.
     */
    _resetSpawnFailures() {
      const hadFailures = this.consecutiveSpawnFailures >= 3;
      this.consecutiveSpawnFailures = 0;
      if (hadFailures) {
        this._resolveFailureNotification();
      }
    }

    /**
     * Submit a notification feed item for consecutive failures via the submit API.
     */
    async _submitFailureNotification() {
      const notificationId = 'agent-health-consecutive-failures';

      // Build detailed failure text from recent history
      const failureCount = this.consecutiveSpawnFailures;
      const recentFailures = this.history
        .filter((t) => t.state === 'failed')
        .slice(0, failureCount);

      let text = `${failureCount} consecutive task failures.`;

      if (recentFailures.length > 0) {
        // Timestamp range
        const timestamps = recentFailures
          .map((t) => t.completedAt || t.createdAt)
          .filter(Boolean)
          .map((ts) => new Date(ts));
        if (timestamps.length >= 2) {
          const fmt = (d) => d.toISOString().slice(11, 16);
          const earliest = new Date(Math.min(...timestamps));
          const latest = new Date(Math.max(...timestamps));
          text = `${failureCount} consecutive task failures between ${fmt(earliest)} and ${fmt(latest)} UTC.`;
        }

        // Task type summary
        const priorityLabels = {
          user_chat: 'chat',
          user_ping: 'ping',
          code_fix_spawn: 'code_fix',
          feed_action: 'feed_action',
          post_enrichment: 'enrichment',
          reflection: 'reflection',
        };
        const typeCounts = {};
        for (const t of recentFailures) {
          const label = priorityLabels[t.priority] || t.priority || 'unknown';
          typeCounts[label] = (typeCounts[label] || 0) + 1;
        }
        const typeParts = Object.entries(typeCounts)
          .map(([label, count]) => count > 1 ? `${count} ${label}` : label);
        if (typeParts.length > 0) {
          text += ` Failed tasks: ${typeParts.join(', ')}.`;
        }

        // Deduplicated error reasons
        const errors = [...new Set(
          recentFailures.map((t) => t.error).filter(Boolean),
        )];
        if (errors.length === 1) {
          text += ` Error: ${errors[0]}`;
        } else if (errors.length > 1) {
          text += ` Errors: ${errors.join('; ')}`;
        }
      }

      const item = {
        id: `notification-${notificationId}-${Date.now()}`,
        type: 'notification',
        source: 'evogent',
        sourceId: notificationId,
        title: 'Agent Health Alert',
        text,
        reason: 'Consecutive task failures detected by orchestrator health monitoring.',
        tags: ['system', 'health'],
        publishedAt: new Date().toISOString(),
        metadata: {
          notificationId,
          severity: 'error',
          dismissable: true,
          autoResolveCondition: 'Next successful task completion',
        },
      };

      try {
        await postInternal('/api/internal/curate/submit', { items: [item] });
        console.warn(`[orchestrator] Submitted failure notification after ${this.consecutiveSpawnFailures} consecutive failures`);
      } catch (err) {
        console.warn(`[orchestrator] Failed to submit failure notification: ${err.message}`);
      }
    }

    /**
     * Auto-resolve the failure notification by dismissing it.
     */
    _resolveFailureNotification() {
      // We don't need to remove the notification from the DB — it has dismissable: true
      // and will naturally resolve. Just log the recovery.
      console.log('[orchestrator] Consecutive failures resolved — agent recovered');
    }

    _resolveBackgroundSessionMaxAgeMs() {
      return 7 * 24 * 60 * 60 * 1000;
    }

    _normalizeHistoryEntries(entries) {
      if (!Array.isArray(entries)) {
        return [];
      }

      return entries
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => ({
          ...entry,
          logFile: typeof entry.logFile === 'string' && entry.logFile.trim()
            ? entry.logFile.trim()
            : null,
        }));
    }

    _normalizeTrackedFileMtimes(trackedFileMtimes) {
      if (!trackedFileMtimes || typeof trackedFileMtimes !== 'object' || Array.isArray(trackedFileMtimes)) {
        return {};
      }

      return Object.entries(trackedFileMtimes).reduce((acc, [key, value]) => {
        if (typeof key !== 'string' || !key.trim()) {
          return acc;
        }

        acc[key] = typeof value === 'number' && Number.isFinite(value)
          ? value
          : null;
        return acc;
      }, {});
    }

    _normalizeBackgroundSessionState(session) {
      if (!session || typeof session !== 'object' || Array.isArray(session)) {
        return null;
      }

      const id = typeof session.id === 'string' ? session.id.trim() : '';
      if (!isUuid(id)) {
        return null;
      }

      const createdAt = typeof session.createdAt === 'string' ? session.createdAt.trim() : '';
      if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
        return null;
      }

      const trackedFileMtimes = this._normalizeTrackedFileMtimes(session.trackedFileMtimes);

      const provider = typeof session.provider === 'string' && session.provider.trim()
        ? session.provider.trim().toLowerCase()
        : null;

      return {
        id,
        provider,
        createdAt,
        trackedFileMtimes,
      };
    }

    _loadPersistedState() {
      try {
        if (fs.existsSync(this.historyFile)) {
          const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
          if (Array.isArray(data)) {
            console.log(`[orchestrator] Loaded ${data.length} history entries from disk`);
            return {
              history: this._normalizeHistoryEntries(data),
              reflectionSession: null,
            };
          }

          if (data && typeof data === 'object') {
            const history = this._normalizeHistoryEntries(data.history);
            console.log(`[orchestrator] Loaded ${history.length} history entries from disk`);
            return {
              history,
              reflectionSession: this._normalizeBackgroundSessionState(data.reflectionSession),
            };
          }
        }
      } catch (err) {
        console.warn(`[orchestrator] Failed to load history: ${err.message}`);
      }
      return {
        history: [],
        reflectionSession: null,
      };
    }

    _saveHistory() {
      try {
        fs.writeFileSync(this.historyFile, JSON.stringify({
          history: this.history,
          reflectionSession: this.reflectionSession,
        }, null, 2));
      } catch (err) {
        console.warn(`[orchestrator] Failed to save history: ${err.message}`);
      }
    }

    onStatus(listener) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    emitStatus(trigger, event = null) {
      const status = this.getStatus();
      for (const listener of this.listeners) {
        listener(status, trigger, event);
      }
    }

    _buildTaskCompletionError(task) {
      const message = typeof task?.error === 'string' && task.error.trim()
        ? task.error.trim()
        : `Task ${task?.id || 'unknown'} failed`;
      return new Error(message);
    }

    _settleTaskCompletionWaiters(task) {
      const taskId = typeof task?.id === 'string' ? task.id.trim() : '';
      if (!taskId) {
        return;
      }

      const waiters = this.taskCompletionWaiters.get(taskId);
      if (!Array.isArray(waiters) || waiters.length === 0) {
        return;
      }

      this.taskCompletionWaiters.delete(taskId);

      if (task.state === 'completed') {
        for (const waiter of waiters) {
          waiter.resolve(task);
        }
        return;
      }

      const error = this._buildTaskCompletionError(task);
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }

    waitForTaskCompletion(taskId) {
      const normalizedTaskId = typeof taskId === 'string' ? taskId.trim() : '';
      if (!normalizedTaskId) {
        return Promise.reject(new Error('taskId is required'));
      }

      const completedTask = this.history.find((entry) => (
        entry?.id === normalizedTaskId
        && (entry.state === 'completed' || entry.state === 'failed')
      ));
      if (completedTask) {
        return completedTask.state === 'completed'
          ? Promise.resolve(completedTask)
          : Promise.reject(this._buildTaskCompletionError(completedTask));
      }

      return new Promise((resolve, reject) => {
        const waiters = this.taskCompletionWaiters.get(normalizedTaskId) || [];
        waiters.push({ resolve, reject });
        this.taskCompletionWaiters.set(normalizedTaskId, waiters);
      });
    }

    _refreshBrainRuntimeState({ sessionExistsWhenIdle = true } = {}) {
      const activeRuns = [...this.activeClaudeRuns.values()];
      const latestRun = activeRuns
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;

      this.lastBrainState = {
        ...this.lastBrainState,
        mode: 'ephemeral',
        sessionExists: activeRuns.length > 0 ? true : sessionExistsWhenIdle,
        working: activeRuns.length > 0,
        paneTail: latestRun?.paneTail || null,
        pid: latestRun?.pid || null,
        checkedAt: new Date().toISOString(),
      };
    }

    _touchActiveClaudeRun(taskId, { pid = null, paneTail = null, forceFinalize } = {}) {
      if (typeof taskId !== 'string' || !taskId.trim()) {
        return;
      }

      const existing = this.activeClaudeRuns.get(taskId) || {
        pid: null,
        paneTail: null,
        forceFinalize: null,
        updatedAt: new Date().toISOString(),
      };
      this.activeClaudeRuns.set(taskId, {
        pid: Number.isInteger(pid) && pid > 0 ? pid : existing.pid,
        paneTail: typeof paneTail === 'string' && paneTail.trim()
          ? paneTail
          : existing.paneTail,
        forceFinalize: typeof forceFinalize === 'function'
          ? forceFinalize
          : existing.forceFinalize,
        updatedAt: new Date().toISOString(),
      });
      this._refreshBrainRuntimeState();
    }

    _recordTaskInHistory(task) {
      if (!task?.id) {
        return;
      }

      this.history = [
        task,
        ...this.history.filter((entry) => entry?.id !== task.id),
      ].slice(0, 120);
      this._saveHistory();
    }

    _clearActiveClaudeRun(taskId, { sessionExistsWhenIdle = true } = {}) {
      if (typeof taskId === 'string' && taskId.trim()) {
        this.activeClaudeRuns.delete(taskId);
      }

      this._refreshBrainRuntimeState({ sessionExistsWhenIdle });
    }

    _serializeTask(task, { includeResponsePreview = false } = {}) {
      if (!task) {
        return null;
      }

      return {
        id: task.id,
        source: task.source,
        priority: task.priority,
        chatMessageId: getTaskChatMessageId(task),
        sessionId: getTaskSessionId(task),
        state: task.state,
        enqueuedAt: task.enqueuedAt,
        startedAt: task.startedAt,
        sentAt: task.sentAt,
        completedAt: task.completedAt,
        error: task.error,
        paneTail: task.paneTail,
        logFile: task.logFile,
        messagePreview: summarizeMessage(task.message, 100),
        ...(includeResponsePreview ? { responsePreview: summarizeMessage(task.response || '', 220) } : {}),
      };
    }

    _isChatBackedTask(task) {
      return Boolean(getTaskChatMessageId(task) && isUuid(getTaskSessionId(task)));
    }

    _markChatBackedTaskProcessing(task) {
      if (!this._isChatBackedTask(task)) {
        return;
      }

      const chatMessageId = getTaskChatMessageId(task);
      if (chatMessageId) {
        markChatMessageProcessing(chatMessageId);
      }
    }

    _parseChatMessageMetadata(rawMetadata) {
      if (typeof rawMetadata !== 'string' || !rawMetadata.trim()) {
        return {};
      }

      try {
        const parsed = JSON.parse(rawMetadata);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : {};
      } catch {
        return {};
      }
    }

    _buildPoisonRecoveryMetadata(task, recovery) {
      const reason = typeof recovery?.reason === 'string' && recovery.reason.trim()
        ? recovery.reason.trim()
        : 'image_url_unreachable';
      return {
        reason,
        provider: 'claude',
        recoveredAt: new Date().toISOString(),
        recoverable: recovery?.recoverable === true,
        truncated: recovery?.truncated === true,
        jsonlPath: typeof recovery?.jsonlPath === 'string' ? recovery.jsonlPath : null,
        backupPath: typeof recovery?.backupPath === 'string' ? recovery.backupPath : null,
        syntheticLineIndex: Number.isInteger(recovery?.syntheticLineIndex) ? recovery.syntheticLineIndex : null,
        realAssistantLineIndex: Number.isInteger(recovery?.realAssistantLineIndex) ? recovery.realAssistantLineIndex : null,
        truncateLineCount: Number.isInteger(recovery?.truncateLineCount) ? recovery.truncateLineCount : null,
        totalLineCount: Number.isInteger(recovery?.totalLineCount) ? recovery.totalLineCount : null,
        errorText: typeof recovery?.errorText === 'string' && recovery.errorText.trim()
          ? truncateText(recovery.errorText.replace(/\s+/g, ' '), 300)
          : null,
        taskId: typeof task?.id === 'string' ? task.id : null,
      };
    }

    _markChatMessageFailedWithPoisonRecovery(chatMessageId, task, recovery) {
      if (typeof chatMessageId !== 'string' || !chatMessageId.trim()) {
        return false;
      }

      try {
        const db = getChatStatusDb();
        const row = db.prepare(`
          SELECT metadata
          FROM chat_messages
          WHERE id = ?
        `).get(chatMessageId.trim()) || null;
        const existingMetadata = this._parseChatMessageMetadata(row?.metadata);
        const poisonRecovery = this._buildPoisonRecoveryMetadata(task, recovery);
        const metadata = {
          ...existingMetadata,
          poisonRecoveryReason: poisonRecovery.reason,
          poisonRecovery,
        };
        const result = db.prepare(`
          UPDATE chat_messages
          SET status = 'failed',
              metadata = ?
          WHERE id = ?
        `).run(JSON.stringify(metadata), chatMessageId.trim());
        return result.changes > 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[orchestrator] Failed to mark chat message poison recovery (${chatMessageId}): ${message}`);
        return false;
      }
    }

    _buildPoisonRecoveryUserText(recovery) {
      if (recovery?.truncated === true) {
        return "Couldn't process the image you shared (URL was unreachable). Earlier conversation context kept; the message was dropped. Try resharing as a local upload or with a stable URL.";
      }

      return "Couldn't process the image you shared (URL was unreachable). I couldn't safely repair the saved chat history automatically, so this chat may need manual repair before retrying. Try resharing as a local upload or with a stable URL.";
    }

    _recoverFailedClaudeChatSession(task) {
      const appSessionId = getTaskSessionId(task);
      if (!isUuid(appSessionId)) {
        return null;
      }

      const runtimeInfo = getChatSessionRuntimeInfo(appSessionId);
      const provider = typeof runtimeInfo?.provider === 'string' && runtimeInfo.provider.trim()
        ? runtimeInfo.provider.trim().toLowerCase()
        : 'claude';
      if (provider !== 'claude') {
        return null;
      }

      const providerSessionId = runtimeInfo?.providerSessionId
        || getTaskProviderSessionId(task)
        || getProviderSessionIdForChatSession(appSessionId, 'claude');
      if (!isUuid(providerSessionId)) {
        return null;
      }

      const workingDirectory = typeof runtimeInfo?.workingDirectory === 'string' && runtimeInfo.workingDirectory.trim()
        ? runtimeInfo.workingDirectory.trim()
        : typeof task?.metadata?.workingDirectory === 'string' && task.metadata.workingDirectory.trim()
          ? task.metadata.workingDirectory.trim()
          : process.cwd();

      try {
        const recovery = recoverClaudeSessionPoison({
          workingDirectory,
          sessionId: providerSessionId,
        });
        if (!recovery?.detected) {
          return null;
        }

        return {
          ...recovery,
          appSessionId,
          providerSessionId,
          sessionTitle: typeof runtimeInfo?.title === 'string' && runtimeInfo.title.trim()
            ? runtimeInfo.title.trim()
            : null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[orchestrator] Failed to repair Claude chat session ${providerSessionId}: ${message}`);
        return null;
      }
    }

    _attachTaskPoisonRecovery(task, recovery) {
      if (!task || !recovery?.detected) {
        return;
      }

      const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
      const poisonRecovery = this._buildPoisonRecoveryMetadata(task, recovery);
      task.metadata = {
        ...metadata,
        poisonRecoveryReason: poisonRecovery.reason,
        poisonRecovery,
      };
    }

    async _submitPoisonRecoveryChatEvent({ task, chatMessageId, appSessionId, recovery }) {
      await appendAgentEventToChatOutput({
        id: `event-chat-poison-recovered-${task.id}`,
        text: this._buildPoisonRecoveryUserText(recovery),
        sessionId: appSessionId,
        inReplyTo: chatMessageId,
        metadata: {
          event: 'chat_poison_recovered',
          status: 'failed',
          severity: 'warning',
          chatVisible: true,
          taskId: task.id,
          chatMessageId,
          sessionId: appSessionId,
          poisonRecoveryReason: recovery.reason || 'image_url_unreachable',
          recoveryTruncated: recovery.truncated === true,
          jsonlPath: recovery.jsonlPath || null,
          backupPath: recovery.backupPath || null,
        },
      });
    }

    async _submitPoisonRecoveryFeedNotification({ task, chatMessageId, appSessionId, recovery }) {
      const notificationId = `chat-poison-recovery:${chatMessageId}`;
      const sessionLabel = typeof recovery?.sessionTitle === 'string' && recovery.sessionTitle.trim()
        ? recovery.sessionTitle.trim()
        : `chat session ${appSessionId.slice(0, 8)}`;
      const text = `${sessionLabel}: ${this._buildPoisonRecoveryUserText(recovery)}`;
      const now = new Date().toISOString();
      const item = {
        id: `notification-chat-poison-recovery-${chatMessageId}`,
        type: 'notification',
        source: 'evogent',
        sourceId: notificationId,
        originSessionId: appSessionId,
        title: 'Chat image could not be processed',
        text,
        reason: 'Claude returned a recoverable image-processing API error for this chat session.',
        tags: ['chat', 'recovery'],
        publishedAt: now,
        metadata: {
          notificationId,
          severity: 'warning',
          dismissable: true,
          sessionId: appSessionId,
          chatMessageId,
          taskId: task.id,
          poisonRecoveryReason: recovery.reason || 'image_url_unreachable',
          recoveryTruncated: recovery.truncated === true,
        },
      };

      try {
        await postInternal('/api/internal/curate/submit', { items: [item] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[orchestrator] Failed to submit chat poison recovery notification: ${message}`);
      }
    }

    async _finalizeChatBackedTask(task) {
      const chatMessageId = getTaskChatMessageId(task);
      if (!chatMessageId) {
        return { poisonRecovery: null };
      }

      if (task.state === 'completed') {
        markChatMessageDeliveredIfPendingOrQueued(chatMessageId);
        return { poisonRecovery: null };
      }

      if (task.state === 'failed') {
        const poisonRecovery = this._recoverFailedClaudeChatSession(task);
        if (poisonRecovery?.detected) {
          const appSessionId = poisonRecovery.appSessionId || getTaskSessionId(task);
          this._attachTaskPoisonRecovery(task, poisonRecovery);
          this._markChatMessageFailedWithPoisonRecovery(chatMessageId, task, poisonRecovery);
          await this._submitPoisonRecoveryChatEvent({
            task,
            chatMessageId,
            appSessionId,
            recovery: poisonRecovery,
          });
          await this._submitPoisonRecoveryFeedNotification({
            task,
            chatMessageId,
            appSessionId,
            recovery: poisonRecovery,
          });

          const recoveryAction = poisonRecovery.truncated
            ? `JSONL truncated to last clean turn at ${new Date().toISOString()}`
            : 'JSONL left unchanged because no real assistant turn was found within the recovery bound';
          console.warn(
            `[orchestrator] Session ${poisonRecovery.providerSessionId} detected poison-pill failure (broken image URL); ${recoveryAction}; user message ${chatMessageId} surfaced as failed with reason ${poisonRecovery.reason || 'image_url_unreachable'}`,
          );
          broadcastChatTyping(false);
          return { poisonRecovery };
        }

        markChatMessageFailedIfPendingOrQueued(chatMessageId);
        broadcastChatUpdate([{
          id: `event-chat-failed-${task.id}`,
          role: 'agent',
          type: 'agent_event',
          text: 'Message could not be delivered. Please try again.',
          timestamp: new Date().toISOString(),
          inReplyTo: chatMessageId,
          ...(isUuid(getTaskSessionId(task)) ? { sessionId: getTaskSessionId(task) } : {}),
          metadata: {
            event: 'chat_task_failed',
            error: task.error || 'unknown error',
            taskId: task.id,
            ...(isUuid(getTaskSessionId(task)) ? { sessionId: getTaskSessionId(task) } : {}),
          },
        }]);
        broadcastChatTyping(false);
      }

      return { poisonRecovery: null };
    }

    _buildTaskLifecycleEvent(task) {
      return {
        taskId: task?.id || null,
        priority: task?.priority || null,
        source: task?.source || null,
        chatMessageId: getTaskChatMessageId(task),
        sessionId: getTaskSessionId(task),
        state: task?.state || null,
        error: task?.error || null,
      };
    }

    _getChatTaskLaneKey(task) {
      const sessionId = getTaskSessionId(task);
      if (typeof sessionId === 'string' && sessionId.trim()) {
        return sessionId.trim();
      }
      return `chat-task:${task.id}`;
    }

    _getPrimaryActiveChatTask() {
      const activeChatTasks = [...this.activeChatTasks.values()];
      if (activeChatTasks.length === 0) {
        return null;
      }

      activeChatTasks.sort((left, right) => {
        const leftTime = Date.parse(left.startedAt || left.enqueuedAt || 0);
        const rightTime = Date.parse(right.startedAt || right.enqueuedAt || 0);
        return rightTime - leftTime;
      });

      return activeChatTasks[0] || null;
    }

    _getActiveTaskById(taskId) {
      if (typeof taskId !== 'string' || !taskId.trim()) {
        return null;
      }

      if (this.currentTask?.id === taskId) {
        return this.currentTask;
      }

      for (const task of this.activeChatTasks.values()) {
        if (task.id === taskId) {
          return task;
        }
      }

      return null;
    }

    _getQueuedTaskIndexById(taskId) {
      if (typeof taskId !== 'string' || !taskId.trim()) {
        return -1;
      }

      return this.queue.findIndex((task) => task.id === taskId);
    }

    _hasActiveTasks() {
      return Boolean(this.currentTask)
        || this.activeChatTasks.size > 0
        || this.activeBackgroundTaskIds.size > 0;
    }

    _canStartTask(task) {
      if (!task) {
        return false;
      }

      if (task.priority === 'user_chat') {
        return !this.activeChatTasks.has(this._getChatTaskLaneKey(task));
      }

      return !this.currentTask;
    }

    _dequeueNextRunnableTask() {
      for (let index = 0; index < this.queue.length; index += 1) {
        const task = this.queue[index];
        if (!this._canStartTask(task)) {
          continue;
        }

        this.queue.splice(index, 1);
        return task;
      }

      return null;
    }

    _countBlockingTasksAhead(task) {
      if (!task) {
        return 0;
      }

      if (task.priority === 'user_chat') {
        const laneKey = this._getChatTaskLaneKey(task);
        let count = this.activeChatTasks.has(laneKey) ? 1 : 0;
        for (const queuedTask of this.queue) {
          if (queuedTask.id === task.id) {
            break;
          }
          if (queuedTask.priority === 'user_chat' && this._getChatTaskLaneKey(queuedTask) === laneKey) {
            count += 1;
          }
        }
        return count;
      }

      let count = this.currentTask ? 1 : 0;
      for (const queuedTask of this.queue) {
        if (queuedTask.id === task.id) {
          break;
        }
        if (queuedTask.priority !== 'user_chat') {
          count += 1;
        }
      }
      return count;
    }

    _resolveTaskPriorityValue(priority, metadata) {
      return PRIORITY_VALUES[priority];
    }

    _trackActiveTask(task) {
      if (task.priority === 'user_chat') {
        this.activeChatTasks.set(this._getChatTaskLaneKey(task), task);
        return;
      }

      this.currentTask = task;
    }

    _trackBackgroundTask(task) {
      if (typeof task?.id !== 'string' || !task.id.trim()) {
        return;
      }

      this.activeBackgroundTaskIds.add(task.id);
    }

    _untrackActiveTask(task) {
      if (!task) {
        return;
      }

      if (task.priority === 'user_chat') {
        const laneKey = this._getChatTaskLaneKey(task);
        const activeTask = this.activeChatTasks.get(laneKey);
        if (activeTask?.id === task.id) {
          this.activeChatTasks.delete(laneKey);
          return;
        }

        for (const [key, candidate] of this.activeChatTasks.entries()) {
          if (candidate?.id === task.id) {
            this.activeChatTasks.delete(key);
            return;
          }
        }
        return;
      }

      if (this.currentTask?.id === task.id) {
        this.currentTask = null;
      }
    }

    _untrackBackgroundTask(task) {
      if (typeof task?.id !== 'string' || !task.id.trim()) {
        return;
      }

      this.activeBackgroundTaskIds.delete(task.id);
    }

    _getTerminalBrowseCacheRefreshRun(task) {
      return readLatestTerminalCacheRefreshRun(task, { getDb: getChatStatusDb });
    }

    _appendCacheRefreshValidationFailureLog(task, errorMessage, validation) {
      const logFile = typeof task?.logFile === 'string' && task.logFile.trim()
        ? task.logFile.trim()
        : assignTaskLogFile(task);
      if (!logFile) {
        return;
      }

      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        if (!fs.existsSync(logFile)) {
          fs.writeFileSync(logFile, '', 'utf8');
        }
        fs.appendFileSync(logFile, `${JSON.stringify({
          type: 'system',
          subtype: 'cache_refresh_validation_failed',
          error: errorMessage,
          runId: validation?.run?.id || null,
          itemsAdded: validation?.run?.itemsAdded ?? null,
          timestamp: new Date().toISOString(),
        })}\n`, 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[orchestrator] failed to persist cache-refresh validation failure for ${task?.id || 'unknown'}: ${message}`);
      }
    }

    async _waitForPidExit(pid, timeoutMs) {
      if (!Number.isInteger(pid) || pid <= 0) {
        return true;
      }

      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (Date.now() < deadline) {
        if (!isPidRunning(pid)) {
          return true;
        }
        await delay(100);
      }

      return !isPidRunning(pid);
    }

    _signalProcessGroup(pid, signal) {
      if (!Number.isInteger(pid) || pid <= 0 || !isPidRunning(pid)) {
        return false;
      }

      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }
    }

    async _terminateCacheRefreshTaskForRestart(task, {
      graceMs,
      terminalRun,
    }) {
      const activeRun = this.activeClaudeRuns.get(task.id);
      const pid = activeRun?.pid;
      const terminalStatus = typeof terminalRun?.status === 'string'
        ? terminalRun.status.trim().toLowerCase()
        : null;
      const terminalItemsAdded = Number.isFinite(Number(terminalRun?.itemsAdded))
        ? Number(terminalRun.itemsAdded)
        : 0;
      const terminalSucceeded = terminalStatus === 'completed' && terminalItemsAdded > 0;
      const failureMessage = terminalRun
        ? terminalStatus === 'completed' && terminalItemsAdded <= 0
          ? `Cache refresh already persisted completed browse-cache run ${terminalRun.id || 'unknown'} with 0 items added`
          : `Cache refresh already persisted ${terminalStatus || 'terminal'} browse-cache run ${terminalRun.id || 'unknown'}`
        : 'Cache refresh stopped by worker restart before a terminal browse-cache result was persisted';

      if (!terminalSucceeded) {
        this.forcedTaskFailureMessages.set(task.id, failureMessage);
      }

      if (Number.isInteger(pid) && pid > 0 && isPidRunning(pid)) {
        this._signalProcessGroup(pid, 'SIGTERM');
        const exitedGracefully = await this._waitForPidExit(pid, graceMs);
        if (!exitedGracefully) {
          this._signalProcessGroup(pid, 'SIGKILL');
          await this._waitForPidExit(pid, 1_000);
        }
      }

      const latestRun = this.activeClaudeRuns.get(task.id);
      if (typeof latestRun?.forceFinalize === 'function') {
        latestRun.forceFinalize();
      }

      const settleDeadline = Date.now() + 1_000;
      while (Date.now() < settleDeadline && this._getActiveTaskById(task.id)) {
        await delay(25);
      }

      if (this._getActiveTaskById(task.id)) {
        task.state = terminalSucceeded ? 'completed' : 'failed';
        task.error = terminalSucceeded ? null : failureMessage;
        task.completedAt = new Date().toISOString();
        this._clearActiveClaudeRun(task.id);
        this._untrackActiveTask(task);
        this._recordTaskInHistory(task);
        this._settleTaskCompletionWaiters(task);
        this.emitStatus('task_finished', this._buildTaskLifecycleEvent(task));
      }
    }

    async prepareForWorkerRestart({ graceMs = 5_000 } = {}) {
      const result = {
        finalizedCompletedCacheRefresh: 0,
        failedCacheRefresh: 0,
        removedQueuedCacheRefresh: 0,
        activeUserChatTasks: this.activeChatTasks.size,
      };

      const retainedQueue = [];
      for (const task of this.queue) {
        if (!isCacheRefreshTask(task)) {
          retainedQueue.push(task);
          continue;
        }

        task.state = 'failed';
        task.error = 'Cache refresh skipped by worker restart before it started';
        task.completedAt = new Date().toISOString();
        this._recordTaskInHistory(task);
        this._settleTaskCompletionWaiters(task);
        this.emitStatus('task_finished', this._buildTaskLifecycleEvent(task));
        result.removedQueuedCacheRefresh += 1;
      }
      this.queue = retainedQueue;

      const activeTask = this.currentTask;
      if (isCacheRefreshTask(activeTask)) {
        const terminalRun = this._getTerminalBrowseCacheRefreshRun(activeTask);
        await this._terminateCacheRefreshTaskForRestart(activeTask, {
          graceMs,
          terminalRun,
        });

        const status = typeof terminalRun?.status === 'string'
          ? terminalRun.status.trim().toLowerCase()
          : null;
        const itemsAdded = Number.isFinite(Number(terminalRun?.itemsAdded))
          ? Number(terminalRun.itemsAdded)
          : 0;
        if (status === 'completed' && itemsAdded > 0) {
          result.finalizedCompletedCacheRefresh += 1;
        } else {
          result.failedCacheRefresh += 1;
        }
      }

      if (
        result.finalizedCompletedCacheRefresh > 0
        || result.failedCacheRefresh > 0
        || result.removedQueuedCacheRefresh > 0
      ) {
        this.emitStatus('restart_cache_refresh_drained', result);
      }

      return result;
    }

    _requestProcessLoop() {
      this.processLoopRequested = true;
      return this.processLoop();
    }

    _readSystemPrompt() {
      try {
        const content = fs.readFileSync(CLAUDE_SYSTEM_PROMPT_PATH, 'utf8');
        const trimmed = content.trim();
        if (trimmed) return trimmed;
      } catch {
        // Fall through to lightweight fallback.
      }

      return [
        'You are Evogent.',
        'Each invocation is ephemeral: complete one task, write required JSONL output, and exit.',
        'Never wait for follow-up prompts.',
      ].join('\n');
    }

    _resolveChatSessionId(task, providerName, forceFreshSession = false) {
      if (!this._isChatBackedTask(task)) return null;

      const taskSessionId = getTaskSessionId(task);
      const persistedProviderSessionId = getProviderSessionIdForChatSession(taskSessionId, providerName);
      const taskProviderSessionId = persistedProviderSessionId || getTaskProviderSessionId(task);
      const storedProviderSessionId = this._getStoredChatSessionId(providerName);

      if (forceFreshSession) {
        const freshId = taskProviderSessionId || randomUUID();
        this.chatSessionIds.set(providerName, freshId);
        if (!taskSessionId) {
          this._setStoredChatSessionId(providerName, freshId);
        }
        return freshId;
      }

      if (taskProviderSessionId) {
        this.chatSessionIds.set(providerName, taskProviderSessionId);
        if (!taskSessionId) {
          this._setStoredChatSessionId(providerName, taskProviderSessionId);
        }
        return taskProviderSessionId;
      }

      if (!isUuid(storedProviderSessionId)) {
        const freshId = randomUUID();
        this._setStoredChatSessionId(providerName, freshId);
        return freshId;
      }

      return storedProviderSessionId;
    }

    _setTaskProviderSessionId(task, providerName, providerSessionId) {
      if (!task || typeof task !== 'object' || !isUuid(providerSessionId)) {
        return;
      }

      const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
      task.metadata = {
        ...metadata,
        providerSessionId,
        ...(providerName === 'claude' ? { claudeSessionId: providerSessionId } : {}),
      };
    }

    _readTrackedFileMtimeMs(filePath) {
      try {
        return fs.statSync(filePath).mtimeMs;
      } catch {
        return null;
      }
    }

    _readTrackedFileMtimes(fileMap) {
      return Object.entries(fileMap).reduce((acc, [key, filePath]) => {
        acc[key] = this._readTrackedFileMtimeMs(filePath);
        return acc;
      }, {});
    }

    _trackedFilesChanged(previousTrackedFileMtimes, nextTrackedFileMtimes) {
      const previous = this._normalizeTrackedFileMtimes(previousTrackedFileMtimes);
      const next = this._normalizeTrackedFileMtimes(nextTrackedFileMtimes);
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

      for (const key of keys) {
        if ((previous[key] ?? null) !== (next[key] ?? null)) {
          return true;
        }
      }

      return false;
    }

    _getReflectionSessionTrackedFileMtimes() {
      return this._readTrackedFileMtimes({
        config: this.configPath,
        preferencesContext: this.preferencesContextPath,
      });
    }

    _setBackgroundSessionState(kind, session) {
      const normalizedSession = this._normalizeBackgroundSessionState(session);
      if (kind === 'reflection') {
        this.reflectionSession = normalizedSession;
        this.reflectionSessionId = normalizedSession?.id || null;
      }
      this._saveHistory();
    }

    _resolveBackgroundSession(task, providerName) {
      const sessionKind = task?.priority === 'reflection' ? 'reflection' : null;
      if (!sessionKind) return null;

      const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
      const explicitReset = metadata?.forceFreshReflectionSession === true || metadata?.resetReflectionSession === true;
      const trackedFileMtimes = this._getReflectionSessionTrackedFileMtimes();
      const existingSession = this.reflectionSession;
      const existingCreatedAtMs = existingSession ? Date.parse(existingSession.createdAt) : Number.NaN;
      const sessionExpired = existingSession
        ? !Number.isFinite(existingCreatedAtMs)
          || (Date.now() - existingCreatedAtMs) >= this.backgroundSessionMaxAgeMs
        : false;
      const trackedFilesChanged = existingSession
        ? this._trackedFilesChanged(existingSession.trackedFileMtimes, trackedFileMtimes)
        : false;
      const providerChanged = existingSession && existingSession.provider && existingSession.provider !== providerName;
      const shouldStartFresh = explicitReset || !existingSession || sessionExpired || trackedFilesChanged || providerChanged;

      if (shouldStartFresh) {
        const nextSession = {
          id: randomUUID(),
          provider: providerName,
          createdAt: new Date().toISOString(),
          trackedFileMtimes,
        };
        this._setBackgroundSessionState(sessionKind, nextSession);

        if (existingSession) {
          const reason = explicitReset
            ? 'explicit reset requested'
            : sessionExpired
              ? 'session age exceeded max'
              : providerChanged
                ? 'provider changed'
                : 'tracked context files changed';
          console.log(`[orchestrator] Reset ${sessionKind} session ${existingSession.id} -> ${nextSession.id} (${reason})`);
        }

        return {
          sessionId: nextSession.id,
          isFresh: true,
        };
      }

      return {
        sessionId: existingSession.id,
        isFresh: false,
      };
    }

    _persistBackgroundSessionState(kind, providerName, activeSessionId) {
      if (!isUuid(activeSessionId)) {
        return;
      }

      const existingSession = this.reflectionSession;
      const trackedFileMtimes = this._getReflectionSessionTrackedFileMtimes();
      const normalizedSession = {
        id: activeSessionId,
        provider: providerName,
        createdAt: existingSession?.createdAt || new Date().toISOString(),
        trackedFileMtimes,
      };

      if (!existingSession
        || existingSession.id !== normalizedSession.id
        || this._trackedFilesChanged(existingSession.trackedFileMtimes, normalizedSession.trackedFileMtimes)) {
        this._setBackgroundSessionState(kind, normalizedSession);
      }
    }

    _buildBrainInvocation(task, prompt, systemPrompt, provider, { forceFreshChatSession = false } = {}) {
      let sessionMode = {
        mode: 'ephemeral',
      };

      if (this._isChatBackedTask(task)) {
        const hadExistingSession = isUuid(this._getStoredChatSessionId(provider.name));
        const metadataForceFresh = task?.metadata?.forceFreshChatSession === true;
        const shouldForceFresh = forceFreshChatSession || metadataForceFresh;
        const sessionId = this._resolveChatSessionId(task, provider.name, shouldForceFresh);
        if (!isUuid(sessionId)) {
          throw new Error('Failed to initialize chat session id');
        }
        sessionMode = {
          mode: shouldForceFresh || !hadExistingSession ? 'new' : 'resume',
          sessionId,
        };
      } else {
        const backgroundSession = this._resolveBackgroundSession(task, provider.name);
        if (backgroundSession) {
          if (!isUuid(backgroundSession.sessionId)) {
            throw new Error(`Failed to initialize ${task.priority} session id`);
          }
          sessionMode = {
            mode: backgroundSession.isFresh ? 'new' : 'resume',
            sessionId: backgroundSession.sessionId,
          };
        }
      }

      return provider.buildInvocation({
        prompt,
        systemPrompt,
        task,
        sessionMode,
      });
    }

    _buildClaudeArgs(task, prompt, systemPrompt) {
      const provider = this._getBrainProviderForTask(task);
      return this._buildBrainInvocation(task, prompt, systemPrompt, provider).args;
    }

    _emitBrainTranscript(task, transcriptLines, pid = null) {
      if (!task?.id) return;

      const paneLines = transcriptLines.slice(-MAX_TRANSCRIPT_LINES);
      const paneTail = paneLines.at(-1) || null;

      this._touchActiveClaudeRun(task.id, {
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        paneTail,
      });

      this.emitStatus('brain_transcript', {
        taskId: task.id,
        paneTail,
        paneLines,
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        checkedAt: new Date().toISOString(),
      });
    }

    _runSimulatedBackgroundTask(task, timeoutMs, {
      kind,
      onSpawn = null,
    } = {}) {
      const logFilePath = assignTaskLogFile(task);
      const simulatedPid = process.pid;
      const simulatedDurationMs = Math.max(1_500, Math.min(timeoutMs, 2_200));

      cleanupExpiredTaskLogs();
      ensureTaskLogsDir();
      fs.writeFileSync(logFilePath, '', 'utf8');

      task.sentAt = new Date().toISOString();
      this._touchActiveClaudeRun(task.id, {
        pid: simulatedPid,
        paneTail: `[test] ${kind} task started`,
      });

      if (typeof onSpawn === 'function') {
        onSpawn(simulatedPid);
      }

      const writeTranscriptEntry = (text) => {
        const entry = {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text,
              },
            ],
          },
        };
        fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
      };

      writeTranscriptEntry(`[test] ${kind} task started`);
      this._emitBrainTranscript(task, [`[test] ${kind} task started`], simulatedPid);

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const transcriptLines = [
            `[test] ${kind} task started`,
            '[test] skipped — not sent to brain',
          ];
          writeTranscriptEntry('[test] skipped — not sent to brain');
          fs.appendFileSync(logFilePath, `${JSON.stringify({
            type: 'result',
            result: '[test] skipped — not sent to brain',
          })}\n`, 'utf8');
          this._emitBrainTranscript(task, transcriptLines, simulatedPid);
          this._clearActiveClaudeRun(task.id);

          resolve({
            logFile: logFilePath,
            response: '[test] skipped — not sent to brain',
            paneTail: transcriptLines.at(-1) || null,
            transcriptLines,
          });
        }, simulatedDurationMs);

        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      });
    }

    _launchBackgroundTask(task, {
      kind,
      prompt,
      timeoutMs,
      isTestMessage,
      emitTaskFinished = true,
    }) {
      const logFile = assignTaskLogFile(task);
      const startedAt = task.startedAt || new Date().toISOString();

      ensureTaskLogsDir();
      if (!fs.existsSync(logFile)) {
        fs.writeFileSync(logFile, '', 'utf8');
      }

      if (kind === 'post_enrichment') {
        const existingStatus = readCurationStatus();
        const curationRequestId = existingStatus.active && existingStatus.requestId
          ? existingStatus.requestId
          : task.id;
        writeCurationStatus({
          ...existingStatus,
          active: true,
          pid: null,
          startedAt: existingStatus.startedAt || startedAt,
          completedAt: null,
          triggerSource: task.source,
          requestId: curationRequestId,
          phaseTaskId: task.id,
          logFile,
          phase: 'enriching',
          phaseDetail: 'Running post-curation tweet enrichment',
          phaseUpdatedAt: startedAt,
          cancelRequestedAt: null,
          cancelRequestedTaskId: null,
          cacheSkipRequestedAt: null,
        });
        this.emitStatus('curation_phase_changed', {
          event: 'curation_phase',
          taskId: task.id,
          phase: 'enriching',
          detail: 'Running post-curation tweet enrichment',
        });
      } else if (!isTestMessage) {
        const reflectionBase = readReflectionStatus();
        writeReflectionStatus({
          ...reflectionBase,
          active: true,
          pid: null,
          startedAt,
          completedAt: null,
          triggerSource: task.source,
          requestId: task.id,
          logFile,
        });
      }

      const runTask = async () => {
        if (kind === 'post_enrichment') {
          console.log(`[orchestrator] starting background enrichment task ${task.id}`);
        } else {
          console.log(`[orchestrator] starting background reflection task ${task.id}`);
        }

        const onSpawn = (pid) => {
          if (kind === 'post_enrichment') {
            const existingStatus = readCurationStatus();
            const curationRequestId = existingStatus.active && existingStatus.requestId
              ? existingStatus.requestId
              : task.id;
            writeCurationStatus({
              ...existingStatus,
              active: true,
              pid: Number.isInteger(pid) && pid > 0 ? pid : null,
              completedAt: null,
              triggerSource: task.source,
              requestId: curationRequestId,
              phaseTaskId: task.id,
              logFile,
              phase: 'enriching',
              phaseDetail: existingStatus.phaseDetail || 'Running post-curation tweet enrichment',
              phaseUpdatedAt: existingStatus.phaseUpdatedAt || startedAt,
            });
            this.emitStatus('curation_phase_changed', {
              event: 'curation_phase',
              taskId: task.id,
              phase: 'enriching',
              detail: readCurationStatus().phaseDetail || null,
            });
            return;
          }

          if (!isTestMessage) {
            writeReflectionStatus({
              ...(readReflectionStatus()),
              active: true,
              pid: Number.isInteger(pid) && pid > 0 ? pid : null,
              startedAt,
              completedAt: null,
              triggerSource: task.source,
              requestId: task.id,
              logFile,
            });
          }
        };

        if (isTestMessage) {
          return this._runSimulatedBackgroundTask(task, timeoutMs, { kind, onSpawn });
        }

        return this._runBrainTask(task, prompt, timeoutMs, {
          onSpawn,
          forceFreshChatSession: false,
        });
      };

      const cacheRefreshBaselineRun = kind === 'cache_refresh'
        ? this._getTerminalBrowseCacheRefreshRun(task)
        : null;

      return runTask()
        .then((runResult) => {
          task.paneTail = runResult?.paneTail || null;
          task.response = runResult?.response || null;
          task.logFile = runResult?.logFile || task.logFile || null;
          if (kind === 'cache_refresh') {
            const validation = validateCacheRefreshTaskResult(task, {
              baselineRun: cacheRefreshBaselineRun,
              getDb: getChatStatusDb,
              persistNoRunFailure: true,
              failureCause: 'worker exited 0 without writing browse_cache_refresh_runs',
            });
            if (!validation.ok) {
              this._appendCacheRefreshValidationFailureLog(task, validation.error, validation);
              task.state = 'failed';
              task.error = validation.error;
              return;
            }
          }
          task.state = 'completed';
          task.error = null;
        })
        .catch((error) => {
          if (kind === 'cache_refresh') {
            const validation = validateCacheRefreshTaskResult(task, {
              baselineRun: cacheRefreshBaselineRun,
              getDb: getChatStatusDb,
              persistNoRunFailure: true,
              failureCause: error,
            });
            if (!validation.ok) {
              this._appendCacheRefreshValidationFailureLog(task, validation.error, validation);
              task.state = 'failed';
              task.error = validation.error;
              return;
            }
          }
          task.state = 'failed';
          task.error = error instanceof Error ? error.message : String(error);
        })
        .finally(async () => {
          const completedAt = new Date().toISOString();
          let taskSucceeded = task.state === 'completed';
          const isChatBackedTask = this._isChatBackedTask(task);

          task.completedAt = completedAt;

          if (kind === 'post_enrichment') {
            const curationStatus = readCurationStatus();
            if (curationStatus.phaseTaskId === task.id) {
              writeCurationStatus({
                ...curationStatus,
                active: false,
                pid: null,
                completedAt,
                triggerSource: task.source,
                requestId: task.id,
                phaseTaskId: task.id,
                logFile: task.logFile || logFile,
                phase: taskSucceeded ? 'completed' : 'failed',
                phaseDetail: taskSucceeded
                  ? 'Post-curation enrichment completed'
                  : (task.error || 'Post-curation enrichment failed'),
                phaseUpdatedAt: completedAt,
                cancelRequestedAt: null,
                cancelRequestedTaskId: null,
                cacheSkipRequestedAt: null,
              });
              this.emitStatus('curation_phase_changed', {
                event: 'curation_phase',
                taskId: task.id,
                phase: taskSucceeded ? 'completed' : 'failed',
                detail: taskSucceeded
                  ? 'Post-curation enrichment completed'
                  : (task.error || 'Post-curation enrichment failed'),
              });
            }
          } else if (!isTestMessage) {
            const finalStatus = readReflectionStatus();
            writeReflectionStatus({
              ...finalStatus,
              active: false,
              pid: null,
              completedAt,
              lastReflectionAt: taskSucceeded ? completedAt : (finalStatus.lastReflectionAt || null),
              requestId: task.id,
              triggerSource: task.source,
              logFile: task.logFile || logFile,
            });
          }

          if (isChatBackedTask) {
            await this._finalizeChatBackedTask(task);
          }

          this.history = [
            task,
            ...this.history.filter((entry) => entry?.id !== task.id),
          ].slice(0, 120);
          this._saveHistory();
          this._settleTaskCompletionWaiters(task);
          if (emitTaskFinished) {
            this.emitStatus('task_finished', this._buildTaskLifecycleEvent(task));
          }
        });
    }

    async runBackgroundTask({ message, priority, source, metadata, requestId, timeoutMs }) {
      const normalizedMessage = sanitizeMessage(message);
      if (!normalizedMessage) {
        throw new Error('message must be a non-empty string');
      }

      const normalizedPriority = normalizePriority(priority);
      const id = typeof requestId === 'string' && requestId.trim() ? requestId.trim() : randomUUID();

      /** @type {QueueTask} */
      const task = {
        id,
        sequence: this.sequence++,
        source: typeof source === 'string' && source.trim() ? source.trim() : 'internal',
        message: normalizedMessage,
        priority: normalizedPriority,
        priorityValue: this._resolveTaskPriorityValue(normalizedPriority, metadata),
        timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0
          ? Math.min(timeoutMs, TASK_TIMEOUT_MS_BY_PRIORITY[normalizedPriority] || timeoutMs)
          : undefined,
        metadata: metadata && typeof metadata === 'object' ? metadata : null,
        state: 'processing',
        enqueuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        sentAt: null,
        completedAt: null,
        error: null,
        response: null,
        paneTail: null,
        logFile: null,
      };

      const backgroundTaskKind = resolveBackgroundTaskKind(task);
      if (!backgroundTaskKind) {
        throw new Error(`Task ${task.id} is not a supported background job`);
      }

      const prompt = buildTaskPrompt(task);
      const isTestMessage = isUnitTestTask(task);
      const resolvedTimeoutMs = Number.isInteger(task.timeoutMs) && task.timeoutMs > 0
        ? task.timeoutMs
        : resolveTaskTimeoutMs(task);

      this.history.unshift(task);
      if (this.history.length > 120) {
        this.history = this.history.slice(0, 120);
      }
      this._saveHistory();
      this._trackBackgroundTask(task);
      this.emitStatus('task_started', this._buildTaskLifecycleEvent(task));

      try {
        await this._launchBackgroundTask(task, {
          kind: backgroundTaskKind,
          prompt,
          timeoutMs: resolvedTimeoutMs,
          isTestMessage,
          emitTaskFinished: false,
        });

        if (task.state === 'completed') {
          this._resetSpawnFailures();
          return task;
        }

        void this._recordSpawnFailure();
        throw new Error(task.error || `Background task ${task.id} failed`);
      } finally {
        this._untrackBackgroundTask(task);
        this.emitStatus('task_finished', this._buildTaskLifecycleEvent(task));
      }
    }

    enqueue({ message, priority, source, metadata, requestId, timeoutMs }) {
      const normalizedMessage = sanitizeMessage(message);
      if (!normalizedMessage) {
        return {
          ok: false,
          error: 'message must be a non-empty string',
        };
      }

      const normalizedPriority = normalizePriority(priority);

      const id = typeof requestId === 'string' && requestId.trim() ? requestId.trim() : randomUUID();

      /** @type {QueueTask} */
      const task = {
        id,
        sequence: this.sequence++,
        source: typeof source === 'string' && source.trim() ? source.trim() : 'internal',
        message: normalizedMessage,
        priority: normalizedPriority,
        priorityValue: this._resolveTaskPriorityValue(normalizedPriority, metadata),
        timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0
          ? Math.min(timeoutMs, TASK_TIMEOUT_MS_BY_PRIORITY[normalizedPriority] || timeoutMs)
          : undefined,
        metadata: metadata && typeof metadata === 'object' ? metadata : null,
        state: 'queued',
        enqueuedAt: new Date().toISOString(),
        startedAt: null,
        sentAt: null,
        completedAt: null,
        error: null,
        response: null,
        paneTail: null,
        logFile: null,
      };

      if (isChatResearchSource(task.source)) {
        broadcastChatResearchStatus('research_started', {
          taskId: task.id,
          topic: extractResearchTopic(task.message),
          timestamp: task.enqueuedAt,
        });
      }

      // Background reflection tasks launch immediately without
      // waiting for foreground tasks in the queue. They spawn a child process
      // and return right away, so there's no reason to serialize them behind
      // chat/ping tasks that can take minutes.
      const backgroundTaskKind = resolveBackgroundTaskKind(task);
      if (backgroundTaskKind) {
        task.state = 'processing';
        task.startedAt = new Date().toISOString();
        this._markChatBackedTaskProcessing(task);
        const prompt = buildTaskPrompt(task);
        const timeoutMs = resolveTaskTimeoutMs(task);
        const isTestMessage = isUnitTestTask(task);

        const execution = this._launchBackgroundTask(task, {
          kind: backgroundTaskKind,
          prompt,
          timeoutMs,
          isTestMessage,
        });
        void execution.catch(() => {});

        // Add to history immediately (the .finally handler in
        // _launchBackgroundTask will update it again when the task completes).
        this.history.unshift(task);
        if (this.history.length > 120) {
          this.history = this.history.slice(0, 120);
        }
        this._saveHistory();
        this.emitStatus('enqueued');

        return {
          ok: true,
          requestId: task.id,
          priority: task.priority,
          queueDepth: this.queue.length,
          position: 0,
          acceptedAt: task.enqueuedAt,
          backgrounded: true,
        };
      }

      this.queue.push(task);
      this.queue.sort((left, right) => {
        if (right.priorityValue !== left.priorityValue) {
          return right.priorityValue - left.priorityValue;
        }
        return left.sequence - right.sequence;
      });

      const position = this._countBlockingTasksAhead(task) + 1;

      this.emitStatus('enqueued');
      void this._requestProcessLoop();

      return {
        ok: true,
        requestId: task.id,
        priority: task.priority,
        queueDepth: this.queue.length,
        position,
        acceptedAt: task.enqueuedAt,
      };
    }

    readReflectionStatusFile() {
      const status = readReflectionStatus();
      if (status.active) {
        if (status.pid && !isPidRunning(status.pid)) {
          writeReflectionStatus({
            ...status,
            active: false,
            pid: null,
          });
          return null;
        }

        return status.requestId || 'reflection-active';
      }
      return null;
    }

    getStatus() {
      const provider = this._getBrainProvider();
      const activeChatTasks = [...this.activeChatTasks.values()]
        .sort((left, right) => {
          const leftTime = Date.parse(left.startedAt || left.enqueuedAt || 0);
          const rightTime = Date.parse(right.startedAt || right.enqueuedAt || 0);
          return rightTime - leftTime;
        })
        .map((task) => this._serializeTask(task));
      const currentTask = this.currentTask || this._getPrimaryActiveChatTask();

      return {
        sessionName: this.sessionName,
        brainProvider: provider.name,
        brainProviderLabel: provider.displayName,
        brainAvailable: this.brainAvailable,
        consecutiveSpawnFailures: this.consecutiveSpawnFailures,
        queueDepth: this.queue.length,
        isProcessing: this._hasActiveTasks(),
        activeCurationAgent: null,
        activeReflectionAgent: this.readReflectionStatusFile() || null,
        brain: this.lastBrainState,
        currentTask: this._serializeTask(currentTask),
        activeChatTasks,
        queued: this.queue.map((task) => this._serializeTask(task)),
        history: this.history.slice(0, 20).map((task) => this._serializeTask(task, { includeResponsePreview: true })),
        updatedAt: new Date().toISOString(),
      };
    }

    _scheduleForcedTaskKill(pid, onForceCleanup = null) {
      const killTimer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Ignore already-exited processes.
        }

        if (typeof onForceCleanup === 'function') {
          const forceCleanupTimer = setTimeout(() => {
            onForceCleanup();
          }, 10_000);

          if (typeof forceCleanupTimer.unref === 'function') {
            forceCleanupTimer.unref();
          }
        }
      }, 5_000);

      if (typeof killTimer.unref === 'function') {
        killTimer.unref();
      }
    }

    _cancelTrackedForegroundTask(task) {
      const activeRun = this.activeClaudeRuns.get(task.id);
      const pid = activeRun?.pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        return { ok: false, error: 'Active task process is unavailable' };
      }

      this.cancelRequestedTaskIds.add(task.id);
      const chatMessageId = getTaskChatMessageId(task);
      if (chatMessageId) {
        markChatMessageCancelledIfQueued(chatMessageId);
      }

      try {
        process.kill(-pid, 'SIGTERM');
      } catch (error) {
        this.cancelRequestedTaskIds.delete(task.id);
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to cancel task',
        };
      }

      this._scheduleForcedTaskKill(pid, () => {
        const trackedRun = this.activeClaudeRuns.get(task.id);
        const stillTracked = Boolean(this._getActiveTaskById(task.id)) || Boolean(trackedRun);
        if (!stillTracked) {
          return;
        }

        if (typeof trackedRun?.forceFinalize === 'function') {
          trackedRun.forceFinalize();
          return;
        }

        this.cancelRequestedTaskIds.delete(task.id);
        this._clearActiveClaudeRun(task.id);
        this._untrackActiveTask(task);
        this.emitStatus('task_finished', this._buildTaskLifecycleEvent(task));
      });

      this.emitStatus('task_cancel_requested', {
        taskId: task.id,
        chatMessageId,
        sessionId: getTaskSessionId(task),
        ts: new Date().toISOString(),
      });

      return {
        ok: true,
        taskId: task.id,
        chatMessageId,
        sessionId: getTaskSessionId(task),
      };
    }

    _cancelQueuedTaskById(taskId) {
      const queuedTaskIndex = this._getQueuedTaskIndexById(taskId);
      if (queuedTaskIndex < 0) {
        return null;
      }

      const [task] = this.queue.splice(queuedTaskIndex, 1);
      if (!task) {
        return null;
      }

      const chatMessageId = getTaskChatMessageId(task);
      if (chatMessageId) {
        markChatMessageCancelledIfQueued(chatMessageId);
      }

      const event = {
        taskId: task.id,
        chatMessageId,
        sessionId: getTaskSessionId(task),
        dequeued: true,
        ts: new Date().toISOString(),
      };

      this.emitStatus('task_cancel_requested', event);
      void this._requestProcessLoop();

      return {
        ok: true,
        dequeued: true,
        taskId: task.id,
        chatMessageId,
        sessionId: getTaskSessionId(task),
      };
    }

    cancelCurrentTask(taskId = null) {
      const requestedTaskId = typeof taskId === 'string' && taskId.trim()
        ? taskId.trim()
        : null;
      const task = requestedTaskId
        ? this._getActiveTaskById(requestedTaskId)
        : (this.currentTask || this._getPrimaryActiveChatTask());
      if (task && task.state === 'processing') {
        return this._cancelTrackedForegroundTask(task);
      }

      if (requestedTaskId) {
        const queuedCancellation = this._cancelQueuedTaskById(requestedTaskId);
        if (queuedCancellation) {
          return queuedCancellation;
        }
        return { ok: false, error: 'Requested task was not found' };
      }

      return { ok: false, error: 'No running task to cancel' };
    }

    async processTask(task) {
      task.state = 'processing';
      task.startedAt = new Date().toISOString();
      const isChatBackedTask = this._isChatBackedTask(task);
      const isUserChatTask = task.priority === 'user_chat';
      const isTestMessage = isUnitTestTask(task);
      const backgroundTaskKind = resolveBackgroundTaskKind(task);
      const isChatResearchTask = isChatResearchSource(task.source);
      const timeoutMs = resolveTaskTimeoutMs(task);
      const provider = this._getBrainProviderForTask(task);

      if (backgroundTaskKind) {
        const prompt = buildTaskPrompt(task);
        this._launchBackgroundTask(task, {
          kind: backgroundTaskKind,
          prompt,
          timeoutMs,
          isTestMessage,
        });
        return { backgrounded: true };
      }

      // --- Background routing for heavyweight slash commands from chat ---
      if (isUserChatTask && !isTestMessage) {
        const chatBody = typeof task.message === 'string'
          ? task.message.replace(/^[\s\S]*?Chat:\s*/m, '').split('\n')[0].trim()
          : '';
        const slashCommand = extractSlashCommandName(chatBody);

        if (slashCommand && !isChatCommandSupported(provider.name, slashCommand)) {
          const chatMessageId = getTaskChatMessageId(task);
          const sessionId = getTaskSessionId(task);
          const autoReplyPayload = {
            type: 'chat',
            id: `chat-auto-${randomUUID()}`,
            role: 'agent',
            inReplyTo: chatMessageId || null,
            taskId: task.id,
            ...(isUuid(sessionId) ? { sessionId } : {}),
            text: getUnsupportedChatCommandMessage(provider.name, slashCommand),
            timestamp: new Date().toISOString(),
            metadata: {
              autoReply: true,
              taskId: task.id,
              ...(isUuid(sessionId) ? { sessionId } : {}),
            },
          };

          const response = await fetch(`${process.env.MEDIA_AGENT_INTERNAL_BASE_URL || process.env.ORCHESTRATOR_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || '3001'}`}/api/internal/chat/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(autoReplyPayload),
          });
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Failed to persist unsupported-command auto-reply (${response.status}): ${body || 'unknown error'}`);
          }

          task.state = 'completed';
          task.response = autoReplyPayload.text;
          return;
        }

        if (slashCommand && isBackgroundRoutedCommand(slashCommand)) {
          const chatMessageId = getTaskChatMessageId(task);
          const sessionId = getTaskSessionId(task);
          const autoReplyId = `chat-auto-${randomUUID()}`;
          const autoReplyText = `Running /${slashCommand} in the background — results will appear in your feed when done.`;
          const autoReplyTimestamp = new Date().toISOString();

          // Write auto-reply to chat-output.jsonl
          const autoReplyPayload = {
            type: 'chat',
            id: autoReplyId,
            role: 'agent',
            inReplyTo: chatMessageId || null,
            taskId: task.id,
            ...(isUuid(sessionId) ? { sessionId } : {}),
            text: autoReplyText,
            timestamp: autoReplyTimestamp,
            metadata: {
              autoReply: true,
              taskId: task.id,
              ...(isUuid(sessionId) ? { sessionId } : {}),
            },
          };

          const response = await fetch(`${process.env.MEDIA_AGENT_INTERNAL_BASE_URL || process.env.ORCHESTRATOR_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || '3001'}`}/api/internal/chat/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(autoReplyPayload),
          });
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Failed to persist background routing auto-reply (${response.status}): ${body || 'unknown error'}`);
          }

          task.state = 'completed';
          task.response = autoReplyText;
          console.log(`[orchestrator] background-routed /${slashCommand} from chat to user_ping`);

          // Return re-enqueue params so processLoop enqueues AFTER processTask
          // resolves. Enqueueing inside processTask caused the ping task to sit
          // in the queue unprocessed because the inner processLoop() call was a
          // no-op (processingPromise already set) and the while-loop could miss
          // the newly queued item.
          return {
            backgroundRouted: true,
            reEnqueue: {
              message: chatBody,
              priority: 'user_ping',
              source: 'chat_background_routing',
              metadata: {
                sessionId,
                originalChatMessageId: chatMessageId,
                routedFrom: 'user_chat',
              },
              timeoutMs: TASK_TIMEOUT_MS_BY_PRIORITY.user_ping,
            },
          };
        }
      }

      if (isUserChatTask) {
        broadcastChatTyping(true);
      }

      try {
        // Skip full Claude invocation for test messages.
        if (isTestMessage) {
          await delay(2200);
          task.response = '[test] skipped — not sent to brain';
          task.state = 'completed';
          if (isChatResearchTask) {
            broadcastChatResearchStatus('research_completed', {
              taskId: task.id,
              timestamp: new Date().toISOString(),
              feedItemId: null,
            });
          }
          return;
        }

        const prompt = buildTaskPrompt(task);
        let runResult = null;

        try {
          runResult = await this._runBrainTask(task, prompt, timeoutMs, {
            forceFreshChatSession: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failureDetails = getBrainTaskFailureDetails(error);
          const taskSessionId = getTaskSessionId(task);
          const previousSessionId = isUuid(failureDetails?.activeSessionId)
            ? failureDetails.activeSessionId
            : getProviderSessionIdForChatSession(taskSessionId, provider.name)
              || getTaskProviderSessionId(task)
              || this._getStoredChatSessionId(provider.name);
          const poisonedSessionFailure = failureDetails?.isSessionPoisoned === true
            || (
              typeof provider.isSessionPoisoningError === 'function'
              && provider.isSessionPoisoningError(message, failureDetails || {})
            );
          const shouldRetryChatSession = isChatBackedTask
            && isUuid(previousSessionId)
            && (provider.isResumeSessionError(message) || poisonedSessionFailure);

          if (!shouldRetryChatSession) {
            throw error;
          }

          const nextSessionId = randomUUID();
          const appSessionId = getTaskSessionId(task);
          this._setTaskProviderSessionId(task, provider.name, nextSessionId);
          this.chatSessionIds.set(provider.name, nextSessionId);
          if (appSessionId) {
            updateChatSessionProviderSessionId(appSessionId, provider.name, nextSessionId);
          } else {
            this._setStoredChatSessionId(provider.name, nextSessionId);
          }
          broadcastChatSessionReset(poisonedSessionFailure ? 'session_poisoned' : 'resume_failed', nextSessionId, appSessionId);

          const priorMessages = getRecentChatMessages(getChatStatusDb(), {
            limit: 24,
            sessionId: appSessionId,
            excludeMessageId: getTaskChatMessageId(task),
          });
          const priorHistoryBlock = buildSessionResetHistoryBlock(priorMessages, {
            perMessageCharLimit: 400,
            maxBlockChars: 9000,
          });
          const retryPrompt = priorHistoryBlock
            ? buildTaskPrompt({
              ...task,
              message: `${priorHistoryBlock}\n\n${task.message}`,
            })
            : prompt;

          console.warn(
            `[orchestrator] chat session ${poisonedSessionFailure ? 'poisoned' : 'resume failed'}; reset session ${previousSessionId} -> ${nextSessionId}: ${message}`,
          );

          runResult = await this._runBrainTask(task, retryPrompt, timeoutMs, {
            forceFreshChatSession: true,
          });
        }

        task.paneTail = runResult?.paneTail || null;
        task.response = runResult?.response || null;
        task.logFile = runResult?.logFile || task.logFile || null;
        task.state = 'completed';

        if (isChatResearchTask) {
          broadcastChatResearchStatus('research_completed', {
            taskId: task.id,
            timestamp: new Date().toISOString(),
            feedItemId: resolveResearchFeedItemId(runResult?.transcriptLines, runResult?.response),
          });
        }
      } catch (error) {
        const taskFailureMessage = error instanceof Error ? error.message : String(error);
        if (isChatResearchTask) {
          broadcastChatResearchStatus('research_failed', {
            taskId: task.id,
            timestamp: new Date().toISOString(),
            error: taskFailureMessage,
          });
        }
        throw error;
      } finally {
        if (isUserChatTask) {
          broadcastChatTyping(false);
        }
      }
    }

    async _runBrainTask(task, prompt, timeoutMs, {
      onSpawn = null,
      forceFreshChatSession = false,
    } = {}) {
      const systemPrompt = this._readSystemPrompt();
      const provider = this._getBrainProviderForTask(task);
      const invocation = this._buildBrainInvocation(task, prompt, systemPrompt, provider, {
        forceFreshChatSession,
      });
      const transcriptLines = [];
      const assistantTextParts = [];
      const toolUseBlocks = new Map();
      let streamedChatText = '';
      let finalResultText = '';
      const isChatBackedTask = this._isChatBackedTask(task);
      const backgroundSessionKind = task.priority === 'reflection' ? 'reflection' : null;
      let activeSessionId = isChatBackedTask
        ? this._getStoredChatSessionId(provider.name)
        : backgroundSessionKind === 'reflection'
          ? (this.reflectionSession?.provider === provider.name ? this.reflectionSessionId : null)
          : null;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let lastStreamBroadcastAt = 0;
      let allowAssistantTextStreaming = false;
      let timedOut = false;
      let finalized = false;
      let killTimer = null;
      let timeoutTimer = null;
      let cancelPollTimer = null;
      let pendingStreamTimer = null;
      let pendingStreamText = '';
      let lastProgressSignature = '';
      let transcriptLogError = null;
      let hadToolUse = false;
      let hadPartialProgress = false;
      let latestContextMetrics = null;
      let persistedActiveChatSessionId = null;
      const STREAM_THROTTLE_MS = 50;
      const isUserChatTask = task.priority === 'user_chat';
      const chatInReplyTo = task.metadata?.chatMessageId || null;
      const chatSessionId = isChatBackedTask ? getTaskSessionId(task) ?? task.metadata?.sessionId ?? null : null;
      const session = isChatBackedTask && typeof task.metadata?.workingDirectory === 'string' && task.metadata.workingDirectory.trim()
        ? { workingDirectory: task.metadata.workingDirectory.trim() }
        : null;
      const logFilePath = assignTaskLogFile(task);
      const taskDeadlineAt = resolveTaskDeadlineAt(task.startedAt || task.enqueuedAt || null, timeoutMs);
      const spawnOptions = {
        cwd: session?.workingDirectory || process.cwd(),
        env: {
          ...process.env,
          MEDIA_AGENT_ROOT: session?.workingDirectory || process.cwd(),
          DATA_DIR: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
          MEDIA_AGENT_INTERNAL_BASE_URL: process.env.MEDIA_AGENT_INTERNAL_BASE_URL
            || process.env.ORCHESTRATOR_INTERNAL_URL
            || `http://127.0.0.1:${process.env.PORT || '3001'}`,
          MEDIA_AGENT_TASK_ID: task.id,
          MEDIA_AGENT_TASK_TIMEOUT_MS: String(timeoutMs),
          ...(taskDeadlineAt ? { MEDIA_AGENT_TASK_DEADLINE_AT: taskDeadlineAt } : {}),
          ...(invocation.env || {}),
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      const brainSpawnRetryDelaysMs = [5_000, 7_500, 10_000];

      const waitForBrainSpawnRetry = (delayMs) => new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });

      const spawnBrainChild = async () => {
        for (let attempt = 0; ; attempt += 1) {
          let child;
          try {
            child = spawn(invocation.command, invocation.args, spawnOptions);
          } catch (error) {
            const spawnError = error instanceof Error ? error : new Error(String(error));
            if (spawnError && spawnError.code === 'ENOENT' && attempt < brainSpawnRetryDelaysMs.length) {
              const delayMs = brainSpawnRetryDelaysMs[attempt];
              this._refreshBrainRuntimeState({ sessionExistsWhenIdle: false });
              console.warn(`[orchestrator] ${provider.binaryName} spawn hit ENOENT; retrying in ${Math.round(delayMs / 1000)}s (${attempt + 1}/${brainSpawnRetryDelaysMs.length})`);
              await waitForBrainSpawnRetry(delayMs);
              continue;
            }
            throw spawnError;
          }

          try {
            await new Promise((resolve, reject) => {
              const handleSpawn = () => {
                child.off('error', handleError);
                resolve();
              };
              const handleError = (error) => {
                child.off('spawn', handleSpawn);
                reject(error);
              };
              child.once('spawn', handleSpawn);
              child.once('error', handleError);
            });
            return child;
          } catch (error) {
            const spawnError = error instanceof Error ? error : new Error(String(error));
            if (spawnError && spawnError.code === 'ENOENT' && attempt < brainSpawnRetryDelaysMs.length) {
              const delayMs = brainSpawnRetryDelaysMs[attempt];
              this._refreshBrainRuntimeState({ sessionExistsWhenIdle: false });
              console.warn(`[orchestrator] ${provider.binaryName} spawn hit ENOENT; retrying in ${Math.round(delayMs / 1000)}s (${attempt + 1}/${brainSpawnRetryDelaysMs.length})`);
              await waitForBrainSpawnRetry(delayMs);
              continue;
            }
            throw spawnError;
          }
        }
      };

      cleanupExpiredTaskLogs();
      ensureTaskLogsDir();
      fs.writeFileSync(logFilePath, '', 'utf8');

      const child = await spawnBrainChild();
      const claudeTaskUsage = provider.name === 'claude' ? {
        taskId: task.id,
        priority: task.priority,
        sourceLabel: task.priority === 'cache_refresh' ? resolveCacheRefreshTaskSource(task) : null,
        model: readInvocationArg(invocation?.args, '--model'),
        effort: readInvocationArg(invocation?.args, '--effort'),
        startedAtMs: Date.now(),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        resultUsageSeen: false,
      } : null;

      return new Promise((resolve, reject) => {
        task.sentAt = new Date().toISOString();
        const pid = Number.isInteger(child.pid) ? child.pid : null;
        this._touchActiveClaudeRun(task.id, {
          pid,
          paneTail: null,
        });

        if (typeof onSpawn === 'function') {
          onSpawn(pid);
        }

        const maybeEmitTranscript = () => {
          if (transcriptLines.length === 0) return;
          this._emitBrainTranscript(task, transcriptLines, pid);
        };

        const addTranscriptLine = (line) => {
          const normalized = truncateText(typeof line === 'string' ? line : stringifyUnknown(line), 620);
          if (!normalized) return;
          transcriptLines.push(normalized);
          const hardLimit = MAX_TRANSCRIPT_LINES * 4;
          if (transcriptLines.length > hardLimit) {
            transcriptLines.splice(0, transcriptLines.length - hardLimit);
          }
          maybeEmitTranscript();
        };

        const getChatProgressSignature = (payload) => {
          const tool = typeof payload?.tool === 'string' ? payload.tool.trim() : '';
          const activity = typeof payload?.activity === 'string' ? payload.activity.trim() : '';
          const target = typeof payload?.target === 'string' ? payload.target.trim() : '';
          return `${tool}:${activity}:${target}`;
        };

        const sendChatProgress = (payload) => {
          if (!payload || typeof payload.activity !== 'string' || !payload.activity.trim()) {
            return;
          }

          lastProgressSignature = getChatProgressSignature(payload);
          broadcastChatProgress(payload.activity, payload.tool, chatInReplyTo, chatSessionId);
        };

        const sendChatStream = (text) => {
          pendingStreamText = '';
          lastStreamBroadcastAt = Date.now();
          broadcastChatStreaming(text, chatInReplyTo, chatSessionId);
        };

        const queueChatProgress = (payload) => {
          if (!payload || typeof payload.activity !== 'string' || !payload.activity.trim()) {
            return;
          }

          const signature = getChatProgressSignature(payload);
          if (signature === lastProgressSignature) {
            return;
          }

          sendChatProgress(payload);
        };

        const queueChatStream = (text) => {
          if (typeof text !== 'string' || !text) {
            return;
          }

          pendingStreamText = text;
          const now = Date.now();
          if (now - lastStreamBroadcastAt >= STREAM_THROTTLE_MS) {
            if (pendingStreamTimer) {
              clearTimeout(pendingStreamTimer);
              pendingStreamTimer = null;
            }
            sendChatStream(text);
            return;
          }

          if (pendingStreamTimer) {
            return;
          }

          pendingStreamTimer = setTimeout(() => {
            pendingStreamTimer = null;
            if (pendingStreamText) {
              sendChatStream(pendingStreamText);
            }
          }, Math.max(0, STREAM_THROTTLE_MS - (now - lastStreamBroadcastAt)));

          if (typeof pendingStreamTimer.unref === 'function') {
            pendingStreamTimer.unref();
          }
        };

        const flushPendingChatStream = () => {
          if (pendingStreamTimer) {
            clearTimeout(pendingStreamTimer);
            pendingStreamTimer = null;
          }

          if (pendingStreamText) {
            sendChatStream(pendingStreamText);
          }
        };

        const handleLine = (line, streamName) => {
          if (transcriptLogError) return;
          const trimmed = typeof line === 'string' ? line.trim() : '';
          if (!trimmed) return;

          const parsedEvent = safeParseJsonLine(trimmed);
          if (parsedEvent) {
            try {
              fs.appendFileSync(logFilePath, `${trimmed}\n`, 'utf8');
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              transcriptLogError = new Error(`Failed to persist transcript log: ${message}`);
              child.kill('SIGTERM');
              return;
            }

            const sessionIdCandidate = provider.extractSessionId(parsedEvent);
            if (isUuid(sessionIdCandidate)) {
              activeSessionId = sessionIdCandidate;
              if (
                provider.name === 'codex'
                && isChatBackedTask
                && isUuid(chatSessionId)
                && persistedActiveChatSessionId !== activeSessionId
              ) {
                this._setTaskProviderSessionId(task, provider.name, activeSessionId);
                updateChatSessionProviderSessionId(chatSessionId, provider.name, activeSessionId);
                persistedActiveChatSessionId = activeSessionId;
              }
            }

            if (typeof provider.extractContextMetrics === 'function') {
              const nextContextMetrics = provider.extractContextMetrics(parsedEvent);
              if (nextContextMetrics) {
                applyClaudeTaskUsageMetrics(claudeTaskUsage, nextContextMetrics);

                const normalizedModelId = typeof nextContextMetrics.modelId === 'string' && nextContextMetrics.modelId.trim()
                  ? nextContextMetrics.modelId.trim()
                  : null;
                const normalizedContextTokens = Number.isFinite(nextContextMetrics.contextTokens)
                  ? Math.max(0, Math.floor(Number(nextContextMetrics.contextTokens)))
                  : null;
                const normalizedContextWindow = Number.isFinite(nextContextMetrics.contextWindow)
                  ? Math.max(1, Math.floor(Number(nextContextMetrics.contextWindow)))
                  : null;

                if (
                  normalizedModelId !== null
                  || normalizedContextTokens !== null
                  || normalizedContextWindow !== null
                ) {
                  latestContextMetrics = {
                    modelId: latestContextMetrics?.modelId ?? null,
                    contextTokens: Number.isFinite(latestContextMetrics?.contextTokens)
                      ? latestContextMetrics.contextTokens
                      : null,
                    contextWindow: Number.isFinite(latestContextMetrics?.contextWindow)
                      ? latestContextMetrics.contextWindow
                      : null,
                  };

                  if (normalizedModelId !== null) {
                    latestContextMetrics.modelId = normalizedModelId;
                  }

                  if (
                    normalizedContextTokens !== null
                    && (
                      !Number.isFinite(latestContextMetrics.contextTokens)
                      || nextContextMetrics.replaceContextTokens === true
                    )
                  ) {
                    latestContextMetrics.contextTokens = normalizedContextTokens;
                  }

                  if (normalizedContextWindow !== null) {
                    latestContextMetrics.contextWindow = normalizedContextWindow;
                  }
                }
              }
            }

            if (isUserChatTask && !allowAssistantTextStreaming && provider.isFreshAssistantStreamingSignal(parsedEvent)) {
              allowAssistantTextStreaming = true;
            }

            const assistantTexts = provider.collectAssistantText(parsedEvent);
            if (provider.name === 'claude' && parsedEvent.type === 'assistant' && assistantTexts.length > 0 && assistantTextParts.length > 0) {
              assistantTextParts.length = 0;
            }
            for (const text of assistantTexts) {
              if (text) assistantTextParts.push(text);
            }
            if (assistantTexts.length > 0) {
              hadPartialProgress = true;
            }

            if (isUserChatTask) {
              const streamedToolText = provider.extractStreamingChatText(parsedEvent, {
                toolUseBlocks,
                expectedInReplyTo: chatInReplyTo,
              });
              const streamDebugSummary = provider.summarizeEvent(parsedEvent);
              if (streamDebugSummary) {
                const suffix = streamedToolText
                  ? ` -> ${truncateText(streamedToolText.replace(/\s+/g, ' '), 120)}`
                  : '';
                console.log(`[chat-streaming] task ${task.id} ${streamDebugSummary}${suffix}`);
              }
              if (streamedToolText) {
                streamedChatText = streamedToolText;
                hadPartialProgress = true;
              }
            }

            if (isUserChatTask) {
              const chatProgress = provider.extractChatProgress(parsedEvent, {
                toolUseBlocks,
              });
              if (toolUseBlocks.size > 0) {
                hadToolUse = true;
                hadPartialProgress = true;
              }
              const partialChatText = streamedChatText || (
                allowAssistantTextStreaming
                  ? assistantTextParts.join('')
                  : ''
              );
              if (chatProgress) {
                queueChatProgress(chatProgress);
              }
              if (partialChatText) {
                queueChatStream(partialChatText);
              }
            }

            const transcriptParts = provider.formatTranscriptLines(parsedEvent);
            for (const transcriptPart of transcriptParts) {
              if (/^tool(?:\s| result:| error:)/i.test(transcriptPart)) {
                hadToolUse = true;
                hadPartialProgress = true;
              }
              addTranscriptLine(transcriptPart);
            }

            const finalText = provider.extractFinalResultText(parsedEvent);
            if (finalText) {
              finalResultText = finalText;
            }
            return;
          }

          if (streamName === 'stderr') {
            addTranscriptLine(`[stderr] ${trimmed}`);
          } else {
            addTranscriptLine(trimmed);
          }
        };

        const consumeChunk = (chunk, streamName) => {
          const rawChunk = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          if (streamName === 'stderr') {
            stderrBuffer += rawChunk;
            const lines = stderrBuffer.split(/\r?\n/);
            stderrBuffer = lines.pop() || '';
            for (const line of lines) {
              handleLine(line, 'stderr');
            }
            return;
          }

          stdoutBuffer += rawChunk;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() || '';
          for (const line of lines) {
            handleLine(line, 'stdout');
          }
        };

        const finalize = (code, signal, error = null) => {
          if (finalized) return;
          finalized = true;
          const completedAtMs = Date.now();

          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          if (killTimer) {
            clearTimeout(killTimer);
            killTimer = null;
          }
          if (cancelPollTimer) {
            clearInterval(cancelPollTimer);
            cancelPollTimer = null;
          }

          if (stdoutBuffer.trim()) handleLine(stdoutBuffer, 'stdout');
          if (stderrBuffer.trim()) handleLine(stderrBuffer, 'stderr');

          flushPendingChatStream();

          if (isUserChatTask && !streamedChatText) {
            console.warn(`[chat-streaming] task ${task.id} completed without extracted tool stream text`);
          }

          if (isUserChatTask) {
            broadcastChatStreaming('', chatInReplyTo, chatSessionId);
          }

          const paneTail = transcriptLines.at(-1) || null;
          const assistantText = assistantTextParts.join('\n').trim();
          const transcriptFallback = transcriptLines.slice(-30).join('\n').trim();
          const responseText = finalResultText || streamedChatText || assistantText || transcriptFallback || null;
          const buildTaskFailure = (failure) => {
            const sessionId = isUuid(activeSessionId) ? activeSessionId : null;
            const failureDetails = {
              activeSessionId: sessionId,
              hadToolUse,
              hadPartialProgress: hadPartialProgress || hadToolUse || assistantTextParts.length > 0 || Boolean(streamedChatText),
            };
            const message = failure instanceof Error ? failure.message : String(failure);
            return attachBrainTaskFailureDetails(failure, {
              ...failureDetails,
              isSessionPoisoned: Boolean(
                isUserChatTask
                && typeof provider.isSessionPoisoningError === 'function'
                && provider.isSessionPoisoningError(message, failureDetails)
              ),
            });
          };
          let completionError = null;

          if (error || transcriptLogError) {
            completionError = buildTaskFailure(transcriptLogError || error);
          } else if (this.forcedTaskFailureMessages.has(task.id)) {
            completionError = buildTaskFailure(new Error(this.forcedTaskFailureMessages.get(task.id)));
          } else if (timedOut) {
            completionError = buildTaskFailure(new Error(`Task timed out after ${Math.round(timeoutMs / 1000)}s`));
          } else if (typeof code === 'number' && code !== 0) {
            const tail = transcriptLines.slice(-8).join(' | ').trim();
            const suffix = signal ? `, signal ${signal}` : '';
            completionError = buildTaskFailure(new Error(
              `${provider.binaryName} exited with code ${code}${suffix}${tail ? `: ${tail}` : ''}`,
            ));
          }
          const completionFailureDetails = getBrainTaskFailureDetails(completionError);

          this._clearActiveClaudeRun(task.id, {
            sessionExistsWhenIdle: !(error && error.code === 'ENOENT'),
          });

          if (transcriptLines.length > 0) {
            this.emitStatus('brain_transcript', {
              taskId: task.id,
              paneTail,
              paneLines: transcriptLines.slice(-MAX_TRANSCRIPT_LINES),
              pid: null,
              checkedAt: new Date().toISOString(),
            });
          }

          if (isChatBackedTask && isUuid(activeSessionId) && completionFailureDetails?.isSessionPoisoned !== true) {
            this._setStoredChatSessionId(provider.name, activeSessionId);
          }

          if (
            provider.name === 'codex'
            && isChatBackedTask
            && isUuid(activeSessionId)
            && completionError === null
            && (
              !latestContextMetrics
              || !Number.isFinite(latestContextMetrics.contextTokens)
              || !Number.isFinite(latestContextMetrics.contextWindow)
            )
          ) {
            const sessionLogMetrics = readLatestCodexSessionLogContextMetrics({
              sessionId: activeSessionId,
              fallbackModelId: latestContextMetrics?.modelId ?? provider.config?.codexModel ?? null,
            });
            if (sessionLogMetrics) {
              latestContextMetrics = {
                modelId: sessionLogMetrics.latestContextModel,
                contextTokens: sessionLogMetrics.latestContextTokens,
                contextWindow: sessionLogMetrics.latestContextWindow,
                updatedAt: sessionLogMetrics.latestContextUpdatedAt,
              };
            }
          }

          if (
            isChatBackedTask
            && isUuid(chatSessionId)
            && latestContextMetrics
            && Number.isFinite(latestContextMetrics.contextTokens)
            && completionError === null
          ) {
            updateChatSessionContextMetrics({
              sessionId: chatSessionId,
              latestContextTokens: latestContextMetrics.contextTokens,
              latestContextWindow: latestContextMetrics.contextWindow,
              latestContextModel: latestContextMetrics.modelId,
              latestContextUpdatedAt: latestContextMetrics.updatedAt,
            });
            broadcastChatSessionLifecycle('chat_session_updated', { sessionId: chatSessionId });
          }

          if (backgroundSessionKind && isUuid(activeSessionId)) {
            this._persistBackgroundSessionState(backgroundSessionKind, provider.name, activeSessionId);
          }

          if (claudeTaskUsage) {
            try {
              persistClaudeTaskUsage(getChatStatusDb(), claudeTaskUsage, completedAtMs);
            } catch (usageError) {
              const message = usageError instanceof Error ? usageError.message : String(usageError);
              console.warn(`[orchestrator] failed to persist Claude task usage for ${task.id}: ${message}`);
            }
          }

          if (completionError) {
            this.forcedTaskFailureMessages.delete(task.id);
            reject(completionError);
            return;
          }

          if (this.cancelRequestedTaskIds.has(task.id)) {
            this.cancelRequestedTaskIds.delete(task.id);
            reject(new Error('Cancelled by user'));
            return;
          }

          resolve({
            logFile: logFilePath,
            response: responseText,
            paneTail,
            transcriptLines: [...transcriptLines],
          });
          this.forcedTaskFailureMessages.delete(task.id);
        };

        this._touchActiveClaudeRun(task.id, {
          forceFinalize: () => {
            finalize(null, null, null);
          },
        });

        if (isPostEnrichmentTask(task)) {
          cancelPollTimer = setInterval(() => {
            const status = readCurationStatus();
            if (
              status.cancelRequestedTaskId !== task.id
              || !status.cancelRequestedAt
              || this.cancelRequestedTaskIds.has(task.id)
            ) {
              return;
            }

            this.cancelRequestedTaskIds.add(task.id);
            addTranscriptLine('[orchestrator] Cancel requested by user');

            try {
              child.kill('SIGTERM');
            } catch {
              // Process may have already exited.
            }

            if (!killTimer) {
              killTimer = setTimeout(() => {
                try {
                  child.kill('SIGKILL');
                } catch {
                  // Process may have already exited.
                }
              }, 5_000);
              killTimer.unref?.();
            }
          }, 250);
          cancelPollTimer.unref?.();
        }

        child.once('error', (error) => {
          finalize(null, null, error);
        });

        child.stdout?.on('data', (chunk) => {
          consumeChunk(chunk, 'stdout');
        });
        child.stderr?.on('data', (chunk) => {
          consumeChunk(chunk, 'stderr');
        });

        child.once('close', (code, signal) => {
          finalize(code, signal, null);
        });

        timeoutTimer = setTimeout(() => {
          timedOut = true;
          addTranscriptLine(`[orchestrator] Task timed out after ${Math.round(timeoutMs / 1000)}s`);
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            child.kill('SIGKILL');
          }, 5_000);
        }, timeoutMs);

        if (typeof timeoutTimer.unref === 'function') {
          timeoutTimer.unref();
        }
      });
    }

    _runQueuedTask(task) {
      this._trackActiveTask(task);
      this.emitStatus('task_started', this._buildTaskLifecycleEvent(task));

      void (async () => {
        let backgrounded = false;
        const isChatBackedTask = this._isChatBackedTask(task);

        // Mark chat message as processing when the task starts
        this._markChatBackedTaskProcessing(task);

        try {
          const result = await this.processTask(task);
          backgrounded = result?.backgrounded === true;

          // Background-routed tasks (e.g. heavyweight slash commands from chat)
          // return reEnqueue params. Enqueue here after processTask resolves so
          // the scheduler sees the new task on its next pass.
          if (result?.reEnqueue) {
            this.enqueue(result.reEnqueue);
          }
        } catch (error) {
          task.state = 'failed';
          task.error = error instanceof Error ? error.message : 'unknown orchestrator error';
        } finally {
          let chatFinalizeResult = null;

          if (!backgrounded) {
            task.completedAt = new Date().toISOString();
          }

          if (!backgrounded && isChatBackedTask && task.state === 'failed') {
            chatFinalizeResult = await this._finalizeChatBackedTask(task);
          }

          if (!backgrounded) {
            if (task.state === 'completed') {
              this._resetSpawnFailures();
            } else if (task.state === 'failed') {
              if (chatFinalizeResult?.poisonRecovery?.detected) {
                this.consecutiveSpawnFailures = 0;
              } else {
                void this._recordSpawnFailure();
              }
            }
          }

          if (!backgrounded && isChatBackedTask && task.state !== 'failed') {
            await this._finalizeChatBackedTask(task);
          }

          this.history.unshift(task);
          if (this.history.length > 120) {
            this.history = this.history.slice(0, 120);
          }
          this._saveHistory();
          this._settleTaskCompletionWaiters(task);

          this._untrackActiveTask(task);
          this.emitStatus('task_finished', this._buildTaskLifecycleEvent(task));
          void this._requestProcessLoop();
        }
      })();
    }

    async processLoop() {
      if (this.processingPromise) {
        return this.processingPromise;
      }

      this.processingPromise = (async () => {
        while (this.processLoopRequested) {
          this.processLoopRequested = false;

          while (true) {
            const task = this._dequeueNextRunnableTask();
            if (!task) {
              break;
            }

            this._runQueuedTask(task);
          }
        }
      })();

      try {
        await this.processingPromise;
      } finally {
        this.processingPromise = null;
        if (this.processLoopRequested) {
          void this.processLoop();
        } else if (!this._hasActiveTasks() && this.queue.length === 0) {
          this.emitStatus('queue_idle');
        }
      }
    }
  }

  return BrainOrchestrator;
}

module.exports = {
  createBrainOrchestrator,
};
