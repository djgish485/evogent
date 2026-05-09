#!/usr/bin/env bash
# Usage: merge-now.sh <task-id>
# Called BY the agent (inside codex exec) to merge its branch to the merge target,
# run post-merge hooks, and restart the service — so the agent can then
# verify its changes on the live app before marking done.
#
# Exit codes: 0 = merged OK, 1 = merge failed
set -euo pipefail

TASK_ID="${1:?Usage: merge-now.sh <task-id>}"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/../.." && pwd)"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_ROOT/data/agent-state}"
mkdir -p "$STATE_DIR/logs"
TASKS_FILE="$STATE_DIR/active-tasks.json"
LOG_DIR="$STATE_DIR/logs/agent/${TASK_ID}"
source "$SCRIPTS_DIR/receipt-helpers.sh"

# Read repo dir from task registry
REPO_DIR=$(jq -r --arg id "$TASK_ID" '.[] | select(.id == $id) | .repoDir // empty' "$TASKS_FILE" 2>/dev/null)
[ -z "$REPO_DIR" ] && { echo "ERROR: Could not find repoDir for task $TASK_ID"; exit 1; }
ADDON_MODE_FILE="$REPO_DIR/.evogent-mode.md"
[ -f "$ADDON_MODE_FILE" ] || ADDON_MODE_FILE="$REPO_DIR/.claude/dev-agent-addon.md"
read_addon_value() {
  awk -F: -v key="$1" '$0 ~ "^[[:space:]]*" key "[[:space:]]*:" { value=$2; sub(/#.*/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); gsub(/^["\047]|["\047]$/, "", value); print value; exit }' "$ADDON_MODE_FILE" 2>/dev/null || true
}
ADDON_MODE=$(read_addon_value mode)
[ -n "$ADDON_MODE" ] || ADDON_MODE="suggestion-remote"
case "$ADDON_MODE" in suggestion-remote|suggestion-local|direct) ;; *) echo "ERROR: Invalid $ADDON_MODE_FILE mode: $ADDON_MODE"; exit 1 ;; esac
[ "$ADDON_MODE" != "direct" ] || { echo "ERROR: direct mode does not use merge-now.sh"; exit 1; }
MERGE_TARGET="${MERGE_TARGET:-$(read_addon_value mergeTarget)}"
[ -n "$MERGE_TARGET" ] || MERGE_TARGET="main"
MERGE_REMOTE_REF="origin/$MERGE_TARGET"

echo "=== merge-now.sh: merging $TASK_ID to $MERGE_TARGET ==="

cd "$REPO_DIR"

# Preserve runtime data files that git reset would wipe —
# but skip files the branch modifies (branch version wins)
MERGE_BASE_REF="$MERGE_TARGET"
if [ "$ADDON_MODE" = "suggestion-remote" ]; then
  git fetch origin "$MERGE_TARGET" || { echo "ERROR: mergeTarget ${MERGE_TARGET} has no ${MERGE_REMOTE_REF} ref - create it on origin first or push manually"; exit 1; }
  MERGE_BASE_REF="$MERGE_REMOTE_REF"
fi
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
git checkout "$MERGE_TARGET"
[ "$ADDON_MODE" = "suggestion-remote" ] && git reset --hard "$MERGE_REMOTE_REF"

# Restore preserved runtime data
for _f in "${_preserved_files[@]}"; do
  _tmp="/tmp/_merge_preserve_$(basename $_f)"
  if [ -f "$_tmp" ]; then
    cp "$_tmp" "$_f"
    rm -f "$_tmp"
    echo "Restored runtime data: $_f"
  fi
done

# Remove the worktree so git allows checking out the branch for rebase
WORKTREE=$(jq -r --arg id "$TASK_ID" '.[] | select(.id == $id) | .worktree // empty' "$TASKS_FILE" 2>/dev/null)
if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
  git worktree remove "$WORKTREE" --force 2>/dev/null || true
fi

# Rebase agent branch onto current merge target to prevent silent reverts.
echo "=== Rebasing ${TASK_ID} onto ${MERGE_TARGET} ==="
if ! git rebase "$MERGE_TARGET" "$TASK_ID"; then
  echo "REBASE CONFLICT for ${TASK_ID} — aborting"
  git rebase --abort 2>/dev/null || true
  git checkout "$MERGE_TARGET" 2>/dev/null || true
  exit 1
fi
git checkout "$MERGE_TARGET"

if [ "$ADDON_MODE" = "suggestion-remote" ] && ! bash "$SCRIPTS_DIR/check-push-size.sh" "$REPO_DIR" "$MERGE_REMOTE_REF" "$TASK_ID"; then
  echo "=== merge-now.sh: ${TASK_ID} introduces a blob larger than the push limit ==="
  exit 1
fi

VALIDATION_RESULT="$(read_validation_result "$STATE_DIR" "$TASK_ID")"
PUSH_AFTER_MERGE=0
[ "$ADDON_MODE" = "suggestion-remote" ] && PUSH_AFTER_MERGE=1
if REPO_DIR="$REPO_DIR" TASKS_FILE="$TASKS_FILE" LOG_DIR="$LOG_DIR" MERGE_BRANCH="$TASK_ID" MERGE_TARGET="$MERGE_TARGET" PUSH_AFTER_MERGE="$PUSH_AFTER_MERGE" RECEIPT_REQUIRED=1 bash "$SCRIPTS_DIR/finalize-merge.sh" "$TASK_ID" "$VALIDATION_RESULT"; then
  MERGED_TEXT="=== merge-now.sh: merged and deployed $TASK_ID to $MERGE_TARGET ==="
  [ "$ADDON_MODE" = "suggestion-local" ] && MERGED_TEXT="=== merge-now.sh: merged locally $TASK_ID to $MERGE_TARGET ==="
  echo "$MERGED_TEXT"
  # Mark that the agent handled the merge (so run-agent.sh skips it)
  touch "/tmp/.agent-merged-${TASK_ID}"
  exit 0
else
  echo "=== merge-now.sh: MERGE FAILED for $TASK_ID ==="
  exit 1
fi
