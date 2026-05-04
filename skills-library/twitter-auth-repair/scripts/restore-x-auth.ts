import fs from 'node:fs/promises';
import { chromium, type Cookie } from 'playwright';
import {
  acquireSharedBrowserPage,
  getSharedBrowserCdpUrl,
} from '../../../src/lib/shared-browser';

const COOKIE_PATH = process.env.TWITTER_AUTH_REPAIR_COOKIE_PATH?.trim() || '/root/.config/x-auth-cookies.json';
const HOME_URL = 'https://x.com/home';
const PROFILE_SELECTOR = '[data-testid="AppTabBar_Profile_Link"]';
const REQUIRED_COOKIE_NAMES = ['auth_token', 'ct0', 'twid', 'kdt'] as const;
const parsedTimeoutMs = Number(process.env.TWITTER_AUTH_REPAIR_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(parsedTimeoutMs)
  ? Math.max(1_000, parsedTimeoutMs)
  : 45_000;

type ExportedCookie = {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  sameSite?: unknown;
  expirationDate?: unknown;
  expires?: unknown;
};

function normalizeSameSite(value: unknown): Cookie['sameSite'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'strict') return 'Strict';
  if (normalized === 'lax') return 'Lax';
  if (normalized === 'none' || normalized === 'no_restriction') return 'None';
  return undefined;
}

function normalizeExpires(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function parseCookieExport(raw: string): Cookie[] {
  const payload = JSON.parse(raw) as unknown;
  const entries = Array.isArray(payload)
    ? payload
    : (
      payload
      && typeof payload === 'object'
      && 'cookies' in payload
      && Array.isArray((payload as { cookies?: unknown }).cookies)
    )
      ? (payload as { cookies: unknown[] }).cookies
      : null;

  if (!entries) {
    throw new Error(`${COOKIE_PATH} does not contain a cookie array.`);
  }

  const cookies = entries.flatMap((entry) => {
    const rawCookie = entry as ExportedCookie | null;
    if (!rawCookie || typeof rawCookie !== 'object') {
      return [];
    }

    const name = typeof rawCookie.name === 'string' ? rawCookie.name.trim() : '';
    const value = typeof rawCookie.value === 'string' ? rawCookie.value : '';
    if (!name || !value) {
      return [];
    }

    const domain = typeof rawCookie.domain === 'string' && rawCookie.domain.trim()
      ? rawCookie.domain.trim()
      : '.x.com';
    const path = typeof rawCookie.path === 'string' && rawCookie.path.trim()
      ? rawCookie.path.trim()
      : '/';
    const sameSite = normalizeSameSite(rawCookie.sameSite);
    const expires = normalizeExpires(rawCookie.expirationDate ?? rawCookie.expires);

    return [{
      name,
      value,
      domain,
      path,
      secure: typeof rawCookie.secure === 'boolean' ? rawCookie.secure : true,
      httpOnly: typeof rawCookie.httpOnly === 'boolean' ? rawCookie.httpOnly : false,
      ...(sameSite ? { sameSite } : {}),
      ...(typeof expires === 'number' ? { expires } : {}),
    } satisfies Cookie];
  });

  const present = new Set(cookies.map((cookie) => cookie.name));
  const missing = REQUIRED_COOKIE_NAMES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`${COOKIE_PATH} is missing required X cookies: ${missing.join(', ')}`);
  }

  return cookies;
}

async function main() {
  const cdpUrl = getSharedBrowserCdpUrl(process.env.TWITTER_AUTH_REPAIR_CDP_URL);
  const raw = await fs.readFile(COOKIE_PATH, 'utf8');
  const cookies = parseCookieExport(raw);
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: TIMEOUT_MS });

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error(`No Chrome context available at ${cdpUrl}`);
    }

    await context.addCookies(cookies);

    const acquired = await acquireSharedBrowserPage(browser, {
      cdpUrl,
      timeoutMs: TIMEOUT_MS,
    });
    const page = acquired.page;

    try {
      await page.goto(HOME_URL, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_MS,
      });
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => undefined);

      const currentUrl = page.url() || null;
      if (/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:i\/flow\/login|login)(?:\/|$|\?)/i.test(currentUrl || '')) {
        throw new Error(`x.com still redirected to login after cookie restore: ${currentUrl}`);
      }

      const profileLink = page.locator(PROFILE_SELECTOR).first();
      await profileLink.waitFor({ state: 'attached', timeout: TIMEOUT_MS });
      const href = await profileLink.getAttribute('href');
      const screenName = href?.match(/^\/([^/?#]+)$/)?.[1] || null;
      if (!screenName) {
        throw new Error(`x.com did not expose a profile identity after cookie restore on ${currentUrl || HOME_URL}`);
      }

      process.stdout.write(`${JSON.stringify({
        ok: true,
        cdpUrl,
        cookiePath: COOKIE_PATH,
        cookiesApplied: cookies.length,
        currentUrl,
        screenName,
        profileUrl: `https://x.com/${screenName}`,
      })}\n`);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({
    ok: false,
    cookiePath: COOKIE_PATH,
    error: message,
  })}\n`);
  process.exit(1);
});
