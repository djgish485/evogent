#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_dir="$repo_dir/plugins/openclaw-curator-tools"
openclaw_home="${OPENCLAW_HOME:-$HOME/.openclaw}"

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

cat <<EOF

Next steps:
  1. Restart OpenClaw so the gateway loads evogent-curator-tools.
  2. Confirm it is enabled with: openclaw plugins list | grep -i evogent-curator-tools
  3. Run scripts/install-openclaw-curator-agent.sh to seed the curator agent and cron entry.
  4. Keep MEDIA_AGENT_INTERNAL_BASE_URL exported for OpenClaw if Evogent is not on http://127.0.0.1:3001.
EOF
