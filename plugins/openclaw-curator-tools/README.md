# OpenClaw Evogent Curator Tools

This plugin is the bridge from the OpenClaw curator agent to Evogent's live
feed. The curator can inspect browse-cache candidates, read recent OpenClaw
skill outputs, search Evogent chat history, score text against Evogent
preferences, read recent engagement, and submit selected items with
`evogent_feed_submit`.

## Install

From the Evogent repo:

```bash
bash scripts/install-openclaw-curator-tools.sh
```

The installer registers this folder with OpenClaw:

```bash
openclaw plugins install plugins/openclaw-curator-tools
```

If the OpenClaw `curator` agent already exists, the installer also adds
`evogent-curator-tools` to that agent's tool allow additions. This is required
when OpenClaw uses the default `coding` tool profile, because that profile only
allows core coding tools unless a plugin is explicitly added.

Restart OpenClaw after installing so the manifest and runtime entrypoint are
discovered.

## Tools

### `evogent_browse_cache_query`

Returns candidates from `browse_cache_items`.

### `evogent_preferences_match`

Scores text against Evogent's preference vector matcher.

### `evogent_feed_submit`

Posts the same request body shape accepted by `/api/internal/curate/submit` and
writes accepted items into Evogent's live feed.

### `evogent_interactions_recent`

Returns recent engagement signals joined to feed item titles and source ids.

### `evogent_skill_runs_list`

Lists recent output files under `~/.openclaw/data/skill-runs/<skill>/`.
Accepts `since` (ISO timestamp or epoch milliseconds, default 24 hours ago) and
`skills` (optional skill-name filter). Returns each matching output file with
its skill name, path, mtime, byte size, and a 200-character preview.

### `evogent_skill_runs_read`

Reads one skill-run output file by path. The path must resolve inside
`~/.openclaw/data/skill-runs/`; paths outside that directory are rejected.
Returns the file content, mtime, and content type (`html`, `markdown`, or
`json`).

### `evogent_chat_history_search`

Searches Evogent chat history through
`GET /api/internal/chat-history/search`. Accepts `query`, `sessionId`, `since`
(default 14 days ago), and `limit` (default 50, max 200), and returns matching
messages with session title metadata and snippets around the match.

## Curator Agent Prompt

`scripts/install-openclaw-curator-agent.sh` appends a managed
`Beyond installed skills — exploration` section to the curator's `AGENTS.md`.
That addendum tells the curator to consider skill outputs as candidates, search
chat history occasionally for follow-ups and open questions, and tag shipped
OpenClaw or cross-source observation cards with the expected metadata. Rerunning
the installer replaces that managed section instead of duplicating it.

## Configuration

The plugin calls Evogent over HTTP. Base URL resolution:

1. `EVOGENT_INTERNAL_BASE_URL`
2. `MEDIA_AGENT_INTERNAL_BASE_URL`
3. `INTERNAL_BASE_URL`
4. `http://127.0.0.1:3001`
