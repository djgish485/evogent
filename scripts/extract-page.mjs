#!/usr/bin/env node
// extract-page.mjs — Twitter-only shared Chrome fallback extractor
// Usage: node scripts/extract-page.mjs <url> [--source twitter] [--scroll N]
// Output: JSON array of extracted tweet items to stdout
//
// This script remains only as a Twitter fallback against the shared Chrome CDP
// session. YouTube extraction must use the supported browser-tool path instead.

import { chromium } from 'playwright';
import sharedBrowserConfig from '../lib/shared-browser-config.js';

const url = process.argv[2];
const sourceArg = process.argv.indexOf('--source');
const source = sourceArg !== -1 ? process.argv[sourceArg + 1] : 'twitter';
const scrollArg = process.argv.indexOf('--scroll');
const scrollCount = scrollArg !== -1 ? parseInt(process.argv[scrollArg + 1]) : 3;

if (!url) {
  console.error('Usage: node scripts/extract-page.mjs <url> [--source twitter] [--scroll N]');
  process.exit(1);
}

function firstNonEmptyValue(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function getSharedBrowserCdpUrl(source) {
  const sourceSpecific = source === 'youtube'
    ? process.env.YT_BROWSER_CDP_URL
    : source === 'substack'
      ? process.env.SUBSTACK_BROWSER_CDP_URL
      : process.env.X_BROWSER_CDP_URL;
  return firstNonEmptyValue([
    process.env.CDP_URL,
    process.env.MEDIA_AGENT_SHARED_BROWSER_CDP_URL,
    process.env.SHARED_BROWSER_CDP_URL,
    sourceSpecific,
    process.env.X_BROWSER_CDP_URL,
    sharedBrowserConfig.DEFAULT_SHARED_BROWSER_CDP_URL,
  ]);
}

async function probeBrowserDiagnostics(cdpUrl) {
  const versionUrl = new URL('/json/version', cdpUrl).toString();

  try {
    const response = await fetch(versionUrl);
    if (!response.ok) {
      return {
        cdpUrl,
        versionUrl,
        browserVersion: null,
        browserUserAgent: null,
        webSocketDebuggerUrl: null,
      };
    }

    const payload = await response.json().catch(() => null);
    return {
      cdpUrl,
      versionUrl,
      browserVersion: typeof payload?.Browser === 'string' ? payload.Browser : null,
      browserUserAgent: typeof payload?.['User-Agent'] === 'string'
        ? payload['User-Agent']
        : typeof payload?.userAgent === 'string'
          ? payload.userAgent
          : null,
      webSocketDebuggerUrl: typeof payload?.webSocketDebuggerUrl === 'string'
        ? payload.webSocketDebuggerUrl
        : null,
    };
  } catch {
    return {
      cdpUrl,
      versionUrl,
      browserVersion: null,
      browserUserAgent: null,
      webSocketDebuggerUrl: null,
    };
  }
}

async function extractTwitter(page) {
  // Extract tweets from the current page
  return await page.evaluate(() => {
    const items = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      try {
        // Get tweet link (contains username and tweet ID)
        const timeLink = article.querySelector('a[href*="/status/"]');
        if (!timeLink) continue;
        const href = timeLink.getAttribute('href');
        const match = href.match(/\/([^/]+)\/status\/(\d+)/);
        if (!match) continue;
        
        const authorUsername = match[1];
        const tweetId = match[2];
        
        // Get display name
        const displayNameEl = article.querySelector('[data-testid="User-Name"] span');
        const authorDisplayName = displayNameEl ? displayNameEl.textContent : authorUsername;
        
        // Get tweet text
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.textContent : '';
        if (!text) continue;
        
        // Get timestamp
        const timeEl = article.querySelector('time');
        const publishedAt = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();
        
        // Get metrics (approximate from aria-labels)
        let likes = 0, reposts = 0, replies = 0;
        const replyBtn = article.querySelector('[data-testid="reply"]');
        const retweetBtn = article.querySelector('[data-testid="retweet"]');
        const likeBtn = article.querySelector('[data-testid="like"]');
        if (replyBtn) { const m = replyBtn.getAttribute('aria-label')?.match(/(\d+)/); if (m) replies = parseInt(m[1]); }
        if (retweetBtn) { const m = retweetBtn.getAttribute('aria-label')?.match(/(\d+)/); if (m) reposts = parseInt(m[1]); }
        if (likeBtn) { const m = likeBtn.getAttribute('aria-label')?.match(/(\d+)/); if (m) likes = parseInt(m[1]); }
        
        items.push({
          sourceItemId: tweetId,
          authorUsername,
          authorDisplayName,
          text,
          url: `https://x.com${href}`,
          publishedAt,
          metrics: { likes, reposts, replies },
          mediaUrls: [],
          metadata: {}
        });
      } catch { /* skip malformed tweets */ }
    }
    return items;
  });
}

async function main() {
  let browser;
  const cdpUrl = getSharedBrowserCdpUrl(source);
  const browserDiagnostics = await probeBrowserDiagnostics(cdpUrl);
  try {
    if (source !== 'twitter') {
      throw new Error(`extract-page.mjs no longer supports ${source}. YouTube must use the browser-tool rendered-page path.`);
    }

    browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    const context = contexts[0] || await browser.newContext();
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // Let dynamic content load
    
    // Scroll to load more content
    for (let i = 0; i < scrollCount; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(2000);
    }
    
    const items = await extractTwitter(page);
    
    // Close the page we opened (don't close existing pages)
    await page.close();
    
    console.log(JSON.stringify(items));
  } catch (error) {
    console.error(JSON.stringify({
      error: error.message,
      cdpUrl: browserDiagnostics.cdpUrl,
      versionUrl: browserDiagnostics.versionUrl,
      browserVersion: browserDiagnostics.browserVersion,
      browserUserAgent: browserDiagnostics.browserUserAgent,
      webSocketDebuggerUrl: browserDiagnostics.webSocketDebuggerUrl,
    }));
    process.exit(1);
  }
}

main();
