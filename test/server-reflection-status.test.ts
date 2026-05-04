import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function extractStatusHelpers(source: string): string {
  const start = source.indexOf('function parseStatusString');
  const end = source.indexOf('function isLocalRequest');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to locate reflection status helpers in server.js');
  }

  return source.slice(start, end);
}

test('writeReflectionStatus merges existing reflection-only fields with orchestrator updates', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-status-test-'));
  const statusPath = path.join(tempDir, 'reflection-status.json');

  try {
    fs.writeFileSync(statusPath, JSON.stringify({
      active: true,
      startedAt: '2026-03-10T00:00:00.000Z',
      logFile: 'data/agent-logs/reflection-2026-03-10.log',
      phase: 'running',
      focus: 'recent dislikes',
      error: null,
    }, null, 2));

    const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    const sandbox = {
      fs,
      path,
      console,
      reflectionStatusPath: statusPath,
    } as Record<string, unknown>;

    vm.runInNewContext(`${extractStatusHelpers(serverSource)}; globalThis.writeReflectionStatus = writeReflectionStatus;`, sandbox);

    const writeReflectionStatus = sandbox.writeReflectionStatus as ((status: Record<string, unknown>) => void) | undefined;
    assert.ok(writeReflectionStatus);

    writeReflectionStatus({
      active: false,
      completedAt: '2026-03-11T01:00:00.000Z',
      lastReflectionAt: '2026-03-11T01:00:00.000Z',
    });

    const persisted = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    assert.strictEqual(persisted.active, false);
    assert.strictEqual(persisted.completedAt, '2026-03-11T01:00:00.000Z');
    assert.strictEqual(persisted.lastReflectionAt, '2026-03-11T01:00:00.000Z');
    assert.strictEqual(persisted.logFile, 'data/agent-logs/reflection-2026-03-10.log');
    assert.strictEqual(persisted.phase, 'running');
    assert.strictEqual(persisted.focus, 'recent dislikes');
    assert.strictEqual(persisted.error, null);
    assert.strictEqual(persisted.startedAt, '2026-03-10T00:00:00.000Z');
    assert.strictEqual(typeof persisted.updatedAt, 'string');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
