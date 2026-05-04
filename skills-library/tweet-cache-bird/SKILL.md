---
name: tweet-cache-bird
description: Prefetch Bird-authenticated X/Twitter timelines and searches into the local tweet cache for deployments that explicitly choose Bird-backed fetching.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    requires:
      env:
        - AUTH_TOKEN
        - CT0
---
# Tweet Cache Bird

Install this skill only when the deployment explicitly wants Bird-backed X/Twitter fetching. This is separate from the browser-first `tweet-cache` skill.
Use it instead of `tweet-cache`, not alongside it, so the installed skill state cleanly matches the selected provider.

## Behavior

- Startup refresh runs automatically after install, and the cache refreshes again immediately before each curation cycle. It does not use `claude -p`.
- Refresh reads `data/preferences-context.md`, `data/preference-insights.md`, and `data/curation-prompt.md` on each run so preference changes are picked up automatically.
- Cached tweets are available at `GET /api/tweet-cache`.
- The curation worker should start with `/api/tweet-cache` for Twitter/X data. It must never call Bird CLI directly and must never call the x-browser CLI directly.
- This skill treats Bird credentials in `.env.local` as the auth source of truth. Do not route Bird diagnosis through `/setup-source x.com` unless the deployment is also using the separate browser-first skill for another reason.
- When a Bird refresh fails, infer meaning from the raw stderr/stdout and run diagnostics at runtime. Product code no longer classifies rate limits, auth failures, or retry paths from regex helpers.

## Prerequisites

- `AUTH_TOKEN` and `CT0` must be present in `.env.local`.
- Verify Bird auth with:

```bash
source .env.local
node node_modules/@steipete/bird/dist/cli.js whoami
```

## Contract

When working correctly, the tweet cache should:
- Refresh before each curation cycle with fresh tweets from Bird-backed home timeline, following feed, and priority accounts
- Pre-warm topic searches from `data/cache-hints.json`, `data/curation-prompt.md`, and active tracked events so supplementary curation lookups stay inside the cache
- Return tweets no older than the TTL (configurable, default 72 hours) with the newest tweets being from the last 1-2 hours
- Provide at least 50+ active tweets per refresh cycle on a healthy account
- Support cache queries by account, topic text, recency, and reply/thread metadata through `/api/tweet-cache`

**Freshness indicator:** If `metrics.lastRun.tweetsFetched` is below 20 and `metrics.lastRun.error` contains auth errors (`401`, `Could not authenticate`), the cache is operating in degraded mode and is not fulfilling its contract.

**Expected failure modes and fixes:**
- `401` auth errors on Bird `user-tweets` or related authenticated calls: refresh `AUTH_TOKEN` and `CT0` in `.env.local`.
- `429` or similar throttling output: treat it as a runtime decision using the actual Bird output. The cache scheduler no longer applies a special product-code cooldown for you.
- Empty results from search: rate limiting or API issues. Usually transient.
- Stale cache (no new tweets in 6+ hours): cache refresh may not be triggering, or Bird is failing before inserts complete. Check the pre-curation trigger in `server.js` and recent `tweet_cache_refresh_runs`.

## Guardrails

- Bird fetches are sequential with delays and stop on rate limiting.
- The cache never uses Bird `--all`.
- Already curated tweet IDs are excluded from cache results.
- Author caps keep a single account from flooding the cache.
- If the cache does not contain a needed Twitter item and the source is otherwise healthy, the curation worker skips it.
- If the cache is stale or empty, the curation worker may try bounded browser recovery, but only to restore source coverage for that cycle and never by shelling out to Bird or the x-browser CLI.
