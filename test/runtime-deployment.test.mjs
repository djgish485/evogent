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
});
