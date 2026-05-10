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
~/.openclaw/data/skill-runs/health-rollup/output.mcpapp.html
```

`output.mcpapp.html` is required. If `output.md` or `output.a2ui.json` also exist, the channel ignores them and still posts one Evogent card for the run.

The channel posts to `http://127.0.0.1:3001/api/internal/curate/submit` by default. Override with `EVOGENT_INTERNAL_BASE_URL` or `MEDIA_AGENT_INTERNAL_BASE_URL`.
