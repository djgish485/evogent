---
name: account-mirror
description: Collect recent posts from privately configured X/Twitter accounts into browse cache for later runtime-curator judgment.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: true
    requires:
      env:
        - AUTH_TOKEN
        - CT0
---

# Account Mirror

Use this skill when a deployment wants selected accounts included in source
collection. It improves candidate recall; it does not mirror posts directly
into the feed or guarantee coverage.

## Private configuration

Ask for:

- `accounts` — selected account handles, stored only in the ignored deployment
  config; and
- `collectionLimitPerAccount` — an optional bounded fetch cap used solely to
  control source cost, latency, and cache size.

Example shape:

```json
{
  "accounts": ["example_handle"],
  "collectionLimitPerAccount": 15
}
```

The account list is private collection context. Never commit a deployment's
handles, and never translate the collection cap into a feed quota.

## Heartbeat task

1. Read configured handles and the collection resource bound.
2. Fetch up to that bound from each account using the deployment's selected X
   provider.
3. Preserve stable source-owned post IDs, canonical URLs, author identity,
   source publication time, reply/thread metadata, and the capture method.
4. Persist collected rows through
   `POST $MEDIA_AGENT_INTERNAL_BASE_URL/api/internal/browse-cache/submit` with
   source `twitter`.
5. Record a truthful collection receipt for every attempted account: fetched,
   inserted, duplicate, completion status, and source error facts.

The hint-free runtime curator is the single editorial brain. It sees these
cache rows alongside every other eligible candidate and privately decides
whether anything belongs in the feed.

## Guardrails

- This skill never calls `/api/internal/curate/submit` and never writes a feed
  JSONL fallback.
- No account receives a guaranteed, minimum, or maximum number of feed items.
- A collection cap bounds source work only; it does not express taste.
- Keep original/repost/reply facts intact so the curator can make the judgment.
- When source auth or collection fails, write an honest failed receipt and
  leave other source work independent.
