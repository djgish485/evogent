#!/usr/bin/env bash
# notify.sh — send a push notification via ntfy
# Usage: notify.sh "title" "message"
# Or:    notify.sh "message" (title defaults to "Claude Dev")

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/../.." && pwd)"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_ROOT/data/agent-state}"
mkdir -p "$STATE_DIR/logs"

source "$STATE_DIR/ntfy.conf"

TITLE="${1:-Claude Dev}"
MESSAGE="${2:-$1}"

if [ -z "$MESSAGE" ]; then
  echo "Usage: notify.sh [title] message"
  exit 1
fi

# If only one arg, use it as message with default title
if [ -z "$2" ]; then
  TITLE="Claude Dev"
  MESSAGE="$1"
fi

curl -s \
  -H "Title: $TITLE" \
  -H "Priority: default" \
  -H "Tags: robot" \
  -d "$MESSAGE" \
  "ntfy.sh/$NTFY_TOPIC" > /dev/null 2>&1
