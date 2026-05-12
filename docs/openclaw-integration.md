# OpenClaw Integration

This guide is written for a coding agent. Follow it end to end to wire
OpenClaw skill output into an Evogent feed.

## What This Integration Does

OpenClaw skills publish one Evogent card per run. The card is the skill's
`output.mcpapp.html` rendered inside Evogent's sandboxed MCP App iframe. If a
skill also writes `output.md` or `output.a2ui.json`, the Evogent channel ignores
those files.

## Inbound chat: replying to OpenClaw from Evogent

Evogent also mirrors local OpenClaw chat sessions. The compose session dropdown
has an **OpenClaw** section populated from the OpenClaw gateway, and sending to
one of those rows calls `chat.send` on the real OpenClaw session. Replies stream
back into Evogent while the same turns are appended to
`~/.openclaw/agents/<agent>/sessions/`, so the OpenClaw dashboard shows the same
history. Evogent does not create a parallel SQLite chat copy for these turns.

### Settings

Evogent reads these optional settings from `data/config.md`:

```markdown
## OpenClaw
openclaw.gatewayUrl:
openclaw.token:
openclaw.defaultSessionKey:
```

- `openclaw.gatewayUrl` overrides gateway auto-discovery. Leave it blank for
  local installs. v1 only supports loopback WebSocket URLs such as
  `ws://127.0.0.1:18789`; remote OpenClaw is a planned follow-up.
- `openclaw.token` overrides the shared gateway token. Leave it blank so Evogent
  reads `gateway.auth.token` from `~/.openclaw/openclaw.json`. Never print this
  value in logs or UI; show only whether it is configured.
- `openclaw.defaultSessionKey` is the session key used by the card-level
  **Chat with OpenClaw** button. If blank, Evogent prompts the first time a user
  clicks that button and saves the selected key here.

### Auto-discovery

On the server, Evogent reads `~/.openclaw/openclaw.json`, finds
`gateway.auth.token`, and connects to the local gateway at
`ws://127.0.0.1:18789` unless `openclaw.gatewayUrl` is set. No user action is
needed when OpenClaw and Evogent run on the same machine with the default
gateway. The connection uses the trusted backend shortcut:
`client.id="gateway-client"`, `client.mode="backend"`, role `operator`, scopes
`operator.read` and `operator.write`, and the shared token. Device pairing is
not implemented for Evogent v1.

### User behavior

Every OpenClaw feed card rendered from `source = "openclaw"` and
`metadata.mcpAppHtml` includes a **Chat with OpenClaw** button below the iframe.
Clicking it opens the compose UI, pre-fills a markdown quote containing the card
title and a short body excerpt, selects the saved default OpenClaw session, and
focuses the input. If no default session is saved, Evogent displays the live
OpenClaw session list and asks the user to choose one before continuing.

The compose dropdown has a separate **OpenClaw** section. It is fetched from
`sessions.list`, includes a label plus brief last-message preview, and refreshes
when the gateway emits `sessions.changed`. Selecting a row changes the composer
target to that OpenClaw session; sending a message routes through the gateway
with `chat.send`.

If the gateway cannot be reached, the OpenClaw section shows
`OpenClaw unreachable -- check ~/.openclaw/openclaw.json`. The same diagnostic
appears when a card chat button is clicked. Check that OpenClaw is running, the
gateway port is still `18789` or matches `openclaw.gatewayUrl`, and the shared
token in `data/config.md` or `~/.openclaw/openclaw.json` is correct. Native
Evogent chat sessions continue to work while OpenClaw is unreachable.

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

## Phase 4: Verify Two-way Chat Works

Open Evogent and click the session selector in the compose bar. The dropdown
should include an **OpenClaw** section with rows that match:

```bash
find "$OPENCLAW_HOME/agents" -path "*/sessions/sessions.json" -print
```

Pick an OpenClaw session, type a short message, and send it. Evogent should show
the user turn and then stream the OpenClaw reply into the same chat thread.
Verify the mirror by checking the OpenClaw transcript file for that session:

```bash
SESSION_KEY="<key-from-compose-dropdown>"
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
const key = process.env.SESSION_KEY;
const agentsDir = path.join(home, 'agents');
for (const agent of fs.readdirSync(agentsDir)) {
  const indexPath = path.join(agentsDir, agent, 'sessions', 'sessions.json');
  if (!fs.existsSync(indexPath)) continue;
  const sessions = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const row = sessions[key];
  if (row?.sessionFile) {
    console.log(row.sessionFile);
    process.exit(0);
  }
}
process.exit(1);
NODE
```

Open the printed file and confirm the new user turn and reply are present. Then
open the OpenClaw dashboard for the same session and confirm the same turns are
visible there.

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
