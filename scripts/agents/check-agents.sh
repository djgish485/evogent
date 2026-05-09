#!/usr/bin/env bash
set -uo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
CANONICAL_SCRIPTS_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_ROOT="$(cd "$CANONICAL_SCRIPTS_DIR/../.." && pwd)"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_ROOT/data/agent-state}"
TASKS_FILE="${TASKS_FILE:-$STATE_DIR/active-tasks.json}"
MAX_ATTEMPTS=3

[ ! -f "$TASKS_FILE" ] && exit 0

read_mode_value() {
  local file="$1"
  local key="$2"
  awk -F: -v key="$key" '$0 ~ "^[[:space:]]*" key "[[:space:]]*:" { value=$2; sub(/#.*/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); gsub(/^["\047]|["\047]$/, "", value); print value; exit }' "$file" 2>/dev/null || true
}

echo "=== Agent check at $(date -u) ==="

jq -c '.[] | select(.status == "running")' "$TASKS_FILE" 2>/dev/null | while read -r task; do
  TASK_ID=$(echo "$task" | jq -r '.id')
  TMUX_SESSION=$(echo "$task" | jq -r '.tmux')
  WORKTREE=$(echo "$task" | jq -r '.worktree // empty')
  ATTEMPTS=$(echo "$task" | jq -r '.attempts')

  # Fallback worktree for old entries
  [ -z "$WORKTREE" ] && WORKTREE="/root/the-algo-worktrees/${TASK_ID}"

  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    if [ -f "${WORKTREE}/.agent-done" ]; then
      PIPELINE=$(echo "$task" | jq -r '.pipeline // "none"')
      echo "${TASK_ID}: Agent done, pipeline=$PIPELINE"
      case "$PIPELINE" in
        full)
          bash "$SCRIPTS_DIR/validate.sh" "$TASK_ID"
          ;;
        merge)
          REPO_DIR=$(echo "$task" | jq -r '.repoDir // "/root/the-algo"')
          LOG_DIR="$STATE_DIR/logs/agent/${TASK_ID}"
          FINALIZE_MERGE="$CANONICAL_SCRIPTS_DIR/finalize-merge.sh"
          ADDON_MODE_FILE="$REPO_DIR/.evogent-mode.md"
          [ -f "$ADDON_MODE_FILE" ] || ADDON_MODE_FILE="$REPO_DIR/.claude/dev-agent-addon.md"
          TASK_MERGE_TARGET="${MERGE_TARGET:-$(read_mode_value "$ADDON_MODE_FILE" mergeTarget)}"
          [ -n "$TASK_MERGE_TARGET" ] || TASK_MERGE_TARGET="main"
          MERGE_REMOTE_REF="origin/$TASK_MERGE_TARGET"
          cd "$REPO_DIR"
          if ! git fetch origin "$TASK_MERGE_TARGET"; then
            echo "ERROR: mergeTarget ${TASK_MERGE_TARGET} has no ${MERGE_REMOTE_REF} ref - create it on origin first or push manually"
            jq --arg id "$TASK_ID" '(.[] | select(.id == $id)).status = "failed"' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
            "$SCRIPTS_DIR/notify.sh" "Task Failed" "Task ${TASK_ID} merge target ${TASK_MERGE_TARGET} was not found on origin."
            continue
          fi
          git checkout "$TASK_MERGE_TARGET" && git reset --hard "$MERGE_REMOTE_REF"

          if [ -x "$FINALIZE_MERGE" ]; then
            if REPO_DIR="$REPO_DIR" TASKS_FILE="$TASKS_FILE" LOG_DIR="$LOG_DIR" MERGE_BRANCH="$TASK_ID" MERGE_TARGET="$TASK_MERGE_TARGET" RECEIPT_REQUIRED=1 bash "$FINALIZE_MERGE" "$TASK_ID"; then
              jq --arg id "$TASK_ID" '(.[] | select(.id == $id)).status = "done"' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
              "$SCRIPTS_DIR/notify.sh" "Task Complete" "Task ${TASK_ID} merged and pushed to ${TASK_MERGE_TARGET}."
            else
              jq --arg id "$TASK_ID" '(.[] | select(.id == $id)).status = "failed"' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
              "$SCRIPTS_DIR/notify.sh" "Task Failed" "Task ${TASK_ID} merge failed."
            fi
          else
            if git merge --no-ff "$TASK_ID" -m "merge: ${TASK_ID}"; then
              git push origin "$TASK_MERGE_TARGET"
              jq --arg id "$TASK_ID" '(.[] | select(.id == $id)).status = "done"' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
              "$SCRIPTS_DIR/notify.sh" "Task Complete" "Task ${TASK_ID} merged and pushed to ${TASK_MERGE_TARGET}."
            else
              jq --arg id "$TASK_ID" '(.[] | select(.id == $id)).status = "failed"' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
              "$SCRIPTS_DIR/notify.sh" "Task Failed" "Task ${TASK_ID} merge failed."
            fi
          fi
          ;;
        *)
          jq --arg id "$TASK_ID" '(.[] | select(.id == $id)).status = "done"' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
          "$SCRIPTS_DIR/notify.sh" "Task Done" "Task ${TASK_ID} complete. Review and merge manually."
          ;;
      esac
    elif [ "$ATTEMPTS" -lt "$MAX_ATTEMPTS" ]; then
      echo "${TASK_ID}: Session dead, respawning (attempt $((ATTEMPTS + 1)))"
      AGENT=$(echo "$task" | jq -r '.agent')
      NEW_ATTEMPTS=$((ATTEMPTS + 1))
      jq --arg id "$TASK_ID" --argjson a "$NEW_ATTEMPTS" \
        '(.[] | select(.id == $id)).attempts = $a' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
      # run-agent.sh reads prompt from file — only pass task ID and agent type
      tmux new-session -d -s "$TMUX_SESSION" -c "$WORKTREE" \
        "bash $SCRIPTS_DIR/run-agent.sh '${TASK_ID}' '${AGENT}'"
    else
      echo "${TASK_ID}: Max attempts reached, marking needs-attention"
      jq --arg id "$TASK_ID" \
        '(.[] | select(.id == $id)).status = "needs-attention"' "$TASKS_FILE" > "${TASKS_FILE}.tmp" && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
      "$SCRIPTS_DIR/notify.sh" "Needs Attention" "Task ${TASK_ID} failed after ${MAX_ATTEMPTS} attempts"
    fi
  else
    echo "${TASK_ID}: Still running"
  fi
done

# Kill leaked Chrome processes if using >2GB memory (prevents OOM)
CHROME_MEM_KB=$(ps aux | grep "chrome.*twitter-profile" | grep -v grep | awk '{sum+=$6} END {print sum+0}')
CHROME_MEM_MB=$((CHROME_MEM_KB / 1024))
if [ "$CHROME_MEM_MB" -gt 2048 ]; then
  CHROME_COUNT=$(pgrep -f "chrome.*twitter-profile" 2>/dev/null | wc -l)
  echo "$(date -u): Chrome leak: $CHROME_COUNT processes, ${CHROME_MEM_MB}MB — restarting"
  pkill -f "chrome.*twitter-profile" 2>/dev/null || true
  sleep 2
  nohup google-chrome --headless --no-sandbox --remote-debugging-port=9222     --user-data-dir=/root/.config/chrome-twitter-profile/     --disable-gpu --ozone-platform=headless --noerrdialogs     > /dev/null 2>&1 &
fi
