#!/usr/bin/env python3
"""Atomically reserve a monotonic Android versionCode for a release build."""

from __future__ import annotations

import argparse
import fcntl
import os
import pathlib
import re
import sys
import tempfile
import time


VERSION = re.compile(r"^[1-9][0-9]*$")
MAX_VERSION_CODE = 2_147_483_647


def fail(message: str, code: int = 64) -> None:
    print(f"android version allocator: {message}", file=sys.stderr)
    raise SystemExit(code)


def parse_version(raw: str, label: str) -> int:
    if not VERSION.fullmatch(raw):
        fail(f"{label} must be a positive canonical integer")
    value = int(raw)
    if value > MAX_VERSION_CODE:
        fail(f"{label} exceeds the signed 32-bit Android versionCode limit")
    return value


def is_within(path: pathlib.Path, root: pathlib.Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def write_reserved_version(state: pathlib.Path, value: int) -> None:
    descriptor, temporary_raw = tempfile.mkstemp(
        prefix=f".{state.name}.",
        dir=state.parent,
    )
    temporary = pathlib.Path(temporary_raw)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(f"{value}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, state)
        directory = os.open(
            state.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--forbid-root", required=True)
    parser.add_argument("--override")
    parser.add_argument("--now")
    args = parser.parse_args()

    state = pathlib.Path(args.state_file).expanduser().resolve(strict=False)
    forbidden = pathlib.Path(args.forbid_root).resolve(strict=True)
    if is_within(state, forbidden):
        fail("state file must live outside the source checkout")

    now = parse_version(args.now, "clock value") if args.now else int(time.time())
    if now > MAX_VERSION_CODE:
        fail("Unix time no longer fits the Android versionCode range", 65)
    override = (
        parse_version(args.override, "explicit override")
        if args.override is not None
        else None
    )

    state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = state.with_name(f"{state.name}.lock")
    lock_descriptor = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.fchmod(lock_descriptor, 0o600)
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
        if state.exists():
            if not state.is_file() or state.is_symlink():
                fail("state path is not a regular file", 65)
            previous = parse_version(
                state.read_text(encoding="ascii").strip(),
                "reserved version",
            )
        else:
            previous = 0

        if override is not None:
            if override <= previous:
                fail("explicit override is not newer than the reserved version", 65)
            chosen = override
        else:
            chosen = max(now, previous + 1)
            if chosen > MAX_VERSION_CODE:
                fail("no newer Android versionCode remains available", 65)

        write_reserved_version(state, chosen)
        print(chosen)
    finally:
        os.close(lock_descriptor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
