#!/data/data/com.termux/files/usr/bin/bash
# source-discovery.sh <package> <AppName> [source-name] — one-time heavy-brain discovery
# session for a new source: learns how to browse <package> on the hidden display, caches a
# first batch of items, and writes a repeatable recipe to ~/evogent/data/phone-sources/.
# Dispatched from a source-scout suggestion card's approve button (run it inside a detached
# tmux; it can take up to ~15 minutes). Reports completion as a feed notification.
set -u
TOOLS="$HOME/phone-tools"
EVO="$HOME/evogent"
LOG="$TOOLS/scheduler.log"
BASE="http://127.0.0.1:${PORT:-3001}"
EVO_CURL="$TOOLS/evo-curl"
TASK_QUEUE="$TOOLS/durable_task_queue.py"
REQUEST_QUEUE="$EVO/data/phone-sources/.queue"
REQUEST_LEASE=""
REQUEST_CREATED_AT_MS=0
REQUEST_RECONCILIATION_ONLY=0
if [ "${1:-}" = "--lease" ]; then
  REQUEST_LEASE="${2:?usage: source-discovery.sh --lease <leased-request.json>}"
  PKG=$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1])).get("pkg") or ""))' "$REQUEST_LEASE" 2>/dev/null)
  NAME=$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1])).get("name") or ""))' "$REQUEST_LEASE" 2>/dev/null)
  SRC=$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1])).get("source") or ""))' "$REQUEST_LEASE" 2>/dev/null)
  REQUEST_CREATED_AT_MS=$(python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1])).get("createdAtMs") or 0))' \
    "$REQUEST_LEASE" 2>/dev/null)
  REQUEST_RECONCILIATION_ONLY=$(python3 -c \
    'import json,sys;value=json.load(open(sys.argv[1])).get("reconciliationOnly",False);isinstance(value,bool) or sys.exit(1);print(int(value))' \
    "$REQUEST_LEASE" 2>/dev/null) || {
    echo "source-discovery: leased request has invalid reconciliation state" >&2
    exit 2
  }
  [ -n "$PKG" ] && [ -n "$NAME" ] && [ -n "$SRC" ] || {
    echo "source-discovery: leased request is missing pkg/name/source" >&2
    exit 2
  }
  [[ "$REQUEST_CREATED_AT_MS" =~ ^[1-9][0-9]+$ ]] || {
    echo "source-discovery: leased request has no valid creation clock" >&2
    exit 2
  }
else
  PKG="${1:?usage: source-discovery.sh <package> <AppName> [source-name]}"
  NAME="${2:?usage: source-discovery.sh <package> <AppName> [source-name]}"
  SRC="${3:-$(echo "$NAME" | tr '[:upper:] ' '[:lower:]-')}"
fi
if ! [[ "$PKG" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]]; then
  echo "source-discovery: package is not a canonical Android package name" >&2
  exit 2
fi
if ! [[ "$SRC" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; then
  echo "source-discovery: source must be a canonical lowercase slug" >&2
  exit 2
fi
if [ "${#NAME}" -gt 120 ] || printf '%s' "$NAME" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  echo "source-discovery: app name must be bounded printable text" >&2
  exit 2
fi
export EVOGENT_API_CURL="$EVO_CURL"
ts(){ date '+%F %T'; }
say(){ echo "[$(ts)] [source-discovery:$SRC] $*" | tee -a "$LOG" >&2; }
source_optout_state(){
  local state
  state=$(python3 "$TOOLS/source_recipe_authority.py" admission-state \
    --database "$EVO/data/media-agent.db" \
    --ledger "$EVO/data/phone-sources/.optout" \
    --source "$SRC" 2>/dev/null) || state=unknown
  case "$state" in
    allowed) printf 'no\n' ;;
    cancelled) printf 'yes\n' ;;
    *) printf 'unknown\n' ;;
  esac
}
opted_out(){
  [ "$(source_optout_state)" = yes ]
}
optout_authority_unknown(){
  [ "$(source_optout_state)" = unknown ]
}

. "$TOOLS/control-plane.sh"
control_init_owner source-discovery
control_reap_abandoned_owners

# The scheduler's admission proof can be minutes old by the time this detached worker obtains the
# cycle lock. Re-prove all phone-control paths at the provider boundary: one fixed authenticated
# accessibility health reply, one bounded shell-uid query, and the read-only Termux background-
# launch app-op. No heal, retry loop, display selection, or source-state mutation belongs here.
discovery_phone_reprove() {
  local shell_identity="" overlay_state="" host_policy=""
  if ! "$TOOLS/evo-health" >/dev/null 2>&1; then
    say "authenticated local server proof failed after lock acquisition"
    return 1
  fi
  if ! EVOGENT_TASK_OWNER="$CONTROL_OWNER_ID" A11Y_PERSIST_SNAPSHOT=0 \
      bash "$TOOLS/phone.sh" health >/dev/null 2>>"$LOG"; then
    say "accessibility health proof failed after lock acquisition"
    return 1
  fi
  if ! shell_identity=$(control_rish_bounded 'id' 2>/dev/null) \
      || ! printf '%s\n' "$shell_identity" | grep -qE '(^|[[:space:]])uid=2000([[:space:](]|$)'; then
    say "shell uid proof failed after lock acquisition"
    return 1
  fi
  if ! overlay_state=$(control_rish_bounded \
      'appops get com.termux SYSTEM_ALERT_WINDOW' 2>/dev/null); then
    say "Termux special-access proof unavailable after lock acquisition; owner revocation is unknown"
    return 1
  elif ! printf '%s\n' "$overlay_state" |
      grep -qE 'SYSTEM_ALERT_WINDOW:[[:space:]]*allow([;[:space:]]|$)'; then
    if printf '%s\n' "$overlay_state" |
        grep -qE 'SYSTEM_ALERT_WINDOW:[[:space:]]*(deny|ignore|default|foreground)([;[:space:]]|$)'; then
      say "USER_ACTION_REQUIRED kind=termux_display_over_apps purpose=hidden_display_launch"
    else
      say "Termux special-access proof was malformed; owner revocation is unknown"
    fi
    return 1
  fi
  if ! host_policy=$(control_rish_bounded \
      'printf "phantom=%s desktop=%s freeform=%s\n" "$(settings get global settings_enable_monitor_phantom_procs)" "$(settings get global force_desktop_mode_on_external_displays)" "$(settings get global enable_freeform_support)"' \
      2>/dev/null); then
    say "phone host-policy proof unavailable after lock acquisition; owner reversal is unknown"
    return 1
  elif [ "$host_policy" != "phantom=false desktop=1 freeform=1" ]; then
    if printf '%s\n' "$host_policy" |
        grep -qxE 'phantom=(true|false|null|0|1) desktop=(0|1|null) freeform=(0|1|null)'; then
      say "USER_ACTION_REQUIRED kind=phone_host_policy purpose=durable_runtime_and_hidden_display"
    else
      say "phone host-policy proof was malformed; owner reversal is unknown"
    fi
    return 1
  fi
  return 0
}

discovery_wake_acquire_policy() {
  local wake_rc=0
  if control_wake_acquire; then
    DISC_WAKE_HELD=1
    return 0
  else
    wake_rc=$?
  fi
  [ "${CONTROL_WAKE_HELD:-0}" = 1 ] && DISC_WAKE_HELD=1
  if [ "$wake_rc" -eq 125 ]; then
    say "power_unprotected — owner policy has not opted this dedicated Termux install into scoped wake control"
    return 0
  fi
  say "scoped CPU wake acquisition failed (rc=$wake_rc) — discovery provider deferred"
  return 76
}

# Same PID+start-aware lease as evogent-cycle.sh: exactly one hidden-display driver at a time.
# A live owner is never evicted merely because its task crossed an arbitrary age threshold.
LOCKDIR="$TOOLS/.cycle.lock"
WAITED=0
DISC_LOCK_HELD=0
DISC_WAKE_HELD=0
DISC_REPORTED=0
DISC_REQUEST_FINISHED=0
DISC_TERMINAL_PROOF=0
DISC_ACTIVATION_PENDING=0
DISC_CANCELLED=0
DISCOVERY_RECEIPT=""
DISCOVERY_RECEIPT_TMP=""
LIVE_RECIPE="$EVO/data/phone-sources/$SRC.txt"
RECIPE_CANDIDATE_DIR="$EVO/data/phone-sources/.candidates"
ACTIVE_MANIFEST="$EVO/data/phone-sources/.active/$SRC.json"
RECIPE_AUTHORITY="$TOOLS/source_recipe_authority.py"
RECIPE=""
AUTHORITY_BACKUP_DIR="$TOOLS/.source-discovery-authority-backups"
LIVE_RECIPE_BACKUP=""
ACTIVE_MANIFEST_BACKUP=""
AUTHORITY_SNAPSHOT_METADATA_BACKUP=""
LIVE_RECIPE_EXISTED=0
ACTIVE_MANIFEST_EXISTED=0
AUTHORITY_SNAPSHOT_READY=0
RETAIN_AUTHORITY_BACKUPS=0
finish_request() {
  local result="$1" outcome="$2" detail="${3:-}" transition
  [ -n "$REQUEST_LEASE" ] || return 0
  [ "$DISC_REQUEST_FINISHED" = 0 ] || return 0
  transition=$(python3 "$TASK_QUEUE" finish --root "$REQUEST_QUEUE" --lease "$REQUEST_LEASE" \
    --result "$result" --outcome "$outcome" --detail "$detail" 2>>"$LOG") || {
      say "request ledger transition failed; lease remains durable for expiry recovery"
      return 1
    }
  DISC_REQUEST_FINISHED=1
  say "request ledger: $(printf '%s' "$transition" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("action") or "updated")' 2>/dev/null || echo updated)"
}

mark_request_reconciliation_only() {
  local transition action
  if [ -z "$REQUEST_LEASE" ]; then
    REQUEST_RECONCILIATION_ONLY=1
    return 0
  fi
  transition=$(python3 "$TASK_QUEUE" mark-discovery-reconciliation-only \
    --root "$REQUEST_QUEUE" --lease "$REQUEST_LEASE" 2>>"$LOG") || {
      say "validated proof could not be bound to durable reconciliation-only state"
      return 1
    }
  action=$(printf '%s' "$transition" |
    python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("action") or "")' \
      2>/dev/null)
  case "$action" in
    marked|already_marked)
      REQUEST_RECONCILIATION_ONLY=1
      say "request ledger: discovery is permanently reconciliation-only"
      ;;
    *)
      say "validated proof reconciliation marker returned an invalid result"
      return 1
      ;;
  esac
}

recover_completed_discovery_ack(){
  [ -n "$REQUEST_LEASE" ] || return 1
  [[ "$REQUEST_CREATED_AT_MS" =~ ^[1-9][0-9]+$ ]] || return 1
  [ -f "$RECIPE_AUTHORITY" ] || return 1
  python3 "$RECIPE_AUTHORITY" recover-promote \
    --database "$EVO/data/media-agent.db" \
    --source "$SRC" \
    --package "$PKG" \
    --live "$LIVE_RECIPE" \
    --manifest "$ACTIVE_MANIFEST" \
    --candidate-dir "$RECIPE_CANDIDATE_DIR" \
    --created-at-ms "$REQUEST_CREATED_AT_MS"
}

publish_discovery_success_notification(){
  local count="$1" payload
  [[ "$count" =~ ^[1-9][0-9]*$ ]] || return 1
  payload=$(python3 - "$SRC" "$NAME" "$count" <<'PYEOF'
import json
import sys

source, name, count = sys.argv[1:]
print(json.dumps({
    "items": [{
        "type": "notification",
        "source": "phone",
        "sourceId": f"source-discovery-{source}",
        "title": f"{name} source discovery succeeded",
        "text": (
            f"Evogent validated an attempt-bound browse recipe and "
            f"{count} server-accepted current-run items. Normal cycles will use "
            "the source only when its finite cadence or a source signal makes it due."
        ),
        "metadata": {
            "notificationId": f"source-discovery-{source}",
            "notificationKind": "source_discovery_success",
            "sourceName": source,
            "severity": "info",
        },
    }],
}, separators=(",", ":")))
PYEOF
  ) || return 1
  "$EVO_CURL" -fsS -m8 -X POST "$BASE/api/internal/curate/submit" \
    -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1
}

publish_discovery_failure_notification(){
  local provider_rc="$1" payload
  [[ "$provider_rc" =~ ^[0-9]+$ ]] || provider_rc=1
  payload=$(python3 - "$SRC" "$NAME" "$provider_rc" <<'PYEOF'
import json
import sys

source, name, provider_rc = sys.argv[1:]
print(json.dumps({
    "items": [{
        "type": "notification",
        "source": "phone",
        "sourceId": f"source-discovery-{source}-failed",
        "title": f"{name} source discovery failed",
        "text": (
            f"The source discovery session for {name} did not prove a usable "
            f"attempt-bound browse recipe (provider exit {provider_rc}). Evogent "
            "retained the request for bounded retry; repeated failures are quarantined."
        ),
        "metadata": {
            "notificationId": f"source-discovery-{source}-failed",
            "severity": "warning",
        },
    }],
}, separators=(",", ":")))
PYEOF
  ) || return 1
  "$EVO_CURL" -fsS -m8 -X POST "$BASE/api/internal/curate/submit" \
    -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1
}

cancel_opted_out_source(){
  local payload
  payload=$(python3 - "$SRC" <<'PYEOF'
import json
import sys
print(json.dumps({"source": sys.argv[1]}, separators=(",", ":")))
PYEOF
  ) || return 1
  "$EVO_CURL" -fsS -m8 -X POST "$BASE/api/internal/browse-cache/cancel-source" \
    -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1 || return 1
  rm -f -- "$LIVE_RECIPE" "$ACTIVE_MANIFEST" \
    "$EVO/data/phone-sources/$SRC.py" "${RECIPE:-}"
  if [ -d "$RECIPE_CANDIDATE_DIR" ] && [ ! -L "$RECIPE_CANDIDATE_DIR" ]; then
    find "$RECIPE_CANDIDATE_DIR" -maxdepth 1 -type f \
      -name "$SRC.source-discovery-*.candidate" -delete 2>/dev/null || return 1
  fi
}

discard_current_discovery_staging(){
  [ -n "${DISCOVERY_RUN_ID:-}" ] || return 0
  local payload
  payload=$(python3 - "$SRC" "$DISCOVERY_RUN_ID" <<'PYEOF'
import json
import sys
print(json.dumps(
    {"source": sys.argv[1], "runId": sys.argv[2]},
    separators=(",", ":"),
))
PYEOF
  ) || return 1
  "$EVO_CURL" -fsS -m8 -X POST \
    "$BASE/api/internal/browse-cache/discard-source-staging" \
    -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1
}

activate_discovery_evidence(){
  local run_id="$1" recipe_sha="$2" payload response
  payload=$(python3 - "$SRC" "$PKG" "$run_id" "$recipe_sha" <<'PYEOF'
import json
import sys
print(json.dumps({
    "source": sys.argv[1],
    "package": sys.argv[2],
    "runId": sys.argv[3],
    "recipeSha256": sys.argv[4],
}, separators=(",", ":")))
PYEOF
  ) || return 1
  response=$("$EVO_CURL" -fsS -m8 -X POST \
    "$BASE/api/internal/browse-cache/activate-source" \
    -H 'content-type: application/json' -d "$payload") || return 1
  python3 -c '
import json, sys
run_id, recipe_sha, response = sys.argv[1:]
body = json.loads(response)
activation = body.get("activation") if isinstance(body, dict) and body.get("ok") is True else None
if not isinstance(activation, dict):
    raise SystemExit(1)
if (
    activation.get("runId") != run_id
    or activation.get("recipeSha256") != recipe_sha
    or not isinstance(activation.get("itemsActivated"), int)
    or activation["itemsActivated"] < 1
):
    raise SystemExit(1)
print(activation["itemsActivated"])
' "$run_id" "$recipe_sha" "$response"
}

finish_opted_out_request(){
  DISC_TERMINAL_PROOF=0
  DISC_CANCELLED=1
  DISC_REPORTED=1
  if ! cancel_opted_out_source; then
    say "cancelled source cache cleanup failed; retaining request for model-free retry"
    control_status_write sources "$SRC" degraded discovery_cancel_cleanup_failed 0 75 \
      "owner opt-out is durable but source cache cleanup is not yet proven"
    finish_request retry discovery_cancel_cleanup_failed \
      "owner opt-out cache cleanup is not yet proven" || true
    return 75
  fi
  control_status_write sources "$SRC" completed discovery_cancelled 0 0 \
    "owner opt-out removed recipes and cached source rows"
  finish_request ack discovery_cancelled \
    "owner opt-out removed recipes and cached source rows"
}

prepare_discovery_recipe_authority(){
  python3 - "$EVO/data/phone-sources" "$RECIPE_CANDIDATE_DIR" \
    "$RECIPE" "$LIVE_RECIPE" "$(dirname "$ACTIVE_MANIFEST")" \
    "$AUTHORITY_BACKUP_DIR" "$LIVE_RECIPE_BACKUP" \
    "$ACTIVE_MANIFEST_BACKUP" "$AUTHORITY_SNAPSHOT_METADATA_BACKUP" \
    "$SRC" "$DISCOVERY_RUN_ID" <<'PYEOF'
import json
import os
from pathlib import Path
import stat
import sys

(
    root,
    candidate_directory,
    recipe,
    live_recipe,
    active_directory,
    backup_directory,
    live_backup,
    manifest_backup,
    snapshot_metadata,
) = map(Path, sys.argv[1:10])
source, run_id = sys.argv[10:12]
for directory in (root, candidate_directory, active_directory, backup_directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = directory.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or directory.is_symlink()
    ):
        raise SystemExit("recipe directory is not safe owner-controlled authority")
    os.chmod(directory, 0o700)
if recipe.parent != candidate_directory:
    raise SystemExit("candidate path escaped its private staging directory")
try:
    recipe_metadata = recipe.lstat()
except FileNotFoundError:
    recipe_metadata = None
if recipe_metadata is not None:
    raise SystemExit("run-scoped recipe candidate already exists")
existence = []
for existing, backup, maximum in (
    (live_recipe, live_backup, 64 * 1024),
    (active_directory / f"{live_recipe.stem}.json", manifest_backup, 16 * 1024),
):
    try:
        existing_metadata = existing.lstat()
    except FileNotFoundError:
        existence.append(0)
        continue
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(existing, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or opened.st_nlink != 1
            or opened.st_size > maximum
        ):
            raise SystemExit("existing live source authority is unsafe")
        data = b""
        while len(data) < opened.st_size:
            chunk = os.read(descriptor, opened.st_size - len(data))
            if not chunk:
                raise SystemExit("existing live source authority changed during snapshot")
            data += chunk
    finally:
        os.close(descriptor)
    backup_flags = (
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    )
    backup_descriptor = os.open(backup, backup_flags, 0o600)
    try:
        written = 0
        while written < len(data):
            written += os.write(backup_descriptor, data[written:])
        os.fchmod(backup_descriptor, 0o600)
        os.fsync(backup_descriptor)
    finally:
        os.close(backup_descriptor)
    existence.append(1)
snapshot_flags = (
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
)
snapshot_descriptor = os.open(snapshot_metadata, snapshot_flags, 0o600)
try:
    snapshot_data = (
        json.dumps(
            {
                "format": 1,
                "source": source,
                "runId": run_id,
                "liveExisted": existence[0],
                "manifestExisted": existence[1],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")
    written = 0
    while written < len(snapshot_data):
        written += os.write(snapshot_descriptor, snapshot_data[written:])
    os.fchmod(snapshot_descriptor, 0o600)
    os.fsync(snapshot_descriptor)
finally:
    os.close(snapshot_descriptor)
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(recipe, flags, 0o600)
try:
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
directory_descriptor = os.open(candidate_directory, os.O_RDONLY)
try:
    os.fsync(directory_descriptor)
finally:
    os.close(directory_descriptor)
backup_directory_descriptor = os.open(backup_directory, os.O_RDONLY)
try:
    os.fsync(backup_directory_descriptor)
finally:
    os.close(backup_directory_descriptor)
print(f"{existence[0]}\t{existence[1]}")
PYEOF
}

restore_discovery_authority_snapshot(){
  python3 - "$LIVE_RECIPE" "$ACTIVE_MANIFEST" \
    "$LIVE_RECIPE_BACKUP" "$ACTIVE_MANIFEST_BACKUP" \
    "$LIVE_RECIPE_EXISTED" "$ACTIVE_MANIFEST_EXISTED" \
    "$AUTHORITY_SNAPSHOT_METADATA_BACKUP" \
    "$RETAIN_AUTHORITY_BACKUPS" <<'PYEOF'
import os
from pathlib import Path
import secrets
import stat
import sys

live, manifest, live_backup, manifest_backup = map(Path, sys.argv[1:5])
live_existed, manifest_existed = map(int, sys.argv[5:7])
snapshot_metadata = Path(sys.argv[7])
retain_backups = sys.argv[8] == "1"

def fsync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def read_backup(path, maximum):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_nlink != 1
            or metadata.st_size > maximum
        ):
            raise SystemExit("source authority rollback snapshot is unsafe")
        data = b""
        while len(data) < metadata.st_size:
            chunk = os.read(descriptor, metadata.st_size - len(data))
            if not chunk:
                raise SystemExit("source authority rollback snapshot is incomplete")
            data += chunk
        return data
    finally:
        os.close(descriptor)

def atomic_restore(target, data):
    parent = target.parent
    metadata = parent.lstat()
    if (
        parent.is_symlink()
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
    ):
        raise SystemExit("source authority parent became unsafe")
    temporary = parent / (
        f".{target.name}.rollback-{os.getpid()}-{secrets.token_hex(8)}"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600)
    try:
        written = 0
        while written < len(data):
            written += os.write(descriptor, data[written:])
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, target)
    fsync_directory(parent)

for target, backup, existed, maximum in (
    (live, live_backup, live_existed, 64 * 1024),
    (manifest, manifest_backup, manifest_existed, 16 * 1024),
):
    if existed:
        atomic_restore(target, read_backup(backup, maximum))
    else:
        try:
            metadata = target.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                raise SystemExit("unauthorized live source authority is a directory")
            target.unlink()
            fsync_directory(target.parent)
        except FileNotFoundError:
            pass
    if not retain_backups:
        try:
            backup.unlink()
        except FileNotFoundError:
            pass
if not retain_backups:
    try:
        snapshot_metadata.unlink()
    except FileNotFoundError:
        pass
if live_backup.parent.exists():
    fsync_directory(live_backup.parent)
PYEOF
}

retire_discovery_authority_snapshot(){
  rm -f -- "${LIVE_RECIPE_BACKUP:-}" "${ACTIVE_MANIFEST_BACKUP:-}" \
    "${AUTHORITY_SNAPSHOT_METADATA_BACKUP:-}"
}

load_discovery_authority_snapshot(){
  local run_id="$1" flags
  [[ "$run_id" =~ ^source-discovery-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || return 1
  LIVE_RECIPE_BACKUP="$AUTHORITY_BACKUP_DIR/$SRC.$run_id.recipe"
  ACTIVE_MANIFEST_BACKUP="$AUTHORITY_BACKUP_DIR/$SRC.$run_id.manifest"
  AUTHORITY_SNAPSHOT_METADATA_BACKUP="$AUTHORITY_BACKUP_DIR/$SRC.$run_id.snapshot.json"
  flags=$(python3 - "$AUTHORITY_SNAPSHOT_METADATA_BACKUP" \
    "$LIVE_RECIPE_BACKUP" "$ACTIVE_MANIFEST_BACKUP" "$SRC" "$run_id" <<'PYEOF'
import json
import os
from pathlib import Path
import stat
import sys

metadata_path, live_backup, manifest_backup = map(Path, sys.argv[1:4])
source, run_id = sys.argv[4:6]

def read_owned(path, maximum):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_nlink != 1
            or metadata.st_size < 2
            or metadata.st_size > maximum
        ):
            raise SystemExit(1)
        data = b""
        while len(data) < metadata.st_size:
            chunk = os.read(descriptor, metadata.st_size - len(data))
            if not chunk:
                raise SystemExit(1)
            data += chunk
        return data
    finally:
        os.close(descriptor)

record = json.loads(read_owned(metadata_path, 4096).decode("utf-8"))
if (
    not isinstance(record, dict)
    or record.get("format") != 1
    or record.get("source") != source
    or record.get("runId") != run_id
    or record.get("liveExisted") not in (0, 1)
    or record.get("manifestExisted") not in (0, 1)
):
    raise SystemExit(1)
for path, existed, maximum in (
    (live_backup, record["liveExisted"], 64 * 1024),
    (manifest_backup, record["manifestExisted"], 16 * 1024),
):
    if existed:
        read_owned(path, maximum)
    elif path.exists() or path.is_symlink():
        raise SystemExit(1)
print(f'{record["liveExisted"]}\t{record["manifestExisted"]}')
PYEOF
  ) || return 1
  IFS=$'\t' read -r LIVE_RECIPE_EXISTED ACTIVE_MANIFEST_EXISTED <<< "$flags"
  [[ "$LIVE_RECIPE_EXISTED" =~ ^[01]$ ]] \
    && [[ "$ACTIVE_MANIFEST_EXISTED" =~ ^[01]$ ]] || return 1
  AUTHORITY_SNAPSHOT_READY=1
}

retire_discovery_candidate(){
  [ -n "${RECIPE:-}" ] || return 0
  python3 - "$RECIPE" "$RECIPE_CANDIDATE_DIR" "$SRC" <<'PYEOF'
import os
from pathlib import Path
import re
import stat
import sys

candidate, candidate_directory = map(Path, sys.argv[1:3])
source = sys.argv[3]
if candidate.parent != candidate_directory or re.fullmatch(
    re.escape(source)
    + r"\.source-discovery-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
      r"[89ab][0-9a-f]{3}-[0-9a-f]{12}\.candidate",
    candidate.name,
) is None:
    raise SystemExit(1)
try:
    metadata = candidate.lstat()
except FileNotFoundError:
    raise SystemExit(0)
if stat.S_ISDIR(metadata.st_mode):
    raise SystemExit(1)
candidate.unlink()
descriptor = os.open(candidate_directory, os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PYEOF
}

defer_validated_activation(){
  local outcome="$1" detail="$2"
  DISC_ACTIVATION_PENDING=1
  DISC_TERMINAL_PROOF=1
  DISC_REPORTED=1
  if [ "$AUTHORITY_SNAPSHOT_READY" = 1 ]; then
    RETAIN_AUTHORITY_BACKUPS=1
    if ! restore_discovery_authority_snapshot 2>>"$LOG"; then
      RETAIN_AUTHORITY_BACKUPS=0
      say "validated activation is pending and the prior active recipe could not be restored"
      finish_request reconcile "$outcome" \
        "$detail; prior source authority restoration failed" || true
      return 75
    fi
    RETAIN_AUTHORITY_BACKUPS=0
    AUTHORITY_SNAPSHOT_READY=0
  fi
  control_status_write sources "$SRC" degraded "$outcome" 0 75 "$detail"
  finish_request reconcile "$outcome" "$detail" || true
  return 75
}

prepare_discovery_receipt_authority(){
  python3 - "$DISCOVERY_RECEIPT" "$DISCOVERY_RECEIPT_TMP" <<'PYEOF'
import os
from pathlib import Path
import stat
import sys

destination = Path(sys.argv[1])
temporary = Path(sys.argv[2])
parent = destination.parent
metadata = parent.lstat()
if parent.is_symlink():
    expected = (
        Path.home() / ".local" / "share" / "evogent" / "state" / "phone-tools"
    ).resolve(strict=True)
    resolved_parent = parent.resolve(strict=True)
    resolved_metadata = resolved_parent.lstat()
    if (
        resolved_parent != expected
        or not stat.S_ISDIR(resolved_metadata.st_mode)
        or resolved_metadata.st_uid != os.geteuid()
    ):
        raise SystemExit("receipt parent symlink is not the canonical private dispatch")
elif not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid():
    raise SystemExit("receipt parent is not an owner-controlled directory")
for path in (destination, temporary):
    try:
        path.lstat()
    except FileNotFoundError:
        continue
    raise SystemExit(f"receipt path already exists: {path.name}")
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(temporary, flags, 0o600)
try:
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PYEOF
}

# Return provider status in the normal case. A prerequisite miss is not a provider failure and
# consumes no spend: durably return the lease to the bounded retry queue before telling the caller
# to exit. The fresh proof is intentionally the final operation before the provider branch.
DISC_PROVIDER_DEFERRED=0
launch_discovery_provider() {
  DISC_PROVIDER_DEFERRED=0
  if ! discovery_phone_reprove; then
    control_status_write sources "$SRC" degraded discovery_prerequisites_unavailable 0 75 \
      "phone-control prerequisites unavailable after cycle-lock acquisition"
    finish_request retry discovery_prerequisites_unavailable \
      "fresh phone-control prerequisite proof failed after cycle-lock acquisition" || true
    DISC_REPORTED=1
    DISC_PROVIDER_DEFERRED=1
    return 0
  fi
  if [ "$BRAIN" = "codex" ]; then
    # '--' guards against prompts that begin with '-' (codex parses them as CLI options).
    ( cd "$EVO" && run_owned_timeout 900 30 codex exec --model "$DISCOVERY_MODEL" -c model_reasoning_effort="$DISCOVERY_EFFORT" \
        --dangerously-bypass-approvals-and-sandbox -- "$PROMPT" >>"$LOG" 2>&1 )
  else
    ( cd "$EVO" && run_owned_timeout 900 30 env -u ANTHROPIC_API_KEY \
      CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.evogent-oauth-token" 2>/dev/null)" \
      claude -p "$PROMPT" --model "$DISCOVERY_MODEL" --effort "$DISCOVERY_EFFORT" \
        --permission-mode bypassPermissions \
        --allowedTools "Bash,Read,Write,Glob,Grep" >>"$LOG" 2>&1 )
  fi
}

discovery_cleanup() {
  local rc=$? reconciliation_outcome reconciliation_detail
  trap - EXIT INT TERM HUP
  control_kill_tagged "$CONTROL_OWNER_ID"
  if [ "$DISC_LOCK_HELD" = 1 ]; then
    control_cleanup_tracked_packages
    control_close_hidden_displays
  fi
  [ "$DISC_WAKE_HELD" = 1 ] && control_wake_release || true
  if [ "$DISC_LOCK_HELD" = 1 ] && [ "$DISC_REPORTED" = 0 ]; then
    control_status_write sources "$SRC" failed discovery_interrupted 0 "$rc" \
      "source discovery exited before a terminal result"
  fi
  if [ "$DISC_REQUEST_FINISHED" = 0 ] && [ "$DISC_TERMINAL_PROOF" = 1 ]; then
    if [ "$DISC_ACTIVATION_PENDING" = 1 ]; then
      reconciliation_outcome=discovery_activation_pending
      reconciliation_detail="validated discovery proof retained after worker exit rc=$rc"
      say "validated discovery proof is durable; returning it for model-free activation"
    else
      reconciliation_outcome=discovery_reconciliation_pending
      reconciliation_detail="terminal discovery proof retained after worker exit rc=$rc"
      say "terminal discovery proof is durable; returning it for model-free ACK reconciliation"
    fi
    finish_request reconcile "$reconciliation_outcome" "$reconciliation_detail" || true
  elif [ "$DISC_REQUEST_FINISHED" = 0 ]; then
    finish_request retry discovery_interrupted "worker exited rc=$rc before a terminal result" || true
  fi
  if [ "$DISC_ACTIVATION_PENDING" = 1 ]; then
    # Keep the exact candidate, staged rows, and rollback snapshot. The request was returned to
    # the durable queue and the next worker can activate it without another provider launch.
    :
  elif [ "$DISC_TERMINAL_PROOF" = 0 ]; then
    discard_current_discovery_staging >/dev/null 2>&1 || true
    [ -n "${RECIPE:-}" ] && rm -f -- "$RECIPE" || true
    if [ "$AUTHORITY_SNAPSHOT_READY" = 1 ]; then
      if [ "$DISC_CANCELLED" = 1 ]; then
        retire_discovery_authority_snapshot || true
      elif ! restore_discovery_authority_snapshot 2>>"$LOG"; then
        say "failed to restore the previously active source recipe after an unproved attempt"
      fi
    else
      retire_discovery_authority_snapshot || true
    fi
  else
    retire_discovery_authority_snapshot || true
  fi
  [ -n "$DISCOVERY_RECEIPT" ] && rm -f -- "$DISCOVERY_RECEIPT" || true
  [ -n "$DISCOVERY_RECEIPT_TMP" ] && rm -f -- "$DISCOVERY_RECEIPT_TMP" || true
  [ "$DISC_LOCK_HELD" = 1 ] && control_lock_release "$LOCKDIR" || true
  control_finish_owner
  exit "$rc"
}
trap discovery_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

until control_lock_acquire "$LOCKDIR" source-discovery; do
  [ "$WAITED" -ge 1200 ] && { say "cycle lock still held after 20min — giving up"; exit 1; }
  [ "$WAITED" = 0 ] && say "waiting for the live cycle owner to release the hidden display..."
  sleep 30; WAITED=$(( WAITED + 30 ))
done
DISC_LOCK_HELD=1
if control_release_transaction_pending \
    "${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"; then
  say "durable release transaction is pending; discovery remains queued"
  exit 75
fi
OPT_STATE=$(source_optout_state)
case "$OPT_STATE" in
  yes)
    say "cancelled by user — cleaning source evidence without provider work"
    if finish_opted_out_request; then
      exit 0
    fi
    exit 75
    ;;
  no) ;;
  *)
    say "source opt-out authority is unreadable or unsafe — discovery deferred closed"
    control_status_write sources "$SRC" degraded discovery_optout_authority_unknown 0 75 \
      "source opt-out ledger could not prove either admission or cancellation"
    finish_request retry discovery_optout_authority_unknown \
      "source opt-out authority is unreadable or unsafe" || true
    DISC_REPORTED=1
    exit 75
    ;;
esac
RECOVERED_PROOF=$(recover_completed_discovery_ack 2>>"$LOG")
RECOVERY_RC=$?
IFS=$'\t' read -r RECOVERED_ITEMS RECOVERED_RECIPE_SHA RECOVERED_RUN_ID \
  <<< "${RECOVERED_PROOF:-}"
if [ "$RECOVERY_RC" -eq 0 ] \
    && [[ "${RECOVERED_ITEMS:-}" =~ ^[1-9][0-9]*$ ]] \
    && [[ "${RECOVERED_RECIPE_SHA:-}" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "${RECOVERED_RUN_ID:-}" =~ ^source-discovery-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  DISC_TERMINAL_PROOF=1
  DISC_REPORTED=1
  RECIPE="$RECIPE_CANDIDATE_DIR/$SRC.$RECOVERED_RUN_ID.candidate"
  if ! load_discovery_authority_snapshot "$RECOVERED_RUN_ID" 2>>"$LOG"; then
    AUTHORITY_SNAPSHOT_READY=0
  fi
  if ! mark_request_reconciliation_only; then
    defer_validated_activation discovery_reconciliation_state_unavailable \
      "validated recovery could not persist its provider-replay prohibition" || true
    exit 75
  fi
  OPT_STATE=$(source_optout_state)
  if [ "$OPT_STATE" = yes ]; then
    say "owner opt-out won terminal reconciliation; cancelling without success publication"
    if finish_opted_out_request; then
      exit 0
    fi
    exit 75
  fi
  if [ "$OPT_STATE" != no ]; then
    say "source opt-out authority became unknown during terminal reconciliation"
    defer_validated_activation discovery_optout_authority_unknown \
      "validated recovery is waiting for readable source opt-out authority" || true
    exit 75
  fi
  ACTIVATED_ITEMS=$(activate_discovery_evidence \
    "$RECOVERED_RUN_ID" "$RECOVERED_RECIPE_SHA" 2>>"$LOG")
  if ! [[ "${ACTIVATED_ITEMS:-}" =~ ^[1-9][0-9]*$ ]]; then
    OPT_STATE=$(source_optout_state)
    if [ "$OPT_STATE" = yes ]; then
      say "owner cancellation won recovered activation"
      finish_opted_out_request || true
    else
      say "recovered recipe proof could not atomically activate staged evidence; restoring prior authority"
      defer_validated_activation discovery_activation_pending \
        "validated source evidence is waiting for atomic activation" || true
    fi
    exit 75
  fi
  retire_discovery_candidate 2>>"$LOG" || \
    say "activated recovery left a harmless run-scoped candidate for later cleanup"
  RECOVERED_ITEMS="$ACTIVATED_ITEMS"
  say "recovered durable terminal discovery proof; reconciling request ACK without provider work"
  if ! publish_discovery_success_notification "$RECOVERED_ITEMS"; then
    say "success notification publication failed; retaining terminal proof for model-free reconciliation"
    exit 75
  fi
  OPT_STATE=$(source_optout_state)
  if [ "$OPT_STATE" = yes ]; then
    say "owner opt-out landed during recovered success publication; retiring the source"
    if finish_opted_out_request; then
      exit 0
    fi
    exit 75
  elif [ "$OPT_STATE" != no ]; then
    say "source opt-out authority became unknown after success publication; deferring ACK"
    exit 75
  fi
  if finish_request ack discovery_fresh \
      "recovered terminal proof with $RECOVERED_ITEMS accepted items"; then
    exit 0
  fi
  say "request ACK reconciliation failed; retaining terminal proof without provider replay"
  exit 75
fi

if [ "$REQUEST_RECONCILIATION_ONLY" = 1 ]; then
  say "reconciliation-only request has no currently recoverable proof; provider replay is forbidden"
  control_status_write sources "$SRC" degraded discovery_reconciliation_proof_unavailable \
    0 75 "durable reconciliation proof is temporarily unavailable"
  finish_request reconcile discovery_reconciliation_proof_unavailable \
    "reconciliation-only request retained without launching provider work" || true
  DISC_REPORTED=1
  exit 75
fi

DISCOVERY_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>>"$LOG")
DISCOVERY_UUID_RC=$?
DISCOVERY_RUN_ID="source-discovery-$DISCOVERY_UUID"
DISCOVERY_STARTED_AT_MS=$(python3 -c 'import time; print(time.time_ns() // 1_000_000)' \
  2>>"$LOG")
DISCOVERY_CLOCK_RC=$?
DISCOVERY_RECEIPT="$TOOLS/.source-discovery-receipt-$DISCOVERY_RUN_ID.json"
DISCOVERY_RECEIPT_TMP="$DISCOVERY_RECEIPT.tmp"
RECIPE="$RECIPE_CANDIDATE_DIR/$SRC.$DISCOVERY_RUN_ID.candidate"
LIVE_RECIPE_BACKUP="$AUTHORITY_BACKUP_DIR/$SRC.$DISCOVERY_RUN_ID.recipe"
ACTIVE_MANIFEST_BACKUP="$AUTHORITY_BACKUP_DIR/$SRC.$DISCOVERY_RUN_ID.manifest"
AUTHORITY_SNAPSHOT_METADATA_BACKUP="$AUTHORITY_BACKUP_DIR/$SRC.$DISCOVERY_RUN_ID.snapshot.json"
if [ "$DISCOVERY_UUID_RC" -ne 0 ] \
    || [ "$DISCOVERY_CLOCK_RC" -ne 0 ] \
    || ! [[ "$DISCOVERY_RUN_ID" =~ ^source-discovery-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || ! [[ "$DISCOVERY_STARTED_AT_MS" =~ ^[1-9][0-9]{12,15}$ ]] \
    || [[ "$DISCOVERY_RECEIPT" != "$TOOLS"/.source-discovery-receipt-source-discovery-*.json ]] \
    || [[ "$RECIPE" != "$RECIPE_CANDIDATE_DIR/$SRC.$DISCOVERY_RUN_ID.candidate" ]]; then
  say "source discovery identity preparation failed before provider admission"
  control_status_write sources "$SRC" failed discovery_preparation 0 70 \
    "attempt identity or clock failed before provider work"
  finish_request retry discovery_preparation \
    "attempt identity or clock failed before provider work" || true
  DISC_REPORTED=1
  exit 70
fi
AUTHORITY_SNAPSHOT=$(prepare_discovery_recipe_authority 2>>"$LOG")
AUTHORITY_SNAPSHOT_RC=$?
IFS=$'\t' read -r LIVE_RECIPE_EXISTED ACTIVE_MANIFEST_EXISTED \
  <<< "${AUTHORITY_SNAPSHOT:-}"
if [ "$AUTHORITY_SNAPSHOT_RC" -ne 0 ] \
    || ! [[ "$LIVE_RECIPE_EXISTED" =~ ^[01]$ ]] \
    || ! [[ "$ACTIVE_MANIFEST_EXISTED" =~ ^[01]$ ]]; then
  say "recipe output authority is unavailable; discovery deferred before provider work"
  control_status_write sources "$SRC" failed discovery_output_unavailable 0 70 \
    "recipe directory or candidate path is unsafe or unwritable"
  finish_request retry discovery_output_unavailable \
    "recipe directory or candidate path is unsafe or unwritable" || true
  DISC_REPORTED=1
  exit 70
fi
AUTHORITY_SNAPSHOT_READY=1

# Source discovery is allowed to author a durable recipe, so it uses a strong
# independently configured source-discovery route for the selected Brain Provider rather than inheriting
# ordinary chat, browse, curation, or overseer authority. Populate only missing
# phone headings; never rewrite a deployment choice.
MODEL_ROUTER="$TOOLS/model_routing.py"
MODEL_POLICY="$TOOLS/model-routing.default.json"
MODEL_LIVE="$EVO/data/model-routing.json"
MODEL_RECEIPTS="$TOOLS/model-benchmark-results.jsonl"
if ! python3 "$MODEL_ROUTER" ensure-phone-config \
    --config "$EVO/data/config.md" >/dev/null 2>>"$LOG"; then
  say "additive phone model defaults unavailable — discovery deferred"
  control_status_write sources "$SRC" failed discovery_model_config 0 70 \
    "phone model-route defaults unavailable"
  finish_request retry discovery_model_config \
    "phone model-route defaults unavailable" || true
  DISC_REPORTED=1
  exit 70
fi

# App-specific notes from the catalog (best-effort).
NOTES=$(python3 - "$PKG" <<'PYEOF'
import json, sys, os
try:
    apps = json.load(open(os.path.expanduser("~/phone-tools/source-catalog.json")))["apps"]
    print(apps.get(sys.argv[1], {}).get("discoveryNotes", "none"))
except Exception:
    print("none")
PYEOF
)

PROMPT=$(python3 - "$TOOLS/source-discovery-prompt.txt" \
  "$PKG" "$NAME" "$SRC" "$NOTES" "$DISCOVERY_RUN_ID" \
  "$DISCOVERY_STARTED_AT_MS" "$DISCOVERY_RECEIPT" "$RECIPE" <<'PYEOF'
from pathlib import Path
import sys

(
    template_path,
    package,
    name,
    source,
    notes,
    run_id,
    started_at_ms,
    receipt,
    candidate,
) = sys.argv[1:]
text = Path(template_path).read_text(encoding="utf-8")
for marker, value in (
    ("__PKG__", package),
    ("__NAME__", name),
    ("__SRC__", source),
    ("__NOTES__", notes),
    ("__DISCOVERY_RUN_ID__", run_id),
    ("__DISCOVERY_STARTED_AT_MS__", started_at_ms),
    ("__DISCOVERY_RECEIPT__", receipt),
    ("__DISCOVERY_RECIPE_CANDIDATE__", candidate),
):
    text = text.replace(marker, value)
print(text, end="")
PYEOF
)
DISCOVERY_PROMPT_RC=$?
if [ "$DISCOVERY_PROMPT_RC" -ne 0 ] \
    || [ "${#PROMPT}" -lt 1000 ] \
    || [ "${#PROMPT}" -gt 131072 ] \
    || printf '%s' "$PROMPT" | grep -qE '__[A-Z][A-Z0-9_]*__' \
    || ! printf '%s' "$PROMPT" | grep -Fq "$DISCOVERY_RUN_ID" \
    || ! printf '%s' "$PROMPT" | grep -Fq "$DISCOVERY_RECEIPT" \
    || ! printf '%s' "$PROMPT" | grep -Fq "$RECIPE"; then
  say "source discovery preparation failed before provider admission"
  control_status_write sources "$SRC" failed discovery_preparation 0 70 \
    "attempt identity, clock, or prompt rendering failed before provider work"
  finish_request retry discovery_preparation \
    "attempt identity, clock, or prompt rendering failed before provider work" || true
  DISC_REPORTED=1
  exit 70
fi
if ! prepare_discovery_receipt_authority 2>>"$LOG"; then
  say "receipt output authority is unavailable; discovery deferred before provider work"
  control_status_write sources "$SRC" failed discovery_output_unavailable 0 70 \
    "attempt receipt path is unsafe or unwritable"
  finish_request retry discovery_output_unavailable \
    "attempt receipt path is unsafe or unwritable" || true
  DISC_REPORTED=1
  exit 70
fi

# Source discovery is a one-time instruction-authoring/research task, not routine extraction.
# Its independent route prevents a browse or curator benchmark from silently
# changing the model that writes a new durable source recipe.
# Brain provider from data/config.md, same convention as evogent-cycle.sh.
BRAIN_TOKEN=$(awk '/^## Brain Provider/{f=1;next} f&&/^##[[:space:]]/{exit} f&&NF{print;exit}' \
  "$EVO/data/config.md" 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]//g')
case "$BRAIN_TOKEN" in
  codex|codexcli) BRAIN=codex ;;
  claude|claudecode|claudecodecli) BRAIN=claude ;;
  *)
    BRAIN=claude
    say "Brain Provider missing or invalid — using product default Claude Code"
    ;;
esac
if ! SOURCE_DISCOVERY_ROUTE=$(python3 "$MODEL_ROUTER" resolve \
  --task source_discovery \
  --provider "$BRAIN" \
  --config "$EVO/data/config.md" \
  --policy "$MODEL_POLICY" \
  --live "$MODEL_LIVE" \
  --receipts "$MODEL_RECEIPTS" \
  --model-override "${EVOGENT_SOURCE_DISCOVERY_MODEL:-}" \
  --effort-override "${EVOGENT_SOURCE_DISCOVERY_REASONING:-}" \
  2>>"$LOG"); then
  say "selected-provider source-discovery route unavailable — provider not launched"
  control_status_write sources "$SRC" failed discovery_model_route 0 70 \
    "selected-provider source-discovery route unavailable"
  finish_request retry discovery_model_route \
    "selected-provider source-discovery route unavailable" || true
  DISC_REPORTED=1
  exit 70
fi
IFS=$'\t' read -r DISCOVERY_MODEL DISCOVERY_EFFORT DISCOVERY_ROUTE_ORIGIN ROUTE_EXTRA \
  <<< "$SOURCE_DISCOVERY_ROUTE"
ROUTE_VALID=1
[[ "$SOURCE_DISCOVERY_ROUTE" != *$'\n'* ]] || ROUTE_VALID=0
[ -n "$DISCOVERY_MODEL" ] && [ -n "$DISCOVERY_ROUTE_ORIGIN" ] \
  && [ -z "$ROUTE_EXTRA" ] || ROUTE_VALID=0
[[ "$DISCOVERY_MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$ ]] || ROUTE_VALID=0
case "$DISCOVERY_EFFORT" in
  low|medium|high|xhigh|max) ;;
  *) ROUTE_VALID=0 ;;
esac
if [ "$BRAIN" = claude ]; then
  case "$DISCOVERY_MODEL" in claude-*|haiku|sonnet|opus) ;; *) ROUTE_VALID=0 ;; esac
else
  case "$DISCOVERY_MODEL" in claude-*|haiku|sonnet|opus) ROUTE_VALID=0 ;; esac
  [ "$DISCOVERY_EFFORT" != max ] || ROUTE_VALID=0
fi
if [ "$ROUTE_VALID" != 1 ]; then
  say "selected-provider source-discovery route invalid — provider not launched"
  control_status_write sources "$SRC" failed discovery_model_route 0 70 \
    "selected-provider source-discovery route invalid"
  finish_request retry discovery_model_route \
    "selected-provider source-discovery route invalid" || true
  DISC_REPORTED=1
  exit 70
fi

if ! discovery_wake_acquire_policy; then
  control_status_write sources "$SRC" degraded discovery_wake_acquire_failed 0 76 \
    "provider not launched; request remains retryable"
  finish_request retry discovery_wake_acquire_failed \
    "scoped CPU wake acquisition failed before provider work" || true
  DISC_REPORTED=1
  exit 76
fi
control_status_write sources "$SRC" running discovery "" "" "source discovery"

say "discovery starting (brain=$BRAIN, route=$DISCOVERY_ROUTE_ORIGIN, budget 900s) — $NAME ($PKG) -> $SRC"
launch_discovery_provider
RC=$?
if [ "$DISC_PROVIDER_DEFERRED" = 1 ]; then
  say "discovery deferred before provider launch; request retained for retry"
  exit 75
fi

# Cancellation raced the discovery: respect it before candidate validation or activation.
OPT_STATE=$(source_optout_state)
if [ "$OPT_STATE" = yes ]; then
  say "cancelled by user during discovery — removing candidates and cached source rows"
  if finish_opted_out_request; then
    exit 0
  fi
  exit 75
elif [ "$OPT_STATE" != no ]; then
  say "source opt-out authority became unknown during discovery — candidate remains inactive"
  control_status_write sources "$SRC" degraded discovery_optout_authority_unknown 0 75 \
    "post-provider opt-out authority is unreadable or unsafe"
  finish_request retry discovery_optout_authority_unknown \
    "post-provider opt-out authority is unreadable or unsafe" || true
  DISC_REPORTED=1
  exit 75
fi
validate_discovery_postconditions() {
  python3 "$RECIPE_AUTHORITY" validate-promote \
    --database "$EVO/data/media-agent.db" \
    --source "$SRC" \
    --package "$PKG" \
    --live "$LIVE_RECIPE" \
    --manifest "$ACTIVE_MANIFEST" \
    --candidate "$RECIPE" \
    --receipt "$DISCOVERY_RECEIPT" \
    --run-id "$DISCOVERY_RUN_ID" \
    --started-at-ms "$DISCOVERY_STARTED_AT_MS"
}

DISCOVERY_PROOF=""
CACHED=0
RECIPE_SHA=""
PROOF_RUN_ID=""
POSTCONDITION_RC=1
DISCOVERY_PROOF=$(validate_discovery_postconditions 2>>"$LOG")
POSTCONDITION_RC=$?
IFS=$'\t' read -r CACHED RECIPE_SHA PROOF_RUN_ID <<< "${DISCOVERY_PROOF:-}"

if [ "$POSTCONDITION_RC" -eq 0 ] \
    && [[ "${CACHED:-}" =~ ^[1-9][0-9]*$ ]] \
    && [[ "${RECIPE_SHA:-}" =~ ^[0-9a-f]{64}$ ]] \
    && [ "$PROOF_RUN_ID" = "$DISCOVERY_RUN_ID" ]; then
  # Recipe + manifest + staged DB proof are now durable. From this point every failure is
  # reconciled model-free; never spend the source-discovery provider again.
  DISC_TERMINAL_PROOF=1
  DISC_REPORTED=1
  if ! mark_request_reconciliation_only; then
    defer_validated_activation discovery_reconciliation_state_unavailable \
      "validated discovery proof could not persist its provider-replay prohibition" || true
    exit 75
  fi
  OPT_STATE=$(source_optout_state)
  if [ "$OPT_STATE" = yes ]; then
    say "owner opt-out won the post-validation race; cancelling without success publication"
    if finish_opted_out_request; then
      exit 0
    fi
    exit 75
  elif [ "$OPT_STATE" != no ]; then
    say "source opt-out authority became unknown after validation; activation deferred"
    defer_validated_activation discovery_optout_authority_unknown \
      "validated source evidence is waiting for readable source opt-out authority" || true
    exit 75
  fi
  ACTIVATED_ITEMS=$(activate_discovery_evidence \
    "$PROOF_RUN_ID" "$RECIPE_SHA" 2>>"$LOG")
  if ! [[ "${ACTIVATED_ITEMS:-}" =~ ^[1-9][0-9]*$ ]]; then
    OPT_STATE=$(source_optout_state)
    if [ "$OPT_STATE" = yes ]; then
      say "owner cancellation won the activation transaction"
      finish_opted_out_request || true
    else
      say "staged evidence activation failed; restoring prior source authority for model-free retry"
      defer_validated_activation discovery_activation_pending \
        "validated source evidence is waiting for atomic activation" || true
    fi
    exit 75
  fi
  retire_discovery_candidate 2>>"$LOG" || \
    say "activated discovery left a harmless run-scoped candidate for later cleanup"
  CACHED="$ACTIVATED_ITEMS"
  OPT_STATE=$(source_optout_state)
  if [ "$OPT_STATE" = yes ]; then
    say "owner opt-out landed immediately after activation; retiring the source"
    finish_opted_out_request || true
    exit 75
  elif [ "$OPT_STATE" != no ]; then
    say "source opt-out authority became unknown after activation; success publication deferred"
    exit 75
  fi
  say "discovery SUCCEEDED: attempt-bound recipe and receipt validated, $CACHED items cached (provider rc=$RC)"
  control_status_write sources "$SRC" completed discovery_fresh "$CACHED" "$RC" \
    "source discovery produced an attempt-bound recipe and accepted-item receipt"
  if ! publish_discovery_success_notification "$CACHED"; then
    say "success notification publication failed; terminal proof retained for model-free reconciliation"
    exit 75
  fi
  OPT_STATE=$(source_optout_state)
  if [ "$OPT_STATE" = yes ]; then
    say "owner opt-out landed during success publication; retiring the published source"
    finish_opted_out_request || true
    exit 75
  elif [ "$OPT_STATE" != no ]; then
    say "source opt-out authority became unknown after success publication; deferring ACK"
    exit 75
  fi
  if ! finish_request ack discovery_fresh \
      "attempt-bound recipe validated and $CACHED items accepted"; then
    say "request ACK publication failed; terminal proof retained for model-free reconciliation"
    exit 75
  fi
  exit 0
elif [ "$RC" -eq 0 ]; then
  say "discovery PARTIAL: provider exited cleanly but exact recipe/receipt proof failed — retrying"
  control_status_write sources "$SRC" failed discovery_partial 0 "$RC" \
    "provider completed without an attempt-bound recipe and accepted-item receipt"
  finish_request retry discovery_partial \
    "provider completed without an attempt-bound recipe and accepted-item receipt" || true
  DISC_REPORTED=1
  publish_discovery_failure_notification "$RC" || true
else
  say "discovery FAILED: provider exited rc=$RC; stale recipe/cache state was ignored"
  control_status_write sources "$SRC" failed discovery_failure 0 "$RC" \
    "provider failed before exact discovery postconditions were proven"
  finish_request retry discovery_failure \
    "provider exited rc=$RC before exact discovery postconditions were proven" || true
  DISC_REPORTED=1
  # Keep failure visibility model-free and safely encoded, just like terminal success visibility.
  publish_discovery_failure_notification "$RC" || true
fi
