'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { applyGitCredentialEnv } = require('./git-credential-env');

const DEFAULT_GIT_OPS_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const gitCommonDirCache = new Map();
const lockPollIntervalMs = 25;

class GitOpsLockTimeoutError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GitOpsLockTimeoutError';
    this.code = 'GIT_OPS_LOCK_TIMEOUT';
    this.lockFile = options.lockFile || null;
    this.lockTimeoutMs = options.lockTimeoutMs || null;
    this.gitArgs = Array.isArray(options.gitArgs) ? options.gitArgs : null;
  }
}

function normalizeTimeoutMs(value, fallbackMs) {
  const normalized = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallbackMs;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getGitCommonDir(repoDir) {
  const resolvedRepoDir = path.resolve(repoDir || process.cwd());
  const cached = gitCommonDirCache.get(resolvedRepoDir);
  if (cached) {
    return cached;
  }

  const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
    cwd: resolvedRepoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  if (!commonDir) {
    throw new Error(`Unable to resolve git common dir for ${resolvedRepoDir}`);
  }

  gitCommonDirCache.set(resolvedRepoDir, commonDir);
  return commonDir;
}

function getGitOpsLockPath(repoDir) {
  return path.join(getGitCommonDir(repoDir), 'evogent-git-ops.lockdir');
}

function buildGitCommandError(result, gitArgs) {
  const stderr = typeof result.stderr === 'string'
    ? result.stderr.trim()
    : Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : '';
  const stdout = typeof result.stdout === 'string'
    ? result.stdout.trim()
    : Buffer.isBuffer(result.stdout)
      ? result.stdout.toString('utf8').trim()
      : '';
  const details = stderr || stdout || `exit code ${result.status}`;
  return new Error(`git ${gitArgs.join(' ')} failed: ${details}`);
}

function sleepSync(milliseconds) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function tryReclaimDeadLock(lockPath) {
  const owner = readLockOwner(lockPath);
  if (!owner || isProcessAlive(owner.pid)) return false;

  const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch {
    return false;
  }
  fs.rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function acquireGitOpsLock(lockPath, lockTimeoutMs, gitArgs) {
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }));
      return () => {
        try {
          fs.rmSync(path.join(lockPath, 'owner.json'), { force: true });
          fs.rmdirSync(lockPath);
        } catch {
          // A later owner can prove this process dead and reclaim the directory.
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (tryReclaimDeadLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new GitOpsLockTimeoutError(
          `Timed out waiting ${lockTimeoutMs}ms for shared git operations lock`,
          {
            gitArgs,
            lockFile: lockPath,
            lockTimeoutMs,
          },
        );
      }
      sleepSync(Math.min(lockPollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function execGitCommandWithLock(gitArgs, options = {}) {
  if (!Array.isArray(gitArgs) || gitArgs.length === 0) {
    throw new Error('execGitCommandWithLock requires git arguments');
  }

  const cwd = options.cwd || process.cwd();
  const lockTimeoutMs = normalizeTimeoutMs(
    options.lockTimeoutMs,
    DEFAULT_GIT_OPS_LOCK_TIMEOUT_MS,
  );
  const lockPath = getGitOpsLockPath(cwd);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const releaseLock = acquireGitOpsLock(lockPath, lockTimeoutMs, gitArgs);
  try {
    const result = spawnSync('git', gitArgs, {
      cwd,
      encoding: options.encoding,
      env: applyGitCredentialEnv(process.env, options.env),
      input: options.input,
      maxBuffer: options.maxBuffer,
      stdio: options.stdio,
      timeout: options.timeout,
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw buildGitCommandError(result, gitArgs);
    }

    if (typeof options.encoding === 'string') {
      return result.stdout || '';
    }

    return result.stdout || Buffer.alloc(0);
  } finally {
    releaseLock();
  }
}

function buildFlockCommandPrefix(repoDir, timeoutSeconds) {
  const lockPath = getGitOpsLockPath(repoDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return `flock -E 75 -w ${shellQuote(String(timeoutSeconds))} ${shellQuote(lockPath)}`;
}

function isGitOpsLockTimeoutError(error) {
  return Boolean(error && error.code === 'GIT_OPS_LOCK_TIMEOUT');
}

module.exports = {
  DEFAULT_GIT_OPS_LOCK_TIMEOUT_MS,
  GitOpsLockTimeoutError,
  acquireGitOpsLock,
  buildFlockCommandPrefix,
  execGitCommandWithLock,
  getGitOpsLockPath,
  isGitOpsLockTimeoutError,
};
