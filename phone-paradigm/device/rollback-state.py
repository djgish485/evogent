#!/usr/bin/env python3
"""Validate one exact, immediately usable Android APK rollback."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field


ROLLBACK_ID = re.compile(r"^[0-9]+:$")
PACKAGE_ROW = re.compile(
    r"^(?P<package>[A-Za-z0-9_.]+) "
    r"(?P<from_version>[0-9]+) -> (?P<to_version>[0-9]+)"
    r"(?: \[[0-9]+\])?$"
)
CAUSE_PACKAGE_ROW = re.compile(r"^[A-Za-z0-9_.]+ [0-9]+$")
EXTENSION_VERSION = re.compile(r"(?P<sdk>[0-9]+)=(?P<version>[0-9]+)")
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9_.]+$")
VERSION_CODE = re.compile(r"^[0-9]+$")
HISTORICAL_BOUNDARY = "Historical rollbacks:"
WATCHDOG_BOUNDARY = "Package Watchdog status"
MAX_EXTENSION_VERSIONS = 64
MAX_SIGNED_INT = (1 << 31) - 1


@dataclass
class Rollback:
    rollback_id: str = ""
    section: str = "active"
    state: str = ""
    staged: bool = False
    valid: bool = True
    strict_valid: bool = True
    state_seen: bool = False
    staged_seen: bool = False
    original_session_seen: bool = False
    original_session_id: int = -1
    committed_session_seen: bool = False
    committed_session_id: int = -1
    packages_seen: bool = False
    packages: list[tuple[str, int, int]] = field(default_factory=list)
    cause_packages_seen: bool = False
    extension_versions_seen: bool = False
    extension_versions_rows: int = 0
    scalar_fields: set[str] = field(default_factory=set)
    unknown_lines: list[str] = field(default_factory=list)


def valid_extension_versions(line: str) -> bool:
    if not (line.startswith("{") and line.endswith("}")):
        return False
    body = line[1:-1]
    if not body:
        return False
    parts = body.split(", ")
    if not 1 <= len(parts) <= MAX_EXTENSION_VERSIONS:
        return False
    seen: set[int] = set()
    for part in parts:
        match = EXTENSION_VERSION.fullmatch(part)
        if match is None:
            return False
        sdk = int(match["sdk"])
        version = int(match["version"])
        if (
            sdk > MAX_SIGNED_INT
            or version > MAX_SIGNED_INT
            or sdk in seen
        ):
            return False
        seen.add(sdk)
    return True


def strict_dump_framing(raw: str) -> bool:
    lines = raw.splitlines()
    historical = [
        index
        for index, line in enumerate(lines)
        if line == HISTORICAL_BOUNDARY
    ]
    watchdog = [
        index
        for index, line in enumerate(lines)
        if line == WATCHDOG_BOUNDARY
    ]
    if not (
        len(historical) == 1
        and len(watchdog) == 1
        and historical[0] < watchdog[0]
    ):
        return False
    # Outside the Package Watchdog tail, each non-empty section must begin
    # with a rollback ID. This rejects an unrecognized top-level preamble
    # instead of silently treating a truncated or shifted dump as authority.
    record_seen = False
    for source_line in lines[:watchdog[0]]:
        if source_line == HISTORICAL_BOUNDARY:
            record_seen = False
            continue
        line = source_line.strip()
        if ROLLBACK_ID.fullmatch(line):
            record_seen = True
        elif line and not record_seen:
            return False
    return True


def parse_rollbacks(raw: str) -> list[Rollback]:
    rollbacks: list[Rollback] = []
    current: Rollback | None = None
    section = "active"
    detail = ""

    for source_line in raw.splitlines():
        if source_line == HISTORICAL_BOUNDARY:
            current = None
            section = "historical"
            detail = ""
            continue
        if source_line == WATCHDOG_BOUNDARY:
            break
        line = source_line.strip()
        if ROLLBACK_ID.fullmatch(line):
            current = Rollback(rollback_id=line[:-1], section=section)
            rollbacks.append(current)
            detail = ""
            continue
        if current is None:
            continue
        if line.startswith("-state:"):
            if current.state_seen:
                current.strict_valid = False
            current.state_seen = True
            current.state = line.partition(":")[2].strip()
            detail = ""
            continue
        if line.startswith("-isStaged:"):
            if current.staged_seen:
                current.strict_valid = False
            current.staged_seen = True
            value = line.partition(":")[2].strip().lower()
            if value not in {"true", "false"}:
                current.valid = False
            elif value == "true":
                current.staged = True
            detail = ""
            continue
        if line.startswith("-stagedSessionId:"):
            # Older Android dumps omit -isStaged and emit this field only for a
            # staged rollback. Staged APK recovery would require a reboot.
            if current.staged_seen:
                current.strict_valid = False
            current.staged_seen = True
            current.staged = True
            detail = ""
            continue
        if line.startswith("-originalSessionId:"):
            if current.original_session_seen:
                current.strict_valid = False
            current.original_session_seen = True
            value = line.partition(":")[2].strip()
            if (
                not value.isdigit()
                or not 0 < int(value) <= MAX_SIGNED_INT
            ):
                current.valid = False
            else:
                current.original_session_id = int(value)
            detail = ""
            continue
        if line == "-packages:":
            if current.packages_seen:
                current.strict_valid = False
            current.packages_seen = True
            detail = "packages"
            continue
        if line == "-causePackages:":
            if current.cause_packages_seen:
                current.strict_valid = False
            current.cause_packages_seen = True
            detail = "cause-packages"
            continue
        if line.startswith("-committedSessionId:"):
            if current.committed_session_seen:
                current.strict_valid = False
            current.committed_session_seen = True
            value = line.partition(":")[2].strip()
            if (
                not value.isdigit()
                or not 0 < int(value) <= MAX_SIGNED_INT
            ):
                current.valid = False
            else:
                current.committed_session_id = int(value)
            detail = ""
            continue
        if line == "-extensionVersions:":
            if current.extension_versions_seen:
                current.strict_valid = False
            current.extension_versions_seen = True
            detail = "extension-versions"
            continue
        scalar = next(
            (
                field_name
                for field_name in (
                    "stateDescription",
                    "timestamp",
                    "rollbackLifetimeMillis",
                    "rollbackImpactLevel",
                )
                if line.startswith(f"-{field_name}:")
            ),
            None,
        )
        if scalar is not None:
            if scalar in current.scalar_fields:
                current.strict_valid = False
            current.scalar_fields.add(scalar)
            detail = ""
            continue
        if line.startswith("-"):
            current.strict_valid = False
            current.unknown_lines.append(line)
            detail = ""
            continue
        if detail == "packages":
            match = PACKAGE_ROW.fullmatch(line)
            if match:
                package = (
                    match["package"],
                    int(match["from_version"]),
                    int(match["to_version"]),
                )
                if package in current.packages:
                    current.strict_valid = False
                current.packages.append(package)
            elif line:
                current.valid = False
                current.unknown_lines.append(line)
        elif detail == "cause-packages":
            if line and CAUSE_PACKAGE_ROW.fullmatch(line) is None:
                current.valid = False
                current.unknown_lines.append(line)
        elif detail == "extension-versions":
            if line:
                current.extension_versions_rows += 1
                if (
                    current.extension_versions_rows != 1
                    or not valid_extension_versions(line)
                ):
                    current.valid = False
                    current.unknown_lines.append(line)
        elif line:
            current.strict_valid = False
            current.unknown_lines.append(line)

    for rollback in rollbacks:
        if (
            rollback.extension_versions_seen
            and rollback.extension_versions_rows != 1
        ):
            rollback.strict_valid = False

    return rollbacks


def has_exact_available_rollback(
    raw: str,
    package: str,
    installed_version: int,
    backup_version: int,
) -> bool:
    expected = [(package, installed_version, backup_version)]
    return any(
        rollback.valid
        and rollback.state == "available"
        and not rollback.staged
        and rollback.packages == expected
        for rollback in parse_rollbacks(raw)
    )


def exact_rollback_status(
    raw: str,
    package: str,
    installed_version: int,
    backup_version: int,
) -> str:
    expected = (package, installed_version, backup_version)
    rollbacks = parse_rollbacks(raw)
    # Recovery authority comes only from one complete, framed system dump.
    # In particular, the historical records must end before Package Watchdog
    # output, whose numeric headings are not rollback IDs.
    if (
        not strict_dump_framing(raw)
        or not rollbacks
        or any(
            not rollback.valid
            or not rollback.strict_valid
            or rollback.state
            not in {"enabling", "available", "committed", "deleted"}
            or not rollback.state_seen
            or not rollback.staged_seen
            or not rollback.original_session_seen
            or not rollback.packages_seen
            or not rollback.packages
            for rollback in rollbacks
        )
    ):
        return "available"
    affecting_installed = [
        rollback
        for rollback in rollbacks
        if any(
            candidate_package == package
            and from_version == installed_version
            for candidate_package, from_version, _to_version
            in rollback.packages
        )
    ]
    if not affecting_installed:
        return "available"
    # Every record capable of moving the installed target must be the same
    # exact, single-package lineage. Distinct historical records for repeated
    # attempts are legitimate; duplicate rollback/session identities are not.
    if any(
        rollback.packages != [expected]
        or rollback.staged
        or (
            rollback.section == "active"
            and (
                rollback.state != "committed"
                or not rollback.committed_session_seen
            )
        )
        or (
            rollback.section == "historical"
            and (
                rollback.state != "deleted"
                or rollback.committed_session_seen
            )
        )
        for rollback in affecting_installed
    ):
        return "available"
    sections = {rollback.section for rollback in affecting_installed}
    if len(sections) != 1:
        return "available"
    rollback_ids = [rollback.rollback_id for rollback in affecting_installed]
    original_sessions = [
        rollback.original_session_id for rollback in affecting_installed
    ]
    if (
        len(rollback_ids) != len(set(rollback_ids))
        or len(original_sessions) != len(set(original_sessions))
    ):
        return "available"
    return "consumed"


def main(argv: list[str]) -> int:
    if len(argv) != 5 or argv[1] not in {"check", "require-consumed"}:
        print(
            "usage: rollback-state.py <check|require-consumed> <package> "
            "<installed-version> <backup-version>",
            file=sys.stderr,
        )
        return 64
    package, installed_raw, backup_raw = argv[2:]
    if (
        not PACKAGE_NAME.fullmatch(package)
        or not VERSION_CODE.fullmatch(installed_raw)
        or not VERSION_CODE.fullmatch(backup_raw)
    ):
        print("rollback-state: invalid package or version", file=sys.stderr)
        return 64
    raw = sys.stdin.read()
    if argv[1] == "check":
        return (
            0
            if has_exact_available_rollback(
                raw,
                package,
                int(installed_raw),
                int(backup_raw),
            )
            else 1
        )
    status = exact_rollback_status(
        raw,
        package,
        int(installed_raw),
        int(backup_raw),
    )
    if status != "consumed":
        print(
            f"rollback-state: exact rollback is {status}, not consumed",
            file=sys.stderr,
        )
        return 1
    print("consumed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
