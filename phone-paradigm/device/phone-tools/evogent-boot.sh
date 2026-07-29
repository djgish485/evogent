#!/data/data/com.termux/files/usr/bin/bash
# Canonical on-device boot bringup for the Evogent phone paradigm. Idempotent and
# self-contained: safe to run more than once and from either boot path —
#   (a) the Evogent APK's BootReceiver via a Termux RUN_COMMAND intent (no addon needed), or
#   (b) the Termux:Boot addon (~/.termux/boot/10-evogent.sh sources this), if installed.
# A standalone user phone needs NO Mac and NO sshd — the server + app + browse all run
# on-device. sshd is started only when ~/.evogent-dev-ssh exists (a dev/Mac-access opt-in).
set -u
TOOLS="$HOME/phone-tools"
LOG="$HOME/evogent-boot.log"
RELEASE_ROOT="${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"
HOST_POLICY_INCIDENT_DIR="$TOOLS/.incident-phone-host-policy-action-required"
export EVOGENT_API_CURL="$TOOLS/evo-curl"
say(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

BOOT_SOURCE="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || true)"
BOOT_RELEASE="$(dirname "$(dirname "$BOOT_SOURCE")")"
if [ -n "$BOOT_SOURCE" ] \
    && [ "$(dirname "$BOOT_RELEASE")" = "$RELEASE_ROOT/releases" ]; then
  export EVOGENT_CONTROL_RELEASE_ROOT="$BOOT_RELEASE"
else
  unset EVOGENT_CONTROL_RELEASE_ROOT
fi

# SIGKILL and reboot bypass the installer's EXIT trap.  Before any component is
# allowed to start, finish the durable transaction policy through the private
# recovery copy written before the first switch: pre-decision work rolls back,
# while a verified committed decision is re-proven and finalized in place. The
# installer's own restart path sets the bypass to avoid recursive recovery.
INSTALL_JOURNAL="$RELEASE_ROOT/install-transaction/journal.json"
INSTALL_RECOVERER="$RELEASE_ROOT/install-transaction/install-release.sh"
if [ "${EVOGENT_RELEASE_RECOVERY:-0}" != 1 ] \
    && { [ -e "$INSTALL_JOURNAL" ] || [ -L "$INSTALL_JOURNAL" ]; }; then
  if [ ! -f "$INSTALL_JOURNAL" ] || [ -L "$INSTALL_JOURNAL" ] \
      || [ ! -f "$INSTALL_RECOVERER" ] || [ -L "$INSTALL_RECOVERER" ]; then
    say "CRITICAL: interrupted release has unsafe or incomplete recovery metadata"
    exit 70
  fi
  say "interrupted release transaction detected; recovering before boot"
  bash "$INSTALL_RECOVERER" --recover "$INSTALL_JOURNAL" >> "$LOG" 2>&1 || {
    say "CRITICAL: interrupted release recovery failed; control plane remains stopped"
    exit 70
  }
  # The pinned recoverer has already restored or finalized the durable
  # live/stopped/absent contract. This candidate boot must not reinterpret it.
  exit 0
fi

. "$TOOLS/control-plane.sh"
control_init_owner boot || exit 70
BOOT_MUTATION_GATE_HELD=0
boot_cleanup() {
  local rc=$? attempt
  trap - EXIT INT TERM HUP
  for attempt in 1 2 3; do
    [ "$BOOT_MUTATION_GATE_HELD" = 1 ] || break
    if control_release_mutation_gate_release; then
      BOOT_MUTATION_GATE_HELD=0
      break
    fi
    sleep 1
  done
  control_finish_owner
  exit "$rc"
}
trap boot_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

server_code() {
  if "$TOOLS/evo-health"; then
    printf '200\n'
  else
    printf '000\n'
  fi
}

surface_host_policy_action() {
  if ! mkdir -m 700 "$HOST_POLICY_INCIDENT_DIR" 2>/dev/null; then
    [ -d "$HOST_POLICY_INCIDENT_DIR" ] &&
      [ ! -L "$HOST_POLICY_INCIDENT_DIR" ]
    return
  fi
  if ! "$TOOLS/evo-curl" -fsS -m8 -X POST \
      "http://127.0.0.1:${PORT:-3001}/api/internal/curate/submit" \
      -H 'content-type: application/json' -d '{
        "items":[{
          "type":"notification",
          "source":"phone",
          "sourceId":"phone-host-policy-action-required",
          "title":"Phone setup needs attention",
          "text":"Evogent left Android host policy unchanged. A technical owner can follow the stock-phone setup guide to enable the supported background-process and external-display options; app-backed work stays deferred until read-only proof passes.",
          "metadata":{
            "notificationId":"phone-host-policy-action-required",
            "incidentKey":"phone-capability-host-policy",
            "reactivateOnRepeat":true,
            "severity":"warning",
            "userActionKind":"phone_host_policy"
          }
        }]
      }' >/dev/null 2>&1; then
    rmdir "$HOST_POLICY_INCIDENT_DIR" 2>/dev/null || true
    return 1
  fi
}

clear_host_policy_action() {
  [ -d "$HOST_POLICY_INCIDENT_DIR" ] &&
    [ ! -L "$HOST_POLICY_INCIDENT_DIR" ] || return 0
  "$TOOLS/evo-curl" -fsS -m8 -X POST \
    "http://127.0.0.1:${PORT:-3001}/api/internal/notifications/resolve" \
    -H 'content-type: application/json' \
    -d '{"notificationId":"phone-host-policy-action-required"}' \
    >/dev/null 2>&1 || return 1
  rmdir "$HOST_POLICY_INCIDENT_DIR" 2>/dev/null
}

wait_for_control_owner_status() {
  local section="$1" lock="$2" max_age_seconds="$3"
  for _ in $(seq 1 20); do
    control_status_owner_live "$section" "$lock" "$max_age_seconds" \
      && return 0
    sleep 1
  done
  return 1
}

exec >>"$LOG" 2>&1
say "=== evogent-boot start (pid $$) ==="

# A durable release transaction owns server/scheduler/watchdog ordering. A live
# installer lease without a journal is only preflight/build, when production is
# intentionally still allowed to heal. The installer invokes candidate boot
# with the explicit internal bypass while its journal is pending.
if [ "${EVOGENT_RELEASE_BOOT:-0}" != 1 ] \
    && control_release_transaction_pending "$RELEASE_ROOT"; then
  say "durable release transaction owns the control plane — boot bringup deferred"
  exit 0
fi

# Serialize every normal-boot mutation, including wake reconciliation and
# Shizuku/appops/settings repair, with durable journal publication. The acquire
# helper rechecks the journal while holding the same stable gate.
if [ "${EVOGENT_RELEASE_BOOT:-0}" != 1 ]; then
  if ! control_release_mutation_gate_acquire "$RELEASE_ROOT" boot-bringup; then
    if [ -n "$CONTROL_RELEASE_MUTATION_GATE" ]; then
      BOOT_MUTATION_GATE_HELD=1
      say "CRITICAL: boot mutation barrier retirement failed; exiting through cleanup"
      exit 70
    fi
    say "release control-plane mutation barrier is busy or pending — boot bringup deferred"
    exit 0
  fi
  BOOT_MUTATION_GATE_HELD=1
fi

# The generic app config is shared with desktop deployments. Before any
# phone-owned provider work can start, add only absent phone route headings.
# Existing headings (including intentionally blank ones) remain user-owned.
if python3 "$TOOLS/model_routing.py" ensure-phone-config \
    --config "$HOME/evogent/data/config.md" >/dev/null 2>&1; then
  say "phone model-route defaults verified"
else
  # Keep the native/server recovery path available. The cycle and discovery
  # dispatchers independently fail closed before spending provider work.
  say "WARN: phone model-route defaults could not be verified; provider cycles will defer"
fi

# Retire the old permanent Termux wakelock. Cycles/discoveries now acquire a reference-counted
# lock only for their bounded work and release it from EXIT/TERM cleanup.
control_release_legacy_wake_if_idle

# Shell access is probed later, after the private server is serving. Boot must not delay native
# recovery or silently rewrite owner/system policy while waiting for Shizuku.
rish(){ control_rish_bounded "$1" 2>/dev/null; }

# DB integrity gate: an abrupt power loss mid-write can leave media-agent.db malformed, which
# would make the server crash-loop (watchdog restarting forever without ever fixing it). Check
# once per boot; on corruption, roll back to the newest good backup BEFORE starting the server
# so the stack comes up on a sound DB instead of thrashing.
DB="$HOME/evogent/data/media-agent.db"
if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  QC=$(sqlite3 "$DB" 'PRAGMA quick_check;' 2>&1 | head -1)
  if [ "$QC" != "ok" ]; then
    GOOD=$(ls -t "$HOME/evogent/data/backups/"*.db 2>/dev/null | head -1)
    if [ -n "$GOOD" ]; then
      cp "$DB" "$DB.corrupt-$(date +%s)" 2>/dev/null
      cp "$GOOD" "$DB" && say "DB CORRUPT ($QC) — rolled back to backup $(basename "$GOOD")"
    else
      say "DB CORRUPT ($QC) and NO backup available — server may crash-loop"
    fi
  fi
fi

# Start the production server (tmux 'evo'). The scoped restart never touches the
# scheduler, watchdog, active cycle, or unrelated Node/agent processes.
if ! tmux has-session -t '=evo' 2>/dev/null || [ "$(server_code)" != 200 ]; then
  if control_lock_live "$TOOLS/.cycle.lock"; then
    # Preserve a live cycle and replace only the production-server session.
    tmux kill-session -t '=evo' 2>/dev/null || true
    tmux new-session -d -s evo "bash $HOME/start-prod.sh >> $HOME/evogent-server.log 2>&1"
  else
    bash "$HOME/restart-evo.sh"
  fi
  say "server (re)started"
fi
for i in $(seq 1 30); do
  [ "$(server_code)" = "200" ] && break
  sleep 2
done
SERVER_HTTP_CODE=$(server_code)
SERVER_READY=0
[ "$SERVER_HTTP_CODE" = 200 ] && SERVER_READY=1
say "authenticated server http $SERVER_HTTP_CODE"

# Read, explain, and defer when explicit technical-user host policy is absent. These settings
# are provisioning choices, not ordinary-boot repair authority. Production boot never disables
# DeviceConfig synchronization or writes test-only global policy.
if [ "$SERVER_READY" = 1 ] && rish 'id' | grep -q 'uid=2000'; then
  phantom_policy=$(rish 'settings get global settings_enable_monitor_phantom_procs' | tr -d '\r')
  desktop_policy=$(rish 'settings get global force_desktop_mode_on_external_displays' | tr -d '\r')
  freeform_policy=$(rish 'settings get global enable_freeform_support' | tr -d '\r')
  if [ "$phantom_policy" = false ] &&
     [ "$desktop_policy" = 1 ] &&
     [ "$freeform_policy" = 1 ]; then
    clear_host_policy_action || true
    say "read-only phone host-policy proof ready"
  else
    say "USER_ACTION_REQUIRED kind=phone_host_policy purpose=durable_runtime_and_hidden_display"
    surface_host_policy_action || true
  fi
elif [ "$SERVER_READY" = 1 ]; then
  say "Shizuku/rish unavailable at boot host-policy probe; app-backed work will re-prove it when due"
fi

# Probe only after the server is available so a missing owner grant becomes one deduplicated,
# user-visible recovery item rather than a scheduler-log-only warning. The probe never rewrites
# Android secure settings. A live cycle owns its own just-in-time prerequisite probe.
if [ "$SERVER_READY" != 1 ]; then
  say "capability probes deferred until authenticated local server recovery"
elif control_lock_live "$TOOLS/.cycle.lock"; then
  say "accessibility probe deferred: a live cycle owns the hidden-display lease"
else
  BG_BROWSE_POLICY=$(awk '
    $0=="## Background Source Browsing"{f=1;next}
    f&&/^##[[:space:]]/{exit}
    f&&NF{gsub(/\r/,"");print;exit}
  ' "$HOME/evogent/data/config.md" 2>/dev/null)
  BG_BROWSE_FEATURE_ENABLED=1
  case "$(printf '%s' "$BG_BROWSE_POLICY" | tr '[:upper:]' '[:lower:]' |
      sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" in
    off|disabled|disable|false|no) BG_BROWSE_FEATURE_ENABLED=0 ;;
  esac
  EVOGENT_CAPABILITY_FEATURE_ENABLED="$BG_BROWSE_FEATURE_ENABLED" \
    bash "$TOOLS/a11y-heal.sh" || true
fi

# tmux sessions inherit the server's global environment, not necessarily this
# boot client's custom variables. Bind every newly launched control process to
# the exact resolved release even when the tmux server predates this boot.
if [ -n "${EVOGENT_CONTROL_RELEASE_ROOT:-}" ]; then
  tmux set-environment -g EVOGENT_CONTROL_RELEASE_ROOT \
    "$EVOGENT_CONTROL_RELEASE_ROOT" || {
      say "CRITICAL: tmux release identity could not be bound"
      exit 70
    }
else
  tmux set-environment -gu EVOGENT_CONTROL_RELEASE_ROOT 2>/dev/null || true
fi

# Start the on-device periodic scheduler only behind authenticated server proof. The independent
# watchdog remains available to repair the server and starts the scheduler on a later healthy tick.
if [ "$SERVER_READY" = 1 ]; then
  if control_lock_live "$TOOLS/.scheduler.lock"; then
    say "scheduler owner lock already live"
  else
    tmux kill-session -t '=evo-sched' 2>/dev/null || true
    tmux new -d -s evo-sched "exec bash '$TOOLS/evogent-scheduler.sh'"
    say "scheduler launch requested"
  fi
  if ! wait_for_control_owner_status scheduler "$TOOLS/.scheduler.lock" 0; then
    say "CRITICAL: scheduler did not publish a live owner status"
    exit 70
  fi
  say "scheduler ready"
else
  say "scheduler deferred: authenticated local server is unavailable"
fi

# Watchdog: keep the server alive unattended. It runs outside tmux and owns a
# PID+start-aware single-instance lease.
if ! control_lock_live "$TOOLS/.watchdog.lock"; then
  setsid bash "$TOOLS/evogent-watchdog.sh" >/dev/null 2>&1 &
  say "watchdog launch requested"
fi
if ! wait_for_control_owner_status watchdog "$TOOLS/.watchdog.lock" 180; then
  say "CRITICAL: watchdog did not publish a live owner status"
  exit 70
fi
say "watchdog ready"

# Dev/Mac access only: start sshd if opted in. A standalone user phone never needs this.
if [ -f "$HOME/.evogent-dev-ssh" ]; then
  sshd 2>/dev/null || true
  say "sshd started (dev opt-in)"
fi

say "=== evogent-boot done: tmux=[$(tmux ls 2>&1 | tr '\n' ' ')] ==="
