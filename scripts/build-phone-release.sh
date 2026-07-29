#!/usr/bin/env bash
# Build one immutable, content-verified Evogent phone release.
#
# Output defaults outside the checkout so creating a release cannot make the
# source tree dirty. The bundle is accepted by device/install-release.sh.
# Recovery-only Android/TLS reuse is documented in
# docs/phone-release-artifact-reuse.md.
set -euo pipefail
umask 077
# macOS otherwise synthesizes AppleDouble `._*` entries for extended metadata.
# Those entries are outside the release root and must never enter the archive.
export COPYFILE_DISABLE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
cd "$ROOT"

OUTPUT_DIR="${EVOGENT_RELEASE_OUTPUT_DIR:-$(dirname "$ROOT")/evogent-phone-releases}"
if [ "$#" -gt 0 ]; then
  OUTPUT_DIR="$1"
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "phone release: required command not found: $1" >&2
    exit 69
  }
}

require_command git
require_command node
require_command npm
require_command python3
require_command tar
require_command unzip
require_command openssl
require_command ps

java_home_has_build_tools() {
  local candidate="$1"
  [ -x "$candidate/bin/java" ] \
    && [ -x "$candidate/bin/javac" ] \
    && [ -x "$candidate/bin/keytool" ]
}

resolve_java_home() {
  local candidate="" javac_path="" formula=""
  if [ "${EVOGENT_JAVA_HOME+x}" = x ]; then
    java_home_has_build_tools "$EVOGENT_JAVA_HOME" || return 1
    (cd "$EVOGENT_JAVA_HOME" && pwd -P)
    return
  fi
  if [ "${JAVA_HOME+x}" = x ] && [ -n "$JAVA_HOME" ]; then
    java_home_has_build_tools "$JAVA_HOME" || return 1
    (cd "$JAVA_HOME" && pwd -P)
    return
  fi
  if [ -x /usr/libexec/java_home ]; then
    candidate="$(/usr/libexec/java_home 2>/dev/null || true)"
    if [ -n "$candidate" ] && java_home_has_build_tools "$candidate"; then
      (cd "$candidate" && pwd -P)
      return
    fi
  fi
  if command -v brew >/dev/null 2>&1; then
    for formula in openjdk@17 openjdk@11 openjdk; do
      candidate="$(brew --prefix "$formula" 2>/dev/null || true)"
      if [ -n "$candidate" ] && java_home_has_build_tools "$candidate"; then
        (cd "$candidate" && pwd -P)
        return
      fi
    done
  fi
  javac_path="$(command -v javac 2>/dev/null || true)"
  [ -n "$javac_path" ] || return 1
  candidate="$(python3 - "$javac_path" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve().parent.parent)
PY
)"
  java_home_has_build_tools "$candidate" || return 1
  (cd "$candidate" && pwd -P)
}

file_mode() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

print(f"{stat.S_IMODE(os.stat(sys.argv[1], follow_symlinks=False).st_mode):o}")
PY
}

prepare_phone_live_defaults() {
  local defaults_data="$1"
  python3 - "$defaults_data" <<'PY'
import json
import math
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
cadence_template = root / "source-cadence.default.json"
preference_template = root / "preference-insights.default.md"

for source in (cadence_template, preference_template):
    metadata = source.lstat()
    if not stat.S_ISREG(metadata.st_mode) or source.is_symlink():
        raise SystemExit(f"phone release: unsafe live-default template: {source.name}")

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result

cadence = json.loads(
    cadence_template.read_text(encoding="utf-8"),
    object_pairs_hook=unique_object,
)
if not isinstance(cadence, dict):
    raise SystemExit("phone release: cadence default must be an object")

live_cadence = {}
for source, entry in cadence.items():
    # Underscore-prefixed fields explain the public template but are not live
    # source records. In particular, the private-artifact contract rejects
    # _comment so metadata can never deadlock a first daily review.
    if isinstance(source, str) and source.startswith("_"):
        continue
    if (
        not isinstance(source, str)
        or not source
        or source != source.strip()
        or not isinstance(entry, dict)
    ):
        raise SystemExit("phone release: cadence default has an invalid source")
    hours = entry.get("cadenceHours")
    why = entry.get("why")
    if (
        isinstance(hours, bool)
        or not isinstance(hours, (int, float))
        or not math.isfinite(float(hours))
        or float(hours) < 0.25
        or float(hours) > 168
        or not isinstance(why, str)
        or not why.strip()
        or len(why) > 240
    ):
        raise SystemExit(
            f"phone release: cadence default has an invalid record: {source}"
        )
    live_cadence[source] = entry
if not live_cadence:
    raise SystemExit("phone release: cadence default has no live source records")

preference_bytes = preference_template.read_bytes()
if (
    not preference_bytes.strip()
    or len(preference_bytes) > 49_152
    or b"\0" in preference_bytes
):
    raise SystemExit("phone release: preference-insights default is invalid")
try:
    preference_bytes.decode("utf-8")
except UnicodeDecodeError as error:
    raise SystemExit(
        "phone release: preference-insights default is not UTF-8"
    ) from error

outputs = {
    "preference-insights.md": preference_bytes,
    "source-cadence.json": (
        json.dumps(
            live_cadence,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8"),
}
for name, payload in outputs.items():
    destination = root / name
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(destination, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("live-default write stopped")
            view = view[written:]
        os.fsync(descriptor)
    except Exception:
        os.close(descriptor)
        destination.unlink(missing_ok=True)
        raise
    else:
        os.close(descriptor)

directory = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

OUTPUT_DIR="$(python3 - "$OUTPUT_DIR" "$ROOT" <<'PY'
import pathlib
import sys

raw_output, raw_root = sys.argv[1:]
root = pathlib.Path(raw_root).resolve(strict=True)
try:
    output = pathlib.Path(raw_output).expanduser().resolve(strict=False)
    output.relative_to(root)
except ValueError:
    print(output)
except (OSError, RuntimeError):
    print("phone release: release output path could not be resolved safely", file=sys.stderr)
    raise SystemExit(65)
else:
    print(
        "phone release: release output must resolve outside the source checkout",
        file=sys.stderr,
    )
    raise SystemExit(65)
PY
)"

BUILD_LOCK_WAIT_SECONDS="${EVOGENT_PHONE_BUILD_LOCK_WAIT_SECONDS:-21600}"
[[ "$BUILD_LOCK_WAIT_SECONDS" =~ ^[0-9]+$ ]] || {
  echo "phone release: build-lock wait must be a non-negative integer" >&2
  exit 65
}
BUILD_LOCK_PARENT="${TMPDIR:-/tmp}/evogent-phone-release-locks"
mkdir -p "$BUILD_LOCK_PARENT"
chmod 700 "$BUILD_LOCK_PARENT"
BUILD_LOCK_KEY="$(python3 - "$ROOT" <<'PY'
import hashlib
import pathlib
import sys
print(hashlib.sha256(str(pathlib.Path(sys.argv[1]).resolve()).encode()).hexdigest())
PY
)"
BUILD_LOCK="$BUILD_LOCK_PARENT/$BUILD_LOCK_KEY.lock"
BUILD_LOCK_HELD=0
BUILD_LOCK_CANDIDATE=""

build_process_start() {
  python3 - "$1" <<'PY'
import hashlib
import os
import subprocess
import sys

pid = sys.argv[1]
result = subprocess.run(
    ["ps", "-o", "lstart=", "-p", pid],
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
    check=False,
)
normalized = b" ".join(result.stdout.split())
if result.returncode != 0 or not normalized:
    raise SystemExit(1)
print(hashlib.sha256(normalized).hexdigest())
PY
}

BUILD_LOCK_SELF_START="$(build_process_start "$$")" || {
  echo "phone release: could not identify the build-lock owner process" >&2
  exit 69
}
[[ "$BUILD_LOCK_SELF_START" =~ ^[0-9a-f]{64}$ ]] || {
  echo "phone release: build-lock owner identity is invalid" >&2
  exit 69
}

move_proven_build_lock() {
  python3 - "$@" <<'PY'
import ctypes
import errno
import fcntl
import hashlib
import os
import pathlib
import re
import stat
import subprocess
import sys
import time

operation, raw_source, raw_destination, expected_pid, expected_start = sys.argv[1:]
source = pathlib.Path(raw_source)
destination = pathlib.Path(raw_destination)
if source.parent != destination.parent:
    raise SystemExit("build lock move crossed directories")
flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
descriptor = os.open(source, flags)
try:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(75)
    observed = os.fstat(descriptor)
    owner_descriptor = None
    try:
        owner_descriptor = os.open(
            "owner",
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=descriptor,
        )
    except OSError as error:
        if error.errno not in {errno.ENOENT, errno.ELOOP, errno.EISDIR}:
            raise
    owner_pid = ""
    owner_valid = False
    owner_legacy = False
    if owner_descriptor is not None:
        try:
            owner_metadata = os.fstat(owner_descriptor)
            if (
                stat.S_ISREG(owner_metadata.st_mode)
                and stat.S_IMODE(owner_metadata.st_mode) == 0o600
                and owner_metadata.st_uid == os.geteuid()
                and owner_metadata.st_size <= 256
            ):
                try:
                    payload = os.read(owner_descriptor, 129).decode(
                        "ascii", "strict"
                    )
                except UnicodeDecodeError:
                    payload = ""
                match = re.fullmatch(
                    r"pid=([1-9][0-9]*)\nstart=([0-9a-f]{64})\n",
                    payload,
                )
                if match is not None:
                    owner_pid = match.group(1)
                    owner_start = match.group(2)
                    owner_valid = True
                    if operation == "publish":
                        os.fsync(owner_descriptor)
                else:
                    legacy_match = re.fullmatch(
                        r"pid=([1-9][0-9]*)\n",
                        payload,
                    )
                    if legacy_match is not None:
                        owner_pid = legacy_match.group(1)
                        owner_legacy = True
        finally:
            os.close(owner_descriptor)
    def process_start(pid):
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", pid],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
            check=False,
        )
        normalized = b" ".join(result.stdout.split())
        if result.returncode != 0 or not normalized:
            return None
        return hashlib.sha256(normalized).hexdigest()

    if operation == "reap":
        if owner_valid:
            if process_start(owner_pid) == owner_start:
                raise SystemExit(75)
        elif owner_legacy:
            # Rollout compatibility only: a builder that acquired the previous
            # pid-only format may still be live while this script is updated.
            # Never accept that weaker format for a new publish or retirement.
            try:
                os.kill(int(owner_pid), 0)
            except ProcessLookupError:
                pass
            except PermissionError:
                raise SystemExit(75)
            else:
                raise SystemExit(75)
        elif time.time() - observed.st_mtime < 2:
            raise SystemExit(75)
    elif operation == "retire":
        if (
            not owner_valid
            or owner_pid != expected_pid
            or owner_start != expected_start
        ):
            raise SystemExit(75)
    elif operation == "publish":
        if (
            not owner_valid
            or owner_pid != expected_pid
            or owner_start != expected_start
        ):
            raise SystemExit(75)
        os.fsync(descriptor)
    else:
        raise SystemExit("unknown build lock move")
    current = os.lstat(source)
    if (
        not stat.S_ISDIR(current.st_mode)
        or (current.st_dev, current.st_ino) != (observed.st_dev, observed.st_ino)
    ):
        raise SystemExit(75)
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
    else:
        renamex = getattr(libc, "renamex_np", None)
        if renamex is None:
            raise SystemExit("no atomic no-clobber rename primitive")
        renamex.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex.restype = ctypes.c_int
        result = renamex(
            os.fsencode(source),
            os.fsencode(destination),
            0x00000004,
        )
    if result != 0:
        error = ctypes.get_errno()
        if error in {errno.ENOENT, errno.EEXIST, errno.ENOTEMPTY}:
            raise SystemExit(75)
        raise OSError(error, os.strerror(error), str(destination))
    parent = os.open(source.parent, flags)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
finally:
    os.close(descriptor)
PY
}

discard_build_lock_candidate() {
  local candidate="${BUILD_LOCK_CANDIDATE:-}" quarantine status=0
  [ -n "$candidate" ] || return 0
  quarantine="${candidate}.discarded.${RANDOM}"
  move_proven_build_lock retire "$candidate" "$quarantine" \
    "$$" "$BUILD_LOCK_SELF_START" \
    || status=$?
  if [ "$status" = 0 ]; then
    rm -rf -- "$quarantine"
    BUILD_LOCK_CANDIDATE=""
    return 0
  fi
  return "$status"
}

acquire_build_lock() {
  local deadline=$(( $(date +%s) + BUILD_LOCK_WAIT_SECONDS ))
  local stale status
  while true; do
    BUILD_LOCK_CANDIDATE="$(mktemp -d \
      "${BUILD_LOCK}.pending.XXXXXXXX")" || return 1
    chmod 700 "$BUILD_LOCK_CANDIDATE"
    printf 'pid=%s\nstart=%s\n' "$$" "$BUILD_LOCK_SELF_START" \
      > "$BUILD_LOCK_CANDIDATE/owner"
    chmod 600 "$BUILD_LOCK_CANDIDATE/owner"
    status=0
    move_proven_build_lock publish \
      "$BUILD_LOCK_CANDIDATE" "$BUILD_LOCK" \
      "$$" "$BUILD_LOCK_SELF_START" || status=$?
    if [ "$status" = 0 ]; then
      BUILD_LOCK_CANDIDATE=""
      BUILD_LOCK_HELD=1
      return 0
    fi
    discard_build_lock_candidate || return 1
    [ "$status" = 75 ] || return "$status"

    stale="$BUILD_LOCK.stale.$$.${RANDOM}"
    status=0
    move_proven_build_lock reap "$BUILD_LOCK" "$stale" \
      "$$" "$BUILD_LOCK_SELF_START" || status=$?
    if [ "$status" = 0 ]; then
      rm -rf -- "$stale"
      continue
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "phone release: timed out waiting for the checkout build lock" >&2
      return 1
    fi
    sleep 1
  done
}

release_build_lock() {
  local quarantine status=0
  discard_build_lock_candidate || status=$?
  [ "$BUILD_LOCK_HELD" = 1 ] || return "$status"
  quarantine="$BUILD_LOCK.released.$$.${RANDOM}"
  move_proven_build_lock retire "$BUILD_LOCK" "$quarantine" \
    "$$" "$BUILD_LOCK_SELF_START" || status=$?
  [ "$status" = 0 ] && rm -rf -- "$quarantine"
  BUILD_LOCK_HELD=0
  return "$status"
}

trap release_build_lock EXIT
acquire_build_lock

assert_clean_source() {
  local status
  status="$(git status --porcelain=v1 --untracked-files=all)"
  if [ -n "$status" ]; then
    echo "phone release: refusing to build from a dirty source tree" >&2
    printf '%s\n' "$status" >&2
    exit 65
  fi
}

resolve_android_sdk_root() {
  local candidate="" sdkmanager=""
  if [ "${EVOGENT_ANDROID_SDK_ROOT+x}" = x ]; then
    candidate="$EVOGENT_ANDROID_SDK_ROOT"
    [ -d "$candidate/build-tools" ] && [ -d "$candidate/platforms" ] || return 1
    (cd "$candidate" && pwd -P)
    return
  fi
  if [ "${ANDROID_SDK_ROOT+x}" = x ]; then
    candidate="$ANDROID_SDK_ROOT"
    [ -d "$candidate/build-tools" ] && [ -d "$candidate/platforms" ] || return 1
    (cd "$candidate" && pwd -P)
    return
  fi
  if [ "${ANDROID_HOME+x}" = x ]; then
    candidate="$ANDROID_HOME"
    [ -d "$candidate/build-tools" ] && [ -d "$candidate/platforms" ] || return 1
    (cd "$candidate" && pwd -P)
    return
  fi
  for candidate in \
      "$HOME/Library/Android/sdk" \
      "$HOME/Android/Sdk" \
      "$HOME/Android/sdk"; do
    if [ -d "$candidate/build-tools" ] && [ -d "$candidate/platforms" ]; then
      (cd "$candidate" && pwd -P)
      return
    fi
  done
  sdkmanager="$(command -v sdkmanager 2>/dev/null || true)"
  [ -n "$sdkmanager" ] || return 1
  python3 - "$sdkmanager" <<'PY'
import pathlib
import sys

tool = pathlib.Path(sys.argv[1]).resolve()
for parent in tool.parents:
    if (parent / "build-tools").is_dir() and (parent / "platforms").is_dir():
        print(parent)
        raise SystemExit(0)
raise SystemExit(1)
PY
}

find_android_tool() {
  local name="$1" sdk="" override="${EVOGENT_ANDROID_BUILD_TOOLS_DIR:-}"
  if [ -n "$override" ]; then
    [ -x "$override/$name" ] || return 1
    printf '%s\n' "$override/$name"
    return
  fi
  sdk="$(resolve_android_sdk_root)" || return 1
  python3 - "$sdk" "$name" <<'PY'
import glob
import os
import re
import sys

sdk, name = sys.argv[1:]
paths = glob.glob(os.path.join(sdk, "build-tools", "*", name))
def version(path):
    raw = os.path.basename(os.path.dirname(path))
    return tuple(int(part) for part in re.findall(r"\d+", raw))
paths.sort(key=version)
if paths:
    print(paths[-1])
PY
}

android_artifact_provenance() {
  python3 - "$@" <<'PY'
# EVOGENT_ANDROID_ARTIFACT_PROVENANCE_HELPER_V1
import hashlib
import json
import os
import pathlib
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile

SCHEMA = "evogent.android-tls.artifact-provenance.v1"
TREE_PATH = "android-shell"
HEX_DIGEST = re.compile(r"[0-9a-f]{64}")
GIT_OID = re.compile(r"[0-9a-f]{40,64}")
SAFE_RELEASE_ID = re.compile(r"[A-Za-z0-9._-]{1,240}")
SAFE_ARCHIVE_NAME = re.compile(r"[A-Za-z0-9._-]+\.tar\.gz")
SAFE_VERSION_NAME = re.compile(r"[A-Za-z0-9._+-]{1,80}")
SPECIAL_FILES = {"manifest.json", "files.sha256", "links.json"}
ARTIFACT_FILES = {
    "apk/evogent.apk",
    "tls/server-cert.pem",
    "tls/server-key.pem",
}


def fail(message):
    raise SystemExit(f"phone release: {message}")


def git_output(root, arguments):
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        fail("Android source provenance could not be resolved")
    try:
        return result.stdout.decode("ascii", "strict").strip()
    except UnicodeDecodeError:
        fail("Android source provenance was not ASCII")


def commit_and_tree(root, raw_commit):
    if not isinstance(raw_commit, str) or not GIT_OID.fullmatch(raw_commit):
        fail("Android source commit provenance is invalid")
    commit = git_output(root, ["rev-parse", "--verify", f"{raw_commit}^{{commit}}"])
    if commit != raw_commit:
        fail("Android source commit provenance is not exact")
    tree = git_output(root, ["rev-parse", f"{commit}:{TREE_PATH}"])
    if not GIT_OID.fullmatch(tree):
        fail("Android source tree provenance is invalid")
    if git_output(root, ["cat-file", "-t", tree]) != "tree":
        fail("Android source provenance does not identify a tree")
    return commit, tree


def path_components_are_not_links(path):
    current = pathlib.Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = os.lstat(current)
        except OSError:
            fail("trusted prior release path is unavailable")
        if stat.S_ISLNK(metadata.st_mode):
            fail("trusted prior release path must not contain symlinks")


def assert_private_regular(path, *, exact_mode=0o600):
    try:
        metadata = os.lstat(path)
    except OSError:
        fail("trusted prior release artifact is unavailable")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != exact_mode
    ):
        fail("trusted prior release artifact must be private, owned, and regular")
    return metadata


def copy_stable_regular(source, destination, expected):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    source_descriptor = os.open(source, flags)
    try:
        opened = os.fstat(source_descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or opened.st_nlink != 1
            or stat.S_IMODE(opened.st_mode) != 0o600
            or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)
        ):
            fail("trusted prior release artifact changed before validation")
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
        )
        digest = hashlib.sha256()
        try:
            while True:
                chunk = os.read(source_descriptor, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(destination_descriptor, view)
                    view = view[written:]
            os.fsync(destination_descriptor)
        finally:
            os.close(destination_descriptor)
        completed = os.fstat(source_descriptor)
        current = os.lstat(source)
        identity = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
        if (
            identity
            != (
                completed.st_dev,
                completed.st_ino,
                completed.st_size,
                completed.st_mtime_ns,
            )
            or identity
            != (
                current.st_dev,
                current.st_ino,
                current.st_size,
                current.st_mtime_ns,
            )
        ):
            fail("trusted prior release artifact changed during validation")
        return digest.hexdigest()
    finally:
        os.close(source_descriptor)


def safe_release_relative(raw):
    if not isinstance(raw, str) or not raw or "\\" in raw or "\0" in raw:
        fail("trusted prior release inventory contains an unsafe path")
    pure = pathlib.PurePosixPath(raw)
    if (
        pure.is_absolute()
        or any(part in {"", ".", ".."} for part in pure.parts)
        or pure.as_posix() != raw
    ):
        fail("trusted prior release inventory contains an unsafe path")
    return raw


def bounded_member_bytes(bundle, member, limit, label):
    if member.size < 0 or member.size > limit:
        fail(f"trusted prior release {label} is unreasonably large")
    stream = bundle.extractfile(member)
    if stream is None:
        fail(f"trusted prior release {label} is unreadable")
    data = stream.read(limit + 1)
    if len(data) != member.size or len(data) > limit:
        fail(f"trusted prior release {label} is unreadable")
    return data


def parse_inventory(data):
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("trusted prior release inventory is not UTF-8")
    if not text.endswith("\n"):
        fail("trusted prior release inventory is not newline terminated")
    rows = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if match is None:
            fail("trusted prior release inventory row is invalid")
        relative = safe_release_relative(match.group(2))
        if relative in SPECIAL_FILES or relative in rows:
            fail("trusted prior release inventory is ambiguous")
        rows[relative] = match.group(1)
    if not rows:
        fail("trusted prior release inventory is empty")
    return rows


def member_sha256(bundle, member):
    stream = bundle.extractfile(member)
    if stream is None:
        fail("trusted prior release file is unreadable")
    digest = hashlib.sha256()
    observed = 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        observed += len(chunk)
        if observed > member.size:
            fail("trusted prior release file size changed while reading")
        digest.update(chunk)
    if observed != member.size:
        fail("trusted prior release file is truncated")
    return digest.hexdigest()


def string_field(container, name, label, pattern=None):
    value = container.get(name) if isinstance(container, dict) else None
    if not isinstance(value, str) or not value:
        fail(f"trusted prior release {label} is invalid")
    if pattern is not None and pattern.fullmatch(value) is None:
        fail(f"trusted prior release {label} is invalid")
    return value


def integer_field(container, name, label):
    value = container.get(name) if isinstance(container, dict) else None
    if isinstance(value, bool) or not isinstance(value, int):
        fail(f"trusted prior release {label} is invalid")
    return value


def validate_manifest(manifest, root, current_commit, current_tree):
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != "evogent.phone.release.v1"
        or manifest.get("releaseFormat") != 1
    ):
        fail("trusted prior release manifest schema is unsupported")
    release_id = string_field(
        manifest,
        "releaseId",
        "release identity",
        SAFE_RELEASE_ID,
    )
    source = manifest.get("source")
    source_commit = string_field(
        source,
        "commit",
        "source commit",
        GIT_OID,
    )
    source_short = string_field(source, "commitShort", "short source commit")
    if not source_commit.startswith(source_short) or len(source_short) < 7:
        fail("trusted prior release short source commit is inconsistent")
    _, prior_tree = commit_and_tree(root, source_commit)
    if prior_tree != current_tree:
        fail("Android source inputs changed; prior APK/TLS reuse is forbidden")

    android = manifest.get("android")
    package = string_field(android, "package", "Android package")
    if package != "net.dangish.evogent":
        fail("trusted prior release Android package is unexpected")
    version_code = integer_field(android, "versionCode", "Android version code")
    if version_code < 1 or version_code > 2147483647:
        fail("trusted prior release Android version code is out of range")
    version_name = string_field(
        android,
        "versionName",
        "Android version name",
        SAFE_VERSION_NAME,
    )
    signer_sha256 = string_field(
        android,
        "signerSha256",
        "Android signer",
        HEX_DIGEST,
    )
    apk_sha256 = string_field(android, "sha256", "APK digest", HEX_DIGEST)

    phone_tls = manifest.get("phoneTls")
    if (
        not isinstance(phone_tls, dict)
        or phone_tls.get("host") != "127.0.0.1"
        or phone_tls.get("port") != 3443
    ):
        fail("trusted prior release TLS endpoint is invalid")
    certificate_sha256 = string_field(
        phone_tls,
        "certificateDerSha256",
        "TLS certificate digest",
        HEX_DIGEST,
    )
    string_field(phone_tls, "certificateNotAfter", "TLS certificate expiry")

    identity = hashlib.sha256(
        (
            f"apk-sha256:{apk_sha256}\n"
            f"tls-cert-der-sha256:{certificate_sha256}\n"
        ).encode("ascii")
    ).hexdigest()[:12]
    if (
        manifest.get("releaseIdentityDigest") != identity
        or not release_id.endswith(f"-apk{version_code}-{identity}")
    ):
        fail("trusted prior release APK/TLS identity is inconsistent")

    provenance_root = manifest.get("artifactProvenance")
    if provenance_root is None:
        origin_release_id = release_id
        origin_commit = source_commit
        origin_tree = prior_tree
    else:
        if not isinstance(provenance_root, dict):
            fail("trusted prior release artifact provenance is invalid")
        provenance = provenance_root.get("androidTls")
        if (
            not isinstance(provenance, dict)
            or provenance.get("schema") != SCHEMA
            or provenance.get("mode") not in {"built", "reused"}
        ):
            fail("trusted prior release Android/TLS provenance is invalid")
        origin_release_id = string_field(
            provenance,
            "originReleaseId",
            "Android/TLS origin release",
            SAFE_RELEASE_ID,
        )
        origin_commit = string_field(
            provenance,
            "sourceCommit",
            "Android/TLS origin commit",
            GIT_OID,
        )
        source_tree = provenance.get("sourceTree")
        if not isinstance(source_tree, dict) or source_tree.get("path") != TREE_PATH:
            fail("trusted prior release Android/TLS source-tree path is invalid")
        declared_tree = string_field(
            source_tree,
            "oid",
            "Android/TLS source-tree identity",
            GIT_OID,
        )
        _, origin_tree = commit_and_tree(root, origin_commit)
        if declared_tree != origin_tree or origin_tree != prior_tree:
            fail("trusted prior release Android/TLS provenance is inconsistent")
        if (
            not origin_release_id.startswith(f"{origin_commit[:12]}-")
            or not origin_release_id.endswith(f"-apk{version_code}-{identity}")
        ):
            fail("trusted prior release Android/TLS origin identity is inconsistent")
        if provenance.get("mode") == "built" and (
            origin_release_id != release_id or origin_commit != source_commit
        ):
            fail("trusted prior built-artifact provenance is inconsistent")
        if provenance.get("mode") == "reused" and origin_release_id == release_id:
            fail("trusted prior reused-artifact provenance is self-referential")

    if origin_tree != current_tree:
        fail("Android artifact origin differs from current Android inputs")
    return {
        "priorReleaseId": release_id,
        "priorSourceCommit": source_commit,
        "originReleaseId": origin_release_id,
        "originSourceCommit": origin_commit,
        "originSourceTreeOid": origin_tree,
        "package": package,
        "versionCode": version_code,
        "versionName": version_name,
        "signerSha256": signer_sha256,
        "apkSha256": apk_sha256,
        "tlsCertificateDerSha256": certificate_sha256,
        "currentSourceCommit": current_commit,
        "currentSourceTreeOid": current_tree,
    }


def stage_archive_artifacts(root, current_commit, raw_archive, staging):
    archive = pathlib.Path(raw_archive)
    if not archive.is_absolute():
        fail("trusted prior release archive path must be absolute")
    normalized = pathlib.Path(os.path.normpath(raw_archive))
    try:
        canonical = archive.resolve(strict=True)
    except OSError:
        fail("trusted prior release archive is unavailable")
    if archive != normalized or archive != canonical:
        fail("trusted prior release archive path must be canonical")
    path_components_are_not_links(archive)
    try:
        archive.relative_to(root)
    except ValueError:
        pass
    else:
        fail("trusted prior release archive must live outside the source checkout")
    if SAFE_ARCHIVE_NAME.fullmatch(archive.name) is None:
        fail("trusted prior release archive name is unsafe")
    sidecar = pathlib.Path(f"{archive}.sha256")
    path_components_are_not_links(sidecar)
    archive_metadata = assert_private_regular(archive)
    sidecar_metadata = assert_private_regular(sidecar)
    if (
        archive_metadata.st_size < 1
        or archive_metadata.st_size > 4 * 1024 * 1024 * 1024
        or sidecar_metadata.st_size < 1
        or sidecar_metadata.st_size > 1024
    ):
        fail("trusted prior release artifact size is invalid")

    if staging.exists():
        fail("trusted prior release staging path already exists")
    staging.mkdir(mode=0o700)
    snapshot = staging / "prior-release.tar.gz"
    snapshot_sidecar = staging / "prior-release.tar.gz.sha256"
    archive_digest = copy_stable_regular(archive, snapshot, archive_metadata)
    copy_stable_regular(sidecar, snapshot_sidecar, sidecar_metadata)
    try:
        expected_sidecar = snapshot_sidecar.read_text(
            encoding="ascii",
            errors="strict",
        )
    except (OSError, UnicodeError):
        fail("trusted prior release checksum sidecar is unreadable")
    expected_line = f"{archive_digest}  {archive.name}\n"
    if expected_sidecar != expected_line:
        fail("trusted prior release archive checksum does not match its sidecar")

    _, current_tree = commit_and_tree(root, current_commit)
    try:
        bundle = tarfile.open(snapshot, "r:gz")
    except (OSError, tarfile.TarError):
        fail("trusted prior release archive is unreadable")
    with bundle:
        members = {}
        total_regular_size = 0
        for member in bundle.getmembers():
            raw_name = member.name
            name = raw_name[:-1] if member.isdir() and raw_name.endswith("/") else raw_name
            pure = pathlib.PurePosixPath(name)
            if (
                not name
                or "\\" in name
                or pure.is_absolute()
                or any(part in {"", ".", ".."} for part in pure.parts)
                or pure.as_posix() != name
                or pure.parts[0] != "release"
                or name in members
            ):
                fail("trusted prior release archive contains an unsafe member")
            if member.islnk() or member.isdev() or member.isfifo():
                fail("trusted prior release archive contains an unsupported member")
            if not (member.isdir() or member.isreg() or member.issym()):
                fail("trusted prior release archive contains an unsupported member")
            if member.issym():
                target = member.linkname
                if not isinstance(target, str) or not target or "\\" in target:
                    fail("trusted prior release archive symlink is invalid")
                resolved = posixpath.normpath(
                    posixpath.join(posixpath.dirname(name), target)
                )
                if resolved != "release" and not resolved.startswith("release/"):
                    fail("trusted prior release archive symlink escapes its root")
            if member.isreg():
                total_regular_size += member.size
                if member.size < 0 or total_regular_size > 4 * 1024 * 1024 * 1024:
                    fail("trusted prior release archive is unreasonably large")
            members[name] = member

        root_member = members.get("release")
        if (
            root_member is None
            or not root_member.isdir()
            or stat.S_IMODE(root_member.mode) & 0o077
        ):
            fail("trusted prior release archive root is not private")
        required = {
            "release/manifest.json",
            "release/files.sha256",
            "release/links.json",
            *(f"release/{relative}" for relative in ARTIFACT_FILES),
        }
        if not required.issubset(members):
            fail("trusted prior release archive lacks required identity artifacts")
        for name in required:
            member = members[name]
            if not member.isreg():
                fail("trusted prior release identity artifact is not regular")
            mode = stat.S_IMODE(member.mode)
            relative = name.removeprefix("release/")
            if relative == "tls/server-cert.pem":
                if mode & 0o022 or not mode & 0o400:
                    fail("trusted prior release TLS certificate mode is unsafe")
            elif mode != 0o600:
                fail("trusted prior release identity artifact is not private")

        manifest_bytes = bounded_member_bytes(
            bundle,
            members["release/manifest.json"],
            1024 * 1024,
            "manifest",
        )
        inventory_bytes = bounded_member_bytes(
            bundle,
            members["release/files.sha256"],
            64 * 1024 * 1024,
            "inventory",
        )
        links_bytes = bounded_member_bytes(
            bundle,
            members["release/links.json"],
            16 * 1024 * 1024,
            "symlink inventory",
        )
        try:
            manifest = json.loads(manifest_bytes)
            links = json.loads(links_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("trusted prior release metadata is invalid JSON")
        inventory_contract = manifest.get("inventory") if isinstance(manifest, dict) else None
        if (
            not isinstance(inventory_contract, dict)
            or inventory_contract.get("algorithm") != "sha256"
            or inventory_contract.get("path") != "files.sha256"
            or inventory_contract.get("linksPath") != "links.json"
            or inventory_contract.get("sha256")
            != hashlib.sha256(inventory_bytes).hexdigest()
            or inventory_contract.get("linksSha256")
            != hashlib.sha256(links_bytes).hexdigest()
        ):
            fail("trusted prior release manifest does not bind its inventory")
        inventory = parse_inventory(inventory_bytes)
        regular_members = {
            name.removeprefix("release/"): member
            for name, member in members.items()
            if member.isreg()
            and name.startswith("release/")
            and name.removeprefix("release/") not in SPECIAL_FILES
        }
        if set(regular_members) != set(inventory):
            fail("trusted prior release inventory is incomplete")
        for relative, expected_digest in inventory.items():
            if member_sha256(bundle, regular_members[relative]) != expected_digest:
                fail("trusted prior release file does not match its inventory")

        if not isinstance(links, dict) or any(
            not isinstance(key, str) or not isinstance(value, str)
            for key, value in links.items()
        ):
            fail("trusted prior release symlink inventory is invalid")
        archive_links = {
            name.removeprefix("release/"): member.linkname
            for name, member in members.items()
            if member.issym() and name.startswith("release/")
        }
        if archive_links != links:
            fail("trusted prior release symlink inventory is incomplete")
        for relative, target in links.items():
            safe_release_relative(relative)
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), target))
            if resolved == ".." or resolved.startswith("../") or posixpath.isabs(resolved):
                fail("trusted prior release symlink inventory escapes its root")

        metadata = validate_manifest(manifest, root, current_commit, current_tree)
        if inventory["apk/evogent.apk"] != metadata["apkSha256"]:
            fail("trusted prior release APK digest disagrees with its manifest")
        artifact_dir = staging / "artifacts"
        artifact_dir.mkdir(mode=0o700)
        for relative in sorted(ARTIFACT_FILES):
            destination = artifact_dir / pathlib.PurePosixPath(relative).name
            stream = bundle.extractfile(regular_members[relative])
            if stream is None:
                fail("trusted prior release identity artifact is unreadable")
            with open(destination, "xb") as output:
                shutil.copyfileobj(stream, output, 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(destination, 0o600)

    metadata_path = staging / "metadata.json"
    with open(metadata_path, "x", encoding="utf-8") as handle:
        json.dump(metadata, handle, separators=(",", ":"), sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(metadata_path, 0o600)


def metadata_value(path, key):
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail("trusted prior release staging metadata is unreadable")
    value = metadata.get(key) if isinstance(metadata, dict) else None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        fail("trusted prior release staging metadata is invalid")
    print(value)


def main():
    if len(sys.argv) < 2:
        fail("Android artifact provenance operation is missing")
    operation = sys.argv[1]
    if operation == "tree-oid" and len(sys.argv) == 4:
        root = pathlib.Path(sys.argv[2]).resolve(strict=True)
        _, tree = commit_and_tree(root, sys.argv[3])
        print(tree)
        return
    if operation == "stage-reuse" and len(sys.argv) == 6:
        root = pathlib.Path(sys.argv[2]).resolve(strict=True)
        commit, _ = commit_and_tree(root, sys.argv[3])
        stage_archive_artifacts(
            root,
            commit,
            sys.argv[4],
            pathlib.Path(sys.argv[5]),
        )
        return
    if operation == "metadata" and len(sys.argv) == 4:
        metadata_value(pathlib.Path(sys.argv[2]), sys.argv[3])
        return
    fail("Android artifact provenance operation is invalid")


try:
    main()
except SystemExit:
    raise
except Exception:
    fail("trusted prior release validation failed")
PY
}

assert_clean_source
SOURCE_COMMIT="$(git rev-parse HEAD)"
SOURCE_SHORT="$(git rev-parse --short=12 HEAD)"
assert_source_commit_unchanged() {
  [ "$(git rev-parse HEAD)" = "$SOURCE_COMMIT" ] || {
    echo "phone release: source commit changed while the build was running" >&2
    exit 65
  }
}
ANDROID_SOURCE_TREE_OID="$(
  android_artifact_provenance tree-oid "$ROOT" "$SOURCE_COMMIT"
)"
[[ "$ANDROID_SOURCE_TREE_OID" =~ ^[0-9a-f]{40,64}$ ]] || {
  echo "phone release: Android source-tree identity is invalid" >&2
  exit 66
}
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/evogent-phone-release.XXXXXX")"
trap 'rm -rf -- "$WORK_DIR"; release_build_lock' EXIT
REUSE_ANDROID_TLS_ARCHIVE="${EVOGENT_REUSE_ANDROID_TLS_FROM_RELEASE:-}"
ANDROID_TLS_PROVENANCE_MODE="built"
ANDROID_TLS_ORIGIN_RELEASE_ID=""
ANDROID_TLS_ORIGIN_SOURCE_COMMIT="$SOURCE_COMMIT"
ANDROID_TLS_ORIGIN_SOURCE_TREE_OID="$ANDROID_SOURCE_TREE_OID"
REUSED_EXPECTED_PACKAGE=""
REUSED_EXPECTED_VERSION_NAME=""
REUSED_EXPECTED_SIGNER_SHA256=""
REUSED_EXPECTED_APK_SHA256=""
REUSED_EXPECTED_TLS_CERT_SHA256=""
REUSED_FROM_RELEASE_ID=""

if [ -n "$REUSE_ANDROID_TLS_ARCHIVE" ]; then
  [ "${EVOGENT_ANDROID_VERSION_CODE+x}" != x ] || {
    echo "phone release: an Android version override cannot accompany exact artifact reuse" >&2
    exit 65
  }
  echo "phone release: validating trusted prior Android/TLS artifact set"
  REUSED_ANDROID_STAGE="$WORK_DIR/reused-android"
  android_artifact_provenance stage-reuse \
    "$ROOT" "$SOURCE_COMMIT" "$REUSE_ANDROID_TLS_ARCHIVE" \
    "$REUSED_ANDROID_STAGE"
  REUSED_METADATA="$REUSED_ANDROID_STAGE/metadata.json"
  APK="$REUSED_ANDROID_STAGE/artifacts/evogent.apk"
  TLS_CERT="$REUSED_ANDROID_STAGE/artifacts/server-cert.pem"
  TLS_KEY="$REUSED_ANDROID_STAGE/artifacts/server-key.pem"
  ANDROID_VERSION_CODE="$(
    android_artifact_provenance metadata "$REUSED_METADATA" versionCode
  )"
  REUSED_EXPECTED_PACKAGE="$(
    android_artifact_provenance metadata "$REUSED_METADATA" package
  )"
  REUSED_EXPECTED_VERSION_NAME="$(
    android_artifact_provenance metadata "$REUSED_METADATA" versionName
  )"
  REUSED_EXPECTED_SIGNER_SHA256="$(
    android_artifact_provenance metadata "$REUSED_METADATA" signerSha256
  )"
  REUSED_EXPECTED_APK_SHA256="$(
    android_artifact_provenance metadata "$REUSED_METADATA" apkSha256
  )"
  REUSED_EXPECTED_TLS_CERT_SHA256="$(
    android_artifact_provenance metadata \
      "$REUSED_METADATA" tlsCertificateDerSha256
  )"
  REUSED_FROM_RELEASE_ID="$(
    android_artifact_provenance metadata "$REUSED_METADATA" priorReleaseId
  )"
  ANDROID_TLS_ORIGIN_RELEASE_ID="$(
    android_artifact_provenance metadata "$REUSED_METADATA" originReleaseId
  )"
  ANDROID_TLS_ORIGIN_SOURCE_COMMIT="$(
    android_artifact_provenance metadata "$REUSED_METADATA" originSourceCommit
  )"
  ANDROID_TLS_ORIGIN_SOURCE_TREE_OID="$(
    android_artifact_provenance metadata \
      "$REUSED_METADATA" originSourceTreeOid
  )"
  ANDROID_TLS_PROVENANCE_MODE="reused"
else
  ANDROID_VERSION_STATE_FILE="${EVOGENT_ANDROID_VERSION_STATE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/evogent/android-version-code}"
  ANDROID_VERSION_ARGUMENTS=(
    --state-file "$ANDROID_VERSION_STATE_FILE"
    --forbid-root "$ROOT"
  )
  if [ "${EVOGENT_ANDROID_VERSION_CODE+x}" = x ]; then
    ANDROID_VERSION_ARGUMENTS+=(--override "$EVOGENT_ANDROID_VERSION_CODE")
  fi
  ANDROID_VERSION_CODE="$(python3 scripts/allocate-android-version-code.py \
    "${ANDROID_VERSION_ARGUMENTS[@]}")"
  export EVOGENT_ANDROID_VERSION_CODE="$ANDROID_VERSION_CODE"
fi

JAVA_HOME="$(resolve_java_home)" || {
  echo "phone release: JDK not found; set EVOGENT_JAVA_HOME or JAVA_HOME" >&2
  exit 69
}
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

echo "phone release: building web application at $SOURCE_SHORT"
npm run build

if [ -n "$REUSE_ANDROID_TLS_ARCHIVE" ]; then
  echo "phone release: reusing verified Android/TLS artifact version $ANDROID_VERSION_CODE"
else
  echo "phone release: building and signing Android shell version $ANDROID_VERSION_CODE"
  bash android-shell/build.sh
  APK="$ROOT/android-shell/build/evogent.apk"
  TLS_CERT="$ROOT/android-shell/build/server-cert.pem"
  TLS_KEY="$ROOT/android-shell/build/server-key.pem"
fi

# A build script must not be able to quietly edit the source it claims to represent.
assert_clean_source
assert_source_commit_unchanged

BUILD_ID="$(tr -d '\r\n' < .next/BUILD_ID)"
[ -n "$BUILD_ID" ] || {
  echo "phone release: .next/BUILD_ID is empty" >&2
  exit 66
}

[ -s "$APK" ] || {
  echo "phone release: signed APK missing: $APK" >&2
  exit 66
}

AAPT2="$(find_android_tool aapt2)"
APKSIGNER="$(find_android_tool apksigner)"
[ -x "$AAPT2" ] && [ -x "$APKSIGNER" ] || {
  echo "phone release: Android build tools aapt2/apksigner were not found" >&2
  exit 69
}

"$APKSIGNER" verify --verbose --print-certs "$APK" >/dev/null
unzip -Z1 "$APK" | grep -Eqi '^META-INF/.*\.(RSA|DSA|EC)$' || {
  echo "phone release: APK lacks the certificate block required for on-device signer verification" >&2
  exit 66
}
BADGING="$("$AAPT2" dump badging "$APK")"
APK_PACKAGE="$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\\([^']*\\)'.*/\\1/p" | head -1)"
APK_VERSION_CODE="$(printf '%s\n' "$BADGING" | sed -n "s/^package: .*versionCode='\\([^']*\\)'.*/\\1/p" | head -1)"
APK_VERSION_NAME="$(printf '%s\n' "$BADGING" | sed -n "s/^package: .*versionName='\\([^']*\\)'.*/\\1/p" | head -1)"
APK_SIGNER_SHA256="$("$APKSIGNER" verify --print-certs "$APK" \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' \
  | tr '[:upper:]' '[:lower:]' \
  | head -1)"
APK_SHA256="$(python3 - "$APK" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"

[ "$APK_PACKAGE" = "net.dangish.evogent" ] \
  && [ "$APK_VERSION_CODE" = "$ANDROID_VERSION_CODE" ] \
  && [[ "$APK_VERSION_CODE" =~ ^[0-9]+$ ]] \
  && [ -n "$APK_VERSION_NAME" ] \
  && [[ "$APK_SIGNER_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "phone release: could not verify APK package, version, and signer" >&2
    exit 66
  }
if [ -n "$REUSE_ANDROID_TLS_ARCHIVE" ]; then
  [ "$APK_PACKAGE" = "$REUSED_EXPECTED_PACKAGE" ] \
    && [ "$APK_VERSION_NAME" = "$REUSED_EXPECTED_VERSION_NAME" ] \
    && [ "$APK_SIGNER_SHA256" = "$REUSED_EXPECTED_SIGNER_SHA256" ] \
    && [ "$APK_SHA256" = "$REUSED_EXPECTED_APK_SHA256" ] || {
      echo "phone release: reused APK identity differs from the trusted release" >&2
      exit 66
    }
fi

SAFE_BUILD_ID="$(printf '%s' "$BUILD_ID" | tr -cd 'A-Za-z0-9._-' | cut -c1-20)"
[ -n "$SAFE_BUILD_ID" ] || SAFE_BUILD_ID=build
EMBEDDED_CA="$WORK_DIR/evogent-phone-ca.pem"
[ -f "$TLS_CERT" ] && [ ! -L "$TLS_CERT" ] \
  && [ -f "$TLS_KEY" ] && [ ! -L "$TLS_KEY" ] || {
    echo "phone release: Android build did not emit regular TLS certificate/key artifacts" >&2
    exit 66
  }
[ "$(file_mode "$TLS_KEY")" = 600 ] || {
  echo "phone release: Android TLS private key permissions must be 0600" >&2
  exit 66
}
unzip -p "$APK" res/raw/evogent_phone_ca.pem > "$EMBEDDED_CA"
[ -s "$EMBEDDED_CA" ] || {
  echo "phone release: APK does not contain its release CA certificate" >&2
  exit 66
}
openssl x509 -in "$TLS_CERT" -noout -checkend 0 >/dev/null || {
  echo "phone release: Android TLS certificate is not currently valid" >&2
  exit 66
}
openssl verify -purpose sslserver -CAfile "$EMBEDDED_CA" "$TLS_CERT" >/dev/null || {
  echo "phone release: Android TLS certificate does not chain to the APK release CA" >&2
  exit 66
}
TLS_SAN="$(openssl x509 -in "$TLS_CERT" -noout -ext subjectAltName \
  | tail -n +2 | tr -d '[:space:]')"
[ "$TLS_SAN" = "IPAddress:127.0.0.1" ] || {
  echo "phone release: Android TLS certificate must contain only the exact 127.0.0.1 IP SAN" >&2
  exit 66
}
openssl x509 -in "$TLS_CERT" -pubkey -noout \
  | openssl pkey -pubin -outform DER > "$WORK_DIR/server-cert.pub"
openssl pkey -in "$TLS_KEY" -pubout -outform DER > "$WORK_DIR/server-key.pub"
cmp -s "$WORK_DIR/server-cert.pub" "$WORK_DIR/server-key.pub" || {
  echo "phone release: Android TLS certificate/private key mismatch" >&2
  exit 66
}
TLS_CERT_DER_SHA256="$(openssl x509 -in "$TLS_CERT" -outform DER \
  | openssl dgst -sha256 -r | awk '{print $1}')"
TLS_CERT_NOT_AFTER="$(openssl x509 -in "$TLS_CERT" -noout -enddate | cut -d= -f2-)"
[[ "$TLS_CERT_DER_SHA256" =~ ^[0-9a-f]{64}$ ]] && [ -n "$TLS_CERT_NOT_AFTER" ] || {
  echo "phone release: Android TLS certificate identity could not be read" >&2
  exit 66
}
if [ -n "$REUSE_ANDROID_TLS_ARCHIVE" ] \
    && [ "$TLS_CERT_DER_SHA256" != "$REUSED_EXPECTED_TLS_CERT_SHA256" ]; then
  echo "phone release: reused TLS identity differs from the trusted release" >&2
  exit 66
fi

RELEASE_IDENTITY_DIGEST="$(python3 - "$APK_SHA256" "$TLS_CERT_DER_SHA256" <<'PY'
import hashlib
import sys

apk_sha256, certificate_sha256 = sys.argv[1:]
identity = f"apk-sha256:{apk_sha256}\ntls-cert-der-sha256:{certificate_sha256}\n"
print(hashlib.sha256(identity.encode("ascii")).hexdigest()[:12])
PY
)"
[[ "$RELEASE_IDENTITY_DIGEST" =~ ^[0-9a-f]{12}$ ]] || {
  echo "phone release: APK/TLS release identity could not be derived" >&2
  exit 66
}
# The APK embeds a freshly generated private CA, so two clean builds from the
# same source/build/version are intentionally different releases.  Bind the
# directory/archive identity to the actual APK plus its matching TLS leaf.
RELEASE_ID="${SOURCE_SHORT}-${SAFE_BUILD_ID}-apk${APK_VERSION_CODE}-${RELEASE_IDENTITY_DIGEST}"
if [ "$ANDROID_TLS_PROVENANCE_MODE" = "built" ]; then
  ANDROID_TLS_ORIGIN_RELEASE_ID="$RELEASE_ID"
elif [ "$RELEASE_ID" = "$REUSED_FROM_RELEASE_ID" ]; then
  echo "phone release: artifact reuse must create a distinct successor release" >&2
  exit 65
fi
RELEASE="$WORK_DIR/release"
RUNTIME="$RELEASE/runtime"

mkdir -p "$RUNTIME" "$RELEASE/phone-tools" "$RELEASE/device" "$RELEASE/apk" \
  "$RELEASE/tls" \
  "$RELEASE/defaults"

# The clean tree equals HEAD, but archive from Git anyway: ignored build caches,
# local secrets, worktrees, and private data can never enter a release by accident.
git archive "$SOURCE_COMMIT" \
  server.js worker.js package.json package-lock.json next.config.js tsconfig.json \
  CLAUDE.md AGENTS.md LICENSE lib src scripts .claude \
  .intent/contracts.jsonl .intent/failure-modes.jsonl skills-library data \
  | tar -xf - -C "$RUNTIME"
# Host-development agent orchestration is disabled on the phone and contains
# host-specific state symlinks. It cannot enter a portable runtime bundle.
rm -rf "$RUNTIME/scripts/agents"

# Private data is a shared deployment state directory. Seedable public defaults
# travel beside the runtime, while runtime/data is created as a state link by the
# installer.
mv "$RUNTIME/data" "$RELEASE/defaults/data"
prepare_phone_live_defaults "$RELEASE/defaults/data"

# Copy the build output without its disposable host cache.
mkdir -p "$RUNTIME/.next"
(cd "$ROOT/.next" && tar --exclude='./cache' -cf - .) | (cd "$RUNTIME/.next" && tar -xf -)

# Next records the build machine's absolute checkout in its generated server
# manifests. The custom server reads only their config, so retain the manifests
# with a portable appDir and regenerate their JavaScript twin exactly.
python3 - "$RUNTIME/.next/required-server-files.json" \
  "$RUNTIME/.next/required-server-files.js" <<'PY'
import json
import pathlib
import sys

json_path = pathlib.Path(sys.argv[1])
js_path = pathlib.Path(sys.argv[2])
payload = json.loads(json_path.read_text(encoding="utf-8"))
payload["appDir"] = "."
config = payload.get("config")
if isinstance(config, dict):
    config["outputFileTracingRoot"] = "."
    turbopack = config.get("turbopack")
    if isinstance(turbopack, dict):
        turbopack["root"] = "."
formatted = json.dumps(payload, indent=2)
json_path.write_text(formatted + "\n", encoding="utf-8")
js_path.write_text("self.__SERVER_FILES_MANIFEST=" + formatted, encoding="utf-8")
PY

cp "$APK" "$RELEASE/apk/evogent.apk"
cp "$TLS_CERT" "$RELEASE/tls/server-cert.pem"
cp "$TLS_KEY" "$RELEASE/tls/server-key.pem"
chmod 644 "$RELEASE/tls/server-cert.pem"
chmod 600 "$RELEASE/tls/server-key.pem"
COPIED_APK_SHA256="$(python3 - "$RELEASE/apk/evogent.apk" <<'PY'
import hashlib
import sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
COPIED_TLS_CERT_DER_SHA256="$(
  openssl x509 -in "$RELEASE/tls/server-cert.pem" -outform DER \
    | openssl dgst -sha256 -r | awk '{print $1}'
)"
openssl x509 -in "$RELEASE/tls/server-cert.pem" -pubkey -noout \
  | openssl pkey -pubin -outform DER > "$WORK_DIR/copied-server-cert.pub"
openssl pkey -in "$RELEASE/tls/server-key.pem" -pubout -outform DER \
  > "$WORK_DIR/copied-server-key.pub"
[ "$COPIED_APK_SHA256" = "$APK_SHA256" ] \
  && [ "$COPIED_TLS_CERT_DER_SHA256" = "$TLS_CERT_DER_SHA256" ] \
  && cmp -s "$WORK_DIR/copied-server-cert.pub" "$WORK_DIR/copied-server-key.pub" || {
    echo "phone release: verified APK/TLS artifacts changed before packaging" >&2
    exit 66
  }
# Archive only committed control-plane sources. Ignored bytecode, local test
# caches, and any untracked operator artifact can never enter a phone release.
git archive "$SOURCE_COMMIT":phone-paradigm/device/phone-tools \
  | tar -xf - -C "$RELEASE/phone-tools"
git archive "$SOURCE_COMMIT" \
  phone-paradigm/device/start-prod.sh \
  phone-paradigm/device/restart-evo.sh \
  phone-paradigm/device/install-release.sh \
  phone-paradigm/device/attest-install-review.py \
  phone-paradigm/device/forward-rescue.sh \
  phone-paradigm/device/android-role-state.py \
  phone-paradigm/device/dependency-tree-state.py \
  phone-paradigm/device/rollback-state.py \
  phone-paradigm/device/write-control-token.py \
  | tar --strip-components=2 -xf - -C "$RELEASE/device"
mkdir -p "$RELEASE/device/bin"
git archive "$SOURCE_COMMIT":phone-paradigm/device/bin \
  | tar -xf - -C "$RELEASE/device/bin"

# Mutable paths are linked by the installer only after extraction. Keeping them
# out of the archive makes traversal validation and the immutable boundary clear.
rm -rf "$RUNTIME/data" "$RUNTIME/node_modules" "$RUNTIME/.env.local"

# Fail closed if a tracked/generated text artifact still contains an email
# address or this build machine's identity/path. Optional exact private markers
# can be supplied one per line without ever copying that file into the release.
python3 - "$RELEASE" "$ROOT" "$HOME" \
  "${EVOGENT_RELEASE_PRIVATE_MARKERS_FILE:-}" <<'PY'
import os
import pathlib
import re
import socket
import sys

release = pathlib.Path(sys.argv[1])
root = sys.argv[2]
home = sys.argv[3]
markers_path = sys.argv[4]
markers = {root, home, pathlib.Path(home).name, socket.gethostname()}
if markers_path:
    marker_file = pathlib.Path(markers_path)
    if not marker_file.is_file():
        raise SystemExit("phone release: private marker file was not found")
    markers.update(
        line.strip()
        for line in marker_file.read_text(encoding="utf-8").splitlines()
        if len(line.strip()) >= 4
    )
markers = {marker.encode() for marker in markers if len(marker) >= 4}
email = re.compile(rb"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
reserved_email_domains = {b"example.com", b"example.org", b"example.net", b"example.invalid"}

for path in release.rglob("*"):
    if not path.is_file() or path.is_symlink():
        continue
    data = path.read_bytes()
    if b"\0" in data:
        continue
    relative_path = path.relative_to(release)
    # Third-party source maps legitimately contain their authors' addresses.
    # Project source is scanned before compilation; generated .next text still
    # receives the exact host/private-marker checks below.
    private_email = ".next" not in relative_path.parts and any(
        match.group().rsplit(b"@", 1)[1].lower() not in reserved_email_domains
        for match in email.finditer(data)
    )
    if any(marker in data for marker in markers) or private_email:
        relative = relative_path.as_posix()
        raise SystemExit(f"phone release: private text detected in {relative}")
PY

BUILT_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
PACKAGE_LOCK_SHA256="$(python3 - "$RUNTIME/package-lock.json" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"

# Runtime-visible identity does not depend on a .git directory being deployed.
python3 - "$RUNTIME/.evogent-release.json" <<PY
import json
import sys
payload = {
    "releaseFormat": 1,
    "releaseId": "$RELEASE_ID",
    "sourceCommit": "$SOURCE_COMMIT",
    "sourceCommitShort": "$SOURCE_SHORT",
    "buildId": "$BUILD_ID",
    "builtAt": "$BUILT_AT",
    "apkVersionCode": int("$APK_VERSION_CODE"),
    "apkVersionName": "$APK_VERSION_NAME",
    "releaseIdentityDigest": "$RELEASE_IDENTITY_DIGEST",
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\\n")
PY

# Hash every regular file in a stable path order. Symlinks in .next are recorded
# separately in the manifest and are also bounded by the outer archive checksum.
python3 - "$RELEASE" "$RELEASE/files.sha256" "$RELEASE/links.json" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
inventory = pathlib.Path(sys.argv[2])
links_path = pathlib.Path(sys.argv[3])
excluded = {"files.sha256", "links.json", "manifest.json"}
rows = []
links = {}
for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
    relative = path.relative_to(root).as_posix()
    if relative in excluded:
        continue
    if path.is_symlink():
        target = os.readlink(path)
        if os.path.isabs(target):
            raise SystemExit(f"absolute symlink cannot enter a phone release: {relative}")
        resolved = (path.parent / target).resolve(strict=False)
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            raise SystemExit(f"symlink escapes phone release: {relative}")
        links[relative] = target
    elif path.is_file():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append(f"{digest}  {relative}")
inventory.write_text("\n".join(rows) + "\n", encoding="utf-8")
links_path.write_text(
    json.dumps(links, separators=(",", ":"), sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

INVENTORY_SHA256="$(python3 - "$RELEASE/files.sha256" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
LINKS_SHA256="$(python3 - "$RELEASE/links.json" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"

python3 - "$RELEASE/manifest.json" <<PY
import json
import sys
manifest = {
    "schema": "evogent.phone.release.v1",
    "releaseFormat": 1,
    "releaseId": "$RELEASE_ID",
    "releaseIdentityDigest": "$RELEASE_IDENTITY_DIGEST",
    "builtAt": "$BUILT_AT",
    "source": {
        "commit": "$SOURCE_COMMIT",
        "commitShort": "$SOURCE_SHORT",
    },
    "artifactProvenance": {
        "androidTls": {
            "schema": "evogent.android-tls.artifact-provenance.v1",
            "mode": "$ANDROID_TLS_PROVENANCE_MODE",
            "originReleaseId": "$ANDROID_TLS_ORIGIN_RELEASE_ID",
            "sourceCommit": "$ANDROID_TLS_ORIGIN_SOURCE_COMMIT",
            "sourceTree": {
                "path": "android-shell",
                "oid": "$ANDROID_TLS_ORIGIN_SOURCE_TREE_OID",
            },
        },
    },
    "web": {"buildId": "$BUILD_ID"},
    "android": {
        "package": "$APK_PACKAGE",
        "versionCode": int("$APK_VERSION_CODE"),
        "versionName": "$APK_VERSION_NAME",
        "signerSha256": "$APK_SIGNER_SHA256".lower(),
        "sha256": "$APK_SHA256",
    },
    "phoneTls": {
        "host": "127.0.0.1",
        "port": 3443,
        "certificateDerSha256": "$TLS_CERT_DER_SHA256",
        "certificateNotAfter": "$TLS_CERT_NOT_AFTER",
    },
    "databaseSchema": {
        "version": 1,
        "strategy": "idempotent-startup-migrations",
        "rollbackRequiresSnapshot": True,
    },
    "stateLinks": {
        "runtime/data": "../../../state/data",
        "runtime/node_modules": "../../../state/dependencies/$PACKAGE_LOCK_SHA256/node_modules",
        "runtime/.env.local": "../../../state/config/.env.local",
        "runtime/.next/cache": "../../../../state/next-cache/$RELEASE_ID",
    },
    "dependencies": {"packageLockSha256": "$PACKAGE_LOCK_SHA256"},
    "inventory": {
        "algorithm": "sha256",
        "path": "files.sha256",
        "sha256": "$INVENTORY_SHA256",
        "linksPath": "links.json",
        "linksSha256": "$LINKS_SHA256",
    },
    "requiredPaths": [
        "runtime/.next/BUILD_ID",
        "runtime/.evogent-release.json",
        "runtime/server.js",
        "runtime/package.json",
        "runtime/package-lock.json",
        "runtime/lib",
        "runtime/src/lib/runtime-profile.js",
        "runtime/.claude",
        "runtime/.intent/contracts.jsonl",
        "runtime/.intent/failure-modes.jsonl",
        "runtime/skills-library",
        "defaults/data/preference-insights.md",
        "defaults/data/source-cadence.json",
        "phone-tools/evo-curl",
        "phone-tools/evo-health",
        "phone-tools/evo_curl_transport.py",
        "phone-tools/evogent_api.py",
        "phone-tools/control-plane.sh",
        "phone-tools/evogent-cycle.sh",
        "phone-tools/evogent-scheduler.sh",
        "phone-tools/evogent-watchdog.sh",
        "device/start-prod.sh",
        "device/restart-evo.sh",
        "device/install-release.sh",
        "device/attest-install-review.py",
        "device/forward-rescue.sh",
        "device/android-role-state.py",
        "device/dependency-tree-state.py",
        "device/rollback-state.py",
        "device/write-control-token.py",
        "apk/evogent.apk",
        "tls/server-cert.pem",
        "tls/server-key.pem",
    ],
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write("\\n")
PY

mkdir -p "$OUTPUT_DIR"
ARCHIVE="$OUTPUT_DIR/evogent-phone-${RELEASE_ID}.tar.gz"
assert_clean_source
assert_source_commit_unchanged
# macOS bsdtar otherwise serializes com.apple.provenance as a PAX xattr for
# thousands of generated files. The phone ignores it but emits one warning per
# member, wasting install time and obscuring the transactional status output.
tar --no-xattrs -czf "$ARCHIVE" -C "$WORK_DIR" release
chmod 600 "$ARCHIVE"
python3 - "$ARCHIVE" <<'PY'
import pathlib
import posixpath
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as bundle:
    for member in bundle.getmembers():
        name = member.name
        pure = pathlib.PurePosixPath(name)
        if (
            pure.is_absolute()
            or ".." in pure.parts
            or not pure.parts
            or pure.parts[0] != "release"
        ):
            raise SystemExit(f"phone release: unsafe archive member: {name!r}")
        if (
            member.isdev()
            or member.isfifo()
            or member.ischr()
            or member.isblk()
            or member.islnk()
        ):
            raise SystemExit(
                f"phone release: unsupported archive member type: {name!r}",
            )
        if member.issym():
            resolved = posixpath.normpath(
                posixpath.join(posixpath.dirname(name), member.linkname),
            )
            if not resolved.startswith("release/"):
                raise SystemExit(
                    f"phone release: symlink escapes release: {name!r}",
                )
PY
[ "$(file_mode "$ARCHIVE")" = 600 ] || {
  echo "phone release: archive containing TLS key is not mode 0600" >&2
  exit 66
}
ARCHIVE_SHA256="$(python3 - "$ARCHIVE" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
printf '%s  %s\n' "$ARCHIVE_SHA256" "$(basename "$ARCHIVE")" > "$ARCHIVE.sha256"
chmod 600 "$ARCHIVE.sha256"
[ "$(file_mode "$ARCHIVE.sha256")" = 600 ] || {
  echo "phone release: archive checksum sidecar is not mode 0600" >&2
  exit 66
}

echo "phone release: $ARCHIVE"
echo "phone release sha256: $ARCHIVE_SHA256"
echo "source: $SOURCE_COMMIT"
echo "build: $BUILD_ID"
echo "apk: $APK_VERSION_NAME ($APK_VERSION_CODE)"
