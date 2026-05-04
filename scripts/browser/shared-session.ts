import { chromium, type Browser, type Page } from 'playwright';
import {
  acquireSharedBrowserPage,
  getSharedBrowserCdpUrl,
} from '../../src/lib/shared-browser';

const DEFAULT_BROWSER_TIMEOUT_MS = 45_000;

export interface SharedBrowserSession {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
}

export interface WithSharedBrowserSessionInput {
  cdpUrl?: string | null;
  timeoutMs?: number;
}

function resolveTimeoutMs(timeoutMs?: number) {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_BROWSER_TIMEOUT_MS;
  }

  return Math.max(1_000, Math.floor(timeoutMs as number));
}

export async function delay(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withSharedBrowserSession<T>(
  callback: (session: SharedBrowserSession) => Promise<T>,
  input: WithSharedBrowserSessionInput = {},
) {
  const timeoutMs = resolveTimeoutMs(input.timeoutMs);
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl ?? null);
  let browser: Browser | null = null;

  try {
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
    const connectedBrowser = browser;

    const session: SharedBrowserSession = {
      async withPage<TPage>(fn: (page: Page) => Promise<TPage>) {
        const pageRef = await acquireSharedBrowserPage(connectedBrowser, {
          cdpUrl,
          timeoutMs,
        });
        const page = pageRef.page;
        page.setDefaultNavigationTimeout(timeoutMs);
        page.setDefaultTimeout(timeoutMs);

        try {
          return await fn(page);
        } finally {
          await page.close().catch(() => undefined);
        }
      },
    };

    return await callback(session);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function waitForDynamicContent(page: Page, settleMs = 2_000) {
  await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_BROWSER_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(settleMs).catch(() => undefined);
}

export async function scrollPage(page: Page, steps: number, delayMs = 1_500) {
  const totalSteps = Math.max(0, Math.floor(steps));
  for (let index = 0; index < totalSteps; index += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.5);
    }).catch(() => undefined);
    await page.waitForTimeout(delayMs).catch(() => undefined);
  }
}
