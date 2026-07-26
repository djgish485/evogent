import assert from 'node:assert/strict';
import test from 'node:test';

import runtimeDeployment from '../lib/runtime-deployment.js';

const { readDeploymentIdentity } = runtimeDeployment;

test('readDeploymentIdentity captures commit and build metadata from the running snapshot inputs', () => {
  const calls = [];
  const deployment = readDeploymentIdentity({
    cwd: '/tmp/evogent',
    startedAt: '2026-03-27T19:30:00.000Z',
    env: { NODE_ENV: 'production' },
    version: '0.1.0-test',
    execFileSync(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      if (args.join(' ') === 'rev-parse --short HEAD') {
        return 'abc123\n';
      }
      if (args.join(' ') === 'rev-parse HEAD') {
        return 'abc123def456\n';
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
    readFileSync(filePath) {
      if (filePath === '/tmp/evogent/.evogent-release.json') {
        throw new Error('not a phone release');
      }
      assert.equal(filePath, '/tmp/evogent/.next/BUILD_ID');
      return 'build-live-42\n';
    },
  });

  assert.deepEqual(calls, [
    { command: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/tmp/evogent' },
    { command: 'git', args: ['rev-parse', 'HEAD'], cwd: '/tmp/evogent' },
  ]);
  assert.deepEqual(deployment, {
    startedAt: '2026-03-27T19:30:00.000Z',
    nodeEnv: 'production',
    version: '0.1.0-test',
    buildId: 'build-live-42',
    commit: 'abc123',
    commitFull: 'abc123def456',
    releaseId: null,
    releaseFormat: null,
  });
});

test('readDeploymentIdentity tolerates missing git metadata and build output', () => {
  const deployment = readDeploymentIdentity({
    cwd: '/tmp/evogent',
    startedAt: '2026-03-27T19:30:00.000Z',
    env: {},
    execFileSync() {
      throw new Error('git unavailable');
    },
    readFileSync() {
      throw new Error('missing build');
    },
  });

  assert.equal(deployment.buildId, null);
  assert.equal(deployment.commit, null);
  assert.equal(deployment.commitFull, null);
  assert.equal(deployment.nodeEnv, null);
  assert.equal(deployment.releaseId, null);
  assert.equal(deployment.releaseFormat, null);
});

test('readDeploymentIdentity prefers immutable phone release metadata without a Git checkout', () => {
  const deployment = readDeploymentIdentity({
    cwd: '/phone/release/runtime',
    startedAt: '2026-07-25T12:00:00.000Z',
    env: { NODE_ENV: 'production' },
    execFileSync() {
      throw new Error('git must not be needed');
    },
    readFileSync(filePath) {
      assert.equal(filePath, '/phone/release/runtime/.evogent-release.json');
      return JSON.stringify({
        releaseFormat: 1,
        releaseId: 'abc123-build-apk2',
        sourceCommit: 'abcdef1234567890',
        sourceCommitShort: 'abcdef123456',
        buildId: 'next-build-id',
      });
    },
  });

  assert.equal(deployment.releaseId, 'abc123-build-apk2');
  assert.equal(deployment.releaseFormat, 1);
  assert.equal(deployment.commit, 'abcdef123456');
  assert.equal(deployment.commitFull, 'abcdef1234567890');
  assert.equal(deployment.buildId, 'next-build-id');
});
