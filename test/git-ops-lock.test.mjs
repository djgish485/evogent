import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  execGitCommandWithLock,
  getGitOpsLockPath,
} = require('../lib/git-ops-lock');

test('execGitCommandWithLock surfaces lock timeouts from another process', { concurrency: false }, async () => {
  const lockPath = getGitOpsLockPath(process.cwd());
  const holder = spawn('flock', ['-w', '0', lockPath, 'sleep', '1'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });

  try {
    await delay(50);

    assert.throws(
      () => execGitCommandWithLock(['status', '--short'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        lockTimeoutMs: 50,
      }),
      (error) => error?.code === 'GIT_OPS_LOCK_TIMEOUT',
    );
  } finally {
    holder.kill('SIGTERM');
    await new Promise((resolve) => {
      holder.once('exit', () => resolve());
    });
  }
});
