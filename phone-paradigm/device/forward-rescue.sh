#!/bin/sh
''':'
exec python3 "$0" "$@"
':'''
"""One-way recovery for the one retained failed Pixel initial migration.

The file is copied byte-for-byte to install-transaction/install-release.sh.
Its polyglot prelude works when invoked by Bash, Python, or its shebang.
"""
import hashlib
import json
import ctypes
import errno
import os
import pathlib
import posixpath
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import ssl
import stat
import subprocess
import sys
import time
import zipfile

P = pathlib.Path
SCHEMA = "evogent.phone.forward-rescue.v1"
OLD_SCHEMA = "evogent.phone.install-transaction.v3"
OLD_PLAN = "evogent.phone.legacy-rollback-plan.v1"
PACKAGE = "net.dangish.evogent"
ANDROID_SHELL_UID = 2000
ROLES = ("android.app.role.HOME", "android.app.role.ASSISTANT")
APP_TOKEN = f"/sdcard/Android/data/{PACKAGE}/files/control-token.txt"
PHASES = ("forward_decided", "migration_pending", "prepare_pending", "switch_pending",
          "runtime_pending", "health_pending", "committed")
HOME_NAMES = ("start-prod-sub.sh", "start-prod.sh", "restart-evo.sh",
              "deploy-next.sh", "install-evogent-release.sh")
HEX = re.compile(r"[0-9a-f]{64}")
SAFE = re.compile(r"[A-Za-z0-9._-]{1,160}")
PKG_OP = re.compile(r"/data/local/tmp/evogent-package-op\.[0-9a-f]{32}")
CONTROL_ARTIFACT = re.compile(
    r"(?:\.control|\.watchdog\.lock|\.scheduler\.lock|\.curation-control|"
    r"\.automatic-diagnosis-budget\.json|\.last-[A-Za-z0-9._-]+|"
    r"\.yield-[A-Za-z0-9._-]+|\.barren-[A-Za-z0-9._-]+|"
    r"\.failure-[A-Za-z0-9._-]+|\.interest-browse-output\.[0-9]+|"
    r"\.app-research-output\.[0-9]+|\.overseer-output\.[A-Za-z0-9._-]+|"
    r"\.xbrowse-inflight|\.shizuku-down|\.diskfull-warned|"
    r"\.cycle-overdue-signalled|\.no-success-cycle-baseline|\.overseer-stamp|"
    r"scheduler\.log|browse-benchmark-results\.txt|cu-micro-results\.txt|"
    r"last-cycle-newitems|model-benchmark-results\.jsonl)")
OLD_ONES = ("apkChanged", "apkInstallAttempted", "apkBackupReady",
            "dbBackupReady", "dbExisted", "initialMigration",
            "legacyRuntimeExpected", "legacyControlPlaneExpected",
            "legacySnapshotReady", "migrationStarted", "switchStarted",
            "controlTokenExisted", "controlTokenBackupReady",
            "androidRoleBackupReady", "androidRoleRestoreRequired",
            "androidRoleMutationAttempted", "androidRolesApplied")


class Error(Exception):
    pass


def need(value, message):
    if not value:
        raise Error(message)
    return value


def pairs(values):
    result = {}
    for key, value in values:
        need(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def slurp(path, limit=16 * 1024 * 1024, mode=None):
    path = P(path)
    need(hasattr(os, "O_NOFOLLOW"), "platform lacks O_NOFOLLOW")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
    except OSError as exc:
        raise Error(f"unsafe or missing file {path.name}: {exc}") from exc
    try:
        before, named = os.fstat(fd), os.lstat(path)
        need(stat.S_ISREG(before.st_mode) and os.path.samestat(before, named),
             f"unsafe regular file: {path.name}")
        need(before.st_uid == os.geteuid() and before.st_nlink == 1
             and 0 <= before.st_size <= limit, f"unsafe regular file: {path.name}")
        need(mode is None or stat.S_IMODE(before.st_mode) == mode,
             f"wrong private mode: {path.name}")
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(1024 * 1024, limit + 1))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_nlink,
                              s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        need(len(data) == before.st_size and identity(before) == identity(after)
             and identity(before) == identity(os.lstat(path)),
             f"file changed while read: {path.name}")
        return bytes(data)
    finally:
        os.close(fd)


def shell_slurp(path, limit, binding):
    """Read one Android-shell publication without trusting its pathname alone."""
    path = P(path)
    need(hasattr(os, "O_NOFOLLOW"), "platform lacks O_NOFOLLOW")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
    except OSError as exc:
        raise Error(f"unsafe or missing shell capture: {exc}") from exc
    try:
        before, named = os.fstat(fd), os.lstat(path)
        bound = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_nlink)
        stable = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
                                value.st_nlink, value.st_size, value.st_mtime_ns,
                                value.st_ctime_ns)
        need(stat.S_ISREG(before.st_mode) and os.path.samestat(before, named)
             and bound(before) == binding and before.st_uid == ANDROID_SHELL_UID
             and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o644
             and 0 <= before.st_size <= limit, "unsafe Android-shell publication")
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(1024 * 1024, limit + 1))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        need(len(data) == before.st_size and stable(before) == stable(after)
             and stable(before) == stable(os.lstat(path)),
             "Android-shell publication changed while read")
        return bytes(data)
    finally:
        os.close(fd)


def jread(path, mode=None):
    try:
        value = json.loads(slurp(path, mode=mode), object_pairs_hook=pairs)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise Error(f"invalid JSON: {exc}") from exc
    need(isinstance(value, dict), "JSON root is not an object")
    return value


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else slurp(value, 1 << 32)).hexdigest()


def real_dir(path, label="directory"):
    path = P(path)
    try:
        info = os.lstat(path)
    except FileNotFoundError as exc:
        raise Error(f"{label} is missing") from exc
    need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
         and info.st_uid == os.geteuid(), f"{label} is unsafe")
    return path


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                 | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def put(path, data, mode, replace=False, critical=False):
    path = P(path)
    temp = path.with_name(f".{path.name}.new.{secrets.token_hex(10)}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                 | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            need(written > 0, "short private write")
            view = view[written:]
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    if os.path.lexists(path) and not replace:
        temp.unlink()
        need(slurp(path, len(data), mode) == data, f"private file changed: {path.name}")
        # The prior process may have died after publishing the equal target but
        # before making its directory entry durable. Replay the parent barrier
        # before allowing the caller to advance durable intent.
        sync_dir(path.parent)
        return
    os.replace(temp, path)
    try:
        if critical and os.environ.get("EVOGENT_FORWARD_TEST_FAIL_DIR_FSYNC") == "1":
            raise OSError("injected directory fsync failure")
        sync_dir(path.parent)
    except BaseException:
        if critical:
            os._exit(76)
        raise


def jput(path, value, replace=False, critical=False):
    put(path, encode(value), 0o600, replace, critical)


def copy(source, target, mode, replace=False):
    data = slurp(source)
    put(target, data, mode, replace)
    return digest(data)


def child(path, parent, label):
    path, parent = P(path), P(parent)
    need(path.parent == parent and SAFE.fullmatch(path.name), f"unsafe {label} path")
    return path


class Ctx:
    def __init__(self, root):
        self.home = P(os.environ["HOME"])
        self.root = P(root)
        need(self.root == self.home / ".local/share/evogent",
             "alternate release roots are not reboot-safe")
        self.releases, self.state = self.root / "releases", self.root / "state"
        self.tx = self.root / "install-transaction"
        self.journal, self.recoverer = self.tx / "journal.json", self.tx / "install-release.sh"
        self.old_recoverer = self.tx / "source-install-release.sh"
        self.install_lock = self.root / "install.lock"
        self.control_lock = self.root / "control-plane-mutation.lock"
        for path in (self.home, self.root, self.releases, self.state, self.tx):
            real_dir(path)


def command(args, *, data=None, env=None, cwd=None, timeout=120, check=True,
            new_session=False):
    try:
        return subprocess.run(args, input=data, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, cwd=cwd,
                              timeout=timeout, check=check,
                              start_new_session=new_session)
    except (OSError, subprocess.SubprocessError) as exc:
        raise Error(f"bounded command failed: {P(args[0]).name}: {exc}") from exc


def release_inventory(path, manifest, inventory_bytes, links_bytes):
    try:
        links = json.loads(links_bytes, object_pairs_hook=pairs)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise Error(f"invalid release link inventory: {exc}") from exc
    need(isinstance(links, dict), "release link inventory is not an object")
    state_links = manifest.get("stateLinks")
    need(isinstance(state_links, dict), "release state-link inventory is invalid")
    expected_files = {}
    try:
        lines = inventory_bytes.decode("utf-8").splitlines()
    except UnicodeError as exc:
        raise Error("release file inventory is not UTF-8") from exc
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        need(match is not None, "malformed release file inventory")
        relative = pathlib.PurePosixPath(match.group(2))
        need(not relative.is_absolute() and relative.parts
             and all(part not in {"", ".", ".."} for part in relative.parts),
             "unsafe release inventory path")
        name = relative.as_posix()
        need(name not in expected_files and name not in links and name not in state_links,
             "duplicate release inventory path")
        expected_files[name] = match.group(1)
    expected_links = {}
    for source in (links, state_links):
        for name, target in source.items():
            relative = pathlib.PurePosixPath(name)
            need(isinstance(name, str) and isinstance(target, str)
                 and not relative.is_absolute() and relative.parts
                 and all(part not in {"", ".", ".."} for part in relative.parts)
                 and name not in expected_links and name not in expected_files,
                 "unsafe or duplicate release link")
            if source is links:
                resolved = posixpath.normpath(
                    posixpath.join(relative.parent.as_posix(), target))
                need(not os.path.isabs(target)
                     and resolved != ".." and not resolved.startswith("../"),
                     "release link escapes its tree")
            expected_links[name] = target
    specials = {"manifest.json", "files.sha256", "links.json"}
    allowed_directories = set()
    for name in {*expected_files, *expected_links, *specials}:
        parent = pathlib.PurePosixPath(name).parent
        while parent.parts:
            allowed_directories.add(parent.as_posix())
            parent = parent.parent
    seen_files, seen_links, seen_directories = set(), set(), set()
    for item in path.rglob("*"):
        name = item.relative_to(path).as_posix()
        info = os.lstat(item)
        if stat.S_ISLNK(info.st_mode):
            need(name in expected_links and os.readlink(item) == expected_links[name],
                 "release symlink inventory changed")
            seen_links.add(name)
        elif stat.S_ISREG(info.st_mode):
            need(name in expected_files or name in specials,
                 "unbound regular file in release")
            if name in expected_files:
                need(digest(item) == expected_files[name], "release file inventory changed")
                seen_files.add(name)
        elif stat.S_ISDIR(info.st_mode):
            need(name in allowed_directories, "unbound directory in release")
            seen_directories.add(name)
        else:
            raise Error("unsupported release entry")
    need(seen_files == set(expected_files) and seen_links == set(expected_links)
         and allowed_directories <= seen_directories, "release tree is incomplete")


def release(ctx, path):
    path = child(path, ctx.releases, "release")
    real_dir(path, "release")
    manifest = jread(path / "manifest.json")
    android, tls, dependencies = (manifest.get("android"), manifest.get("phoneTls"),
                                  manifest.get("dependencies"))
    need(manifest.get("schema") == "evogent.phone.release.v1"
         and manifest.get("releaseFormat") == 1 and manifest.get("releaseId") == path.name,
         "invalid release manifest")
    need(isinstance(android, dict) and android.get("package") == PACKAGE
         and type(android.get("versionCode")) is int
         and HEX.fullmatch(str(android.get("signerSha256", "")))
         and HEX.fullmatch(str(android.get("sha256", ""))), "invalid release APK identity")
    need(isinstance(tls, dict) and tls.get("host") == "127.0.0.1"
         and tls.get("port") == 3443
         and HEX.fullmatch(str(tls.get("certificateDerSha256", ""))),
         "invalid release TLS identity")
    need(isinstance(dependencies, dict)
         and HEX.fullmatch(str(dependencies.get("packageLockSha256", ""))),
         "invalid release dependency identity")
    need(digest(path / "apk/evogent.apk") == android["sha256"], "release APK changed")
    inventory_contract = manifest.get("inventory")
    need(isinstance(inventory_contract, dict), "invalid release inventory contract")
    inventory = slurp(path / "files.sha256", 128 << 20)
    links = slurp(path / "links.json", 128 << 20)
    need(digest(inventory) == inventory_contract.get("sha256")
         and digest(links) == inventory_contract.get("linksSha256"),
         "release inventory identity changed")
    release_inventory(path, manifest, inventory, links)
    for item in ("tls/server-cert.pem", "tls/server-key.pem"):
        slurp(path / item)
    return manifest


def paths(ctx):
    runtime = ctx.home / "evogent"
    result = {"runtime": runtime, "data": runtime / "data",
              "nodeModules": runtime / "node_modules",
              "environment": runtime / ".env.local",
              "phoneTools": ctx.home / "phone-tools"}
    result.update({f"home:{name}": ctx.home / name for name in HOME_NAMES})
    return result


def capture(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return {"type": "absent"}
    value = {"dev": info.st_dev, "ino": info.st_ino, "mode": stat.S_IMODE(info.st_mode),
             "nlink": info.st_nlink, "uid": info.st_uid}
    if stat.S_ISDIR(info.st_mode):
        value["type"] = "directory"
    elif stat.S_ISREG(info.st_mode):
        value.update(type="regular", size=info.st_size, sha256=digest(path))
    elif stat.S_ISLNK(info.st_mode):
        value.update(type="symlink", target=os.readlink(path))
    else:
        raise Error("unsupported production entry")
    return value


def same(path, expected, nlink=None, core=False):
    actual = capture(path)
    if expected.get("type") == "absent":
        return actual["type"] == "absent"
    if any(actual.get(key) != expected.get(key)
           for key in ("type", "dev", "ino", "mode", "uid")):
        return False
    if core:
        return True
    if nlink is not None and actual.get("nlink") != nlink:
        return False
    if expected["type"] == "regular":
        return (actual.get("size"), actual.get("sha256")) == (
            expected.get("size"), expected.get("sha256"))
    if expected["type"] == "symlink":
        return actual.get("target") == expected.get("target")
    return True


def old_state(ctx, incoming):
    old = jread(ctx.journal, 0o600)
    operation = old.get("packageOperation", "")
    need(old.get("schema") == OLD_SCHEMA and old.get("phase") == "health_pending"
         and old.get("root") == str(ctx.root) and old.get("previousTarget") == ""
         and old.get("previousApkCode") == "0" and old.get("controlTokenBridge", "") == ""
         and all(old.get(key) == 1 for key in OLD_ONES)
         and isinstance(operation, str) and PKG_OP.fullmatch(operation)
         and not os.path.lexists(ctx.root / "current"),
         "retained transaction is not the exact admitted v3 shape")
    old_release = child(old.get("newRelease", ""), ctx.releases, "source release")
    first, second = release(ctx, old_release), release(ctx, incoming)
    need(first["android"] == second["android"] and first["phoneTls"] == second["phoneTls"],
         "successor changes retained native identity")
    for name in ("apk/evogent.apk", "tls/server-cert.pem", "tls/server-key.pem"):
        need(digest(old_release / name) == digest(incoming / name),
             "successor changes retained APK/TLS bytes")
    migration = child(old.get("migrationDir", ""), ctx.root / "migrations", "migration")
    plan_path = migration / "rollback-plan.json"
    need(digest(plan_path) == old.get("legacyPlanSha256"), "rollback plan changed")
    plan = jread(plan_path, 0o600)
    expected_paths = paths(ctx)
    need(plan.get("schema") == OLD_PLAN and plan.get("snapshotReady") == 1
         and plan.get("root") == str(ctx.root) and plan.get("home") == str(ctx.home)
         and plan.get("state") == str(ctx.state)
         and plan.get("phoneState") == str(ctx.state / "phone-tools")
         and plan.get("releaseId") == old.get("releaseId")
         and plan.get("migrationDir") == str(migration)
         and plan.get("legacyRuntimeExpected") == 1
         and plan.get("legacyControlPlaneExpected") == 1
         and isinstance(plan.get("entries"), dict)
         and set(plan["entries"]) == set(expected_paths), "invalid rollback plan")
    entries = plan["entries"]
    need(entries["runtime"].get("type") == entries["data"].get("type")
         == entries["phoneTools"].get("type") == "directory", "unexpected legacy topology")
    need(entries["environment"].get("type") in {"regular", "absent"}
         and entries["nodeModules"].get("type") in {"directory", "absent"},
         "unexpected legacy topology")
    for key, path in expected_paths.items():
        need(same(path, entries[key]), f"restored legacy entry changed: {key}")
    for target in (ctx.state / "data", ctx.state / "node_modules",
                   ctx.state / "config", ctx.state / "phone-tools",
                   ctx.state / "next-cache" / incoming.name):
        need(not os.path.lexists(target), "versioned state appeared before decision")
    role = P(old.get("androidRoleBackup", ""))
    need(role == P(old.get("backupDir", "")) / "android-role-holders.json"
         and digest(role) == old.get("androidRoleBackupSha256")
         and jread(role, 0o600).get("userId") == old.get("androidRoleUserId"),
         "Android role proof changed")
    return old, plan, plan_path, role, second


def rish(script, timeout=30):
    executable = shutil.which("rish") or str(P.home() / "rish-bin/rish")
    env = os.environ.copy()
    env["RISH_APPLICATION_ID"] = "com.termux"
    command([executable, "-c", script], env=env, timeout=timeout)


def android(script, purpose, limit=4096, timeout=30):
    need(SAFE.fullmatch(purpose) and 0 < limit <= 16 << 20, "unsafe shell capture")
    operation = f"/data/local/tmp/evogent-forward-{purpose}.{secrets.token_hex(16)}"
    payload, header = f"{operation}/payload", b"EVOGENT_FORWARD_CAPTURE_V1\n"
    try:
        rish(f"mkdir -m 0700 '{operation}' && : > '{payload}' "
             f"&& chmod 0600 '{payload}' && chmod 0711 '{operation}'")
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not P(payload).is_file():
            time.sleep(.1)
        operation_info, payload_info = os.lstat(operation), os.lstat(payload)
        need(stat.S_ISDIR(operation_info.st_mode)
             and stat.S_IMODE(operation_info.st_mode) == 0o711
             and operation_info.st_uid == ANDROID_SHELL_UID
             and stat.S_ISREG(payload_info.st_mode)
             and stat.S_IMODE(payload_info.st_mode) == 0o600
             and payload_info.st_uid == ANDROID_SHELL_UID
             and payload_info.st_nlink == 1, "capture did not appear safely")
        payload_identity = (payload_info.st_dev, payload_info.st_ino,
                            payload_info.st_uid, payload_info.st_nlink)
        temp = f"{payload}.query"
        wrapped = (f"rm -f '{temp}'; umask 077; if ({script}) > '{temp}' 2>/dev/null "
                   f"&& [ -f '{temp}' ] && [ ! -L '{temp}' ] "
                   f"&& [ \"$(wc -c < '{temp}')\" -le '{limit}' ]; then "
                   f"{{ printf 'EVOGENT_FORWARD_CAPTURE_V1\\n'; cat '{temp}'; }} "
                   f"> '{payload}' && rm -f '{temp}' && chmod 0644 '{payload}'; "
                   f"else rm -f '{temp}'; exit 65; fi")
        rish(wrapped, timeout)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if stat.S_IMODE(os.lstat(payload).st_mode) == 0o644:
                    result = shell_slurp(payload, len(header) + limit, payload_identity)
                    need(result.startswith(header), "capture header changed")
                    return result[len(header):]
            except FileNotFoundError:
                pass
            time.sleep(.1)
        raise Error("Android-shell capture did not publish")
    finally:
        try:
            rish(f"rm -rf '{operation}'")
        except Error:
            pass
        deadline = time.monotonic() + 10
        while os.path.lexists(operation) and time.monotonic() < deadline:
            time.sleep(.1)
        need(not os.path.lexists(operation), "capture capability was not removed")


def logical_db(path):
    need(P(path).is_file() and not P(path).is_symlink(), "unsafe live database")
    value = hashlib.sha256()
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        need(db.execute("PRAGMA quick_check").fetchall() == [("ok",)], "database check failed")
        for line in db.iterdump():
            value.update(line.encode() + b"\n")
        return value.hexdigest()
    except sqlite3.Error as exc:
        raise Error(f"database proof failed: {exc}") from exc
    finally:
        if "db" in locals():
            db.close()


def tagged():
    result = []
    for item in P("/proc").glob("[0-9]*/environ"):
        try:
            pid = int(item.parent.name)
            if pid == os.getpid():
                continue
            values = item.read_bytes().split(b"\0")
        except OSError:
            continue
        if any(value.startswith(b"EVOGENT_TASK_OWNER=") for value in values):
            result.append(pid)
    return result


def control_processes(ctx):
    result = {}
    names = {"evogent-boot.sh", "evogent-scheduler.sh", "evogent-watchdog.sh"}
    for proc in P("/proc").glob("[0-9]*"):
        try:
            pid = int(proc.name)
            argv = [os.fsdecode(value) for value in
                    (proc / "cmdline").read_bytes().split(b"\0") if value]
            if len(argv) != 2 or P(argv[0]).name not in {"bash", "sh"}:
                continue
            script = P(argv[1])
            if script.name not in names or not script.is_absolute():
                continue
            resolved = script.resolve(strict=True)
            legacy = resolved.parent in {
                ctx.home / "phone-tools", ctx.state / "phone-tools"}
            versioned = (resolved.parent.name == "phone-tools"
                         and resolved.parent.parent.parent == ctx.releases)
            if legacy or versioned:
                start_value = proc_start(pid)
                if start_value:
                    result[pid] = start_value
        except (FileNotFoundError, OSError, PermissionError, ValueError):
            continue
    for tools in (ctx.home / "phone-tools", ctx.state / "phone-tools"):
        owners = tools / ".control/owners"
        if not owners.is_dir() or owners.is_symlink():
            continue
        for directory in owners.iterdir():
            try:
                info = os.lstat(directory)
                need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                     and info.st_uid == os.geteuid(), "unsafe control owner")
                text = slurp(directory / "owner", 4096, 0o600).decode("ascii")
                fields = pairs(line.split("=", 1) for line in text.splitlines())
                pid, start_value = fields.get("pid", ""), fields.get("start", "")
                need(fields.get("owner") == directory.name and pid.isdigit()
                     and start_value.isdigit(), "invalid control owner")
                number = int(pid)
                if proc_start(number) == start_value:
                    result[number] = start_value
            except FileNotFoundError:
                continue
    result.pop(os.getpid(), None)
    return result


def stopped(ctx):
    for name in ("evo", "evo-sched"):
        need(command(["tmux", "has-session", "-t", name], check=False,
                     timeout=5).returncode != 0, "legacy tmux session is live")
    runtime = ctx.home / "evogent"
    for proc in P("/proc").glob("[0-9]*"):
        try:
            argv = [os.fsdecode(x) for x in (proc / "cmdline").read_bytes().split(b"\0") if x]
            need(not (len(argv) == 2 and P(argv[0]).name == "node" and argv[1] == "server.js"
                      and os.path.samefile(proc / "cwd", runtime)), "legacy server is live")
        except (FileNotFoundError, PermissionError):
            pass
    need(not control_processes(ctx), "phone control process is live")
    need(not [pid for pid in tagged() if pid != os.getpid()],
         "tagged control worker is live")
    for _ in range(3):
        for port in (3001, 3443):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    raise Error("phone listener is live")
            except OSError:
                pass
        time.sleep(1)


def roles(role_path, role_sha, user):
    snapshot = jread(role_path, 0o600)
    need(digest(role_path) == role_sha
         and snapshot.get("schema") == "evogent.phone.android-role-holders.v1"
         and snapshot.get("userId") == user and set(snapshot.get("holders", {})) == set(ROLES),
         "invalid Android role snapshot")
    need(android("am get-current-user", "current-user", 64).strip()
         == str(user).encode(), "foreground Android user changed")
    for role in ROLES:
        observed = android(f"cmd role get-role-holders --user '{user}' '{role}'",
                           "role-holders", 4096).decode("ascii").splitlines()
        need(observed == snapshot["holders"][role], "Android role holders changed")


def evidence(ctx, old, plan, role_path, manifest):
    idle = android("cmd package wait-for-handler --timeout 120000 "
                   "&& cmd package wait-for-background-handler --timeout 120000 "
                   "&& printf 'idle\\n'", "package-idle", 64, 300)
    need(idle == b"idle\n", "package manager is not idle")
    op = old["packageOperation"]
    need(android(f"[ ! -e '{op}' ] && [ ! -L '{op}' ] && printf 'absent\\n'",
                 "package-absence", 64) == b"absent\n", "package operation remains")
    apk = android(f"p=$(pm path '{PACKAGE}' | sed -n 's/^package://p' | head -1); "
                  f"c=$(dumpsys package '{PACKAGE}' | sed -n "
                  f"'s/.*versionCode=\\([0-9]*\\).*/\\1/p' | head -1); "
                  f"[ -n \"$p\" ] && [ -n \"$c\" ] && printf '%s\\n' \"$c\" "
                  f"&& sha256sum \"$p\" | awk '{{print $1}}'",
                  "installed-apk", 256).decode().splitlines()
    need(apk == [str(manifest["android"]["versionCode"]), manifest["android"]["sha256"]],
         "installed APK changed")
    rollback = android("dumpsys rollback", "rollback-dump", 4 << 20)
    command([sys.executable, str(P(old["newRelease"]) / "device/rollback-state.py"),
             "require-consumed", PACKAGE, str(manifest["android"]["versionCode"]),
             old["previousApkCode"]], data=rollback)
    roles(role_path, old["androidRoleBackupSha256"], old["androidRoleUserId"])
    token = android(f"cat '{APP_TOKEN}'", "control-token", 4096)
    live = slurp(ctx.home / "evogent/data/control-token.txt", 4096, 0o600)
    need(token == live, "APK and live control tokens differ")
    stopped(ctx)
    nlinks = {key: capture(path)["nlink"] for key, path in paths(ctx).items()
              if plan["entries"][key]["type"] != "absent"}
    return {"databaseLogicalSha256": logical_db(ctx.home / "evogent/data/media-agent.db"),
            "controlTokenSha256": digest(live), "nlinks": nlinks}


def migrated_topology(ctx, journal):
    plan, workspace = jread(journal["sourcePlan"], 0o600), P(journal["workspace"])
    entries = plan["entries"]
    need(not os.path.lexists(ctx.root / "current")
         and not os.path.lexists(ctx.home / "evogent")
         and not os.path.lexists(ctx.home / "phone-tools"),
         "pre-switch forward topology exposed a release")
    need(same(workspace / "runtime", entries["runtime"], core=True)
         and same(ctx.state / "data", entries["data"], core=True)
         and same(ctx.state / "phone-tools", entries["phoneTools"], core=True),
         "pre-switch migrated authority changed")
    expected_environment = entries["environment"]
    need(same(ctx.state / "config/.env.local", expected_environment)
         if expected_environment["type"] != "absent"
         else not os.path.lexists(ctx.state / "config/.env.local"),
         "pre-switch environment changed")
    for name in HOME_NAMES:
        expected = entries[f"home:{name}"]
        need(same(workspace / "home" / name, expected)
             if expected["type"] != "absent"
             else not os.path.lexists(workspace / "home" / name),
             "pre-switch HOME forensic entry changed")
    real_dir(ctx.state / "next-cache" / journal["releaseId"],
             "pre-switch Next cache")
    real_dir(ctx.state / "phone-tools/.cycle.lock", "held cycle gate")


def chain_state(ctx, incoming):
    prior = load_forward(ctx)
    need(prior["chainDepth"] == 0
         and prior["phase"] in {"prepare_pending", "health_pending"},
         "only one exact failed forward successor may be chained")
    previous = P(prior["newRelease"])
    previous_manifest, manifest = release(ctx, previous), release(ctx, incoming)
    need(previous != incoming
         and previous_manifest["android"] == manifest["android"]
         and previous_manifest["phoneTls"] == manifest["phoneTls"],
         "chained successor changes native identity")
    for name in ("apk/evogent.apk", "tls/server-cert.pem", "tls/server-key.pem"):
        need(digest(previous / name) == digest(incoming / name),
             "chained successor changes native bytes")
    if prior["phase"] == "health_pending":
        topology(ctx, prior)
    else:
        migrated_topology(ctx, prior)
    origin_plan = jread(prior["sourcePlan"], 0o600)
    need(same(ctx.state / "data", origin_plan["entries"]["data"], core=True),
         "chained data authority inode changed")
    quiesce(ctx)
    idle = android("cmd package wait-for-handler --timeout 120000 "
                   "&& cmd package wait-for-background-handler --timeout 120000 "
                   "&& printf 'idle\\n'", "package-idle", 64, 300)
    need(idle == b"idle\n", "package manager is not idle")
    operation = prior["sourcePackageOperation"]
    need(android(f"[ ! -e '{operation}' ] && [ ! -L '{operation}' ] "
                 "&& printf 'absent\\n'", "package-absence", 64) == b"absent\n",
         "source package operation reappeared")
    apk = android(f"p=$(pm path '{PACKAGE}' | sed -n 's/^package://p' | head -1); "
                  f"c=$(dumpsys package '{PACKAGE}' | sed -n "
                  f"'s/.*versionCode=\\([0-9]*\\).*/\\1/p' | head -1); "
                  f"[ -n \"$p\" ] && [ -n \"$c\" ] && printf '%s\\n' \"$c\" "
                  f"&& sha256sum \"$p\" | awk '{{print $1}}'",
                  "installed-apk", 256).decode().splitlines()
    need(apk == [str(manifest["android"]["versionCode"]), manifest["android"]["sha256"]],
         "installed native identity changed")
    role = jread(prior["sourceRole"], 0o600)
    roles(prior["sourceRole"], prior["sourceRoleSha256"], role["userId"])
    token = slurp(ctx.state / "data/control-token.txt", 4096, 0o600)
    app_token = android(f"cat '{APP_TOKEN}'", "control-token", 4096)
    need(token == app_token and digest(token) == prior["controlTokenSha256"],
         "control token changed before chained decision")
    database = logical_db(ctx.state / "data/media-agent.db")
    stopped(ctx)
    return prior, manifest, {"databaseLogicalSha256": database,
                             "controlTokenSha256": digest(token)}


def forward_journal(ctx, old, plan_path, role_path, incoming, manifest, proof, workspace):
    return {"schema": SCHEMA, "forwardDecision": 1, "chainDepth": 0,
            "phase": "forward_decided",
            "root": str(ctx.root), "home": str(ctx.home), "releaseId": incoming.name,
            "newRelease": str(incoming), "workspace": str(workspace),
            "selfSha256": digest(__file__),
            "manifestSha256": digest(incoming / "manifest.json"),
            "sourceJournal": str(workspace / "source-journal.json"),
            "sourceJournalSha256": digest(ctx.journal),
            "sourceRecoverer": str(workspace / "source-install-release.sh"),
            "sourceRecovererSha256": digest(workspace / "source-install-release.sh"),
            "sourcePlan": str(workspace / "source-rollback-plan.json"),
            "sourcePlanSha256": digest(plan_path),
            "sourceRole": str(workspace / "source-android-role-holders.json"),
            "sourceRoleSha256": digest(role_path),
            "sourcePackageOperation": old["packageOperation"],
            "sourcePreviousApkCode": old["previousApkCode"],
            "android": manifest["android"], "phoneTls": manifest["phoneTls"],
            "dependencies": manifest["dependencies"], **proof}


def chained_journal(ctx, prior, incoming, manifest, proof, workspace):
    payload = dict(prior)
    payload.update({
        "chainDepth": 1,
        "phase": "prepare_pending",
        "releaseId": incoming.name,
        "newRelease": str(incoming),
        "workspace": str(workspace),
        "originWorkspace": prior["workspace"],
        "manifestSha256": digest(incoming / "manifest.json"),
        "previousPhase": prior["phase"],
        "previousReleaseId": prior["releaseId"],
        "previousRelease": prior["newRelease"],
        "previousManifestSha256": prior["manifestSha256"],
        "previousJournalSha256": digest(ctx.journal),
        "previousRecovererSha256": digest(ctx.recoverer),
        "android": manifest["android"],
        "phoneTls": manifest["phoneTls"],
        "dependencies": manifest["dependencies"],
        **proof,
    })
    return payload


def load_forward(ctx, journal=None):
    journal = P(journal or ctx.journal)
    data = jread(journal, 0o600)
    incoming, workspace, depth = (P(data.get("newRelease", "")),
                                  P(data.get("workspace", "")),
                                  data.get("chainDepth"))
    need(data.get("schema") == SCHEMA and data.get("forwardDecision") == 1
         and type(depth) is int and depth in {0, 1}
         and data.get("phase") in PHASES and data.get("root") == str(ctx.root)
         and data.get("home") == str(ctx.home) and journal == ctx.journal
         and incoming == ctx.releases / data.get("releaseId", "")
         and workspace.parent == ctx.root / "migrations" and SAFE.fullmatch(workspace.name)
         and HEX.fullmatch(str(data.get("selfSha256", "")))
         and digest(__file__) == data["selfSha256"], "invalid forward journal")
    real_dir(workspace, "forward workspace")
    manifest = release(ctx, incoming)
    need(digest(incoming / "manifest.json") == data.get("manifestSha256")
         and manifest["android"] == data.get("android")
         and manifest["phoneTls"] == data.get("phoneTls")
         and manifest["dependencies"] == data.get("dependencies"),
         "forward release changed")
    source_base = workspace
    if depth == 1:
        source_base = P(data.get("originWorkspace", ""))
        need(source_base.parent == ctx.root / "migrations"
             and SAFE.fullmatch(source_base.name) and source_base != workspace,
             "invalid origin workspace")
        real_dir(source_base, "origin workspace")
        previous = child(data.get("previousRelease", ""), ctx.releases,
                         "previous forward release")
        previous_manifest = release(ctx, previous)
        need(data.get("previousReleaseId") == previous.name
             and digest(previous / "manifest.json") == data.get("previousManifestSha256")
             and previous_manifest["android"] == manifest["android"]
             and previous_manifest["phoneTls"] == manifest["phoneTls"],
             "chained successor changes a bound native identity")
        prior_journal = workspace / "source-forward-journal.json"
        prior_recoverer = workspace / "source-forward-recoverer.sh"
        prior = jread(prior_journal, 0o600)
        need(digest(prior_journal) == data.get("previousJournalSha256")
             and digest(prior_recoverer) == data.get("previousRecovererSha256")
             and prior.get("schema") == SCHEMA and prior.get("chainDepth") == 0
             and prior.get("phase") in {"prepare_pending", "health_pending"}
             and prior.get("phase") == data.get("previousPhase")
             and prior.get("newRelease") == str(previous)
             and prior.get("workspace") == str(source_base)
             and prior.get("selfSha256") == data.get("selfSha256")
             and digest(prior_recoverer) == data.get("selfSha256"),
             "previous forward decision proof changed")
    else:
        need("originWorkspace" not in data and "previousRelease" not in data,
             "initial forward decision carries a chain")
    for key, name, sha in (("sourceJournal", "source-journal.json", "sourceJournalSha256"),
                           ("sourceRecoverer", "source-install-release.sh",
                            "sourceRecovererSha256"),
                           ("sourcePlan", "source-rollback-plan.json", "sourcePlanSha256"),
                           ("sourceRole", "source-android-role-holders.json", "sourceRoleSha256")):
        path = P(data.get(key, ""))
        need(path == source_base / name and digest(path) == data.get(sha),
             "forensic source proof changed")
    need(HEX.fullmatch(str(data.get("databaseLogicalSha256", "")))
         and HEX.fullmatch(str(data.get("controlTokenSha256", "")))
         and isinstance(data.get("nlinks"), dict), "forward evidence changed")
    return data


def proc_start(pid):
    try:
        return P(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
    except (OSError, IndexError):
        return ""


def rename_noreplace(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is not None:
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                              ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    else:
        renamex = getattr(libc, "renamex_np", None)
        need(renamex is not None, "no atomic no-clobber rename primitive")
        renamex.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex.restype = ctypes.c_int
        result = renamex(os.fsencode(source), os.fsencode(target), 4)
    if result == 0:
        return True
    error = ctypes.get_errno()
    if error in {errno.ENOENT, errno.EEXIST, errno.ENOTEMPTY}:
        return False
    raise OSError(error, os.strerror(error), str(target))


class Lock:
    def __init__(self, path, label, adopt=False):
        self.path, self.label = P(path), label
        self.start = need(proc_start(os.getpid()), "cannot bind process identity")
        if adopt:
            self.verify()
        else:
            self.acquire()
        info = os.lstat(self.path)
        need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
             f"{self.label} lock is unsafe")
        self.identity = (info.st_dev, info.st_ino)

    def owner_at(self, directory):
        try:
            text = slurp(P(directory) / "owner", 4096, 0o600).decode("ascii")
        except (OSError, UnicodeError) as exc:
            raise Error(f"{self.label} owner is malformed") from exc
        value = {}
        for line in text.splitlines():
            key, separator, item = line.partition("=")
            need(separator and key not in value, f"{self.label} owner is malformed")
            value[key] = item
        return value

    def owner(self):
        return self.owner_at(self.path)

    def verify(self):
        value = self.owner()
        need(value.get("pid") == str(os.getpid()) and value.get("start") == self.start,
             f"{self.label} lock is not owned")

    def acquire(self):
        raw_wait = os.environ.get("EVOGENT_INSTALL_WAIT_SECONDS", "21600")
        need(raw_wait.isdigit(), "invalid lock wait")
        deadline = time.monotonic() + int(raw_wait)
        prefix = f"{self.path.name}.pending."
        tombstone_prefix = f"{self.path.name}.pending-stale."
        for tombstone in self.path.parent.glob(f"{tombstone_prefix}*"):
            need(re.fullmatch(re.escape(tombstone_prefix) + r"[0-9a-f]{16}",
                              tombstone.name),
                 f"{self.label} pending tombstone name is unsafe")
            info = os.lstat(tombstone)
            need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                 and info.st_uid == os.geteuid(),
                 f"{self.label} pending tombstone is unsafe")
            try:
                value = self.owner_at(tombstone)
                live = (value.get("pid", "").isdigit()
                        and proc_start(int(value["pid"])) == value.get("start"))
            except (Error, ValueError):
                live = False
            need(not live, f"{self.label} pending tombstone is still owned")
            try:
                shutil.rmtree(tombstone)
            except FileNotFoundError:
                pass
            sync_dir(tombstone.parent)
        for pending in self.path.parent.glob(f"{prefix}*"):
            need(re.fullmatch(re.escape(prefix) + r"[0-9a-f]{16}", pending.name),
                 f"{self.label} pending lock name is unsafe")
            info = os.lstat(pending)
            need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                 and info.st_uid == os.geteuid(), f"{self.label} pending lock is unsafe")
            try:
                value = self.owner_at(pending)
                live = (value.get("pid", "").isdigit()
                        and proc_start(int(value["pid"])) == value.get("start"))
            except (Error, ValueError):
                live = False
            if live or time.time() - info.st_mtime < 2:
                continue
            stale = pending.with_name(
                f"{self.path.name}.pending-stale.{secrets.token_hex(8)}")
            os.rename(pending, stale)
            moved = os.lstat(stale)
            need((moved.st_dev, moved.st_ino) == (info.st_dev, info.st_ino),
                 f"{self.label} pending lock identity changed")
            sync_dir(pending.parent)
            if os.environ.get("EVOGENT_FORWARD_TEST_CRASH_PENDING_REAP") == "1":
                os._exit(77)
            shutil.rmtree(stale)
            sync_dir(stale.parent)
        candidate = self.path.with_name(f"{self.path.name}.pending.{secrets.token_hex(8)}")
        os.mkdir(candidate, 0o700)
        owner = (f"pid={os.getpid()}\nstart={self.start}\nlabel={self.label}\n").encode()
        put(candidate / "owner", owner, 0o600)
        sync_dir(candidate)
        try:
            while True:
                if rename_noreplace(candidate, self.path):
                    sync_dir(self.path.parent)
                    return
                try:
                    observed = os.lstat(self.path)
                    need(stat.S_ISDIR(observed.st_mode)
                         and not stat.S_ISLNK(observed.st_mode)
                         and observed.st_uid == os.geteuid(),
                         f"{self.label} lock is unsafe")
                    try:
                        value = self.owner()
                        live = (value.get("pid", "").isdigit()
                                and proc_start(int(value["pid"]))
                                == value.get("start"))
                    except (Error, ValueError):
                        live = False
                    if live:
                        need(time.monotonic() < deadline,
                             f"timed out for {self.label} lock")
                        time.sleep(1)
                        continue
                    time.sleep(.05)
                    current = os.lstat(self.path)
                    need((current.st_dev, current.st_ino)
                         == (observed.st_dev, observed.st_ino),
                         f"{self.label} lock changed during stale proof")
                    stale = self.path.with_name(
                        f"{self.path.name}.stale.{secrets.token_hex(8)}")
                    os.rename(self.path, stale)
                    moved = os.lstat(stale)
                    need((moved.st_dev, moved.st_ino)
                         == (observed.st_dev, observed.st_ino),
                         f"{self.label} stale lock identity changed")
                    sync_dir(self.path.parent)
                    shutil.rmtree(stale)
                except FileNotFoundError:
                    continue
        finally:
            if os.path.lexists(candidate):
                shutil.rmtree(candidate)
                sync_dir(candidate.parent)

    def relocate(self, path):
        path = P(path)
        info = os.lstat(path)
        need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
             and (info.st_dev, info.st_ino) == self.identity,
             "cycle lock did not move with state")
        self.path = path
        self.verify()

    def release(self):
        self.verify()
        (self.path / "owner").unlink()
        if os.environ.get("EVOGENT_FORWARD_TEST_CRASH_LOCK_RELEASE") == "owner":
            os._exit(78)
        os.rmdir(self.path)
        if os.environ.get("EVOGENT_FORWARD_TEST_CRASH_LOCK_RELEASE") == "rmdir":
            os._exit(79)
        sync_dir(self.path.parent)


def cycle_parent(ctx):
    home, state = ctx.home / "phone-tools", ctx.state / "phone-tools"
    first, second = home.is_dir() and not home.is_symlink(), state.is_dir() and not state.is_symlink()
    need(first != second, "ambiguous cycle-gate topology")
    return home if first else state


def locks(ctx, activation=False):
    held = []
    try:
        held.append(Lock(ctx.install_lock, "release-install", activation))
        held.append(Lock(ctx.control_lock, "release-install-control-barrier"))
        held.append(Lock(cycle_parent(ctx) / ".cycle.lock",
                         "release-install-cycle-gate"))
        return held
    except BaseException:
        for lock in reversed(held):
            lock.release()
        raise


def quiesce(ctx):
    for name in ("evo-sched", "evo"):
        command(["tmux", "kill-session", "-t", name], check=False, timeout=20)
    owners = control_processes(ctx)
    owners.update((pid, proc_start(pid)) for pid in tagged()
                  if pid != os.getpid() and proc_start(pid))
    for pid, start_value in owners.items():
        if proc_start(pid) != start_value:
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    while any(proc_start(pid) == start_value for pid, start_value in owners.items()) \
            and time.monotonic() < deadline:
        time.sleep(.1)
    for pid, start_value in owners.items():
        if proc_start(pid) != start_value:
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    while any(proc_start(pid) == start_value for pid, start_value in owners.items()) \
            and time.monotonic() < deadline:
        time.sleep(.1)
    stopped(ctx)


def sync_move_parents(candidates, target):
    parents = []
    for candidate in [*map(P, candidates), P(target)]:
        parent = candidate.parent
        if parent not in parents and os.path.lexists(parent):
            real_dir(parent, "forward move replay parent")
            parents.append(parent)
    for parent in parents:
        sync_dir(parent)


def move(expected, link_count, candidates, target, mutable=False):
    target = P(target)
    if os.path.lexists(target) and mutable and same(target, expected, core=True):
        sync_move_parents(candidates, target)
        return
    found = [P(item) for item in [*candidates, target] if same(item, expected, link_count)]
    if expected["type"] == "absent":
        need(not any(os.path.lexists(item) for item in [*candidates, target]),
             "planned-absent entry appeared")
        return
    need(len(found) == 1, "planned entry is missing, duplicated, or changed")
    if found[0] == target:
        # A replay can observe the rename before either parent fsync completed.
        # Sync every still-real candidate parent (including the actual source
        # parent) as well as the destination parent before advancing.
        sync_move_parents(candidates, target)
        need(same(target, expected, link_count), "forward move replay changed entry")
        return
    need(not os.path.lexists(target), "forward move destination is occupied")
    real_dir(target.parent, "forward move parent")
    os.rename(found[0], target)
    sync_dir(found[0].parent)
    sync_dir(target.parent)
    need(same(target, expected, link_count), "forward move changed entry")


def ensure_dir(path, marker=None):
    path = P(path)
    if not os.path.lexists(path):
        path.mkdir(mode=0o700)
    real_dir(path, "forward state directory")
    # This also repairs a prior mkdir observed after a crash before its parent
    # barrier. Syncing the child makes subsequent marker publication explicit.
    sync_dir(path.parent)
    sync_dir(path)
    if marker:
        put(path / ".evogent-forward-owner", (marker + "\n").encode(), 0o600)


def seed(incoming, data):
    source_root = incoming / "defaults/data"
    if not source_root.is_dir() or source_root.is_symlink():
        return
    for source in sorted(source_root.rglob("*")):
        if source.is_dir() and not source.is_symlink():
            continue
        need(source.is_file() and not source.is_symlink(), "unsafe release default")
        relative, parent = source.relative_to(source_root), data
        for part in relative.parts[:-1]:
            parent /= part
            ensure_dir(parent)
        target = data / relative
        if os.path.lexists(target):
            slurp(target, 64 << 20)
            sync_dir(target.parent)
        else:
            put(target, slurp(source, 64 << 20), 0o600)


def authority(ctx, journal, plan):
    workspace = P(journal["workspace"])
    expected = plan["entries"]["data"]
    holders = [ctx.home / "evogent/data", workspace / "runtime/data", ctx.state / "data"]
    # Release defaults may intentionally add child directories after this
    # authority is moved. Bind its inode and prove its logical DB/token instead
    # of treating a mutable directory's link count as immutable.
    found = [path for path in holders if same(path, expected, core=True)]
    need(len(found) == 1, "live data authority is ambiguous")
    data = found[0]
    need(logical_db(data / "media-agent.db") == journal["databaseLogicalSha256"],
         "live database authority changed")
    need(digest(slurp(data / "control-token.txt", 4096, 0o600))
         == journal["controlTokenSha256"], "live token authority changed")


def migrate(ctx, journal):
    need(journal["phase"] == "migration_pending", "migration lacks durable intent")
    plan, workspace = jread(journal["sourcePlan"], 0o600), P(journal["workspace"])
    authority(ctx, journal, plan)
    entries, counts, runtime = plan["entries"], journal["nlinks"], workspace / "runtime"
    move(entries["runtime"], counts["runtime"], [ctx.home / "evogent"], runtime, True)
    move(entries["data"], counts["data"], [ctx.home / "evogent/data", runtime / "data"],
         ctx.state / "data", True)
    marker = journal["sourceJournalSha256"]
    ensure_dir(ctx.state / "config", marker)
    move(entries["environment"], counts.get("environment"),
         [ctx.home / "evogent/.env.local", runtime / ".env.local"],
         ctx.state / "config/.env.local")
    move(entries["phoneTools"], counts["phoneTools"], [ctx.home / "phone-tools"],
         ctx.state / "phone-tools")
    for name in HOME_NAMES:
        move(entries[f"home:{name}"], counts.get(f"home:{name}"), [ctx.home / name],
             workspace / "home" / name)
    ensure_dir(ctx.state / "next-cache")
    ensure_dir(ctx.state / "next-cache" / journal["releaseId"], marker)
    seed(P(journal["newRelease"]), ctx.state / "data")
    sync_dir(ctx.state)


def prepare_runtime(ctx, journal):
    ensure_dir(ctx.state / "next-cache")
    ensure_dir(ctx.state / "next-cache" / journal["releaseId"],
               journal["sourceJournalSha256"])
    sync_dir(ctx.state / "next-cache")
    runtime = P(journal["newRelease"]) / "runtime"
    env = os.environ.copy()
    env["EVOGENT_TASK_OWNER"] = (
        f"evogent-forward-prepare:{journal['sourceJournalSha256']}")
    env["NODE_ENV"] = "production"
    command(["npm", "ls", "--omit=dev", "--depth=0"], cwd=runtime, timeout=60,
            env=env, new_session=True)
    probe = b"""\
for (const name of ['next', 'better-sqlite3', 'ws', 'dotenv']) require.resolve(name);
const next = require('next');
const app = next({dev: false, dir: process.cwd(), hostname: '127.0.0.1', port: 3001});
(async () => {
  try { await app.prepare(); } finally { await app.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
"""
    command(["timeout", "-k", "5", "120", "node"], data=probe, env=env,
            cwd=runtime, timeout=130, new_session=True)


def link(path, target):
    path = P(path)
    if path.is_symlink() and os.readlink(path) == target:
        # Re-establish the parent barrier when replay observes a symlink that a
        # prior process may have published immediately before it died.
        sync_dir(path.parent)
        return
    need(not os.path.lexists(path), f"occupied forward link: {path.name}")
    temporary = path.with_name(f".{path.name}.link.{secrets.token_hex(8)}")
    os.symlink(target, temporary)
    os.rename(temporary, path)
    sync_dir(path.parent)


def desired_phone_tools(ctx, journal):
    incoming = P(journal["newRelease"])
    result = {}
    for source in (incoming / "phone-tools").iterdir():
        need(SAFE.fullmatch(source.name) and source.name != ".cycle.lock",
             "unsafe phone-tool name")
        need(source.name not in result, "duplicate phone-tool name")
        result[source.name] = str(ctx.root / "current/phone-tools" / source.name)
    need("install-release.sh" not in result, "ambiguous installer dispatch")
    result["install-release.sh"] = str(ctx.root / "current/device/install-release.sh")
    return result


def publish_current(ctx, journal):
    current = ctx.root / "current"
    target = f"releases/{journal['releaseId']}"
    if current.is_symlink() and os.readlink(current) == target:
        # This early path bypasses link(), so it needs the same replay barrier.
        sync_dir(current.parent)
        return
    if journal["chainDepth"] == 0:
        link(current, target)
        return
    previous = f"releases/{journal['previousReleaseId']}"
    if journal["previousPhase"] == "prepare_pending":
        need(not os.path.lexists(current), "pre-switch chain gained a release pointer")
        link(current, target)
        return
    need(current.is_symlink() and os.readlink(current) == previous,
         "failed successor pointer changed before chained switch")
    temporary = current.with_name(f".current.link.{secrets.token_hex(8)}")
    os.symlink(target, temporary)
    os.replace(temporary, current)
    sync_dir(current.parent)
    if os.environ.get("EVOGENT_FORWARD_TEST_FAIL_AFTER_POINTER") == "1":
        raise Error("injected post-pointer failure")


def switch(ctx, journal):
    need(journal["phase"] == "switch_pending", "switch lacks durable intent")
    incoming, workspace = P(journal["newRelease"]), P(journal["workspace"])
    phone, retired = ctx.state / "phone-tools", workspace / "phone-tools"
    real_dir(phone, "forward phone-tools state")
    real_dir(retired, "retired phone-tools state")
    # Replay can observe the final retirement only in `retired`, so no source
    # entry remains to drive the loop. Reassert both rename-parent barriers
    # before accepting any already-retired namespace.
    sync_dir(phone)
    sync_dir(retired)
    desired = desired_phone_tools(ctx, journal)
    for target in sorted(phone.iterdir(), key=lambda item: item.name):
        name = target.name
        need(SAFE.fullmatch(name), "unsafe legacy phone-tool name")
        if name == ".cycle.lock":
            real_dir(target, "held cycle gate")
            continue
        expected = desired.get(name)
        if expected is not None and target.is_symlink() and os.readlink(target) == expected:
            continue
        old = retired / name
        need(not os.path.lexists(old), "duplicated phone-tool predecessor")
        os.rename(target, old)
        sync_dir(phone)
        sync_dir(retired)
    for name, expected in sorted(desired.items()):
        link(phone / name, expected)
    public = ((ctx.home / "evogent", str(ctx.root / "current/runtime")),
              (ctx.home / "phone-tools", str(phone)),
              (ctx.home / "start-prod.sh", str(ctx.root / "current/device/start-prod.sh")),
              (ctx.home / "restart-evo.sh", str(ctx.root / "current/device/restart-evo.sh")),
              (ctx.home / "deploy-next.sh", str(ctx.root / "current/phone-tools/deploy-next.sh")),
              (ctx.home / "install-evogent-release.sh",
               str(ctx.root / "current/device/install-release.sh")))
    need(not os.path.lexists(ctx.home / "start-prod-sub.sh"), "retired entrypoint reappeared")
    for path, target in public:
        link(path, target)
    publish_current(ctx, journal)


def topology(ctx, journal):
    incoming, phone = P(journal["newRelease"]), ctx.state / "phone-tools"
    expected = ((ctx.home / "evogent", str(ctx.root / "current/runtime")),
                (ctx.home / "phone-tools", str(phone)),
                (ctx.home / "start-prod.sh", str(ctx.root / "current/device/start-prod.sh")),
                (ctx.home / "restart-evo.sh", str(ctx.root / "current/device/restart-evo.sh")),
                (ctx.home / "deploy-next.sh", str(ctx.root / "current/phone-tools/deploy-next.sh")),
                (ctx.home / "install-evogent-release.sh",
                 str(ctx.root / "current/device/install-release.sh")),
                (ctx.root / "current", f"releases/{incoming.name}"))
    need(not os.path.lexists(ctx.home / "start-prod-sub.sh"), "obsolete entrypoint exists")
    need(all(path.is_symlink() and os.readlink(path) == target for path, target in expected),
         "forward topology is incomplete")
    need((ctx.root / "current").resolve() == incoming, "release pointer changed")
    desired = desired_phone_tools(ctx, journal)
    actual = {item.name: item for item in phone.iterdir()}
    extras = set(actual) - {*desired, ".cycle.lock"}
    for name in extras:
        info = os.lstat(actual[name])
        need(CONTROL_ARTIFACT.fullmatch(name)
             and not stat.S_ISLNK(info.st_mode) and info.st_uid == os.geteuid()
             and (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)),
             "phone-tool namespace contains legacy or unknown entries")
    need(all((phone / name).is_symlink() and os.readlink(phone / name) == target
             for name, target in desired.items()), "phone-tool dispatch is incomplete")
    real_dir(phone / ".cycle.lock", "held cycle gate")


def start(ctx, journal):
    incoming = P(journal["newRelease"])
    command(["bash", str(incoming / "device/restart-evo.sh")], timeout=150)
    env = os.environ.copy()
    env.update(EVOGENT_RELEASE_RECOVERY="1", EVOGENT_RELEASE_BOOT="1",
               EVOGENT_CONTROL_RELEASE_ROOT=str(incoming))
    command(["bash", str(incoming / "phone-tools/evogent-boot.sh")],
            env=env, timeout=180)


def api(incoming, url):
    env = os.environ.copy()
    env["EVOGENT_PHONE_TOOLS"] = str(incoming / "phone-tools")
    raw = command([str(incoming / "phone-tools/evo-curl"), "--fail", "--silent",
                   "--show-error", "--max-time", "15", url], env=env, timeout=20).stdout
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise Error("invalid authenticated response") from exc


def healthy(ctx, journal):
    incoming, manifest = P(journal["newRelease"]), release(ctx, journal["newRelease"])
    for _ in range(60):
        try:
            health = api(incoming, "http://127.0.0.1:3001/api/internal/phone-health")
            running = api(incoming, "http://127.0.0.1:3001/api/internal/deployment-status")["running"]
            api(incoming, "http://127.0.0.1:3001/api/feed?limit=1")
            need(health["ok"] is True and health["runtime"]["profile"] == "phone"
                 and health["runtime"]["backgroundJobsDisabled"] is True
                 and running["releaseId"] == manifest["releaseId"]
                 and running["releaseFormat"] == manifest["releaseFormat"]
                 and running["buildId"] == manifest["web"]["buildId"]
                 and running["commitFull"] == manifest["source"]["commit"], "health mismatch")
            env = os.environ.copy()
            env["EVOGENT_PHONE_TOOLS"] = str(incoming / "phone-tools")
            command([str(incoming / "phone-tools/evo-health")], env=env, timeout=20)
            with zipfile.ZipFile(incoming / "apk/evogent.apk") as apk:
                ca = apk.read("res/raw/evogent_phone_ca.pem").decode("ascii")
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname, context.verify_mode = True, ssl.CERT_REQUIRED
            context.load_verify_locations(cadata=ca)
            with socket.create_connection(("127.0.0.1", 3443), timeout=3) as plain:
                with context.wrap_socket(plain, server_hostname="127.0.0.1") as secure:
                    cert = digest(secure.getpeercert(binary_form=True))
            need(cert == manifest["phoneTls"]["certificateDerSha256"], "TLS changed")
            role = jread(journal["sourceRole"], 0o600)
            roles(journal["sourceRole"], journal["sourceRoleSha256"], role["userId"])
            token = android(f"cat '{APP_TOKEN}'", "control-token", 4096)
            live = slurp(ctx.state / "data/control-token.txt", 4096, 0o600)
            apk_sha = android(f"p=$(pm path '{PACKAGE}' | sed -n 's/^package://p' | head -1); "
                              "sha256sum \"$p\" | awk '{print $1}'",
                              "installed-apk", 128).decode().strip()
            need(token == live and digest(token) == journal["controlTokenSha256"]
                 and apk_sha == journal["android"]["sha256"], "native proof changed")
            return
        except (Error, KeyError, OSError, ssl.SSLError):
            time.sleep(2)
    raise Error("forward release did not become healthy")


def transition(ctx, old, new):
    journal = load_forward(ctx)
    need(journal["phase"] == old and old in PHASES and new in PHASES
         and PHASES.index(new) == PHASES.index(old) + 1, "invalid phase transition")
    journal["phase"] = new
    jput(ctx.journal, journal, True, True)


def retire(ctx, journal):
    incoming = P(journal["newRelease"])
    command([sys.executable, str(incoming / "device/dependency-tree-state.py"),
             "candidate-clear", str(ctx.root), journal["releaseId"]])
    if journal["chainDepth"] == 1:
        command([sys.executable, str(incoming / "device/dependency-tree-state.py"),
                 "candidate-clear", str(ctx.root), journal["previousReleaseId"]])
    archive = P(journal["workspace"]) / "committed-journal.json"
    need(not os.path.lexists(archive), "committed archive already exists")
    os.rename(ctx.journal, archive)
    sync_dir(ctx.tx)
    sync_dir(archive.parent)
    for path in (ctx.recoverer, ctx.old_recoverer, ctx.tx / "forward-candidate.json"):
        if os.path.lexists(path):
            P(path).unlink()
    sync_dir(ctx.tx)


def advance(ctx, held):
    while True:
        journal = load_forward(ctx)
        phase = journal["phase"]
        if phase == "forward_decided":
            transition(ctx, phase, "migration_pending")
        elif phase == "migration_pending":
            quiesce(ctx)
            migrate(ctx, journal)
            held[2].relocate(ctx.state / "phone-tools/.cycle.lock")
            transition(ctx, phase, "prepare_pending")
        elif phase == "prepare_pending":
            quiesce(ctx)
            prepare_runtime(ctx, journal)
            transition(ctx, phase, "switch_pending")
        elif phase == "switch_pending":
            switch(ctx, journal)
            topology(ctx, journal)
            transition(ctx, phase, "runtime_pending")
        elif phase == "runtime_pending":
            topology(ctx, journal)
            transition(ctx, phase, "health_pending")
        elif phase == "health_pending":
            start(ctx, journal)
            healthy(ctx, journal)
            transition(ctx, phase, "committed")
        else:
            start(ctx, journal)
            healthy(ctx, journal)
            topology(ctx, journal)
            return journal


def publish_decision(ctx, candidate):
    os.replace(candidate, ctx.journal)
    try:
        if os.environ.get("EVOGENT_FORWARD_TEST_FAIL_DIR_FSYNC") == "1":
            raise OSError("injected decision fsync failure")
        sync_dir(ctx.tx)
    except BaseException:
        os._exit(76)


def decide(ctx, incoming):
    old, plan, plan_path, role, manifest = old_state(ctx, incoming)
    proof, source_sha = evidence(ctx, old, plan, role, manifest), digest(ctx.journal)
    workspace = ctx.root / "migrations" / f"legacy-forward-{incoming.name}-{source_sha[:12]}"
    need(SAFE.fullmatch(workspace.name), "forward workspace name is unsafe")
    ensure_dir(workspace)
    ensure_dir(workspace / "home")
    ensure_dir(workspace / "phone-tools")
    source_program = ctx.old_recoverer if os.path.lexists(ctx.old_recoverer) else ctx.recoverer
    slurp(source_program, mode=0o700)
    if source_program == ctx.recoverer:
        copy(source_program, ctx.old_recoverer, 0o700)
    copy(ctx.journal, workspace / "source-journal.json", 0o600)
    copy(source_program, workspace / "source-install-release.sh", 0o700)
    copy(plan_path, workspace / "source-rollback-plan.json", 0o600)
    copy(role, workspace / "source-android-role-holders.json", 0o600)
    candidate = ctx.tx / "forward-candidate.json"
    payload = forward_journal(ctx, old, plan_path, role, incoming, manifest, proof, workspace)
    jput(candidate, payload)
    copy(__file__, ctx.recoverer, 0o700, True)
    old2, plan2, path2, role2, manifest2 = old_state(ctx, incoming)
    proof2 = evidence(ctx, old2, plan2, role2, manifest2)
    expected = forward_journal(ctx, old2, path2, role2, incoming, manifest2, proof2, workspace)
    need(jread(candidate, 0o600) == expected and digest(ctx.journal) == source_sha,
         "admission floor changed before decision")
    publish_decision(ctx, candidate)


def decide_chain(ctx, incoming):
    prior, manifest, proof = chain_state(ctx, incoming)
    source_sha = digest(ctx.journal)
    slurp(ctx.recoverer, mode=0o700)
    need(os.path.samefile(__file__, ctx.recoverer)
         and digest(ctx.recoverer) == prior["selfSha256"],
         "chain activation is not running its pinned recoverer")
    workspace = ctx.root / "migrations" / (
        f"legacy-forward-chain-{incoming.name}-{source_sha[:12]}")
    need(SAFE.fullmatch(workspace.name), "chained workspace name is unsafe")
    ensure_dir(workspace)
    ensure_dir(workspace / "home")
    ensure_dir(workspace / "phone-tools")
    copy(ctx.journal, workspace / "source-forward-journal.json", 0o600)
    copy(ctx.recoverer, workspace / "source-forward-recoverer.sh", 0o700)
    candidate = ctx.tx / "forward-candidate.json"
    payload = chained_journal(ctx, prior, incoming, manifest, proof, workspace)
    jput(candidate, payload)
    prior2, manifest2, proof2 = chain_state(ctx, incoming)
    expected = chained_journal(ctx, prior2, incoming, manifest2, proof2, workspace)
    need(jread(candidate, 0o600) == expected and digest(ctx.journal) == source_sha,
         "chained admission floor changed before decision")
    publish_decision(ctx, candidate)


def finalize(ctx, committed, held):
    held[2].release()
    held[2] = None
    held[1].release()
    held[1] = None
    retire(ctx, committed)


def orchestrate(mode, incoming=None, root=None, journal=None):
    chained = False
    if mode == "recover":
        raw = jread(journal, 0o600)
        need(raw.get("schema") == SCHEMA, "forward decision is not durably visible")
        ctx = Ctx(raw.get("root", ""))
        need(P(journal) == ctx.journal, "recovery journal path changed")
        load_forward(ctx)
        sync_dir(ctx.tx)  # convert a visible decision only in a later process
        held = locks(ctx)
    else:
        ctx = Ctx(root)
        need(P(journal) == ctx.journal, "source journal path changed")
        incoming = child(incoming, ctx.releases, "successor release")
        raw = jread(ctx.journal, 0o600)
        if raw.get("schema") == SCHEMA and not os.path.samefile(__file__, ctx.recoverer):
            slurp(ctx.recoverer, mode=0o700)
            os.execv(sys.executable, [sys.executable, str(ctx.recoverer),
                                      "--chain-activate", str(incoming),
                                      str(ctx.root), str(ctx.journal)])
        chained = raw.get("schema") == SCHEMA
        need(mode == "activate" or chained, "internal chain activation is invalid")
        if chained:
            need(os.path.samefile(__file__, ctx.recoverer),
                 "chain activation is not pinned")
            load_forward(ctx)
        else:
            need(mode == "activate", "chain activation lacks a forward decision")
        held = locks(ctx, True)
    decided, failure = mode == "recover" or chained, None
    try:
        if mode != "recover":
            if chained:
                decide_chain(ctx, incoming)
            else:
                decide(ctx, incoming)
        decided = load_forward(ctx).get("forwardDecision") == 1
        committed = advance(ctx, held)
        finalize(ctx, committed, held)
    except BaseException as exc:
        failure = exc
        # Once retirement has removed the live journal, there is no durable
        # intent left that a reboot can use to rearm a runtime stopped here.
        # Post-retirement forensic/recoverer cleanup failures are surfaced, but
        # must not fail-stop the already-proven committed runtime.
        if decided and os.path.lexists(ctx.journal):
            try:
                quiesce(ctx)
            except BaseException as stop_exc:
                failure = Error(f"postdecision fail-stop could not be proven: {stop_exc}")
    release_failures = []
    for lock in reversed(held):
        if lock is not None:
            try:
                lock.release()
            except BaseException as exc:
                release_failures.append(exc)
    if failure is not None:
        raise failure
    if release_failures:
        raise Error(f"durable lock retirement failed: {release_failures[0]}")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) == 4 and argv[0] == "--activate":
            orchestrate("activate", P(argv[1]), P(argv[2]), P(argv[3]))
        elif len(argv) == 4 and argv[0] == "--chain-activate":
            orchestrate("chain", P(argv[1]), P(argv[2]), P(argv[3]))
        elif len(argv) == 2 and argv[0] == "--recover":
            orchestrate("recover", journal=P(argv[1]))
        else:
            raise Error("usage: forward-rescue.sh --activate <release> <root> <journal> "
                        "| --recover <journal>")
    except Error as exc:
        print(f"forward rescue: {exc}", file=sys.stderr)
        return 70
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
