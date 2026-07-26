#!/data/data/com.termux/files/usr/bin/bash
# Shared process, lock, display, and wake-lock containment for Evogent's on-phone workers.
#
# This file is sourced by the scheduler/cycle/watchdog rather than run directly.  The important
# boundary is ownership: a worker may only terminate descendants carrying its unique
# EVOGENT_TASK_OWNER token.  It must never pattern-kill every Codex/Claude process on the phone.

CONTROL_ROOT="${EVOGENT_CONTROL_ROOT:-$HOME/phone-tools/.control}"
CONTROL_OWNER_ID="${CONTROL_OWNER_ID:-}"
CONTROL_OWNER_DIR="${CONTROL_OWNER_DIR:-}"
CONTROL_SELF_START="${CONTROL_SELF_START:-}"
CONTROL_ACTIVE_LOCK="${CONTROL_ACTIVE_LOCK:-}"
CONTROL_WAKE_HELD="${CONTROL_WAKE_HELD:-0}"
CONTROL_CYCLE_CLAIM="${CONTROL_CYCLE_CLAIM:-}"
CONTROL_CYCLE_REQUEST_REASON="${CONTROL_CYCLE_REQUEST_REASON:-}"

control_proc_start() {
  local pid="${1:-}" stat
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ -r "/proc/$pid/stat" ] || return 1
  stat=$(<"/proc/$pid/stat") || return 1
  # Remove pid + "(comm) ".  starttime is field 22 in proc(5), field 20 after that prefix.
  printf '%s\n' "${stat##*) }" | awk '{print $20}'
}

control_pid_matches() {
  local pid="${1:-}" expected="${2:-}" actual
  [ -n "$expected" ] || return 1
  actual=$(control_proc_start "$pid" 2>/dev/null) || return 1
  [ "$actual" = "$expected" ]
}

control_meta_field() {
  local file="$1" key="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | head -1
}

control_init_owner() {
  local label="${1:-worker}" safe
  [ -n "$CONTROL_OWNER_ID" ] && return 0
  safe=$(printf '%s' "$label" | tr -cd 'A-Za-z0-9_.-')
  [ -n "$safe" ] || safe=worker
  CONTROL_SELF_START=$(control_proc_start "$$") || return 1
  CONTROL_OWNER_ID="${safe}-$$-${CONTROL_SELF_START}-$(date +%s)"
  CONTROL_OWNER_DIR="$CONTROL_ROOT/owners/$CONTROL_OWNER_ID"
  mkdir -p "$CONTROL_OWNER_DIR/roots" "$CONTROL_OWNER_DIR/packages"
  {
    printf 'owner=%s\n' "$CONTROL_OWNER_ID"
    printf 'pid=%s\n' "$$"
    printf 'start=%s\n' "$CONTROL_SELF_START"
    printf 'label=%s\n' "$safe"
    printf 'created=%s\n' "$(date +%s)"
  } > "$CONTROL_OWNER_DIR/owner.tmp"
  mv "$CONTROL_OWNER_DIR/owner.tmp" "$CONTROL_OWNER_DIR/owner"
}

control_owner_live() {
  local dir="$1" meta="$1/owner" pid start
  [ -f "$meta" ] || {
    # A just-created owner directory is initializing, not abandoned.
    [ -n "$(find "$dir" -maxdepth 0 -mmin -2 2>/dev/null)" ]
    return
  }
  pid=$(control_meta_field "$meta" pid)
  start=$(control_meta_field "$meta" start)
  control_pid_matches "$pid" "$start"
}

control_tagged_processes() {
  local token="$1" envf pid start
  for envf in /proc/[0-9]*/environ; do
    [ -r "$envf" ] || continue
    if tr '\0' '\n' < "$envf" 2>/dev/null |
        grep -Fqx "EVOGENT_TASK_OWNER=$token"; then
      pid="${envf#/proc/}"; pid="${pid%/environ}"
      start=$(control_proc_start "$pid" 2>/dev/null) || continue
      printf '%s:%s\n' "$pid" "$start"
    fi
  done
}

control_kill_tagged() {
  local token="${1:-}" pair pid start pairs=""
  [ -n "$token" ] || return 0
  pairs=$(control_tagged_processes "$token")
  [ -n "$pairs" ] || return 0
  while IFS=: read -r pid start; do
    [ -n "$pid" ] || continue
    control_pid_matches "$pid" "$start" && kill -TERM "$pid" 2>/dev/null || true
  done <<< "$pairs"
  sleep 1
  while IFS=: read -r pid start; do
    [ -n "$pid" ] || continue
    control_pid_matches "$pid" "$start" && kill -KILL "$pid" 2>/dev/null || true
  done <<< "$pairs"
}

control_reap_abandoned_owners() {
  local dir token
  mkdir -p "$CONTROL_ROOT/owners"
  for dir in "$CONTROL_ROOT"/owners/*; do
    [ -d "$dir" ] || continue
    [ "$dir" = "$CONTROL_OWNER_DIR" ] && continue
    control_owner_live "$dir" && continue
    token=$(control_meta_field "$dir/owner" owner)
    [ -n "$token" ] && control_kill_tagged "$token"
    rm -rf -- "$dir"
  done
}

control_register_root() {
  local pid="$1" start="$2"
  [ -n "$CONTROL_OWNER_DIR" ] || return 0
  printf '%s\n' "$start" > "$CONTROL_OWNER_DIR/roots/$pid"
}

control_unregister_root() {
  local pid="$1"
  [ -n "$CONTROL_OWNER_DIR" ] || return 0
  rm -f "$CONTROL_OWNER_DIR/roots/$pid"
}

# run_owned_timeout <seconds> <kill-grace-seconds> <command> [args...]
#
# `setsid` removes the controlling terminal and gives GNU timeout an isolated process group, so
# rish cannot be stopped by SIGTTIN/SIGTTOU and timeout can terminate the whole command tree.
# The fallback uses `timeout --foreground` with stdin closed, which also avoids the background
# terminal group bug.  Every descendant inherits an exact owner token for cleanup after crashes.
run_owned_timeout() {
  local budget="$1" grace="$2" pid start rc
  shift 2
  [ -n "$CONTROL_OWNER_ID" ] || control_init_owner bounded
  control_lock_renew "${CONTROL_ACTIVE_LOCK:-}" 2>/dev/null || true
  if command -v setsid >/dev/null 2>&1; then
    env EVOGENT_TASK_OWNER="$CONTROL_OWNER_ID" EVOGENT_CONTROL_ROOT="$CONTROL_ROOT" \
      setsid -w timeout -k "$grace" "$budget" "$@" </dev/null &
  else
    env EVOGENT_TASK_OWNER="$CONTROL_OWNER_ID" EVOGENT_CONTROL_ROOT="$CONTROL_ROOT" \
      timeout --foreground -k "$grace" "$budget" "$@" </dev/null &
  fi
  pid=$!
  start=$(control_proc_start "$pid" 2>/dev/null || true)
  [ -n "$start" ] && control_register_root "$pid" "$start"
  wait "$pid"; rc=$?
  control_unregister_root "$pid"
  # Successful CLIs have still been observed to leave detached helpers behind.  The token makes
  # this cleanup precise: server agents, user agents, and other cycles never match it.
  control_kill_tagged "$CONTROL_OWNER_ID"
  control_lock_renew "${CONTROL_ACTIVE_LOCK:-}" 2>/dev/null || true
  return "$rc"
}

# Same containment, but preserve a caller-provided pipe/heredoc as stdin.  `setsid` still means
# that fd is not a controlling terminal.
run_owned_timeout_stdin() {
  local budget="$1" grace="$2" pid start rc
  shift 2
  [ -n "$CONTROL_OWNER_ID" ] || control_init_owner bounded
  control_lock_renew "${CONTROL_ACTIVE_LOCK:-}" 2>/dev/null || true
  if command -v setsid >/dev/null 2>&1; then
    env EVOGENT_TASK_OWNER="$CONTROL_OWNER_ID" EVOGENT_CONTROL_ROOT="$CONTROL_ROOT" \
      setsid -w timeout -k "$grace" "$budget" "$@" &
  else
    env EVOGENT_TASK_OWNER="$CONTROL_OWNER_ID" EVOGENT_CONTROL_ROOT="$CONTROL_ROOT" \
      timeout --foreground -k "$grace" "$budget" "$@" &
  fi
  pid=$!
  start=$(control_proc_start "$pid" 2>/dev/null || true)
  [ -n "$start" ] && control_register_root "$pid" "$start"
  wait "$pid"; rc=$?
  control_unregister_root "$pid"
  control_kill_tagged "$CONTROL_OWNER_ID"
  control_lock_renew "${CONTROL_ACTIVE_LOCK:-}" 2>/dev/null || true
  return "$rc"
}

control_lock_live() {
  local lock="${1:-}" meta pid start
  [ -d "$lock" ] || return 1
  meta="$lock/owner"
  if [ -f "$meta" ]; then
    pid=$(control_meta_field "$meta" pid)
    start=$(control_meta_field "$meta" start)
    control_pid_matches "$pid" "$start"
    return
  fi
  # Never steal a lock in the small atomic-mkdir -> metadata-write window.
  [ -n "$(find "$lock" -maxdepth 0 -mmin -2 2>/dev/null)" ]
}

control_lock_owner_id() {
  control_meta_field "$1/owner" owner
}

control_lock_acquire() {
  local lock="$1" label="${2:-lock}" stale="$1.stale.$$"
  [ -n "$CONTROL_OWNER_ID" ] || control_init_owner "$label"
  mkdir -p "$(dirname "$lock")"
  if ! mkdir "$lock" 2>/dev/null; then
    control_lock_live "$lock" && return 1
    # Atomically rename the proved-dead lock. Only one contender can win the rename; a live
    # owner is never age-stolen, and no broad/path-pattern delete is involved.
    mv "$lock" "$stale" 2>/dev/null || return 1
    rm -rf -- "$stale"
    if ! mkdir "$lock" 2>/dev/null; then
      return 1
    fi
  fi
  {
    printf 'owner=%s\n' "$CONTROL_OWNER_ID"
    printf 'pid=%s\n' "$$"
    printf 'start=%s\n' "$CONTROL_SELF_START"
    printf 'label=%s\n' "$label"
    printf 'acquired=%s\n' "$(date +%s)"
  } > "$lock/owner.tmp"
  mv "$lock/owner.tmp" "$lock/owner"
  touch "$lock/heartbeat"
  CONTROL_ACTIVE_LOCK="$lock"
}

control_lock_renew() {
  local lock="${1:-}" owner
  [ -n "$lock" ] && [ -d "$lock" ] || return 1
  owner=$(control_lock_owner_id "$lock")
  [ "$owner" = "$CONTROL_OWNER_ID" ] || return 1
  control_pid_matches "$$" "$CONTROL_SELF_START" || return 1
  touch "$lock/heartbeat"
}

control_lock_release() {
  local lock="${1:-}" owner
  [ -n "$lock" ] && [ -d "$lock" ] || return 0
  owner=$(control_lock_owner_id "$lock")
  [ "$owner" = "$CONTROL_OWNER_ID" ] || return 1
  rm -rf -- "$lock"
  [ "$CONTROL_ACTIVE_LOCK" = "$lock" ] && CONTROL_ACTIVE_LOCK=""
}

control_track_package() {
  local pkg="${1:-}" dir
  [[ "$pkg" =~ ^[A-Za-z0-9_.]+$ ]] || return 1
  [ -n "${EVOGENT_TASK_OWNER:-}" ] || return 0
  dir="$CONTROL_ROOT/owners/$EVOGENT_TASK_OWNER/packages"
  [ -d "$dir" ] || return 0
  : > "$dir/$pkg"
}

control_rish_bounded() {
  local cmd="$1" rish_bin="$HOME/rish-bin/rish"
  [ -x "$rish_bin" ] || return 1
  if command -v setsid >/dev/null 2>&1; then
    # rish may propagate the invoking PTY through Binder unless setsid is forced to fork.
    # Its callers only distinguish success/non-success, so util-linux's signal-number return
    # convention under -f/-w does not erase any timeout classification here.
    setsid -f -w timeout -k 2 12 env RISH_APPLICATION_ID=com.termux \
      "$rish_bin" -c "$cmd" </dev/null
  else
    timeout --foreground -k 2 12 env RISH_APPLICATION_ID=com.termux \
      "$rish_bin" -c "$cmd" </dev/null
  fi
}

control_close_hidden_displays() {
  local pids pid
  # Exact argv[0] matching avoids the old `pgrep -f evopriv` self-match that killed probe
  # shells as well as the Shizuku UserService.
  pids=$(control_rish_bounded \
    "ps -A -o PID,ARGS 2>/dev/null | awk '\$2 == \"net.dangish.evogent:evopriv\" {print \$1}'" \
    2>/dev/null || true)
  for pid in $pids; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    control_rish_bounded "kill -TERM $pid 2>/dev/null; sleep 1; kill -KILL $pid 2>/dev/null || true" \
      >/dev/null 2>&1 || true
  done
  rm -f "$HOME/.phone-display" "$HOME/.phone-screen.txt"
}

control_cleanup_tracked_packages() {
  local dir="${CONTROL_OWNER_DIR:-}/packages" fg pkg
  [ -d "$dir" ] || return 0
  fg=$(control_rish_bounded \
    "dumpsys activity activities 2>/dev/null | grep -m1 topResumedActivity | grep -oE '[a-z][a-z0-9_.]+/' | head -1 | tr -d '/'" \
    2>/dev/null || true)
  for pkg in "$dir"/*; do
    [ -f "$pkg" ] || continue
    pkg="${pkg##*/}"
    [[ "$pkg" =~ ^[A-Za-z0-9_.]+$ ]] || continue
    [ -n "$fg" ] && [ "$pkg" = "$fg" ] && continue
    control_rish_bounded "am force-stop $pkg" >/dev/null 2>&1 || true
  done
}

control_wake_prune() {
  local dir pid start
  mkdir -p "$CONTROL_ROOT/wake"
  for dir in "$CONTROL_ROOT"/wake/*; do
    [ -d "$dir" ] || continue
    if [ ! -f "$dir/owner" ]; then
      # Do not reap another worker in its mkdir -> atomic owner-file window.
      [ -n "$(find "$dir" -maxdepth 0 -mmin -2 2>/dev/null)" ] && continue
      rm -rf -- "$dir"
      continue
    fi
    pid=$(control_meta_field "$dir/owner" pid)
    start=$(control_meta_field "$dir/owner" start)
    control_pid_matches "$pid" "$start" || rm -rf -- "$dir"
  done
}

control_wake_acquire() {
  local dir marker="$CONTROL_ROOT/wake/.evogent-held"
  [ -n "$CONTROL_OWNER_ID" ] || control_init_owner wake
  control_wake_prune
  dir="$CONTROL_ROOT/wake/$CONTROL_OWNER_ID"
  mkdir -p "$dir"
  {
    printf 'pid=%s\n' "$$"
    printf 'start=%s\n' "$CONTROL_SELF_START"
  } > "$dir/owner.tmp"
  mv "$dir/owner.tmp" "$dir/owner"
  if ! command -v termux-wake-lock >/dev/null 2>&1 \
      || ! termux-wake-lock >/dev/null 2>&1; then
    rm -rf -- "$dir"
    CONTROL_WAKE_HELD=0
    return 1
  fi
  : > "$marker"
  chmod 600 "$marker" 2>/dev/null || true
  CONTROL_WAKE_HELD=1
}

control_wake_release() {
  local marker="$CONTROL_ROOT/wake/.evogent-held"
  [ -n "$CONTROL_OWNER_ID" ] && rm -rf -- "$CONTROL_ROOT/wake/$CONTROL_OWNER_ID"
  control_wake_prune
  if ! find "$CONTROL_ROOT/wake" -mindepth 1 -maxdepth 1 -type d 2>/dev/null |
      grep -q . && [ -f "$marker" ]; then
    if command -v termux-wake-unlock >/dev/null 2>&1 \
        && termux-wake-unlock >/dev/null 2>&1; then
      rm -f "$marker"
    fi
  fi
  CONTROL_WAKE_HELD=0
}

control_release_legacy_wake_if_idle() {
  local marker="$CONTROL_ROOT/wake/.evogent-held"
  local legacy_retired="$CONTROL_ROOT/wake/.legacy-release-attempted"
  control_wake_prune
  if ! find "$CONTROL_ROOT/wake" -mindepth 1 -maxdepth 1 -type d 2>/dev/null |
      grep -q .; then
    if [ -f "$marker" ]; then
      if command -v termux-wake-unlock >/dev/null 2>&1 \
          && termux-wake-unlock >/dev/null 2>&1; then
        rm -f "$marker"
      fi
    elif [ ! -f "$legacy_retired" ] \
        && command -v termux-wake-unlock >/dev/null 2>&1 \
        && termux-wake-unlock >/dev/null 2>&1; then
      # One blind release retires the pre-reference-counted Evogent lock during upgrade.
      # Thereafter the marker above prevents the watchdog from releasing unrelated Termux work.
      : > "$legacy_retired"
      chmod 600 "$legacy_retired" 2>/dev/null || true
    fi
  fi
}

control_request_cycle() {
  local reason="${1:-unspecified}" signal="$HOME/evogent/data/phone-cycle-request.json" tmp
  reason=$(printf '%s' "$reason" | tr '\r\n|' '   ' | cut -c1-160)
  mkdir -p "$(dirname "$signal")"
  tmp="$signal.tmp.$$"
  python3 - "$reason" "$$" > "$tmp" <<'PYEOF'
import json, sys, time
print(json.dumps({
    "version": 1,
    "requestedAtMs": int(time.time() * 1000),
    "requestedByPid": int(sys.argv[2]),
    "reason": sys.argv[1],
}, separators=(",", ":")))
PYEOF
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$signal"
}

control_cycle_request_pending() {
  local signal="$HOME/evogent/data/phone-cycle-request.json" claim
  [ -f "$signal" ] && return 0
  for claim in "$signal".claim.*; do
    [ -f "$claim" ] && return 0
  done
  return 1
}

control_claim_cycle_request() {
  local signal="$HOME/evogent/data/phone-cycle-request.json" claim=""
  CONTROL_CYCLE_CLAIM=""
  CONTROL_CYCLE_REQUEST_REASON=""
  if [ -f "$signal" ]; then
    claim="$signal.claim.${CONTROL_OWNER_ID:-$$}"
    mv "$signal" "$claim" 2>/dev/null || claim=""
  fi
  if [ -z "$claim" ]; then
    for claim in "$signal".claim.*; do
      [ -f "$claim" ] && break
      claim=""
    done
  fi
  [ -n "$claim" ] && [ -f "$claim" ] || return 1
  CONTROL_CYCLE_REQUEST_REASON=$(python3 - "$claim" <<'PYEOF' 2>/dev/null
import json, sys
try:
    print(str(json.load(open(sys.argv[1])).get("reason") or "external"))
except Exception:
    print("external")
PYEOF
)
  CONTROL_CYCLE_CLAIM="$claim"
}

control_ack_cycle_claims() {
  local signal="$HOME/evogent/data/phone-cycle-request.json" claim
  # Only the sole scheduler calls this, and only after its cycle returned success. Requests
  # arriving after the pre-cycle claim use the base path, so acknowledging old claims cannot
  # consume a mid-cycle request.
  for claim in "$signal".claim.*; do
    [ -f "$claim" ] && rm -f "$claim"
  done
  CONTROL_CYCLE_CLAIM=""
  CONTROL_CYCLE_REQUEST_REASON=""
}

# Compatibility helper for diagnostics/tests that want a consume operation. Production
# scheduling uses claim + explicit acknowledgement around the completed cycle.
control_take_cycle_request() {
  control_claim_cycle_request || return 1
  printf '%s\n' "$CONTROL_CYCLE_REQUEST_REASON"
  control_ack_cycle_claims
}

# Locked read-modify-write registry for server health.  All writers share one small JSON file;
# flock prevents scheduler/cycle/source updates from losing each other, and os.replace keeps
# readers from observing a partial document.
control_status_write() {
  local section="$1" key="$2" state="$3" outcome="${4:-}" gain="${5:-}" rc="${6:-}" detail="${7:-}"
  local registry="$HOME/evogent/data/phone-control-status.json"
  mkdir -p "$(dirname "$registry")"
  python3 - "$registry" "$section" "$key" "$state" "$outcome" "$gain" "$rc" "$detail" \
    "${CONTROL_OWNER_ID:-}" "$$" "${CONTROL_SELF_START:-}" <<'PYEOF' >/dev/null 2>&1
import fcntl, json, os, sys, time

path, section, key, state, outcome, gain, rc, detail, owner, pid, start = sys.argv[1:]
lock_path = path + ".lock"
now = int(time.time() * 1000)
with open(lock_path, "a+", encoding="utf-8") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    entry = {
        "state": state,
        "updatedAtMs": now,
        "owner": owner or None,
        "pid": int(pid) if pid.isdigit() else None,
        "processStartTicks": int(start) if start.isdigit() else None,
    }
    if outcome:
        entry["outcome"] = outcome
    if gain and gain.lstrip("-").isdigit():
        entry["gain"] = int(gain)
    if rc and rc.lstrip("-").isdigit():
        entry["runnerRc"] = int(rc)
    if detail:
        entry["detail"] = detail[:300]
    if section == "sources":
        sources = data.setdefault("sources", {})
        previous = sources.get(key) if isinstance(sources.get(key), dict) else {}
        for field in ("lastCompletedAtMs", "lastFreshAtMs", "lastFailureAtMs"):
            if previous.get(field):
                entry[field] = previous[field]
        if state == "running":
            entry["startedAtMs"] = now
        else:
            if previous.get("startedAtMs"):
                entry["startedAtMs"] = previous["startedAtMs"]
            entry["completedAtMs"] = now
            entry["lastCompletedAtMs"] = now
        if outcome == "fresh" or outcome.startswith("partial_fresh"):
            entry["lastFreshAtMs"] = now
        if state in ("degraded", "failed"):
            entry["lastFailureAtMs"] = now
        sources[key] = entry
    else:
        previous = data.get(section) if isinstance(data.get(section), dict) else {}
        for field in ("lastCompletedAtMs", "lastSuccessAtMs", "lastFailureAtMs"):
            if previous.get(field):
                entry[field] = previous[field]
        if state == "running" and previous.get("state") != "running":
            entry["startedAtMs"] = now
        elif previous.get("startedAtMs"):
            entry["startedAtMs"] = previous["startedAtMs"]
        if state in ("completed", "degraded", "failed", "stopped", "interrupted"):
            entry["completedAtMs"] = now
            entry["lastCompletedAtMs"] = now
        if state == "completed":
            entry["lastSuccessAtMs"] = now
        if state in ("degraded", "failed"):
            entry["lastFailureAtMs"] = now
        data[section] = entry
    data["version"] = 1
    data["updatedAtMs"] = now
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    fcntl.flock(lock, fcntl.LOCK_UN)
PYEOF
}

control_finish_owner() {
  [ -n "$CONTROL_OWNER_ID" ] || return 0
  control_kill_tagged "$CONTROL_OWNER_ID"
  [ -n "$CONTROL_OWNER_DIR" ] && rm -rf -- "$CONTROL_OWNER_DIR"
}
