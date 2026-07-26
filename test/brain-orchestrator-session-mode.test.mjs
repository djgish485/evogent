import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBrainOrchestrator } = require('../lib/brain-orchestrator.js');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-session-mode-'));
  tempDirs.push(dir);
  return dir;
}

function isUuid(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

// Build an orchestrator whose only injected state is: which provider session id
// each (appSession, provider) pair has persisted, and what the single global
// "current chat" pointer currently holds. The stub provider records the
// sessionMode it was handed so we can assert resume-vs-new directly.
function buildOrchestrator({
  perSession = {},
  globalPointer = null,
  claudeSessionExists = () => true,
} = {}) {
  const tmpDir = makeTempDir();
  let storedGlobal = globalPointer;

  const deps = {
    dataPath: (name) => path.join(tmpDir, name),
    fs,
    isUuid,
    randomUUID,
    ensureReflectionStatusFile: () => {},
    cleanupExpiredTaskLogs: () => {},
    getTaskChatMessageId: (task) => task?.metadata?.chatMessageId ?? null,
    getTaskSessionId: (task) => task?.metadata?.sessionId ?? null,
    getTaskProviderSessionId: (task) => task?.metadata?.providerSessionId ?? null,
    claudeSessionExists,
    getProviderSessionIdForChatSession: (sessionId, providerName) =>
      perSession[`${sessionId}:${providerName}`] ?? null,
    // The global pointer is provider-tagged in production; model "not a claude
    // pointer" simply as null for the claude lookups under test.
    readStoredChatProviderSessionId: () => storedGlobal,
    writeStoredChatProviderSessionId: (_providerName, sessionId) => { storedGlobal = sessionId; },
  };

  const BrainOrchestrator = createBrainOrchestrator(deps);
  return new BrainOrchestrator('test-session');
}

const stubProvider = {
  name: 'claude',
  buildInvocation({ sessionMode }) {
    const args = sessionMode.mode === 'resume'
      ? ['--resume', sessionMode.sessionId]
      : sessionMode.mode === 'new'
        ? ['--session-id', sessionMode.sessionId]
        : ['--no-session-persistence'];
    return { command: 'claude', args, env: {}, sessionMode };
  },
};

function chatTask({ sessionId, providerSessionId = null, forceFreshChatSession = false }) {
  return {
    id: `task-${randomUUID()}`,
    priority: 'user_chat',
    message: 'hello',
    metadata: {
      sessionId,
      chatMessageId: `msg-${randomUUID()}`,
      ...(providerSessionId ? { providerSessionId } : {}),
      forceFreshChatSession,
    },
  };
}

function modeFor(orchestrator, task) {
  const invocation = orchestrator._buildBrainInvocation(task, 'prompt', 'system', stubProvider, {
    forceFreshChatSession: false,
  });
  return invocation.sessionMode;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('chat session resume-vs-new decision', () => {
  test('resumes an existing session even when the global pointer is empty (the "already in use" bug)', () => {
    // The exact production failure: the last chat was a different session/provider
    // (e.g. a Codex chat), so the global claude pointer is empty; the orchestrator
    // is fresh from a restart (in-memory map empty). The travel-plans session still
    // has its own persisted Claude session id on disk.
    const appSession = randomUUID();
    const existingProviderSession = randomUUID();
    const orchestrator = buildOrchestrator({
      perSession: { [`${appSession}:claude`]: existingProviderSession },
      globalPointer: null,
    });

    const mode = modeFor(orchestrator, chatTask({ sessionId: appSession }));

    // Must RESUME the session's own id — not start a NEW one with an id that
    // already exists on disk (which exits "Session ID ... is already in use").
    assert.equal(mode.mode, 'resume');
    assert.equal(mode.sessionId, existingProviderSession);
  });

  test('resumes the session-specific id even when the global pointer names a DIFFERENT session', () => {
    const appSession = randomUUID();
    const ownProviderSession = randomUUID();
    const someOtherSession = randomUUID();
    const orchestrator = buildOrchestrator({
      perSession: { [`${appSession}:claude`]: ownProviderSession },
      globalPointer: someOtherSession,
    });

    const mode = modeFor(orchestrator, chatTask({ sessionId: appSession }));

    assert.equal(mode.mode, 'resume');
    assert.equal(mode.sessionId, ownProviderSession);
  });

  test('starts a NEW session for a brand-new chat that has no persisted provider id', () => {
    const appSession = randomUUID();
    const orchestrator = buildOrchestrator({ perSession: {}, globalPointer: null });

    const mode = modeFor(orchestrator, chatTask({ sessionId: appSession, forceFreshChatSession: true }));

    assert.equal(mode.mode, 'new');
    assert.ok(isUuid(mode.sessionId));
  });

  test('a forced-fresh retry starts a NEW session with the freshly minted id', () => {
    // Mirrors the poison-recovery retry: the catch block mints a fresh provider
    // session id, persists it, and retries with forceFreshChatSession.
    const appSession = randomUUID();
    const freshlyMinted = randomUUID();
    const orchestrator = buildOrchestrator({
      perSession: { [`${appSession}:claude`]: freshlyMinted },
      globalPointer: null,
    });

    const mode = modeFor(orchestrator, chatTask({ sessionId: appSession, forceFreshChatSession: true }));

    assert.equal(mode.mode, 'new');
    assert.equal(mode.sessionId, freshlyMinted);
  });

  test('starts fresh with the persisted id when the provider session file is missing', () => {
    const appSession = randomUUID();
    const danglingProviderSession = randomUUID();
    const orchestrator = buildOrchestrator({
      perSession: { [`${appSession}:claude`]: danglingProviderSession },
      claudeSessionExists: () => false,
    });

    const mode = modeFor(orchestrator, chatTask({ sessionId: appSession }));

    assert.equal(mode.mode, 'new');
    assert.equal(mode.sessionId, danglingProviderSession);
  });
});
