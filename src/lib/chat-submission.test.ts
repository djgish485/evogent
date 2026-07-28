import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { submitChatMessage } from './chat-submission';
import { createChatSession } from './db/chat-sessions';
import { getDb } from './db/client';
import { POST_CONTEXT_SEPARATOR } from './page-constants';

interface ContractTask {
  id: string;
  message: string;
  priority: string;
  metadata: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface ContractInvocation {
  args: string[];
  promptViaStdin?: string | null;
}

interface ContractProvider {
  name: string;
  buildInvocation: (input: {
    prompt: string;
    systemPrompt: string;
    task: ContractTask;
    sessionMode: { mode: string; sessionId?: string };
  }) => ContractInvocation;
}

interface ContractOrchestrator {
  queue: ContractTask[];
  history: ContractTask[];
  emitStatus: (...args: unknown[]) => void;
  _requestProcessLoop: () => Promise<void>;
  _saveHistory: () => void;
  enqueue: (payload: Record<string, unknown>) => { ok: boolean; requestId?: string };
  _getTransientScreenContext: (task: ContractTask) => string | null;
  _buildBrainInvocation: (
    task: ContractTask,
    prompt: string,
    systemPrompt: string,
    provider: ContractProvider,
  ) => ContractInvocation;
}

type ContractOrchestratorConstructor = new (sessionName?: string) => ContractOrchestrator;

const require = createRequire(import.meta.url);
const { createBrainOrchestrator } = require('../../lib/brain-orchestrator.js') as {
  createBrainOrchestrator: (deps: Record<string, unknown>) => ContractOrchestratorConstructor;
};
const { createCodexProvider } = require('../../lib/providers/codex-provider.js') as {
  createCodexProvider: (
    deps: Record<string, unknown>,
    config: { codexModel: string; codexReasoningEffort: string },
  ) => ContractProvider;
};

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

let originalDbPath: string | undefined;
let originalDataDir: string | undefined;
let originalPath: string | undefined;
let originalFetch: typeof fetch;
let tempDir = '';
let enqueuePayload: Record<string, unknown> | null = null;

function readContractTaskMetadata(task: unknown): Record<string, unknown> {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return {};
  const metadata = (task as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createTransientContractHarness(): ContractOrchestrator {
  const runtimeDir = path.join(tempDir, 'transient-contract-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const BrainOrchestrator = createBrainOrchestrator({
    dataPath: (name: unknown) => path.join(runtimeDir, String(name)),
    fs,
    isUuid,
    randomUUID,
    ensureReflectionStatusFile: () => {},
    cleanupExpiredTaskLogs: () => {},
    getTaskChatMessageId: (task: unknown) => readContractTaskMetadata(task).chatMessageId ?? null,
    getTaskSessionId: (task: unknown) => readContractTaskMetadata(task).sessionId ?? null,
    getTaskProviderSessionId: (task: unknown) => readContractTaskMetadata(task).providerSessionId ?? null,
    getProviderSessionIdForChatSession: () => null,
    readStoredChatProviderSessionId: () => null,
    writeStoredChatProviderSessionId: () => {},
    summarizeMessage: (value: unknown, maxLength: unknown) => (
      typeof value === 'string' ? value.slice(0, Number(maxLength) || 0) : ''
    ),
    sanitizeMessage: (message: unknown) => (
      typeof message === 'string' ? message.trim() : ''
    ),
    normalizePriority: (priority: unknown) => (
      typeof priority === 'string' && priority ? priority : 'user_chat'
    ),
    PRIORITY_VALUES: { user_chat: 400 },
    TASK_TIMEOUT_MS_BY_PRIORITY: { user_chat: 5_000 },
    isChatResearchSource: () => false,
    resolveBackgroundTaskKind: () => null,
    extractResearchTopic: () => '',
  });
  const orchestrator = new BrainOrchestrator('chat-submission-contract');

  // Keep the submitted task queued so the test can inspect the exact object that registration
  // and provider selection consume, without launching a CLI process.
  orchestrator.emitStatus = () => {};
  orchestrator._requestProcessLoop = async () => {};
  return orchestrator;
}

function enqueueThroughTransientProviderContract(payload: Record<string, unknown>): {
  orchestrator: ContractOrchestrator;
  task: ContractTask;
  invocation: ContractInvocation;
} {
  const orchestrator = createTransientContractHarness();
  const enqueueResult = orchestrator.enqueue(payload);
  assert.strictEqual(enqueueResult.ok, true);
  const task = orchestrator.queue.find((candidate) => candidate.id === enqueueResult.requestId);
  assert.ok(task, 'the exact serialized submission payload should produce a queued runtime task');

  const metadata = task.metadata ?? {};
  const appendSystemPrompt = typeof metadata.appendSystemPrompt === 'string'
    ? metadata.appendSystemPrompt
    : '';
  const provider = createCodexProvider({}, {
    codexModel: 'gpt-5.5',
    codexReasoningEffort: 'medium',
  });
  const invocation = orchestrator._buildBrainInvocation(
    task,
    task.message,
    ['System prompt', appendSystemPrompt].filter(Boolean).join('\n\n'),
    provider,
  );
  return { orchestrator, task, invocation };
}

beforeEach(async () => {
  originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
  originalDataDir = process.env.DATA_DIR;
  originalPath = process.env.PATH;
  originalFetch = globalThis.fetch;
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-submit-test-'));

  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }

  process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  process.env.DATA_DIR = tempDir;
  const binDir = path.join(tempDir, 'bin');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(path.join(binDir, 'claude'), '#!/usr/bin/env sh\necho claude-test\n', { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  enqueuePayload = null;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith('/api/orchestrator/enqueue')) {
      throw new Error(`Unexpected fetch in chat-submission.test: ${url}`);
    }

    enqueuePayload = init?.body && typeof init.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;

    return new Response(JSON.stringify({
      ok: true,
      requestId: 'chat-queue-unit-test',
      priority: 'user_chat',
      queueDepth: 1,
      position: 1,
      acceptedAt: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }

  if (originalDbPath === undefined) {
    delete process.env.MEDIA_AGENT_DB_PATH;
  } else {
    process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
  }

  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }

  globalThis.fetch = originalFetch;

  if (tempDir) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('submitChatMessage queues Codex xhigh reasoning and Fast mode metadata from the session', async () => {
  const session = createChatSession({
    provider: 'codex',
    codexReasoningEffort: 'xhigh',
    codexFastMode: true,
    title: 'Codex XHigh',
  });

  const result = await submitChatMessage({
    message: 'Use the selected Codex settings.',
    sessionId: session.id,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(enqueuePayload?.message, 'Use the selected Codex settings.');
  const metadata = enqueuePayload?.metadata as Record<string, unknown> | undefined;
  assert.strictEqual(metadata?.provider, 'codex');
  assert.strictEqual(metadata?.codexReasoningEffort, 'xhigh');
  assert.strictEqual(metadata?.codexFastMode, true);
  assert.match(String(metadata?.appendSystemPrompt), /ChatMessageId: msg-/);
  assert.match(String(metadata?.appendSystemPrompt), /POSTing exactly one JSON body/);
});

test('submitChatMessage withholds phone-notification post content from persistence and runtime-agent instructions', async () => {
  const privateCanary = 'PRIVATE_PHONE_NOTIFICATION_CHAT_CANARY_7781';
  const session = createChatSession({
    provider: 'codex',
    title: 'Private notification boundary',
  });
  getDb().prepare(`
    INSERT INTO feed (id, type, source, source_id, title, text, published_at)
    VALUES (?, 'notification', 'phone-notification', ?, ?, ?, ?)
  `).run(
    'private-phone-notification',
    'phone-notification:private',
    `Private title ${privateCanary}`,
    `Private body ${privateCanary}`,
    new Date().toISOString(),
  );

  const result = await submitChatMessage({
    message: `Chat: What can I do with this?${POST_CONTEXT_SEPARATOR}\nTitle: ${privateCanary}\nFull text: ${privateCanary}`,
    sessionId: session.id,
    context: `Secondary context ${privateCanary}`,
    contextKind: 'post',
    contextRefId: 'private-phone-notification',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.userMessage.text, 'What can I do with this?');
  assert.doesNotMatch(JSON.stringify(result.userMessage), new RegExp(privateCanary));
  assert.doesNotMatch(JSON.stringify(enqueuePayload), new RegExp(privateCanary));
  assert.strictEqual(enqueuePayload?.message, 'What can I do with this?');
  const metadata = enqueuePayload?.metadata as Record<string, unknown> | undefined;
  assert.match(String(metadata?.appendSystemPrompt), /local, model-free card/i);

  const persisted = getDb().prepare(`
    SELECT text, context, metadata
    FROM chat_messages
    WHERE id = ?
  `).get(result.userMessage.id) as {
    text: string;
    context: string | null;
    metadata: string | null;
  };
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(privateCanary));
  assert.match(persisted.context ?? '', /intentionally unavailable/i);
  const persistedMetadata = JSON.parse(persisted.metadata ?? '{}') as Record<string, unknown>;
  assert.equal(persistedMetadata.phoneNotificationContentWithheld, true);
  assert.equal(persistedMetadata.phoneNotificationSessionEvidencePurged, true);
  assert.equal(persistedMetadata.phoneNotificationAuditEvidencePurged, true);
  assert.equal(persistedMetadata.phoneNotificationOrchestratorEvidencePurged, true);
});

test('screen context bypasses durable chat and task fields and uses only the transient enqueue channel', async () => {
  const privateCanary = 'PRIVATE_SCREEN_CONTEXT_CANARY_9274';
  const metadataCanary = 'PRIVATE_SCREEN_METADATA_CANARY_6118';
  const screenApp = 'com.private.example.reader';
  const screenContext = `The user is viewing ${screenApp}. Visible screen content:\n${privateCanary}`;
  const session = createChatSession({
    provider: 'codex',
    title: 'Transient screen context',
  });

  const result = await submitChatMessage({
    message: 'Summarize what I am looking at.',
    sessionId: session.id,
    context: screenContext,
    contextKind: 'screen',
    contextRefId: 'current-overlay-screen',
    originView: 'post_detail',
    metadata: {
      overlay: true,
      screenApp,
      arbitrary: metadataCanary,
      nested: { value: metadataCanary },
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.userMessage.context, null);
  assert.doesNotMatch(JSON.stringify(result.userMessage), new RegExp(`${screenApp}|${metadataCanary}`));
  assert.strictEqual(enqueuePayload?.transientScreenContext, screenContext);
  const taskMetadata = enqueuePayload?.metadata as Record<string, unknown> | undefined;
  assert.strictEqual(taskMetadata?.overlay, true);
  assert.strictEqual(taskMetadata?.contextKind, 'screen');
  assert.strictEqual(taskMetadata?.contextRefId, 'current-overlay-screen');
  assert.strictEqual(taskMetadata?.originView, 'post_detail');
  assert.ok(!Object.hasOwn(taskMetadata ?? {}, 'screenApp'));
  assert.ok(!Object.hasOwn(taskMetadata ?? {}, 'arbitrary'));
  assert.ok(!Object.hasOwn(taskMetadata ?? {}, 'nested'));
  const {
    transientScreenContext,
    ...durableTaskPayload
  } = enqueuePayload ?? {};
  assert.strictEqual(transientScreenContext, screenContext);
  assert.doesNotMatch(JSON.stringify(durableTaskPayload), new RegExp(privateCanary));
  assert.doesNotMatch(JSON.stringify(durableTaskPayload), new RegExp(`${screenApp}|${metadataCanary}`));

  const persisted = getDb().prepare(`
    SELECT text, context, metadata
    FROM chat_messages
    WHERE id = ?
  `).get(result.userMessage.id) as {
    text: string;
    context: string | null;
    metadata: string | null;
  };
  assert.strictEqual(persisted.text, 'Summarize what I am looking at.');
  assert.strictEqual(persisted.context, null);
  assert.doesNotMatch(persisted.metadata ?? '', new RegExp(privateCanary));
  assert.doesNotMatch(persisted.metadata ?? '', new RegExp(`${screenApp}|${metadataCanary}`));
  assert.strictEqual(
    (JSON.parse(persisted.metadata ?? '{}') as Record<string, unknown>).contextKind,
    'screen',
  );

  assert.ok(enqueuePayload);
  const { orchestrator, task, invocation } = enqueueThroughTransientProviderContract(enqueuePayload);
  assert.strictEqual(
    orchestrator._getTransientScreenContext(task),
    screenContext,
    'the serialized submission payload must satisfy the runtime registration guard',
  );
  assert.strictEqual(task.metadata?.contextKind, 'screen');
  assert.strictEqual(task.metadata?.contextRefId, 'current-overlay-screen');
  assert.strictEqual(task.metadata?.originView, 'post_detail');
  assert.doesNotMatch(JSON.stringify(task), new RegExp(privateCanary));
  assert.doesNotMatch(JSON.stringify(task), new RegExp(`${screenApp}|${metadataCanary}`));
  orchestrator.history.unshift(task);
  orchestrator._saveHistory();
  const durableHistory = fs.readFileSync(
    path.join(tempDir, 'transient-contract-runtime', 'orchestrator-history.json'),
    'utf8',
  );
  assert.doesNotMatch(durableHistory, new RegExp(`${privateCanary}|${screenApp}|${metadataCanary}`));
  assert.deepStrictEqual(invocation.args.slice(0, 2), ['exec', '--ephemeral']);
  assert.ok(!invocation.args.includes('resume'));
  assert.match(invocation.promptViaStdin ?? '', new RegExp(privateCanary));
  assert.match(invocation.promptViaStdin ?? '', new RegExp(screenApp));
  assert.doesNotMatch(invocation.promptViaStdin ?? '', new RegExp(metadataCanary));
  assert.doesNotMatch(invocation.args.join(' '), new RegExp(privateCanary));
  assert.doesNotMatch(invocation.args.join(' '), new RegExp(`${screenApp}|${metadataCanary}`));
});

test('ordinary chat context keeps its existing durable and provider-instruction behavior', async () => {
  const ordinaryContext = 'Durable user-provided project context';
  const session = createChatSession({
    provider: 'codex',
    title: 'Ordinary context',
  });

  const result = await submitChatMessage({
    message: 'Use this project context.',
    sessionId: session.id,
    context: ordinaryContext,
    contextKind: 'global',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.userMessage.context, ordinaryContext);
  assert.ok(!Object.hasOwn(enqueuePayload ?? {}, 'transientScreenContext'));
  const metadata = enqueuePayload?.metadata as Record<string, unknown> | undefined;
  assert.strictEqual(metadata?.contextKind, 'global');
  assert.strictEqual(metadata?.contextRefId, null);
  assert.strictEqual(metadata?.originView, 'feed');
  assert.match(String(metadata?.appendSystemPrompt), new RegExp(ordinaryContext));

  const persisted = getDb().prepare(`
    SELECT context
    FROM chat_messages
    WHERE id = ?
  `).get(result.userMessage.id) as { context: string | null };
  assert.strictEqual(persisted.context, ordinaryContext);

  assert.ok(enqueuePayload);
  const { orchestrator, task, invocation } = enqueueThroughTransientProviderContract(enqueuePayload);
  assert.strictEqual(orchestrator._getTransientScreenContext(task), null);
  assert.ok(!invocation.args.includes('--ephemeral'));
  assert.strictEqual(invocation.promptViaStdin, undefined);
  assert.match(invocation.args.at(-1) ?? '', new RegExp(ordinaryContext));
});
