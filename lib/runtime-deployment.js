/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const packageJson = require('../package.json');

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readCommandOutput(command, args, options = {}) {
  const execFileSyncImpl = typeof options.execFileSync === 'function' ? options.execFileSync : execFileSync;

  try {
    const output = execFileSyncImpl(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return normalizeOptionalString(output);
  } catch {
    return null;
  }
}

function readBuildId(cwd, readFileSyncImpl = fs.readFileSync) {
  try {
    const buildIdPath = path.join(cwd, '.next', 'BUILD_ID');
    return normalizeOptionalString(readFileSyncImpl(buildIdPath, 'utf8'));
  } catch {
    return null;
  }
}

function readDeploymentIdentity(options = {}) {
  const cwd = normalizeOptionalString(options.cwd) || process.cwd();
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const readFileSyncImpl = typeof options.readFileSync === 'function' ? options.readFileSync : fs.readFileSync;
  const execFileSyncImpl = typeof options.execFileSync === 'function' ? options.execFileSync : execFileSync;
  const startedAt = normalizeOptionalString(options.startedAt) || new Date().toISOString();

  const commit = readCommandOutput('git', ['rev-parse', '--short', 'HEAD'], { cwd, execFileSync: execFileSyncImpl });
  const commitFull = readCommandOutput('git', ['rev-parse', 'HEAD'], { cwd, execFileSync: execFileSyncImpl });

  return {
    startedAt,
    nodeEnv: normalizeOptionalString(env.NODE_ENV),
    version: normalizeOptionalString(options.version) || normalizeOptionalString(packageJson.version),
    buildId: readBuildId(cwd, readFileSyncImpl),
    commit,
    commitFull,
  };
}

const runtimeDeploymentSnapshot = Object.freeze(readDeploymentIdentity());

function getRuntimeDeploymentSnapshot() {
  return { ...runtimeDeploymentSnapshot };
}

module.exports = {
  getRuntimeDeploymentSnapshot,
  readDeploymentIdentity,
};
