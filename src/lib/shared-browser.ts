import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import * as sharedBrowserConfig from '../../lib/shared-browser-config.js';

export const DEFAULT_SHARED_BROWSER_CDP_URL = sharedBrowserConfig.DEFAULT_SHARED_BROWSER_CDP_URL;
const DEFAULT_SHARED_BROWSER_PROFILE_DIR = process.env.CHROME_BROWSE_PROFILE_DIR
  || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'chrome-browse-profile');
const LEGACY_SHARED_BROWSER_PROFILE_DIR = process.env.CHROME_BROWSE_PROFILE_DIR_LEGACY || '/root/.config/chrome-twitter-profile/';
const DEFAULT_SHARED_BROWSER_SERVICE_NAME = 'chrome-browse.service';
const DEFAULT_SHARED_BROWSER_DISPLAY = ':0';
const DEFAULT_SHARED_BROWSER_KEYRING_DIR = process.env.KEYRING_DIR || '/root/.local/share/keyrings';
const SHARED_BROWSER_VERSION_TIMEOUT_MS = 5_000;
const SHARED_BROWSER_SESSION_TIMEOUT_MS = 5_000;
const SHARED_BROWSER_X_AUTH_TIMEOUT_MS = 5_000;
const SHARED_BROWSER_YOUTUBE_AUTH_TIMEOUT_MS = 5_000;
const SHARED_BROWSER_PAGE_PROBE_TIMEOUT_MS = 8_000;
const SHARED_BROWSER_YOUTUBE_CONTENT_SETTLE_INTERVAL_MS = 500;
const SHARED_BROWSER_YOUTUBE_CONTENT_STABILITY_MS = 1_000;
const SHARED_BROWSER_SESSION_PROBE_URL = 'data:text/html;charset=utf-8,<html><head><title>evogent-shared-browser-probe</title></head><body data-shared-browser-probe="ok">shared-browser-probe</body></html>';
const SHARED_BROWSER_X_HOME_URL = 'https://x.com/home';
const SHARED_BROWSER_X_PROFILE_LINK_SELECTOR = '[data-testid="AppTabBar_Profile_Link"]';
const SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL = 'https://www.youtube.com/feed/subscriptions';
const SHARED_BROWSER_SUBSTACK_HOME_URL = 'https://substack.com/home';

export interface SharedBrowserProbeResult {
  ok: boolean;
  cdpUrl: string;
  versionUrl: string;
  checkedAt: string;
  elapsedMs: number;
  browserVersion?: string | null;
  browserUserAgent?: string | null;
  webSocketDebuggerUrl: string | null;
  ownership?: SharedBrowserOwnershipEvidence;
  error: string | null;
}

export interface SharedBrowserSessionProbeResult {
  ok: boolean;
  cdpUrl: string;
  checkedAt: string;
  elapsedMs: number;
  probeUrl: string;
  browserVersion?: string | null;
  browserUserAgent?: string | null;
  webSocketDebuggerUrl?: string | null;
  ownership?: SharedBrowserOwnershipEvidence;
  error: string | null;
}

export interface SharedBrowserTwitterAuthProbeResult {
  ok: boolean;
  cdpUrl: string;
  checkedAt: string;
  elapsedMs: number;
  homeUrl: string;
  currentUrl: string | null;
  profileUrl: string | null;
  screenName: string | null;
  browserVersion?: string | null;
  browserUserAgent?: string | null;
  webSocketDebuggerUrl?: string | null;
  ownership?: SharedBrowserOwnershipEvidence;
  failureKind: 'none' | 'auth' | 'provider';
  error: string | null;
}

export interface SharedBrowserYouTubeAuthProbeResult {
  ok: boolean;
  cdpUrl: string;
  checkedAt: string;
  elapsedMs: number;
  subscriptionsUrl: string;
  currentUrl: string | null;
  pageTitle: string | null;
  videoLinkCount: number;
  browserVersion?: string | null;
  browserUserAgent?: string | null;
  webSocketDebuggerUrl?: string | null;
  ownership?: SharedBrowserOwnershipEvidence;
  failureKind: 'none' | 'auth' | 'provider';
  error: string | null;
}

export type SharedBrowserPageProbeSource = 'twitter' | 'youtube' | 'substack';
export type SharedBrowserPageBlockingState =
  | 'none'
  | 'consent_wall'
  | 'signed_out'
  | 'age_gate'
  | 'interstitial'
  | 'empty'
  | 'provider';

export interface SharedBrowserSourcePageProbeResult {
  ok: boolean;
  source: SharedBrowserPageProbeSource;
  cdpUrl: string;
  checkedAt: string;
  elapsedMs: number;
  targetUrl: string;
  currentUrl: string | null;
  pageTitle: string | null;
  visibleText: string;
  itemCount: number;
  visibleMarkers: string[];
  consoleErrors: string[];
  blockingState: SharedBrowserPageBlockingState;
  attemptedRecovery: boolean;
  recovered: boolean;
  recoveryAction: string | null;
  browserVersion?: string | null;
  browserUserAgent?: string | null;
  webSocketDebuggerUrl?: string | null;
  ownership?: SharedBrowserOwnershipEvidence;
  error: string | null;
}

interface ManagedChromeProcess {
  argv: string[];
  pid: number;
}

export interface SharedBrowserOwnershipEvidence {
  serviceName: string | null;
  serviceActive: boolean | null;
  pid: number | null;
  expectedProfileDir: string;
  profileDir: string | null;
  profileMatchesExpected: boolean | null;
  expectedDisplay: string;
  display: string | null;
  displaySocketPath: string | null;
  displaySocketPresent: boolean;
  dbusSessionBusAddress: string | null;
  dbusSocketPath: string | null;
  dbusSocketPresent: boolean;
  xdgRuntimeDir: string | null;
  xdgRuntimeDirPresent: boolean;
  desktopSessionLikely: boolean;
  headless: boolean | null;
  keyringDir: string;
  keyringPresent: boolean;
}

export type SharedBrowserLifecycleOverrides = {
  probeSharedBrowserVersion?: (input: { cdpUrl: string; timeoutMs: number }) => Promise<SharedBrowserProbeResult>;
  probeSharedBrowserSession?: (input: { cdpUrl: string; timeoutMs: number }) => Promise<SharedBrowserSessionProbeResult>;
  probeSharedBrowserTwitterAuth?: (input: { cdpUrl: string; timeoutMs: number }) => Promise<SharedBrowserTwitterAuthProbeResult>;
  probeSharedBrowserYouTubeAuth?: (input: { cdpUrl: string; timeoutMs: number }) => Promise<SharedBrowserYouTubeAuthProbeResult>;
  probeSharedBrowserSourcePage?: (input: {
    cdpUrl: string;
    timeoutMs: number;
    source: SharedBrowserPageProbeSource;
    allowRecovery: boolean;
  }) => Promise<SharedBrowserSourcePageProbeResult>;
  probeSharedBrowserOwnership?: (input: { cdpUrl: string; profileDir: string }) => Promise<SharedBrowserOwnershipEvidence>;
};

let profileMigrationChecked = false;
let lifecycleOverrides: SharedBrowserLifecycleOverrides | null = null;

function compactErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return 'unknown error';
}

function readEnvValue(key: string) {
  return sharedBrowserConfig.compactString(process.env[key]);
}

function buildSharedBrowserConnectionDiagnostic(input: {
  browserVersion?: string | null;
  browserUserAgent?: string | null;
  webSocketDebuggerUrl?: string | null;
  ownership?: SharedBrowserOwnershipEvidence;
}) {
  const parts = [
    input.ownership?.serviceName
      ? `service=${input.ownership.serviceName}${input.ownership.serviceActive === true ? '(active)' : input.ownership.serviceActive === false ? '(inactive)' : ''}`
      : null,
    input.ownership?.pid ? `pid=${input.ownership.pid}` : null,
    input.ownership?.profileDir ? `profile=${input.ownership.profileDir}` : null,
    input.ownership?.display ? `display=${input.ownership.display}` : null,
    input.ownership?.headless === true ? 'headless=true' : input.ownership?.headless === false ? 'headless=false' : null,
    input.ownership?.keyringPresent === false ? `keyring=missing(${input.ownership.keyringDir})` : null,
    input.webSocketDebuggerUrl ? `ws=${input.webSocketDebuggerUrl}` : null,
    input.browserUserAgent ? `ua=${input.browserUserAgent}` : null,
    input.browserVersion ? `browser=${input.browserVersion}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? ` [${parts.join('; ')}]` : '';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function getSharedBrowserCdpUrl(configuredUrl?: string | null) {
  return sharedBrowserConfig.resolveSharedBrowserCdpUrl({
    configuredUrl,
    env: process.env,
  });
}

export function getSharedBrowserCdpPort(cdpUrl = DEFAULT_SHARED_BROWSER_CDP_URL) {
  try {
    const url = new URL(getSharedBrowserCdpUrl(cdpUrl));
    const parsedPort = Number.parseInt(url.port || '', 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0) {
      return parsedPort;
    }
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 9222;
  }
}

export function getSharedBrowserProfileDir() {
  const configured = process.env.X_BROWSER_PROFILE_DIR?.trim();
  if (configured) {
    return configured;
  }

  if (!profileMigrationChecked) {
    profileMigrationChecked = true;
    if (!fs.existsSync(DEFAULT_SHARED_BROWSER_PROFILE_DIR) && fs.existsSync(LEGACY_SHARED_BROWSER_PROFILE_DIR)) {
      try {
        fs.renameSync(LEGACY_SHARED_BROWSER_PROFILE_DIR, DEFAULT_SHARED_BROWSER_PROFILE_DIR);
      } catch {
        // setup.sh handles more complex migration cases when both directories exist.
      }
    }
  }

  return DEFAULT_SHARED_BROWSER_PROFILE_DIR;
}

function getSharedBrowserServiceName() {
  const configured = readEnvValue('SHARED_BROWSER_SERVICE_NAME');
  return configured || DEFAULT_SHARED_BROWSER_SERVICE_NAME;
}

function getSharedBrowserExpectedDisplay() {
  const configured = readEnvValue('SHARED_BROWSER_DISPLAY');
  return configured || DEFAULT_SHARED_BROWSER_DISPLAY;
}

function getSharedBrowserKeyringDir() {
  const configured = readEnvValue('SHARED_BROWSER_KEYRING_DIR');
  return configured || DEFAULT_SHARED_BROWSER_KEYRING_DIR;
}

function buildSharedBrowserFailureMessage(versionUrl: string, detail: string) {
  return `Shared browser CDP unhealthy at ${versionUrl}: ${detail}`;
}

function parseChromeArgValue(argv: string[], prefix: string) {
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function getDisplaySocketPath(display: string | null | undefined) {
  const normalized = typeof display === 'string' ? display.trim() : '';
  const match = normalized.match(/^:([0-9]+)(?:\.[0-9]+)?$/);
  return match?.[1] ? `/tmp/.X11-unix/X${match[1]}` : null;
}

function getUnixSocketPathFromAddress(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const match = normalized.match(/^unix:path=(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function readManagedChromeProcessEnvironment(pid: number) {
  try {
    const raw = await fs.promises.readFile(`/proc/${pid}/environ`);
    return raw.toString('utf8').split('\0').reduce<Record<string, string>>((entries, pair) => {
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex <= 0) {
        return entries;
      }

      const key = pair.slice(0, separatorIndex);
      const value = pair.slice(separatorIndex + 1);
      if (key) {
        entries[key] = value;
      }
      return entries;
    }, {});
  } catch {
    return {};
  }
}

async function isManagedChromeServiceActive(serviceName: string) {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn('systemctl', ['is-active', '--quiet', serviceName], {
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }

      if (code === 3) {
        resolve(false);
        return;
      }

      reject(new Error(`systemctl is-active ${serviceName} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function probeSharedBrowserOwnership(input: {
  cdpUrl: string;
  profileDir?: string;
}): Promise<SharedBrowserOwnershipEvidence> {
  const profileDir = input.profileDir || getSharedBrowserProfileDir();

  if (lifecycleOverrides?.probeSharedBrowserOwnership) {
    return lifecycleOverrides.probeSharedBrowserOwnership({
      cdpUrl: input.cdpUrl,
      profileDir,
    });
  }

  const serviceName = await detectManagedChromeService({
    cdpUrl: input.cdpUrl,
    profileDir,
  });
  const serviceActive = serviceName
    ? await isManagedChromeServiceActive(serviceName).catch(() => null)
    : null;
  const processes = await listManagedChromeProcesses(input.cdpUrl).catch(() => []);
  const primaryProcess = processes.find((processInfo) => !processInfo.argv.some((arg) => arg.startsWith('--type=')))
    || processes[0]
    || null;
  const processEnv = primaryProcess ? await readManagedChromeProcessEnvironment(primaryProcess.pid) : {};
  const actualProfileDir = primaryProcess ? parseChromeArgValue(primaryProcess.argv, '--user-data-dir=') : null;
  const display = processEnv.DISPLAY?.trim() || null;
  const displaySocketPath = getDisplaySocketPath(display || getSharedBrowserExpectedDisplay());
  const dbusSessionBusAddress = processEnv.DBUS_SESSION_BUS_ADDRESS?.trim() || null;
  const dbusSocketPath = getUnixSocketPathFromAddress(dbusSessionBusAddress);
  const xdgRuntimeDir = processEnv.XDG_RUNTIME_DIR?.trim() || null;
  const keyringDir = getSharedBrowserKeyringDir();
  let keyringPresent = false;
  try {
    keyringPresent = fs.statSync(keyringDir).isDirectory() && fs.readdirSync(keyringDir).length > 0;
  } catch {
    keyringPresent = false;
  }
  const displaySocketPresent = Boolean(displaySocketPath && fs.existsSync(displaySocketPath));
  const dbusSocketPresent = Boolean(
    (dbusSocketPath && fs.existsSync(dbusSocketPath))
    || (xdgRuntimeDir && fs.existsSync(`${xdgRuntimeDir}/bus`)),
  );
  const xdgRuntimeDirPresent = Boolean(xdgRuntimeDir && fs.existsSync(xdgRuntimeDir));
  const headless = primaryProcess
    ? primaryProcess.argv.some((arg) => arg === '--headless' || arg.startsWith('--headless='))
    : null;

  return {
    serviceName,
    serviceActive,
    pid: primaryProcess?.pid ?? null,
    expectedProfileDir: profileDir,
    profileDir: actualProfileDir,
    profileMatchesExpected: actualProfileDir ? actualProfileDir === profileDir : null,
    expectedDisplay: getSharedBrowserExpectedDisplay(),
    display,
    displaySocketPath,
    displaySocketPresent,
    dbusSessionBusAddress,
    dbusSocketPath,
    dbusSocketPresent,
    xdgRuntimeDir,
    xdgRuntimeDirPresent,
    desktopSessionLikely: Boolean(display && displaySocketPresent && (dbusSocketPresent || xdgRuntimeDirPresent)),
    headless,
    keyringDir,
    keyringPresent,
  };
}

function isXLoginUrl(url: string | null | undefined) {
  const normalized = typeof url === 'string' ? url.trim() : '';
  if (!normalized) return false;
  return /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:i\/flow\/login|login)(?:\/|$|\?)/i.test(normalized);
}

function buildTwitterBrowserAuthError(message: string) {
  return `Shared browser X auth unavailable: ${message}`;
}

function isYouTubeLoginUrl(url: string | null | undefined) {
  const normalized = typeof url === 'string' ? url.trim() : '';
  if (!normalized) return false;
  return (
    /https?:\/\/accounts\.google\.com(?:\/|$|\?)/i.test(normalized)
    || /https?:\/\/(?:www\.)?youtube\.com\/(?:signin|login)(?:\/|$|\?)/i.test(normalized)
  );
}

function isYouTubeSubscriptionsUrl(url: string | null | undefined) {
  const normalized = typeof url === 'string' ? url.trim() : '';
  if (!normalized) return false;
  return /https?:\/\/(?:www\.)?youtube\.com\/feed\/subscriptions(?:\/|$|\?)/i.test(normalized);
}

function isSubstackLoginUrl(url: string | null | undefined) {
  const normalized = typeof url === 'string' ? url.trim() : '';
  if (!normalized) return false;
  return /https?:\/\/substack\.com\/(?:signin|sign-in|login)(?:\/|$|\?)/i.test(normalized);
}

function isSubstackHomeUrl(url: string | null | undefined) {
  const normalized = typeof url === 'string' ? url.trim() : '';
  if (!normalized) return false;
  return /https?:\/\/substack\.com\/home(?:\/|$|\?)/i.test(normalized);
}

function buildYouTubeBrowserAuthError(message: string) {
  return `Shared browser YouTube auth unavailable: ${message}`;
}

type SharedBrowserPageProbeConfig = {
  source: SharedBrowserPageProbeSource;
  label: string;
  targetUrl: string;
  itemSelectors: string[];
  isExpectedUrl: (url: string | null | undefined) => boolean;
  isSignedOutUrl: (url: string | null | undefined) => boolean;
};

function getSharedBrowserPageProbeConfig(source: SharedBrowserPageProbeSource): SharedBrowserPageProbeConfig {
  if (source === 'twitter') {
    return {
      source,
      label: 'X home',
      targetUrl: SHARED_BROWSER_X_HOME_URL,
      itemSelectors: ['article[data-testid="tweet"]', '[data-testid="primaryColumn"] article'],
      isExpectedUrl: (url) => /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/home(?:\/|$|\?)/i.test(url || ''),
      isSignedOutUrl: isXLoginUrl,
    };
  }

  if (source === 'youtube') {
    return {
      source,
      label: 'YouTube subscriptions',
      targetUrl: SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL,
      itemSelectors: ['a[href*="/watch?v="]', 'a[href*="/shorts/"]'],
      isExpectedUrl: isYouTubeSubscriptionsUrl,
      isSignedOutUrl: isYouTubeLoginUrl,
    };
  }

  return {
    source,
    label: 'Substack home',
    targetUrl: SHARED_BROWSER_SUBSTACK_HOME_URL,
    itemSelectors: ['article a[href*="/p/"]', 'a[href*=".substack.com/p/"]'],
    isExpectedUrl: isSubstackHomeUrl,
    isSignedOutUrl: isSubstackLoginUrl,
  };
}

export async function acquireSharedBrowserPage(
  browser: Browser,
  input: {
    cdpUrl: string;
    timeoutMs: number;
  },
) {
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error(`No Chrome context available at ${input.cdpUrl}`);
  }

  const page = await withTimeout(
    context.newPage(),
    input.timeoutMs,
    `context.newPage timed out after ${input.timeoutMs}ms`,
  );
  return {
    context,
    page,
  };
}

function buildSharedBrowserSubstrateFailures(ownership: SharedBrowserOwnershipEvidence) {
  const failures: string[] = [];

  if (!ownership.serviceName) {
    failures.push(`managed desktop Chrome service ${getSharedBrowserServiceName()} is not installed`);
  } else if (ownership.serviceActive === false) {
    failures.push(`managed desktop Chrome service ${ownership.serviceName} is inactive`);
  }

  if (ownership.pid === null) {
    failures.push(`no managed Chrome process is attached to ${ownership.expectedProfileDir}`);
  }

  if (ownership.profileMatchesExpected === false) {
    failures.push(`Chrome is using profile ${ownership.profileDir} instead of ${ownership.expectedProfileDir}`);
  }

  if (ownership.headless === true) {
    failures.push('Chrome is running headless instead of inside the desktop session');
  }

  if (!ownership.desktopSessionLikely) {
    failures.push('desktop display/session bus ownership is missing');
  }

  if (!ownership.keyringPresent) {
    failures.push(`desktop keyring files are missing at ${ownership.keyringDir}`);
  }

  return failures;
}

function appendSharedBrowserSubstrateDiagnostics(
  detail: string,
  ownership: SharedBrowserOwnershipEvidence | null | undefined,
) {
  const failures = ownership ? buildSharedBrowserSubstrateFailures(ownership) : [];
  if (failures.length === 0 || /ownership diagnostics:/i.test(detail)) {
    return detail;
  }

  return `${detail} Ownership diagnostics: ${failures.join('; ')}`;
}

function compactVisibleText(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return '';
  }

  return normalized.length > 4_000
    ? `${normalized.slice(0, 3_997)}...`
    : normalized;
}

function compactConsoleError(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!normalized) {
    return null;
  }

  return normalized.length > 500
    ? `${normalized.slice(0, 497)}...`
    : normalized;
}

async function collectTwitterProbeMarkers(page: Page, timeoutMs: number) {
  return withTimeout(
    page.evaluate((profileLinkSelector) => {
      const markers: string[] = [];
      const title = document.title?.trim() || '';
      if (title) {
        markers.push(`title:${title}`);
      }

      const profileLink = document.querySelector<HTMLAnchorElement>(profileLinkSelector);
      const profileHref = profileLink?.getAttribute('href')?.trim() || null;
      if (profileHref) {
        markers.push(`profile_link:${profileHref}`);
      }

      if (document.querySelector('[data-testid="primaryColumn"]')) {
        markers.push('primary_column');
      }

      const selectedTabLabels = Array.from(
        document.querySelectorAll('[role="tab"][aria-selected="true"], [data-testid="ScrollSnap-List"] [aria-selected="true"]'),
      )
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() || '')
        .filter(Boolean);
      for (const label of selectedTabLabels) {
        markers.push(`selected_tab:${label}`);
      }

      return {
        profileHref,
        markers,
      };
    }, SHARED_BROWSER_X_PROFILE_LINK_SELECTOR),
    timeoutMs,
    `Twitter probe markers timed out after ${timeoutMs}ms`,
  ).catch(() => ({
    profileHref: null,
    markers: [] as string[],
  }));
}

type SharedBrowserYouTubeContentSnapshot = {
  currentUrl: string | null;
  pageTitle: string | null;
  bodyText: string;
  itemCount: number;
  readyState: string | null;
  shellReady: boolean;
  pendingIndicators: number;
};

async function readYouTubeContentSnapshot(page: Page, timeoutMs: number): Promise<SharedBrowserYouTubeContentSnapshot> {
  return withTimeout(
    page.evaluate(() => {
      const itemSelectors = ['a[href*="/watch?v="]', 'a[href*="/shorts/"]'];
      const pendingSelectors = [
        'yt-page-navigation-progress[is-loading]',
        'tp-yt-paper-spinner-lite[active]',
        'ytd-continuation-item-renderer',
        'yt-content-metadata-view-model[is-loading]',
        'ytd-rich-grid-renderer[is-loading]',
      ];
      const itemCount = itemSelectors.reduce((count, selector) => (
        count + document.querySelectorAll(selector).length
      ), 0);
      const pendingIndicators = pendingSelectors.reduce((count, selector) => (
        count + document.querySelectorAll(selector).length
      ), 0);

      return {
        currentUrl: window.location.href || null,
        pageTitle: document.title || null,
        bodyText: document.body?.innerText || '',
        itemCount,
        readyState: document.readyState || null,
        shellReady: Boolean(
          document.querySelector(
            'ytd-browse[page-subtype="subscriptions"], ytd-two-column-browse-results-renderer, ytd-rich-grid-renderer, ytd-item-section-renderer, #contents',
          ),
        ),
        pendingIndicators,
      };
    }),
    timeoutMs,
    `YouTube content snapshot timed out after ${timeoutMs}ms`,
  ).catch(() => ({
    currentUrl: page.url() || null,
    pageTitle: null,
    bodyText: '',
    itemCount: 0,
    readyState: null,
    shellReady: false,
    pendingIndicators: 0,
  }));
}

async function waitForYouTubeContentReady(page: Page, timeoutMs: number) {
  const startedAt = Date.now();
  let scrolledForLazyContent = false;
  let settledWithoutContentAt: number | null = null;
  let snapshot = await readYouTubeContentSnapshot(page, timeoutMs);

  while ((Date.now() - startedAt) < timeoutMs) {
    if (snapshot.itemCount > 0) {
      return snapshot;
    }

    const stillLoading = (
      snapshot.readyState !== 'complete'
      || !snapshot.shellReady
      || snapshot.pendingIndicators > 0
    );

    if (!stillLoading && !scrolledForLazyContent) {
      scrolledForLazyContent = true;
      await page.evaluate(() => {
        window.scrollBy(0, Math.max(window.innerHeight * 1.5, 900));
        return undefined;
      }).catch(() => undefined);
      await page.waitForTimeout(750);
    } else if (!stillLoading) {
      if (settledWithoutContentAt === null) {
        settledWithoutContentAt = Date.now();
      } else if ((Date.now() - settledWithoutContentAt) >= SHARED_BROWSER_YOUTUBE_CONTENT_STABILITY_MS) {
        return snapshot;
      }
      await page.waitForTimeout(SHARED_BROWSER_YOUTUBE_CONTENT_SETTLE_INTERVAL_MS);
    } else {
      settledWithoutContentAt = null;
      await page.waitForTimeout(SHARED_BROWSER_YOUTUBE_CONTENT_SETTLE_INTERVAL_MS);
    }

    snapshot = await readYouTubeContentSnapshot(page, Math.max(1, Math.min(timeoutMs, 2_000)));
  }

  return snapshot;
}

async function prepareSharedBrowserSourcePage(input: {
  page: Page;
  config: SharedBrowserPageProbeConfig;
  timeoutMs: number;
}) {
  await withTimeout(
    input.page.goto(input.config.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: input.timeoutMs,
    }),
    input.timeoutMs,
    `page.goto(${input.config.targetUrl}) timed out after ${input.timeoutMs}ms`,
  );
  await input.page.waitForLoadState('networkidle', { timeout: input.timeoutMs }).catch(() => undefined);

  if (input.config.source === 'youtube') {
    await waitForYouTubeContentReady(input.page, input.timeoutMs);
  }
}

async function collectPageProbeState(page: Page, config: SharedBrowserPageProbeConfig, timeoutMs: number) {
  const currentUrl = page.url() || null;
  const pageTitle = await withTimeout(
    page.title(),
    timeoutMs,
    `page.title(${config.targetUrl}) timed out after ${timeoutMs}ms`,
  ).catch(() => null);
  const bodyText = await withTimeout(
    page.evaluate(() => document.body?.innerText || ''),
    timeoutMs,
    `page.evaluate(bodyText for ${config.targetUrl}) timed out after ${timeoutMs}ms`,
  ).catch(() => '') as string;
  const visibleText = compactVisibleText(bodyText);
  const itemCount = await withTimeout(
    page.evaluate((selectors) => {
      const seen = new Set<Element>();
      for (const selector of selectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          seen.add(node);
        }
      }
      return seen.size;
    }, config.itemSelectors),
    timeoutMs,
    `item count probe timed out after ${timeoutMs}ms`,
  ).catch(() => 0);
  const visibleMarkers: string[] = [];
  if (pageTitle) {
    visibleMarkers.push(`title:${pageTitle}`);
  }
  if (itemCount > 0) {
    visibleMarkers.push(`items:${itemCount}`);
  }

  let twitterProfileHref: string | null = null;
  if (config.source === 'twitter') {
    const twitterMarkers = await collectTwitterProbeMarkers(page, timeoutMs);
    twitterProfileHref = twitterMarkers.profileHref;
    for (const marker of twitterMarkers.markers) {
      if (!visibleMarkers.includes(marker)) {
        visibleMarkers.push(marker);
      }
    }
  }

  if (config.source === 'twitter' && config.isExpectedUrl(currentUrl) && (itemCount > 0 || Boolean(twitterProfileHref))) {
    return { currentUrl, pageTitle, visibleText, itemCount, visibleMarkers, blockingState: 'none' as const };
  }

  if (!config.isExpectedUrl(currentUrl)) {
    return { currentUrl, pageTitle, visibleText, itemCount, visibleMarkers, blockingState: 'interstitial' as const };
  }

  if (itemCount > 0) {
    return { currentUrl, pageTitle, visibleText, itemCount, visibleMarkers, blockingState: 'none' as const };
  }

  return { currentUrl, pageTitle, visibleText, itemCount, visibleMarkers, blockingState: 'empty' as const };
}

function buildSourcePageProbeError(
  config: SharedBrowserPageProbeConfig,
  state: SharedBrowserPageBlockingState,
  currentUrl: string | null,
  pageTitle: string | null,
  itemCount: number,
  visibleMarkers: string[],
  diagnostics: {
    browserVersion?: string | null;
    browserUserAgent?: string | null;
    webSocketDebuggerUrl?: string | null;
  },
) {
  const pageRef = currentUrl || config.targetUrl;
  const diagnosticSuffix = buildSharedBrowserConnectionDiagnostic(diagnostics);
  const markerSuffix = visibleMarkers.length > 0
    ? ` markers=${visibleMarkers.join(', ')}`
    : '';
  if (state === 'signed_out') {
    return `Shared browser ${config.label} page requires sign-in at ${pageRef}${markerSuffix}${diagnosticSuffix}`;
  }
  if (state === 'interstitial') {
    return `Shared browser ${config.label} page landed on an unexpected URL at ${pageRef}${pageTitle ? ` (${pageTitle})` : ''}${markerSuffix}${diagnosticSuffix}`;
  }
  if (state === 'empty') {
    return `Shared browser ${config.label} page returned zero cacheable items at ${pageRef}${markerSuffix}${diagnosticSuffix}`;
  }
  if (state === 'provider') {
    return `Shared browser ${config.label} page probe failed at ${pageRef}${markerSuffix}${diagnosticSuffix}`;
  }
  return itemCount > 0
    ? `Shared browser ${config.label} page exposed ${itemCount} items at ${pageRef}${markerSuffix}${diagnosticSuffix}`
    : null;
}

export function isSharedBrowserFailureText(message: string | null | undefined) {
  const normalized = typeof message === 'string' ? message.trim() : '';
  if (!normalized) return false;

  return normalized.startsWith('Shared browser CDP unhealthy at ');
}

export function isSharedBrowserTwitterAuthFailureText(message: string | null | undefined) {
  const normalized = typeof message === 'string' ? message.trim() : '';
  if (!normalized) return false;

  return (
    /shared browser x auth unavailable/i.test(normalized)
    || /chrome session is not logged into x/i.test(normalized)
    || /redirected to https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:i\/flow\/login|login)/i.test(normalized)
    || /did not expose an x profile identity/i.test(normalized)
    || /apptabbar_profile_link/i.test(normalized)
  );
}

export function isSharedBrowserYouTubeAuthFailureText(message: string | null | undefined) {
  const normalized = typeof message === 'string' ? message.trim() : '';
  if (!normalized) return false;

  return (
    /shared browser youtube auth unavailable/i.test(normalized)
    || /consent\.youtube\.com/i.test(normalized)
    || /before you continue to youtube/i.test(normalized)
    || /accounts\.google\.com/i.test(normalized)
    || /youtube.*(sign in|login required)/i.test(normalized)
  );
}

export function isSharedBrowserFailureError(error: unknown) {
  return isSharedBrowserFailureText(compactErrorMessage(error));
}

export async function probeSharedBrowserVersion(
  input: { cdpUrl?: string; timeoutMs?: number } = {},
): Promise<SharedBrowserProbeResult> {
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl);
  const timeoutMs = Math.max(1, input.timeoutMs ?? SHARED_BROWSER_VERSION_TIMEOUT_MS);
  const ownership = await probeSharedBrowserOwnership({
    cdpUrl,
    profileDir: getSharedBrowserProfileDir(),
  }).catch(() => undefined);
  const diagnosticSuffix = buildSharedBrowserConnectionDiagnostic({ ownership });

  if (lifecycleOverrides?.probeSharedBrowserVersion) {
    return lifecycleOverrides.probeSharedBrowserVersion({
      cdpUrl,
      timeoutMs,
    });
  }

  const versionUrl = new URL('/json/version', cdpUrl).toString();
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(versionUrl, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        cdpUrl,
        versionUrl,
        checkedAt,
        elapsedMs: Date.now() - startedAt,
        browserVersion: null,
        browserUserAgent: null,
        webSocketDebuggerUrl: null,
        ownership,
        error: `GET ${versionUrl} returned HTTP ${response.status}${diagnosticSuffix}`,
      };
    }

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const browserVersion = typeof payload?.Browser === 'string'
      ? payload.Browser
      : typeof payload?.browser === 'string'
        ? payload.browser
        : null;
    const browserUserAgent = typeof payload?.['User-Agent'] === 'string'
      ? payload['User-Agent']
      : typeof payload?.userAgent === 'string'
        ? payload.userAgent
        : null;
    const webSocketDebuggerUrl = typeof payload?.webSocketDebuggerUrl === 'string'
      ? payload.webSocketDebuggerUrl
      : null;

    if (!webSocketDebuggerUrl) {
      return {
        ok: false,
        cdpUrl,
        versionUrl,
        checkedAt,
        elapsedMs: Date.now() - startedAt,
        browserVersion,
        browserUserAgent,
        webSocketDebuggerUrl: null,
        ownership,
        error: `GET ${versionUrl} returned no webSocketDebuggerUrl${diagnosticSuffix}`,
      };
    }

    return {
      ok: true,
      cdpUrl,
      versionUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      browserVersion,
      browserUserAgent,
      webSocketDebuggerUrl,
      ownership,
      error: null,
    };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      cdpUrl,
      versionUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      browserVersion: null,
      browserUserAgent: null,
      webSocketDebuggerUrl: null,
      ownership,
      error: isAbort
        ? `GET ${versionUrl} timed out after ${timeoutMs}ms${diagnosticSuffix}`
        : `GET ${versionUrl} failed: ${compactErrorMessage(error)}${diagnosticSuffix}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeSharedBrowserSession(
  input: { cdpUrl?: string; timeoutMs?: number } = {},
): Promise<SharedBrowserSessionProbeResult> {
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl);
  const timeoutMs = Math.max(1, input.timeoutMs ?? SHARED_BROWSER_SESSION_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  if (lifecycleOverrides?.probeSharedBrowserSession) {
    return lifecycleOverrides.probeSharedBrowserSession({
      cdpUrl,
      timeoutMs,
    });
  }

  let browser: Browser | null = null;
  let page: Page | null = null;
  const versionProbe = await probeSharedBrowserVersion({
    cdpUrl,
    timeoutMs,
  }).catch(() => null);

  try {
    browser = await withTimeout(
      chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs }),
      timeoutMs,
      `browserType.connectOverCDP timed out after ${timeoutMs}ms`,
    );

    const acquiredPage = await acquireSharedBrowserPage(browser, {
      cdpUrl,
      timeoutMs,
    });
    page = acquiredPage.page;

    await withTimeout(
      page.goto(SHARED_BROWSER_SESSION_PROBE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      }),
      timeoutMs,
      `page.goto(shared-browser-probe) timed out after ${timeoutMs}ms`,
    );

    const probeMarker = await withTimeout(
      page.evaluate(() => {
        return document.body?.getAttribute('data-shared-browser-probe') || null;
      }),
      timeoutMs,
      `page.evaluate(shared-browser-probe) timed out after ${timeoutMs}ms`,
    );
    const probeUrl = SHARED_BROWSER_SESSION_PROBE_URL;

    if (probeMarker !== 'ok') {
      throw new Error(`shared-browser session probe did not observe a ready document on ${probeUrl || SHARED_BROWSER_SESSION_PROBE_URL}`);
    }

    return {
      ok: true,
      cdpUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      probeUrl: probeUrl || SHARED_BROWSER_SESSION_PROBE_URL,
      browserVersion: versionProbe?.browserVersion || null,
      browserUserAgent: versionProbe?.browserUserAgent || null,
      webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
      ownership: versionProbe?.ownership,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      cdpUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      probeUrl: SHARED_BROWSER_SESSION_PROBE_URL,
      browserVersion: versionProbe?.browserVersion || null,
      browserUserAgent: versionProbe?.browserUserAgent || null,
      webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
      ownership: versionProbe?.ownership,
      error: `${compactErrorMessage(error)}${buildSharedBrowserConnectionDiagnostic(versionProbe || {})}`,
    };
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export async function probeSharedBrowserTwitterAuth(
  input: { cdpUrl?: string; timeoutMs?: number } = {},
): Promise<SharedBrowserTwitterAuthProbeResult> {
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl);
  const timeoutMs = Math.max(1, input.timeoutMs ?? SHARED_BROWSER_X_AUTH_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  if (lifecycleOverrides?.probeSharedBrowserTwitterAuth) {
    return lifecycleOverrides.probeSharedBrowserTwitterAuth({
      cdpUrl,
      timeoutMs,
    });
  }

  let browser: Browser | null = null;
  let page: Page | null = null;
  const versionProbe = await probeSharedBrowserVersion({
    cdpUrl,
    timeoutMs,
  }).catch(() => null);
  const diagnosticSuffix = buildSharedBrowserConnectionDiagnostic(versionProbe || {});

  try {
    browser = await withTimeout(
      chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs }),
      timeoutMs,
      `browserType.connectOverCDP timed out after ${timeoutMs}ms`,
    );

    const acquiredPage = await acquireSharedBrowserPage(browser, {
      cdpUrl,
      timeoutMs,
    });
    page = acquiredPage.page;

    await withTimeout(
      page.goto(SHARED_BROWSER_X_HOME_URL, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      }),
      timeoutMs,
      `page.goto(${SHARED_BROWSER_X_HOME_URL}) timed out after ${timeoutMs}ms`,
    );

    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);

    const currentUrl = page.url();
    if (isXLoginUrl(currentUrl)) {
      return {
        ok: false,
        cdpUrl,
        checkedAt,
        elapsedMs: Date.now() - startedAt,
        homeUrl: SHARED_BROWSER_X_HOME_URL,
        currentUrl,
        profileUrl: null,
        screenName: null,
        browserVersion: versionProbe?.browserVersion || null,
        browserUserAgent: versionProbe?.browserUserAgent || null,
        webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
        ownership: versionProbe?.ownership,
        failureKind: 'auth',
        error: buildTwitterBrowserAuthError(`Chrome session is not logged into X and was redirected to ${currentUrl}${diagnosticSuffix}`),
      };
    }

    const profileLink = page.locator(SHARED_BROWSER_X_PROFILE_LINK_SELECTOR).first();
    await withTimeout(
      profileLink.waitFor({ state: 'attached', timeout: timeoutMs }),
      timeoutMs,
      `${SHARED_BROWSER_X_PROFILE_LINK_SELECTOR} did not appear within ${timeoutMs}ms`,
    );

    const href = await withTimeout(
      profileLink.getAttribute('href'),
      timeoutMs,
      `${SHARED_BROWSER_X_PROFILE_LINK_SELECTOR} href lookup timed out after ${timeoutMs}ms`,
    );
    const screenName = href?.match(/^\/([^/?#]+)$/)?.[1] || null;
    if (!screenName) {
      return {
        ok: false,
        cdpUrl,
        checkedAt,
        elapsedMs: Date.now() - startedAt,
        homeUrl: SHARED_BROWSER_X_HOME_URL,
        currentUrl,
        profileUrl: null,
        screenName: null,
        browserVersion: versionProbe?.browserVersion || null,
        browserUserAgent: versionProbe?.browserUserAgent || null,
        webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
        ownership: versionProbe?.ownership,
        failureKind: 'auth',
        error: buildTwitterBrowserAuthError(`Chrome session did not expose an X profile identity on ${currentUrl || SHARED_BROWSER_X_HOME_URL}${diagnosticSuffix}`),
      };
    }

    return {
      ok: true,
      cdpUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      homeUrl: SHARED_BROWSER_X_HOME_URL,
      currentUrl,
      profileUrl: `https://x.com/${screenName}`,
      screenName,
      browserVersion: versionProbe?.browserVersion || null,
      browserUserAgent: versionProbe?.browserUserAgent || null,
      webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
      ownership: versionProbe?.ownership,
      failureKind: 'none',
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      cdpUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      homeUrl: SHARED_BROWSER_X_HOME_URL,
      currentUrl: page?.url() || null,
      profileUrl: null,
      screenName: null,
      browserVersion: versionProbe?.browserVersion || null,
      browserUserAgent: versionProbe?.browserUserAgent || null,
      webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
      ownership: versionProbe?.ownership,
      failureKind: 'provider',
      error: `${compactErrorMessage(error)}${diagnosticSuffix}`,
    };
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export async function probeSharedBrowserYouTubeAuth(
  input: { cdpUrl?: string; timeoutMs?: number } = {},
): Promise<SharedBrowserYouTubeAuthProbeResult> {
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl);
  const timeoutMs = Math.max(1, input.timeoutMs ?? SHARED_BROWSER_YOUTUBE_AUTH_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  if (lifecycleOverrides?.probeSharedBrowserYouTubeAuth) {
    return lifecycleOverrides.probeSharedBrowserYouTubeAuth({
      cdpUrl,
      timeoutMs,
    });
  }

  let browser: Browser | null = null;
  let page: Page | null = null;
  const versionProbe = await probeSharedBrowserVersion({
    cdpUrl,
    timeoutMs,
  }).catch(() => null);
  const diagnosticSuffix = buildSharedBrowserConnectionDiagnostic(versionProbe || {});

  try {
    browser = await withTimeout(
      chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs }),
      timeoutMs,
      `browserType.connectOverCDP timed out after ${timeoutMs}ms`,
    );

    const acquiredPage = await acquireSharedBrowserPage(browser, {
      cdpUrl,
      timeoutMs,
    });
    page = acquiredPage.page;

    await withTimeout(
      page.goto(SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      }),
      timeoutMs,
      `page.goto(${SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL}) timed out after ${timeoutMs}ms`,
    );
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);

    const readinessSnapshot = await waitForYouTubeContentReady(page, timeoutMs);
    const currentUrl = readinessSnapshot.currentUrl || page.url();
    const pageTitle = readinessSnapshot.pageTitle;
    const videoLinkCount = readinessSnapshot.itemCount;

    if (isYouTubeLoginUrl(currentUrl)) {
      return {
        ok: false,
        cdpUrl,
        checkedAt,
        elapsedMs: Date.now() - startedAt,
        subscriptionsUrl: SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL,
        currentUrl,
        pageTitle,
        videoLinkCount,
        browserVersion: versionProbe?.browserVersion || null,
        browserUserAgent: versionProbe?.browserUserAgent || null,
        webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
        ownership: versionProbe?.ownership,
        failureKind: 'auth',
        error: buildYouTubeBrowserAuthError(
          `Chrome session is not logged into YouTube and was redirected to ${currentUrl}${diagnosticSuffix}`,
        ),
      };
    }

    if (!isYouTubeSubscriptionsUrl(currentUrl)) {
      return {
        ok: false,
        cdpUrl,
        checkedAt,
        elapsedMs: Date.now() - startedAt,
        subscriptionsUrl: SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL,
        currentUrl,
        pageTitle,
        videoLinkCount,
        browserVersion: versionProbe?.browserVersion || null,
        browserUserAgent: versionProbe?.browserUserAgent || null,
        webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
        ownership: versionProbe?.ownership,
        failureKind: 'provider',
        error: `Shared browser YouTube subscriptions page unavailable: expected ${SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL} but landed on ${currentUrl || 'an unknown page'}${diagnosticSuffix}`,
      };
    }

    if (videoLinkCount <= 0) {
      return {
        ok: false,
        cdpUrl,
        checkedAt,
        elapsedMs: Date.now() - startedAt,
        subscriptionsUrl: SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL,
        currentUrl,
        pageTitle,
        videoLinkCount,
        browserVersion: versionProbe?.browserVersion || null,
        browserUserAgent: versionProbe?.browserUserAgent || null,
        webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
        ownership: versionProbe?.ownership,
        failureKind: 'provider',
        error: `Shared browser YouTube subscriptions page unavailable: ${currentUrl} exposed no cacheable video links${diagnosticSuffix}`,
      };
    }

    return {
      ok: true,
      cdpUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      subscriptionsUrl: SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL,
      currentUrl,
      pageTitle,
      videoLinkCount,
      browserVersion: versionProbe?.browserVersion || null,
      browserUserAgent: versionProbe?.browserUserAgent || null,
      webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
      ownership: versionProbe?.ownership,
      failureKind: 'none',
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      cdpUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      subscriptionsUrl: SHARED_BROWSER_YOUTUBE_SUBSCRIPTIONS_URL,
      currentUrl: page?.url() || null,
      pageTitle: null,
      videoLinkCount: 0,
      browserVersion: versionProbe?.browserVersion || null,
      browserUserAgent: versionProbe?.browserUserAgent || null,
      webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
      ownership: versionProbe?.ownership,
      failureKind: 'provider',
      error: `${compactErrorMessage(error)}${diagnosticSuffix}`,
    };
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export async function probeSharedBrowserSourcePage(input: {
  source: SharedBrowserPageProbeSource;
  cdpUrl?: string;
  timeoutMs?: number;
  allowRecovery?: boolean;
}): Promise<SharedBrowserSourcePageProbeResult> {
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl);
  const timeoutMs = Math.max(1, input.timeoutMs ?? SHARED_BROWSER_PAGE_PROBE_TIMEOUT_MS);
  const allowRecovery = input.allowRecovery === true;
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const config = getSharedBrowserPageProbeConfig(input.source);

  if (lifecycleOverrides?.probeSharedBrowserSourcePage) {
    return lifecycleOverrides.probeSharedBrowserSourcePage({
      cdpUrl,
      timeoutMs,
      source: input.source,
      allowRecovery,
    });
  }

  let browser: Browser | null = null;
  let page: Page | null = null;
  const attemptedRecovery = false;
  const recoveryAction: string | null = null;
  const consoleErrors: string[] = [];
  const versionProbe = await probeSharedBrowserVersion({
    cdpUrl,
    timeoutMs,
  }).catch(() => null);

  try {
    browser = await withTimeout(
      chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs }),
      timeoutMs,
      `browserType.connectOverCDP timed out after ${timeoutMs}ms`,
    );

    const acquiredPage = await acquireSharedBrowserPage(browser, {
      cdpUrl,
      timeoutMs,
    });
    page = acquiredPage.page;
    const consoleListener = (message: { type(): string; text(): string }) => {
      if (message.type() !== 'error') {
        return;
      }
      const normalized = compactConsoleError(message.text());
      if (!normalized || consoleErrors.includes(normalized)) {
        return;
      }
      consoleErrors.push(normalized);
      if (consoleErrors.length > 12) {
        consoleErrors.shift();
      }
    };
    if (typeof (page as Page & { on?: unknown }).on === 'function') {
      page.on('console', consoleListener);
    }

    await prepareSharedBrowserSourcePage({
      page,
      config,
      timeoutMs,
    });

    const state = await collectPageProbeState(page, config, timeoutMs);
    void allowRecovery;

    return {
      ok: state.blockingState === 'none',
      source: input.source,
      cdpUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      targetUrl: config.targetUrl,
      currentUrl: state.currentUrl,
      pageTitle: state.pageTitle,
      visibleText: state.visibleText,
      itemCount: state.itemCount,
      visibleMarkers: state.visibleMarkers,
      consoleErrors: [...consoleErrors],
      blockingState: state.blockingState,
      attemptedRecovery,
      recovered: Boolean(recoveryAction) && state.blockingState === 'none',
      recoveryAction,
      browserVersion: versionProbe?.browserVersion || null,
      browserUserAgent: versionProbe?.browserUserAgent || null,
      webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
      ownership: versionProbe?.ownership,
      error: state.blockingState === 'none'
        ? null
        : buildSourcePageProbeError(
          config,
          state.blockingState,
          state.currentUrl,
          state.pageTitle,
          state.itemCount,
          state.visibleMarkers,
          versionProbe || {},
        ),
    };
  } catch (error) {
    return {
      ok: false,
      source: input.source,
      cdpUrl,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      targetUrl: config.targetUrl,
      currentUrl: page?.url() || null,
      pageTitle: null,
      visibleText: '',
      itemCount: 0,
      visibleMarkers: [],
      consoleErrors: [...consoleErrors],
      blockingState: 'provider',
      attemptedRecovery,
      recovered: false,
      recoveryAction,
      browserVersion: versionProbe?.browserVersion || null,
      browserUserAgent: versionProbe?.browserUserAgent || null,
      webSocketDebuggerUrl: versionProbe?.webSocketDebuggerUrl || null,
      ownership: versionProbe?.ownership,
      error: `${compactErrorMessage(error)}${buildSharedBrowserConnectionDiagnostic(versionProbe || {})}`,
    };
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function listManagedChromeProcesses(cdpUrl: string): Promise<ManagedChromeProcess[]> {
  const port = getSharedBrowserCdpPort(cdpUrl);
  const entries = await fs.promises.readdir('/proc', { withFileTypes: true }).catch(() => []);
  const processes: ManagedChromeProcess[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      continue;
    }

    let argv: string[] = [];
    try {
      const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`);
      argv = raw.toString('utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }

    if (argv.length === 0 || !argv.some((arg) => arg === `--remote-debugging-port=${port}`)) {
      continue;
    }

    const executable = argv[0]?.toLowerCase() || '';
    if (!executable.includes('chrome') && !executable.includes('chromium')) {
      continue;
    }

    processes.push({ pid, argv });
  }

  return processes.sort((left, right) => left.pid - right.pid);
}

async function detectManagedChromeService(input: { cdpUrl: string; profileDir: string }) {
  void input.cdpUrl;
  void input.profileDir;
  const serviceName = getSharedBrowserServiceName();
  const unitCandidates = [
    `/etc/systemd/system/${serviceName}`,
    `/usr/lib/systemd/system/${serviceName}`,
    `/lib/systemd/system/${serviceName}`,
  ];

  return unitCandidates.some((candidate) => fs.existsSync(candidate)) ? serviceName : null;
}

async function evaluateSharedBrowserReadiness(input: {
  cdpUrl?: string;
  verifyReady?: () => Promise<void>;
  probeTimeoutMs?: number;
  skipSessionProbe?: boolean;
}) {
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl);
  const probe = await probeSharedBrowserVersion({
    cdpUrl,
    timeoutMs: input.probeTimeoutMs,
  });
  const ownership = probe.ownership ?? await probeSharedBrowserOwnership({
    cdpUrl,
    profileDir: getSharedBrowserProfileDir(),
  }).catch(() => null);
  const diagnostics = ownership ? buildSharedBrowserSubstrateFailures(ownership) : [];

  if (!probe.ok) {
    return {
      error: buildSharedBrowserFailureMessage(
        probe.versionUrl,
        appendSharedBrowserSubstrateDiagnostics(probe.error || 'unknown probe failure', ownership),
      ),
      diagnostics,
    };
  }

  const sessionOwnership = ownership;
  const sessionDiagnostics = sessionOwnership ? buildSharedBrowserSubstrateFailures(sessionOwnership) : diagnostics;
  if (!input.skipSessionProbe) {
    const sessionProbe = await probeSharedBrowserSession({
      cdpUrl,
      timeoutMs: input.probeTimeoutMs,
    });
    const probedOwnership = sessionProbe.ownership ?? ownership;
    const probedDiagnostics = probedOwnership ? buildSharedBrowserSubstrateFailures(probedOwnership) : diagnostics;
    if (!sessionProbe.ok) {
      return {
        error: buildSharedBrowserFailureMessage(
          probe.versionUrl,
          appendSharedBrowserSubstrateDiagnostics(sessionProbe.error || 'unknown session probe failure', probedOwnership),
        ),
        diagnostics: probedDiagnostics,
      };
    }
  }

  if (input.verifyReady) {
    try {
      await input.verifyReady();
    } catch (error) {
      const message = compactErrorMessage(error);
      if (isSharedBrowserFailureText(message)) {
        return {
          error: buildSharedBrowserFailureMessage(
            probe.versionUrl,
            appendSharedBrowserSubstrateDiagnostics(message, sessionOwnership),
          ),
          diagnostics: sessionDiagnostics,
        };
      }
      throw error;
    }
  }

  return {
    error: null,
    diagnostics: sessionDiagnostics,
  };
}

export interface EnsureSharedBrowserReadyResult {
  ok: boolean;
  diagnostics: string[];
  error: string | null;
}

export async function ensureSharedBrowserReady(input: {
  cdpUrl?: string;
  verifyReady?: () => Promise<void>;
  probeTimeoutMs?: number;
  attemptRestartOnFailure?: boolean;
  skipSessionProbe?: boolean;
} = {}): Promise<EnsureSharedBrowserReadyResult> {
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl);
  const evaluation = await evaluateSharedBrowserReadiness({
    cdpUrl,
    verifyReady: input.verifyReady,
    probeTimeoutMs: input.probeTimeoutMs,
    skipSessionProbe: input.skipSessionProbe === true,
  });

  const shouldAttemptRestart = (
    input.attemptRestartOnFailure !== false
    && Boolean(evaluation.error)
    && isSharedBrowserFailureText(evaluation.error)
  );

  if (shouldAttemptRestart) {
    try {
      const { restartSharedBrowserUsingAdapter } = await import('./shared-browser-restart-adapter');
      await restartSharedBrowserUsingAdapter({
        cdpUrl,
        verifyReady: input.verifyReady,
      });

      const recovered = await evaluateSharedBrowserReadiness({
        cdpUrl,
        probeTimeoutMs: input.probeTimeoutMs,
        skipSessionProbe: input.skipSessionProbe === true,
      });

      return {
        ok: !recovered.error,
        diagnostics: recovered.diagnostics,
        error: recovered.error,
      };
    } catch (restartError) {
      return {
        ok: false,
        diagnostics: evaluation.diagnostics,
        error: [
          evaluation.error,
          `Automatic shared browser restart failed: ${compactErrorMessage(restartError)}`,
        ].filter(Boolean).join(' | '),
      };
    }
  }

  return {
    ok: !evaluation.error,
    diagnostics: evaluation.diagnostics,
    error: evaluation.error,
  };
}

export const __testOnly = {
  ensureSharedBrowserReady,
  probeSharedBrowserSession,
  probeSharedBrowserSourcePage,
  probeSharedBrowserTwitterAuth,
  probeSharedBrowserYouTubeAuth,
  probeSharedBrowserVersion,
  resetLifecycleOverrides() {
    lifecycleOverrides = null;
    profileMigrationChecked = false;
  },
  setLifecycleOverrides(overrides: SharedBrowserLifecycleOverrides | null) {
    lifecycleOverrides = overrides;
  },
};
