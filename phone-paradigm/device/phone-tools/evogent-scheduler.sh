#!/data/data/com.termux/files/usr/bin/bash
# evogent-scheduler.sh -- the phone-native cycle scheduler with an adaptive cadence.
#
# The schedule is bounded by data/config.md ## Curation Schedule and reshaped by durable app
# signals. This loop is the canonical owner of periodic browse+curate dispatch:
#
#   - Never browse+curate more often than the minimum interval (don't drain battery / over-curate).
#   - Always run at least once per maximum interval (feed never goes fully stale).
#   - Between the two, adapt to how productive recent cycles were: a cycle that shipped fresh
#     items resets toward the minimum (there's stuff to curate -> stay lively); a cycle that
#     shipped nothing backs off geometrically toward the maximum (idle -> go quiet). This is the
#     activity-driven trigger.
#   - An optional private quiet window forces the maximum interval. Public code carries no
#     assumption about a person's sleep or wake routine.
#
# Run detached:  tmux new -d -s evo-sched '~/phone-tools/evogent-scheduler.sh'
# Overrides: EVOGENT_MIN_INTERVAL_MIN / EVOGENT_MAX_INTERVAL_MIN / EVOGENT_QUIET_START /
#            EVOGENT_QUIET_END (hours, local). Legacy EVOGENT_CYCLE_INTERVAL_MIN pins a fixed
#            interval (disables the dynamic logic) if you really want the old behaviour.
set -u
TOOLS="$HOME/phone-tools"
EVO="$HOME/evogent"
LOG="$TOOLS/scheduler.log"
CYCLE="$TOOLS/evogent-cycle.sh"
EVO_CURL="$TOOLS/evo-curl"
export EVOGENT_API_CURL="$EVO_CURL"
ts(){ date '+%F %T'; }
say(){ echo "[$(ts)] [sched] $*" | tee -a "$LOG" >&2; }

. "$TOOLS/control-plane.sh"
control_init_owner scheduler
SCHED_LOCK="$TOOLS/.scheduler.lock"
SCHED_LOCK_HELD=0
SCHED_CONTRACT="$TOOLS/.curation-control"
TASK_QUEUE="$TOOLS/durable_task_queue.py"
SCHEDULED_TASK_ROOT="$EVO/data/.scheduler-tasks"
DREAM_STAMP="$TOOLS/.dream-stamp"
REFLECTION_STAMP="$TOOLS/.last-reflect"
scheduler_cleanup() {
  local rc=$? owner
  trap - EXIT INT TERM HUP
  owner=$(control_meta_field "$SCHED_CONTRACT" owner)
  [ "$owner" = "$CONTROL_OWNER_ID" ] && rm -f "$SCHED_CONTRACT"
  [ "$SCHED_LOCK_HELD" = 1 ] &&
    control_status_write scheduler - stopped "" "" "$rc" "scheduler exit"
  [ "$SCHED_LOCK_HELD" = 1 ] && control_lock_release "$SCHED_LOCK" || true
  control_finish_owner
  exit "$rc"
}
trap scheduler_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
if ! control_lock_acquire "$SCHED_LOCK" scheduler; then
  say "another live Termux scheduler owns curation; exiting duplicate"
  exit 0
fi
SCHED_LOCK_HELD=1
{
  printf 'mode=termux-scheduler-signal-only\n'
  printf 'owner=%s\n' "$CONTROL_OWNER_ID"
  printf 'pid=%s\n' "$$"
  printf 'start=%s\n' "$CONTROL_SELF_START"
  printf 'signal=%s\n' "$EVO/data/phone-cycle-request.json"
} > "$SCHED_CONTRACT.tmp"
mv "$SCHED_CONTRACT.tmp" "$SCHED_CONTRACT"
control_status_write scheduler - running "" "" "" \
  "signal=$EVO/data/phone-cycle-request.json"

# read the "## Curation Schedule" Minimum/Maximum interval from config.md, in minutes.
# Accepts "2 hours", "90 min", etc. Falls back to the generic 120 / 720 bounds.
sched_minutes(){ # $1 = "Minimum" | "Maximum" ; $2 = default
  awk -v want="$1 interval" -v def="$2" '
    /^## Curation Schedule/{f=1;next} f&&/^##[[:space:]]/{f=0}
    f && tolower($0) ~ tolower(want) {
      if (match($0,/[0-9]+(\.[0-9]+)?/)) {
        n=substr($0,RSTART,RLENGTH)+0
        if (tolower($0) ~ /h(our|r)?/) n=n*60
        print int(n); found=1; exit
      }
    }
    END{ if(!found) print def }
  ' "$EVO/data/config.md" 2>/dev/null
}

normalized_scheduler_bounds(){ # $1 raw minimum; $2 raw maximum; $3 legacy fixed override
  python3 "$TOOLS/scheduler_timing.py" \
    --scheduler-bounds \
    --scheduler-minimum-value="$1" \
    --scheduler-maximum-value="$2" \
    --scheduler-fixed-value="$3"
}

scheduler_cfg(){ # one-line value under an exact ## heading
  awk -v want="## $1" '
    $0==want{f=1;next} f&&/^##[[:space:]]/{exit} f&&NF{gsub(/\r/,"");print;exit}
  ' "$EVO/data/config.md" 2>/dev/null
}

# Daily private-learning passes are durable scheduler tasks, independent of normal
# browse/curate timing. ensure-nightly writes each due record before the configured
# maintenance hour; claim is atomic once due. Provider or postcondition failures retry
# with bounded backoff and eventually quarantine with receipts.
maintenance_hour(){
  local raw hour
  raw="${EVOGENT_MAINTENANCE_HOUR:-$(scheduler_cfg 'Maintenance Hour')}"
  hour=$(printf '%s\n' "$raw" | awk 'match($0,/[0-9]+/){print substr($0,RSTART,RLENGTH);exit}')
  if [[ "$hour" =~ ^[0-9]+$ ]] && [ "$hour" -ge 0 ] && [ "$hour" -le 23 ]; then
    printf '%s\n' "$hour"
  else
    # Generic product fallback, not a claim about the deployment owner's routine.
    printf '0\n'
  fi
}

run_due_reflection(){
  local ensured claim lease reflect_file brain model prompt rc transition action reflect_hour
  local insights_before cadence_before
  reflect_hour=$(maintenance_hour)
  ensured=$(python3 "$TASK_QUEUE" ensure-nightly --root "$SCHEDULED_TASK_ROOT" \
    --task reflect --hour "$reflect_hour" --legacy-stamp "$REFLECTION_STAMP" 2>>"$LOG") || {
      say "reflection-ledger: could not ensure today's durable due record"
      control_status_write reflection - failed ledger_failure 0 2 "ensure-nightly failed"
      return 2
    }
  claim=$(python3 "$TASK_QUEUE" claim --root "$SCHEDULED_TASK_ROOT" \
    --kind reflect --owner "$CONTROL_OWNER_ID" --lease-ms 1200000 2>>"$LOG") || {
      say "reflection-ledger: claim failed"
      control_status_write reflection - failed ledger_failure 0 2 "claim failed"
      return 2
    }
  lease=$(printf '%s' "$claim" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("leasePath") or "")' 2>/dev/null)
  [ -n "$lease" ] || return 0

  reflect_file="$EVO/.claude/commands/reflect.md"
  control_status_write reflection - running daily_due "" "" "scheduler-owned durable task"
  if [ ! -f "$reflect_file" ]; then
    transition=$(python3 "$TASK_QUEUE" finish --root "$SCHEDULED_TASK_ROOT" --lease "$lease" \
      --result retry --outcome reflection_instruction_missing \
      --detail "the deployed reflection command document is missing" 2>>"$LOG") || {
        say "reflection: missing instruction and retry transition failed; lease retained"
        control_status_write reflection - failed ledger_retry_failure 0 2 "lease retained"
        return 2
      }
    action=$(printf '%s' "$transition" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("action") or "retry")' 2>/dev/null)
    say "reflection: instruction missing — ledger action=$action"
    control_status_write reflection - failed "reflection_$action" 0 2 \
      "deployed reflection command document missing"
    return 2
  fi

  brain=$(scheduler_cfg 'Brain Provider' | grep -qiE 'codex' && echo codex || echo claude)
  model="${EVOGENT_CODEX_MODEL:-$(scheduler_cfg 'Codex Model')}"
  model="${model:-gpt-5.5}"
  prompt="Execute the following Evogent scheduled private reflection NOW, end to end, exactly as written. MEDIA_AGENT_INTERNAL_BASE_URL is $BASE.

$(cat "$reflect_file")"
  insights_before=$(python3 "$TOOLS/private_artifact.py" snapshot \
    --path "$EVO/data/preference-insights.md")
  cadence_before=$(python3 "$TOOLS/private_artifact.py" snapshot \
    --path "$EVO/data/source-cadence.json")
  say "reflection: claiming scheduler-owned private learning pass"
  if [ "$brain" = codex ]; then
    ( cd "$EVO" && run_owned_timeout 900 30 codex exec --model "$model" \
      -c model_reasoning_effort=medium --dangerously-bypass-approvals-and-sandbox \
      -- "$prompt" >>"$LOG" 2>&1 )
    rc=$?
  else
    ( cd "$EVO" && run_owned_timeout 900 30 env -u ANTHROPIC_API_KEY \
      CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.evogent-oauth-token" 2>/dev/null)" \
      claude -p "$prompt" --permission-mode bypassPermissions \
      --allowedTools "Bash,Read,Write,Glob,Grep" >>"$LOG" 2>&1 )
    rc=$?
  fi
  control_lock_renew "$SCHED_LOCK" || true
  if [ "$rc" -eq 0 ] \
    && python3 "$TOOLS/private_artifact.py" verify \
      --path "$EVO/data/preference-insights.md" --before "$insights_before" --kind preference \
    && python3 "$TOOLS/private_artifact.py" verify \
      --path "$EVO/data/source-cadence.json" --before "$cadence_before" --kind cadence; then
    transition=$(python3 "$TASK_QUEUE" finish --root "$SCHEDULED_TASK_ROOT" --lease "$lease" \
      --result ack --outcome reflection_completed \
      --detail "provider completed and bounded private memory/cadence artifacts verified" 2>>"$LOG") || {
        say "reflection: result valid but durable acknowledgement failed; lease retained"
        control_status_write reflection - failed ledger_ack_failure 0 2 "valid result, ack failed"
        return 2
      }
    date +%s > "$REFLECTION_STAMP"  # compatibility marker; the task receipt is authoritative
    say "reflection: durable daily task completed"
    control_status_write reflection - completed reflection_completed 0 0 \
      "bounded private memory and cadence verified"
    return 0
  fi
  transition=$(python3 "$TASK_QUEUE" finish --root "$SCHEDULED_TASK_ROOT" --lease "$lease" \
    --result retry --outcome reflection_failure \
    --detail "provider/mechanics or private-artifact postcondition failure rc=$rc" 2>>"$LOG") || {
      say "reflection: retry transition failed; lease retained for expiry recovery"
      control_status_write reflection - failed ledger_retry_failure 0 "$rc" "lease retained"
      return 2
    }
  action=$(printf '%s' "$transition" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("action") or "retry")' 2>/dev/null)
  say "reflection: failed rc=$rc — ledger action=$action"
  control_status_write reflection - failed "reflection_$action" 0 "$rc" \
    "provider/mechanics or private-artifact postcondition failed"
  return 2
}

run_due_dream(){
  local ensured claim lease dream_file brain model prompt rc transition action dream_hour
  local insights_before
  dream_hour=$(maintenance_hour)
  ensured=$(python3 "$TASK_QUEUE" ensure-nightly --root "$SCHEDULED_TASK_ROOT" \
    --task dream --hour "$dream_hour" --legacy-stamp "$DREAM_STAMP" 2>>"$LOG") || {
      say "dream-ledger: could not ensure today's durable due record"
      control_status_write dream - failed ledger_failure 0 2 "ensure-nightly failed"
      return 2
    }
  claim=$(python3 "$TASK_QUEUE" claim --root "$SCHEDULED_TASK_ROOT" \
    --kind dream --owner "$CONTROL_OWNER_ID" --lease-ms 900000 2>>"$LOG") || {
      say "dream-ledger: claim failed"
      control_status_write dream - failed ledger_failure 0 2 "claim failed"
      return 2
    }
  lease=$(printf '%s' "$claim" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("leasePath") or "")' 2>/dev/null)
  [ -n "$lease" ] || return 0

  dream_file="$EVO/.claude/commands/dream.md"
  control_status_write dream - running nightly_due "" "" "scheduler-owned durable task"
  if [ ! -f "$dream_file" ]; then
    transition=$(python3 "$TASK_QUEUE" finish --root "$SCHEDULED_TASK_ROOT" --lease "$lease" \
      --result retry --outcome dream_instruction_missing \
      --detail "the deployed dream command document is missing" 2>>"$LOG") || {
        say "dream: missing instruction and retry transition failed; lease retained"
        control_status_write dream - failed ledger_retry_failure 0 2 "lease retained"
        return 2
      }
    action=$(printf '%s' "$transition" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("action") or "retry")' 2>/dev/null)
    say "dream: instruction missing — ledger action=$action"
    control_status_write dream - failed "dream_$action" 0 2 \
      "deployed dream command document missing"
    return 2
  fi

  brain=$(scheduler_cfg 'Brain Provider' | grep -qiE 'codex' && echo codex || echo claude)
  model="${EVOGENT_CODEX_MODEL:-$(scheduler_cfg 'Codex Model')}"
  model="${model:-gpt-5.5}"
  prompt="Execute the following Evogent scheduled private taste pass NOW, end to end, exactly as written. MEDIA_AGENT_INTERNAL_BASE_URL is $BASE.

$(cat "$dream_file")"
  insights_before=$(python3 "$TOOLS/private_artifact.py" snapshot \
    --path "$EVO/data/preference-insights.md")
  say "dream: claiming scheduler-owned private taste pass"
  if [ "$brain" = codex ]; then
    ( cd "$EVO" && run_owned_timeout 600 30 codex exec --model "$model" \
      -c model_reasoning_effort=medium --dangerously-bypass-approvals-and-sandbox \
      -- "$prompt" >>"$LOG" 2>&1 )
    rc=$?
  else
    ( cd "$EVO" && run_owned_timeout 600 30 env -u ANTHROPIC_API_KEY \
      CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.evogent-oauth-token" 2>/dev/null)" \
      claude -p "$prompt" --permission-mode bypassPermissions \
      --allowedTools "Bash,Read,Glob,Grep" >>"$LOG" 2>&1 )
    rc=$?
  fi
  control_lock_renew "$SCHED_LOCK" || true
  if [ "$rc" -eq 0 ] \
    && python3 "$TOOLS/private_artifact.py" verify \
      --path "$EVO/data/preference-insights.md" --before "$insights_before" --kind preference; then
    transition=$(python3 "$TASK_QUEUE" finish --root "$SCHEDULED_TASK_ROOT" --lease "$lease" \
      --result ack --outcome dream_completed \
      --detail "provider completed and canonical bounded private memory verified" 2>>"$LOG") || {
        say "dream: result valid but durable acknowledgement failed; lease retained"
        control_status_write dream - failed ledger_ack_failure 0 2 "valid result, ack failed"
        return 2
      }
    date +%s > "$DREAM_STAMP"  # compatibility marker; the task receipt is authoritative
    say "dream: durable nightly task completed"
    control_status_write dream - completed dream_completed 0 0 "bounded memory verified"
    return 0
  fi
  transition=$(python3 "$TASK_QUEUE" finish --root "$SCHEDULED_TASK_ROOT" --lease "$lease" \
    --result retry --outcome dream_failure \
    --detail "provider/mechanics or private-memory postcondition failure rc=$rc" 2>>"$LOG") || {
      say "dream: retry transition failed; lease retained for expiry recovery"
      control_status_write dream - failed ledger_retry_failure 0 "$rc" "lease retained"
      return 2
    }
  action=$(printf '%s' "$transition" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("action") or "retry")' 2>/dev/null)
  say "dream: failed rc=$rc — ledger action=$action"
  control_status_write dream - failed "dream_$action" 0 "$rc" \
    "provider/mechanics or memory postcondition failed"
  return 2
}

QUIET_START="${EVOGENT_QUIET_START:-$(scheduler_cfg 'Quiet Start Hour')}"
QUIET_END="${EVOGENT_QUIET_END:-$(scheduler_cfg 'Quiet End Hour')}"
in_quiet_hours(){
  local h
  [[ "$QUIET_START" =~ ^[0-9]+$ ]] && [[ "$QUIET_END" =~ ^[0-9]+$ ]] || return 1
  [ "$QUIET_START" -ge 0 ] && [ "$QUIET_START" -le 23 ] || return 1
  [ "$QUIET_END" -ge 0 ] && [ "$QUIET_END" -le 23 ] || return 1
  [ "$QUIET_START" -ne "$QUIET_END" ] || return 1
  h=$(date +%-H)
  if [ "$QUIET_START" -le "$QUIET_END" ]; then
    [ "$h" -ge "$QUIET_START" ] && [ "$h" -lt "$QUIET_END" ]
  else # window wraps midnight (e.g. 23 -> 7)
    [ "$h" -ge "$QUIET_START" ] || [ "$h" -lt "$QUIET_END" ]
  fi
}

# Open-aware target: ask the app when the next feed open is probable and aim the
# next cycle start so browse+curate finishes shortly before it. Prints
# "epoch|predictedOpenLocal|prob" or nothing when there's no usable prediction.
LEAD="${EVOGENT_CYCLE_LEAD_MIN:-35}"
BASE="http://127.0.0.1:${PORT:-3001}"
predict_start(){
  "$EVO_CURL" -s -m8 "$BASE/api/internal/anticipation/next-cycle?leadMinutes=$LEAD&minIntervalMinutes=${MIN:-120}" 2>/dev/null | python3 -c '
import sys, json, datetime
try:
    d = json.load(sys.stdin)
    if not d.get("ok"):
        sys.exit(0)
    # Active-use override: the user is here NOW and content is stale past the min interval —
    # run immediately instead of waiting for the predicted next arrival.
    if d.get("activeRefreshDue"):
        print("%d|ACTIVE-NOW|due" % int(datetime.datetime.now().timestamp()))
        sys.exit(0)
    start = d.get("recommendedStartAt"); opened = d.get("predictedOpenAt")
    if not (start and opened):
        sys.exit(0)
    se = int(datetime.datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp())
    ol = datetime.datetime.fromisoformat(opened.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    p = (d.get("basis") or {}).get("chosenHourProbability")
    print("%d|%s|%s" % (se, ol, p if p is not None else "?"))
except Exception:
    sys.exit(0)
' 2>/dev/null
}

say "open-aware scheduler up (pid $$; owner $CONTROL_OWNER_ID; lead ${LEAD}m)"

# Cross-supervision (guard-the-guards): the watchdog restarts a dead scheduler (cycle-liveness),
# and the scheduler restarts a dead watchdog here — two INDEPENDENT processes (this one lives in
# tmux, the watchdog runs setsid outside tmux) each resurrect the other, so both must die in the
# same instant to stay dead. Full-reboot is covered separately by the APK BootReceiver. Cheap
# deterministic mechanics; no agent needed to keep a process alive.
ensure_watchdog(){
  control_lock_live "${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}/install.lock" && return
  control_lock_live "$TOOLS/.watchdog.lock" && return
  say "watchdog not running — re-arming"
  setsid bash "$TOOLS/evogent-watchdog.sh" >/dev/null 2>&1 < /dev/null &
}

NEXT_MIN=""
INITIAL_FLOOR_CHECKED=0
while true; do
  ensure_watchdog
  # Unlike the old opportunistic cycle block, these checks run at scheduler startup and every
  # sleep slice. A quiet/long-backoff day therefore cannot skip either due private task.
  run_due_dream || true
  run_due_reflection || true
  RAW_MIN="${EVOGENT_MIN_INTERVAL_MIN:-$(sched_minutes Minimum 120)}"
  # Adaptive cadence stays inside configured battery and freshness bounds.
  RAW_MAX="${EVOGENT_MAX_INTERVAL_MIN:-$(sched_minutes Maximum 720)}"
  # Normalize every config/env path before Bash arithmetic. A valid legacy fixed override pins
  # both bounds; malformed/decimal input can never crash the scheduler.
  BOUNDS=$(normalized_scheduler_bounds \
    "$RAW_MIN" "$RAW_MAX" "${EVOGENT_CYCLE_INTERVAL_MIN:-}" 2>>"$LOG") \
    || BOUNDS=$'120\t720'
  IFS=$'\t' read -r MIN MAX <<< "$BOUNDS"
  if ! [[ "$MIN" =~ ^[1-9][0-9]*$ && "$MAX" =~ ^[1-9][0-9]*$ ]] ||
     [ "$MAX" -lt "$MIN" ]; then
    MIN=120
    MAX=720
  fi
  [ -z "$NEXT_MIN" ] && NEXT_MIN="$MIN"
  [ "$NEXT_MIN" -lt "$MIN" ] 2>/dev/null && NEXT_MIN="$MIN"
  [ "$NEXT_MIN" -gt "$MAX" ] 2>/dev/null && NEXT_MIN="$MAX"

  # A process restart is not a content signal. Seed the first dispatch from the durable
  # successful-cycle completion stamp, so deploy/watchdog restarts cannot bypass the configured
  # minimum interval. No stamp or an overdue stamp remains immediately due.
  if [ "$INITIAL_FLOOR_CHECKED" = 0 ]; then
    INITIAL_FLOOR_CHECKED=1
    while true; do
      INITIAL_REMAIN=$(python3 "$TOOLS/scheduler_timing.py" \
        --completion-stamp "$TOOLS/.last-successful-cycle" \
        --minimum-minutes "$MIN" 2>/dev/null || echo 0)
      [[ "$INITIAL_REMAIN" =~ ^[0-9]+$ ]] || INITIAL_REMAIN=0
      [ "$INITIAL_REMAIN" -gt 0 ] || break
      say "startup respects last successful cycle: next dispatch in $(( INITIAL_REMAIN / 60 ))m (minimum ${MIN}m)"
      SLICE=$(( INITIAL_REMAIN < 60 ? INITIAL_REMAIN : 60 ))
      sleep "$SLICE"
      control_lock_renew "$SCHED_LOCK" || true
      run_due_dream || true
      run_due_reflection || true
      ensure_watchdog
    done
  fi

  REQUEST_REASON=""
  if control_claim_cycle_request 2>/dev/null; then
    REQUEST_REASON="$CONTROL_CYCLE_REQUEST_REASON"
    say "claiming coalesced cycle request ($REQUEST_REASON)"
    CYCLE_TRIGGER="signal:$REQUEST_REASON"
  else
    CYCLE_TRIGGER=scheduler
  fi
  CURATION_CYCLE_ID=$(python3 -c 'import uuid; print("phone-curation-" + str(uuid.uuid4()))' 2>/dev/null)
  if ! [[ "$CURATION_CYCLE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$ ]]; then
    say "could not mint a valid curation cycle identity; request claim retained"
    sleep 60
    continue
  fi
  control_status_write scheduler - running "" "" "" "dispatching cycle trigger=$CYCLE_TRIGGER"
  EVOGENT_CYCLE_TRIGGER="$CYCLE_TRIGGER" \
    EVOGENT_CURATION_CYCLE_ID="$CURATION_CYCLE_ID" \
    bash "$CYCLE"
  CYCLE_RC=$?
  if [ "$CYCLE_RC" -eq 0 ]; then
    [ -n "$CONTROL_CYCLE_CLAIM" ] && control_ack_cycle_claims
  else
    say "cycle exited non-zero (rc=$CYCLE_RC); request claim retained for retry"
  fi
  control_lock_renew "$SCHED_LOCK" || true
  control_status_write scheduler - running "" "" "" "waiting for next cycle"
  if [ "$CYCLE_RC" -ne 0 ]; then
    sleep 60
    continue
  fi
  CYCLE_END=$(date +%s)
  EARLIEST=$(( CYCLE_END + MIN * 60 ))   # battery floor between cycle starts
  LATEST=$(( CYCLE_END + MAX * 60 ))     # staleness ceiling: never a full max without a cycle

  # legacy productivity backoff — the fallback when no open prediction is available
  NEW=$(cat "$TOOLS/last-cycle-newitems" 2>/dev/null | tr -dc '0-9'); NEW="${NEW:-0}"
  if [ "${NEW:-0}" -gt 0 ] 2>/dev/null; then
    NEXT_MIN="$MIN"
  else
    NEXT_MIN=$(( NEXT_MIN * 3 / 2 ))
    [ "$NEXT_MIN" -gt "$MAX" ] 2>/dev/null && NEXT_MIN="$MAX"
    [ "$NEXT_MIN" -lt "$MIN" ] 2>/dev/null && NEXT_MIN="$MIN"
  fi

  # Wait toward the target in <=60s slices, re-asking the app each slice so fresh opens
  # reshape the plan. A prediction targets one specific pre-open cycle and takes precedence
  # over the optional private quiet window.
  LAST_WHY=""
  while true; do
    P="$(predict_start)"
    if [ -n "$P" ]; then
      TARGET="${P%%|*}"; REST="${P#*|}"; OPEN_AT="${REST%%|*}"; PROB="${REST#*|}"
      if [ "$OPEN_AT" = "ACTIVE-NOW" ]; then
        # User is active now and content is stale past the min interval: the min-interval floor
        # was already checked server-side, so cycle immediately without clamping to EARLIEST.
        WHY="active use: user here now + content stale -> cycle now"
      else
        [ "$TARGET" -lt "$EARLIEST" ] 2>/dev/null && TARGET="$EARLIEST"
        [ "$TARGET" -gt "$LATEST" ] 2>/dev/null && TARGET="$LATEST"
        WHY="open predicted ~${OPEN_AT} (p=${PROB}) -> start T-${LEAD}m"
      fi
    else
      TARGET=$(( CYCLE_END + NEXT_MIN * 60 ))
      if in_quiet_hours; then TARGET="$LATEST"; WHY="no prediction; quiet hours -> max ${MAX}m"
      else WHY="no prediction; productivity backoff ${NEXT_MIN}m"; fi
    fi
    # A coalesced app/server request may accelerate a later prediction/backoff target, but it
    # cannot bypass the battery floor between successful cycles.
    if control_cycle_request_pending; then
      TARGET="$EARLIEST"
      WHY="cycle request pending -> run at minimum-interval floor"
    fi
    NOW=$(date +%s)
    REMAIN=$(( TARGET - NOW ))
    if [ "$REMAIN" -le 0 ]; then
      say "cycle due (${WHY})"
      break
    fi
    if [ "$WHY" != "$LAST_WHY" ]; then
      say "next cycle in $(( REMAIN / 60 ))m (${WHY}; min ${MIN}/max ${MAX})"
      LAST_WHY="$WHY"
    fi
    SLICE=$(( REMAIN < 60 ? REMAIN : 60 ))
    sleep "$SLICE"
    control_lock_renew "$SCHED_LOCK" || true
    run_due_dream || true
    run_due_reflection || true
    # Cross-supervision cadence fix: checking the watchdog only once per cycle left it dead for
    # hours. Re-check every <=60s signal slice.
    ensure_watchdog
  done
done
