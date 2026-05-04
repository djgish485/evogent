#!/usr/bin/env bash
# Usage: run-research.sh <research-id> <agent-type>
# Reads prompt from $LOG_DIR/full-prompt.txt. Uses script(1) for PTY, with timeout.
set -euo pipefail

[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
unset CLAUDECODE 2>/dev/null || true

RESEARCH_ID="${1:?}"
AGENT_TYPE="${2:?}"

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/../.." && pwd)"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_ROOT/data/agent-state}"
mkdir -p "$STATE_DIR/logs"
source "$SCRIPTS_DIR/config"
source "$SCRIPTS_DIR/task-registry.sh"
[ -f "$STATE_DIR/env" ] && source "$STATE_DIR/env"

TASKS_FILE="$STATE_DIR/research-tasks.json"
LOG_DIR="$STATE_DIR/logs/research/${RESEARCH_ID}"
TIMEOUT_MINUTES=30
RAW_OUTPUT="${LOG_DIR}/output-raw.txt"
OUTPUT="${LOG_DIR}/output.txt"

PROMPT=$(cat "$LOG_DIR/full-prompt.txt" 2>/dev/null || echo "")
if [ -z "$PROMPT" ]; then
  echo "ERROR: No prompt at $LOG_DIR/full-prompt.txt"
  exit 1
fi

echo "=== Starting ${AGENT_TYPE} research for ${RESEARCH_ID} at $(date -u) ==="
echo "=== Timeout: ${TIMEOUT_MINUTES} minutes ==="

update_status() {
  local status="$1"
  local updated_at
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  jq --arg id "$RESEARCH_ID" --arg s "$status" --arg updated "$updated_at" '
    map(
      if .id == $id then
        .status = $s
        | .lastUpdatedAt = $updated
        | if ($s == "done" or $s == "failed" or $s == "timeout") then
            .completedAt = $updated
          else
            .
          end
      else
        .
      end
    )
  ' "$TASKS_FILE" \
    | prune_task_registry_json 50 '["running","needs-attention"]' '["done","failed","timeout"]' \
    > "${TASKS_FILE}.tmp" \
    && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
}

PROMPT_FILE="${LOG_DIR}/prompt-escaped.txt"
printf '%s' "$PROMPT" > "$PROMPT_FILE"

AGENT_EXIT=0
case "$AGENT_TYPE" in
  claude)
    script -q "$RAW_OUTPUT" -c "timeout ${TIMEOUT_MINUTES}m claude --model $CLAUDE_MODEL --allowedTools Bash Read Glob Grep WebFetch WebSearch -p \"\$(cat '$PROMPT_FILE')\"" || AGENT_EXIT=$?
    ;;
  codex)
    # codex exec -s danger-full-access (NOT --dangerously-bypass which loops)
    # --skip-git-repo-check: research doesn't need a repo context
    timeout ${TIMEOUT_MINUTES}m codex exec --model $CODEX_MODEL -c "model_reasoning_effort=${CODEX_REASONING}" -s danger-full-access --skip-git-repo-check "$(cat "$PROMPT_FILE")" > "$RAW_OUTPUT" 2>&1 || AGENT_EXIT=$?
    ;;
  gemini)
    # Gemini CLI is a TUI app (ink/React) — needs a PTY via script(1) or it gets SIGTTOU
    script -q "$RAW_OUTPUT" -c "timeout ${TIMEOUT_MINUTES}m gemini --model $GEMINI_MODEL -p \"\$(cat '$PROMPT_FILE')\"" || AGENT_EXIT=$?
    ;;
  *)
    echo "Unknown agent type: $AGENT_TYPE"
    exit 1
    ;;
esac

# Strip ANSI escape codes and script headers from raw output
python3 -c "
import re
text = open('$RAW_OUTPUT').read()
text = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', text)
text = re.sub(r'\x1b\][^\x07]*\x07?', '', text)
text = re.sub(r'\[<u[^\n]*', '', text)
text = re.sub(r'\]9;[^\n]*', '', text)
lines = [l for l in text.split('\n') if not l.startswith('Script started on') and not l.startswith('Script done on')]
open('$OUTPUT', 'w').write('\n'.join(lines).strip() + '\n')
" 2>/dev/null || cp "$RAW_OUTPUT" "$OUTPUT"

echo "=== Research finished at $(date -u) (exit code: $AGENT_EXIT) ==="

if [ "$AGENT_EXIT" -eq 124 ]; then
  echo "=== TIMED OUT after ${TIMEOUT_MINUTES} minutes ==="
  update_status "timeout"
  "$SCRIPTS_DIR/notify.sh" "Research Timeout" "Research ${RESEARCH_ID} timed out after ${TIMEOUT_MINUTES}min."
else
  update_status "done"
  "$SCRIPTS_DIR/notify.sh" "Research Complete" "Research ${RESEARCH_ID} finished. Log: ${OUTPUT}"
fi
