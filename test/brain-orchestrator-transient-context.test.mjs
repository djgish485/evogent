import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBrainOrchestrator } = require('../lib/brain-orchestrator.js');

const tempDirs = [];

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 42_424;
  child.stdinText = '';
  child.stdin = {
    write(value) {
      child.stdinText += String(value);
    },
    end() {},
  };
  return child;
}

function buildHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-transient-orchestrator-'));
  tempDirs.push(tempDir);
  const spawnCalls = [];
  const child = createFakeChild();
  const taskLogsDir = path.join(tempDir, 'task-logs');

  const deps = {
    CLAUDE_SYSTEM_PROMPT_PATH: path.join(tempDir, 'missing-system-prompt.md'),
    DEFAULT_CLAUDE_ALLOWED_TOOLS: 'Read',
    DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS: 'Read',
    DEFAULT_CLAUDE_PERMISSION_MODE: 'dontAsk',
    MAX_TRANSCRIPT_LINES: 20,
    PRIORITY_VALUES: {
      user_chat: 400,
      user_ping: 300,
      feed_action: 325,
      post_enrichment: 200,
      cache_refresh: 150,
      reflection: 50,
    },
    TASK_TIMEOUT_MS_BY_PRIORITY: { user_chat: 5_000 },
    appendAgentEventToChatOutput: async () => {},
    assignTaskLogFile(task) {
      if (!task.logFile) task.logFile = path.join(taskLogsDir, `${task.id}.jsonl`);
      return task.logFile;
    },
    broadcastChatProgress: () => {},
    broadcastChatResearchStatus: () => {},
    broadcastChatSessionReset: () => {},
    broadcastChatStreaming: () => {},
    broadcastChatTyping: () => {},
    broadcastChatUpdate: () => {},
    buildSessionResetHistoryBlock: () => '',
    buildTaskPrompt: (task) => task.message,
    cleanupExpiredTaskLogs: () => {},
    collectAssistantText: () => [],
    dataPath: (name) => path.join(tempDir, name),
    delay: async () => {},
    ensureReflectionStatusFile: () => {},
    ensureTaskLogsDir: () => fs.mkdirSync(taskLogsDir, { recursive: true }),
    extractChatProgressFromEvent: () => null,
    extractFinalResultText: () => '',
    extractResearchTopic: () => '',
    extractSessionIdFromStreamEvent: () => null,
    extractSlashCommandName: () => null,
    extractStreamingChatTextFromEvent: () => null,
    formatTranscriptLines: () => [],
    fs,
    getProviderSessionIdForChatSession: () => null,
    getRecentChatMessages: () => [],
    getTaskChatMessageId: (task) => task?.metadata?.chatMessageId ?? null,
    getTaskProviderSessionId: (task) => task?.metadata?.providerSessionId ?? null,
    getTaskSessionId: (task) => task?.metadata?.sessionId ?? null,
    isBackgroundRoutedCommand: () => false,
    isChatResearchSource: () => false,
    isCurationTask: () => false,
    isFreshAssistantStreamingSignal: () => false,
    isPidRunning: () => false,
    isUnitTestTask: () => false,
    isUuid: (value) => (
      typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ),
    markChatMessageDeliveredIfPendingOrQueued: () => {},
    markChatMessageFailedIfPendingOrQueued: () => {},
    markChatMessageProcessing: () => {},
    normalizePriority: (priority) => priority,
    path,
    postInternal: async () => {},
    randomUUID,
    readCurationStatus: () => ({}),
    readReflectionStatus: () => ({ active: false }),
    readStoredChatProviderSessionId: () => null,
    resolveBackgroundTaskKind: () => null,
    resolveResearchFeedItemId: () => null,
    resolveTaskTimeoutMs: () => 5_000,
    safeParseJsonLine: (line) => JSON.parse(line),
    sanitizeMessage: (message) => String(message).trim(),
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      queueMicrotask(() => {
        child.emit('spawn');
        setTimeout(() => {
          child.stdout.emit('data', `${JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'Provider reply repeats PRIVATE_RUNTIME_SCREEN_CANARY_4437',
            },
          })}\n`);
          child.emit('close', 0, null);
        }, 0);
      });
      return child;
    },
    stringifyUnknown: (value) => JSON.stringify(value),
    summarizeMessage: (value, maxLength) => (
      typeof value === 'string' ? value.slice(0, maxLength) : ''
    ),
    summarizeStreamingChatEvent: () => null,
    truncateText: (value, maxLength) => (
      typeof value === 'string' ? value.slice(0, maxLength) : ''
    ),
    updateChatSessionContextMetrics: () => {},
    updateChatSessionProviderSessionId: () => {},
    clearChatSessionProviderSessionId: () => {},
    writeReflectionStatus: () => {},
    writeStoredChatProviderSessionId: () => {},
  };

  const BrainOrchestrator = createBrainOrchestrator(deps);
  return {
    child,
    orchestrator: new BrainOrchestrator('transient-test'),
    spawnCalls,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('screen context reaches one ephemeral provider over stdin without Evogent log or env exposure', async () => {
  const { child, orchestrator, spawnCalls } = buildHarness();
  const task = {
    id: `task-${randomUUID()}`,
    priority: 'user_chat',
    source: 'user_chat',
    message: 'What am I looking at?',
    enqueuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    metadata: {
      provider: 'codex',
      contextKind: 'screen',
      chatMessageId: `msg-${randomUUID()}`,
      sessionId: randomUUID(),
    },
    logFile: null,
  };
  const privateContext = [
    'The user is viewing a reader.',
    'Visible screen content:',
    'PRIVATE_RUNTIME_SCREEN_CANARY_4437',
  ].join('\n');
  orchestrator._registerTransientScreenContext(task, privateContext);

  const originalSecret = process.env.EVOGENT_SERVER_LOOPBACK_SECRET;
  const originalBaseUrl = process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
  process.env.EVOGENT_SERVER_LOOPBACK_SECRET = 'server-secret-must-not-spawn';
  process.env.MEDIA_AGENT_INTERNAL_BASE_URL = 'http://127.0.0.1:3999';
  try {
    const result = await orchestrator._runBrainTask(task, task.message, 5_000);

    assert.strictEqual(spawnCalls.length, 1);
    const [{ args, options }] = spawnCalls;
    assert.ok(args.includes('--ephemeral'));
    assert.ok(!args.includes('resume'));
    assert.doesNotMatch(args.join(' '), /PRIVATE_RUNTIME_SCREEN_CANARY_4437/);
    assert.match(child.stdinText, /PRIVATE_RUNTIME_SCREEN_CANARY_4437/);
    assert.ok(!Object.hasOwn(options.env, 'EVOGENT_SERVER_LOOPBACK_SECRET'));
    assert.strictEqual(options.env.MEDIA_AGENT_INTERNAL_BASE_URL, 'http://127.0.0.1:3999');

    assert.doesNotMatch(result.response ?? '', /PRIVATE_RUNTIME_SCREEN_CANARY_4437/);
    assert.match(result.response ?? '', /screen context withheld/);
    const durableLog = fs.readFileSync(result.logFile, 'utf8');
    assert.doesNotMatch(durableLog, /PRIVATE_RUNTIME_SCREEN_CANARY_4437/);
    assert.match(durableLog, /screen context withheld/);
    assert.doesNotMatch(result.paneTail ?? '', /PRIVATE_RUNTIME_SCREEN_CANARY_4437/);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.EVOGENT_SERVER_LOOPBACK_SECRET;
    } else {
      process.env.EVOGENT_SERVER_LOOPBACK_SECRET = originalSecret;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    } else {
      process.env.MEDIA_AGENT_INTERNAL_BASE_URL = originalBaseUrl;
    }
  }
});
