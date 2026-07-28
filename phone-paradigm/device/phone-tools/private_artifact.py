#!/data/data/com.termux/files/usr/bin/env python3
"""Postconditions for scheduler-owned private learning artifacts."""

from __future__ import annotations

import argparse
import json
import math
import os
import stat
from pathlib import Path


MAX_PRIVATE_ARTIFACT_BYTES = 49_152


def artifact_identity(path: Path) -> str:
    try:
        info = path.stat()
    except OSError:
        return "missing"
    return f"{info.st_dev}:{info.st_ino}"


def _private_file_valid(path: Path) -> bool:
    try:
        info = path.stat()
    except OSError:
        return False
    return (
        stat.S_ISREG(info.st_mode)
        and stat.S_IMODE(info.st_mode) == 0o600
        and info.st_size > 0
        and info.st_size <= MAX_PRIVATE_ARTIFACT_BYTES
    )


def preference_insights_valid(path: Path) -> bool:
    return _private_file_valid(path)


def source_cadence_valid(path: Path) -> bool:
    if not _private_file_valid(path):
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict) or not data:
        return False
    for source, entry in data.items():
        if not isinstance(source, str) or not source.strip() or not isinstance(entry, dict):
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
        if not isinstance(why, str) or not why.strip() or len(why.strip()) > 240:
            return False
    return True


def artifact_was_atomically_rewritten(
    path: Path,
    *,
    before_identity: str,
    kind: str,
) -> bool:
    # The worker contract requires temp-file + rename even on a no-change pass.
    # The old destination still exists while the temp inode is created, so a
    # successful atomic replacement necessarily changes (device, inode).
    if artifact_identity(path) in {"missing", before_identity}:
        return False
    if kind == "preference":
        return preference_insights_valid(path)
    if kind == "cadence":
        return source_cadence_valid(path)
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--path", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--path", required=True)
    verify.add_argument("--before", required=True)
    verify.add_argument("--kind", required=True, choices=("preference", "cadence"))
    args = parser.parse_args(argv)

    path = Path(args.path)
    if args.command == "snapshot":
        print(artifact_identity(path))
        return 0
    return 0 if artifact_was_atomically_rewritten(
        path,
        before_identity=args.before,
        kind=args.kind,
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
