#!/usr/bin/env bash
# Usage: finalize-merge.sh <task-id> [validation-result]
#
# Assumes: task branch has already been rebased onto main, and HEAD is at main.
# Does: trailered merge commit, push, receipt append, post-merge review enqueue,
# and the repo-specific post-merge hook. Single source of receipts-aware merge
# logic shared by merge-now.sh, run-agent.sh, the unified check-agents.sh, and
# the server-side agent-runner.js.

set -uo pipefail

TASK_ID="${1:?task id required}"
VALIDATION_RESULT="${2:-}"

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPTS_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/../.." && pwd)"
REPO_DIR="${REPO_DIR:-$REPO_ROOT}"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_ROOT/data/agent-state}"
TASKS_FILE="${TASKS_FILE:-$STATE_DIR/active-tasks.json}"
LOG_DIR="${LOG_DIR:-$STATE_DIR/logs/agent/$TASK_ID}"
MERGE_BRANCH="${MERGE_BRANCH:-$TASK_ID}"
MERGE_TARGET="${MERGE_TARGET:-main}"
PUSH_AFTER_MERGE="${PUSH_AFTER_MERGE:-1}"
ENQUEUE_POST_MERGE_REVIEW="${ENQUEUE_POST_MERGE_REVIEW:-1}"
RECEIPT_REQUIRED="${RECEIPT_REQUIRED:-0}"

# shellcheck source=/dev/null
source "$SCRIPTS_DIR/receipt-helpers.sh"

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -z "$VALIDATION_RESULT" ]; then
  VALIDATION_RESULT="$(read_validation_result "$STATE_DIR" "$TASK_ID" 2>/dev/null || printf '')"
fi

if [ -n "$MERGE_TARGET" ]; then
  git -C "$REPO_DIR" checkout "$MERGE_TARGET" || exit 1
fi

MERGE_BASE="$(git -C "$REPO_DIR" rev-parse HEAD)"
MERGE_MESSAGE_FILE="$(mktemp)"
trap 'rm -f "$MERGE_MESSAGE_FILE"' EXIT

if ! write_merge_commit_message_file \
  "$MERGE_MESSAGE_FILE" \
  "$TASK_ID" \
  "$TASKS_FILE" \
  "$LOG_DIR" \
  "$REPO_ROOT" \
  "$REPO_DIR" \
  "$STATE_DIR" \
  "$VALIDATION_RESULT"; then
  if is_truthy "$RECEIPT_REQUIRED"; then
    echo "finalize-merge: write_merge_commit_message_file failed; receipt-required merge aborted" >&2
    exit 1
  fi
  echo "finalize-merge: write_merge_commit_message_file failed; falling back to bare merge message" >&2
  printf 'merge: %s\n' "$TASK_ID" > "$MERGE_MESSAGE_FILE"
fi

if ! git -C "$REPO_DIR" merge --no-ff "$MERGE_BRANCH" -F "$MERGE_MESSAGE_FILE"; then
  exit 1
fi

NEW_HEAD="$(git -C "$REPO_DIR" rev-parse HEAD)"

if [ "$MERGE_BASE" != "$NEW_HEAD" ]; then
  if ! append_agent_receipt \
    "$TASK_ID" \
    "$TASKS_FILE" \
    "$LOG_DIR" \
    "$REPO_ROOT" \
    "$REPO_DIR" \
    "$STATE_DIR" \
    "$VALIDATION_RESULT"; then
    if is_truthy "$RECEIPT_REQUIRED"; then
      echo "finalize-merge: append_agent_receipt failed; receipt-required merge left unpushed" >&2
      exit 1
    fi
    echo "finalize-merge: append_agent_receipt failed (non-fatal)" >&2
  fi
fi

if is_truthy "$PUSH_AFTER_MERGE"; then
  if ! git -C "$REPO_DIR" push origin "$MERGE_TARGET"; then
    exit 1
  fi
fi

if [ "$MERGE_BASE" != "$NEW_HEAD" ] && is_truthy "$ENQUEUE_POST_MERGE_REVIEW"; then
  bash "$SCRIPTS_DIR/enqueue-post-merge-review.sh" "$NEW_HEAD" "$TASK_ID" \
    || echo "finalize-merge: post-merge review enqueue failed (non-fatal)" >&2
fi

if [ -n "${POST_MERGE_HOOK:-}" ]; then
  case "$POST_MERGE_HOOK" in
    /*) POST_MERGE_HOOK_PATH="$POST_MERGE_HOOK" ;;
    *) POST_MERGE_HOOK_PATH="$REPO_DIR/$POST_MERGE_HOOK" ;;
  esac
else
  POST_MERGE_HOOK_PATH="$REPO_DIR/.claude/hooks/post-merge.sh"
fi

if [ -x "$POST_MERGE_HOOK_PATH" ]; then
  echo "=== Running post-merge hook ==="
  bash "$POST_MERGE_HOOK_PATH" || echo "finalize-merge: post-merge hook failed (non-fatal)" >&2
fi

if is_truthy "$PUSH_AFTER_MERGE"; then
  echo "finalize-merge: merged and pushed $TASK_ID (commit $NEW_HEAD)"
else
  echo "finalize-merge: merged $TASK_ID without push (commit $NEW_HEAD)"
fi
