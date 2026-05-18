# OpenClaw Curator

Evogent now uses an OpenClaw-native curator agent for feed selection. Evogent
still owns the feed database, browse cache, preference files, and submit API,
but it no longer schedules or runs its own curator process.

## Runtime Model

- OpenClaw runs the `curator` agent on its cron schedule.
- The agent reads Evogent memory copied from:
  - `data/curation-prompt.md`
  - `data/preferences-context.md`
  - `data/preference-insights.md`
- The `openclaw-curator-tools` plugin exposes browse-cache, preference-match,
  recent-interaction, and live feed-submit tools.
- `evogent.feed.submit` posts to `POST /api/internal/curate/submit`.

If OpenClaw is not running, Evogent's feed can become stale. That is expected:
the fix is to repair OpenClaw, not to fall back to an Evogent-native curator.

## Install

Install the tool plugin:

```bash
bash scripts/install-openclaw-curator-tools.sh
```

Seed or refresh the OpenClaw curator agent:

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

It also ensures OpenClaw has a `curator` agent using the configured runtime and
model, grants that agent the `evogent-curator-tools` tool plugin, then creates a
cron job named `Evogent curator` unless it already exists.

## Manual Run

```bash
openclaw agent run --agent curator
```

After a successful run, accepted items should appear in Evogent's live feed:

```bash
sqlite3 data/media-agent.db \
  'SELECT source_id, title, datetime(created_at_ms/1000, "unixepoch")
   FROM feed
   ORDER BY created_at_ms DESC
   LIMIT 10'
```

## Notes

- `scripts/install-openclaw-curator-tools.sh` remains the plugin installer.
- `scripts/install-openclaw-curator-agent.sh` remains the agent seeding script.
- Evogent's old automatic curator heartbeat has been removed.
- Skill outputs stay on disk under OpenClaw's skill-run data; they are not
  automatically submitted to Evogent.
