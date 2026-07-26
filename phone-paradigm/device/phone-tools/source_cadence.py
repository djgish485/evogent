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
import time
from pathlib import Path
from typing import Any


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


def cadence_decision(
    source: str,
    *,
    stamp_path: Path,
    live_path: Path,
    default_path: Path,
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
        stamp_seconds = stamp_path.stat().st_mtime
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
    return {
        "due": age_seconds >= hours * 60 * 60,
        "hours": hours,
        "reason": "elapsed" if age_seconds >= hours * 60 * 60 else "within_cadence",
        "ageSeconds": age_seconds,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--stamp", required=True)
    parser.add_argument("--live", required=True)
    parser.add_argument("--default", required=True)
    parser.add_argument("--now-seconds", type=float)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    decision = cadence_decision(
        args.source,
        stamp_path=Path(args.stamp),
        live_path=Path(args.live),
        default_path=Path(args.default),
        now_seconds=args.now_seconds,
    )
    # A tab record is deliberately trivial for POSIX shell to parse without jq.
    hours = format(float(decision["hours"]), "g")
    print(f"{1 if decision['due'] else 0}\t{hours}\t{decision['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
