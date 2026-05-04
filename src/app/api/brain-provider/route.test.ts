import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testOnly } from './route';

test('mergeCodexAvailability keeps Codex available when only browser prerequisites fail', () => {
  const codex = __testOnly.mergeCodexAvailability(
    {
      provider: 'codex',
      providerDisplayName: 'Codex CLI',
      providerBinary: 'codex',
      available: true,
      version: 'codex 1.2.3',
      error: null,
    },
    {
      ok: false,
      checkedAt: '2026-04-07T00:00:00.000Z',
      expectedCdpUrl: 'http://127.0.0.1:9222',
      configuredCdpUrl: null,
      serverName: null,
      reason: 'playwright_missing',
      message: 'Codex browser prerequisites missing: configure an enabled Playwright MCP server for Codex that targets http://127.0.0.1:9222.',
    },
  );

  assert.equal(codex.available, true);
  assert.equal(codex.error, null);
  assert.equal(codex.diagnostics?.browserTools.ok, false);
  assert.equal(codex.diagnostics?.browserTools.reason, 'playwright_missing');
  assert.equal(codex.diagnostics?.browserTools.expectedCdpUrl, 'http://127.0.0.1:9222');
  assert.equal(codex.diagnostics?.browserTools.serverName, null);
  assert.match(String(codex.diagnostics?.browserTools.message), /Playwright MCP server/i);
});

test('mergeCodexAvailability preserves missing-cli failures without browser diagnostics', () => {
  const codex = __testOnly.mergeCodexAvailability(
    {
      provider: 'codex',
      providerDisplayName: 'Codex CLI',
      providerBinary: 'codex',
      available: false,
      version: null,
      error: 'codex not found in PATH',
    },
    null,
  );

  assert.equal(codex.available, false);
  assert.equal(codex.error, 'codex not found in PATH');
  assert.equal(codex.diagnostics, undefined);
});

test('brain provider switch only blocks interactive or curation task priorities', () => {
  for (const priority of ['user_chat', 'user_ping', 'heartbeat', 'code_fix_spawn', 'reflection']) {
    assert.equal(
      __testOnly.isBrainProviderSwitchBlocked({ priority }),
      true,
      `expected ${priority} to block brain provider switches`,
    );
  }

  for (const priority of ['cache_refresh', 'post_enrichment']) {
    assert.equal(
      __testOnly.isBrainProviderSwitchBlocked({ priority }),
      false,
      `expected ${priority} to allow brain provider switches`,
    );
  }

  assert.equal(__testOnly.isBrainProviderSwitchBlocked(null), false);
});
