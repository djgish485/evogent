# OpenClaw Evogent Channel

This channel ships with Evogent and lets OpenClaw skills land their output in the Evogent feed without a manual POST.

## Install

From the Evogent repo:

```bash
bash scripts/install-openclaw-channel.sh
```

The installer symlinks this folder to:

```text
~/.openclaw/channels/evogent
```

Then add `evogent` to the channel list for any OpenClaw skill:

```yaml
channels: [evogent]
```

Restart OpenClaw after changing skill config.

## Bundle Format

For a skill named `health-rollup`, the channel reads:

```text
~/.openclaw/data/skill-runs/health-rollup/output.md
~/.openclaw/data/skill-runs/health-rollup/output.a2ui.json
~/.openclaw/data/skill-runs/health-rollup/output.mcpapp.html
```

`output.md` is required. The A2UI JSON and MCP App HTML files are optional. If either optional file exists, the channel posts an extra card for that render tier under the same Evogent thread.

The channel posts to `http://127.0.0.1:3001/api/internal/curate/submit` by default. Override with `EVOGENT_INTERNAL_BASE_URL` or `MEDIA_AGENT_INTERNAL_BASE_URL`.
