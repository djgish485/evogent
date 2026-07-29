#!/usr/bin/env bash
# Create a migration backup from the canonical, versioned Evogent phone layout.
#
# Usage:
#   backup-phone.sh <adb-serial> <new-out-dir> <termux-ssh-user> <host-forward-port>
#
# This intentionally does not archive Termux home/usr, SSH configuration,
# provider login state, environment files, control tokens, release binaries,
# dependencies, logs, caches, locks, or temporary files. The current release is
# reinstalled from its host-built artifact; only selected mutable Evogent state
# is backed up. Provider/SSH authentication is a separate, explicit owner export.
set -euo pipefail
umask 077

usage() {
  echo "usage: backup-phone.sh <adb-serial> <new-out-dir> <termux-ssh-user> <host-forward-port>" >&2
  exit 64
}

[ "$#" -eq 4 ] || usage
SERIAL="$1"
OUT_ARG="$2"
TERMUX_USER="$3"
HOST_SSH_PORT="$4"
DEVICE_SSH_PORT="${PHONE_DEVICE_SSH_PORT:-8022}"
PACKAGE_NAME="net.dangish.evogent"

[ -n "$SERIAL" ] && [[ "$SERIAL" != *[[:space:]]* ]] || usage
[[ "$TERMUX_USER" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || usage
[[ "$HOST_SSH_PORT" =~ ^[0-9]+$ ]] \
  && [ "$HOST_SSH_PORT" -ge 1024 ] \
  && [ "$HOST_SSH_PORT" -le 65535 ] || usage
[[ "$DEVICE_SSH_PORT" =~ ^[0-9]+$ ]] \
  && [ "$DEVICE_SSH_PORT" -ge 1 ] \
  && [ "$DEVICE_SSH_PORT" -le 65535 ] || usage

for required in adb ssh scp python3 mktemp; do
  command -v "$required" >/dev/null 2>&1 || {
    echo "backup-phone: required host command not found: $required" >&2
    exit 69
  }
done

OUT="$(python3 - "$OUT_ARG" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1]).expanduser()
if path == pathlib.Path("/") or path.name in {"", ".", ".."}:
    raise SystemExit("backup-phone: output must name a new, bounded directory")
print(path.resolve(strict=False))
PY
)"
[ ! -e "$OUT" ] && [ ! -L "$OUT" ] || {
  echo "backup-phone: output already exists; choose a new directory" >&2
  exit 73
}
OUT_PARENT="$(dirname "$OUT")"
mkdir -p "$OUT_PARENT"
[ -d "$OUT_PARENT" ] && [ ! -L "$OUT_PARENT" ] || {
  echo "backup-phone: output parent is not a safe directory" >&2
  exit 73
}
WORK="$(mktemp -d "$OUT_PARENT/.evogent-backup.pending.XXXXXXXX")"
chmod 700 "$WORK"
KNOWN_HOSTS="$(mktemp "$OUT_PARENT/.evogent-known-hosts.XXXXXXXX")"
chmod 600 "$KNOWN_HOSTS"

REMOTE="${TERMUX_USER}@127.0.0.1"
SSH=(
  ssh -p "$HOST_SSH_PORT"
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$KNOWN_HOSTS"
  "$REMOTE"
)
SCP=(
  scp -P "$HOST_SSH_PORT"
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$KNOWN_HOSTS"
)
A() {
  adb -s "$SERIAL" "$@"
}

FORWARD_CREATED=0
REMOTE_STAGE=""
PUBLISHED=0

current_forward_target() {
  adb forward --list 2>/dev/null |
    awk -v serial="$SERIAL" -v local_port="tcp:$HOST_SSH_PORT" \
      '$1 == serial && $2 == local_port { print $3 }'
}

remove_owned_forward() {
  [ "$FORWARD_CREATED" -eq 1 ] || return 0
  local current
  current="$(current_forward_target)"
  if [ "$current" != "tcp:$DEVICE_SSH_PORT" ]; then
    echo "backup-phone: refusing to remove a forward whose identity changed" >&2
    return 1
  fi
  A forward --remove "tcp:$HOST_SSH_PORT" >/dev/null
  [ -z "$(current_forward_target)" ] || {
    echo "backup-phone: owned adb forward remained after removal" >&2
    return 1
  }
  FORWARD_CREATED=0
}

remove_remote_stage() {
  [ -n "$REMOTE_STAGE" ] || return 0
  "${SSH[@]}" bash -s -- "$REMOTE_STAGE" <<'REMOTE_CLEANUP'
set -euo pipefail
stage="$1"
[[ "$stage" =~ ^"$HOME"/[.]cache/evogent-backup[.][A-Za-z0-9]+$ ]] || {
  echo "backup-phone: unsafe remote cleanup path" >&2
  exit 65
}
[ -d "$stage" ] && [ ! -L "$stage" ] || {
  echo "backup-phone: remote staging directory is missing or unsafe" >&2
  exit 66
}
rm -rf -- "$stage"
[ ! -e "$stage" ] && [ ! -L "$stage" ]
REMOTE_CLEANUP
  REMOTE_STAGE=""
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ -n "$REMOTE_STAGE" ]; then
    remove_remote_stage >/dev/null 2>&1 || {
      echo "backup-phone: warning: remote private staging cleanup failed" >&2
      [ "$rc" -ne 0 ] || rc=74
    }
  fi
  if [ "$FORWARD_CREATED" -eq 1 ]; then
    remove_owned_forward >/dev/null 2>&1 || {
      echo "backup-phone: warning: owned adb forward cleanup failed" >&2
      [ "$rc" -ne 0 ] || rc=74
    }
  fi
  if [ "$PUBLISHED" -eq 0 ] && [ -n "${WORK:-}" ] \
      && [ -d "$WORK" ] && [ ! -L "$WORK" ]; then
    rm -rf -- "$WORK"
  fi
  rm -f -- "$KNOWN_HOSTS"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

A get-state | grep -qx device || {
  echo "backup-phone: selected Android device is unavailable" >&2
  exit 69
}

existing_forward="$(current_forward_target)"
case "$existing_forward" in
  "")
    A forward --no-rebind "tcp:$HOST_SSH_PORT" \
      "tcp:$DEVICE_SSH_PORT" >/dev/null
    FORWARD_CREATED=1
    ;;
  "tcp:$DEVICE_SSH_PORT")
    ;;
  *)
    echo "backup-phone: requested host port already has another adb forward" >&2
    exit 73
    ;;
esac

"${SSH[@]}" 'printf EVOGENT_BACKUP_SSH_READY' |
  grep -qx EVOGENT_BACKUP_SSH_READY || {
    echo "backup-phone: Termux SSH proof failed" >&2
    exit 69
  }

REMOTE_STAGE="$("${SSH[@]}" \
  'set -euo pipefail; umask 077; mkdir -p "$HOME/.cache"; chmod 700 "$HOME/.cache"; mktemp -d "$HOME/.cache/evogent-backup.XXXXXXXX"')"
[[ "$REMOTE_STAGE" =~ ^/data/data/com[.]termux/files/home/[.]cache/evogent-backup[.][A-Za-z0-9]+$ ]] || {
  echo "backup-phone: remote staging path was not canonical" >&2
  exit 65
}

echo "backup-phone: creating online database and selective state snapshots"
"${SSH[@]}" bash -s -- "$REMOTE_STAGE" <<'REMOTE_BACKUP'
set -euo pipefail
umask 077
stage="$1"
root="$HOME/.local/share/evogent"
state="$root/state"
tools="$HOME/phone-tools"
cycle_gate="$tools/.cycle.lock"
cycle_gate_held=0
backup_owner_ready=0

remote_backup_cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "$cycle_gate_held" -eq 1 ]; then
    control_lock_release "$cycle_gate" || {
      echo "backup-phone: cycle fence cleanup failed" >&2
      [ "$rc" -ne 0 ] || rc=74
    }
  fi
  if [ "$backup_owner_ready" -eq 1 ]; then
    control_finish_owner || {
      echo "backup-phone: backup owner cleanup failed" >&2
      [ "$rc" -ne 0 ] || rc=74
    }
  fi
  exit "$rc"
}
trap remote_backup_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

[[ "$stage" =~ ^"$HOME"/[.]cache/evogent-backup[.][A-Za-z0-9]+$ ]] || {
  echo "backup-phone: unsafe remote staging path" >&2
  exit 65
}
[ -d "$stage" ] && [ ! -L "$stage" ] || exit 66
[ -d "$state" ] && [ ! -L "$state" ] || {
  echo "backup-phone: canonical private state directory is unavailable" >&2
  exit 66
}
[ -L "$root/current" ] || {
  echo "backup-phone: canonical current-release pointer is unavailable" >&2
  exit 66
}
[ -r "$tools/control-plane.sh" ] || {
  echo "backup-phone: canonical control-plane helper is unavailable" >&2
  exit 66
}

. "$tools/control-plane.sh"
control_init_owner migration-backup
backup_owner_ready=1
control_reap_abandoned_owners
if ! control_lock_acquire "$cycle_gate" migration-backup; then
  echo "backup-phone: a browse/provider cycle is active; retry after it finishes" >&2
  exit 75
fi
cycle_gate_held=1

LC_ALL=C pkg list-installed > "$stage/termux-packages.txt"
[ -s "$stage/termux-packages.txt" ] || {
  echo "backup-phone: Termux package inventory is empty" >&2
  exit 70
}

python3 - "$stage" "$root" "$state" <<'PY'
import gzip
import fcntl
import hashlib
import json
import math
import os
import pathlib
import platform
import re
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import time

stage, root, state = map(pathlib.Path, os.sys.argv[1:])
home = pathlib.Path.home()
snapshot = stage / "snapshot"
snapshot.mkdir(mode=0o700)

MIGRATION_SOURCE_INTENTS = pathlib.PurePosixPath(
    "data/phone-sources/.migration-pending-source-intents.json"
)
MAX_MIGRATION_SOURCE_INTENTS = 256
MAX_MIGRATION_SOURCE_INTENTS_BYTES = 256 * 1024
MAX_SOURCE_QUEUE_TASK_BYTES = 64 * 1024
ANDROID_PACKAGE_RE = re.compile(
    r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$"
)
SOURCE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
DISCOVERY_TASK_ID_RE = re.compile(
    r"^discovery-v[1-9][0-9]{0,5}-([a-z0-9][a-z0-9-]{0,63})$"
)

def regular_owned(path: pathlib.Path, label: str) -> os.stat_result:
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_uid != os.geteuid()
        or metadata.st_nlink != 1
    ):
        raise SystemExit(f"backup-phone: unsafe {label}")
    return metadata

def read_bounded_owned(path: pathlib.Path, maximum: int, label: str) -> bytes:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise SystemExit(f"backup-phone: unsafe {label}") from error
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) & 0o077
            or metadata.st_size < 1
            or metadata.st_size > maximum
        ):
            raise SystemExit(f"backup-phone: unsafe {label}")
        chunks = []
        remaining = metadata.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 65536))
            if not chunk:
                raise SystemExit(f"backup-phone: truncated {label}")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise SystemExit(f"backup-phone: growing {label}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)

def positive_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise SystemExit(f"backup-phone: invalid {label}")
    return value

def canonical_source_intent(
    value: object,
    *,
    label: str,
    queued_task: bool,
) -> dict:
    if not isinstance(value, dict):
        raise SystemExit(f"backup-phone: {label} is not an object")
    kind = value.get("kind")
    task_id = value.get("taskId")
    package = value.get("pkg")
    created_at_ms = positive_int(value.get("createdAtMs"), f"{label} createdAtMs")
    if (
        not isinstance(task_id, str)
        or not isinstance(package, str)
        or len(package) > 253
        or ANDROID_PACKAGE_RE.fullmatch(package) is None
    ):
        raise SystemExit(f"backup-phone: invalid {label} identity")
    if queued_task and (value.get("state") != "queued" or "lease" in value):
        raise SystemExit(f"backup-phone: {label} is not an unleased queued task")
    reconciliation_only = value.get("reconciliationOnly")
    if queued_task and reconciliation_only is not None:
        if kind != "discovery" or not isinstance(reconciliation_only, bool):
            raise SystemExit(
                f"backup-phone: invalid {label} reconciliation state"
            )
        if reconciliation_only:
            raise SystemExit(
                "backup-phone: reconciliation-only source task must finish "
                "on the old phone before backup"
            )

    if kind == "discovery":
        name = value.get("name")
        source = value.get("source")
        if (
            not isinstance(name, str)
            or name != name.strip()
            or not name
            or len(name) > 120
            or not all(character.isprintable() for character in name)
            or not isinstance(source, str)
            or SOURCE_SLUG_RE.fullmatch(source) is None
            or DISCOVERY_TASK_ID_RE.fullmatch(task_id) is None
            or DISCOVERY_TASK_ID_RE.fullmatch(task_id).group(1) != source
        ):
            raise SystemExit(f"backup-phone: invalid {label} discovery intent")
        canonical = {
            "taskId": task_id,
            "kind": "discovery",
            "pkg": package,
            "name": name,
            "source": source,
            "createdAtMs": created_at_ms,
        }
    elif kind == "research":
        installed_days_ago = value.get("installedDaysAgo")
        if (
            task_id != f"research-{package}"
            or isinstance(installed_days_ago, bool)
            or not isinstance(installed_days_ago, (int, float))
            or not math.isfinite(installed_days_ago)
            or installed_days_ago < 0
        ):
            raise SystemExit(f"backup-phone: invalid {label} research intent")
        canonical = {
            "taskId": task_id,
            "kind": "research",
            "pkg": package,
            "installedDaysAgo": installed_days_ago,
            "createdAtMs": created_at_ms,
        }
    else:
        raise SystemExit(f"backup-phone: unsupported {label} kind")

    if not queued_task and set(value) != set(canonical):
        raise SystemExit(f"backup-phone: {label} has unexpected fields")
    return canonical

def decode_json_object(data: bytes, label: str) -> dict:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"backup-phone: invalid {label} JSON") from error
    if not isinstance(value, dict):
        raise SystemExit(f"backup-phone: {label} must be an object")
    return value

def collect_migration_source_intents() -> list[dict]:
    """Carry intent, never the old phone's live queue or lease authority."""
    by_task_id = {}
    existing_handoff = state.joinpath(*MIGRATION_SOURCE_INTENTS.parts)
    if os.path.lexists(existing_handoff):
        document = decode_json_object(
            read_bounded_owned(
                existing_handoff,
                MAX_MIGRATION_SOURCE_INTENTS_BYTES,
                "existing migration source-intent handoff",
            ),
            "existing migration source-intent handoff",
        )
        if (
            set(document) != {"schemaVersion", "capturedAtMs", "intents"}
            or document.get("schemaVersion") != 1
            or isinstance(document.get("schemaVersion"), bool)
            or positive_int(
                document.get("capturedAtMs"),
                "existing migration source-intent capturedAtMs",
            )
            < 1
            or not isinstance(document.get("intents"), list)
            or len(document["intents"]) > MAX_MIGRATION_SOURCE_INTENTS
        ):
            raise SystemExit(
                "backup-phone: invalid existing migration source-intent handoff"
            )
        for index, value in enumerate(document["intents"]):
            intent = canonical_source_intent(
                value,
                label=f"existing migration source intent {index}",
                queued_task=False,
            )
            if intent["taskId"] in by_task_id:
                raise SystemExit(
                    "backup-phone: duplicate existing migration source intent"
                )
            by_task_id[intent["taskId"]] = intent

    queue = state / "data" / "phone-sources" / ".queue"
    try:
        queue_metadata = queue.lstat()
    except FileNotFoundError:
        queue_metadata = None
    if queue_metadata is not None:
        if (
            queue.is_symlink()
            or not stat.S_ISDIR(queue_metadata.st_mode)
            or queue_metadata.st_uid != os.geteuid()
            or stat.S_IMODE(queue_metadata.st_mode) & 0o077
        ):
            raise SystemExit("backup-phone: unsafe source queue directory")
        lock_path = queue / ".tasks.lock"
        lock_flags = (
            os.O_RDWR
            | os.O_CREAT
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            lock_descriptor = os.open(lock_path, lock_flags, 0o600)
        except OSError as error:
            raise SystemExit("backup-phone: unsafe source queue lock") from error
        try:
            lock_metadata = os.fstat(lock_descriptor)
            if (
                not stat.S_ISREG(lock_metadata.st_mode)
                or lock_metadata.st_uid != os.geteuid()
                or lock_metadata.st_nlink != 1
                or stat.S_IMODE(lock_metadata.st_mode) & 0o077
            ):
                raise SystemExit("backup-phone: unsafe source queue lock")
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
            leased = queue / ".leased"
            try:
                leased_metadata = leased.lstat()
            except FileNotFoundError:
                leased_metadata = None
            if leased_metadata is not None:
                if (
                    leased.is_symlink()
                    or not stat.S_ISDIR(leased_metadata.st_mode)
                    or leased_metadata.st_uid != os.geteuid()
                    or stat.S_IMODE(leased_metadata.st_mode) & 0o077
                ):
                    raise SystemExit(
                        "backup-phone: unsafe leased source queue directory"
                    )
                if next(leased.iterdir(), None) is not None:
                    raise SystemExit(
                        "backup-phone: leased source intent exists; retry after "
                        "the source worker or lease recovery finishes"
                    )
            task_paths = sorted(
                entry
                for entry in queue.iterdir()
                if entry.name.endswith(".json")
            )
            if len(task_paths) > MAX_MIGRATION_SOURCE_INTENTS:
                raise SystemExit(
                    "backup-phone: too many queued source intents for migration"
                )
            for task_path in task_paths:
                request = decode_json_object(
                    read_bounded_owned(
                        task_path,
                        MAX_SOURCE_QUEUE_TASK_BYTES,
                        "queued source task",
                    ),
                    "queued source task",
                )
                intent = canonical_source_intent(
                    request,
                    label="queued source task",
                    queued_task=True,
                )
                if task_path.name != f"{intent['taskId']}.json":
                    raise SystemExit(
                        "backup-phone: queued source task filename is not its identity"
                    )
                previous = by_task_id.get(intent["taskId"])
                if previous is not None and previous != intent:
                    raise SystemExit(
                        "backup-phone: conflicting migration source intents"
                    )
                by_task_id[intent["taskId"]] = intent
        finally:
            fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
            os.close(lock_descriptor)

    if len(by_task_id) > MAX_MIGRATION_SOURCE_INTENTS:
        raise SystemExit("backup-phone: too many migration source intents")
    return sorted(
        by_task_id.values(),
        key=lambda item: (item["createdAtMs"], item["taskId"]),
    )

current = root / "current"
release = current.resolve(strict=True)
releases = (root / "releases").resolve(strict=True)
try:
    release.relative_to(releases)
except ValueError as error:
    raise SystemExit("backup-phone: current release escaped releases root") from error
release_manifest = release / "manifest.json"
regular_owned(release_manifest, "release manifest")
release_manifest_bytes = release_manifest.read_bytes()
json.loads(release_manifest_bytes)
(stage / "release-manifest.json").write_bytes(release_manifest_bytes)
os.chmod(stage / "release-manifest.json", 0o600)

database = state / "data" / "media-agent.db"
regular_owned(database, "live database")
database_backup = stage / "media-agent.db"
source = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=30)
destination = sqlite3.connect(database_backup)
try:
    source.backup(destination)
finally:
    destination.close()
    source.close()
check = sqlite3.connect(f"file:{database_backup}?mode=ro", uri=True)
try:
    rows = [row[0] for row in check.execute("PRAGMA quick_check").fetchall()]
finally:
    check.close()
if rows != ["ok"]:
    raise SystemExit(f"backup-phone: database quick_check failed: {rows!r}")
os.chmod(database_backup, 0o600)
with database_backup.open("rb") as handle:
    os.fsync(handle.fileno())

portable_source_intents = collect_migration_source_intents()
portable_source_intents_captured_at_ms = time.time_ns() // 1_000_000

allowed_roots = ("data", "phone-tools")
excluded_top_roots = (
    "backups",
    "config",
    "dependencies",
    "dependency-builds",
    "dependency-quarantine",
    "release-candidates",
)
excluded_directory_names = {
    ".cache",
    ".control",
    ".git",
    ".ssh",
    "agent-logs",
    "cache",
    "logs",
    "node_modules",
    "tmp",
}
secret_directory_names = {
    ".claude",
    ".codex",
    "auth",
    "authentication",
    "credential",
    "credentials",
    "secrets",
    "tokens",
}
secret_file_fragments = (
    "auth-token",
    "control-token",
    "cookie",
    "credential",
    "private-key",
    "secret",
)

included = []
excluded_counts = {
    "credential_or_environment": 0,
    "device_local_owner_policy": 0,
    "device_local_task_authority": 0,
    "generated_or_transient": 0,
    "live_database_separate": 0,
    "release_or_dependency_state": sum(
        os.path.lexists(state / name) for name in excluded_top_roots
    ),
    "symlink_recreated": 0,
}

def directory_exclusion(relative: pathlib.PurePath) -> str | None:
    lowered = [part.lower() for part in relative.parts]
    name = lowered[-1]
    if lowered == ["data", ".scheduler-tasks"] or lowered == [
        "data",
        "source-due-signals",
    ] or lowered == [
        "phone-tools",
        ".source-failure-backoff",
    ]:
        return "device_local_task_authority"
    if lowered in (
        ["data", "phone-sources", ".queue"],
        ["data", "phone-sources", ".candidates"],
    ):
        return "device_local_task_authority"
    if name in excluded_directory_names or name.endswith(".lock"):
        return "generated_or_transient"
    if name.startswith(".incident-"):
        return "generated_or_transient"
    if any(part in secret_directory_names for part in lowered):
        return "credential_or_environment"
    return None

def file_exclusion(relative: pathlib.PurePath) -> str | None:
    lowered = [part.lower() for part in relative.parts]
    name = lowered[-1]
    if pathlib.PurePosixPath(*relative.parts) == MIGRATION_SOURCE_INTENTS:
        return "device_local_task_authority"
    if relative.parts[0] == "phone-tools" and name in {
        ".dedicated-termux-wake",
        ".host-policy-before.json",
    }:
        return "device_local_owner_policy"
    if (
        relative.parts[0] == "phone-tools"
        and name == ".curation-control"
    ) or (
        relative.parts[0] == "phone-tools"
        and name == ".last-failed-curation-input-generation.json"
    ) or (
        relative.parts[0] == "phone-tools"
        and name == ".last-source-scout"
    ) or (
        relative.parts[0] == "data"
        and name == "phone-cycle-request.json"
    ):
        return "device_local_task_authority"
    if relative.parts[0] == "data" and name in {
        "media-agent.db",
        "media-agent.db-shm",
        "media-agent.db-wal",
    }:
        return "live_database_separate"
    if (
        name == ".env"
        or name.startswith(".env.")
        or name.endswith(".log")
        or name.endswith(".pid")
        or name.endswith(".sock")
        or name.endswith(".tmp")
        or name.endswith(".pending")
        or name.endswith(".inflight")
        or name.startswith(".overseer-output.")
        or name.startswith(".app-research-output.")
        or name.startswith(".interest-browse-output.")
    ):
        return (
            "credential_or_environment"
            if name == ".env" or name.startswith(".env.")
            else "generated_or_transient"
        )
    if any(fragment in name for fragment in secret_file_fragments):
        return "credential_or_environment"
    if any(part in secret_directory_names for part in lowered):
        return "credential_or_environment"
    return None

for top_name in allowed_roots:
    source_root = state / top_name
    if not source_root.exists():
        continue
    metadata = source_root.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or source_root.is_symlink():
        raise SystemExit(f"backup-phone: unsafe selected state root: {top_name}")
    for directory, directory_names, file_names in os.walk(
        source_root, topdown=True, followlinks=False
    ):
        directory_path = pathlib.Path(directory)
        relative_directory = directory_path.relative_to(state)
        destination_directory = snapshot / relative_directory
        destination_directory.mkdir(mode=0o700, parents=True, exist_ok=True)

        retained_directories = []
        for child_name in sorted(directory_names):
            child = directory_path / child_name
            relative = child.relative_to(state)
            child_metadata = child.lstat()
            if stat.S_ISLNK(child_metadata.st_mode):
                excluded_counts["symlink_recreated"] += 1
                continue
            reason = directory_exclusion(relative)
            if reason:
                excluded_counts[reason] += 1
                continue
            if not stat.S_ISDIR(child_metadata.st_mode):
                raise SystemExit(f"backup-phone: non-directory state entry: {relative}")
            retained_directories.append(child_name)
        directory_names[:] = retained_directories

        for file_name in sorted(file_names):
            source_path = directory_path / file_name
            relative = source_path.relative_to(state)
            metadata_before = source_path.lstat()
            if stat.S_ISLNK(metadata_before.st_mode):
                excluded_counts["symlink_recreated"] += 1
                continue
            reason = file_exclusion(relative)
            if reason:
                excluded_counts[reason] += 1
                continue
            if (
                not stat.S_ISREG(metadata_before.st_mode)
                or metadata_before.st_uid != os.geteuid()
                or metadata_before.st_nlink != 1
            ):
                raise SystemExit(f"backup-phone: unsafe selected state file: {relative}")

            destination_path = snapshot / relative
            destination_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source_flags = (
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            destination_flags = (
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            digest = hashlib.sha256()
            source_descriptor = os.open(source_path, source_flags)
            destination_descriptor = os.open(destination_path, destination_flags, 0o600)
            try:
                source_opened = os.fstat(source_descriptor)
                if (
                    source_opened.st_dev != metadata_before.st_dev
                    or source_opened.st_ino != metadata_before.st_ino
                    or not stat.S_ISREG(source_opened.st_mode)
                ):
                    raise SystemExit(f"backup-phone: state file changed before copy: {relative}")
                while True:
                    chunk = os.read(source_descriptor, 1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    view = memoryview(chunk)
                    while view:
                        written = os.write(destination_descriptor, view)
                        if written <= 0:
                            raise OSError("state snapshot write stopped")
                        view = view[written:]
                os.fsync(destination_descriptor)
                source_after = os.fstat(source_descriptor)
            finally:
                os.close(destination_descriptor)
                os.close(source_descriptor)
            metadata_after = source_path.lstat()
            stable_fields = (
                "st_dev",
                "st_ino",
                "st_size",
                "st_mtime_ns",
                "st_ctime_ns",
            )
            if any(
                getattr(metadata_before, field) != getattr(source_after, field)
                or getattr(metadata_before, field) != getattr(metadata_after, field)
                for field in stable_fields
            ):
                raise SystemExit(f"backup-phone: state file changed during copy: {relative}")
            mode = stat.S_IMODE(metadata_before.st_mode) & 0o700
            os.chmod(destination_path, mode or 0o600)
            included.append(
                {
                    "path": relative.as_posix(),
                    "sha256": digest.hexdigest(),
                    "size": metadata_before.st_size,
                    "mode": f"{mode or 0o600:04o}",
                }
            )

if portable_source_intents:
    handoff_path = snapshot.joinpath(*MIGRATION_SOURCE_INTENTS.parts)
    handoff_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    handoff_bytes = (
        json.dumps(
            {
                "schemaVersion": 1,
                "capturedAtMs": portable_source_intents_captured_at_ms,
                "intents": portable_source_intents,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")
    if len(handoff_bytes) > MAX_MIGRATION_SOURCE_INTENTS_BYTES:
        raise SystemExit("backup-phone: migration source-intent handoff is too large")
    handoff_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    handoff_descriptor = os.open(handoff_path, handoff_flags, 0o600)
    try:
        view = memoryview(handoff_bytes)
        while view:
            written = os.write(handoff_descriptor, view)
            if written <= 0:
                raise OSError("migration source-intent handoff write stopped")
            view = view[written:]
        os.fsync(handoff_descriptor)
    finally:
        os.close(handoff_descriptor)
    handoff_directory = os.open(
        handoff_path.parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(handoff_directory)
    finally:
        os.close(handoff_directory)
    included.append(
        {
            "path": MIGRATION_SOURCE_INTENTS.as_posix(),
            "sha256": hashlib.sha256(handoff_bytes).hexdigest(),
            "size": len(handoff_bytes),
            "mode": "0600",
        }
    )

inventory = {
    "schemaVersion": 1,
    "roots": list(allowed_roots),
    "included": sorted(included, key=lambda item: item["path"]),
    "excludedCounts": excluded_counts,
    "neverIncluded": [
        "Termux home or usr",
        "provider authentication",
        "SSH configuration or keys",
        "environment files",
        "control tokens",
        "release/dependency trees",
        "device-local host-policy rollback and dedicated-wake authority",
        "live scheduler/source queue files, leases, retry state, control ownership, and due signals",
        "logs, caches, locks, and temporary files",
        "symlinks (recreate from the current release)",
    ],
}
inventory_path = stage / "state-inventory.json"
inventory_path.write_text(
    json.dumps(inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
os.chmod(inventory_path, 0o600)

archive_path = stage / "evogent-state.tar.gz"
with archive_path.open("wb") as raw_archive:
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw_archive, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for path in sorted(snapshot.rglob("*"), key=lambda item: item.as_posix()):
                relative = pathlib.PurePosixPath("state") / path.relative_to(snapshot)
                archive.add(path, arcname=relative.as_posix(), recursive=False)
os.chmod(archive_path, 0o600)

expected = {
    f"state/{item['path']}": (item["sha256"], item["size"])
    for item in inventory["included"]
}
seen = {}
with tarfile.open(archive_path, mode="r:gz") as archive:
    for member in archive:
        member_path = pathlib.PurePosixPath(member.name)
        if (
            member_path.is_absolute()
            or ".." in member_path.parts
            or member.issym()
            or member.islnk()
        ):
            raise SystemExit("backup-phone: unsafe state archive member")
        if member.isfile():
            extracted = archive.extractfile(member)
            if extracted is None:
                raise SystemExit("backup-phone: unreadable state archive member")
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = extracted.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                size += len(chunk)
            seen[member.name] = (digest.hexdigest(), size)
if seen != expected:
    raise SystemExit("backup-phone: state archive inventory verification failed")

device_info = {
    "schemaVersion": 1,
    "androidBuildFingerprint": subprocess.run(
        ["getprop", "ro.build.fingerprint"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    ).stdout.strip(),
    "kernelRelease": platform.release(),
    "pythonVersion": platform.python_version(),
}
for name, command in {
    "nodeVersion": ["node", "--version"],
    "bashVersion": ["bash", "--version"],
}.items():
    result = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    device_info[name] = result.stdout.splitlines()[0].strip() if result.returncode == 0 else None
(stage / "device-info.json").write_text(
    json.dumps(device_info, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
os.chmod(stage / "device-info.json", 0o600)

if release_manifest.read_bytes() != release_manifest_bytes:
    raise SystemExit("backup-phone: current release changed during backup")

payload_names = [
    "device-info.json",
    "evogent-state.tar.gz",
    "media-agent.db",
    "release-manifest.json",
    "state-inventory.json",
    "termux-packages.txt",
]
payload_hashes = {}

def file_sha256(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

for name in payload_names:
    path = stage / name
    regular_owned(path, f"backup payload {name}")
    payload_hashes[name] = file_sha256(path)
(stage / "payload-sha256.json").write_text(
    json.dumps(
        {"schemaVersion": 1, "sha256": payload_hashes},
        indent=2,
        sort_keys=True,
    )
    + "\n",
    encoding="utf-8",
)
os.chmod(stage / "payload-sha256.json", 0o600)
PY

rm -rf -- "$stage/snapshot"
control_lock_release "$cycle_gate"
cycle_gate_held=0
control_finish_owner
backup_owner_ready=0
trap - EXIT INT TERM HUP
REMOTE_BACKUP

for name in \
    device-info.json \
    evogent-state.tar.gz \
    media-agent.db \
    payload-sha256.json \
    release-manifest.json \
    state-inventory.json \
    termux-packages.txt; do
  "${SCP[@]}" "$REMOTE:$REMOTE_STAGE/$name" "$WORK/$name"
done
chmod 600 "$WORK"/*

echo "backup-phone: capturing installed APK identity"
A shell pm path "$PACKAGE_NAME" > "$WORK/package-path.raw"
A shell dumpsys package "$PACKAGE_NAME" > "$WORK/package-dump.raw"
APK_PATH="$(python3 - "$WORK/package-path.raw" "$WORK/package-dump.raw" \
  "$WORK/android-package.json" "$PACKAGE_NAME" <<'PY'
import json
import pathlib
import re
import sys

path_file, dump_file, output_file = map(pathlib.Path, sys.argv[1:4])
package_name = sys.argv[4]
paths = [
    line.removeprefix("package:").strip()
    for line in path_file.read_text(encoding="utf-8").splitlines()
    if line.startswith("package:")
]
base_paths = [path for path in paths if path.endswith("/base.apk")]
if len(base_paths) == 1:
    apk_path = base_paths[0]
elif len(paths) == 1:
    apk_path = paths[0]
else:
    raise SystemExit("backup-phone: installed package has no unique base APK")
if not re.fullmatch(r"/[A-Za-z0-9._/+@=-]+", apk_path):
    raise SystemExit("backup-phone: installed APK path is unsafe")

dump = dump_file.read_text(encoding="utf-8", errors="strict")
version_code = re.search(r"\bversionCode=(\d+)\b", dump)
version_name = re.search(r"(?m)^\s*versionName=([^\s]+)\s*$", dump)
if version_code is None or version_name is None:
    raise SystemExit("backup-phone: installed package version could not be proven")
payload = {
    "schemaVersion": 1,
    "packageName": package_name,
    "versionCode": int(version_code.group(1)),
    "versionName": version_name.group(1),
}
output_file.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
print(apk_path)
PY
)"
rm -f -- "$WORK/package-path.raw" "$WORK/package-dump.raw"
A pull "$APK_PATH" "$WORK/evogent-shell.apk" >/dev/null
chmod 600 "$WORK/evogent-shell.apk" "$WORK/android-package.json"

DEVICE_APK_SHA256="$(A shell sha256sum "$APK_PATH" |
  awk 'NR == 1 { gsub(/\r/, "", $1); print $1 }')"
[[ "$DEVICE_APK_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "backup-phone: device APK digest could not be proven" >&2
  exit 70
}

echo "backup-phone: verifying every copied component"
python3 - "$WORK" "$DEVICE_APK_SHA256" "$PACKAGE_NAME" <<'PY'
import hashlib
import json
import os
import pathlib
import sqlite3
import tarfile
import sys

root = pathlib.Path(sys.argv[1])
device_apk_sha256 = sys.argv[2]
package_name = sys.argv[3]

def digest(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

remote_hashes = json.loads(
    (root / "payload-sha256.json").read_text(encoding="utf-8")
)
if remote_hashes.get("schemaVersion") != 1:
    raise SystemExit("backup-phone: unknown remote payload-hash schema")
expected_remote_names = {
    "device-info.json",
    "evogent-state.tar.gz",
    "media-agent.db",
    "release-manifest.json",
    "state-inventory.json",
    "termux-packages.txt",
}
remote_digest_map = remote_hashes.get("sha256")
if (
    not isinstance(remote_digest_map, dict)
    or set(remote_digest_map) != expected_remote_names
):
    raise SystemExit("backup-phone: remote payload-hash inventory is incomplete")
for name, expected in remote_digest_map.items():
    path = root / name
    if (
        pathlib.PurePath(name).name != name
        or not path.is_file()
        or path.is_symlink()
        or digest(path) != expected
    ):
        raise SystemExit(f"backup-phone: remote payload verification failed: {name}")

database = sqlite3.connect(
    f"file:{root / 'media-agent.db'}?mode=ro", uri=True
)
try:
    rows = [row[0] for row in database.execute("PRAGMA quick_check").fetchall()]
finally:
    database.close()
if rows != ["ok"]:
    raise SystemExit(f"backup-phone: host database quick_check failed: {rows!r}")

inventory = json.loads((root / "state-inventory.json").read_text(encoding="utf-8"))
expected_members = {
    f"state/{item['path']}": (item["sha256"], item["size"])
    for item in inventory["included"]
}
seen_members = {}
with tarfile.open(root / "evogent-state.tar.gz", mode="r:gz") as archive:
    for member in archive:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
            raise SystemExit("backup-phone: unsafe host state archive member")
        if member.isfile():
            extracted = archive.extractfile(member)
            if extracted is None:
                raise SystemExit("backup-phone: unreadable host state archive member")
            digest_value = hashlib.sha256()
            size = 0
            while True:
                chunk = extracted.read(1024 * 1024)
                if not chunk:
                    break
                digest_value.update(chunk)
                size += len(chunk)
            seen_members[member.name] = (
                digest_value.hexdigest(),
                size,
            )
if seen_members != expected_members:
    raise SystemExit("backup-phone: host state archive inventory mismatch")

package = json.loads((root / "android-package.json").read_text(encoding="utf-8"))
release = json.loads((root / "release-manifest.json").read_text(encoding="utf-8"))
android = release.get("android", {})
apk_sha256 = digest(root / "evogent-shell.apk")
if (
    package.get("packageName") != package_name
    or android.get("package") != package_name
    or package.get("versionCode") != android.get("versionCode")
    or package.get("versionName") != android.get("versionName")
    or apk_sha256 != device_apk_sha256
    or apk_sha256 != android.get("sha256")
):
    raise SystemExit("backup-phone: installed APK and current release do not agree")

manifest = {
    "schemaVersion": 1,
    "kind": "evogent-private-phone-migration-backup",
    "capturedAtUnixSeconds": int(__import__("time").time()),
    "android": package,
    "release": {
        "releaseId": release.get("releaseId"),
        "sourceCommit": release.get("sourceCommit"),
    },
    "contents": [
        "online SQLite backup",
        "selected mutable state under canonical state/data and state/phone-tools",
        "bounded validated unleased source-intent handoff when queued work exists",
        "Termux package and runtime-version inventory",
        "current release manifest",
        "exact installed shell APK and package/version inventory",
    ],
    "excludedByDesign": [
        "whole Termux home and usr",
        "provider authentication",
        "SSH configuration and keys",
        "environment files and source-provider cookies",
        "Evogent control tokens",
        "release/dependency trees",
        "device-local host-policy rollback and dedicated-wake authority",
        "live scheduler/source queue files, leases, retry state, control ownership, and due signals",
        "logs, caches, locks, temporary files, and generated symlinks",
    ],
}
(root / "backup-manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)

hashed_files = sorted(
    path
    for path in root.iterdir()
    if path.is_file() and not path.is_symlink() and path.name != "SHA256SUMS"
)
with (root / "SHA256SUMS").open("w", encoding="utf-8") as output:
    for path in hashed_files:
        output.write(f"{digest(path)}  {path.name}\n")

for raw_line in (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
    expected, separator, name = raw_line.partition("  ")
    path = root / name
    if (
        separator != "  "
        or len(expected) != 64
        or pathlib.PurePath(name).name != name
        or not path.is_file()
        or path.is_symlink()
        or digest(path) != expected
    ):
        raise SystemExit("backup-phone: final SHA256SUMS verification failed")

for path in root.iterdir():
    if not path.is_file() or path.is_symlink():
        raise SystemExit("backup-phone: final output contains an unsafe entry")
    os.chmod(path, 0o600)
    with path.open("rb") as handle:
        os.fsync(handle.fileno())
directory = os.open(
    root,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY

# Private staging and our own forward must be gone before a result can be
# published or described as complete.
remove_remote_stage
remove_owned_forward

python3 - "$WORK" "$OUT" "$OUT_PARENT" <<'PY'
import os
import pathlib
import stat
import sys

source, destination, parent = map(pathlib.Path, sys.argv[1:])
if not source.is_dir() or source.is_symlink():
    raise SystemExit("backup-phone: verified staging directory became unsafe")
if os.path.lexists(destination):
    raise SystemExit("backup-phone: output appeared before publication")
source_metadata = source.stat()
renamed = False
try:
    os.rename(source, destination)
    renamed = True
    destination_metadata = destination.stat()
    if (
        not destination.is_dir()
        or destination.is_symlink()
        or source.exists()
        or destination_metadata.st_dev != source_metadata.st_dev
        or destination_metadata.st_ino != source_metadata.st_ino
    ):
        raise OSError("backup-phone: atomic output publication was not proven")
    for directory_path in (destination, parent):
        descriptor = os.open(
            directory_path,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
except BaseException:
    if renamed and os.path.lexists(destination) and not os.path.lexists(source):
        try:
            destination_metadata = destination.lstat()
            if stat.S_ISDIR(destination_metadata.st_mode) and (
                destination_metadata.st_dev == source_metadata.st_dev
                and destination_metadata.st_ino == source_metadata.st_ino
            ):
                os.rename(destination, source)
                try:
                    descriptor = os.open(
                        parent,
                        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
                    )
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                except OSError:
                    # The exact directory is back at the private staging path;
                    # shell cleanup owns and removes it even if directory-fsync
                    # support or storage durability failed.
                    pass
        except OSError:
            pass
    raise
PY
WORK=""
PUBLISHED=1
echo "backup-phone: verified backup complete -> $OUT"
