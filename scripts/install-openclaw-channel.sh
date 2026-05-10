#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_dir="$repo_dir/plugins/openclaw-channel"
openclaw_home="${OPENCLAW_HOME:-$HOME/.openclaw}"
channels_dir="$openclaw_home/channels"
target="$channels_dir/evogent"

if [[ ! -d "$openclaw_home" ]]; then
  echo "OpenClaw home not found: $openclaw_home" >&2
  exit 1
fi

if [[ ! -d "$plugin_dir" ]]; then
  echo "Evogent OpenClaw channel plugin not found: $plugin_dir" >&2
  exit 1
fi

mkdir -p "$channels_dir"
ln -sfn "$plugin_dir" "$target"

cat <<EOF
Installed Evogent OpenClaw channel:
  $target -> $plugin_dir

Next steps:
  1. Add channels: [evogent] to the OpenClaw skill configs that should publish to Evogent.
  2. Restart OpenClaw.
  3. Run a skill. Bundles with output.md, output.a2ui.json, and output.mcpapp.html will appear as adjacent Evogent cards.
EOF
