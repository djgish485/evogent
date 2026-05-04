import assert from 'node:assert';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { getDataPath } from '@/lib/data-dir';
import { spawnSubAgent, type SubAgentHandle } from './sub-agent';

async function createMockCliBin(binaryName: 'claude' | 'codex'): Promise<{ binDir: string; cleanup: () => Promise<void> }> {
  const binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `mock-${binaryName}-`));
  const binaryPath = path.join(binDir, binaryName);

  await fs.promises.writeFile(
    binaryPath,
    [
      '#!/usr/bin/env bash',
      'echo "{\"type\":\"system\",\"subtype\":\"mock\"}"',
      'sleep 1',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.promises.chmod(binaryPath, 0o755);

  return {
    binDir,
    cleanup: async () => {
      await fs.promises.rm(binDir, { recursive: true, force: true });
    },
  };
}

async function spawnWithMock(type: 'curation' | 'enrichment' | 'research'): Promise<{
  handle: SubAgentHandle;
  cleanup: () => Promise<void>;
}> {
  const mock = await createMockCliBin('claude');
  const originalPath = process.env.PATH || '';

  const handle = await spawnSubAgent(type, 'Unit test prompt for sub-agent', {
    provider: 'claude',
    env: {
      NODE_ENV: process.env.NODE_ENV || 'test',
      PATH: `${mock.binDir}:${originalPath}`,
    },
  });

  const cleanup = async () => {
    if (handle.process.exitCode === null && handle.process.signalCode === null) {
      if (!handle.process.killed) {
        handle.process.kill('SIGTERM');
      }

      await Promise.race([
        once(handle.process, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }

    await fs.promises.rm(handle.logFile, { force: true });
    await mock.cleanup();
  };

  return { handle, cleanup };
}

async function spawnWithMockAndOptions(
  type: 'curation' | 'enrichment' | 'research',
  options: Parameters<typeof spawnSubAgent>[2],
): Promise<{
  handle: SubAgentHandle;
  cleanup: () => Promise<void>;
}> {
  const provider = options?.provider === 'codex' ? 'codex' : 'claude';
  const mock = await createMockCliBin(provider);
  const originalPath = process.env.PATH || '';

  const handle = await spawnSubAgent(type, 'Unit test prompt for sub-agent', {
    ...options,
    env: {
      NODE_ENV: process.env.NODE_ENV || 'test',
      ...(options?.env ?? {}),
      PATH: `${mock.binDir}:${originalPath}`,
    },
  });

  const cleanup = async () => {
    if (handle.process.exitCode === null && handle.process.signalCode === null) {
      if (!handle.process.killed) {
        handle.process.kill('SIGTERM');
      }

      await Promise.race([
        once(handle.process, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }

    await fs.promises.rm(handle.logFile, { force: true });
    await mock.cleanup();
  };

  return { handle, cleanup };
}

describe('spawnSubAgent', () => {
  test('creates a log file in data/agent-logs', async () => {
    const { handle, cleanup } = await spawnWithMock('curation');

    try {
      assert.ok(handle.logFile.startsWith(getDataPath('agent-logs')));
      const stat = await fs.promises.stat(handle.logFile);
      assert.ok(stat.isFile());
    } finally {
      await cleanup();
    }
  });

  test('returns handle with correct type/status/startedAt', async () => {
    const { handle, cleanup } = await spawnWithMock('enrichment');

    try {
      assert.strictEqual(handle.type, 'enrichment');
      assert.strictEqual(handle.status, 'running');
      assert.ok(Number.isFinite(Date.parse(handle.startedAt)));
      assert.strictEqual(typeof handle.id, 'string');
      assert.ok(handle.id.length > 0);
    } finally {
      await cleanup();
    }
  });

  test('uses <type>-<timestamp>.jsonl log file naming convention', async () => {
    const { handle, cleanup } = await spawnWithMock('research');

    try {
      const basename = path.basename(handle.logFile);
      assert.match(basename, /^research-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/);
    } finally {
      await cleanup();
    }
  });

  test('uses default allowed tools', async () => {
    const { handle, cleanup } = await spawnWithMock('curation');

    try {
      assert.ok(handle.command.includes("--allowedTools 'Bash,Read,Write,WebSearch,WebFetch'"));
    } finally {
      await cleanup();
    }
  });

  test('uses default permission mode', async () => {
    const { handle, cleanup } = await spawnWithMock('curation');

    try {
      assert.ok(handle.command.includes("--permission-mode 'dontAsk'"));
    } finally {
      await cleanup();
    }
  });

  test('passes explicit --model flag when configured', async () => {
    const { handle, cleanup } = await spawnWithMockAndOptions('curation', {
      provider: 'claude',
      model: 'sonnet',
    });

    try {
      assert.ok(handle.command.includes("--model 'sonnet'"));
    } finally {
      await cleanup();
    }
  });

  test('spawns Codex when provider is codex', async () => {
    const { handle, cleanup } = await spawnWithMockAndOptions('research', {
      provider: 'codex',
      reasoningEffort: 'high',
    });

    try {
      assert.strictEqual(handle.provider, 'codex');
      assert.ok(handle.command.includes('codex exec --json'));
      assert.ok(handle.command.includes("--model 'gpt-5.5'"));
      assert.ok(handle.command.includes("-c 'model_reasoning_effort=high'"));
      assert.ok(handle.command.includes('--dangerously-bypass-approvals-and-sandbox'));
    } finally {
      await cleanup();
    }
  });
});
