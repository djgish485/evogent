# Runtime Recipes

These are fallback recipes that the runtime can discover when command-driven orchestration is unavailable.

## Research Fallback Enqueue

Prefer `/research` when the command file is available. Use this direct enqueue flow only as a fallback:

```bash
curl -s -X POST http://127.0.0.1:${PORT:-3001}/api/internal/orchestrator/enqueue \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "Research and write a comprehensive analysis post about [TOPIC/URL]. Submit a type=analysis feed item via /api/internal/curate/submit with: source=claude, authorUsername=evogent, authorDisplayName=Evogent, relationship=parent, parentId=null. If the API is unavailable, append the same item to data/feed-output.jsonl as a last-resort audit fallback. Include thorough research using web search and Bird CLI. The analysis text should be full markdown with a ## Sources section. Title should be descriptive. Tags should be relevant. Reason should be: User-requested analysis via inline chat.",
    "priority": "user_ping",
    "source": "chat_research"
  }'
```

Chat confirmation template:

```text
Researching [topic] — the analysis will appear in your feed when ready.
```

## Browser-Backed Source Validation

Use this when you need to prove that a browser-backed source refresh really ran from an isolated worktree instance and persisted browse cache rows into SQLite.

For source setup, do not count ad hoc CDP extraction as success. The validation must trigger the packaged `/cache-refresh <source>` path through the isolated app and then verify rows in the isolated app's SQLite database.

For login setup, first quiet background source browsing so scheduled refreshes cannot touch the shared browser while the user enters credentials. Set `## Background Source Browsing` to `Off` in the isolated `DATA_DIR/config.md` or use the app Settings toggle. Open the source login page once, wait for the user to confirm login is complete, and only then run provider checks plus the setup-smoke `/cache-refresh <source>` proof.

1. Start the worktree app on the isolated validation host, port, and data dir.

```bash
HOST=127.0.0.1 \
PORT=3239 \
DATA_DIR=/tmp/evogent-validation/fix-add-browser-backed-source-validation-rec-1775667907864 \
npm start
```

2. Trigger a packaged source cache refresh against the isolated worktree app, not production.

```bash
curl -s -X POST http://127.0.0.1:3239/api/internal/orchestrator/enqueue \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "/cache-refresh x.com",
    "priority": "user_ping",
    "source": "worktree-browser-validation"
  }'
```

3. Wait for the isolated refresh to finish, then verify persisted browse cache rows in SQLite. The validation is not complete until the isolated data dir shows newly inserted source rows.

```bash
sqlite3 /tmp/evogent-validation/fix-add-browser-backed-source-validation-rec-1775667907864/media-agent.db "
  SELECT
    source,
    source_id,
    fetched_at_ms,
    author_username,
    title,
    datetime(fetched_at_ms / 1000, 'unixepoch') AS fetched_at_utc
  FROM browse_cache_items
  WHERE source = '$SOURCE'
  ORDER BY fetched_at_ms DESC
  LIMIT 5;
"
```

4. Verify that the isolated refresh persisted multiple recent rows from browser-backed sources.

```bash
sqlite3 /tmp/evogent-validation/fix-add-browser-backed-source-validation-rec-1775667907864/media-agent.db "
  SELECT
    source,
    source_id,
    fetched_at_ms,
    author_username,
    datetime(fetched_at_ms / 1000, 'unixepoch') AS fetched_at_utc
  FROM browse_cache_items
  WHERE source = '$SOURCE'
  ORDER BY fetched_at_ms DESC
  LIMIT 5;
"
```

Notes:

- Prefer SQLite verification over API-only verification when you need to prove persistence, because the acceptance condition is a real isolated cycle plus durable writes in the isolated validation data dir.
- For `/setup-source x.com`, the equivalent source-specific check is: install `tweet-cache`, enqueue a bounded setup-smoke refresh against the isolated app, then verify the matching `browse_cache_refresh_runs` evidence row and `browse_cache_items.source = 'twitter'` rows in the isolated `DATA_DIR`.
- Do not run this setup-smoke enqueue until after the user confirms the shared Chrome profile is logged in. It should be the only source refresh started for setup; leave background source browsing off until the smoke run finishes.

```bash
REQUEST_ID="setup-source-twitter-validation"
EXPECTED_RUN_ID="setup-source-twitter-$REQUEST_ID"
curl -s -X POST http://127.0.0.1:${PORT}/api/internal/orchestrator/enqueue \
  -H 'Content-Type: application/json' \
  -d "{
    \"requestId\":\"$REQUEST_ID\",
    \"message\":\"/cache-refresh twitter\",
    \"priority\":\"cache_refresh\",
    \"source\":\"setup-source\",
    \"metadata\":{\"cacheSource\":\"twitter\",\"triggerSource\":\"setup-source\",\"setupSourceSmoke\":true}
  }"
```

```bash
sqlite3 "$DATA_DIR/media-agent.db" "
  SELECT
    id,
    source,
    triggered_by,
    status,
    items_added,
    datetime(completed_at_ms / 1000, 'unixepoch') AS completed_at_utc
  FROM browse_cache_refresh_runs
  WHERE id = '$EXPECTED_RUN_ID'
    AND source = 'twitter'
    AND triggered_by = 'setup-source-smoke'
    AND status = 'completed'
    AND items_added > 0;
"
```

```bash
sqlite3 "$DATA_DIR/media-agent.db" "
  SELECT
    source,
    source_id,
    fetched_at_ms,
    datetime(fetched_at_ms / 1000, 'unixepoch') AS fetched_at_utc
  FROM browse_cache_items
  WHERE source = 'twitter'
  ORDER BY fetched_at_ms DESC
  LIMIT 5;
"
```
