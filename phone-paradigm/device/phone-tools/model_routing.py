#!/data/data/com.termux/files/usr/bin/env python3
"""Private, benchmark-gated model routing for the phone runtime.

The public file describes mechanics and safe fallbacks.  A deployment may write
``data/model-routing.json`` with a candidate route, but an enabled routine route
is used only when the phone-local receipt ledger proves enough recent paired
passes. Global browse, YouTube browse, curation, and source discovery are
additionally pinned to their configured baselines until a safe qualifying
harness exists. Automatic diagnosis is pinned to its public baseline unless an
operator supplies a one-run environment override. Receipts contain metrics and
digests, never source text or model output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import time
import unicodedata
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1
ALLOWED_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max", "ultra"})
SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$")
BENCHMARK_KIND_BY_TASK = {
    # This identity remains parseable for screening and historical ledgers, but
    # it is not production proof: v3 does not bind a frozen, blinded private-
    # relevance review. A future qualifier needs a new versioned identity.
    "browse_mixed_full_v3": "full_browse_mixed",
    # This live, mutable-feed harness is useful operational evidence, but it
    # cannot compare relevance on one identical workload. Keep it explicitly
    # outside production qualification until a frozen, reviewed harness exists.
    "browse_youtube_smoke_v1": "full_browse_youtube_smoke",
    "browse_youtube_full_v1": "full_browse_youtube",
    # Retain the old identity so historical ledgers stay parseable, but no
    # production route consumes it: that harness covered YouTube while its
    # receipt could incorrectly qualify the global browse route.
    "browse_full_v2": "full_browse",
    "browse_micro": "grounded_micro",
    "curator_full_v2": "full_curation_snapshot",
}
QUALIFICATION_RECEIPT_TASK = {
    "browse": "browse_mixed_full_v3",
    "curator": "curator_full_v2",
}
QUALIFICATION_BENCHMARK_KIND = {
    "browse": BENCHMARK_KIND_BY_TASK["browse_mixed_full_v3"],
    "curator": BENCHMARK_KIND_BY_TASK["curator_full_v2"],
}
# Neither current computer-use receipt contract binds a frozen, blinded
# private-relevance review, and the curator benchmark cannot yet isolate all
# production state. Keep their validators parseable for historical ledgers and
# future harness work, but never let these production routes consume a durable
# override until a safe qualifying harness is implemented.
PERSISTENT_OVERRIDE_DISABLED_TASKS = frozenset({
    "browse",
    "browse_youtube",
    "curator",
    "source_discovery",
    "diagnosis",
})
PHONE_CONFIG_BOOTSTRAP_VERSION = 1
PHONE_CONFIG_BOOTSTRAP_MARKER = ".phone-config-bootstrap.json"
PHONE_CONFIG_MAX_BYTES = 1024 * 1024
PHONE_CONFIG_MARKER_MAX_BYTES = 4096
DEFAULT_CODEX_MODEL = "gpt-5.5"
DEFAULT_CODEX_REASONING = "medium"
# The phone helper is deployed independently of the host-side CommonJS module.
# Keep this literal in sync with lib/brain-config.js; the fresh-phone regression
# test compares the bytes.
GENERIC_DEFAULT_CONFIG_CONTENT = """# Evogent Config

## Agent Name
Evogent

## Time Zone
<!-- IANA time zone, for example America/Denver. Leave blank to use the host timezone. -->

## Interests

## Brain Provider
Claude Code

## Codex Model
gpt-5.5

## Codex Reasoning Effort
Medium

## Code-Fix Reasoning Effort
High

## Usage Level
Medium

## Automatic Curation
On

## Background Source Browsing
On

## Curation Schedule
<!-- Source caches refresh ahead of visible curation; Medium cache defaults are twitter 30m, Hacker News 60m, Substack 120m, YouTube 120m. -->
- Minimum interval: 90 minutes
- Maximum interval: 4 hours
"""
PHONE_CONFIG_DEFAULTS = (
    ("Curator Model", "gpt-5.6-sol"),
    ("Curator Reasoning", "High"),
    ("Source Discovery Model", "gpt-5.6-sol"),
    ("Source Discovery Reasoning", "High"),
    ("Browse Model", "gpt-5.6-terra"),
    ("Browse Reasoning", "Medium"),
    ("Overseer Model", "gpt-5.6-sol"),
    ("Overseer Reasoning", "High"),
)
LEGACY_CODEX_MODEL_HEADINGS = frozenset({
    "Curator Model",
    "Source Discovery Model",
    "Browse Model",
})
LEGACY_FIXED_REASONING = {
    "Source Discovery Reasoning": "Medium",
    "Browse Reasoning": "Medium",
}
FULL_BROWSE_ROUTE_TASKS = frozenset({"browse", "browse_youtube"})
FULL_BROWSE_MIN_OUTCOME_RATIO = 0.80
FULL_BROWSE_MAX_ELAPSED_RATIO = 1.20
FULL_BROWSE_MAX_TOTAL_TOKEN_RATIO = 1.50
CURATOR_MINIMUM_PAIRED_PASSES = 3
CURATOR_MECHANICS_STATUSES = frozenset({
    "passed",
    "timeout",
    "runner_failed",
    "snapshot_prepare_failed",
    "terminal_failed",
    "artifact_failed",
    "restore_failed",
})
RECEIPT_ROLES = frozenset({"baseline", "candidate"})
QUALITY_STATUSES = frozenset({"passed", "failed", "not_scored"})
MECHANICS_STATUSES_BY_TASK = {
    "browse_mixed_full_v3": frozenset({
        "passed",
        "failed",
        "timeout",
        "runner_failed",
        "terminal_proof_failed",
    }),
    "browse_youtube_smoke_v1": frozenset({
        "passed",
        "failed",
        "timeout",
        "runner_failed",
        "terminal_proof_failed",
    }),
    "browse_youtube_full_v1": frozenset({
        "passed",
        "failed",
        "timeout",
        "runner_failed",
        "terminal_proof_failed",
    }),
    "browse_full_v2": frozenset({
        "passed",
        "failed",
        "timeout",
        "runner_failed",
        "terminal_proof_failed",
    }),
    "browse_micro": frozenset({"passed", "failed", "timeout", "runner_failed"}),
    "curator_full_v2": CURATOR_MECHANICS_STATUSES,
}


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _read_bounded_private_bytes(
    path: Path,
    *,
    maximum_bytes: int = 49_152,
) -> bytes | None:
    """Read one owner-held 0600 regular file without following its leaf."""

    descriptor = -1
    try:
        expected = path.lstat()
        if (
            stat.S_ISLNK(expected.st_mode)
            or not stat.S_ISREG(expected.st_mode)
            or stat.S_IMODE(expected.st_mode) != 0o600
            or expected.st_uid != os.geteuid()
            or expected.st_nlink != 1
            or expected.st_size <= 0
            or expected.st_size > maximum_bytes
        ):
            return None
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
        )
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or stat.S_IMODE(opened.st_mode) != 0o600
            or opened.st_uid != os.geteuid()
            or opened.st_nlink != 1
            or opened.st_size <= 0
            or opened.st_size > maximum_bytes
            or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)
        ):
            return None
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 16_384))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        current = path.lstat()
        signature = (
            opened.st_dev,
            opened.st_ino,
            opened.st_mode,
            opened.st_uid,
            opened.st_nlink,
            opened.st_size,
            opened.st_mtime_ns,
            opened.st_ctime_ns,
        )
        if (
            remaining
            or signature
            != (
                after.st_dev,
                after.st_ino,
                after.st_mode,
                after.st_uid,
                after.st_nlink,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
            or signature
            != (
                current.st_dev,
                current.st_ino,
                current.st_mode,
                current.st_uid,
                current.st_nlink,
                current.st_size,
                current.st_mtime_ns,
                current.st_ctime_ns,
            )
        ):
            return None
        return b"".join(chunks)
    except OSError:
        return None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _read_private_json(path: Path) -> dict[str, Any]:
    payload = _read_bounded_private_bytes(path)
    if payload is None:
        return {}
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return rows
    for line in lines:
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("schemaVersion") == SCHEMA_VERSION:
            rows.append(value)
    return rows


def _read_private_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        info = path.stat()
    except OSError:
        return []
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 8 * 1024 * 1024
    ):
        return []
    return _read_jsonl(path)


def _markdown_sections_from_content(content: str) -> dict[str, str]:
    sections: dict[str, str] = {}
    heading = ""
    for line in content.splitlines():
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            heading = match.group(1).strip().lower()
            continue
        if heading and line.strip() and heading not in sections:
            sections[heading] = re.sub(r"^[-*]\s*", "", line.strip())
    return sections


def _markdown_sections(path: Path) -> dict[str, str]:
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    return _markdown_sections_from_content(content)


def _effective_legacy_codex_route(content: str) -> tuple[str, str]:
    """Mirror the generic config's effective Codex defaults for old phones."""

    sections = _markdown_sections_from_content(content)
    model = _safe_model(sections.get("codex model")) or DEFAULT_CODEX_MODEL
    effort = sections.get("codex reasoning effort", "").strip().lower()
    if effort not in {"low", "medium", "high", "xhigh"}:
        usage = sections.get("usage level", "").strip().lower()
        effort = usage if usage in {"low", "medium", "high"} else DEFAULT_CODEX_REASONING
    return model, effort


def _format_codex_effort(value: str) -> str:
    return {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "XHigh",
    }.get(value, "Medium")


def ensure_phone_config_defaults(path: Path) -> dict[str, Any]:
    """Seed or migrate private phone config without changing owned sections.

    A genuinely new phone receives the complete generic config before its
    phone-specific routes. An existing config keeps the effective behavior each
    lane had before the split: new model headings inherit its Codex model,
    curator inherits Codex reasoning, and the two former medium-effort lanes
    remain medium. Every heading already present, including a blank one,
    remains user-owned.
    """

    path = path.expanduser()
    if path.name in {"", ".", "..", PHONE_CONFIG_BOOTSTRAP_MARKER}:
        raise ValueError("phone config path must name a non-reserved file")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Versioned phone releases deliberately expose runtime/data as a symlink to
    # durable private state. Resolve that known directory indirection, then keep
    # no-follow checks on the config file and every temporary file inside it.
    config_directory = path.parent.resolve(strict=True)
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    file_read_flags = (
        os.O_RDONLY
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    directory = os.open(config_directory, directory_flags)
    directory_info = os.fstat(directory)
    if (
        not stat.S_ISDIR(directory_info.st_mode)
        or directory_info.st_uid != os.geteuid()
    ):
        os.close(directory)
        raise ValueError("phone config directory is not private deployment state")

    def identity(info: os.stat_result) -> tuple[int, ...]:
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

    def read_owned_file(
        name: str,
        *,
        maximum_bytes: int,
        label: str,
        private_mode: bool = False,
        require_content: bool = False,
    ) -> tuple[bytes | None, tuple[int, ...] | None]:
        try:
            descriptor = os.open(name, file_read_flags, dir_fd=directory)
        except FileNotFoundError:
            return None, None
        try:
            before = os.fstat(descriptor)
            named = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (
                not stat.S_ISREG(before.st_mode)
                or not stat.S_ISREG(named.st_mode)
                or (before.st_dev, before.st_ino) != (named.st_dev, named.st_ino)
                or before.st_uid != os.geteuid()
                or before.st_nlink != 1
                or before.st_size < int(require_content)
                or before.st_size > maximum_bytes
                or (private_mode and stat.S_IMODE(before.st_mode) != 0o600)
            ):
                raise ValueError(f"{label} is not a bounded private regular file")
            chunks: list[bytes] = []
            remaining = before.st_size
            while remaining:
                chunk = os.read(descriptor, min(remaining, 64 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            after = os.fstat(descriptor)
            if remaining or identity(before) != identity(after):
                raise RuntimeError(f"{label} changed while it was read")
            return b"".join(chunks), identity(before)
        finally:
            os.close(descriptor)

    def atomic_replace(
        name: str,
        encoded: bytes,
        *,
        original_identity: tuple[int, ...] | None,
        label: str,
    ) -> None:
        temporary_name = f".{name}.{os.getpid()}.{time.time_ns()}"
        temporary_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        try:
            temporary = os.open(
                temporary_name,
                temporary_flags,
                stat.S_IRUSR | stat.S_IWUSR,
                dir_fd=directory,
            )
            try:
                offset = 0
                while offset < len(encoded):
                    written = os.write(temporary, encoded[offset:])
                    if written <= 0:
                        raise OSError(f"short {label} write")
                    offset += written
                os.fchmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
                os.fsync(temporary)
            finally:
                os.close(temporary)

            try:
                current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                if original_identity is not None:
                    raise RuntimeError(f"{label} disappeared during update")
            else:
                if original_identity is None or identity(current) != original_identity:
                    raise RuntimeError(f"{label} changed during update")

            os.replace(
                temporary_name,
                name,
                src_dir_fd=directory,
                dst_dir_fd=directory,
            )
            temporary_name = ""
            os.fsync(directory)
        finally:
            if temporary_name:
                try:
                    os.unlink(temporary_name, dir_fd=directory)
                except FileNotFoundError:
                    pass

    try:
        marker_bytes, marker_identity = read_owned_file(
            PHONE_CONFIG_BOOTSTRAP_MARKER,
            maximum_bytes=PHONE_CONFIG_MARKER_MAX_BYTES,
            label="phone config bootstrap marker",
            private_mode=True,
            require_content=True,
        )
        marker_version = 0
        if marker_bytes is not None:
            try:
                marker = json.loads(marker_bytes.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as error:
                raise ValueError("phone config bootstrap marker is invalid") from error
            marker_version = marker.get("bootstrapVersion") if isinstance(marker, dict) else None
            if (
                isinstance(marker_version, bool)
                or not isinstance(marker_version, int)
                or marker_version < 1
            ):
                raise ValueError("phone config bootstrap marker has no valid version")
            if marker_version > PHONE_CONFIG_BOOTSTRAP_VERSION:
                raise ValueError("phone config bootstrap marker is newer than this runtime")

        config_bytes, original_identity = read_owned_file(
            path.name,
            maximum_bytes=PHONE_CONFIG_MAX_BYTES,
            label="phone config",
        )
        fresh_config = config_bytes is None
        if fresh_config:
            content = GENERIC_DEFAULT_CONFIG_CONTENT
        else:
            try:
                content = config_bytes.decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError("phone config is not valid UTF-8") from error

        present = {
            match.group(1).strip().casefold()
            for match in re.finditer(r"^##[ \t]+(.+?)[ \t]*$", content, flags=re.MULTILINE)
        }
        legacy_model, legacy_effort = _effective_legacy_codex_route(content)
        missing: list[tuple[str, str]] = []
        for heading, default_value in PHONE_CONFIG_DEFAULTS:
            if heading.casefold() in present:
                continue
            value = default_value
            if not fresh_config and heading in LEGACY_CODEX_MODEL_HEADINGS:
                value = legacy_model
            elif not fresh_config and heading == "Curator Reasoning":
                value = _format_codex_effort(legacy_effort)
            elif not fresh_config and heading in LEGACY_FIXED_REASONING:
                value = LEGACY_FIXED_REASONING[heading]
            missing.append((heading, value))

        config_changed = bool(missing)
        if config_changed:
            next_content = content
            if not next_content.endswith("\n"):
                next_content += "\n"
            if next_content.strip():
                next_content += "\n"
            next_content += "\n\n".join(
                f"## {heading}\n{value}"
                for heading, value in missing
            )
            next_content += "\n"
            encoded = next_content.encode("utf-8")
            if len(encoded) > PHONE_CONFIG_MAX_BYTES:
                raise ValueError("phone config would exceed its private size bound")
            atomic_replace(
                path.name,
                encoded,
                original_identity=original_identity,
                label="phone config",
            )

        marker_changed = marker_version < PHONE_CONFIG_BOOTSTRAP_VERSION
        if marker_changed:
            encoded_marker = (
                json.dumps(
                    {"bootstrapVersion": PHONE_CONFIG_BOOTSTRAP_VERSION},
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
                + b"\n"
            )
            atomic_replace(
                PHONE_CONFIG_BOOTSTRAP_MARKER,
                encoded_marker,
                original_identity=marker_identity,
                label="phone config bootstrap marker",
            )

        return {
            "changed": config_changed,
            "added": [heading for heading, _value in missing],
            "bootstrapVersion": PHONE_CONFIG_BOOTSTRAP_VERSION,
            "markerChanged": marker_changed,
        }
    finally:
        os.close(directory)


def _safe_model(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip()
    return normalized if SAFE_TOKEN.fullmatch(normalized) else ""


def _safe_effort(value: Any, fallback: str = "medium") -> str:
    normalized = value.strip().lower() if isinstance(value, str) else ""
    return normalized if normalized in ALLOWED_EFFORTS else fallback


def _allowed_efforts(route: dict[str, Any]) -> set[str]:
    values = route.get("allowedEfforts")
    if not isinstance(values, list):
        return set(ALLOWED_EFFORTS)
    allowed = {
        value.strip().lower()
        for value in values
        if isinstance(value, str) and value.strip().lower() in ALLOWED_EFFORTS
    }
    return allowed or set(ALLOWED_EFFORTS)


def _positive_int(value: Any, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _finite_nonnegative(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed >= 0 else None


def live_route_file_valid(
    path: Path,
    *,
    policy_path: Path,
    allow_missing: bool = False,
) -> bool:
    """Validate the bounded private route artifact without exposing its contents."""

    try:
        path.lstat()
    except OSError:
        return allow_missing
    payload = _read_bounded_private_bytes(path)
    if payload is None:
        return False
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    if not isinstance(value, dict):
        return False
    routes = value.get("routes")
    if value.get("schemaVersion") != SCHEMA_VERSION or not isinstance(routes, dict):
        return False
    if len(routes) > 32:
        return False
    policy_routes = (_read_json(policy_path).get("routes") or {})
    for task, entry in routes.items():
        if not isinstance(task, str) or not SAFE_TOKEN.fullmatch(task):
            return False
        if not isinstance(entry, dict):
            return False
        route_policy = policy_routes.get(task)
        allowed_efforts = (
            _allowed_efforts(route_policy)
            if isinstance(route_policy, dict)
            else set(ALLOWED_EFFORTS)
        )
        if not _safe_model(entry.get("model")):
            return False
        effort = entry.get("effort")
        if not isinstance(effort, str) or effort.strip().lower() not in allowed_efforts:
            return False
        qualification = entry.get("qualification")
        if qualification is not None:
            if not isinstance(qualification, dict):
                return False
            suite_id = qualification.get("suiteId")
            if not isinstance(suite_id, str) or not SAFE_TOKEN.fullmatch(suite_id):
                return False
    return True


def _route_defaults(
    task: str,
    *,
    config_path: Path,
    policy_path: Path,
) -> dict[str, Any]:
    policy = _read_json(policy_path)
    route = (policy.get("routes") or {}).get(task)
    if not isinstance(route, dict):
        return {"execution": "unsupported", "model": "", "effort": "", "origin": "missing"}
    execution = route.get("execution")
    if execution != "agent":
        return {"execution": execution or "unsupported", "model": "", "effort": "", "origin": "policy"}

    sections = _markdown_sections(config_path)
    model = ""
    for name in route.get("modelSections") or []:
        if isinstance(name, str):
            model = _safe_model(sections.get(name.strip().lower()))
            if model:
                break
    origin = "config" if model else "policy"
    model = model or _safe_model(route.get("fallbackModel"))

    allowed_efforts = _allowed_efforts(route)
    effort = ""
    for name in route.get("effortSections") or []:
        if isinstance(name, str):
            candidate = sections.get(name.strip().lower())
            if isinstance(candidate, str) and candidate.strip().lower() in allowed_efforts:
                effort = candidate.strip().lower()
                break
    fallback_effort = _safe_effort(route.get("fallbackEffort"))
    effort = effort or (fallback_effort if fallback_effort in allowed_efforts else sorted(allowed_efforts)[0])
    return {
        "execution": "agent",
        "model": model,
        "effort": effort,
        "origin": origin,
        "policy": policy,
        "routePolicy": route,
    }


def _receipt_key(row: dict[str, Any]) -> tuple[str, str]:
    return (_safe_model(row.get("model")), _safe_effort(row.get("effort"), ""))


def _full_browse_terminal_metrics(row: dict[str, Any]) -> tuple[int, int, int] | None:
    """Return exact outcome, elapsed, and usage metrics for a run-bound proof."""

    metrics = row.get("metrics")
    if not isinstance(metrics, dict) or metrics.get("terminalProof") is not True:
        return None
    run_digest = metrics.get("runDigest")
    if not isinstance(run_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", run_digest):
        return None

    values: dict[str, int] = {}
    for key in (
        "terminalItems",
        "freshRows",
        "completeRows",
        "elapsedMs",
        "inputTokens",
        "outputTokens",
        "totalTokens",
    ):
        value = _finite_nonnegative(metrics.get(key))
        if value is None or value < 1 or not value.is_integer():
            return None
        values[key] = int(value)
    if not (
        values["terminalItems"]
        == values["freshRows"]
        == values["completeRows"]
    ):
        return None
    cached_tokens = _finite_nonnegative(metrics.get("cachedInputTokens"))
    if (
        cached_tokens is None
        or not cached_tokens.is_integer()
        or cached_tokens > values["inputTokens"]
        or values["totalTokens"] < values["inputTokens"] + values["outputTokens"]
    ):
        return None
    return values["freshRows"], values["elapsedMs"], values["totalTokens"]


def _curator_review_proof(row: dict[str, Any]) -> bool:
    """Require an explicit review bound to one private full-snapshot artifact."""

    metrics = row.get("metrics")
    if (
        not isinstance(metrics, dict)
        or metrics.get("artifactReviewed") is not True
        or metrics.get("fullSnapshotProof") is not True
        or metrics.get("terminalProof") is not True
    ):
        return False
    digest = metrics.get("artifactDigest")
    run_digest = metrics.get("runDigest")
    reviewed_at_ms = _finite_nonnegative(metrics.get("reviewedAtMs"))
    candidate_count = _finite_nonnegative(metrics.get("candidateCount"))
    return (
        isinstance(digest, str)
        and re.fullmatch(r"[a-f0-9]{64}", digest) is not None
        and isinstance(run_digest, str)
        and re.fullmatch(r"[a-f0-9]{64}", run_digest) is not None
        and reviewed_at_ms is not None
        and reviewed_at_ms > 0
        and candidate_count is not None
        and candidate_count >= 1
        and candidate_count.is_integer()
    )


def qualification_decision(
    receipts: Iterable[dict[str, Any]],
    *,
    task: str,
    suite_id: str,
    candidate_model: str,
    candidate_effort: str,
    baseline_model: str,
    baseline_effort: str,
    minimum_paired_passes: int,
    max_age_hours: int,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """Prove a candidate matched a passing baseline on paired private cases.

    Mechanics failures invalidate their pair but never become model-quality
    failures.  A candidate qualifies only from distinct rounds where both routes
    passed mechanics and quality on the same benchmark task and suite.
    """

    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    bounded_max_age_hours = _positive_int(max_age_hours, 720)
    cutoff_ms = now_ms - bounded_max_age_hours * 60 * 60 * 1000
    wanted_candidate = (_safe_model(candidate_model), _safe_effort(candidate_effort, ""))
    wanted_baseline = (_safe_model(baseline_model), _safe_effort(baseline_effort, ""))
    if (
        not all((*wanted_candidate, *wanted_baseline))
        or wanted_candidate == wanted_baseline
        or not SAFE_TOKEN.fullmatch(suite_id)
    ):
        return {"qualified": False, "reason": "invalid_request", "pairedPasses": 0}

    by_round: dict[int, dict[str, dict[str, Any]]] = {}
    mechanics_failures = 0
    browse_mechanics_failure_rounds: set[int] = set()
    browse_terminal_failure_rounds: set[int] = set()
    curator_mechanics_failure_rounds: set[int] = set()
    curator_review_proof_failures = 0
    terminal_proof_failures = 0
    outcome_equivalence_failures = 0
    latency_equivalence_failures = 0
    token_equivalence_failures = 0
    role_integrity_failure_rounds: set[int] = set()
    ineligible_kind_rows = 0
    ineligible_task_rows = 0
    required_kind = QUALIFICATION_BENCHMARK_KIND.get(task, "")
    required_receipt_task = QUALIFICATION_RECEIPT_TASK.get(task, task)
    for row in receipts:
        if row.get("suiteId") != suite_id:
            continue
        if row.get("task") != required_receipt_task:
            if required_receipt_task != task and row.get("task") == task:
                ineligible_task_rows += 1
            continue
        if required_kind and row.get("benchmarkKind") != required_kind:
            ineligible_kind_rows += 1
            continue
        recorded_at = _finite_nonnegative(row.get("recordedAtMs"))
        if recorded_at is None or recorded_at < cutoff_ms or recorded_at > now_ms + 300_000:
            continue
        try:
            round_number = int(row.get("round"))
        except (TypeError, ValueError):
            continue
        if round_number < 1:
            continue
        key = _receipt_key(row)
        role = "candidate" if key == wanted_candidate else "baseline" if key == wanted_baseline else ""
        if not role:
            continue
        # Model/effort determines which side a receipt can represent. The
        # declared role is still part of the signed-by-process ledger contract:
        # disagreement or duplicate side labels make the round ambiguous and
        # invalidate the suite instead of silently relabeling a corrupt row.
        if row.get("role") != role:
            role_integrity_failure_rounds.add(round_number)
            continue
        if task in FULL_BROWSE_ROUTE_TASKS:
            if row.get("mechanicsStatus") != "passed":
                browse_mechanics_failure_rounds.add(round_number)
            elif _full_browse_terminal_metrics(row) is None:
                browse_terminal_failure_rounds.add(round_number)
        if task == "curator" and row.get("mechanicsStatus") != "passed":
            # A failed side may have no peer because the benchmark aborts rather
            # than pretending the snapshot comparison remained fair. It still
            # invalidates the whole curator suite.
            curator_mechanics_failure_rounds.add(round_number)
        round_rows = by_round.setdefault(round_number, {})
        if role in round_rows:
            role_integrity_failure_rounds.add(round_number)
            continue
        round_rows[role] = row

    bounded_minimum_paired_passes = _positive_int(minimum_paired_passes, 3)
    required_paired_passes = (
        max(CURATOR_MINIMUM_PAIRED_PASSES, bounded_minimum_paired_passes)
        if task == "curator"
        else bounded_minimum_paired_passes
    )
    paired_passes = 0
    elapsed_ratios: list[float] = []
    outcome_ratios: list[float] = []
    total_token_ratios: list[float] = []
    for pair in by_round.values():
        baseline = pair.get("baseline")
        candidate = pair.get("candidate")
        if not baseline or not candidate:
            continue
        if (
            baseline.get("mechanicsStatus") != "passed"
            or candidate.get("mechanicsStatus") != "passed"
        ):
            if task != "curator":
                mechanics_failures += 1
            continue
        if task in FULL_BROWSE_ROUTE_TASKS:
            baseline_terminal = _full_browse_terminal_metrics(baseline)
            candidate_terminal = _full_browse_terminal_metrics(candidate)
            if baseline_terminal is None or candidate_terminal is None:
                continue
        if (
            baseline.get("qualityStatus") != "passed"
            or candidate.get("qualityStatus") != "passed"
        ):
            continue
        if task == "curator" and (
            not _curator_review_proof(baseline)
            or not _curator_review_proof(candidate)
        ):
            curator_review_proof_failures += 1
            continue
        baseline_elapsed = _finite_nonnegative((baseline.get("metrics") or {}).get("elapsedMs"))
        candidate_elapsed = _finite_nonnegative((candidate.get("metrics") or {}).get("elapsedMs"))
        if baseline_elapsed and candidate_elapsed is not None:
            elapsed_ratios.append(candidate_elapsed / baseline_elapsed)
        if task in FULL_BROWSE_ROUTE_TASKS:
            baseline_fresh, baseline_elapsed_exact, baseline_total_tokens = baseline_terminal
            candidate_fresh, candidate_elapsed_exact, candidate_total_tokens = candidate_terminal
            outcome_ratio = candidate_fresh / baseline_fresh
            elapsed_ratio = candidate_elapsed_exact / baseline_elapsed_exact
            total_token_ratio = candidate_total_tokens / baseline_total_tokens
            outcome_ratios.append(outcome_ratio)
            total_token_ratios.append(total_token_ratio)
            if outcome_ratio < FULL_BROWSE_MIN_OUTCOME_RATIO:
                outcome_equivalence_failures += 1
                continue
            if elapsed_ratio > FULL_BROWSE_MAX_ELAPSED_RATIO:
                latency_equivalence_failures += 1
                continue
            if total_token_ratio > FULL_BROWSE_MAX_TOTAL_TOKEN_RATIO:
                token_equivalence_failures += 1
                continue
        paired_passes += 1

    if task in FULL_BROWSE_ROUTE_TASKS:
        terminal_proof_failures = len(browse_terminal_failure_rounds)
        mechanics_failures = len(
            browse_mechanics_failure_rounds
            | browse_terminal_failure_rounds
            | role_integrity_failure_rounds
        )
    elif task == "curator":
        mechanics_failures = len(
            curator_mechanics_failure_rounds | role_integrity_failure_rounds
        )
    else:
        mechanics_failures += len(role_integrity_failure_rounds)
    qualified = (
        not role_integrity_failure_rounds
        and mechanics_failures == 0
        and paired_passes >= required_paired_passes
    )
    reason = (
        "qualified"
        if qualified
        else "ineligible_benchmark_task"
        if ineligible_task_rows and not by_round
        else "ineligible_benchmark_kind"
        if ineligible_kind_rows and not by_round
        else "ledger_integrity_failure"
        if role_integrity_failure_rounds
        else "mechanics_failure"
        if mechanics_failures
        else "outcome_equivalence_failure"
        if outcome_equivalence_failures
        else "latency_equivalence_failure"
        if latency_equivalence_failures
        else "token_equivalence_failure"
        if token_equivalence_failures
        else "quality_review_proof_failure"
        if curator_review_proof_failures
        else "insufficient_paired_quality_passes"
    )
    decision: dict[str, Any] = {
        "qualified": qualified,
        "reason": reason,
        "pairedPasses": paired_passes,
        "minimumPairedPasses": required_paired_passes,
        "mechanicsFailedPairs": mechanics_failures,
        "roleIntegrityFailedPairs": len(role_integrity_failure_rounds),
    }
    if task == "curator":
        decision["qualityReviewProofFailedPairs"] = curator_review_proof_failures
    if task in FULL_BROWSE_ROUTE_TASKS:
        decision.update({
            "terminalProofFailedPairs": terminal_proof_failures,
            "outcomeEquivalenceFailedPairs": outcome_equivalence_failures,
            "latencyEquivalenceFailedPairs": latency_equivalence_failures,
            "tokenEquivalenceFailedPairs": token_equivalence_failures,
            "minimumOutcomeRatio": FULL_BROWSE_MIN_OUTCOME_RATIO,
            "maximumElapsedRatio": FULL_BROWSE_MAX_ELAPSED_RATIO,
            "maximumTotalTokenRatio": FULL_BROWSE_MAX_TOTAL_TOKEN_RATIO,
        })
    if required_kind:
        decision["requiredBenchmarkKind"] = required_kind
    if required_receipt_task:
        decision["requiredBenchmarkTask"] = required_receipt_task
    if elapsed_ratios:
        decision["meanElapsedRatio"] = sum(elapsed_ratios) / len(elapsed_ratios)
    if outcome_ratios:
        decision["meanOutcomeRatio"] = sum(outcome_ratios) / len(outcome_ratios)
    if total_token_ratios:
        decision["meanTotalTokenRatio"] = (
            sum(total_token_ratios) / len(total_token_ratios)
        )
    return decision


def resolve_route(
    task: str,
    *,
    config_path: Path,
    policy_path: Path,
    live_path: Path,
    receipts_path: Path,
    model_override: str = "",
    effort_override: str = "",
    now_ms: int | None = None,
) -> dict[str, Any]:
    baseline = _route_defaults(task, config_path=config_path, policy_path=policy_path)
    if baseline.get("execution") != "agent":
        return baseline

    explicit_model = _safe_model(model_override)
    allowed_efforts = _allowed_efforts(baseline.get("routePolicy") or {})
    explicit_effort = _safe_effort(effort_override, "") if effort_override else ""
    if explicit_effort not in allowed_efforts:
        explicit_effort = ""
    if explicit_model or explicit_effort:
        return {
            **baseline,
            "model": explicit_model or baseline["model"],
            "effort": explicit_effort or baseline["effort"],
            "origin": "environment",
        }

    live = _read_private_json(live_path)
    entry = (live.get("routes") or {}).get(task)
    if not isinstance(entry, dict):
        return baseline
    route_policy = baseline.get("routePolicy") or {}
    if (
        task in PERSISTENT_OVERRIDE_DISABLED_TASKS
        or route_policy.get("persistentOverrideAllowed") is False
    ):
        return {**baseline, "origin": "baseline_persistent_override_disabled"}
    candidate_model = _safe_model(entry.get("model"))
    candidate_effort = _safe_effort(entry.get("effort"), "")
    if not candidate_model or candidate_effort not in allowed_efforts:
        return {**baseline, "origin": "baseline_invalid_live"}
    if candidate_model == baseline["model"] and candidate_effort == baseline["effort"]:
        return {**baseline, "origin": "live_matches_baseline"}

    if route_policy.get("qualificationRequired") is not True:
        return {**baseline, "model": candidate_model, "effort": candidate_effort, "origin": "live"}

    qualification = entry.get("qualification")
    suite_id = qualification.get("suiteId") if isinstance(qualification, dict) else ""
    policy = baseline.get("policy") or {}
    decision = qualification_decision(
        _read_private_jsonl(receipts_path),
        task=task,
        suite_id=suite_id if isinstance(suite_id, str) else "",
        candidate_model=candidate_model,
        candidate_effort=candidate_effort,
        baseline_model=baseline["model"],
        baseline_effort=baseline["effort"],
        minimum_paired_passes=_positive_int(policy.get("minimumPairedPasses"), 3),
        max_age_hours=_positive_int(policy.get("qualificationMaxAgeHours"), 720),
        now_ms=now_ms,
    )
    if decision["qualified"]:
        return {
            **baseline,
            "model": candidate_model,
            "effort": candidate_effort,
            "origin": "benchmark_qualified_live",
            "qualification": decision,
        }
    return {**baseline, "origin": f"baseline_{decision['reason']}", "qualification": decision}


def _normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(re.sub(r"[^\w]+", " ", value, flags=re.UNICODE).split())


def grounded_title_metrics(response_text: str, tree_text: str) -> dict[str, Any]:
    candidates = re.findall(r'\{"titles"\s*:\s*\[[^\]]*\]\}', response_text, flags=re.DOTALL)
    try:
        payload = json.loads(candidates[-1]) if candidates else {}
    except ValueError:
        payload = {}
    titles = payload.get("titles") if isinstance(payload, dict) else []
    titles = titles if isinstance(titles, list) else []
    valid = [
        title.strip()
        for title in titles
        if isinstance(title, str) and len(_normalize_text(title)) >= 4
    ]
    normalized_titles = {_normalize_text(title) for title in valid}
    normalized_tree = _normalize_text(tree_text)
    grounded = sum(1 for title in normalized_titles if title in normalized_tree)
    mechanics_status = "passed" if len(normalized_tree) >= 40 else "failed"
    quality_status = (
        "passed"
        if (
            mechanics_status == "passed"
            and len(valid) == 5
            and len(normalized_titles) == 5
            and grounded == 5
        )
        else "failed" if mechanics_status == "passed" else "not_scored"
    )
    return {
        "mechanicsStatus": mechanics_status,
        "qualityStatus": quality_status,
        "metrics": {
            "reportedTitles": len(valid),
            "distinctTitles": len(normalized_titles),
            "groundedTitles": grounded,
            "requiredTitles": 5,
            "caseDigest": hashlib.sha256(tree_text.encode("utf-8")).hexdigest(),
        },
    }


def codex_exec_usage(events_path: Path) -> dict[str, int]:
    """Extract content-free token usage from a private ``codex exec --json`` log."""

    latest: dict[str, Any] | None = None
    try:
        lines = events_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return {}
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get("type") != "turn.completed":
            continue
        usage = event.get("usage")
        if isinstance(usage, dict):
            latest = usage
    if latest is None:
        return {}

    def exact_nonnegative(*keys: str) -> int | None:
        for key in keys:
            value = _finite_nonnegative(latest.get(key))
            if value is not None and value.is_integer():
                return int(value)
        return None

    input_tokens = exact_nonnegative("input_tokens", "inputTokens")
    cached_tokens = exact_nonnegative("cached_input_tokens", "cachedInputTokens")
    output_tokens = exact_nonnegative("output_tokens", "outputTokens")
    if (
        input_tokens is None
        or cached_tokens is None
        or output_tokens is None
        or input_tokens < 1
        or output_tokens < 1
        or cached_tokens > input_tokens
    ):
        return {}
    total_tokens = exact_nonnegative("total_tokens", "totalTokens")
    minimum_total = input_tokens + output_tokens
    if total_tokens is None:
        total_tokens = minimum_total
    if total_tokens < minimum_total:
        return {}
    result = {
        "inputTokens": input_tokens,
        "cachedInputTokens": cached_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
    }
    reasoning_tokens = exact_nonnegative(
        "reasoning_output_tokens",
        "reasoningOutputTokens",
    )
    if reasoning_tokens is not None:
        result["reasoningOutputTokens"] = reasoning_tokens
    return result


def append_receipt(path: Path, receipt: dict[str, Any]) -> None:
    benchmark_kind = _safe_model(receipt.get("benchmarkKind"))
    receipt_role = receipt.get("role")
    safe = {
        "schemaVersion": SCHEMA_VERSION,
        "recordedAtMs": int(receipt.get("recordedAtMs") or time.time() * 1000),
        "suiteId": str(receipt.get("suiteId") or "")[:160],
        "round": int(receipt.get("round") or 0),
        "task": str(receipt.get("task") or "")[:80],
        "benchmarkKind": benchmark_kind,
        "role": "baseline" if receipt.get("role") == "baseline" else "candidate",
        "model": _safe_model(receipt.get("model")),
        "effort": _safe_effort(receipt.get("effort"), ""),
        "mechanicsStatus": str(receipt.get("mechanicsStatus") or "failed")[:40],
        "qualityStatus": str(receipt.get("qualityStatus") or "not_scored")[:40],
        "metrics": {},
    }
    metrics = receipt.get("metrics")
    if isinstance(metrics, dict):
        for key, value in metrics.items():
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", key):
                continue
            if isinstance(value, bool) or isinstance(value, (int, float)) and math.isfinite(float(value)):
                safe["metrics"][key] = value
            elif key.endswith("Digest") and isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value):
                safe["metrics"][key] = value
    if (
        not SAFE_TOKEN.fullmatch(safe["suiteId"])
        or safe["round"] < 1
        or not SAFE_TOKEN.fullmatch(safe["task"])
        or not safe["model"]
        or not safe["effort"]
        or BENCHMARK_KIND_BY_TASK.get(safe["task"]) != safe["benchmarkKind"]
    ):
        raise ValueError("invalid benchmark receipt identity")
    mechanics_status = safe["mechanicsStatus"]
    quality_status = safe["qualityStatus"]
    if receipt_role not in RECEIPT_ROLES:
        raise ValueError("invalid benchmark role")
    if mechanics_status not in MECHANICS_STATUSES_BY_TASK[safe["task"]]:
        raise ValueError("invalid benchmark mechanics status")
    if quality_status not in QUALITY_STATUSES:
        raise ValueError("invalid benchmark quality status")
    if mechanics_status != "passed" and quality_status != "not_scored":
        raise ValueError("benchmark mechanics failure cannot carry a quality score")
    if safe["task"] == QUALIFICATION_RECEIPT_TASK["curator"]:
        if quality_status in {"passed", "failed"} and not _curator_review_proof(safe):
            raise ValueError("curator quality requires explicit private artifact review")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(descriptor, stat.S_IRUSR | stat.S_IWUSR)
        os.write(descriptor, (json.dumps(safe, separators=(",", ":")) + "\n").encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    resolve = sub.add_parser("resolve")
    resolve.add_argument("--task", required=True)
    resolve.add_argument("--config", required=True)
    resolve.add_argument("--policy", required=True)
    resolve.add_argument("--live", required=True)
    resolve.add_argument("--receipts", required=True)
    resolve.add_argument("--model-override", default="")
    resolve.add_argument("--effort-override", default="")
    resolve.add_argument("--now-ms", type=int)
    resolve.add_argument("--json", action="store_true")

    grounded = sub.add_parser("grounded-titles")
    grounded.add_argument("--response", required=True)
    grounded.add_argument("--tree", required=True)

    usage = sub.add_parser("codex-usage")
    usage.add_argument("--events", required=True)

    record = sub.add_parser("record")
    record.add_argument("--ledger", required=True)
    record.add_argument("--receipt-json", required=True)

    validate = sub.add_parser("validate-live")
    validate.add_argument("--live", required=True)
    validate.add_argument("--policy", required=True)
    validate.add_argument("--allow-missing", action="store_true")

    phone_config = sub.add_parser("ensure-phone-config")
    phone_config.add_argument("--config", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "resolve":
        result = resolve_route(
            args.task,
            config_path=Path(args.config),
            policy_path=Path(args.policy),
            live_path=Path(args.live),
            receipts_path=Path(args.receipts),
            model_override=args.model_override,
            effort_override=args.effort_override,
            now_ms=args.now_ms,
        )
        if args.json:
            print(json.dumps(result, separators=(",", ":")))
        elif result.get("execution") == "agent":
            print(f"{result['model']}\t{result['effort']}\t{result['origin']}")
        else:
            print(f"-\t-\t{result.get('execution', 'unsupported')}")
        return 0
    if args.command == "grounded-titles":
        result = grounded_title_metrics(
            Path(args.response).read_text(encoding="utf-8", errors="replace"),
            Path(args.tree).read_text(encoding="utf-8", errors="replace"),
        )
        print(json.dumps(result, separators=(",", ":")))
        return 0
    if args.command == "codex-usage":
        result = codex_exec_usage(Path(args.events))
        print(json.dumps(result, separators=(",", ":")))
        return 0
    if args.command == "validate-live":
        return 0 if live_route_file_valid(
            Path(args.live),
            policy_path=Path(args.policy),
            allow_missing=args.allow_missing,
        ) else 1
    if args.command == "ensure-phone-config":
        result = ensure_phone_config_defaults(Path(args.config))
        print(json.dumps(result, separators=(",", ":")))
        return 0
    receipt = json.loads(args.receipt_json)
    if not isinstance(receipt, dict):
        raise ValueError("receipt must be an object")
    append_receipt(Path(args.ledger), receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
