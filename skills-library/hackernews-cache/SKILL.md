---
name: hackernews-cache
description: Prefetch Hacker News stories into the shared browse cache so curation can stay cache-first for HN links and Ask HN posts.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-source: hackernews
    feed-source-label: Hacker News
---
# Hacker News Cache

Install this skill when you want Hacker News to behave like the other browse-cache-backed sources.

## Requirements

- No browser session, auth token, or Chrome CDP connection is required.
- Refresh uses the public Hacker News Firebase API directly.

## Behavior

- Startup refresh runs automatically after install, and the cache refreshes again immediately before each curation cycle.
- Refresh uses the shared browse-cache storage and query APIs. Cached HN stories are available through `GET /api/browse-cache?source=hackernews`.
- Product code handles persistence, dedup, deadlines, and diagnostics. The source itself is public API work, not browser automation.
- Cache hints may use the `hackernews` source namespace in `data/cache-hints.json`, but refresh still works without hints because it fetches top-ranked HN stories directly.

## Refresh Task

- Fetch the configured `topstories`, `beststories`, and `newstories` lists from the Hacker News API when their limits are non-zero.
- Dedup story ids across lists before fetching individual items.
- Fetch each item from `/v0/item/<id>.json` and keep only cacheable story rows with a stable title and publish time.
- Persist kept rows directly into SQLite with `source='hackernews'` and `INSERT ... ON CONFLICT(source, tweet_id) DO UPDATE`.
- Set `tweet_id` to the Hacker News story id string.
- Set `author_username` to `by`, `metrics_likes` to `score`, and `metrics_replies` to `descendants`.
- Every submitted HN cache row must include `score` as a non-null integer; missing score is a data-quality failure, and curators may use the score as a soft filter signal.
- Use the external `url` when present; otherwise fall back to `https://news.ycombinator.com/item?id=<id>`.
- Use the title as `text`, appending cleaned body text for Ask HN / Show HN style posts when present.
- Store compact metadata with title, score, comment count, author, HN item URL, canonical URL, story type, and Ask/Show/Launch flags.
- Skip stories already outside the TTL window.

## Guardrails

- Already curated Hacker News source ids are excluded from cache results.
- The cache dedups the same story across top, best, and new list membership.
- Author caps prevent a single HN account from flooding the cache.
