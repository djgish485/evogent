import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { __testOnly as sharedBrowserTestOnly } from './shared-browser';
import {
  __testOnly as restartAdapterTestOnly,
  restartSharedBrowserUsingAdapter,
} from './shared-browser-restart-adapter';

const DEFAULT_PROFILE_DIR = path.join(process.cwd(), 'data', 'chrome-browse-profile');
const DEFAULT_KEYRING_DIR = '/root/.local/share/keyrings';

afterEach(() => {
  delete process.env.MEDIA_AGENT_SHARED_BROWSER_RESTART_COMMAND;
  delete process.env.SHARED_BROWSER_RESTART_COMMAND;
  delete process.env.SHARED_BROWSER_SERVICE_NAME;
  sharedBrowserTestOnly.resetLifecycleOverrides();
  restartAdapterTestOnly.resetRestartAdapterOverrides();
});

test('restartSharedBrowserUsingAdapter fails explicitly when no deployment adapter is configured', async () => {
  sharedBrowserTestOnly.setLifecycleOverrides({
    probeSharedBrowserVersion: async ({ cdpUrl }) => ({
      ok: false,
      cdpUrl,
      versionUrl: `${cdpUrl}/json/version`,
      checkedAt: new Date().toISOString(),
      elapsedMs: 1,
      webSocketDebuggerUrl: null,
      error: 'GET timed out',
    }),
  });

  await assert.rejects(
    () => restartSharedBrowserUsingAdapter(),
    /restart adapter is not configured for this deployment/i,
  );
});

test('restartSharedBrowserUsingAdapter delegates to the explicit adapter override', async () => {
  let verifyReadyCalls = 0;
  let seenPreviousWebSocketDebuggerUrl: string | null | undefined;

  sharedBrowserTestOnly.setLifecycleOverrides({
    probeSharedBrowserVersion: async ({ cdpUrl }) => ({
      ok: true,
      cdpUrl,
      versionUrl: `${cdpUrl}/json/version`,
      checkedAt: new Date().toISOString(),
      elapsedMs: 1,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/original',
      error: null,
    }),
  });
  restartAdapterTestOnly.setRestartAdapterOverrides({
    restartSharedBrowser: async ({ previousWebSocketDebuggerUrl, verifyReady }) => {
      seenPreviousWebSocketDebuggerUrl = previousWebSocketDebuggerUrl;
      await verifyReady?.();
    },
  });

  await restartSharedBrowserUsingAdapter({
    verifyReady: async () => {
      verifyReadyCalls += 1;
    },
  });

  assert.strictEqual(seenPreviousWebSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/browser/original');
  assert.strictEqual(verifyReadyCalls, 1);
});

test('restartSharedBrowserUsingAdapter falls back to restarting the managed chrome service when ownership identifies it', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-shared-browser-systemctl-'));
  const logPath = path.join(tempDir, 'systemctl.log');
  const systemctlPath = path.join(tempDir, 'systemctl');
  const originalPath = process.env.PATH || '';

  await fs.promises.writeFile(systemctlPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${logPath}"`,
    'exit 0',
  ].join('\n'));
  await fs.promises.chmod(systemctlPath, 0o755);
  process.env.PATH = `${tempDir}:${originalPath}`;

  try {
    let probeCalls = 0;
    let verifyReadyCalls = 0;

    sharedBrowserTestOnly.setLifecycleOverrides({
      probeSharedBrowserVersion: async ({ cdpUrl }) => {
        probeCalls += 1;
        return {
          ok: true,
          cdpUrl,
          versionUrl: `${cdpUrl}/json/version`,
          checkedAt: new Date().toISOString(),
          elapsedMs: 1,
          webSocketDebuggerUrl: probeCalls >= 2
            ? 'ws://127.0.0.1:9222/devtools/browser/restarted'
            : 'ws://127.0.0.1:9222/devtools/browser/original',
          ownership: {
            serviceName: 'chrome-browse.service',
            serviceActive: true,
            pid: 123,
            expectedProfileDir: DEFAULT_PROFILE_DIR,
            profileDir: DEFAULT_PROFILE_DIR,
            profileMatchesExpected: true,
            expectedDisplay: ':0',
            display: ':0',
            displaySocketPath: '/tmp/.X11-unix/X0',
            displaySocketPresent: true,
            dbusSessionBusAddress: null,
            dbusSocketPath: null,
            dbusSocketPresent: true,
            xdgRuntimeDir: '/run/user/0',
            xdgRuntimeDirPresent: true,
            desktopSessionLikely: true,
            headless: false,
            keyringDir: DEFAULT_KEYRING_DIR,
            keyringPresent: true,
          },
          error: null,
        };
      },
      probeSharedBrowserSession: async ({ cdpUrl }) => ({
        ok: true,
        cdpUrl,
        checkedAt: new Date().toISOString(),
        elapsedMs: 1,
        probeUrl: 'data:text/html,probe',
        error: null,
      }),
    });

    await restartSharedBrowserUsingAdapter({
      verifyReady: async () => {
        verifyReadyCalls += 1;
      },
    });

    const loggedCommand = await fs.promises.readFile(logPath, 'utf8');
    assert.match(loggedCommand, /^restart chrome-browse\.service/m);
    assert.strictEqual(verifyReadyCalls, 1);
  } finally {
    process.env.PATH = originalPath;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
