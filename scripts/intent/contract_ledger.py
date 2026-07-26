#!/usr/bin/env python3
"""Validate and resolve the append-only public contract ledger.

Contract records are immutable history.  A record without an explicit key gets
a deterministic key derived from its area and statement so older ledgers can be
revised without rewriting them.  Revisions repeat the stable key and explicitly
list that key in ``supersedes``.  A replacement may also supersede other,
already-known keys.  The last valid record for a key wins; superseded records
remain available as history but never appear in the active contract set.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


ACTIVE_STATUSES = {"law", "open", "verified", "fixed"}
CONTRACT_STATUSES = ACTIVE_STATUSES | {"superseded"}
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._:-]{2,127}$")


class ContractLedgerError(ValueError):
    """Raised when append-only contract history is ambiguous or malformed."""


@dataclass(frozen=True)
class ContractRevision:
    key: str
    line_number: int
    record: dict[str, Any]
    supersedes: tuple[str, ...]


@dataclass(frozen=True)
class ResolvedContractLedger:
    active: tuple[ContractRevision, ...]
    history: tuple[ContractRevision, ...]
    latest_by_key: dict[str, ContractRevision]
    superseded_by: dict[str, str]


def stable_contract_key(area: str, statement: str) -> str:
    """Return the stable legacy key for an area/statement pair."""

    normalized_area = " ".join(area.strip().lower().split())
    normalized_statement = " ".join(statement.strip().split())
    digest = hashlib.sha256(
        f"{normalized_area}\0{normalized_statement}".encode("utf-8")
    ).hexdigest()[:16]
    return f"contract-{digest}"


def _error(source: str, line_number: int, message: str) -> ContractLedgerError:
    return ContractLedgerError(f"{source}:{line_number}: {message}")


def _require_text(
    record: dict[str, Any],
    field: str,
    *,
    source: str,
    line_number: int,
) -> str:
    value = record.get(field)
    if not isinstance(value, str) or not value.strip():
        raise _error(source, line_number, f"{field} must be a non-empty string")
    return value.strip()


def _parse_supersedes(
    value: Any,
    *,
    source: str,
    line_number: int,
) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not value:
        raise _error(
            source,
            line_number,
            "supersedes must be a non-empty array of stable contract keys",
        )
    targets: list[str] = []
    for target in value:
        if not isinstance(target, str) or not KEY_RE.fullmatch(target):
            raise _error(
                source,
                line_number,
                "supersedes contains an invalid stable contract key",
            )
        targets.append(target)
    if len(targets) != len(set(targets)):
        raise _error(source, line_number, "supersedes contains duplicate keys")
    return tuple(targets)


def resolve_contract_lines(
    lines: Iterable[str],
    *,
    source: str = "<contracts>",
) -> ResolvedContractLedger:
    """Parse, validate, and resolve JSONL contract revisions."""

    history: list[ContractRevision] = []
    latest_by_key: dict[str, ContractRevision] = {}
    superseded_by: dict[str, str] = {}

    for line_number, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise _error(source, line_number, f"invalid JSON: {exc.msg}") from exc
        if not isinstance(record, dict):
            raise _error(source, line_number, "contract record must be a JSON object")

        area = _require_text(
            record, "area", source=source, line_number=line_number
        )
        statement = _require_text(
            record, "statement", source=source, line_number=line_number
        )
        status = _require_text(
            record, "status", source=source, line_number=line_number
        )
        if status not in CONTRACT_STATUSES:
            raise _error(
                source,
                line_number,
                f"status must be one of {sorted(CONTRACT_STATUSES)}",
            )

        explicit_key = record.get("key")
        key = (
            stable_contract_key(area, statement)
            if explicit_key is None
            else explicit_key
        )
        if not isinstance(key, str) or not KEY_RE.fullmatch(key):
            raise _error(source, line_number, "key is not a valid stable contract key")

        supersedes = _parse_supersedes(
            record.get("supersedes"),
            source=source,
            line_number=line_number,
        )
        known_keys = set(latest_by_key)
        unknown_targets = [target for target in supersedes if target not in known_keys]
        if unknown_targets:
            raise _error(
                source,
                line_number,
                "supersedes unknown contract key(s): "
                + ", ".join(unknown_targets),
            )

        if key in latest_by_key and key not in supersedes:
            raise _error(
                source,
                line_number,
                f"duplicate key {key!r} must explicitly supersede itself",
            )
        if status == "superseded":
            if key not in latest_by_key or supersedes != (key,):
                raise _error(
                    source,
                    line_number,
                    "a superseded tombstone must repeat a known key and supersede only itself",
                )

        for target in supersedes:
            if target == key:
                continue
            prior_replacement = superseded_by.get(target)
            if prior_replacement is not None:
                raise _error(
                    source,
                    line_number,
                    f"contract key {target!r} was already superseded by "
                    f"{prior_replacement!r}",
                )
            superseded_by[target] = key

        revision = ContractRevision(
            key=key,
            line_number=line_number,
            record=record,
            supersedes=supersedes,
        )
        history.append(revision)
        latest_by_key[key] = revision

    active = tuple(
        revision
        for revision in latest_by_key.values()
        if revision.key not in superseded_by
        and revision.record.get("status") in ACTIVE_STATUSES
    )
    return ResolvedContractLedger(
        active=active,
        history=tuple(history),
        latest_by_key=latest_by_key,
        superseded_by=superseded_by,
    )


def load_contract_ledger(path: Path) -> ResolvedContractLedger:
    return resolve_contract_lines(
        path.read_text(encoding="utf-8").splitlines(),
        source=str(path),
    )


def active_contract_records(path: Path) -> list[dict[str, Any]]:
    """Return active records with their resolved stable key attached."""

    return [
        {**revision.record, "key": revision.key}
        for revision in load_contract_ledger(path).active
    ]


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument(
        "--active-json",
        action="store_true",
        help="print resolved active records as JSON instead of a validation summary",
    )
    args = parser.parse_args()
    ledger = load_contract_ledger(args.path)
    if args.active_json:
        print(
            json.dumps(
                [
                    {**revision.record, "key": revision.key}
                    for revision in ledger.active
                ],
                indent=2,
                sort_keys=True,
            )
        )
    else:
        print(
            f"contracts valid: {len(ledger.history)} revisions, "
            f"{len(ledger.active)} active, "
            f"{len(ledger.history) - len(ledger.active)} historical"
        )


if __name__ == "__main__":
    main()
