#!/usr/bin/env bash
# Stream one complete release to a connected phone and invoke its installer.
# Device-specific values are required through the environment and never stored here.
set -euo pipefail
umask 077

INSTALL_MODE="normal"
if [ "${1:-}" = "--forward-supersede" ]; then
  INSTALL_MODE="--forward-supersede"
  shift
fi
[ "$#" -eq 1 ] || {
  echo "usage: deploy-phone-release.sh [--forward-supersede] <release.tar.gz>" >&2
  exit 64
}

exec python3 - "$INSTALL_MODE" "$1" <<'HOSTPY'
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile


SAFE_NAME = re.compile(r"[A-Za-z0-9._-]+")
REMOTE_SCHEMA = "evogent.phone.deploy-staging.v1"
REMOTE_METADATA = "deploy-metadata.json"
active_child = None
local_stage = None
local_stage_fd = None
local_stage_identity = None
snapshot_names = []


class HostFailure(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class HostSignal(Exception):
    def __init__(self, status):
        super().__init__(status)
        self.status = status


def fail(status, message):
    raise HostFailure(status, message)


def normalize_returncode(returncode):
    return returncode if returncode >= 0 else 128 - returncode


def handle_signal(signum, _frame):
    global active_child
    if active_child is not None and active_child.poll() is None:
        try:
            active_child.send_signal(signum)
        except OSError:
            pass
    raise HostSignal(128 + signum)


for handled_signal in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(handled_signal, handle_signal)


def file_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_uid,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def write_all(descriptor, data):
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        if written < 1:
            fail(74, "phone deploy: local release staging failed")
        view = view[written:]


def snapshot_regular(source, destination_name, size_limit):
    try:
        before = os.lstat(source)
    except OSError:
        fail(66, "phone deploy: local release artifacts were rejected")
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != os.geteuid()
        or before.st_nlink != 1
        or before.st_size < 1
        or before.st_size > size_limit
    ):
        fail(66, "phone deploy: local release artifacts were rejected")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        fail(66, "phone deploy: local release artifacts were rejected")
    try:
        source_fd = os.open(
            source,
            os.O_RDONLY | nofollow | getattr(os, "O_CLOEXEC", 0),
        )
    except OSError:
        fail(66, "phone deploy: local release artifacts were rejected")
    destination_fd = None
    try:
        opened = os.fstat(source_fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or opened.st_nlink != 1
            or file_identity(opened) != file_identity(before)
        ):
            fail(66, "phone deploy: local release artifacts were rejected")
        if stat.S_IMODE(opened.st_mode) != 0o600:
            os.fchmod(source_fd, 0o600)
        opened = os.fstat(source_fd)
        current = os.lstat(source)
        if (
            stat.S_IMODE(opened.st_mode) != 0o600
            or file_identity(current) != file_identity(opened)
        ):
            fail(66, "phone deploy: local release artifacts were rejected")
        destination_fd = os.open(
            destination_name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | nofollow
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=local_stage_fd,
        )
        digest = hashlib.sha256()
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            write_all(destination_fd, chunk)
        os.fchmod(destination_fd, 0o600)
        os.fsync(destination_fd)
        installed = os.fstat(destination_fd)
        completed = os.fstat(source_fd)
        current = os.lstat(source)
        if (
            not stat.S_ISREG(installed.st_mode)
            or installed.st_uid != os.geteuid()
            or installed.st_nlink != 1
            or stat.S_IMODE(installed.st_mode) != 0o600
            or file_identity(completed) != file_identity(opened)
            or file_identity(current) != file_identity(opened)
        ):
            fail(66, "phone deploy: local release artifacts were rejected")
        return digest.hexdigest()
    except OSError:
        fail(66, "phone deploy: local release artifacts were rejected")
    finally:
        if destination_fd is not None:
            os.close(destination_fd)
        os.close(source_fd)


def open_snapshot(name):
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(
        name,
        os.O_RDONLY | nofollow | getattr(os, "O_CLOEXEC", 0),
        dir_fd=local_stage_fd,
    )
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.geteuid()
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        os.close(descriptor)
        fail(66, "phone deploy: local release snapshot was rejected")
    return descriptor, info


def cleanup_local():
    cleanup_failed = False
    if local_stage_fd is None or local_stage is None:
        return False
    for name in snapshot_names:
        try:
            info = os.stat(name, dir_fd=local_stage_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        except OSError:
            cleanup_failed = True
            continue
        if stat.S_ISDIR(info.st_mode):
            cleanup_failed = True
            continue
        try:
            os.unlink(name, dir_fd=local_stage_fd)
        except OSError:
            cleanup_failed = True
    try:
        os.fsync(local_stage_fd)
    except OSError:
        cleanup_failed = True
    try:
        rebound = os.lstat(local_stage)
        if (
            not stat.S_ISDIR(rebound.st_mode)
            or (rebound.st_dev, rebound.st_ino) != local_stage_identity
            or os.listdir(local_stage_fd)
        ):
            cleanup_failed = True
        else:
            os.rmdir(local_stage)
    except OSError:
        cleanup_failed = True
    return cleanup_failed


REMOTE_SOURCE = r"""
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tarfile
import time


SCHEMA = "evogent.phone.deploy-staging.v1"
METADATA_NAME = "deploy-metadata.json"
LEAF_PATTERN = re.compile(r"deploy\.[0-9a-f]{16}")
SAFE_NAME = re.compile(r"[A-Za-z0-9._-]+")
STALE_NS = 7 * 24 * 60 * 60 * 1_000_000_000
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
CLOEXEC = getattr(os, "O_CLOEXEC", 0)
active_child = None
home_fd = None
cache_fd = None
incoming_fd = None
leaf_fd = None
leaf = None
leaf_identity = None
archive_name = None


class RemoteFailure(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class RemoteSignal(Exception):
    def __init__(self, status):
        super().__init__(status)
        self.status = status


def fail(status, message):
    raise RemoteFailure(status, message)


def normalize_returncode(returncode):
    return returncode if returncode >= 0 else 128 - returncode


def handle_signal(signum, _frame):
    global active_child
    if active_child is not None and active_child.poll() is None:
        try:
            active_child.send_signal(signum)
        except OSError:
            pass
    raise RemoteSignal(128 + signum)


for handled_signal in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(handled_signal, handle_signal)


def warning(message):
    print(message, file=sys.stderr)


def identity(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_uid,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def open_owned_directory(parent_fd, name, create_mode=None, exact_mode=None):
    if create_mode is not None:
        try:
            os.mkdir(name, create_mode, dir_fd=parent_fd)
        except FileExistsError:
            pass
        except OSError:
            fail(73, "phone deploy: remote staging directory was rejected")
    if not NOFOLLOW or not DIRECTORY:
        fail(73, "phone deploy: remote staging directory was rejected")
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
            dir_fd=parent_fd,
        )
    except OSError:
        fail(73, "phone deploy: remote staging directory was rejected")
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        os.close(descriptor)
        fail(73, "phone deploy: remote staging directory was rejected")
    if exact_mode is not None:
        try:
            os.fchmod(descriptor, exact_mode)
        except OSError:
            os.close(descriptor)
            fail(73, "phone deploy: remote staging directory was rejected")
        info = os.fstat(descriptor)
        if stat.S_IMODE(info.st_mode) != exact_mode:
            os.close(descriptor)
            fail(73, "phone deploy: remote staging directory was rejected")
    return descriptor


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def parse_metadata(raw, expected_leaf):
    if len(raw) < 2 or len(raw) > 1024 or not raw.endswith(b"\n"):
        raise ValueError
    value = json.loads(
        raw.decode("utf-8", "strict"),
        object_pairs_hook=unique_object,
    )
    if (
        not isinstance(value, dict)
        or set(value)
        != {"schema", "leaf", "archiveBasename", "createdAt"}
        or value.get("schema") != SCHEMA
        or value.get("leaf") != expected_leaf
    ):
        raise ValueError
    candidate_archive = value.get("archiveBasename")
    created_at = value.get("createdAt")
    if (
        not isinstance(candidate_archive, str)
        or not SAFE_NAME.fullmatch(candidate_archive)
        or candidate_archive in {".", "..", METADATA_NAME}
        or len(candidate_archive) > 220
        or not isinstance(created_at, int)
        or isinstance(created_at, bool)
        or created_at < 0
    ):
        raise ValueError
    return candidate_archive, created_at


def stable_metadata(directory_fd):
    before = os.stat(
        METADATA_NAME,
        dir_fd=directory_fd,
        follow_symlinks=False,
    )
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != os.geteuid()
        or before.st_nlink != 1
        or stat.S_IMODE(before.st_mode) != 0o600
        or before.st_size < 2
        or before.st_size > 1024
    ):
        raise ValueError
    descriptor = os.open(
        METADATA_NAME,
        os.O_RDONLY | NOFOLLOW | CLOEXEC,
        dir_fd=directory_fd,
    )
    try:
        opened = os.fstat(descriptor)
        if identity(opened) != identity(before):
            raise ValueError
        raw = b""
        while len(raw) <= 1024:
            chunk = os.read(descriptor, 1025 - len(raw))
            if not chunk:
                break
            raw += chunk
        completed = os.fstat(descriptor)
        current = os.stat(
            METADATA_NAME,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if (
            identity(completed) != identity(opened)
            or identity(current) != identity(opened)
        ):
            raise ValueError
        return raw, opened
    finally:
        os.close(descriptor)


def reconcile_leaf(parent_fd, candidate):
    if not LEAF_PATTERN.fullmatch(candidate):
        return True
    candidate_fd = None
    try:
        before = os.stat(candidate, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISDIR(before.st_mode)
            or before.st_uid != os.geteuid()
            or stat.S_IMODE(before.st_mode) != 0o700
        ):
            return True
        candidate_fd = os.open(
            candidate,
            os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
            dir_fd=parent_fd,
        )
        opened = os.fstat(candidate_fd)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o700
            or (opened.st_dev, opened.st_ino)
            != (before.st_dev, before.st_ino)
        ):
            return True
        names = set(os.listdir(candidate_fd))
        if METADATA_NAME not in names:
            return True
        raw_metadata, metadata_info = stable_metadata(candidate_fd)
        candidate_archive, created_at = parse_metadata(
            raw_metadata,
            candidate,
        )
        allowed_modes = {
            METADATA_NAME: 0o600,
            f"{candidate_archive}.partial": 0o600,
            f"{candidate_archive}.sha256.partial": 0o600,
            candidate_archive: 0o600,
            f"{candidate_archive}.sha256": 0o600,
        }
        if not names.issubset(allowed_modes):
            return True
        entry_identities = {METADATA_NAME: identity(metadata_info)}
        mtimes = [opened.st_mtime_ns, metadata_info.st_mtime_ns]
        for name in sorted(names - {METADATA_NAME}):
            info = os.stat(
                name,
                dir_fd=candidate_fd,
                follow_symlinks=False,
            )
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid()
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != allowed_modes[name]
            ):
                return True
            entry_identities[name] = identity(info)
            mtimes.append(info.st_mtime_ns)
        now_ns = time.time_ns()
        created_at_ns = created_at * 1_000_000_000
        if (
            created_at_ns > now_ns
            or any(value < 0 or value > now_ns for value in mtimes)
        ):
            return True
        cutoff_ns = now_ns - STALE_NS
        if created_at_ns >= cutoff_ns or max(mtimes) >= cutoff_ns:
            return False
        rebound = os.stat(
            candidate,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if (
            not stat.S_ISDIR(rebound.st_mode)
            or rebound.st_uid != os.geteuid()
            or stat.S_IMODE(rebound.st_mode) != 0o700
            or (rebound.st_dev, rebound.st_ino)
            != (opened.st_dev, opened.st_ino)
        ):
            return True
        for name in sorted(names - {METADATA_NAME}) + [METADATA_NAME]:
            current = os.stat(
                name,
                dir_fd=candidate_fd,
                follow_symlinks=False,
            )
            if identity(current) != entry_identities[name]:
                return True
            os.unlink(name, dir_fd=candidate_fd)
        os.fsync(candidate_fd)
        if os.listdir(candidate_fd):
            return True
        rebound = os.stat(
            candidate,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if (
            not stat.S_ISDIR(rebound.st_mode)
            or (rebound.st_dev, rebound.st_ino)
            != (opened.st_dev, opened.st_ino)
        ):
            return True
        os.close(candidate_fd)
        candidate_fd = None
        os.rmdir(candidate, dir_fd=parent_fd)
        os.fsync(parent_fd)
        return False
    except (OSError, UnicodeError, ValueError):
        return True
    finally:
        if candidate_fd is not None:
            os.close(candidate_fd)


def reconcile_incoming(parent_fd):
    unsafe = False
    try:
        candidates = sorted(os.listdir(parent_fd))
    except OSError:
        return True
    for candidate in candidates:
        if reconcile_leaf(parent_fd, candidate):
            unsafe = True
    return unsafe


def write_all(descriptor, data):
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        if written < 1:
            fail(74, "phone deploy: remote upload was incomplete")
        view = view[written:]


def read_exact(size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.read(min(1024 * 1024, size - len(result)))
        if not chunk:
            fail(74, "phone deploy: remote upload was incomplete")
        result.extend(chunk)
    return bytes(result)


def write_metadata(directory_fd, directory_leaf, basename):
    payload = (
        json.dumps(
            {
                "archiveBasename": basename,
                "createdAt": int(time.time()),
                "leaf": directory_leaf,
                "schema": SCHEMA,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        + b"\n"
    )
    descriptor = os.open(
        METADATA_NAME,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC,
        0o600,
        dir_fd=directory_fd,
    )
    try:
        write_all(descriptor, payload)
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            fail(73, "phone deploy: remote staging metadata was rejected")
    finally:
        os.close(descriptor)
    os.fsync(directory_fd)


def receive_file(directory_fd, name, size, collect=False):
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC,
        0o600,
        dir_fd=directory_fd,
    )
    digest = hashlib.sha256()
    captured = bytearray()
    try:
        remaining = size
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                fail(74, "phone deploy: remote upload was incomplete")
            remaining -= len(chunk)
            digest.update(chunk)
            if collect:
                captured.extend(chunk)
            write_all(descriptor, chunk)
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size != size
        ):
            fail(66, "phone deploy: remote release staging was rejected")
    finally:
        os.close(descriptor)
    return digest.hexdigest(), bytes(captured)


def checked_open(directory_fd, name, expected_mode):
    before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != os.geteuid()
        or before.st_nlink != 1
        or stat.S_IMODE(before.st_mode) != expected_mode
    ):
        fail(66, "phone deploy: remote release staging was rejected")
    descriptor = os.open(
        name,
        os.O_RDONLY | NOFOLLOW | CLOEXEC,
        dir_fd=directory_fd,
    )
    opened = os.fstat(descriptor)
    if identity(opened) != identity(before):
        os.close(descriptor)
        fail(66, "phone deploy: remote release staging was rejected")
    return descriptor


def cleanup_active_leaf():
    cleanup_failed = False
    if leaf_fd is None or incoming_fd is None or leaf is None:
        return False
    if active_child is not None and active_child.poll() is None:
        try:
            active_child.terminate()
            active_child.wait(timeout=2)
        except Exception:
            try:
                active_child.kill()
                active_child.wait(timeout=2)
            except Exception:
                cleanup_failed = True
    try:
        if home_fd is not None:
            os.fchdir(home_fd)
    except OSError:
        cleanup_failed = True
    exact_names = []
    if archive_name is not None:
        exact_names.extend(
            [
                f"{archive_name}.partial",
                f"{archive_name}.sha256.partial",
                archive_name,
                f"{archive_name}.sha256",
            ]
        )
    exact_names.extend(
        [
            "install-release.sh.partial",
            "install-release.sh",
            METADATA_NAME,
        ]
    )
    for name in exact_names:
        try:
            info = os.stat(name, dir_fd=leaf_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        except OSError:
            cleanup_failed = True
            continue
        if stat.S_ISDIR(info.st_mode):
            cleanup_failed = True
            continue
        try:
            os.unlink(name, dir_fd=leaf_fd)
        except OSError:
            cleanup_failed = True
    try:
        os.fsync(leaf_fd)
    except OSError:
        cleanup_failed = True
    try:
        remaining = os.listdir(leaf_fd)
    except OSError:
        remaining = [True]
        cleanup_failed = True
    if remaining:
        cleanup_failed = True
    else:
        try:
            rebound = os.stat(
                leaf,
                dir_fd=incoming_fd,
                follow_symlinks=False,
            )
            if (
                not stat.S_ISDIR(rebound.st_mode)
                or (rebound.st_dev, rebound.st_ino) != leaf_identity
            ):
                cleanup_failed = True
            else:
                os.rmdir(leaf, dir_fd=incoming_fd)
                os.fsync(incoming_fd)
        except OSError:
            cleanup_failed = True
    return cleanup_failed


def parse_header():
    line = stream.readline(4097)
    if not line or len(line) > 4096 or not line.endswith(b"\n"):
        fail(65, "phone deploy: remote upload header was rejected")
    try:
        value = json.loads(
            line.decode("ascii", "strict"),
            object_pairs_hook=unique_object,
        )
    except (UnicodeError, ValueError):
        fail(65, "phone deploy: remote upload header was rejected")
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "archiveBasename",
            "archiveSha256",
            "archiveSize",
            "installMode",
            "sidecarSize",
        }
    ):
        fail(65, "phone deploy: remote upload header was rejected")
    basename = value.get("archiveBasename")
    checksum = value.get("archiveSha256")
    archive_size = value.get("archiveSize")
    sidecar_size = value.get("sidecarSize")
    install_mode = value.get("installMode")
    if (
        not isinstance(basename, str)
        or not SAFE_NAME.fullmatch(basename)
        or basename in {".", "..", METADATA_NAME}
        or len(basename) > 220
        or not isinstance(checksum, str)
        or not re.fullmatch(r"[0-9a-f]{64}", checksum)
        or not isinstance(archive_size, int)
        or isinstance(archive_size, bool)
        or archive_size < 1
        or archive_size > 4 * 1024 * 1024 * 1024
        or not isinstance(sidecar_size, int)
        or isinstance(sidecar_size, bool)
        or sidecar_size < 1
        or sidecar_size > 1024
        or install_mode not in {"normal", "--forward-supersede"}
    ):
        fail(65, "phone deploy: remote upload header was rejected")
    return basename, checksum, archive_size, sidecar_size, install_mode


primary_status = 0
primary_message = None
cleanup_failed = False
try:
    (
        archive_name,
        expected_sha256,
        archive_size,
        sidecar_size,
        install_mode,
    ) = parse_header()
    home_path = os.path.expanduser("~")
    home_before = os.lstat(home_path)
    home_fd = os.open(
        home_path,
        os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
    )
    home_opened = os.fstat(home_fd)
    if (
        not stat.S_ISDIR(home_opened.st_mode)
        or home_opened.st_uid != os.geteuid()
        or (home_opened.st_dev, home_opened.st_ino)
        != (home_before.st_dev, home_before.st_ino)
    ):
        fail(73, "phone deploy: remote staging directory was rejected")
    os.fchdir(home_fd)
    cache_fd = open_owned_directory(home_fd, ".cache", create_mode=0o700)
    incoming_fd = open_owned_directory(
        cache_fd,
        "evogent-release-incoming",
        create_mode=0o700,
        exact_mode=0o700,
    )
    if reconcile_incoming(incoming_fd):
        warning("phone deploy: stale remote staging entry was retained")
    for _ in range(128):
        candidate = f"deploy.{os.urandom(8).hex()}"
        try:
            os.mkdir(candidate, 0o700, dir_fd=incoming_fd)
            leaf = candidate
            break
        except FileExistsError:
            continue
        except OSError:
            fail(73, "phone deploy: remote staging directory was rejected")
    else:
        fail(73, "phone deploy: remote staging directory was rejected")
    leaf_fd = open_owned_directory(incoming_fd, leaf, exact_mode=0o700)
    leaf_opened = os.fstat(leaf_fd)
    leaf_identity = (leaf_opened.st_dev, leaf_opened.st_ino)
    write_metadata(leaf_fd, leaf, archive_name)

    partial_archive = f"{archive_name}.partial"
    partial_sidecar = f"{archive_name}.sha256.partial"
    archive_digest, _ = receive_file(
        leaf_fd,
        partial_archive,
        archive_size,
    )
    _, sidecar_bytes = receive_file(
        leaf_fd,
        partial_sidecar,
        sidecar_size,
        collect=True,
    )
    if stream.read(1):
        fail(65, "phone deploy: remote upload framing was rejected")
    if (
        archive_digest != expected_sha256
        or sidecar_bytes
        != f"{expected_sha256}  {archive_name}\n".encode("ascii")
    ):
        fail(66, "phone deploy: remote release staging was rejected")
    if set(os.listdir(leaf_fd)) != {
        METADATA_NAME,
        partial_archive,
        partial_sidecar,
    }:
        fail(66, "phone deploy: remote release staging was rejected")
    for final_name in (archive_name, f"{archive_name}.sha256"):
        try:
            os.stat(final_name, dir_fd=leaf_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        except OSError:
            fail(66, "phone deploy: remote release staging was rejected")
        else:
            fail(66, "phone deploy: remote release staging was rejected")
    os.rename(
        partial_archive,
        archive_name,
        src_dir_fd=leaf_fd,
        dst_dir_fd=leaf_fd,
    )
    os.rename(
        partial_sidecar,
        f"{archive_name}.sha256",
        src_dir_fd=leaf_fd,
        dst_dir_fd=leaf_fd,
    )
    os.fsync(leaf_fd)

    archive_fd = checked_open(leaf_fd, archive_name, 0o600)
    try:
        digest = hashlib.sha256()
        while True:
            chunk = os.read(archive_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        if digest.hexdigest() != expected_sha256:
            fail(66, "phone deploy: remote release staging was rejected")
        os.lseek(archive_fd, 0, os.SEEK_SET)
        try:
            bundle = tarfile.open(
                fileobj=os.fdopen(os.dup(archive_fd), "rb"),
                mode="r:gz",
            )
        except (OSError, tarfile.TarError):
            fail(66, "phone deploy: remote release staging was rejected")
        with bundle:
            try:
                member = bundle.getmember(
                    "release/device/install-release.sh"
                )
            except KeyError:
                fail(66, "phone deploy: remote release staging was rejected")
            if (
                not member.isreg()
                or member.size < 1
                or member.size > 4 * 1024 * 1024
            ):
                fail(66, "phone deploy: remote release staging was rejected")
            extracted = bundle.extractfile(member)
            if extracted is None:
                fail(66, "phone deploy: remote release staging was rejected")
            bootstrap_bytes = extracted.read(member.size + 1)
            if len(bootstrap_bytes) != member.size:
                fail(66, "phone deploy: remote release staging was rejected")
    finally:
        os.close(archive_fd)

    os.fchdir(leaf_fd)
    installer_arguments = ["bash", "-s", "--"]
    if install_mode == "--forward-supersede":
        installer_arguments.append("--forward-supersede")
    installer_arguments.extend([archive_name, expected_sha256])
    active_child = subprocess.Popen(
        installer_arguments,
        stdin=subprocess.PIPE,
    )
    try:
        active_child.communicate(input=bootstrap_bytes)
        primary_status = normalize_returncode(active_child.returncode)
    finally:
        if active_child.poll() is not None:
            active_child = None
except RemoteSignal as error:
    primary_status = error.status
except RemoteFailure as error:
    primary_status = error.status
    primary_message = error.message
except BaseException:
    primary_status = 70
    primary_message = "phone deploy: remote deployment failed"
finally:
    cleanup_failed = cleanup_active_leaf()
    for descriptor_name in ("leaf_fd", "incoming_fd", "cache_fd", "home_fd"):
        descriptor = globals().get(descriptor_name)
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                cleanup_failed = True

if primary_message is not None:
    print(primary_message, file=sys.stderr)
if cleanup_failed:
    warning("phone deploy: staging cleanup was incomplete")
raise SystemExit(primary_status)
"""


def send_file(stream_handle, descriptor, size):
    remaining = size
    while remaining:
        chunk = os.read(descriptor, min(1024 * 1024, remaining))
        if not chunk:
            fail(74, "phone deploy: local release upload failed")
        stream_handle.write(chunk)
        remaining -= len(chunk)


primary_status = 0
primary_message = None
cleanup_failed = False
archive_fd = None
sidecar_fd = None
device_selector = None
ssh_port = None
forward_owned = False
try:
    install_mode, raw_archive = sys.argv[1:]
    if install_mode not in {"normal", "--forward-supersede"}:
        fail(64, "phone deploy: install mode was rejected")
    archive = os.path.abspath(raw_archive)
    archive_name = os.path.basename(archive)
    if (
        not SAFE_NAME.fullmatch(archive_name)
        or archive_name in {".", "..", REMOTE_METADATA}
        or len(archive_name) > 220
    ):
        fail(65, "phone deploy: release archive filename was rejected")
    device_selector = os.environ.get("EVOGENT_ADB_SERIAL")
    ssh_user = os.environ.get("EVOGENT_SSH_USER")
    raw_port = os.environ.get("EVOGENT_SSH_PORT")
    if not device_selector:
        fail(64, "phone deploy: device configuration is incomplete")
    if not ssh_user or not SAFE_NAME.fullmatch(ssh_user):
        fail(65, "phone deploy: SSH user configuration was rejected")
    try:
        ssh_port = int(raw_port)
    except (TypeError, ValueError):
        fail(65, "phone deploy: SSH port configuration was rejected")
    if ssh_port < 1 or ssh_port > 65535:
        fail(65, "phone deploy: SSH port configuration was rejected")

    stage_root = os.environ.get("TMPDIR") or None
    local_stage = tempfile.mkdtemp(
        prefix="evogent-phone-deploy.",
        dir=stage_root,
    )
    local_stage_fd = os.open(
        local_stage,
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0),
    )
    os.fchmod(local_stage_fd, 0o700)
    stage_info = os.fstat(local_stage_fd)
    if (
        not stat.S_ISDIR(stage_info.st_mode)
        or stage_info.st_uid != os.geteuid()
        or stat.S_IMODE(stage_info.st_mode) != 0o700
    ):
        fail(73, "phone deploy: local release staging failed")
    local_stage_identity = (stage_info.st_dev, stage_info.st_ino)
    snapshot_names = [archive_name, f"{archive_name}.sha256"]
    archive_digest = snapshot_regular(
        archive,
        archive_name,
        4 * 1024 * 1024 * 1024,
    )
    snapshot_regular(
        f"{archive}.sha256",
        f"{archive_name}.sha256",
        1024,
    )
    sidecar_fd, sidecar_info = open_snapshot(f"{archive_name}.sha256")
    sidecar_bytes = os.read(sidecar_fd, 1025)
    os.lseek(sidecar_fd, 0, os.SEEK_SET)
    if (
        sidecar_bytes
        != f"{archive_digest}  {archive_name}\n".encode("ascii")
    ):
        fail(66, "phone deploy: local release artifacts were rejected")
    archive_fd, archive_info = open_snapshot(archive_name)
    os.fsync(local_stage_fd)

    local_endpoint = f"tcp:{ssh_port}"
    adb_list = subprocess.run(
        [
            "adb",
            "-s",
            device_selector,
            "forward",
            "--list",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if adb_list.returncode != 0:
        fail(69, "phone deploy: device forwarding state was unavailable")
    for raw_line in adb_list.stdout.splitlines():
        fields = raw_line.split()
        if len(fields) >= 3 and fields[1] == local_endpoint.encode("ascii"):
            fail(73, "phone deploy: configured SSH port is already forwarded")

    adb_result = subprocess.run(
        [
            "adb",
            "-s",
            device_selector,
            "forward",
            "--no-rebind",
            local_endpoint,
            "tcp:8022",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if adb_result.returncode != 0:
        fail(69, "phone deploy: device forwarding failed")
    forward_owned = True

    remote_command = (
        "python3 -c "
        "'import sys;s=sys.stdin.buffer;n=int(s.readline());"
        'exec(compile(s.read(n),"<evogent-deploy>","exec"),'
        '{"stream":s})\''
    )
    ssh_command = [
        "ssh",
        "-p",
        str(ssh_port),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "LogLevel=ERROR",
        f"{ssh_user}@127.0.0.1",
        remote_command,
    ]
    header = {
        "archiveBasename": archive_name,
        "archiveSha256": archive_digest,
        "archiveSize": archive_info.st_size,
        "installMode": install_mode,
        "sidecarSize": sidecar_info.st_size,
    }
    remote_bytes = REMOTE_SOURCE.encode("utf-8")
    active_child = subprocess.Popen(ssh_command, stdin=subprocess.PIPE)
    write_failed = False
    try:
        active_child.stdin.write(f"{len(remote_bytes)}\n".encode("ascii"))
        active_child.stdin.write(remote_bytes)
        active_child.stdin.write(
            json.dumps(
                header,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("ascii")
            + b"\n"
        )
        send_file(active_child.stdin, archive_fd, archive_info.st_size)
        send_file(active_child.stdin, sidecar_fd, sidecar_info.st_size)
    except (BrokenPipeError, OSError):
        write_failed = True
    finally:
        try:
            active_child.stdin.close()
        except (BrokenPipeError, OSError):
            write_failed = True
    remote_status = normalize_returncode(active_child.wait())
    active_child = None
    if remote_status != 0:
        primary_status = remote_status
    elif write_failed:
        fail(74, "phone deploy: local release upload failed")
    for descriptor, name, expected in (
        (archive_fd, archive_name, archive_info),
        (sidecar_fd, f"{archive_name}.sha256", sidecar_info),
    ):
        completed = os.fstat(descriptor)
        current = os.stat(
            name,
            dir_fd=local_stage_fd,
            follow_symlinks=False,
        )
        if (
            file_identity(completed) != file_identity(expected)
            or file_identity(current) != file_identity(expected)
        ):
            fail(66, "phone deploy: local release snapshot changed")
except HostSignal as error:
    primary_status = error.status
except HostFailure as error:
    primary_status = error.status
    primary_message = error.message
except BaseException:
    primary_status = 70
    primary_message = "phone deploy: deployment failed"
finally:
    if active_child is not None and active_child.poll() is None:
        try:
            active_child.terminate()
            active_child.wait(timeout=2)
        except Exception:
            try:
                active_child.kill()
                active_child.wait(timeout=2)
            except Exception:
                pass
    if forward_owned and device_selector is not None and ssh_port is not None:
        removed = subprocess.run(
            [
                "adb",
                "-s",
                device_selector,
                "forward",
                "--remove",
                f"tcp:{ssh_port}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if removed.returncode != 0:
            cleanup_failed = True
        else:
            forward_owned = False
    for descriptor in (archive_fd, sidecar_fd):
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                cleanup_failed = True
    if cleanup_local():
        cleanup_failed = True
    if local_stage_fd is not None:
        try:
            os.close(local_stage_fd)
        except OSError:
            cleanup_failed = True

if primary_message is not None:
    print(primary_message, file=sys.stderr)
if cleanup_failed:
    print("phone deploy: staging cleanup was incomplete", file=sys.stderr)
raise SystemExit(primary_status)
HOSTPY
