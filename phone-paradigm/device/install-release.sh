#!/data/data/com.termux/files/usr/bin/bash
# Transactionally install one host-built Evogent phone release.
#
# Usage:
#   install-release.sh <evogent-phone-*.tar.gz> <archive-sha256>
#   install-release.sh --recover <transaction-journal>
#
# One atomic `current` link selects both the web runtime and phone mechanics.
# Private data, Android-built node_modules, and phone control state live outside
# releases and survive every switch.
set -euo pipefail
umask 077
unset PYTHONOPTIMIZE PYTHONPATH PYTHONHOME PYTHONUSERBASE

DEFAULT_RELEASE_ROOT="$HOME/.local/share/evogent"
ROOT="${EVOGENT_RELEASE_ROOT:-$DEFAULT_RELEASE_ROOT}"
# Android's BootReceiver must be able to rediscover the durable journal without
# inheriting a shell environment. Alternate production roots are therefore not
# a supported topology; the namespace helper accepts arbitrary roots only when
# it is extracted into isolated host tests.
[ "$ROOT" = "$DEFAULT_RELEASE_ROOT" ] || {
  echo "release install: alternate release roots are not reboot-safe" >&2
  exit 65
}

usage() {
  echo "usage: install-release.sh [--forward-supersede] <release-archive> <archive-sha256> | --recover <transaction-journal>" >&2
  exit 65
}

FORWARD_SUPERSEDE=0
if [ "${1:-}" = "--forward-supersede" ]; then
  FORWARD_SUPERSEDE=1
  shift
fi

RECOVERY_JOURNAL_ARG=""
if [ "${1:-}" = "--recover" ]; then
  [ "$FORWARD_SUPERSEDE" = 0 ] && [ "$#" = 2 ] || usage
  RECOVERY_JOURNAL_ARG="$2"
  ARCHIVE=""
  EXPECTED_ARCHIVE_SHA256=""
else
  [ "$#" = 2 ] && [[ "$1" != -* ]] || usage
  ARCHIVE="$1"
  EXPECTED_ARCHIVE_SHA256="$2"
  [[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "release install: expected archive SHA-256 is invalid" >&2
    exit 65
  }
  [ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || {
    echo "release install: archive not found" >&2
    exit 66
  }
  chmod 600 "$ARCHIVE"
  [ "$(stat -c '%a' "$ARCHIVE")" = 600 ] || {
    echo "release install: archive containing TLS key is not mode 0600" >&2
    exit 66
  }
fi

RELEASES="$ROOT/releases"
STATE="$ROOT/state"
DEPENDENCIES="$STATE/dependencies"
DEPENDENCY_BUILDS="$STATE/dependency-builds"
DEPENDENCY_QUARANTINE="$STATE/dependency-quarantine"
RELEASE_CANDIDATES="$STATE/release-candidates"
PHONE_STATE="$STATE/phone-tools"
CURRENT="$ROOT/current"
STAGING_ROOT="$ROOT/staging"
BACKUPS="$ROOT/backups"
MIGRATIONS="$ROOT/migrations"
LOGS="$ROOT/logs"
INSTALL_LOCK="$ROOT/install.lock"
CONTROL_MUTATION_GATE="$ROOT/control-plane-mutation.lock"
TRANSACTION_DIR="$ROOT/install-transaction"
TRANSACTION_JOURNAL="$TRANSACTION_DIR/journal.json"
TRANSACTION_RECOVERER="$TRANSACTION_DIR/install-release.sh"
PACKAGE_NAME="net.dangish.evogent"
ANDROID_HOME_ROLE="android.app.role.HOME"
ANDROID_ASSISTANT_ROLE="android.app.role.ASSISTANT"
APP_CONTROL_TOKEN_PATH="/sdcard/Android/data/$PACKAGE_NAME/files/control-token.txt"
PHONE_PORT="${PORT:-3001}"
PHONE_HTTPS_PORT=3443
HEALTH_URL="${EVOGENT_PHONE_HEALTH_URL:-http://127.0.0.1:${PHONE_PORT}/api/internal/phone-health}"
FEED_URL="${EVOGENT_PHONE_FEED_URL:-http://127.0.0.1:${PHONE_PORT}/api/feed?limit=1}"
DEPLOYMENT_URL="${EVOGENT_PHONE_DEPLOYMENT_URL:-http://127.0.0.1:${PHONE_PORT}/api/internal/deployment-status}"
INSTALL_WAIT_SECONDS="${EVOGENT_INSTALL_WAIT_SECONDS:-21600}"
INSTALL_USER_ACTION_WAIT_SECONDS="${EVOGENT_INSTALL_USER_ACTION_WAIT_SECONDS:-900}"
KEEP_RELEASES="${EVOGENT_KEEP_RELEASES:-5}"
KEEP_BACKUPS="${EVOGENT_KEEP_BACKUPS:-7}"
KEEP_LOGS="${EVOGENT_KEEP_INSTALL_LOGS:-20}"
for numeric in "$INSTALL_WAIT_SECONDS" "$KEEP_RELEASES" "$KEEP_BACKUPS" "$KEEP_LOGS"; do
  [[ "$numeric" =~ ^[0-9]+$ ]] || {
    echo "release install: numeric configuration is invalid" >&2
    exit 65
  }
done
[[ "$INSTALL_USER_ACTION_WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  && [ "$INSTALL_USER_ACTION_WAIT_SECONDS" -le 3600 ] || {
  echo "release install: foreground action wait must be 1..3600 seconds" >&2
  exit 65
}

prepare_private_release_directories() {
  python3 - "$HOME" "$ROOT" "$RELEASES" "$STATE" "$DEPENDENCIES" \
    "$DEPENDENCY_BUILDS" "$DEPENDENCY_QUARANTINE" "$RELEASE_CANDIDATES" \
    "$STAGING_ROOT" "$BACKUPS" "$MIGRATIONS" "$LOGS" \
    "$TRANSACTION_DIR" <<'PY'
import os
import pathlib
import stat
import sys

def normalized_absolute(raw, label):
    if (
        not os.path.isabs(raw)
        or raw.startswith("//")
        or os.path.normpath(raw) != raw
    ):
        raise SystemExit(f"{label} is not an exact absolute path")
    return pathlib.Path(raw)

home = normalized_absolute(sys.argv[1], "HOME")
root = normalized_absolute(sys.argv[2], "private release root")
if home == pathlib.Path("/") or root == pathlib.Path("/"):
    raise SystemExit("private release paths cannot be the filesystem root")
raw_directories = [
    normalized_absolute(raw, "private release directory")
    for raw in sys.argv[3:]
]
directories = {root, *raw_directories}
for directory in directories:
    try:
        directory.relative_to(root)
    except ValueError:
        raise SystemExit("private release directory escapes its root")

if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
    raise SystemExit("platform lacks no-follow directory traversal")
walk_flags = (
    getattr(os, "O_PATH", os.O_RDONLY)
    | os.O_DIRECTORY
    | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0)
)
sync_flags = (
    os.O_RDONLY
    | os.O_DIRECTORY
    | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0)
)

def same_inode(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)

def sync_walked_directory(descriptor, *, mode=None):
    sync_descriptor = os.open(".", sync_flags, dir_fd=descriptor)
    try:
        walked = os.fstat(descriptor)
        opened = os.fstat(sync_descriptor)
        if not same_inode(walked, opened) or not stat.S_ISDIR(opened.st_mode):
            raise SystemExit("private release directory identity changed")
        if mode is not None:
            os.fchmod(sync_descriptor, mode)
        os.fsync(sync_descriptor)
    finally:
        os.close(sync_descriptor)

def walk_directory(path, *, create):
    descriptor = os.open("/", walk_flags)
    if path == pathlib.Path("/"):
        return descriptor
    try:
        for component in path.parts[1:]:
            created = False
            try:
                child = os.open(component, walk_flags, dir_fd=descriptor)
            except FileNotFoundError:
                if not create:
                    os.close(descriptor)
                    return None
                os.mkdir(component, 0o700, dir_fd=descriptor)
                created = True
                child = os.open(component, walk_flags, dir_fd=descriptor)
            metadata = os.fstat(child)
            named = os.stat(
                component,
                dir_fd=descriptor,
                follow_symlinks=False,
            )
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or not stat.S_ISDIR(named.st_mode)
                or not same_inode(metadata, named)
            ):
                os.close(child)
                raise SystemExit(f"unsafe private release directory: {path}")
            if created:
                if metadata.st_uid != os.geteuid():
                    os.close(child)
                    raise SystemExit("created private directory has the wrong owner")
                sync_walked_directory(child, mode=0o700)
                sync_walked_directory(descriptor)
                rebound = os.stat(
                    component,
                    dir_fd=descriptor,
                    follow_symlinks=False,
                )
                if not same_inode(metadata, rebound):
                    os.close(child)
                    raise SystemExit("created private directory name changed")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise

try:
    relative_root = root.relative_to(home)
except ValueError:
    owned_directories = {root.parent, root, *raw_directories}
else:
    cursor = home
    owned_directories = {cursor, *raw_directories}
    for part in relative_root.parts:
        cursor /= part
        owned_directories.add(cursor)

# Inspect every existing component before mutating any namespace. The second
# no-follow walk closes races while creating one level at a time.
home_descriptor = walk_directory(home, create=False)
if home_descriptor is None:
    raise SystemExit("HOME is unavailable")
try:
    if os.fstat(home_descriptor).st_uid != os.geteuid():
        raise SystemExit("HOME has the wrong owner")
finally:
    os.close(home_descriptor)

for directory in sorted(
    {home, *directories, *owned_directories},
    key=lambda item: len(item.parts),
):
    descriptor = walk_directory(directory, create=False)
    if descriptor is None:
        continue
    try:
        if (
            directory in owned_directories
            and os.fstat(descriptor).st_uid != os.geteuid()
        ):
            raise SystemExit(f"unsafe private release directory: {directory}")
    finally:
        os.close(descriptor)

for directory in sorted(directories, key=lambda item: len(item.parts)):
    descriptor = walk_directory(directory, create=True)
    try:
        sync_walked_directory(descriptor)
    finally:
        os.close(descriptor)

root_anchor = walk_directory(root, create=False)
if root_anchor is None:
    raise SystemExit("private release root is missing")
root_identity = os.fstat(root_anchor)

for directory in sorted(owned_directories, key=lambda item: len(item.parts)):
    descriptor = walk_directory(directory, create=False)
    if descriptor is None:
        raise SystemExit(f"private release directory is missing: {directory}")
    try:
        if os.fstat(descriptor).st_uid != os.geteuid():
            raise SystemExit(f"unsafe private release directory: {directory}")
        sync_walked_directory(descriptor)
    finally:
        os.close(descriptor)

transaction = raw_directories[-1]
descriptor = walk_directory(transaction, create=False)
if descriptor is None:
    raise SystemExit("private transaction directory is missing")
try:
    sync_walked_directory(descriptor, mode=0o700)
finally:
    os.close(descriptor)

reopened_root = walk_directory(root, create=False)
if reopened_root is None:
    os.close(root_anchor)
    raise SystemExit("private release root disappeared")
try:
    if not same_inode(root_identity, os.fstat(reopened_root)):
        raise SystemExit("private release root identity changed")
finally:
    os.close(reopened_root)
    os.close(root_anchor)
PY
}
prepare_private_release_directories

prepare_versioned_state_directories() {
  python3 - "$STATE" "$1" <<'PY'
import os
import re
import stat
import sys

state, release_id = sys.argv[1:]
if re.fullmatch(r"[A-Za-z0-9._-]{1,120}", release_id) is None:
    raise SystemExit("invalid release identity for state preparation")
flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
state_descriptor = os.open(state, flags)
opened = [state_descriptor]

def ensure(parent, name):
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent)
    except FileExistsError:
        pass
    else:
        os.fsync(parent)
    descriptor = os.open(name, flags, dir_fd=parent)
    metadata = os.fstat(descriptor)
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid():
        os.close(descriptor)
        raise SystemExit("versioned state component is unsafe")
    opened.append(descriptor)
    return descriptor

try:
    ensure(state_descriptor, "data")
    ensure(state_descriptor, "config")
    next_cache = ensure(state_descriptor, "next-cache")
    ensure(next_cache, release_id)
    ensure(state_descriptor, "phone-tools")
    for descriptor in reversed(opened):
        os.fsync(descriptor)
finally:
    for descriptor in reversed(opened):
        os.close(descriptor)
PY
}

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
LOG="$LOGS/install-$STAMP-$$.log"
exec > >(tee -a "$LOG") 2>&1

say() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

evo_curl() {
  local client candidate
  for candidate in \
    "${NEW_RELEASE:-}/phone-tools/evo-curl" \
    "$HOME/phone-tools/evo-curl"; do
    if [ -x "$candidate" ]; then
      client="$candidate"
      break
    fi
  done
  [ -n "${client:-}" ] || {
    say "authenticated Evogent HTTP client is unavailable"
    return 127
  }
  EVOGENT_PHONE_TOOLS="$(dirname "$client")" "$client" "$@"
}

loopback_port_open() {
  local probe_port="${1:-$PHONE_PORT}"
  python3 - "$probe_port" <<'PY' >/dev/null 2>&1
import socket
import sys
with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=1):
    pass
PY
}

phone_ports_open() {
  loopback_port_open "$PHONE_PORT" || loopback_port_open "$PHONE_HTTPS_PORT"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

manifest_value() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1], encoding="utf-8"))
for part in sys.argv[2].split("."):
    value = value[part]
if isinstance(value, bool) or isinstance(value, (dict, list)) or value is None:
    raise SystemExit("manifest field is not a scalar")
print(value)
PY
}

fsync_regular_file_and_parent() {
  python3 - "$1" <<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
descriptor = os.open(
    path,
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0),
)
try:
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        raise SystemExit("durability target is not a regular file")
    os.fsync(descriptor)
finally:
    os.close(descriptor)
directory = os.open(
    path.parent,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

fsync_directory() {
  python3 - "$1" <<'PY'
import os
import pathlib
import stat
import sys

directory = os.open(
    pathlib.Path(sys.argv[1]),
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

fsync_tree() {
  python3 - "$1" <<'PY'
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
if os.environ.get("EVOGENT_TASK_OWNER"):
    raise SystemExit("installer inherited a control-worker owner token")
root_stat = os.lstat(root)
if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
    raise SystemExit("durability tree is not a real directory")
directories = []
for base, names, files in os.walk(root, topdown=True, followlinks=False):
    directory = pathlib.Path(base)
    directories.append(directory)
    for name in files:
        path = directory / name
        entry = os.lstat(path)
        if stat.S_ISLNK(entry.st_mode):
            continue
        if not stat.S_ISREG(entry.st_mode):
            raise SystemExit("durability tree contains an unsupported entry")
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
for directory in reversed(directories):
    descriptor = os.open(
        directory,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

rename_no_copy() {
  python3 - "$1" "$2" <<'PY'
import ctypes
import errno
import os
import pathlib
import sys

source, destination = map(pathlib.Path, sys.argv[1:])
os.lstat(source)
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
        os.fsencode(source),
        -100,
        os.fsencode(destination),
        1,
    )
    if result != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOTEMPTY}:
            raise SystemExit("rename destination already exists")
        raise OSError(error, os.strerror(error), str(destination))
else:
    # Production is Linux/Android; retain no-clobber behavior for host tests.
    if os.path.lexists(destination):
        raise SystemExit("rename destination already exists")
    try:
        os.rename(source, destination)
    except FileExistsError:
        raise SystemExit("rename destination already exists")
PY
}

proc_start() {
  local pid="${1:-}" stat
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ -r "/proc/$pid/stat" ] || return 1
  stat=$(<"/proc/$pid/stat") || return 1
  printf '%s\n' "${stat##*) }" | awk '{print $20}'
}

pid_matches() {
  local pid="${1:-}" expected="${2:-}" actual
  [ -n "$expected" ] || return 1
  actual="$(proc_start "$pid" 2>/dev/null)" || return 1
  [ "$actual" = "$expected" ]
}

meta_field() {
  sed -n "s/^${2}=//p" "$1" 2>/dev/null | head -1
}

lock_live() {
  local lock="$1" pid start
  [ -d "$lock" ] || return 1
  if [ -f "$lock/owner" ]; then
    pid="$(meta_field "$lock/owner" pid)"
    start="$(meta_field "$lock/owner" start)"
    pid_matches "$pid" "$start"
    return
  fi
  # Legacy cycle locks had no owner metadata. They are always treated as live:
  # age alone is never grounds to kill work. An interrupted install-lock mkdir
  # window is reclaimable only after it is no longer recent.
  case "$lock" in
    *.cycle.lock) return 0 ;;
  esac
  [ -n "$(find "$lock" -maxdepth 0 -mmin -2 2>/dev/null)" ]
}

publish_prepared_lock_dir() {
  python3 - "$1" "$2" <<'PY'
import ctypes
import errno
import os
import pathlib
import sys

source, destination = map(pathlib.Path, sys.argv[1:])
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
        os.fsencode(source),
        -100,
        os.fsencode(destination),
        1,
    )
    if result != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOTEMPTY}:
            raise SystemExit(75)
        raise OSError(error, os.strerror(error), str(destination))
else:
    # The production target is Linux/Android. This fallback keeps host-side
    # recovery tests useful without silently replacing an observed lock.
    if os.path.lexists(destination):
        raise SystemExit(75)
    try:
        os.rename(source, destination)
    except FileExistsError:
        raise SystemExit(75)
PY
}

reap_dead_lock_dir() {
  python3 - "$1" "$2" <<'PY'
import ctypes
import errno
import fcntl
import os
import pathlib
import re
import sys
import time

lock, quarantine = map(pathlib.Path, sys.argv[1:])
flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
try:
    descriptor = os.open(lock, flags)
except FileNotFoundError:
    raise SystemExit(75)
try:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(75)
    observed = os.fstat(descriptor)
    current = os.lstat(lock)
    if (
        current.st_dev != observed.st_dev
        or current.st_ino != observed.st_ino
        or not os.path.samestat(current, observed)
    ):
        raise SystemExit(75)

    owner = {}
    try:
        owner_descriptor = os.open(
            "owner",
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=descriptor,
        )
    except FileNotFoundError:
        owner_descriptor = None
    if owner_descriptor is not None:
        try:
            metadata = os.fstat(owner_descriptor)
            if metadata.st_size > 4096:
                raise SystemExit(75)
            payload = os.read(owner_descriptor, 4097).decode("utf-8", "strict")
        finally:
            os.close(owner_descriptor)
        for line in payload.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                owner[key] = value
        pid = owner.get("pid", "")
        start = owner.get("start", "")
        if not re.fullmatch(r"[1-9][0-9]*", pid or ""):
            raise SystemExit(75)
        if not re.fullmatch(r"[0-9]+", start or ""):
            raise SystemExit(75)
        try:
            process_stat = pathlib.Path(f"/proc/{pid}/stat").read_text()
        except (FileNotFoundError, ProcessLookupError):
            process_stat = ""
        if process_stat:
            fields = process_stat.rsplit(") ", 1)
            if len(fields) == 2 and len(fields[1].split()) >= 20:
                if fields[1].split()[19] == start:
                    raise SystemExit(75)
    else:
        # Ownerless legacy cycle locks are deliberate indefinite leases. A
        # recent ownerless install lock may be the mkdir window of old code.
        if lock.name.endswith(".cycle.lock") or time.time() - observed.st_mtime < 120:
            raise SystemExit(75)

    current = os.lstat(lock)
    if current.st_dev != observed.st_dev or current.st_ino != observed.st_ino:
        raise SystemExit(75)
    if os.path.lexists(quarantine):
        raise SystemExit("stale-lock quarantine already exists")
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
            os.fsencode(lock),
            -100,
            os.fsencode(quarantine),
            1,
        )
        if result != 0:
            error = ctypes.get_errno()
            if error in {errno.ENOENT, errno.EEXIST, errno.ENOTEMPTY}:
                raise SystemExit(75)
            raise OSError(error, os.strerror(error), str(quarantine))
    else:
        os.rename(lock, quarantine)
finally:
    os.close(descriptor)
PY
}

acquire_lock_dir() {
  local lock="$1" label="$2" deadline=$(( $(date +%s) + INSTALL_WAIT_SECONDS ))
  local candidate stale self_start publish_status reap_status
  self_start="$(proc_start "$$")"
  stale="$lock.stale.$$.${self_start:-unknown}"
  candidate="$(mktemp -d "${lock}.pending.XXXXXXXX")" || return 1
  {
    printf 'owner=release-install-%s-%s\n' "$$" "$self_start"
    printf 'pid=%s\n' "$$"
    printf 'start=%s\n' "$self_start"
    printf 'label=%s\n' "$label"
    printf 'acquired=%s\n' "$(date +%s)"
  } > "$candidate/owner" || {
    rm -rf -- "$candidate"
    return 1
  }
  fsync_regular_file_and_parent "$candidate/owner" || {
    rm -rf -- "$candidate"
    return 1
  }
  while :; do
    publish_status=0
    publish_prepared_lock_dir "$candidate" "$lock" || publish_status=$?
    if [ "$publish_status" = 0 ]; then
      fsync_directory "$(dirname "$lock")" || return 1
      return 0
    fi
    [ "$publish_status" = 75 ] || {
      rm -rf -- "$candidate"
      return 1
    }
    if ! lock_live "$lock"; then
      reap_status=0
      reap_dead_lock_dir "$lock" "$stale" || reap_status=$?
      if [ "$reap_status" = 0 ]; then
        fsync_directory "$(dirname "$lock")" || {
          rm -rf -- "$candidate"
          return 1
        }
        rm -rf -- "$stale"
        fsync_directory "$(dirname "$lock")" || {
          rm -rf -- "$candidate"
          return 1
        }
        continue
      fi
      [ "$reap_status" = 75 ] || {
        rm -rf -- "$candidate"
        return 1
      }
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      say "timed out waiting for $label"
      rm -rf -- "$candidate"
      fsync_directory "$(dirname "$lock")" || true
      return 1
    fi
    sleep 2
  done
}

retire_owned_lock_dir() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import ctypes
import errno
import os
import pathlib
import stat
import sys

lock, quarantine = map(pathlib.Path, sys.argv[1:3])
expected_pid, expected_start = sys.argv[3:]
descriptor = os.open(
    lock,
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0),
)
try:
    observed = os.fstat(descriptor)
    owner_descriptor = os.open(
        "owner",
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=descriptor,
    )
    try:
        owner_stat = os.fstat(owner_descriptor)
        if (
            not stat.S_ISREG(owner_stat.st_mode)
            or owner_stat.st_uid != os.getuid()
            or owner_stat.st_size > 4096
        ):
            raise SystemExit("lock owner metadata is unsafe")
        payload = os.read(owner_descriptor, 4097).decode("utf-8", "strict")
    finally:
        os.close(owner_descriptor)
    values = {}
    for line in payload.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    if values.get("pid") != expected_pid or values.get("start") != expected_start:
        raise SystemExit("lock ownership changed before retirement")
    current = os.lstat(lock)
    if current.st_dev != observed.st_dev or current.st_ino != observed.st_ino:
        raise SystemExit("lock directory changed before retirement")
    if os.path.lexists(quarantine):
        raise SystemExit("lock retirement quarantine already exists")
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
            os.fsencode(lock),
            -100,
            os.fsencode(quarantine),
            1,
        )
        if result != 0:
            error = ctypes.get_errno()
            if error in {errno.ENOENT, errno.EEXIST, errno.ENOTEMPTY}:
                raise SystemExit("lock retirement raced another owner")
            raise OSError(error, os.strerror(error), str(quarantine))
    else:
        os.rename(lock, quarantine)
    parent = os.open(
        lock.parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
finally:
    os.close(descriptor)
PY
}

release_lock_dir() {
  local lock="$1" pid start quarantine
  [ -d "$lock" ] || return 0
  pid="$(meta_field "$lock/owner" pid)"
  start="$(meta_field "$lock/owner" start)"
  [ "$pid" = "$$" ] && pid_matches "$pid" "$start" || return 1
  quarantine="$lock.released.$$.${start}"
  retire_owned_lock_dir "$lock" "$quarantine" "$pid" "$start" || return 1
  rm -rf -- "$quarantine" || return 1
  fsync_directory "$(dirname "$lock")"
}

INSTALL_LOCK_HELD=0
CONTROL_MUTATION_GATE_HELD=0
CYCLE_GATE=""
CYCLE_GATE_HELD=0
STAGE=""
RELEASE_ID=""
NEW_RELEASE=""
PREVIOUS_TARGET=""
BACKUP_DIR=""
DB_BACKUP=""
DB_BACKUP_READY=0
DB_EXISTED=0
APK_BACKUP=""
APK_BACKUP_READY=0
APK_CHANGED=0
APK_INSTALL_ATTEMPTED=0
PACKAGE_OPERATION=""
APK_USER_ACTION_KIND=""
APK_USER_ACTION_PURPOSE=""
APK_USER_ACTION_EVIDENCE=""
APK_USER_ACTION_TARGET_SHA256=""
APK_USER_ACTION_TARGET_VERSION_CODE=""
APK_USER_ACTION_TARGET_SIGNER_SHA256=""
PREVIOUS_APK_CODE=""
PREVIOUS_APK_SIGNER=""
ROLLBACK_FAILED=0
ROLLBACK_ATTEMPTED=0
REARM_PRIOR_CONTROL_PLANE=0
ROLLBACK_DECISION_DURABLE=0
RESTORED_LEGACY_CONTROL_PLANE=0
LEGACY_RUNTIME_EXPECTED=0
LEGACY_CONTROL_PLANE_EXPECTED=0
LEGACY_EXPECTATION_COMPAT=0
LEGACY_RECOVERY_LAUNCH_ID=""
LEGACY_SNAPSHOT_READY=0
LEGACY_PLAN_SHA256=""
SWITCH_STARTED=0
QUIESCED=0
CONTROL_PLANE_MUTATION_STARTED=0
RUNTIME_PROVEN_STOPPED=0
INITIAL_MIGRATION=0
MIGRATION_STARTED=0
MIGRATION_DIR=""
SUCCESS=0
RECOVERY_ACTIVE=0
CONTROL_TOKEN="$STATE/data/control-token.txt"
CONTROL_TOKEN_BACKUP=""
CONTROL_TOKEN_EXISTED=0
CONTROL_TOKEN_BACKUP_READY=0
CONTROL_TOKEN_BRIDGE=""
ANDROID_ROLE_BACKUP=""
ANDROID_ROLE_BACKUP_READY=0
ANDROID_ROLE_BACKUP_SHA256=""
ANDROID_ROLE_USER_ID=""
ANDROID_ROLE_RESTORE_REQUIRED=0
ANDROID_ROLE_MUTATION_ATTEMPTED=0
ANDROID_ROLES_APPLIED=0
TRANSACTION_PHASE=""
TRANSACTION_JOURNAL_WRITTEN=0
COMMITTED=0
DEPENDENCY_BUILD=""
DEPENDENCY_STATE_HELPER=""
ROLLBACK_STATE_HELPER=""
ANDROID_ROLE_STATE_HELPER=""

stop_tmux_session() {
  local name="$1"
  tmux has-session -t "=$name" 2>/dev/null || return 0
  tmux kill-session -t "=$name" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    tmux has-session -t "=$name" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

stop_and_prove_runtime() {
  local stable=0
  RUNTIME_PROVEN_STOPPED=0
  stop_tmux_session evo || return 1
  for _ in $(seq 1 20); do
    if phone_ports_open; then
      stable=0
    else
      stable=$((stable + 1))
      if [ "$stable" -ge 3 ]; then
        RUNTIME_PROVEN_STOPPED=1
        return 0
      fi
    fi
    sleep 1
  done
  say "one of the server ports is still owned after the scoped evo session stopped"
  return 1
}

stop_scoped_lock_owner() {
  local lock="$1" expected_label="$2" pid start label
  [ -f "$lock/owner" ] || return 0
  pid="$(meta_field "$lock/owner" pid)"
  start="$(meta_field "$lock/owner" start)"
  label="$(meta_field "$lock/owner" label)"
  [ "$label" = "$expected_label" ] || {
    say "refusing to stop unexpected $expected_label lock owner (label=$label)"
    return 1
  }
  pid_matches "$pid" "$start" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    pid_matches "$pid" "$start" || return 0
    sleep 1
  done
  kill -KILL "$pid" 2>/dev/null || true
  for _ in $(seq 1 5); do
    pid_matches "$pid" "$start" || return 0
    sleep 1
  done
  return 1
}

stop_scoped_watchdog() {
  local lock="$HOME/phone-tools/.watchdog.lock"
  local pid_file="$HOME/phone-tools/.watchdog.pid"
  local expected="$HOME/phone-tools/evogent-watchdog.sh"
  local pid start current
  if [ -f "$lock/owner" ]; then
    stop_scoped_lock_owner "$lock" watchdog
    return
  fi

  # Compatibility with the pre-control-plane watchdog. Verify its exact script
  # before touching the PID; never use a name or command-pattern kill.
  [ -e "$pid_file" ] || [ -L "$pid_file" ] || return 0
  [ -f "$pid_file" ] && [ ! -L "$pid_file" ] || return 1
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  start="$(proc_start "$pid" 2>/dev/null || true)"
  [ -n "$start" ] || return 0
  process_has_exact_script "$pid" "$expected" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    pid_matches "$pid" "$start" || break
    sleep 1
  done
  if pid_matches "$pid" "$start"; then
    kill -KILL "$pid" 2>/dev/null || true
    for _ in $(seq 1 5); do
      pid_matches "$pid" "$start" || break
      sleep 1
    done
  fi
  pid_matches "$pid" "$start" && return 1
  [ -e "$pid_file" ] || [ -L "$pid_file" ] || return 0
  [ -f "$pid_file" ] && [ ! -L "$pid_file" ] || return 1
  current="$(<"$pid_file")"
  [ "$current" = "$pid" ] || return 1
  rm -f -- "$pid_file" || return 1
  fsync_directory "$(dirname "$pid_file")"
}

legacy_watchdog_stopped() {
  local pid_file="$HOME/phone-tools/.watchdog.pid"
  local expected="$HOME/phone-tools/evogent-watchdog.sh"
  local pid start
  [ -e "$pid_file" ] || [ -L "$pid_file" ] || return 0
  [ -f "$pid_file" ] && [ ! -L "$pid_file" ] || return 1
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  start="$(proc_start "$pid" 2>/dev/null || true)"
  [ -n "$start" ] || return 0
  ! process_has_exact_script "$pid" "$expected"
}

reap_dead_background_control_lock() {
  local lock="$1" expected_label="" self_start="" quarantine=""
  case "$lock" in
    "$HOME/phone-tools/.scheduler.lock") expected_label=scheduler ;;
    "$HOME/phone-tools/.watchdog.lock") expected_label=watchdog ;;
    *) return 2 ;;
  esac
  [ ! -e "$lock" ] && [ ! -L "$lock" ] && return 0
  [ -d "$lock" ] && [ ! -L "$lock" ] || return 1
  [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] \
    && [ "$(meta_field "$lock/owner" label)" = "$expected_label" ] || return 1
  # A live or structurally ambiguous owner is never stale. The shared
  # installer lock reaper binds PID+start, directory inode, and a no-replace
  # quarantine rename before this helper removes anything.
  lock_live "$lock" && return 1
  self_start="$(proc_start "$$")" || return 1
  [[ "$self_start" =~ ^[0-9]+$ ]] || return 1
  quarantine="${lock}.rollback-stale.$$.$self_start"
  [ ! -e "$quarantine" ] && [ ! -L "$quarantine" ] || return 1
  reap_dead_lock_dir "$lock" "$quarantine" || return 1
  fsync_directory "$(dirname "$lock")" || return 1
  rm -rf -- "$quarantine" || return 1
  fsync_directory "$(dirname "$lock")"
}

reap_dead_background_control_locks() {
  private_scheduler_watchdog_processes_absent \
    && reap_dead_background_control_lock \
    "$HOME/phone-tools/.scheduler.lock" \
    && reap_dead_background_control_lock \
      "$HOME/phone-tools/.watchdog.lock"
}

quiesce_control_plane() {
  local scheduler_lock="$HOME/phone-tools/.scheduler.lock"
  local watchdog_lock="$HOME/phone-tools/.watchdog.lock"
  for _ in $(seq 1 3); do
    stop_tmux_session evo-sched
    stop_scoped_lock_owner "$scheduler_lock" scheduler
    stop_scoped_watchdog
    sleep 1
    if ! tmux has-session -t '=evo-sched' 2>/dev/null \
        && ! lock_live "$scheduler_lock" \
        && ! lock_live "$watchdog_lock" \
        && legacy_watchdog_stopped \
        && reap_dead_background_control_locks; then
      return 0
    fi
  done
  say "scheduler/watchdog control plane could not be quiesced safely"
  return 1
}

reap_abandoned_control_workers_and_prove_absent() {
  local owners="$HOME/phone-tools/.control/owners" proc_root="/proc"
  [ ! -e "$owners" ] && [ ! -L "$owners" ] && return 0
  python3 - "$owners" "$proc_root" <<'PY'
import os
import pathlib
import re
import shutil
import signal
import stat
import sys
import time

root = pathlib.Path(sys.argv[1])
proc_root = pathlib.Path(sys.argv[2])
root_stat = os.lstat(root)
if (
    not stat.S_ISDIR(root_stat.st_mode)
    or stat.S_ISLNK(root_stat.st_mode)
    or root_stat.st_uid != os.geteuid()
):
    raise SystemExit("control owner root is unsafe")

token_pattern = re.compile(r"[A-Za-z0-9_.-]{1,240}")

def proc_start(pid):
    try:
        payload = (proc_root / str(pid) / "stat").read_bytes()
    except OSError:
        return None
    try:
        fields = payload.rsplit(b") ", 1)[1].split()
        return fields[19].decode("ascii")
    except (IndexError, UnicodeDecodeError):
        return None

def tagged():
    result = {}
    for environ in proc_root.glob("[0-9]*/environ"):
        try:
            values = environ.read_bytes().split(b"\0")
        except OSError:
            continue
        for value in values:
            if not value.startswith(b"EVOGENT_TASK_OWNER="):
                continue
            try:
                token = value.split(b"=", 1)[1].decode("ascii")
            except UnicodeDecodeError:
                raise SystemExit("tagged control worker has a non-ASCII owner")
            if token_pattern.fullmatch(token) is None:
                raise SystemExit("tagged control worker has an invalid owner")
            pid = int(environ.parent.name)
            start = proc_start(pid)
            if start is not None:
                result.setdefault(token, []).append((pid, start))
    return result

def still_same(pid, start):
    return proc_start(pid) == start

owners = {}
for entry in sorted(root.iterdir(), key=lambda path: path.name):
    metadata = os.lstat(entry)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
    ):
        raise SystemExit("control owner entry is unsafe")
    quarantine_match = re.fullmatch(
        r"\.reaped-(?:owner|init)-.+-([0-9]+)-([0-9]+)",
        entry.name,
    )
    if quarantine_match is not None:
        if (
            metadata.st_dev != int(quarantine_match.group(1))
            or metadata.st_ino != int(quarantine_match.group(2))
        ):
            raise SystemExit("control owner quarantine identity changed")
        shutil.rmtree(entry)
        continue
    if token_pattern.fullmatch(entry.name) is None:
        raise SystemExit("control owner entry has an invalid name")
    owner_file = entry / "owner"
    try:
        owner_stat = os.lstat(owner_file)
    except FileNotFoundError:
        # control_init_owner publishes mkdirs before its atomic owner metadata.
        # A recent directory may still be initializing; an aged one cannot
        # have launched tagged work and is safe to reap by exact inode.
        if time.time() - metadata.st_mtime < 120:
            raise SystemExit("a control owner is still initializing")
        quarantine = root / (
            f".reaped-init-{entry.name}-{metadata.st_dev}-{metadata.st_ino}"
        )
        if os.path.lexists(quarantine):
            raise SystemExit("control owner quarantine already exists")
        os.rename(entry, quarantine)
        shutil.rmtree(quarantine)
        continue
    if (
        not stat.S_ISREG(owner_stat.st_mode)
        or stat.S_ISLNK(owner_stat.st_mode)
        or owner_stat.st_uid != os.geteuid()
        or stat.S_IMODE(owner_stat.st_mode) not in {0o600, 0o644}
        or owner_stat.st_size > 4096
    ):
        raise SystemExit("control owner metadata is unsafe")
    fields = {}
    for line in owner_file.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if not separator or key in fields:
            raise SystemExit("control owner metadata is malformed")
        fields[key] = value
    token = fields.get("owner", "")
    pid = fields.get("pid", "")
    start = fields.get("start", "")
    if (
        token != entry.name
        or token_pattern.fullmatch(token) is None
        or re.fullmatch(r"[1-9][0-9]*", pid) is None
        or re.fullmatch(r"[0-9]+", start) is None
    ):
        raise SystemExit("control owner identity is invalid")
    owners[token] = (entry, int(pid), start, metadata.st_dev, metadata.st_ino)

tagged_before = tagged()
for token, (entry, pid, start, device, inode) in owners.items():
    if still_same(pid, start):
        raise SystemExit("a live control owner remains after quiesce")
    for tagged_pid, tagged_start in tagged_before.get(token, []):
        if still_same(tagged_pid, tagged_start):
            try:
                os.kill(tagged_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

deadline = time.monotonic() + 2
while time.monotonic() < deadline:
    remaining = tagged()
    if not any(token in remaining for token in owners):
        break
    time.sleep(0.1)

remaining = tagged()
for token in owners:
    for tagged_pid, tagged_start in remaining.get(token, []):
        if still_same(tagged_pid, tagged_start):
            try:
                os.kill(tagged_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

deadline = time.monotonic() + 2
while time.monotonic() < deadline:
    remaining = tagged()
    if not any(token in remaining for token in owners):
        break
    time.sleep(0.1)
if any(token in tagged() for token in owners):
    raise SystemExit("an abandoned tagged control worker survived reaping")

for token, (entry, _pid, _start, device, inode) in owners.items():
    current = os.lstat(entry)
    if (current.st_dev, current.st_ino) != (device, inode):
        raise SystemExit("control owner entry changed during reaping")
    quarantine = root / f".reaped-owner-{token}-{device}-{inode}"
    if os.path.lexists(quarantine):
        raise SystemExit("control owner quarantine already exists")
    os.rename(entry, quarantine)
    shutil.rmtree(quarantine)

directory = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)

# A tagged child whose owner directory was already lost is also abandoned.
unregistered = tagged()
for token, processes in unregistered.items():
    for tagged_pid, tagged_start in processes:
        if still_same(tagged_pid, tagged_start):
            try:
                os.kill(tagged_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
deadline = time.monotonic() + 2
while time.monotonic() < deadline and tagged():
    time.sleep(0.1)
for processes in tagged().values():
    for tagged_pid, tagged_start in processes:
        if still_same(tagged_pid, tagged_start):
            try:
                os.kill(tagged_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
deadline = time.monotonic() + 2
while time.monotonic() < deadline and tagged():
    time.sleep(0.1)
if tagged() or any(root.iterdir()):
    raise SystemExit("control workers were not fully quiesced")
PY
}

rish_command() {
  local command="$1" budget="${2:-30}" rish_bin="$HOME/rish-bin/rish"
  [ -x "$rish_bin" ] \
    && command -v timeout >/dev/null 2>&1 \
    && [[ "$budget" =~ ^[1-9][0-9]{0,2}$ ]] \
    && [ "$budget" -le 900 ] || return 1
  if command -v setsid >/dev/null 2>&1; then
    # Force rish to fork away from an inherited SSH/PTY session, then wait for
    # the actual Android-shell child. Timeout runs inside that detached session
    # so a wedged Binder/Shizuku call cannot strand durable installer locks.
    setsid -f -w timeout -k 5 "$budget" env RISH_APPLICATION_ID=com.termux \
      "$rish_bin" -c "$command" </dev/null
  else
    timeout --foreground -k 5 "$budget" \
      env RISH_APPLICATION_ID=com.termux \
      "$rish_bin" -c "$command" </dev/null
  fi
}

allocate_shell_staging_file() {
  local purpose="$1" operation="" path="" nonce="" attempt probe
  case "$purpose" in
    android-role-query|control-token|installed-apk|package-version|\
    rollback-dump|package-idle) ;;
    *) return 1 ;;
  esac
  for attempt in $(seq 1 3); do
    nonce="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
    [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || return 1
    operation="/data/local/tmp/evogent-${purpose}.${nonce}"
    path="$operation/payload"
    rish_command \
      "mkdir -m 0700 '$operation' && : > '$path' && chmod 0600 '$path' && chmod 0711 '$operation'" \
      >/dev/null 2>&1 || true
    for probe in $(seq 1 100); do
      if [ -d "$operation" ] && [ ! -L "$operation" ] \
          && [ -f "$path" ] && [ ! -L "$path" ] \
          && [ "$(stat -c '%a' "$operation" 2>/dev/null || true)" = 711 ] \
          && [ "$(stat -c '%a' "$path" 2>/dev/null || true)" = 600 ]; then
        printf '%s\n' "$path"
        return 0
      fi
      sleep 0.1
    done
    rish_command "rm -rf '$operation'" >/dev/null 2>&1 || true
  done
  return 1
}

remove_shell_staging_file() {
  local path="$1" operation probe
  [[ "$path" =~ ^/data/local/tmp/evogent-(android-role-query|control-token|installed-apk|package-version|rollback-dump|package-idle)\.[0-9a-f]{32}/payload$ ]] \
    || return 1
  operation="${path%/payload}"
  rish_command "rm -rf '$operation'" >/dev/null 2>&1 || true
  for probe in $(seq 1 100); do
    if [ ! -e "$operation" ] && [ ! -L "$operation" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

copy_published_shell_file() {
  local source="$1" destination="$2" attempts="${3:-100}" probe
  local partial="${destination}.bridge.$$"
  [[ "$attempts" =~ ^[0-9]+$ ]] && [ "$attempts" -gt 0 ] || return 1
  [ ! -L "$destination" ] || return 1
  rm -f -- "$partial"
  for probe in $(seq 1 "$attempts"); do
    if [ -f "$source" ] && [ ! -L "$source" ] \
        && [ "$(stat -c '%a' "$source" 2>/dev/null || true)" = 644 ] \
        && cp "$source" "$partial"; then
      chmod 600 "$partial"
      mv -f -- "$partial" "$destination"
      return 0
    fi
    rm -f -- "$partial"
    sleep 0.1
  done
  return 1
}

allocate_shell_package_operation() {
  local path="" nonce="" attempt probe
  for attempt in $(seq 1 3); do
    nonce="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
    [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || return 1
    path="/data/local/tmp/evogent-package-op.${nonce}"
    rish_command \
      "mkdir -m 0700 '$path' && : > '$path/candidate.apk' && chmod 0666 '$path/candidate.apk' && chmod 0711 '$path'" \
      >/dev/null 2>&1 || true
    for probe in $(seq 1 100); do
      if [ -d "$path" ] && [ ! -L "$path" ] \
          && [ -f "$path/candidate.apk" ] && [ ! -L "$path/candidate.apk" ] \
          && [ "$(stat -c '%a' "$path" 2>/dev/null || true)" = 711 ] \
          && [ "$(stat -c '%a' "$path/candidate.apk" 2>/dev/null || true)" = 666 ]; then
        printf '%s\n' "$path"
        return 0
      fi
      sleep 0.1
    done
    rish_command "rm -rf '$path'" >/dev/null 2>&1 || true
  done
  return 1
}

remove_shell_package_operation() {
  local path="$1" probe
  [[ "$path" =~ ^/data/local/tmp/evogent-package-op\.[0-9a-f]{32}$ ]] \
    || return 1
  rish_command "rm -rf '$path'" >/dev/null 2>&1 || true
  for probe in $(seq 1 100); do
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

read_package_result_status() {
  python3 - "$1" <<'PY'
import os
import re
import stat
import sys

path = sys.argv[1]
descriptor = os.open(
    path,
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0),
)
try:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 64:
        raise SystemExit(1)
    payload = os.read(descriptor, 65)
finally:
    os.close(descriptor)
match = re.fullmatch(rb"EVOGENT_PACKAGE_RESULT_V1\n(0|[1-9][0-9]{0,2})\n", payload)
if match is None:
    raise SystemExit(1)
status = int(match.group(1))
if status > 255:
    raise SystemExit(1)
print(status)
PY
}

display_zero_top_resumed_package_from_dump() {
  awk '
    function observe(line, fields, count, part, package_name) {
      count = split(line, fields, /[[:space:]]+/)
      for (part = 1; part <= count; part++) {
        if (fields[part] ~ /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+\/[^[:space:]]+$/) {
          package_name = fields[part]
          sub(/\/.*/, "", package_name)
          packages[package_name] = 1
          found = 1
          return
        }
      }
    }
    /^[[:space:]]*Display[[:space:]]+#?[0-9]+([[:space:]:(]|$)/ {
      display_zero = ($0 ~ /^[[:space:]]*Display[[:space:]]+#?0([[:space:]:(]|$)/)
      next
    }
    display_zero && /(topResumedActivity|mResumedActivity)[=:]/ {
      observe($0)
    }
    END {
      if (!found) exit 1
      count = 0
      for (package_name in packages) {
        answer = package_name
        count++
      }
      if (count != 1) exit 1
      print answer
    }
  '
}

trusted_android_install_foreground_once() {
  local activity_dump="" package_name=""
  activity_dump="$(
    rish_command 'dumpsys activity activities 2>/dev/null' 15 \
      2>/dev/null || true
  )"
  package_name="$(
    printf '%s\n' "$activity_dump" \
      | display_zero_top_resumed_package_from_dump 2>/dev/null || true
  )"
  case "$package_name" in
    com.android.packageinstaller|com.google.android.packageinstaller|\
com.android.permissioncontroller|com.google.android.permissioncontroller|\
com.android.vending|com.google.android.gms)
      return 0
      ;;
    *) return 1 ;;
  esac
}

trusted_android_install_foreground() {
  trusted_android_install_foreground_once || return 1
  sleep 1
  trusted_android_install_foreground_once
}

clear_apk_user_action_state() {
  APK_USER_ACTION_KIND=""
  APK_USER_ACTION_PURPOSE=""
  APK_USER_ACTION_EVIDENCE=""
  APK_USER_ACTION_TARGET_SHA256=""
  APK_USER_ACTION_TARGET_VERSION_CODE=""
  APK_USER_ACTION_TARGET_SIGNER_SHA256=""
}

package_manager_supports_apk_rollback() {
  rish_command \
    "cmd package help | grep -q -- '--enable-rollback'" \
    >/dev/null 2>&1 || return 1
  if rish_command \
      "cmd package help | grep -q -- 'rollback-app'" \
      >/dev/null 2>&1; then
    return 0
  fi

  # Android 16's Pixel package-manager help omits this hidden command even
  # though PackageManagerShellCommand implements it. With no package argument,
  # the command cannot mutate state; reaching its arity check proves dispatch.
  rish_command \
    "cmd package rollback-app 2>&1 | grep -Fq 'Argument expected after \"rollback-app\"'" \
    >/dev/null 2>&1
}

install_apk() {
  local apk="$1" mode="${2:-upgrade}" operation="" candidate=""
  local expected_apk_sha256="" install_command="" completed=0 operation_removed=0
  local private_output="$STAGE/package-manager-output.txt"
  local private_status="$STAGE/package-manager-status.txt"
  local retained_result="${LOG%.log}-package-manager-${mode}.log"
  local package_status="" rish_status=0
  case "$mode" in
    upgrade)
      install_command="cmd package install -r --enable-rollback"
      ;;
    fallback)
      # Last-resort fallback only. Android native rollback is the supported
      # path; `-d` may reject non-debuggable downgrades and cannot be trusted.
      install_command="cmd package install -r -d"
      ;;
    *) return 1 ;;
  esac
  expected_apk_sha256="$(sha256_file "$apk")"
  [[ "$expected_apk_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  if [ "$mode" = fallback ] && [ -n "$PACKAGE_OPERATION" ]; then
    remove_shell_package_operation "$PACKAGE_OPERATION" || return 1
    PACKAGE_OPERATION=""
  fi
  if [ -n "$PACKAGE_OPERATION" ]; then
    [[ "$PACKAGE_OPERATION" =~ ^/data/local/tmp/evogent-package-op\.[0-9a-f]{32}$ ]] \
      || return 1
    operation="$PACKAGE_OPERATION"
    [ -d "$operation" ] && [ ! -L "$operation" ] \
      && [ -f "$operation/candidate.apk" ] \
      && [ ! -L "$operation/candidate.apk" ] || return 1
  else
    operation="$(allocate_shell_package_operation)" || return 1
    PACKAGE_OPERATION="$operation"
    if [ "${TRANSACTION_JOURNAL_WRITTEN:-0}" = 1 ]; then
      if ! write_transaction_journal "${TRANSACTION_PHASE:-apk_install_pending}"; then
        return 1
      fi
    fi
  fi
  candidate="$operation/candidate.apk"
  if ! cp "$apk" "$candidate" \
      || [ "$(sha256_file "$candidate")" != "$expected_apk_sha256" ]; then
    if remove_shell_package_operation "$operation"; then
      [ "$operation" != "$PACKAGE_OPERATION" ] || PACKAGE_OPERATION=""
    fi
    return 1
  fi

  # Some rish transports return before a large stdout stream or package
  # operation is complete. The shell privately rechecks immutable candidate
  # bytes, captures diagnostics, and publishes a versioned status marker last.
  # Its directory becomes traversable only after that complete marker exists.
  rish_command \
    "package_rc=125; : > '$operation/details.tmp'; if chmod 0700 '$operation' && [ -f '$candidate' ] && [ ! -L '$candidate' ] && chmod 0400 '$candidate'; then actual_sha256=\$(sha256sum '$candidate' 2>/dev/null | awk '{print \$1}'); if [ \"\$actual_sha256\" = '$expected_apk_sha256' ]; then $install_command '$candidate' > '$operation/details.tmp' 2>&1; package_rc=\$?; if [ \"\$package_rc\" -eq 0 ]; then cmd package wait-for-handler --timeout 120000 >> '$operation/details.tmp' 2>&1 && cmd package wait-for-background-handler --timeout 120000 >> '$operation/details.tmp' 2>&1 || package_rc=\$?; fi; else printf '%s\\n' 'candidate APK identity check failed' > '$operation/details.tmp'; fi; else printf '%s\\n' 'candidate APK staging check failed' > '$operation/details.tmp'; fi; rm -f '$candidate'; printf 'EVOGENT_PACKAGE_RESULT_V1\\n%s\\n' \"\$package_rc\" > '$operation/status.tmp'; chmod 0444 '$operation/details.tmp' '$operation/status.tmp' && mv '$operation/details.tmp' '$operation/details' && mv '$operation/status.tmp' '$operation/status' && chmod 0755 '$operation'; exit 0" \
    480 \
    >/dev/null 2>&1 || rish_status=$?
  for _ in $(seq 1 120); do
    if [ -d "$operation" ] && [ ! -L "$operation" ] \
        && [ -f "$operation/status" ] && [ ! -L "$operation/status" ] \
        && cp "$operation/status" "$private_status" 2>/dev/null; then
      chmod 600 "$private_status"
      if package_status="$(read_package_result_status "$private_status" 2>/dev/null)"; then
        completed=1
        break
      fi
    fi
    package_status=""
    sleep 1
  done
  if [ "$completed" = 1 ] \
      && [ -f "$operation/details" ] && [ ! -L "$operation/details" ]; then
    cp "$operation/details" "$private_output" 2>/dev/null || : > "$private_output"
  else
    : > "$private_output"
  fi
  chmod 600 "$private_output"
  if [ "$completed" = 1 ]; then
    if remove_shell_package_operation "$operation"; then
      operation_removed=1
      [ "$operation" != "$PACKAGE_OPERATION" ] || PACKAGE_OPERATION=""
    fi
  fi

  if [ "$completed" = 0 ] || [ "$package_status" -ne 0 ] \
      || [ "$operation_removed" = 0 ]; then
    [ ! -e "$retained_result" ] && [ ! -L "$retained_result" ] || return 1
    {
      printf 'rishStatus=%s\n' "$rish_status"
      printf 'completionPublished=%s\n' "$completed"
      printf 'packageStatus=%s\n' "${package_status:-unavailable}"
      printf '%s\n' '--- private package-manager output ---'
      cat "$private_output"
    } > "$retained_result"
    chmod 600 "$retained_result"
    fsync_regular_file_and_parent "$retained_result"
    if [ "$completed" = 1 ] \
        && [ "$package_status" -ne 0 ] \
        && [ "$operation_removed" = 1 ] \
        && reconcile_android_install_user_action \
          "$apk" "$mode" "$retained_result"; then
      rm -f -- "$retained_result"
      return 0
    fi
    say "Android package installation failed; private package-manager details were retained"
    return 1
  fi
  rm -f -- "$retained_result"
}

wait_for_package_manager_idle() {
  local shell_path="" private_result="$STAGE/package-manager-idle.txt"
  shell_path="$(allocate_shell_staging_file package-idle 2>/dev/null || true)"
  [ -n "$shell_path" ] || return 1
  rish_command \
    "if cmd package wait-for-handler --timeout 120000 && cmd package wait-for-background-handler --timeout 120000; then printf 'EVOGENT_PACKAGE_MANAGER_IDLE_V1\\n' > '$shell_path' && chmod 0644 '$shell_path'; fi" \
    300 \
    >/dev/null 2>&1 || true
  if ! copy_published_shell_file "$shell_path" "$private_result" 3000; then
    remove_shell_staging_file "$shell_path" >/dev/null 2>&1 || true
    rm -f -- "$private_result"
    return 1
  fi
  remove_shell_staging_file "$shell_path" >/dev/null 2>&1 || {
    rm -f -- "$private_result"
    return 1
  }
  [ "$(cat "$private_result")" = EVOGENT_PACKAGE_MANAGER_IDLE_V1 ] || {
    rm -f -- "$private_result"
    return 1
  }
  rm -f -- "$private_result"
}

backup_installed_apk() {
  local output="$1" attempt partial="${1}.partial-$$" shell_path
  rm -f -- "$partial"
  for attempt in 1 2 3; do
    shell_path="$(allocate_shell_staging_file installed-apk 2>/dev/null || true)"
    if [ -n "$shell_path" ]; then
      rish_command \
        "installed_path=\$(pm path '$PACKAGE_NAME' | sed -n 's/^package://p' | head -1); [ -n \"\$installed_path\" ] && [ -f \"\$installed_path\" ] && [ ! -L \"\$installed_path\" ] && cp \"\$installed_path\" '$shell_path' && chmod 0644 '$shell_path'" \
        >/dev/null 2>&1 || true
      if copy_published_shell_file "$shell_path" "$partial" 100 \
          && [ -s "$partial" ] \
          && unzip -tqq "$partial" >/dev/null 2>&1; then
        remove_shell_staging_file "$shell_path" || true
        mv -f -- "$partial" "$output"
        return 0
      fi
    fi
    [ -z "$shell_path" ] || remove_shell_staging_file "$shell_path" || true
    rm -f -- "$partial"
    [ "$attempt" -eq 3 ] || sleep 1
  done
  return 1
}

apk_signer_sha256() {
  local apk="$1" entry block cert der
  command -v unzip >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1 || return 1
  entry="$(unzip -Z1 "$apk" 2>/dev/null \
    | awk 'toupper($0) ~ /^META-INF\/.*\.(RSA|DSA|EC)$/ {print; exit}')"
  [ -n "$entry" ] || return 1
  block="$(mktemp "$STAGING_ROOT/signer-block.XXXXXX")"
  cert="$(mktemp "$STAGING_ROOT/signer-cert.XXXXXX")"
  der="$(mktemp "$STAGING_ROOT/signer-der.XXXXXX")"
  if ! unzip -p "$apk" "$entry" > "$block" \
      || ! openssl pkcs7 -inform DER -in "$block" -print_certs -out "$cert" 2>/dev/null \
      || ! openssl x509 -in "$cert" -outform DER > "$der" 2>/dev/null; then
    rm -f "$block" "$cert" "$der"
    return 1
  fi
  sha256_file "$der"
  rm -f "$block" "$cert" "$der"
}

installed_apk_version_code() {
  local shell_path="" private_result="$STAGE/installed-version-code.txt" code=""
  shell_path="$(allocate_shell_staging_file package-version 2>/dev/null || true)"
  [ -n "$shell_path" ] || return 1
  rish_command \
    "dumpsys package '$PACKAGE_NAME' | sed -n 's/.*versionCode=\\([0-9]*\\).*/\\1/p' | head -1 > '$shell_path' && chmod 0644 '$shell_path'" \
    >/dev/null 2>&1 || true
  if copy_published_shell_file "$shell_path" "$private_result" 100; then
    code="$(tr -d '\r\n' < "$private_result")"
    [[ "$code" =~ ^[0-9]{1,18}$ ]] || code=""
  fi
  remove_shell_staging_file "$shell_path" || true
  [ -n "$code" ] || return 1
  printf '%s\n' "$code"
}

installed_apk_matches_backup() {
  local probe="$1" code signer
  backup_installed_apk "$probe" || return 1
  code="$(installed_apk_version_code)"
  signer="$(apk_signer_sha256 "$probe" 2>/dev/null || true)"
  [ "$code" = "$PREVIOUS_APK_CODE" ] \
    && [ "$signer" = "$PREVIOUS_APK_SIGNER" ] \
    && [ "$(sha256_file "$probe")" = "$(sha256_file "$APK_BACKUP")" ]
}

installed_apk_matches_identity() {
  local probe="$1" expected_code="$2" expected_signer="$3"
  local expected_sha256="$4" code="" signer=""
  [[ "$expected_code" =~ ^[0-9]{1,18}$ ]] \
    && [[ "$expected_signer" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  code="$(installed_apk_version_code)" || return 1
  # During a foreground Android review the predecessor normally remains
  # installed. Check its small package metadata before copying and hashing the
  # complete APK on every bounded poll.
  [ "$code" = "$expected_code" ] || return 1
  backup_installed_apk "$probe" || return 1
  signer="$(apk_signer_sha256 "$probe" 2>/dev/null || true)"
  [ "$signer" = "$expected_signer" ] \
    && [ "$(sha256_file "$probe")" = "$expected_sha256" ]
}

installed_apk_identity_stable() {
  local probe="$1" code="$2" signer="$3" sha256="$4"
  local observations="${5:-3}"
  [[ "$observations" =~ ^[1-9][0-9]?$ ]] || return 1
  for _ in $(seq 1 "$observations"); do
    installed_apk_matches_identity "$probe" "$code" "$signer" "$sha256" \
      || return 1
    [ "$observations" -eq 1 ] || sleep 1
  done
}

reconcile_android_install_user_action() {
  local apk="$1" mode="$2" retained_result="$3"
  local prior_phase="$TRANSACTION_PHASE" purpose="" target_code=""
  local target_signer="" target_sha256="" counterpart_code=""
  local counterpart_signer="" counterpart_sha256="" probe=""
  local deadline=0
  [ "$TRANSACTION_JOURNAL_WRITTEN" = 1 ] \
    && [ -f "$retained_result" ] && [ ! -L "$retained_result" ] \
    && [ "$(stat -c '%a' "$retained_result")" = 600 ] || return 1
  target_sha256="$(sha256_file "$apk")"
  case "$mode" in
    upgrade)
      [ "$prior_phase" = apk_install_pending ] || return 1
      purpose=candidate_install
      target_code="$EXPECTED_APK_CODE"
      target_signer="$EXPECTED_APK_SIGNER"
      counterpart_code="$PREVIOUS_APK_CODE"
      counterpart_signer="$PREVIOUS_APK_SIGNER"
      counterpart_sha256="$(sha256_file "$APK_BACKUP")"
      ;;
    fallback)
      purpose=rollback_restore
      target_code="$PREVIOUS_APK_CODE"
      target_signer="$PREVIOUS_APK_SIGNER"
      counterpart_code="$EXPECTED_APK_CODE"
      counterpart_signer="$EXPECTED_APK_SIGNER"
      counterpart_sha256="$EXPECTED_APK_SHA256"
      ;;
    *) return 1 ;;
  esac
  [[ "$target_sha256" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$target_signer" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$target_code" =~ ^[0-9]{1,18}$ ]] \
    && [[ "$counterpart_sha256" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$counterpart_signer" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$counterpart_code" =~ ^[0-9]{1,18}$ ]] || return 1

  probe="$STAGE/installed-user-action.apk"
  if installed_apk_identity_stable \
      "$probe" "$target_code" "$target_signer" "$target_sha256" 3 \
      && wait_for_package_manager_idle \
      && installed_apk_identity_stable \
        "$probe" "$target_code" "$target_signer" "$target_sha256" 3; then
    say "Android package result reconciled from exact installed identity"
    return 0
  fi
  installed_apk_identity_stable \
    "$probe" "$counterpart_code" "$counterpart_signer" \
    "$counterpart_sha256" 3 || return 1
  trusted_android_install_foreground || return 1

  APK_USER_ACTION_KIND=android_install_review
  APK_USER_ACTION_PURPOSE="$purpose"
  APK_USER_ACTION_EVIDENCE=trusted_system_installer_foreground_v1
  APK_USER_ACTION_TARGET_SHA256="$target_sha256"
  APK_USER_ACTION_TARGET_VERSION_CODE="$target_code"
  APK_USER_ACTION_TARGET_SIGNER_SHA256="$target_signer"
  write_transaction_journal apk_user_action_required || return 1
  say "USER_ACTION_REQUIRED kind=android_install_review purpose=$purpose"

  deadline=$(( $(date +%s) + INSTALL_USER_ACTION_WAIT_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if installed_apk_matches_identity \
        "$probe" "$target_code" "$target_signer" "$target_sha256"; then
      if wait_for_package_manager_idle \
          && installed_apk_identity_stable \
            "$probe" "$target_code" "$target_signer" "$target_sha256" 3; then
        clear_apk_user_action_state
        write_transaction_journal "$prior_phase" || return 1
        say "Android foreground installation action completed"
        return 0
      fi
    fi
    sleep 2
  done
  say "Android foreground installation action timed out; restoring the prior release"
  return 1
}

wait_for_apk_backup_identity() {
  local probe="$1" stable=0
  for _ in $(seq 1 60); do
    if installed_apk_matches_backup "$probe"; then
      stable=$((stable + 1))
      [ "$stable" -ge 3 ] && return 0
    else
      stable=0
    fi
    sleep 2
  done
  return 1
}

rollback_apk_native() {
  local probe="$STAGING_ROOT/installed-after-rollback.apk" current_code=""
  local version_mismatch=0
  [ "$APK_INSTALL_ATTEMPTED" = 1 ] || return 0
  [ "$APK_BACKUP_READY" = 1 ] || {
    say "CRITICAL: APK install was attempted without a proven rollback backup"
    return 1
  }

  # Cancel the exact journaled candidate before the final package-manager
  # barrier. A detached shell that starts afterward can no longer open the APK;
  # a shell already in PackageManager is drained by the barriers below.
  reap_recorded_package_operation || return 1

  # Accept an already-restored APK only after both package-manager handlers are
  # idle and three stable exact-identity observations agree. A version mismatch
  # observed after that idle barrier proves the backup identity cannot match,
  # so skip the full exact-byte window before asking Android to roll back.
  if wait_for_package_manager_idle; then
    current_code="$(installed_apk_version_code 2>/dev/null || true)"
    if [[ "$current_code" =~ ^[0-9]{1,18}$ ]] \
        && [[ "$PREVIOUS_APK_CODE" =~ ^[0-9]{1,18}$ ]] \
        && [ "$current_code" != "$PREVIOUS_APK_CODE" ]; then
      version_mismatch=1
    fi
    if [ "$version_mismatch" = 0 ] \
        && wait_for_apk_backup_identity "$probe"; then
      return 0
    fi
  fi

  # Otherwise serialize a native rollback (or exact-byte fallback reinstall)
  # behind any pending package operation and prove its exact identity.
  rish_command "cmd package rollback-app '$PACKAGE_NAME'" 120 \
    >/dev/null 2>&1 || true
  if wait_for_package_manager_idle \
      && wait_for_apk_backup_identity "$probe"; then
    return 0
  fi

  say "CRITICAL: Android native rollback did not restore the backed-up APK; trying -d fallback"
  if ! install_apk "$APK_BACKUP" fallback >/dev/null 2>&1; then
    say "CRITICAL: backed-up APK fallback install was rejected"
    reap_recorded_package_operation || return 1
    if wait_for_package_manager_idle \
        && wait_for_apk_backup_identity "$probe"; then
      return 0
    fi
    return 1
  fi
  reap_recorded_package_operation || return 1
  if wait_for_package_manager_idle \
      && wait_for_apk_backup_identity "$probe"; then
    return 0
  fi
  say "CRITICAL: installed APK did not return to its backed-up identity"
  return 1
}

wait_for_apk_rollback_availability() {
  local expected_installed="$1" expected_backup="$2"
  local dump="$STAGING_ROOT/rollback-state.txt" shell_path=""
  [ -f "$ROLLBACK_STATE_HELPER" ] && [ ! -L "$ROLLBACK_STATE_HELPER" ] || return 1
  for _ in $(seq 1 30); do
    shell_path="$(allocate_shell_staging_file rollback-dump 2>/dev/null || true)"
    if [ -n "$shell_path" ]; then
      rish_command \
        "dumpsys rollback > '$shell_path' && chmod 0644 '$shell_path'" \
        >/dev/null 2>&1 || true
      if copy_published_shell_file "$shell_path" "$dump" 30; then
        remove_shell_staging_file "$shell_path" || true
        shell_path=""
      fi
    fi
    if [ -s "$dump" ] \
        && python3 "$ROLLBACK_STATE_HELPER" check \
          "$PACKAGE_NAME" "$expected_installed" "$expected_backup" < "$dump"; then
      rm -f -- "$dump"
      return 0
    fi
    [ -z "$shell_path" ] || remove_shell_staging_file "$shell_path" || true
    shell_path=""
    rm -f -- "$dump"
    sleep 1
  done
  return 1
}

android_role_state_helper_safe() {
  [ -n "$ANDROID_ROLE_STATE_HELPER" ] \
    && [ -f "$ANDROID_ROLE_STATE_HELPER" ] \
    && [ ! -L "$ANDROID_ROLE_STATE_HELPER" ]
}

android_role_name_valid() {
  case "${1:-}" in
    "$ANDROID_HOME_ROLE"|"$ANDROID_ASSISTANT_ROLE") return 0 ;;
    *) return 1 ;;
  esac
}

read_android_role_query_result() {
  local kind="$1" command="$2" max_bytes="$3"
  local shell_path="" private_result="" value="" parsed=0 removed=0
  case "$kind:$max_bytes" in
    current-user:64|role-holders:4096|\
    assistant-setting:1024|voice-setting:1024|home-component:1024) ;;
    *) return 1 ;;
  esac
  [ -n "$STAGE" ] && [ -d "$STAGE" ] && [ ! -L "$STAGE" ] \
    && android_role_state_helper_safe || return 1
  private_result="$(mktemp "$STAGE/android-role-query.XXXXXX")" || return 1
  chmod 600 "$private_result" || {
    rm -f -- "$private_result"
    return 1
  }
  shell_path="$(
    allocate_shell_staging_file android-role-query 2>/dev/null || true
  )"
  if [ -n "$shell_path" ]; then
    # rish stdout is not a completion channel: on some devices it is
    # nondeterministically empty even with rc=0. The Android shell instead
    # captures the bounded query privately, publishes a typed/versioned result
    # by changing the randomized capability path to 0644 only after success,
    # and the Termux side polls that filesystem proof.
    rish_command \
      "query_tmp='${shell_path}.query'; rm -f \"\$query_tmp\"; umask 077; if $command > \"\$query_tmp\" 2>/dev/null && [ -f \"\$query_tmp\" ] && [ ! -L \"\$query_tmp\" ]; then query_size=\$(wc -c < \"\$query_tmp\" | tr -d '[:space:]'); if [ -n \"\$query_size\" ] && [ \"\$query_size\" -le '$max_bytes' ]; then { printf 'EVOGENT_ANDROID_ROLE_QUERY_RESULT_V1\\n%s\\n' '$kind'; cat \"\$query_tmp\"; } > '$shell_path' && rm -f \"\$query_tmp\" && chmod 0644 '$shell_path'; else rm -f \"\$query_tmp\"; exit 65; fi; else rm -f \"\$query_tmp\"; exit 65; fi" \
      30 >/dev/null 2>&1 || true
    if copy_published_shell_file "$shell_path" "$private_result" 100; then
      case "$kind" in
        current-user)
          value="$(
            python3 "$ANDROID_ROLE_STATE_HELPER" \
              parse-current-user-result < "$private_result" 2>/dev/null
          )" && parsed=1
          ;;
        role-holders)
          value="$(
            python3 "$ANDROID_ROLE_STATE_HELPER" \
              parse-role-holders-result < "$private_result" 2>/dev/null
          )" && parsed=1
          ;;
        assistant-setting)
          value="$(
            python3 "$ANDROID_ROLE_STATE_HELPER" \
              parse-assistant-setting-result < "$private_result" 2>/dev/null
          )" && parsed=1
          ;;
        voice-setting)
          value="$(
            python3 "$ANDROID_ROLE_STATE_HELPER" \
              parse-voice-setting-result < "$private_result" 2>/dev/null
          )" && parsed=1
          ;;
        home-component)
          value="$(
            python3 "$ANDROID_ROLE_STATE_HELPER" \
              parse-home-component-result < "$private_result" 2>/dev/null
          )" && parsed=1
          ;;
      esac
    fi
    remove_shell_staging_file "$shell_path" >/dev/null 2>&1 && removed=1
  fi
  rm -f -- "$private_result"
  [ "$parsed" = 1 ] && [ "$removed" = 1 ] || return 1
  printf '%s\n' "$value"
}

read_android_role_holders() {
  local role="$1" user_id="$2"
  android_role_name_valid "$role" \
    && [[ "$user_id" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$user_id" -le 2147483647 ] || return 1
  read_android_role_query_result \
    role-holders \
    "cmd role get-role-holders --user '$user_id' '$role'" \
    4096
}

read_android_current_user() {
  read_android_role_query_result current-user "am get-current-user" 64
}

read_android_assistant_setting() {
  local user_id="$1"
  [[ "$user_id" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$user_id" -le 2147483647 ] || return 1
  read_android_role_query_result \
    assistant-setting \
    "settings --user '$user_id' get secure assistant" \
    1024
}

read_android_voice_setting() {
  local user_id="$1"
  [[ "$user_id" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$user_id" -le 2147483647 ] || return 1
  read_android_role_query_result \
    voice-setting \
    "settings --user '$user_id' get secure voice_interaction_service" \
    1024
}

read_android_home_component() {
  local user_id="$1"
  [[ "$user_id" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$user_id" -le 2147483647 ] || return 1
  read_android_role_query_result \
    home-component \
    "cmd package resolve-activity --brief --user '$user_id' -a android.intent.action.MAIN -c android.intent.category.HOME | tail -n 1" \
    1024
}

capture_android_role_backup() {
  local home_raw assistant_raw digest role_backup role_user_id
  android_role_state_helper_safe || return 1
  role_backup="$BACKUP_DIR/android-role-holders.json"
  [ "$ANDROID_ROLE_BACKUP" = "$role_backup" ] \
    && [ ! -e "$role_backup" ] \
    && [ ! -L "$role_backup" ] || return 1
  role_user_id="$(read_android_current_user)" || return 1
  home_raw="$(
    read_android_role_holders "$ANDROID_HOME_ROLE" "$role_user_id"
  )" || return 1
  assistant_raw="$(
    read_android_role_holders "$ANDROID_ASSISTANT_ROLE" "$role_user_id"
  )" || return 1
  digest="$(
    {
      printf '%s\n' EVOGENT_ANDROID_ROLE_RAW_V1
      printf '%s\n' "$home_raw"
      printf '%s\n' "$assistant_raw"
    } | python3 "$ANDROID_ROLE_STATE_HELPER" capture \
      --snapshot "$role_backup" \
      --user-id "$role_user_id"
  )" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  # Publish the proof fields as one assignment command. A pending signal can
  # therefore observe either a wholly unready state or the complete proof,
  # never a user id without a ready digest.
  ANDROID_ROLE_BACKUP_SHA256="$digest" \
    ANDROID_ROLE_USER_ID="$role_user_id" \
    ANDROID_ROLE_BACKUP_READY=1
  validate_android_role_backup
}

validate_android_role_backup() {
  [ "$ANDROID_ROLE_BACKUP_READY" = 1 ] \
    && [ "$ANDROID_ROLE_BACKUP" = "$BACKUP_DIR/android-role-holders.json" ] \
    && [[ "$ANDROID_ROLE_BACKUP_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$ANDROID_ROLE_USER_ID" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && android_role_state_helper_safe \
    && python3 "$ANDROID_ROLE_STATE_HELPER" validate \
      --snapshot "$ANDROID_ROLE_BACKUP" \
      --sha256 "$ANDROID_ROLE_BACKUP_SHA256" \
      --user-id "$ANDROID_ROLE_USER_ID" \
      >/dev/null
}

android_role_snapshot_holder() {
  local role="$1"
  android_role_name_valid "$role" \
    && validate_android_role_backup \
    && python3 "$ANDROID_ROLE_STATE_HELPER" query \
      --snapshot "$ANDROID_ROLE_BACKUP" \
      --sha256 "$ANDROID_ROLE_BACKUP_SHA256" \
      --user-id "$ANDROID_ROLE_USER_ID" \
      --role "$role"
}

android_role_matches_snapshot() {
  local role="$1" observed
  observed="$(
    read_android_role_holders "$role" "$ANDROID_ROLE_USER_ID"
  )" || return 65
  printf '%s\n' "$observed" \
    | python3 "$ANDROID_ROLE_STATE_HELPER" compare-snapshot \
      --snapshot "$ANDROID_ROLE_BACKUP" \
      --sha256 "$ANDROID_ROLE_BACKUP_SHA256" \
      --user-id "$ANDROID_ROLE_USER_ID" \
      --role "$role"
}

android_role_matches_release() {
  local role="$1" user_id="$2" observed
  android_role_state_helper_safe || return 65
  observed="$(read_android_role_holders "$role" "$user_id")" || return 65
  printf '%s\n' "$observed" \
    | python3 "$ANDROID_ROLE_STATE_HELPER" compare-target \
      --role "$role" \
      --target-package "$PACKAGE_NAME"
}

installed_release_apk_exact() {
  local manifest="$NEW_RELEASE/manifest.json"
  local expected_code expected_signer expected_sha code signer
  local probe="$STAGE/installed-role-proof.apk"
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  expected_code="$(manifest_value "$manifest" android.versionCode)" || return 1
  expected_signer="$(manifest_value "$manifest" android.signerSha256)" || return 1
  expected_sha="$(manifest_value "$manifest" android.sha256)" || return 1
  code="$(installed_apk_version_code)" || return 1
  backup_installed_apk "$probe" || return 1
  signer="$(apk_signer_sha256 "$probe" 2>/dev/null || true)"
  [ "$code" = "$expected_code" ] \
    && [ "$signer" = "$expected_signer" ] \
    && [ "$(sha256_file "$probe")" = "$expected_sha" ]
}

android_assistant_components_match() {
  local user_id="$1" assistant voice
  assistant="$(read_android_assistant_setting "$user_id")" || return 1
  voice="$(read_android_voice_setting "$user_id")" || return 1
  case "$assistant" in
    "$PACKAGE_NAME/.EvogentVoiceInteractionService"|\
    "$PACKAGE_NAME/$PACKAGE_NAME.EvogentVoiceInteractionService") ;;
    *) return 1 ;;
  esac
  case "$voice" in
    "$PACKAGE_NAME/.EvogentVoiceInteractionService"|\
    "$PACKAGE_NAME/$PACKAGE_NAME.EvogentVoiceInteractionService") ;;
    *) return 1 ;;
  esac
}

android_home_component_matches() {
  local user_id="$1" component
  component="$(read_android_home_component "$user_id")" || return 1
  case "$component" in
    "$PACKAGE_NAME/.MainActivity"|"$PACKAGE_NAME/$PACKAGE_NAME.MainActivity")
      return 0
      ;;
    *) return 1 ;;
  esac
}

wait_for_release_assistant_activation() {
  local stable=0
  for _ in $(seq 1 30); do
    if android_role_matches_release \
        "$ANDROID_ASSISTANT_ROLE" "$ANDROID_ROLE_USER_ID" \
        && android_assistant_components_match "$ANDROID_ROLE_USER_ID"; then
      stable=$((stable + 1))
      [ "$stable" -ge 3 ] && return 0
    else
      stable=0
    fi
    sleep 1
  done
  return 1
}

verify_release_android_roles() {
  local user_id="${1:-}" stable=0
  android_role_state_helper_safe || return 1
  if [ -z "$user_id" ]; then
    user_id="$(read_android_current_user)" || return 1
  fi
  for _ in $(seq 1 30); do
    if android_role_matches_release "$ANDROID_ASSISTANT_ROLE" "$user_id" \
        && android_role_matches_release "$ANDROID_HOME_ROLE" "$user_id" \
        && android_assistant_components_match "$user_id" \
        && android_home_component_matches "$user_id"; then
      stable=$((stable + 1))
      [ "$stable" -ge 3 ] && return 0
    else
      stable=0
    fi
    sleep 1
  done
  return 1
}

android_roles_have_only_allowed_post_apk_drift() {
  local role current prior status
  validate_android_role_backup || return 1
  for role in "$ANDROID_ASSISTANT_ROLE" "$ANDROID_HOME_ROLE"; do
    current="$(
      read_android_role_holders "$role" "$ANDROID_ROLE_USER_ID"
    )" || return 1
    if printf '%s\n' "$current" \
        | python3 "$ANDROID_ROLE_STATE_HELPER" compare-snapshot \
          --snapshot "$ANDROID_ROLE_BACKUP" \
          --sha256 "$ANDROID_ROLE_BACKUP_SHA256" \
          --user-id "$ANDROID_ROLE_USER_ID" \
          --role "$role" >/dev/null; then
      status=0
    else
      status=$?
    fi
    [ "$status" = 0 ] && continue
    [ "$status" = 1 ] || return 1
    prior="$(android_role_snapshot_holder "$role")" || return 1
    [ "$prior" = "$PACKAGE_NAME" ] && [ -z "$current" ] || return 1
  done
}

assign_release_android_roles() {
  installed_release_apk_exact \
    && validate_android_role_backup \
    && android_roles_have_only_allowed_post_apk_drift || return 1
  if verify_release_android_roles "$ANDROID_ROLE_USER_ID"; then
    ANDROID_ROLES_APPLIED=1
    write_transaction_journal roles_applied
    return
  fi

  ANDROID_ROLE_RESTORE_REQUIRED=1
  ANDROID_ROLE_MUTATION_ATTEMPTED=1
  write_transaction_journal role_assignment_pending || return 1

  rish_command \
    "cmd role add-role-holder --user '$ANDROID_ROLE_USER_ID' '$ANDROID_ASSISTANT_ROLE' '$PACKAGE_NAME'" \
    60 >/dev/null 2>&1 || return 1
  wait_for_release_assistant_activation || return 1

  rish_command \
    "cmd role add-role-holder --user '$ANDROID_ROLE_USER_ID' '$ANDROID_HOME_ROLE' '$PACKAGE_NAME'" \
    60 >/dev/null 2>&1 || return 1
  verify_release_android_roles "$ANDROID_ROLE_USER_ID" || return 1
  ANDROID_ROLES_APPLIED=1
  write_transaction_journal roles_applied
}

converge_committed_android_roles() {
  [ "$ANDROID_ROLES_APPLIED" = 1 ] \
    && installed_release_apk_exact || return 1
  verify_release_android_roles "$ANDROID_ROLE_USER_ID" && return 0
  rish_command \
    "cmd role add-role-holder --user '$ANDROID_ROLE_USER_ID' '$ANDROID_ASSISTANT_ROLE' '$PACKAGE_NAME'" \
    60 >/dev/null 2>&1 || return 1
  wait_for_release_assistant_activation || return 1
  rish_command \
    "cmd role add-role-holder --user '$ANDROID_ROLE_USER_ID' '$ANDROID_HOME_ROLE' '$PACKAGE_NAME'" \
    60 >/dev/null 2>&1 || return 1
  verify_release_android_roles "$ANDROID_ROLE_USER_ID"
}

restore_android_role_from_snapshot() {
  local role="$1" holder
  android_role_name_valid "$role" || return 1
  if android_role_matches_snapshot "$role"; then
    return 0
  else
    [ "$?" = 1 ] || return 1
  fi
  holder="$(android_role_snapshot_holder "$role")" || return 1
  if [ -n "$holder" ]; then
    rish_command \
      "cmd role add-role-holder --user '$ANDROID_ROLE_USER_ID' '$role' '$holder'" \
      60 >/dev/null 2>&1
  else
    rish_command \
      "cmd role clear-role-holders --user '$ANDROID_ROLE_USER_ID' '$role'" \
      60 >/dev/null 2>&1
  fi
}

restore_android_roles() {
  local stable=0
  [ "$ANDROID_ROLE_RESTORE_REQUIRED" = 1 ] || return 0
  validate_android_role_backup || return 1
  # Restore HOME first so an exclusive replacement never creates an avoidable
  # period without the user's prior launcher.
  restore_android_role_from_snapshot "$ANDROID_HOME_ROLE" || return 1
  restore_android_role_from_snapshot "$ANDROID_ASSISTANT_ROLE" || return 1
  for _ in $(seq 1 30); do
    if android_role_matches_snapshot "$ANDROID_HOME_ROLE" \
        && android_role_matches_snapshot "$ANDROID_ASSISTANT_ROLE"; then
      stable=$((stable + 1))
      [ "$stable" -ge 3 ] && return 0
    else
      stable=0
    fi
    sleep 1
  done
  return 1
}

backup_database() {
  local source="$1" output="$2"
  DB_BACKUP_READY=0
  DB_EXISTED=0
  if [ ! -e "$source" ] && [ ! -L "$source" ]; then
    [ ! -e "$source-wal" ] && [ ! -L "$source-wal" ] \
      && [ ! -e "$source-shm" ] && [ ! -L "$source-shm" ] || return 1
    : > "$BACKUP_DIR/media-agent.absent" || return 1
    chmod 600 "$BACKUP_DIR/media-agent.absent" || return 1
    fsync_regular_file_and_parent "$BACKUP_DIR/media-agent.absent" || return 1
    DB_BACKUP_READY=1
    return 0
  fi
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  DB_EXISTED=1
  python3 - "$source" "$output" <<'PY'
import sqlite3
import sys

source, output = sys.argv[1:]
src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
dst = sqlite3.connect(output)
src.backup(dst)
dst.close()
src.close()
check = sqlite3.connect(f"file:{output}?mode=ro", uri=True)
result = check.execute("PRAGMA quick_check").fetchone()[0]
check.close()
if result != "ok":
    raise SystemExit(f"database backup quick_check failed: {result}")
PY
  chmod 600 "$output"
  fsync_regular_file_and_parent "$output"
  DB_BACKUP_READY=1
}

transaction_rollback_temp_path() {
  python3 - "$1" "$MIGRATION_DIR" "$2" <<'PY'
import hashlib
import pathlib
import sys

target, migration, kind = sys.argv[1:]
if kind not in {"database", "control-token"} or not migration:
    raise SystemExit("invalid transaction rollback temporary")
nonce = hashlib.sha256(migration.encode()).hexdigest()[:32]
path = pathlib.Path(target)
print(path.parent / f".evogent-{kind}-rollback.{nonce}.pending")
PY
}

remove_transaction_rollback_temp() {
  local target="$1" kind="$2" temporary parent
  temporary="$(transaction_rollback_temp_path "$target" "$kind")" || return 1
  parent="$(dirname "$temporary")"
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 0
  if [ ! -e "$temporary" ] && [ ! -L "$temporary" ]; then
    return 0
  fi
  [ -f "$temporary" ] && [ ! -L "$temporary" ] \
    && [ "$(stat -c '%a' "$temporary")" = 600 ] || return 1
  rm -f -- "$temporary" || return 1
  fsync_directory "$parent"
}

reap_transaction_rollback_temps() {
  local relative target
  [ -n "$MIGRATION_DIR" ] || return 1
  for relative in media-agent.db control-token.txt; do
    for target in \
      "$STATE/data/$relative" \
      "$HOME/evogent/data/$relative" \
      "$MIGRATION_DIR/evogent/data/$relative"; do
      case "$relative" in
        media-agent.db)
          remove_transaction_rollback_temp "$target" database || return 1
          ;;
        control-token.txt)
          remove_transaction_rollback_temp "$target" control-token || return 1
          ;;
      esac
    done
  done
}

restore_database() {
  local target="${1:-$STATE/data/media-agent.db}" temp
  [ "$DB_BACKUP_READY" = 1 ] || return 0
  if [ "$DB_EXISTED" = 0 ]; then
    [ -f "$BACKUP_DIR/media-agent.absent" ] \
      && [ ! -L "$BACKUP_DIR/media-agent.absent" ] \
      && [ ! -s "$BACKUP_DIR/media-agent.absent" ] \
      && [ "$(stat -c '%a' "$BACKUP_DIR/media-agent.absent")" = 600 ] || {
        say "CRITICAL: proven database absence marker is missing or unsafe"
        return 1
      }
    reap_transaction_rollback_temps || return 1
    if [ -d "$(dirname "$target")" ]; then
      [ ! -L "$target" ] || return 1
      rm -f -- "$target" "$target-wal" "$target-shm" || return 1
      fsync_directory "$(dirname "$target")" || return 1
    fi
    return 0
  fi
  [ "$DB_EXISTED" = 1 ] \
    && [ -n "$DB_BACKUP" ] && [ -f "$DB_BACKUP" ] \
    && [ ! -L "$DB_BACKUP" ] \
    && [ "$(stat -c '%a' "$DB_BACKUP")" = 600 ] || {
    say "CRITICAL: proven database backup is missing or unsafe"
    return 1
  }
  python3 - "$DB_BACKUP" <<'PY' || return 1
import sqlite3
import sys

database = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
result = database.execute("PRAGMA quick_check").fetchone()[0]
database.close()
if result != "ok":
    raise SystemExit(f"database rollback quick_check failed: {result}")
PY
  reap_transaction_rollback_temps || return 1
  mkdir -p "$(dirname "$target")" || return 1
  temp="$(transaction_rollback_temp_path "$target" database)" || return 1
  if ! cp "$DB_BACKUP" "$temp" \
      || ! chmod 600 "$temp" \
      || ! cmp -s "$DB_BACKUP" "$temp" \
      || ! rm -f "$target-wal" "$target-shm" \
      || ! mv -f "$temp" "$target" \
      || ! fsync_regular_file_and_parent "$target" \
      || ! cmp -s "$DB_BACKUP" "$target"; then
    rm -f -- "$temp" 2>/dev/null || true
    return 1
  fi
  python3 - "$target" <<'PY'
import sqlite3
import sys

database = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
result = database.execute("PRAGMA quick_check").fetchone()[0]
database.close()
if result != "ok":
    raise SystemExit(1)
PY
}

record_default_seed_intent() {
  python3 - "$1" "$STATE/data" "$BACKUP_DIR/seeded-defaults" "$2" <<'PY'
import hashlib
import json
import os
import pathlib
import secrets
import stat
import sys

source, raw_state, raw_intents, raw_relative = sys.argv[1:]
state = pathlib.Path(raw_state)
intents = pathlib.Path(raw_intents)
relative = pathlib.PurePosixPath(raw_relative)
if (
    relative.is_absolute()
    or not relative.parts
    or any(part in {"", ".", ".."} for part in relative.parts)
):
    raise SystemExit("unsafe default seed path")
source_path = pathlib.Path(source)
source_descriptor = os.open(
    source_path,
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0),
)
try:
    source_stat = os.fstat(source_descriptor)
    if not stat.S_ISREG(source_stat.st_mode):
        raise SystemExit("default seed source is not regular")
    hasher = hashlib.sha256()
    while True:
        chunk = os.read(source_descriptor, 1024 * 1024)
        if not chunk:
            break
        hasher.update(chunk)
    source_after = os.fstat(source_descriptor)
finally:
    os.close(source_descriptor)
identity_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
if any(
    getattr(source_stat, field) != getattr(source_after, field)
    for field in identity_fields
):
    raise SystemExit("default seed source changed while hashing")
state_stat = os.lstat(state)
if not stat.S_ISDIR(state_stat.st_mode) or stat.S_ISLNK(state_stat.st_mode):
    raise SystemExit("default seed state root is unsafe")

target = state.joinpath(*relative.parts)
if os.path.lexists(target):
    raise SystemExit("default seed destination already exists")
missing_parents = []
cursor = state
for part in relative.parts[:-1]:
    cursor /= part
    try:
        metadata = os.lstat(cursor)
    except FileNotFoundError:
        missing_parents.append(cursor.relative_to(state).as_posix())
        continue
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit("default seed parent is unsafe")

base_payload = {
    "schema": "evogent.phone.seeded-default.v3",
    "relative": relative.as_posix(),
    "sha256": hasher.hexdigest(),
    "size": source_stat.st_size,
    "missingParents": missing_parents,
}
intents.mkdir(mode=0o700, parents=True, exist_ok=True)
intent_stat = os.lstat(intents)
if not stat.S_ISDIR(intent_stat.st_mode) or stat.S_ISLNK(intent_stat.st_mode):
    raise SystemExit("default seed intent directory is unsafe")
marker = intents / f"{hashlib.sha256(relative.as_posix().encode()).hexdigest()}.json"
if os.path.lexists(marker):
    marker_stat = os.lstat(marker)
    if not stat.S_ISREG(marker_stat.st_mode) or stat.S_IMODE(marker_stat.st_mode) != 0o600:
        raise SystemExit("default seed intent is unsafe")
    payload = json.loads(marker.read_text(encoding="utf-8"))
    temporary_relative = pathlib.PurePosixPath(payload.get("temporary", ""))
    if (
        any(payload.get(key) != value for key, value in base_payload.items())
        or temporary_relative.parent != relative.parent
        or not temporary_relative.name.startswith(".evogent-seed-")
        or not temporary_relative.name.endswith(".tmp")
        or len(temporary_relative.name) != len(".evogent-seed-") + 32 + len(".tmp")
        or any(
            character not in "0123456789abcdef"
            for character in temporary_relative.name[
                len(".evogent-seed-") : -len(".tmp")
            ]
        )
        or payload.get("phase") not in {"intent", "copying", "prepared", "published"}
        or not isinstance(payload.get("createdParents"), list)
        or (
            payload.get("temporaryIdentity") is not None
            and not isinstance(payload.get("temporaryIdentity"), dict)
        )
        or (
            payload.get("publishedIdentity") is not None
            and not isinstance(payload.get("publishedIdentity"), dict)
        )
    ):
        raise SystemExit("default seed intent changed")
    print(temporary_relative.as_posix())
    raise SystemExit(0)
while True:
    temporary_relative = relative.parent / (
        f".evogent-seed-{secrets.token_hex(16)}.tmp"
    )
    if not os.path.lexists(state.joinpath(*temporary_relative.parts)):
        break
payload = dict(
    base_payload,
    temporary=temporary_relative.as_posix(),
    phase="intent",
    temporaryIdentity=None,
    publishedIdentity=None,
    createdParents=[],
)
temporary = marker.with_suffix(".json.new")
try:
    temporary.unlink()
except FileNotFoundError:
    pass
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, 0o600)
os.replace(temporary, marker)
descriptor = os.open(intents, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
descriptor = os.open(intents.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
print(temporary_relative.as_posix())
PY
}

publish_recorded_default_seed() {
  python3 - "$1" "$STATE/data" "$BACKUP_DIR/seeded-defaults" "$2" <<'PY'
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import stat
import sys

source, raw_state, raw_intents, raw_relative = sys.argv[1:]
state = pathlib.Path(raw_state)
intents = pathlib.Path(raw_intents)
relative = pathlib.PurePosixPath(raw_relative)
if (
    relative.is_absolute()
    or not relative.parts
    or any(part in {"", ".", ".."} for part in relative.parts)
):
    raise SystemExit("unsafe default seed publication path")
marker = intents / f"{hashlib.sha256(relative.as_posix().encode()).hexdigest()}.json"
marker_stat = os.lstat(marker)
if not stat.S_ISREG(marker_stat.st_mode) or stat.S_IMODE(marker_stat.st_mode) != 0o600:
    raise SystemExit("default seed publication intent is unsafe")
payload = json.loads(marker.read_text(encoding="utf-8"))
expected_digest = payload.get("sha256")
expected_size = payload.get("size")
temporary_relative = pathlib.PurePosixPath(payload.get("temporary", ""))
temporary_token = (
    temporary_relative.name[len(".evogent-seed-") : -len(".tmp")]
    if temporary_relative.name.startswith(".evogent-seed-")
    and temporary_relative.name.endswith(".tmp")
    else ""
)
if (
    payload.get("schema") != "evogent.phone.seeded-default.v3"
    or payload.get("relative") != relative.as_posix()
    or not isinstance(expected_digest, str)
    or len(expected_digest) != 64
    or any(character not in "0123456789abcdef" for character in expected_digest)
    or type(expected_size) is not int
    or expected_size < 0
    or temporary_relative.parent != relative.parent
    or len(temporary_token) != 32
    or any(character not in "0123456789abcdef" for character in temporary_token)
    or payload.get("phase") not in {"intent", "copying", "prepared", "published"}
    or not isinstance(payload.get("createdParents"), list)
    or (
        payload.get("temporaryIdentity") is not None
        and not isinstance(payload.get("temporaryIdentity"), dict)
    )
    or (
        payload.get("publishedIdentity") is not None
        and not isinstance(payload.get("publishedIdentity"), dict)
    )
):
    raise SystemExit("default seed publication intent is invalid")
temporary_identity = payload.get("temporaryIdentity")
if temporary_identity is not None and (
    not isinstance(temporary_identity, dict)
    or set(temporary_identity) != {"device", "inode"}
    or type(temporary_identity.get("device")) is not int
    or type(temporary_identity.get("inode")) is not int
    or temporary_identity["device"] < 0
    or temporary_identity["inode"] <= 0
):
    raise SystemExit("default seed publication inode identity is invalid")
published_identity = payload.get("publishedIdentity")
if published_identity is not None and (
    not isinstance(published_identity, dict)
    or set(published_identity)
    != {"device", "inode", "size", "mode", "uid", "gid", "mtimeNs"}
    or any(
        type(published_identity.get(key)) is not int
        for key in published_identity
    )
    or published_identity["device"] < 0
    or published_identity["inode"] <= 0
    or published_identity["size"] < 0
    or published_identity["mode"] < 0
    or published_identity["mode"] > 0o7777
    or published_identity["uid"] < 0
    or published_identity["gid"] < 0
    or published_identity["mtimeNs"] < 0
):
    raise SystemExit("default seed publication generation is invalid")
if (
    payload["phase"] in {"prepared", "published"}
) != (published_identity is not None):
    raise SystemExit("default seed publication phase lacks generation proof")
if (
    payload["phase"] in {"copying", "prepared", "published"}
) != (temporary_identity is not None):
    raise SystemExit("default seed publication phase lacks inode proof")
seen_created_parents = set()
for entry in payload["createdParents"]:
    parent_relative = (
        pathlib.PurePosixPath(entry.get("relative", ""))
        if isinstance(entry, dict)
        else pathlib.PurePosixPath()
    )
    if (
        not isinstance(entry, dict)
        or set(entry) != {"relative", "device", "inode"}
        or parent_relative.is_absolute()
        or not parent_relative.parts
        or any(part in {"", ".", ".."} for part in parent_relative.parts)
        or len(parent_relative.parts) >= len(relative.parts)
        or relative.parts[: len(parent_relative.parts)] != parent_relative.parts
        or type(entry.get("device")) is not int
        or type(entry.get("inode")) is not int
        or entry["device"] < 0
        or entry["inode"] <= 0
        or parent_relative.as_posix() in seen_created_parents
    ):
        raise SystemExit("default seed publication created-parent identity is invalid")
    seen_created_parents.add(parent_relative.as_posix())

def persist_payload():
    update = marker.with_suffix(".json.new")
    try:
        update.unlink()
    except FileNotFoundError:
        pass
    with open(update, "x", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(update, 0o600)
    os.replace(update, marker)
    descriptor = os.open(intents, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def rename_noreplace(source_dir, source, destination_dir, destination):
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
            source_dir,
            os.fsencode(source),
            destination_dir,
            os.fsencode(destination),
            1,
        )
        if result != 0:
            error = ctypes.get_errno()
            if error in {errno.ENOENT, errno.EEXIST, errno.ENOTEMPTY}:
                raise OSError(error, os.strerror(error))
            raise OSError(error, os.strerror(error))
        return
    try:
        os.stat(destination, dir_fd=destination_dir, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError(destination)
    os.rename(
        source,
        destination,
        src_dir_fd=source_dir,
        dst_dir_fd=destination_dir,
    )

directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
opened_directories = []
state_descriptor = os.open(state, directory_flags)
opened_directories.append(state_descriptor)
parent_descriptor = state_descriptor
try:
    for part in relative.parts[:-1]:
        try:
            os.mkdir(part, mode=0o700, dir_fd=parent_descriptor)
        except FileExistsError:
            pass
        else:
            os.fsync(parent_descriptor)
        child_descriptor = os.open(part, directory_flags, dir_fd=parent_descriptor)
        opened_directories.append(child_descriptor)
        parent_descriptor = child_descriptor

    target_name = relative.name
    temporary_name = temporary_relative.name
    try:
        os.stat(target_name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise SystemExit("default seed destination appeared before publication")
    try:
        os.stat(temporary_name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise SystemExit("default seed transaction temporary already exists")

    source_descriptor = os.open(
        source,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    temporary_descriptor = -1
    try:
        source_before = os.fstat(source_descriptor)
        if not stat.S_ISREG(source_before.st_mode):
            raise SystemExit("default seed source is not regular")
        temporary_descriptor = os.open(
            temporary_name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=parent_descriptor,
        )
        temporary_identity = os.fstat(temporary_descriptor)
        payload["temporaryIdentity"] = {
            "device": temporary_identity.st_dev,
            "inode": temporary_identity.st_ino,
        }
        payload["phase"] = "copying"
        persist_payload()
        hasher = hashlib.sha256()
        copied = 0
        while True:
            chunk = os.read(source_descriptor, 1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
            copied += len(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(temporary_descriptor, view)
                view = view[written:]
        os.fsync(temporary_descriptor)
        source_after = os.fstat(source_descriptor)
        temporary_stat = os.fstat(temporary_descriptor)
    finally:
        if temporary_descriptor >= 0:
            os.close(temporary_descriptor)
        os.close(source_descriptor)

    identity_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    if (
        any(
            getattr(source_before, field) != getattr(source_after, field)
            for field in identity_fields
        )
        or copied != expected_size
        or temporary_stat.st_size != expected_size
        or hasher.hexdigest() != expected_digest
    ):
        raise SystemExit("default seed source changed or copy verification failed")
    # Persist the complete, fsynced inode generation before publication. Rename
    # preserves these fields, so rollback can authenticate either the temporary
    # name or the final name after a crash in the rename -> phase-update window.
    payload["publishedIdentity"] = {
        "device": temporary_stat.st_dev,
        "inode": temporary_stat.st_ino,
        "size": temporary_stat.st_size,
        "mode": stat.S_IMODE(temporary_stat.st_mode),
        "uid": temporary_stat.st_uid,
        "gid": temporary_stat.st_gid,
        "mtimeNs": temporary_stat.st_mtime_ns,
    }
    payload["phase"] = "prepared"
    persist_payload()

    # Android deliberately omits Python's hard-link wrapper. renameat2 is an
    # atomic same-directory, no-clobber publication there, and the journaled
    # inode identity makes either pre- or post-rename crash state recoverable.
    rename_noreplace(
        parent_descriptor,
        temporary_name,
        parent_descriptor,
        target_name,
    )
    os.fsync(parent_descriptor)
    published_descriptor = os.open(
        target_name,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=parent_descriptor,
    )
    try:
        published_before = os.fstat(published_descriptor)
        published_hasher = hashlib.sha256()
        while True:
            chunk = os.read(published_descriptor, 1024 * 1024)
            if not chunk:
                break
            published_hasher.update(chunk)
        published_after = os.fstat(published_descriptor)
    finally:
        os.close(published_descriptor)
    if (
        not stat.S_ISREG(published_before.st_mode)
        or any(
            getattr(published_before, field) != getattr(published_after, field)
            for field in identity_fields
        )
        or (
            published_after.st_dev,
            published_after.st_ino,
        )
        != (
            temporary_identity.st_dev,
            temporary_identity.st_ino,
        )
        or published_after.st_size != expected_size
        or published_hasher.hexdigest() != expected_digest
        or any(
            payload["publishedIdentity"][key] != value
            for key, value in {
                "device": published_after.st_dev,
                "inode": published_after.st_ino,
                "size": published_after.st_size,
                "mode": stat.S_IMODE(published_after.st_mode),
                "uid": published_after.st_uid,
                "gid": published_after.st_gid,
                "mtimeNs": published_after.st_mtime_ns,
            }.items()
        )
    ):
        raise SystemExit("default seed publication proof failed")
    payload["phase"] = "published"
    persist_payload()
finally:
    for descriptor in reversed(opened_directories):
        os.close(descriptor)
PY
}

seed_missing_public_defaults() {
  local defaults_root="$1" relative destination
  if [ ! -e "$defaults_root" ] && [ ! -L "$defaults_root" ]; then
    return 0
  fi
  [ -d "$defaults_root" ] && [ ! -L "$defaults_root" ] || {
    say "phone release default-data root is unsafe"
    return 1
  }
  while IFS= read -r -d '' relative; do
    destination="$STATE/data/${relative#./}"
    # Existing private state, including a defensive dangling symlink, is never
    # followed or replaced by a public bootstrap. Its consumer remains
    # responsible for rejecting unsafe or invalid private artifacts.
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      continue
    fi
    record_default_seed_intent \
      "$defaults_root/${relative#./}" "${relative#./}" >/dev/null
    publish_recorded_default_seed \
      "$defaults_root/${relative#./}" "${relative#./}"
  done < <(cd "$defaults_root" && find . -type f -print0)
}

rollback_seeded_defaults() {
  local intents="$BACKUP_DIR/seeded-defaults"
  [ -n "$BACKUP_DIR" ] || return 0
  [ -e "$intents" ] || [ -L "$intents" ] || return 0
  python3 - "$intents" "$STATE/data" <<'PY'
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import stat
import sys

intents, state = map(pathlib.Path, sys.argv[1:])
directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
file_flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
backup_descriptor = os.open(intents.parent, directory_flags)
intents_descriptor = os.open(intents.name, directory_flags, dir_fd=backup_descriptor)
state_descriptor = None
quarantine_descriptor = None
quarantine_name = "rollback-quarantine"
intents_metadata = os.fstat(intents_descriptor)
if (
    not stat.S_ISDIR(intents_metadata.st_mode)
    or stat.S_IMODE(intents_metadata.st_mode) != 0o700
    or intents_metadata.st_uid != os.geteuid()
):
    raise SystemExit("seeded-default rollback intent directory is unsafe")

def valid_relative(raw):
    if not isinstance(raw, str):
        return None
    candidate = pathlib.PurePosixPath(raw)
    if (
        candidate.is_absolute()
        or not candidate.parts
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
        return None
    return candidate

def valid_identity(raw):
    if not isinstance(raw, dict) or set(raw) != {"device", "inode"}:
        return None
    device = raw.get("device")
    inode = raw.get("inode")
    if type(device) is not int or type(inode) is not int or device < 0 or inode <= 0:
        return None
    return device, inode

def matches_identity(metadata, identity):
    return identity is not None and (metadata.st_dev, metadata.st_ino) == identity

def matches_generation(metadata, generation):
    return generation is not None and (
        metadata.st_dev == generation["device"]
        and metadata.st_ino == generation["inode"]
        and metadata.st_size == generation["size"]
        and stat.S_IMODE(metadata.st_mode) == generation["mode"]
        and metadata.st_uid == generation["uid"]
        and metadata.st_gid == generation["gid"]
        and metadata.st_mtime_ns == generation["mtimeNs"]
    )

def open_parent(relative):
    global state_descriptor
    if state_descriptor is None:
        state_descriptor = os.open(state, directory_flags)
    descriptor = os.dup(state_descriptor)
    try:
        for part in relative.parts[:-1]:
            child = os.open(part, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except FileNotFoundError:
        os.close(descriptor)
        return None
    except Exception:
        os.close(descriptor)
        raise

def ensure_quarantine():
    global quarantine_descriptor
    if quarantine_descriptor is not None:
        return quarantine_descriptor
    try:
        os.mkdir(quarantine_name, mode=0o700, dir_fd=intents_descriptor)
    except FileExistsError:
        pass
    metadata = os.stat(
        quarantine_name,
        dir_fd=intents_descriptor,
        follow_symlinks=False,
    )
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o700
        or metadata.st_uid != os.geteuid()
    ):
        raise SystemExit("seeded-default rollback quarantine is unsafe")
    quarantine_descriptor = os.open(
        quarantine_name,
        directory_flags,
        dir_fd=intents_descriptor,
    )
    opened = os.fstat(quarantine_descriptor)
    if (
        (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino)
        or not stat.S_ISDIR(opened.st_mode)
        or stat.S_IMODE(opened.st_mode) != 0o700
        or opened.st_uid != os.geteuid()
    ):
        os.close(quarantine_descriptor)
        quarantine_descriptor = None
        raise SystemExit("seeded-default rollback quarantine changed while opening")
    os.fsync(intents_descriptor)
    return quarantine_descriptor

def rename_noreplace(source_dir, source, destination_dir, destination):
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
            source_dir,
            os.fsencode(source),
            destination_dir,
            os.fsencode(destination),
            1,
        )
        if result != 0:
            error = ctypes.get_errno()
            if error in {errno.ENOENT, errno.EEXIST, errno.ENOTEMPTY}:
                raise OSError(error, os.strerror(error))
            raise OSError(error, os.strerror(error))
        return
    try:
        os.stat(destination, dir_fd=destination_dir, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError(destination)
    os.rename(
        source,
        destination,
        src_dir_fd=source_dir,
        dst_dir_fd=destination_dir,
    )

def hash_regular(descriptor):
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode):
        return None
    hasher = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        hasher.update(chunk)
    after = os.fstat(descriptor)
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    if any(getattr(before, field) != getattr(after, field) for field in fields):
        return None
    return after, hasher.hexdigest()

def restore_quarantined(parent, name, quarantine, staged):
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise SystemExit("seeded-default rollback target raced restoration")
    rename_noreplace(quarantine, staged, parent, name)
    os.fsync(quarantine)
    os.fsync(parent)

def recover_quarantined_regular(
    parent,
    name,
    identity,
    staged,
    digest=None,
    size=None,
    generation=None,
):
    quarantine = ensure_quarantine()
    try:
        metadata = os.stat(staged, dir_fd=quarantine, follow_symlinks=False)
    except FileNotFoundError:
        return "absent"
    if not stat.S_ISREG(metadata.st_mode) or not matches_identity(metadata, identity):
        raise SystemExit("seeded-default rollback quarantine collision")
    try:
        descriptor = os.open(staged, file_flags, dir_fd=quarantine)
    except OSError as error:
        raise SystemExit(
            f"seeded-default rollback quarantine is unreadable: {error}"
        )
    try:
        hashed = hash_regular(descriptor)
    finally:
        os.close(descriptor)
    if hashed is None or not matches_identity(hashed[0], identity):
        raise SystemExit("seeded-default rollback quarantine changed")
    accepted = digest is None or (
        matches_generation(hashed[0], generation)
        and hashed[0].st_size == size
        and hashed[1] == digest
    )
    if accepted:
        os.unlink(staged, dir_fd=quarantine)
        os.fsync(quarantine)
        return "removed"

    try:
        endpoint = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        restore_quarantined(parent, name, quarantine, staged)
        return "preserved"
    if stat.S_ISREG(endpoint.st_mode) and matches_identity(endpoint, identity):
        # A hard-link publication can leave the same modified inode at both
        # names. Removing only the quarantine alias preserves the user's bytes.
        os.unlink(staged, dir_fd=quarantine)
        os.fsync(quarantine)
        return "preserved"
    raise SystemExit(
        "seeded-default rollback cannot restore modified quarantined content"
    )

def remove_owned_regular(
    parent,
    name,
    identity,
    staged,
    digest=None,
    size=None,
    generation=None,
):
    recovered = recover_quarantined_regular(
        parent,
        name,
        identity,
        staged,
        digest,
        size,
        generation,
    )
    if recovered == "preserved":
        return
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (
        not stat.S_ISREG(metadata.st_mode)
        or not matches_identity(metadata, identity)
        or (digest is not None and not matches_generation(metadata, generation))
    ):
        return
    quarantine = ensure_quarantine()
    rename_noreplace(parent, name, quarantine, staged)
    os.fsync(parent)
    os.fsync(quarantine)
    recover_quarantined_regular(
        parent,
        name,
        identity,
        staged,
        digest,
        size,
        generation,
    )

def read_intent_payload(name):
    descriptor = os.open(name, file_flags, dir_fd=intents_descriptor)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid != os.geteuid()
            or metadata.st_size > 131072
        ):
            raise SystemExit("seeded-default intent update is unsafe")
        raw = os.read(descriptor, metadata.st_size + 1)
        if len(raw) != metadata.st_size:
            raise SystemExit("seeded-default intent update changed while reading")
    finally:
        os.close(descriptor)
    try:
        return metadata, json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return metadata, None

def validate_v3_payload(payload, marker_name):
    if not isinstance(payload, dict):
        return False
    relative = valid_relative(payload.get("relative"))
    temporary = valid_relative(payload.get("temporary"))
    digest = payload.get("sha256")
    size = payload.get("size")
    missing = payload.get("missingParents")
    phase = payload.get("phase")
    temporary_identity = payload.get("temporaryIdentity")
    published = payload.get("publishedIdentity")
    created = payload.get("createdParents")
    if (
        payload.get("schema") != "evogent.phone.seeded-default.v3"
        or relative is None
        or marker_name
        != f"{hashlib.sha256(relative.as_posix().encode()).hexdigest()}.json"
        or not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
        or type(size) is not int
        or size < 0
        or not isinstance(missing, list)
        or any(valid_relative(value) is None for value in missing)
        or temporary is None
        or temporary.parent != relative.parent
        or not temporary.name.startswith(".evogent-seed-")
        or not temporary.name.endswith(".tmp")
        or len(temporary.name) != len(".evogent-seed-") + 32 + len(".tmp")
        or any(
            character not in "0123456789abcdef"
            for character in temporary.name[
                len(".evogent-seed-") : -len(".tmp")
            ]
        )
        or phase not in {"intent", "copying", "prepared", "published"}
        or not isinstance(created, list)
    ):
        return False
    parsed_temporary = (
        None if temporary_identity is None else valid_identity(temporary_identity)
    )
    if temporary_identity is not None and parsed_temporary is None:
        return False
    if phase in {"copying", "prepared", "published"} and parsed_temporary is None:
        return False
    if phase == "intent" and parsed_temporary is not None:
        return False
    if published is not None:
        if (
            not isinstance(published, dict)
            or set(published)
            != {"device", "inode", "size", "mode", "uid", "gid", "mtimeNs"}
            or any(type(published.get(key)) is not int for key in published)
            or published["device"] < 0
            or published["inode"] <= 0
            or published["size"] < 0
            or published["mode"] < 0
            or published["mode"] > 0o7777
            or published["uid"] < 0
            or published["gid"] < 0
            or published["mtimeNs"] < 0
            or (published["device"], published["inode"]) != parsed_temporary
        ):
            return False
    if (phase in {"prepared", "published"}) != (published is not None):
        return False
    seen = set()
    for entry in created:
        if not isinstance(entry, dict) or set(entry) != {"relative", "device", "inode"}:
            return False
        parent = valid_relative(entry.get("relative"))
        identity = valid_identity(
            {"device": entry.get("device"), "inode": entry.get("inode")}
        )
        if (
            parent is None
            or identity is None
            or len(parent.parts) >= len(relative.parts)
            or relative.parts[: len(parent.parts)] != parent.parts
            or parent.as_posix() in seen
        ):
            return False
        seen.add(parent.as_posix())
    return True

def intent_updates_monotonic(stable, update):
    immutable = (
        "schema",
        "relative",
        "sha256",
        "size",
        "missingParents",
        "temporary",
    )
    if any(stable.get(key) != update.get(key) for key in immutable):
        return False
    phases = {"intent": 0, "copying": 1, "prepared": 2, "published": 3}
    if phases[update["phase"]] < phases[stable["phase"]]:
        return False
    stable_created = stable.get("createdParents", [])
    update_created = update.get("createdParents", [])
    if update_created[: len(stable_created)] != stable_created:
        return False
    stable_temporary = stable.get("temporaryIdentity")
    update_temporary = update.get("temporaryIdentity")
    if stable_temporary is not None and update_temporary != stable_temporary:
        return False
    stable_published = stable.get("publishedIdentity")
    update_published = update.get("publishedIdentity")
    if stable_published is not None and update_published != stable_published:
        return False
    return True

def unlink_if_unchanged(name, observed):
    current = os.stat(name, dir_fd=intents_descriptor, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (observed.st_dev, observed.st_ino):
        raise SystemExit("seeded-default intent update changed before cleanup")
    os.unlink(name, dir_fd=intents_descriptor)
    os.fsync(intents_descriptor)

def promote_durable_intent_updates():
    for update_name in sorted(os.listdir(intents_descriptor)):
        if not update_name.endswith(".json.new"):
            continue
        stable_name = update_name[:-4]
        update_metadata, update = read_intent_payload(update_name)
        if update is None:
            unlink_if_unchanged(update_name, update_metadata)
            continue
        if not validate_v3_payload(update, stable_name):
            raise SystemExit("seeded-default durable intent update is invalid")
        try:
            stable_metadata, stable = read_intent_payload(stable_name)
        except FileNotFoundError:
            stable_metadata = None
            stable = None
        if stable is not None:
            if (
                not validate_v3_payload(stable, stable_name)
                or not intent_updates_monotonic(stable, update)
            ):
                raise SystemExit("seeded-default durable intent update is not monotonic")
        current_update = os.stat(
            update_name,
            dir_fd=intents_descriptor,
            follow_symlinks=False,
        )
        if (current_update.st_dev, current_update.st_ino) != (
            update_metadata.st_dev,
            update_metadata.st_ino,
        ):
            raise SystemExit("seeded-default durable intent update changed")
        if stable_metadata is not None:
            current_stable = os.stat(
                stable_name,
                dir_fd=intents_descriptor,
                follow_symlinks=False,
            )
            if (current_stable.st_dev, current_stable.st_ino) != (
                stable_metadata.st_dev,
                stable_metadata.st_ino,
            ):
                raise SystemExit("seeded-default stable intent changed")
        # Termux Python exposes dir_fd support on os.rename but not os.replace.
        # Overwrite is intentional here: the update was proven monotonic and
        # both names are bound to this already-open private directory.
        os.rename(
            update_name,
            stable_name,
            src_dir_fd=intents_descriptor,
            dst_dir_fd=intents_descriptor,
        )
        os.fsync(intents_descriptor)

promote_durable_intent_updates()
marker_names = []
for entry_name in sorted(os.listdir(intents_descriptor)):
    if entry_name == quarantine_name:
        ensure_quarantine()
        continue
    marker_names.append(entry_name)
consumed_markers = []
try:
    for marker_name in marker_names:
        if marker_name.endswith(".json.new"):
            descriptor = os.open(marker_name, file_flags, dir_fd=intents_descriptor)
            try:
                metadata = os.fstat(descriptor)
            finally:
                os.close(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
                raise SystemExit("seeded-default temporary intent is unsafe")
            os.unlink(marker_name, dir_fd=intents_descriptor)
            continue
        if not marker_name.endswith(".json"):
            raise SystemExit("unexpected seeded-default rollback artifact")
        descriptor = os.open(marker_name, file_flags, dir_fd=intents_descriptor)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
                raise SystemExit("seeded-default intent is unsafe")
            with os.fdopen(os.dup(descriptor), "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        finally:
            os.close(descriptor)
        schema = payload.get("schema")
        relative = valid_relative(payload.get("relative"))
        expected_digest = payload.get("sha256")
        expected_size = payload.get("size")
        missing_parents = payload.get("missingParents")
        if (
            schema not in {
                "evogent.phone.seeded-default.v1",
                "evogent.phone.seeded-default.v2",
                "evogent.phone.seeded-default.v3",
            }
            or relative is None
            or not isinstance(expected_digest, str)
            or len(expected_digest) != 64
            or any(character not in "0123456789abcdef" for character in expected_digest)
            or type(expected_size) is not int
            or expected_size < 0
            or not isinstance(missing_parents, list)
            or any(valid_relative(value) is None for value in missing_parents)
            or marker_name
            != f"{hashlib.sha256(relative.as_posix().encode()).hexdigest()}.json"
        ):
            raise SystemExit("seeded-default intent is invalid")

        temporary_relative = None
        owned_identity = None
        published_generation = None
        if schema == "evogent.phone.seeded-default.v1":
            if "temporary" in payload:
                raise SystemExit("legacy seeded-default intent has a temporary")
        else:
            temporary_relative = valid_relative(payload.get("temporary"))
            temporary_token = (
                temporary_relative.name[len(".evogent-seed-") : -len(".tmp")]
                if temporary_relative is not None
                and temporary_relative.name.startswith(".evogent-seed-")
                and temporary_relative.name.endswith(".tmp")
                else ""
            )
            if (
                temporary_relative is None
                or temporary_relative.parent != relative.parent
                or len(temporary_token) != 32
                or any(character not in "0123456789abcdef" for character in temporary_token)
            ):
                raise SystemExit("seeded-default temporary intent is invalid")
        if schema == "evogent.phone.seeded-default.v3":
            if payload.get("phase") not in {"intent", "copying", "prepared", "published"}:
                raise SystemExit("seeded-default phase is invalid")
            raw_identity = payload.get("temporaryIdentity")
            owned_identity = None if raw_identity is None else valid_identity(raw_identity)
            if raw_identity is not None and owned_identity is None:
                raise SystemExit("seeded-default inode identity is invalid")
            raw_published = payload.get("publishedIdentity")
            if raw_published is not None:
                if (
                    not isinstance(raw_published, dict)
                    or set(raw_published)
                    != {
                        "device",
                        "inode",
                        "size",
                        "mode",
                        "uid",
                        "gid",
                        "mtimeNs",
                    }
                    or any(type(raw_published.get(key)) is not int for key in raw_published)
                    or raw_published["device"] < 0
                    or raw_published["inode"] <= 0
                    or raw_published["size"] < 0
                    or raw_published["mode"] < 0
                    or raw_published["mode"] > 0o7777
                    or raw_published["uid"] < 0
                    or raw_published["gid"] < 0
                    or raw_published["mtimeNs"] < 0
                    or (
                        raw_published["device"],
                        raw_published["inode"],
                    )
                    != owned_identity
                ):
                    raise SystemExit("seeded-default publication generation is invalid")
                published_generation = raw_published
            if (
                payload.get("phase") in {"prepared", "published"}
            ) != (published_generation is not None):
                raise SystemExit(
                    "prepared seeded-default lacks generation proof"
                )
            raw_created = payload.get("createdParents")
            if not isinstance(raw_created, list):
                raise SystemExit("seeded-default created-parent intent is invalid")
            for entry in raw_created:
                if not isinstance(entry, dict) or set(entry) != {"relative", "device", "inode"}:
                    raise SystemExit("seeded-default created-parent intent is invalid")
                parent_relative = valid_relative(entry.get("relative"))
                parent_identity = valid_identity(
                    {"device": entry.get("device"), "inode": entry.get("inode")}
                )
                if (
                    parent_relative is None
                    or parent_identity is None
                    or len(parent_relative.parts) >= len(relative.parts)
                    or relative.parts[: len(parent_relative.parts)] != parent_relative.parts
                ):
                    raise SystemExit("seeded-default created parent is invalid")
        parent_descriptor = open_parent(relative)
        if parent_descriptor is not None:
            try:
                if temporary_relative is not None and owned_identity is not None:
                    remove_owned_regular(
                        parent_descriptor,
                        temporary_relative.name,
                        owned_identity,
                        f"{marker_name[:-5]}.temporary",
                        expected_digest if published_generation is not None else None,
                        expected_size if published_generation is not None else None,
                        published_generation,
                    )
                if owned_identity is not None and published_generation is not None:
                    remove_owned_regular(
                        parent_descriptor,
                        relative.name,
                        owned_identity,
                        f"{marker_name[:-5]}.target",
                        expected_digest,
                        expected_size,
                        published_generation,
                    )
            finally:
                os.close(parent_descriptor)
        consumed_markers.append(marker_name)

    if quarantine_descriptor is not None:
        if os.listdir(quarantine_descriptor):
            raise SystemExit("seeded-default rollback quarantine is not empty")
    for marker_name in consumed_markers:
        metadata = os.stat(
            marker_name,
            dir_fd=intents_descriptor,
            follow_symlinks=False,
        )
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit("seeded-default intent changed during rollback")
        os.unlink(marker_name, dir_fd=intents_descriptor)
    remaining = os.listdir(intents_descriptor)
    if any(name != quarantine_name for name in remaining):
        raise SystemExit("seeded-default intent namespace is not empty")
    os.fsync(intents_descriptor)
finally:
    if quarantine_descriptor is not None:
        os.close(quarantine_descriptor)
    if state_descriptor is not None:
        os.close(state_descriptor)
    os.close(intents_descriptor)

# Keep the private, empty rollback namespace as a tombstone. Removing either
# directory by its live pathname after an adversarial swap could delete an
# unrelated replacement; retained mode-0700 directories are harmless and make
# repeated recovery idempotent.
os.close(backup_descriptor)
PY
}

backup_apk_for_rollback() {
  local source="$1" output="$2"
  APK_BACKUP_READY=0
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  cp "$source" "$output"
  chmod 600 "$output"
  fsync_regular_file_and_parent "$output"
  cmp -s "$source" "$output" || return 1
  APK_BACKUP_READY=1
}

atomic_link() {
  python3 - "$1" "$2" "$$" <<'PY'
import os
import pathlib
import sys

target, raw_link, owner = sys.argv[1:]
link = pathlib.Path(raw_link)
temporary = link.with_name(f"{link.name}.new.{owner}")
try:
    temporary.unlink()
except FileNotFoundError:
    pass
os.symlink(target, temporary)
try:
    os.replace(temporary, link)
finally:
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
directory = os.open(
    link.parent,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

set_tmux_control_release_root() {
  local target="$1"
  is_real_release_target "$target" || return 1
  tmux set-environment -g EVOGENT_CONTROL_RELEASE_ROOT "$target"
}

clear_tmux_control_release_root() {
  tmux set-environment -gu EVOGENT_CONTROL_RELEASE_ROOT 2>/dev/null || true
}

is_real_release_target() {
  python3 - "$1" "$RELEASES" <<'PY' >/dev/null 2>&1
import os
import pathlib
import re
import stat
import sys

target = pathlib.Path(sys.argv[1])
releases = pathlib.Path(sys.argv[2])
if re.fullmatch(r"[A-Za-z0-9._-]{1,120}", target.name) is None:
    raise SystemExit(1)
target_stat = os.lstat(target)
releases_stat = os.lstat(releases)
if not stat.S_ISDIR(target_stat.st_mode) or not stat.S_ISDIR(releases_stat.st_mode):
    raise SystemExit(1)
if not os.path.samefile(target.parent, releases):
    raise SystemExit(1)
PY
}

backup_control_token() {
  local source="$1"
  CONTROL_TOKEN_BACKUP="$BACKUP_DIR/control-token.txt"
  CONTROL_TOKEN_EXISTED=0
  CONTROL_TOKEN_BACKUP_READY=0
  if [ -e "$source" ] || [ -L "$source" ]; then
    [ -f "$source" ] && [ ! -L "$source" ] || {
      say "phone control token is not a regular private file"
      return 1
    }
    cp "$source" "$CONTROL_TOKEN_BACKUP"
    chmod 600 "$CONTROL_TOKEN_BACKUP"
    fsync_regular_file_and_parent "$CONTROL_TOKEN_BACKUP"
    CONTROL_TOKEN_EXISTED=1
  else
    : > "$BACKUP_DIR/control-token.absent"
    chmod 600 "$BACKUP_DIR/control-token.absent"
    fsync_regular_file_and_parent "$BACKUP_DIR/control-token.absent"
  fi
  CONTROL_TOKEN_BACKUP_READY=1
}

restore_control_token() {
  local target="$CONTROL_TOKEN" temp
  [ "$CONTROL_TOKEN_BACKUP_READY" = 1 ] || return 0
  if [ "$INITIAL_MIGRATION" = 1 ] \
      && [ -d "$HOME/evogent" ] && [ ! -L "$HOME/evogent" ]; then
    target="$HOME/evogent/data/control-token.txt"
  elif [ "$INITIAL_MIGRATION" = 1 ] \
      && [ -d "$MIGRATION_DIR/evogent/data" ] \
      && [ ! -d "$STATE/data" ]; then
    target="$MIGRATION_DIR/evogent/data/control-token.txt"
  fi
  reap_transaction_rollback_temps || return 1
  if [ "$CONTROL_TOKEN_EXISTED" = 1 ]; then
    [ -f "$CONTROL_TOKEN_BACKUP" ] && [ ! -L "$CONTROL_TOKEN_BACKUP" ] || {
      say "CRITICAL: prior phone control token backup is unavailable"
      return 1
    }
    mkdir -p "$(dirname "$target")" || return 1
    temp="$(transaction_rollback_temp_path "$target" control-token)" \
      || return 1
    if ! cp "$CONTROL_TOKEN_BACKUP" "$temp" \
        || ! chmod 600 "$temp" \
        || ! cmp -s "$CONTROL_TOKEN_BACKUP" "$temp" \
        || ! mv -f "$temp" "$target" \
        || ! fsync_regular_file_and_parent "$target" \
        || ! cmp -s "$CONTROL_TOKEN_BACKUP" "$target"; then
      rm -f -- "$temp" 2>/dev/null || true
      return 1
    fi
  else
    [ -f "$BACKUP_DIR/control-token.absent" ] \
      && [ ! -L "$BACKUP_DIR/control-token.absent" ] \
      && [ ! -s "$BACKUP_DIR/control-token.absent" ] \
      && [ "$(stat -c '%a' "$BACKUP_DIR/control-token.absent")" = 600 ] || {
        say "CRITICAL: prior phone control-token absence proof is unavailable"
        return 1
      }
    if [ -d "$(dirname "$target")" ]; then
      rm -f "$target" || return 1
      fsync_directory "$(dirname "$target")" || return 1
    fi
  fi
  return 0
}

sync_control_token_from_apk() {
  local writer="$NEW_RELEASE/device/write-control-token.py"
  local shell_path="" staged_token="$STAGE/control-token.candidate"
  [ -f "$writer" ] && [ ! -L "$writer" ] || {
    say "phone control-token writer is unavailable"
    return 1
  }
  mkdir -p "$(dirname "$CONTROL_TOKEN")"
  if [ -e "$CONTROL_TOKEN" ] || [ -L "$CONTROL_TOKEN" ]; then
    [ -f "$CONTROL_TOKEN" ] && [ ! -L "$CONTROL_TOKEN" ] || {
      say "phone control token destination is not a regular private file"
      return 1
    }
  fi

  # Launching clears Android's package-stopped state and causes every supported
  # app entry path to create the per-install token if this is a fresh install.
  # Rish can return before a large stdout stream has reached a detached caller.
  # Use the same permission-gated filesystem bridge as APK rollback capture;
  # wait for its read-only publication into the private stage, remove the
  # shell-visible inode, and only then validate and persist the token.
  rish_command "am start -n '$PACKAGE_NAME/.MainActivity' >/dev/null" \
    >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    if [ -n "$CONTROL_TOKEN_BRIDGE" ]; then
      [[ "$CONTROL_TOKEN_BRIDGE" =~ ^/data/local/tmp/evogent-control-token\.[0-9a-f]{32}/payload$ ]] \
        || return 1
      shell_path="$CONTROL_TOKEN_BRIDGE"
    else
      shell_path="$(allocate_shell_staging_file control-token 2>/dev/null || true)"
      if [ -n "$shell_path" ]; then
        CONTROL_TOKEN_BRIDGE="$shell_path"
        if [ "$TRANSACTION_JOURNAL_WRITTEN" = 1 ] \
            && ! write_transaction_journal "$TRANSACTION_PHASE"; then
          return 1
        fi
      fi
    fi
    if [ -n "$shell_path" ]; then
      rish_command \
        "cp '$APP_CONTROL_TOKEN_PATH' '$shell_path' && chmod 0644 '$shell_path'" \
        >/dev/null 2>&1 || true
      if copy_published_shell_file "$shell_path" "$staged_token" 30; then
        if ! remove_shell_staging_file "$shell_path"; then
          say "CRITICAL: shell-visible phone control token could not be removed"
          return 1
        fi
        shell_path=""
        CONTROL_TOKEN_BRIDGE=""
      fi
    fi
    if [ -s "$staged_token" ] \
        && python3 "$writer" "$CONTROL_TOKEN" < "$staged_token"; then
      rm -f -- "$staged_token"
      say "phone control token synchronized from APK-scoped storage"
      return 0
    fi
    if [ -n "$shell_path" ]; then
      if ! remove_shell_staging_file "$shell_path"; then
        say "CRITICAL: incomplete phone control-token bridge could not be removed"
        return 1
      fi
      CONTROL_TOKEN_BRIDGE=""
    fi
    shell_path=""
    rm -f -- "$staged_token"
    sleep 1
  done
  say "APK-scoped phone control token was not available in time"
  return 1
}

prepare_transaction_recoverer() {
  local source="$NEW_RELEASE/device/install-release.sh"
  local temporary="$TRANSACTION_RECOVERER.new.$$"
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  cp "$source" "$temporary"
  chmod 700 "$temporary"
  mv -f "$temporary" "$TRANSACTION_RECOVERER"
  fsync_regular_file_and_parent "$TRANSACTION_RECOVERER"
}

write_transaction_journal() {
  local phase="$1" temporary="$TRANSACTION_JOURNAL.new.$$" result=0
  python3 - "$temporary" "$TRANSACTION_JOURNAL" \
    "$ROOT" "$phase" "$RELEASE_ID" "$NEW_RELEASE" "$PREVIOUS_TARGET" \
    "$BACKUP_DIR" "$DB_BACKUP" "$DB_BACKUP_READY" "$DB_EXISTED" \
    "$APK_BACKUP" "$APK_BACKUP_READY" "$APK_CHANGED" \
    "$APK_INSTALL_ATTEMPTED" "$PACKAGE_OPERATION" \
    "$APK_USER_ACTION_KIND" "$APK_USER_ACTION_PURPOSE" \
    "$APK_USER_ACTION_EVIDENCE" "$APK_USER_ACTION_TARGET_SHA256" \
    "$APK_USER_ACTION_TARGET_VERSION_CODE" \
    "$APK_USER_ACTION_TARGET_SIGNER_SHA256" \
    "$PREVIOUS_APK_CODE" "$PREVIOUS_APK_SIGNER" \
    "$INITIAL_MIGRATION" "$LEGACY_RUNTIME_EXPECTED" \
    "$LEGACY_CONTROL_PLANE_EXPECTED" \
    "$LEGACY_SNAPSHOT_READY" "$LEGACY_PLAN_SHA256" \
    "$MIGRATION_STARTED" "$SWITCH_STARTED" \
    "$MIGRATION_DIR" "$CYCLE_GATE" "$CONTROL_TOKEN" "$CONTROL_TOKEN_BACKUP" \
    "$CONTROL_TOKEN_EXISTED" "$CONTROL_TOKEN_BACKUP_READY" \
    "$CONTROL_TOKEN_BRIDGE" \
    "$ANDROID_ROLE_BACKUP" "$ANDROID_ROLE_BACKUP_READY" \
    "$ANDROID_ROLE_BACKUP_SHA256" "$ANDROID_ROLE_USER_ID" \
    "$ANDROID_ROLE_RESTORE_REQUIRED" \
    "$ANDROID_ROLE_MUTATION_ATTEMPTED" "$ANDROID_ROLES_APPLIED" \
    <<'PY' || result=$?
import hashlib
import json
import os
import pathlib
import sys

(
    temporary,
    journal,
    root,
    phase,
    release_id,
    new_release,
    previous_target,
    backup_dir,
    db_backup,
    db_backup_ready,
    db_existed,
    apk_backup,
    apk_backup_ready,
    apk_changed,
    apk_install_attempted,
    package_operation,
    apk_user_action_kind,
    apk_user_action_purpose,
    apk_user_action_evidence,
    apk_user_action_target_sha256,
    apk_user_action_target_version_code,
    apk_user_action_target_signer_sha256,
    previous_apk_code,
    previous_apk_signer,
    initial_migration,
    legacy_runtime_expected,
    legacy_control_plane_expected,
    legacy_snapshot_ready,
    legacy_plan_sha256,
    migration_started,
    switch_started,
    migration_dir,
    cycle_gate,
    control_token,
    control_token_backup,
    control_token_existed,
    control_token_backup_ready,
    control_token_bridge,
    android_role_backup,
    android_role_backup_ready,
    android_role_backup_sha256,
    android_role_user_id,
    android_role_restore_required,
    android_role_mutation_attempted,
    android_roles_applied,
) = sys.argv[1:]
payload = {
    "schema": "evogent.phone.install-transaction.v4",
    "root": root,
    "phase": phase,
    "releaseId": release_id,
    "newRelease": new_release,
    "previousTarget": previous_target,
    "backupDir": backup_dir,
    "dbBackup": db_backup,
    "dbBackupReady": int(db_backup_ready),
    "dbExisted": int(db_existed),
    "apkBackup": apk_backup,
    "apkBackupReady": int(apk_backup_ready),
    "apkChanged": int(apk_changed),
    "apkInstallAttempted": int(apk_install_attempted),
    "packageOperation": package_operation,
    "apkUserActionKind": apk_user_action_kind,
    "apkUserActionPurpose": apk_user_action_purpose,
    "apkUserActionEvidence": apk_user_action_evidence,
    "apkUserActionTargetSha256": apk_user_action_target_sha256,
    "apkUserActionTargetVersionCode": (
        int(apk_user_action_target_version_code)
        if apk_user_action_target_version_code
        else -1
    ),
    "apkUserActionTargetSignerSha256": (
        apk_user_action_target_signer_sha256
    ),
    "previousApkCode": previous_apk_code,
    "previousApkSigner": previous_apk_signer,
    "initialMigration": int(initial_migration),
    "legacyRuntimeExpected": int(legacy_runtime_expected),
    "legacyControlPlaneExpected": int(legacy_control_plane_expected),
    "legacySnapshotReady": int(legacy_snapshot_ready),
    "legacyPlanSha256": legacy_plan_sha256,
    "migrationStarted": int(migration_started),
    "switchStarted": int(switch_started),
    "migrationDir": migration_dir,
    "cycleGate": cycle_gate,
    "controlToken": control_token,
    "controlTokenBackup": control_token_backup,
    "controlTokenExisted": int(control_token_existed),
    "controlTokenBackupReady": int(control_token_backup_ready),
    "controlTokenBridge": control_token_bridge,
    "androidRoleBackup": android_role_backup,
    "androidRoleBackupReady": int(android_role_backup_ready),
    "androidRoleBackupSha256": android_role_backup_sha256,
    "androidRoleUserId": (
        int(android_role_user_id) if android_role_user_id else -1
    ),
    "androidRoleRestoreRequired": int(android_role_restore_required),
    "androidRoleMutationAttempted": int(android_role_mutation_attempted),
    "androidRolesApplied": int(android_roles_applied),
}
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, 0o600)
os.replace(temporary, journal)
try:
    directory = os.open(
        pathlib.Path(journal).parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
except BaseException:
    # The complete new journal is already visible, but its directory fsync did
    # not report success. Callers must distinguish this from a prepublication
    # failure and retain both possible durable interpretations.
    raise SystemExit(76)
PY
  if [ "$result" = 0 ] || [ "$result" = 76 ]; then
    TRANSACTION_PHASE="$phase"
    TRANSACTION_JOURNAL_WRITTEN=1
  else
    rm -f -- "$temporary" 2>/dev/null || true
  fi
  return "$result"
}

clear_transaction_journal() {
  python3 - "$TRANSACTION_JOURNAL" <<'PY'
import os
import pathlib
import sys

journal = pathlib.Path(sys.argv[1])
try:
    journal.unlink()
except FileNotFoundError:
    pass
directory = os.open(journal.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

retire_rolled_back_transaction_journal() {
  local result
  [ "$TRANSACTION_PHASE" = rolled_back ] \
    && [ "$ROLLBACK_DECISION_DURABLE" = 1 ] || return 70
  remove_exact_empty_recovery_phone_state_parent || return 70
  # The non-replayable rollback decision remains durable while the predecessor
  # is re-armed. Retire it only after the restored live/stopped contract has
  # been proved, so a crash can never replay backups over acknowledged writes.
  trap '' INT TERM HUP
  if clear_transaction_journal; then
    COMMITTED=1
    result=0
  else
    result=$?
  fi
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  return "$result"
}

commit_rolled_back_decision() {
  local result
  [ "$ROLLBACK_FAILED" = 0 ] \
    && [ "$RUNTIME_PROVEN_STOPPED" = 1 ] \
    && [ "$TRANSACTION_PHASE" != committed ] \
    && [ -z "$PACKAGE_OPERATION" ] \
    && [ -z "$CONTROL_TOKEN_BRIDGE" ] \
    && { [ "$APK_INSTALL_ATTEMPTED" = 0 ] \
      || [ "$APK_BACKUP_READY" = 1 ]; } \
    && { [ "$ANDROID_ROLE_RESTORE_REQUIRED" = 0 ] \
      || [ "$ANDROID_ROLE_BACKUP_READY" = 1 ]; } \
    && { { [ "$MIGRATION_STARTED" = 0 ] && [ "$SWITCH_STARTED" = 0 ]; } \
      || { [ "$DB_BACKUP_READY" = 1 ] \
        && [ "$CONTROL_TOKEN_BACKUP_READY" = 1 ]; }; } || return 70
  trap '' INT TERM HUP
  if write_transaction_journal rolled_back; then
    ROLLBACK_DECISION_DURABLE=1
    result=0
  else
    result=$?
    # Status 76 means publication is visible but its directory durability is
    # ambiguous. Keep every predecessor process stopped and let the pinned
    # recoverer decide from the journal after the next durable observation.
  fi
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  return "$result"
}

commit_new_release_decision() {
  local result
  [ "$TRANSACTION_PHASE" = health_pending ] \
    && [ "$SWITCH_STARTED" = 1 ] \
    && [ "$MIGRATION_STARTED" = "$INITIAL_MIGRATION" ] \
    && [ "$ANDROID_ROLE_BACKUP_READY" = 1 ] \
    && [ "$ANDROID_ROLES_APPLIED" = 1 ] || return 70
  canonicalize_cycle_gate_for_commit || return 70
  trap '' INT TERM HUP
  if write_transaction_journal committed; then
    COMMITTED=1
    result=0
  else
    result=$?
    # Status 76 means atomic publication completed but the directory fsync did
    # not report success. Never roll back: disk may contain either the prior
    # rollback phase or the complete committed decision, and all assets remain
    # for the corresponding recovery path.
    if [ "$result" = 76 ]; then
      COMMITTED=1
    fi
  fi
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  return "$result"
}

remove_transaction_recoverer() {
  python3 - "$TRANSACTION_RECOVERER" <<'PY'
import os
import pathlib
import sys

recoverer = pathlib.Path(sys.argv[1])
try:
    recoverer.unlink()
except FileNotFoundError:
    pass
directory = os.open(
    recoverer.parent,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

prune_orphan_migrations() {
  python3 - "$MIGRATIONS" "$TRANSACTION_JOURNAL" <<'PY'
import os
import pathlib
import re
import shutil
import stat
import sys

migrations, journal = map(pathlib.Path, sys.argv[1:])
if os.path.lexists(journal):
    raise SystemExit("cannot prune migrations while a transaction is durable")
metadata = os.lstat(migrations)
if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
    raise SystemExit("migration root is unsafe")
safe = re.compile(r"^(?:install|legacy)-[A-Za-z0-9._-]+$")
for child in migrations.iterdir():
    child_stat = os.lstat(child)
    if (
        safe.fullmatch(child.name) is None
        or not stat.S_ISDIR(child_stat.st_mode)
        or stat.S_ISLNK(child_stat.st_mode)
    ):
        raise SystemExit(f"unexpected migration artifact: {child.name}")
for child in list(migrations.iterdir()):
    for path in sorted(
        child.rglob("*"),
        key=lambda item: len(item.parts),
        reverse=True,
    ):
        if path.is_symlink():
            continue
        try:
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
        except FileNotFoundError:
            pass
    os.chmod(child, 0o700)
    shutil.rmtree(child)
descriptor = os.open(migrations, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

validate_transaction_journal() {
  python3 - "$1" "$ROOT" "$RELEASES" "$BACKUPS" "$MIGRATIONS" \
    "$CONTROL_TOKEN" "$HOME/phone-tools/.cycle.lock" "$PHONE_STATE/.cycle.lock" \
    "$TRANSACTION_DIR/initial-cycle.lock" \
    "$TRANSACTION_DIR/recovery-cycle.lock" <<'PY' || return 1
import json
import hashlib
import os
import pathlib
import re
import stat
import sys

(
    journal,
    root,
    releases,
    backups,
    migrations,
    token,
    home_gate,
    state_gate,
    transaction_gate,
    recovery_gate,
) = sys.argv[1:]
data = json.load(open(journal, encoding="utf-8"))
schema = data.get("schema")
if schema not in {
    "evogent.phone.install-transaction.v1",
    "evogent.phone.install-transaction.v2",
    "evogent.phone.install-transaction.v3",
    "evogent.phone.install-transaction.v4",
}:
    raise SystemExit("unsupported install transaction journal")
if data.get("root") != root:
    raise SystemExit("install transaction belongs to a different release root")
if data.get("phase") not in {
    "quiesce_pending",
    "backup_pending",
    "prepared",
    "switch_pending",
    "apk_install_pending",
    "apk_user_action_required",
    "token_sync_pending",
    "role_assignment_pending",
    "roles_applied",
    "health_pending",
    "rolled_back",
    "committed",
}:
    raise SystemExit("invalid install transaction phase")
if data.get("phase") == "committed" \
    and schema == "evogent.phone.install-transaction.v1":
    raise SystemExit("legacy transaction cannot carry a committed decision")
if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", str(data.get("releaseId", ""))):
    raise SystemExit("invalid transaction release id")

def exact_child(value, parent, *, optional=False):
    if optional and not value:
        return
    path = pathlib.Path(value).resolve(strict=False)
    parent_path = pathlib.Path(parent).resolve(strict=False)
    try:
        relative = path.relative_to(parent_path)
    except ValueError:
        raise SystemExit("transaction path escapes its private root")
    if not relative.parts:
        raise SystemExit("transaction path does not name a private child")

exact_child(data.get("newRelease", ""), releases)
previous_target = data.get("previousTarget", "")
current = pathlib.Path(root) / "current"
legacy_self_predecessor = (
    schema == "evogent.phone.install-transaction.v1"
    and "legacyRuntimeExpected" not in data
    and "legacyControlPlaneExpected" not in data
    and previous_target == str(current)
    and data.get("initialMigration") == 0
    and data.get("migrationStarted") == 0
    and data.get("switchStarted") == 0
)
if legacy_self_predecessor:
    try:
        current_stat = os.lstat(current)
    except FileNotFoundError:
        # Crash-reentrant recovery may already have durably removed the link.
        pass
    else:
        if not current.is_symlink():
            raise SystemExit("legacy self predecessor is not a symlink")
        raw_target = os.readlink(current)
        if raw_target != str(current):
            raise SystemExit("legacy self predecessor link changed")
else:
    exact_child(previous_target, releases, optional=True)
exact_child(data.get("backupDir", ""), backups)
exact_child(data.get("dbBackup", ""), backups)
exact_child(data.get("apkBackup", ""), backups)
exact_child(data.get("migrationDir", ""), migrations)
exact_child(data.get("controlTokenBackup", ""), backups, optional=True)
if schema in {
    "evogent.phone.install-transaction.v3",
    "evogent.phone.install-transaction.v4",
}:
    exact_child(data.get("androidRoleBackup", ""), backups)
package_operation = data.get("packageOperation", "")
if not isinstance(package_operation, str) or (
    package_operation
    and re.fullmatch(
        r"/data/local/tmp/evogent-package-op\.[0-9a-f]{32}",
        package_operation,
    )
    is None
):
    raise SystemExit("transaction package operation is invalid")
control_token_bridge = data.get("controlTokenBridge", "")
if not isinstance(control_token_bridge, str) or (
    control_token_bridge
    and re.fullmatch(
        r"/data/local/tmp/evogent-control-token\.[0-9a-f]{32}/payload",
        control_token_bridge,
    )
    is None
):
    raise SystemExit("transaction control-token bridge is invalid")
if package_operation and (
    data.get("apkChanged") != 1 or data.get("apkInstallAttempted") != 1
):
    raise SystemExit("transaction package operation has no APK mutation intent")
action_phase = data.get("phase") == "apk_user_action_required"
action_kind = data.get("apkUserActionKind", "")
action_purpose = data.get("apkUserActionPurpose", "")
action_evidence = data.get("apkUserActionEvidence", "")
action_sha256 = data.get("apkUserActionTargetSha256", "")
action_version = data.get("apkUserActionTargetVersionCode", -1)
action_signer = data.get("apkUserActionTargetSignerSha256", "")
if schema == "evogent.phone.install-transaction.v4":
    if action_phase:
        if (
            action_kind != "android_install_review"
            or action_purpose not in {"candidate_install", "rollback_restore"}
            or action_evidence
            != "trusted_system_installer_foreground_v1"
            or re.fullmatch(r"[0-9a-f]{64}", str(action_sha256)) is None
            or type(action_version) is not int
            or action_version < 1
            or action_version > 9223372036854775807
            or re.fullmatch(r"[0-9a-f]{64}", str(action_signer)) is None
            or package_operation != ""
            or control_token_bridge != ""
            or data.get("apkChanged") != 1
            or data.get("apkInstallAttempted") != 1
            or data.get("apkBackupReady") != 1
        ):
            raise SystemExit("APK foreground action proof is incomplete")
    elif (
        action_kind != ""
        or action_purpose != ""
        or action_evidence != ""
        or action_sha256 != ""
        or action_version != -1
        or action_signer != ""
    ):
        raise SystemExit("terminal transaction carries APK foreground action state")
elif action_phase:
    raise SystemExit("legacy transaction carries APK foreground action state")
if data.get("controlToken") != token:
    raise SystemExit("transaction control-token destination changed")
if data.get("cycleGate") not in {
    home_gate,
    state_gate,
    transaction_gate,
    recovery_gate,
}:
    raise SystemExit("transaction cycle gate is invalid")
for key in (
    "apkChanged",
    "apkInstallAttempted",
    "apkBackupReady",
    "dbBackupReady",
    "dbExisted",
    "initialMigration",
    "migrationStarted",
    "switchStarted",
    "controlTokenExisted",
    "controlTokenBackupReady",
    "legacySnapshotReady",
):
    if schema == "evogent.phone.install-transaction.v1" \
        and key in {"legacySnapshotReady", "dbExisted"}:
        continue
    if type(data.get(key)) is not int or data.get(key) not in {0, 1}:
        raise SystemExit("transaction flag is invalid")
if schema in {
    "evogent.phone.install-transaction.v2",
    "evogent.phone.install-transaction.v3",
    "evogent.phone.install-transaction.v4",
}:
    committed = data["phase"] == "committed"
    rolled_back = data["phase"] == "rolled_back"
    release_id = data["releaseId"]
    new_release = pathlib.Path(data["newRelease"])
    backup_dir = pathlib.Path(data["backupDir"])
    migration_dir = pathlib.Path(data["migrationDir"])
    expected_release = pathlib.Path(releases) / release_id
    if new_release != expected_release:
        raise SystemExit("new release path does not match its release id")
    try:
        new_release_stat = os.lstat(new_release)
    except FileNotFoundError:
        raise SystemExit("new release is unavailable")
    if (
        not stat.S_ISDIR(new_release_stat.st_mode)
        or stat.S_ISLNK(new_release_stat.st_mode)
        or not os.path.samefile(new_release.parent, releases)
    ):
        raise SystemExit("new release is unsafe")
    if committed:
        try:
            current_stat = os.lstat(current)
        except FileNotFoundError:
            raise SystemExit("committed release pointer is missing")
        if (
            not stat.S_ISLNK(current_stat.st_mode)
            or os.readlink(current) != f"releases/{release_id}"
            or not os.path.samefile(current, new_release)
        ):
            raise SystemExit("committed release pointer changed")
    if (
        backup_dir.parent != pathlib.Path(backups)
        or re.fullmatch(r"[A-Za-z0-9._-]+", backup_dir.name) is None
        or migration_dir.parent != pathlib.Path(migrations)
        or re.fullmatch(r"[A-Za-z0-9._-]+", migration_dir.name) is None
    ):
        raise SystemExit("transaction private directories are not direct children")
    expected_migration_prefix = (
        "legacy-" if data["initialMigration"] == 1 else "install-"
    )
    if not migration_dir.name.startswith(expected_migration_prefix):
        raise SystemExit("transaction migration directory has the wrong role")
    for directory in (backup_dir, migration_dir):
        try:
            directory_stat = os.lstat(directory)
        except FileNotFoundError:
            if committed:
                continue
            raise SystemExit("transaction private directory is missing")
        if (
            not stat.S_ISDIR(directory_stat.st_mode)
            or stat.S_ISLNK(directory_stat.st_mode)
            or directory_stat.st_uid != os.getuid()
        ):
            raise SystemExit("transaction private directory is unsafe")
    if pathlib.Path(data["dbBackup"]) != backup_dir / "media-agent.db":
        raise SystemExit("database backup is not bound to its transaction")
    if pathlib.Path(data["apkBackup"]) != backup_dir / "evogent.apk":
        raise SystemExit("APK backup is not bound to its transaction")
    if (
        pathlib.Path(data["controlTokenBackup"])
        != backup_dir / "control-token.txt"
    ):
        raise SystemExit("control-token backup is not bound to its transaction")
    if action_phase:
        manifest_path = new_release / "manifest.json"
        manifest_stat = os.lstat(manifest_path)
        if (
            not stat.S_ISREG(manifest_stat.st_mode)
            or stat.S_ISLNK(manifest_stat.st_mode)
            or manifest_stat.st_uid != os.getuid()
        ):
            raise SystemExit("release manifest is unsafe during APK action")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if action_purpose == "candidate_install":
            expected_action = (
                manifest.get("android", {}).get("sha256"),
                manifest.get("android", {}).get("versionCode"),
                manifest.get("android", {}).get("signerSha256"),
            )
            if data["switchStarted"] != 0:
                raise SystemExit("candidate APK action began after release switch")
        else:
            apk_backup_path = pathlib.Path(data["apkBackup"])
            backup_stat = os.lstat(apk_backup_path)
            if (
                not stat.S_ISREG(backup_stat.st_mode)
                or stat.S_ISLNK(backup_stat.st_mode)
                or backup_stat.st_uid != os.getuid()
                or stat.S_IMODE(backup_stat.st_mode) != 0o600
            ):
                raise SystemExit("rollback APK action backup is unsafe")
            digest = hashlib.sha256()
            with open(apk_backup_path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            expected_action = (
                digest.hexdigest(),
                int(data.get("previousApkCode", -1)),
                data.get("previousApkSigner"),
            )
        if (
            action_sha256,
            action_version,
            action_signer,
        ) != expected_action:
            raise SystemExit("APK foreground action target changed")
    if previous_target:
        previous_path = pathlib.Path(previous_target)
        if (
            previous_path.parent != pathlib.Path(releases)
            or re.fullmatch(r"[A-Za-z0-9._-]{1,120}", previous_path.name) is None
        ):
            raise SystemExit("previous release is not a direct release child")
        try:
            previous_stat = os.lstat(previous_path)
        except FileNotFoundError:
            if not committed:
                raise SystemExit("previous release is unavailable")
        else:
            if (
                not stat.S_ISDIR(previous_stat.st_mode)
                or stat.S_ISLNK(previous_stat.st_mode)
                or not os.path.samefile(previous_path.parent, releases)
            ):
                raise SystemExit("previous release is unsafe")
    if (data["initialMigration"] == 1) != (previous_target == ""):
        raise SystemExit("transaction predecessor does not match its migration role")
    if data["phase"] in {
        "prepared",
        "switch_pending",
        "apk_install_pending",
        "apk_user_action_required",
        "token_sync_pending",
        "role_assignment_pending",
        "roles_applied",
        "health_pending",
        "rolled_back",
    }:
        predecessor_marker = backup_dir / "previous-release"
        marker_stat = os.lstat(predecessor_marker)
        if (
            not stat.S_ISREG(marker_stat.st_mode)
            or stat.S_ISLNK(marker_stat.st_mode)
            or stat.S_IMODE(marker_stat.st_mode) != 0o600
            or marker_stat.st_uid != os.getuid()
            or predecessor_marker.read_text(encoding="utf-8")
            != previous_target + "\n"
        ):
            raise SystemExit("previous release marker does not match its journal")
    for key in ("legacyRuntimeExpected", "legacyControlPlaneExpected"):
        if type(data.get(key)) is not int or data.get(key) not in {0, 1}:
            raise SystemExit("legacy transaction expectation is invalid")
    if data["legacyControlPlaneExpected"] > data["legacyRuntimeExpected"]:
        raise SystemExit("legacy control-plane expectation has no legacy runtime")
    if data["initialMigration"] == 0 and (
        data["legacyRuntimeExpected"] != 0
        or data["legacyControlPlaneExpected"] != 0
    ):
        raise SystemExit("versioned transaction carries a legacy expectation")
    plan_digest = data.get("legacyPlanSha256")
    if not isinstance(plan_digest, str):
        raise SystemExit("legacy rollback plan digest is invalid")
    if data["initialMigration"] == 0:
        if data["legacySnapshotReady"] != 0 or plan_digest:
            raise SystemExit("versioned transaction carries a legacy rollback plan")
    else:
        plan_path = pathlib.Path(data["migrationDir"]) / "rollback-plan.json"
        try:
            plan_stat = os.lstat(plan_path)
        except FileNotFoundError:
            if not committed:
                raise SystemExit("legacy rollback plan is missing")
            plan_stat = None
        if plan_stat is None:
            if (
                data["legacySnapshotReady"] != 1
                or re.fullmatch(r"[0-9a-f]{64}", plan_digest) is None
            ):
                raise SystemExit("committed legacy decision lost its proof identity")
        elif (
            not stat.S_ISREG(plan_stat.st_mode)
            or stat.S_IMODE(plan_stat.st_mode) != 0o600
            or plan_stat.st_uid != os.getuid()
        ):
            raise SystemExit("legacy rollback plan is unsafe")
        if plan_stat is None:
            plan = None
        else:
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
        expected_home = str(pathlib.Path(home_gate).parent.parent)
        expected_state = str(pathlib.Path(root) / "state")
        expected_phone_state = str(pathlib.Path(expected_state) / "phone-tools")
        if plan is not None and not (
            plan.get("schema") == "evogent.phone.legacy-rollback-plan.v1"
            and plan.get("root") == root
            and plan.get("home") == expected_home
            and plan.get("state") == expected_state
            and plan.get("phoneState") == expected_phone_state
            and plan.get("releaseId") == data["releaseId"]
            and plan.get("migrationDir") == data["migrationDir"]
            and isinstance(plan.get("generatedMarker"), str)
            and re.fullmatch(r"[0-9a-f]{64}", plan["generatedMarker"]) is not None
            and plan.get("legacyRuntimeExpected") == data["legacyRuntimeExpected"]
            and plan.get("legacyControlPlaneExpected")
            == data["legacyControlPlaneExpected"]
        ):
            raise SystemExit("legacy rollback plan does not match its journal")
        rearm_program = "" if plan is None else plan.get("rearmProgram")
        if plan is not None and (
            data["legacyRuntimeExpected"] == 1
            and rearm_program not in {"start-prod.sh", "start-prod-sub.sh"}
        ) or (
            data["legacyRuntimeExpected"] == 0 and rearm_program != ""
        ):
            raise SystemExit("legacy rollback rearm program is invalid")
        if plan is not None and data["legacySnapshotReady"] == 1:
            if plan.get("snapshotReady") != 1:
                raise SystemExit("ready journal has an unready legacy plan")
            if re.fullmatch(r"[0-9a-f]{64}", plan_digest) is None:
                raise SystemExit("legacy rollback plan digest is invalid")
            actual = hashlib.sha256(plan_path.read_bytes()).hexdigest()
            if actual != plan_digest:
                raise SystemExit("legacy rollback plan digest changed")
        elif plan is not None and (
            plan_digest or plan.get("snapshotReady") not in {0, 1}
        ):
            raise SystemExit("unready legacy journal has an invalid plan")
        if data["migrationStarted"] == 1 and data["legacySnapshotReady"] != 1:
            raise SystemExit("migration began before its rollback snapshots were ready")
    if committed:
        if not (
            data["switchStarted"] == 1
            and data["migrationStarted"] == data["initialMigration"]
            and data["dbBackupReady"] == 1
            and data["apkBackupReady"] == 1
            and data["controlTokenBackupReady"] == 1
            and data["apkInstallAttempted"] == data["apkChanged"]
            and package_operation == ""
            and control_token_bridge == ""
            and data["cycleGate"] == state_gate
        ):
            raise SystemExit("committed transaction invariants are incomplete")
        if data["initialMigration"] == 1 and (
            data["legacySnapshotReady"] != 1
            or re.fullmatch(r"[0-9a-f]{64}", plan_digest) is None
        ):
            raise SystemExit("committed legacy transaction lacks rollback proof")
    if schema in {
        "evogent.phone.install-transaction.v3",
        "evogent.phone.install-transaction.v4",
    }:
        for key in (
            "androidRoleBackupReady",
            "androidRoleRestoreRequired",
            "androidRoleMutationAttempted",
            "androidRolesApplied",
        ):
            if type(data.get(key)) is not int or data[key] not in {0, 1}:
                raise SystemExit("Android role transaction flag is invalid")
        role_backup = pathlib.Path(data.get("androidRoleBackup", ""))
        role_digest = data.get("androidRoleBackupSha256")
        role_user_id = data.get("androidRoleUserId")
        if role_backup != backup_dir / "android-role-holders.json":
            raise SystemExit("Android role backup is not bound to its transaction")
        if (
            type(role_user_id) is not int
            or role_user_id < -1
            or role_user_id > 2147483647
        ):
            raise SystemExit("Android role user is invalid")
        if data["androidRoleBackupReady"] == 1:
            if (
                re.fullmatch(r"[0-9a-f]{64}", str(role_digest)) is None
                or role_user_id < 0
            ):
                raise SystemExit("Android role backup proof is unsafe")
            try:
                role_stat = os.lstat(role_backup)
            except FileNotFoundError:
                if not committed:
                    raise SystemExit("Android role backup proof is missing")
            else:
                if (
                    not stat.S_ISREG(role_stat.st_mode)
                    or stat.S_ISLNK(role_stat.st_mode)
                    or stat.S_IMODE(role_stat.st_mode) != 0o600
                    or role_stat.st_uid != os.getuid()
                ):
                    raise SystemExit("Android role backup proof is unsafe")
                if (
                    hashlib.sha256(role_backup.read_bytes()).hexdigest()
                    != role_digest
                ):
                    raise SystemExit("Android role backup digest changed")
        elif role_digest != "" or role_user_id != -1:
            raise SystemExit("unready Android role backup carries proof")
        if (
            data["androidRoleMutationAttempted"]
            > data["androidRoleRestoreRequired"]
            or data["androidRolesApplied"]
            > data["androidRoleBackupReady"]
            or data["androidRoleRestoreRequired"]
            > data["androidRoleBackupReady"]
        ):
            raise SystemExit("Android role transaction flags are inconsistent")
        if data["apkInstallAttempted"] > data["androidRoleRestoreRequired"]:
            raise SystemExit("APK mutation lacks prior Android role restore intent")
        if data["phase"] in {
            "prepared",
            "apk_install_pending",
            "apk_user_action_required",
            "role_assignment_pending",
            "roles_applied",
            "switch_pending",
            "token_sync_pending",
            "health_pending",
            "committed",
        } and data["androidRoleBackupReady"] != 1:
            raise SystemExit("mutating transaction lacks Android role backup")
        if data["phase"] in {
            "roles_applied",
            "switch_pending",
            "token_sync_pending",
            "health_pending",
            "committed",
        } and data["androidRolesApplied"] != 1:
            raise SystemExit("release switch lacks activated Android roles")
        if committed and (
            data["androidRolesApplied"] != 1
            or data["androidRoleBackupReady"] != 1
        ):
            raise SystemExit("committed transaction lacks Android role proof")
        if rolled_back and (
            data["androidRoleRestoreRequired"] == 1
            and data["androidRoleBackupReady"] != 1
        ):
            raise SystemExit("rolled-back transaction lacks Android role restore proof")
    elif data["phase"] in {
        "apk_user_action_required",
        "role_assignment_pending",
        "roles_applied",
    }:
        raise SystemExit("legacy transaction carries Android role phases")
    if rolled_back and (
        package_operation != ""
        or control_token_bridge != ""
        or (
            data["apkInstallAttempted"] == 1
            and data["apkBackupReady"] != 1
        )
        or (
            (data["migrationStarted"] == 1 or data["switchStarted"] == 1)
            and (
                data["dbBackupReady"] != 1
                or data["controlTokenBackupReady"] != 1
            )
        )
    ):
        raise SystemExit("rolled-back transaction lacks restoration proof")
else:
    if data["migrationStarted"] == 1 or data["switchStarted"] == 1:
        raise SystemExit("mutated v1 transactions require their pinned recoverer")
    for key in ("legacyRuntimeExpected", "legacyControlPlaneExpected"):
        if key in data and (
            type(data[key]) is not int or data[key] not in {0, 1}
        ):
            raise SystemExit("legacy compatibility expectation is invalid")
PY
}

journal_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]]
print(value)
PY
}

journal_optional_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2], "")
print(value)
PY
}

copy_legacy_home_snapshots() {
  python3 - "$@" <<'PY'
import os
import pathlib
import shutil
import stat
import sys

destination = pathlib.Path(sys.argv[1])
sources = [pathlib.Path(value) for value in sys.argv[2:]]
source_entries = [(source, os.lstat(source)) for source in sources]
regular_identities = [
    (entry.st_dev, entry.st_ino)
    for _, entry in source_entries
    if stat.S_ISREG(entry.st_mode)
]
if len(regular_identities) != len(set(regular_identities)):
    raise SystemExit(
        "legacy HOME hard-link topology cannot be preserved on Android"
    )
for source, entry in source_entries:
    target = destination / source.name
    if os.path.lexists(target):
        raise SystemExit("legacy HOME snapshot destination is occupied")
    if stat.S_ISLNK(entry.st_mode):
        os.symlink(os.readlink(source), target)
    elif stat.S_ISREG(entry.st_mode):
        shutil.copy2(source, target, follow_symlinks=False)
    else:
        raise SystemExit("legacy HOME snapshot type is unsupported")
PY
}

prepare_legacy_rollback_plan() {
  local plan="$MIGRATION_DIR/rollback-plan.json"
  python3 - "$plan" "$HOME" "$STATE" "$PHONE_STATE" \
    "$ROOT" "$RELEASE_ID" "$MIGRATION_DIR" \
    "$LEGACY_RUNTIME_EXPECTED" "$LEGACY_CONTROL_PLANE_EXPECTED" <<'PY'
import hashlib
import json
import os
import pathlib
import secrets
import stat
import sys

(
    plan,
    raw_home,
    raw_state,
    raw_phone_state,
    root,
    release_id,
    migration_dir,
    runtime_expected,
    plane_expected,
) = sys.argv[1:]
home = pathlib.Path(raw_home)
state = pathlib.Path(raw_state)
phone_state = pathlib.Path(raw_phone_state)

def capture(path):
    try:
        entry = os.lstat(path)
    except FileNotFoundError:
        return {"type": "absent"}
    if stat.S_ISDIR(entry.st_mode):
        kind = "directory"
    elif stat.S_ISREG(entry.st_mode):
        kind = "regular"
    elif stat.S_ISLNK(entry.st_mode):
        kind = "symlink"
    else:
        raise SystemExit(f"unsupported legacy entry type: {path}")
    result = {
        "type": kind,
        "dev": entry.st_dev,
        "ino": entry.st_ino,
        "mode": stat.S_IMODE(entry.st_mode),
        "uid": entry.st_uid,
    }
    if kind == "symlink":
        result["target"] = os.readlink(path)
    elif kind == "regular":
        result["size"] = entry.st_size
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        result["sha256"] = digest.hexdigest()
    return result

runtime = home / "evogent"
entries = {
    "runtime": capture(runtime),
    "data": capture(runtime / "data"),
    "nodeModules": capture(runtime / "node_modules"),
    "environment": capture(runtime / ".env.local"),
    "phoneTools": capture(home / "phone-tools"),
}
for name in (
    "start-prod-sub.sh",
    "start-prod.sh",
    "restart-evo.sh",
    "deploy-next.sh",
    "install-evogent-release.sh",
):
    entries[f"home:{name}"] = capture(home / name)

regular_identities = {}
for name, entry in entries.items():
    if entry["type"] != "regular":
        continue
    identity = (entry["dev"], entry["ino"])
    previous = regular_identities.get(identity)
    if previous is not None:
        raise SystemExit(
            "legacy hard-link topology cannot be preserved on Android: "
            f"{previous}, {name}"
        )
    regular_identities[identity] = name

reserved = {
    "stateData": state / "data",
    "stateNodeModules": state / "node_modules",
    "stateConfig": state / "config",
    "nextCache": state / "next-cache" / release_id,
    "phoneState": phone_state,
}
for name, path in reserved.items():
    if os.path.lexists(path):
        raise SystemExit(f"ambiguous pre-existing versioned state: {name}")

runtime_expected = int(runtime_expected)
plane_expected = int(plane_expected)
if runtime_expected not in {0, 1} or plane_expected not in {0, 1}:
    raise SystemExit("invalid legacy rollback expectation")
if plane_expected > runtime_expected:
    raise SystemExit("legacy liveness has no runtime")
if len(
    {
        os.stat(home).st_dev,
        os.stat(state).st_dev,
        os.stat(pathlib.Path(migration_dir)).st_dev,
    }
) != 1:
    raise SystemExit("legacy migration paths cross filesystem boundaries")
if runtime_expected:
    if entries["runtime"]["type"] != "directory":
        raise SystemExit("legacy runtime plan is incomplete")
    if entries["phoneTools"]["type"] != "directory":
        raise SystemExit("legacy phone-tools plan is incomplete")
    if entries["data"]["type"] not in {"absent", "directory"}:
        raise SystemExit("legacy data path is unsafe")
    if entries["nodeModules"]["type"] not in {"absent", "directory"}:
        raise SystemExit("legacy dependency path is unsafe")
    if entries["environment"]["type"] not in {"absent", "regular"}:
        raise SystemExit("legacy environment path is unsafe")
    for name, value in entries.items():
        if name.startswith("home:") and value["type"] not in {
            "absent",
            "regular",
            "symlink",
        }:
            raise SystemExit("legacy HOME entrypoint is unsafe")
    rearm_program = ""
    for name in ("start-prod.sh", "start-prod-sub.sh"):
        value = entries[f"home:{name}"]
        if (
            value["type"] == "regular"
            and value["uid"] == os.getuid()
            and not value["mode"] & 0o022
            and value["mode"] & 0o400
        ):
            rearm_program = name
            break
    if not rearm_program:
        raise SystemExit("legacy runtime has no safe rearm program")
else:
    if any(value["type"] != "absent" for value in entries.values()):
        raise SystemExit("fresh install has an unexpected legacy footprint")
    rearm_program = ""

payload = {
    "schema": "evogent.phone.legacy-rollback-plan.v1",
    "root": root,
    "home": str(home),
    "state": str(state),
    "phoneState": str(phone_state),
    "releaseId": release_id,
    "migrationDir": migration_dir,
    "generatedMarker": secrets.token_hex(32),
    "rearmProgram": rearm_program,
    "legacyRuntimeExpected": runtime_expected,
    "legacyControlPlaneExpected": plane_expected,
    "snapshotReady": 0,
    "entries": entries,
    "snapshots": {},
}
temporary = pathlib.Path(f"{plan}.new.{os.getpid()}")
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, 0o600)
os.replace(temporary, plan)
directory = os.open(
    pathlib.Path(plan).parent,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

finalize_legacy_rollback_plan() {
  local plan="$MIGRATION_DIR/rollback-plan.json"
  python3 - "$plan" "$MIGRATION_DIR" <<'PY'
import json
import hashlib
import os
import pathlib
import stat
import sys

plan_path = pathlib.Path(sys.argv[1])
migration = pathlib.Path(sys.argv[2])
plan = json.loads(plan_path.read_text(encoding="utf-8"))
if (
    plan.get("schema") != "evogent.phone.legacy-rollback-plan.v1"
    or plan.get("migrationDir") != str(migration)
    or plan.get("snapshotReady") != 0
    or plan.get("snapshots") != {}
):
    raise SystemExit("legacy rollback plan cannot be finalized")

def regular_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def capture(path, *, bind_control_programs=False):
    try:
        entry = os.lstat(path)
    except FileNotFoundError:
        return {"type": "absent"}
    if stat.S_ISDIR(entry.st_mode):
        kind = "directory"
    elif stat.S_ISREG(entry.st_mode):
        kind = "regular"
    elif stat.S_ISLNK(entry.st_mode):
        kind = "symlink"
    else:
        raise SystemExit(f"unsupported legacy snapshot type: {path}")
    result = {
        "type": kind,
        "dev": entry.st_dev,
        "ino": entry.st_ino,
        "mode": stat.S_IMODE(entry.st_mode),
        "uid": entry.st_uid,
    }
    if kind == "symlink":
        result["target"] = os.readlink(path)
    elif kind == "regular":
        result["size"] = entry.st_size
        result["sha256"] = regular_sha256(path)
    elif bind_control_programs:
        programs = {}
        for candidate in sorted(path.rglob("*")):
            relative = candidate.relative_to(path)
            if (
                any(part.startswith(".") for part in relative.parts)
                or "__pycache__" in relative.parts
                or "tests" in relative.parts
                or not (
                    candidate.name in {"evo-curl", "evo-health"}
                    or candidate.suffix in {".json", ".md", ".py", ".sh", ".txt"}
                )
            ):
                continue
            name = relative.as_posix()
            value = capture(candidate)
            if value["type"] not in {"regular", "symlink"}:
                raise SystemExit(f"legacy control program is unsafe: {name}")
            programs[name] = value
        required_programs = (
            "evogent-boot.sh",
            "evogent-scheduler.sh",
            "evogent-watchdog.sh",
        )
        for required in required_programs:
            if required not in programs:
                raise SystemExit(f"legacy control program is missing: {required}")
            value = programs[required]
            if (
                value["type"] != "regular"
                or value["uid"] != os.getuid()
                or value["mode"] & 0o022
                or not value["mode"] & 0o400
            ):
                raise SystemExit(f"legacy recovery program is unsafe: {required}")
        # Pre-helper legacy releases have the complete boot/scheduler/watchdog
        # recovery surface without a shared control-plane.sh. When the helper
        # exists it is transitively executable, so bind the exact private
        # regular file. When absent, reject scripts that still refer to it.
        helper = programs.get("control-plane.sh")
        if helper is not None:
            if (
                helper["type"] != "regular"
                or helper["uid"] != os.getuid()
                or helper["mode"] & 0o022
                or not helper["mode"] & 0o400
            ):
                raise SystemExit("legacy control helper is unsafe: control-plane.sh")
        else:
            for required in required_programs:
                with open(path / required, "rb") as handle:
                    if b"control-plane.sh" in handle.read():
                        raise SystemExit(
                            "legacy recovery program references missing "
                            "control-plane.sh"
                        )
        result["controlPrograms"] = programs
    return result

snapshot_paths = {"phoneTools": migration / "phone-tools"}
for name in (
    "start-prod-sub.sh",
    "start-prod.sh",
    "restart-evo.sh",
    "deploy-next.sh",
    "install-evogent-release.sh",
):
    snapshot_paths[f"home:{name}"] = migration / "home" / name

snapshots = {}
for name, path in snapshot_paths.items():
    original = plan["entries"][name]
    snapshot = capture(path, bind_control_programs=name == "phoneTools")
    if original["type"] == "absent":
        if snapshot["type"] != "absent":
            raise SystemExit(f"unexpected snapshot for absent entry: {name}")
    else:
        if snapshot["type"] != original["type"]:
            raise SystemExit(f"legacy snapshot type changed: {name}")
        if (
            snapshot["mode"] != original["mode"]
            or snapshot["uid"] != original["uid"]
            or (
                snapshot["type"] == "regular"
                and (
                    snapshot["size"] != original["size"]
                    or snapshot["sha256"] != original["sha256"]
                )
            )
            or (
                snapshot["type"] == "symlink"
                and snapshot["target"] != original["target"]
            )
        ):
            raise SystemExit(f"legacy snapshot metadata changed: {name}")
    snapshots[name] = snapshot

home_snapshot_names = [
    name for name in snapshot_paths if name.startswith("home:")
]
for index, left_name in enumerate(home_snapshot_names):
    left_original = plan["entries"][left_name]
    if left_original["type"] == "absent":
        continue
    for right_name in home_snapshot_names[index + 1 :]:
        right_original = plan["entries"][right_name]
        originally_linked = (
            right_original["type"] != "absent"
            and left_original["dev"] == right_original["dev"]
            and left_original["ino"] == right_original["ino"]
        )
        snapshots_linked = (
            snapshots[left_name]["type"] != "absent"
            and snapshots[right_name]["type"] != "absent"
            and snapshots[left_name]["dev"] == snapshots[right_name]["dev"]
            and snapshots[left_name]["ino"] == snapshots[right_name]["ino"]
        )
        if originally_linked != snapshots_linked:
            raise SystemExit("legacy HOME hard-link relationship changed")

plan["snapshots"] = snapshots
plan["snapshotReady"] = 1
temporary = plan_path.with_name(f"{plan_path.name}.new.{os.getpid()}")
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump(plan, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, 0o600)
os.replace(temporary, plan_path)
directory = os.open(
    plan_path.parent,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  LEGACY_PLAN_SHA256="$(sha256_file "$plan")" || return 1
  [[ "$LEGACY_PLAN_SHA256" =~ ^[0-9a-f]{64}$ ]] || return 1
  LEGACY_SNAPSHOT_READY=1
}

legacy_rollback_plan_revalidate() {
  python3 - "$MIGRATION_DIR/rollback-plan.json" "$HOME" "$STATE" \
    "$PHONE_STATE" "$CYCLE_GATE" "$CYCLE_GATE_HELD" \
    "$LEGACY_RUNTIME_EXPECTED" "$LEGACY_CONTROL_PLANE_EXPECTED" \
    "$ROOT" "$RELEASE_ID" "$MIGRATION_DIR" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

(
    raw_plan,
    raw_home,
    raw_state,
    raw_phone_state,
    raw_cycle_gate,
    cycle_gate_held,
    runtime_expected,
    plane_expected,
    root,
    release_id,
    migration_dir,
) = sys.argv[1:]
plan_path = pathlib.Path(raw_plan)
plan_stat = os.lstat(plan_path)
if (
    not stat.S_ISREG(plan_stat.st_mode)
    or stat.S_IMODE(plan_stat.st_mode) != 0o600
    or plan_stat.st_uid != os.getuid()
):
    raise SystemExit("unsafe legacy rollback plan")
plan = json.loads(plan_path.read_text(encoding="utf-8"))
if plan.get("schema") != "evogent.phone.legacy-rollback-plan.v1":
    raise SystemExit("invalid legacy rollback plan")
if (
    plan.get("root") != root
    or plan.get("home") != raw_home
    or plan.get("state") != raw_state
    or plan.get("phoneState") != raw_phone_state
    or plan.get("releaseId") != release_id
    or plan.get("migrationDir") != migration_dir
    or not isinstance(plan.get("generatedMarker"), str)
    or len(plan["generatedMarker"]) != 64
    or any(value not in "0123456789abcdef" for value in plan["generatedMarker"])
    or (
        int(runtime_expected) == 1
        and plan.get("rearmProgram")
        not in {"start-prod.sh", "start-prod-sub.sh"}
    )
    or (int(runtime_expected) == 0 and plan.get("rearmProgram") != "")
    or plan.get("legacyRuntimeExpected") != int(runtime_expected)
    or plan.get("legacyControlPlaneExpected") != int(plane_expected)
):
    raise SystemExit("legacy rollback plan expectation changed")

home = pathlib.Path(raw_home)
state = pathlib.Path(raw_state)
paths = {
    "runtime": home / "evogent",
    "data": home / "evogent" / "data",
    "nodeModules": home / "evogent" / "node_modules",
    "environment": home / "evogent" / ".env.local",
    "phoneTools": home / "phone-tools",
}
for name in (
    "start-prod-sub.sh",
    "start-prod.sh",
    "restart-evo.sh",
    "deploy-next.sh",
    "install-evogent-release.sh",
):
    paths[f"home:{name}"] = home / name

def same_entry(path, expected):
    try:
        entry = os.lstat(path)
    except FileNotFoundError:
        return expected.get("type") == "absent"
    if expected.get("type") == "absent":
        return False
    if entry.st_dev != expected.get("dev") or entry.st_ino != expected.get("ino"):
        return False
    if (
        stat.S_IMODE(entry.st_mode) != expected.get("mode")
        or entry.st_uid != expected.get("uid")
    ):
        return False
    if expected.get("type") == "symlink":
        return stat.S_ISLNK(entry.st_mode) and os.readlink(path) == expected.get("target")
    if expected.get("type") == "directory":
        return stat.S_ISDIR(entry.st_mode)
    if expected.get("type") == "regular":
        if not stat.S_ISREG(entry.st_mode) or entry.st_size != expected.get("size"):
            return False
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest() == expected.get("sha256")
    return False

entries = plan.get("entries")
if not isinstance(entries, dict) or set(entries) != set(paths):
    raise SystemExit("legacy rollback plan inventory changed")
for name, path in paths.items():
    if not same_entry(path, entries[name]):
        raise SystemExit(f"legacy entry changed while waiting for the cycle gate: {name}")

for path in (
    state / "data",
    state / "node_modules",
    state / "config",
    state / "next-cache" / release_id,
):
    if os.path.lexists(path):
        raise SystemExit("versioned state appeared before migration")
phone_state = pathlib.Path(raw_phone_state)
if os.path.lexists(phone_state):
    gate = pathlib.Path(raw_cycle_gate)
    if not (
        cycle_gate_held == "1"
        and gate == phone_state / ".cycle.lock"
        and phone_state.is_dir()
        and not phone_state.is_symlink()
        and {value.name for value in phone_state.iterdir()} == {".cycle.lock"}
    ):
        raise SystemExit("phone state appeared before migration")
PY
}

legacy_plan_entry_location() {
  local key="$1"
  shift
  python3 - "$MIGRATION_DIR/rollback-plan.json" "$key" "$@" <<'PY'
import json
import os
import pathlib
import stat
import sys

plan_path, key, *candidates = sys.argv[1:]
plan = json.load(open(plan_path, encoding="utf-8"))
entry = plan["entries"][key]
if entry["type"] == "absent":
    print("absent")
    raise SystemExit(0)
matches = []
for raw_path in candidates:
    try:
        current = os.lstat(raw_path)
    except FileNotFoundError:
        continue
    if current.st_dev == entry["dev"] and current.st_ino == entry["ino"]:
        matches.append(raw_path)
if len(matches) > 1:
    raise SystemExit(1)
print(matches[0] if matches else "missing")
PY
}

legacy_plan_snapshot_location() {
  local key="$1"
  shift
  python3 - "$MIGRATION_DIR/rollback-plan.json" "$key" "$@" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

plan_path, key, *candidates = sys.argv[1:]
plan = json.load(open(plan_path, encoding="utf-8"))
entry = plan["snapshots"][key]
if entry["type"] == "absent":
    print("absent")
    raise SystemExit(0)
matches = []
for raw_path in candidates:
    path = pathlib.Path(raw_path)
    try:
        current = os.lstat(path)
    except FileNotFoundError:
        continue
    if current.st_dev != entry["dev"] or current.st_ino != entry["ino"]:
        continue
    if entry["type"] == "directory":
        if not stat.S_ISDIR(current.st_mode):
            continue
    elif entry["type"] == "regular":
        if not stat.S_ISREG(current.st_mode) or current.st_size != entry["size"]:
            continue
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != entry["sha256"]:
            continue
    elif entry["type"] == "symlink":
        if not stat.S_ISLNK(current.st_mode) or os.readlink(path) != entry["target"]:
            continue
    else:
        continue
    if (
        stat.S_IMODE(current.st_mode) != entry["mode"]
        or current.st_uid != entry["uid"]
    ):
        continue
    control_programs = entry.get("controlPrograms", {})
    control_programs_match = True
    for name, expected in control_programs.items():
        candidate = path / name
        try:
            program = os.lstat(candidate)
        except FileNotFoundError:
            control_programs_match = False
            break
        if (
            program.st_dev != expected["dev"]
            or program.st_ino != expected["ino"]
            or stat.S_IMODE(program.st_mode) != expected["mode"]
            or program.st_uid != expected["uid"]
        ):
            control_programs_match = False
            break
        if expected["type"] == "regular":
            if not stat.S_ISREG(program.st_mode) or program.st_size != expected["size"]:
                control_programs_match = False
                break
            digest = hashlib.sha256()
            with open(candidate, "rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected["sha256"]:
                control_programs_match = False
                break
        elif expected["type"] == "symlink":
            if (
                not stat.S_ISLNK(program.st_mode)
                or os.readlink(candidate) != expected["target"]
            ):
                control_programs_match = False
                break
        else:
            control_programs_match = False
            break
    if control_programs_match:
        matches.append(raw_path)
# A power cut while reconstituting a planned hard-link group can leave the
# bound snapshot inode at both its migration path and its HOME destination.
# Both names are the same authenticated object; prefer the last candidate
# (the live destination) so retry treats that entry as already restored.
print(matches[-1] if matches else "missing")
PY
}

legacy_plan_original_type() {
  python3 - "$MIGRATION_DIR/rollback-plan.json" "$1" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["entries"][sys.argv[2]]["type"])
PY
}

legacy_plan_generated_marker() {
  python3 - "$MIGRATION_DIR/rollback-plan.json" <<'PY'
import json
import re
import sys

marker = json.load(open(sys.argv[1], encoding="utf-8")).get("generatedMarker")
if not isinstance(marker, str) or re.fullmatch(r"[0-9a-f]{64}", marker) is None:
    raise SystemExit(1)
print(marker)
PY
}

legacy_plan_rearm_program() {
  python3 - "$MIGRATION_DIR/rollback-plan.json" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1], encoding="utf-8")).get("rearmProgram")
if value not in {"start-prod.sh", "start-prod-sub.sh"}:
    raise SystemExit(1)
print(value)
PY
}

generated_directory_owned() {
  local directory="$1" marker marker_path="$1/.evogent-install-owner"
  marker="$(legacy_plan_generated_marker)" || return 1
  python3 - "$directory" "$marker_path" "$marker" <<'PY' >/dev/null 2>&1
import os
import pathlib
import stat
import sys

directory, marker_path = map(pathlib.Path, sys.argv[1:3])
expected = sys.argv[3]
directory_entry = os.lstat(directory)
marker_entry = os.lstat(marker_path)
if (
    not stat.S_ISDIR(directory_entry.st_mode)
    or stat.S_ISLNK(directory_entry.st_mode)
    or not stat.S_ISREG(marker_entry.st_mode)
    or stat.S_IMODE(marker_entry.st_mode) != 0o600
    or marker_entry.st_uid != os.getuid()
    or marker_path.read_text(encoding="utf-8") != f"{expected}\n"
):
    raise SystemExit(1)
PY
}

ensure_generated_directory_marker() {
  local directory="$1" marker marker_path temporary
  marker="$(legacy_plan_generated_marker)" || return 1
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  marker_path="$directory/.evogent-install-owner"
  if [ -e "$marker_path" ] || [ -L "$marker_path" ]; then
    generated_directory_owned "$directory"
    return
  fi
  temporary="$(mktemp "$directory/.evogent-install-owner.new.XXXXXXXX")" \
    || return 1
  printf '%s\n' "$marker" > "$temporary" \
    && chmod 600 "$temporary" \
    && mv -f "$temporary" "$marker_path" \
    && fsync_regular_file_and_parent "$marker_path" || {
    rm -f -- "$temporary"
    return 1
  }
}

publish_generated_directory() {
  local destination="$1" candidate="$2"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    generated_directory_owned "$destination"
    return
  fi
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
    mkdir "$candidate" || return 1
    ensure_generated_directory_marker "$candidate" || return 1
    fsync_directory "$(dirname "$candidate")" || return 1
  else
    generated_directory_owned "$candidate" || return 1
  fi
  mkdir -p "$(dirname "$destination")" || return 1
  rename_no_copy "$candidate" "$destination" || return 1
  fsync_directory "$(dirname "$candidate")" || return 1
  fsync_directory "$(dirname "$destination")" || return 1
  generated_directory_owned "$destination"
}

quarantine_generated_directory() {
  local source="$1" destination="$2"
  if [ -e "$source" ] || [ -L "$source" ]; then
    generated_directory_owned "$source" \
      && [ ! -e "$destination" ] && [ ! -L "$destination" ] || return 1
    rename_no_copy "$source" "$destination" || return 1
    fsync_directory "$(dirname "$source")" || return 1
    fsync_directory "$(dirname "$destination")" || return 1
  elif [ -e "$destination" ] || [ -L "$destination" ]; then
    generated_directory_owned "$destination" || return 1
  fi
  if [ -d "$(dirname "$source")" ]; then
    fsync_directory "$(dirname "$source")" || return 1
  fi
  if [ -d "$(dirname "$destination")" ]; then
    fsync_directory "$(dirname "$destination")" || return 1
  fi
}

remove_exact_generated_symlink() {
  local path="$1" expected="$2"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    if [ -d "$(dirname "$path")" ]; then
      fsync_directory "$(dirname "$path")" || return 1
    fi
    return 0
  fi
  [ -L "$path" ] && [ "$(readlink "$path")" = "$expected" ] || return 1
  rm -f -- "$path" || return 1
  fsync_directory "$(dirname "$path")"
}

remove_candidate_current_pointer() {
  if [ ! -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
    fsync_directory "$ROOT"
    return 0
  fi
  [ -L "$CURRENT" ] \
    && [ "$(readlink "$CURRENT")" = "releases/$RELEASE_ID" ] || return 1
  rm -f -- "$CURRENT" || return 1
  fsync_directory "$ROOT"
}

generated_home_target() {
  case "$1" in
    start-prod.sh) printf '%s\n' "$ROOT/current/device/start-prod.sh" ;;
    restart-evo.sh) printf '%s\n' "$ROOT/current/device/restart-evo.sh" ;;
    deploy-next.sh) printf '%s\n' "$ROOT/current/phone-tools/deploy-next.sh" ;;
    install-evogent-release.sh)
      printf '%s\n' "$ROOT/current/device/install-release.sh"
      ;;
    start-prod-sub.sh) return 1 ;;
    *) return 1 ;;
  esac
}

remove_generated_home_entry() {
  local name="$1" path="$HOME/$1" expected
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  if [ "$name" = start-prod.sh ] \
      && [ -f "$path" ] && [ ! -L "$path" ] \
      && [ -f "$HOME/start-prod-sub.sh" ] \
      && [ ! -L "$HOME/start-prod-sub.sh" ] \
      && [ "$path" -ef "$HOME/start-prod-sub.sh" ]; then
    rm -f -- "$path" || return 1
    fsync_directory "$HOME"
    return
  fi
  expected="$(generated_home_target "$name" 2>/dev/null)" || return 1
  remove_exact_generated_symlink "$path" "$expected"
}

quarantine_real_directory() {
  local source="$1" destination="$2"
  if [ -e "$source" ] || [ -L "$source" ]; then
    [ -d "$source" ] && [ ! -L "$source" ] \
      && [ ! -e "$destination" ] && [ ! -L "$destination" ] || return 1
    rename_no_copy "$source" "$destination" || return 1
    fsync_directory "$(dirname "$source")" || return 1
    fsync_directory "$(dirname "$destination")" || return 1
  elif [ -e "$destination" ] || [ -L "$destination" ]; then
    [ -d "$destination" ] && [ ! -L "$destination" ] || return 1
  fi
  if [ -d "$(dirname "$source")" ]; then
    fsync_directory "$(dirname "$source")" || return 1
  fi
  if [ -d "$(dirname "$destination")" ]; then
    fsync_directory "$(dirname "$destination")" || return 1
  fi
}

restore_planned_runtime_component() {
  local key="$1" holder="$2" relative="$3" state_path="$4"
  local destination="$holder/$relative" location
  location="$(legacy_plan_entry_location \
    "$key" "$destination" "$state_path")" || return 1
  case "$location" in
    "$destination")
      fsync_directory "$holder" || return 1
      if [ -d "$(dirname "$state_path")" ]; then
        fsync_directory "$(dirname "$state_path")" || return 1
      fi
      return
      ;;
    "$state_path")
      [ ! -e "$destination" ] && [ ! -L "$destination" ] || return 1
      mkdir -p "$(dirname "$destination")" || return 1
      rename_no_copy "$state_path" "$destination" || return 1
      fsync_directory "$(dirname "$state_path")" || return 1
      fsync_directory "$(dirname "$destination")" || return 1
      ;;
    absent)
      [ ! -e "$destination" ] && [ ! -L "$destination" ] || return 1
      fsync_directory "$holder" || return 1
      if [ -d "$(dirname "$state_path")" ]; then
        fsync_directory "$(dirname "$state_path")" || return 1
      fi
      ;;
    *) return 1 ;;
  esac
}

fsync_real_directory_if_present() {
  local directory="$1"
  if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then
    return 0
  fi
  [ -d "$directory" ] && [ ! -L "$directory" ] \
    && fsync_directory "$directory"
}

rollback_initial_namespace_barrier() {
  local directory
  for directory in \
    "$ROOT" \
    "$HOME" \
    "$STATE" \
    "$STATE/config" \
    "$STATE/next-cache" \
    "$PHONE_STATE" \
    "$HOME/evogent" \
    "$HOME/phone-tools" \
    "$MIGRATION_DIR" \
    "$MIGRATION_DIR/home"; do
    fsync_real_directory_if_present "$directory" || return 1
  done
}

restore_planned_phone_tools() {
  local original snapshot old_gate="" home_gate="$HOME/phone-tools/.cycle.lock"
  local quarantine="$MIGRATION_DIR/rolled-back-phone-state"
  original="$(legacy_plan_entry_location phoneTools \
    "$HOME/phone-tools" "$PHONE_STATE" "$quarantine")" || return 1
  snapshot="$(legacy_plan_snapshot_location phoneTools \
    "$MIGRATION_DIR/phone-tools" "$HOME/phone-tools")" || return 1

  if [ "$original" = "$HOME/phone-tools" ]; then
    [ "$snapshot" = "$MIGRATION_DIR/phone-tools" ] || return 1
    [ "$CYCLE_GATE" = "$home_gate" ] \
      && cycle_gate_owned_by_current "$home_gate" || return 1
  elif [ "$snapshot" = "$HOME/phone-tools" ]; then
    [ "$CYCLE_GATE" = "$home_gate" ] \
      && cycle_gate_owned_by_current "$home_gate" || return 1
  elif [ "$snapshot" = "$MIGRATION_DIR/phone-tools" ] \
      && { [ "$original" = "$PHONE_STATE" ] \
        || [ "$original" = "$quarantine" ]; }; then
    old_gate="$CYCLE_GATE"
    if ! cycle_gate_owned_by_current "$MIGRATION_DIR/phone-tools/.cycle.lock"; then
      acquire_lock_dir \
        "$MIGRATION_DIR/phone-tools/.cycle.lock" \
        release-install-legacy-restore || return 1
    fi
    remove_exact_generated_symlink "$HOME/phone-tools" "$PHONE_STATE" || return 1
    rename_no_copy "$MIGRATION_DIR/phone-tools" "$HOME/phone-tools" || return 1
    fsync_directory "$MIGRATION_DIR" || return 1
    fsync_directory "$HOME" || return 1
    CYCLE_GATE="$home_gate"
    CYCLE_GATE_HELD=1
    cycle_gate_owned_by_current "$home_gate" || return 1
    if [ "$old_gate" != "$home_gate" ]; then
      release_lock_dir "$old_gate"
      [ ! -e "$old_gate" ] && [ ! -L "$old_gate" ] || return 1
      fsync_directory "$(dirname "$old_gate")" || return 1
    fi
  else
    return 1
  fi

  original="$(legacy_plan_entry_location phoneTools \
    "$HOME/phone-tools" "$PHONE_STATE" "$quarantine")" || return 1
  if [ "$original" = "$PHONE_STATE" ]; then
    [ "$CYCLE_GATE" = "$home_gate" ] \
      && cycle_gate_owned_by_current "$home_gate" || return 1
    [ ! -e "$quarantine" ] && [ ! -L "$quarantine" ] || return 1
    rename_no_copy "$PHONE_STATE" "$quarantine" || return 1
    fsync_directory "$(dirname "$PHONE_STATE")" || return 1
    fsync_directory "$MIGRATION_DIR" || return 1
  elif [ "$original" != "$HOME/phone-tools" ] \
      && [ "$original" != "$quarantine" ]; then
    return 1
  fi
  fsync_directory "$HOME/phone-tools"
}

restore_planned_home_entry() {
  local name="$1" key="home:$1" original_type original snapshot
  original_type="$(legacy_plan_original_type "$key")" || return 1
  if [ "$original_type" = absent ]; then
    [ "$(legacy_plan_snapshot_location \
      "$key" "$MIGRATION_DIR/home/$name" "$HOME/$name")" = absent ] \
      || return 1
    remove_generated_home_entry "$name"
    return
  fi
  original="$(legacy_plan_entry_location "$key" "$HOME/$name")" || return 1
  snapshot="$(legacy_plan_snapshot_location \
    "$key" "$MIGRATION_DIR/home/$name" "$HOME/$name")" || return 1
  if [ "$original" = "$HOME/$name" ]; then
    [ "$snapshot" = "$MIGRATION_DIR/home/$name" ] || return 1
  elif [ "$snapshot" = "$HOME/$name" ]; then
    :
  elif [ "$snapshot" = "$MIGRATION_DIR/home/$name" ] \
      && [ "$original" = missing ]; then
    remove_generated_home_entry "$name" || return 1
    rename_no_copy "$MIGRATION_DIR/home/$name" "$HOME/$name" || return 1
    fsync_directory "$MIGRATION_DIR/home" || return 1
    fsync_directory "$HOME" || return 1
  else
    return 1
  fi
}

reconcile_planned_home_link_groups() {
  python3 - "$MIGRATION_DIR/rollback-plan.json" "$HOME" \
    "$MIGRATION_DIR/home" <<'PY'
import pathlib
import re
import sys

plan_path, raw_home, raw_snapshot_home = sys.argv[1:]
plan = __import__("json").load(open(plan_path, encoding="utf-8"))
generated_marker = plan.get("generatedMarker")
if (
    re.fullmatch(r"[0-9a-f]{64}", str(generated_marker)) is None
    or plan.get("migrationDir") != str(pathlib.Path(plan_path).parent)
):
    raise SystemExit("legacy HOME link transaction identity is invalid")
names = (
    "start-prod-sub.sh",
    "start-prod.sh",
    "restart-evo.sh",
    "deploy-next.sh",
    "install-evogent-release.sh",
)
groups = {}
for name in names:
    entry = plan["entries"][f"home:{name}"]
    if entry["type"] != "regular":
        continue
    groups.setdefault((entry["dev"], entry["ino"]), []).append(name)
if any(len(group) > 1 for group in groups.values()):
    raise SystemExit(
        "legacy HOME hard-link topology cannot be recovered on Android"
    )
PY
}

rollback_fresh_initial_install() {
  remove_exact_generated_symlink "$HOME/evogent" "$ROOT/current/runtime" \
    || return 1
  remove_exact_generated_symlink "$HOME/phone-tools" "$PHONE_STATE" \
    || return 1
  for name in start-prod-sub.sh start-prod.sh restart-evo.sh deploy-next.sh \
      install-evogent-release.sh; do
    remove_generated_home_entry "$name" || return 1
  done
  quarantine_generated_directory \
    "$STATE/data" "$MIGRATION_DIR/rolled-back-state-data" || return 1
  quarantine_generated_directory \
    "$STATE/node_modules" "$MIGRATION_DIR/rolled-back-state-node-modules" \
    || return 1
  quarantine_generated_directory \
    "$STATE/config" "$MIGRATION_DIR/rolled-back-state-config" || return 1
  quarantine_generated_directory \
    "$STATE/next-cache/$RELEASE_ID" \
    "$MIGRATION_DIR/rolled-back-next-cache" || return 1
  if [ "$CYCLE_GATE_HELD" = 1 ] \
      && [[ "$CYCLE_GATE" == "$PHONE_STATE/"* ]]; then
    release_lock_dir "$CYCLE_GATE"
    [ ! -e "$CYCLE_GATE" ] && [ ! -L "$CYCLE_GATE" ] || return 1
    CYCLE_GATE_HELD=0
  fi
  quarantine_generated_directory \
    "$PHONE_STATE" "$MIGRATION_DIR/rolled-back-phone-state" || return 1
}

rollback_initial_migration() {
  [ "$INITIAL_MIGRATION" = 1 ] && [ "$MIGRATION_STARTED" = 1 ] || return 0
  [ "$LEGACY_EXPECTATION_COMPAT" = 0 ] \
    && [ "$LEGACY_SNAPSHOT_READY" = 1 ] \
    && [[ "$LEGACY_PLAN_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    && [ "$(sha256_file "$MIGRATION_DIR/rollback-plan.json")" \
      = "$LEGACY_PLAN_SHA256" ] || {
      say "CRITICAL: initial migration has no bound rollback plan"
      return 1
    }
  remove_candidate_current_pointer || return 1
  if [ "$LEGACY_RUNTIME_EXPECTED" = 0 ]; then
    rollback_fresh_initial_install || return 1
    rollback_initial_namespace_barrier
    return
  fi

  local holder
  holder="$(legacy_plan_entry_location runtime \
    "$HOME/evogent" "$MIGRATION_DIR/evogent")" || return 1
  [ "$holder" = "$HOME/evogent" ] \
    || [ "$holder" = "$MIGRATION_DIR/evogent" ] || return 1
  restore_planned_runtime_component \
    data "$holder" data "$STATE/data" || return 1
  restore_planned_runtime_component \
    nodeModules "$holder" node_modules "$STATE/node_modules" || return 1
  restore_planned_runtime_component \
    environment "$holder" .env.local "$STATE/config/.env.local" || return 1
  quarantine_generated_directory \
    "$STATE/data" "$MIGRATION_DIR/rolled-back-state-data" || return 1
  quarantine_generated_directory \
    "$STATE/node_modules" "$MIGRATION_DIR/rolled-back-state-node-modules" \
    || return 1
  quarantine_generated_directory \
    "$STATE/config" "$MIGRATION_DIR/rolled-back-state-config" || return 1
  quarantine_generated_directory \
    "$STATE/next-cache/$RELEASE_ID" \
    "$MIGRATION_DIR/rolled-back-next-cache" || return 1
  if [ "$holder" = "$MIGRATION_DIR/evogent" ]; then
    remove_exact_generated_symlink "$HOME/evogent" "$ROOT/current/runtime" \
      || return 1
    rename_no_copy "$MIGRATION_DIR/evogent" "$HOME/evogent" || return 1
    fsync_directory "$MIGRATION_DIR" || return 1
    fsync_directory "$HOME" || return 1
  fi
  [ "$(legacy_plan_entry_location runtime "$HOME/evogent")" \
    = "$HOME/evogent" ] || return 1

  restore_planned_phone_tools || return 1
  for name in start-prod-sub.sh start-prod.sh restart-evo.sh deploy-next.sh \
      install-evogent-release.sh; do
    restore_planned_home_entry "$name" || return 1
  done
  reconcile_planned_home_link_groups || return 1
  fsync_directory "$HOME" || return 1
  fsync_directory "$MIGRATION_DIR" || return 1
  rollback_initial_namespace_barrier
}

phone_dispatch_target() {
  case "$1" in
    install-release.sh)
      printf '%s\n' "$ROOT/current/device/install-release.sh"
      ;;
    *)
      [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
      printf '%s\n' "$ROOT/current/phone-tools/$1"
      ;;
  esac
}

fsync_copied_entry() {
  local path="$1"
  if [ -L "$path" ]; then
    fsync_directory "$(dirname "$path")"
  elif [ -d "$path" ]; then
    fsync_tree "$path" \
      && fsync_directory "$(dirname "$path")"
  elif [ -f "$path" ]; then
    fsync_regular_file_and_parent "$path"
  else
    return 1
  fi
}

phone_dispatch_entries_equivalent() {
  python3 - "$1" "$2" <<'PY' >/dev/null 2>&1
import hashlib
import os
import pathlib
import stat
import sys

left, right = map(pathlib.Path, sys.argv[1:])

def digest(path):
    entry = os.lstat(path)
    metadata = (
        stat.S_IFMT(entry.st_mode),
        stat.S_IMODE(entry.st_mode),
        entry.st_uid,
    )
    if stat.S_ISLNK(entry.st_mode):
        return metadata + ("link", os.readlink(path))
    if stat.S_ISREG(entry.st_mode):
        value = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                value.update(chunk)
        return metadata + ("file", entry.st_size, value.hexdigest())
    if stat.S_ISDIR(entry.st_mode):
        records = []
        pending = [(path, pathlib.PurePath("."))]
        while pending:
            directory, relative_root = pending.pop()
            for child in sorted(directory.iterdir(), key=lambda item: item.name):
                relative = relative_root / child.name
                child_entry = os.lstat(child)
                record = [
                    relative.as_posix(),
                    stat.S_IFMT(child_entry.st_mode),
                    stat.S_IMODE(child_entry.st_mode),
                    child_entry.st_uid,
                ]
                if stat.S_ISDIR(child_entry.st_mode):
                    pending.append((child, relative))
                elif stat.S_ISLNK(child_entry.st_mode):
                    record.append(os.readlink(child))
                elif stat.S_ISREG(child_entry.st_mode):
                    value = hashlib.sha256()
                    with open(child, "rb") as handle:
                        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                            value.update(chunk)
                    record.extend((child_entry.st_size, value.hexdigest()))
                else:
                    raise SystemExit(1)
                records.append(tuple(record))
        return metadata + ("directory", tuple(sorted(records)))
    raise SystemExit(1)

if digest(left) != digest(right):
    raise SystemExit(1)
PY
}

record_phone_dispatch_predecessor() {
  local name="$1" force="${2:-0}" target="$PHONE_STATE/$1"
  local expected backup marker
  expected="$(phone_dispatch_target "$name")" || return 1
  if [ "$force" != 1 ] \
      && [ -L "$target" ] && [ "$(readlink "$target")" = "$expected" ]; then
    return 0
  fi
  backup="$MIGRATION_DIR/replaced-phone-tools/$name"
  if [ -e "$backup" ] || [ -L "$backup" ]; then
    phone_dispatch_entries_equivalent "$backup" "$backup" || return 1
    [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
    return 0
  fi
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    mkdir -p "$MIGRATION_DIR/created-phone-links" || return 1
    marker="$MIGRATION_DIR/created-phone-links/$name"
    if [ ! -e "$marker" ] && [ ! -L "$marker" ]; then
      : > "$marker" || return 1
      chmod 600 "$marker" || return 1
      fsync_regular_file_and_parent "$marker" || return 1
    else
      [ -f "$marker" ] && [ ! -L "$marker" ] \
        && [ ! -s "$marker" ] || return 1
    fi
    fsync_directory "$MIGRATION_DIR" || return 1
    return 0
  fi
  mkdir -p "$MIGRATION_DIR/replaced-phone-tools" || return 1
  fsync_directory "$MIGRATION_DIR" || return 1
  [ ! -e "$backup" ] && [ ! -L "$backup" ] || return 1
  # Retire the authenticated predecessor with one same-filesystem rename.
  # A recursive delete here would expose a partially removed live entry after
  # power loss and make rollback unable to prove which copy was authoritative.
  fsync_copied_entry "$target" || return 1
  rename_no_copy "$target" "$backup" || return 1
  fsync_directory "$PHONE_STATE" || return 1
  fsync_directory "$MIGRATION_DIR/replaced-phone-tools" || return 1
  fsync_directory "$MIGRATION_DIR" || return 1
  phone_dispatch_entries_equivalent "$backup" "$backup"
}

remove_obsolete_phone_dispatch_links() {
  local release="$1" name target expected
  while IFS= read -r -d '' name; do
    [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
    target="$PHONE_STATE/$name"
    expected="$(phone_dispatch_target "$name")" || return 1
    [ -L "$target" ] && [ "$(readlink "$target")" = "$expected" ] || return 1
    record_phone_dispatch_predecessor "$name" 1 || return 1
    [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
  done < <(
    python3 - "$release" "$PHONE_STATE" "$ROOT" <<'PY'
import os
import pathlib
import sys

release, phone_state, root = map(pathlib.Path, sys.argv[1:])
expected = {child.name for child in (release / "phone-tools").iterdir()}
expected.add("install-release.sh")
prefix = str(root / "current" / "phone-tools") + os.sep
for dispatch in phone_state.iterdir():
    if not dispatch.is_symlink() or dispatch.name in expected:
        continue
    raw = os.readlink(dispatch)
    if raw == prefix + dispatch.name:
        sys.stdout.buffer.write(os.fsencode(dispatch.name) + b"\0")
PY
  )
}

publish_phone_dispatch_link() {
  local name="$1" target="$PHONE_STATE/$1" expected
  expected="$(phone_dispatch_target "$name")" || return 1
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$expected" ]; then
    return 0
  fi
  if [ "$INITIAL_MIGRATION" = 0 ] \
      && { [ -e "$target" ] || [ -L "$target" ]; }; then
    # In a versioned topology, the prior release proof has already accounted
    # for every owned code link. Anything else at a newly introduced name is
    # mutable/unknown state and must never be consumed by a successful upgrade.
    return 1
  fi
  record_phone_dispatch_predecessor "$name" || return 1
  [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
  ln -s "$expected" "$target" || return 1
  fsync_directory "$PHONE_STATE"
}

restore_phone_dispatch_backup() {
  local name="$1" source="$MIGRATION_DIR/replaced-phone-tools/$1"
  local target="$PHONE_STATE/$1" stage
  if [ -e "$target" ] || [ -L "$target" ]; then
    phone_dispatch_entries_equivalent "$target" "$source"
    return
  fi
  stage="$(mktemp -d "$MIGRATION_DIR/dispatch-restore-$name.XXXXXXXX")" \
    || return 1
  cp -a "$source" "$stage/$name" \
    && fsync_copied_entry "$stage/$name" \
    && phone_dispatch_entries_equivalent "$source" "$stage/$name" \
    && rename_no_copy "$stage/$name" "$target" \
    && fsync_directory "$PHONE_STATE" \
    && rmdir "$stage" \
    && fsync_directory "$MIGRATION_DIR" \
    && phone_dispatch_entries_equivalent "$target" "$source" || {
    rm -rf -- "$stage"
    return 1
  }
}

rollback_phone_dispatch_changes() {
  [ "$INITIAL_MIGRATION" = 0 ] || return 0
  [ -n "$MIGRATION_DIR" ] || return 0
  if [ -d "$MIGRATION_DIR/created-phone-links" ] \
      && [ ! -L "$MIGRATION_DIR/created-phone-links" ]; then
    local marker name source target expected
    for marker in "$MIGRATION_DIR/created-phone-links"/* \
        "$MIGRATION_DIR/created-phone-links"/.[!.]* \
        "$MIGRATION_DIR/created-phone-links"/..?*; do
      [ -e "$marker" ] || [ -L "$marker" ] || continue
      [ -f "$marker" ] && [ ! -L "$marker" ] && [ ! -s "$marker" ] \
        || return 1
      name="$(basename "$marker")"
      [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
      expected="$(phone_dispatch_target "$name")" || return 1
      remove_exact_generated_symlink "$PHONE_STATE/$name" "$expected" \
        || return 1
    done
  elif [ -e "$MIGRATION_DIR/created-phone-links" ] \
      || [ -L "$MIGRATION_DIR/created-phone-links" ]; then
    return 1
  fi
  if [ -d "$MIGRATION_DIR/replaced-phone-tools" ]; then
    [ ! -L "$MIGRATION_DIR/replaced-phone-tools" ] || return 1
    for source in "$MIGRATION_DIR/replaced-phone-tools"/* \
        "$MIGRATION_DIR/replaced-phone-tools"/.[!.]* \
        "$MIGRATION_DIR/replaced-phone-tools"/..?*; do
      [ -e "$source" ] || [ -L "$source" ] || continue
      name="$(basename "$source")"
      [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
      target="$PHONE_STATE/$name"
      expected="$(phone_dispatch_target "$name")" || return 1
      if [ -L "$target" ] && [ "$(readlink "$target")" = "$expected" ]; then
        rm -f -- "$target" || return 1
        fsync_directory "$PHONE_STATE" || return 1
      elif [ -e "$target" ] || [ -L "$target" ]; then
        phone_dispatch_entries_equivalent "$target" "$source" || return 1
        continue
      fi
      restore_phone_dispatch_backup "$name" || return 1
    done
  fi
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET/phone-tools" ]; then
    [ ! -L "$PREVIOUS_TARGET/phone-tools" ] || return 1
    for source in "$PREVIOUS_TARGET/phone-tools"/* \
        "$PREVIOUS_TARGET/phone-tools"/.[!.]* \
        "$PREVIOUS_TARGET/phone-tools"/..?*; do
      [ -e "$source" ] || [ -L "$source" ] || continue
      name="$(basename "$source")"
      [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
      target="$PHONE_STATE/$name"
      expected="$ROOT/current/phone-tools/$name"
      if [ ! -e "$target" ] && [ ! -L "$target" ]; then
        ln -s "$expected" "$target" || return 1
      elif [ -L "$target" ] && [ "$(readlink "$target")" = "$expected" ]; then
        :
      fi
    done
  fi
  [ -d "$PHONE_STATE" ] || return 1
  fsync_directory "$PHONE_STATE" || return 1
  return 0
}

normalize_dangling_legacy_predecessor() {
  [ "$INITIAL_MIGRATION" = 0 ] || return 0
  [ "$SWITCH_STARTED" = 0 ] || return 0
  [ "$MIGRATION_STARTED" = 0 ] || return 0
  [ -n "$PREVIOUS_TARGET" ] || return 0
  local normalized
  if ! normalized="$(python3 - "$CURRENT" "$PREVIOUS_TARGET" "$RELEASES" \
      "$HOME/evogent" "$HOME/phone-tools" <<'PY'
import os
import pathlib
import re
import stat
import sys

current, previous, releases, legacy_runtime, legacy_tools = sys.argv[1:]

def is_real_directory(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except FileNotFoundError:
        return False

previous_path = pathlib.Path(previous)
legacy_self_predecessor = previous == current
if not legacy_self_predecessor:
    if re.fullmatch(r"[A-Za-z0-9._-]{1,120}", previous_path.name) is None:
        raise SystemExit("journal predecessor has an invalid release identity")
    try:
        if not os.path.samefile(previous_path.parent, releases):
            raise SystemExit("journal predecessor is not a direct release child")
    except FileNotFoundError:
        raise SystemExit("release directory is unavailable during recovery")
    try:
        previous_stat = os.lstat(previous)
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISDIR(previous_stat.st_mode):
            print("versioned")
            raise SystemExit(0)
        raise SystemExit("prior release target is not a real directory")
if not is_real_directory(legacy_runtime) or not is_real_directory(legacy_tools):
    raise SystemExit("missing prior release has no intact legacy runtime")
try:
    current_stat = os.lstat(current)
except FileNotFoundError:
    # Crash-reentrant second half: a prior recovery may already have unlinked
    # the exact dangling pointer before it could update the in-memory flags.
    directory = os.open(
        os.path.dirname(current),
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    print("normalized")
    raise SystemExit(0)
if not stat.S_ISLNK(current_stat.st_mode):
    raise SystemExit("missing prior release has an unexpected current entry")
raw_target = os.readlink(current)
if legacy_self_predecessor:
    target_matches_predecessor = raw_target == current
else:
    lexical_target = raw_target
    if not os.path.isabs(lexical_target):
        lexical_target = os.path.join(os.path.dirname(current), lexical_target)
    target_matches_predecessor = os.path.normpath(
        os.path.abspath(lexical_target)
    ) == os.path.normpath(os.path.abspath(previous))
if not target_matches_predecessor:
    raise SystemExit("dangling current pointer does not name the journal predecessor")

# Recheck the same inode and raw target immediately before unlinking. The
# release install lock excludes cooperating writers; this closes accidental
# replacement races without following the dangling link.
latest = os.lstat(current)
if (
    latest.st_dev != current_stat.st_dev
    or latest.st_ino != current_stat.st_ino
    or os.readlink(current) != raw_target
):
    raise SystemExit("legacy predecessor pointer changed during recovery")
os.unlink(current)
directory = os.open(
    os.path.dirname(current),
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
print("normalized")
PY
  )"; then
    return 1
  fi
  case "$normalized" in
    versioned) return 0 ;;
    normalized)
      PREVIOUS_TARGET=""
      INITIAL_MIGRATION=1
      LEGACY_RUNTIME_EXPECTED=1
      LEGACY_CONTROL_PLANE_EXPECTED=1
      LEGACY_EXPECTATION_COMPAT=0
      say "normalized a pre-switch dangling release pointer to the intact legacy runtime"
      ;;
    *) return 1 ;;
  esac
}

resolve_legacy_compat_expectation() {
  local topology evidence=0
  [ "$LEGACY_EXPECTATION_COMPAT" = 1 ] || return 0
  if [ "$INITIAL_MIGRATION" = 0 ] && [ -n "$PREVIOUS_TARGET" ]; then
    LEGACY_RUNTIME_EXPECTED=0
    LEGACY_CONTROL_PLANE_EXPECTED=0
    LEGACY_EXPECTATION_COMPAT=0
    return 0
  fi
  [ "$INITIAL_MIGRATION" = 1 ] && [ -z "$PREVIOUS_TARGET" ] || return 1
  topology="$(legacy_runtime_topology 2>/dev/null)" || topology=partial
  if [ "$topology" = present ] \
      || { [ -d "$MIGRATION_DIR/evogent" ] \
        && [ ! -L "$MIGRATION_DIR/evogent" ]; } \
      || { [ -d "$MIGRATION_DIR/phone-tools" ] \
        && [ ! -L "$MIGRATION_DIR/phone-tools" ]; } \
      || find "$MIGRATION_DIR/home" -mindepth 1 -maxdepth 1 \
        -print -quit 2>/dev/null | grep -q .; then
    evidence=1
  fi
  if [ "$evidence" = 1 ]; then
    # V1 did not record prior liveness. Preserve its conservative historical
    # behavior and rearm an evidenced legacy install after exact restoration.
    LEGACY_RUNTIME_EXPECTED=1
    LEGACY_CONTROL_PLANE_EXPECTED=1
  elif [ "$MIGRATION_STARTED" = 0 ] && [ "$topology" = absent ]; then
    LEGACY_RUNTIME_EXPECTED=0
    LEGACY_CONTROL_PLANE_EXPECTED=0
  else
    say "CRITICAL: legacy expectation is unknowable in a v1 transaction"
    return 1
  fi
  LEGACY_EXPECTATION_COMPAT=0
}

safe_private_program() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import os
import stat
import sys

value = sys.argv[1]
entry = os.lstat(value)
mode = stat.S_IMODE(entry.st_mode)
if (
    not stat.S_ISREG(entry.st_mode)
    or entry.st_uid != os.getuid()
    or mode & 0o022
    or not mode & 0o400
):
    raise SystemExit("invalid ownership probe input")
PY
}

legacy_runtime_topology() {
  python3 - "$HOME" <<'PY'
import os
import pathlib
import stat
import sys

home = pathlib.Path(sys.argv[1])
runtime = home / "evogent"
tools = home / "phone-tools"
footprint = [
    runtime,
    tools,
    home / "start-prod.sh",
    home / "start-prod-sub.sh",
    home / "restart-evo.sh",
    home / "deploy-next.sh",
    home / "install-evogent-release.sh",
]

def real_directory(path):
    try:
        entry = os.lstat(path)
    except FileNotFoundError:
        return False
    return stat.S_ISDIR(entry.st_mode) and not stat.S_ISLNK(entry.st_mode)

def private_program(path):
    try:
        entry = os.lstat(path)
    except FileNotFoundError:
        return False
    mode = stat.S_IMODE(entry.st_mode)
    return (
        stat.S_ISREG(entry.st_mode)
        and entry.st_uid == os.getuid()
        and not mode & 0o022
        and bool(mode & 0o400)
    )

if not any(os.path.lexists(value) for value in footprint):
    print("absent")
elif real_directory(runtime) and real_directory(tools) and (
    private_program(home / "start-prod.sh")
    or private_program(home / "start-prod-sub.sh")
) and all(
    private_program(tools / name)
    for name in (
        "evogent-boot.sh",
        "evogent-scheduler.sh",
        "evogent-watchdog.sh",
    )
):
    print("present")
else:
    print("partial")
PY
}

publish_legacy_start_compatibility() {
  local source="$HOME/start-prod-sub.sh"
  local target="$HOME/start-prod.sh"
  [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
  safe_private_program "$source" || return 1
  ln "$source" "$target" || return 1
  fsync_directory "$HOME" || return 1
  safe_private_program "$target" && [ "$source" -ef "$target" ]
}

single_tmux_pane_pid() {
  local panes
  # list-panes parses a target-window, so `=name` alone can still prefix-match
  # the session component. The trailing colon terminates an exact session name.
  panes="$(tmux list-panes -t "=$1:" -F '#{pane_pid}' 2>/dev/null)" || return 1
  [[ "$panes" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$panes"
}

process_has_exact_script() {
  local command_line="${3:-/proc/$1/cmdline}"
  python3 - "$1" "$2" "$command_line" <<'PY' >/dev/null 2>&1
import os
import sys

pid, expected, command_line = sys.argv[1:]
if not pid.isdecimal():
    raise SystemExit(1)
arguments = [
    os.fsdecode(value)
    for value in open(command_line, "rb").read().split(b"\0")
    if value
]
if not (
    len(arguments) == 2
    and os.path.basename(arguments[0]) == "bash"
    and arguments[1] == expected
):
    raise SystemExit(1)
PY
}

process_has_exact_environment() {
  python3 - "$1" "$2" "$3" <<'PY' >/dev/null 2>&1
import os
import sys

pid, key, expected = sys.argv[1:]
if not pid.isdecimal() or not key or "=" in key:
    raise SystemExit(1)
values = {}
for value in open(f"/proc/{pid}/environ", "rb").read().split(b"\0"):
    if b"=" not in value:
        continue
    name, content = value.split(b"=", 1)
    decoded = os.fsdecode(name)
    if decoded in values:
        raise SystemExit(1)
    values[decoded] = os.fsdecode(content)
if values.get(key) != expected:
    raise SystemExit(1)
PY
}

phone_server_owner_fingerprint() {
  python3 - "$1" "$2" "$3" "${4:-}" "${5:-$3}" "${6:-/proc}" \
    <<'PY' 2>/dev/null
import os
import pathlib
import socket
import sys
import time

root_pid, runtime, probe_port, launch_id, environment_port, raw_proc = sys.argv[1:]
if (
    not root_pid.isdecimal()
    or not probe_port.isdecimal()
    or not environment_port.isdecimal()
):
    raise SystemExit(1)
root = int(root_pid)
expected_uid = os.getuid()
proc = pathlib.Path(raw_proc)

def process_start(pid):
    raw = (proc / str(pid) / "stat").read_text()
    fields = raw[raw.rfind(")") + 2 :].split()
    return fields[19]

children = {}
for entry in proc.iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        raw = (entry / "stat").read_text()
        fields = raw[raw.rfind(")") + 2 :].split()
        parent = int(fields[1])
    except (OSError, ValueError, IndexError):
        continue
    children.setdefault(parent, []).append(int(entry.name))

members = []
pending = [root]
while pending:
    pid = pending.pop()
    members.append(pid)
    pending.extend(children.get(pid, ()))

def matching_server(pid):
    try:
        arguments = [
            os.fsdecode(value)
            for value in open(proc / str(pid) / "cmdline", "rb")
            .read()
            .split(b"\0")
            if value
        ]
        environment = dict(
            os.fsdecode(value).split("=", 1)
            for value in open(proc / str(pid) / "environ", "rb")
            .read()
            .split(b"\0")
            if b"=" in value
        )
        cwd = os.path.realpath(proc / str(pid) / "cwd")
        uid = os.stat(proc / str(pid)).st_uid
    except (OSError, ValueError):
        return False
    return (
        uid == expected_uid
        and len(arguments) == 2
        and os.path.basename(arguments[0]) == "node"
        and arguments[1] == "server.js"
        and os.path.samefile(cwd, runtime)
        and environment.get("NODE_ENV") == "production"
        and environment.get("HOST") == "127.0.0.1"
        and environment.get("PORT") == environment_port
        and (not launch_id or environment.get("EVOGENT_RECOVERY_LAUNCH_ID") == launch_id)
    )

tree_matches = sorted(pid for pid in members if matching_server(pid))
all_matches = sorted(
    int(entry.name)
    for entry in proc.iterdir()
    if entry.name.isdecimal() and matching_server(int(entry.name))
)
if len(tree_matches) != 1 or all_matches != tree_matches:
    raise SystemExit("server process identity is ambiguous")
server_pid = tree_matches[0]
server_start = process_start(server_pid)

def socket_inodes():
    values = set()
    for descriptor in (proc / str(server_pid) / "fd").iterdir():
        try:
            target = os.readlink(descriptor)
        except OSError:
            continue
        if target.startswith("socket:[") and target.endswith("]"):
            values.add(target[8:-1])
    return values

def wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return None

# Android hides the global TCP inode table from the Termux uid. Correlate two
# deliberately held accepts with new FDs in this exact Node instead. This is a
# strict ownership proof: an unrelated app racing the loopback bind cannot make
# accepted sockets appear and disappear in the tmux-owned process.
baseline = socket_inodes()
if not baseline:
    raise SystemExit("server has no baseline socket")
clients = []
accepted = []
try:
    for _ in range(2):
        client = socket.create_connection(("127.0.0.1", int(probe_port)), timeout=1)
        if probe_port == environment_port:
            client.sendall(
                b"GET / HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"X-Evogent-Ownership-Probe: held\r\n"
            )
        clients.append(client)
        previous = baseline | set().union(*accepted)
        delta = wait_for(
            lambda: (
                current
                if len(current := socket_inodes() - previous) == 1
                else None
            )
        )
        if delta is None:
            raise SystemExit("accepted socket did not bind to the server")
        accepted.append(delta)

    second = accepted[1]
    try:
        clients[1].shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    clients[1].close()
    clients[1] = None
    if wait_for(lambda: not (socket_inodes() & second)) is None:
        raise SystemExit("second accepted socket did not close")
    if not (socket_inodes() & accepted[0]):
        raise SystemExit("first accepted socket vanished early")

    first = accepted[0]
    try:
        clients[0].shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    clients[0].close()
    clients[0] = None
    if wait_for(lambda: not (socket_inodes() & first)) is None:
        raise SystemExit("first accepted socket did not close")
finally:
    for client in clients:
        if client is not None:
            try:
                client.close()
            except OSError:
                pass

if process_start(server_pid) != server_start:
    raise SystemExit("server process restarted during ownership proof")
print(f"{server_pid}:{server_start}")
PY
}

legacy_server_owner_live() {
  local pane fingerprint
  pane="$(single_tmux_pane_pid evo)" || return 1
  fingerprint="$(phone_server_owner_fingerprint \
    "$pane" "$HOME/evogent" "$PHONE_PORT" "${LEGACY_RECOVERY_LAUNCH_ID:-}")" \
    || return 1
  [[ "$fingerprint" =~ ^[0-9]+:[0-9]+$ ]]
}

legacy_wrapped_scheduler_fingerprint() {
  local proc_root="${4:-/proc}"
  local trusted_bash="${5:-$BASH}"
  local installer_pid="${6:-$$}"
  python3 - \
    "$1" "$2" "$3" "$proc_root" "$trusted_bash" "$installer_pid" <<'PY'
import os
import pathlib
import stat
import sys

(
    raw_pane,
    expected,
    log_path,
    raw_proc,
    trusted_bash,
    raw_installer,
) = sys.argv[1:]
if not raw_pane.isdecimal() or not raw_installer.isdecimal():
    raise SystemExit(1)
pane = int(raw_pane)
installer = int(raw_installer)
proc = pathlib.Path(raw_proc)
expected_uid = os.getuid()
expected_command = f"bash {expected} >> {log_path} 2>&1"

if (
    not os.path.isabs(expected)
    or os.path.normpath(expected) != expected
    or not os.path.isabs(log_path)
    or os.path.normpath(log_path) != log_path
    or not os.path.isabs(raw_proc)
    or os.path.normpath(raw_proc) != raw_proc
    or not os.path.isabs(trusted_bash)
    or os.path.normpath(trusted_bash) != trusted_bash
):
    raise SystemExit(1)

def program_snapshot():
    value = os.lstat(expected)
    mode = stat.S_IMODE(value.st_mode)
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_uid != expected_uid
        or mode & 0o022
        or not mode & 0o400
    ):
        raise SystemExit(1)
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
        value.st_uid,
        mode,
    )

def arguments(pid):
    return tuple(
        os.fsdecode(value)
        for value in (proc / str(pid) / "cmdline").read_bytes().split(b"\0")
        if value
    )

def process_snapshot(pid):
    directory = os.lstat(proc / str(pid))
    if not stat.S_ISDIR(directory.st_mode):
        raise OSError("process directory is not a directory")
    raw = (proc / str(pid) / "stat").read_text()
    opening = raw.find("(")
    closing = raw.rfind(")")
    if (
        opening <= 0
        or closing <= opening
        or raw[:opening].strip() != str(pid)
    ):
        raise ValueError("process stat PID is invalid")
    fields = raw[closing + 2 :].split()
    if (
        len(fields) < 20
        or not fields[1].isdecimal()
        or not fields[19].isdecimal()
    ):
        raise ValueError("process stat identity is invalid")
    executable = os.stat(proc / str(pid) / "exe")
    return {
        "directory": (
            directory.st_dev,
            directory.st_ino,
            directory.st_uid,
        ),
        "arguments": arguments(pid),
        "parent": int(fields[1]),
        "start": int(fields[19]),
        "executable": (executable.st_dev, executable.st_ino),
    }

trusted_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
trusted_descriptor = os.open(trusted_bash, trusted_flags)
try:
    trusted = os.fstat(trusted_descriptor)
    if not stat.S_ISREG(trusted.st_mode):
        raise SystemExit(1)
    trusted_identity = (trusted.st_dev, trusted.st_ino)
    installer_executable = os.stat(proc / str(installer) / "exe")
    if (
        installer_executable.st_dev,
        installer_executable.st_ino,
    ) != trusted_identity:
        raise SystemExit(1)

    initial_program = program_snapshot()
    initial_pane = process_snapshot(pane)
    if (
        initial_pane["directory"][2] != expected_uid
        or initial_pane["arguments"] != ("bash", "-c", expected_command)
        or initial_pane["executable"] != trusted_identity
    ):
        raise SystemExit(1)

    def exact_candidates():
        found = []
        for entry in proc.iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                pid = int(entry.name)
                directory = os.lstat(entry)
                if (
                    not stat.S_ISDIR(directory.st_mode)
                    or directory.st_uid != expected_uid
                    or arguments(pid) != ("bash", expected)
                ):
                    continue
            except (FileNotFoundError, ProcessLookupError):
                continue
            except (OSError, ValueError, IndexError):
                continue
            observed_directory = (
                directory.st_dev,
                directory.st_ino,
                directory.st_uid,
            )
            try:
                snapshot = process_snapshot(pid)
            except (OSError, ValueError, IndexError):
                # Once exact same-UID argv was visible, an incomplete identity
                # is ambiguity rather than evidence that the process is absent.
                raise SystemExit(1)
            if (
                snapshot["directory"] != observed_directory
                or snapshot["arguments"] != ("bash", expected)
            ):
                raise SystemExit(1)
            found.append((pid, snapshot))
        return found

    matches = exact_candidates()
    if len(matches) != 1:
        raise SystemExit(1)
    child, initial_child = matches[0]
    if (
        initial_child["directory"][2] != expected_uid
        or initial_child["arguments"] != ("bash", expected)
        or initial_child["parent"] != pane
        or initial_child["executable"] != trusted_identity
    ):
        raise SystemExit(1)

    # Re-read every mutable identity field before returning. The start times
    # make PID reuse visible; executable inodes prevent argv-only impersonation.
    final_matches = exact_candidates()
    if (
        process_snapshot(pane) != initial_pane
        or len(final_matches) != 1
        or final_matches[0][0] != child
        or final_matches[0][1] != initial_child
        or program_snapshot() != initial_program
    ):
        raise SystemExit(1)
    installer_executable = os.stat(proc / str(installer) / "exe")
    if (
        installer_executable.st_dev,
        installer_executable.st_ino,
    ) != trusted_identity:
        raise SystemExit(1)
    print(f"{child}:{initial_child['start']}")
finally:
    os.close(trusted_descriptor)
PY
}

scheduler_owner_live() {
  local release_target="${1:-}"
  local lock="$HOME/phone-tools/.scheduler.lock"
  local expected="$HOME/phone-tools/evogent-scheduler.sh"
  local pane="" scheduler_fingerprint="" scheduler_pid="" scheduler_start=""
  local pid="" start="" label=""
  pane="$(single_tmux_pane_pid evo-sched)" || return 1
  if process_has_exact_script "$pane" "$expected"; then
    scheduler_pid="$pane"
  elif [ -z "$release_target" ]; then
    scheduler_fingerprint="$(legacy_wrapped_scheduler_fingerprint \
      "$pane" "$expected" "$HOME/evo-sched.log" /proc "$BASH" "$$")" \
      || return 1
    [[ "$scheduler_fingerprint" =~ ^[0-9]+:[0-9]+$ ]] || return 1
    scheduler_pid="${scheduler_fingerprint%%:*}"
    scheduler_start="${scheduler_fingerprint#*:}"
    pid_matches "$scheduler_pid" "$scheduler_start" || return 1
  else
    return 1
  fi
  if [ -n "$release_target" ]; then
    process_has_exact_environment \
      "$pane" EVOGENT_CONTROL_RELEASE_ROOT "$release_target" || return 1
    [ -d "$lock" ] && [ ! -L "$lock" ] || return 1
  fi
  if [ -e "$lock" ] || [ -L "$lock" ]; then
    [ -d "$lock" ] && [ ! -L "$lock" ] \
      && [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || return 1
    pid="$(meta_field "$lock/owner" pid)"
    start="$(meta_field "$lock/owner" start)"
    label="$(meta_field "$lock/owner" label)"
    [ "$label" = scheduler ] && [ "$pid" = "$scheduler_pid" ] \
      && { [ -z "$scheduler_start" ] || [ "$start" = "$scheduler_start" ]; } \
      && pid_matches "$pid" "$start" || return 1
  fi
  return 0
}

watchdog_owner_live() {
  local release_target="${1:-}"
  local lock="$HOME/phone-tools/.watchdog.lock"
  local pid_file="$HOME/phone-tools/.watchdog.pid"
  local expected="$HOME/phone-tools/evogent-watchdog.sh"
  local pid="" start="" label=""
  if [ -e "$lock" ] || [ -L "$lock" ]; then
    [ -d "$lock" ] && [ ! -L "$lock" ] \
      && [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || return 1
    pid="$(meta_field "$lock/owner" pid)"
    start="$(meta_field "$lock/owner" start)"
    label="$(meta_field "$lock/owner" label)"
    [ "$label" = watchdog ] && pid_matches "$pid" "$start" \
      && process_has_exact_script "$pid" "$expected" \
      && { [ -z "$release_target" ] \
        || process_has_exact_environment \
          "$pid" EVOGENT_CONTROL_RELEASE_ROOT "$release_target"; }
    return
  fi
  [ -z "$release_target" ] || return 1
  safe_private_program "$pid_file" || return 1
  pid="$(sed -n '1p' "$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null \
    && process_has_exact_script "$pid" "$expected"
}

legacy_control_plane_live() {
  legacy_server_owner_live \
    && scheduler_owner_live \
    && watchdog_owner_live
}

legacy_processes_absent() {
  python3 - "$HOME/evogent" \
    "$HOME/phone-tools/evogent-scheduler.sh" \
    "$HOME/phone-tools/evogent-watchdog.sh" <<'PY' >/dev/null 2>&1
import os
import pathlib
import sys

runtime, scheduler, watchdog = sys.argv[1:]
for entry in pathlib.Path("/proc").iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        arguments = [
            os.fsdecode(value)
            for value in open(entry / "cmdline", "rb").read().split(b"\0")
            if value
        ]
    except OSError:
        continue
    if (
        len(arguments) == 2
        and os.path.basename(arguments[0]) == "bash"
        and arguments[1] in {scheduler, watchdog}
    ):
        raise SystemExit(1)
    if (
        len(arguments) == 2
        and os.path.basename(arguments[0]) == "node"
        and arguments[1] == "server.js"
    ):
        try:
            if os.path.samefile(f"/proc/{entry.name}/cwd", runtime):
                raise SystemExit(1)
        except FileNotFoundError:
            pass
PY
}

private_scheduler_watchdog_processes_absent() {
  python3 - "$HOME/phone-tools/evogent-scheduler.sh" \
    "$HOME/phone-tools/evogent-watchdog.sh" <<'PY' >/dev/null 2>&1
import os
import pathlib
import sys

scheduler, watchdog = sys.argv[1:]
for entry in pathlib.Path("/proc").iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        arguments = [
            os.fsdecode(value)
            for value in open(entry / "cmdline", "rb").read().split(b"\0")
            if value
        ]
    except OSError:
        continue
    if (
        len(arguments) == 2
        and os.path.basename(arguments[0]) == "bash"
        and arguments[1] in {scheduler, watchdog}
    ):
        raise SystemExit(1)
PY
}

restored_background_control_stopped() {
  ! tmux has-session -t '=evo-sched' 2>/dev/null \
    && [ ! -e "$HOME/phone-tools/.scheduler.lock" ] \
    && [ ! -L "$HOME/phone-tools/.scheduler.lock" ] \
    && [ ! -e "$HOME/phone-tools/.watchdog.lock" ] \
    && [ ! -L "$HOME/phone-tools/.watchdog.lock" ] \
    && [ ! -e "$HOME/phone-tools/.watchdog.pid" ] \
    && [ ! -L "$HOME/phone-tools/.watchdog.pid" ] \
    && private_scheduler_watchdog_processes_absent
}

phone_ports_stably_closed() {
  local stable=0
  for _ in $(seq 1 5); do
    if phone_ports_open; then
      stable=0
    else
      stable=$((stable + 1))
      [ "$stable" -ge 3 ] && return 0
    fi
    sleep 1
  done
  return 1
}

cycle_gate_owned_by_current() {
  local lock="$1" pid start
  [ -d "$lock" ] && [ ! -L "$lock" ] \
    && [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || return 1
  pid="$(meta_field "$lock/owner" pid)"
  start="$(meta_field "$lock/owner" start)"
  [ "$pid" = "$$" ] && pid_matches "$pid" "$start"
}

canonicalize_cycle_gate_for_commit() {
  local home_gate="$HOME/phone-tools/.cycle.lock"
  local state_gate="$PHONE_STATE/.cycle.lock"
  case "$CYCLE_GATE" in
    "$state_gate")
      cycle_gate_owned_by_current "$state_gate"
      ;;
    "$home_gate")
      cycle_gate_owned_by_current "$home_gate" \
        && python3 - "$home_gate" "$state_gate" <<'PY' >/dev/null 2>&1 \
        || return 1
import os
import sys
if not os.path.samefile(sys.argv[1], sys.argv[2]):
    raise SystemExit(1)
PY
      CYCLE_GATE="$state_gate"
      cycle_gate_owned_by_current "$state_gate"
      ;;
    *)
      return 1
      ;;
  esac
}

cycle_gate_absent_or_owned() {
  local lock="$HOME/phone-tools/.cycle.lock"
  if [ ! -e "$lock" ] && [ ! -L "$lock" ]; then
    return 0
  fi
  [ "$CYCLE_GATE_HELD" = 1 ] \
    && [ "$CYCLE_GATE" = "$lock" ] \
    && cycle_gate_owned_by_current "$lock"
}

select_recovery_cycle_gate() {
  local selected parent
  if [ "$INITIAL_MIGRATION" = 1 ] \
      && [ "$LEGACY_EXPECTATION_COMPAT" = 0 ]; then
    selected="$(
      python3 - "$MIGRATION_DIR/rollback-plan.json" "$HOME" "$STATE" \
        "$PHONE_STATE" "$MIGRATION_DIR" "$TRANSACTION_DIR" \
        "$LEGACY_RUNTIME_EXPECTED" "$LEGACY_SNAPSHOT_READY" \
        "$MIGRATION_STARTED" "$CYCLE_GATE" <<'PY'
import json
import os
import pathlib
import stat
import sys

(
    raw_plan,
    raw_home,
    raw_state,
    raw_phone_state,
    raw_migration,
    raw_transaction,
    raw_runtime_expected,
    raw_snapshot_ready,
    raw_migration_started,
    raw_journal_gate,
) = sys.argv[1:]
plan_path = pathlib.Path(raw_plan)
home = pathlib.Path(raw_home)
state = pathlib.Path(raw_state)
phone_state = pathlib.Path(raw_phone_state)
migration = pathlib.Path(raw_migration)
transaction = pathlib.Path(raw_transaction)
runtime_expected = int(raw_runtime_expected)
snapshot_ready = int(raw_snapshot_ready)
migration_started = int(raw_migration_started)
journal_gate = pathlib.Path(raw_journal_gate)
home_tools = home / "phone-tools"
snapshot_tools = migration / "phone-tools"
quarantine_tools = migration / "rolled-back-phone-state"
home_gate = home_tools / ".cycle.lock"
state_gate = phone_state / ".cycle.lock"
initial_gate = transaction / "initial-cycle.lock"
recovery_gate = transaction / "recovery-cycle.lock"
entry_names = {
    "runtime",
    "data",
    "nodeModules",
    "environment",
    "phoneTools",
    "home:start-prod-sub.sh",
    "home:start-prod.sh",
    "home:restart-evo.sh",
    "home:deploy-next.sh",
    "home:install-evogent-release.sh",
}
snapshot_names = {
    "phoneTools",
    "home:start-prod-sub.sh",
    "home:start-prod.sh",
    "home:restart-evo.sh",
    "home:deploy-next.sh",
    "home:install-evogent-release.sh",
}

def reject(message):
    raise SystemExit(f"unsafe initial recovery cycle topology: {message}")

try:
    plan_stat = os.lstat(plan_path)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
except (FileNotFoundError, OSError, ValueError, TypeError) as error:
    reject(f"rollback plan unavailable: {error}")
if (
    not stat.S_ISREG(plan_stat.st_mode)
    or stat.S_IMODE(plan_stat.st_mode) != 0o600
    or plan_stat.st_uid != os.getuid()
    or plan.get("schema") != "evogent.phone.legacy-rollback-plan.v1"
    or plan.get("home") != str(home)
    or plan.get("state") != str(state)
    or plan.get("phoneState") != str(phone_state)
    or plan.get("migrationDir") != str(migration)
    or plan.get("legacyRuntimeExpected") != runtime_expected
    or plan.get("snapshotReady") != snapshot_ready
    or not isinstance(plan.get("entries"), dict)
    or set(plan["entries"]) != entry_names
    or not isinstance(plan.get("snapshots"), dict)
    or (
        snapshot_ready == 1
        and set(plan["snapshots"]) != snapshot_names
    )
    or (snapshot_ready == 0 and plan["snapshots"] != {})
):
    reject("rollback plan inventory changed")
if (
    runtime_expected not in {0, 1}
    or snapshot_ready not in {0, 1}
    or migration_started not in {0, 1}
    or (migration_started == 1 and snapshot_ready != 1)
):
    reject("rollback state flags are inconsistent")
if journal_gate not in {home_gate, state_gate, initial_gate, recovery_gate}:
    reject("journal gate is outside the transaction topology")

original = plan["entries"]["phoneTools"]
snapshot = (
    plan["snapshots"]["phoneTools"]
    if snapshot_ready == 1
    else {"type": "absent"}
)

def exact_directory(path, expected):
    if expected.get("type") != "directory":
        return False
    try:
        current = os.lstat(path)
    except FileNotFoundError:
        return False
    return (
        stat.S_ISDIR(current.st_mode)
        and not stat.S_ISLNK(current.st_mode)
        and current.st_dev == expected.get("dev")
        and current.st_ino == expected.get("ino")
        and stat.S_IMODE(current.st_mode) == expected.get("mode")
        and current.st_uid == expected.get("uid")
    )

def lexists(path):
    return os.path.lexists(path)

def exact_generated_home_link():
    try:
        current = os.lstat(home_tools)
    except FileNotFoundError:
        return False
    return (
        stat.S_ISLNK(current.st_mode)
        and os.readlink(home_tools) == str(phone_state)
    )

def exact_empty_recovery_parent():
    try:
        current = os.lstat(phone_state)
    except FileNotFoundError:
        return False
    return (
        stat.S_ISDIR(current.st_mode)
        and not stat.S_ISLNK(current.st_mode)
        and current.st_uid == os.getuid()
        and stat.S_IMODE(current.st_mode) == 0o700
        and not any(phone_state.iterdir())
    )

def generated_directory(path):
    marker = plan.get("generatedMarker")
    try:
        current = os.lstat(path)
        marker_stat = os.lstat(path / ".evogent-install-owner")
        marker_value = (path / ".evogent-install-owner").read_text(
            encoding="utf-8"
        )
    except (FileNotFoundError, OSError, UnicodeError):
        return False
    return (
        isinstance(marker, str)
        and len(marker) == 64
        and all(value in "0123456789abcdef" for value in marker)
        and stat.S_ISDIR(current.st_mode)
        and not stat.S_ISLNK(current.st_mode)
        and current.st_uid == os.getuid()
        and stat.S_ISREG(marker_stat.st_mode)
        and not stat.S_ISLNK(marker_stat.st_mode)
        and marker_stat.st_uid == os.getuid()
        and stat.S_IMODE(marker_stat.st_mode) == 0o600
        and marker_value == f"{marker}\n"
    )

paths = {
    "home": home_tools,
    "state": phone_state,
    "snapshot": snapshot_tools,
    "quarantine": quarantine_tools,
}

if runtime_expected == 1:
    if original.get("type") != "directory":
        reject("legacy phone-tools identity is not a directory")
    if snapshot_ready == 0:
        if not exact_directory(home_tools, original):
            reject("pre-snapshot legacy phone-tools identity is missing")
        if any(lexists(path) for name, path in paths.items() if name != "home"):
            reject("pre-snapshot legacy phone-tools has a second parent")
        print(home_gate)
        raise SystemExit(0)
    if snapshot.get("type") != "directory":
        reject("legacy phone-tools snapshot identity is not a directory")
    if (
        original.get("dev") == snapshot.get("dev")
        and original.get("ino") == snapshot.get("ino")
    ):
        reject("original and snapshot identities alias")
    original_locations = [
        name for name, path in paths.items() if exact_directory(path, original)
    ]
    snapshot_locations = [
        name for name, path in paths.items() if exact_directory(path, snapshot)
    ]
    if len(original_locations) != 1 or len(snapshot_locations) != 1:
        reject("planned phone-tools identity is missing or has two parents")
    pair = (original_locations[0], snapshot_locations[0])
    if migration_started == 0 and pair != ("home", "snapshot"):
        reject("unstarted migration has a moved phone-tools identity")
    valid_pairs = {
        ("home", "snapshot"): home_gate,
        ("state", "snapshot"): state_gate,
        ("state", "home"): home_gate,
        ("quarantine", "home"): home_gate,
    }
    selected = valid_pairs.get(pair)
    if selected is None:
        reject("planned phone-tools identities occupy an invalid pair")
    for name, path in paths.items():
        if name in pair or not lexists(path):
            continue
        if (
            pair == ("state", "snapshot")
            and name == "home"
            and exact_generated_home_link()
        ):
            continue
        if (
            pair == ("quarantine", "home")
            and name == "state"
            and exact_empty_recovery_parent()
        ):
            continue
        reject(f"unexpected phone-tools parent: {name}")
    print(selected)
    raise SystemExit(0)

if original.get("type") != "absent" or snapshot.get("type") != "absent":
    reject("fresh-install plan unexpectedly binds phone-tools")
home_present = lexists(home_tools)
home_link = exact_generated_home_link()
if home_present and not home_link:
    reject("fresh-install HOME phone-tools is unsafe")
state_generated = generated_directory(phone_state)
state_empty = exact_empty_recovery_parent()
state_present = lexists(phone_state)
quarantine_generated = generated_directory(quarantine_tools)
quarantine_present = lexists(quarantine_tools)
if state_present and not state_generated and not state_empty:
    reject("fresh-install phone state is unsafe")
if quarantine_present and not quarantine_generated:
    reject("fresh-install quarantine is unsafe")
if lexists(snapshot_tools):
    reject("fresh-install snapshot path is occupied")
if state_generated and quarantine_generated:
    reject("fresh-install generated state has two parents")
if migration_started == 0:
    if home_present or state_present or quarantine_present:
        reject("unstarted fresh migration has a phone-tools footprint")
    if journal_gate != initial_gate:
        reject("unstarted fresh migration lost its initial gate")
    print(initial_gate)
    raise SystemExit(0)
if quarantine_generated:
    if home_present or (state_present and not state_empty):
        reject("rolled-back fresh install has live phone state")
    print(recovery_gate)
elif state_generated:
    print(state_gate)
elif state_present:
    reject("unbound empty phone state has no rolled-back owner")
else:
    if home_present or journal_gate not in {initial_gate, recovery_gate}:
        reject("fresh-install gate parent is missing")
    print(journal_gate)
PY
    )" || return 1
    CYCLE_GATE="$selected"
    return 0
  fi

  parent="$(dirname "$CYCLE_GATE")"
  if [ -e "$parent" ] || [ -L "$parent" ]; then
    [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  else
    [ "$CYCLE_GATE" = "$PHONE_STATE/.cycle.lock" ] || return 1
    mkdir "$PHONE_STATE" || return 1
    fsync_directory "$STATE" || return 1
  fi
}

remove_exact_empty_recovery_phone_state_parent() {
  [ "$RECOVERY_ACTIVE" = 1 ] \
    && [ "$INITIAL_MIGRATION" = 1 ] \
    && [ "$LEGACY_EXPECTATION_COMPAT" = 0 ] || return 0
  python3 - "$MIGRATION_DIR/rollback-plan.json" "$HOME" "$STATE" \
    "$PHONE_STATE" "$MIGRATION_DIR" "$LEGACY_RUNTIME_EXPECTED" \
    "$LEGACY_SNAPSHOT_READY" <<'PY'
import json
import os
import pathlib
import stat
import sys

(
    raw_plan,
    raw_home,
    raw_state,
    raw_phone_state,
    raw_migration,
    raw_runtime_expected,
    raw_snapshot_ready,
) = sys.argv[1:]
plan_path = pathlib.Path(raw_plan)
home = pathlib.Path(raw_home)
state = pathlib.Path(raw_state)
phone_state = pathlib.Path(raw_phone_state)
migration = pathlib.Path(raw_migration)
runtime_expected = int(raw_runtime_expected)
snapshot_ready = int(raw_snapshot_ready)
home_tools = home / "phone-tools"
snapshot_tools = migration / "phone-tools"
quarantine_tools = migration / "rolled-back-phone-state"

try:
    phone_entry = os.lstat(phone_state)
except FileNotFoundError:
    parent = os.open(
        state,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    raise SystemExit(0)
if (
    not stat.S_ISDIR(phone_entry.st_mode)
    or stat.S_ISLNK(phone_entry.st_mode)
    or phone_entry.st_uid != os.getuid()
    or stat.S_IMODE(phone_entry.st_mode) != 0o700
    or any(phone_state.iterdir())
):
    raise SystemExit("recovery phone-state parent is not exact and empty")

try:
    plan_stat = os.lstat(plan_path)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
except (FileNotFoundError, OSError, ValueError, TypeError) as error:
    raise SystemExit(f"recovery rollback plan is unavailable: {error}")
if (
    not stat.S_ISREG(plan_stat.st_mode)
    or stat.S_IMODE(plan_stat.st_mode) != 0o600
    or plan_stat.st_uid != os.getuid()
    or plan.get("schema") != "evogent.phone.legacy-rollback-plan.v1"
    or plan.get("home") != str(home)
    or plan.get("state") != str(state)
    or plan.get("phoneState") != str(phone_state)
    or plan.get("migrationDir") != str(migration)
    or plan.get("legacyRuntimeExpected") != runtime_expected
    or plan.get("snapshotReady") != snapshot_ready
    or snapshot_ready != 1
):
    raise SystemExit("recovery rollback plan identity changed")
original = plan.get("entries", {}).get("phoneTools", {})
snapshot = plan.get("snapshots", {}).get("phoneTools", {})

def exact_directory(path, expected):
    if expected.get("type") != "directory":
        return False
    try:
        current = os.lstat(path)
    except FileNotFoundError:
        return False
    return (
        stat.S_ISDIR(current.st_mode)
        and not stat.S_ISLNK(current.st_mode)
        and current.st_dev == expected.get("dev")
        and current.st_ino == expected.get("ino")
        and stat.S_IMODE(current.st_mode) == expected.get("mode")
        and current.st_uid == expected.get("uid")
    )

def absent(path):
    return not os.path.lexists(path)

def generated_directory(path):
    marker = plan.get("generatedMarker")
    try:
        current = os.lstat(path)
        marker_stat = os.lstat(path / ".evogent-install-owner")
        marker_value = (path / ".evogent-install-owner").read_text(
            encoding="utf-8"
        )
    except (FileNotFoundError, OSError, UnicodeError):
        return False
    return (
        isinstance(marker, str)
        and len(marker) == 64
        and all(value in "0123456789abcdef" for value in marker)
        and stat.S_ISDIR(current.st_mode)
        and not stat.S_ISLNK(current.st_mode)
        and current.st_uid == os.getuid()
        and stat.S_ISREG(marker_stat.st_mode)
        and not stat.S_ISLNK(marker_stat.st_mode)
        and marker_stat.st_uid == os.getuid()
        and stat.S_IMODE(marker_stat.st_mode) == 0o600
        and marker_value == f"{marker}\n"
    )

if runtime_expected == 1:
    pre_move = (
        exact_directory(home_tools, original)
        and exact_directory(snapshot_tools, snapshot)
        and absent(quarantine_tools)
    )
    restored = (
        exact_directory(home_tools, snapshot)
        and exact_directory(quarantine_tools, original)
        and absent(snapshot_tools)
    )
    if not (pre_move or restored):
        raise SystemExit("recovery phone-state parent has no restored legacy topology")
elif runtime_expected == 0:
    if (
        original.get("type") != "absent"
        or snapshot.get("type") != "absent"
        or not absent(home_tools)
        or not absent(snapshot_tools)
        or (
            not absent(quarantine_tools)
            and not generated_directory(quarantine_tools)
        )
    ):
        raise SystemExit("recovery phone-state parent has no fresh rollback topology")
else:
    raise SystemExit("recovery runtime expectation is invalid")

parent_flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
child_flags = parent_flags
parent = os.open(state, parent_flags)
try:
    child = os.open("phone-tools", child_flags, dir_fd=parent)
    try:
        opened = os.fstat(child)
        rebound = os.stat("phone-tools", dir_fd=parent, follow_symlinks=False)
        if (
            opened.st_dev != phone_entry.st_dev
            or opened.st_ino != phone_entry.st_ino
            or rebound.st_dev != phone_entry.st_dev
            or rebound.st_ino != phone_entry.st_ino
            or opened.st_uid != os.getuid()
            or stat.S_IMODE(opened.st_mode) != 0o700
            or os.listdir(child)
        ):
            raise SystemExit("recovery phone-state parent changed before removal")
    finally:
        os.close(child)
    os.rmdir("phone-tools", dir_fd=parent)
    os.fsync(parent)
finally:
    os.close(parent)
PY
}

legacy_control_plane_stopped() {
  ! tmux has-session -t '=evo' 2>/dev/null \
    && ! tmux has-session -t '=evo-sched' 2>/dev/null \
    && [ ! -e "$HOME/phone-tools/.scheduler.lock" ] \
    && [ ! -L "$HOME/phone-tools/.scheduler.lock" ] \
    && [ ! -e "$HOME/phone-tools/.watchdog.lock" ] \
    && [ ! -L "$HOME/phone-tools/.watchdog.lock" ] \
    && [ ! -e "$HOME/phone-tools/.watchdog.pid" ] \
    && [ ! -L "$HOME/phone-tools/.watchdog.pid" ] \
    && cycle_gate_absent_or_owned \
    && legacy_processes_absent \
    && phone_ports_stably_closed
}

legacy_install_state() {
  local topology state
  topology="$(legacy_runtime_topology 2>/dev/null)" || topology=partial
  case "$topology" in
    absent)
      if legacy_processes_absent && phone_ports_stably_closed \
          && ! tmux has-session -t '=evo' 2>/dev/null \
          && ! tmux has-session -t '=evo-sched' 2>/dev/null; then
        printf '%s\n' absent
      else
        printf '%s\n' partial
      fi
      ;;
    present)
      if legacy_control_plane_live; then
        sleep 1
        legacy_control_plane_live && state=live || state=partial
      elif legacy_control_plane_stopped; then
        state=stopped
      else
        state=partial
      fi
      printf '%s\n' "$state"
      ;;
    *) printf '%s\n' partial ;;
  esac
}

legacy_state_matches_expectation() {
  local state
  state="$(legacy_install_state)" || return 1
  case "$LEGACY_RUNTIME_EXPECTED:$LEGACY_CONTROL_PLANE_EXPECTED:$state" in
    0:0:absent|1:0:stopped|1:1:live) return 0 ;;
    *) return 1 ;;
  esac
}

abort_partial_legacy_rearm() {
  say "CRITICAL: restored legacy control plane did not become durably live"
  quiesce_control_plane >/dev/null 2>&1 || true
  stop_and_prove_runtime >/dev/null 2>&1 || true
  return 1
}

rearm_legacy_server() {
  local start_name="" start_script=""
  [ "$RUNTIME_PROVEN_STOPPED" = 1 ] || {
    say "CRITICAL: legacy rearm has no stable closed-port proof"
    return 1
  }
  if [ "$LEGACY_SNAPSHOT_READY" = 1 ] \
      && [ -f "$MIGRATION_DIR/rollback-plan.json" ]; then
    start_name="$(legacy_plan_rearm_program)" || return 1
  elif safe_private_program "$HOME/start-prod.sh"; then
    start_name=start-prod.sh
  elif safe_private_program "$HOME/start-prod-sub.sh"; then
    start_name=start-prod-sub.sh
  else
    say "CRITICAL: intact legacy runtime has no safe server start program"
    return 1
  fi
  start_script="$HOME/$start_name"
  safe_private_program "$start_script" || {
    say "CRITICAL: planned legacy server start program is unsafe"
    return 1
  }
  fsync_directory "$HOME" || {
    say "CRITICAL: legacy server start program is not durably published"
    return 1
  }

  LEGACY_RECOVERY_LAUNCH_ID="$(
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  )" || return 1
  [[ "$LEGACY_RECOVERY_LAUNCH_ID" =~ ^[0-9a-f]{64}$ ]] || return 1
  stop_tmux_session evo || return 1
  tmux new-session -d -s evo \
    "exec env EVOGENT_RECOVERY_LAUNCH_ID='$LEGACY_RECOVERY_LAUNCH_ID' bash '$start_script' >> '$HOME/evogent-server.log' 2>&1" \
    || {
      abort_partial_legacy_rearm
      return 1
    }
  for _ in $(seq 1 60); do
    legacy_server_owner_live && break
    sleep 2
  done
  legacy_server_owner_live || {
    abort_partial_legacy_rearm
    return 1
  }
  sleep 1
  legacy_server_owner_live || {
    abort_partial_legacy_rearm
    return 1
  }
  restored_background_control_stopped || {
    abort_partial_legacy_rearm
    return 1
  }
}

rearm_legacy_control_plane() {
  local boot_script="$HOME/phone-tools/evogent-boot.sh"
  legacy_server_owner_live || {
    say "CRITICAL: legacy control-plane rearm lost its restored server"
    return 1
  }
  safe_private_program "$boot_script" || {
    say "CRITICAL: intact legacy runtime has no safe control-plane boot program"
    return 1
  }
  clear_tmux_control_release_root
  EVOGENT_RELEASE_RECOVERY=1 EVOGENT_RELEASE_BOOT=1 \
    bash "$boot_script" || {
      abort_partial_legacy_rearm
      return 1
    }
  for _ in $(seq 1 60); do
    legacy_control_plane_live && break
    sleep 2
  done
  legacy_control_plane_live || {
    abort_partial_legacy_rearm
    return 1
  }
  # Require a second observation so a just-exited process cannot satisfy the
  # recovery contract for one scheduling tick.
  sleep 1
  legacy_control_plane_live || {
    abort_partial_legacy_rearm
    return 1
  }
}

release_dispatch_matches_target() {
  python3 - "$1" "$CURRENT" "$HOME" "$PHONE_STATE" <<'PY' >/dev/null 2>&1
import os
import pathlib
import stat
import sys

target, raw_current, raw_home, raw_phone_state = map(pathlib.Path, sys.argv[1:])
current = raw_current
home = raw_home
phone_state = raw_phone_state
root = current.parent
if not current.is_symlink() or not target.is_dir() or target.is_symlink():
    raise SystemExit(1)
phone_state_stat = os.lstat(phone_state)
if (
    not stat.S_ISDIR(phone_state_stat.st_mode)
    or stat.S_ISLNK(phone_state_stat.st_mode)
    or phone_state_stat.st_uid != os.getuid()
):
    raise SystemExit(1)
if not os.path.samefile(current, target):
    raise SystemExit(1)
if os.path.lexists(home / "start-prod-sub.sh"):
    raise SystemExit(1)

home_expected = {
    home / "evogent": (str(root / "current" / "runtime"), target / "runtime"),
    home / "phone-tools": (str(phone_state), phone_state),
    home / "start-prod.sh": (
        str(root / "current" / "device" / "start-prod.sh"),
        target / "device" / "start-prod.sh",
    ),
    home / "restart-evo.sh": (
        str(root / "current" / "device" / "restart-evo.sh"),
        target / "device" / "restart-evo.sh",
    ),
    home / "install-evogent-release.sh": (
        str(root / "current" / "device" / "install-release.sh"),
        target / "device" / "install-release.sh",
    ),
    home / "deploy-next.sh": (
        str(root / "current" / "phone-tools" / "deploy-next.sh"),
        target / "phone-tools" / "deploy-next.sh",
    ),
}
for dispatch, (raw_expected, source) in home_expected.items():
    if (
        not dispatch.is_symlink()
        or os.readlink(dispatch) != raw_expected
        or not os.path.lexists(source)
        or not os.path.samefile(dispatch, source)
    ):
        raise SystemExit(1)

release_tools = target / "phone-tools"
if not release_tools.is_dir() or release_tools.is_symlink():
    raise SystemExit(1)
expected = {
    source.name: (
        str(root / "current" / "phone-tools" / source.name),
        source,
    )
    for source in release_tools.iterdir()
}
expected["install-release.sh"] = (
    str(root / "current" / "device" / "install-release.sh"),
    target / "device" / "install-release.sh",
)
for name, (raw_expected, source) in expected.items():
    dispatch = phone_state / name
    if (
        not dispatch.is_symlink()
        or os.readlink(dispatch) != raw_expected
        or not os.path.lexists(source)
        or not os.path.samefile(dispatch, source)
    ):
        raise SystemExit(1)

# Reject obsolete release-code links without conflating them with mutable
# scheduler state that legitimately shares this directory.
stable_tools_prefix = str(root / "current" / "phone-tools") + os.sep
stable_installer = str(root / "current" / "device" / "install-release.sh")
for dispatch in phone_state.iterdir():
    if not dispatch.is_symlink():
        continue
    raw = os.readlink(dispatch)
    if raw.startswith(stable_tools_prefix) or raw == stable_installer:
        if dispatch.name not in expected or raw != expected[dispatch.name][0]:
            raise SystemExit(1)
PY
}

verify_phone_tls_listener() {
  local release_root="$1"
  python3 - "$release_root/apk/evogent.apk" "$release_root/manifest.json" \
    "$PHONE_HTTPS_PORT" <<'PY'
import hashlib
import json
import socket
import ssl
import sys
import zipfile

apk_path, manifest_path, raw_port = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding="utf-8"))
expected = manifest["phoneTls"]["certificateDerSha256"]
with zipfile.ZipFile(apk_path) as apk:
    ca_pem = apk.read("res/raw/evogent_phone_ca.pem").decode("ascii")

context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
context.minimum_version = ssl.TLSVersion.TLSv1_2
context.check_hostname = True
context.verify_mode = ssl.CERT_REQUIRED
context.load_verify_locations(cadata=ca_pem)
with socket.create_connection(("127.0.0.1", int(raw_port)), timeout=3) as plain:
    with context.wrap_socket(plain, server_hostname="127.0.0.1") as secure:
        actual = hashlib.sha256(secure.getpeercert(binary_form=True)).hexdigest()
        if actual != expected:
            raise SystemExit("running TLS listener certificate does not match release")
        secure.sendall(
            b"GET /api/internal/phone-health HTTP/1.1\r\n"
            b"Host: 127.0.0.1:3443\r\n"
            b"Connection: close\r\n\r\n"
        )
        response = b""
        while b"\r\n\r\n" not in response and len(response) <= 32768:
            chunk = secure.recv(4096)
            if not chunk:
                break
            response += chunk
headers = response.split(b"\r\n\r\n", 1)[0].lower()
if not headers.startswith(b"http/1.1 401 "):
    raise SystemExit("running TLS listener did not enforce the phone session gate")
if b"\r\nwww-authenticate: evogentphonesession\r\n" not in b"\r\n" + headers + b"\r\n":
    raise SystemExit("running TLS listener returned the wrong authentication gate")
PY
}

authenticated_release_server_live() {
  local target="$1" pane before_http before_tls after_http after_tls
  local client="$target/phone-tools/evo-curl"
  local canonical_health="http://127.0.0.1:${PHONE_PORT}/api/internal/phone-health"
  is_real_release_target "$target" \
    && release_dispatch_matches_target "$target" \
    && [ -x "$client" ] && [ ! -L "$client" ] \
    && [ -f "$target/phone-tools/evo_curl_transport.py" ] \
    && [ ! -L "$target/phone-tools/evo_curl_transport.py" ] || return 1
  pane="$(single_tmux_pane_pid evo)" || return 1
  before_http="$(phone_server_owner_fingerprint \
    "$pane" "$target/runtime" "$PHONE_PORT")" || return 1
  before_tls="$(phone_server_owner_fingerprint \
    "$pane" "$target/runtime" "$PHONE_HTTPS_PORT" "" "$PHONE_PORT")" \
    || return 1
  [ "$before_http" = "$before_tls" ] || return 1

  EVOGENT_PHONE_TOOLS="$target/phone-tools" \
    "$client" --silent --show-error --max-time 15 "$canonical_health" \
    2>/dev/null | python3 -c '
import json
import sys

health = json.load(sys.stdin)
if not (
    health["runtime"]["profile"] == "phone"
    and health["runtime"]["backgroundJobsDisabled"] is True
    and health["database"]["result"] == "ok"
):
    raise SystemExit(1)
' >/dev/null 2>&1 || return 1
  python3 - "$target/manifest.json" \
    "$target/runtime/.evogent-release.json" <<'PY' >/dev/null 2>&1 || return 1
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
identity = json.load(open(sys.argv[2], encoding="utf-8"))
if not (
    identity["releaseId"] == manifest["releaseId"]
    and identity["releaseFormat"] == manifest["releaseFormat"]
    and identity["buildId"] == manifest["web"]["buildId"]
    and identity["sourceCommit"] == manifest["source"]["commit"]
):
    raise SystemExit(1)
PY
  verify_phone_tls_listener "$target" >/dev/null 2>&1 || return 1
  pane="$(single_tmux_pane_pid evo)" || return 1
  after_http="$(phone_server_owner_fingerprint \
    "$pane" "$target/runtime" "$PHONE_PORT")" || return 1
  after_tls="$(phone_server_owner_fingerprint \
    "$pane" "$target/runtime" "$PHONE_HTTPS_PORT" "" "$PHONE_PORT")" \
    || return 1
  [ "$before_http" = "$after_http" ] \
    && [ "$before_http" = "$after_tls" ]
}

wait_for_authenticated_release_server() {
  local target="$1"
  for _ in $(seq 1 60); do
    authenticated_release_server_live "$target" && break
    sleep 2
  done
  authenticated_release_server_live "$target" || return 1
  sleep 1
  authenticated_release_server_live "$target"
}

authenticated_release_control_plane_live() {
  local target="$1" health_client="$1/phone-tools/evo-health"
  local client="$1/phone-tools/evo-curl"
  local canonical_health="http://127.0.0.1:${PHONE_PORT}/api/internal/phone-health"
  RELEASE_CONTROL_PROBE_REASON=server_proof
  authenticated_release_server_live "$target" || return 1
  RELEASE_CONTROL_PROBE_REASON=health_client_shape
  [ -x "$health_client" ] && [ ! -L "$health_client" ] || return 1
  RELEASE_CONTROL_PROBE_REASON=scheduler_owner
  scheduler_owner_live "$target" || return 1
  RELEASE_CONTROL_PROBE_REASON=watchdog_owner
  watchdog_owner_live "$target" || return 1
  RELEASE_CONTROL_PROBE_REASON=release_identity
  EVOGENT_PHONE_TOOLS="$target/phone-tools" \
  EVOGENT_EVO_CURL="$client" \
  EVOGENT_RELEASE_IDENTITY="$target/runtime/.evogent-release.json" \
  PORT="$PHONE_PORT" \
    "$health_client" >/dev/null 2>&1 || return 1
  RELEASE_CONTROL_PROBE_REASON=control_health_payload
  EVOGENT_PHONE_TOOLS="$target/phone-tools" \
    "$client" --fail --silent --show-error --max-time 15 "$canonical_health" \
    2>/dev/null | python3 -c '
import json
import sys

health = json.load(sys.stdin)
if not (
    health["ok"] is True
    and health["control"]["scheduler"]["live"] is True
    and health["control"]["watchdog"]["live"] is True
    and not health["criticalProblems"]
):
    raise SystemExit(1)
' >/dev/null 2>&1 || return 1
  RELEASE_CONTROL_PROBE_REASON=healthy
  return 0
}

wait_for_authenticated_release_control_plane() {
  local target="$1" consecutive=0 previous_reason="" safe_reason="" attempt
  # A package replacement can make the foreground shell and notification
  # listener issue short-lived loopback requests while the exact socket-owner
  # proof is running. Keep every strict predicate, but treat one success
  # followed by a transient miss as "not stable yet" rather than an immediate
  # rollback. Sixty bounded attempts preserve the existing retry ceiling.
  for attempt in $(seq 1 60); do
    if authenticated_release_control_plane_live "$target"; then
      consecutive=$((consecutive + 1))
      # Preserve the original three full proofs (the readiness hit, its
      # immediate recheck, and the delayed stability recheck).
      [ "$consecutive" -ge 3 ] && return 0
      sleep 1
      continue
    fi
    consecutive=0
    case "${RELEASE_CONTROL_PROBE_REASON:-unknown}" in
      server_proof|health_client_shape|scheduler_owner|watchdog_owner|\
release_identity|control_health_payload)
        safe_reason="$RELEASE_CONTROL_PROBE_REASON"
        ;;
      *) safe_reason=unknown ;;
    esac
    if [ "$safe_reason" != "$previous_reason" ]; then
      say "candidate control-plane proof pending ($safe_reason)"
      previous_reason="$safe_reason"
    fi
    sleep 2
  done
  say "candidate control-plane proof did not stabilize (${safe_reason:-unknown})"
  return 1
}

verify_committed_release_state() {
  local manifest="$NEW_RELEASE/manifest.json" probe code signer
  local expected_code expected_signer expected_sha
  is_real_release_target "$NEW_RELEASE" \
    && [ -f "$manifest" ] && [ ! -L "$manifest" ] \
    && [ "$(manifest_value "$manifest" schema)" = evogent.phone.release.v1 ] \
    && [ "$(manifest_value "$manifest" releaseId)" = "$RELEASE_ID" ] \
    && [ -L "$CURRENT" ] \
    && [ "$(readlink "$CURRENT")" = "releases/$RELEASE_ID" ] \
    && [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" = "$NEW_RELEASE" ] \
    && release_dispatch_matches_target "$NEW_RELEASE" || return 1

  expected_code="$(manifest_value "$manifest" android.versionCode)" || return 1
  expected_signer="$(manifest_value "$manifest" android.signerSha256)" || return 1
  expected_sha="$(manifest_value "$manifest" android.sha256)" || return 1
  probe="$STAGE/committed-release.apk"
  backup_installed_apk "$probe" || return 1
  code="$(installed_apk_version_code)" || return 1
  signer="$(apk_signer_sha256 "$probe" 2>/dev/null || true)"
  [ "$code" = "$expected_code" ] \
    && [ "$signer" = "$expected_signer" ] \
    && [ "$(sha256_file "$probe")" = "$expected_sha" ] || return 1
  if [ "$ANDROID_ROLES_APPLIED" = 1 ]; then
    converge_committed_android_roles || return 1
  fi

  CONTROL_PLANE_MUTATION_STARTED=1
  quiesce_control_plane || return 1
  QUIESCED=1
  stop_and_prove_runtime || return 1
  reap_abandoned_control_workers_and_prove_absent || return 1
  bash "$NEW_RELEASE/device/restart-evo.sh" || return 1
  set_tmux_control_release_root "$NEW_RELEASE" || return 1
  EVOGENT_RELEASE_RECOVERY=1 EVOGENT_RELEASE_BOOT=1 \
    EVOGENT_CONTROL_RELEASE_ROOT="$NEW_RELEASE" \
    bash "$NEW_RELEASE/phone-tools/evogent-boot.sh" || return 1
  wait_for_authenticated_release_control_plane "$NEW_RELEASE" \
    && { [ "$ANDROID_ROLES_APPLIED" = 0 ] \
      || converge_committed_android_roles; }
}

prune_committed_migration() {
  python3 - "$TRANSACTION_JOURNAL" "$MIGRATION_DIR" "$MIGRATIONS" <<'PY'
import json
import os
import pathlib
import re
import shutil
import stat
import sys

journal, migration, migrations = map(pathlib.Path, sys.argv[1:])
data = json.load(open(journal, encoding="utf-8"))
if (
    data.get("schema") not in {
        "evogent.phone.install-transaction.v2",
        "evogent.phone.install-transaction.v3",
        "evogent.phone.install-transaction.v4",
    }
    or data.get("phase") != "committed"
    or pathlib.Path(data.get("migrationDir", "")) != migration
    or migration.parent != migrations
    or re.fullmatch(r"(?:install|legacy)-[A-Za-z0-9._-]+", migration.name)
    is None
):
    raise SystemExit("committed migration identity is invalid")
try:
    metadata = os.lstat(migration)
except FileNotFoundError:
    pass
else:
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.getuid()
    ):
        raise SystemExit("committed migration directory is unsafe")
    for path in sorted(
        migration.rglob("*"),
        key=lambda item: len(item.parts),
        reverse=True,
    ):
        if path.is_symlink():
            continue
        try:
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
        except FileNotFoundError:
            pass
    os.chmod(migration, 0o700)
    shutil.rmtree(migration)
descriptor = os.open(migrations, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

finalize_committed_transaction_state() {
  [ "$COMMITTED" = 1 ] && [ "$TRANSACTION_PHASE" = committed ] \
    && [ -f "$TRANSACTION_JOURNAL" ] \
    && [ ! -L "$TRANSACTION_JOURNAL" ] || return 1
  DEPENDENCY_STATE_HELPER="$NEW_RELEASE/device/dependency-tree-state.py"
  [ -f "$DEPENDENCY_STATE_HELPER" ] \
    && [ ! -L "$DEPENDENCY_STATE_HELPER" ] || return 1
  if [ "$INITIAL_MIGRATION" = 1 ]; then
    python3 "$DEPENDENCY_STATE_HELPER" reclaim-legacy "$ROOT" || return 1
  fi
  python3 "$DEPENDENCY_STATE_HELPER" candidate-clear "$ROOT" "$RELEASE_ID" \
    || return 1
  prune_committed_migration
}

reap_recorded_package_operation() {
  [ -n "$PACKAGE_OPERATION" ] || return 0
  if remove_shell_package_operation "$PACKAGE_OPERATION"; then
    PACKAGE_OPERATION=""
    return 0
  fi
  say "CRITICAL: recorded Android package operation could not be reaped"
  return 1
}

reap_recorded_control_token_bridge() {
  [ -n "$CONTROL_TOKEN_BRIDGE" ] || return 0
  if remove_shell_staging_file "$CONTROL_TOKEN_BRIDGE"; then
    CONTROL_TOKEN_BRIDGE=""
    return 0
  fi
  say "CRITICAL: recorded phone control-token bridge could not be reaped"
  return 1
}

rollback_release() {
  say "install failed; rolling back the complete release"
  ROLLBACK_ATTEMPTED=1
  set +e
  if [ "$TRANSACTION_PHASE" = apk_user_action_required ]; then
    clear_apk_user_action_state
    if ! write_transaction_journal apk_install_pending; then
      ROLLBACK_FAILED=1
      say "CRITICAL: foreground install action could not enter rollback"
      set -e
      return 1
    fi
  fi
  CONTROL_PLANE_MUTATION_STARTED=1
  if ! quiesce_control_plane; then
    ROLLBACK_FAILED=1
    if [ "$SWITCH_STARTED" = 0 ] && [ "$MIGRATION_STARTED" = 0 ] \
        && [ "$APK_INSTALL_ATTEMPTED" = 0 ]; then
      REARM_PRIOR_CONTROL_PLANE=1
    fi
    say "CRITICAL: rollback cannot prove the scheduler/watchdog control plane is quiescent"
    set -e
    return 1
  fi
  if ! stop_and_prove_runtime; then
    ROLLBACK_FAILED=1
    if [ "$SWITCH_STARTED" = 0 ] && [ "$MIGRATION_STARTED" = 0 ] \
        && [ "$APK_INSTALL_ATTEMPTED" = 0 ]; then
      REARM_PRIOR_CONTROL_PLANE=1
    fi
    say "CRITICAL: rollback cannot prove the prior runtime is stopped"
    set -e
    return 1
  fi
  if ! reap_abandoned_control_workers_and_prove_absent; then
    ROLLBACK_FAILED=1
    say "CRITICAL: rollback cannot prove all tagged control workers are gone"
    set -e
    return 1
  fi
  QUIESCED=1
  if ! reap_recorded_control_token_bridge; then
    ROLLBACK_FAILED=1
    set -e
    return 1
  fi
  if ! normalize_dangling_legacy_predecessor; then
    ROLLBACK_FAILED=1
    say "CRITICAL: rollback could not safely normalize the prior runtime topology"
    set -e
    return 1
  fi
  if ! resolve_legacy_compat_expectation; then
    ROLLBACK_FAILED=1
    say "CRITICAL: rollback could not resolve legacy recovery intent"
    set -e
    return 1
  fi
  if ! rollback_seeded_defaults; then
    ROLLBACK_FAILED=1
    say "CRITICAL: rollback could not remove transaction-created defaults"
    set -e
    return 1
  fi
  if [ "$SWITCH_STARTED" = 1 ] || [ "$MIGRATION_STARTED" = 1 ]; then
    rollback_phone_dispatch_changes || ROLLBACK_FAILED=1
  fi
  if [ "$APK_CHANGED" = 1 ] && ! rollback_apk_native; then
    ROLLBACK_FAILED=1
  fi
  if [ "$ROLLBACK_FAILED" = 0 ] \
      && [ "$ANDROID_ROLE_RESTORE_REQUIRED" = 1 ] \
      && ! restore_android_roles; then
    say "CRITICAL: prior Android HOME/ASSISTANT roles could not be restored"
    ROLLBACK_FAILED=1
  fi
  if [ "$ROLLBACK_FAILED" = 0 ] && [ "$APK_CHANGED" = 1 ]; then
    # Package replacement may run code from an older predecessor whose
    # MY_PACKAGE_REPLACED policy predates recovery-only dispatch. Re-establish
    # the complete stopped proof after Android has restored that APK and before
    # any predecessor database or token bytes become visible.
    if ! quiesce_control_plane \
        || ! stop_and_prove_runtime \
        || ! reap_abandoned_control_workers_and_prove_absent; then
      say "CRITICAL: restored APK could not be made inert before state restoration"
      ROLLBACK_FAILED=1
    fi
  fi
  if [ -n "$PREVIOUS_TARGET" ] && ! is_real_release_target "$PREVIOUS_TARGET"; then
    say "CRITICAL: prior release target is unavailable or unsafe"
    ROLLBACK_FAILED=1
    restore_database || ROLLBACK_FAILED=1
    if ! restore_control_token; then
      ROLLBACK_FAILED=1
    fi
  elif [ -n "$PREVIOUS_TARGET" ]; then
    atomic_link "$PREVIOUS_TARGET" "$CURRENT" || ROLLBACK_FAILED=1
    restore_database || ROLLBACK_FAILED=1
    if ! restore_control_token; then
      ROLLBACK_FAILED=1
    fi
    if [ "$ROLLBACK_FAILED" = 0 ]; then
      if ! release_dispatch_matches_target "$PREVIOUS_TARGET"; then
        say "CRITICAL: restored release dispatch does not match its target"
        ROLLBACK_FAILED=1
      elif ! reap_dead_background_control_locks \
          || ! legacy_processes_absent \
          || ! phone_ports_stably_closed \
          || ! restored_background_control_stopped; then
        say "CRITICAL: restored release was not inert before rollback decision"
        ROLLBACK_FAILED=1
      else
        clear_tmux_control_release_root
        # No predecessor process may observe the restored database until the
        # non-replayable rolled_back decision is durable.
        REARM_PRIOR_CONTROL_PLANE=1
      fi
    fi
    if [ "$ROLLBACK_FAILED" = 1 ]; then
      quiesce_control_plane >/dev/null 2>&1 || true
      stop_and_prove_runtime >/dev/null 2>&1 || true
    fi
  else
    clear_tmux_control_release_root
    rollback_initial_migration || ROLLBACK_FAILED=1
    if [ "$ROLLBACK_FAILED" = 0 ]; then
      restore_database "$HOME/evogent/data/media-agent.db" \
        || ROLLBACK_FAILED=1
      restore_control_token || ROLLBACK_FAILED=1
    fi
    if [ "$ROLLBACK_FAILED" = 0 ]; then
      local legacy_topology
      legacy_topology="$(legacy_runtime_topology)" || legacy_topology=partial
      case "$LEGACY_RUNTIME_EXPECTED:$LEGACY_CONTROL_PLANE_EXPECTED:$legacy_topology" in
        0:0:absent)
          legacy_processes_absent && phone_ports_stably_closed \
            || ROLLBACK_FAILED=1
          RESTORED_LEGACY_CONTROL_PLANE=0
          ;;
        1:0:present)
          legacy_control_plane_stopped || ROLLBACK_FAILED=1
          RESTORED_LEGACY_CONTROL_PLANE=0
          ;;
        1:1:present)
          if legacy_control_plane_stopped; then
            RESTORED_LEGACY_CONTROL_PLANE=0
            REARM_PRIOR_CONTROL_PLANE=1
          else
            ROLLBACK_FAILED=1
          fi
          ;;
        *)
          say "CRITICAL: restored legacy topology does not match durable intent"
          ROLLBACK_FAILED=1
          ;;
      esac
    fi
  fi
  if [ -n "$PREVIOUS_TARGET" ]; then
    is_real_release_target "$PREVIOUS_TARGET" \
      && [ -L "$CURRENT" ] \
      && [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" = "$PREVIOUS_TARGET" ] \
      || ROLLBACK_FAILED=1
  elif [ -e "$CURRENT" ] || [ -L "$CURRENT" ]; then
    ROLLBACK_FAILED=1
  fi
  if [ "$ROLLBACK_FAILED" = 0 ] \
      && ! commit_rolled_back_decision; then
    say "CRITICAL: restored predecessor remains stopped because the rollback decision is not durable"
    ROLLBACK_FAILED=1
  fi
  set -e
  [ "$ROLLBACK_FAILED" = 0 ]
}

cleanup() {
  local rc=$? rearm_failed=0 previous_boot=""
  trap - EXIT INT TERM HUP
  if [ "$rc" -ne 0 ] && [ "$COMMITTED" = 0 ] \
    && [ "$ROLLBACK_ATTEMPTED" = 0 ] \
    && { [ "$SWITCH_STARTED" = 1 ] || [ "$MIGRATION_STARTED" = 1 ] \
      || [ "$QUIESCED" = 1 ] || [ "$CONTROL_PLANE_MUTATION_STARTED" = 1 ]; }; then
    rollback_release || true
  elif [ "$rc" -ne 0 ] && [ "$COMMITTED" = 0 ] \
      && [ "$ROLLBACK_ATTEMPTED" = 0 ] \
      && [ "$TRANSACTION_JOURNAL_WRITTEN" = 1 ]; then
    # The durable intent exists but no production mutation began. A graceful
    # failure can discard it; SIGKILL/reboot still leaves it for recovery.
    if clear_transaction_journal; then
      COMMITTED=1
      remove_transaction_recoverer || true
      prune_orphan_migrations || true
    fi
  fi
  if [ "$CYCLE_GATE_HELD" = 1 ]; then
    if release_lock_dir "$CYCLE_GATE"; then
      CYCLE_GATE_HELD=0
    else
      rc=70
    fi
  fi
  if [ "$CONTROL_MUTATION_GATE_HELD" = 1 ]; then
    if release_lock_dir "$CONTROL_MUTATION_GATE"; then
      CONTROL_MUTATION_GATE_HELD=0
    else
      rc=70
    fi
  fi
  [ -n "$STAGE" ] && [ -d "$STAGE" ] && rm -rf -- "$STAGE"
  if [ "$REARM_PRIOR_CONTROL_PLANE" = 1 ] \
      && [ "$ROLLBACK_DECISION_DURABLE" = 1 ] \
      && [ "$TRANSACTION_PHASE" = rolled_back ] \
      && [ -f "$TRANSACTION_JOURNAL" ] \
      && [ ! -L "$TRANSACTION_JOURNAL" ] \
      && [ "$CYCLE_GATE_HELD" = 0 ] \
      && [ "$CONTROL_MUTATION_GATE_HELD" = 0 ] \
      && [ "$INSTALL_LOCK_HELD" = 1 ] \
      && { [ -n "$PREVIOUS_TARGET" ] \
        || [ "$LEGACY_CONTROL_PLANE_EXPECTED" = 1 ]; }; then
    if [ -n "$PREVIOUS_TARGET" ]; then
      previous_boot="$PREVIOUS_TARGET/phone-tools/evogent-boot.sh"
      if is_real_release_target "$PREVIOUS_TARGET" \
          && safe_private_program "$previous_boot"; then
        EVOGENT_RELEASE_RECOVERY=1 EVOGENT_RELEASE_BOOT=1 \
            EVOGENT_CONTROL_RELEASE_ROOT="$PREVIOUS_TARGET" \
            bash "$previous_boot" \
          && set_tmux_control_release_root "$PREVIOUS_TARGET" \
          && wait_for_authenticated_release_control_plane "$PREVIOUS_TARGET" \
          || rearm_failed=1
      else
        rearm_failed=1
      fi
    elif safe_private_program "$HOME/phone-tools/evogent-boot.sh"; then
      rearm_legacy_server \
        && rearm_legacy_control_plane \
        || rearm_failed=1
    else
      rearm_failed=1
    fi
    if [ "$rearm_failed" = 1 ]; then
      say "CRITICAL: prior control plane could not be re-armed after durable rollback"
      SUCCESS=0
      rc=70
    fi
  elif [ "$REARM_PRIOR_CONTROL_PLANE" = 1 ]; then
    say "prior control-plane rearm remains deferred until rollback is durable"
    rc=70
  fi
  if [ "$rearm_failed" = 0 ] \
      && [ "$ROLLBACK_DECISION_DURABLE" = 1 ] \
      && [ "$TRANSACTION_PHASE" = rolled_back ] \
      && [ "$CYCLE_GATE_HELD" = 0 ] \
      && [ "$CONTROL_MUTATION_GATE_HELD" = 0 ] \
      && [ "$INSTALL_LOCK_HELD" = 1 ]; then
    if retire_rolled_back_transaction_journal; then
      remove_transaction_recoverer || true
      prune_orphan_migrations || true
    else
      say "CRITICAL: durable rollback decision could not be retired after predecessor proof"
      SUCCESS=0
      rc=70
    fi
  fi
  if [ "$INSTALL_LOCK_HELD" = 1 ] \
      && [ -f "$DEPENDENCY_STATE_HELPER" ] \
      && [ ! -L "$DEPENDENCY_STATE_HELPER" ]; then
    # This safely makes sealed trees removable and also reaps a failed release
    # candidate after rollback has retired its durable transaction journal.
    python3 "$DEPENDENCY_STATE_HELPER" prune "$ROOT" || true
  elif [ -n "$DEPENDENCY_BUILD" ] \
      && [ -d "$DEPENDENCY_BUILD" ] \
      && [ "$(dirname "$DEPENDENCY_BUILD")" = "$DEPENDENCY_BUILDS" ]; then
    rm -rf -- "$DEPENDENCY_BUILD"
  fi
  # Keep the exclusive install lease through predecessor rearm and journal
  # retirement. Package-replaced receivers may already be waiting here; they
  # must observe either the intact transaction or its fully retired state,
  # never a half-rearmed predecessor.
  if [ "$INSTALL_LOCK_HELD" = 1 ]; then
    if release_lock_dir "$INSTALL_LOCK"; then
      INSTALL_LOCK_HELD=0
    else
      rc=70
    fi
  fi
  if [ "$SUCCESS" = 1 ] && [ "$RECOVERY_ACTIVE" = 1 ]; then
    say "interrupted release transaction recovered"
  elif [ "$SUCCESS" = 1 ]; then
    say "release install complete: $RELEASE_ID"
  else
    say "release install exited with status $rc"
    [ "$ROLLBACK_FAILED" = 1 ] \
      && say "CRITICAL: complete release rollback could not be proven; the recovery journal was retained"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

recover_interrupted_transaction() {
  local journal="$1" restored_target
  RECOVERY_ACTIVE=1
  [ "$journal" = "$TRANSACTION_JOURNAL" ] || {
    say "interrupted install recovery path is invalid"
    return 65
  }
  acquire_lock_dir "$INSTALL_LOCK" release-install-recovery
  INSTALL_LOCK_HELD=1
  if [ ! -e "$journal" ] && [ ! -L "$journal" ]; then
    # A concurrent recoverer may have completed while this process waited.
    SUCCESS=1
    return 0
  fi
  [ -f "$journal" ] && [ ! -L "$journal" ] \
    && [ -f "$TRANSACTION_RECOVERER" ] && [ ! -L "$TRANSACTION_RECOVERER" ] || {
      say "interrupted install recovery metadata is missing or unsafe"
      return 65
    }
  [ "$(stat -c '%a' "$journal")" = 600 ] \
    && [ "$(stat -c '%a' "$TRANSACTION_RECOVERER")" = 700 ] || {
      say "interrupted install recovery metadata is not private"
      return 65
    }
  validate_transaction_journal "$journal" || return 65

  local journal_schema
  journal_schema="$(journal_field "$journal" schema)"
  TRANSACTION_PHASE="$(journal_field "$journal" phase)"
  if [ "$journal_schema" != evogent.phone.install-transaction.v1 ] \
      && [ "$TRANSACTION_PHASE" = committed ]; then
    # The durable decision is authoritative before any fallible recovery work.
    COMMITTED=1
  elif [ "$journal_schema" != evogent.phone.install-transaction.v1 ] \
      && [ "$TRANSACTION_PHASE" = rolled_back ]; then
    ROLLBACK_DECISION_DURABLE=1
  fi
  RELEASE_ID="$(journal_field "$journal" releaseId)"
  NEW_RELEASE="$(journal_field "$journal" newRelease)"
  PREVIOUS_TARGET="$(journal_field "$journal" previousTarget)"
  BACKUP_DIR="$(journal_field "$journal" backupDir)"
  DB_BACKUP="$(journal_field "$journal" dbBackup)"
  DB_BACKUP_READY="$(journal_field "$journal" dbBackupReady)"
  APK_BACKUP="$(journal_field "$journal" apkBackup)"
  APK_BACKUP_READY="$(journal_field "$journal" apkBackupReady)"
  APK_CHANGED="$(journal_field "$journal" apkChanged)"
  APK_INSTALL_ATTEMPTED="$(journal_field "$journal" apkInstallAttempted)"
  PACKAGE_OPERATION="$(journal_optional_field "$journal" packageOperation)"
  PREVIOUS_APK_CODE="$(journal_field "$journal" previousApkCode)"
  PREVIOUS_APK_SIGNER="$(journal_field "$journal" previousApkSigner)"
  INITIAL_MIGRATION="$(journal_field "$journal" initialMigration)"
  if [ "$journal_schema" = evogent.phone.install-transaction.v2 ] \
      || [ "$journal_schema" = evogent.phone.install-transaction.v3 ] \
      || [ "$journal_schema" = evogent.phone.install-transaction.v4 ]; then
    DB_EXISTED="$(journal_field "$journal" dbExisted)"
    LEGACY_RUNTIME_EXPECTED="$(journal_field "$journal" legacyRuntimeExpected)"
    LEGACY_CONTROL_PLANE_EXPECTED="$(
      journal_field "$journal" legacyControlPlaneExpected
    )"
    LEGACY_SNAPSHOT_READY="$(journal_field "$journal" legacySnapshotReady)"
    LEGACY_PLAN_SHA256="$(journal_field "$journal" legacyPlanSha256)"
    LEGACY_EXPECTATION_COMPAT=0
  else
    DB_EXISTED="$DB_BACKUP_READY"
    LEGACY_RUNTIME_EXPECTED=-1
    LEGACY_CONTROL_PLANE_EXPECTED=-1
    LEGACY_SNAPSHOT_READY=0
    LEGACY_PLAN_SHA256=""
    LEGACY_EXPECTATION_COMPAT=1
  fi
  MIGRATION_STARTED="$(journal_field "$journal" migrationStarted)"
  SWITCH_STARTED="$(journal_field "$journal" switchStarted)"
  MIGRATION_DIR="$(journal_field "$journal" migrationDir)"
  CYCLE_GATE="$(journal_field "$journal" cycleGate)"
  CONTROL_TOKEN="$(journal_field "$journal" controlToken)"
  CONTROL_TOKEN_BACKUP="$(journal_field "$journal" controlTokenBackup)"
  CONTROL_TOKEN_EXISTED="$(journal_field "$journal" controlTokenExisted)"
  CONTROL_TOKEN_BACKUP_READY="$(journal_field "$journal" controlTokenBackupReady)"
  CONTROL_TOKEN_BRIDGE="$(journal_optional_field "$journal" controlTokenBridge)"
  if [ "$journal_schema" = evogent.phone.install-transaction.v3 ] \
      || [ "$journal_schema" = evogent.phone.install-transaction.v4 ]; then
    ANDROID_ROLE_BACKUP="$(journal_field "$journal" androidRoleBackup)"
    ANDROID_ROLE_BACKUP_READY="$(
      journal_field "$journal" androidRoleBackupReady
    )"
    ANDROID_ROLE_BACKUP_SHA256="$(
      journal_field "$journal" androidRoleBackupSha256
    )"
    ANDROID_ROLE_USER_ID="$(journal_field "$journal" androidRoleUserId)"
    ANDROID_ROLE_RESTORE_REQUIRED="$(
      journal_field "$journal" androidRoleRestoreRequired
    )"
    ANDROID_ROLE_MUTATION_ATTEMPTED="$(
      journal_field "$journal" androidRoleMutationAttempted
    )"
    ANDROID_ROLES_APPLIED="$(journal_field "$journal" androidRolesApplied)"
  else
    ANDROID_ROLE_BACKUP=""
    ANDROID_ROLE_BACKUP_READY=0
    ANDROID_ROLE_BACKUP_SHA256=""
    ANDROID_ROLE_USER_ID=""
    ANDROID_ROLE_RESTORE_REQUIRED=0
    ANDROID_ROLE_MUTATION_ATTEMPTED=0
    ANDROID_ROLES_APPLIED=0
  fi
  if [ "$journal_schema" = evogent.phone.install-transaction.v4 ]; then
    APK_USER_ACTION_KIND="$(
      journal_optional_field "$journal" apkUserActionKind
    )"
    APK_USER_ACTION_PURPOSE="$(
      journal_optional_field "$journal" apkUserActionPurpose
    )"
    APK_USER_ACTION_EVIDENCE="$(
      journal_optional_field "$journal" apkUserActionEvidence
    )"
    APK_USER_ACTION_TARGET_SHA256="$(
      journal_optional_field "$journal" apkUserActionTargetSha256
    )"
    APK_USER_ACTION_TARGET_VERSION_CODE="$(
      journal_optional_field "$journal" apkUserActionTargetVersionCode
    )"
    APK_USER_ACTION_TARGET_SIGNER_SHA256="$(
      journal_optional_field "$journal" apkUserActionTargetSignerSha256
    )"
  else
    clear_apk_user_action_state
  fi
  TRANSACTION_JOURNAL_WRITTEN=1
  MANIFEST_PATH="$NEW_RELEASE/manifest.json"
  DEPENDENCY_STATE_HELPER="$NEW_RELEASE/device/dependency-tree-state.py"
  ROLLBACK_STATE_HELPER="$NEW_RELEASE/device/rollback-state.py"
  ANDROID_ROLE_STATE_HELPER="$NEW_RELEASE/device/android-role-state.py"
  EXPECTED_APK_CODE="$(manifest_value "$MANIFEST_PATH" android.versionCode)"
  EXPECTED_APK_SIGNER="$(
    manifest_value "$MANIFEST_PATH" android.signerSha256
  )"
  EXPECTED_APK_SHA256="$(manifest_value "$MANIFEST_PATH" android.sha256)"
  STAGE="$(mktemp -d "$STAGING_ROOT/recover.XXXXXX")"

  if [ "$TRANSACTION_PHASE" != committed ]; then
    select_recovery_cycle_gate
  fi
  acquire_lock_dir "$CYCLE_GATE" release-install-recovery-cycle-gate
  CYCLE_GATE_HELD=1

  if [ "$TRANSACTION_PHASE" = committed ] \
      || [ "$APK_INSTALL_ATTEMPTED" = 1 ] \
      || [ -n "$CONTROL_TOKEN_BRIDGE" ]; then
    for _ in $(seq 1 12); do
      rish_command "id" 2>/dev/null | grep -q 'uid=2000' && break
      sleep 5
    done
  fi

  say "recovering interrupted release transaction at phase $TRANSACTION_PHASE"
  if [ "$TRANSACTION_PHASE" = committed ]; then
    if ! verify_committed_release_state; then
      say "CRITICAL: committed release could not be re-proven; its durable decision was retained"
      return 70
    fi
    if ! finalize_committed_transaction_state; then
      say "CRITICAL: committed release finalization did not converge"
      return 70
    fi
    clear_transaction_journal || return 70
    remove_transaction_recoverer || return 70
    prune_orphan_migrations \
      || say "warning: post-commit orphan cleanup did not complete"
    SUCCESS=1
    return 0
  fi
  if [ "$TRANSACTION_PHASE" = rolled_back ]; then
    # A predecessor may have become partially live before a crash during
    # post-decision rearm. Stop it without replaying any backup: writes made
    # after the rolled_back decision are authoritative.
    CONTROL_PLANE_MUTATION_STARTED=1
    if ! quiesce_control_plane || ! stop_and_prove_runtime; then
      say "CRITICAL: durable rollback recovery could not make the predecessor inert"
      ROLLBACK_FAILED=1
      return 70
    fi
    if ! reap_abandoned_control_workers_and_prove_absent; then
      say "CRITICAL: durable rollback recovery found an uncontained control worker"
      ROLLBACK_FAILED=1
      return 70
    fi
    QUIESCED=1
  else
    rollback_release || true
  fi
  [ "$ROLLBACK_FAILED" = 0 ] || return 70
  if [ -n "$PREVIOUS_TARGET" ]; then
    restored_target="$(readlink -f "$CURRENT" 2>/dev/null || true)"
    is_real_release_target "$PREVIOUS_TARGET" \
      && [ -L "$CURRENT" ] && [ "$restored_target" = "$PREVIOUS_TARGET" ] || {
      say "CRITICAL: interrupted install did not restore the prior release pointer"
      return 70
    }
  elif [ -e "$CURRENT" ] || [ -L "$CURRENT" ]; then
    say "CRITICAL: interrupted initial install left a release pointer behind"
    return 70
  fi
  if [ "$CONTROL_TOKEN_BACKUP_READY" = 1 ] && [ "$CONTROL_TOKEN_EXISTED" = 1 ]; then
    local restored_token="$CONTROL_TOKEN"
    if [ "$INITIAL_MIGRATION" = 1 ]; then
      restored_token="$HOME/evogent/data/control-token.txt"
    fi
    cmp -s "$CONTROL_TOKEN_BACKUP" "$restored_token" || {
      say "CRITICAL: interrupted install did not restore the prior phone control token"
      return 70
    }
    [ "$(stat -c '%a' "$restored_token")" = 600 ] || {
      say "CRITICAL: restored phone control token permissions are unsafe"
      return 70
    }
  fi
  if [ -n "$PREVIOUS_TARGET" ]; then
    release_dispatch_matches_target "$PREVIOUS_TARGET" \
      && reap_dead_background_control_locks \
      && legacy_processes_absent \
      && phone_ports_stably_closed \
      && restored_background_control_stopped || {
      say "CRITICAL: restored release was not inert before predecessor rearm"
      quiesce_control_plane >/dev/null 2>&1 || true
      stop_and_prove_runtime >/dev/null 2>&1 || true
      ROLLBACK_FAILED=1
      return 70
    }
    REARM_PRIOR_CONTROL_PLANE=1
  else
    case "$LEGACY_RUNTIME_EXPECTED:$LEGACY_CONTROL_PLANE_EXPECTED" in
      1:1)
        legacy_control_plane_stopped || {
          say "CRITICAL: restored legacy runtime was not inert before predecessor rearm"
          quiesce_control_plane >/dev/null 2>&1 || true
          stop_and_prove_runtime >/dev/null 2>&1 || true
          ROLLBACK_FAILED=1
          return 70
        }
        REARM_PRIOR_CONTROL_PLANE=1
        ;;
      1:0)
        [ "$(legacy_runtime_topology 2>/dev/null || true)" = present ] \
          && legacy_control_plane_stopped || {
          say "CRITICAL: stopped legacy state changed before recovery commit"
          ROLLBACK_FAILED=1
          return 70
        }
        ;;
      0:0)
        [ "$(legacy_runtime_topology 2>/dev/null || true)" = absent ] \
          && legacy_processes_absent \
          && phone_ports_stably_closed || {
          say "CRITICAL: fresh-install rollback left production state behind"
          ROLLBACK_FAILED=1
          return 70
        }
        ;;
      *)
        say "CRITICAL: recovery has an invalid legacy expectation"
        ROLLBACK_FAILED=1
        return 70
        ;;
    esac
  fi
  # cleanup releases every installer/cycle gate, re-arms the predecessor while
  # the non-replayable decision remains durable, proves its contract, and only
  # then retires the journal.
  SUCCESS=1
}

if [ -n "$RECOVERY_JOURNAL_ARG" ]; then
  recover_interrupted_transaction "$RECOVERY_JOURNAL_ARG"
  exit 0
fi

acquire_install_lock_and_recover_prior_transactions() {
  acquire_lock_dir "$INSTALL_LOCK" release-install
  INSTALL_LOCK_HELD=1
  if [ "$FORWARD_SUPERSEDE" = 1 ]; then
    [ -f "$TRANSACTION_JOURNAL" ] && [ ! -L "$TRANSACTION_JOURNAL" ] \
      && [ "$(stat -c '%a' "$TRANSACTION_JOURNAL")" = 600 ] \
      && [ "$(stat -c '%u' "$TRANSACTION_JOURNAL")" = "$(id -u)" ] \
      && [ "$(stat -c '%h' "$TRANSACTION_JOURNAL")" = 1 ] \
      && [ -f "$TRANSACTION_RECOVERER" ] && [ ! -L "$TRANSACTION_RECOVERER" ] \
      && [ "$(stat -c '%a' "$TRANSACTION_RECOVERER")" = 700 ] \
      && [ "$(stat -c '%u' "$TRANSACTION_RECOVERER")" = "$(id -u)" ] \
      && [ "$(stat -c '%h' "$TRANSACTION_RECOVERER")" = 1 ] || {
      say "forward supersede requires one exact private interrupted transaction"
      return 70
    }
    return 0
  fi
  while [ -e "$TRANSACTION_JOURNAL" ] || [ -L "$TRANSACTION_JOURNAL" ]; do
    [ -f "$TRANSACTION_RECOVERER" ] && [ ! -L "$TRANSACTION_RECOVERER" ] \
      && [ "$(stat -c '%a' "$TRANSACTION_RECOVERER")" = 700 ] || {
        say "a prior interrupted install has no safe private recovery program"
        return 70
      }
    say "recovering the prior interrupted release before accepting a new archive"
    release_lock_dir "$INSTALL_LOCK"
    INSTALL_LOCK_HELD=0
    bash "$TRANSACTION_RECOVERER" --recover "$TRANSACTION_JOURNAL" || return 70
    acquire_lock_dir "$INSTALL_LOCK" release-install
    INSTALL_LOCK_HELD=1
    # Recheck under the reacquired lock. Another transaction may have started
    # and been interrupted while this process waited for the first recoverer.
  done
}

acquire_install_lock_and_recover_prior_transactions
if [ "$FORWARD_SUPERSEDE" = 0 ]; then
  prune_orphan_migrations || {
    say "orphaned migration state could not be pruned safely"
    exit 70
  }
fi

ACTUAL_ARCHIVE_SHA256="$(sha256_file "$ARCHIVE")"
[ "${ACTUAL_ARCHIVE_SHA256,,}" = "${EXPECTED_ARCHIVE_SHA256,,}" ] || {
  say "archive checksum mismatch"
  exit 65
}

STAGE="$(mktemp -d "$STAGING_ROOT/install.XXXXXX")"
python3 - "$ARCHIVE" "$STAGE" <<'PY'
import pathlib
import posixpath
import sys
import tarfile

archive, destination = sys.argv[1:]
root = pathlib.Path(destination).resolve()
with tarfile.open(archive, "r:gz") as bundle:
    for member in bundle.getmembers():
        name = member.name
        pure = pathlib.PurePosixPath(name)
        if pure.is_absolute() or ".." in pure.parts or not pure.parts or pure.parts[0] != "release":
            raise SystemExit(f"unsafe archive member: {name!r}")
        if member.isdev() or member.isfifo() or member.ischr() or member.isblk() or member.islnk():
            raise SystemExit(f"unsupported archive member type: {name!r}")
        if member.issym():
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if not resolved.startswith("release/"):
                raise SystemExit(f"symlink escapes release: {name!r}")
    bundle.extractall(root)
PY

EXTRACTED="$STAGE/release"
[ -f "$EXTRACTED/manifest.json" ] \
  && [ -f "$EXTRACTED/files.sha256" ] \
  && [ -f "$EXTRACTED/links.json" ] || {
    say "release metadata is incomplete"
    exit 65
}
[ -f "$EXTRACTED/tls/server-key.pem" ] \
  && [ ! -L "$EXTRACTED/tls/server-key.pem" ] \
  && chmod 600 "$EXTRACTED/tls/server-key.pem"

MANIFEST_PATH="$EXTRACTED/manifest.json"
read_manifest() {
  manifest_value "$MANIFEST_PATH" "$1"
}

smoke_android_dependency_tree() {
  local tree="$1"
  (
    cd "$tree"
    npm ls --omit=dev --depth=0 >/dev/null
    node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES (1)');
if (db.prepare('SELECT value FROM proof').get().value !== 1) {
  throw new Error('better-sqlite3 Android smoke check failed');
}
db.close();
for (const name of ['next', 'better-sqlite3', 'ws', 'dotenv', 'bullmq']) {
  require.resolve(name);
}
NODE
  )
}

verify_android_dependency_tree() {
  local tree="$1" expected_lock="$2"
  [ -f "$DEPENDENCY_STATE_HELPER" ] && [ ! -L "$DEPENDENCY_STATE_HELPER" ] || return 1
  python3 "$DEPENDENCY_STATE_HELPER" verify "$tree" "$expected_lock" || return 1
  smoke_android_dependency_tree "$tree"
}

prepare_android_dependency_tree() {
  local expected_lock="$1" target="$DEPENDENCIES/$1"
  local node_gyp
  [[ "$expected_lock" =~ ^[0-9a-f]{64}$ ]] || {
    say "release dependency identity is invalid"
    return 65
  }
  if verify_android_dependency_tree "$target" "$expected_lock"; then
    say "reusing verified Android dependency tree"
    return 0
  fi

  DEPENDENCY_BUILD="$(mktemp -d "$DEPENDENCY_BUILDS/$expected_lock.XXXXXX")"
  cp "$NEW_RELEASE/runtime/package.json" "$DEPENDENCY_BUILD/package.json"
  cp "$NEW_RELEASE/runtime/package-lock.json" "$DEPENDENCY_BUILD/package-lock.json"
  chmod 600 "$DEPENDENCY_BUILD/package.json" "$DEPENDENCY_BUILD/package-lock.json"

  # Android packages do not publish a compatible better-sqlite3 prebuild. Install the exact
  # public lock without lifecycle scripts, then compile that one native addon against the
  # Termux toolchain. Host-only optional packages (the embedding model, SWC, and image
  # optimizers) remain absent. The production Next config is plain CommonJS, so startup
  # never needs the omitted SWC compiler; runtime features have explicit Android fallbacks.
  (
    cd "$DEPENDENCY_BUILD"
    npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
  )
  node_gyp="$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js"
  [ -f "$node_gyp" ] || {
    say "Termux npm does not expose its bundled node-gyp"
    return 69
  }
  (
    cd "$DEPENDENCY_BUILD/node_modules/better-sqlite3"
    GYP_DEFINES="android_ndk_path=$PREFIX" \
      node "$node_gyp" rebuild --release
  )

  printf '%s\n' "$expected_lock" > "$DEPENDENCY_BUILD/.evogent-package-lock.sha256"
  chmod 600 "$DEPENDENCY_BUILD/.evogent-package-lock.sha256"
  python3 "$DEPENDENCY_STATE_HELPER" seal "$DEPENDENCY_BUILD" "$expected_lock" || {
    say "new Android dependency tree could not be inventoried and sealed"
    return 70
  }
  sync -f "$DEPENDENCY_BUILD"
  if [ -e "$target" ] || [ -L "$target" ]; then
    say "quarantining invalid Android dependency tree during atomic replacement"
  fi
  python3 "$DEPENDENCY_STATE_HELPER" publish \
    "$DEPENDENCY_BUILD" "$target" "$DEPENDENCY_QUARANTINE" "$expected_lock" || {
      say "Android dependency tree could not be published atomically"
      return 70
    }
  DEPENDENCY_BUILD=""
  smoke_android_dependency_tree "$target" || {
    say "published Android dependency tree failed its native runtime smoke test"
    return 70
  }
  say "built and verified versioned Android dependency tree"
}

verify_release_runtime_prepared() {
  smoke_android_dependency_tree "$DEPENDENCIES/$EXPECTED_PACKAGE_LOCK" \
    || return 1
  (
    cd "$NEW_RELEASE/runtime"
    npm ls --omit=dev --depth=0 >/dev/null
    timeout -k 5 120 env NODE_ENV=production node <<'NODE'
for (const name of ['next', 'better-sqlite3', 'ws', 'dotenv']) {
  require.resolve(name);
}
const next = require('next');
const app = next({
  dev: false,
  dir: process.cwd(),
  hostname: '127.0.0.1',
  port: 3001,
});
async function prepareAndClose() {
  try {
    await app.prepare();
  } finally {
    await app.close();
  }
}
prepareAndClose().catch((error) => {
  console.error('release install: production Next runtime preparation failed');
  console.error(error);
  process.exitCode = 1;
});
NODE
  )
}

validate_release_phone_tools_namespace() {
  python3 - "$1" <<'PY'
import os
import pathlib
import re
import sys

tools = pathlib.Path(sys.argv[1]) / "phone-tools"
if not tools.is_dir() or tools.is_symlink():
    raise SystemExit("release phone-tools is not a real directory")
reserved = {
    "__pycache__",
    "browse-benchmark-results.txt",
    "cu-micro-results.txt",
    "install-release.sh",
    "last-cycle-newitems",
    "scheduler.log",
}
for child in tools.iterdir():
    name = child.name
    if (
        re.fullmatch(r"[A-Za-z0-9._-]+", name) is None
        or name.startswith(".")
        or name in reserved
        or name.endswith((".pyc", ".pyo"))
    ):
        raise SystemExit(f"release phone-tools collides with mutable state: {name}")
    metadata = os.lstat(child)
    if not (
        pathlib.Path(child).is_file()
        or pathlib.Path(child).is_dir()
        or pathlib.Path(child).is_symlink()
    ):
        raise SystemExit(f"unsupported release phone-tools entry: {name}")
PY
}

verify_release_tls_material() {
  local release_root="$1"
  local cert="$release_root/tls/server-cert.pem"
  local key="$release_root/tls/server-key.pem"
  local embedded_ca="$STAGE/release-ca.pem"
  [ -f "$cert" ] && [ ! -L "$cert" ] \
    && [ -f "$key" ] && [ ! -L "$key" ] || {
      say "release TLS certificate/key are missing or not regular files"
      return 1
    }
  [ "$(stat -c '%a' "$key")" = 600 ] || {
    say "release TLS private key permissions are not 0600"
    return 1
  }
  unzip -p "$release_root/apk/evogent.apk" res/raw/evogent_phone_ca.pem \
    > "$embedded_ca" || return 1
  [ -s "$embedded_ca" ] || {
    say "release APK does not contain its private CA certificate"
    return 1
  }
  openssl x509 -in "$cert" -noout -checkend 0 >/dev/null || {
    say "release TLS certificate is not currently valid"
    return 1
  }
  openssl verify -purpose sslserver -CAfile "$embedded_ca" "$cert" >/dev/null || {
    say "release TLS certificate does not chain to the APK CA"
    return 1
  }
  local san cert_hash expected_hash
  san="$(openssl x509 -in "$cert" -noout -ext subjectAltName \
    | tail -n +2 | tr -d '[:space:]')"
  [ "$san" = "IPAddress:127.0.0.1" ] || {
    say "release TLS certificate does not have the exact loopback IP SAN"
    return 1
  }
  openssl x509 -in "$cert" -pubkey -noout \
    | openssl pkey -pubin -outform DER > "$STAGE/release-cert.pub" || return 1
  openssl pkey -in "$key" -pubout -outform DER > "$STAGE/release-key.pub" || return 1
  cmp -s "$STAGE/release-cert.pub" "$STAGE/release-key.pub" || {
    say "release TLS certificate and private key do not match"
    return 1
  }
  cert_hash="$(openssl x509 -in "$cert" -outform DER \
    | openssl dgst -sha256 -r | awk '{print $1}')"
  expected_hash="$(read_manifest phoneTls.certificateDerSha256)"
  [ "$cert_hash" = "$expected_hash" ] || {
    say "release TLS certificate identity does not match the manifest"
    return 1
  }
  [ "$(read_manifest phoneTls.host)" = 127.0.0.1 ] \
    && [ "$(read_manifest phoneTls.port)" = "$PHONE_HTTPS_PORT" ] || {
      say "release TLS listener identity is incompatible with the APK"
      return 1
    }
}

[ "$(read_manifest schema)" = "evogent.phone.release.v1" ] \
  && [ "$(read_manifest releaseFormat)" = 1 ] || {
    say "unsupported release schema"
    exit 65
}
RELEASE_ID="$(read_manifest releaseId)"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]{1,120}$ ]] \
  && [ "$RELEASE_ID" != . ] && [ "$RELEASE_ID" != .. ] || {
  say "unsafe release id"
  exit 65
}
[ "$(read_manifest phoneTls.host)" = 127.0.0.1 ] \
  && [ "$(read_manifest phoneTls.port)" = "$PHONE_HTTPS_PORT" ] || {
    say "release does not target the exact Android HTTPS origin"
    exit 65
  }
EXPECTED_INVENTORY="$(read_manifest inventory.sha256)"
EXPECTED_LINKS="$(read_manifest inventory.linksSha256)"
[ "$(sha256_file "$EXTRACTED/files.sha256")" = "$EXPECTED_INVENTORY" ] \
  && [ "$(sha256_file "$EXTRACTED/links.json")" = "$EXPECTED_LINKS" ] || {
    say "release inventory metadata mismatch"
    exit 65
}

(cd "$EXTRACTED" && sha256sum -c files.sha256)
validate_release_phone_tools_namespace "$EXTRACTED" || exit 65
verify_release_tls_material "$EXTRACTED" || exit 65
python3 - "$EXTRACTED" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
links = json.loads((root / "links.json").read_text(encoding="utf-8"))
for relative, expected in links.items():
    path = root / relative
    if not path.is_symlink() or os.readlink(path) != expected:
        raise SystemExit(f"symlink inventory mismatch: {relative}")
for relative in manifest["requiredPaths"]:
    if not (root / relative).exists():
        raise SystemExit(f"required release path missing: {relative}")
identity = json.loads((root / "runtime/.evogent-release.json").read_text(encoding="utf-8"))
if identity["releaseId"] != manifest["releaseId"]:
    raise SystemExit("runtime identity does not match manifest")
release_identity = (
    f"apk-sha256:{manifest['android']['sha256']}\n"
    f"tls-cert-der-sha256:{manifest['phoneTls']['certificateDerSha256']}\n"
)
identity_digest = hashlib.sha256(release_identity.encode("ascii")).hexdigest()[:12]
if manifest.get("releaseIdentityDigest") != identity_digest:
    raise SystemExit("manifest APK/TLS release identity digest is invalid")
if identity.get("releaseIdentityDigest") != identity_digest:
    raise SystemExit("runtime APK/TLS release identity digest is invalid")
if not manifest["releaseId"].endswith("-" + identity_digest):
    raise SystemExit("release id is not bound to its APK/TLS identity")
if (root / "runtime/.next/BUILD_ID").read_text().strip() != manifest["web"]["buildId"]:
    raise SystemExit("Next.js BUILD_ID does not match manifest")
PY

DEPENDENCY_STATE_HELPER="$EXTRACTED/device/dependency-tree-state.py"
[ -f "$DEPENDENCY_STATE_HELPER" ] && [ ! -L "$DEPENDENCY_STATE_HELPER" ] || {
  say "release dependency-state helper is missing or unsafe"
  exit 65
}
ROLLBACK_STATE_HELPER="$EXTRACTED/device/rollback-state.py"
[ -f "$ROLLBACK_STATE_HELPER" ] && [ ! -L "$ROLLBACK_STATE_HELPER" ] || {
  say "release rollback-state helper is missing or unsafe"
  exit 65
}
ANDROID_ROLE_STATE_HELPER="$EXTRACTED/device/android-role-state.py"
android_role_state_helper_safe || {
  say "release Android role-state helper is missing or unsafe"
  exit 65
}
# This runs while the exclusive install lock is held and before a new dependency
# build begins. It bounds artifacts left by SIGKILL, reboot, or a failed candidate.
if [ "$FORWARD_SUPERSEDE" = 0 ]; then
  python3 "$DEPENDENCY_STATE_HELPER" prune "$ROOT" || {
    say "stale dependency/release state could not be pruned safely"
    exit 70
  }
fi

NEW_RELEASE="$RELEASES/$RELEASE_ID"
if [ -e "$NEW_RELEASE" ]; then
  [ -f "$NEW_RELEASE/manifest.json" ] \
    && [ "$(sha256_file "$NEW_RELEASE/manifest.json")" = "$(sha256_file "$EXTRACTED/manifest.json")" ] || {
      say "release id collision with different contents"
      exit 65
    }
  (cd "$NEW_RELEASE" && sha256sum -c files.sha256 >/dev/null) || {
    say "existing release directory failed its file inventory"
    exit 65
  }
  rm -rf -- "$EXTRACTED"
else
  python3 "$DEPENDENCY_STATE_HELPER" candidate-add "$ROOT" "$RELEASE_ID"
  python3 - "$EXTRACTED" <<'PY'
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
for relative, target in manifest["stateLinks"].items():
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(target, path)
PY
  mv "$EXTRACTED" "$NEW_RELEASE"
fi
MANIFEST_PATH="$NEW_RELEASE/manifest.json"
DEPENDENCY_STATE_HELPER="$NEW_RELEASE/device/dependency-tree-state.py"
ROLLBACK_STATE_HELPER="$NEW_RELEASE/device/rollback-state.py"
ANDROID_ROLE_STATE_HELPER="$NEW_RELEASE/device/android-role-state.py"
android_role_state_helper_safe || {
  say "installed release Android role-state helper is missing or unsafe"
  exit 65
}
[ "$(sha256_file "$NEW_RELEASE/files.sha256")" = "$(read_manifest inventory.sha256)" ] \
  && [ "$(sha256_file "$NEW_RELEASE/links.json")" = "$(read_manifest inventory.linksSha256)" ] || {
  say "installed release inventory metadata mismatch"
  exit 65
}
(cd "$NEW_RELEASE" && sha256sum -c files.sha256 >/dev/null) || {
  say "installed release directory failed its file inventory"
  exit 65
}
validate_release_phone_tools_namespace "$NEW_RELEASE" || exit 65
python3 - "$NEW_RELEASE" <<'PY'
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
links = json.loads((root / "links.json").read_text(encoding="utf-8"))
for relative, expected in links.items():
    path = root / relative
    if not path.is_symlink() or os.readlink(path) != expected:
        raise SystemExit(f"installed release symlink inventory mismatch: {relative}")
for relative, expected in manifest["stateLinks"].items():
    path = root / relative
    if not path.is_symlink() or os.readlink(path) != expected:
        raise SystemExit(f"state link mismatch: {relative}")
PY

# Releases are read-only once staged. Runtime writes have explicit state links
# (data, Android node_modules, private env, and Next cache).
python3 - "$NEW_RELEASE" <<'PY'
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
for path in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
    if path.is_symlink():
        continue
    mode = path.stat().st_mode
    if path.is_dir():
        os.chmod(path, 0o555)
    elif path.is_file():
        relative = path.relative_to(root).as_posix()
        if relative == "tls/server-key.pem":
            os.chmod(path, 0o600)
        else:
            os.chmod(path, 0o555 if mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH) else 0o444)
os.chmod(root, 0o555)
PY
[ "$(stat -c '%a' "$NEW_RELEASE/tls/server-key.pem")" = 600 ] || {
  say "installed TLS private key permissions changed across immutable staging"
  exit 65
}
verify_release_tls_material "$NEW_RELEASE" || exit 65
fsync_tree "$NEW_RELEASE" || {
  say "installed release tree could not be made durable"
  exit 70
}
fsync_directory "$RELEASES" || exit 70

# Build dependencies before taking the cycle gate or stopping production. The exact lock hash
# names the tree, so a failed build cannot mutate the currently running release and a later
# release with the same lock can reuse the verified Android-native result.
EXPECTED_PACKAGE_LOCK="$(read_manifest dependencies.packageLockSha256)"
EXPECTED_DEPENDENCY_LINK="../../../state/dependencies/$EXPECTED_PACKAGE_LOCK/node_modules"
[ "$(read_manifest stateLinks.runtime/node_modules)" = "$EXPECTED_DEPENDENCY_LINK" ] || {
  say "release dependency link does not match its lock identity"
  exit 65
}
prepare_android_dependency_tree "$EXPECTED_PACKAGE_LOCK"

# Same release + matching APK metadata is an intentional no-op. Still prove the
# local server is healthy instead of trusting a symlink alone. GNU readlink -f
# succeeds when only the final path component is absent, so resolve the pointer
# only after proving that a directory entry actually exists.
CURRENT_RESOLVED=""
if [ -e "$CURRENT" ] || [ -L "$CURRENT" ]; then
  CURRENT_RESOLVED="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  [ -L "$CURRENT" ] && [ -n "$CURRENT_RESOLVED" ] \
    && is_real_release_target "$CURRENT_RESOLVED" || {
      say "current release pointer is dangling or unsafe; recover it before installing"
      exit 69
    }
fi
PREVIOUS_TARGET="$CURRENT_RESOLVED"
if [ -n "$CURRENT_RESOLVED" ] \
    && ! release_dispatch_matches_target "$CURRENT_RESOLVED"; then
  say "current release dispatch is not canonical; recover it before installing"
  exit 69
fi
if [ -z "$CURRENT_RESOLVED" ] && [ -d "$HOME/evogent" ] && [ ! -L "$HOME/evogent" ] \
    && { [ -e "$STATE/data" ] || [ -e "$STATE/node_modules" ]; }; then
  say "initial migration found ambiguous pre-existing versioned state; recover it before retrying"
  exit 69
fi
if [ -z "$CURRENT_RESOLVED" ] && [ -d "$HOME/phone-tools" ] \
    && [ ! -L "$HOME/phone-tools" ] && [ -e "$PHONE_STATE" ]; then
  say "initial migration found ambiguous pre-existing phone control state; recover it before retrying"
  exit 69
fi
EXPECTED_APK_CODE="$(read_manifest android.versionCode)"
EXPECTED_APK_SIGNER="$(read_manifest android.signerSha256)"
EXPECTED_APK_SHA256="$(read_manifest android.sha256)"
INCOMING_APK_SIGNER="$(apk_signer_sha256 "$NEW_RELEASE/apk/evogent.apk" 2>/dev/null || true)"
[ "$INCOMING_APK_SIGNER" = "$EXPECTED_APK_SIGNER" ] \
  && [ "$(sha256_file "$NEW_RELEASE/apk/evogent.apk")" = "$EXPECTED_APK_SHA256" ] || {
  say "release APK bytes or signer do not match the manifest"
  exit 65
}
CURRENT_APK_PROBE="$STAGE/installed-current.apk"
backup_installed_apk "$CURRENT_APK_PROBE" || {
  say "could not read the currently installed APK"
  exit 70
}
INSTALLED_APK_CODE="$(installed_apk_version_code)"
INSTALLED_APK_SIGNER="$(apk_signer_sha256 "$CURRENT_APK_PROBE" 2>/dev/null || true)"
PREVIOUS_APK_CODE="$INSTALLED_APK_CODE"
PREVIOUS_APK_SIGNER="$INSTALLED_APK_SIGNER"
CURRENT_APK_SHA256="$(sha256_file "$CURRENT_APK_PROBE")"
if [ "$FORWARD_SUPERSEDE" = 1 ]; then
  [ "$INSTALLED_APK_CODE" = "$EXPECTED_APK_CODE" ] \
    && [ "$INSTALLED_APK_SIGNER" = "$EXPECTED_APK_SIGNER" ] \
    && [ "$CURRENT_APK_SHA256" = "$EXPECTED_APK_SHA256" ] || {
    say "forward supersede cannot change the retained installed APK"
    exit 70
  }
  FORWARD_RESCUER="$NEW_RELEASE/device/forward-rescue.sh"
  [ -f "$FORWARD_RESCUER" ] && [ ! -L "$FORWARD_RESCUER" ] \
    && [ "$(stat -c '%u' "$FORWARD_RESCUER")" = "$(id -u)" ] \
    && [ "$(stat -c '%h' "$FORWARD_RESCUER")" = 1 ] || {
    say "release forward-rescue program is missing or unsafe"
    exit 65
  }
  rm -rf -- "$STAGE"
  STAGE=""
  exec python3 "$FORWARD_RESCUER" \
    --activate "$NEW_RELEASE" "$ROOT" "$TRANSACTION_JOURNAL"
fi
if [ "$CURRENT_APK_SHA256" != "$EXPECTED_APK_SHA256" ]; then
  APK_CHANGED=1
  [[ "$INSTALLED_APK_CODE" =~ ^[0-9]+$ ]] \
    && [[ "$EXPECTED_APK_CODE" =~ ^[0-9]+$ ]] \
    && [ "$EXPECTED_APK_CODE" -gt "$INSTALLED_APK_CODE" ] || {
      say "changed APK requires a strictly higher Android version code"
      exit 65
    }
  package_manager_supports_apk_rollback || {
      say "Android package manager does not expose native app rollback; refusing the APK upgrade"
      exit 69
    }
fi
if [ "$CURRENT_RESOLVED" = "$NEW_RELEASE" ] \
    && [ "$INSTALLED_APK_CODE" = "$EXPECTED_APK_CODE" ] \
    && [ "$INSTALLED_APK_SIGNER" = "$EXPECTED_APK_SIGNER" ] \
    && [ "$(sha256_file "$CURRENT_APK_PROBE")" = "$EXPECTED_APK_SHA256" ]; then
  NOOP_HEALTH="$(evo_curl -sS -m 15 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
  NOOP_DEPLOYMENT="$(evo_curl -sS -m 15 -o "$STAGE/deployment-noop.json" -w '%{http_code}' \
    "$DEPLOYMENT_URL" 2>/dev/null || true)"
  if [ "$NOOP_HEALTH" = 200 ] && [ "$NOOP_DEPLOYMENT" = 200 ] \
      && verify_phone_tls_listener "$NEW_RELEASE" \
      && wait_for_authenticated_release_control_plane "$NEW_RELEASE" \
      && verify_release_android_roles \
      && python3 - "$STAGE/deployment-noop.json" "$NEW_RELEASE/manifest.json" <<'PY'
import json
import sys
running = json.load(open(sys.argv[1], encoding="utf-8"))["running"]
manifest = json.load(open(sys.argv[2], encoding="utf-8"))
if not (
    running["releaseId"] == manifest["releaseId"]
    and running["releaseFormat"] == manifest["releaseFormat"]
    and running["buildId"] == manifest["web"]["buildId"]
    and running["commitFull"] == manifest["source"]["commit"]
):
    raise SystemExit(1)
PY
  then
    SUCCESS=1
    exit 0
  fi
fi

# Allocate every recovery path and durably record intent before the first cycle
# gate or control-plane side effect. A SIGKILL from this point onward therefore
# leaves BootReceiver/next install enough truthful state to restart the prior
# runtime, while readiness flags prevent partial backups from being restored.
BACKUP_DIR="$(mktemp -d "$BACKUPS/install-$STAMP-$RELEASE_ID.XXXXXXXX")" \
  || exit 70
chmod 700 "$BACKUP_DIR"
fsync_directory "$BACKUP_DIR"
fsync_directory "$BACKUPS"
DB_BACKUP="$BACKUP_DIR/media-agent.db"
APK_BACKUP="$BACKUP_DIR/evogent.apk"
CONTROL_TOKEN_BACKUP="$BACKUP_DIR/control-token.txt"
ANDROID_ROLE_BACKUP="$BACKUP_DIR/android-role-holders.json"
if [ -z "$CURRENT_RESOLVED" ]; then
  INITIAL_MIGRATION=1
  MIGRATION_DIR="$(
    mktemp -d "$MIGRATIONS/legacy-$STAMP-$RELEASE_ID.XXXXXXXX"
  )" || exit 70
  mkdir -p "$MIGRATION_DIR/home"
  fsync_directory "$MIGRATION_DIR/home"
  fsync_directory "$MIGRATION_DIR"
  fsync_directory "$MIGRATIONS"
  LEGACY_STATE="$(legacy_install_state)"
  case "$LEGACY_STATE" in
    absent)
      LEGACY_RUNTIME_EXPECTED=0
      LEGACY_CONTROL_PLANE_EXPECTED=0
      ;;
    stopped)
      LEGACY_RUNTIME_EXPECTED=1
      LEGACY_CONTROL_PLANE_EXPECTED=0
      ;;
    live)
      LEGACY_RUNTIME_EXPECTED=1
      LEGACY_CONTROL_PLANE_EXPECTED=1
      ;;
    *)
      say "initial migration found an ambiguous legacy control plane"
      exit 69
      ;;
  esac
  prepare_legacy_rollback_plan
else
  MIGRATION_DIR="$(
    mktemp -d "$MIGRATIONS/install-$STAMP-$RELEASE_ID.XXXXXXXX"
  )" || exit 70
  fsync_directory "$MIGRATION_DIR"
  fsync_directory "$MIGRATIONS"
fi

if [ "$INITIAL_MIGRATION" = 0 ]; then
  prepare_versioned_state_directories "$RELEASE_ID"
fi

# Bind the predecessor and incoming release identity before the first durable
# quiesce intent. Even an early rolled-back decision can then be validated
# without pretending that database/APK/token backups were already necessary.
printf '%s\n' "$PREVIOUS_TARGET" > "$BACKUP_DIR/previous-release"
cp "$NEW_RELEASE/manifest.json" "$BACKUP_DIR/new-release-manifest.json"
chmod 600 "$BACKUP_DIR/previous-release" \
  "$BACKUP_DIR/new-release-manifest.json"
fsync_regular_file_and_parent "$BACKUP_DIR/previous-release"
fsync_regular_file_and_parent "$BACKUP_DIR/new-release-manifest.json"

# Establish a cycle gate with the exact same mkdir/PID-start lease understood by
# old and new cycles. Once held, no browse/curate task can begin during a switch.
CYCLE_GATE="$HOME/phone-tools/.cycle.lock"
if [ ! -e "$HOME/phone-tools" ]; then
  CYCLE_GATE="$TRANSACTION_DIR/initial-cycle.lock"
fi

prepare_transaction_recoverer
acquire_lock_dir "$CONTROL_MUTATION_GATE" release-install-control-barrier
CONTROL_MUTATION_GATE_HELD=1
write_transaction_journal quiesce_pending
release_lock_dir "$CONTROL_MUTATION_GATE"
CONTROL_MUTATION_GATE_HELD=0
acquire_lock_dir "$CYCLE_GATE" release-install-cycle-gate
CYCLE_GATE_HELD=1

if [ "$INITIAL_MIGRATION" = 1 ]; then
  cycle_gate_owned_by_current "$CYCLE_GATE" \
    && legacy_rollback_plan_revalidate \
    && legacy_state_matches_expectation || {
      say "legacy state changed while the release waited for its cycle gate"
      exit 69
    }
fi

CONTROL_PLANE_MUTATION_STARTED=1
quiesce_control_plane
QUIESCED=1

# Stop and prove the exact server owner and both listeners before moving its cwd
# or private data.
# The cycle gate prevents a new background writer; taking the checked snapshot
# here also closes the display-0/user-write race during initial migration.
if ! stop_and_prove_runtime; then
  say "refusing an unsafe migration while a server listener remains"
  exit 70
fi
reap_abandoned_control_workers_and_prove_absent || {
  say "refusing a release snapshot while a tagged control worker remains"
  exit 70
}

write_transaction_journal backup_pending
backup_database "$HOME/evogent/data/media-agent.db" "$DB_BACKUP"
backup_apk_for_rollback "$CURRENT_APK_PROBE" "$APK_BACKUP"

# Record the pre-transaction authentication state before any migration.  The
# backup contains the secret; the journal contains only private paths/flags.
backup_control_token "$HOME/evogent/data/control-token.txt"
capture_android_role_backup || {
  say "could not capture a private Android HOME/ASSISTANT role snapshot"
  exit 70
}
if [ "$APK_CHANGED" = 1 ]; then
  # Package replacement can indirectly drop a role holder if qualification
  # changes. Publish restoration intent before APK_INSTALL_ATTEMPTED becomes
  # durable, even though no explicit role command has run yet.
  ANDROID_ROLE_RESTORE_REQUIRED=1
fi

# Copy the small legacy dispatch surface before marking migration intent. If
# this copy is interrupted, the pre-quiesce journal leaves the originals alone.
if [ "$INITIAL_MIGRATION" = 1 ]; then
  if [ -d "$HOME/phone-tools" ] && [ ! -L "$HOME/phone-tools" ]; then
    cp -a "$HOME/phone-tools" "$MIGRATION_DIR/phone-tools"
    rm -rf -- \
      "$MIGRATION_DIR/phone-tools/.cycle.lock" \
      "$MIGRATION_DIR/phone-tools/.scheduler.lock" \
      "$MIGRATION_DIR/phone-tools/.watchdog.lock"
    rm -f -- "$MIGRATION_DIR/phone-tools/.watchdog.pid"
    fsync_tree "$MIGRATION_DIR/phone-tools"
  fi
  LEGACY_HOME_SNAPSHOT_SOURCES=()
  for name in start-prod.sh start-prod-sub.sh restart-evo.sh deploy-next.sh \
      install-evogent-release.sh; do
    if [ -e "$HOME/$name" ] || [ -L "$HOME/$name" ]; then
      LEGACY_HOME_SNAPSHOT_SOURCES+=("$HOME/$name")
    fi
  done
  if [ "${#LEGACY_HOME_SNAPSHOT_SOURCES[@]}" -gt 0 ]; then
    copy_legacy_home_snapshots \
      "$MIGRATION_DIR/home" "${LEGACY_HOME_SNAPSHOT_SOURCES[@]}"
  fi
  fsync_tree "$MIGRATION_DIR/home"
  finalize_legacy_rollback_plan
fi
write_transaction_journal prepared

# Install and prove the release APK before moving any legacy HOME path.  From
# this point onward BootReceiver itself knows the stable journal/recoverer path,
# so even a reboot during the first versioned migration can recover without
# depending on a temporarily moving ~/phone-tools symlink.
if [ "$APK_CHANGED" = 1 ]; then
  PACKAGE_OPERATION="$(allocate_shell_package_operation)" || {
    say "could not allocate a private Android package operation"
    exit 70
  }
  APK_INSTALL_ATTEMPTED=1
  write_transaction_journal apk_install_pending
  install_apk "$NEW_RELEASE/apk/evogent.apk" upgrade
fi
INSTALLED_APK_CODE="$(installed_apk_version_code)"
INSTALLED_APK_PROBE="$STAGE/installed-release.apk"
backup_installed_apk "$INSTALLED_APK_PROBE" || {
  say "could not read the installed release APK"
  exit 70
}
INSTALLED_APK_SIGNER="$(apk_signer_sha256 "$INSTALLED_APK_PROBE" 2>/dev/null || true)"
[ "$INSTALLED_APK_CODE" = "$EXPECTED_APK_CODE" ] \
  && [ "$INSTALLED_APK_SIGNER" = "$EXPECTED_APK_SIGNER" ] \
  && [ "$(sha256_file "$INSTALLED_APK_PROBE")" = "$EXPECTED_APK_SHA256" ] || {
  say "installed APK bytes, version, or signer do not match the release manifest"
  exit 70
}
if [ "$APK_CHANGED" = 1 ] \
    && ! wait_for_apk_rollback_availability \
        "$EXPECTED_APK_CODE" "$PREVIOUS_APK_CODE"; then
  say "Android did not make the exact APK rollback available; recovering before the runtime switch"
  exit 70
fi
assign_release_android_roles || {
  say "Android HOME/ASSISTANT roles did not converge on the exact release APK"
  exit 70
}

# Initial migration preserves the full legacy runtime for recovery, then moves
# only private/machine-built state out of it. No user file is copied into a
# release or its manifest.
SWITCH_STARTED=1
if [ "$INITIAL_MIGRATION" = 1 ]; then
  MIGRATION_STARTED=1
fi
write_transaction_journal switch_pending
if [ -z "$CURRENT_RESOLVED" ]; then
  if [ -d "$HOME/evogent" ] && [ ! -L "$HOME/evogent" ]; then
    rename_no_copy "$HOME/evogent" "$MIGRATION_DIR/evogent"
    fsync_directory "$HOME"
    fsync_directory "$MIGRATION_DIR"
    [ -d "$MIGRATION_DIR/evogent/data" ] \
      && {
        rename_no_copy "$MIGRATION_DIR/evogent/data" "$STATE/data"
        fsync_directory "$MIGRATION_DIR/evogent"
        fsync_directory "$STATE"
      }
    [ -d "$MIGRATION_DIR/evogent/node_modules" ] \
      && {
        rename_no_copy \
          "$MIGRATION_DIR/evogent/node_modules" "$STATE/node_modules"
        fsync_directory "$MIGRATION_DIR/evogent"
        fsync_directory "$STATE"
      }
    if [ -f "$MIGRATION_DIR/evogent/.env.local" ]; then
      publish_generated_directory \
        "$STATE/config" "$MIGRATION_DIR/generated-state-config"
      rename_no_copy \
        "$MIGRATION_DIR/evogent/.env.local" "$STATE/config/.env.local"
      fsync_directory "$MIGRATION_DIR/evogent"
      fsync_directory "$STATE/config"
      fsync_directory "$STATE"
    fi
  fi
  if [ -d "$HOME/phone-tools" ] && [ ! -L "$HOME/phone-tools" ]; then
    # The original becomes the stable state/dispatch directory so all existing
    # locks, logs, cadence artifacts, and recovery metadata live on.
    if [ "$HOME/phone-tools" != "$PHONE_STATE" ]; then
      rename_no_copy "$HOME/phone-tools" "$PHONE_STATE"
      fsync_directory "$HOME"
      fsync_directory "$STATE"
      CYCLE_GATE="$PHONE_STATE/.cycle.lock"
    fi
  fi
  for name in start-prod.sh start-prod-sub.sh restart-evo.sh deploy-next.sh \
      install-evogent-release.sh; do
    if [ -e "$HOME/$name" ] || [ -L "$HOME/$name" ]; then
      rm -f "$HOME/$name"
    fi
  done
  fsync_directory "$HOME"
fi

if [ "$INITIAL_MIGRATION" = 1 ]; then
  if [ "$(legacy_plan_original_type data)" = absent ]; then
    publish_generated_directory \
      "$STATE/data" "$MIGRATION_DIR/generated-state-data"
  else
    [ -d "$STATE/data" ] && [ ! -L "$STATE/data" ] || exit 70
  fi
  if [ "$(legacy_plan_original_type nodeModules)" = absent ] \
      && { [ -e "$STATE/node_modules" ] || [ -L "$STATE/node_modules" ]; }; then
    say "unexpected dependency state appeared during initial migration"
    exit 70
  fi
  publish_generated_directory \
    "$STATE/config" "$MIGRATION_DIR/generated-state-config"
  publish_generated_directory \
    "$STATE/next-cache/$RELEASE_ID" \
    "$MIGRATION_DIR/generated-next-cache"
  if [ "$(legacy_plan_original_type phoneTools)" = absent ]; then
    publish_generated_directory \
      "$PHONE_STATE" "$MIGRATION_DIR/generated-phone-state"
  else
    [ -d "$PHONE_STATE" ] && [ ! -L "$PHONE_STATE" ] || exit 70
  fi
else
  prepare_versioned_state_directories "$RELEASE_ID"
fi
fsync_directory "$STATE"
fsync_directory "$STATE/next-cache"

# Public defaults seed only missing private files.
seed_missing_public_defaults "$NEW_RELEASE/defaults/data"
fsync_tree "$STATE/data" || {
  say "phone data state could not be made durable before release publication"
  exit 70
}

# The destination must remain a private regular file until the APK-scoped copy
# replaces it atomically below.
if [ -e "$CONTROL_TOKEN" ] || [ -L "$CONTROL_TOKEN" ]; then
  [ -f "$CONTROL_TOKEN" ] && [ ! -L "$CONTROL_TOKEN" ] || {
    say "phone control token is not a regular private file"
    exit 65
  }
  chmod 600 "$CONTROL_TOKEN"
fi

# Re-prove the production runtime through the release link immediately before the switch.
verify_release_runtime_prepared || {
  say "release production Next runtime failed its pre-switch preparation test"
  exit 70
}

if [ "$INITIAL_MIGRATION" = 1 ] \
    && [ "$(legacy_plan_original_type phoneTools)" = absent ]; then
  NEW_CYCLE_GATE="$PHONE_STATE/.cycle.lock"
  OLD_CYCLE_GATE="$CYCLE_GATE"
  acquire_lock_dir "$NEW_CYCLE_GATE" release-install-cycle-handoff
  CYCLE_GATE="$NEW_CYCLE_GATE"
  if ! write_transaction_journal switch_pending; then
    CYCLE_GATE="$OLD_CYCLE_GATE"
    release_lock_dir "$NEW_CYCLE_GATE" || true
    exit 70
  fi
  release_lock_dir "$OLD_CYCLE_GATE" || {
    say "fresh-install cycle gate handoff could not release its transaction lease"
    exit 70
  }
  cycle_gate_owned_by_current "$CYCLE_GATE" || exit 70
fi

# Build a stable phone-tools dispatch directory. Code links all travel through
# one current pointer; locks, logs, yield histories, and browse stamps stay here.
remove_obsolete_phone_dispatch_links "$NEW_RELEASE"
find "$NEW_RELEASE/phone-tools" -mindepth 1 -maxdepth 1 | while IFS= read -r source; do
  name="$(basename "$source")"
  publish_phone_dispatch_link "$name"
done
publish_phone_dispatch_link install-release.sh
fsync_directory "$MIGRATION_DIR"
fsync_directory "$PHONE_STATE"

# Stable public entrypoints all resolve through the same atomic release pointer.
if ! { [ -L "$HOME/evogent" ] \
    && [ "$(readlink "$HOME/evogent")" = "$ROOT/current/runtime" ]; }; then
  [ "$INITIAL_MIGRATION" = 1 ] \
    && [ ! -e "$HOME/evogent" ] && [ ! -L "$HOME/evogent" ] || exit 70
  atomic_link "$ROOT/current/runtime" "$HOME/evogent"
fi
if ! { [ -L "$HOME/phone-tools" ] \
    && [ "$(readlink "$HOME/phone-tools")" = "$PHONE_STATE" ]; }; then
  [ "$INITIAL_MIGRATION" = 1 ] \
    && [ ! -e "$HOME/phone-tools" ] && [ ! -L "$HOME/phone-tools" ] || exit 70
  atomic_link "$PHONE_STATE" "$HOME/phone-tools"
fi
atomic_link "$ROOT/current/device/start-prod.sh" "$HOME/start-prod.sh"
rm -f "$HOME/start-prod-sub.sh"
atomic_link "$ROOT/current/device/restart-evo.sh" "$HOME/restart-evo.sh"
atomic_link "$ROOT/current/phone-tools/deploy-next.sh" "$HOME/deploy-next.sh"
atomic_link "$ROOT/current/device/install-release.sh" "$HOME/install-evogent-release.sh"

atomic_link "releases/$RELEASE_ID" "$CURRENT"

write_transaction_journal token_sync_pending
sync_control_token_from_apk
write_transaction_journal health_pending
bash "$HOME/restart-evo.sh"
set_tmux_control_release_root "$NEW_RELEASE"
EVOGENT_RELEASE_RECOVERY=1 EVOGENT_RELEASE_BOOT=1 \
  EVOGENT_CONTROL_RELEASE_ROOT="$NEW_RELEASE" \
  bash "$HOME/phone-tools/evogent-boot.sh"

READY=0
for _ in $(seq 1 60); do
  FEED_CODE="$(evo_curl -sS -m 10 -o /dev/null -w '%{http_code}' "$FEED_URL" 2>/dev/null || true)"
  HEALTH_CODE="$(evo_curl -sS -m 15 -o "$STAGE/health.json" -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
  DEPLOYMENT_CODE="$(evo_curl -sS -m 15 -o "$STAGE/deployment.json" -w '%{http_code}' "$DEPLOYMENT_URL" 2>/dev/null || true)"
  if [ "$FEED_CODE" = 200 ] && [ "$HEALTH_CODE" = 200 ] && [ "$DEPLOYMENT_CODE" = 200 ] \
      && verify_phone_tls_listener "$NEW_RELEASE" >/dev/null 2>&1; then
    if python3 - "$STAGE/health.json" "$STAGE/deployment.json" \
        "$NEW_RELEASE/manifest.json" <<'PY'
import json
import sys

health = json.load(open(sys.argv[1], encoding="utf-8"))
deployment = json.load(open(sys.argv[2], encoding="utf-8"))
manifest = json.load(open(sys.argv[3], encoding="utf-8"))
running = deployment["running"]
if not (
    health["ok"] is True
    and health["runtime"]["profile"] == "phone"
    and health["runtime"]["backgroundJobsDisabled"] is True
    and running["releaseId"] == manifest["releaseId"]
    and running["releaseFormat"] == manifest["releaseFormat"]
    and running["buildId"] == manifest["web"]["buildId"]
    and running["commitFull"] == manifest["source"]["commit"]
):
    raise SystemExit(1)
PY
    then
      READY=1
      break
    fi
  fi
  sleep 2
done
[ "$READY" = 1 ] || {
  say "new release did not pass local phone health"
  exit 70
}
wait_for_authenticated_release_control_plane "$NEW_RELEASE" || {
    say "new release did not retain exact process-bound control-plane health"
    exit 70
  }
installed_release_apk_exact \
  && verify_release_android_roles "$ANDROID_ROLE_USER_ID" || {
    say "new release lost exact APK or Android role activation before commit"
    exit 70
  }

# The new runtime and synchronized authentication boundary are proven healthy.
# Commit durably before reopening the cycle gate; a reboot after this point
# keeps the verified release instead of conservatively rolling it back.
commit_new_release_decision || exit $?
finalize_committed_transaction_state || {
  say "committed release finalization did not converge; retaining its journal"
  exit 70
}
clear_transaction_journal || {
  say "committed release journal retirement did not complete"
  exit 70
}
remove_transaction_recoverer || {
  say "committed transaction program could not be removed"
  exit 70
}
prune_orphan_migrations \
  || say "warning: post-commit orphan cleanup did not complete"
release_lock_dir "$CYCLE_GATE"
CYCLE_GATE_HELD=0

# Bounded retention. Targets are validated release/backup/log names under exact
# narrow directories; current and previous releases are never removed. Retention
# is post-commit housekeeping: a cleanup error must not roll back a healthy
# release after its cycle gate has been reopened.
python3 - "$ROOT" "$KEEP_RELEASES" "$KEEP_BACKUPS" "$KEEP_LOGS" <<'PY' \
  || say "warning: release retention cleanup did not complete"
import json
import os
import pathlib
import re
import shutil
import stat
import sys

root = pathlib.Path(sys.argv[1])
keep_releases, keep_backups, keep_logs = map(int, sys.argv[2:])
safe = re.compile(r"^[A-Za-z0-9._-]+$")
protected = set()
current = root / "current"
if current.is_symlink():
    protected.add(current.resolve())
backups = root / "backups"
for marker in backups.glob("*/previous-release"):
    try:
        value = marker.read_text(encoding="utf-8").strip()
        if value:
            protected.add(pathlib.Path(value).resolve())
    except OSError:
        pass

release_root = root / "releases"
for entry in release_root.iterdir():
    metadata = os.lstat(entry)
    if (
        safe.fullmatch(entry.name) is None
        or not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
    ):
        raise SystemExit(f"unsafe release retention entry: {entry.name}")
releases = sorted(
    release_root.iterdir(),
    key=lambda p: p.stat().st_mtime,
    reverse=True,
)
for release in releases[keep_releases:]:
    if release.resolve() not in protected:
        for path in sorted(release.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            if not path.is_symlink():
                try:
                    os.chmod(path, 0o755 if path.is_dir() else 0o644)
                except OSError:
                    pass
        os.chmod(release, 0o755)
        shutil.rmtree(release)
        cache = root / "state" / "next-cache" / release.name
        if os.path.lexists(cache):
            metadata = os.lstat(cache)
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                raise SystemExit("unsafe Next cache retention target")
            shutil.rmtree(cache)

referenced_dependencies = set()
for release in (root / "releases").iterdir():
    manifest = release / "manifest.json"
    if not release.is_dir() or release.is_symlink() or not manifest.is_file():
        continue
    try:
        lock = json.loads(manifest.read_text(encoding="utf-8"))["dependencies"]["packageLockSha256"]
        if re.fullmatch(r"[0-9a-f]{64}", lock):
            referenced_dependencies.add(lock)
    except (KeyError, OSError, ValueError, TypeError):
        pass
dependencies = root / "state" / "dependencies"
if dependencies.is_dir() and not dependencies.is_symlink():
    for tree in dependencies.iterdir():
        if (
            tree.is_dir()
            and not tree.is_symlink()
            and re.fullmatch(r"[0-9a-f]{64}", tree.name)
            and tree.name not in referenced_dependencies
        ):
            for path in sorted(tree.rglob("*"), key=lambda item: len(item.parts), reverse=True):
                if not path.is_symlink():
                    os.chmod(path, 0o700 if path.is_dir() else 0o600)
            os.chmod(tree, 0o700)
            shutil.rmtree(tree)

for entry in backups.iterdir():
    metadata = os.lstat(entry)
    if (
        safe.fullmatch(entry.name) is None
        or not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
    ):
        raise SystemExit(f"unsafe backup retention entry: {entry.name}")
backup_dirs = sorted(
    backups.iterdir(),
    key=lambda p: p.stat().st_mtime,
    reverse=True,
)
for backup in backup_dirs[keep_backups:]:
    shutil.rmtree(backup)

logs = list((root / "logs").glob("install-*.log"))
for log in logs:
    metadata = os.lstat(log)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(f"unsafe install log retention entry: {log.name}")
logs = sorted(logs, key=lambda p: p.stat().st_mtime, reverse=True)
for log in logs[keep_logs:]:
    log.unlink()
PY
SUCCESS=1
