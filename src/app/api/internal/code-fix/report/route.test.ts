import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createChatSession } from '@/lib/db/chat-sessions';
import { getDb } from '@/lib/db/client';
import { getFeedItemById, insertOrIgnoreFeedItem } from '@/lib/db/feed';

type GlobalWithDb = typeof globalThis & { evogentDb?: { close: () => void } };
type RouteModule = { POST: (request: Request) => Promise<Response> };
type FetchCall = { url: string; body: Record<string, unknown> };

const globalWithDb = globalThis as GlobalWithDb;

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
}

describe('internal code-fix report route', { concurrency: false }, () => {
  let originalCwd = '';
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalBaseUrl: string | undefined;
  let originalFetch: typeof fetch;
  let originalWarn: typeof console.warn;
  let tempDir = '';
  let routeModule: RouteModule | null = null;
  let calls: FetchCall[] = [];
  let failChatSubmit = false;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalBaseUrl = process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-code-fix-report-route-test-'));
    calls = [];
    failChatSubmit = false;
    console.warn = () => {};

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.chdir(tempDir);
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
    process.env.MEDIA_AGENT_INTERNAL_BASE_URL = 'http://internal.test';

    globalThis.fetch = (async (input, init) => {
      const rawBody = init?.body;
      const body = typeof rawBody === 'string' ? JSON.parse(rawBody) as Record<string, unknown> : {};
      const url = String(input);
      calls.push({ url, body });
      const status = failChatSubmit && url.endsWith('/api/internal/chat/submit') ? 500 : url.endsWith('/api/internal/orchestrator/enqueue') ? 202 : 200;
      return new Response(JSON.stringify({ ok: status < 400, requestId: body.requestId ?? 'ok', queueDepth: 1 }), { status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const routeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/internal/code-fix/report/route.ts')).href}?case=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    routeModule = await import(routeModuleUrl) as RouteModule;
  });

  afterEach(async () => {
    routeModule = null;
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    process.chdir(originalCwd);
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    if (originalBaseUrl === undefined) delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    else process.env.MEDIA_AGENT_INTERNAL_BASE_URL = originalBaseUrl;
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  function createSuggestionFixture() {
    const session = createChatSession({ id: randomUUID(), title: 'Origin Chat', workingDirectory: originalCwd });
    const suggestionId = `code-fix-${randomUUID()}`;
    assert.ok(insertOrIgnoreFeedItem({
      id: suggestionId,
      type: 'suggestion',
      originSessionId: session.id,
      title: 'Fix self report callback',
      text: 'Persist callback as agent and enqueue audit.',
      metadata: { suggestionType: 'code_fix', originSessionId: session.id },
      publishedAt: new Date().toISOString(),
    }));
    return { session, suggestionId };
  }

  function callBody(pathSuffix: string) {
    const match = calls.find((call) => call.url.endsWith(pathSuffix));
    assert.ok(match, `Expected fetch call to ${pathSuffix}`);
    return match.body;
  }

  function countCalls(pathSuffix: string) {
    return calls.filter((call) => call.url.endsWith(pathSuffix)).length;
  }

  test('done reports persist an agent callback and enqueue an audit chat task without POST /api/chat', async () => {
    assert.ok(routeModule);
    const { session, suggestionId } = createSuggestionFixture();
    const response = await routeModule.POST(new Request('http://127.0.0.1/api/internal/code-fix/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'fix-task-1', suggestionId, phase: 'merged', status: 'done', commitSha: 'abc123' }),
    }));

    assert.strictEqual(response.status, 200);
    assert.strictEqual(calls.some((call) => call.url.endsWith('/api/chat')), false);

    const submitBody = callBody('/api/internal/chat/submit');
    const callbackMessageId = String(submitBody.id);
    assert.match(callbackMessageId, /^chat-code-fix-/);
    assert.strictEqual(submitBody.type, 'chat');
    assert.strictEqual(submitBody.taskId, 'fix-task-1');
    assert.strictEqual(submitBody.sessionId, session.id);
    assert.match(String(submitBody.text), /Audit this merge:/);
    assert.match(String(submitBody.text), /git show abc123 --stat/);

    const enqueueBody = callBody('/api/internal/orchestrator/enqueue');
    assert.strictEqual(enqueueBody.priority, 'user_chat');
    assert.strictEqual(enqueueBody.source, 'code_fix_self_report');
    assert.strictEqual(enqueueBody.requestId, `chat-queue-${callbackMessageId}`);
    assert.match(String(enqueueBody.message), /Chat: A code-fix you authorized just merged\./);
    assert.match(String(enqueueBody.message), /Submit \{"type":"chat"/);

    assertObject(enqueueBody.metadata, 'Expected enqueue metadata');
    assert.strictEqual(enqueueBody.metadata.chatMessageId, callbackMessageId);
    assert.strictEqual(enqueueBody.metadata.inReplyTo, callbackMessageId);
    assert.strictEqual(enqueueBody.metadata.sessionId, session.id);
    assert.strictEqual(enqueueBody.metadata.endpoint, '/api/internal/code-fix/report');
  });

  test('enqueue still fires when callback persistence fails', async () => {
    assert.ok(routeModule);
    failChatSubmit = true;
    const { suggestionId } = createSuggestionFixture();
    const response = await routeModule.POST(new Request('http://127.0.0.1/api/internal/code-fix/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'fix-task-2', suggestionId, phase: 'merged', status: 'done', commitSha: 'def456' }),
    }));

    assert.strictEqual(response.status, 200);
    assert.ok(calls.some((call) => call.url.endsWith('/api/internal/chat/submit')));
    assert.ok(calls.some((call) => call.url.endsWith('/api/internal/orchestrator/enqueue')));
  });

  test('failed reports keep the diagnose prompt and enqueue the same session', async () => {
    assert.ok(routeModule);
    const { session, suggestionId } = createSuggestionFixture();
    const response = await routeModule.POST(new Request('http://127.0.0.1/api/internal/code-fix/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'fix-task-3', suggestionId, phase: 'lint_pass', status: 'failed', reason: 'lint failed' }),
    }));

    assert.strictEqual(response.status, 200);
    assert.match(String(callBody('/api/internal/chat/submit').text), /Diagnose this failure\./);
    assertObject(callBody('/api/internal/orchestrator/enqueue').metadata, 'Expected enqueue metadata');
    assert.strictEqual(callBody('/api/internal/orchestrator/enqueue').metadata.sessionId, session.id);
    const row = getDb().prepare('SELECT status FROM code_fix_tasks WHERE task_id = ?').get('fix-task-3') as { status: string } | undefined;
    assert.strictEqual(row?.status, 'failed');
  });

  test('done reports without a commit SHA are downgraded to failure callbacks', async () => {
    assert.ok(routeModule);
    const { session, suggestionId } = createSuggestionFixture();
    const response = await routeModule.POST(new Request('http://127.0.0.1/api/internal/code-fix/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'fix-task-empty-commit', suggestionId, phase: 'merged', status: 'done', commitSha: '' }),
    }));

    assert.strictEqual(response.status, 200);
    const responseBody = await response.json() as { status?: string };
    assert.strictEqual(responseBody.status, 'failed');

    const submitBody = callBody('/api/internal/chat/submit');
    assert.strictEqual(submitBody.sessionId, session.id);
    assert.match(String(submitBody.text), /reached a terminal failed state/);
    assert.match(String(submitBody.text), /no commit on main: status=done report did not include commitSha/);
    assert.doesNotMatch(String(submitBody.text), /Audit this merge:/);

    const row = getDb()
      .prepare('SELECT status, error FROM code_fix_tasks WHERE task_id = ?')
      .get('fix-task-empty-commit') as { status: string; error: string } | undefined;
    assertObject(row, 'Expected code_fix_tasks row for downgraded report');
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error, 'no commit on main: status=done report did not include commitSha');

    const suggestion = getFeedItemById(suggestionId);
    assertObject(suggestion?.metadata, 'Expected suggestion metadata for downgraded report');
    assert.strictEqual(suggestion?.metadata.suggestionStatus, 'failed');
    assert.strictEqual(suggestion?.metadata.codeFixOrchestratorStatus, 'failed');
    assert.strictEqual(suggestion?.metadata.codeFixFailureReason, 'no commit on main: status=done report did not include commitSha');
    assert.strictEqual(suggestion?.metadata.codeFixMergedAt, undefined);
    assert.strictEqual(suggestion?.metadata.codeFixMergedCommit, undefined);

    const progressBody = callBody('/api/internal/agent-progress');
    assertObject(progressBody.event, 'Expected broadcast event payload');
    assert.strictEqual(progressBody.event.status, 'failed');
    assert.strictEqual(progressBody.event.reason, 'no commit on main: status=done report did not include commitSha');
  });

  test('duplicate done reports for the same task do not enqueue another callback or broadcast', async () => {
    assert.ok(routeModule);
    const { suggestionId } = createSuggestionFixture();
    const requestBody = { taskId: 'fix-task-duplicate-done', suggestionId, phase: 'merged', status: 'done', commitSha: 'first123' };
    const first = await routeModule.POST(new Request('http://127.0.0.1/api/internal/code-fix/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }));

    assert.strictEqual(first.status, 200);
    assert.strictEqual(countCalls('/api/internal/chat/submit'), 1);
    assert.strictEqual(countCalls('/api/internal/orchestrator/enqueue'), 1);
    assert.strictEqual(countCalls('/api/internal/agent-progress'), 1);
    const itemAfterFirst = getFeedItemById(suggestionId);
    const metadataAfterFirst = itemAfterFirst?.metadata;
    assertObject(metadataAfterFirst, 'Expected suggestion metadata after first done report');
    const firstMergedAt = metadataAfterFirst.codeFixMergedAt;
    assert.strictEqual(metadataAfterFirst.codeFixMergedCommit, 'first123');

    const duplicate = await routeModule.POST(new Request('http://127.0.0.1/api/internal/code-fix/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestBody, commitSha: 'second456' }),
    }));

    assert.strictEqual(duplicate.status, 200);
    assert.strictEqual(countCalls('/api/internal/chat/submit'), 1);
    assert.strictEqual(countCalls('/api/internal/orchestrator/enqueue'), 1);
    assert.strictEqual(countCalls('/api/internal/agent-progress'), 1);
    const itemAfterDuplicate = getFeedItemById(suggestionId);
    const metadataAfterDuplicate = itemAfterDuplicate?.metadata;
    assertObject(metadataAfterDuplicate, 'Expected suggestion metadata after duplicate done report');
    assert.strictEqual(metadataAfterDuplicate.codeFixMergedAt, firstMergedAt);
    assert.strictEqual(metadataAfterDuplicate.codeFixMergedCommit, 'first123');
  });

  test('late progress reports keep merged status sticky while updating phase telemetry', async () => {
    assert.ok(routeModule);
    const { suggestionId } = createSuggestionFixture();
    const taskId = 'fix-task-late-progress-after-merge';
    const done = await routeModule.POST(new Request('http://127.0.0.1/api/internal/code-fix/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, suggestionId, phase: 'complete', status: 'done', commitSha: 'merged123' }),
    }));

    assert.strictEqual(done.status, 200);

    const lateProgress = await routeModule.POST(new Request('http://127.0.0.1/api/internal/code-fix/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, suggestionId, phase: 'merge_started', status: 'progress', reason: 'late stale report' }),
    }));

    assert.strictEqual(lateProgress.status, 200);

    const taskRow = getDb()
      .prepare('SELECT status, phase, phase_detail FROM code_fix_tasks WHERE task_id = ?')
      .get(taskId) as { status: string; phase: string; phase_detail: string } | undefined;
    assertObject(taskRow, 'Expected code_fix_tasks row after late progress report');
    assert.strictEqual(taskRow.status, 'merged');
    assert.strictEqual(taskRow.phase, 'merge_started');
    assert.strictEqual(taskRow.phase_detail, 'merge_started: late stale report');

    const suggestion = getFeedItemById(suggestionId);
    assertObject(suggestion?.metadata, 'Expected suggestion metadata after late progress report');
    assert.strictEqual(suggestion?.metadata.suggestionStatus, 'merged');
    assert.strictEqual(suggestion?.metadata.codeFixOrchestratorStatus, 'merged');
    assert.strictEqual(suggestion?.metadata.codeFixPhase, 'merge_started');
    assert.strictEqual(suggestion?.metadata.codeFixPhaseDetail, 'merge_started: late stale report');
    assert.strictEqual(suggestion?.metadata.codeFixMergedCommit, 'merged123');
    assert.strictEqual(countCalls('/api/internal/agent-progress'), 2);
  });
});
