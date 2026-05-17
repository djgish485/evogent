import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRuntimeTaskPrompt, isChatCommandSupported } from '../lib/runtime-tasks.js';

test('Codex runtime support excludes retired curation commands', () => {
  assert.strictEqual(isChatCommandSupported('codex', 'curate-latest'), false);
  assert.strictEqual(isChatCommandSupported('codex', 'curate'), false);
  assert.strictEqual(isChatCommandSupported('codex', 'source-status'), true);
  assert.strictEqual(isChatCommandSupported('codex', 'develop'), false);
  assert.strictEqual(isChatCommandSupported('claude', 'develop'), true);
});

test('curate instructions treat front-page leads as rare override signals', async () => {
  const rootDir = process.cwd();
  const defaultPrompt = await fs.readFile(path.join(rootDir, 'data', 'curation-prompt.default.md'), 'utf8');

  for (const content of [defaultPrompt]) {
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
