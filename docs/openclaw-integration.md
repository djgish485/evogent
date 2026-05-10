# OpenClaw Integration

This guide is written for a coding agent. Follow it end to end to wire OpenClaw
skill output into an Evogent feed.

## What This Integration Does

OpenClaw skills can publish their run output into Evogent automatically. The
basic path sends `output.md` into the feed as a markdown card. The richer path
also sends `output.a2ui.json`, so the skill run describes its own card UI with
Evogent's A2UI primitives. The richest path sends `output.mcpapp.html`, so the
skill can render a sandboxed iframe UI instead of using a hardcoded template.

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

The checked-in channel plugin reads `EVOGENT_INTERNAL_BASE_URL` first and then
`MEDIA_AGENT_INTERNAL_BASE_URL`. Treat `EVOGENT_BASE_URL` as the readable
operator setting and export one of the plugin env names from it before starting
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
find "$OPENCLAW_HOME/channels/evogent" -maxdepth 2 -type f | sort
```

If OpenClaw uses a non-default home, rerun the installer with that path:

```bash
export OPENCLAW_HOME="/path/to/openclaw-home"
cd <evogent-repo>
bash scripts/install-openclaw-channel.sh
```

If OpenClaw has a global config file with an allowed channel list, add
`evogent` there too. Find likely config files with:

```bash
find "$OPENCLAW_HOME" -maxdepth 3 -type f \
  \( -name 'config.json' -o -name 'config.yaml' -o -name 'config.yml' -o -name 'config.toml' \) \
  -print
```

Restart OpenClaw with the Evogent env available to the OpenClaw process:

```bash
export EVOGENT_BASE_URL="${EVOGENT_BASE_URL:-http://127.0.0.1:3001}"
export EVOGENT_INTERNAL_BASE_URL="${EVOGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
export MEDIA_AGENT_INTERNAL_BASE_URL="${MEDIA_AGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
systemctl --user restart openclaw || true
```

## Phase 2: Opt Every Existing Skill In

Every skill that should publish to Evogent needs `channels: [evogent]` in its
skill config. Run this from any directory:

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.OPENCLAW_HOME || path.join(process.env.HOME, '.openclaw');
const skillsDir = path.join(home, 'skills');
const names = ['skill.json','config.json','skill.yaml','skill.yml','config.yaml','config.yml','skill.toml','config.toml'];
function addUnique(list) {
  return Array.from(new Set([...(Array.isArray(list) ? list : []), 'evogent'].filter(Boolean)));
}
function patchJson(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.channels = addUnique(data.channels);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
function patchText(file) {
  const ext = path.extname(file).toLowerCase();
  let text = fs.readFileSync(file, 'utf8');
  if (/\bchannels\b/.test(text) && /\bevogent\b/.test(text)) return;
  if (ext === '.toml') {
    text = /^channels\s*=\s*\[[^\]]*\]/m.test(text)
      ? text.replace(/^channels\s*=\s*\[([^\]]*)\]/m, (_, body) => `channels = [${body.trim() ? `${body.trim()}, ` : ''}"evogent"]`)
      : `${text.trimEnd()}\nchannels = ["evogent"]\n`;
  } else {
    text = /^channels:\s*\[[^\]]*\]/m.test(text)
      ? text.replace(/^channels:\s*\[([^\]]*)\]/m, (_, body) => `channels: [${body.trim() ? `${body.trim()}, ` : ''}evogent]`)
      : `${text.trimEnd()}\nchannels: [evogent]\n`;
  }
  fs.writeFileSync(file, text);
}
if (!fs.existsSync(skillsDir)) throw new Error(`No skills directory found at ${skillsDir}`);
for (const skill of fs.readdirSync(skillsDir).sort()) {
  const dir = path.join(skillsDir, skill);
  if (!fs.statSync(dir).isDirectory()) continue;
  const file = names.map((name) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
  if (!file) { console.log(`SKIP ${skill}: no known config file`); continue; }
  file.endsWith('.json') ? patchJson(file) : patchText(file);
  console.log(`WIRED ${skill}: ${file}`);
}
NODE
```

Confirm the edits, restart OpenClaw, and run one skill:

```bash
grep -R "evogent" "$OPENCLAW_HOME/skills" -n
export EVOGENT_BASE_URL="${EVOGENT_BASE_URL:-http://127.0.0.1:3001}"
export EVOGENT_INTERNAL_BASE_URL="${EVOGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
export MEDIA_AGENT_INTERNAL_BASE_URL="${MEDIA_AGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
systemctl --user restart openclaw || true
SKILL="<skill-name>"
"$OPENCLAW_HOME/skills/$SKILL/run.sh"
test -s "$OPENCLAW_HOME/data/skill-runs/$SKILL/output.md"
```

At this point a markdown card should appear in Evogent.

## Phase 3: A2UI Emission

This phase is optional and recommended. Update each skill so every run writes
`output.a2ui.json` beside `output.md`.

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
SKILL="<skill-name>"
RUN_DIR="$OPENCLAW_HOME/data/skill-runs/$SKILL"
mkdir -p "$RUN_DIR"
cat > "$RUN_DIR/output.a2ui.json" <<'JSON'
{"id":"root","type":"Section","props":{"title":"OpenClaw skill summary"},"children":[{"id":"p1","type":"Paragraph","props":{"text":"A2UI is working for this skill."}},{"id":"metrics","type":"Row","props":{"gap":"lg","align":"center","wrap":true},"children":[{"id":"confidence","type":"MetricRing","props":{"label":"Confidence","value":82,"tone":"green"}},{"id":"trend","type":"Sparkline","props":{"trendLabel":"Signal","data":[2,5,4,8,11],"highlight":4,"tone":"sky"}}]}]}
JSON
```

Validate the file without external tools:

```bash
node - "$RUN_DIR/output.a2ui.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const allowed = new Set(['Section','Paragraph','KeyValue','Bullet','Pill','Avatar','Row','LinkOut','Action','Sparkline','BarChart','MetricRing','TrendArrow','CollapsedCount']);
function walk(node, where) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${where} is not an object`);
  if (typeof node.id !== 'string' || !node.id.trim()) throw new Error(`${where}.id must be a string`);
  if (typeof node.type !== 'string' || !allowed.has(node.type)) throw new Error(`${where}.type is invalid: ${node.type}`);
  if (node.props !== undefined && (!node.props || typeof node.props !== 'object' || Array.isArray(node.props))) throw new Error(`${where}.props must be an object`);
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) throw new Error(`${where}.children must be an array`);
    node.children.forEach((child, index) => walk(child, `${where}.children[${index}]`));
  }
}
walk(JSON.parse(fs.readFileSync(file, 'utf8')), '$');
console.log(`valid ${file}`);
NODE
```

### A2UI Core Rules

- Root node: one object with string `id`, string `type`, optional object
  `props`, and optional array `children`.
- Unknown node type: Evogent renders an "Unknown A2UI node type" warning box.
- Invalid node object: Evogent renders an "Invalid A2UI node" warning box.
- Tone props: `tone` and `color` are synonyms. Accepted normalized tones are
  `zinc`, `rose`, `blue`, `purple`, `teal`, `amber`, `green`, and `sky`.
- Tone aliases: `red` -> `rose`, `violet` -> `purple`, `cyan` -> `teal`,
  `yellow` -> `amber`, `emerald` -> `green`, `gray` or `slate` -> `zinc`.
- Number props may be JSON numbers or numeric strings.
- Boolean props may be JSON `true` or the string `"true"`.
- Valid nesting: `Section` can contain any primitive; `Row` can contain compact
  primitives; `KeyValue` can contain compact suffix primitives; leaf primitives
  should not have children.

### A2UI Catalog

#### Section

Props: `title?: string`; `collapsible?: boolean | "true"`; `defaultCollapsed?: boolean | "true"`.
Children: any primitive. Use as the normal root.
Example tree:
```json
{"id":"sec","type":"Section","props":{"title":"Findings","collapsible":true},"children":[{"id":"p","type":"Paragraph","props":{"text":"Two findings."}}]}
```

#### Paragraph

Props: `text?: string`.
Children: none.
Example tree:
```json
{"id":"para","type":"Paragraph","props":{"text":"Plain explanatory text."}}
```

#### KeyValue

Props: `label?: string` default `Metric`; `value?: string | number`.
Children: optional compact suffix primitives.
Example tree:
```json
{"id":"kv","type":"KeyValue","props":{"label":"Queue","value":12},"children":[{"id":"kv-trend","type":"TrendArrow","props":{"direction":"down","delta":"-3"}}]}
```

#### Bullet

Props: `text?: string`; `icon?: string`; `emoji?: string`.
Children: none. If `icon` and `emoji` are absent, Evogent shows a dot.
Example tree:
```json
{"id":"bullet","type":"Bullet","props":{"icon":"!","text":"Fix the expired token before the next run."}}
```

#### Pill

Props: `text?: string`; `tone?: tone`; `color?: tone`.
Children: none.
Example tree:
```json
{"id":"pill","type":"Pill","props":{"text":"recommended","tone":"teal"}}
```

#### Avatar

Props: `src?: string`; `initials?: string` default `AG`, first three uppercase chars; `alt?: string` default initials; `size?: "sm" | "md" | "lg"` default `md`; `tone?: tone`; `color?: tone`.
Children: none.
Example tree:
```json
{"id":"avatar","type":"Avatar","props":{"initials":"OC","size":"lg","tone":"purple"}}
```

#### Row

Props: `wrap?: boolean | "true"` default `true`; `gap?: "1" | "sm" | "3" | "lg" | "4" | "xl"` default medium; `align?: "start" | "end" | "stretch" | "center"` default `center`; `justify?: "between" | "end" | "center" | "start"` default `start`.
Children: compact primitives such as buttons, charts, rings, pills, and short metrics.
Example tree:
```json
{"id":"row","type":"Row","props":{"gap":"lg","justify":"between"},"children":[{"id":"row-pill","type":"Pill","props":{"text":"ready","tone":"green"}},{"id":"row-action","type":"Action","props":{"label":"Open detail","actionId":"open_detail"}}]}
```

#### LinkOut

Props: `href?: string`; `text?: string`.
Children: none. `href` must be an absolute `http:` or `https:` URL; invalid URLs render as an inert pill.
Example tree:
```json
{"id":"link","type":"LinkOut","props":{"href":"https://example.com/report","text":"Source report"}}
```

#### Action

Props: `label?: string` default `Action`; `actionId?: string`; `tone?: tone`; `color?: tone`.
Children: none. Without `actionId`, the button is disabled. Common action IDs include `open_detail`, `view_all`, `expand`, `chat`, `ask_agent`, `thumbsup`, `thumbsdown`, `dismiss`, `accept_suggestion`, and `dismiss_suggestion`.
Example tree:
```json
{"id":"action","type":"Action","props":{"label":"Ask agent","actionId":"ask_agent","tone":"sky"}}
```

#### Sparkline

Props: `data?: Array<number | numeric string>`; `highlight?: number | numeric string`; `trendLabel?: string`; `tone?: tone`; `color?: tone`.
Children: none. If `highlight` is absent or out of range, the last point is highlighted. Empty data renders `No trend data`.
Example tree:
```json
{"id":"spark","type":"Sparkline","props":{"trendLabel":"Mentions","data":[1,3,2,6,9],"highlight":4,"tone":"sky"}}
```

#### BarChart

Props: `data?: Array<number | numeric string>`; `targetLine?: number | numeric string`; `label?: string`; `tone?: tone`; `color?: tone`.
Children: none. Empty data renders `No chart data`.
Example tree:
```json
{"id":"bars","type":"BarChart","props":{"label":"Items by day","data":[4,8,5,11],"targetLine":7,"tone":"blue"}}
```

#### MetricRing

Props: `value?: number | numeric string` clamped to `0..100`; `label?: string` default `Metric`; `tone?: tone`; `color?: tone`.
Children: none.
Example tree:
```json
{"id":"ring","type":"MetricRing","props":{"label":"Confidence","value":91,"tone":"green"}}
```

#### TrendArrow

Props: `direction?: "up" | "down" | "flat"` default `flat`; `delta?: string`.
Children: none.
Example tree:
```json
{"id":"trend-arrow","type":"TrendArrow","props":{"direction":"up","delta":"+12%"}}
```

#### CollapsedCount

Props: `label?: string`; `actionId?: string`.
Children: none. Without `actionId`, the button is disabled.
Example tree:
```json
{"id":"collapsed","type":"CollapsedCount","props":{"label":"Show 6 more","actionId":"view_all"}}
```

## Phase 4: MCP App Emission

This phase is optional. Update each skill so every run writes
`output.mcpapp.html` beside `output.md`.

Evogent renders the HTML in an iframe with `sandbox="allow-scripts"`, no
same-origin permission, no top navigation permission, and
`referrerPolicy="no-referrer"`.

The parent listens only to messages from the iframe where
`event.data.channel === "evogent:mcpapp"`.

Accepted parent message types:

- Height resize: `{ channel: "evogent:mcpapp", type: "height", height: 360 }`
- Action invocation: `{ channel: "evogent:mcpapp", type: "action", actionId: "open_detail", payload: { text: "Open detail" } }`

Evogent injects a bridge that posts height on load and resize, exposes
`window.evogentAction(actionId, payload)`, and converts clicks on
`[data-evogent-action]` or `[data-action-id]` into action messages.

Write a test MCP App bundle:

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
window.addEventListener('load',function(){parent.postMessage({type:'mcpapp:ready'},'*');postHeight()})
document.getElementById('chat').addEventListener('click',function(){post({type:'action',actionId:'ask_agent',payload:{source:'mcpapp'}})})
</script></body></html>
HTML
```

The `mcpapp:ready` message is harmless for current Evogent and useful for local
OpenClaw wrappers that expect an iframe-ready handshake. The actionable Evogent
contract is the `evogent:mcpapp` channel with `height` and `action` messages.

## Verification

Run a skill and confirm that cards appear within seconds:

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
export EVOGENT_BASE_URL="${EVOGENT_BASE_URL:-http://127.0.0.1:3001}"
export EVOGENT_INTERNAL_BASE_URL="${EVOGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
export MEDIA_AGENT_INTERNAL_BASE_URL="${MEDIA_AGENT_INTERNAL_BASE_URL:-$EVOGENT_BASE_URL}"
SKILL="<skill-name>"
"$OPENCLAW_HOME/skills/$SKILL/run.sh"
RUN_DIR="$OPENCLAW_HOME/data/skill-runs/$SKILL"
ls -la "$RUN_DIR"
test -s "$RUN_DIR/output.md"
test -s "$RUN_DIR/output.a2ui.json" || true
test -s "$RUN_DIR/output.mcpapp.html" || true
```

Expected result: markdown only creates 1 card; markdown plus A2UI creates 2
cards; markdown plus A2UI plus MCP App creates 3 cards. All cards from one run
should share one `threadId` and each should have a distinct tier pill:
`Markdown`, `A2UI`, or `MCP App`.

Check Evogent's SQLite database from the Evogent repo:

```bash
cd <evogent-repo>
node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/media-agent.db', { readonly: true });
const rows = db.prepare(`SELECT id, source_id, title, metadata FROM feed WHERE source = 'openclaw' ORDER BY created_at_ms DESC LIMIT 10`).all();
for (const row of rows) {
  const metadata = JSON.parse(row.metadata || '{}');
  console.log(JSON.stringify({ id: row.id, sourceId: row.source_id, title: row.title, renderTier: metadata.renderTier, threadId: metadata.thread && metadata.thread.threadId }, null, 2));
}
NODE
```

## Troubleshooting

Channel not loaded:

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
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

Card duplicates: the channel builds the idempotency ID from skill name, run
timestamp, and render tier. Check the skill's run timestamp and file mtime:

```bash
RUN_DIR="$OPENCLAW_HOME/data/skill-runs/<skill-name>"
stat "$RUN_DIR/output.md"
```

A2UI tree silently falls back to markdown or shows a warning:

```bash
RUN_DIR="$OPENCLAW_HOME/data/skill-runs/<skill-name>"
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('json ok')" "$RUN_DIR/output.a2ui.json"
```

Check the browser console for an `A2UIRenderer` warning. Ensure every node has
string `id` and `type`, use one of the 14 catalog types, make `props` an object,
and make `children` an array.

MCP App iframe blank:

```bash
RUN_DIR="$OPENCLAW_HOME/data/skill-runs/<skill-name>"
grep -n "mcpapp:ready\|evogent:mcpapp\|data-evogent-action\|data-action-id" "$RUN_DIR/output.mcpapp.html"
```

If the postMessage handshake never completed, check that the agent-emitted HTML
calls `parent.postMessage({type:'mcpapp:ready'},'*')` on load and also sends
height messages on the `evogent:mcpapp` channel. Because the iframe is sandboxed
without same-origin, do not read parent DOM or cookies from inside the app.

Submit API unreachable:

```bash
export EVOGENT_BASE_URL="${EVOGENT_BASE_URL:-http://127.0.0.1:3001}"
curl -sS -X POST "$EVOGENT_BASE_URL/api/internal/curate/submit" \
  -H 'Content-Type: application/json' \
  -d '{"items":[]}'
```

If this cannot reach Evogent, fix networking before changing the OpenClaw skill.

## Footer

This same pattern works for any agent platform: Codex, n8n, custom Python, and
future agents. Install the channel adapter, follow the A2UI and MCP App emission
specs above, and publish skill bundles into Evogent. The channel plugin in
`plugins/openclaw-channel/index.ts` is a reference implementation to fork.
