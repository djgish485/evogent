#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_dir="$repo_dir/plugins/openclaw-curator-tools"
openclaw_home="${OPENCLAW_HOME:-$HOME/.openclaw}"
plugin_tools_dir="$openclaw_home/plugin-tools"
target="$plugin_tools_dir/curator-tools"

if [[ ! -d "$openclaw_home" ]]; then
  echo "OpenClaw home not found: $openclaw_home" >&2
  exit 1
fi

if [[ ! -d "$plugin_dir" ]]; then
  echo "Evogent OpenClaw curator tools plugin not found: $plugin_dir" >&2
  exit 1
fi

mkdir -p "$plugin_tools_dir"

if [[ -L "$target" ]]; then
  current_target="$(readlink "$target")"
  if [[ "$current_target" == "$plugin_dir" ]]; then
    echo "Evogent OpenClaw curator tools already installed:"
    echo "  $target -> $plugin_dir"
  else
    rm -f "$target"
    ln -s "$plugin_dir" "$target"
    echo "Updated Evogent OpenClaw curator tools symlink:"
    echo "  $target -> $plugin_dir"
  fi
elif [[ -e "$target" ]]; then
  echo "Target already exists and is not a symlink: $target" >&2
  echo "Move it aside and rerun this installer." >&2
  exit 1
else
  ln -s "$plugin_dir" "$target"
  echo "Installed Evogent OpenClaw curator tools:"
  echo "  $target -> $plugin_dir"
fi

cat <<EOF

Next steps:
  1. Restart OpenClaw so it discovers openclaw.plugin.json.
  2. Run scripts/install-openclaw-curator-agent.sh to seed the curator agent and cron entry.
  3. Keep MEDIA_AGENT_INTERNAL_BASE_URL exported for OpenClaw if Evogent is not on http://127.0.0.1:3001.
EOF
