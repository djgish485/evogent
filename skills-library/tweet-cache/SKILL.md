---
name: tweet-cache
description: Prefetch browser-authenticated X/Twitter home and account timelines into a local SQLite cache and expose them through /api/tweet-cache so curation stays cache-first.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-source: twitter
    feed-source-label: Twitter
---
# Tweet Cache

Install this skill when X/Twitter should be sourced from the shared Chrome browse profile. This is the browser-first X source skill.
If you later switch this deployment to Bird-backed fetching, uninstall this skill and install `tweet-cache-bird` instead so the active instructions stay provider-specific.

## Behavior

- Startup refresh runs automatically after install, and the cache refreshes again immediately before each curation cycle through the configured brain provider's short-lived nested browser task against the shared authenticated desktop Chrome session.
- Refresh reads `data/tweet-cache-policy.json`, `data/cache-hints.json`, `data/preferences-context.md`, `data/preference-insights.md`, and `data/curation-prompt.md` on each run so policy and preference changes are picked up automatically.
- Cached tweets are available at `GET /api/tweet-cache`.
- The curation worker should start with `/api/tweet-cache` for Twitter/X data. It must never call Bird CLI directly and must never call the x-browser CLI directly.
- Source-specific browsing tactics, fetch-order judgment, and extraction expectations belong in `data/tweet-cache-policy.json` plus the Twitter browser refresh prompt/skill boundary, while persistence, dedup, diagnostics, and repair routing stay in product code.
- External linked-page cards visible on tweets are supported extracted facts. Preserve them through the cache payload as `linkCard`, `linkPreviews`, and `urlEntities` using the field shapes in `data/tweet-cache-policy.json`; do not solve those cards with product-side X DOM heuristics.
- Video media extraction follows `data/tweet-cache-policy.json`: emit one media entry per visible video, use the poster URL for both `url` and `posterUrl`, and never persist `blob:` URLs as standalone media.
- Avatar extraction follows `data/tweet-cache-policy.json`: capture `authorAvatarUrl` from the visible user-name block avatar image for every tweet, including reply child items, parent ancestors, and thread context tweets.
- Reply context extraction follows `data/tweet-cache-policy.json`: on Home and Following timelines, when X renders a visible parent tweet above a reply card as its own complete article, capture that parent as a separate cache item with its own authorUsername, authorDisplayName, text, authorAvatarUrl, and media.
- Reply indicator extraction follows `data/tweet-cache-policy.json`: when `Replying to @handle` is visible, capture `inReplyToUsername` from that handle. Populate `inReplyToStatusId` only when X exposes the parent status URL/href or when the parent-with-child-below connector rule links the reply to the immediately preceding article. If only the `Replying to @handle` indicator is visible and no parent-rendered-above connector layout exists, `inReplyToUsername` alone is acceptable, `inReplyToStatusId` stays null, and QA should not fail the item.
- Parent-with-child-below reply linkage follows `data/tweet-cache-policy.json`: use a two-pass extraction over `[data-testid="cellInnerDiv"]` cells. Pass 1 collects cells with articles plus their `sourceId` and author handle. Pass 2 walks cells in DOM order and treats cell N as a parent-with-child-below when its article contains a `div` with CSS classes `r-1bimlpy`, `r-f8sm7e`, and `r-m5arl1`, width 1-4px, height >= 30px, and `getBoundingClientRect().bottom > cell.getBoundingClientRect().bottom - 5`. When this signal fires, cell N+1's article is the child reply: set the child `inReplyToStatusId` to the parent `sourceId` and `inReplyToUsername` to the parent author handle. This applies to cross-author replies and same-author self-threads and does not require the visible `Replying to @handle` indicator.
- Cache refresh cycle summaries should include `cycleSummary.replyExtractionAudit: { totalCells, cellsWithConnectorBelow, repliesLinkedFromConnector, repliesWithReplyingToIndicator }` so reply-linkage gaps stay visible in production.
- Text-completeness extraction follows `data/tweet-cache-policy.json`: audit every timeline/profile/search tweet before cache persistence. If the main text is likely clipped, open the canonical status URL in the shared browser and recover the full rendered text from the URL-matched main article before returning the item.
- Text-completeness cache rows must be explicit: complete status-page recoveries use `textCapture.textSource: "status_page"` and `textCapture.completeness: "complete"`; failed recoveries are either skipped or persisted with `textCapture.completeness: "incomplete"`, `cacheAudit.recoveryFailed: true`, and `sourceQuality.issue: "twitter_text_incomplete"` so cache-only curation does not count them as taste rejections.
- Cache refresh cycle summaries should include `cycleSummary.textCompletenessAudit: { tweetRowsAudited, statusPageRecovered, skippedIncomplete, deduped }` so reflection can see whether status-page recovery is working.
- Twitter cache source ids are bare numeric tweet ids. Deduplicate `twitter:<id>`, `tweet-<id>`, status URLs, and bare `<id>` before submit, keep the row with the best text-completeness evidence, and count duplicates in `cycleSummary.textCompletenessAudit.deduped`.
- Edit `data/tweet-cache-policy.json` when you need to tune per-usage refresh volume, source ordering, phase ordering, search caps, or deadline budgets. Do not re-encode those judgments in product code.
- When browser refresh diagnostics are present, read the raw probe fields directly: `currentUrl`, `pageTitle`, `visibleText`, `consoleErrors`, and `visibleMarkers`. Product code no longer classifies X pages as signed-out, consent, age-gated, interstitial, or provider-degraded from regex matches.
- If the cache is stale or empty after diagnosis, the curation worker may use its own browser tools to recover a bounded number of Twitter items for that cycle and should record that experiment in `cycleSummary.metadata`.
- Use `/setup-source x.com` when you need to authenticate the shared Chrome browse profile, verify provider MCP wiring, and prove packaged `/cache-refresh twitter` works.
- The shared Chrome browse profile is the only auth source of truth for this skill. Do not require `AUTH_TOKEN` or `CT0` when this browser skill is the selected provider.
- On deployments that provide `/root/.config/x-auth-cookies.json`, tweet-cache may dispatch the bounded `twitter-auth-repair` skill as a Twitter-specific fallback when the shared session loses auth. It is not the normal setup path and not a pattern to copy onto Google properties.

See `.claude/commands/curate.md` for the cache-first curation workflow.

## Cacher Mode

- MANDATORY SURFACE COVERAGE: Every Cacher run MUST browse all four kinds of surface in this order before submitting: (1) MANDATORY FOR YOU: `https://x.com/home` For You tab, (2) MANDATORY FOLLOWING: `https://x.com/home` Following tab, (3) MANDATORY PRIORITY PROFILES: at least three priority-account profiles read from the 'Top Engaged Accounts' section of `data/preferences-context.md` (visit `https://x.com/<username>` for each), (4) MANDATORY PLANNED SEARCHES: any planned topic searches from `data/cache-hints.json` if present. Reporting fewer than the first three kinds in `cycleSummary.surfaces` is a HARD FAILURE - submit `status: "failed"` with `error: "surface_coverage_incomplete: <missing kinds>"` instead of `status: "completed"` with partial coverage.
- Cacher runs use the same DOM selectors, the same field shape, and the same browser tactics from `data/tweet-cache-policy.json` `browserPrompt` as Curation Task. The ONLY difference between Cacher Mode and Curation Task is downstream destination - Cacher writes to `/api/internal/browse-cache/submit`, Curation submits feed items.
- Do not invent a reduced extractor. If Curation Task would capture a field, Cacher Mode captures the same field into `payload`.
- External linked-page cards are part of that field shape. When visible, preserve them in `payload.linkCard`, `payload.linkPreviews`, and `payload.urlEntities` using the shapes named in `data/tweet-cache-policy.json`.
- Persist items through `/api/internal/browse-cache/submit` with source `twitter`.
- Default cadence: every 15 minutes.
- Auth/session requirement is unchanged: use the shared authenticated Chrome browse profile.
- Never pre-judge `/root/.config/x-auth-cookies.json` or `.env.local` `AUTH_TOKEN`/`CT0` as stale based on file age, mtime, context labels, or other a-priori freshness heuristics; if the shared session is signed out and the repair fallback is available, attempt it and let the post-import `https://x.com/home` probe be the basis for declaring credentials stale.

## Main Tweet Identification

MAIN-TWEET IDENTIFICATION:
1. On x.com/<user>/status/<sourceId> pages, articles[0] is often the parent tweet, not the main tweet. Never use array index alone to identify the main article.
2. Identify the main article as the article whose self-link href matches the current page URL: it contains an a[href] ending with /status/<sourceId> for the current item sourceId. Equivalent: the only article whose own permalink anchor points to its own /status/<id>.
3. Articles before the matched main article are upstream context. Persist the article immediately preceding main as relationship="parent"; persist older ancestors as relationship="thread", oldest first. Articles after the matched main article are reply candidates, so any reply picker must use articles after the matched main index.
4. PATCH text, media_urls, metrics, and linkCard for the main feed row only from the matched main article, never from articles[0] blindly.
5. Before PATCHing text, compare the curator-submitted feed-row text with the freshly extracted candidate text. If they are plainly about different topics, different framings, or different tweet authors, STOP, re-check the URL match, and do not PATCH. Use agent judgment, not a JS text comparator.
6. Do not PATCH text merely because a candidate is longer. Text replacement requires the URL-matched main article plus the sanity judgment above.

## Recovery / Resilience

Before accepting an empty browser refresh, distinguish one empty surface from a durably empty source. `data/tweet-cache-policy.json` owns tunable fetch wording, so its `browserPrompt` should mirror these same recovery rules without shipping a default runtime policy file.

- Wait through X shell states. After landing on the target URL, run at least two short waits, about 1.5-2.5 seconds each, and re-check `article[data-testid='tweet']` before treating the page as empty.
- Use update controls when present. If the page shows a visible `Show N posts` or `See new posts` control, click it and re-evaluate the tweet rows before deciding the surface is empty.
- Fall back across open X tabs. If the canonical target tab, such as `x.com/home`, has zero tweet rows on the first scroll pass, inspect every other open `x.com` tab in the shared profile, including search, profile, list, and notification tabs.
- Persist recovered rows from any fallback tab in the same run. Rows recovered from search, profile, list, notification, or other open X tabs are legitimate cache; the run should not fail just because Home was initially empty.
- Declare source outage only after all inspected surfaces are empty. A genuine empty result requires at least two zero-row Home passes with shell waits and update-control clicks attempted, plus zero tweet rows on every other open `x.com` tab inspected.
- Otherwise persist whatever rows were extractable and complete the run normally with diagnostic notes.
- When the source is durably empty, include useful diagnostics with `items_added=0`: per-tab tweet-row counts, page title, visible text snippets, console errors, visible rate-limit markers, and visible login-required markers.
- Separate suspected shadow ban or rate limit cases, where pages render normally but timelines stay empty, from auth-loss cases where a login interstitial is visible.

## Guardrails

- Already curated tweet IDs are excluded from cache results.
- Author caps keep a single account from flooding the cache.
- Tune cache breadth and fetch order in `data/tweet-cache-policy.json`, not in `src/lib/tweet-cache.ts`.
- If the shared Chrome profile itself is logged out, re-run `/setup-source x.com`. On deployments with `/root/.config/x-auth-cookies.json`, tweet-cache may dispatch the Twitter-only `twitter-auth-repair` fallback before surfacing the warning, but the shared profile remains the source of truth.
- Never pre-judge `/root/.config/x-auth-cookies.json` or `.env.local` `AUTH_TOKEN`/`CT0` as stale based on file age, mtime, context labels, or other a-priori freshness heuristics; when the repair fallback is available, attempt it and let the post-import `https://x.com/home` probe be the basis for declaring credentials stale.
- If the shared Chrome profile is visibly logged in but automation pages fail, treat that as a browser/session attachment bug to diagnose rather than a Bird credential problem.
- If the raw probe lands on login, consent, challenge, or empty pages, the runtime decides what that means from the page state. Treat the raw URL/title/text as the source of truth rather than waiting for cache infrastructure to classify it.
- If the cache does not contain a needed Twitter item and the source is otherwise healthy, the curation worker skips it.
- If the cache is stale or empty, the curation worker may try bounded browser recovery, but only to restore source coverage for that cycle and never by shelling out to Bird or the x-browser CLI.
