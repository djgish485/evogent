# OpenClaw Curator

> **Legacy/demo profile.** This document does not describe canonical phone
> production. On the phone, the Termux scheduler dispatches the hint-free
> runtime brain and the phone-local API persists accepted items. See
> [`docs/phone-production.md`](phone-production.md).

The legacy VM/demo profile can use an OpenClaw-native curator agent for feed
selection. In that profile Evogent still owns the feed database, browse cache,
preference files, and submit API, while OpenClaw schedules the curator process.

## Runtime Model

- OpenClaw runs the `curator` agent on its cron schedule.
- The agent reads Evogent memory copied from:
  - `data/curation-prompt.md`
  - `data/preferences-context.md`
  - `data/preference-insights.md`
- The `openclaw-curator-tools` plugin exposes browse-cache, preference-match,
  recent-interaction, and live feed-submit tools.
- `evogent_feed_submit` posts to `POST /api/internal/curate/submit`.

In this legacy profile, a stopped OpenClaw curator can leave the feed stale.
Repair that profile's configured owner instead of starting a competing
scheduler. This rule does not transfer OpenClaw ownership to phone production.

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
- These installers are for the legacy/demo OpenClaw profile only.
- Skill outputs stay on disk under OpenClaw's skill-run data; they are not
  automatically submitted to Evogent.
