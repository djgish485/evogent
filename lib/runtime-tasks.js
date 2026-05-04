const fs = require('node:fs');
const path = require('node:path');
const {
  resolveCurationPersistDeadlineAt,
  resolveCurationPersistReserveMs,
  resolveTaskDeadlineAt,
} = require('./curation-runtime');
const commandSupport = require('./chat-command-support.json');

const CODEX_SUPPORTED_SLASH_COMMANDS = Object.freeze([...(commandSupport.codex || [])]);

function extractSlashCommandName(message) {
  if (typeof message !== 'string') {
    return null;
  }

  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const match = trimmed.match(/^\/([A-Za-z0-9_-]+)/);
  return match?.[1]?.trim().toLowerCase() || null;
}

function extractSlashCommandArguments(message) {
  if (typeof message !== 'string') {
    return '';
  }

  const trimmed = message.trim();
  const match = trimmed.match(/^\/[A-Za-z0-9_-]+\s*(.*)$/s);
  return match?.[1]?.trim() || '';
}

function isChatCommandSupported(provider, commandName) {
  if (provider !== 'codex') {
    return true;
  }

  return CODEX_SUPPORTED_SLASH_COMMANDS.includes(commandName);
}

function isRuntimeCurationCommand(commandName) {
  return commandName === 'curate' || commandName === 'curate-latest';
}

function isRuntimeCacheRefreshCommand(commandName) {
  return commandName === 'cache-refresh';
}

function normalizeSourceArgument(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().split(/\s+/, 1)[0] || '';
}

function resolveCacheRefreshSource(task, commandArgs) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  if (typeof metadata?.cacheSource === 'string' && metadata.cacheSource.trim()) {
    return normalizeSourceArgument(metadata.cacheSource);
  }
  return normalizeSourceArgument(commandArgs);
}

function isSetupSourceSmokeTask(task) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  return metadata?.setupSourceSmoke === true
    || metadata?.triggerSource === 'setup-source'
    || task?.source === 'setup-source';
}

function sanitizeRunIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown';
}

function getUnsupportedChatCommandMessage(provider, commandName) {
  if (provider !== 'codex') {
    return `/${commandName} is not available right now.`;
  }

  return `/${commandName} is only available when Evogent is powered by Claude Code. Switch the Brain Provider in Config if you want to use it.`;
}

function readRuntimeInstructionFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function resolveRuntimeInstruction(task, rootDir) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  const messageText = typeof task?.message === 'string' ? task.message : '';
  const chatMessageId = typeof metadata?.chatMessageId === 'string' && metadata.chatMessageId.trim()
    ? metadata.chatMessageId.trim()
    : messageText.match(/^ChatMessageId:\s*(\S+)/m)?.[1]?.trim() || '';
  const sessionId = typeof metadata?.sessionId === 'string' && metadata.sessionId.trim()
    ? metadata.sessionId.trim()
    : messageText.match(/^SessionId:\s*(\S+)/m)?.[1]?.trim() || '';
  if (chatMessageId && sessionId) {
    return null;
  }

  const slashCommand = extractSlashCommandName(messageText);
  const commandArgs = extractSlashCommandArguments(messageText);

  if (task?.priority === 'heartbeat' || slashCommand === 'curate') {
    return {
      commandName: 'curate',
      commandArgs,
      instructionPath: path.join(rootDir, '.claude', 'commands', 'curate.md'),
      description: 'Run one full curation cycle.',
    };
  }

  if (slashCommand === 'curate-latest') {
    return {
      commandName: 'curate-latest',
      commandArgs,
      instructionPath: path.join(rootDir, '.claude', 'commands', 'curate-latest.md'),
      description: 'Run one lightweight latest-content curation pass.',
    };
  }

  if (task?.priority === 'cache_refresh' || slashCommand === 'cache-refresh') {
    return {
      commandName: 'cache-refresh',
      commandArgs,
      instructionPath: path.join(rootDir, '.claude', 'commands', 'cache-refresh.md'),
      description: 'Refresh one source into the ambient browse cache.',
    };
  }

  if (task?.priority === 'reflection' || slashCommand === 'reflect') {
    return {
      commandName: 'reflect',
      commandArgs,
      instructionPath: path.join(rootDir, '.claude', 'commands', 'reflect.md'),
      description: 'Run one reflection cycle focused on recent feedback and preference updates.',
    };
  }

  if (slashCommand === 'research') {
    return {
      commandName: 'research',
      commandArgs,
      instructionPath: path.join(rootDir, '.claude', 'commands', 'research.md'),
      description: 'Run one background research task and notify the app when it completes.',
    };
  }

  return null;
}

function resolveInternalBaseUrl(options = {}) {
  if (typeof options.internalBaseUrl === 'string' && options.internalBaseUrl.trim()) {
    return options.internalBaseUrl.trim();
  }

  if (typeof process.env.MEDIA_AGENT_INTERNAL_BASE_URL === 'string' && process.env.MEDIA_AGENT_INTERNAL_BASE_URL.trim()) {
    return process.env.MEDIA_AGENT_INTERNAL_BASE_URL.trim();
  }

  if (typeof process.env.ORCHESTRATOR_INTERNAL_URL === 'string' && process.env.ORCHESTRATOR_INTERNAL_URL.trim()) {
    return process.env.ORCHESTRATOR_INTERNAL_URL.trim();
  }

  const internalPort = process.env.PORT || '3001';
  return `http://127.0.0.1:${internalPort}`;
}

function buildRuntimeTaskPrompt(task, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const runtimeInstruction = resolveRuntimeInstruction(task, rootDir);
  if (!runtimeInstruction) {
    return typeof task?.message === 'string' ? task.message : '';
  }

  const instructionText = readRuntimeInstructionFile(runtimeInstruction.instructionPath);
  if (!instructionText) {
    return typeof task?.message === 'string' ? task.message : '';
  }

  const invocation = runtimeInstruction.commandArgs
    ? `/${runtimeInstruction.commandName} ${runtimeInstruction.commandArgs}`
    : `/${runtimeInstruction.commandName}`;
  const internalBaseUrl = resolveInternalBaseUrl(options);
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(rootDir, 'data');
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : null;
  const startedAt = typeof options.startedAt === 'string' && options.startedAt.trim()
    ? options.startedAt.trim()
    : typeof task?.startedAt === 'string' && task.startedAt.trim()
      ? task.startedAt.trim()
      : typeof task?.enqueuedAt === 'string' && task.enqueuedAt.trim()
        ? task.enqueuedAt.trim()
        : null;
  const taskDeadlineAt = resolveTaskDeadlineAt(startedAt, timeoutMs);
  const curationPersistDeadlineAt = isRuntimeCurationCommand(runtimeInstruction.commandName)
    ? resolveCurationPersistDeadlineAt(startedAt, timeoutMs)
    : null;
  const resolvedValues = [
    `MEDIA_AGENT_ROOT=${rootDir}`,
    `DATA_DIR=${dataDir}`,
    `MEDIA_AGENT_INTERNAL_BASE_URL=${internalBaseUrl}`,
  ];

  if (typeof task?.id === 'string' && task.id.trim()) {
    resolvedValues.push(`MEDIA_AGENT_TASK_ID=${task.id.trim()}`);
  }

  if (timeoutMs) {
    resolvedValues.push(`MEDIA_AGENT_TASK_TIMEOUT_MS=${timeoutMs}`);
  }

  if (taskDeadlineAt) {
    resolvedValues.push(`MEDIA_AGENT_TASK_DEADLINE_AT=${taskDeadlineAt}`);
  }

  if (curationPersistDeadlineAt && timeoutMs) {
    resolvedValues.push(`MEDIA_AGENT_CURATION_PERSIST_DEADLINE_AT=${curationPersistDeadlineAt}`);
    resolvedValues.push(`MEDIA_AGENT_CURATION_PERSIST_RESERVE_MS=${resolveCurationPersistReserveMs(timeoutMs)}`);
    resolvedValues.push(`MEDIA_AGENT_CURATION_PROGRESS_URL=${internalBaseUrl}/api/internal/curation/progress`);
  }

  if (isRuntimeCacheRefreshCommand(runtimeInstruction.commandName)) {
    const cacheSource = resolveCacheRefreshSource(task, runtimeInstruction.commandArgs);
    if (cacheSource) {
      resolvedValues.push(`MEDIA_AGENT_CACHE_REFRESH_SOURCE=${cacheSource}`);
    }
    if (isSetupSourceSmokeTask(task)) {
      const taskId = sanitizeRunIdPart(task?.id || 'unknown');
      const source = sanitizeRunIdPart(cacheSource || 'source');
      resolvedValues.push('MEDIA_AGENT_CACHE_REFRESH_MODE=setup-smoke');
      resolvedValues.push('MEDIA_AGENT_CACHE_REFRESH_TRIGGERED_BY=setup-source-smoke');
      resolvedValues.push(`MEDIA_AGENT_CACHE_REFRESH_RUN_ID=setup-source-${source}-${taskId}`);
      resolvedValues.push('MEDIA_AGENT_CACHE_REFRESH_MAX_ITEMS=5');
    }
  }

  return [
    `You are executing Evogent's built-in runtime task ${invocation}.`,
    runtimeInstruction.description,
    'Treat the instruction document below as the task spec for this single run. Execute it directly instead of interpreting it as a slash command file.',
    `Invocation: ${invocation}`,
    `Task ID: ${task?.id || 'unknown'}`,
    '## Resolved Runtime Values',
    resolvedValues.join('\n'),
    'For internal Evogent API requests such as /api/feed, /api/preferences, and /api/internal/*, always use MEDIA_AGENT_INTERNAL_BASE_URL as the base URL.',
    'Never hardcode localhost:3001, 127.0.0.1:3001, or any other port from repo examples when MEDIA_AGENT_INTERNAL_BASE_URL is provided for this run.',
    isRuntimeCurationCommand(runtimeInstruction.commandName) && curationPersistDeadlineAt
      ? 'For curation runs, treat MEDIA_AGENT_CURATION_PERSIST_DEADLINE_AT as the pre-timeout submit boundary and use MEDIA_AGENT_CURATION_PROGRESS_URL to report phase changes.'
      : null,
    isRuntimeCacheRefreshCommand(runtimeInstruction.commandName)
      ? 'For cache-refresh runs, use MEDIA_AGENT_CACHE_REFRESH_SOURCE as the requested source when present. If MEDIA_AGENT_CACHE_REFRESH_MODE=setup-smoke, run the bounded source-setup proof path and submit the provided run id and triggeredBy values.'
      : null,
    '',
    '## Instruction Document',
    instructionText,
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  CODEX_SUPPORTED_SLASH_COMMANDS,
  buildRuntimeTaskPrompt,
  extractSlashCommandArguments,
  extractSlashCommandName,
  getUnsupportedChatCommandMessage,
  isChatCommandSupported,
};
