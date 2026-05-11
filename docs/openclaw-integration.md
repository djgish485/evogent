# OpenClaw Integration

This guide is written for a coding agent. Follow it end to end to wire
OpenClaw skill output into an Evogent feed.

## What This Integration Does

OpenClaw skills publish one Evogent card per run. The card is the skill's
`output.mcpapp.html` rendered inside Evogent's sandboxed MCP App iframe. If a
skill also writes `output.md` or `output.a2ui.json`, the Evogent channel ignores
those files.

## Prerequisites

You need OpenClaw running, Evogent running, and both reachable from the same
machine. The default Evogent base URL is `http://127.0.0.1:3001`.

```bash
export EVOGENT_BASE_URL="${EVOGENT_BASE_URL:-http://127.0.0.1:3001}"
export EVOGENT_INTERNAL_BASE_URL="${EVOGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
export MEDIA_AGENT_INTERNAL_BASE_URL="${MEDIA_AGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
test -d "$OPENCLAW_HOME"
curl -fsS "$EVOGENT_BASE_URL" >/dev/null
```

The channel plugin reads `EVOGENT_INTERNAL_BASE_URL` first and then
`MEDIA_AGENT_INTERNAL_BASE_URL`. Export one of those variables before starting
OpenClaw.

## Phase 1: Install The Channel Plugin

Run this from the Evogent repo:

```bash
cd <evogent-repo>
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
bash scripts/install-openclaw-channel.sh
```

Verify the symlink and channel files:

```bash
test -L "$OPENCLAW_HOME/channels/evogent"
readlink "$OPENCLAW_HOME/channels/evogent"
test -f "$OPENCLAW_HOME/channels/evogent/index.ts"
```

If OpenClaw uses a non-default home, set `OPENCLAW_HOME` to that path and rerun
the installer. Restart OpenClaw with the Evogent env available:

```bash
export EVOGENT_BASE_URL="${EVOGENT_BASE_URL:-http://127.0.0.1:3001}"
export EVOGENT_INTERNAL_BASE_URL="${EVOGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
export MEDIA_AGENT_INTERNAL_BASE_URL="${MEDIA_AGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
systemctl --user restart openclaw || true
```

## Phase 2: Opt Skills Into The Channel

Every skill that should publish to Evogent needs `evogent` in its `channels`
list. Patch each skill config under `$OPENCLAW_HOME/skills/<skill-name>/`.

JSON example:

```json
{
  "channels": ["evogent"]
}
```

YAML example:

```yaml
channels: [evogent]
```

Confirm the edits, restart OpenClaw, and run one skill:

```bash
grep -R "evogent" "$OPENCLAW_HOME/skills" -n
systemctl --user restart openclaw || true
SKILL="<skill-name>"
"$OPENCLAW_HOME/skills/$SKILL/run.sh"
```

## Phase 3: Emit MCP App HTML

Update each skill so every run writes `output.mcpapp.html`:

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
SKILL="<skill-name>"
RUN_DIR="$OPENCLAW_HOME/data/skill-runs/$SKILL"
mkdir -p "$RUN_DIR"
cat > "$RUN_DIR/output.mcpapp.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#e4e4e7;background:transparent}main{display:grid;gap:10px;padding:12px}button{border:1px solid #38bdf8;border-radius:999px;padding:8px 12px;color:#e0f2fe;background:#082f49}</style></head>
<body><main><strong>OpenClaw MCP App output</strong><p>This iframe came from output.mcpapp.html.</p><button data-evogent-action="open_detail">Open detail</button><button id="chat">Ask agent</button></main>
<script>
function post(message){parent.postMessage(Object.assign({channel:'evogent:mcpapp'},message),'*')}
function postHeight(){post({type:'height',height:document.documentElement.scrollHeight})}
window.addEventListener('load',postHeight)
document.getElementById('chat').addEventListener('click',function(){post({type:'action',actionId:'ask_agent',payload:{source:'mcpapp'}})})
</script></body></html>
HTML
```

Evogent renders the HTML in an iframe with `sandbox="allow-scripts"`, no
same-origin permission, no top navigation permission, and
`referrerPolicy="no-referrer"`.

## Daily Brief Timer Time Zone

Evogent reads the configured IANA time zone from `data/config.md`:

```markdown
## Time Zone
America/Denver
```

The app exposes OpenClaw daily timer status at
`GET /api/openclaw/daily-timer`. If `openclaw-skills-daily.timer` is installed
and still uses a UTC-style schedule such as `OnCalendar=*-*-* 06:00:00`, Evogent
marks it misaligned for the configured local morning. `POST
/api/openclaw/daily-timer` writes a user systemd drop-in that clears the old
calendar and replaces it with a DST-safe calendar expression such as:

```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* 07:00:00 America/Denver
```

The repair only runs when `systemd-analyze calendar` accepts time zones in
calendar expressions. If the host does not support that, Evogent reports the
problem instead of silently converting local morning to a fixed UTC hour.

The parent listens only to messages from the iframe where
`event.data.channel === "evogent:mcpapp"`.

Accepted parent message types:

- Height resize: `{ channel: "evogent:mcpapp", type: "height", height: 360 }`
- Action invocation: `{ channel: "evogent:mcpapp", type: "action", actionId: "open_detail", payload: { text: "Open detail" } }`

Evogent also injects a bridge that posts height on load and resize, exposes
`window.evogentAction(actionId, payload)`, and converts clicks on
`[data-evogent-action]` or `[data-action-id]` into action messages.

## Verification

Run a skill and confirm that one card appears within seconds:

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
export EVOGENT_BASE_URL="${EVOGENT_BASE_URL:-http://127.0.0.1:3001}"
export EVOGENT_INTERNAL_BASE_URL="${EVOGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
export MEDIA_AGENT_INTERNAL_BASE_URL="${MEDIA_AGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
SKILL="<skill-name>"
"$OPENCLAW_HOME/skills/$SKILL/run.sh"
RUN_DIR="$OPENCLAW_HOME/data/skill-runs/$SKILL"
test -s "$RUN_DIR/output.mcpapp.html"
```

Expected result: one Evogent card per skill run. The feed card is the MCP App
iframe with its `sandboxed agent UI` label and the agent's HTML, with no
separate Evogent title row, tier badge, or footer.

Check Evogent's SQLite database from the Evogent repo:

```bash
cd <evogent-repo>
node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/media-agent.db', { readonly: true });
const rows = db.prepare(`SELECT id, source_id, title, metadata FROM feed WHERE source = 'openclaw' ORDER BY created_at_ms DESC LIMIT 5`).all();
for (const row of rows) {
  const metadata = JSON.parse(row.metadata || '{}');
  console.log(JSON.stringify({ id: row.id, sourceId: row.source_id, title: row.title, hasMcpAppHtml: typeof metadata.mcpAppHtml === 'string' && metadata.mcpAppHtml.length > 0 }, null, 2));
}
NODE
```

## Troubleshooting

Channel not loaded:

```bash
test -L "$OPENCLAW_HOME/channels/evogent"
grep -R "channels:.*evogent\|channels = .*evogent\|\"evogent\"" "$OPENCLAW_HOME/skills" -n
```

Evogent base URL wrong:

```bash
export EVOGENT_BASE_URL="http://127.0.0.1:3001"
export EVOGENT_INTERNAL_BASE_URL="$EVOGENT_BASE_URL"
export MEDIA_AGENT_INTERNAL_BASE_URL="$EVOGENT_BASE_URL"
curl -fsS "$EVOGENT_BASE_URL" >/dev/null
```

MCP App iframe blank:

```bash
RUN_DIR="$OPENCLAW_HOME/data/skill-runs/<skill-name>"
grep -n "evogent:mcpapp\|data-evogent-action\|data-action-id" "$RUN_DIR/output.mcpapp.html"
```

If the iframe does not resize, send height messages on the `evogent:mcpapp`
channel. Because the iframe is sandboxed without same-origin, do not read parent
DOM or cookies from inside the app.
