import type { Page } from 'playwright';
import { delay, scrollPage, waitForDynamicContent, withSharedBrowserSession } from '../browser/shared-session';

const DEFAULT_SCROLL_DELAY_MS = 1_200;
const DEFAULT_TIMELINE_BATCH_SIZE = 8;
const DEFAULT_HOME_SCROLL_STEPS = 4;
const DEFAULT_STATUS_SCROLL_STEPS = 5;
const COLLAPSED_TWEET_TEXT_LENGTH_FLOOR = 240;
const STATUS_TEXT_RECOVERY_TIMEOUT_MS = 45_000;
const STATUS_TEXT_RECOVERY_WAIT_MS = 1_500;
const STATUS_SHOW_MORE_ATTEMPTS = 2;

export interface BrowserSession {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
}

type ScrapedTweet = Record<string, unknown>;

interface ExtractedTweetTextCapture {
  visibleText: string;
  textSource: 'timeline_card' | 'status_page' | 'timeline_card_fallback';
  collapsedCardDetected: boolean;
  statusPageAttempted: boolean;
  statusPageRecovered: boolean;
  diagnostic: string | null;
}

interface ExtractedTweetPayload {
  tweetId: string;
  authorUsername: string;
  authorDisplayName: string;
  authorAvatarUrl: string | null;
  text: string;
  visibleText: string;
  url: string;
  publishedAt: string;
  likes: number;
  reposts: number;
  replies: number;
  viewCount: number | null;
  mediaUrls: string[];
  conversationId: string | null;
  inReplyToStatusId: string | null;
  replyCapture: {
    source: 'timeline' | 'search' | 'profile_tweets' | 'profile_with_replies' | 'status_thread' | 'status_replies';
    classification: 'confirmed' | 'candidate' | 'none';
    requestedHandle: string | null;
    authoredByRequestedAccount: boolean | null;
    visibleReplyBanner: boolean;
  };
  textCapture: ExtractedTweetTextCapture | null;
}

interface ExtractTweetsEvaluateInput {
  limit: number;
  targetTweetId: string | null;
  mode: 'timeline' | 'read' | 'replies';
  source: 'timeline' | 'search' | 'profile_tweets' | 'profile_with_replies' | 'status_thread' | 'status_replies';
  requestedHandle: string | null;
}

function extractTweetIdFromTarget(target: string) {
  const trimmed = target.trim();
  const statusMatch = trimmed.match(/\/status\/(\d+)/);
  if (statusMatch?.[1]) {
    return statusMatch[1];
  }
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function buildStatusUrl(target: string) {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error('A tweet target is required.');
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^http:\/\//i, 'https://');
  }

  if (/^\d+$/.test(trimmed)) {
    return `https://x.com/i/status/${trimmed}`;
  }

  return `https://x.com/${trimmed.replace(/^@/, '')}`;
}

function buildSearchUrl(query: string) {
  const params = new URLSearchParams({
    q: query,
    src: 'typed_query',
    f: 'live',
  });
  return `https://x.com/search?${params.toString()}`;
}

function buildLegacyMedia(mediaUrls: string[]) {
  if (mediaUrls.length === 0) {
    return undefined;
  }

  return mediaUrls.map((url) => ({
    media_url_https: url,
    type: 'photo',
  }));
}

function buildRawTweetNode(payload: ExtractedTweetPayload): ScrapedTweet {
  const media = buildLegacyMedia(payload.mediaUrls);

  return {
    rest_id: payload.tweetId,
    text: payload.text,
    full_text: payload.text,
    core: {
      user_results: {
        result: {
          legacy: {
            screen_name: payload.authorUsername,
            name: payload.authorDisplayName,
            ...(payload.authorAvatarUrl ? { profile_image_url_https: payload.authorAvatarUrl } : {}),
          },
        },
      },
    },
    legacy: {
      id_str: payload.tweetId,
      full_text: payload.text,
      favorite_count: payload.likes,
      retweet_count: payload.reposts,
      reply_count: payload.replies,
      created_at: payload.publishedAt,
      ...(payload.conversationId ? { conversation_id_str: payload.conversationId } : {}),
      ...(payload.inReplyToStatusId ? { in_reply_to_status_id_str: payload.inReplyToStatusId } : {}),
      ...(media ? { entities: { media }, extended_entities: { media } } : {}),
    },
    ...(payload.textCapture ? { evogent_text_capture: payload.textCapture } : {}),
    replyCapture: {
      source: payload.replyCapture.source,
      classification: payload.replyCapture.classification,
      ...(payload.replyCapture.requestedHandle ? { requestedHandle: payload.replyCapture.requestedHandle } : {}),
      ...(typeof payload.replyCapture.authoredByRequestedAccount === 'boolean'
        ? { authoredByRequestedAccount: payload.replyCapture.authoredByRequestedAccount }
        : {}),
      ...(payload.replyCapture.visibleReplyBanner ? { visibleReplyBanner: true } : {}),
    },
    evogent_reply_capture: {
      source: payload.replyCapture.source,
      classification: payload.replyCapture.classification,
      ...(payload.replyCapture.requestedHandle ? { requestedHandle: payload.replyCapture.requestedHandle } : {}),
      ...(typeof payload.replyCapture.authoredByRequestedAccount === 'boolean'
        ? { authoredByRequestedAccount: payload.replyCapture.authoredByRequestedAccount }
        : {}),
      ...(payload.replyCapture.visibleReplyBanner ? { visibleReplyBanner: true } : {}),
    },
    ...(payload.viewCount !== null ? { views: { count: payload.viewCount } } : {}),
    url: payload.url,
  };
}

async function navigateToTimeline(page: Page, url: string, scrollSteps: number) {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await waitForDynamicContent(page, 2_500);
  await scrollPage(page, scrollSteps, DEFAULT_SCROLL_DELAY_MS);
}

async function maybeSelectFollowingTab(page: Page) {
  const selected = await page.locator('[data-testid="ScrollSnap-List"] a[aria-selected="true"]').first().textContent().catch(() => null);
  if (selected && /following/i.test(selected)) {
    return;
  }

  const tab = page.getByRole('tab', { name: /following/i }).first();
  const visible = await tab.isVisible().catch(() => false);
  if (!visible) {
    return;
  }

  await tab.click({ timeout: 5_000 }).catch(() => undefined);
  await waitForDynamicContent(page, 1_500);
}

async function extractTweetsFromPage(
  page: Page,
  input: ExtractTweetsEvaluateInput,
) {
  return page.evaluate(({ threshold, ...options }) => {
    const compactWhitespaceInPage = (value: string | null | undefined) => {
      const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      return normalized;
    };

    const parsePositiveIntInPage = (value: string | null | undefined) => {
      const trimmed = compactWhitespaceInPage(value);
      if (!trimmed) return null;

      const normalized = trimmed.replace(/[,\s]/g, '');
      const suffix = normalized.slice(-1).toLowerCase();
      const multiplier = suffix === 'k'
        ? 1000
        : suffix === 'm'
          ? 1000000
          : suffix === 'b'
            ? 1000000000
            : 1;
      const numericPortion = multiplier === 1 ? normalized : normalized.slice(0, -1);
      const parsed = Number.parseFloat(numericPortion);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
      }
      return Math.max(0, Math.round(parsed * multiplier));
    };

    const parseMetric = (article: Element, testId: string, labelPattern: RegExp) => {
      const button = article.querySelector(`[data-testid="${testId}"]`);
      const ariaLabel = button?.getAttribute('aria-label') || button?.textContent || '';
      const labelMatch = ariaLabel.match(labelPattern);
      if (labelMatch?.[1]) {
        return parsePositiveIntInPage(labelMatch[1]) ?? 0;
      }

      const fallbackMatch = ariaLabel.match(/([\d.,]+[kmb]?)/i);
      return fallbackMatch?.[1] ? (parsePositiveIntInPage(fallbackMatch[1]) ?? 0) : 0;
    };

    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const extracted: ExtractedTweetPayload[] = [];
    const requestedHandle = typeof options.requestedHandle === 'string' && options.requestedHandle.trim()
      ? options.requestedHandle.trim().toLowerCase()
      : null;

    for (const article of articles) {
      const statusLinks = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'));
      const primaryStatusLink = statusLinks.find((link) => {
        const href = link.getAttribute('href') || '';
        return /\/status\/\d+/.test(href);
      });
      if (!primaryStatusLink) continue;

      const href = primaryStatusLink.getAttribute('href') || '';
      const match = href.match(/\/([^/]+)\/status\/(\d+)/);
      if (!match?.[1] || !match?.[2]) {
        continue;
      }

      const authorUsername = match[1];
      const tweetId = match[2];
      const nameContainer = article.querySelector('[data-testid="User-Name"]');
      const nameSpans = nameContainer ? Array.from(nameContainer.querySelectorAll('span')) : [];
      const authorDisplayName = compactWhitespaceInPage(nameSpans[0]?.textContent) || authorUsername;
      const visibleText = compactWhitespaceInPage(article.querySelector('[data-testid="tweetText"]')?.textContent);
      if (!visibleText) continue;

      const hasShowMoreControl = Array.from(
        article.querySelectorAll('button, a, div[role="button"], div[role="link"]'),
      ).some((element) => /^show more$/i.test(compactWhitespaceInPage(element.textContent)));
      const hasShowMoreTestId = Array.from(article.querySelectorAll('[data-testid]')).some((element) => {
        const testId = element.getAttribute('data-testid') || '';
        return /showmore/i.test(testId);
      });
      const visibleTextEndsWithEllipsis = /(?:…|\.{3})$/.test(visibleText);
      const collapsedCardDetected = hasShowMoreControl
        || hasShowMoreTestId
        || (visibleText.length >= threshold && visibleTextEndsWithEllipsis);

      const avatarUrl = article.querySelector('img[src*="profile_images"]')?.getAttribute('src') || null;
      const timeEl = article.querySelector('time');
      const publishedAt = timeEl?.getAttribute('datetime') || new Date().toISOString();
      const mediaUrls = Array.from(article.querySelectorAll('img[src]'))
        .map((img) => img.getAttribute('src') || '')
        .filter((src) => src && !src.includes('profile_images'));

      const replyText = compactWhitespaceInPage(
        article.querySelector('[data-testid="socialContext"], [role="link"][href*="/status/"] + div')?.textContent,
      );
      const inReplyToMatch = replyText.match(/replying to @([A-Za-z0-9_]{1,15})/i);
      const authoredByRequestedAccount = requestedHandle ? authorUsername.toLowerCase() === requestedHandle : null;
      const isConfirmedReply = Boolean(inReplyToMatch && options.targetTweetId);
      const isReplyCandidate = !isConfirmedReply && Boolean(inReplyToMatch);
      const replyClassification: ExtractedTweetPayload['replyCapture']['classification'] = isConfirmedReply
        ? 'confirmed'
        : isReplyCandidate
          ? 'candidate'
          : 'none';
      const conversationId = options.targetTweetId && (options.mode === 'read' || options.mode === 'replies')
        ? options.targetTweetId
        : tweetId;

      extracted.push({
        tweetId,
        authorUsername,
        authorDisplayName,
        authorAvatarUrl: avatarUrl ? avatarUrl.replace('_normal', '_200x200') : null,
        text: visibleText,
        visibleText,
        url: `https://x.com${href}`,
        publishedAt,
        likes: parseMetric(article, 'like', /([\d.,]+[kmb]?)\s+likes?/i),
        reposts: parseMetric(article, 'retweet', /([\d.,]+[kmb]?)\s+(?:reposts?|retweets?)/i),
        replies: parseMetric(article, 'reply', /([\d.,]+[kmb]?)\s+repl(?:y|ies)/i),
        viewCount: parsePositiveIntInPage(
          article.querySelector('[aria-label*="view"], [aria-label*="View"]')?.getAttribute('aria-label') || null,
        ),
        mediaUrls,
        conversationId,
        inReplyToStatusId: isConfirmedReply ? options.targetTweetId : null,
        replyCapture: {
          source: options.source,
          classification: replyClassification,
          requestedHandle,
          authoredByRequestedAccount,
          visibleReplyBanner: Boolean(inReplyToMatch),
        },
        textCapture: collapsedCardDetected
          ? {
              visibleText,
              textSource: 'timeline_card',
              collapsedCardDetected: true,
              statusPageAttempted: false,
              statusPageRecovered: false,
              diagnostic: null,
            }
          : null,
      });
    }

    const targetIndex = options.targetTweetId
      ? extracted.findIndex((entry) => entry.tweetId === options.targetTweetId)
      : -1;
    const filtered = options.mode === 'read'
      ? (targetIndex >= 0 ? extracted.slice(0, targetIndex + 1) : extracted)
      : options.mode === 'replies'
        ? (targetIndex >= 0 ? extracted.slice(targetIndex + 1) : extracted)
        : extracted;

    const deduped: typeof extracted = [];
    const seen = new Set<string>();
    for (const entry of filtered) {
      if (seen.has(entry.tweetId)) continue;
      seen.add(entry.tweetId);
      deduped.push(entry);
      if (deduped.length >= options.limit) {
        break;
      }
    }

    return deduped;
  }, {
    ...input,
    threshold: COLLAPSED_TWEET_TEXT_LENGTH_FLOOR,
  });
}

function compactErrorMessage(error: unknown) {
  const value = error as Error & { message?: string };
  const message = typeof value?.message === 'string' ? value.message.trim() : '';
  return message || 'Unknown browser text recovery error';
}

async function maybeExpandStatusTweet(page: Page, tweetId: string) {
  const targetArticle = page.locator('article[data-testid="tweet"]').filter({
    has: page.locator(`a[href*="/status/${tweetId}"]`),
  }).first();
  const visible = await targetArticle.isVisible().catch(() => false);
  if (!visible) {
    return false;
  }

  let clicked = false;
  for (let attempt = 0; attempt < STATUS_SHOW_MORE_ATTEMPTS; attempt += 1) {
    const showMoreButton = targetArticle.getByRole('button', { name: /^show more$/i }).first();
    const showMoreLink = targetArticle.getByRole('link', { name: /^show more$/i }).first();
    const buttonVisible = await showMoreButton.isVisible().catch(() => false);
    const linkVisible = !buttonVisible && await showMoreLink.isVisible().catch(() => false);
    if (!buttonVisible && !linkVisible) {
      break;
    }

    if (buttonVisible) {
      await showMoreButton.click({ timeout: 5_000 }).catch(() => undefined);
    } else if (linkVisible) {
      await showMoreLink.click({ timeout: 5_000 }).catch(() => undefined);
    }
    clicked = true;
    await waitForDynamicContent(page, 750);
  }

  return clicked;
}

async function extractTweetTextFromStatusPage(page: Page, tweetId: string) {
  return page.evaluate(({ targetId, threshold }) => {
    const compactWhitespaceInPage = (value: string | null | undefined) => {
      const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      return normalized;
    };

    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const targetArticle = articles.find((article) => {
      return Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')).some((link) => {
        const href = link.getAttribute('href') || '';
        return href.includes(`/status/${targetId}`);
      });
    });

    if (!targetArticle) {
      return null;
    }

    const text = compactWhitespaceInPage(targetArticle.querySelector('[data-testid="tweetText"]')?.textContent);
    if (!text) {
      return null;
    }

    const hasShowMoreControl = Array.from(
      targetArticle.querySelectorAll('button, a, div[role="button"], div[role="link"]'),
    ).some((element) => /^show more$/i.test(compactWhitespaceInPage(element.textContent)));
    const hasShowMoreTestId = Array.from(targetArticle.querySelectorAll('[data-testid]')).some((element) => {
      const testId = element.getAttribute('data-testid') || '';
      return /showmore/i.test(testId);
    });
    const visibleTextEndsWithEllipsis = /(?:…|\.{3})$/.test(text);
    const collapsedCardDetected = hasShowMoreControl
      || hasShowMoreTestId
      || (text.length >= threshold && visibleTextEndsWithEllipsis);

    return {
      text,
      collapsedCardDetected,
    };
  }, {
    targetId: tweetId,
    threshold: COLLAPSED_TWEET_TEXT_LENGTH_FLOOR,
  });
}

function buildCollapsedTextFallback(payload: ExtractedTweetPayload, diagnostic: string): ExtractedTweetPayload {
  return {
    ...payload,
    text: payload.visibleText,
    textCapture: {
      visibleText: payload.visibleText,
      textSource: 'timeline_card_fallback',
      collapsedCardDetected: true,
      statusPageAttempted: true,
      statusPageRecovered: false,
      diagnostic,
    },
  };
}

async function recoverCollapsedTweetText(
  statusPage: Page,
  payload: ExtractedTweetPayload,
): Promise<ExtractedTweetPayload> {
  try {
    await statusPage.goto(payload.url, {
      waitUntil: 'domcontentloaded',
      timeout: STATUS_TEXT_RECOVERY_TIMEOUT_MS,
    });
    await waitForDynamicContent(statusPage, STATUS_TEXT_RECOVERY_WAIT_MS);
    await maybeExpandStatusTweet(statusPage, payload.tweetId);
    await waitForDynamicContent(statusPage, 750);

    const statusText = await extractTweetTextFromStatusPage(statusPage, payload.tweetId);
    if (!statusText?.text) {
      return buildCollapsedTextFallback(
        payload,
        'Browser detected a collapsed timeline card, but the status page did not expose canonical tweet text.',
      );
    }

    const statusPageRecovered = statusText.text !== payload.visibleText || !statusText.collapsedCardDetected;
    if (!statusPageRecovered) {
      return buildCollapsedTextFallback(
        payload,
        'Browser detected a collapsed timeline card, but the status page still only exposed the visible clipped text.',
      );
    }

    return {
      ...payload,
      text: statusText.text,
      textCapture: {
        visibleText: payload.visibleText,
        textSource: 'status_page',
        collapsedCardDetected: true,
        statusPageAttempted: true,
        statusPageRecovered: true,
        diagnostic: null,
      } satisfies ExtractedTweetTextCapture,
    };
  } catch (error) {
    return buildCollapsedTextFallback(
      payload,
      `Browser detected a collapsed timeline card, but canonical text recovery failed: ${compactErrorMessage(error)}`,
    );
  }
}

async function recoverCollapsedTweetTexts(
  page: Page,
  rows: ExtractedTweetPayload[],
) {
  const collapsedRows = rows.filter((row) => row.textCapture?.collapsedCardDetected);
  if (collapsedRows.length === 0) {
    return rows;
  }

  let statusPage: Page | null = null;
  try {
    statusPage = await page.context().newPage();
    const recoveredByTweetId = new Map<string, ExtractedTweetPayload>();

    for (const row of collapsedRows) {
      const recovered = await recoverCollapsedTweetText(statusPage, row);
      recoveredByTweetId.set(row.tweetId, recovered);
    }

    return rows.map((row) => recoveredByTweetId.get(row.tweetId) ?? row);
  } catch (error) {
    const diagnostic = `Browser detected collapsed timeline cards, but could not open status pages for canonical recovery: ${compactErrorMessage(error)}`;
    return rows.map((row) => (
      row.textCapture?.collapsedCardDetected
        ? buildCollapsedTextFallback(row, diagnostic)
        : row
    ));
  } finally {
    await statusPage?.close().catch(() => undefined);
  }
}

async function scrapeTimelinePage(
  session: BrowserSession,
  url: string,
  input: ExtractTweetsEvaluateInput,
  options: { selectFollowingTab?: boolean } = {},
) {
  return session.withPage(async (page) => {
    await navigateToTimeline(
      page,
      url,
      input.mode === 'timeline' ? DEFAULT_HOME_SCROLL_STEPS : DEFAULT_STATUS_SCROLL_STEPS,
    );

    if (options.selectFollowingTab) {
      await maybeSelectFollowingTab(page);
      await scrollPage(page, 2, DEFAULT_SCROLL_DELAY_MS);
    }

    const rows = await extractTweetsFromPage(page, input);
    const hydratedRows = await recoverCollapsedTweetTexts(page, rows);
    return hydratedRows.map((row) => buildRawTweetNode(row));
  });
}

export async function betweenActions(): Promise<void> {
  await delay(DEFAULT_SCROLL_DELAY_MS);
}

export async function withBrowserSession<T>(callback: (session: BrowserSession) => Promise<T>): Promise<T> {
  return withSharedBrowserSession(callback, {
    cdpUrl: process.env.X_BROWSER_CDP_URL,
  });
}

export async function scrapeHome(opts: { count?: number; following?: boolean; session: BrowserSession }): Promise<ScrapedTweet[]> {
  const count = Math.max(1, Math.floor(opts.count ?? DEFAULT_TIMELINE_BATCH_SIZE));
  return scrapeTimelinePage(
    opts.session,
    'https://x.com/home',
    {
      limit: count,
      targetTweetId: null,
      mode: 'timeline',
      source: 'timeline',
      requestedHandle: null,
    },
    { selectFollowingTab: opts.following === true },
  );
}

export async function scrapeUserTweets(opts: { count?: number; handle: string; session: BrowserSession }): Promise<ScrapedTweet[]> {
  const handle = opts.handle.replace(/^@/, '').trim();
  const count = Math.max(1, Math.floor(opts.count ?? DEFAULT_TIMELINE_BATCH_SIZE));
  return scrapeTimelinePage(opts.session, `https://x.com/${handle}`, {
    limit: count,
    targetTweetId: null,
    mode: 'timeline',
    source: 'profile_tweets',
    requestedHandle: handle,
  });
}

export async function scrapeUserReplies(opts: { count?: number; handle: string; session: BrowserSession }): Promise<ScrapedTweet[]> {
  const handle = opts.handle.replace(/^@/, '').trim();
  const count = Math.max(1, Math.floor(opts.count ?? DEFAULT_TIMELINE_BATCH_SIZE));
  return scrapeTimelinePage(opts.session, `https://x.com/${handle}/with_replies`, {
    limit: count,
    targetTweetId: null,
    mode: 'timeline',
    source: 'profile_with_replies',
    requestedHandle: handle,
  });
}

export async function scrapeSearch(opts: { count?: number; query: string; session: BrowserSession }): Promise<ScrapedTweet[]> {
  const count = Math.max(1, Math.floor(opts.count ?? DEFAULT_TIMELINE_BATCH_SIZE));
  return scrapeTimelinePage(opts.session, buildSearchUrl(opts.query), {
    limit: count,
    targetTweetId: null,
    mode: 'timeline',
    source: 'search',
    requestedHandle: null,
  });
}

export async function scrapeRead(opts: { target: string; session: BrowserSession }): Promise<ScrapedTweet[]> {
  const targetTweetId = extractTweetIdFromTarget(opts.target);
  return scrapeTimelinePage(opts.session, buildStatusUrl(opts.target), {
    limit: Math.max(DEFAULT_TIMELINE_BATCH_SIZE, 12),
    targetTweetId,
    mode: 'read',
    source: 'status_thread',
    requestedHandle: null,
  });
}

export async function scrapeReplies(opts: { target: string; count?: number; session: BrowserSession }): Promise<ScrapedTweet[]> {
  const targetTweetId = extractTweetIdFromTarget(opts.target);
  const count = Math.max(1, Math.floor(opts.count ?? 20));
  return scrapeTimelinePage(opts.session, buildStatusUrl(opts.target), {
    limit: count,
    targetTweetId,
    mode: 'replies',
    source: 'status_replies',
    requestedHandle: null,
  });
}

export async function likeTweet(opts: { target: string; session?: BrowserSession }): Promise<string> {
  const applyLike = async (session: BrowserSession) => {
    return session.withPage(async (page) => {
      await page.goto(buildStatusUrl(opts.target), {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await waitForDynamicContent(page, 2_000);

      const unlikeButton = page.locator('[data-testid="unlike"]').first();
      if (await unlikeButton.isVisible().catch(() => false)) {
        return 'already-liked';
      }

      const likeButton = page.locator('[data-testid="like"]').first();
      if (!await likeButton.isVisible().catch(() => false)) {
        throw new Error(`Unable to find a like button for ${opts.target}`);
      }

      await likeButton.click({ timeout: 5_000 });
      await delay(1_000);
      return 'liked';
    });
  };

  if (opts.session) {
    return applyLike(opts.session);
  }

  return withBrowserSession(applyLike);
}
