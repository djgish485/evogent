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
cron_schedule="${OPENCLAW_CURATOR_CRON:-*/30 * * * *}"

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
  'At the start of each cycle, after pulling content candidates from the browse cache:',
  '',
  '1. Call `evogent_skill_runs_list` to see what OpenClaw skills have produced recently (daily-brief, competitor-watch, email-triage, gh-issues, research-clipping, etc.). For any that look promising, call `evogent_skill_runs_read` to inspect the content. Rank these candidates alongside the cache candidates — don\'t auto-include them, decide what\'s worth surfacing.',
  '',
  '2. Occasionally (not every cycle), use `evogent_chat_history_search` to look for:',
  '   - **Promised follow-ups**: terms like "I\'ll send", "will do", "let me get back". If the user committed to doing something more than 3 days ago and hasn\'t, surface a card.',
  '   - **Open questions the user raised**: things like "will Hermes ship #11712?" or "is X going to happen?" — and check if anything in today\'s cache or news answers it.',
  '   - **Topics under active discussion**: search for recent themes from chat (e.g., "OpenClaw", "Codex", whatever the user has been engaging with), then look in the cache for related items the user would want.',
  '',
  '3. Beyond skills and chat, use your existing tools (web_search, web_fetch, bash) for ad-hoc enrichment when an item is interesting but underspecified. Cross-source observations are valuable: a tweet + an HN comment + an email receipt that together tell a story no single source tells.',
  '',
  '4. Surface SPARSE high-signal items in this category (typically 1-3 per cycle). The standard content stream is the main thing; these are the bonus signal that makes the feed feel personal rather than generic.',
  '',
  '5. Tag any skill-output card you ship with `metadata.source: "openclaw"` so it renders as the rich OpenClaw card type. Tag any cross-source observation card with `metadata.source: "chat-curator"` and `metadata.kind: "observation"` so we can distinguish it.',
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
copy_if_missing "$repo_dir/data/preference-insights.md" "$agent_dir/USER.md" "USER.md"

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
    openclaw cron edit "$existing_cron_id" --no-deliver >/dev/null
    echo "OpenClaw cron entry already exists; ensured silent delivery:"
    echo "  $cron_name"
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
