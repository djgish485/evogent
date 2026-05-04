import assert from 'node:assert';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { chromium } from 'playwright';
import { __testOnly as restartAdapterTestOnly } from './shared-browser-restart-adapter';
import { __testOnly, getSharedBrowserCdpUrl, probeSharedBrowserSourcePage, probeSharedBrowserTwitterAuth, probeSharedBrowserYouTubeAuth } from './shared-browser';

const DEFAULT_PROFILE_DIR = path.join(process.cwd(), 'data', 'chrome-browse-profile');
const DEFAULT_KEYRING_DIR = '/root/.local/share/keyrings';

afterEach(() => {
  mock.restoreAll();
  delete process.env.MEDIA_AGENT_SHARED_BROWSER_CDP_URL;
  delete process.env.SHARED_BROWSER_CDP_URL;
  __testOnly.resetLifecycleOverrides();
  restartAdapterTestOnly.resetRestartAdapterOverrides();
});

test('probeSharedBrowserYouTubeAuth navigates a fresh attached page to subscriptions and verifies the rendered result', async () => {
  let freshUrl = 'about:blank';
  let freshCloseCalls = 0;
  let freshGotoCalls = 0;
  let newPageCalls = 0;
  let browserCloseCalls = 0;

  const existingPage = {
    isClosed: () => false,
    url: () => 'https://www.youtube.com/feed/subscriptions',
  };

  const freshPage = {
    url: () => freshUrl,
    async goto(url: string) {
      freshGotoCalls += 1;
      freshUrl = url;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    async evaluate<T>(pageFunction: () => T) {
      const source = pageFunction.toString();
      if (source.includes('pendingIndicators')) {
        return {
          currentUrl: freshUrl,
          pageTitle: 'Subscriptions',
          bodyText: '',
          itemCount: 4,
          readyState: 'complete',
          shellReady: true,
          pendingIndicators: 0,
        };
      }
      if (source.includes('window.scrollBy')) {
        return undefined;
      }
      return null;
    },
    async close() {
      freshCloseCalls += 1;
    },
  };

  const context = {
    pages() {
      return [existingPage];
    },
    async newPage() {
      newPageCalls += 1;
      return freshPage;
    },
  };

  const browser = {
    contexts() {
      return [context];
    },
    async close() {
      browserCloseCalls += 1;
    },
  };

  mock.method(chromium, 'connectOverCDP', async () => browser as never);

  const result = await probeSharedBrowserYouTubeAuth({
    cdpUrl: 'http://localhost:9222',
    timeoutMs: 50,
  });

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.currentUrl, 'https://www.youtube.com/feed/subscriptions');
  assert.strictEqual(result.videoLinkCount, 4);
  assert.ok(result.webSocketDebuggerUrl === null || typeof result.webSocketDebuggerUrl === 'string');
  assert.ok(result.browserUserAgent === null || typeof result.browserUserAgent === 'string');
  assert.strictEqual(newPageCalls, 1);
  assert.strictEqual(freshGotoCalls, 1);
  assert.strictEqual(freshCloseCalls, 1);
  assert.strictEqual(browserCloseCalls, 1);
});

test('probeSharedBrowserSourcePage navigates the target URL before classifying the rendered page', async () => {
  let freshGotoCalls = 0;
  let readinessCalls = 0;
  let waitCalls = 0;

  const freshPage = {
    url: () => 'https://www.youtube.com/feed/subscriptions',
    async goto() {
      freshGotoCalls += 1;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      waitCalls += 1;
      return undefined;
    },
    async title() {
      return 'Subscriptions';
    },
    async evaluate<T, TArg>(pageFunction: (arg?: TArg) => T, _arg?: TArg) {
      void _arg;
      const source = pageFunction.toString();
      if (source.includes('pendingIndicators')) {
        readinessCalls += 1;
        return {
          currentUrl: 'https://www.youtube.com/feed/subscriptions',
          pageTitle: 'Subscriptions',
          bodyText: '',
          itemCount: readinessCalls >= 2 ? 3 : 0,
          readyState: 'complete',
          shellReady: true,
          pendingIndicators: readinessCalls >= 2 ? 0 : 1,
        };
      }
      if (source.includes('window.scrollBy')) {
        return undefined;
      }
      if (source.includes('document.body?.innerText')) {
        return '';
      }
      if (source.includes('querySelectorAll(selector)')) {
        return 3;
      }
      return null;
    },
    getByRole() {
      return {
        first() {
          return {
            async count() {
              return 0;
            },
          };
        },
      };
    },
    async close() {
      return undefined;
    },
  };

  const context = {
    pages() {
      return [];
    },
    async newPage() {
      return freshPage;
    },
  };

  const browser = {
    contexts() {
      return [context];
    },
    async close() {
      return undefined;
    },
  };

  mock.method(chromium, 'connectOverCDP', async () => browser as never);

  const result = await probeSharedBrowserSourcePage({
    source: 'youtube',
    cdpUrl: 'http://localhost:9222',
    timeoutMs: 200,
  });

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.itemCount, 3);
  assert.strictEqual(result.blockingState, 'none');
  assert.match(result.visibleMarkers.join(' | '), /items:3/);
  assert.strictEqual(freshGotoCalls, 1);
  assert.ok(readinessCalls >= 2);
  assert.ok(waitCalls >= 1);
});

test('probeSharedBrowserSourcePage treats a visible signed-in X home timeline as success before generic consent text', async () => {
  const freshPage = {
    url: () => 'https://x.com/home',
    async goto() {
      return undefined;
    },
    async waitForLoadState() {
      return undefined;
    },
    async title() {
      return 'Home / X';
    },
    async evaluate<T, TArg>(pageFunction: (arg?: TArg) => T, _arg?: TArg) {
      void _arg;
      const source = pageFunction.toString();
      if (source.includes('document.body?.innerText')) {
        return 'Home timeline\nPrivacy Policy\nCookie Policy';
      }
      if (source.includes('querySelectorAll(selector)')) {
        return 4;
      }
      if (source.includes('profileLinkSelector')) {
        return {
          profileHref: '/tester',
          markers: ['title:Home / X', 'profile_link:/tester', 'primary_column', 'selected_tab:For you'],
        };
      }
      return null;
    },
    async close() {
      return undefined;
    },
  };

  const context = {
    pages() {
      return [];
    },
    async newPage() {
      return freshPage;
    },
  };

  const browser = {
    contexts() {
      return [context];
    },
    async close() {
      return undefined;
    },
  };

  mock.method(chromium, 'connectOverCDP', async () => browser as never);

  const result = await probeSharedBrowserSourcePage({
    source: 'twitter',
    cdpUrl: 'http://localhost:9222',
    timeoutMs: 200,
  });

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.blockingState, 'none');
  assert.strictEqual(result.itemCount, 4);
  assert.match(result.visibleMarkers.join(' | '), /profile_link:\/tester/);
});

test('probeSharedBrowserYouTubeAuth treats an empty subscriptions shell as unavailable without text classification', async () => {
  const existingPage = {
    isClosed: () => false,
    url: () => 'https://www.youtube.com/feed/subscriptions',
    async goto() {
      return undefined;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    async evaluate<T>(pageFunction: () => T) {
      const source = pageFunction.toString();
      if (source.includes('pendingIndicators')) {
        return {
          currentUrl: 'https://www.youtube.com/feed/subscriptions',
          pageTitle: 'Subscriptions - YouTube',
          bodyText: 'Don’t miss new videos\nSign in to see updates from your favorite YouTube channels',
          itemCount: 0,
          readyState: 'complete',
          shellReady: true,
          pendingIndicators: 0,
        };
      }
      if (source.includes('window.scrollBy')) {
        return undefined;
      }
      return null;
    },
    async close() {
      return undefined;
    },
  };

  const context = {
    pages() {
      return [existingPage];
    },
    async newPage() {
      return existingPage;
    },
  };

  const browser = {
    contexts() {
      return [context];
    },
    async close() {
      return undefined;
    },
  };

  mock.method(chromium, 'connectOverCDP', async () => browser as never);

  const result = await probeSharedBrowserYouTubeAuth({
    cdpUrl: 'http://localhost:9222',
    timeoutMs: 200,
  });

  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.failureKind, 'provider');
  assert.match(String(result.error), /no cacheable video links/i);
});

test('probeSharedBrowserTwitterAuth navigates a fresh attached page to X home and reads the rendered identity', async () => {
  let currentUrl = 'about:blank';
  let freshCloseCalls = 0;
  let freshGotoCalls = 0;
  let newPageCalls = 0;

  const existingPage = {
    isClosed: () => false,
    url: () => 'https://x.com/home',
  };

  const freshPage = {
    url: () => currentUrl,
    async goto(url: string) {
      freshGotoCalls += 1;
      currentUrl = url;
    },
    async waitForLoadState() {
      return undefined;
    },
    locator() {
      return {
        first() {
          return {
            async waitFor() {
              return undefined;
            },
            async getAttribute() {
              return '/tester';
            },
          };
        },
      };
    },
    async close() {
      freshCloseCalls += 1;
    },
  };

  const context = {
    pages() {
      return [existingPage];
    },
    async newPage() {
      newPageCalls += 1;
      return freshPage;
    },
  };

  const browser = {
    contexts() {
      return [context];
    },
    async close() {
      return undefined;
    },
  };

  mock.method(chromium, 'connectOverCDP', async () => browser as never);

  const result = await probeSharedBrowserTwitterAuth({
    cdpUrl: 'http://localhost:9222',
    timeoutMs: 50,
  });

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.screenName, 'tester');
  assert.strictEqual(newPageCalls, 1);
  assert.strictEqual(freshGotoCalls, 1);
  assert.strictEqual(freshCloseCalls, 1);
});

test('getSharedBrowserCdpUrl normalizes loopback hosts to IPv4 and falls back to the explicit IPv4 endpoint', () => {
  assert.strictEqual(getSharedBrowserCdpUrl('http://[::1]:9555'), 'http://127.0.0.1:9555');
  assert.strictEqual(getSharedBrowserCdpUrl('http://localhost:9666'), 'http://127.0.0.1:9666');

  process.env.SHARED_BROWSER_CDP_URL = 'http://[::1]:9333';
  assert.strictEqual(getSharedBrowserCdpUrl(), 'http://127.0.0.1:9333');

  process.env.MEDIA_AGENT_SHARED_BROWSER_CDP_URL = 'http://localhost:9444';
  assert.strictEqual(getSharedBrowserCdpUrl(), 'http://127.0.0.1:9444');

  delete process.env.MEDIA_AGENT_SHARED_BROWSER_CDP_URL;
  delete process.env.SHARED_BROWSER_CDP_URL;
  assert.strictEqual(getSharedBrowserCdpUrl(), 'http://127.0.0.1:9222');
});

test('ensureSharedBrowserReady treats successful rendered-page verification as authoritative readiness', async () => {
  let verifyReadyCalls = 0;

  __testOnly.setLifecycleOverrides({
    probeSharedBrowserVersion: async ({ cdpUrl }) => ({
      ok: true,
      cdpUrl,
      versionUrl: `${cdpUrl}/json/version`,
      checkedAt: new Date().toISOString(),
      elapsedMs: 1,
      browserVersion: 'Chrome/136.0.0.0',
      browserUserAgent: 'Desktop Chrome',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/healthy',
      ownership: {
        serviceName: 'chrome-browse.service',
        serviceActive: true,
        pid: null,
        expectedProfileDir: DEFAULT_PROFILE_DIR,
        profileDir: DEFAULT_PROFILE_DIR,
        profileMatchesExpected: true,
        expectedDisplay: ':0',
        display: null,
        displaySocketPath: '/tmp/.X11-unix/X0',
        displaySocketPresent: false,
        dbusSessionBusAddress: null,
        dbusSocketPath: null,
        dbusSocketPresent: false,
        xdgRuntimeDir: null,
        xdgRuntimeDirPresent: false,
        desktopSessionLikely: false,
        headless: false,
        keyringDir: DEFAULT_KEYRING_DIR,
        keyringPresent: true,
      },
      error: null,
    }),
    probeSharedBrowserSession: async ({ cdpUrl }) => ({
      ok: true,
      cdpUrl,
      checkedAt: new Date().toISOString(),
      elapsedMs: 1,
      probeUrl: 'data:text/html,ok',
      browserVersion: 'Chrome/136.0.0.0',
      browserUserAgent: 'Desktop Chrome',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/healthy',
      ownership: {
        serviceName: 'chrome-browse.service',
        serviceActive: true,
        pid: null,
        expectedProfileDir: DEFAULT_PROFILE_DIR,
        profileDir: DEFAULT_PROFILE_DIR,
        profileMatchesExpected: true,
        expectedDisplay: ':0',
        display: null,
        displaySocketPath: '/tmp/.X11-unix/X0',
        displaySocketPresent: false,
        dbusSessionBusAddress: null,
        dbusSocketPath: null,
        dbusSocketPresent: false,
        xdgRuntimeDir: null,
        xdgRuntimeDirPresent: false,
        desktopSessionLikely: false,
        headless: false,
        keyringDir: DEFAULT_KEYRING_DIR,
        keyringPresent: true,
      },
      error: null,
    }),
  });

  const result = await __testOnly.ensureSharedBrowserReady({
    verifyReady: async () => {
      verifyReadyCalls += 1;
    },
  });

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.error, null);
  assert.deepStrictEqual(result.diagnostics, [
    `no managed Chrome process is attached to ${DEFAULT_PROFILE_DIR}`,
    'desktop display/session bus ownership is missing',
  ]);
  assert.strictEqual(verifyReadyCalls, 1);
});

test('ensureSharedBrowserReady keeps ownership failures as diagnostics when rendered-page verification fails', async () => {
  __testOnly.setLifecycleOverrides({
    probeSharedBrowserVersion: async ({ cdpUrl }) => ({
      ok: true,
      cdpUrl,
      versionUrl: `${cdpUrl}/json/version`,
      checkedAt: new Date().toISOString(),
      elapsedMs: 1,
      browserVersion: 'Chrome/136.0.0.0',
      browserUserAgent: 'Desktop Chrome',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/healthy',
      ownership: {
        serviceName: 'chrome-browse.service',
        serviceActive: true,
        pid: null,
        expectedProfileDir: DEFAULT_PROFILE_DIR,
        profileDir: DEFAULT_PROFILE_DIR,
        profileMatchesExpected: true,
        expectedDisplay: ':0',
        display: null,
        displaySocketPath: '/tmp/.X11-unix/X0',
        displaySocketPresent: false,
        dbusSessionBusAddress: null,
        dbusSocketPath: null,
        dbusSocketPresent: false,
        xdgRuntimeDir: null,
        xdgRuntimeDirPresent: false,
        desktopSessionLikely: false,
        headless: false,
        keyringDir: DEFAULT_KEYRING_DIR,
        keyringPresent: true,
      },
      error: null,
    }),
    probeSharedBrowserSession: async ({ cdpUrl }) => ({
      ok: true,
      cdpUrl,
      checkedAt: new Date().toISOString(),
      elapsedMs: 1,
      probeUrl: 'data:text/html,ok',
      browserVersion: 'Chrome/136.0.0.0',
      browserUserAgent: 'Desktop Chrome',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/healthy',
      error: null,
    }),
  });

  const result = await __testOnly.ensureSharedBrowserReady({
    verifyReady: async () => {
      throw new Error('Shared browser CDP unhealthy at http://127.0.0.1:9222/json/version: YouTube subscriptions page exposed no cacheable video links');
    },
  });

  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.deepStrictEqual(result.diagnostics, [
    `no managed Chrome process is attached to ${DEFAULT_PROFILE_DIR}`,
    'desktop display/session bus ownership is missing',
  ]);
  assert.match(String(result.error), /ownership diagnostics: no managed chrome process is attached/i);
  assert.match(String(result.error), /desktop display\/session bus ownership is missing/i);
});

test('ensureSharedBrowserReady restarts and retries once on shared provider failures', async () => {
  let sessionProbeCalls = 0;
  let verifyReadyCalls = 0;
  let restartCalls = 0;

  __testOnly.setLifecycleOverrides({
    probeSharedBrowserVersion: async ({ cdpUrl }) => ({
      ok: true,
      cdpUrl,
      versionUrl: `${cdpUrl}/json/version`,
      checkedAt: new Date().toISOString(),
      elapsedMs: 1,
      browserVersion: 'Chrome/136.0.0.0',
      browserUserAgent: 'Desktop Chrome',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/healthy',
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
    }),
    probeSharedBrowserSession: async ({ cdpUrl }) => {
      sessionProbeCalls += 1;
      if (sessionProbeCalls === 1) {
        return {
          ok: false,
          cdpUrl,
          checkedAt: new Date().toISOString(),
          elapsedMs: 1_500,
          probeUrl: 'data:text/html,probe',
          error: 'browserType.connectOverCDP timed out after 1500ms',
        };
      }

      return {
        ok: true,
        cdpUrl,
        checkedAt: new Date().toISOString(),
        elapsedMs: 1,
        probeUrl: 'data:text/html,probe',
        error: null,
      };
    },
  });
  restartAdapterTestOnly.setRestartAdapterOverrides({
    restartSharedBrowser: async ({ verifyReady }) => {
      restartCalls += 1;
      await verifyReady?.();
    },
  });

  const result = await __testOnly.ensureSharedBrowserReady({
    verifyReady: async () => {
      verifyReadyCalls += 1;
    },
  });

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.error, null);
  assert.strictEqual(restartCalls, 1);
  assert.strictEqual(sessionProbeCalls, 2);
  assert.strictEqual(verifyReadyCalls, 1);
});
