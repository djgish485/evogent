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
CONTROL_WAKE_REGISTRY_HELD="${CONTROL_WAKE_REGISTRY_HELD:-0}"
CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK="${CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK:-}"
CONTROL_RELEASE_MUTATION_GATE="${CONTROL_RELEASE_MUTATION_GATE:-}"
CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK="${CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK:-}"
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

# The durable journal, rather than the installer process lease, is the runtime
# mutation barrier. A live install lock with no journal is only preflight/build
# work, during which the current production stack intentionally keeps running.
# Once the journal exists, all dispatch/revival remains frozen through either a
# proved rollback or committed finalization—even if the installer is SIGKILLed.
control_release_transaction_pending() {
  local root="${1:-$HOME/.local/share/evogent}"
  local transaction="$root/install-transaction"
  local journal="$transaction/journal.json"
  [ -d "$transaction" ] && [ ! -L "$transaction" ] || return 0
  [ -e "$journal" ] || [ -L "$journal" ]
}

control_release_mutation_gate_acquire() {
  local root="${1:-$HOME/.local/share/evogent}"
  local label="${2:-control-plane-mutation}"
  local gate="$root/control-plane-mutation.lock"
  [ -z "$CONTROL_RELEASE_MUTATION_GATE" ] || return 1
  CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK="$CONTROL_ACTIVE_LOCK"
  if ! control_lock_acquire "$gate" "$label"; then
    CONTROL_ACTIVE_LOCK="$CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK"
    CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK=""
    return 1
  fi
  CONTROL_RELEASE_MUTATION_GATE="$gate"
  if control_release_transaction_pending "$root"; then
    # Never forget an inode we may still own. A caller seeing a non-empty gate
    # after failure must exit through cleanup, which retries retirement; if the
    # process dies, PID+start ownership makes the lease safely reapable.
    control_lock_release "$gate" || return 70
    CONTROL_RELEASE_MUTATION_GATE=""
    CONTROL_ACTIVE_LOCK="$CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK"
    CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK=""
    return 75
  fi
  return 0
}

control_release_mutation_gate_release() {
  local gate="$CONTROL_RELEASE_MUTATION_GATE"
  [ -n "$gate" ] || return 0
  control_lock_release "$gate" || return 1
  CONTROL_RELEASE_MUTATION_GATE=""
  CONTROL_ACTIVE_LOCK="$CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK"
  CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK=""
}

control_lock_owner_id() {
  control_meta_field "$1/owner" owner
}

control_lock_directory_operation() {
  python3 - "$@" <<'PY'
import ctypes
import errno
import fcntl
import os
import pathlib
import re
import stat
import sys
import time

operation = sys.argv[1]
source = pathlib.Path(sys.argv[2])
destination = pathlib.Path(sys.argv[3])
directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)

def rename_noreplace(old, new):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is not None:
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(
            -100,
            os.fsencode(old),
            -100,
            os.fsencode(new),
            1,
        )
    else:
        renamex = getattr(libc, "renamex_np", None)
        if renamex is None:
            raise SystemExit("no atomic no-clobber rename primitive")
        renamex.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex.restype = ctypes.c_int
        result = renamex(os.fsencode(old), os.fsencode(new), 0x00000004)
    if result != 0:
        error = ctypes.get_errno()
        if error in {errno.ENOENT, errno.EEXIST, errno.ENOTEMPTY}:
            raise SystemExit(75)
        raise OSError(error, os.strerror(error), str(new))

def read_owner(descriptor, allow_legacy_mode=False):
    try:
        owner_descriptor = os.open(
            "owner",
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=descriptor,
        )
    except FileNotFoundError:
        return None
    try:
        metadata = os.fstat(owner_descriptor)
        owner_mode = stat.S_IMODE(metadata.st_mode)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or (
                owner_mode != 0o600
                and not (allow_legacy_mode and owner_mode == 0o644)
            )
            or metadata.st_uid != os.geteuid()
            or metadata.st_size > 4096
        ):
            raise SystemExit(75)
        payload = os.read(owner_descriptor, 4097).decode("utf-8", "strict")
    finally:
        os.close(owner_descriptor)
    values = {}
    for line in payload.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values

def owner_live(owner):
    if owner is None:
        return False
    pid = owner.get("pid", "")
    start = owner.get("start", "")
    if (
        re.fullmatch(r"[1-9][0-9]*", pid or "") is None
        or re.fullmatch(r"[0-9]+", start or "") is None
    ):
        raise SystemExit(75)
    try:
        process_stat = pathlib.Path(f"/proc/{pid}/stat").read_text()
    except (FileNotFoundError, ProcessLookupError):
        if sys.platform == "darwin":
            try:
                os.kill(int(pid), 0)
            except (ProcessLookupError, PermissionError):
                return False
            return True
        return False
    fields = process_stat.rsplit(") ", 1)
    return (
        len(fields) == 2
        and len(fields[1].split()) >= 20
        and fields[1].split()[19] == start
    )

def same_live_name(path, observed):
    try:
        current = os.lstat(path)
    except FileNotFoundError:
        return False
    return (
        stat.S_ISDIR(current.st_mode)
        and not stat.S_ISLNK(current.st_mode)
        and (current.st_dev, current.st_ino)
        == (observed.st_dev, observed.st_ino)
    )

def fsync_parent(path):
    # Versioned installs deliberately expose ~/phone-tools as a symlink to the
    # private state directory.  The lock itself must never be a symlink, but
    # opening that canonical parent with O_NOFOLLOW rejects the valid dispatch
    # symlink *after* rename_noreplace has already published the lock.  Resolve
    # and bind the parent identity before fsync so publication is both durable
    # and reported as successful.
    observed = os.stat(path.parent, follow_symlinks=True)
    resolved = path.parent.resolve(strict=True)
    parent = os.open(resolved, directory_flags)
    try:
        opened = os.fstat(parent)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or (opened.st_dev, opened.st_ino)
            != (observed.st_dev, observed.st_ino)
        ):
            raise SystemExit(75)
        os.fsync(parent)
        current = os.stat(path.parent, follow_symlinks=True)
        if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise SystemExit(75)
    finally:
        os.close(parent)

if source.parent != destination.parent:
    raise SystemExit("lock operation crossed directories")

if operation == "publish":
    descriptor = os.open(source, directory_flags)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o700
            or metadata.st_uid != os.geteuid()
        ):
            raise SystemExit("prepared lock directory is unsafe")
        owner = read_owner(descriptor)
        if owner is None:
            raise SystemExit("prepared lock owner is missing")
        for name in ("owner", "heartbeat"):
            child = os.open(
                name,
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=descriptor,
            )
            try:
                child_metadata = os.fstat(child)
                if not stat.S_ISREG(child_metadata.st_mode):
                    raise SystemExit("prepared lock metadata is unsafe")
                os.fsync(child)
            finally:
                os.close(child)
        os.fsync(descriptor)
        if not same_live_name(source, metadata):
            raise SystemExit(75)
        rename_noreplace(source, destination)
        os.fsync(descriptor)
        fsync_parent(destination)
    finally:
        os.close(descriptor)
    raise SystemExit(0)

descriptor = os.open(source, directory_flags)
try:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(75)
    observed = os.fstat(descriptor)
    owner = read_owner(descriptor, allow_legacy_mode=operation == "reap")
    if operation == "reap":
        if owner_live(owner):
            raise SystemExit(75)
        if owner is None and time.time() - observed.st_mtime < 120:
            raise SystemExit(75)
    elif operation == "retire":
        if len(sys.argv) != 7:
            raise SystemExit("lock retirement arguments are incomplete")
        expected_owner, expected_pid, expected_start = sys.argv[4:]
        if owner is None or (
            owner.get("owner") != expected_owner
            or owner.get("pid") != expected_pid
            or owner.get("start") != expected_start
        ):
            raise SystemExit(75)
        if not owner_live(owner):
            raise SystemExit(75)
    else:
        raise SystemExit("unknown lock directory operation")
    if not same_live_name(source, observed):
        raise SystemExit(75)
    rename_noreplace(source, destination)
    os.fsync(descriptor)
    fsync_parent(destination)
finally:
    os.close(descriptor)
PY
}

control_lock_acquire() {
  local lock="$1" label="${2:-lock}" stale candidate status
  [ -n "$CONTROL_OWNER_ID" ] || control_init_owner "$label"
  mkdir -p "$(dirname "$lock")"
  candidate="$(mktemp -d "${lock}.pending.XXXXXXXX")" || return 1
  chmod 700 "$candidate" || {
    rm -rf -- "$candidate"
    return 1
  }
  {
    printf 'owner=%s\n' "$CONTROL_OWNER_ID"
    printf 'pid=%s\n' "$$"
    printf 'start=%s\n' "$CONTROL_SELF_START"
    printf 'label=%s\n' "$label"
    printf 'acquired=%s\n' "$(date +%s)"
  } > "$candidate/owner"
  chmod 600 "$candidate/owner" || {
    rm -rf -- "$candidate"
    return 1
  }
  : > "$candidate/heartbeat"
  chmod 600 "$candidate/heartbeat" || {
    rm -rf -- "$candidate"
    return 1
  }
  status=0
  control_lock_directory_operation publish "$candidate" "$lock" || status=$?
  if [ "$status" = 75 ]; then
    if control_lock_live "$lock"; then
      rm -rf -- "$candidate"
      return 1
    fi
    stale="$lock.stale.$$.${CONTROL_SELF_START}.${RANDOM}"
    status=0
    control_lock_directory_operation reap "$lock" "$stale" || status=$?
    if [ "$status" = 0 ]; then
      rm -rf -- "$stale" || {
        rm -rf -- "$candidate"
        return 1
      }
      status=0
      control_lock_directory_operation publish "$candidate" "$lock" || status=$?
    fi
  fi
  if [ "$status" != 0 ]; then
    rm -rf -- "$candidate"
    return 1
  fi
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
  local lock="${1:-}" owner quarantine status=0
  [ -n "$lock" ] && [ -d "$lock" ] || return 0
  owner=$(control_lock_owner_id "$lock")
  [ "$owner" = "$CONTROL_OWNER_ID" ] || return 1
  quarantine="$lock.released.$$.${CONTROL_SELF_START}.${RANDOM}"
  control_lock_directory_operation retire "$lock" "$quarantine" \
    "$CONTROL_OWNER_ID" "$$" "$CONTROL_SELF_START" || status=$?
  [ "$status" = 0 ] || return 1
  rm -rf -- "$quarantine" || return 1
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

# Parse the package of the activity actually resumed on the physical display. Android's
# topDisplayFocusedRootTask line is not sufficient: on current Pixels it commonly contains only
# "type=home", so a substring check against the target package can never protect the app in the
# user's hands. Accept both dumpsys display-header spellings and both resumed-activity fields,
# while rejecting missing or conflicting answers.
control_display_zero_top_resumed_from_dump() {
  awk '
    function emit_component_package(line, fields, count, part, pkg) {
      count = split(line, fields, /[[:space:]]+/)
      for (part = 1; part <= count; part++) {
        if (fields[part] ~ /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+\/[^[:space:]]+$/) {
          pkg = fields[part]
          sub(/\/.*/, "", pkg)
          packages[pkg] = 1
          found = 1
          return
        }
      }
    }
    /^[[:space:]]*Display[[:space:]]+#?[0-9]+([[:space:]:(]|$)/ {
      in_display_zero = ($0 ~ /^[[:space:]]*Display[[:space:]]+#?0([[:space:]:(]|$)/)
      next
    }
    in_display_zero && /(topResumedActivity|mResumedActivity)[=:]/ {
      emit_component_package($0)
    }
    END {
      if (!found) exit 1
      count = 0
      for (pkg in packages) {
        answer = pkg
        count++
      }
      if (count != 1) exit 1
      print answer
    }
  '
}

# Normalize PowerManager variants to an intentionally small state machine. Multiple contradictory
# fields, unknown values, and missing fields are all "unknown"; callers must fail closed.
control_screen_wake_state_from_dump() {
  awk '
    function observe(value) {
      if (value == "Awake" || value == "1" || value == "true") awake = 1
      else if (value == "Asleep" || value == "Dreaming" || value == "Dozing" || value == "0" || value == "2" || value == "3" || value == "false") asleep = 1
      else unknown = 1
    }
    {
      line = $0
      while (match(line, /(mWakefulness|mInteractive)=[^[:space:]]+/)) {
        field = substr(line, RSTART, RLENGTH)
        sub(/^[^=]*=/, "", field)
        observe(field)
        line = substr(line, RSTART + RLENGTH)
      }
    }
    END {
      if (unknown || (awake && asleep) || (!awake && !asleep)) print "unknown"
      else if (awake) print "awake"
      else print "not-awake"
    }
  '
}

# WindowManager has used several names for the keyguard-visible bit. Treat disagreement or absence
# as unknown rather than guessing that the phone is unattended.
control_lockscreen_state_from_dump() {
  awk '
    {
      line = $0
      while (match(line, /(mDreamingLockscreen|mShowingLockscreen|mKeyguardShowing|isKeyguardShowing)=(true|false)/)) {
        field = substr(line, RSTART, RLENGTH)
        sub(/^[^=]*=/, "", field)
        if (field == "true") locked = 1
        else unlocked = 1
        line = substr(line, RSTART + RLENGTH)
      }
    }
    END {
      if ((locked && unlocked) || (!locked && !unlocked)) print "unknown"
      else if (locked) print "locked"
      else print "unlocked"
    }
  '
}

# Return one stable verdict for phone.sh. Only two situations are safe:
#   1. the physical screen is proved non-interactive or keyguard-locked; or
#   2. it is awake and unlocked, and display 0 unambiguously has a different exact package.
# Every incomplete or contradictory proof is a refusal.
control_hidden_launch_verdict() {
  local wake="${1:-unknown}" lock="${2:-unknown}" foreground="${3:-}" target="${4:-}"
  if [ "$wake" = "not-awake" ]; then
    printf '%s\n' safe-unattended
  elif [ "$lock" = "locked" ]; then
    printf '%s\n' safe-locked
  elif [ "$wake" = "awake" ] && [ "$lock" = "unlocked" ] \
      && [ -n "$foreground" ] && [ -n "$target" ]; then
    if [ "$foreground" = "$target" ]; then
      printf '%s\n' refuse-active-target
    else
      printf '%s\n' safe-different-app
    fi
  else
    printf '%s\n' refuse-unproven
  fi
}

# Resolve exactly one non-physical display containing the exact requested package. The accessibility
# dump also lists display-0 windows, and accepting one of those would turn a failed background
# launch into a false "hidden display" success.
control_hidden_display_for_package_from_windows_dump() {
  local package="${1:-}"
  [[ "$package" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || return 1
  awk -v wanted="$package" '
    /^[[:space:]]*display[[:space:]]+[0-9]+[[:space:]]+windows=/ {
      display_id = $2
      next
    }
    display_id ~ /^[1-9][0-9]*$/ {
      for (field = 1; field <= NF; field++) {
        if ($field == "pkg=" wanted) displays[display_id] = 1
      }
    }
    END {
      count = 0
      for (display_id in displays) {
        answer = display_id
        count++
      }
      if (count != 1) exit 1
      print answer
    }
  '
}

# Force-stop is a device-wide mutation even when it is motivated by hidden-display cleanup.
# Re-prove physical-display state immediately before each package stop. A different exact
# display-0 package is safe; the target package is safe only when the phone is proved asleep or
# locked. Any missing/ambiguous state skips the optimization.
control_safe_force_stop_package() {
  local package="${1:-}" activity_dump foreground power_dump window_dump wake lock verdict
  [[ "$package" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || return 2

  activity_dump=$(control_rish_bounded 'dumpsys activity activities 2>/dev/null' \
    2>/dev/null || true)
  foreground=$(printf '%s\n' "$activity_dump" |
    control_display_zero_top_resumed_from_dump 2>/dev/null || true)
  if [ -n "$foreground" ] && [ "$foreground" != "$package" ]; then
    control_rish_bounded "am force-stop $package" >/dev/null 2>&1
    return
  fi

  power_dump=$(control_rish_bounded 'dumpsys power 2>/dev/null' 2>/dev/null || true)
  window_dump=$(control_rish_bounded 'dumpsys window 2>/dev/null' 2>/dev/null || true)
  wake=$(printf '%s\n' "$power_dump" | control_screen_wake_state_from_dump)
  lock=$(printf '%s\n' "$window_dump" | control_lockscreen_state_from_dump)
  verdict=$(control_hidden_launch_verdict "$wake" "$lock" "$foreground" "$package")
  case "$verdict" in
    safe-unattended|safe-locked|safe-different-app)
      control_rish_bounded "am force-stop $package" >/dev/null 2>&1
      ;;
    *)
      return 75
      ;;
  esac
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
  local dir="${CONTROL_OWNER_DIR:-}/packages" pkg
  [ -d "$dir" ] || return 0
  for pkg in "$dir"/*; do
    [ -f "$pkg" ] || continue
    pkg="${pkg##*/}"
    [[ "$pkg" =~ ^[A-Za-z0-9_.]+$ ]] || continue
    control_safe_force_stop_package "$pkg" || true
  done
}

control_wake_command() {
  local binary="$1" budget="${CONTROL_WAKE_COMMAND_SECONDS:-8}"
  case "$budget" in
    ''|*[!0-9]*) budget=8 ;;
  esac
  [ "$budget" -ge 1 ] 2>/dev/null || budget=8
  [ "$budget" -le 15 ] 2>/dev/null || budget=15
  command -v "$binary" >/dev/null 2>&1 || return 127
  if command -v setsid >/dev/null 2>&1; then
    setsid -f -w timeout -k 2 "$budget" "$binary" </dev/null \
      >/dev/null 2>&1
  else
    timeout --foreground -k 2 "$budget" "$binary" </dev/null \
      >/dev/null 2>&1
  fi
}

control_dedicated_termux_wake_enabled() {
  local marker="$HOME/phone-tools/.dedicated-termux-wake"
  [ "${EVOGENT_DEDICATED_TERMUX_WAKE:-0}" = 1 ] && return 0
  [ -f "$marker" ] && [ ! -L "$marker" ] \
    && [ "$(stat -c '%a' "$marker" 2>/dev/null || true)" = 600 ] \
    && [ "$(stat -c '%u' "$marker" 2>/dev/null || true)" = "$(id -u)" ] \
    && [ "$(cat "$marker" 2>/dev/null)" = EVOGENT_DEDICATED_TERMUX_WAKE_V1 ]
}

control_wake_marker_state() {
  local marker="$CONTROL_ROOT/wake/.evogent-held" state
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  state=$(head -n 1 "$marker" 2>/dev/null || true)
  case "$state" in
    ""|held) printf 'held\n' ;;
    acquiring|uncertain) printf 'uncertain\n' ;;
    *) return 2 ;;
  esac
}

control_wake_marker_write_locked() {
  local state="$1" marker="$CONTROL_ROOT/wake/.evogent-held"
  local temporary="$marker.tmp.$$"
  case "$state" in held|acquiring|uncertain) ;; *) return 1 ;; esac
  printf '%s\n' "$state" > "$temporary" || return 1
  chmod 600 "$temporary" 2>/dev/null || true
  mv "$temporary" "$marker"
}

# Turn an ambiguous prior launch into the explicitly dedicated Termux wake state
# before any unlock is permitted. Termux exposes one app-global singleton, so
# this is safe only after the device owner declares this Termux installation
# dedicated to Evogent.
control_wake_establish_locked() {
  control_wake_command termux-wake-lock || return $?
  control_wake_marker_write_locked held
}

control_wake_registry_acquire() {
  local attempt gate="$CONTROL_ROOT/wake-registry.lock"
  [ "$CONTROL_WAKE_REGISTRY_HELD" = 0 ] || return 0
  CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK="$CONTROL_ACTIVE_LOCK"
  for attempt in $(seq 1 200); do
    if control_lock_acquire "$gate" wake-registry; then
      CONTROL_WAKE_REGISTRY_HELD=1
      return 0
    fi
    sleep 0.05
  done
  CONTROL_ACTIVE_LOCK="$CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK"
  CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK=""
  return 1
}

control_wake_registry_release() {
  local gate="$CONTROL_ROOT/wake-registry.lock"
  [ "$CONTROL_WAKE_REGISTRY_HELD" = 1 ] || return 0
  control_lock_release "$gate" || return 1
  CONTROL_WAKE_REGISTRY_HELD=0
  CONTROL_ACTIVE_LOCK="$CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK"
  CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK=""
}

control_wake_prune_locked() {
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
  local marker_state="" attempt status=0
  control_dedicated_termux_wake_enabled || return 125
  [ -n "$CONTROL_OWNER_ID" ] || control_init_owner wake
  control_wake_registry_acquire || return 1
  control_wake_prune_locked
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    marker_state="$(control_wake_marker_state)" || {
      control_wake_registry_release || true
      return 1
    }
  fi
  dir="$CONTROL_ROOT/wake/$CONTROL_OWNER_ID"
  mkdir -p "$dir"
  {
    printf 'pid=%s\n' "$$"
    printf 'start=%s\n' "$CONTROL_SELF_START"
  } > "$dir/owner.tmp"
  mv "$dir/owner.tmp" "$dir/owner"
  if [ "$marker_state" = held ]; then
    CONTROL_WAKE_HELD=1
    control_wake_registry_release || return 1
    return 0
  fi
  # Publish cleanup intent before the global Android wake operation. SIGKILL
  # after this barrier leaves both a dead owner reference and an explicit
  # uncertain marker. Cleanup must establish Evogent ownership before unlock.
  [ "$marker_state" = uncertain ] \
    || control_wake_marker_write_locked acquiring || {
    rm -rf -- "$dir"
    CONTROL_WAKE_HELD=0
    control_wake_registry_release || true
    return 1
  }
  for attempt in 1 2; do
    status=0
    control_wake_establish_locked || status=$?
    if [ "$status" = 0 ]; then
      CONTROL_WAKE_HELD=1
      control_wake_registry_release || return 1
      return 0
    fi
    [ "$status" = 127 ] && break
  done
  if [ "$status" = 127 ] && [ -z "$marker_state" ]; then
    # command -v failed before any global wake operation was possible.
    rm -rf -- "$dir"
    rm -f "$marker"
    CONTROL_WAKE_HELD=0
    control_wake_registry_release || true
    return 1
  fi
  control_wake_marker_write_locked uncertain || true
  # Keep the owner reference live so cleanup/watchdog can retry establishment.
  # Callers inspect this flag even when acquisition returns nonzero.
  CONTROL_WAKE_HELD=1
  control_wake_registry_release || true
  return 1
}

control_wake_release() {
  local marker="$CONTROL_ROOT/wake/.evogent-held" marker_state=""
  control_dedicated_termux_wake_enabled || return 125
  control_wake_registry_acquire || return 1
  control_wake_prune_locked
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    marker_state="$(control_wake_marker_state)" || {
      control_wake_registry_release || true
      return 1
    }
  fi
  if [ -n "$CONTROL_OWNER_ID" ] \
      && [ -d "$CONTROL_ROOT/wake/$CONTROL_OWNER_ID" ]; then
    if [ "$marker_state" != held ]; then
      if ! control_wake_establish_locked; then
        CONTROL_WAKE_HELD=1
        control_wake_registry_release || true
        return 1
      fi
      marker_state=held
    fi
    rm -rf -- "$CONTROL_ROOT/wake/$CONTROL_OWNER_ID"
  fi
  control_wake_prune_locked
  if ! find "$CONTROL_ROOT/wake" -mindepth 1 -maxdepth 1 -type d 2>/dev/null |
      grep -q . && [ -f "$marker" ]; then
    if control_wake_command termux-wake-unlock; then
      rm -f "$marker"
    else
      CONTROL_WAKE_HELD=1
      control_wake_registry_release || true
      return 1
    fi
  fi
  CONTROL_WAKE_HELD=0
  control_wake_registry_release
}

control_release_legacy_wake_if_idle() {
  local marker="$CONTROL_ROOT/wake/.evogent-held" marker_state=""
  local legacy_retired="$CONTROL_ROOT/wake/.legacy-release-attempted"
  control_dedicated_termux_wake_enabled || return 0
  control_wake_registry_acquire || return 1
  control_wake_prune_locked
  if ! find "$CONTROL_ROOT/wake" -mindepth 1 -maxdepth 1 -type d 2>/dev/null |
      grep -q .; then
    if [ -f "$marker" ]; then
      marker_state="$(control_wake_marker_state)" || {
        control_wake_registry_release || true
        return 1
      }
      if [ "$marker_state" != held ] \
          && ! control_wake_establish_locked; then
        control_wake_registry_release || true
        return 1
      fi
      if control_wake_command termux-wake-unlock; then
        rm -f "$marker"
      fi
    elif [ ! -f "$legacy_retired" ] \
        && control_wake_command termux-wake-unlock; then
      # One blind release retires the pre-reference-counted Evogent lock during upgrade.
      # Thereafter the marker above prevents the watchdog from releasing unrelated Termux work.
      : > "$legacy_retired"
      chmod 600 "$legacy_retired" 2>/dev/null || true
    fi
  fi
  control_wake_registry_release
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
  local registry="$HOME/evogent/data/phone-control-status.json" status=0
  mkdir -p "$(dirname "$registry")"
  python3 - "$registry" "$section" "$key" "$state" "$outcome" "$gain" "$rc" "$detail" \
    "${CONTROL_OWNER_ID:-}" "$$" "${CONTROL_SELF_START:-}" <<'PYEOF' \
    >/dev/null 2>&1 || status=$?
import fcntl, json, math, os, signal, sys, time

path, section, key, state, outcome, gain, rc, detail, owner, pid, start = sys.argv[1:]
lock_path = path + ".lock"
now = int(time.time() * 1000)
try:
    lock_timeout = float(
        os.environ.get("EVOGENT_CONTROL_STATUS_WRITE_TIMEOUT_SECONDS", "5")
    )
except ValueError:
    lock_timeout = 5.0
if not math.isfinite(lock_timeout):
    lock_timeout = 5.0
lock_timeout = min(10.0, max(0.05, lock_timeout))

def write_timeout(_signum, _frame):
    # Status 75 is the sole retryable result. The shell owners distinguish it
    # from malformed arguments, unsafe storage, and every other hard failure.
    raise SystemExit(75)

signal.signal(signal.SIGALRM, write_timeout)
signal.setitimer(signal.ITIMER_REAL, lock_timeout)
with open(lock_path, "a+", encoding="utf-8") as lock:
    deadline = time.monotonic() + lock_timeout
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SystemExit(75)
            time.sleep(min(0.05, remaining))
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
    descriptor = os.open(
        tmp,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), sort_keys=True)
        f.write("\n")
        f.flush()
        os.fchmod(f.fileno(), 0o600)
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fcntl.flock(lock, fcntl.LOCK_UN)
PYEOF
  case "$status" in
    0) return 0 ;;
    75)
      printf 'control status: %s publication timed out; retry deferred\n' \
        "$section" >&2
      return 75
      ;;
    *)
      printf 'control status: %s publication failed (status %s)\n' \
        "$section" "$status" >&2
      return 1
      ;;
  esac
}

# Prove that one status record belongs to the exact PID+start-aware lock owner
# that is still alive. Boot uses this after launching the scheduler and watchdog
# so "started" means observable control-plane health, not merely a fork request.
control_status_owner_live() {
  local section="$1" lock="$2" max_age_seconds="${3:-0}"
  local registry="$HOME/evogent/data/phone-control-status.json"
  python3 - "$registry" "$section" "$lock" "$max_age_seconds" <<'PYEOF' \
    >/dev/null 2>&1
import json
import os
import pathlib
import re
import stat
import sys
import time

registry, section, lock, raw_max_age = sys.argv[1:]
registry = pathlib.Path(registry)
lock = pathlib.Path(lock)
if section not in {"scheduler", "watchdog"}:
    raise SystemExit(1)
if re.fullmatch(r"[0-9]+", raw_max_age or "") is None:
    raise SystemExit(1)
max_age_ms = int(raw_max_age) * 1000

lock_metadata = os.lstat(lock)
if not stat.S_ISDIR(lock_metadata.st_mode) or stat.S_ISLNK(lock_metadata.st_mode):
    raise SystemExit(1)
owner_path = lock / "owner"
owner_metadata = os.lstat(owner_path)
if (
    not stat.S_ISREG(owner_metadata.st_mode)
    or stat.S_ISLNK(owner_metadata.st_mode)
    or stat.S_IMODE(owner_metadata.st_mode) != 0o600
    or owner_metadata.st_uid != os.geteuid()
    or owner_metadata.st_size > 4096
):
    raise SystemExit(1)
owner = {}
for line in owner_path.read_text(encoding="utf-8").splitlines():
    if "=" in line:
        key, value = line.split("=", 1)
        owner[key] = value

data = json.loads(registry.read_text(encoding="utf-8"))
record = data.get(section) if isinstance(data, dict) else None
if not isinstance(record, dict) or record.get("state") != "running":
    raise SystemExit(1)
pid = owner.get("pid", "")
start = owner.get("start", "")
if (
    re.fullmatch(r"[1-9][0-9]*", pid or "") is None
    or re.fullmatch(r"[0-9]+", start or "") is None
    or record.get("owner") != owner.get("owner")
    or record.get("pid") != int(pid)
    or record.get("processStartTicks") != int(start)
):
    raise SystemExit(1)
try:
    process_stat = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
except FileNotFoundError:
    if sys.platform != "darwin":
        raise SystemExit(1)
    try:
        os.kill(int(pid), 0)
    except (ProcessLookupError, PermissionError):
        raise SystemExit(1)
else:
    fields = process_stat.rsplit(") ", 1)
    if (
        len(fields) != 2
        or len(fields[1].split()) < 20
        or fields[1].split()[19] != start
    ):
        raise SystemExit(1)
updated_at_ms = record.get("updatedAtMs")
if max_age_ms and (
    not isinstance(updated_at_ms, int)
    or isinstance(updated_at_ms, bool)
    or updated_at_ms > int(time.time() * 1000) + 60_000
    or int(time.time() * 1000) - updated_at_ms > max_age_ms
):
    raise SystemExit(1)
PYEOF
}

control_finish_owner() {
  [ -n "$CONTROL_OWNER_ID" ] || return 0
  control_kill_tagged "$CONTROL_OWNER_ID"
  [ -n "$CONTROL_OWNER_DIR" ] && rm -rf -- "$CONTROL_OWNER_DIR"
}
