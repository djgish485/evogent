#!/usr/bin/env bash

normalize_receipt_line() {
  printf '%s' "${1:-}" | tr '\r\n' '  ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

truncate_receipt_line() {
  printf '%s' "${1:-}" | cut -c1-120
}

receipt_validation_result_file() {
  local state_dir="${1:?state dir required}"
  local task_id="${2:?task id required}"
  printf '%s/logs/agent/%s/validation-result.txt\n' "$state_dir" "$task_id"
}

clear_validation_result() {
  local state_dir="${1:?state dir required}"
  local task_id="${2:?task id required}"
  rm -f "$(receipt_validation_result_file "$state_dir" "$task_id")"
}

write_validation_result() {
  local state_dir="${1:?state dir required}"
  local task_id="${2:?task id required}"
  local result="${3:-skipped}"
  local result_file
  result_file="$(receipt_validation_result_file "$state_dir" "$task_id")"
  mkdir -p "$(dirname "$result_file")"
  printf '%s\n' "$result" > "$result_file"
}

read_validation_result() {
  local state_dir="${1:?state dir required}"
  local task_id="${2:?task id required}"
  local result_file
  result_file="$(receipt_validation_result_file "$state_dir" "$task_id")"
  if [ -f "$result_file" ]; then
    local result
    result="$(tr -d '\r\n' < "$result_file")"
    case "$result" in
      pass|fail|skipped) printf '%s\n' "$result"; return 0 ;;
    esac
  fi
  printf 'skipped\n'
}

find_receipt_history_file() {
  local repo_root="${1:?repo root required}"
  local repo_dir="${2:?repo dir required}"
  local state_dir="${3:?state dir required}"
  local data_dir
  data_dir="$(dirname "$state_dir")"
  local candidate
  for candidate in \
    "$repo_root/data/orchestrator-history.json" \
    "$repo_dir/data/orchestrator-history.json" \
    "$data_dir/orchestrator-history.json"
  do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

read_receipt_prompt_fallback() {
  local log_dir="${1:?log dir required}"
  local prompt_input_file="$log_dir/prompt-input.txt"
  local prompt_file="$log_dir/prompt.txt"

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

resolve_receipt_agent_model() {
  local raw_value
  raw_value="$(normalize_receipt_line "${1:-}")"
  case "$raw_value" in
    codex) printf '%s\n' "${CODEX_MODEL:-codex}" ;;
    claude) printf '%s\n' "${CLAUDE_MODEL:-claude}" ;;
    gemini) printf '%s\n' "${GEMINI_MODEL:-gemini}" ;;
    *) printf '%s\n' "$raw_value" ;;
  esac
}

load_receipt_context() {
  local task_id="${1:?task id required}"
  local tasks_file="${2:?tasks file required}"
  local log_dir="${3:?log dir required}"
  local repo_root="${4:?repo root required}"
  local repo_dir="${5:?repo dir required}"
  local state_dir="${6:?state dir required}"
  local default_log_file="data/task-logs/${task_id}.jsonl"
  local task_json='{}'
  local history_json='{}'
  local prompt_fallback=''
  local history_file=''
  local env_branch="${CODE_FIX_BRANCH:-${MERGE_BRANCH:-}}"
  local env_suggestion_id="${CODE_FIX_SUGGESTION_ID:-${RECEIPT_SUGGESTION_ID:-}}"
  local env_origin_session_id="${CODE_FIX_ORIGIN_SESSION_ID:-${RECEIPT_ORIGIN_SESSION_ID:-}}"
  local env_agent_model="${CODE_FIX_AGENT_MODEL:-${RECEIPT_AGENT_MODEL:-}}"
  local env_reasoning_effort="${CODE_FIX_REASONING_EFFORT:-${RECEIPT_REASONING_EFFORT:-}}"
  local env_prompt_summary="${CODE_FIX_PROMPT_SUMMARY:-${RECEIPT_PROMPT_SUMMARY:-}}"
  local env_log_file="${CODE_FIX_LOG_FILE:-${RECEIPT_LOG_FILE:-}}"

  if [ -f "$tasks_file" ]; then
    task_json="$(jq -c --arg id "$task_id" '[.[]? | select((.id // "") == $id)] | last // {}' "$tasks_file" 2>/dev/null || printf '{}')"
  fi

  if history_file="$(find_receipt_history_file "$repo_root" "$repo_dir" "$state_dir" 2>/dev/null)"; then
    history_json="$(jq -c --arg id "$task_id" '
      def entries:
        if type == "array" then .
        elif type == "object" and ((.history | type) == "array") then .history
        elif type == "object" and ((.tasks | type) == "array") then .tasks
        else []
        end;
      [entries[]? | select(((.taskId // .id // "") | tostring) == $id)] | last // {}
    ' "$history_file" 2>/dev/null || printf '{}')"
  fi

  prompt_fallback="$(read_receipt_prompt_fallback "$log_dir" 2>/dev/null || true)"

  RECEIPT_CONTEXT_JSON="$(jq -nc \
    --arg taskId "$task_id" \
    --arg defaultLog "$default_log_file" \
    --arg promptFallback "$prompt_fallback" \
    --arg envBranch "$env_branch" \
    --arg envSuggestionId "$env_suggestion_id" \
    --arg envOriginSessionId "$env_origin_session_id" \
    --arg envAgentModel "$env_agent_model" \
    --arg envReasoningEffort "$env_reasoning_effort" \
    --arg envPromptSummary "$env_prompt_summary" \
    --arg envLogFile "$env_log_file" \
    --argjson task "$task_json" \
    --argjson history "$history_json" '
    def clean($value):
      if ($value | type) != "string" then ""
      else
        $value
        | gsub("[\r\n]+"; " ")
        | gsub("[[:space:]]+"; " ")
        | sub("^ "; "")
        | sub(" $"; "")
      end;
    def first_non_empty($values):
      first($values[] | select(. != null and clean(.) != "")) // "";
    def normalize_log($value; $default):
      (clean($value)) as $cleaned
      | if $cleaned == "" then $default
        elif ($cleaned | test("(^|/)data/task-logs/[^/]+\\.jsonl$")) then
          ($cleaned | capture("(?<path>data/task-logs/[^/]+\\.jsonl$)").path)
        else $default
        end;
    {
      taskId: $taskId,
      branch: first_non_empty([$envBranch, $task.branch, $history.branch, $taskId]),
      suggestionId: first_non_empty([
        $envSuggestionId,
        $history.suggestionId,
        $history.feedItemId,
        $history.metadata.suggestionId,
        $history.metadata.feedItemId,
        $task.suggestionId,
        $task.feedItemId,
        $task.metadata.suggestionId,
        $task.metadata.feedItemId
      ]),
      originSessionId: first_non_empty([
        $envOriginSessionId,
        $history.originSessionId,
        $history.metadata.originSessionId,
        $task.originSessionId,
        $task.metadata.originSessionId
      ]),
      agentModel: first_non_empty([
        $envAgentModel,
        $history.agentModel,
        $history.model,
        $history.agent,
        $task.agentModel,
        $task.model,
        $task.agent
      ]),
      reasoningEffort: first_non_empty([
        $envReasoningEffort,
        $history.reasoningEffort,
        $history.reasoning,
        $task.reasoningEffort,
        $task.reasoning
      ]),
      promptSummary: (
        first_non_empty([
          $envPromptSummary,
          $history.promptSummary,
          $history.prompt,
          $history.description,
          $history.message,
          $task.promptSummary,
          $task.description,
          $task.message,
          $promptFallback
        ])
        | clean(.)
        | .[0:120]
      ),
      logFile: normalize_log(first_non_empty([$envLogFile, $history.logFile, $task.logFile, $defaultLog]); $defaultLog)
    }')"

  RECEIPT_TASK_ID="$(jq -r '.taskId' <<<"$RECEIPT_CONTEXT_JSON")"
  RECEIPT_BRANCH="$(jq -r '.branch' <<<"$RECEIPT_CONTEXT_JSON")"
  RECEIPT_SUGGESTION_ID="$(jq -r '.suggestionId' <<<"$RECEIPT_CONTEXT_JSON")"
  RECEIPT_ORIGIN_SESSION_ID="$(jq -r '.originSessionId' <<<"$RECEIPT_CONTEXT_JSON")"
  RECEIPT_AGENT_MODEL="$(resolve_receipt_agent_model "$(jq -r '.agentModel' <<<"$RECEIPT_CONTEXT_JSON")")"
  RECEIPT_REASONING_EFFORT="$(normalize_receipt_line "$(jq -r '.reasoningEffort' <<<"$RECEIPT_CONTEXT_JSON")")"
  RECEIPT_PROMPT_SUMMARY="$(truncate_receipt_line "$(normalize_receipt_line "$(jq -r '.promptSummary' <<<"$RECEIPT_CONTEXT_JSON")")")"
  RECEIPT_LOG_FILE="$(jq -r '.logFile' <<<"$RECEIPT_CONTEXT_JSON")"
}

receipt_files_touched() {
  local branch="${1:?branch required}"
  git diff --name-only HEAD.."$branch" 2>/dev/null | sed '/^$/d'
}

receipt_files_touched_count() {
  local branch="${1:?branch required}"
  local count
  count="$(receipt_files_touched "$branch" | wc -l | tr -d ' ')"
  printf '%s\n' "${count:-0}"
}

write_merge_commit_message_file() {
  local message_file="${1:?message file required}"
  local task_id="${2:?task id required}"
  local tasks_file="${3:?tasks file required}"
  local log_dir="${4:?log dir required}"
  local repo_root="${5:?repo root required}"
  local repo_dir="${6:?repo dir required}"
  local state_dir="${7:?state dir required}"
  local validation_result="${8:-skipped}"

  load_receipt_context "$task_id" "$tasks_file" "$log_dir" "$repo_root" "$repo_dir" "$state_dir"

  cat > "$message_file" <<EOF
merge: ${task_id}

Task-Id: ${task_id}
Suggestion-Id: ${RECEIPT_SUGGESTION_ID}
Origin-Session-Id: ${RECEIPT_ORIGIN_SESSION_ID}
Agent-Model: ${RECEIPT_AGENT_MODEL}
Reasoning-Effort: ${RECEIPT_REASONING_EFFORT}
Prompt-Summary: ${RECEIPT_PROMPT_SUMMARY}
Log-File: ${RECEIPT_LOG_FILE}
Validation-Result: ${validation_result}
Files-Touched-Count: $(receipt_files_touched_count "${RECEIPT_BRANCH}")
EOF
}

append_agent_receipt() {
  local task_id="${1:?task id required}"
  local tasks_file="${2:?tasks file required}"
  local log_dir="${3:?log dir required}"
  local repo_root="${4:?repo root required}"
  local repo_dir="${5:?repo dir required}"
  local state_dir="${6:?state dir required}"
  local validation_result="${7:-skipped}"
  local ledger_file="$repo_dir/data/agent-receipts.jsonl"
  local merge_commit merged_at files_json diff_summary_json shortstat files insertions deletions

  if ! git rev-parse --verify HEAD^1 >/dev/null 2>&1; then
    return 1
  fi

  load_receipt_context "$task_id" "$tasks_file" "$log_dir" "$repo_root" "$repo_dir" "$state_dir"

  merge_commit="$(git rev-parse HEAD)"
  merged_at="$(git show -s --format=%cI HEAD)"
  files_json="$(git diff --name-only HEAD^1 HEAD | jq -Rsc 'split("\n") | map(select(length > 0))')"
  shortstat="$(git diff --shortstat HEAD^1 HEAD)"
  files="$(printf '%s' "$shortstat" | grep -oE '[0-9]+ file[s]?' | head -1 | grep -oE '[0-9]+' || printf '0')"
  insertions="$(printf '%s' "$shortstat" | grep -oE '[0-9]+ insertion[s]?' | head -1 | grep -oE '[0-9]+' || printf '0')"
  deletions="$(printf '%s' "$shortstat" | grep -oE '[0-9]+ deletion[s]?' | head -1 | grep -oE '[0-9]+' || printf '0')"
  diff_summary_json="$(jq -nc \
    --argjson files "${files:-0}" \
    --argjson insertions "${insertions:-0}" \
    --argjson deletions "${deletions:-0}" \
    '{files: $files, insertions: $insertions, deletions: $deletions}')"

  mkdir -p "$(dirname "$ledger_file")"
  jq -nc \
    --arg taskId "$task_id" \
    --arg mergeCommit "$merge_commit" \
    --arg branch "$RECEIPT_BRANCH" \
    --arg mergedAt "$merged_at" \
    --arg agentModel "$RECEIPT_AGENT_MODEL" \
    --arg suggestionId "$RECEIPT_SUGGESTION_ID" \
    --arg originSessionId "$RECEIPT_ORIGIN_SESSION_ID" \
    --arg promptSummary "$RECEIPT_PROMPT_SUMMARY" \
    --arg logFile "$RECEIPT_LOG_FILE" \
    --arg validationResult "$validation_result" \
    --argjson filesTouched "$files_json" \
    --argjson diffSummary "$diff_summary_json" \
    '{
      taskId: $taskId,
      mergeCommit: $mergeCommit,
      branch: $branch,
      mergedAt: $mergedAt,
      agentModel: $agentModel,
      suggestionId: $suggestionId,
      originSessionId: ($originSessionId | if . == "" then null else . end),
      promptSummary: $promptSummary,
      logFile: $logFile,
      validationResult: $validationResult,
      filesTouched: $filesTouched,
      diffSummary: $diffSummary
    }' >> "$ledger_file"
}
