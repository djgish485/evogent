#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
openclaw_home="${OPENCLAW_HOME:-$HOME/.openclaw}"
agent_id="curator"
agent_dir="$openclaw_home/agents/$agent_id"
config_file="${OPENCLAW_CONFIG_PATH:-$openclaw_home/openclaw.json}"
model_ref="${OPENCLAW_CURATOR_MODEL:-openai/gpt-5.5}"
runtime_id="${OPENCLAW_CURATOR_RUNTIME_ID:-codex}"
cron_name="${OPENCLAW_CURATOR_CRON_NAME:-Evogent shadow curator}"
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

mkdir -p "$agent_dir/sessions"

copy_if_missing "$repo_dir/data/curation-prompt.md" "$agent_dir/AGENTS.md" "AGENTS.md"
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

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`OpenClaw config ${action} for agent "${agentId}":`);
console.log(`  ${configPath}`);
console.log(`  model: ${model}`);
console.log(`  agentRuntime.id: ${runtimeId}`);
NODE

cron_message=$(
  cat <<'EOF'
Run one Evogent shadow curation cycle. Use evogent.browse_cache.query to inspect candidates, evogent.preferences.match to score them against memory, evogent.interactions.recent for recent feedback, and evogent.feed.submit to write selected items to the shadow log only. Do not call the live curate submit endpoint.
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
  if CRON_LIST_FILE="$cron_list_file" CRON_NAME="$cron_name" node <<'NODE'
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
const exists = jobs.some((job) => {
  if (!job || typeof job !== 'object') return false;
  return job.name === cronName || job.id === 'evogent-shadow-curator' || job.jobId === 'evogent-shadow-curator';
});
process.exit(exists ? 0 : 1);
NODE
  then
    echo "OpenClaw cron entry already exists; leaving it unchanged:"
    echo "  $cron_name"
  else
    openclaw cron add \
      --name "$cron_name" \
      --cron "$cron_schedule" \
      --session isolated \
      --agent "$agent_id" \
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
    --message "$cron_message"
fi

cat <<EOF

Installed OpenClaw curator agent in shadow mode:
  $agent_dir

Manual run:
  openclaw agent run --agent curator

Shadow output:
  $repo_dir/data/shadow-curator-log/$(date +%Y-%m-%d).jsonl
EOF
