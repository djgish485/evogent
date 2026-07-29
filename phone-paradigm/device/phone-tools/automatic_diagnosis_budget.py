#!/data/data/com.termux/files/usr/bin/env python3
"""Crash-safe global budget for automatic source-health diagnosis.

The source tripwire remains in ``evogent-cycle.sh``.  This helper owns only the
small piece of durable scheduling state needed to ensure that all sources share
one automatic diagnosis slot per local service date. Proved-empty content and
retrieval/receipt mechanics use separate per-source lanes under that one budget.

A slot is recorded before the provider process may launch.  An abrupt stop
therefore consumes the slot instead of replaying an expensive diagnosis after
restart.  Deferred thresholds remain pending and can claim a later service
date.  Manual operator work does not use this helper.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
import secrets
import stat
import sys
import time
from pathlib import Path
from typing import Any, Iterator


SCHEMA_VERSION = 1
MAX_STATE_BYTES = 2 * 1024 * 1024
MAX_SOURCE_LENGTH = 160
INCIDENT_LANES = frozenset(("barren", "mechanics"))
# Recent dates remain exact. Older dates compact into a monotonic closed
# boundary: dates at or below it stay fail-closed after clock rollback without
# letting the claims map grow forever.
MAX_EXACT_CLAIMS = 400


class DiagnosisBudgetError(RuntimeError):
    """The budget cannot safely decide whether today's slot is free."""


def now_ms() -> int:
    return int(time.time() * 1000)


def local_service_date(stamp_ms: int | None = None) -> str:
    stamp_ms = now_ms() if stamp_ms is None else int(stamp_ms)
    return dt.datetime.fromtimestamp(stamp_ms / 1000).astimezone().date().isoformat()


def _validated_service_date(value: str | None, stamp_ms: int) -> str:
    if value is None:
        return local_service_date(stamp_ms)
    try:
        parsed = dt.date.fromisoformat(value)
    except (TypeError, ValueError) as error:
        raise DiagnosisBudgetError("invalid service date") from error
    if parsed.isoformat() != value:
        raise DiagnosisBudgetError("invalid service date")
    return value


def _validated_source(value: str) -> str:
    source = str(value or "")
    if (
        not source
        or len(source) > MAX_SOURCE_LENGTH
        or any(character in source for character in ("\x00", "\r", "\n"))
    ):
        raise DiagnosisBudgetError("invalid source identifier")
    return source


def _empty_state() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "claims": {},
        "sources": {},
        "mechanicsSources": {},
    }


def _validated_lane(value: str | None) -> str:
    lane = str(value or "barren")
    if lane not in INCIDENT_LANES:
        raise DiagnosisBudgetError("invalid diagnosis incident lane")
    return lane


def _validate_source_records(
    records: object,
    *,
    mechanics: bool = False,
) -> dict[str, Any]:
    if not isinstance(records, dict):
        raise DiagnosisBudgetError("malformed diagnosis source state")
    for source, record in records.items():
        _validated_source(source)
        if not isinstance(record, dict):
            raise DiagnosisBudgetError("malformed diagnosis source state")
        for field in ("handledThrough", "pendingThreshold"):
            threshold = int(record.get(field) or 0)
            if threshold < 0 or (threshold and (threshold < 3 or threshold % 3)):
                raise DiagnosisBudgetError("malformed diagnosis source threshold")
        if mechanics:
            streak_count = int(record.get("streakCount") or 0)
            if streak_count < 0:
                raise DiagnosisBudgetError("malformed mechanics incident count")
    return records


def _validate_state(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION:
        raise DiagnosisBudgetError("unsupported diagnosis budget state")
    claims = value.get("claims")
    sources = value.get("sources")
    if not isinstance(claims, dict) or not isinstance(sources, dict):
        raise DiagnosisBudgetError("malformed diagnosis budget state")
    mechanics_sources = value.get("mechanicsSources", {})
    if not isinstance(mechanics_sources, dict):
        raise DiagnosisBudgetError("malformed mechanics diagnosis state")

    closed_through = value.get("closedThroughServiceDate")
    if closed_through is not None:
        _validated_service_date(closed_through, 0)

    for service_date, claim in claims.items():
        _validated_service_date(service_date, 0)
        if closed_through is not None and service_date <= closed_through:
            raise DiagnosisBudgetError("overlapping diagnosis budget history")
        if not isinstance(claim, dict):
            raise DiagnosisBudgetError("malformed diagnosis budget claim")
        _validated_source(claim.get("source"))
        _validated_lane(claim.get("lane"))
        if int(claim.get("attemptedAtMs") or 0) <= 0:
            raise DiagnosisBudgetError("malformed diagnosis budget claim")
        threshold = int(claim.get("threshold") or 0)
        if threshold < 3 or threshold % 3:
            raise DiagnosisBudgetError("malformed diagnosis budget threshold")

    _validate_source_records(sources)
    _validate_source_records(mechanics_sources, mechanics=True)
    return value


def _source_records(state: dict[str, Any], lane: str) -> dict[str, Any]:
    lane = _validated_lane(lane)
    if lane == "barren":
        return state["sources"]
    records = state.setdefault("mechanicsSources", {})
    if not isinstance(records, dict):
        raise DiagnosisBudgetError("malformed mechanics diagnosis state")
    return records


def _compact_claims(state: dict[str, Any]) -> bool:
    """Bound exact history while retaining a fail-closed date boundary."""

    claims = state["claims"]
    if len(claims) <= MAX_EXACT_CLAIMS:
        return False
    dates = sorted(claims)
    retired = dates[: len(dates) - MAX_EXACT_CLAIMS]
    for service_date in retired:
        del claims[service_date]
    previous = state.get("closedThroughServiceDate")
    boundary = max([*retired, *([previous] if previous else [])])
    state["closedThroughServiceDate"] = boundary
    return True


def _read_state(path: Path) -> dict[str, Any]:
    try:
        path_stat = path.lstat()
    except FileNotFoundError:
        return _empty_state()
    if stat.S_ISLNK(path_stat.st_mode) or not stat.S_ISREG(path_stat.st_mode):
        raise DiagnosisBudgetError("unsafe diagnosis budget state")
    if path_stat.st_size > MAX_STATE_BYTES:
        raise DiagnosisBudgetError("diagnosis budget state is too large")
    os.chmod(path, 0o600)
    try:
        with path.open(encoding="utf-8") as stream:
            return _validate_state(json.load(stream))
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
        if isinstance(error, DiagnosisBudgetError):
            raise
        raise DiagnosisBudgetError("unreadable diagnosis budget state") from error


def _fsync_parent(path: Path) -> None:
    try:
        descriptor = os.open(path.parent, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        # Some Android filesystems reject fsync on directory descriptors.
        pass
    finally:
        os.close(descriptor)


def _atomic_write_state(path: Path, value: dict[str, Any]) -> None:
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temp, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, separators=(",", ":"), sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        os.chmod(path, 0o600)
        _fsync_parent(path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


@contextlib.contextmanager
def _state_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f"{path.name}.lock")
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise DiagnosisBudgetError("diagnosis budget lock unavailable") from error
    try:
        lock_stat = os.fstat(descriptor)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink != 1:
            raise DiagnosisBudgetError("unsafe diagnosis budget lock")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def claim_automatic_diagnosis(
    state_path: Path | str,
    *,
    source: str,
    barren_count: int,
    dispatcher_available: bool = True,
    service_date: str | None = None,
    stamp_ms: int | None = None,
    lane: str = "barren",
) -> dict[str, Any]:
    """Request one incident lane's threshold and atomically consume today's slot.

    Calling on every incident count is intentional. ``handledThrough`` preserves
    the original every-third-cycle re-arm, while ``pendingThreshold`` lets a
    threshold deferred by the global budget run on a later service date.
    """

    state_path = Path(state_path)
    source = _validated_source(source)
    lane = _validated_lane(lane)
    barren_count = max(0, int(barren_count))
    stamp_ms = now_ms() if stamp_ms is None else int(stamp_ms)
    service_date = _validated_service_date(service_date, stamp_ms)
    threshold = (barren_count // 3) * 3 if barren_count >= 3 else 0

    with _state_lock(state_path):
        state = _read_state(state_path)
        sources = _source_records(state, lane)
        claims = state["claims"]
        changed = _compact_claims(state)
        record = dict(sources.get(source) or {})
        handled = int(record.get("handledThrough") or 0)
        pending = int(record.get("pendingThreshold") or 0)

        if threshold >= 3 and threshold > handled and threshold > pending:
            pending = threshold
            record["pendingThreshold"] = pending
            record["updatedAtMs"] = stamp_ms
            sources[source] = record
            changed = True

        if pending < 3:
            if changed:
                _atomic_write_state(state_path, state)
            return {
                "claimed": False,
                "reason": "threshold_not_due",
                "serviceDate": service_date,
            }

        if not dispatcher_available:
            if changed:
                _atomic_write_state(state_path, state)
            return {
                "claimed": False,
                "reason": "dispatcher_unavailable",
                "serviceDate": service_date,
            }

        closed_through = state.get("closedThroughServiceDate")
        if service_date in claims or (
            closed_through is not None and service_date <= closed_through
        ):
            if changed:
                _atomic_write_state(state_path, state)
            return {
                "claimed": False,
                "reason": "daily_budget_spent",
                "serviceDate": service_date,
            }

        # This durable write is the commit point.  The caller may launch the
        # provider only after it observes claimed=true.
        claims[service_date] = {
            "attemptedAtMs": stamp_ms,
            "source": source,
            "threshold": pending,
        }
        if lane != "barren":
            claims[service_date]["lane"] = lane
        # ``pending`` may belong to a previous consecutive-empty streak that
        # was interrupted by a mechanics/provider failure.  Claiming that old
        # work at n=1 must not make the new streak look handled through n=6.
        # Only thresholds observed in the current streak advance its gate.
        record["handledThrough"] = max(handled, threshold)
        record.pop("pendingThreshold", None)
        record["updatedAtMs"] = stamp_ms
        sources[source] = record
        _compact_claims(state)
        _atomic_write_state(state_path, state)
        return {
            "claimed": True,
            "reason": "claimed",
            "serviceDate": service_date,
        }


def clear_source_state(
    state_path: Path | str,
    *,
    source: str,
    lane: str = "barren",
) -> bool:
    """Forget one source's streak state without refunding any daily claim."""

    state_path = Path(state_path)
    source = _validated_source(source)
    lane = _validated_lane(lane)
    with _state_lock(state_path):
        state = _read_state(state_path)
        sources = _source_records(state, lane)
        if source not in sources:
            return False
        del sources[source]
        _atomic_write_state(state_path, state)
        return True


def reset_source_streak(
    state_path: Path | str,
    *,
    source: str,
    stamp_ms: int | None = None,
    lane: str = "barren",
) -> bool:
    """Reset handled thresholds after a broken consecutive-empty streak.

    A mechanics/provider failure is not recovery, so any diagnosis already
    pending remains pending.  It does break the shell's consecutive-empty
    counter, though, which means an already-handled threshold must not suppress
    the next streak's first threshold.  Daily claims are intentionally
    untouched.
    """

    state_path = Path(state_path)
    source = _validated_source(source)
    lane = _validated_lane(lane)
    stamp_ms = now_ms() if stamp_ms is None else int(stamp_ms)
    with _state_lock(state_path):
        state = _read_state(state_path)
        record = _source_records(state, lane).get(source)
        if not isinstance(record, dict):
            return False
        updated = dict(record)
        updated["handledThrough"] = 0
        updated["updatedAtMs"] = stamp_ms
        _source_records(state, lane)[source] = updated
        _atomic_write_state(state_path, state)
        return True


def observe_mechanics_failure(
    state_path: Path | str,
    *,
    source: str,
    stamp_ms: int | None = None,
) -> int:
    """Durably increment one source's unresolved mechanics incident count."""

    state_path = Path(state_path)
    source = _validated_source(source)
    stamp_ms = now_ms() if stamp_ms is None else int(stamp_ms)
    with _state_lock(state_path):
        state = _read_state(state_path)
        sources = _source_records(state, "mechanics")
        record = dict(sources.get(source) or {})
        count = int(record.get("streakCount") or 0) + 1
        record["streakCount"] = count
        record["updatedAtMs"] = stamp_ms
        sources[source] = record
        _atomic_write_state(state_path, state)
        return count


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)

    claim = subcommands.add_parser("claim")
    claim.add_argument("--state", required=True)
    claim.add_argument("--source", required=True)
    claim.add_argument(
        "--incident-count",
        "--barren-count",
        dest="incident_count",
        required=True,
        type=int,
    )
    claim.add_argument("--dispatcher-unavailable", action="store_true")
    claim.add_argument("--service-date")
    claim.add_argument("--now-ms", type=int)
    claim.add_argument("--lane", choices=sorted(INCIDENT_LANES), default="barren")

    clear = subcommands.add_parser("clear")
    clear.add_argument("--state", required=True)
    clear.add_argument("--source", required=True)
    clear.add_argument("--lane", choices=sorted(INCIDENT_LANES), default="barren")

    reset = subcommands.add_parser("reset-streak")
    reset.add_argument("--state", required=True)
    reset.add_argument("--source", required=True)
    reset.add_argument("--now-ms", type=int)
    reset.add_argument("--lane", choices=sorted(INCIDENT_LANES), default="barren")

    mechanics = subcommands.add_parser("observe-mechanics-failure")
    mechanics.add_argument("--state", required=True)
    mechanics.add_argument("--source", required=True)
    mechanics.add_argument("--now-ms", type=int)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "claim":
            result = claim_automatic_diagnosis(
                args.state,
                source=args.source,
                barren_count=args.incident_count,
                dispatcher_available=not args.dispatcher_unavailable,
                service_date=args.service_date,
                stamp_ms=args.now_ms,
                lane=args.lane,
            )
            print(f"{1 if result['claimed'] else 0}\t{result['reason']}")
        elif args.command == "clear":
            clear_source_state(args.state, source=args.source, lane=args.lane)
        elif args.command == "reset-streak":
            reset_source_streak(
                args.state,
                source=args.source,
                stamp_ms=args.now_ms,
                lane=args.lane,
            )
        else:
            print(
                observe_mechanics_failure(
                    args.state,
                    source=args.source,
                    stamp_ms=args.now_ms,
                )
            )
    except (DiagnosisBudgetError, OSError, TypeError, ValueError):
        # Never print a source, path, or state value into the shared scheduler
        # log.  An unavailable ledger fails closed in the caller.
        print("automatic diagnosis budget unavailable", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
