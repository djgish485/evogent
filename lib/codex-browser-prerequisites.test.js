/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const test = require('node:test');
const { checkCodexBrowserPrerequisites } = require('./codex-browser-prerequisites');

test('checkCodexBrowserPrerequisites passes when Codex exposes an enabled playwright server on the shared endpoint', async () => {
  const result = await checkCodexBrowserPrerequisites({
    execFileImpl: async () => ({
      stdout: JSON.stringify([
        {
          name: 'playwright',
          enabled: true,
          transport: {
            type: 'stdio',
            command: 'npx',
            args: ['@playwright/mcp@latest', '--cdp-endpoint', 'http://localhost:9222'],
          },
        },
      ]),
      stderr: '',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.expectedCdpUrl, 'http://127.0.0.1:9222');
  assert.equal(result.configuredCdpUrl, 'http://127.0.0.1:9222');
});

test('checkCodexBrowserPrerequisites fails when no Playwright MCP server is configured', async () => {
  const result = await checkCodexBrowserPrerequisites({
    execFileImpl: async () => ({
      stdout: JSON.stringify([]),
      stderr: '',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'playwright_missing');
  assert.match(String(result.message), /configure an enabled Playwright MCP server/i);
});

test('checkCodexBrowserPrerequisites fails when Playwright targets a different CDP endpoint', async () => {
  const result = await checkCodexBrowserPrerequisites({
    execFileImpl: async () => ({
      stdout: JSON.stringify([
        {
          name: 'playwright',
          enabled: true,
          transport: {
            type: 'stdio',
            command: 'npx',
            args: ['@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:9333'],
          },
        },
      ]),
      stderr: '',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'playwright_endpoint_mismatch');
  assert.match(String(result.message), /9333/);
  assert.match(String(result.message), /9222/);
});

test('checkCodexBrowserPrerequisites accepts the managed launcher script as the shared-endpoint source of truth', async () => {
  const result = await checkCodexBrowserPrerequisites({
    cwd: '/root/evogent',
    execFileImpl: async () => ({
      stdout: JSON.stringify([
        {
          name: 'playwright',
          enabled: true,
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['scripts/start-playwright-mcp.js'],
          },
        },
      ]),
      stderr: '',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.configuredCdpUrl, 'http://127.0.0.1:9222');
});
