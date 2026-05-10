---
name: tweet-cache
description: Direct-browse X/Twitter source guidance for curation cycles using the shared browser session and policy JSON prompts.
user-invocable: true
metadata:
  media-agent:
    heartbeat-task: false
    feed-source: twitter
    feed-source-label: Twitter
    action-namespaces: [x]
---
# Tweet Source

Install this skill when this app instance should use the shared Chrome browse profile as the X/Twitter source of truth.

## Behavior

- Curation reads this skill directly every cycle.
- Curation also reads `data/tweet-cache-policy.json` directly every cycle.
- Read `data/curation-prompt.md` before building the fetch plan; it is soft input for what the user cares about, including optional long-tail topics worth using when judgment says they fit.
- The policy JSON is the editable source of truth for browser browsing tactics, phase ordering, volume expectations, priority thinkers, and the full `browserPrompt`.
- When the policy JSON contains `browserPrompt`, curation must follow it verbatim rather than summarizing it.
- The curation worker browses X/Twitter directly in the shared authenticated browser session. It must not expect a cache query API or server-side hydration to decide what matters.
- The shared Chrome browse profile is the only auth source of truth for this installed skill.
- Reply context extraction follows `data/tweet-cache-policy.json`: on Home and Following timelines, when X renders a visible parent tweet above a reply card as its own complete article, capture that parent as a separate cache item with its own authorUsername, authorDisplayName, text, authorAvatarUrl, and media.
- Do not only store the reply's inReplyToStatusId when X renders the parent above a reply card as its own complete article; persist the parent as its own cache row too.

## Feed Action Handlers

This skill owns the `x.*` feed action namespace. These actions are user-initiated from rendered feed cards, not autonomous curation behavior.

### `x.follow`

Use when a user clicks a follow button on a freeform card.

Inputs:
- `itemId`: source feed item id to update after the attempt.
- `payload.handle`: X handle, with or without `@`.

Procedure:
- Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"`.
- Normalize `payload.handle` to a plain handle: trim whitespace, remove a leading `@`, and reject empty or non-handle values.
- Use the shared authenticated browser session. Do not open a separate Chrome profile and do not use cookie files as a substitute for the shared session.
- Navigate to `https://x.com/<handle>`.
- If the profile already shows `Following`, `Subscribed`, or another clear already-following state, treat the action as a no-op success.
- If the profile is suspended, unavailable, protected in a way that prevents following, or the handle resolves to a different account, stop and report a clear error.
- If X shows a rate-limit, automation, login, or retry-later state, stop and report an error with a retry hint. Do not keep retrying.
- Otherwise click the visible `Follow` button once, then verify the state changed to `Following` or equivalent.

After the attempt, PATCH the source card:

```bash
curl -sS -X PATCH "${API_BASE}/api/feed/<itemId>" \
  -H 'Content-Type: application/json' \
  --data '{"metadata":{"mcpAppHtml":"<div role=\"status\">Followed @handle.</div>"}}'
```

For errors, patch `metadata.mcpAppHtml` to a concise error state that preserves the handle and reason. Keep the card actionable only when a retry is reasonable.

## Curation Task

- Read the full curation plan from `.claude/commands/curate.md` plus the full `browserPrompt` from `data/tweet-cache-policy.json`.
- Browse every required X surface in order: `home`, `following`, gap-detected priority thinkers, then planned searches.
- Stay inside the shared authenticated Chrome session. Do not spawn a second agent, do not shell out to Bird CLI, and do not use repo-specific browser scripts.
- At the start of each source step, verify the active tab and current URL match the intended X surface. If they do not, reuse the current tab by navigating it back to the target URL. Do not close other shared-browser tabs.
- For feed scrolling, never use keyboard End, Home, Page Down, or arrow keys. Use browser JavaScript evaluation with `window.scrollBy(0, window.innerHeight * 3)`, then confirm the page is still on the intended feed URL before extracting again.
- Treat the thresholds in `data/tweet-cache-policy.json` as minimum browsing coverage for this cycle before calling Twitter sufficiently covered.
- Capture raw candidate details in your scratchpad, then submit only the tweets that clear the editorial bar.
- Preserve verified reply and quote context in submitted metadata.
- Never report the source as blocked, rate-limited, or unavailable without specific page-level evidence.

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

## Prerequisites

- Google Chrome must be installed on the server.
- Desktop-backed Chrome must be running with remote debugging on port `9222`.
- The shared Chrome browse profile owned by the browser service is the only browser-auth source of truth for browser-backed X access.
- Use `/setup-source x.com` when you need to authenticate the shared Chrome browse profile, verify provider MCP wiring, and prove packaged `/cache-refresh twitter` works.
