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
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9_.]+$")
VERSION_CODE = re.compile(r"^[0-9]+$")


@dataclass
class Rollback:
    rollback_id: str = ""
    state: str = ""
    staged: bool = False
    valid: bool = True
    strict_valid: bool = True
    state_seen: bool = False
    staged_seen: bool = False
    packages_seen: bool = False
    packages: list[tuple[str, int, int]] = field(default_factory=list)


def parse_rollbacks(raw: str) -> list[Rollback]:
    rollbacks: list[Rollback] = []
    current: Rollback | None = None
    in_packages = False

    for source_line in raw.splitlines():
        line = source_line.strip()
        if ROLLBACK_ID.fullmatch(line):
            current = Rollback(rollback_id=line[:-1])
            rollbacks.append(current)
            in_packages = False
            continue
        if current is None:
            continue
        if line.startswith("-state:"):
            if current.state_seen:
                current.strict_valid = False
            current.state_seen = True
            current.state = line.partition(":")[2].strip()
            in_packages = False
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
            in_packages = False
            continue
        if line.startswith("-stagedSessionId:"):
            # Older Android dumps omit -isStaged and emit this field only for a
            # staged rollback. Staged APK recovery would require a reboot.
            if current.staged_seen:
                current.strict_valid = False
            current.staged_seen = True
            current.staged = True
            in_packages = False
            continue
        if line == "-packages:":
            if current.packages_seen:
                current.strict_valid = False
            current.packages_seen = True
            in_packages = True
            continue
        if line.startswith("-"):
            in_packages = False
            continue
        if in_packages:
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
        elif line:
            current.strict_valid = False

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
    # A malformed record cannot be proven unrelated to the package. Fail
    # closed instead of allowing one well-formed terminal row to hide an
    # unparsed pending rollback elsewhere in the same authoritative dump.
    if any(
        not rollback.valid
        or not rollback.strict_valid
        or rollback.state not in {"available", "committed", "deleted"}
        or not rollback.state_seen
        or not rollback.packages_seen
        or not rollback.packages
        for rollback in rollbacks
    ):
        return "available"
    rollback_ids = [rollback.rollback_id for rollback in rollbacks]
    package_rows = [
        package_row
        for rollback in rollbacks
        for package_row in rollback.packages
    ]
    if (
        len(set(rollback_ids)) != len(rollback_ids)
        or len(set(package_rows)) != len(package_rows)
    ):
        return "available"
    containing = [
        rollback
        for rollback in rollbacks
        if expected in rollback.packages
    ]
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
    # A historical terminal record is not proof of unavailability when any
    # rollback can still move the currently installed package, even when its
    # target differs from the retained backup version. Multi-package rollback
    # records can still downgrade this package and must not be ignored.
    if any(
        rollback.staged
        or rollback.state not in {"committed", "deleted"}
        for rollback in affecting_installed
    ):
        return "available"
    if containing:
        return "consumed"
    return "absent"


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
