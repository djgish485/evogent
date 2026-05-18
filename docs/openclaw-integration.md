# OpenClaw Integration

Evogent integrates with OpenClaw in two live ways:

- The OpenClaw `curator` agent selects feed items and submits them through
  `evogent.feed.submit`.
- Evogent mirrors local OpenClaw chat sessions through the OpenClaw gateway.

Evogent no longer installs an OpenClaw channel adapter and no longer auto-posts
skill output files. Skills may still write their own
`~/.openclaw/data/skill-runs/<skill>/output.mcpapp.html`; future curator work
can read those files directly.

## Curator

Install the Evogent tool plugin and seed the curator agent:

```bash
bash scripts/install-openclaw-curator-tools.sh
bash scripts/install-openclaw-curator-agent.sh
```

The curator uses:

- `evogent.browse_cache.query`
- `evogent.preferences.match`
- `evogent.interactions.recent`
- `evogent.skill_runs.list`
- `evogent.skill_runs.read`
- `evogent.chat_history.search`
- `evogent.feed.submit`

See `docs/openclaw-curator-migration.md` for the curator runtime model.

## OpenClaw Chat Mirror

Evogent reads these optional settings from `data/config.md`:

```markdown
## OpenClaw
openclaw.gatewayUrl:
openclaw.token:
openclaw.defaultSessionKey:
```

- `openclaw.gatewayUrl` overrides gateway auto-discovery. Leave it blank for
  local installs.
- `openclaw.token` overrides the shared gateway token. Leave it blank so Evogent
  reads `gateway.auth.token` from `~/.openclaw/openclaw.json`.
- `openclaw.defaultSessionKey` is the session key used by the card-level
  **Chat with OpenClaw** button.

By default Evogent connects to `ws://127.0.0.1:18789` with the trusted backend
gateway mode. If the gateway is unreachable, native Evogent chat continues to
work while OpenClaw rows show an unavailable diagnostic.
