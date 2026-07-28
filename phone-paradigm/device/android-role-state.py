#!/data/data/com.termux/files/usr/bin/python3
"""Private, strict Android HOME/ASSISTANT role snapshot handling.

The helper never invokes Android commands. The installer supplies their bounded
raw output over stdin, keeping holder package names out of argv and ordinary
logs.

Capture stdin is exactly:

    EVOGENT_ANDROID_ROLE_RAW_V1\n
    <raw HOME get-role-holders output>
    <raw ASSISTANT get-role-holders output>

Each raw role output is exactly one LF-terminated line. An empty line means no
holder. Android 16 joins multiple holders with semicolons; this helper rejects
multiple holders because HOME and ASSISTANT are exclusive roles.

Exit status 0 means success or match. Status 1 is a valid comparison mismatch
and is deliberately silent. Status 65 means invalid or unsafe input/state.
Only explicit snapshot/query-result parsing commands emit observed values.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import sys
from typing import BinaryIO, NoReturn


SCHEMA = "evogent.phone.android-role-holders.v1"
HOME_ROLE = "android.app.role.HOME"
ASSISTANT_ROLE = "android.app.role.ASSISTANT"
ROLES = (HOME_ROLE, ASSISTANT_ROLE)
SNAPSHOT_BASENAME = "android-role-holders.json"
CAPTURE_HEADER = b"EVOGENT_ANDROID_ROLE_RAW_V1\n"
QUERY_RESULT_HEADER = b"EVOGENT_ANDROID_ROLE_QUERY_RESULT_V1\n"
CURRENT_USER_RESULT_HEADER = QUERY_RESULT_HEADER + b"current-user\n"
ROLE_HOLDERS_RESULT_HEADER = QUERY_RESULT_HEADER + b"role-holders\n"
ASSISTANT_SETTING_RESULT_HEADER = QUERY_RESULT_HEADER + b"assistant-setting\n"
VOICE_SETTING_RESULT_HEADER = QUERY_RESULT_HEADER + b"voice-setting\n"
HOME_COMPONENT_RESULT_HEADER = QUERY_RESULT_HEADER + b"home-component\n"

MAX_ROLE_OUTPUT_BYTES = 4096
MAX_CAPTURE_INPUT_BYTES = len(CAPTURE_HEADER) + (MAX_ROLE_OUTPUT_BYTES * 2)
MAX_CURRENT_USER_RESULT_BYTES = len(CURRENT_USER_RESULT_HEADER) + 12
MAX_ROLE_HOLDERS_RESULT_BYTES = (
    len(ROLE_HOLDERS_RESULT_HEADER) + MAX_ROLE_OUTPUT_BYTES
)
MAX_COMPONENT_OUTPUT_BYTES = 1024
MAX_SNAPSHOT_BYTES = 8192
MAX_USER_ID = (2**31) - 1

EXIT_MISMATCH = 1
EXIT_INVALID = 65

USER_ID_PATTERN = re.compile(r"(?:0|[1-9][0-9]{0,9})")
DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}")
PACKAGE_PATTERN = re.compile(
    r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+"
)


class RoleStateError(Exception):
    """An intentionally non-disclosing validation failure."""


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> NoReturn:
        raise RoleStateError


def _read_bounded(stream: BinaryIO, limit: int) -> bytes:
    payload = stream.read(limit + 1)
    if len(payload) > limit:
        raise RoleStateError
    return payload


def _parse_user_id(raw: str) -> int:
    if USER_ID_PATTERN.fullmatch(raw) is None:
        raise RoleStateError
    value = int(raw)
    if value > MAX_USER_ID:
        raise RoleStateError
    return value


def _parse_digest(raw: str) -> str:
    if DIGEST_PATTERN.fullmatch(raw) is None:
        raise RoleStateError
    return raw


def _parse_role(raw: str) -> str:
    if raw not in ROLES:
        raise RoleStateError
    return raw


def _parse_package(raw: str) -> str:
    if len(raw) > 255 or PACKAGE_PATTERN.fullmatch(raw) is None:
        raise RoleStateError
    return raw


def _parse_raw_role_output(payload: bytes) -> tuple[str, ...]:
    if (
        len(payload) > MAX_ROLE_OUTPUT_BYTES
        or not payload.endswith(b"\n")
        or payload.count(b"\n") != 1
    ):
        raise RoleStateError
    raw_holder = payload[:-1]
    if not raw_holder:
        return ()
    try:
        holder = raw_holder.decode("ascii", "strict")
    except UnicodeDecodeError as error:
        raise RoleStateError from error
    # Android joins role holders with ';'. These two roles are exclusive, so
    # any separator is unsupported rather than something to normalize.
    if ";" in holder:
        raise RoleStateError
    return (_parse_package(holder),)


def _parse_capture_input(stream: BinaryIO) -> dict[str, tuple[str, ...]]:
    payload = _read_bounded(stream, MAX_CAPTURE_INPUT_BYTES)
    if not payload.startswith(CAPTURE_HEADER):
        raise RoleStateError
    body = payload[len(CAPTURE_HEADER) :]
    lines = body.splitlines(keepends=True)
    if len(lines) != 2 or b"".join(lines) != body:
        raise RoleStateError
    return {
        HOME_ROLE: _parse_raw_role_output(lines[0]),
        ASSISTANT_ROLE: _parse_raw_role_output(lines[1]),
    }


def _parse_observed_input(stream: BinaryIO) -> tuple[str, ...]:
    return _parse_raw_role_output(_read_bounded(stream, MAX_ROLE_OUTPUT_BYTES))


def _strip_one_optional_lf(payload: bytes) -> bytes:
    if payload.endswith(b"\n"):
        payload = payload[:-1]
    if b"\n" in payload or b"\r" in payload:
        raise RoleStateError
    return payload


def _parse_current_user_result(stream: BinaryIO) -> int:
    payload = _read_bounded(stream, MAX_CURRENT_USER_RESULT_BYTES)
    if not payload.startswith(CURRENT_USER_RESULT_HEADER):
        raise RoleStateError
    raw_user_id = _strip_one_optional_lf(
        payload[len(CURRENT_USER_RESULT_HEADER) :]
    )
    try:
        user_id = raw_user_id.decode("ascii", "strict")
    except UnicodeDecodeError as error:
        raise RoleStateError from error
    return _parse_user_id(user_id)


def _parse_role_holders_result(stream: BinaryIO) -> tuple[str, ...]:
    payload = _read_bounded(stream, MAX_ROLE_HOLDERS_RESULT_BYTES)
    if not payload.startswith(ROLE_HOLDERS_RESULT_HEADER):
        raise RoleStateError
    raw_holder = _strip_one_optional_lf(
        payload[len(ROLE_HOLDERS_RESULT_HEADER) :]
    )
    if not raw_holder:
        return ()
    try:
        holder = raw_holder.decode("ascii", "strict")
    except UnicodeDecodeError as error:
        raise RoleStateError from error
    if ";" in holder:
        raise RoleStateError
    return (_parse_package(holder),)


def _parse_single_line_result(
    stream: BinaryIO,
    header: bytes,
) -> str:
    payload = _read_bounded(
        stream,
        len(header) + MAX_COMPONENT_OUTPUT_BYTES,
    )
    if not payload.startswith(header):
        raise RoleStateError
    raw_value = _strip_one_optional_lf(payload[len(header) :])
    try:
        value = raw_value.decode("ascii", "strict")
    except UnicodeDecodeError as error:
        raise RoleStateError from error
    if any(ord(character) < 0x20 or ord(character) > 0x7E for character in value):
        raise RoleStateError
    return value


def _strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise RoleStateError
        result[key] = value
    return result


def _validate_snapshot_object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != {"schema", "userId", "holders"}:
        raise RoleStateError
    if value["schema"] != SCHEMA:
        raise RoleStateError
    user_id = value["userId"]
    if (
        type(user_id) is not int
        or user_id < 0
        or user_id > MAX_USER_ID
    ):
        raise RoleStateError
    holders = value["holders"]
    if not isinstance(holders, dict) or set(holders) != set(ROLES):
        raise RoleStateError
    normalized_holders: dict[str, list[str]] = {}
    for role in ROLES:
        role_holders = holders[role]
        if not isinstance(role_holders, list) or len(role_holders) > 1:
            raise RoleStateError
        normalized: list[str] = []
        for holder in role_holders:
            if not isinstance(holder, str):
                raise RoleStateError
            normalized.append(_parse_package(holder))
        if len(normalized) != len(set(normalized)):
            raise RoleStateError
        normalized_holders[role] = normalized
    return {
        "schema": SCHEMA,
        "userId": user_id,
        "holders": normalized_holders,
    }


def _encode_snapshot(value: dict[str, object]) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
        + b"\n"
    )


def _parse_snapshot_bytes(payload: bytes) -> dict[str, object]:
    try:
        decoded = payload.decode("ascii", "strict")
        value = json.loads(decoded, object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError, RoleStateError) as error:
        raise RoleStateError from error
    normalized = _validate_snapshot_object(value)
    if _encode_snapshot(normalized) != payload:
        raise RoleStateError
    return normalized


def _validate_snapshot_path(raw: str) -> pathlib.Path:
    if (
        not raw
        or "\x00" in raw
        or not os.path.isabs(raw)
        or raw.startswith("//")
        or os.path.normpath(raw) != raw
    ):
        raise RoleStateError
    path = pathlib.Path(raw)
    if path.name != SNAPSHOT_BASENAME or path.parent == pathlib.Path("/"):
        raise RoleStateError
    return path


def _directory_walk_flags() -> int:
    required = ("O_DIRECTORY", "O_NOFOLLOW")
    if any(not hasattr(os, name) for name in required):
        raise RoleStateError
    return (
        getattr(os, "O_PATH", os.O_RDONLY)
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )


def _directory_sync_flags() -> int:
    return (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )


def _open_private_parent(path: pathlib.Path) -> int:
    walk_flags = _directory_walk_flags()
    descriptor = os.open("/", walk_flags)
    sync_descriptor: int | None = None
    try:
        for component in path.parent.parts[1:]:
            child = os.open(component, walk_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        walked = os.fstat(descriptor)
        sync_descriptor = os.open(
            ".",
            _directory_sync_flags(),
            dir_fd=descriptor,
        )
        opened = os.fstat(sync_descriptor)
        if (
            not stat.S_ISDIR(walked.st_mode)
            or not stat.S_ISDIR(opened.st_mode)
            or not _same_inode(walked, opened)
            or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o700
        ):
            raise RoleStateError
        os.close(descriptor)
        return sync_descriptor
    except BaseException:
        if sync_descriptor is not None:
            os.close(sync_descriptor)
        os.close(descriptor)
        raise


def _same_inode(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            raise RoleStateError
        offset += written


def _publish_noreplace(
    directory_descriptor: int,
    source: str,
    destination: str,
) -> bool:
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
            directory_descriptor,
            os.fsencode(source),
            directory_descriptor,
            os.fsencode(destination),
            1,
        )
        if result == 0:
            return False
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOTEMPTY}:
            raise FileExistsError(error, os.strerror(error), destination)
        if error != errno.ENOSYS:
            raise OSError(error, os.strerror(error), destination)

    if hasattr(os, "link"):
        try:
            os.link(
                source,
                destination,
                src_dir_fd=directory_descriptor,
                dst_dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
        except (AttributeError, NotImplementedError, TypeError):
            pass
        else:
            return True

    raise RoleStateError


def _snapshot_digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _publish_snapshot(path: pathlib.Path, payload: bytes) -> None:
    parent_descriptor = _open_private_parent(path)
    temporary = f".{SNAPSHOT_BASENAME}.new.{secrets.token_hex(16)}"
    file_descriptor: int | None = None
    temporary_exists = False
    try:
        try:
            os.stat(
                SNAPSHOT_BASENAME,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            raise RoleStateError

        file_descriptor = os.open(
            temporary,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_NOFOLLOW
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=parent_descriptor,
        )
        temporary_exists = True
        os.fchmod(file_descriptor, 0o600)
        _write_all(file_descriptor, payload)
        os.fsync(file_descriptor)
        os.close(file_descriptor)
        file_descriptor = None

        # Linux/Android renameat2 publishes atomically without replacing an
        # existing snapshot. Hosts without renameat2 retain the equivalent
        # hard-link publication, followed by removal of the temporary name.
        temporary_exists = _publish_noreplace(
            parent_descriptor,
            temporary,
            SNAPSHOT_BASENAME,
        )
        if temporary_exists:
            os.unlink(temporary, dir_fd=parent_descriptor)
            temporary_exists = False
        os.fsync(parent_descriptor)
    finally:
        if file_descriptor is not None:
            os.close(file_descriptor)
        if temporary_exists:
            try:
                os.unlink(temporary, dir_fd=parent_descriptor)
                os.fsync(parent_descriptor)
            except OSError:
                pass
        os.close(parent_descriptor)


def _read_snapshot(
    raw_path: str,
    expected_digest: str,
    expected_user_id: int,
) -> tuple[dict[str, object], bytes]:
    path = _validate_snapshot_path(raw_path)
    digest = _parse_digest(expected_digest)
    parent_descriptor = _open_private_parent(path)
    descriptor: int | None = None
    try:
        descriptor = os.open(
            SNAPSHOT_BASENAME,
            os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
            dir_fd=parent_descriptor,
        )
        opened = os.fstat(descriptor)
        named = os.stat(
            SNAPSHOT_BASENAME,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            not stat.S_ISREG(opened.st_mode)
            or not stat.S_ISREG(named.st_mode)
            or not _same_inode(opened, named)
            or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o600
            or opened.st_size <= 0
            or opened.st_size > MAX_SNAPSHOT_BYTES
        ):
            raise RoleStateError
        with os.fdopen(os.dup(descriptor), "rb") as handle:
            payload = _read_bounded(handle, MAX_SNAPSHOT_BYTES)
        after = os.fstat(descriptor)
        rebound = os.stat(
            SNAPSHOT_BASENAME,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            not _same_inode(opened, after)
            or not _same_inode(opened, rebound)
            or after.st_size != len(payload)
        ):
            raise RoleStateError
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent_descriptor)

    if _snapshot_digest(payload) != digest:
        raise RoleStateError
    snapshot = _parse_snapshot_bytes(payload)
    if snapshot["userId"] != expected_user_id:
        raise RoleStateError
    return snapshot, payload


def _command_capture(arguments: argparse.Namespace) -> int:
    path = _validate_snapshot_path(arguments.snapshot)
    user_id = _parse_user_id(arguments.user_id)
    observed = _parse_capture_input(sys.stdin.buffer)
    snapshot = _validate_snapshot_object(
        {
            "schema": SCHEMA,
            "userId": user_id,
            "holders": {
                role: list(observed[role])
                for role in ROLES
            },
        }
    )
    payload = _encode_snapshot(snapshot)
    digest = _snapshot_digest(payload)
    _publish_snapshot(path, payload)
    # Reopen and prove the published name before returning its journal digest.
    _read_snapshot(str(path), digest, user_id)
    sys.stdout.write(digest + "\n")
    return 0


def _command_parse_current_user_result(_arguments: argparse.Namespace) -> int:
    user_id = _parse_current_user_result(sys.stdin.buffer)
    sys.stdout.write(f"{user_id}\n")
    return 0


def _command_parse_role_holders_result(_arguments: argparse.Namespace) -> int:
    holders = _parse_role_holders_result(sys.stdin.buffer)
    sys.stdout.write((holders[0] if holders else "") + "\n")
    return 0


def _command_parse_assistant_setting_result(
    _arguments: argparse.Namespace,
) -> int:
    value = _parse_single_line_result(
        sys.stdin.buffer,
        ASSISTANT_SETTING_RESULT_HEADER,
    )
    sys.stdout.write(value + "\n")
    return 0


def _command_parse_voice_setting_result(_arguments: argparse.Namespace) -> int:
    value = _parse_single_line_result(
        sys.stdin.buffer,
        VOICE_SETTING_RESULT_HEADER,
    )
    sys.stdout.write(value + "\n")
    return 0


def _command_parse_home_component_result(
    _arguments: argparse.Namespace,
) -> int:
    value = _parse_single_line_result(
        sys.stdin.buffer,
        HOME_COMPONENT_RESULT_HEADER,
    )
    sys.stdout.write(value + "\n")
    return 0


def _command_validate(arguments: argparse.Namespace) -> int:
    _read_snapshot(
        arguments.snapshot,
        arguments.sha256,
        _parse_user_id(arguments.user_id),
    )
    return 0


def _command_query(arguments: argparse.Namespace) -> int:
    role = _parse_role(arguments.role)
    snapshot, _ = _read_snapshot(
        arguments.snapshot,
        arguments.sha256,
        _parse_user_id(arguments.user_id),
    )
    holders = snapshot["holders"]
    assert isinstance(holders, dict)
    role_holders = holders[role]
    assert isinstance(role_holders, list)
    sys.stdout.write((role_holders[0] if role_holders else "") + "\n")
    return 0


def _command_compare_snapshot(arguments: argparse.Namespace) -> int:
    role = _parse_role(arguments.role)
    snapshot, _ = _read_snapshot(
        arguments.snapshot,
        arguments.sha256,
        _parse_user_id(arguments.user_id),
    )
    observed = _parse_observed_input(sys.stdin.buffer)
    holders = snapshot["holders"]
    assert isinstance(holders, dict)
    expected = tuple(holders[role])
    return 0 if observed == expected else EXIT_MISMATCH


def _command_compare_target(arguments: argparse.Namespace) -> int:
    _parse_role(arguments.role)
    target = _parse_package(arguments.target_package)
    observed = _parse_observed_input(sys.stdin.buffer)
    return 0 if observed == (target,) else EXIT_MISMATCH


def _add_snapshot_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--user-id", required=True)


def _build_parser() -> SafeArgumentParser:
    parser = SafeArgumentParser(
        description="Strict private Android role snapshot helper",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    capture = commands.add_parser("capture")
    capture.add_argument("--snapshot", required=True)
    capture.add_argument("--user-id", required=True)
    capture.set_defaults(handler=_command_capture)

    parse_current_user_result = commands.add_parser(
        "parse-current-user-result"
    )
    parse_current_user_result.set_defaults(
        handler=_command_parse_current_user_result
    )

    parse_role_holders_result = commands.add_parser(
        "parse-role-holders-result"
    )
    parse_role_holders_result.set_defaults(
        handler=_command_parse_role_holders_result
    )

    parse_assistant_setting_result = commands.add_parser(
        "parse-assistant-setting-result"
    )
    parse_assistant_setting_result.set_defaults(
        handler=_command_parse_assistant_setting_result
    )

    parse_voice_setting_result = commands.add_parser(
        "parse-voice-setting-result"
    )
    parse_voice_setting_result.set_defaults(
        handler=_command_parse_voice_setting_result
    )

    parse_home_component_result = commands.add_parser(
        "parse-home-component-result"
    )
    parse_home_component_result.set_defaults(
        handler=_command_parse_home_component_result
    )

    validate = commands.add_parser("validate")
    _add_snapshot_arguments(validate)
    validate.set_defaults(handler=_command_validate)

    query = commands.add_parser("query")
    _add_snapshot_arguments(query)
    query.add_argument("--role", required=True)
    query.set_defaults(handler=_command_query)

    compare_snapshot = commands.add_parser("compare-snapshot")
    _add_snapshot_arguments(compare_snapshot)
    compare_snapshot.add_argument("--role", required=True)
    compare_snapshot.set_defaults(handler=_command_compare_snapshot)

    compare_target = commands.add_parser("compare-target")
    compare_target.add_argument("--role", required=True)
    compare_target.add_argument("--target-package", required=True)
    compare_target.set_defaults(handler=_command_compare_target)
    return parser


def main() -> int:
    try:
        arguments = _build_parser().parse_args()
        return int(arguments.handler(arguments))
    except (RoleStateError, OSError, ValueError, TypeError):
        # Never include exception strings: they can contain snapshot paths or
        # holder values. Detailed diagnostics belong in tests, not device logs.
        sys.stderr.write("android-role-state: invalid or unsafe role state\n")
        return EXIT_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
