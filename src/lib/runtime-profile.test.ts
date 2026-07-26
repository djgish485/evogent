import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areBackgroundJobsDisabled,
  getAdaptiveHeartbeatMode,
  getListenHost,
  getRuntimeProfile,
  isPhoneRuntime,
} from './runtime-profile';

test('phone profile is loopback-first and disables Redis-backed jobs', () => {
  const env = { NODE_ENV: 'test', EVOGENT_RUNTIME_PROFILE: 'phone' };
  assert.equal(getRuntimeProfile(env), 'phone');
  assert.equal(isPhoneRuntime(env), true);
  assert.equal(areBackgroundJobsDisabled(env), true);
  assert.equal(getAdaptiveHeartbeatMode(env), 'signal');
  assert.equal(getListenHost(env), '127.0.0.1');
});

test('default profile retains direct heartbeat and optional background queue', () => {
  const env = { NODE_ENV: 'test' };
  assert.equal(getRuntimeProfile(env), 'default');
  assert.equal(isPhoneRuntime(env), false);
  assert.equal(areBackgroundJobsDisabled(env), false);
  assert.equal(getAdaptiveHeartbeatMode(env), 'direct');
});

test('explicit safe overrides are honored', () => {
  const env = {
    NODE_ENV: 'test',
    EVOGENT_RUNTIME_PROFILE: 'phone',
    EVOGENT_ADAPTIVE_HEARTBEAT_MODE: 'off',
    LISTEN_HOST: '::1',
  };
  assert.equal(getAdaptiveHeartbeatMode(env), 'off');
  assert.equal(getListenHost(env), '::1');
});
