import { chromium, type BrowserContext, type Cookie, type Page } from 'playwright';

const PROFILE_DIR = '/root/.config/playwright-browse-profile/';
const HOME_URL = 'https://x.com/home';
const REQUIRED_COOKIES = new Set(['auth_token', 'ct0']);

interface SessionCheckResult {
  loggedIn: boolean;
  username: string | null;
  cookieCount: number;
}

async function getInitialPage(context: BrowserContext): Promise<Page> {
  const existingPage = context.pages()[0];
  if (existingPage) {
    return existingPage;
  }

  return context.newPage();
}

function hasRequiredCookies(cookies: Cookie[]): boolean {
  const cookieNames = new Set(cookies.map((cookie) => cookie.name));
  return Array.from(REQUIRED_COOKIES).every((cookieName) => cookieNames.has(cookieName));
}

async function isTimelineVisible(page: Page): Promise<boolean> {
  const selectors = [
    '[data-testid="primaryColumn"]',
    '[aria-label*="Timeline"]:visible',
    '[data-testid="cellInnerDiv"]',
    '[data-testid="tweet"]',
  ];

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 3_000 })) {
        return true;
      }
    } catch {
      // Keep checking alternate selectors because X frequently changes the feed DOM.
    }
  }

  return false;
}

async function getUsername(page: Page): Promise<string | null> {
  const profileLink = page.locator('[data-testid="AppTabBar_Profile_Link"]').first();

  try {
    await profileLink.waitFor({ state: 'attached', timeout: 3_000 });
    const href = await profileLink.getAttribute('href');

    if (!href) {
      return null;
    }

    const match = href.match(/^\/([^/?#]+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: ['--no-sandbox'],
    });

    const page = await getInitialPage(context);
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    const cookies = await context.cookies(['https://x.com', 'https://twitter.com']);
    const hasCookies = hasRequiredCookies(cookies);
    const redirectedToLogin = /\/(i\/flow\/login|login)(\/|$|\?)/.test(page.url());
    const timelineVisible = await isTimelineVisible(page);
    const username = hasCookies && !redirectedToLogin ? await getUsername(page) : null;
    const result: SessionCheckResult = {
      loggedIn: hasCookies && !redirectedToLogin && timelineVisible,
      username,
      cookieCount: cookies.length,
    };

    console.log(JSON.stringify(result));
    process.exitCode = result.loggedIn ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: SessionCheckResult = {
      loggedIn: false,
      username: null,
      cookieCount: 0,
    };

    console.error(`Browser session test failed: ${message}`);
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  } finally {
    if (context) {
      await context.close();
    }
  }
}

void run();
