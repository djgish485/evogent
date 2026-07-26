#!/data/data/com.termux/files/usr/bin/env python3
"""Small, testable timing mechanics for the phone scheduler."""

from __future__ import annotations

import argparse
import math
import os
import time
from pathlib import Path


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
    """Seconds until a restarted scheduler may run another successful-cycle follow-up."""

    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    minimum = float(minimum_interval_minutes)
    if not math.isfinite(minimum) or minimum < 0:
        minimum = 0
    try:
        completed_at = completion_stamp.stat().st_mtime
    except OSError:
        return 0
    # A large future timestamp is clock-skew evidence, not authority to suppress work forever.
    if completed_at > now_seconds + 60:
        completed_at = now_seconds
    remaining = completed_at + minimum * 60 - now_seconds
    return max(0, math.ceil(remaining))


def ensure_watchdog_success_reference(
    successful_completion_stamp: Path,
    missing_success_baseline: Path,
    *,
    now_seconds: float | None = None,
) -> Path:
    """Return the liveness clock, creating a private install baseline when success is absent."""

    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if successful_completion_stamp.is_file():
        try:
            missing_success_baseline.unlink()
        except FileNotFoundError:
            pass
        return successful_completion_stamp

    missing_success_baseline.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(
            missing_success_baseline,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError:
        descriptor = None
    if descriptor is not None:
        try:
            os.write(descriptor, f"{int(now_seconds)}\n".encode())
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.utime(missing_success_baseline, (now_seconds, now_seconds))
    os.chmod(missing_success_baseline, 0o600)
    return missing_success_baseline


def watchdog_success_reference_overdue(
    reference: Path,
    *,
    overdue_minutes: float,
    now_seconds: float | None = None,
) -> bool:
    """Whether neither a successful cycle nor the first-observation grace is recent."""

    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    overdue = float(overdue_minutes)
    if not math.isfinite(overdue) or overdue < 0:
        overdue = 0
    try:
        observed_at = reference.stat().st_mtime
    except OSError:
        return False
    if observed_at > now_seconds + 60:
        # Repair clock-skew evidence once instead of letting a future stamp suppress liveness
        # forever by being re-capped to "now" on every watchdog tick.
        os.utime(reference, (now_seconds, now_seconds))
        observed_at = now_seconds
    return now_seconds - observed_at > overdue * 60


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--completion-stamp")
    parser.add_argument("--minimum-minutes", type=float)
    parser.add_argument("--watchdog-success-stamp")
    parser.add_argument("--watchdog-missing-baseline")
    parser.add_argument("--watchdog-overdue-minutes", type=float)
    parser.add_argument("--scheduler-bounds", action="store_true")
    parser.add_argument("--scheduler-minimum-value")
    parser.add_argument("--scheduler-maximum-value")
    parser.add_argument("--scheduler-fixed-value")
    parser.add_argument("--now-seconds", type=float)
    args = parser.parse_args(argv)
    if args.scheduler_bounds:
        minimum, maximum = normalize_scheduler_bounds(
            args.scheduler_minimum_value,
            args.scheduler_maximum_value,
            fixed_value=args.scheduler_fixed_value,
        )
        print(f"{minimum}\t{maximum}")
        return 0
    if args.watchdog_success_stamp:
        if not args.watchdog_missing_baseline or args.watchdog_overdue_minutes is None:
            parser.error(
                "--watchdog-missing-baseline and --watchdog-overdue-minutes are required "
                "with --watchdog-success-stamp"
            )
        reference = ensure_watchdog_success_reference(
            Path(args.watchdog_success_stamp),
            Path(args.watchdog_missing_baseline),
            now_seconds=args.now_seconds,
        )
        overdue = watchdog_success_reference_overdue(
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
