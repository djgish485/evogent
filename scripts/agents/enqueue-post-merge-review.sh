#!/usr/bin/env bash
set -euo pipefail

MERGE_COMMIT="${1:?Usage: enqueue-post-merge-review.sh <merge-commit> [task-id]}"
TASK_ID="${2:-}"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${MEDIA_AGENT_REPO_DIR:-$PWD}"
STATE_DIR="${MEDIA_AGENT_STATE_DIR:-$REPO_DIR/data/agent-state}"
LEDGER_FILE="$REPO_DIR/data/agent-receipts.jsonl"
INTERNAL_BASE_URL="${MEDIA_AGENT_INTERNAL_BASE_URL:-${ORCHESTRATOR_INTERNAL_URL:-http://127.0.0.1:${PORT:-3001}}}"
SKILL_PATH=".claude/skills/review-landed-merge/SKILL.md"

source "$SCRIPTS_DIR/receipt-helpers.sh"

if [ ! -s "$LEDGER_FILE" ]; then
  exit 0
fi

receipt_json="$(jq -c --arg mergeCommit "$MERGE_COMMIT" 'select((.mergeCommit // "") == $mergeCommit)' "$LEDGER_FILE" | tail -n 1)"
if [ -z "$receipt_json" ]; then
  exit 0
fi

suggestion_id="$(jq -r '.suggestionId // ""' <<<"$receipt_json")"
origin_session_id="$(jq -r '.originSessionId // .metadata.originSessionId // ""' <<<"$receipt_json")"
validation_result="$(jq -r '.validationResult // "skipped"' <<<"$receipt_json")"
files_touched_json="$(jq -c '.filesTouched // []' <<<"$receipt_json")"
files_preview="$(jq -r '
  def preview:
    if length == 0 then "none recorded"
    else
      (.[0:4] | join(", "))
      + (if length > 4 then " (+" + ((length - 4) | tostring) + " more)" else "" end)
    end;
  "files (" + (length | tostring) + "): " + preview
' <<<"$files_touched_json")"

resolve_origin_session_from_history() {
  local history_file
  history_file="$(find_receipt_history_file "$REPO_DIR" "$REPO_DIR" "$STATE_DIR" 2>/dev/null || true)"
  if [ -z "$history_file" ] || [ ! -f "$history_file" ]; then
    return 0
  fi

  jq -r --arg suggestionId "$suggestion_id" --arg taskId "$TASK_ID" '
    def entries:
      if type == "array" then .
      elif type == "object" and ((.history | type) == "array") then .history
      elif type == "object" and ((.tasks | type) == "array") then .tasks
      else []
      end;
    def origin:
      .originSessionId // .metadata.originSessionId // "";
    [entries[]?
      | select(
          (($suggestionId != "") and ((.suggestionId // .feedItemId // .metadata.suggestionId // .metadata.feedItemId // "") == $suggestionId))
          or (($taskId != "") and ((.taskId // .id // "") == $taskId))
        )
      | origin
      | select(type == "string" and length > 0)
    ] | last // ""
  ' "$history_file"
}

resolve_code_fix_from_task_id() {
  if [ -z "$TASK_ID" ]; then
    printf '{}\n'
    return 0
  fi

  local encoded_task_id
  encoded_task_id="$(jq -rn --arg value "$TASK_ID" '$value|@uri')"
  local resolved_json
  resolved_json="$(curl -fsS "${INTERNAL_BASE_URL}/api/internal/code-fix-orchestrator/resolve?taskId=${encoded_task_id}" 2>/dev/null || true)"
  if [ -n "$resolved_json" ] && jq -e '.ok == true' >/dev/null 2>&1 <<<"$resolved_json"; then
    printf '%s\n' "$resolved_json"
    return 0
  fi

  resolve_receipt_code_fix_provenance "$TASK_ID" "$REPO_DIR" "$REPO_DIR" "$STATE_DIR" 2>/dev/null || printf '{}\n'
}

post_merge_review_already_enqueued() {
  local encoded_session_id
  encoded_session_id="$(jq -rn --arg value "$origin_session_id" '$value|@uri')"
  local chat_json
  chat_json="$(curl -fsS "${INTERNAL_BASE_URL}/api/chat?sessionId=${encoded_session_id}&limit=100" 2>/dev/null || true)"
  if [ -z "$chat_json" ]; then
    return 1
  fi

  jq -e --arg mergeCommit "$MERGE_COMMIT" '
    any(.items[]?;
      (.metadata.source // "") == "post_merge_review"
      and (.metadata.mergeCommit // "") == $mergeCommit
    )
  ' >/dev/null 2>&1 <<<"$chat_json"
}

if [ -z "$origin_session_id" ] && [ -z "$suggestion_id" ] && [ -n "$TASK_ID" ]; then
  resolved_json="$(resolve_code_fix_from_task_id)"
  if [ -n "$resolved_json" ]; then
    resolved_suggestion_id="$(jq -r '.suggestionId // .feedItemId // ""' <<<"$resolved_json")"
    resolved_origin_session_id="$(jq -r '.originSessionId // .metadata.originSessionId // ""' <<<"$resolved_json")"
    if [ -z "$suggestion_id" ] && [ -n "$resolved_suggestion_id" ]; then
      suggestion_id="$resolved_suggestion_id"
    fi
    if [ -n "$resolved_origin_session_id" ]; then
      origin_session_id="$resolved_origin_session_id"
    fi
  fi
fi

if [ -z "$origin_session_id" ] && [ -n "$suggestion_id" ]; then
  suggestion_json="$(curl -fsS "${INTERNAL_BASE_URL}/api/feed/${suggestion_id}" 2>/dev/null || true)"
  if [ -n "$suggestion_json" ]; then
    origin_session_id="$(jq -r '.item.originSessionId // .item.metadata.originSessionId // ""' <<<"$suggestion_json")"
  fi
fi

if [ -z "$origin_session_id" ]; then
  origin_session_id="$(resolve_origin_session_from_history)"
fi

if [ -z "$origin_session_id" ]; then
  exit 0
fi

session_json="$(curl -fsS "${INTERNAL_BASE_URL}/api/chat/sessions?sessionId=${origin_session_id}" 2>/dev/null || true)"
if [ -z "$session_json" ] || [ "$(jq -r '.session == null' <<<"$session_json")" = "true" ]; then
  exit 0
fi

if post_merge_review_already_enqueued; then
  exit 0
fi

short_merge_commit="${MERGE_COMMIT:0:12}"
review_prompt=$(
  cat <<EOF
Review landed merge ${short_merge_commit}${suggestion_id:+ for suggestion ${suggestion_id}}. Use ${SKILL_PATH}.
Context: task ${TASK_ID:-unknown}; validation ${validation_result}; ${files_preview}.
Post exactly one compact, simple review reply in this session: either \`✅ Review clean\` or a concrete concern block. Cover request fit, Evogent development-philosophy/boundary fit, and unintended revert risk.
EOF
)

chat_payload="$(jq -nc \
  --arg message "$review_prompt" \
  --arg sessionId "$origin_session_id" \
  --arg mergeCommit "$MERGE_COMMIT" \
  --arg taskId "$TASK_ID" \
  --arg suggestionId "$suggestion_id" \
  --arg skillPath "$SKILL_PATH" \
  --argjson filesTouched "$files_touched_json" \
  '{
    message: $message,
    sessionId: $sessionId,
    metadata: {
      source: "post_merge_review",
      mergeCommit: $mergeCommit,
      taskId: ($taskId | if . == "" then null else . end),
      suggestionId: ($suggestionId | if . == "" then null else . end),
      skillPath: $skillPath,
      filesTouched: $filesTouched
    }
  }')"

curl -fsS \
  -X POST "${INTERNAL_BASE_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -d "$chat_payload" >/dev/null
