---
name: substack-cache
description: Prefetch Substack posts into the shared browse cache so curation can stay cache-first for newsletter content.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-source: substack
    feed-source-label: Substack
---
# Substack Cache

Install this skill when you want Substack to behave like the other browse-cache-backed sources.

## Requirements

- The shared Chrome browse service should already be running with remote debugging exposed on port `9222` (or `SUBSTACK_BROWSER_CDP_URL` / `X_BROWSER_CDP_URL` pointing at it) if you want subscriber-only or inbox-backed discovery.
- The Chrome profile used by that browse service is the only browser-auth source of truth and should already be signed into the relevant Substack account if you want inbox/subscriber coverage.
- Public publication feeds can be fetched directly from `<publication>.substack.com/feed` without browser auth.

## Behavior

- Startup refresh runs automatically after install, and the cache refreshes again immediately before each curation cycle.
- Refresh uses the shared browse-cache storage and query APIs. Cached posts are available through `GET /api/browse-cache?source=substack`.
- The refresh worker uses the configured brain provider's short-lived nested browser task for the whole refresh plan instead of hard-coded RSS parsing, browser scraping, or inline persistence in TypeScript.
- Source-specific Substack extraction tactics belong in this skill and the refresh prompt, while persistence accounting, dedup, deadlines, and diagnostics stay in product code.
- When browser diagnostics are available, inspect the raw probe state directly: `currentUrl`, `pageTitle`, `visibleText`, `consoleErrors`, and `visibleMarkers`. Product code no longer decides whether a Substack page is signed out or blocked from regex rules.
- Cache hints should use the `substack` source namespace in `data/cache-hints.json` when you want publication/search steering.

## Refresh Task

- Read the full plan from the prompt and execute every step in order. Some steps are RSS-only and some use the authenticated browser session.
- Stay inside the shared authenticated Chrome session for browser work. Do not spawn another agent and do not use repo-specific browser scripts.
- For `rss_publication` steps, fetch the feed URL from the plan directly and parse it as RSS/XML. Keep recent canonical post entries from that publication only.
- For `browser_inbox`, use `https://substack.com/inbox` as the primary authenticated browser surface for subscriber-only and cross-publication discovery.
- Persist kept rows directly into SQLite as you go with `INSERT ... ON CONFLICT(source, tweet_id) DO UPDATE` against `tweet_cache_items`.
- Always set `source='substack'`, `last_seen_run_id`, `fetch_kind`, `fetch_contexts`, `topic_tags`, `cached_at`, and `expires_at`. Set `first_seen_run_id` only on inserts.
- Set `author_username` to the normalized publication slug from the canonical `*.substack.com` hostname when available.
- Set `tweet_id` to `<publicationSlug>:<normalizedPath>` using the canonical post URL path without a trailing slash.
- Use the title as `text`, appending a blank line and excerpt when an excerpt is available. Put the lead image URL into `media_urls` when present.
- Store post metadata compactly in `metadata` with title, excerpt, publicationName, publicationSlug, publicationUrl, canonicalUrl, authorName when visible, and `subscriberOnly`.
- Skip curated source ids, rows outside the TTL window, duplicate post ids, and rows over the prompt-specified per-publication cap. Skip rows missing a canonical post URL, title, or published time.
- Never report a source as blocked or unavailable without specific evidence such as a visible login wall, explicit error message, `4xx/5xx` RSS response, or clearly empty authenticated page.
- If an RSS fetch or browser page looks transiently empty on first attempt, retry once before concluding the source failed.
- If one step fails, note it briefly and continue to the remaining sources.
- Finish with one terse status line summarizing persisted row count plus any failed sources. Do not output a JSON document of posts.

## Guardrails

- Already curated Substack source IDs are excluded from cache results.
- The cache dedups repeated post IDs across RSS and authenticated browser discovery.
- Publication caps prevent a single newsletter from flooding the cache.
