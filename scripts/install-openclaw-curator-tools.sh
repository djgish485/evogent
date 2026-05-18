#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_dir="$repo_dir/plugins/openclaw-curator-tools"
openclaw_home="${OPENCLAW_HOME:-$HOME/.openclaw}"
config_file="${OPENCLAW_CONFIG_PATH:-$openclaw_home/openclaw.json}"

if [[ ! -d "$openclaw_home" ]]; then
  echo "OpenClaw home not found: $openclaw_home" >&2
  exit 1
fi

if [[ ! -d "$plugin_dir" ]]; then
  echo "Evogent OpenClaw curator tools plugin not found: $plugin_dir" >&2
  exit 1
fi

if ! command -v openclaw >/dev/null 2>&1; then
  echo "OpenClaw CLI not found in PATH. Install OpenClaw or add it to PATH and rerun this installer." >&2
  exit 1
fi

openclaw plugins install "$plugin_dir"

OPENCLAW_CONFIG_PATH="$config_file" node <<'NODE'
const fs = require('node:fs');

const configPath = process.env.OPENCLAW_CONFIG_PATH;
const agentId = 'curator';
const curatorToolPluginId = 'evogent-curator-tools';

if (!configPath || !fs.existsSync(configPath) || !fs.readFileSync(configPath, 'utf8').trim()) {
  process.exit(0);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error(`Could not parse ${configPath} as JSON.`);
  console.error('Use OpenClaw doctor/config tooling to repair it, then rerun this installer.');
  throw error;
}

const agents = config && typeof config === 'object' && !Array.isArray(config)
  ? config.agents
  : null;
const agentList = agents && typeof agents === 'object' && !Array.isArray(agents) && Array.isArray(agents.list)
  ? agents.list
  : [];
const agent = agentList.find((entry) => entry && typeof entry === 'object' && entry.id === agentId);

if (!agent) {
  console.log(`OpenClaw curator agent is not configured yet; scripts/install-openclaw-curator-agent.sh will grant ${curatorToolPluginId}.`);
  process.exit(0);
}

agent.tools = agent.tools && typeof agent.tools === 'object' && !Array.isArray(agent.tools)
  ? agent.tools
  : {};

let changed = false;
if (Array.isArray(agent.tools.allow) && agent.tools.allow.length > 0) {
  if (!agent.tools.allow.includes(curatorToolPluginId)) {
    agent.tools.allow = [...agent.tools.allow, curatorToolPluginId];
    changed = true;
  }
} else {
  const currentAlsoAllow = Array.isArray(agent.tools.alsoAllow) ? agent.tools.alsoAllow : [];
  if (!currentAlsoAllow.includes(curatorToolPluginId)) {
    agent.tools.alsoAllow = [...currentAlsoAllow, curatorToolPluginId];
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`Updated OpenClaw curator agent tool allowlist: ${curatorToolPluginId}`);
} else {
  console.log(`OpenClaw curator agent already allows ${curatorToolPluginId}.`);
}
NODE

cat <<EOF

Next steps:
  1. Restart OpenClaw so the gateway loads evogent-curator-tools.
  2. Confirm it is enabled with: openclaw plugins list | grep -i evogent-curator-tools
  3. Run scripts/install-openclaw-curator-agent.sh to seed the curator agent and cron entry.
  4. Keep MEDIA_AGENT_INTERNAL_BASE_URL exported for OpenClaw if Evogent is not on http://127.0.0.1:3001.
EOF
