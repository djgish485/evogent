#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: sync.sh <username> [limit]" >&2
  exit 1
fi

USER_NAME="$1"
LIMIT="${2:-15}"
BIRD="node node_modules/@steipete/bird/dist/cli.js"

$BIRD user-tweets "$USER_NAME" -n "$LIMIT" --json
