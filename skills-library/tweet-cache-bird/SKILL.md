---
name: tweet-cache-bird
description: Prefetch Bird-authenticated X/Twitter timelines and searches into the local tweet cache for deployments that explicitly choose Bird-backed fetching.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    installRequiresExplicitOptIn: true
    reasonForGate: "Bird is the deprecated cookie-token X path. Browser-based tweet-cache is the supported default. Only install bird when the user has typed 'tweet-cache-bird' verbatim or explicitly chose the bird path in setup-source."
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
- Refresh according to the deployment's private source-cadence and cache policy,
  including the configured Bird-backed home, following, search, and selected
  account collection inputs.
- Treat selected or priority accounts as private collection hints. They never
  guarantee feed inclusion and never establish a public per-account quota.
- Pre-warm configured topic searches from private runtime context so the
  curator can judge a useful candidate set without calling Bird directly.
- Enforce the configured cache TTL and resource bounds without treating either
  as an editorial freshness threshold.
- Support cache queries by account, topic text, source-owned publication time,
  and reply/thread metadata through `/api/tweet-cache`.
- Persist a truthful refresh receipt containing the attempted surfaces,
  configured bounds, fetched/inserted counts, newest source-owned timestamp,
  completion state, and raw failure category.

**Health indicator:** Compare each source/surface receipt with its own trailing
successful baseline and configured cadence. A meaningful drop in yield, a
source-owned freshness regression, or an auth/throttling error is evidence to
investigate; no universal item count or newest-item age defines health.

**Expected failure modes and fixes:**
- `401` auth errors on Bird `user-tweets` or related authenticated calls: refresh `AUTH_TOKEN` and `CT0` in `.env.local`.
- `429` or similar throttling output: treat it as a runtime decision using the actual Bird output. The cache scheduler no longer applies a special product-code cooldown for you.
- Empty or unusually weak results: compare the receipt with the same surface's
  trailing baseline, then inspect actual throttling, auth, or source output.
- Cache freshness outside configured policy: verify the phone-owned trigger and
  recent refresh receipts before changing collection policy.

## Guardrails

- Bird fetches are sequential with delays and stop on rate limiting.
- The cache never uses Bird `--all`.
- Already curated tweet IDs are excluded from cache results.
- Configured request and result caps are collection resource bounds only. They
  do not derive account preference or reserve, guarantee, or limit feed slots.
- If the cache does not contain a needed Twitter item and the source is otherwise healthy, the curation worker skips it.
- If the cache is stale or empty, the curation worker may try bounded browser recovery, but only to restore source coverage for that cycle and never by shelling out to Bird or the x-browser CLI.
