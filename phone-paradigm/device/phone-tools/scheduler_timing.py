#!/data/data/com.termux/files/usr/bin/env python3
"""Small, testable timing mechanics for the phone scheduler."""

from __future__ import annotations

import argparse
import json
import math
import os
import secrets
import stat
import time
from pathlib import Path


CYCLE_FAILURE_BACKOFF_VERSION = 1
DEFAULT_CYCLE_FAILURE_BASE_SECONDS = 5 * 60
DEFAULT_CYCLE_FAILURE_MAX_SECONDS = 2 * 60 * 60
MAX_CYCLE_FAILURE_COUNT = 32
MAX_CYCLE_FAILURE_STATE_BYTES = 512


class InvalidCycleFailureState(ValueError):
    """An existing state path could not safely authorize an immediate retry."""


def _fsync_parent(path: Path) -> None:
    try:
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        # Some Android filesystems do not permit fsync on directory descriptors.
        pass


def _atomic_write_private_json(path: Path, value: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        payload = (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode()
        if len(payload) > MAX_CYCLE_FAILURE_STATE_BYTES:
            raise ValueError("cycle failure state exceeds its bounded schema")
        try:
            offset = 0
            while offset < len(payload):
                written = os.write(descriptor, payload[offset:])
                if written <= 0:
                    raise OSError("short write while publishing cycle failure state")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temp, path)
        os.chmod(path, 0o600)
        _fsync_parent(path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _discard_cycle_failure_state(path: Path, *, strict: bool = False) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError:
        if strict:
            raise
        return
    _fsync_parent(path)


def _cycle_failure_bounds(base_seconds: object, max_seconds: object) -> tuple[int, int]:
    try:
        base = int(base_seconds)
    except (TypeError, ValueError):
        base = DEFAULT_CYCLE_FAILURE_BASE_SECONDS
    try:
        maximum = int(max_seconds)
    except (TypeError, ValueError):
        maximum = DEFAULT_CYCLE_FAILURE_MAX_SECONDS
    if maximum < 1 or maximum > DEFAULT_CYCLE_FAILURE_MAX_SECONDS:
        maximum = DEFAULT_CYCLE_FAILURE_MAX_SECONDS
    if base < 1 or base > DEFAULT_CYCLE_FAILURE_MAX_SECONDS:
        base = DEFAULT_CYCLE_FAILURE_BASE_SECONDS
    base = min(base, maximum)
    return base, maximum


def _read_cycle_failure_state(path: Path, *, maximum_seconds: int) -> dict[str, int] | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise InvalidCycleFailureState("cycle failure state could not be inspected") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or metadata.st_size < 2
        or metadata.st_size > MAX_CYCLE_FAILURE_STATE_BYTES
    ):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state has unsafe file metadata")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state could not be opened safely") from error
    try:
        current = os.fstat(descriptor)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
            or current.st_dev != metadata.st_dev
            or current.st_ino != metadata.st_ino
        ):
            _discard_cycle_failure_state(path)
            raise InvalidCycleFailureState("cycle failure state changed while opening")
        if stat.S_IMODE(current.st_mode) != 0o600:
            os.fchmod(descriptor, 0o600)
        payload = os.read(descriptor, MAX_CYCLE_FAILURE_STATE_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(payload) > MAX_CYCLE_FAILURE_STATE_BYTES:
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state exceeds its size bound")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state is not valid JSON")
    expected_keys = {
        "version",
        "consecutiveFailures",
        "delaySeconds",
        "notBeforeEpochSeconds",
        "updatedAtEpochSeconds",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state has an unknown schema")
    if any(type(value[key]) is not int for key in expected_keys):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state fields must be integers")
    try:
        normalized = {key: int(value[key]) for key in expected_keys}
    except (TypeError, ValueError):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state fields are invalid")
    if (
        normalized["version"] != CYCLE_FAILURE_BACKOFF_VERSION
        or not 1 <= normalized["consecutiveFailures"] <= MAX_CYCLE_FAILURE_COUNT
        or not 1 <= normalized["delaySeconds"] <= maximum_seconds
        or normalized["notBeforeEpochSeconds"] < 0
        or normalized["updatedAtEpochSeconds"] < 0
    ):
        _discard_cycle_failure_state(path)
        raise InvalidCycleFailureState("cycle failure state values are outside their bounds")
    return normalized


def record_cycle_failure(
    state_path: Path,
    *,
    now_seconds: float | None = None,
    base_seconds: int = DEFAULT_CYCLE_FAILURE_BASE_SECONDS,
    max_seconds: int = DEFAULT_CYCLE_FAILURE_MAX_SECONDS,
) -> dict[str, int]:
    """Persist the next exponential retry boundary before the scheduler sleeps."""

    base, maximum = _cycle_failure_bounds(base_seconds, max_seconds)
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        now_seconds = time.time()
    try:
        previous = _read_cycle_failure_state(state_path, maximum_seconds=maximum)
    except InvalidCycleFailureState:
        # The invalid path was retired above. The failure currently being
        # recorded becomes the first trustworthy bounded generation.
        previous = None
    previous_count = int(previous["consecutiveFailures"]) if previous else 0
    count = min(MAX_CYCLE_FAILURE_COUNT, previous_count + 1)
    exponent = min(count - 1, MAX_CYCLE_FAILURE_COUNT - 1)
    delay = min(maximum, base * (2 ** exponent))
    state = {
        "version": CYCLE_FAILURE_BACKOFF_VERSION,
        "consecutiveFailures": count,
        "delaySeconds": delay,
        "notBeforeEpochSeconds": int(math.ceil(now_seconds + delay)),
        "updatedAtEpochSeconds": int(now_seconds),
    }
    _atomic_write_private_json(state_path, state)
    return state


def cycle_failure_remaining_seconds(
    state_path: Path,
    *,
    now_seconds: float | None = None,
    max_seconds: int = DEFAULT_CYCLE_FAILURE_MAX_SECONDS,
) -> int:
    """Return a bounded persisted delay; repair large future-clock skew once."""

    _, maximum = _cycle_failure_bounds(1, max_seconds)
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    if not math.isfinite(now_seconds) or now_seconds < 0:
        now_seconds = time.time()
    try:
        state = _read_cycle_failure_state(state_path, maximum_seconds=maximum)
    except InvalidCycleFailureState:
        # Missing means no known failure. Existing-but-invalid is different:
        # it may be crash-corrupted guard evidence, so atomically replace it
        # with one conservative base window instead of failing open.
        state = record_cycle_failure(
            state_path,
            now_seconds=now_seconds,
            base_seconds=min(DEFAULT_CYCLE_FAILURE_BASE_SECONDS, maximum),
            max_seconds=maximum,
        )
    if not state:
        return 0
    deadline = int(state["notBeforeEpochSeconds"])
    maximum_deadline = int(math.ceil(now_seconds + maximum))
    if deadline > maximum_deadline:
        # A wall-clock rollback must not suppress cycles forever. Persist the cap
        # so repeated scheduler/watchdog restarts count down one bounded window.
        state["notBeforeEpochSeconds"] = maximum_deadline
        state["delaySeconds"] = maximum
        state["updatedAtEpochSeconds"] = int(now_seconds)
        _atomic_write_private_json(state_path, state)
        deadline = maximum_deadline
    return max(0, min(maximum, int(math.ceil(deadline - now_seconds))))


def clear_cycle_failure_backoff(state_path: Path) -> None:
    """Durably clear consecutive-failure state after a successful cycle."""

    _discard_cycle_failure_state(state_path, strict=True)


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
    parser.add_argument("--cycle-failure-state")
    parser.add_argument(
        "--cycle-failure-action",
        choices=("remaining", "record-failure", "clear"),
    )
    parser.add_argument(
        "--cycle-failure-base-seconds",
        type=int,
        default=DEFAULT_CYCLE_FAILURE_BASE_SECONDS,
    )
    parser.add_argument(
        "--cycle-failure-max-seconds",
        type=int,
        default=DEFAULT_CYCLE_FAILURE_MAX_SECONDS,
    )
    parser.add_argument("--now-seconds", type=float)
    args = parser.parse_args(argv)
    if args.cycle_failure_action:
        if not args.cycle_failure_state:
            parser.error("--cycle-failure-state is required with --cycle-failure-action")
        state_path = Path(args.cycle_failure_state)
        if args.cycle_failure_action == "remaining":
            print(
                cycle_failure_remaining_seconds(
                    state_path,
                    now_seconds=args.now_seconds,
                    max_seconds=args.cycle_failure_max_seconds,
                )
            )
        elif args.cycle_failure_action == "record-failure":
            state = record_cycle_failure(
                state_path,
                now_seconds=args.now_seconds,
                base_seconds=args.cycle_failure_base_seconds,
                max_seconds=args.cycle_failure_max_seconds,
            )
            print(state["delaySeconds"])
        else:
            clear_cycle_failure_backoff(state_path)
            print(0)
        return 0
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
