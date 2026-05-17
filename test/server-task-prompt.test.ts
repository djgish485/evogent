import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function extractBuildTaskPrompt(source: string): string {
  const start = source.indexOf('function buildTaskPrompt');
  const end = source.indexOf('\n\nconst BrainOrchestrator = createBrainOrchestrator');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to locate buildTaskPrompt in server.js');
  }

  return source.slice(start, end);
}

test('buildTaskPrompt passes resolved runtime values into buildRuntimeTaskPrompt', () => {
  const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  const capturedCalls: Array<{ task: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const sandbox = {
    buildRuntimeTaskPrompt: (task: Record<string, unknown>, options: Record<string, unknown>) => {
      capturedCalls.push({ task, options });
      return 'resolved runtime prompt';
    },
    internalBaseUrl: 'http://127.0.0.1:3115',
    process: {
      cwd: () => '/app/root',
      env: {
        DATA_DIR: '/tmp/evogent-provider-public/data',
      },
    },
    resolveTaskTimeoutMs: () => 5 * 60 * 1000,
    path: {
      join: (...parts: string[]) => parts.join('/'),
    },
  } as Record<string, unknown>;

  vm.runInNewContext(`${extractBuildTaskPrompt(serverSource)}; globalThis.buildTaskPrompt = buildTaskPrompt;`, sandbox);

  const buildTaskPrompt = sandbox.buildTaskPrompt as ((task: Record<string, unknown>) => string) | undefined;
  assert.ok(buildTaskPrompt);

  const prompt = buildTaskPrompt({
    id: 'task-123',
    priority: 'user_ping',
    source: 'unit-test',
    enqueuedAt: '2026-03-16T12:34:56.000Z',
    message: '[unit] prompt smoke',
    metadata: {
      ignored: true,
    },
  });

  assert.strictEqual(capturedCalls.length, 1);
  assert.strictEqual(capturedCalls[0]?.options.rootDir, '/app/root');
  assert.strictEqual(capturedCalls[0]?.options.dataDir, '/tmp/evogent-provider-public/data');
  assert.strictEqual(capturedCalls[0]?.options.internalBaseUrl, 'http://127.0.0.1:3115');
  assert.strictEqual(capturedCalls[0]?.options.startedAt, '2026-03-16T12:34:56.000Z');
  assert.strictEqual(capturedCalls[0]?.options.timeoutMs, 5 * 60 * 1000);

  assert.strictEqual(prompt, [
    'You are an ephemeral Evogent task. Complete this task and exit.',
    'Task ID: task-123',
    'Priority: user_ping',
    'Source: unit-test',
    'Timestamp (UTC): 2026-03-16T12:34:56.000Z',
    'resolved runtime prompt',
  ].join('\n\n'));
});

test('buildTaskPrompt embeds routed feed-action skill instructions', () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'data', 'server-task-prompt-'));
  const skillPath = path.join(tempDir, '.claude', 'skills', 'tweet-cache', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '# Tweet Source\n\n## Feed Action Handlers\n\n### `x.follow`\nFollow using the shared browser.');

  try {
    const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    const sandbox = {
      buildRuntimeTaskPrompt: () => 'Action ID: x.follow\nPayload JSON: {"handle":"nickcammarata"}',
      internalBaseUrl: 'http://127.0.0.1:3115',
      process: {
        cwd: () => tempDir,
        env: {},
      },
      resolveTaskTimeoutMs: () => 5 * 60 * 1000,
      fs,
      path,
    } as Record<string, unknown>;

    vm.runInNewContext(`${extractBuildTaskPrompt(serverSource)}; globalThis.buildTaskPrompt = buildTaskPrompt;`, sandbox);
    const buildTaskPrompt = sandbox.buildTaskPrompt as ((task: Record<string, unknown>) => string) | undefined;
    assert.ok(buildTaskPrompt);

    const prompt = buildTaskPrompt({
      id: 'feed-action-task',
      priority: 'feed_action',
      source: 'feed_action_dispatch',
      enqueuedAt: '2026-05-10T12:34:56.000Z',
      message: 'dispatch x.follow',
      metadata: {
        feedAction: { skillPath, actionId: 'x.follow', itemId: 'follow-card-1' },
      },
    });

    assert.match(prompt, /Priority: feed_action/);
    assert.match(prompt, /Run this user-initiated feed-card action/);
    assert.match(prompt, /## Routed Source Skill/);
    assert.match(prompt, /## Feed Action Handlers/);
    assert.match(prompt, /Follow using the shared browser/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
