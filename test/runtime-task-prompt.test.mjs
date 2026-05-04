import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRuntimeTaskPrompt, isChatCommandSupported } from '../lib/runtime-tasks.js';

test('Codex runtime support includes curate-latest', () => {
  assert.strictEqual(isChatCommandSupported('codex', 'curate-latest'), true);
  assert.strictEqual(isChatCommandSupported('codex', 'source-status'), true);
  assert.strictEqual(isChatCommandSupported('codex', 'develop'), false);
  assert.strictEqual(isChatCommandSupported('claude', 'develop'), true);
});

test('curate instructions treat front-page leads as rare override signals', async () => {
  const rootDir = process.cwd();
  const command = await fs.readFile(path.join(rootDir, '.claude', 'commands', 'curate.md'), 'utf8');
  const defaultPrompt = await fs.readFile(path.join(rootDir, 'data', 'curation-prompt.default.md'), 'utf8');

  for (const content of [command, defaultPrompt]) {
    assert.match(content, /rare override signal, not a routine requirement/);
    assert.match(content, /live public event, policy shock, market shock, war\/diplomacy turn, or major elite-institution story/);
    assert.match(content, /prefer a fresh top-level thread\/update unless there is a clear quality reason to drop it/);
    assert.match(content, /record the headline in `frontPageSignalAudit` and continue normally/);
    assert.match(content, /direct story wording/);
    assert.match(content, /metadata\.thread\.prominence\.level = "lead"/);
    assert.match(content, /one plain sentence (?:rationale about|about) what happened/);
    assert.match(content, /\{\s*headline,\s*prominence,\s*action,\s*reason\s*\}/);
    assert.match(content, /concrete quality reason/);
  }
});

test('buildRuntimeTaskPrompt injects the resolved internal base URL for runtime tasks', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evogent-runtime-task-'));
  const commandsDir = path.join(rootDir, '.claude', 'commands');

  await fs.mkdir(commandsDir, { recursive: true });
  await fs.writeFile(
    path.join(commandsDir, 'curate.md'),
    'Run one full curation cycle in this invocation.\nUse POST /api/internal/curate/submit.\n',
    'utf8',
  );

  const prompt = buildRuntimeTaskPrompt(
    {
      id: 'task-curate-1',
      priority: 'heartbeat',
      message: '/curate',
    },
    {
      rootDir,
      dataDir: '/tmp/evogent-provider-public/data',
      internalBaseUrl: 'http://127.0.0.1:3115',
      startedAt: '2026-03-31T12:00:00.000Z',
      timeoutMs: 20 * 60 * 1000,
    },
  );

  assert.match(prompt, /MEDIA_AGENT_ROOT=/);
  assert.match(prompt, /DATA_DIR=\/tmp\/evogent-provider-public\/data/);
  assert.match(prompt, /MEDIA_AGENT_INTERNAL_BASE_URL=http:\/\/127\.0\.0\.1:3115/);
  assert.match(prompt, /MEDIA_AGENT_TASK_ID=task-curate-1/);
  assert.match(prompt, /MEDIA_AGENT_TASK_TIMEOUT_MS=1200000/);
  assert.match(prompt, /MEDIA_AGENT_TASK_DEADLINE_AT=2026-03-31T12:20:00\.000Z/);
  assert.match(prompt, /MEDIA_AGENT_CURATION_PERSIST_DEADLINE_AT=2026-03-31T12:18:00\.000Z/);
  assert.match(prompt, /MEDIA_AGENT_CURATION_PROGRESS_URL=http:\/\/127\.0\.0\.1:3115\/api\/internal\/curation\/progress/);
  assert.match(prompt, /always use MEDIA_AGENT_INTERNAL_BASE_URL as the base URL/i);
  assert.match(prompt, /Never hardcode localhost:3001, 127\.0\.0\.1:3001/i);
  assert.match(prompt, /submit boundary/i);
  assert.match(prompt, /## Instruction Document/);
});

test('buildRuntimeTaskPrompt preserves chat-backed automated curate instructions', async () => {
  const message = [
    'Chat: /curate',
    'ChatMessageId: msg-automated-curate',
    'SessionId: 33333333-3333-4333-8333-333333333333',
    'Follow the curator instruction document below directly for this turn.',
  ].join('\n');
  const prompt = buildRuntimeTaskPrompt(
    {
      id: 'automated-chat-curate',
      priority: 'user_chat',
      source: 'adaptive_heartbeat:unit-test',
      message,
      metadata: {
        automatedCuration: true,
        curationCommand: '/curate',
        chatMessageId: 'msg-automated-curate',
        sessionId: '33333333-3333-4333-8333-333333333333',
      },
    },
    {
      rootDir: process.cwd(),
      internalBaseUrl: 'http://127.0.0.1:3205',
    },
  );

  assert.strictEqual(prompt, message);
  assert.doesNotMatch(prompt, /built-in runtime task \/curate/i);
});

test('buildRuntimeTaskPrompt maps curate-latest to the live latest-content instruction document', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evogent-runtime-task-'));
  const commandsDir = path.join(rootDir, '.claude', 'commands');

  await fs.mkdir(commandsDir, { recursive: true });
  await fs.writeFile(
    path.join(commandsDir, 'curate-latest.md'),
    [
      'Run one lightweight latest-content curation pass in this invocation.',
      'This command MUST be direct browse, not cache-first.',
    ].join('\n'),
    'utf8',
  );

  const prompt = buildRuntimeTaskPrompt(
    {
      id: 'task-curate-latest-1',
      priority: 'user_ping',
      message: '/curate-latest AI policy',
    },
    {
      rootDir,
      dataDir: '/tmp/evogent-provider-public/data',
      internalBaseUrl: 'http://127.0.0.1:3115',
      startedAt: '2026-03-31T12:00:00.000Z',
      timeoutMs: 20 * 60 * 1000,
    },
  );

  assert.match(prompt, /built-in runtime task \/curate-latest AI policy/);
  assert.match(prompt, /Run one lightweight latest-content curation pass/);
  assert.match(prompt, /This command MUST be direct browse, not cache-first/);
  assert.match(prompt, /MEDIA_AGENT_CURATION_PROGRESS_URL=http:\/\/127\.0\.0\.1:3115\/api\/internal\/curation\/progress/);
});

test('buildRuntimeTaskPrompt injects bounded setup-source smoke values for cache refresh', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evogent-runtime-task-'));
  const commandsDir = path.join(rootDir, '.claude', 'commands');

  await fs.mkdir(commandsDir, { recursive: true });
  await fs.writeFile(
    path.join(commandsDir, 'cache-refresh.md'),
    'Refresh exactly one source into the ambient browse cache.\n',
    'utf8',
  );

  const prompt = buildRuntimeTaskPrompt(
    {
      id: 'setup-source-twitter-20260427120000',
      priority: 'cache_refresh',
      source: 'setup-source',
      message: '/cache-refresh twitter',
      metadata: {
        cacheSource: 'twitter',
        triggerSource: 'setup-source',
        setupSourceSmoke: true,
      },
    },
    {
      rootDir,
      dataDir: '/tmp/evogent-validation/source-setup/data',
      internalBaseUrl: 'http://127.0.0.1:3270',
    },
  );

  assert.match(prompt, /MEDIA_AGENT_CACHE_REFRESH_SOURCE=twitter/);
  assert.match(prompt, /MEDIA_AGENT_CACHE_REFRESH_MODE=setup-smoke/);
  assert.match(prompt, /MEDIA_AGENT_CACHE_REFRESH_TRIGGERED_BY=setup-source-smoke/);
  assert.match(prompt, /MEDIA_AGENT_CACHE_REFRESH_RUN_ID=setup-source-twitter-setup-source-twitter-20260427120000/);
  assert.match(prompt, /MEDIA_AGENT_CACHE_REFRESH_MAX_ITEMS=5/);
  assert.match(prompt, /bounded source-setup proof path/);
});
