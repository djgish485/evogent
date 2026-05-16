# OpenClaw Curator Migration

This document covers Phase 1A of the curator migration: run an OpenClaw-native
curator beside Evogent's existing curator, capture the OpenClaw output in a
shadow log, and compare quality before any production cutover.

Phase 1A is additive only. It does not disable the current curator, does not
delete existing curator code, and does not write OpenClaw selections into the
live feed.

## What Phase 1A Adds

- A native OpenClaw plugin at `plugins/openclaw-curator-tools/`.
- A shadow submit endpoint at `POST /api/internal/curate/shadow`.
- A recent interactions endpoint at `GET /api/internal/interactions/recent`.
- Installer scripts for the OpenClaw tool plugin and the OpenClaw curator agent.
- A daily JSONL shadow log under `data/shadow-curator-log/`.

The live curator continues to use the existing orchestrator and
`/api/internal/curate/submit` path. The OpenClaw curator uses the same item
shape, but `evogent.feed.submit` points to the shadow endpoint.

## Shadow Mode

The OpenClaw curator can call four tools:

- `evogent.browse_cache.query(source?, since?, limit?)`
  returns candidate rows from `browse_cache_items`.
- `evogent.preferences.match(text, limit?)`
  calls the existing preference matcher.
- `evogent.interactions.recent(limit?)`
  returns recent app engagement signals joined to feed item titles.
- `evogent.feed.submit(items[])`
  posts the same submit body shape to `/api/internal/curate/shadow`.

The shadow endpoint validates the request envelope, normalizes accepted items,
checks live-feed source id duplicates, and appends one JSON object per accepted
batch to:

```text
data/shadow-curator-log/YYYY-MM-DD.jsonl
```

It returns the live submit response keys:

```json
{
  "accepted": 1,
  "duplicates": 0,
  "errors": [],
  "acceptedIds": ["item-id"],
  "duplicateSourceIds": []
}
```

It never inserts into `feed`, never appends to `feed-output.jsonl`, never queues
enrichment, and never notifies WebSocket clients.

## Install

Run the tool plugin installer from the Evogent repo:

```bash
bash scripts/install-openclaw-curator-tools.sh
```

This symlinks:

```text
plugins/openclaw-curator-tools -> ~/.openclaw/plugin-tools/curator-tools
```

Then seed the OpenClaw curator agent:

```bash
bash scripts/install-openclaw-curator-agent.sh
```

The agent installer creates:

```text
~/.openclaw/agents/curator/AGENTS.md
~/.openclaw/agents/curator/MEMORY.md
~/.openclaw/agents/curator/USER.md
~/.openclaw/agents/curator/sessions/
```

The source files are copied once:

- `data/curation-prompt.md` -> `AGENTS.md`
- `data/preferences-context.md` -> `MEMORY.md`
- `data/preference-insights.md` -> `USER.md`

Re-running the installer leaves existing agent files unchanged. The script also
ensures the OpenClaw config has a `curator` agent with:

```json
{
  "id": "curator",
  "model": "openai/gpt-5.5",
  "agentRuntime": {
    "id": "codex"
  }
}
```

Finally, it creates an OpenClaw cron job named `Evogent shadow curator` on this
schedule:

```text
*/30 * * * *
```

If the cron job already exists, the installer reports it and leaves it alone.

## Manual Run

After restarting OpenClaw, run one cycle manually:

```bash
openclaw agent run --agent curator
```

Then inspect the shadow log:

```bash
ls data/shadow-curator-log/
cat "data/shadow-curator-log/$(date +%Y-%m-%d).jsonl" | python3 -m json.tool | head -50
```

Inspect OpenClaw session completion:

```bash
cat ~/.openclaw/agents/curator/sessions/sessions.json | python3 -m json.tool | head -30
```

## Compare Shadow Against Live

Use one live curator cycle and one shadow cycle from the same time window.

For the live feed, inspect newly inserted feed rows around the cycle time:

```bash
sqlite3 data/media-agent.db \
  "SELECT id, source, source_id, title, published_at FROM feed ORDER BY created_at_ms DESC LIMIT 30;"
```

For the OpenClaw shadow output, inspect the matching JSONL entry:

```bash
tail -n 1 "data/shadow-curator-log/$(date +%Y-%m-%d).jsonl" | python3 -m json.tool
```

Compare:

- Did shadow ship the same high-priority items?
- Did shadow avoid obvious duplicates already in the live feed?
- Did shadow preserve real `sourceId` values from `browse_cache_items`?
- Did shadow produce similar item volume?
- Are titles, summaries, sources, and reasons at least as useful as live?

To verify shadow source ids against the browse cache:

```bash
sqlite3 data/media-agent.db \
  "SELECT source, source_id, title FROM browse_cache_items WHERE source_id IN ('<source-id-1>', '<source-id-2>');"
```

## Validation Criteria For Phase 1B

Wait for at least one cron fire, or run the curator manually once. Phase 1B
should not start until all checks pass:

1. `data/shadow-curator-log/YYYY-MM-DD.jsonl` exists and contains valid JSON
   submit payloads.
2. Shadow items reference real `sourceId` values present in
   `browse_cache_items`.
3. The OpenClaw curator session under
   `~/.openclaw/agents/curator/sessions/` has `status=done` and non-empty
   assistant output.
4. Human review shows shadow output is at least as good as the live curator:
   same important items, similar quality, and similar volume.
5. OpenClaw logs show non-zero calls to `evogent.browse_cache.query` and
   `evogent.preferences.match`.

## Phase 1B Cutover Path

If Phase 1A validates, Phase 1B is intentionally small:

1. Change the plugin submit path in `plugins/openclaw-curator-tools/index.ts`
   from `/api/internal/curate/shadow` to `/api/internal/curate/submit`.
2. Restart OpenClaw so the plugin reloads.
3. Disable the existing live curator heartbeat trigger.
4. Keep the shadow log endpoint for rollback testing until the new path has run
   cleanly for multiple cycles.

Do not make those changes in Phase 1A.
