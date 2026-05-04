#!/usr/bin/env bash
# Usage: run-agent.sh <task-id> <agent-type> [prompt]
# If prompt is omitted, reads from $LOG_DIR/prompt-input.txt (preferred — avoids quoting issues).
# Sources model config from the scripts directory and optional secrets from STATE_DIR/env.
set -euo pipefail

[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"

TASK_ID="${1:?}"
AGENT_TYPE="${2:?}"

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/../.." && pwd)"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_ROOT/data/agent-state}"
mkdir -p "$STATE_DIR/logs"
source "$SCRIPTS_DIR/config"
[ -f "$STATE_DIR/env" ] && source "$STATE_DIR/env"
source "$SCRIPTS_DIR/receipt-helpers.sh"

TASKS_FILE="$STATE_DIR/active-tasks.json"
LOG_DIR="$STATE_DIR/logs/agent/${TASK_ID}"
mkdir -p "$LOG_DIR"
MAX_ATTEMPTS="${AGENT_MAX_ATTEMPTS:-3}"
AGENT_LOG_FILE="${LOG_DIR}/agent.log"
AGENT_LOG_MAX_BYTES="${AGENT_LOG_MAX_BYTES:-94371840}"
AGENT_LOG_TRIM_BYTES="${AGENT_LOG_TRIM_BYTES:-78643200}"
AGENT_LOG_MONITOR_INTERVAL_SEC="${AGENT_LOG_MONITOR_INTERVAL_SEC:-15}"
clear_validation_result "$STATE_DIR" "$TASK_ID"

trim_agent_log() {
  local log_file="$1"
  local keep_bytes="$2"
  local tmp_file

  tmp_file="$(mktemp "${log_file}.trim.XXXXXX")"
  {
    printf '=== agent.log trimmed at %s UTC; keeping the last %s bytes ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$keep_bytes"
    tail -c "$keep_bytes" "$log_file" 2>/dev/null || true
  } > "$tmp_file"
  cat "$tmp_file" > "$log_file"
  rm -f "$tmp_file"
}

monitor_agent_log_size() {
  local log_file="$1"
  local max_bytes="$2"
  local trim_bytes="$3"
  local interval_seconds="$4"
  local current_size

  while sleep "$interval_seconds"; do
    [ -f "$log_file" ] || continue
    current_size="$(wc -c < "$log_file" 2>/dev/null || echo 0)"
    if [ "$current_size" -le "$max_bytes" ]; then
      continue
    fi
    trim_agent_log "$log_file" "$trim_bytes"
  done
}

cleanup_log_monitor() {
  if [ -n "${LOG_MONITOR_PID:-}" ] && kill -0 "$LOG_MONITOR_PID" 2>/dev/null; then
    kill "$LOG_MONITOR_PID" 2>/dev/null || true
    wait "$LOG_MONITOR_PID" 2>/dev/null || true
  fi
}

read_retry_prompt() {
  local prompt_input_file="$1/prompt-input.txt"
  local prompt_file="$1/prompt.txt"

  if [ -s "$prompt_input_file" ]; then
    cat "$prompt_input_file"
    return 0
  fi

  if [ -s "$prompt_file" ]; then
    if grep -qx 'TASK:' "$prompt_file"; then
      awk 'found { print } /^TASK:$/ { found=1; next }' "$prompt_file"
    else
      cat "$prompt_file"
    fi
    return 0
  fi

  return 1
}

task_attempts() {
  local attempts

  attempts="$(jq -r --arg id "$1" '.[] | select(.id == $id) | .attempts // empty' "$TASKS_FILE" 2>/dev/null)"
  if [ -z "$attempts" ] || [ "$attempts" = "null" ]; then
    printf '1\n'
  else
    printf '%s\n' "$attempts"
  fi
}

update_task_attempts() {
  jq --arg id "$1" --argjson attempts "$2" \
    '(.[] | select(.id == $id)).attempts = $attempts' "$TASKS_FILE" > "${TASKS_FILE}.tmp" \
    && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
}

retry_task_id() {
  local current_id="$1"
  local next_attempt="$2"
  local base_id="$current_id"

  if [[ "$current_id" =~ ^(.+)-v[0-9]+$ ]]; then
    base_id="${BASH_REMATCH[1]}"
  fi

  printf '%s-v%s\n' "$base_id" "$next_attempt"
}

cleanup_retry_task() {
  local repo_dir="$1"
  local worktree="$2"

  if [ -n "$worktree" ] && [ -d "$worktree" ]; then
    git -C "$repo_dir" worktree remove "$worktree" --force 2>/dev/null || rm -rf "$worktree" 2>/dev/null || true
  fi
}

# Read prompt: from arg if provided, otherwise from file
if [ -n "${3:-}" ]; then
  PROMPT="$3"
else
  PROMPT=$(cat "$LOG_DIR/prompt-input.txt" 2>/dev/null || echo "")
  if [ -z "$PROMPT" ]; then
    echo "ERROR: No prompt provided and $LOG_DIR/prompt-input.txt not found"
    exit 1
  fi
fi

# Read worktree and pipeline from task registry
WORKTREE=$(jq -r --arg id "$TASK_ID" '.[] | select(.id == $id) | .worktree // empty' "$TASKS_FILE" 2>/dev/null)
PIPELINE=$(jq -r --arg id "$TASK_ID" '.[] | select(.id == $id) | .pipeline // "none"' "$TASKS_FILE" 2>/dev/null)

[ -z "$PIPELINE" ] && PIPELINE="none"

[ -z "$WORKTREE" ] && { echo "ERROR: Missing worktree for task $TASK_ID in $TASKS_FILE"; exit 1; }

touch "$AGENT_LOG_FILE"
monitor_agent_log_size "$AGENT_LOG_FILE" "$AGENT_LOG_MAX_BYTES" "$AGENT_LOG_TRIM_BYTES" "$AGENT_LOG_MONITOR_INTERVAL_SEC" &
LOG_MONITOR_PID=$!
trap cleanup_log_monitor EXIT

exec > >(tee -a "$AGENT_LOG_FILE") 2>&1

cd "$WORKTREE"

# Resolve repo directory (needed for live URL detection and post-agent pipeline)
REPO_DIR=$(jq -r --arg id "$TASK_ID" '.[] | select(.id == $id) | .repoDir // empty' "$TASKS_FILE" 2>/dev/null)
[ -z "$REPO_DIR" ] && { echo "ERROR: Missing repoDir for task $TASK_ID in $TASKS_FILE"; exit 1; }
GIT_DIR="${REPO_DIR}/.git"
ADDON_MODE_FILE="$REPO_DIR/.evogent-mode.md"
[ -f "$ADDON_MODE_FILE" ] || ADDON_MODE_FILE="$REPO_DIR/.claude/dev-agent-addon.md"
ADDON_MODE=$(awk -F: '/^[[:space:]]*mode[[:space:]]*:/ { value=$2; sub(/#.*/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print value; exit }' "$ADDON_MODE_FILE" 2>/dev/null || true)
[ -n "$ADDON_MODE" ] || ADDON_MODE="suggestion-remote"
case "$ADDON_MODE" in suggestion-remote|suggestion-local|direct) ;; *) echo "ERROR: Invalid $ADDON_MODE_FILE mode: $ADDON_MODE"; exit 1 ;; esac

# Detect the live app URL for browser verification (if the project has a web UI)
LIVE_URL=""
if [ -f "${REPO_DIR}/.env.local" ]; then
  _port=$(grep -E '^PORT=' "${REPO_DIR}/.env.local" 2>/dev/null | head -1 | cut -d= -f2)
  [ -n "$_port" ] && LIVE_URL="http://localhost:${_port}"
fi

# Build the full prompt with mandatory instructions
VERIFY_PROTOCOL=""
if [ -n "$LIVE_URL" ] && [ "$PIPELINE" = "merge" ]; then
  VERIFY_PROTOCOL="

VERIFICATION (mandatory):
1. Run: npm run build (must pass — catches type errors and broken imports)
2. Fix any build failures
3. If this task involves UI changes, use your browser to open ${LIVE_URL} and visually verify the fix works correctly. Navigate to the relevant page/component and confirm the change is visible and functional.
4. Close your validation tab before finishing. The shared Chrome persists across dev-agent runs; leftover localhost:PORT tabs from past runs pile up, eat memory, and eventually wedge the browser for the cacher and curator sessions. Use your browser tool's close-tab command, or curl the CDP endpoint directly: curl -s http://127.0.0.1:9222/json/list to find your target id (match on ${LIVE_URL}), then curl -s http://127.0.0.1:9222/json/close/<targetId>. Only close the tab you opened; leave other tabs alone — they may belong to the cacher, another curator session, or the user.
5. Run: echo done > .agent-done"
fi

FULL_PROMPT="You are working in an isolated git worktree for task: ${TASK_ID}
Working directory: ${WORKTREE}

MANDATORY INSTRUCTIONS:
- Work ONLY in this worktree directory
- Run lint, build, and test before finishing (if applicable to this project)
- Implement ONLY what is described in the TASK below. Do not add features, UI changes, notification systems, or other enhancements beyond the specific fix requested.
- Runtime logs under data/agent-state/logs/, data/logs/agent/, and scripts/agents/logs/ are disposable diagnostics. Do NOT add or commit them, and do not commit generated artifacts larger than 90MB.
- If you identify an adjacent problem worth solving, note it in your commit message — do NOT implement it.
- After making changes, run: git add -A && git commit -m $'type: description\n\nTask-Id: ${TASK_ID}' (use conventional prefixes: feat:, fix:, chore:, etc.)${VERIFY_PROTOCOL}
- When completely done, run: echo done > .agent-done

DEBUGGING & DESIGN METHODOLOGY (hand-compute):
When debugging state bugs, race conditions, async issues, or multi-actor flows — or when scoping features on existing state machines — do NOT rely on abstract reasoning. Instead, hand-compute the system execution:

1. BEFORE proposing a fix: walk through the BROKEN flow step by step. At every transition, write each actor's state as a named object (e.g. client = {...}, server = {...}, queue = {...}). Mark with ⚠ where an invariant breaks. That is the bug — often not where you initially thought.

2. AFTER proposing a fix: re-walk the SAME flow with the fix applied. Check every phase, not just the one that was failing. A fix that patches phase A but breaks phase B is the most common regression.

3. For NEW work on unfamiliar systems: execute the task manually first (call APIs, inspect real responses, trace real data). Write down what surprised you. Only then write code.

Failure modes to avoid:
- Narrative computation: prose like 'then this happens, then that' without explicit state. Write state = {...} literally.
- Skipping the broken flow: jumping straight to 'let me walk through the fix' without first understanding why the current code fails.
- Wrong abstraction level: tracing HTTP when the bug is in render-order, or vice versa. Locate the bug's likely home first.
- Wishful code-reading: describing what a function 'should' do instead of re-reading the actual source.

TASK:
${PROMPT}"

echo "$FULL_PROMPT" > "${LOG_DIR}/prompt.txt"

echo "=== Starting ${AGENT_TYPE} agent for ${TASK_ID} at $(date -u) ==="
echo "=== Pipeline: ${PIPELINE} ==="

# Clean up stale .agent-done from previous attempts
rm -f "$WORKTREE/.agent-done"

CODEX_FAST_ARGS=()
if [ "${CODEX_FAST_MODE:-1}" != "0" ]; then
  CODEX_FAST_ARGS=(-c 'service_tier="fast"')
fi

# Launch agent process in background so we can monitor .agent-done
case "$AGENT_TYPE" in
  claude)
    claude --model "$CLAUDE_MODEL" \
      --allowedTools Bash Edit Read Write Glob Grep WebFetch WebSearch LSP NotebookEdit BrowserUse \
      -p "$FULL_PROMPT" 2>&1 &
    AGENT_PID=$!
    ;;
  codex)
    codex exec --model "$CODEX_MODEL" \
      -c "model_reasoning_effort=${CODEX_REASONING}" \
      "${CODEX_FAST_ARGS[@]}" \
      -s danger-full-access \
      "$FULL_PROMPT" 2>&1 &
    AGENT_PID=$!
    ;;
  gemini)
    # Retry wrapper: gemini-3-pro-preview frequently 503s due to capacity limits.
    GEMINI_MAX_RETRIES=${GEMINI_MAX_RETRIES:-10}
    GEMINI_RETRY_DELAY=${GEMINI_RETRY_DELAY:-30}
    (
      for attempt in $(seq 1 "$GEMINI_MAX_RETRIES"); do
        echo "=== Gemini attempt $attempt/$GEMINI_MAX_RETRIES ==="
        gemini --approval-mode yolo --model "$GEMINI_MODEL" -p "$FULL_PROMPT" 2>&1 || true
        GEMINI_EXIT=$?
        if [ -f "$WORKTREE/.agent-done" ]; then
          echo "=== Gemini agent completed (found .agent-done) ==="
          break
        fi
        if [ "$attempt" -lt "$GEMINI_MAX_RETRIES" ]; then
          WAIT=$((GEMINI_RETRY_DELAY * attempt))
          [ "$WAIT" -gt 300 ] && WAIT=300
          echo "=== Gemini attempt $attempt failed (exit=$GEMINI_EXIT, no .agent-done). Retrying in ${WAIT}s ==="
          sleep "$WAIT"
        else
          echo "=== Gemini exhausted $GEMINI_MAX_RETRIES attempts ==="
        fi
      done
    ) &
    AGENT_PID=$!
    ;;
  *)
    echo "Unknown agent type: $AGENT_TYPE"
    exit 1
    ;;
esac

# Wait for agent to exit OR .agent-done to appear (whichever comes first).
# Once .agent-done exists, give the process 30s grace to exit cleanly, then kill it.
# This eliminates delays from stalled agent processes after task completion.
DONE_GRACE=30
while kill -0 $AGENT_PID 2>/dev/null; do
  if [ -f "$WORKTREE/.agent-done" ]; then
    echo "=== .agent-done detected — waiting ${DONE_GRACE}s for process to exit ==="
    GRACE_END=$(($(date +%s) + DONE_GRACE))
    while kill -0 $AGENT_PID 2>/dev/null && [ $(date +%s) -lt $GRACE_END ]; do
      sleep 2
    done
    if kill -0 $AGENT_PID 2>/dev/null; then
      echo "=== Grace period expired — terminating agent process ==="
      kill $AGENT_PID 2>/dev/null
      sleep 2
      kill -9 $AGENT_PID 2>/dev/null || true
    fi
    break
  fi
  sleep 5
done
wait $AGENT_PID 2>/dev/null || true

echo "=== Agent finished at $(date -u) ==="

# Post-agent: run pipeline if configured

update_status() {
  jq --arg id "$TASK_ID" --arg s "$1" \
    '(.[] | select(.id == $id)).status = $s' "$TASKS_FILE" > "${TASKS_FILE}.tmp" \
    && mv "${TASKS_FILE}.tmp" "$TASKS_FILE"
}

handle_rebase_conflict_retry() {
  local attempts next_attempt next_task_id original_prompt worktree_base

  attempts="$(task_attempts "$TASK_ID")"
  if [ "$attempts" -lt "$MAX_ATTEMPTS" ]; then
    next_attempt=$((attempts + 1))
    next_task_id="$(retry_task_id "$TASK_ID" "$next_attempt")"
    original_prompt="$(read_retry_prompt "$LOG_DIR" || true)"
    worktree_base="${REPO_DIR}-worktrees"
    if [ -n "$WORKTREE" ] && [ "$WORKTREE" != "$REPO_DIR" ]; then
      worktree_base="$(dirname "$WORKTREE")"
    fi

    if [ -z "$original_prompt" ]; then
      echo "REBASE CONFLICT for ${TASK_ID} — retry prompt not found"
      update_status "needs-attention"
      "$SCRIPTS_DIR/notify.sh" "Rebase Conflict" "Task ${TASK_ID} rebase conflict but the original prompt could not be loaded. Needs manual resolution."
      return 1
    fi

    if jq -e --arg id "$next_task_id" '.[] | select(.id == $id)' "$TASKS_FILE" >/dev/null 2>&1; then
      echo "REBASE CONFLICT for ${TASK_ID} — retry task ${next_task_id} already exists"
      update_status "needs-attention"
      "$SCRIPTS_DIR/notify.sh" "Rebase Conflict" "Task ${TASK_ID} rebase conflict but retry task ${next_task_id} already exists. Needs manual resolution."
      return 1
    fi

    echo "REBASE CONFLICT — auto-retrying (attempt ${next_attempt}/${MAX_ATTEMPTS}) on latest main"
    cleanup_retry_task "$REPO_DIR" "$WORKTREE"
    unset MEDIA_AGENT_SPAWN_DEPTH
    if bash "$SCRIPTS_DIR/spawn-agent.sh" "$next_task_id" "$AGENT_TYPE" "$original_prompt" --repo "$REPO_DIR" --worktree-base "$worktree_base" --pipeline "$PIPELINE"; then
      update_task_attempts "$next_task_id" "$next_attempt"
      update_status "failed"
      "$SCRIPTS_DIR/notify.sh" "Rebase Conflict" "Task ${TASK_ID} rebase conflict — auto-retrying (attempt ${next_attempt}/${MAX_ATTEMPTS})"
      return 0
    fi

    echo "REBASE CONFLICT for ${TASK_ID} — auto-retry spawn failed"
    update_status "needs-attention"
    "$SCRIPTS_DIR/notify.sh" "Rebase Conflict" "Task ${TASK_ID} rebase conflict but auto-retry failed to respawn. Needs manual resolution."
    return 1
  fi

  echo "REBASE CONFLICT for ${TASK_ID} — max attempts reached (${attempts}/${MAX_ATTEMPTS})"
  update_status "needs-attention"
  "$SCRIPTS_DIR/notify.sh" "Rebase Conflict" "Task ${TASK_ID} has conflicts with current main after ${attempts}/${MAX_ATTEMPTS} attempts. Needs manual resolution."
  return 1
}

case "$PIPELINE" in
  full)
    echo "=== Running full validation pipeline ==="
    bash "$SCRIPTS_DIR/validate.sh" "$TASK_ID"
    ;;
  merge)
    [ "$ADDON_MODE" != "direct" ] || { echo "ERROR: direct mode does not use the code_fix merge pipeline"; update_status "failed"; exit 1; }
    # Check if the agent already ran merge-now.sh
    if [ -f "/tmp/.agent-merged-${TASK_ID}" ]; then
      echo "=== Agent already merged ${TASK_ID} — skipping pipeline merge ==="
      rm -f "/tmp/.agent-merged-${TASK_ID}"
      update_status "done"
      COMPLETE_TEXT="Task ${TASK_ID} merged (agent-verified) and pushed to main."
      [ "$ADDON_MODE" = "suggestion-local" ] && COMPLETE_TEXT="Task ${TASK_ID} merged locally (agent-verified) to main."
      "$SCRIPTS_DIR/notify.sh" "Task Complete" "$COMPLETE_TEXT"
    else
      echo "=== Auto-merge pipeline (fallback) ==="
      # Acquire merge lock to prevent concurrent merges from corrupting git state
      MERGE_LOCK="/tmp/.merge-lock-$(echo "$REPO_DIR" | md5sum | cut -c1-8)"
      LOCK_WAIT=0
      while [ -f "$MERGE_LOCK" ]; do
        LOCK_HOLDER=$(cat "$MERGE_LOCK" 2>/dev/null || echo "unknown")
        if [ "$LOCK_WAIT" -ge 300 ]; then
          echo "WARNING: Merge lock held by ${LOCK_HOLDER} for 5+ minutes — breaking stale lock"
          rm -f "$MERGE_LOCK"
          break
        fi
        echo "Waiting for merge lock (held by ${LOCK_HOLDER})..."
        sleep 10
        LOCK_WAIT=$((LOCK_WAIT + 10))
      done
      echo "$TASK_ID" > "$MERGE_LOCK"
      MERGE_STASH_CREATED=0
      restore_merge_stash() {
        if [ "$MERGE_STASH_CREATED" -eq 1 ]; then
          echo "=== Restoring stashed working tree ==="
          if git stash pop; then
            MERGE_STASH_CREATED=0
          else
            MERGE_STASH_CREATED=0
            echo "WARNING: git stash pop failed — restore the stash manually."
          fi
        fi
      }
      cleanup_merge_pipeline() {
        restore_merge_stash || true
        rm -f "$MERGE_LOCK"
      }
      trap 'cleanup_merge_pipeline; cleanup_log_monitor' EXIT

      cd "$REPO_DIR"
      # Abort any leftover merge state from a previous failed merge
      git merge --abort 2>/dev/null || true

      # Preserve runtime data files that git reset would wipe —
      # but skip files the branch modifies (branch version wins)
      MERGE_BASE_REF="origin/main"
      if [ "$ADDON_MODE" = "suggestion-remote" ]; then git fetch origin main; else MERGE_BASE_REF="main"; fi
      BRANCH_FILES=$(git diff --name-only "$MERGE_BASE_REF"..."$TASK_ID" 2>/dev/null || true)
      declare -a _preserved_files=()
      for _f in data/config.md data/preferences-context.md data/curation-prompt.md data/agent-receipts.jsonl; do
        if [ -f "$_f" ] && ! echo "$BRANCH_FILES" | grep -qF "$_f"; then
          cp "$_f" "/tmp/_merge_preserve_$(basename $_f)"
          _preserved_files+=("$_f")
        elif echo "$BRANCH_FILES" | grep -qF "$_f"; then
          echo "Skipping preserve of $_f (branch modifies it)"
        fi
      done
      git checkout main
      [ "$ADDON_MODE" = "suggestion-remote" ] && git reset --hard origin/main
      # Restore preserved runtime data
      for _f in "${_preserved_files[@]}"; do
        _tmp="/tmp/_merge_preserve_$(basename $_f)"
        if [ -f "$_tmp" ]; then
          cp "$_tmp" "$_f"
          rm -f "$_tmp"
          echo "Restored runtime data: $_f"
        fi
      done
      if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard --directory --no-empty-directory | head -n 1)" ]; then
        echo "=== Stashing working tree before rebase ==="
        git stash push --include-untracked -m "auto-merge:${TASK_ID}"
        MERGE_STASH_CREATED=1
      else
        echo "No working tree changes to stash before rebase"
      fi
      # Rebase agent branch onto current main to prevent silent reverts.
      # Without this, if agent B branched before agent A merged, B's merge
      # can silently revert A's changes (git auto-resolves by taking B's
      # stale version of shared files). Rebasing replays B's commits on top
      # of current main, surfacing conflicts that would otherwise be hidden.
      # Remove the worktree so git allows checking out the branch for rebase
      if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
        git worktree remove "$WORKTREE" --force 2>/dev/null || true
      fi
      echo "=== Rebasing ${TASK_ID} onto main ==="
      if ! git rebase main "$TASK_ID"; then
        echo "REBASE CONFLICT for ${TASK_ID} — aborting"
        git rebase --abort 2>/dev/null || true
        git checkout main 2>/dev/null || true
        if handle_rebase_conflict_retry; then
          exit 0
        fi
        exit 1
      fi
      git checkout main

      if [ "$ADDON_MODE" = "suggestion-remote" ] && ! bash "$SCRIPTS_DIR/check-push-size.sh" "$REPO_DIR" origin/main "$TASK_ID"; then
        update_status "failed"
        echo "OVERSIZED BLOB detected for ${TASK_ID} — refusing to merge"
        "$SCRIPTS_DIR/notify.sh" "Task Failed" "Task ${TASK_ID} introduces a blob larger than the push limit. Remove it before retrying."
        exit 1
      fi

      VALIDATION_RESULT="$(read_validation_result "$STATE_DIR" "$TASK_ID")"
      MERGE_BASE="$(git rev-parse HEAD)"
      MERGE_MESSAGE_FILE="$(mktemp)"
      trap 'cleanup_merge_pipeline; cleanup_log_monitor; rm -f "$MERGE_MESSAGE_FILE"' EXIT
      write_merge_commit_message_file "$MERGE_MESSAGE_FILE" "$TASK_ID" "$TASKS_FILE" "$LOG_DIR" "$REPO_ROOT" "$REPO_DIR" "$STATE_DIR" "$VALIDATION_RESULT"

      if git merge --no-ff "$TASK_ID" -F "$MERGE_MESSAGE_FILE"; then
        NEW_HEAD="$(git rev-parse HEAD)"
        if [ "$MERGE_BASE" != "$NEW_HEAD" ]; then
          append_agent_receipt "$TASK_ID" "$TASKS_FILE" "$LOG_DIR" "$REPO_ROOT" "$REPO_DIR" "$STATE_DIR" "$VALIDATION_RESULT"
        fi
        [ "$ADDON_MODE" = "suggestion-remote" ] && git push origin main
        if [ "$MERGE_BASE" != "$NEW_HEAD" ]; then
          bash "$SCRIPTS_DIR/enqueue-post-merge-review.sh" "$NEW_HEAD" "$TASK_ID" || echo "WARNING: post-merge review enqueue failed"
        fi
        # Run repo-specific post-merge hook if it exists
        if [ -x "${REPO_DIR}/.claude/hooks/post-merge.sh" ]; then
          echo "=== Running post-merge hook ==="
          bash "${REPO_DIR}/.claude/hooks/post-merge.sh" || echo "WARNING: post-merge hook failed"
        fi
        update_status "done"
        echo "Merged ${TASK_ID} to main."
        # Update feed suggestion status via lifecycle endpoint (non-fatal)
        curl -s -X POST http://127.0.0.1:3001/api/internal/code-fix-orchestrator/lifecycle \
          -H "Content-Type: application/json" \
          -d "{"taskId":"${TASK_ID}","status":"merged"}" >/dev/null 2>&1 || true
        COMPLETE_TEXT="Task ${TASK_ID} merged and pushed to main."
        [ "$ADDON_MODE" = "suggestion-local" ] && COMPLETE_TEXT="Task ${TASK_ID} merged locally to main."
        "$SCRIPTS_DIR/notify.sh" "Task Complete" "$COMPLETE_TEXT"
      else
        # Abort the failed merge so the next agent doesn't hit "needs merge" errors
        git merge --abort 2>/dev/null || true
        update_status "failed"
        echo "MERGE FAILED for ${TASK_ID}"
        # Update feed suggestion status via lifecycle endpoint (non-fatal)
        curl -s -X POST http://127.0.0.1:3001/api/internal/code-fix-orchestrator/lifecycle \
          -H "Content-Type: application/json" \
          -d "{"taskId":"${TASK_ID}","status":"failed"}" >/dev/null 2>&1 || true
        "$SCRIPTS_DIR/notify.sh" "Task Failed" "Task ${TASK_ID} merge failed — resolve conflicts manually."
      fi
    fi
    ;;
  *)
    echo "=== No pipeline — marking task done ==="
    update_status "done"
    "$SCRIPTS_DIR/notify.sh" "Task Done" "Task ${TASK_ID} complete (no pipeline). Review and merge manually."
    ;;
esac
