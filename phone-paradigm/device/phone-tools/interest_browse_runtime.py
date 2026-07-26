#!/data/data/com.termux/files/usr/bin/env python3
"""Deterministic helpers for the standing-interest browser."""

from __future__ import annotations

import json
import os
import secrets
import struct
from pathlib import Path
from typing import Any


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_dimensions(path: str | os.PathLike[str]) -> tuple[int, int] | None:
    """Read width/height from a real PNG's IHDR without an image-library dependency."""

    try:
        with open(path, "rb") as stream:
            header = stream.read(24)
        if len(header) != 24 or header[:8] != PNG_SIGNATURE or header[12:16] != b"IHDR":
            return None
        width, height = struct.unpack(">II", header[16:24])
        if width < 100 or height < 100 or width > 20_000 or height > 20_000:
            return None
        return width, height
    except OSError:
        return None


def derive_instagram_geometry(
    width: int,
    height: int,
    tab_rect: tuple[int, int, int, int],
) -> dict[str, tuple[int, int] | tuple[int, int, int, int]] | None:
    """Derive gestures from the captured display and a live Instagram grid-tab anchor.

    Instagram's profile grid is three square columns across the current display.  The custom
    tiles expose no accessibility bounds, so the first tile is anchored immediately below the
    accessible grid-tab row.  All other gestures are ratios of the same screenshot dimensions;
    no coordinate assumes a 1080-wide device.
    """

    if width < 100 or height < 100:
        return None
    left, top, right, bottom = tab_rect
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        return None
    tile = width / 3.0
    grid_top = bottom
    tap_x = round(tile / 2)
    tap_y = round(grid_top + tile / 2)
    # An anchor near/below the bottom chrome is not the profile grid row.  Refuse a blind tap.
    if tap_y >= round(height * 0.94):
        return None
    return {
        "firstTile": (tap_x, tap_y),
        "revealSwipe": (
            round(width * 0.50),
            round(height * 0.68),
            round(width * 0.50),
            round(height * 0.34),
        ),
        "nextPostSwipe": (
            round(width * 0.50),
            round(height * 0.72),
            round(width * 0.50),
            round(height * 0.22),
        ),
    }


def classify_interest_outcomes(
    tracking: dict[str, dict[str, Any]],
    items_per_interest: dict[str, int],
    *,
    extraction_ok: bool,
    extraction_error: str,
) -> list[dict[str, Any]]:
    """Classify each due interest without confusing missing evidence with an empty source."""

    outcomes: list[dict[str, Any]] = []
    for interest_id, track in tracking.items():
        row = dict(track)
        row["itemsAdded"] = max(0, int(items_per_interest.get(interest_id, 0)))
        if not extraction_ok:
            state, outcome, detail = "failed", "mechanics_failure", extraction_error
        elif int(row.get("evidenceCount") or 0) <= 0:
            state, outcome, detail = "failed", "mechanics_failure", "no_source_evidence"
        elif (row.get("anomalies") or row.get("errors")) and row["itemsAdded"] <= 0:
            state, outcome, detail = (
                "failed",
                "mechanics_failure",
                "one or more configured sources failed, preventing an honest empty result",
            )
        elif row.get("anomalies") or row.get("errors"):
            state, outcome, detail = (
                "degraded",
                "partial_fresh",
                "events extracted despite incomplete source evidence",
            )
        elif row["itemsAdded"] > 0:
            state, outcome, detail = "completed", "fresh", "upcoming events extracted"
        else:
            state, outcome, detail = (
                "completed",
                "empty",
                "inspected source evidence contained no qualifying upcoming event",
            )
        row.update({"state": state, "outcome": outcome, "detail": detail})
        outcomes.append(row)
    return outcomes


def apply_submit_result(
    outcomes: list[dict[str, Any]],
    *,
    submit_persisted: bool,
    submit_error: str,
) -> set[str]:
    """Apply the cache commit gate and return the only interest IDs safe to cadence-stamp."""

    completed: set[str] = set()
    for outcome in outcomes:
        if submit_persisted and outcome.get("state") in ("completed", "degraded"):
            completed.add(str(outcome.get("interestId") or ""))
        elif not submit_persisted and outcome.get("state") in ("completed", "degraded"):
            outcome.update(
                {
                    "state": "failed",
                    "outcome": "cache_submit_failure",
                    "detail": submit_error or "cache_submit_failed",
                }
            )
    completed.discard("")
    return completed


def atomic_write_json(path: str | os.PathLike[str], value: Any) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(
        f".{destination.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}"
    )
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, separators=(",", ":"), sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
