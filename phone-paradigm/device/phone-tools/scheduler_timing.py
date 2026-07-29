#!/data/data/com.termux/files/usr/bin/env python3
"""Small, testable timing mechanics for the phone scheduler."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import math
import os
import re
import secrets
import sqlite3
import stat
import sys
import time
import uuid
from pathlib import Path
from typing import Any


CYCLE_FAILURE_BACKOFF_VERSION = 1
DEFAULT_CYCLE_FAILURE_BASE_SECONDS = 5 * 60
DEFAULT_CYCLE_FAILURE_MAX_SECONDS = 2 * 60 * 60
MAX_CYCLE_FAILURE_COUNT = 32
MAX_CYCLE_FAILURE_STATE_BYTES = 512
CURATION_ATTEMPT_VERSION = 1
CURATION_GENERATION_VERSION = 1
CURATION_FAILURE_GENERATION_VERSION = 1
MAX_CURATION_STATE_BYTES = 1024
MAX_CURATION_INPUT_FILE_BYTES = 8 * 1024 * 1024
CURATION_CYCLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$")
CURATION_GENERATION_RE = re.compile(r"^curation-input-v1:[0-9a-f]{64}$")
CURATION_TERMINAL_FAILURES = frozenset(
    {
        "failed",
        "aborted",
        "cancelled",
        "empty",
        "invalid",
        "task_completed_without_receipt",
        "task_failed",
        "task_cancelled",
    }
)
SOURCE_FAILURE_BACKOFF_VERSION = 1
DEFAULT_SOURCE_FAILURE_BASE_SECONDS = 15 * 60
DEFAULT_SOURCE_FAILURE_MAX_SECONDS = 6 * 60 * 60
MAX_SOURCE_FAILURE_COUNT = 32
MAX_SOURCE_FAILURE_STATE_BYTES = 1024
SOURCE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SOURCE_FAILURE_STATE_DIRECTORY = ".source-failure-backoff"
SOURCE_DUE_SIGNAL_DIRECTORY = "source-due-signals"
SOURCE_DUE_SIGNAL_MARKER = b"EVOGENT_SOURCE_DUE_V1\n"
SOURCE_DUE_SIGNAL_PENDING_MODE = 0o400
SOURCE_DUE_SIGNAL_MAX_FUTURE_SKEW_NS = 5 * 60 * 1_000_000_000


class InvalidCycleFailureState(ValueError):
    """An existing state path could not safely authorize an immediate retry."""


def _fsync_parent(path: Path, *, strict: bool = False) -> None:
    try:
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        # Some Android filesystems do not permit fsync on directory descriptors.
        if strict:
            raise


def _open_owned_regular_file(path: Path) -> tuple[int, os.stat_result]:
    """Open one owner-controlled regular file without following a link."""

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError(errno.EINVAL, "reference is not a regular file", path)
        if metadata.st_uid != os.geteuid():
            raise PermissionError(errno.EPERM, "reference is not owner-controlled", path)
        # Timestamp authority is private state. Repair old permissive modes through the already
        # validated descriptor so a pathname swap or symlink can never redirect chmod.
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            os.fchmod(descriptor, 0o600)
            metadata = os.fstat(descriptor)
        return descriptor, metadata
    except BaseException:
        os.close(descriptor)
        raise


def _owned_regular_mtime(path: Path) -> float | None:
    try:
        descriptor, metadata = _open_owned_regular_file(path)
    except OSError:
        return None
    try:
        return metadata.st_mtime
    finally:
        os.close(descriptor)


def _repair_owned_regular_mtime(path: Path, now_seconds: float) -> bool:
    try:
        descriptor, _ = _open_owned_regular_file(path)
    except OSError:
        return False
    try:
        os.utime(descriptor, (now_seconds, now_seconds))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    _fsync_parent(path)
    return True


def advance_cycle_stamp(
    path: Path,
    *,
    now_seconds: float | None = None,
) -> int:
    """Atomically publish a private, file-fsynced cycle clock."""

    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        raise ValueError("cycle stamp time must be a finite nonnegative value")
    epoch_seconds = int(now_seconds)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(8)}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temp, flags, 0o600)
    published = False
    try:
        payload = f"{epoch_seconds}\n".encode()
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise OSError("short write while publishing cycle stamp")
            offset += written
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temp, path)
        published = True
        try:
            _fsync_parent(path, strict=True)
        except OSError:
            # The authoritative path is already atomically visible and its file data is synced.
            # Some Android filesystems reject directory fsync. Retrying a paid cycle cannot
            # improve that filesystem property and would amplify provider spend indefinitely.
            pass
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if not published:
            try:
                temp.unlink()
            except FileNotFoundError:
                pass
    return epoch_seconds


def _atomic_write_private_json(
    path: Path,
    value: dict[str, Any],
    *,
    max_bytes: int = MAX_CYCLE_FAILURE_STATE_BYTES,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        payload = (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode()
        if len(payload) > max_bytes:
            raise ValueError("private timing state exceeds its bounded schema")
        try:
            offset = 0
            while offset < len(payload):
                written = os.write(descriptor, payload[offset:])
                if written <= 0:
                    raise OSError("short write while publishing cycle failure state")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temp, path)
        os.chmod(path, 0o600)
        _fsync_parent(path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _discard_cycle_failure_state(path: Path, *, strict: bool = False) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError:
        if strict:
            raise
        return
    _fsync_parent(path)


def _cycle_failure_bounds(base_seconds: object, max_seconds: object) -> tuple[int, int]:
    try:
        base = int(base_seconds)
    except (TypeError, ValueError):
        base = DEFAULT_CYCLE_FAILURE_BASE_SECONDS
    try:
        maximum = int(max_seconds)
    except (TypeError, ValueError):
        maximum = DEFAULT_CYCLE_FAILURE_MAX_SECONDS
    if maximum < 1 or maximum > DEFAULT_CYCLE_FAILURE_MAX_SECONDS:
        maximum = DEFAULT_CYCLE_FAILURE_MAX_SECONDS
    if base < 1 or base > DEFAULT_CYCLE_FAILURE_MAX_SECONDS:
        base = DEFAULT_CYCLE_FAILURE_BASE_SECONDS
    base = min(base, maximum)
    return base, maximum


def _read_cycle_failure_state(path: Path, *, maximum_seconds: int) -> dict[str, int] | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise InvalidCycleFailureState("cycle failure state could not be inspected") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or metadata.st_size < 2
        or metadata.st_size > MAX_CYCLE_FAILURE_STATE_BYTES
    ):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state has unsafe file metadata")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state could not be opened safely") from error
    try:
        current = os.fstat(descriptor)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
            or current.st_dev != metadata.st_dev
            or current.st_ino != metadata.st_ino
        ):
            _discard_cycle_failure_state(path)
            raise InvalidCycleFailureState("cycle failure state changed while opening")
        if stat.S_IMODE(current.st_mode) != 0o600:
            os.fchmod(descriptor, 0o600)
        payload = os.read(descriptor, MAX_CYCLE_FAILURE_STATE_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(payload) > MAX_CYCLE_FAILURE_STATE_BYTES:
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state exceeds its size bound")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state is not valid JSON")
    expected_keys = {
        "version",
        "consecutiveFailures",
        "delaySeconds",
        "notBeforeEpochSeconds",
        "updatedAtEpochSeconds",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state has an unknown schema")
    if any(type(value[key]) is not int for key in expected_keys):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state fields must be integers")
    try:
        normalized = {key: int(value[key]) for key in expected_keys}
    except (TypeError, ValueError):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state fields are invalid")
    if (
        normalized["version"] != CYCLE_FAILURE_BACKOFF_VERSION
        or not 1 <= normalized["consecutiveFailures"] <= MAX_CYCLE_FAILURE_COUNT
        or not 1 <= normalized["delaySeconds"] <= maximum_seconds
        or normalized["notBeforeEpochSeconds"] < 0
        or normalized["updatedAtEpochSeconds"] < 0
    ):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state values are outside their bounds")
    return normalized


def record_cycle_failure(
    state_path: Path,
    *,
    now_seconds: float | None = None,
    base_seconds: int = DEFAULT_CYCLE_FAILURE_BASE_SECONDS,
    max_seconds: int = DEFAULT_CYCLE_FAILURE_MAX_SECONDS,
) -> dict[str, int]:
    """Persist the next exponential retry boundary before the scheduler sleeps."""

    base, maximum = _cycle_failure_bounds(base_seconds, max_seconds)
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        now_seconds = time.time()
    try:
        previous = _read_cycle_failure_state(state_path, maximum_seconds=maximum)
    except InvalidCycleFailureState:
        # The invalid path was retired above. The failure currently being
        # recorded becomes the first trustworthy bounded generation.
        previous = None
    previous_count = int(previous["consecutiveFailures"]) if previous else 0
    count = min(MAX_CYCLE_FAILURE_COUNT, previous_count + 1)
    exponent = min(count - 1, MAX_CYCLE_FAILURE_COUNT - 1)
    delay = min(maximum, base * (2 ** exponent))
    state = {
        "version": CYCLE_FAILURE_BACKOFF_VERSION,
        "consecutiveFailures": count,
        "delaySeconds": delay,
        "notBeforeEpochSeconds": int(math.ceil(now_seconds + delay)),
        "updatedAtEpochSeconds": int(now_seconds),
    }
    _atomic_write_private_json(state_path, state)
    return state


def cycle_failure_remaining_seconds(
    state_path: Path,
    *,
    now_seconds: float | None = None,
    max_seconds: int = DEFAULT_CYCLE_FAILURE_MAX_SECONDS,
) -> int:
    """Return a bounded persisted delay; repair large future-clock skew once."""

    _, maximum = _cycle_failure_bounds(1, max_seconds)
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        now_seconds = time.time()
    try:
        state = _read_cycle_failure_state(state_path, maximum_seconds=maximum)
    except InvalidCycleFailureState:
        # Missing means no known failure. Existing-but-invalid is different:
        # it may be crash-corrupted guard evidence, so atomically replace it
        # with one conservative base window instead of failing open.
        state = record_cycle_failure(
            state_path,
            now_seconds=now_seconds,
            base_seconds=min(DEFAULT_CYCLE_FAILURE_BASE_SECONDS, maximum),
            max_seconds=maximum,
        )
    if not state:
        return 0
    deadline = int(state["notBeforeEpochSeconds"])
    maximum_deadline = int(math.ceil(now_seconds + maximum))
    if deadline > maximum_deadline:
        # A wall-clock rollback must not suppress cycles forever. Persist the cap
        # so repeated scheduler/watchdog restarts count down one bounded window.
        state["notBeforeEpochSeconds"] = maximum_deadline
        state["delaySeconds"] = maximum
        state["updatedAtEpochSeconds"] = int(now_seconds)
        _atomic_write_private_json(state_path, state)
        deadline = maximum_deadline
    return max(0, min(maximum, int(math.ceil(deadline - now_seconds))))


def clear_cycle_failure_backoff(state_path: Path) -> None:
    """Durably clear consecutive-failure state after a successful cycle."""

    _discard_cycle_failure_state(state_path, strict=True)


def _read_owned_private_json(path: Path, *, max_bytes: int) -> dict[str, Any]:
    """Read one private authority record without following links."""

    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or metadata.st_size < 2
        or metadata.st_size > max_bytes
    ):
        raise ValueError(f"unsafe private state metadata: {path.name}")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        current = os.fstat(descriptor)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
            or current.st_uid != os.geteuid()
            or current.st_dev != metadata.st_dev
            or current.st_ino != metadata.st_ino
        ):
            raise ValueError(f"private state changed while opening: {path.name}")
        if stat.S_IMODE(current.st_mode) != 0o600:
            os.fchmod(descriptor, 0o600)
        payload = b""
        while len(payload) <= max_bytes:
            chunk = os.read(descriptor, min(65536, max_bytes + 1 - len(payload)))
            if not chunk:
                break
            payload += chunk
    finally:
        os.close(descriptor)
    if len(payload) > max_bytes:
        raise ValueError(f"private state exceeds its size bound: {path.name}")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"private state is not valid JSON: {path.name}") from error
    if not isinstance(value, dict):
        raise ValueError(f"private state must be a JSON object: {path.name}")
    return value


def _normalize_curation_cycle_id(value: object) -> str:
    cycle_id = str(value or "").strip()
    if CURATION_CYCLE_ID_RE.fullmatch(cycle_id) is None:
        raise ValueError("invalid curation cycle identity")
    return cycle_id


def _normalize_curation_generation(value: object) -> str:
    generation = str(value or "").strip()
    if CURATION_GENERATION_RE.fullmatch(generation) is None:
        raise ValueError("invalid curation input generation")
    return generation


def _read_curation_attempt(path: Path) -> dict[str, Any] | None:
    try:
        value = _read_owned_private_json(path, max_bytes=MAX_CURATION_STATE_BYTES)
    except FileNotFoundError:
        return None
    expected = {
        "version",
        "cycleId",
        "taskRequestId",
        "createdAtEpochSeconds",
        "updatedAtEpochSeconds",
        "editorialGeneration",
    }
    if set(value) != expected:
        raise ValueError("curation attempt has an unknown schema")
    if value.get("version") != CURATION_ATTEMPT_VERSION:
        raise ValueError("curation attempt has an unknown version")
    cycle_id = _normalize_curation_cycle_id(value.get("cycleId"))
    created = value.get("createdAtEpochSeconds")
    updated = value.get("updatedAtEpochSeconds")
    if type(created) is not int or type(updated) is not int:
        raise ValueError("curation attempt timestamps must be integers")
    if created < 0 or updated < created:
        raise ValueError("curation attempt timestamps are invalid")
    generation_value = value.get("editorialGeneration")
    generation = (
        None
        if generation_value is None
        else _normalize_curation_generation(generation_value)
    )
    task_request_value = value.get("taskRequestId")
    task_request_id = (
        None
        if task_request_value is None
        else _normalize_curation_cycle_id(task_request_value)
    )
    return {
        "version": CURATION_ATTEMPT_VERSION,
        "cycleId": cycle_id,
        "taskRequestId": task_request_id,
        "createdAtEpochSeconds": created,
        "updatedAtEpochSeconds": updated,
        "editorialGeneration": generation,
    }


def ensure_curation_attempt(
    state_path: Path,
    *,
    candidate_cycle_id: str,
    now_seconds: float | None = None,
) -> dict[str, Any]:
    """Retain one exact scheduler curation identity until its receipt is reconciled."""

    existing = _read_curation_attempt(state_path)
    if existing is not None:
        return existing
    cycle_id = _normalize_curation_cycle_id(candidate_cycle_id)
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        raise ValueError("curation attempt time must be finite and nonnegative")
    state = {
        "version": CURATION_ATTEMPT_VERSION,
        "cycleId": cycle_id,
        "taskRequestId": None,
        "createdAtEpochSeconds": int(now_seconds),
        "updatedAtEpochSeconds": int(now_seconds),
        "editorialGeneration": None,
    }
    _atomic_write_private_json(
        state_path,
        state,
        max_bytes=MAX_CURATION_STATE_BYTES,
    )
    return state


def bind_curation_attempt_task(
    state_path: Path,
    *,
    expected_cycle_id: str,
    task_request_id: str,
    now_seconds: float | None = None,
) -> dict[str, Any]:
    """Bind the server's exact acknowledged task id without permitting rebinding."""

    expected = _normalize_curation_cycle_id(expected_cycle_id)
    normalized_task = _normalize_curation_cycle_id(task_request_id)
    state = _read_curation_attempt(state_path)
    if state is None or state["cycleId"] != expected:
        raise ValueError("curation attempt identity does not match")
    existing = state.get("taskRequestId")
    if existing not in (None, normalized_task):
        raise ValueError("curation attempt is already bound to another server task")
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        raise ValueError("curation attempt time must be finite and nonnegative")
    state["taskRequestId"] = normalized_task
    state["updatedAtEpochSeconds"] = max(
        int(state["createdAtEpochSeconds"]),
        int(now_seconds),
    )
    _atomic_write_private_json(
        state_path,
        state,
        max_bytes=MAX_CURATION_STATE_BYTES,
    )
    return state


def bind_curation_attempt_generation(
    state_path: Path,
    *,
    expected_cycle_id: str,
    generation: str,
    replace: bool = False,
    now_seconds: float | None = None,
) -> dict[str, Any]:
    """Bind the exact pre-dispatch editorial generation to one durable attempt."""

    expected = _normalize_curation_cycle_id(expected_cycle_id)
    normalized_generation = _normalize_curation_generation(generation)
    state = _read_curation_attempt(state_path)
    if state is None or state["cycleId"] != expected:
        raise ValueError("curation attempt identity does not match")
    existing = state.get("editorialGeneration")
    if existing not in (None, normalized_generation) and not replace:
        raise ValueError("curation attempt is already bound to another generation")
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        raise ValueError("curation attempt time must be finite and nonnegative")
    state["editorialGeneration"] = normalized_generation
    state["updatedAtEpochSeconds"] = max(
        int(state["createdAtEpochSeconds"]),
        int(now_seconds),
    )
    _atomic_write_private_json(
        state_path,
        state,
        max_bytes=MAX_CURATION_STATE_BYTES,
    )
    return state


def clear_curation_attempt(state_path: Path, *, expected_cycle_id: str) -> None:
    """Retire only the exact reconciled attempt; never clear a newer identity."""

    expected = _normalize_curation_cycle_id(expected_cycle_id)
    state = _read_curation_attempt(state_path)
    if state is None:
        return
    if state["cycleId"] != expected:
        raise ValueError("refusing to clear a different curation attempt")
    _discard_cycle_failure_state(state_path, strict=True)


def _feed_hash_rows(
    digest: "hashlib._Hash",
    label: str,
    rows: list[sqlite3.Row],
) -> None:
    digest.update(label.encode("utf-8"))
    digest.update(b"\0")
    for row in rows:
        payload = json.dumps(
            list(row),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)


def _read_stable_private_input(path: Path) -> bytes | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or metadata.st_size > MAX_CURATION_INPUT_FILE_BYTES
    ):
        raise ValueError(f"unsafe curation input file: {path.name}")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_CURATION_INPUT_FILE_BYTES:
                raise ValueError(f"curation input file is too large: {path.name}")
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise ValueError(f"curation input changed while reading: {path.name}")
    finally:
        os.close(descriptor)
    return b"".join(chunks)


def compute_curation_input_generation(
    database_path: Path,
    *,
    input_files: list[Path] | tuple[Path, ...] = (),
    now_ms: int | None = None,
) -> str:
    """Hash the complete current editorial input set without persisting its content."""

    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    if now_ms < 0:
        raise ValueError("curation generation time must be nonnegative")
    metadata = database_path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
    ):
        raise ValueError("curation database is not a safe owner-controlled file")

    digest = hashlib.sha256()
    digest.update(b"evogent-curation-input-generation-v1\0")
    connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        eligible_rows = connection.execute(
            """
            SELECT
              source, source_id, url, title, author_username, author_display_name,
              published_at_ms, payload_json, fetched_at_ms, expires_at_ms
            FROM browse_cache_items AS cache
            WHERE expires_at_ms >= ?
              AND seen_by_curation_at_ms IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM feed WHERE feed.source_id = cache.source_id
              )
            ORDER BY fetched_at_ms ASC, source ASC, source_id ASC
            """,
            (now_ms,),
        ).fetchall()
        _feed_hash_rows(digest, "eligible-cache", eligible_rows)

        carry_forward_rows = connection.execute(
            """
            SELECT
              f.id, f.type, f.source, f.source_id, f.author_username, f.title,
              f.text, f.excerpt, f.reason, f.url, f.created_at, f.created_at_ms,
              f.published_at, f.display_order, f.thread_id, f.metadata
            FROM feed AS f
            WHERE f.type IN ('tweet', 'article', 'analysis', 'youtube', 'hackernews')
              AND f.parent_id IS NULL
              AND f.id NOT LIKE 'reflection-%'
              AND COALESCE(json_extract(f.metadata, '$.reflectionCycle'), '') = ''
              AND NOT EXISTS (
                SELECT 1
                FROM interactions AS i
                WHERE i.feed_item_id = f.id
                  AND i.action IN (
                    'view', 'expand', 'like', 'thumbsup', 'dislike', 'thumbsdown',
                    'thread_feedback', 'suggestion_dismissed', 'suggestion_accepted'
                  )
              )
            ORDER BY
              CASE WHEN f.display_order IS NULL THEN 1 ELSE 0 END ASC,
              f.display_order ASC,
              f.rowid ASC,
              f.id ASC
            """,
        ).fetchall()
        _feed_hash_rows(digest, "carry-forward", carry_forward_rows)

        preference_rows = connection.execute(
            """
            SELECT
              id, feed_item_id, signal_type, source, text, reason,
              author_username, weight, source_id, created_at
            FROM preferences
            ORDER BY id ASC
            """
        ).fetchall()
        _feed_hash_rows(digest, "preferences", preference_rows)

        feedback_rows = connection.execute(
            """
            SELECT
              id, thread_id, cycle_id, feed_item_id, vote, thread_title, reason,
              category, probe_reason, probe_uncertainty, source_item_ids,
              origin_session_id, created_at
            FROM thread_feedback
            ORDER BY id ASC
            """
        ).fetchall()
        _feed_hash_rows(digest, "thread-feedback", feedback_rows)
        connection.rollback()
    finally:
        connection.close()

    for index, path in enumerate(input_files):
        payload = _read_stable_private_input(path)
        digest.update(f"file-{index}".encode("ascii"))
        digest.update(b"\0")
        if payload is None:
            digest.update(b"missing\0")
        else:
            digest.update(b"present\0")
            digest.update(len(payload).to_bytes(8, "big"))
            digest.update(payload)
    return f"curation-input-v1:{digest.hexdigest()}"


def _read_published_curation_generation(path: Path) -> str | None:
    try:
        value = _read_owned_private_json(path, max_bytes=MAX_CURATION_STATE_BYTES)
    except FileNotFoundError:
        return None
    if set(value) != {"version", "generation", "updatedAtEpochSeconds"}:
        raise ValueError("published curation generation has an unknown schema")
    if value.get("version") != CURATION_GENERATION_VERSION:
        raise ValueError("published curation generation has an unknown version")
    updated = value.get("updatedAtEpochSeconds")
    if type(updated) is not int or updated < 0:
        raise ValueError("published curation generation has an invalid timestamp")
    return _normalize_curation_generation(value.get("generation"))


def compare_curation_generation(path: Path, generation: str) -> str:
    normalized = _normalize_curation_generation(generation)
    existing = _read_published_curation_generation(path)
    if existing is None:
        return "missing"
    return "unchanged" if existing == normalized else "changed"


def publish_curation_generation(
    path: Path,
    generation: str,
    *,
    now_seconds: float | None = None,
) -> None:
    normalized = _normalize_curation_generation(generation)
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        raise ValueError("curation generation time must be finite and nonnegative")
    _atomic_write_private_json(
        path,
        {
            "version": CURATION_GENERATION_VERSION,
            "generation": normalized,
            "updatedAtEpochSeconds": int(now_seconds),
        },
        max_bytes=MAX_CURATION_STATE_BYTES,
    )


def _read_failed_curation_generation(path: Path) -> dict[str, Any] | None:
    try:
        value = _read_owned_private_json(path, max_bytes=MAX_CURATION_STATE_BYTES)
    except FileNotFoundError:
        return None
    expected = {
        "version",
        "generation",
        "terminalStatus",
        "failedAtEpochSeconds",
    }
    if set(value) != expected:
        raise ValueError("failed curation generation has an unknown schema")
    if value.get("version") != CURATION_FAILURE_GENERATION_VERSION:
        raise ValueError("failed curation generation has an unknown version")
    failed_at = value.get("failedAtEpochSeconds")
    if type(failed_at) is not int or failed_at < 0:
        raise ValueError("failed curation generation has an invalid timestamp")
    terminal_status = str(value.get("terminalStatus") or "")
    if terminal_status not in CURATION_TERMINAL_FAILURES:
        raise ValueError("failed curation generation has an invalid terminal status")
    return {
        "version": CURATION_FAILURE_GENERATION_VERSION,
        "generation": _normalize_curation_generation(value.get("generation")),
        "terminalStatus": terminal_status,
        "failedAtEpochSeconds": failed_at,
    }


def compare_failed_curation_generation(path: Path, generation: str) -> str:
    """Classify whether automation already spent on this exact failed input set."""

    normalized = _normalize_curation_generation(generation)
    existing = _read_failed_curation_generation(path)
    if existing is None:
        return "missing"
    return "failed_unchanged" if existing["generation"] == normalized else "changed"


def record_failed_curation_generation(
    path: Path,
    generation: str,
    terminal_status: str,
    *,
    now_seconds: float | None = None,
) -> None:
    """Latch exact accepted work that reached an unsuccessful terminal outcome."""

    normalized = _normalize_curation_generation(generation)
    normalized_status = str(terminal_status or "").strip().lower()
    if normalized_status not in CURATION_TERMINAL_FAILURES:
        raise ValueError("terminal curation failure status is not recognized")
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        raise ValueError("failed curation generation time must be finite and nonnegative")
    _atomic_write_private_json(
        path,
        {
            "version": CURATION_FAILURE_GENERATION_VERSION,
            "generation": normalized,
            "terminalStatus": normalized_status,
            "failedAtEpochSeconds": int(now_seconds),
        },
        max_bytes=MAX_CURATION_STATE_BYTES,
    )


def clear_failed_curation_generation(path: Path) -> None:
    """Retire an obsolete failure latch after exact successful publication."""

    _discard_cycle_failure_state(path, strict=True)


def _normalize_source_name(value: object) -> str:
    source = str(value or "").strip()
    if SOURCE_NAME_RE.fullmatch(source) is None:
        raise ValueError("invalid source failure-backoff identity")
    return source


def _validated_source_failure_path(path: Path, source: str) -> Path:
    normalized = _normalize_source_name(source)
    if (
        path.name != f"{normalized}.json"
        or path.parent.name != SOURCE_FAILURE_STATE_DIRECTORY
    ):
        raise ValueError("source failure-backoff path does not match its identity")
    return path


def _ensure_private_source_failure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = path.parent.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
    ):
        raise ValueError("source failure-backoff directory is not owner-controlled")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        os.chmod(path.parent, 0o700)


def _source_failure_bounds(base_seconds: object, max_seconds: object) -> tuple[int, int]:
    try:
        base = int(base_seconds)
    except (TypeError, ValueError):
        base = DEFAULT_SOURCE_FAILURE_BASE_SECONDS
    try:
        maximum = int(max_seconds)
    except (TypeError, ValueError):
        maximum = DEFAULT_SOURCE_FAILURE_MAX_SECONDS
    if maximum < 1 or maximum > DEFAULT_SOURCE_FAILURE_MAX_SECONDS:
        maximum = DEFAULT_SOURCE_FAILURE_MAX_SECONDS
    if base < 1 or base > DEFAULT_SOURCE_FAILURE_MAX_SECONDS:
        base = DEFAULT_SOURCE_FAILURE_BASE_SECONDS
    return min(base, maximum), maximum


def _read_source_failure_state(
    path: Path,
    source: str,
    *,
    maximum_seconds: int,
) -> dict[str, Any] | None:
    path = _validated_source_failure_path(path, source)
    try:
        value = _read_owned_private_json(
            path,
            max_bytes=MAX_SOURCE_FAILURE_STATE_BYTES,
        )
    except FileNotFoundError:
        return None
    expected = {
        "version",
        "source",
        "consecutiveFailures",
        "delaySeconds",
        "notBeforeEpochSeconds",
        "attemptStartedEpochNs",
        "updatedAtEpochSeconds",
    }
    if set(value) != expected:
        raise ValueError("source failure-backoff state has an unknown schema")
    integer_keys = expected - {"source"}
    if any(type(value.get(key)) is not int for key in integer_keys):
        raise ValueError("source failure-backoff fields must be integers")
    normalized_source = _normalize_source_name(value.get("source"))
    if normalized_source != source:
        raise ValueError("source failure-backoff state has the wrong identity")
    if (
        value["version"] != SOURCE_FAILURE_BACKOFF_VERSION
        or not 1 <= value["consecutiveFailures"] <= MAX_SOURCE_FAILURE_COUNT
        or not 1 <= value["delaySeconds"] <= maximum_seconds
        or value["notBeforeEpochSeconds"] < 0
        or value["attemptStartedEpochNs"] <= 0
        or value["updatedAtEpochSeconds"] < 0
    ):
        raise ValueError("source failure-backoff values are outside their bounds")
    return value


def _private_source_signal_generation_ns(
    source: str,
    signal_path: Path | None,
    *,
    now_ns: int,
) -> int | None:
    """Read one exact content-free signal generation without following path links."""

    if signal_path is None:
        return None
    normalized_source = _normalize_source_name(source)
    if (
        signal_path.name != f"{normalized_source}.due"
        or signal_path.parent.name != SOURCE_DUE_SIGNAL_DIRECTORY
    ):
        return None
    owner_uid = os.getuid()
    try:
        parent_metadata = signal_path.parent.lstat()
    except OSError:
        return None
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or stat.S_ISLNK(parent_metadata.st_mode)
        or stat.S_IMODE(parent_metadata.st_mode) != 0o700
        or parent_metadata.st_uid != owner_uid
    ):
        return None
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory_flag = getattr(os, "O_DIRECTORY", 0)
    if not nofollow or not directory_flag:
        return None
    parent_descriptor = -1
    signal_descriptor = -1
    try:
        parent_descriptor = os.open(
            signal_path.parent,
            os.O_RDONLY | nofollow | directory_flag,
        )
        opened_parent = os.fstat(parent_descriptor)
        if (
            not stat.S_ISDIR(opened_parent.st_mode)
            or stat.S_IMODE(opened_parent.st_mode) != 0o700
            or opened_parent.st_uid != owner_uid
            or opened_parent.st_dev != parent_metadata.st_dev
            or opened_parent.st_ino != parent_metadata.st_ino
        ):
            return None
        signal_descriptor = os.open(
            signal_path.name,
            os.O_RDONLY | nofollow,
            dir_fd=parent_descriptor,
        )
        metadata = os.fstat(signal_descriptor)
        signal_mode = stat.S_IMODE(metadata.st_mode)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or signal_mode not in (0o600, SOURCE_DUE_SIGNAL_PENDING_MODE)
            or metadata.st_uid != owner_uid
            or metadata.st_nlink != 1
            or metadata.st_size != len(SOURCE_DUE_SIGNAL_MARKER)
        ):
            return None
        marker = os.read(signal_descriptor, len(SOURCE_DUE_SIGNAL_MARKER) + 1)
        current_parent = signal_path.parent.lstat()
        current_final = os.stat(
            signal_path.name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            stat.S_ISLNK(current_final.st_mode)
            or current_parent.st_dev != opened_parent.st_dev
            or current_parent.st_ino != opened_parent.st_ino
            or current_final.st_dev != metadata.st_dev
            or current_final.st_ino != metadata.st_ino
        ):
            return None
    except OSError:
        return None
    finally:
        if signal_descriptor >= 0:
            os.close(signal_descriptor)
        if parent_descriptor >= 0:
            os.close(parent_descriptor)
    if marker != SOURCE_DUE_SIGNAL_MARKER:
        return None
    generation_ns = (
        metadata.st_ctime_ns
        if signal_mode == SOURCE_DUE_SIGNAL_PENDING_MODE
        else metadata.st_mtime_ns
    )
    if (
        signal_mode != SOURCE_DUE_SIGNAL_PENDING_MODE
        and generation_ns > now_ns
    ):
        # Cadence tolerates small future skew so a valid marker is not lost. Failure
        # override is stricter: wait until local time reaches that generation, otherwise
        # one future-dated marker could appear newer than several failed attempts.
        return None
    return generation_ns


def record_source_failure_backoff(
    state_path: Path,
    source: str,
    *,
    attempt_started_ns: int,
    now_seconds: float | None = None,
    base_seconds: int = DEFAULT_SOURCE_FAILURE_BASE_SECONDS,
    max_seconds: int = DEFAULT_SOURCE_FAILURE_MAX_SECONDS,
) -> dict[str, Any]:
    """Persist a source-local retry boundary without advancing success freshness."""

    normalized_source = _normalize_source_name(source)
    state_path = _validated_source_failure_path(state_path, normalized_source)
    base, maximum = _source_failure_bounds(base_seconds, max_seconds)
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        now_seconds = time.time()
    if (
        isinstance(attempt_started_ns, bool)
        or not isinstance(attempt_started_ns, int)
        or attempt_started_ns <= 0
        or attempt_started_ns
        > int(now_seconds * 1_000_000_000) + SOURCE_DUE_SIGNAL_MAX_FUTURE_SKEW_NS
    ):
        raise ValueError("invalid source failure attempt-start generation")
    try:
        previous = _read_source_failure_state(
            state_path,
            normalized_source,
            maximum_seconds=maximum,
        )
    except ValueError:
        previous = None
    previous_count = int(previous["consecutiveFailures"]) if previous else 0
    count = min(MAX_SOURCE_FAILURE_COUNT, previous_count + 1)
    delay = min(maximum, base * (2 ** min(count - 1, MAX_SOURCE_FAILURE_COUNT - 1)))
    state = {
        "version": SOURCE_FAILURE_BACKOFF_VERSION,
        "source": normalized_source,
        "consecutiveFailures": count,
        "delaySeconds": delay,
        "notBeforeEpochSeconds": int(math.ceil(now_seconds + delay)),
        "attemptStartedEpochNs": attempt_started_ns,
        "updatedAtEpochSeconds": int(now_seconds),
    }
    _ensure_private_source_failure_parent(state_path)
    _atomic_write_private_json(
        state_path,
        state,
        max_bytes=MAX_SOURCE_FAILURE_STATE_BYTES,
    )
    return state


def source_failure_admission(
    state_path: Path,
    source: str,
    *,
    signal_path: Path | None = None,
    manual_override: bool = False,
    now_seconds: float | None = None,
    base_seconds: int = DEFAULT_SOURCE_FAILURE_BASE_SECONDS,
    max_seconds: int = DEFAULT_SOURCE_FAILURE_MAX_SECONDS,
) -> tuple[str, int]:
    """Admit due source work after its independent failure-retry policy."""

    normalized_source = _normalize_source_name(source)
    state_path = _validated_source_failure_path(state_path, normalized_source)
    base, maximum = _source_failure_bounds(base_seconds, max_seconds)
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        now_seconds = time.time()
    try:
        state = _read_source_failure_state(
            state_path,
            normalized_source,
            maximum_seconds=maximum,
        )
    except ValueError:
        # Existing-but-invalid evidence may be a torn guard. Replace it with a
        # conservative source-local window instead of reopening provider spend.
        state = record_source_failure_backoff(
            state_path,
            normalized_source,
            attempt_started_ns=max(1, int(now_seconds * 1_000_000_000)),
            now_seconds=now_seconds,
            base_seconds=base,
            max_seconds=maximum,
        )
    if state is None:
        return "ready", 0
    deadline = int(state["notBeforeEpochSeconds"])
    maximum_deadline = int(math.ceil(now_seconds + maximum))
    if deadline > maximum_deadline:
        state["notBeforeEpochSeconds"] = maximum_deadline
        state["delaySeconds"] = maximum
        state["updatedAtEpochSeconds"] = int(now_seconds)
        _ensure_private_source_failure_parent(state_path)
        _atomic_write_private_json(
            state_path,
            state,
            max_bytes=MAX_SOURCE_FAILURE_STATE_BYTES,
        )
        deadline = maximum_deadline
    remaining = max(0, min(maximum, int(math.ceil(deadline - now_seconds))))
    if remaining == 0:
        return "ready", 0
    if manual_override:
        return "manual_override", 0
    signal_generation = _private_source_signal_generation_ns(
        normalized_source,
        signal_path,
        now_ns=int(now_seconds * 1_000_000_000),
    )
    if (
        signal_generation is not None
        and signal_generation > int(state["attemptStartedEpochNs"])
    ):
        return "source_signal_override", 0
    return "backoff", remaining


def clear_source_failure_backoff(state_path: Path, source: str) -> None:
    """Retire only the exact source's failure state after a successful refresh."""

    _validated_source_failure_path(state_path, _normalize_source_name(source))
    _discard_cycle_failure_state(state_path, strict=True)


def nightly_task_admission(
    ensured: dict[str, Any],
    root: Path,
    *,
    now_ms: int | None = None,
) -> tuple[str, str, int]:
    """Classify exact nightly state before the global Termux wake is acquired."""

    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    task_id = str(ensured.get("taskId") or "").strip()
    due_at_ms = ensured.get("dueAtMs")
    if (
        not task_id
        or safe_task_component(task_id) != task_id
        or type(due_at_ms) is not int
        or due_at_ms < 0
    ):
        raise ValueError("nightly ensure result is missing exact due authority")
    expected_queue = root / f"{task_id}.json"
    if str(ensured.get("path") or "") != str(expected_queue):
        raise ValueError("nightly ensure result path does not match its exact task")

    candidates = (
        ("queued", expected_queue),
        ("leased", root / ".leased" / f"{task_id}.json"),
        ("acknowledged", root / ".receipts" / f"{task_id}-final.json"),
        ("quarantined", root / ".quarantine" / f"{task_id}.json"),
    )
    existing = [(label, path) for label, path in candidates if path.exists()]
    terminals = [
        (label, path)
        for label, path in existing
        if label in {"acknowledged", "quarantined"}
    ]
    if len(terminals) == 1:
        label, path = terminals[0]
        value = _read_owned_private_json(path, max_bytes=MAX_CURATION_STATE_BYTES)
        if (
            str(value.get("taskId") or "") != task_id
            or str(value.get("state") or "") != label
        ):
            raise ValueError("nightly terminal record has the wrong identity or state")
        # A terminal receipt dominates a crash-replayed base or lease. Claim would reap the
        # duplicate, but no provider work is due and therefore no wake reference is justified.
        return "terminal", label, int(due_at_ms)
    if len(terminals) > 1 or len(existing) != 1:
        raise ValueError("nightly task has ambiguous or missing durable state")
    label, path = existing[0]
    value = _read_owned_private_json(path, max_bytes=MAX_CURATION_STATE_BYTES)
    if str(value.get("taskId") or "") != task_id:
        raise ValueError("nightly task record has the wrong identity")
    record_state = str(value.get("state") or "")
    if label == "queued":
        if record_state != "queued":
            raise ValueError("nightly queue record has the wrong state")
        not_before_ms = value.get("notBeforeMs")
        if type(not_before_ms) is not int or not_before_ms < due_at_ms:
            raise ValueError("nightly queue record has an invalid due boundary")
        if now_ms < max(due_at_ms, not_before_ms):
            return "not_due", record_state, int(due_at_ms)
        return "due", record_state, int(due_at_ms)

    if record_state != "leased" or not isinstance(value.get("lease"), dict):
        raise ValueError("nightly lease record has the wrong state")
    expires_at_ms = value["lease"].get("expiresAtMs")
    if type(expires_at_ms) is not int or expires_at_ms <= 0:
        raise ValueError("nightly lease record has no valid expiry")
    if now_ms < due_at_ms or now_ms < expires_at_ms:
        return "leased", record_state, int(due_at_ms)
    return "due_recovery", record_state, int(due_at_ms)


def safe_task_component(value: object) -> str:
    """Validate the queue's already-normalized, public task filename component."""

    text = str(value or "")
    if (
        not text
        or len(text) > 180
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", text) is None
    ):
        return ""
    return text


def _positive_integer_minutes(value: object, fallback: int) -> int:
    """Normalize a human/operator numeric value for Bash integer arithmetic."""

    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(numeric) or numeric <= 0:
        return fallback
    # Round upward: a fractional minimum must not dispatch earlier than requested, and sub-minute
    # values must never normalize to the invalid integer zero.
    return max(1, math.ceil(numeric))


def normalize_scheduler_bounds(
    minimum_value: object,
    maximum_value: object,
    *,
    fixed_value: object | None = None,
    default_minimum: int = 120,
    default_maximum: int = 720,
) -> tuple[int, int]:
    """Return safe positive integer minute bounds, honoring a valid legacy fixed interval."""

    fallback_minimum = _positive_integer_minutes(default_minimum, 120)
    fallback_maximum = _positive_integer_minutes(default_maximum, 720)
    minimum = _positive_integer_minutes(minimum_value, fallback_minimum)
    maximum = _positive_integer_minutes(maximum_value, fallback_maximum)

    fixed_text = "" if fixed_value is None else str(fixed_value).strip()
    if fixed_text:
        try:
            fixed_numeric = float(fixed_text)
        except (TypeError, ValueError):
            fixed_numeric = math.nan
        if math.isfinite(fixed_numeric) and fixed_numeric > 0:
            fixed = max(1, math.ceil(fixed_numeric))
            return fixed, fixed

    # A contradictory pair should remain safe and honor the battery floor. Raising the ceiling
    # to the normalized floor is less surprising than silently shortening the requested minimum.
    maximum = max(minimum, maximum)
    return minimum, maximum


def initial_floor_remaining_seconds(
    completion_stamp: Path,
    *,
    minimum_interval_minutes: float,
    now_seconds: float | None = None,
) -> int:
    """Seconds until a restarted scheduler may run another completed-cycle follow-up."""

    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    minimum = float(minimum_interval_minutes)
    if not math.isfinite(minimum) or minimum < 0:
        minimum = 0
    completed_at = _owned_regular_mtime(completion_stamp)
    if completed_at is None:
        return 0
    # A large future timestamp is clock-skew evidence, not authority to suppress work forever.
    if completed_at > now_seconds + 60:
        # Persist one repaired clock. Merely capping in memory would reset the full minimum on
        # every scheduler poll and could defer provider work forever after backward clock skew.
        if not _repair_owned_regular_mtime(completion_stamp, now_seconds):
            return 0
        completed_at = now_seconds
    remaining = completed_at + minimum * 60 - now_seconds
    return max(0, math.ceil(remaining))


def ensure_watchdog_completion_reference(
    completed_cycle_stamp: Path,
    legacy_successful_cycle_stamp: Path | None,
    missing_completion_baseline: Path,
    *,
    now_seconds: float | None = None,
) -> Path:
    """Return the liveness clock, with a safe pre-upgrade success-stamp fallback."""

    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if _owned_regular_mtime(completed_cycle_stamp) is not None:
        try:
            missing_completion_baseline.unlink()
        except FileNotFoundError:
            pass
        return completed_cycle_stamp
    if (
        legacy_successful_cycle_stamp is not None
        and _owned_regular_mtime(legacy_successful_cycle_stamp) is not None
    ):
        try:
            missing_completion_baseline.unlink()
        except FileNotFoundError:
            pass
        return legacy_successful_cycle_stamp

    missing_completion_baseline.parent.mkdir(parents=True, exist_ok=True)
    existing_mtime = _owned_regular_mtime(missing_completion_baseline)
    if existing_mtime is None:
        try:
            metadata = missing_completion_baseline.lstat()
        except FileNotFoundError:
            metadata = None
        if metadata is not None:
            # A same-owner link is not authority. Removing the directory entry is safe and does
            # not touch its target. Refuse other non-regular or foreign entries instead of
            # mutating an object we cannot prove belongs to this runtime.
            if stat.S_ISLNK(metadata.st_mode) and metadata.st_uid == os.geteuid():
                missing_completion_baseline.unlink()
            else:
                raise OSError(
                    errno.EINVAL,
                    "unsafe watchdog completion baseline",
                    missing_completion_baseline,
                )
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(missing_completion_baseline, flags, 0o600)
        try:
            os.write(descriptor, f"{int(now_seconds)}\n".encode())
            os.fchmod(descriptor, 0o600)
            os.utime(descriptor, (now_seconds, now_seconds))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _fsync_parent(missing_completion_baseline)
    return missing_completion_baseline


def watchdog_completion_reference_overdue(
    reference: Path,
    *,
    overdue_minutes: float,
    now_seconds: float | None = None,
) -> bool:
    """Whether neither a completed cycle nor the first-observation grace is recent."""

    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    overdue = float(overdue_minutes)
    if not math.isfinite(overdue) or overdue < 0:
        overdue = 0
    observed_at = _owned_regular_mtime(reference)
    if observed_at is None:
        return False
    if observed_at > now_seconds + 60:
        # Repair clock-skew evidence once instead of letting a future stamp suppress liveness
        # forever by being re-capped to "now" on every watchdog tick.
        if not _repair_owned_regular_mtime(reference, now_seconds):
            return False
        observed_at = now_seconds
    return now_seconds - observed_at > overdue * 60


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--advance-cycle-stamp")
    parser.add_argument("--completion-stamp")
    parser.add_argument("--minimum-minutes", type=float)
    parser.add_argument("--watchdog-completion-stamp")
    parser.add_argument("--watchdog-legacy-success-stamp")
    parser.add_argument("--watchdog-missing-baseline")
    parser.add_argument("--watchdog-overdue-minutes", type=float)
    parser.add_argument("--scheduler-bounds", action="store_true")
    parser.add_argument("--scheduler-minimum-value")
    parser.add_argument("--scheduler-maximum-value")
    parser.add_argument("--scheduler-fixed-value")
    parser.add_argument("--cycle-failure-state")
    parser.add_argument(
        "--cycle-failure-action",
        choices=("remaining", "record-failure", "clear"),
    )
    parser.add_argument(
        "--cycle-failure-base-seconds",
        type=int,
        default=DEFAULT_CYCLE_FAILURE_BASE_SECONDS,
    )
    parser.add_argument(
        "--cycle-failure-max-seconds",
        type=int,
        default=DEFAULT_CYCLE_FAILURE_MAX_SECONDS,
    )
    parser.add_argument("--curation-attempt-state")
    parser.add_argument(
        "--curation-attempt-action",
        choices=("ensure", "inspect", "bind-generation", "bind-task", "clear"),
    )
    parser.add_argument("--curation-attempt-cycle-id")
    parser.add_argument("--curation-attempt-generation")
    parser.add_argument("--curation-attempt-task-id")
    parser.add_argument("--curation-attempt-replace-generation", action="store_true")
    parser.add_argument("--curation-generation-db")
    parser.add_argument("--curation-generation-file", action="append", default=[])
    parser.add_argument("--curation-generation-state")
    parser.add_argument(
        "--curation-generation-action",
        choices=("compute", "compare", "publish"),
    )
    parser.add_argument("--curation-generation-value")
    parser.add_argument("--curation-failure-generation-state")
    parser.add_argument(
        "--curation-failure-generation-action",
        choices=("compare", "record", "clear"),
    )
    parser.add_argument("--curation-failure-generation-value")
    parser.add_argument("--curation-failure-terminal-status")
    parser.add_argument("--source-failure-state")
    parser.add_argument(
        "--source-failure-action",
        choices=("admit", "record-failure", "clear"),
    )
    parser.add_argument("--source-failure-source")
    parser.add_argument("--source-failure-signal")
    parser.add_argument("--source-failure-attempt-start-ns", type=int)
    parser.add_argument("--source-failure-manual-override", action="store_true")
    parser.add_argument(
        "--source-failure-base-seconds",
        type=int,
        default=DEFAULT_SOURCE_FAILURE_BASE_SECONDS,
    )
    parser.add_argument(
        "--source-failure-max-seconds",
        type=int,
        default=DEFAULT_SOURCE_FAILURE_MAX_SECONDS,
    )
    parser.add_argument("--nightly-admission-root")
    parser.add_argument("--now-ms", type=int)
    parser.add_argument("--now-seconds", type=float)
    args = parser.parse_args(argv)
    if args.advance_cycle_stamp:
        print(
            advance_cycle_stamp(
                Path(args.advance_cycle_stamp),
                now_seconds=args.now_seconds,
            )
        )
        return 0
    if args.cycle_failure_action:
        if not args.cycle_failure_state:
            parser.error("--cycle-failure-state is required with --cycle-failure-action")
        state_path = Path(args.cycle_failure_state)
        if args.cycle_failure_action == "remaining":
            print(
                cycle_failure_remaining_seconds(
                    state_path,
                    now_seconds=args.now_seconds,
                    max_seconds=args.cycle_failure_max_seconds,
                )
            )
        elif args.cycle_failure_action == "record-failure":
            state = record_cycle_failure(
                state_path,
                now_seconds=args.now_seconds,
                base_seconds=args.cycle_failure_base_seconds,
                max_seconds=args.cycle_failure_max_seconds,
            )
            print(state["delaySeconds"])
        else:
            clear_cycle_failure_backoff(state_path)
            print(0)
        return 0
    if args.curation_attempt_action:
        if not args.curation_attempt_state:
            parser.error(
                "--curation-attempt-state is required with --curation-attempt-action"
            )
        state_path = Path(args.curation_attempt_state)
        if args.curation_attempt_action == "ensure":
            if not args.curation_attempt_cycle_id:
                parser.error("--curation-attempt-cycle-id is required with ensure")
            state = ensure_curation_attempt(
                state_path,
                candidate_cycle_id=args.curation_attempt_cycle_id,
                now_seconds=args.now_seconds,
            )
        elif args.curation_attempt_action == "inspect":
            state = _read_curation_attempt(state_path)
            if state is None:
                raise ValueError("curation attempt is missing")
            if (
                args.curation_attempt_cycle_id
                and state["cycleId"]
                != _normalize_curation_cycle_id(args.curation_attempt_cycle_id)
            ):
                raise ValueError("curation attempt identity does not match")
        elif args.curation_attempt_action == "bind-generation":
            if not args.curation_attempt_cycle_id or not args.curation_attempt_generation:
                parser.error(
                    "--curation-attempt-cycle-id and --curation-attempt-generation "
                    "are required with bind-generation"
                )
            state = bind_curation_attempt_generation(
                state_path,
                expected_cycle_id=args.curation_attempt_cycle_id,
                generation=args.curation_attempt_generation,
                replace=args.curation_attempt_replace_generation,
                now_seconds=args.now_seconds,
            )
        elif args.curation_attempt_action == "bind-task":
            if not args.curation_attempt_cycle_id or not args.curation_attempt_task_id:
                parser.error(
                    "--curation-attempt-cycle-id and --curation-attempt-task-id "
                    "are required with bind-task"
                )
            state = bind_curation_attempt_task(
                state_path,
                expected_cycle_id=args.curation_attempt_cycle_id,
                task_request_id=args.curation_attempt_task_id,
                now_seconds=args.now_seconds,
            )
        else:
            if not args.curation_attempt_cycle_id:
                parser.error("--curation-attempt-cycle-id is required with clear")
            clear_curation_attempt(
                state_path,
                expected_cycle_id=args.curation_attempt_cycle_id,
            )
            print("cleared")
            return 0
        print(
            f"{state['cycleId']}\t"
            f"{state.get('editorialGeneration') or ''}\t"
            f"{state.get('taskRequestId') or ''}"
        )
        return 0
    if args.curation_generation_action:
        if args.curation_generation_action == "compute":
            if not args.curation_generation_db:
                parser.error("--curation-generation-db is required with compute")
            print(
                compute_curation_input_generation(
                    Path(args.curation_generation_db),
                    input_files=[
                        Path(value) for value in args.curation_generation_file
                    ],
                    now_ms=args.now_ms,
                )
            )
            return 0
        if not args.curation_generation_state or not args.curation_generation_value:
            parser.error(
                "--curation-generation-state and --curation-generation-value "
                "are required with compare/publish"
            )
        generation_state = Path(args.curation_generation_state)
        if args.curation_generation_action == "compare":
            print(
                compare_curation_generation(
                    generation_state,
                    args.curation_generation_value,
                )
            )
        else:
            publish_curation_generation(
                generation_state,
                args.curation_generation_value,
                now_seconds=args.now_seconds,
            )
            print("published")
        return 0
    if args.curation_failure_generation_action:
        if not args.curation_failure_generation_state:
            parser.error(
                "--curation-failure-generation-state is required with "
                "--curation-failure-generation-action"
            )
        failure_state = Path(args.curation_failure_generation_state)
        if args.curation_failure_generation_action == "clear":
            clear_failed_curation_generation(failure_state)
            print("cleared")
            return 0
        if not args.curation_failure_generation_value:
            parser.error(
                "--curation-failure-generation-value is required with compare/record"
            )
        if args.curation_failure_generation_action == "compare":
            print(
                compare_failed_curation_generation(
                    failure_state,
                    args.curation_failure_generation_value,
                )
            )
        else:
            if not args.curation_failure_terminal_status:
                parser.error(
                    "--curation-failure-terminal-status is required with record"
                )
            record_failed_curation_generation(
                failure_state,
                args.curation_failure_generation_value,
                args.curation_failure_terminal_status,
                now_seconds=args.now_seconds,
            )
            print("recorded")
        return 0
    if args.source_failure_action:
        if not args.source_failure_state or not args.source_failure_source:
            parser.error(
                "--source-failure-state and --source-failure-source are required "
                "with --source-failure-action"
            )
        source_failure_state = Path(args.source_failure_state)
        if args.source_failure_action == "admit":
            action, remaining = source_failure_admission(
                source_failure_state,
                args.source_failure_source,
                signal_path=(
                    Path(args.source_failure_signal)
                    if args.source_failure_signal
                    else None
                ),
                manual_override=args.source_failure_manual_override,
                now_seconds=args.now_seconds,
                base_seconds=args.source_failure_base_seconds,
                max_seconds=args.source_failure_max_seconds,
            )
            print(f"{action}\t{remaining}")
        elif args.source_failure_action == "record-failure":
            if args.source_failure_attempt_start_ns is None:
                parser.error(
                    "--source-failure-attempt-start-ns is required with record-failure"
                )
            state = record_source_failure_backoff(
                source_failure_state,
                args.source_failure_source,
                attempt_started_ns=args.source_failure_attempt_start_ns,
                now_seconds=args.now_seconds,
                base_seconds=args.source_failure_base_seconds,
                max_seconds=args.source_failure_max_seconds,
            )
            print(state["delaySeconds"])
        else:
            clear_source_failure_backoff(
                source_failure_state,
                args.source_failure_source,
            )
            print(0)
        return 0
    if args.nightly_admission_root:
        try:
            ensured = json.load(sys.stdin)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("nightly ensure result is not valid JSON") from error
        if not isinstance(ensured, dict):
            raise ValueError("nightly ensure result must be an object")
        action, state, due_at_ms = nightly_task_admission(
            ensured,
            Path(args.nightly_admission_root),
            now_ms=args.now_ms,
        )
        print(f"{action}\t{state}\t{due_at_ms}")
        return 0
    if args.scheduler_bounds:
        minimum, maximum = normalize_scheduler_bounds(
            args.scheduler_minimum_value,
            args.scheduler_maximum_value,
            fixed_value=args.scheduler_fixed_value,
        )
        print(f"{minimum}\t{maximum}")
        return 0
    if args.watchdog_completion_stamp:
        if not args.watchdog_missing_baseline or args.watchdog_overdue_minutes is None:
            parser.error(
                "--watchdog-missing-baseline and --watchdog-overdue-minutes are required "
                "with --watchdog-completion-stamp"
            )
        reference = ensure_watchdog_completion_reference(
            Path(args.watchdog_completion_stamp),
            (
                Path(args.watchdog_legacy_success_stamp)
                if args.watchdog_legacy_success_stamp
                else None
            ),
            Path(args.watchdog_missing_baseline),
            now_seconds=args.now_seconds,
        )
        overdue = watchdog_completion_reference_overdue(
            reference,
            overdue_minutes=args.watchdog_overdue_minutes,
            now_seconds=args.now_seconds,
        )
        # This is a tiny machine-readable protocol shared with evogent-watchdog.sh.
        # Include the selected clock so the shell cannot accidentally confuse a path with
        # the overdue bit (or silently lose the bit while changing diagnostics).
        print(f"{reference}\t{1 if overdue else 0}")
        return 0
    if not args.completion_stamp or args.minimum_minutes is None:
        parser.error("--completion-stamp and --minimum-minutes are required")
    print(initial_floor_remaining_seconds(
        Path(args.completion_stamp),
        minimum_interval_minutes=args.minimum_minutes,
        now_seconds=args.now_seconds,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
