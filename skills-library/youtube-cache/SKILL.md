---
name: youtube-cache
description: Prefetch YouTube subscription, channel, and search results into the shared browse cache so curation can stay cache-first for YouTube data.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-source: youtube
    feed-source-label: YouTube
---
# YouTube Cache

Install this skill when you want YouTube to behave like the other browse-cache-backed sources.

## Requirements

- The shared Chrome browse service must already be running with remote debugging exposed on port `9222` (or `YT_BROWSER_CDP_URL` / `X_BROWSER_CDP_URL` pointing at it).
- The Chrome profile used by that browse service should already be signed into YouTube if you want the subscriptions feed.

## Behavior

- Startup refresh runs automatically after install, and the cache refreshes again immediately before each curation cycle.
- Refresh uses the shared browse-cache storage and query APIs. Cached videos are available through `GET /api/browse-cache?source=youtube`.
- The refresh worker uses the configured brain provider's short-lived nested browser task against the authenticated shared desktop Chrome session instead of hard-coding one provider.
- Source-specific YouTube browsing tactics and extraction expectations belong in the YouTube browser refresh prompt/skill boundary, while persistence, dedup, and diagnostics stay in product code.
- When browser diagnostics are available, inspect the raw probe state directly: `currentUrl`, `pageTitle`, `visibleText`, `consoleErrors`, and `visibleMarkers`. Product code no longer labels YouTube pages as consent walls, sign-in shells, or age gates from regex rules.
- Cache hints should use the `youtube` source namespace in `data/cache-hints.json` when you want channel/search steering.

## Refresh Task

- Read the full fetch plan from the prompt and visit every source in order: home page (`youtube.com`), subscriptions, planned channels, and planned searches.
- For the home step, navigate to `youtube.com` (not `youtube.com/feed/subscriptions`) and extract recommended videos from the algorithmic home feed.
- Stay inside the shared authenticated Chrome session. Do not spawn another agent and do not use repo-specific browser scripts.
- Persist kept videos directly into SQLite as you go with `INSERT ... ON CONFLICT(source, tweet_id) DO UPDATE` against `tweet_cache_items`.
- Always set `source='youtube'`, `last_seen_run_id`, `fetch_kind`, `fetch_contexts`, `topic_tags`, `cached_at`, and `expires_at`. Set `first_seen_run_id` only on inserts.
- Store video metadata compactly in `metadata` with title, description, duration, channel info, publish labels, thumbnail URL, canonical watch URL, view-count fields, and live/scheduled fields when present.
- Submit `publishedAtMs` as integer epoch ms when you can compute it from the rendered publish label or schema.org `datePublished`. Omit it (null) rather than guessing.
- Use the title as `text`, appending a blank line and description when the description is available. Put the thumbnail URL into `media_urls` when present.
- Skip curated video ids, rows outside the TTL window, duplicate video ids, and rows over the prompt-specified per-channel caps. Skip rows missing a canonical watch URL, title, publish time/label, or thumbnail.
- Never report a source as `blocked`, rate-limited, or unavailable without specific page-level evidence such as a visible rate-limit banner, `429` status, login wall, or explicit error message. A slow load or initially empty page is not evidence.
- If a page looks empty or redirects unexpectedly on first load, wait 3 seconds and retry once before concluding the source failed.
- If one source fails, hits a sign-in wall, or lands on an interstitial, note it briefly and continue to the remaining sources.
- Use precise failure descriptions in the summary, such as `no new videos past cached timestamp`, `page showed login wall`, or `search returned no results`. Do not use vague labels like `blocked`.
- If a source that succeeded in a previous run now fails, note that regression in the summary.
- Finish with one terse status line summarizing persisted row count plus any failed sources. Do not output a JSON document of videos.

## Guardrails

- Already curated YouTube source IDs are excluded from cache results.
- The cache dedups repeated video IDs across subscriptions, channels, and searches.
- Channel caps prevent a single YouTube account from flooding the cache.
