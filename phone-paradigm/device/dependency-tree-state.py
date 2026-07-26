#!/data/data/com.termux/files/usr/bin/python3
"""Integrity and retention operations for phone release dependency state."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import sys
import time
from typing import Any, NoReturn


LOCK_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,160}$")
BUILD_RE = re.compile(r"^[0-9a-f]{64}\.[A-Za-z0-9_-]{1,32}$")
INCOMING_RE = re.compile(r"^\.incoming-[0-9a-f]{64}\.[A-Za-z0-9_-]{1,32}$")
QUARANTINE_RE = re.compile(r"^[0-9a-f]{64}\.[0-9]{10,20}\.[0-9]+$")
INVENTORY_NAME = ".evogent-dependency-inventory.json"
INVENTORY_SHA_NAME = ".evogent-dependency-inventory.sha256"
LOCK_MARKER_NAME = ".evogent-package-lock.sha256"
INVENTORY_SCHEMA = "evogent.android-dependency-inventory.v2"


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_lock(value: str) -> str:
    if not LOCK_RE.fullmatch(value):
        fail("dependency lock identity is invalid")
    return value


def require_safe_name(value: str, label: str) -> str:
    if value in {".", ".."} or not SAFE_NAME_RE.fullmatch(value):
        fail(f"{label} is unsafe")
    return value


def require_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    if path.is_symlink() or not path.is_dir():
        fail(f"{label} is not a private directory")
    return path


def fsync_directory(path: pathlib.Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_file(path: pathlib.Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            fail("durability target is not a regular file")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def lexical_symlink_target(relative: str, target: str) -> str:
    if not target or os.path.isabs(target):
        fail(f"dependency symlink has an unsafe target: {relative}")
    normalized = os.path.normpath(os.path.join(os.path.dirname(relative), target))
    if normalized == ".." or normalized.startswith("../"):
        fail(f"dependency symlink escapes its tree: {relative}")
    return target


def build_inventory(root: pathlib.Path) -> dict[str, Any]:
    excluded = {INVENTORY_NAME, INVENTORY_SHA_NAME}
    entries: list[dict[str, str]] = []

    def visit(directory: pathlib.Path, relative_directory: pathlib.PurePosixPath) -> None:
        try:
            children = sorted(os.scandir(directory), key=lambda item: os.fsencode(item.name))
        except OSError as error:
            fail(f"cannot enumerate dependency tree: {error}")
        for child in children:
            relative_path = relative_directory / child.name
            relative = relative_path.as_posix()
            if not relative_directory.parts and child.name in excluded:
                continue
            info = child.stat(follow_symlinks=False)
            mode = info.st_mode
            path = pathlib.Path(child.path)
            if stat.S_ISLNK(mode):
                target = lexical_symlink_target(relative, os.readlink(path))
                entries.append({"path": relative, "target": target, "type": "symlink"})
            elif stat.S_ISDIR(mode):
                entries.append({"mode": "0555", "path": relative, "type": "directory"})
                visit(path, relative_path)
            elif stat.S_ISREG(mode):
                entries.append(
                    {
                        "mode": "0555" if mode & 0o111 else "0444",
                        "path": relative,
                        "sha256": sha256_file(path),
                        "type": "file",
                    }
                )
            else:
                fail(f"unsupported dependency-tree entry type: {relative}")

    visit(root, pathlib.PurePosixPath())
    return {"entries": entries, "schema": INVENTORY_SCHEMA}


def inventory_bytes(inventory: dict[str, Any]) -> bytes:
    return (
        json.dumps(inventory, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def validate_lock_files(tree: pathlib.Path, expected_lock: str) -> None:
    package_json = tree / "package.json"
    package_lock = tree / "package-lock.json"
    marker = tree / LOCK_MARKER_NAME
    for path in (package_json, package_lock, marker):
        if path.is_symlink() or not path.is_file():
            fail(f"dependency metadata is missing or unsafe: {path.name}")
    try:
        marker_value = marker.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError) as error:
        fail(f"dependency lock marker cannot be read: {error}")
    if marker_value != expected_lock:
        fail("dependency lock marker does not match")
    if sha256_file(package_lock) != expected_lock:
        fail("dependency package-lock hash does not match")
    if (tree / "node_modules").is_symlink() or not (tree / "node_modules").is_dir():
        fail("dependency node_modules directory is missing or unsafe")


def assert_read_only(tree: pathlib.Path) -> None:
    paths = [tree]
    paths.extend(pathlib.Path(root) / name for root, dirs, files in os.walk(tree) for name in dirs + files)
    for path in paths:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            continue
        if info.st_mode & 0o222:
            relative = "." if path == tree else path.relative_to(tree).as_posix()
            fail(f"published dependency entry is writable: {relative}")


def verify_tree(tree: pathlib.Path, expected_lock: str, *, require_read_only: bool = True) -> None:
    require_lock(expected_lock)
    require_directory(tree, "dependency tree")
    validate_lock_files(tree, expected_lock)
    inventory_path = tree / INVENTORY_NAME
    inventory_sha_path = tree / INVENTORY_SHA_NAME
    for path in (inventory_path, inventory_sha_path):
        if path.is_symlink() or not path.is_file():
            fail(f"dependency inventory metadata is missing or unsafe: {path.name}")
    try:
        expected_digest = inventory_sha_path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError) as error:
        fail(f"dependency inventory digest cannot be read: {error}")
    if not LOCK_RE.fullmatch(expected_digest):
        fail("dependency inventory digest is invalid")
    if sha256_file(inventory_path) != expected_digest:
        fail("dependency inventory digest does not match")
    try:
        expected_inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"dependency inventory cannot be read: {error}")
    if expected_inventory.get("schema") != INVENTORY_SCHEMA:
        fail("dependency inventory schema is invalid")
    if expected_inventory != build_inventory(tree):
        fail("dependency tree differs from its deterministic inventory")
    if require_read_only:
        assert_read_only(tree)


def make_tree_read_only(tree: pathlib.Path) -> None:
    paths: list[pathlib.Path] = []
    for root, dirs, files in os.walk(tree, topdown=False, followlinks=False):
        base = pathlib.Path(root)
        paths.extend(base / name for name in files)
        paths.extend(base / name for name in dirs)
    paths.append(tree)
    for path in paths:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            continue
        if stat.S_ISDIR(info.st_mode):
            os.chmod(path, 0o555, follow_symlinks=False)
        elif stat.S_ISREG(info.st_mode):
            executable = bool(info.st_mode & 0o111)
            os.chmod(path, 0o555 if executable else 0o444, follow_symlinks=False)
        else:
            relative = "." if path == tree else path.relative_to(tree).as_posix()
            fail(f"unsupported dependency-tree entry type: {relative}")


def seal_tree(tree: pathlib.Path, expected_lock: str) -> None:
    require_lock(expected_lock)
    require_directory(tree, "dependency build")
    validate_lock_files(tree, expected_lock)
    inventory_path = tree / INVENTORY_NAME
    inventory_sha_path = tree / INVENTORY_SHA_NAME
    if inventory_path.exists() or inventory_path.is_symlink():
        fail("dependency build already contains inventory metadata")
    if inventory_sha_path.exists() or inventory_sha_path.is_symlink():
        fail("dependency build already contains inventory digest metadata")
    encoded = inventory_bytes(build_inventory(tree))
    inventory_path.write_bytes(encoded)
    inventory_sha_path.write_text(hashlib.sha256(encoded).hexdigest() + "\n", encoding="ascii")
    os.chmod(inventory_path, 0o600)
    os.chmod(inventory_sha_path, 0o600)
    fsync_file(inventory_path)
    fsync_file(inventory_sha_path)
    fsync_directory(tree)
    make_tree_read_only(tree)
    assert_read_only(tree)


def atomic_exchange(left: pathlib.Path, right: pathlib.Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    encoded_left = os.fsencode(left)
    encoded_right = os.fsencode(right)
    restore_modes: tuple[int, int] | None = None
    if hasattr(libc, "renameat2"):
        at_fdcwd = -100
        rename_exchange = 2
        renameat2 = libc.renameat2
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(
            at_fdcwd,
            encoded_left,
            at_fdcwd,
            encoded_right,
            rename_exchange,
        )
    elif hasattr(libc, "renameatx_np"):
        # Darwin's swap API requires owner-write on the two directory roots.
        # This compatibility path is used only by host fixture tests. Android
        # renameat2 exchanges fully sealed directory inodes without chmod.
        left_mode = stat.S_IMODE(left.lstat().st_mode)
        right_mode = stat.S_IMODE(right.lstat().st_mode)
        restore_modes = (left_mode, right_mode)
        if left.is_dir() and not left.is_symlink():
            os.chmod(left, left_mode | stat.S_IWUSR)
        if right.is_dir() and not right.is_symlink():
            os.chmod(right, right_mode | stat.S_IWUSR)
        at_fdcwd = -2
        rename_swap = 0x00000002
        renameatx_np = libc.renameatx_np
        renameatx_np.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameatx_np.restype = ctypes.c_int
        result = renameatx_np(
            at_fdcwd,
            encoded_left,
            at_fdcwd,
            encoded_right,
            rename_swap,
        )
    else:
        fail("platform does not expose atomic directory exchange")
    if result != 0:
        error = ctypes.get_errno()
        if restore_modes is not None:
            left_mode, right_mode = restore_modes
            if left.is_dir() and not left.is_symlink():
                os.chmod(left, left_mode)
            if right.is_dir() and not right.is_symlink():
                os.chmod(right, right_mode)
        fail(f"atomic dependency-tree exchange failed: {os.strerror(error)}")
    if restore_modes is not None:
        left_mode, right_mode = restore_modes
        if right.is_dir() and not right.is_symlink():
            os.chmod(right, left_mode)
        if left.is_dir() and not left.is_symlink():
            os.chmod(left, right_mode)


def move_sealed_directory(source: pathlib.Path, destination: pathlib.Path) -> None:
    """Rename a sealed directory across parents without leaving it writable."""
    mode = stat.S_IMODE(source.lstat().st_mode)
    is_directory = source.is_dir() and not source.is_symlink()
    if is_directory:
        os.chmod(source, mode | stat.S_IWUSR)
    try:
        os.replace(source, destination)
    except BaseException:
        if is_directory and source.exists():
            os.chmod(source, mode)
        raise
    if is_directory:
        os.chmod(destination, mode)


def make_removable(path: pathlib.Path) -> None:
    if path.is_symlink() or not path.exists():
        return
    if path.is_file():
        os.chmod(path, 0o600, follow_symlinks=False)
        return
    for root, dirs, files in os.walk(path, topdown=False, followlinks=False):
        base = pathlib.Path(root)
        for name in files:
            child = base / name
            if not child.is_symlink():
                os.chmod(child, 0o600, follow_symlinks=False)
        for name in dirs:
            child = base / name
            if not child.is_symlink():
                os.chmod(child, 0o700, follow_symlinks=False)
        os.chmod(base, 0o700, follow_symlinks=False)


def remove_exact_child(path: pathlib.Path, parent: pathlib.Path) -> None:
    if path.parent != parent:
        fail("refusing to remove a path outside its narrow state directory")
    if not os.path.lexists(path):
        return
    if path.is_symlink() or not path.is_dir():
        path.unlink()
    else:
        make_removable(path)
        shutil.rmtree(path)
    fsync_directory(parent)


def publish_tree(
    build: pathlib.Path,
    target: pathlib.Path,
    quarantine_root: pathlib.Path,
    expected_lock: str,
) -> pathlib.Path | None:
    require_lock(expected_lock)
    require_directory(build, "dependency build")
    verify_tree(build, expected_lock)
    require_directory(build.parent, "dependency build root")
    if not BUILD_RE.fullmatch(build.name) or not build.name.startswith(expected_lock + "."):
        fail("dependency build name is unsafe")
    if target.name != expected_lock or target.parent.is_symlink():
        fail("dependency publication target is unsafe")
    require_directory(target.parent, "dependency tree root")
    require_directory(quarantine_root, "dependency quarantine root")
    if build.stat().st_dev != target.parent.stat().st_dev:
        fail("dependency build and target are not on the same filesystem")
    if not os.path.lexists(target):
        move_sealed_directory(build, target)
        fsync_directory(target.parent)
        fsync_directory(build.parent)
        return None
    try:
        verify_tree(target, expected_lock)
    except SystemExit:
        pass
    else:
        fail("dependency publication target is already valid")

    quarantine = quarantine_root / f"{expected_lock}.{time.time_ns()}.{os.getpid()}"
    if os.path.lexists(quarantine):
        fail("dependency quarantine destination already exists")
    incoming = target.parent / f".incoming-{build.name}"
    if os.path.lexists(incoming):
        fail("dependency publication staging name already exists")
    move_sealed_directory(build, incoming)
    fsync_directory(build.parent)
    fsync_directory(target.parent)
    try:
        # Android permits sealed directory exchange within one parent. Keeping
        # both names here means the current target is untouched until this one
        # atomic operation succeeds.
        atomic_exchange(incoming, target)
    except BaseException:
        if os.path.lexists(incoming) and not os.path.lexists(build):
            move_sealed_directory(incoming, build)
            fsync_directory(build.parent)
            fsync_directory(target.parent)
        raise
    fsync_directory(target.parent)
    move_sealed_directory(incoming, quarantine)
    fsync_directory(target.parent)
    fsync_directory(quarantine_root)
    return quarantine


def safe_release_target(value: str, releases: pathlib.Path) -> pathlib.Path | None:
    if not value:
        return None
    candidate = pathlib.Path(value)
    try:
        resolved_parent = candidate.parent.resolve(strict=False)
    except OSError:
        return None
    if resolved_parent != releases.resolve(strict=False):
        return None
    try:
        require_safe_name(candidate.name, "release name")
    except SystemExit:
        return None
    return candidate


def current_release(root: pathlib.Path, releases: pathlib.Path) -> pathlib.Path | None:
    current = root / "current"
    if not current.is_symlink():
        return None
    try:
        resolved = current.resolve(strict=False)
    except OSError:
        return None
    return safe_release_target(str(resolved), releases)


def prune_state(root: pathlib.Path, keep_quarantines: int) -> None:
    require_directory(root, "release root")
    releases = require_directory(root / "releases", "release directory")
    state = require_directory(root / "state", "state directory")
    dependencies = require_directory(state / "dependencies", "dependency tree root")
    builds = require_directory(state / "dependency-builds", "dependency build directory")
    quarantine = require_directory(state / "dependency-quarantine", "dependency quarantine directory")
    candidates = require_directory(state / "release-candidates", "release candidate directory")
    next_cache = state / "next-cache"
    protected: set[pathlib.Path] = set()
    current = current_release(root, releases)
    if current is not None:
        protected.add(current)
    backups = root / "backups"
    if backups.is_dir() and not backups.is_symlink():
        for marker in backups.glob("*/previous-release"):
            try:
                target = safe_release_target(marker.read_text(encoding="utf-8").strip(), releases)
            except (OSError, UnicodeError):
                target = None
            if target is not None:
                protected.add(target)

    for entry in list(builds.iterdir()):
        if BUILD_RE.fullmatch(entry.name):
            remove_exact_child(entry, builds)
    for entry in list(dependencies.iterdir()):
        if INCOMING_RE.fullmatch(entry.name):
            remove_exact_child(entry, dependencies)

    quarantined = sorted(
        (entry for entry in quarantine.iterdir() if QUARANTINE_RE.fullmatch(entry.name)),
        key=lambda path: path.lstat().st_mtime_ns,
        reverse=True,
    )
    for entry in quarantined[max(0, keep_quarantines) :]:
        remove_exact_child(entry, quarantine)

    transaction_journal = root / "install-transaction" / "journal.json"
    if not transaction_journal.exists() and not transaction_journal.is_symlink():
        for marker in list(candidates.iterdir()):
            if not SAFE_NAME_RE.fullmatch(marker.name):
                continue
            release = releases / marker.name
            if release not in protected:
                remove_exact_child(release, releases)
                if next_cache.is_dir() and not next_cache.is_symlink():
                    remove_exact_child(next_cache / marker.name, next_cache)
            marker.unlink()
            fsync_directory(candidates)

    legacy = state / "node_modules"
    if current is not None and os.path.lexists(legacy):
        manifest = current / "manifest.json"
        try:
            dependency_link = json.loads(manifest.read_text(encoding="utf-8"))["stateLinks"][
                "runtime/node_modules"
            ]
        except (KeyError, OSError, TypeError, UnicodeError, json.JSONDecodeError):
            dependency_link = ""
        if isinstance(dependency_link, str) and dependency_link.startswith(
            "../../../state/dependencies/"
        ):
            remove_exact_child(legacy, state)


def candidate_add(root: pathlib.Path, release_id: str) -> None:
    require_safe_name(release_id, "release candidate id")
    candidates = require_directory(root / "state" / "release-candidates", "release candidate directory")
    marker = candidates / release_id
    descriptor = os.open(
        marker,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    try:
        os.write(descriptor, (release_id + "\n").encode("ascii"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(candidates)


def candidate_clear(root: pathlib.Path, release_id: str) -> None:
    require_safe_name(release_id, "release candidate id")
    candidates = require_directory(root / "state" / "release-candidates", "release candidate directory")
    marker = candidates / release_id
    if os.path.lexists(marker):
        if marker.is_dir() and not marker.is_symlink():
            fail("release candidate marker is not a regular file")
        marker.unlink()
        fsync_directory(candidates)


def reclaim_legacy(root: pathlib.Path) -> None:
    state = require_directory(root / "state", "state directory")
    remove_exact_child(state / "node_modules", state)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command in ("seal", "verify"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("tree", type=pathlib.Path)
        command_parser.add_argument("lock")

    publish = subparsers.add_parser("publish")
    publish.add_argument("build", type=pathlib.Path)
    publish.add_argument("target", type=pathlib.Path)
    publish.add_argument("quarantine", type=pathlib.Path)
    publish.add_argument("lock")

    prune = subparsers.add_parser("prune")
    prune.add_argument("root", type=pathlib.Path)
    prune.add_argument("--keep-quarantines", type=int, default=1)

    for command in ("candidate-add", "candidate-clear"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("root", type=pathlib.Path)
        command_parser.add_argument("release_id")

    reclaim = subparsers.add_parser("reclaim-legacy")
    reclaim.add_argument("root", type=pathlib.Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "seal":
        seal_tree(args.tree, args.lock)
    elif args.command == "verify":
        verify_tree(args.tree, args.lock)
    elif args.command == "publish":
        publish_tree(args.build, args.target, args.quarantine, args.lock)
    elif args.command == "prune":
        if args.keep_quarantines < 0:
            fail("quarantine retention cannot be negative")
        prune_state(args.root, args.keep_quarantines)
    elif args.command == "candidate-add":
        candidate_add(args.root, args.release_id)
    elif args.command == "candidate-clear":
        candidate_clear(args.root, args.release_id)
    elif args.command == "reclaim-legacy":
        reclaim_legacy(args.root)
    else:
        fail("unsupported dependency state command")


if __name__ == "__main__":
    main()
