import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium, type BrowserContext, type Page } from 'playwright';
import * as sharedBrowserConfig from '../lib/shared-browser-config.js';

const PROFILE_DIR = '/root/.config/playwright-browse-profile/';
const DEFAULT_SHARED_BROWSER_CDP_URL = sharedBrowserConfig.DEFAULT_SHARED_BROWSER_CDP_URL;
const REMOTE_DEBUGGING_PORT = Number.parseInt(new URL(DEFAULT_SHARED_BROWSER_CDP_URL).port || '9222', 10);
const TARGET_URL = process.argv[2]?.trim() || 'about:blank';

async function getInitialPage(context: BrowserContext): Promise<Page> {
  const existingPage = context.pages()[0];
  if (existingPage) {
    return existingPage;
  }

  return context.newPage();
}

async function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  try {
    await rl.question('');
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  let context: BrowserContext | null = null;

  try {
    const executablePath = chromium.executablePath();

    console.log('Launching persistent Playwright Chromium for site login.');
    console.log(`Profile directory: ${PROFILE_DIR}`);
    console.log(`Chromium executable: ${executablePath}`);
    console.log(`Target URL: ${TARGET_URL}`);
    console.log(`Shared browser CDP endpoint: ${DEFAULT_SHARED_BROWSER_CDP_URL}`);
    console.log('');
    console.log('SSH tunnel from your local machine:');
    console.log(`  ssh -L ${REMOTE_DEBUGGING_PORT}:localhost:${REMOTE_DEBUGGING_PORT} user@vm`);
    console.log('');
    console.log('Connect from local Chrome:');
    console.log('  1. Open chrome://inspect');
    console.log(`  2. Click 'Configure' and add 127.0.0.1:${REMOTE_DEBUGGING_PORT}`);
    console.log("  3. Click 'inspect' on the remote tab");
    console.log('');
    console.log('Log into the target site in the remote browser, then press Enter here to close.');
    console.log('');

    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: [`--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`, '--no-sandbox'],
    });

    const page = await getInitialPage(context);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    await waitForEnter();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Browser login failed: ${message}`);
    process.exitCode = 1;
  } finally {
    if (context) {
      await context.close();
    }
  }
}

void run();
