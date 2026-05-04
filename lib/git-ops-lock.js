'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { applyGitCredentialEnv } = require('./git-credential-env');

const DEFAULT_GIT_OPS_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const FLOCK_TIMEOUT_EXIT_CODE = 75;
const gitCommonDirCache = new Map();

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

function formatTimeoutSeconds(timeoutMs) {
  return (timeoutMs / 1000).toFixed(3).replace(/\.?0+$/, '');
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
  return path.join(getGitCommonDir(repoDir), 'evogent-git-ops.lock');
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

  const result = spawnSync('flock', [
    '-E',
    String(FLOCK_TIMEOUT_EXIT_CODE),
    '-w',
    formatTimeoutSeconds(lockTimeoutMs),
    lockPath,
    'git',
    ...gitArgs,
  ], {
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

  if (result.status === FLOCK_TIMEOUT_EXIT_CODE) {
    throw new GitOpsLockTimeoutError(
      `Timed out waiting ${lockTimeoutMs}ms for shared git operations lock`,
      {
        gitArgs,
        lockFile: lockPath,
        lockTimeoutMs,
      },
    );
  }

  if (result.status !== 0) {
    throw buildGitCommandError(result, gitArgs);
  }

  if (typeof options.encoding === 'string') {
    return result.stdout || '';
  }

  return result.stdout || Buffer.alloc(0);
}

function buildFlockCommandPrefix(repoDir, timeoutSeconds) {
  const lockPath = getGitOpsLockPath(repoDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return `flock -E ${FLOCK_TIMEOUT_EXIT_CODE} -w ${shellQuote(String(timeoutSeconds))} ${shellQuote(lockPath)}`;
}

function isGitOpsLockTimeoutError(error) {
  return Boolean(error && error.code === 'GIT_OPS_LOCK_TIMEOUT');
}

module.exports = {
  DEFAULT_GIT_OPS_LOCK_TIMEOUT_MS,
  GitOpsLockTimeoutError,
  buildFlockCommandPrefix,
  execGitCommandWithLock,
  getGitOpsLockPath,
  isGitOpsLockTimeoutError,
};
