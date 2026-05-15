import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
type OpenClawSettings = { gatewayUrl: string; token: string; defaultSessionKey: string };
type GatewayClient = { openSocket: () => void; failConnect: (error: Error) => void; ensureConnected: () => Promise<unknown> };
const readOpenClawSettings = require('./config.js').readOpenClawSettings as (content: string) => OpenClawSettings;
const OpenClawGatewayClient = require('./gateway-client.js').OpenClawGatewayClient as new () => GatewayClient;

test('OpenClaw settings keep empty values on their own line', () => {
  const content = '# Evogent Config\n\n## OpenClaw\nopenclaw.gatewayUrl: \nopenclaw.token: \nopenclaw.defaultSessionKey: agent:main:main';
  assert.deepStrictEqual(readOpenClawSettings(content), {
    gatewayUrl: '',
    token: '',
    defaultSessionKey: 'agent:main:main',
  });
});

test('OpenClaw gateway connect returns the rejected promise from sync failures', async () => {
  const client = new OpenClawGatewayClient();
  client.openSocket = () => client.failConnect(new Error('real config error'));
  await assert.rejects(client.ensureConnected(), /real config error/);
});
