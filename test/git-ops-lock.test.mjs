import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  execGitCommandWithLock,
  getGitOpsLockPath,
} = require('../lib/git-ops-lock');

test('execGitCommandWithLock surfaces lock timeouts from another process', { concurrency: false }, async () => {
  const lockPath = getGitOpsLockPath(process.cwd());
  fs.mkdirSync(lockPath);
  fs.writeFileSync(
    `${lockPath}/owner.json`,
    JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
  );

  try {
    assert.throws(
      () => execGitCommandWithLock(['status', '--short'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        lockTimeoutMs: 50,
      }),
      (error) => error?.code === 'GIT_OPS_LOCK_TIMEOUT',
    );
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});
