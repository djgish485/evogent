#!/data/data/com.termux/files/usr/bin/bash
# Keep the Evogent server alive unattended (overnight). Every few minutes, if the server stops
# answering (crash under a cycle's memory load, doze kill, etc.), bring the whole stack back via
# the idempotent evogent-boot.sh. It runs outside tmux; restart-evo replaces only the `evo`
# server session. Single-instance via a PID+start lease.
set -u
TOOLS="$HOME/phone-tools"
LOG="$HOME/evogent-watchdog.log"
RELEASE_ROOT="${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"
WATCHDOG_SOURCE="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || true)"
WATCHDOG_RELEASE="$(dirname "$(dirname "$WATCHDOG_SOURCE")")"
if [ -n "$WATCHDOG_SOURCE" ] \
    && [ "$(dirname "$WATCHDOG_RELEASE")" = "$RELEASE_ROOT/releases" ]; then
  if [ -n "${EVOGENT_CONTROL_RELEASE_ROOT:-}" ] \
      && [ "$EVOGENT_CONTROL_RELEASE_ROOT" != "$WATCHDOG_RELEASE" ]; then
    exit 70
  fi
  if [ "${EVOGENT_CONTROL_RELEASE_ROOT:-}" != "$WATCHDOG_RELEASE" ]; then
    exec env EVOGENT_CONTROL_RELEASE_ROOT="$WATCHDOG_RELEASE" \
      bash "$TOOLS/evogent-watchdog.sh" "$@"
  fi
else
  unset EVOGENT_CONTROL_RELEASE_ROOT
fi
BASE="http://127.0.0.1:${PORT:-3001}"
EVO_CURL="$TOOLS/evo-curl"
export EVOGENT_API_CURL="$EVO_CURL"
say(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }
max_cycle_interval_min() {
  local config_min config_max bounds normalized_min normalized_max
  config_min=$(awk '
    /^## Curation Schedule/{f=1;next}
    f&&/^##[[:space:]]/{f=0}
    f && tolower($0) ~ /minimum interval/ {
      if (match($0,/[0-9]+(\.[0-9]+)?/)) {
        n=substr($0,RSTART,RLENGTH)+0
        if (tolower($0) ~ /h(our|r)?/) n=n*60
        print int(n); found=1; exit
      }
    }
    END{if(!found) print 120}
  ' "$HOME/evogent/data/config.md" 2>/dev/null)
  config_max=$(awk '
    /^## Curation Schedule/{f=1;next}
    f&&/^##[[:space:]]/{f=0}
    f && tolower($0) ~ /maximum interval/ {
      if (match($0,/[0-9]+(\.[0-9]+)?/)) {
        n=substr($0,RSTART,RLENGTH)+0
        if (tolower($0) ~ /h(our|r)?/) n=n*60
        print int(n); found=1; exit
      }
    }
    END{if(!found) print 720}
  ' "$HOME/evogent/data/config.md" 2>/dev/null
  )
  bounds=$(python3 "$TOOLS/scheduler_timing.py" \
    --scheduler-bounds \
    --scheduler-minimum-value="${EVOGENT_MIN_INTERVAL_MIN:-$config_min}" \
    --scheduler-maximum-value="${EVOGENT_MAX_INTERVAL_MIN:-$config_max}" \
    --scheduler-fixed-value="${EVOGENT_CYCLE_INTERVAL_MIN:-}" 2>/dev/null) \
    || bounds=$'120\t720'
  IFS=$'\t' read -r normalized_min normalized_max <<< "$bounds"
  if [[ "$normalized_min" =~ ^[1-9][0-9]*$ &&
        "$normalized_max" =~ ^[1-9][0-9]*$ ]] &&
     [ "$normalized_max" -ge "$normalized_min" ]; then
    printf '%s\n' "$normalized_max"
  else
    printf '720\n'
  fi
}
. "$TOOLS/control-plane.sh"
watchdog_status_write() {
  local policy="$1" rc=0
  shift
  [ "$policy" = required ] || [ "$policy" = heartbeat ] || return 64
  control_status_write watchdog "$@" || rc=$?
  case "$rc:$policy" in
    0:*) return 0 ;;
    75:heartbeat)
      say "watchdog status heartbeat timed out; live owner retained for retry"
      return 0
      ;;
    75:required)
      say "CRITICAL: initial watchdog status publication timed out"
      return 75
      ;;
    *)
      say "CRITICAL: watchdog status publication failed structurally"
      return 1
      ;;
  esac
}
control_init_owner watchdog
WATCHDOG_LOCK="$TOOLS/.watchdog.lock"
WATCHDOG_LOCK_HELD=0
WATCHDOG_MUTATION_GATE_HELD=0
watchdog_release_mutation_gate() {
  [ "$WATCHDOG_MUTATION_GATE_HELD" = 1 ] || return 0
  control_release_mutation_gate_release || {
    say "CRITICAL: watchdog mutation lease could not be retired"
    exit 70
  }
  WATCHDOG_MUTATION_GATE_HELD=0
}
watchdog_cleanup() {
  local rc=$? attempt
  trap - EXIT INT TERM HUP
  # A duplicate process that failed to acquire the lock owns no status.  Letting its EXIT trap
  # write "stopped" would clobber the real watchdog's heartbeat with the duplicate's PID.
  [ "$WATCHDOG_LOCK_HELD" = 1 ] &&
    control_status_write watchdog - stopped "" "" "$rc" "watchdog exit"
  for attempt in 1 2 3; do
    [ "$WATCHDOG_MUTATION_GATE_HELD" = 1 ] || break
    if control_release_mutation_gate_release; then
      WATCHDOG_MUTATION_GATE_HELD=0
      break
    fi
    sleep 1
  done
  [ "$WATCHDOG_LOCK_HELD" = 1 ] && control_lock_release "$WATCHDOG_LOCK" || true
  control_finish_owner
  exit "$rc"
}
trap watchdog_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Single instance: prove both PID and process starttime so PID reuse cannot impersonate an owner.
if ! control_lock_acquire "$WATCHDOG_LOCK" watchdog; then
  control_finish_owner
  exit 0
fi
WATCHDOG_LOCK_HELD=1
rm -f "$TOOLS/.watchdog.pid"  # legacy pid-only ownership marker
watchdog_status_write required - running "" "" "" \
  "independent control-plane supervisor" || exit 70

say "watchdog up (pid $$; owner $CONTROL_OWNER_ID; no permanent wakelock)"
fails=0
while true; do
  sleep 60
  control_lock_renew "$WATCHDOG_LOCK" || true
  watchdog_status_write heartbeat - running "" "" "" \
    "independent control-plane supervisor" || exit 70
  # SIGKILL and kernel/process death bypass a cycle's EXIT trap. Reap dead
  # reference owners every watchdog tick so a scoped Termux wake lock cannot
  # silently become a permanent battery drain after an abnormal exit. Live
  # cycle/discovery owners keep their reference and are never unlocked here.
  control_release_legacy_wake_if_idle
  # The durable release journal owns restart ordering from quiesce through a
  # proved rollback or committed finalization. Its presence survives SIGKILL;
  # an install lease without a journal is only non-disruptive preflight/build.
  if control_release_transaction_pending "$RELEASE_ROOT"; then
    fails=0
    continue
  fi
  if ! control_release_mutation_gate_acquire \
      "$RELEASE_ROOT" watchdog-control-tick; then
    if [ -n "$CONTROL_RELEASE_MUTATION_GATE" ]; then
      WATCHDOG_MUTATION_GATE_HELD=1
      say "CRITICAL: watchdog mutation barrier retirement failed"
      exit 70
    fi
    fails=0
    continue
  fi
  WATCHDOG_MUTATION_GATE_HELD=1
  # GUARD THE GUARDS: every flow-health check (barren tripwire, sources-flowing, verify-intents)
  # runs INSIDE the cycle — if the scheduler dies, all of them die with it and the system is
  # blind. A cycle advances .last-completed-cycle only after a validated terminal curation
  # receipt, even if a source or owner-controlled capability was degraded. If that stamp goes
  # stale beyond the configured maximum plus a one-hour completion grace, signal the owner.
  # Full-quality success remains separate telemetry and cannot amplify provider work.
  # Scheduler PID+start liveness first, stamp staleness second. A completion stamp says a cycle
  # once finished, not that its scheduler still exists.
  if ! control_lock_live "$TOOLS/.scheduler.lock"; then
    if "$TOOLS/evo-health" >/dev/null 2>&1; then
      say "scheduler-liveness: evo-sched session is GONE — restarting now"
      tmux kill-session -t '=evo-sched' 2>/dev/null || true
      tmux new-session -d -s evo-sched \
        "exec bash '$TOOLS/evogent-scheduler.sh' >> '$HOME/evo-sched.log' 2>&1"
    else
      say "scheduler-liveness: local server unavailable — provider scheduler remains stopped"
    fi
  fi
  COMPLETION_STAMP="$TOOLS/.last-completed-cycle"
  LEGACY_SUCCESS_STAMP="$TOOLS/.last-successful-cycle"
  NO_COMPLETION_BASELINE="$TOOLS/.no-completed-cycle-baseline"
  OVERDUE_SIGNAL="$TOOLS/.cycle-overdue-signalled"
  MAX_CYCLE_MIN="$(max_cycle_interval_min)"
  [[ "$MAX_CYCLE_MIN" =~ ^[0-9]+$ ]] || MAX_CYCLE_MIN=720
  OVERDUE_MIN=$((MAX_CYCLE_MIN + 60))
  COMPLETION_REFERENCE_PATH=""
  COMPLETION_REFERENCE_OVERDUE=0
  if COMPLETION_REFERENCE_RECORD=$(python3 "$TOOLS/scheduler_timing.py" \
    --watchdog-completion-stamp "$COMPLETION_STAMP" \
    --watchdog-legacy-success-stamp "$LEGACY_SUCCESS_STAMP" \
    --watchdog-missing-baseline "$NO_COMPLETION_BASELINE" \
    --watchdog-overdue-minutes "$OVERDUE_MIN" 2>/dev/null); then
    IFS=$'\t' read -r COMPLETION_REFERENCE_PATH COMPLETION_REFERENCE_OVERDUE \
      <<< "$COMPLETION_REFERENCE_RECORD"
  fi
  [[ "$COMPLETION_REFERENCE_OVERDUE" =~ ^[01]$ ]] || COMPLETION_REFERENCE_OVERDUE=0
  if [ "$COMPLETION_REFERENCE_OVERDUE" = 1 ]; then
    if control_lock_live "$TOOLS/.cycle.lock"; then
      say "cycle-liveness: completion stamp stale but a proved-live cycle owns the lease — preserving work"
    elif [ ! -f "$OVERDUE_SIGNAL" ] ||
         [ -z "$(find "$OVERDUE_SIGNAL" -mmin -60 2>/dev/null)" ]; then
      # A live scheduler gets a wake-up signal, not a destructive tmux restart. It checks this
      # within 60s; only a dead PID+start lease is replaced by the liveness branch above.
      control_request_cycle "watchdog: no completed cycle in over ${OVERDUE_MIN}m"
      touch "$OVERDUE_SIGNAL"
      say "cycle-liveness: no cycle completed in >${OVERDUE_MIN}m — signalled sole scheduler"
      "$EVO_CURL" -s -m8 -X POST "$BASE/api/internal/curate/submit" \
        -H 'content-type: application/json' \
        -d "{\"items\":[{\"type\":\"notification\",\"source\":\"phone\",\"sourceId\":\"cycle-liveness\",\"title\":\"Background cycle is overdue — wake-up requested\",\"text\":\"No browse/curate cycle completed within the configured maximum plus its completion grace (${OVERDUE_MIN} minutes). The live on-phone scheduler was signalled without interrupting any active work.\",\"metadata\":{\"notificationId\":\"cycle-liveness\",\"severity\":\"warning\"}}]}" \
        >/dev/null 2>&1
    fi
  else
    rm -f "$OVERDUE_SIGNAL"
  fi
  # Disk-free guard: a full data partition silently blocks every SQLite write and screenshot
  # save (data/tmp, agent-logs, APK staging all grow unbounded) with no error anyone sees. Cheap
  # df check (<1s); warn once per crossing below ~500MB.
  FREEMB=$(df -m "$HOME" 2>/dev/null | awk 'NR==2{print $4}')
  if [ -n "${FREEMB:-}" ] && [ "$FREEMB" -lt 500 ] 2>/dev/null; then
    if [ ! -f "$TOOLS/.diskfull-warned" ]; then
      touch "$TOOLS/.diskfull-warned"
      say "DISK LOW: ${FREEMB}MB free — writes at risk; notifying user"
      "$EVO_CURL" -s -m8 -X POST "$BASE/api/internal/curate/submit" -H 'content-type: application/json' -d "{
        \"items\":[{\"type\":\"notification\",\"source\":\"phone\",\"sourceId\":\"disk-low\",
          \"title\":\"Phone storage almost full\",\"text\":\"Only ${FREEMB}MB free on Evogent's storage. Content saves and the feed database may start failing. Freeing space (or letting old backups/logs prune) will restore normal operation.\",
          \"metadata\":{\"notificationId\":\"disk-low\",\"severity\":\"warning\"}}]}" >/dev/null 2>&1
    fi
  else
    rm -f "$TOOLS/.diskfull-warned"
  fi
  if "$TOOLS/evo-health"; then
    code=200
  else
    code=000
  fi
  if [ "$code" = "200" ]; then
    fails=0
    watchdog_release_mutation_gate
    continue
  fi
  # Don't fight a browse/curate cycle that's mid-run (it can briefly load the server); only act
  # after two consecutive failures ~3min apart.
  fails=$((fails + 1))
  if control_lock_live "$TOOLS/.cycle.lock"; then
    # A held cycle lock must not block server revival indefinitely. The full-stack
    # boot path would tmux-kill the running cycle — so do a SCOPED server-only revive instead:
    # replace just the evo session; the scheduler, cycle, and their tmux sessions are untouched.
    if [ "$fails" -ge 2 ]; then
      say "server down ($code) with a cycle mid-run — scoped server-only revive (cycle untouched)"
      tmux kill-session -t '=evo' 2>/dev/null
      tmux new-session -d -s evo "bash $HOME/start-prod.sh >> $HOME/evogent-server.log 2>&1"
      fails=0
    else
      say "server $code but a cycle holds the lock — one more check before scoped revive"
    fi
    watchdog_release_mutation_gate
    continue
  fi
  if [ "$fails" -ge 2 ]; then
    say "server down ($code) for 2 checks — restarting stack via evogent-boot.sh"
    watchdog_release_mutation_gate
    bash "$TOOLS/evogent-boot.sh" >/dev/null 2>&1
    fails=0
  fi
  watchdog_release_mutation_gate
done
