#!/data/data/com.termux/files/usr/bin/env python3
"""Postconditions for scheduler-owned private learning artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import secrets
import stat
from pathlib import Path
from typing import Literal


MAX_PRIVATE_ARTIFACT_BYTES = 49_152
MAX_PREFERENCE_COMPACTION_SOURCE_BYTES = 1_048_576
PREFERENCE_COMPACTED_TARGET_BYTES = 32_768
PREFERENCE_ARTIFACT_NAME = "preference-insights.md"
PREFERENCE_COMPACTION_SCHEMA = "evogent.preference-insights-compaction.v1"
PREFERENCE_COMPACTION_STRATEGY = "heading-outline-head-recent-tail-v1"
PRODUCTION_RUNTIME_DATA_LINK = "../../../state/data"
ArtifactKind = Literal["preference", "cadence"]


def artifact_identity(
    path: Path,
    *,
    trusted_data_root: Path | None = None,
) -> str:
    """Return an identity only after a stable, bounded private-file read.

    The scheduler uses this as its pre-provider snapshot. A bare ``stat`` would
    let a symlink, oversized file, unsafe mode, hard link, or racing replacement
    authorize paid work even though the worker could never satisfy the durable
    postcondition.
    """

    parent_descriptor = _safe_parent_descriptor(
        path,
        trusted_data_root=trusted_data_root,
    )
    if parent_descriptor < 0:
        return "missing"
    try:
        artifact = _read_private_artifact_at(parent_descriptor, path.name)
        if artifact is None:
            return "missing"
        signature = artifact[1]
        return f"{signature[0]}:{signature[1]}"
    finally:
        os.close(parent_descriptor)


def _canonical_trusted_data_root(path: Path) -> Path | None:
    """Return one absolute, existing data root with no symlink in its path."""

    expanded = path.expanduser()
    if not expanded.is_absolute():
        return None
    lexical = Path(os.path.normpath(os.fspath(expanded)))
    try:
        resolved = expanded.resolve(strict=True)
    except OSError:
        return None
    return resolved if resolved == lexical else None


def _open_owned_directory(path: Path) -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory = getattr(os, "O_DIRECTORY", 0)
    if not nofollow or not directory:
        return -1
    try:
        expected = path.lstat()
    except OSError:
        return -1
    if (
        stat.S_ISLNK(expected.st_mode)
        or not stat.S_ISDIR(expected.st_mode)
        or expected.st_uid != os.getuid()
    ):
        return -1
    descriptor = -1
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | directory | nofollow | getattr(os, "O_CLOEXEC", 0),
        )
        opened = os.fstat(descriptor)
        current = path.lstat()
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != os.getuid()
            or opened.st_dev != expected.st_dev
            or opened.st_ino != expected.st_ino
            or current.st_dev != opened.st_dev
            or current.st_ino != opened.st_ino
        ):
            os.close(descriptor)
            return -1
        return descriptor
    except OSError:
        if descriptor >= 0:
            os.close(descriptor)
        return -1


def _safe_parent_descriptor(
    path: Path,
    *,
    trusted_data_root: Path | None = None,
) -> int:
    """Open the artifact parent without following an untrusted directory link.

    Normal callers retain the strict no-symlink rule. Versioned phone releases
    may additionally bind the exact ``runtime/data -> ../../../state/data``
    indirection to an explicit canonical state root. The returned descriptor is
    always opened on that real, owner-held root; leaf operations remain
    descriptor-relative and no-follow.
    """

    if not path.name or path.name in {".", ".."}:
        return -1
    try:
        expected_parent = path.parent.lstat()
    except OSError:
        return -1

    if not stat.S_ISLNK(expected_parent.st_mode):
        if (
            not stat.S_ISDIR(expected_parent.st_mode)
            or expected_parent.st_uid != os.getuid()
        ):
            return -1
        if trusted_data_root is None:
            return _open_owned_directory(path.parent)
        trusted_root = _canonical_trusted_data_root(trusted_data_root)
        if trusted_root is None:
            return -1
        # With an explicit trust root, a normal parent must itself be that
        # canonical path. Do not silently accept a symlink in an ancestor.
        parent_absolute = Path(os.path.abspath(os.fspath(path.parent)))
        try:
            if parent_absolute != trusted_root or path.parent.resolve(strict=True) != trusted_root:
                return -1
        except OSError:
            return -1
        return _open_owned_directory(trusted_root)

    if trusted_data_root is None or expected_parent.st_uid != os.getuid():
        return -1
    try:
        link_target = os.readlink(path.parent)
        runtime_directory = path.parent.parent.resolve(strict=True)
    except OSError:
        return -1
    if (
        path.parent.name != "data"
        or link_target != PRODUCTION_RUNTIME_DATA_LINK
        or runtime_directory.name != "runtime"
    ):
        return -1

    trusted_root = _canonical_trusted_data_root(trusted_data_root)
    if trusted_root is None:
        return -1
    try:
        if path.parent.resolve(strict=True) != trusted_root:
            return -1
    except OSError:
        return -1

    descriptor = _open_owned_directory(trusted_root)
    if descriptor < 0:
        return -1
    try:
        opened = os.fstat(descriptor)
        followed_parent = os.stat(path.parent)
        current_parent = path.parent.lstat()
        current_target = os.readlink(path.parent)
        if (
            not stat.S_ISLNK(current_parent.st_mode)
            or current_parent.st_uid != os.getuid()
            or current_parent.st_dev != expected_parent.st_dev
            or current_parent.st_ino != expected_parent.st_ino
            or current_target != link_target
            or not stat.S_ISDIR(followed_parent.st_mode)
            or followed_parent.st_dev != opened.st_dev
            or followed_parent.st_ino != opened.st_ino
            or followed_parent.st_uid != opened.st_uid
        ):
            os.close(descriptor)
            return -1
        return descriptor
    except OSError:
        os.close(descriptor)
        return -1


def _artifact_signature(info: os.stat_result) -> tuple[int, ...]:
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


def _private_metadata_valid(
    info: os.stat_result,
    *,
    maximum_bytes: int = MAX_PRIVATE_ARTIFACT_BYTES,
) -> bool:
    return (
        stat.S_ISREG(info.st_mode)
        and stat.S_IMODE(info.st_mode) == 0o600
        and info.st_uid == os.getuid()
        and info.st_nlink == 1
        and info.st_size > 0
        and info.st_size <= maximum_bytes
    )


def _read_private_artifact_at(
    parent_descriptor: int,
    name: str,
    *,
    maximum_bytes: int = MAX_PRIVATE_ARTIFACT_BYTES,
) -> tuple[bytes, tuple[int, ...]] | None:
    descriptor = -1
    try:
        expected = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        if not _private_metadata_valid(expected, maximum_bytes=maximum_bytes):
            return None
        descriptor = os.open(
            name,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
            dir_fd=parent_descriptor,
        )
        opened = os.fstat(descriptor)
        if (
            not _private_metadata_valid(opened, maximum_bytes=maximum_bytes)
            or opened.st_dev != expected.st_dev
            or opened.st_ino != expected.st_ino
        ):
            return None
        chunks: list[bytes] = []
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(remaining, 16_384))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
        current = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        signature = _artifact_signature(opened)
        if (
            len(payload) != opened.st_size
            or len(payload) > maximum_bytes
            or _artifact_signature(after) != signature
            or _artifact_signature(current) != signature
        ):
            return None
        return payload, signature
    except OSError:
        return None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _read_private_artifact(
    path: Path,
    *,
    trusted_data_root: Path | None = None,
) -> bytes | None:
    parent_descriptor = _safe_parent_descriptor(
        path,
        trusted_data_root=trusted_data_root,
    )
    if parent_descriptor < 0:
        return None
    try:
        result = _read_private_artifact_at(parent_descriptor, path.name)
        return result[0] if result is not None else None
    finally:
        os.close(parent_descriptor)


def _private_file_valid(
    path: Path,
    *,
    trusted_data_root: Path | None = None,
) -> bool:
    return _read_private_artifact(
        path,
        trusted_data_root=trusted_data_root,
    ) is not None


def preference_insights_valid(
    path: Path,
    *,
    trusted_data_root: Path | None = None,
) -> bool:
    payload = _read_private_artifact(
        path,
        trusted_data_root=trusted_data_root,
    )
    return payload is not None and _preference_insights_payload_valid(payload)


def _preference_insights_payload_valid(payload: bytes) -> bool:
    """Accept bounded UTF-8 Markdown-like text, never opaque binary memory."""

    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return False
    if not text.strip() or "\x00" in text:
        return False
    return not any(
        (ord(character) < 32 and character not in "\n\r\t")
        or ord(character) == 127
        for character in text
    )


def _source_cadence_payload_valid(payload: bytes) -> bool:
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    if not isinstance(data, dict) or not data:
        return False
    for source, entry in data.items():
        if (
            not isinstance(source, str)
            or not source.strip()
            or source.strip() == "_comment"
            or not isinstance(entry, dict)
        ):
            return False
        hours = entry.get("cadenceHours")
        why = entry.get("why")
        if (
            isinstance(hours, bool)
            or not isinstance(hours, (int, float))
            or not math.isfinite(float(hours))
            or float(hours) < 0.25
            or float(hours) > 168
        ):
            return False
        if not isinstance(why, str) or not why.strip() or len(why) > 240:
            return False
    return True


def source_cadence_valid(
    path: Path,
    *,
    trusted_data_root: Path | None = None,
) -> bool:
    payload = _read_private_artifact(
        path,
        trusted_data_root=trusted_data_root,
    )
    return payload is not None and _source_cadence_payload_valid(payload)


def private_artifact_valid(
    path: Path,
    *,
    kind: ArtifactKind,
    trusted_data_root: Path | None = None,
) -> bool:
    if kind == "preference":
        return preference_insights_valid(
            path,
            trusted_data_root=trusted_data_root,
        )
    if kind == "cadence":
        return source_cadence_valid(
            path,
            trusted_data_root=trusted_data_root,
        )
    return False


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            raise OSError("private artifact temporary write stopped")
        offset += written


def _bounded_utf8_prefix(payload: bytes, maximum_bytes: int) -> str:
    if maximum_bytes <= 0:
        return ""
    clipped = payload[:maximum_bytes].decode("utf-8", errors="ignore")
    if len(payload) > maximum_bytes:
        boundary = clipped.rfind("\n")
        if boundary >= len(clipped) // 2:
            clipped = clipped[: boundary + 1]
    return clipped.strip("\n")


def _bounded_utf8_suffix(payload: bytes, maximum_bytes: int) -> str:
    if maximum_bytes <= 0:
        return ""
    clipped = payload[-maximum_bytes:].decode("utf-8", errors="ignore")
    if len(payload) > maximum_bytes:
        boundary = clipped.find("\n")
        if 0 <= boundary <= len(clipped) // 2:
            clipped = clipped[boundary + 1 :]
    return clipped.strip("\n")


def _preference_heading_outline(payload: bytes, maximum_bytes: int = 4_096) -> str:
    lines: list[str] = []
    used = 0
    text = payload.decode("utf-8")
    for raw_line in text.splitlines():
        heading = raw_line.strip()
        marker_length = len(heading) - len(heading.lstrip("#"))
        if (
            marker_length < 1
            or marker_length > 6
            or len(heading) <= marker_length
            or not heading[marker_length].isspace()
        ):
            continue
        heading = _bounded_utf8_prefix(heading.encode("utf-8"), 240)
        candidate = f"- {heading}\n"
        candidate_size = len(candidate.encode("utf-8"))
        if used + candidate_size > maximum_bytes:
            break
        lines.append(candidate)
        used += candidate_size
    return "".join(lines).rstrip("\n") or "- No Markdown headings were present."


def _compacted_preference_payload(
    source: bytes,
    *,
    source_sha256: str,
    preserved_name: str,
) -> bytes | None:
    """Build one deterministic, truthful bounded view of an oversized synthesis.

    This is deliberately structural rather than inferential: a deterministic
    helper must not guess which private preference is important. It retains an
    outline, a beginning excerpt, and a larger recent-tail excerpt while the
    exact source remains available in the content-addressed private archive.
    """

    outline = _preference_heading_outline(source)
    receipt = (
        "# Preference Insights\n\n"
        "## Deterministic compaction receipt\n\n"
        f"- Original synthesis: `{len(source)}` bytes; SHA-256 `{source_sha256}`.\n"
        f"- Exact original preserved privately as `{preserved_name}` (mode `0600`).\n"
        f"- Bounded-view strategy: `{PREFERENCE_COMPACTION_STRATEGY}`.\n"
        "- This file is a bounded working view. Text omitted from the view remains "
        "unchanged in the exact preserved source.\n\n"
    )
    outline_block = f"## Original heading outline\n\n{outline}\n\n"
    beginning_label = "## Beginning synthesis excerpt\n\n"
    omission = (
        "\n\n## Omission boundary\n\n"
        "The intervening private text is omitted only from this working view and "
        "remains in the exact preserved source named in the receipt.\n\n"
    )
    recent_label = "## Most recent synthesis excerpt\n\n"
    fixed = (
        receipt
        + outline_block
        + beginning_label
        + omission
        + recent_label
        + "\n"
    ).encode("utf-8")
    available = PREFERENCE_COMPACTED_TARGET_BYTES - len(fixed)
    if available < 4_096:
        return None
    beginning_budget = (available * 45) // 100
    recent_budget = available - beginning_budget
    beginning = _bounded_utf8_prefix(source, beginning_budget)
    recent = _bounded_utf8_suffix(source, recent_budget)
    compacted = (
        receipt
        + outline_block
        + beginning_label
        + beginning
        + omission
        + recent_label
        + recent
        + "\n"
    ).encode("utf-8")
    if (
        len(compacted) > PREFERENCE_COMPACTED_TARGET_BYTES
        or not _preference_insights_payload_valid(compacted)
    ):
        return None
    return compacted


def _publish_immutable_private_file_at(
    parent_descriptor: int,
    name: str,
    payload: bytes,
    *,
    maximum_bytes: int,
) -> bool:
    """Create a content-addressed private file, or validate the exact existing one."""

    existing = _read_private_artifact_at(
        parent_descriptor,
        name,
        maximum_bytes=maximum_bytes,
    )
    if existing is not None:
        if existing[0] != payload:
            return False
        try:
            os.fsync(parent_descriptor)
        except OSError:
            return False
        return True
    try:
        os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        return False
    except FileNotFoundError:
        pass
    except OSError:
        return False

    descriptor = -1
    created = False
    complete = False
    try:
        descriptor = os.open(
            name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=parent_descriptor,
        )
        created = True
        os.fchmod(descriptor, 0o600)
        _write_all(descriptor, payload)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        complete = True
        published = _read_private_artifact_at(
            parent_descriptor,
            name,
            maximum_bytes=maximum_bytes,
        )
        if published is None or published[0] != payload:
            return False
        os.fsync(parent_descriptor)
        return True
    except FileExistsError:
        existing = _read_private_artifact_at(
            parent_descriptor,
            name,
            maximum_bytes=maximum_bytes,
        )
        return existing is not None and existing[0] == payload
    except OSError:
        return False
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if created and not complete:
            try:
                os.unlink(name, dir_fd=parent_descriptor)
                os.fsync(parent_descriptor)
            except OSError:
                pass


def _replace_private_artifact_exact_at(
    parent_descriptor: int,
    name: str,
    *,
    original_payload: bytes,
    original_signature: tuple[int, ...],
    original_maximum_bytes: int,
    replacement_payload: bytes,
) -> tuple[bytes, tuple[int, ...]] | None:
    temporary_name = ""
    temporary_descriptor = -1
    try:
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        for _attempt in range(32):
            temporary_name = (
                f".private-artifact-{os.getpid()}-{secrets.token_hex(8)}.tmp"
            )
            try:
                temporary_descriptor = os.open(
                    temporary_name,
                    flags,
                    0o600,
                    dir_fd=parent_descriptor,
                )
                break
            except FileExistsError:
                temporary_name = ""
        if temporary_descriptor < 0:
            return None
        os.fchmod(temporary_descriptor, 0o600)
        _write_all(temporary_descriptor, replacement_payload)
        os.fsync(temporary_descriptor)
        os.close(temporary_descriptor)
        temporary_descriptor = -1

        current = _read_private_artifact_at(
            parent_descriptor,
            name,
            maximum_bytes=original_maximum_bytes,
        )
        if (
            current is None
            or current[0] != original_payload
            or current[1] != original_signature
        ):
            return None
        temporary = _read_private_artifact_at(parent_descriptor, temporary_name)
        if temporary is None or temporary[0] != replacement_payload:
            return None
        os.replace(
            temporary_name,
            name,
            src_dir_fd=parent_descriptor,
            dst_dir_fd=parent_descriptor,
        )
        temporary_name = ""
        os.fsync(parent_descriptor)
        final = _read_private_artifact_at(parent_descriptor, name)
        if (
            final is None
            or final[0] != replacement_payload
            or final[1][:2] == original_signature[:2]
        ):
            return None
        return final
    except OSError:
        return None
    finally:
        if temporary_descriptor >= 0:
            os.close(temporary_descriptor)
        if temporary_name:
            try:
                os.unlink(temporary_name, dir_fd=parent_descriptor)
            except OSError:
                pass


def compact_oversized_preference_for_snapshot(
    path: Path,
    *,
    trusted_data_root: Path | None,
) -> str:
    """Preserve and compact only the canonical preference artifact for admission."""

    if (
        path.name != PREFERENCE_ARTIFACT_NAME
        or trusted_data_root is None
    ):
        return "missing"
    parent_descriptor = _safe_parent_descriptor(
        path,
        trusted_data_root=trusted_data_root,
    )
    if parent_descriptor < 0:
        return "missing"
    try:
        original = _read_private_artifact_at(
            parent_descriptor,
            path.name,
            maximum_bytes=MAX_PREFERENCE_COMPACTION_SOURCE_BYTES,
        )
        if original is None:
            return "missing"
        source, source_signature = original
        if (
            len(source) <= MAX_PRIVATE_ARTIFACT_BYTES
            or not _preference_insights_payload_valid(source)
        ):
            return "missing"

        source_sha256 = hashlib.sha256(source).hexdigest()
        preserved_name = (
            f".{PREFERENCE_ARTIFACT_NAME}.preserved.{source_sha256}.md"
        )
        compacted = _compacted_preference_payload(
            source,
            source_sha256=source_sha256,
            preserved_name=preserved_name,
        )
        if compacted is None:
            return "missing"
        compacted_sha256 = hashlib.sha256(compacted).hexdigest()
        receipt = (
            json.dumps(
                {
                    "artifact": PREFERENCE_ARTIFACT_NAME,
                    "boundedView": {
                        "bytes": len(compacted),
                        "sha256": compacted_sha256,
                        "strategy": PREFERENCE_COMPACTION_STRATEGY,
                    },
                    "preservedSource": {
                        "bytes": len(source),
                        "file": preserved_name,
                        "sha256": source_sha256,
                    },
                    "schema": PREFERENCE_COMPACTION_SCHEMA,
                    "status": "source_preserved_before_atomic_compaction",
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
        receipt_name = (
            f".{PREFERENCE_ARTIFACT_NAME}.compaction.{source_sha256}.json"
        )

        # The exact source and a content-free plan receipt are durable before
        # the only destructive step. The replacement itself contains the
        # human-readable receipt, so a crash cannot install an unlabelled
        # truncated view.
        if not _publish_immutable_private_file_at(
            parent_descriptor,
            preserved_name,
            source,
            maximum_bytes=MAX_PREFERENCE_COMPACTION_SOURCE_BYTES,
        ):
            return "missing"
        if not _publish_immutable_private_file_at(
            parent_descriptor,
            receipt_name,
            receipt,
            maximum_bytes=MAX_PRIVATE_ARTIFACT_BYTES,
        ):
            return "missing"
        final = _replace_private_artifact_exact_at(
            parent_descriptor,
            path.name,
            original_payload=source,
            original_signature=source_signature,
            original_maximum_bytes=MAX_PREFERENCE_COMPACTION_SOURCE_BYTES,
            replacement_payload=compacted,
        )
        if final is None or not _preference_insights_payload_valid(final[0]):
            return "missing"
        return f"{final[1][0]}:{final[1][1]}"
    finally:
        os.close(parent_descriptor)


def snapshot_artifact(
    path: Path,
    *,
    trusted_data_root: Path | None = None,
) -> str:
    identity = artifact_identity(
        path,
        trusted_data_root=trusted_data_root,
    )
    if identity != "missing":
        return identity
    return compact_oversized_preference_for_snapshot(
        path,
        trusted_data_root=trusted_data_root,
    )


def atomic_rewrite_private_artifact(
    path: Path,
    *,
    kind: ArtifactKind,
    trusted_data_root: Path | None = None,
) -> bool:
    """Validate and durably replace a private artifact with its exact current bytes."""

    parent_descriptor = _safe_parent_descriptor(
        path,
        trusted_data_root=trusted_data_root,
    )
    if parent_descriptor < 0:
        return False
    temporary_name = ""
    temporary_descriptor = -1
    try:
        original = _read_private_artifact_at(parent_descriptor, path.name)
        if original is None:
            return False
        payload, original_signature = original
        if kind == "preference" and not _preference_insights_payload_valid(payload):
            return False
        if kind == "cadence" and not _source_cadence_payload_valid(payload):
            return False
        if kind not in ("preference", "cadence"):
            return False

        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        for _attempt in range(32):
            temporary_name = f".private-artifact-{os.getpid()}-{secrets.token_hex(8)}.tmp"
            try:
                temporary_descriptor = os.open(
                    temporary_name,
                    flags,
                    0o600,
                    dir_fd=parent_descriptor,
                )
                break
            except FileExistsError:
                temporary_name = ""
        if temporary_descriptor < 0:
            return False

        os.fchmod(temporary_descriptor, 0o600)
        _write_all(temporary_descriptor, payload)
        os.fsync(temporary_descriptor)
        os.close(temporary_descriptor)
        temporary_descriptor = -1

        current = _read_private_artifact_at(parent_descriptor, path.name)
        if current is None or current[0] != payload or current[1] != original_signature:
            return False
        temporary = _read_private_artifact_at(parent_descriptor, temporary_name)
        if temporary is None or temporary[0] != payload:
            return False

        os.replace(
            temporary_name,
            path.name,
            src_dir_fd=parent_descriptor,
            dst_dir_fd=parent_descriptor,
        )
        temporary_name = ""
        os.fsync(parent_descriptor)

        final = _read_private_artifact_at(parent_descriptor, path.name)
        return (
            final is not None
            and final[0] == payload
            and final[1][:2] != original_signature[:2]
            and (
                _preference_insights_payload_valid(final[0])
                if kind == "preference"
                else _source_cadence_payload_valid(final[0])
            )
        )
    except OSError:
        return False
    finally:
        if temporary_descriptor >= 0:
            os.close(temporary_descriptor)
        if temporary_name:
            try:
                os.unlink(temporary_name, dir_fd=parent_descriptor)
            except OSError:
                pass
        os.close(parent_descriptor)


def artifact_was_atomically_rewritten(
    path: Path,
    *,
    before_identity: str,
    kind: ArtifactKind,
    trusted_data_root: Path | None = None,
) -> bool:
    # The worker contract requires temp-file + rename even on a no-change pass.
    # The old destination still exists while the temp inode is created, so a
    # successful atomic replacement necessarily changes (device, inode).
    if artifact_identity(
        path,
        trusted_data_root=trusted_data_root,
    ) in {"missing", before_identity}:
        return False
    return private_artifact_valid(
        path,
        kind=kind,
        trusted_data_root=trusted_data_root,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--path", required=True)
    snapshot.add_argument("--trusted-data-root")
    verify = sub.add_parser("verify")
    verify.add_argument("--path", required=True)
    verify.add_argument("--before", required=True)
    verify.add_argument("--kind", required=True, choices=("preference", "cadence"))
    verify.add_argument("--trusted-data-root")
    validate = sub.add_parser("validate")
    validate.add_argument("--path", required=True)
    validate.add_argument("--kind", required=True, choices=("preference", "cadence"))
    validate.add_argument("--trusted-data-root")
    rewrite = sub.add_parser("rewrite")
    rewrite.add_argument("--path", required=True)
    rewrite.add_argument("--kind", required=True, choices=("preference", "cadence"))
    rewrite.add_argument("--trusted-data-root")
    args = parser.parse_args(argv)

    path = Path(args.path)
    trusted_data_root = (
        Path(args.trusted_data_root)
        if args.trusted_data_root
        else None
    )
    if args.command == "snapshot":
        print(snapshot_artifact(path, trusted_data_root=trusted_data_root))
        return 0
    if args.command == "verify":
        return 0 if artifact_was_atomically_rewritten(
            path,
            before_identity=args.before,
            kind=args.kind,
            trusted_data_root=trusted_data_root,
        ) else 1
    if args.command == "validate":
        return 0 if private_artifact_valid(
            path,
            kind=args.kind,
            trusted_data_root=trusted_data_root,
        ) else 1
    return 0 if atomic_rewrite_private_artifact(
        path,
        kind=args.kind,
        trusted_data_root=trusted_data_root,
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
