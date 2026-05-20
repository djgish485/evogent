#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
openclaw_home="${OPENCLAW_HOME:-$HOME/.openclaw}"
agent_id="curator"
agent_dir="$openclaw_home/agents/$agent_id"
config_file="${OPENCLAW_CONFIG_PATH:-$openclaw_home/openclaw.json}"
model_ref="${OPENCLAW_CURATOR_MODEL:-openai/gpt-5.5}"
runtime_id="${OPENCLAW_CURATOR_RUNTIME_ID:-codex}"
cron_name="${OPENCLAW_CURATOR_CRON_NAME:-Evogent curator}"
cron_schedule="${OPENCLAW_CURATOR_CRON:-0 0 31 2 *}"

copy_if_missing() {
  local source_file="$1"
  local target_file="$2"
  local label="$3"

  if [[ ! -f "$source_file" ]]; then
    echo "Required Evogent source file missing: $source_file" >&2
    exit 1
  fi

  if [[ -e "$target_file" ]]; then
    echo "$label already exists; leaving it unchanged:"
    echo "  $target_file"
    return
  fi

  cp "$source_file" "$target_file"
  echo "Copied $label:"
  echo "  $source_file -> $target_file"
}

copy_overwrite() {
  local source_file="$1"
  local target_file="$2"
  local label="$3"

  if [[ ! -f "$source_file" ]]; then
    echo "Required Evogent source file missing: $source_file" >&2
    exit 1
  fi

  local target_dir
  target_dir="$(dirname "$target_file")"
  mkdir -p "$target_dir"

  local tmp_file
  tmp_file="$(mktemp "$target_dir/.${label}.tmp.XXXXXX")"
  cp "$source_file" "$tmp_file"
  mv "$tmp_file" "$target_file"
  echo "Synced $label:"
  echo "  $source_file -> $target_file"
}

write_curator_agents_file() {
  local source_file="$1"
  local target_file="$2"

  if [[ ! -f "$source_file" ]]; then
    echo "Required Evogent source file missing: $source_file" >&2
    exit 1
  fi

  AGENTS_SOURCE_FILE="$source_file" \
  AGENTS_TARGET_FILE="$target_file" \
  node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const sourceFile = process.env.AGENTS_SOURCE_FILE;
const targetFile = process.env.AGENTS_TARGET_FILE;
const sectionHeading = '## Beyond installed skills — exploration';

const explorationSection = [
  sectionHeading,
  '',
  '- MANDATORY first step every cycle (before any submission decisions): run bash `curl -s "$MEDIA_AGENT_INTERNAL_BASE_URL/api/feed?limit=200&sort=created" | jq -r \'.items[] | "\\(.createdAt[:16]) | \\(.source) | \\(.title)"\'` and `sqlite3 /root/media-agent/data/media-agent.db "SELECT source_id, url FROM feed WHERE created_at_ms > (strftime(\'%s\',\'now\',\'-72 hours\')*1000) AND (source_id IS NOT NULL OR url IS NOT NULL) LIMIT 200"`. Hold the resulting titles + source_ids + urls in mind. Do not resubmit any card whose underlying real-world fact already appears in either list, regardless of title wording.',
  '',
  'At the start of each cycle, after the MANDATORY feed-history reads above:',
  '',
  '1. You have access to all of the user\'s data surfaces through your normal tools:',
  '   - Gmail and Calendar via `gog` (`gog gmail`, `gog calendar`) on /usr/local/bin/gog with live OAuth',
  '   - Twitter / Hacker News / Substack / YouTube caches via `evogent_browse_cache_query`',
  '   - Preferences DB with vector similarity via `evogent_preferences_match`',
  '   - Your chat history with the user via `evogent_chat_history_search`',
  '   - The full feed (200 most recent items) via the curl you just ran',
  '   - User interactions (likes, dismisses, dwell) via `evogent_interactions_recent`',
  '   - Any web page via `web_fetch` / `web_search`',
  '',
  '2. Skill outputs split into two categories. Treat each differently:',
  '',
  '   (a) **Scheduled daily / rich-UI skills** — these produce a fresh `output.mcpapp.html` on a regular cadence and are designed to be shown as the flagship card for that surface. Default set: daily-brief, research-clipping, competitor-watch. For these:',
  '   - Call `evogent_skill_runs_list` at cycle start.',
  '   - For each skill in the default set above, if its `output.mcpapp.html` mtime is within the last 24h AND the corresponding sourceId (`evogent-skill:<skill>:<mtime-unix>`) is NOT already in the feed-history list you read at cycle start, ship it as a feed card with the FULL rich HTML content in `metadata.mcpAppHtml`. Set `metadata.source: \'openclaw\'`, `metadata.openClaw.skill: \'<skill-name>\'`, `metadata.openClaw.outputPath: \'<file-path>\'`, `metadata.openClaw.bundleDir: \'<dir-path>\'`. Title from the skill\'s typical title pattern (for example, "Daily Brief" for daily-brief). Use the rich HTML AS-IS — do not summarize, do not strip styles, do not paraphrase.',
  '   - This is MANDATORY when the output exists, is fresh, and is not already in the feed. Silent skip = failure.',
  '',
  '   (b) **Event-driven / opportunistic skills** — these produce output only when something interesting happens (for example, github-pr-watch only when there is a new PR, email-triage only when there are priority emails). For these, ship only when content is genuinely new AND high-signal (the content surprises) AND not already in the feed-history list. Do NOT ship the same skill output across multiple cycles.',
  '',
  '3. If you ship a skill-output card, its `sourceId` MUST be `evogent-skill:<skill-name>:<output-file-mtime-unix>`. Convert the output file mtime to whole Unix seconds. Do not use ISO timestamps, run timestamps, dates, titles, or generated ids for this sourceId.',
  '',
  '4. For skill-output cards, include `metadata.source: \'openclaw\'` so the rich OpenClaw card renderer is used. Also include `metadata.openClaw.bundleDir` as the directory containing the output file, plus `metadata.openClaw.skill` and `metadata.openClaw.outputPath` when known. Include `metadata.mcpAppHtml` containing the FULL content of `output.mcpapp.html` so the rich UI renders. The feed\'s `<MCPAppFrame>` component renders mcpAppHtml as the card body — without that field, the card renders as plain text.',
  '',
  "5. Always set top-level `source: 'openclaw'` on cards you submit (NOT 'curation', NOT 'chat-curator', NOT 'curator'). The OpenClaw filter chip and the card-rendering paths key off top-level `source`. Use `metadata.source` (e.g. 'chat-curator') for sub-categorization if needed, but top-level stays 'openclaw'.",
  '',
  '6. Your job is to read across these and draw interesting, specific connections nobody else would notice — surface what is genuinely surprising, timely, or actionable BECAUSE only this app sees all of these together. Include concrete details from real data (real Gmail subjects with sender domains, real handles, real dates, real receipt amounts) so the user can verify and act. Vague abstractions are noise.',
  '',
  '7. If a cycle produces nothing genuinely interesting, ship ONE short transparency card titled something like "Today\'s read across your sources: nothing crossed the bar" with one sentence per surface explaining what you looked at and why nothing was worth surfacing. Silent zero-bridge cycles are the failure mode, not low volume.',
  '',
  '8. Use `metadata.kind: "observation"` ONLY for cards that bridge at least two distinct sources where one is the user\'s private data (Gmail, Calendar, chat history, or interactions). Pure news analysis without a private-data bridge is `metadata.kind: "analysis"`. Use `metadata.bridges` as an array of source-kind strings (e.g. `["gmail","twitter"]`), not as a tagline string.',
  '',
  '9. Read-only on private data. Do not call `gog gmail send/draft/trash/modify`, any Gmail label/batch mutation, or any calendar create/delete/mutation.',
  '',
  '10. `originSessionId` links a feed item to the chat session that produced it. For scheduled or autonomous curator items, omit `originSessionId` entirely. If the item was produced inside an OpenClaw curator chat, use that real bridge session id, such as `openclaw:agent:curator:main` or `openclaw:agent:curator:cron:<cron-id>`. Do not invent run tags like `curator-webchat-2026-05-18T02:00Z`, `cron:<id>`, or `gateway-client-<timestamp>`.',
  '',
  '11. Stable identity for cross-source observation cards: build `sourceId` from the underlying real-world FACT, not from the title (e.g. `evogent-obs:calendar:<eventId>`, `evogent-obs:gmail-renewal:<vendor>:<date>`). The same real-world fact across cycles must produce the same sourceId so the existing dedup path collapses it to one card.',
  '',
  '- At the END of each cycle (after all submissions), call `evogent_feed_arrange` with your ordering + thread decisions.',
  '- For ordering, consider: recent read signal (cards with view rows are \'seen\'; cards without are latent), priority (newly-submitted high-signal cards usually go top), continuity (don\'t yank items the user is mid-engagement with).',
  '- For threads, group only when grouping HELPS the user — 3-5 related items connected by a real angle. Title threads concretely (\'What changed in Iran today\', \'Your AI tool stack drift this week\'), not vaguely.',
  '- Use `displaySubtitle` SPARINGLY — only when a card\'s bump position isn\'t obvious. (\'Bumped to top: you opened the related Altman piece yesterday but didn\'t come back to this one.\')',
  '- Threads are LIVE current-cycle groupings. Deactivate threads that no longer have fresh material. Items can jump threads between cycles based on what the curator notices today.',
  '- No scoring formula. Decide each cycle based on engagement signals + freshness + your model of the user from USER.md.',
].join('\n');

if (!sourceFile || !targetFile) {
  throw new Error('Missing AGENTS source or target path.');
}

function stripExistingExplorationSection(content) {
  const headingIndex = content.indexOf(sectionHeading);
  if (headingIndex === -1) {
    return content.trimEnd();
  }
  return content.slice(0, headingIndex).trimEnd();
}

const baseContent = stripExistingExplorationSection(fs.readFileSync(sourceFile, 'utf8'));
fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, `${baseContent}\n\n${explorationSection}\n`, 'utf8');
NODE

  echo "Wrote AGENTS.md with Evogent exploration addendum:"
  echo "  $source_file -> $target_file"
}

mkdir -p "$agent_dir/sessions"

write_curator_agents_file "$repo_dir/data/curation-prompt.md" "$agent_dir/AGENTS.md"
copy_if_missing "$repo_dir/data/preferences-context.md" "$agent_dir/MEMORY.md" "MEMORY.md"
copy_overwrite "$repo_dir/data/preference-insights.md" "$agent_dir/USER.md" "USER.md"

OPENCLAW_CONFIG_PATH="$config_file" \
CURATOR_AGENT_DIR="$agent_dir" \
CURATOR_MODEL="$model_ref" \
CURATOR_RUNTIME_ID="$runtime_id" \
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const configPath = process.env.OPENCLAW_CONFIG_PATH;
const agentDir = process.env.CURATOR_AGENT_DIR;
const model = process.env.CURATOR_MODEL;
const runtimeId = process.env.CURATOR_RUNTIME_ID;
const agentId = 'curator';
const curatorToolPluginId = 'evogent-curator-tools';

if (!configPath || !agentDir || !model || !runtimeId) {
  throw new Error('Missing OpenClaw curator installer environment.');
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });

let config = {};
if (fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf8').trim()) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`Could not parse ${configPath} as JSON.`);
    console.error('Use OpenClaw doctor/config tooling to repair it, then rerun this installer.');
    throw error;
  }
}

if (!config || typeof config !== 'object' || Array.isArray(config)) {
  config = {};
}

config.agents = config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)
  ? config.agents
  : {};
config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];

let agent = config.agents.list.find((entry) => entry && typeof entry === 'object' && entry.id === agentId);
let action = 'unchanged';
if (!agent) {
  agent = { id: agentId };
  config.agents.list.push(agent);
  action = 'added';
}

const nextFields = {
  workspace: agentDir,
  agentDir,
  model,
};

for (const [key, value] of Object.entries(nextFields)) {
  if (agent[key] !== value) {
    agent[key] = value;
    if (action === 'unchanged') action = 'updated';
  }
}

const currentRuntime = agent.agentRuntime && typeof agent.agentRuntime === 'object' && !Array.isArray(agent.agentRuntime)
  ? agent.agentRuntime
  : {};
if (currentRuntime.id !== runtimeId) {
  agent.agentRuntime = { ...currentRuntime, id: runtimeId };
  if (action === 'unchanged') action = 'updated';
}

agent.tools = agent.tools && typeof agent.tools === 'object' && !Array.isArray(agent.tools)
  ? agent.tools
  : {};

if (Array.isArray(agent.tools.allow) && agent.tools.allow.length > 0) {
  if (!agent.tools.allow.includes(curatorToolPluginId)) {
    agent.tools.allow = [...agent.tools.allow, curatorToolPluginId];
    if (action === 'unchanged') action = 'updated';
  }
} else {
  const currentAlsoAllow = Array.isArray(agent.tools.alsoAllow) ? agent.tools.alsoAllow : [];
  if (!currentAlsoAllow.includes(curatorToolPluginId)) {
    agent.tools.alsoAllow = [...currentAlsoAllow, curatorToolPluginId];
    if (action === 'unchanged') action = 'updated';
  }
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`OpenClaw config ${action} for agent "${agentId}":`);
console.log(`  ${configPath}`);
console.log(`  model: ${model}`);
console.log(`  agentRuntime.id: ${runtimeId}`);
console.log(`  tools: ${curatorToolPluginId} allowed`);
NODE

cron_message=$(
  cat <<'EOF'
Run one Evogent curation cycle. Use evogent_browse_cache_query to inspect candidates, evogent_preferences_match to score them against memory, evogent_interactions_recent for recent feedback, and evogent_feed_submit to submit selected items to the live feed.
EOF
)

if ! command -v openclaw >/dev/null 2>&1; then
  cat <<EOF

OpenClaw CLI was not found on PATH, so the cron entry was not created.
Install or expose the OpenClaw CLI, then rerun this script. The curator files
and config entry are already present and will not be clobbered.
EOF
  exit 0
fi

cron_list_file="$(mktemp)"
cleanup() {
  rm -f "$cron_list_file"
}
trap cleanup EXIT

if openclaw cron list --json > "$cron_list_file" 2>/dev/null; then
  if existing_cron_id=$(CRON_LIST_FILE="$cron_list_file" CRON_NAME="$cron_name" node <<'NODE'
const fs = require('node:fs');
const file = process.env.CRON_LIST_FILE;
const cronName = process.env.CRON_NAME;
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
const jobs = Array.isArray(parsed)
  ? parsed
  : Array.isArray(parsed.jobs)
    ? parsed.jobs
    : parsed.jobs && typeof parsed.jobs === 'object'
      ? Object.values(parsed.jobs)
      : [];
const job = jobs.find((job) => {
  if (!job || typeof job !== 'object') return false;
  return job.name === cronName || job.id === 'evogent-curator' || job.jobId === 'evogent-curator';
});
if (!job) process.exit(1);
const id = [job.id, job.jobId].find((value) => typeof value === 'string' && value.trim())?.trim();
if (!id) process.exit(1);
console.log(id);
NODE
  ); then
    openclaw cron edit "$existing_cron_id" --cron "$cron_schedule" --no-deliver >/dev/null
    echo "OpenClaw cron entry already exists; disabled scheduler cadence and ensured silent delivery:"
    echo "  $cron_name ($cron_schedule)"
  else
    openclaw cron add \
      --name "$cron_name" \
      --cron "$cron_schedule" \
      --session isolated \
      --agent "$agent_id" \
      --no-deliver \
      --message "$cron_message"
    echo "Created OpenClaw cron entry:"
    echo "  $cron_name ($cron_schedule)"
  fi
else
  echo "Could not inspect OpenClaw cron list. Attempting to add the curator cron entry." >&2
  openclaw cron add \
    --name "$cron_name" \
    --cron "$cron_schedule" \
    --session isolated \
    --agent "$agent_id" \
    --no-deliver \
    --message "$cron_message"
fi

cat <<EOF

Installed OpenClaw curator agent:
  $agent_dir

Manual run:
  openclaw agent run --agent curator
EOF
