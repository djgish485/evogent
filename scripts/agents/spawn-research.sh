#!/usr/bin/env bash
# Usage: spawn-research.sh <prompt> [id] [agent-type]
# Spawns a research agent in a tmux session with streaming output and timeout.
set -euo pipefail

PROMPT="${1:?Usage: spawn-research.sh <prompt> [id] [agent-type]}"
CUSTOM_ID="${2:-}"
AGENT_TYPE="${3:-}"

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/../.." && pwd)"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_ROOT/data/agent-state}"
mkdir -p "$STATE_DIR/logs"
source "$SCRIPTS_DIR/config"
source "$SCRIPTS_DIR/task-registry.sh"

# If CUSTOM_ID is actually an agent type (and no agent type was given), swap them
if [ -z "$AGENT_TYPE" ] && [[ "$CUSTOM_ID" =~ ^(claude|codex|gemini)$ ]]; then
  AGENT_TYPE="$CUSTOM_ID"
  CUSTOM_ID=""
fi

[ -z "$AGENT_TYPE" ] && AGENT_TYPE="$DEFAULT_AGENT"

if [ -n "$CUSTOM_ID" ]; then
  RESEARCH_ID="$CUSTOM_ID"
else
  RESEARCH_ID="research-$(date +%Y%m%d-%H%M%S)"
fi
TMUX_SESSION="research-${RESEARCH_ID#research-}"
PARENT_SESSION=$(tmux display-message -p '#S' 2>/dev/null || echo "")
LOG_DIR="$STATE_DIR/logs/research/${RESEARCH_ID}"
TASKS_FILE="$STATE_DIR/research-tasks.json"

mkdir -p "$LOG_DIR"
[ ! -f "$TASKS_FILE" ] && echo '[]' > "$TASKS_FILE"

# Write prompt to file
cat > "${LOG_DIR}/full-prompt.txt" << 'PROMPT_DELIM'
You are a READ-ONLY research agent. Investigate thoroughly and provide a comprehensive analysis.

IMPORTANT CONSTRAINTS:
- Do NOT modify, create, or delete any files
- Do NOT install packages, run builds, or make any changes to the system
- Do NOT edit code, configs, or documentation
- ONLY use read-only operations: reading files, searching code, web searches, git log/diff
- If you need to run a bash command, it must be read-only (e.g. git log, ls, cat, curl GET)
- Your job is to research and report findings, not to implement changes


AFTER completing your research, you MUST submit your report as a feed item. Do not ask — just do it.
Use curl POST to the app's internal API. The base URL is the MEDIA_AGENT_INTERNAL_BASE_URL env var
if set, otherwise http://localhost:3001. This is the expected output path, not a system modification.

Submit to: POST $BASE_URL/api/internal/curate/submit
Example:
curl -X POST "$BASE_URL/api/internal/curate/submit" \
  -H 'Content-Type: application/json' \
  -d '{"items": [{"type": "analysis", "id": "research-<id>-<epoch-ms>", "title": "...", "text": "<full markdown article>", "publishedAt": "<ISO8601>", "source": "research", "tags": ["research"], "originSessionId": "<if-provided>", "reason": "..."}]}'
Body: {"items": [{"type": "analysis", "id": "research-<descriptive-kebab-id>", "title": "<concise title>",
  "text": "<full report text>", "publishedAt": "<current ISO8601>", "source": "research",
  "authorUsername": "evogent", "authorDisplayName": "Evogent Research",
  "reason": "<one-line summary of what was researched>"}]}
Always include originSessionId if provided in the prompt.
PROMPT_DELIM
printf '%s\n' "$PROMPT" >> "${LOG_DIR}/full-prompt.txt"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Register task
TASK_JSON=$(jq -n \
  --arg id "$RESEARCH_ID" \
  --arg agent "$AGENT_TYPE" \
  --arg desc "$PROMPT" \
  --arg log "$LOG_DIR" \
  --arg tmux "$TMUX_SESSION" \
  --arg parent "$PARENT_SESSION" \
  --arg started "$STARTED_AT" \
  '{id:$id, agent:$agent, description:$desc, logDir:$log, tmux:$tmux, parentSession:$parent, startedAt:$started, lastUpdatedAt:$started, completedAt:null, status:"running"}')
jq --argjson task "$TASK_JSON" '. + [$task]' "$TASKS_FILE" \
  | prune_task_registry_json 50 '["running","needs-attention"]' '["done","failed","timeout"]' \
  > "${TASKS_FILE}.tmp" \
  && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"

# Launch in tmux — visible, attachable, with timeout
# Pass through env overrides (e.g. CODEX_REASONING=xhigh)
ENV_EXPORTS=""
[ -n "${CODEX_REASONING:-}" ] && ENV_EXPORTS="export CODEX_REASONING='${CODEX_REASONING}'; "
tmux new-session -d -s "$TMUX_SESSION" \
  "${ENV_EXPORTS}bash $SCRIPTS_DIR/run-research.sh '${RESEARCH_ID}' '${AGENT_TYPE}'"

echo "Spawned research in tmux session: $TMUX_SESSION"
echo "  Research ID: $RESEARCH_ID"
echo "  Agent: $AGENT_TYPE"
echo "  Log: $LOG_DIR/output.txt"
echo "  Watch: tmux attach -t $TMUX_SESSION"
