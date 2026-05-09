#!/usr/bin/env bash
# Usage: spawn-agent.sh <task-id> [agent-type] <prompt> [--repo DIR] [--worktree-base DIR] [--pipeline full|merge|none]
# Defaults: agent-type from config, --repo from cwd git root, --worktree-base <repo>-worktrees, --pipeline merge
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/../.." && pwd)"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_ROOT/data/agent-state}"
mkdir -p "$STATE_DIR/logs"
source "$SCRIPTS_DIR/config"

# Parse positional args
TASK_ID="${1:?Usage: spawn-agent.sh <task-id> [agent-type] <prompt> [--repo DIR] [--worktree-base DIR] [--pipeline full|none]}"
shift

# Check if next arg is agent type or prompt (agent types are short known words)
case "${1:-}" in
  claude|codex|gemini) AGENT_TYPE="$1"; shift ;;
  *) AGENT_TYPE="$DEFAULT_AGENT" ;;
esac

PROMPT="${1:?Prompt required}"
shift || true

# Parse optional flags
REPO_DIR=""
WORKTREE_BASE=""
PIPELINE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_DIR="$2"; shift 2 ;;
    --worktree-base) WORKTREE_BASE="$2"; shift 2 ;;
    --pipeline) PIPELINE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Default --repo to current git root
if [ -z "$REPO_DIR" ]; then
  REPO_DIR=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  if [ -z "$REPO_DIR" ]; then
    echo "ERROR: Not in a git repo and --repo not specified"
    exit 1
  fi
fi

# Auto-detect pipeline from project's .claude/pipeline file if not explicitly set
if [ -z "$PIPELINE" ]; then
  if [ -f "$REPO_DIR/.claude/pipeline" ]; then
    PIPELINE=$(cat "$REPO_DIR/.claude/pipeline" | tr -d '[:space:]')
  else
    PIPELINE="merge"
  fi
fi

# Default --worktree-base to <repo>-worktrees
if [ -z "$WORKTREE_BASE" ]; then
  WORKTREE_BASE="${REPO_DIR}-worktrees"
fi

WORKTREE_DIR="${WORKTREE_BASE}/${TASK_ID}"
TMUX_SESSION="agent-${TASK_ID}"
PARENT_SESSION=$(tmux display-message -p '#S' 2>/dev/null || echo "")
TASKS_FILE="$STATE_DIR/active-tasks.json"
LOG_DIR="$STATE_DIR/logs/agent/${TASK_ID}"

# Validate task doesn't already exist
if [ -f "$TASKS_FILE" ] && jq -e --arg id "$TASK_ID" '.[] | select(.id == $id)' "$TASKS_FILE" >/dev/null 2>&1; then
  echo "ERROR: Task $TASK_ID already exists"
  exit 1
fi


# ==================== GUARDS (defense in depth) ====================

# Guard 1: Spawn depth — blocks recursive calls from dev agents
SPAWN_DEPTH="${MEDIA_AGENT_SPAWN_DEPTH:-0}"
if [ "$SPAWN_DEPTH" -gt 0 ]; then
  echo "ERROR: Recursive spawn blocked (MEDIA_AGENT_SPAWN_DEPTH=$SPAWN_DEPTH)"
  exit 1
fi

# Guard 2: Max concurrent agents
MAX_AGENTS="${MEDIA_AGENT_MAX_AGENTS:-4}"
ACTIVE_COUNT=$(jq "[.[] | select(.status == "running")] | length" "$TASKS_FILE" 2>/dev/null || echo "0")
if [ "$ACTIVE_COUNT" -ge "$MAX_AGENTS" ]; then
  echo "ERROR: Max concurrent agents ($MAX_AGENTS) reached. Active: $ACTIVE_COUNT"
  exit 1
fi

# Guard 3: Nesting detection — refuse if called from inside a worktree
if [ -f "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/.git" ]; then
  CUR_TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
  if [ -n "$CUR_TOPLEVEL" ] && [ "$CUR_TOPLEVEL" != "$REPO_DIR" ]; then
    echo "ERROR: Spawn blocked — called from inside a worktree ($CUR_TOPLEVEL)"
    exit 1
  fi
fi

# ==================== END GUARDS ====================

# Create worktree
mkdir -p "$WORKTREE_BASE"
cd "$REPO_DIR"
ADDON_MODE_FILE="$REPO_DIR/.evogent-mode.md"
[ -f "$ADDON_MODE_FILE" ] || ADDON_MODE_FILE="$REPO_DIR/.claude/dev-agent-addon.md"
read_addon_value() {
  awk -F: -v key="$1" '$0 ~ "^[[:space:]]*" key "[[:space:]]*:" { value=$2; sub(/#.*/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); gsub(/^["\047]|["\047]$/, "", value); print value; exit }' "$ADDON_MODE_FILE" 2>/dev/null || true
}
ADDON_MODE=$(read_addon_value mode)
[ -n "$ADDON_MODE" ] || ADDON_MODE="suggestion-remote"
MERGE_TARGET="${MERGE_TARGET:-$(read_addon_value mergeTarget)}"
[ -n "$MERGE_TARGET" ] || MERGE_TARGET="main"
case "$ADDON_MODE" in
  suggestion-remote)
    git fetch origin "$MERGE_TARGET"
    git worktree add "$WORKTREE_DIR" -b "$TASK_ID" "origin/$MERGE_TARGET"
    ;;
  suggestion-local)
    git worktree add "$WORKTREE_DIR" -b "$TASK_ID" "$MERGE_TARGET"
    ;;
  direct)
    echo "ERROR: direct mode does not dispatch dev agents; edit files directly in the chat working directory"
    exit 1
    ;;
  *)
    echo "ERROR: Invalid $ADDON_MODE_FILE mode: $ADDON_MODE"
    exit 1
    ;;
esac

# Copy .env.local if it exists in the repo
[ -f "$REPO_DIR/.env.local" ] && cp "$REPO_DIR/.env.local" "$WORKTREE_DIR/.env.local"

# Install deps if package.json exists
if [ -f "$WORKTREE_DIR/package.json" ]; then
  cd "$WORKTREE_DIR"
  npm install --prefer-offline 2>/dev/null || true
fi

# Create log directory and write prompt to file (avoids tmux quoting issues)
mkdir -p "$LOG_DIR"
printf '%s\n' "$PROMPT" > "$LOG_DIR/prompt-input.txt"

# Register task
mkdir -p "$(dirname "$TASKS_FILE")"
[ ! -f "$TASKS_FILE" ] && echo '[]' > "$TASKS_FILE"

# Determine reasoning level for the task registry
REASONING_LEVEL=""
[ "$AGENT_TYPE" = "codex" ] && REASONING_LEVEL="${CODEX_REASONING:-high}"

TASK_JSON=$(jq -n \
  --arg id "$TASK_ID" \
  --arg agent "$AGENT_TYPE" \
  --arg desc "$PROMPT" \
  --arg worktree "$WORKTREE_DIR" \
  --arg branch "$TASK_ID" \
  --arg tmux "$TMUX_SESSION" \
  --arg repo "$REPO_DIR" \
  --arg pipeline "$PIPELINE" \
  --arg parent "$PARENT_SESSION" \
  --arg reasoning "$REASONING_LEVEL" \
  --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{id:$id, agent:$agent, description:$desc, worktree:$worktree, branch:$branch, tmux:$tmux, parentSession:$parent, repoDir:$repo, pipeline:$pipeline, reasoning:$reasoning, startedAt:$started, status:"running", attempts:1}')

jq --argjson task "$TASK_JSON" '. += [$task]' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"

# Launch in tmux — only pass task ID and agent type; prompt is read from file
# Pass through env overrides (e.g. CODEX_REASONING=xhigh, CODEX_FAST_MODE=0) so run-agent.sh picks them up
ENV_EXPORTS=""
[ -n "${CODEX_REASONING:-}" ] && ENV_EXPORTS="export CODEX_REASONING='${CODEX_REASONING}'; "
[ -n "${CODEX_FAST_MODE:-}" ] && ENV_EXPORTS="${ENV_EXPORTS}export CODEX_FAST_MODE='${CODEX_FAST_MODE}'; "
ENV_EXPORTS="${ENV_EXPORTS}export MERGE_TARGET='${MERGE_TARGET}'; "
tmux new-session -d -s "$TMUX_SESSION" -c "$WORKTREE_DIR" \
  "${ENV_EXPORTS}bash $SCRIPTS_DIR/run-agent.sh '${TASK_ID}' '${AGENT_TYPE}'"

echo "Spawned $TMUX_SESSION ($AGENT_TYPE) in tmux session"
echo "  Worktree: $WORKTREE_DIR"
echo "  Pipeline: $PIPELINE"
echo "  Logs: $LOG_DIR"
echo "  tmux attach: tmux attach -t $TMUX_SESSION"
