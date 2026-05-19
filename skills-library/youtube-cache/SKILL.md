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
- Store video metadata compactly in each cache item's `payload` with title, description, duration, channel info, publish labels, thumbnail URL, canonical watch URL, view-count fields, and live/scheduled fields when present.
- Submit `publishedAtMs` as integer epoch ms when you can compute it from the rendered publish label or schema.org `datePublished`. Omit it (null) rather than guessing.
- Skip curated video ids, rows outside the TTL window, duplicate video ids, and rows over the prompt-specified per-channel caps. Skip rows missing a canonical watch URL, title, publish time/label, or thumbnail.
- Never report a source as `blocked`, rate-limited, or unavailable without specific page-level evidence such as a visible rate-limit banner, `429` status, login wall, or explicit error message. A slow load or initially empty page is not evidence.
- If a page looks empty or redirects unexpectedly on first load, wait 3 seconds and retry once before concluding the source failed.
- If one source fails, hits a sign-in wall, or lands on an interstitial, note it briefly and continue to the remaining sources.
- Use precise failure descriptions in the summary, such as `no new videos past cached timestamp`, `page showed login wall`, or `search returned no results`. Do not use vague labels like `blocked`.
- If a source that succeeded in a previous run now fails, note that regression in the summary.
- Finish with one terse status line summarizing persisted row count plus any failed sources. Do not output a JSON document of videos.

## Cacher Mode

- Cacher runs use the same YouTube surfaces, browser session, selectors, and quality thresholds as the Refresh Task. The only difference is the destination: Cacher writes to `/api/internal/browse-cache/submit`.
- Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"`.
- Treat `MEDIA_AGENT_CACHE_REFRESH_SOURCE=youtube` as the requested source when set.
- Treat `MEDIA_AGENT_CACHE_REFRESH_RUN_ID` as the run id when set. Submit it as `runId`.
- Submit `triggeredBy` as `MEDIA_AGENT_CACHE_REFRESH_TRIGGERED_BY` when set; otherwise use `cache_refresh`.
- Every cached item must include `source: "youtube"`, `sourceId` as the canonical YouTube video id, `payload`, `fetchedAtMs`, and `expiresAtMs`.
- Include `url`, `title`, `authorUsername`, `authorDisplayName`, and `publishedAtMs` when known. Use the canonical watch URL `https://www.youtube.com/watch?v=<videoId>`.
- Put the complete extracted video object in `payload`, including channel facts, thumbnail URL, duration, publish label, source surface, and any extraction diagnostics useful for curation.
- Persist the run through `POST ${API_BASE}/api/internal/browse-cache/submit`.
- On success, submit `status: "completed"` with the kept `items` array and a `cycleSummary` containing per-surface counts and skipped reasons.
- If the refresh cannot produce at least one persisted item, submit `status: "failed"`, `items: []`, and an `error` beginning `no_rows:`.
- On browser, login, provider, scraper, or submit failure, submit `status: "failed"`, `items: []`, and a concise `error` beginning one of `chrome_login:`, `provider_mcp_endpoint:`, `unsupported_provider_cli:`, `scraper_runtime:`, or `submit_failure:`.

## Guardrails

- Already curated YouTube source IDs are excluded from cache results.
- The cache dedups repeated video IDs across subscriptions, channels, and searches.
- Channel caps prevent a single YouTube account from flooding the cache.
