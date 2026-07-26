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
    state: str = ""
    staged: bool = False
    valid: bool = True
    packages: list[tuple[str, int, int]] = field(default_factory=list)


def parse_rollbacks(raw: str) -> list[Rollback]:
    rollbacks: list[Rollback] = []
    current: Rollback | None = None
    in_packages = False

    for source_line in raw.splitlines():
        line = source_line.strip()
        if ROLLBACK_ID.fullmatch(line):
            current = Rollback()
            rollbacks.append(current)
            in_packages = False
            continue
        if current is None:
            continue
        if line.startswith("-state:"):
            current.state = line.partition(":")[2].strip()
            in_packages = False
            continue
        if line.startswith("-isStaged:"):
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
            current.staged = True
            in_packages = False
            continue
        if line == "-packages:":
            in_packages = True
            continue
        if line.startswith("-"):
            in_packages = False
            continue
        if in_packages:
            match = PACKAGE_ROW.fullmatch(line)
            if match:
                current.packages.append(
                    (
                        match["package"],
                        int(match["from_version"]),
                        int(match["to_version"]),
                    )
                )
            elif line:
                current.valid = False

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


def main(argv: list[str]) -> int:
    if len(argv) != 5 or argv[1] != "check":
        print(
            "usage: rollback-state.py check <package> "
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
    return (
        0
        if has_exact_available_rollback(
            sys.stdin.read(),
            package,
            int(installed_raw),
            int(backup_raw),
        )
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
