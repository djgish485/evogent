#!/data/data/com.termux/files/usr/bin/env python3
"""Mechanical source-cadence decisions for the phone scheduler.

Cadence controls when evidence collection is due; it never judges content.  Keeping
the arithmetic here avoids shell integer-only math and makes fractional-hour
configuration behave exactly like integer configuration.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import stat
import time
from pathlib import Path
from typing import Any


SOURCE_DUE_SIGNAL_MARKER = b"EVOGENT_SOURCE_DUE_V1\n"
SOURCE_DUE_SIGNAL_DIRECTORY = "source-due-signals"
SOURCE_DUE_SIGNAL_MAX_FUTURE_SKEW_NS = 5 * 60 * 1_000_000_000
SOURCE_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")


def _read_record(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _cadence_hours(
    source: str,
    *,
    live_path: Path,
    default_path: Path,
) -> tuple[float, str]:
    """Return a validated cadence and where the value came from.

    The private live file overrides only entries it actually contains.  Missing
    live entries inherit the public default instead of silently becoming zero.
    Invalid values fail open to due-now, rather than crashing the scheduler or
    suppressing a source indefinitely.
    """

    live = _read_record(live_path)
    defaults = _read_record(default_path)
    if source in live:
        raw = live.get(source)
        origin = "live"
    else:
        raw = defaults.get(source)
        origin = "default" if source in defaults else "missing"

    value = raw.get("cadenceHours") if isinstance(raw, dict) else 0
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or float(value) < 0
    ):
        return 0.0, f"invalid_{origin}"
    return float(value), origin


def _source_signal_state(
    source: str,
    signal_path: Path | None,
    *,
    acknowledged_mtime_ns: int | None,
    now_ns: int,
) -> tuple[bool, str]:
    """Return whether an exact content-free source marker is newer than success.

    Invalid or non-private files never cause browsing. This keeps mutable or
    corrupted state from turning into a permanent broad-sweep trigger.
    """

    if signal_path is None:
        return False, "signal_unconfigured"
    normalized_source = source.strip().lower()
    if (
        source != normalized_source
        or SOURCE_NAME.fullmatch(normalized_source) is None
        or signal_path.name != f"{normalized_source}.due"
        or signal_path.parent.name != SOURCE_DUE_SIGNAL_DIRECTORY
    ):
        return False, "signal_invalid"
    owner_uid = os.getuid()
    try:
        parent_metadata = signal_path.parent.lstat()
    except FileNotFoundError:
        return False, "signal_missing"
    except OSError:
        return False, "signal_invalid"
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or stat.S_ISLNK(parent_metadata.st_mode)
        or stat.S_IMODE(parent_metadata.st_mode) != 0o700
        or parent_metadata.st_uid != owner_uid
    ):
        return False, "signal_invalid"
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory_flag = getattr(os, "O_DIRECTORY", 0)
    if not nofollow or not directory_flag:
        return False, "signal_invalid"
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
            return False, "signal_invalid"
        signal_descriptor = os.open(
            signal_path.name,
            os.O_RDONLY | nofollow,
            dir_fd=parent_descriptor,
        )
        metadata = os.fstat(signal_descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid != owner_uid
            or metadata.st_nlink != 1
            or metadata.st_size != len(SOURCE_DUE_SIGNAL_MARKER)
        ):
            return False, "signal_invalid"
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
            return False, "signal_invalid"
    except FileNotFoundError:
        return False, "signal_missing"
    except OSError:
        return False, "signal_invalid"
    finally:
        if signal_descriptor >= 0:
            os.close(signal_descriptor)
        if parent_descriptor >= 0:
            os.close(parent_descriptor)
    if marker != SOURCE_DUE_SIGNAL_MARKER:
        return False, "signal_invalid"
    if metadata.st_mtime_ns > now_ns + SOURCE_DUE_SIGNAL_MAX_FUTURE_SKEW_NS:
        return False, "signal_future_skew"
    if acknowledged_mtime_ns is None:
        return True, "signal_unacknowledged"
    if metadata.st_mtime_ns > acknowledged_mtime_ns:
        return True, "source_signal"
    return False, "signal_obsolete"


def _private_stamp_mtime_ns(path: Path, *, now_ns: int) -> int | None:
    try:
        expected = path.lstat()
    except OSError:
        return None
    if (
        not stat.S_ISREG(expected.st_mode)
        or stat.S_ISLNK(expected.st_mode)
        or stat.S_IMODE(expected.st_mode) != 0o600
        or expected.st_uid != os.getuid()
        or expected.st_nlink != 1
    ):
        return None
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        return None
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | nofollow)
        metadata = os.fstat(descriptor)
    except OSError:
        return None
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != 1
        or metadata.st_dev != expected.st_dev
        or metadata.st_ino != expected.st_ino
        or metadata.st_mtime_ns > now_ns
    ):
        return None
    return metadata.st_mtime_ns


def _write_private_stamp(path: Path, timestamp_ns: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        raise OSError("nofollow file opens are unavailable")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | nofollow,
        0o600,
    )
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_nlink != 1
        ):
            raise OSError("source cadence stamp is not a private regular file")
        os.fchmod(descriptor, 0o600)
        os.utime(descriptor, ns=(timestamp_ns, timestamp_ns))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def acknowledge_browse_success(
    stamp_path: Path,
    signal_ack_path: Path,
    browse_started_ns: int,
) -> None:
    """Record completion freshness, then only the signal generation covered at start."""

    completed_ns = time.time_ns()
    if (
        isinstance(browse_started_ns, bool)
        or not isinstance(browse_started_ns, int)
        or browse_started_ns <= 0
        or browse_started_ns > completed_ns
    ):
        raise ValueError("invalid browse start generation")
    # Completion comes first. A crash before the second write leaves a valid
    # signal unacknowledged and therefore conservatively due.
    _write_private_stamp(stamp_path, completed_ns)
    _write_private_stamp(signal_ack_path, browse_started_ns)


def cadence_decision(
    source: str,
    *,
    stamp_path: Path,
    live_path: Path,
    default_path: Path,
    signal_path: Path | None = None,
    signal_ack_path: Path | None = None,
    now_seconds: float | None = None,
) -> dict[str, Any]:
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    hours, origin = _cadence_hours(
        source,
        live_path=live_path,
        default_path=default_path,
    )
    if origin.startswith("invalid_"):
        return {"due": True, "hours": 0, "reason": origin, "ageSeconds": None}
    if hours == 0:
        return {"due": True, "hours": 0, "reason": f"{origin}_zero", "ageSeconds": None}
    try:
        stamp_metadata = stamp_path.stat()
        stamp_seconds = stamp_metadata.st_mtime
    except OSError:
        return {"due": True, "hours": hours, "reason": "stamp_missing", "ageSeconds": None}

    age_seconds = now_seconds - stamp_seconds
    if not math.isfinite(age_seconds) or age_seconds < 0:
        return {
            "due": True,
            "hours": hours,
            "reason": "stamp_clock_skew",
            "ageSeconds": age_seconds if math.isfinite(age_seconds) else None,
        }
    signaled, signal_state = _source_signal_state(
        source,
        signal_path,
        acknowledged_mtime_ns=(
            _private_stamp_mtime_ns(
                signal_ack_path,
                now_ns=int(now_seconds * 1_000_000_000),
            )
            if signal_ack_path is not None
            else None
        ),
        now_ns=int(now_seconds * 1_000_000_000),
    )
    if signaled:
        return {
            "due": True,
            "hours": hours,
            "reason": "source_signal",
            "ageSeconds": age_seconds,
            "signalState": signal_state,
        }
    return {
        "due": age_seconds >= hours * 60 * 60,
        "hours": hours,
        "reason": "elapsed" if age_seconds >= hours * 60 * 60 else "within_cadence",
        "ageSeconds": age_seconds,
        "signalState": signal_state,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source")
    parser.add_argument("--stamp", required=True)
    parser.add_argument("--live")
    parser.add_argument("--default")
    parser.add_argument("--signal")
    parser.add_argument("--signal-ack")
    parser.add_argument("--now-seconds", type=float)
    parser.add_argument("--mark-success", action="store_true")
    parser.add_argument("--browse-start-ns", type=int)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.mark_success:
        if args.browse_start_ns is None or not args.signal_ack:
            raise ValueError("--browse-start-ns and --signal-ack are required with --mark-success")
        acknowledge_browse_success(
            Path(args.stamp),
            Path(args.signal_ack),
            args.browse_start_ns,
        )
        return 0
    if not args.source or not args.live or not args.default:
        raise ValueError("--source, --live, and --default are required for cadence decisions")
    decision = cadence_decision(
        args.source,
        stamp_path=Path(args.stamp),
        live_path=Path(args.live),
        default_path=Path(args.default),
        signal_path=Path(args.signal) if args.signal else None,
        signal_ack_path=Path(args.signal_ack) if args.signal_ack else None,
        now_seconds=args.now_seconds,
    )
    # A tab record is deliberately trivial for POSIX shell to parse without jq.
    hours = format(float(decision["hours"]), "g")
    print(f"{1 if decision['due'] else 0}\t{hours}\t{decision['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
