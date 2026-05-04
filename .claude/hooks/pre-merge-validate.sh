#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="${1:-$(pwd)}"
STARTUP_TIMEOUT_SECONDS="${MEDIA_AGENT_STARTUP_SMOKE_TIMEOUT_SECONDS:-8}"
LINT_TIMEOUT_SECONDS="${MEDIA_AGENT_VALIDATION_LINT_TIMEOUT_SECONDS:-300}"
BUILD_TIMEOUT_SECONDS="${MEDIA_AGENT_VALIDATION_BUILD_TIMEOUT_SECONDS:-900}"
TEST_TIMEOUT_SECONDS="${MEDIA_AGENT_VALIDATION_TEST_TIMEOUT_SECONDS:-1800}"
KILL_GRACE_SECONDS="${MEDIA_AGENT_VALIDATION_KILL_GRACE_SECONDS:-5}"
TAIL_LINES="${MEDIA_AGENT_VALIDATION_LOG_TAIL_LINES:-40}"
RUNNING_PGID=""
RUNNING_TIMER_PID=""
SUPPRESS_EXIT_RESULT=0

cd "$WORKTREE_DIR"
WORKTREE_DIR="$(pwd -P)"
TASK_ID="${MEDIA_AGENT_TASK_ID:-$(basename "$WORKTREE_DIR")}"
EXPECTED_WORKTREE="${MEDIA_AGENT_EXPECTED_WORKTREE:-$WORKTREE_DIR}"
EXPECTED_WORKTREE="$(cd "$EXPECTED_WORKTREE" && pwd -P)"

if [ -n "${DATA_DIR:-}" ]; then
  mkdir -p "$DATA_DIR"
fi

is_validation_path() {
  local legacy_slug
  legacy_slug="media""-agent"
  case "$1" in
    /tmp/evogent-validation|/tmp/evogent-validation/*|/root/evogent-worktrees|/root/evogent-worktrees/*|/tmp/${legacy_slug}-validation|/tmp/${legacy_slug}-validation/*|/root/${legacy_slug}-worktrees|/root/${legacy_slug}-worktrees/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if is_validation_path "${DATA_DIR:-}" \
  || is_validation_path "${MEDIA_AGENT_VALIDATION_DATA_DIR:-}" \
  || is_validation_path "$WORKTREE_DIR"; then
  VALIDATION_PORT="${PORT:-${MEDIA_AGENT_VALIDATION_PORT:-}}"
  if [ -n "$VALIDATION_PORT" ]; then
    export PORT="$VALIDATION_PORT"
    export HOST="${MEDIA_AGENT_VALIDATION_HOST:-127.0.0.1}"
    VALIDATION_INTERNAL_BASE_URL="http://127.0.0.1:${VALIDATION_PORT}"
    export MEDIA_AGENT_INTERNAL_BASE_URL="$VALIDATION_INTERNAL_BASE_URL"
    export ORCHESTRATOR_INTERNAL_URL="$VALIDATION_INTERNAL_BASE_URL"
    export MEDIA_AGENT_ROOT="$WORKTREE_DIR"
    export MEDIA_AGENT_DISABLE_BACKGROUND_JOBS="${MEDIA_AGENT_DISABLE_BACKGROUND_JOBS:-1}"
  fi
fi

export NEXT_TELEMETRY_DISABLED=1
export MEDIA_AGENT_STATE_DIR="${MEDIA_AGENT_STATE_DIR:-${MEDIA_AGENT_VALIDATION_STATE_DIR:-${DATA_DIR:-$WORKTREE_DIR/data}/agent-state}}"

EVIDENCE_DIR="$MEDIA_AGENT_STATE_DIR/logs/validation/$TASK_ID"
COMMAND_LOG_DIR="$EVIDENCE_DIR/commands"
RESULT_FILE="$EVIDENCE_DIR/result.txt"
mkdir -p "$COMMAND_LOG_DIR"

write_result() {
  local status="$1"
  local reason="$2"
  local command="${3:-}"
  local duration="${4:-0}"
  local log_path="${5:-}"
  local tail_path="${6:-}"
  {
    printf 'status=%s\n' "$status"
    printf 'taskId=%s\n' "$TASK_ID"
    printf 'worktree=%s\n' "$WORKTREE_DIR"
    printf 'reason=%s\n' "$reason"
    printf 'command=%s\n' "$command"
    printf 'durationSeconds=%s\n' "$duration"
    printf 'logPath=%s\n' "$log_path"
    printf 'tailPath=%s\n' "$tail_path"
  } > "$RESULT_FILE"
}

fail_without_command() {
  local reason="$1"
  write_result "failed" "$reason"
  echo "FAIL: $reason"
  echo "Validation evidence: $RESULT_FILE"
  exit 1
}

kill_process_group() {
  local pgid="$1"
  [ -z "$pgid" ] && return 0
  kill -TERM "-$pgid" 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt "$KILL_GRACE_SECONDS" ]; do
    if ! kill -0 "-$pgid" 2>/dev/null; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL "-$pgid" 2>/dev/null || true
}

kill_timer_group() {
  local pgid="$1"
  [ -z "$pgid" ] && return 0
  kill -TERM "-$pgid" 2>/dev/null || true
  sleep 0.05
  kill -KILL "-$pgid" 2>/dev/null || true
}

cleanup() {
  local exit_code=$?
  if [ -n "$RUNNING_PGID" ]; then
    kill_process_group "$RUNNING_PGID"
  fi
  if [ -n "$RUNNING_TIMER_PID" ]; then
    kill_timer_group "$RUNNING_TIMER_PID"
  fi
  if [ "$SUPPRESS_EXIT_RESULT" -eq 0 ] && [ "$exit_code" -ne 0 ] && [ ! -f "$RESULT_FILE" ]; then
    write_result "failed" "validation exited before recording command evidence"
  fi
}
trap cleanup EXIT

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-'
}

run_with_timeout() {
  local label="$1"
  local timeout_seconds="$2"
  local command="$3"
  local timeout_is_success="${4:-0}"
  local slug
  slug="$(slugify "$label")"
  local log_path="$COMMAND_LOG_DIR/${slug}.log"
  local tail_path="$COMMAND_LOG_DIR/${slug}.tail"
  local start_seconds
  start_seconds="$(date +%s)"
  local status=0
  local timed_out=0
  local timeout_marker="$COMMAND_LOG_DIR/${slug}.timeout"
  rm -f "$timeout_marker"

  echo "--- $label ---"
  {
    printf 'taskId=%s\n' "$TASK_ID"
    printf 'worktree=%s\n' "$WORKTREE_DIR"
    printf 'command=%s\n' "$command"
    printf 'timeoutSeconds=%s\n' "$timeout_seconds"
    printf -- '--- output ---\n'
  } > "$log_path"

  set +e
  setsid bash -lc "$command" >> "$log_path" 2>&1 &
  local child_pid=$!
  RUNNING_PGID="$child_pid"
  setsid bash -c '
    sleep "$1"
    if kill -0 "$2" 2>/dev/null; then
      touch "$3"
      kill -TERM "-$2" 2>/dev/null || true
      sleep "$4"
      kill -KILL "-$2" 2>/dev/null || true
    fi
  ' _ "$timeout_seconds" "$child_pid" "$timeout_marker" "$KILL_GRACE_SECONDS" >/dev/null 2>&1 &
  local timer_pid=$!
  RUNNING_TIMER_PID="$timer_pid"

  wait "$child_pid" 2>/dev/null
  status=$?
  if kill -0 "$timer_pid" 2>/dev/null; then
    kill_timer_group "$timer_pid"
    wait "$timer_pid" 2>/dev/null || true
  fi
  RUNNING_PGID=""
  RUNNING_TIMER_PID=""
  if [ -f "$timeout_marker" ]; then
    timed_out=1
    rm -f "$timeout_marker"
  fi
  set -e

  local end_seconds
  end_seconds="$(date +%s)"
  local duration=$((end_seconds - start_seconds))

  if [ "$timed_out" -eq 1 ] && [ "$timeout_is_success" -eq 1 ]; then
    echo "PASS: $label stayed up for ${timeout_seconds}s"
    return 0
  fi

  if [ "$timed_out" -eq 1 ]; then
    tail -n "$TAIL_LINES" "$log_path" > "$tail_path" || true
    write_result "failed" "command timed out" "$command" "$duration" "$log_path" "$tail_path"
    echo "FAIL: command '$command' timed out after ${timeout_seconds}s (duration ${duration}s). Log: $log_path Tail: $tail_path"
    return 124
  fi

  if [ "$status" -ne 0 ]; then
    tail -n "$TAIL_LINES" "$log_path" > "$tail_path" || true
    write_result "failed" "command failed with exit $status" "$command" "$duration" "$log_path" "$tail_path"
    echo "FAIL: command '$command' failed after ${duration}s (exit $status). Log: $log_path Tail: $tail_path"
    return "$status"
  fi

  echo "PASS: $label (${duration}s)"
  return 0
}

if [ "$WORKTREE_DIR" != "$EXPECTED_WORKTREE" ]; then
  fail_without_command "expected worktree $EXPECTED_WORKTREE but validating $WORKTREE_DIR"
fi

if [ ! -f "$WORKTREE_DIR/.agent-done" ]; then
  fail_without_command "missing .agent-done evidence at $WORKTREE_DIR/.agent-done"
fi

LOCK_DIR="$MEDIA_AGENT_STATE_DIR/validation-locks"
mkdir -p "$LOCK_DIR"
LOCK_KEY="$(printf '%s|%s' "$TASK_ID" "$WORKTREE_DIR" | cksum | awk '{print $1}')"
LOCK_FILE="$LOCK_DIR/pre-merge-${LOCK_KEY}.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  HOLDER="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  REASON="duplicate validation runner for task $TASK_ID worktree $WORKTREE_DIR"
  DUPLICATE_RESULT_FILE="$EVIDENCE_DIR/duplicate-${$}.txt"
  {
    printf 'status=duplicate\n'
    printf 'taskId=%s\n' "$TASK_ID"
    printf 'worktree=%s\n' "$WORKTREE_DIR"
    printf 'reason=%s; owner: %s\n' "$REASON" "${HOLDER:-unknown}"
  } > "$DUPLICATE_RESULT_FILE"
  echo "SKIP: $REASON; owner: ${HOLDER:-unknown}"
  echo "Validation evidence: $DUPLICATE_RESULT_FILE"
  SUPPRESS_EXIT_RESULT=1
  exit 75
fi
printf 'taskId=%s pid=%s worktree=%s startedAt=%s\n' "$TASK_ID" "$$" "$WORKTREE_DIR" "$(date -Is)" > "$LOCK_FILE"
rm -f "$RESULT_FILE"

for script_name in lint build test; do
  if ! node -e "const pkg=require('./package.json'); process.exit(pkg.scripts && pkg.scripts[process.argv[1]] ? 0 : 1)" "$script_name" >/dev/null 2>&1; then
    fail_without_command "missing required npm script '$script_name' in $WORKTREE_DIR/package.json"
  fi
done

echo "=== Pre-merge validation ==="
echo "Task: $TASK_ID"
echo "Worktree: $WORKTREE_DIR"
echo "Evidence: $RESULT_FILE"
echo "--- Startup smoke check ---"

run_with_timeout "Startup smoke check" "$STARTUP_TIMEOUT_SECONDS" "node -e \"require('./server.js')\"" 1

run_with_timeout "Lint check" "$LINT_TIMEOUT_SECONDS" "npm run lint"
run_with_timeout "Build check" "$BUILD_TIMEOUT_SECONDS" "npm run build"
run_with_timeout "Test check" "$TEST_TIMEOUT_SECONDS" "npm run test"

write_result "passed" "all validation commands passed"
echo "=== Pre-merge validation complete ==="
