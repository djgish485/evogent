#!/data/data/com.termux/files/usr/bin/python3
"""Atomically install Evogent's APK control token from standard input.

The token intentionally never appears in a command argument, environment
variable, or success/error message.  Both the release installer and the
fresh-phone setup path stream shell-owned app storage directly into this
writer.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import sys
import tempfile


TOKEN = re.compile(
    rb"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
MAX_TOKEN_BYTES = 64


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"control-token install: {message}")


def main() -> None:
    if len(sys.argv) != 2:
        fail("one destination path is required")

    destination = Path(sys.argv[1])
    if not destination.is_absolute():
        fail("destination must be absolute")
    parent = destination.parent
    try:
        parent_metadata = parent.lstat()
    except OSError:
        fail("destination directory is unavailable")
    if parent.is_symlink() or not stat.S_ISDIR(parent_metadata.st_mode):
        fail("destination directory must be a real directory")

    try:
        destination_metadata = destination.lstat()
    except FileNotFoundError:
        destination_metadata = None
    except OSError:
        fail("destination could not be inspected")
    if destination_metadata is not None and (
        destination.is_symlink()
        or not stat.S_ISREG(destination_metadata.st_mode)
    ):
        fail("destination must be a regular private file")

    token = sys.stdin.buffer.read(MAX_TOKEN_BYTES + 1)
    if not TOKEN.fullmatch(token):
        fail("input does not contain one valid per-install token")

    descriptor = -1
    temporary_name = ""
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".control-token.",
            dir=parent,
        )
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(token)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, destination)
        temporary_name = ""
        os.chmod(destination, 0o600, follow_symlinks=False)
        directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    main()
