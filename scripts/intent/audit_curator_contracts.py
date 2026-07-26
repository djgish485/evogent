#!/usr/bin/env python3
"""Audit phone-local curation mechanics without imposing editorial quotas."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_APP_DB = Path("data/media-agent.db")
DEFAULT_OUT_DIR = Path("data/intent-audits")
PRIMARY_SLATE_MAX_ITEMS = 50
TERMINAL_COMPLETION_STATUSES = {
    "success",
    "successful_empty",
    "empty",
    "cancelled",
    "failed",
    "aborted",
}
EMPTY_COMPLETION_STATUSES = {"successful_empty", "empty"}
INTEREST_DURABILITIES = {"evergreen", "dated", "news"}
SINGLETON_SHIPMENT_PREFIXES = (
    "shipment-singleton:",
    "carry-forward-singleton:",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise SystemExit(f"app DB not found: {path}")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def rows(
    conn: sqlite3.Connection,
    sql: str,
    params: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql, params)]


def scalar(
    conn: sqlite3.Connection,
    sql: str,
    params: tuple[Any, ...] = (),
) -> Any:
    row = conn.execute(sql, params).fetchone()
    return None if row is None else row[0]


def parse_json_object(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {"parse_error": "invalid_json"}
    return parsed if isinstance(parsed, dict) else {"parse_error": "not_object"}


def summarize_arrangement(row: dict[str, Any]) -> dict[str, Any]:
    audit = parse_json_object(row.get("carry_forward_audit"))
    curator_audit = parse_json_object(row.get("curator_carry_forward_audit"))
    summary = dict(row)
    summary["carry_forward_audit"] = audit
    summary["curator_carry_forward_audit"] = curator_audit
    if audit:
        promoted = audit.get("promotedIds")
        summary["eligible_review_summary"] = {
            "mode": audit.get("mode"),
            "eligibleCount": audit.get("eligibleCount"),
            "reviewedCount": audit.get("reviewedCount"),
            "returnedCount": audit.get("returnedCount"),
            "includeAllUnviewed": audit.get("includeAllUnviewed"),
            "includeDisplayed": audit.get("includeDisplayed"),
            "promotedCount": len(promoted) if isinstance(promoted, list) else None,
        }
    else:
        summary["eligible_review_summary"] = None
    return summary


def check_latest_eligible_review(
    latest_arrangements: list[dict[str, Any]],
) -> dict[str, Any]:
    """Verify mechanics exposed the complete eligible set to private judgment."""
    if not latest_arrangements:
        return {
            "ok": False,
            "reason": "no arrangement receipt is available",
        }
    latest = latest_arrangements[0]
    audit = latest.get("carry_forward_audit")
    if not isinstance(audit, dict) or audit.get("parse_error"):
        return {
            "ok": False,
            "arrangementId": latest.get("id"),
            "reason": "latest arrangement has no parseable eligibility receipt",
        }

    eligible = audit.get("eligibleCount")
    reviewed = audit.get("reviewedCount")
    returned = audit.get("returnedCount")
    if audit.get("includeAllUnviewed") is not True:
        return {
            "ok": False,
            "arrangementId": latest.get("id"),
            "reason": "mechanics did not request the full unviewed eligible set",
            "audit": latest.get("eligible_review_summary"),
        }
    if audit.get("includeDisplayed") is not True:
        return {
            "ok": False,
            "arrangementId": latest.get("id"),
            "reason": "mechanics excluded displayed-but-unviewed eligible rows",
            "audit": latest.get("eligible_review_summary"),
        }
    if not isinstance(eligible, int) or eligible < 0:
        return {
            "ok": False,
            "arrangementId": latest.get("id"),
            "reason": "eligibility receipt lacks a valid eligible count",
            "audit": latest.get("eligible_review_summary"),
        }
    if not isinstance(reviewed, int) or reviewed < eligible:
        return {
            "ok": False,
            "arrangementId": latest.get("id"),
            "reason": "mechanics did not present every eligible row for judgment",
            "audit": latest.get("eligible_review_summary"),
        }
    if not isinstance(returned, int) or returned < eligible:
        return {
            "ok": False,
            "arrangementId": latest.get("id"),
            "reason": "the complete eligible set was reviewed but not returned to the runtime agent",
            "audit": latest.get("eligible_review_summary"),
        }
    return {
        "ok": True,
        "arrangementId": latest.get("id"),
        "reason": "mechanics presented the full eligible set for private judgment",
        "audit": latest.get("eligible_review_summary"),
    }


def check_primary_slate(primary_slate_count: Any) -> dict[str, Any]:
    valid_count = (
        isinstance(primary_slate_count, int)
        and not isinstance(primary_slate_count, bool)
        and primary_slate_count >= 0
    )
    ok = valid_count and primary_slate_count <= PRIMARY_SLATE_MAX_ITEMS
    return {
        "ok": ok,
        "count": primary_slate_count,
        "maximum": PRIMARY_SLATE_MAX_ITEMS,
        "reason": (
            "primary slate is within the hard ceiling; no minimum applies"
            if ok
            else "primary slate exceeds the hard ceiling or has an invalid count"
        ),
    }


def check_runtime_judgment(primary_slate: list[dict[str, Any]]) -> dict[str, Any]:
    """Require explicit agent judgment, never a deterministic age/type proxy."""
    missing_ids: list[Any] = []
    invalid_ids: list[Any] = []
    for row in primary_slate:
        score = row.get("interest_score")
        durability = row.get("interest_durability")
        if score is None or durability is None:
            missing_ids.append(row.get("id"))
            continue
        if (
            isinstance(score, bool)
            or not isinstance(score, (int, float))
            or not 0 <= float(score) <= 1
            or durability not in INTEREST_DURABILITIES
        ):
            invalid_ids.append(row.get("id"))
    ok = not missing_ids and not invalid_ids
    return {
        "ok": ok,
        "judgedCount": len(primary_slate) - len(missing_ids) - len(invalid_ids),
        "primarySlateCount": len(primary_slate),
        "missingJudgmentIds": missing_ids,
        "invalidJudgmentIds": invalid_ids,
        "reason": (
            "every primary row carries explicit runtime-agent value and freshness judgment"
            if ok
            else "some primary rows lack valid runtime-agent interest judgment"
        ),
    }


def check_thread_integrity(primary_slate: list[dict[str, Any]]) -> dict[str, Any]:
    """Keep real threads truthful and singleton shipment identities hidden."""
    missing_ids: list[Any] = []
    remapped_ids: list[Any] = []
    singleton_metadata_ids: list[Any] = []
    invalid_singleton_identity_ids: list[Any] = []
    positions_by_real_thread: dict[str, list[int]] = {}
    members_by_real_thread: dict[str, list[Any]] = {}
    members_by_singleton_thread: dict[str, list[Any]] = {}

    for index, row in enumerate(primary_slate):
        item_id = row.get("id")
        shipment_id = row.get(
            "shipment_thread_id",
            row.get("display_thread_id"),
        )
        metadata_id = row.get(
            "metadata_thread_id",
            row.get("stable_thread_id"),
        )
        if not isinstance(shipment_id, str) or not shipment_id.strip():
            missing_ids.append(row.get("id"))
            continue
        shipment_id = shipment_id.strip()
        normalized_metadata_id = (
            metadata_id.strip()
            if isinstance(metadata_id, str) and metadata_id.strip()
            else None
        )
        singleton_prefix = next(
            (
                prefix
                for prefix in SINGLETON_SHIPMENT_PREFIXES
                if shipment_id.startswith(prefix)
            ),
            None,
        )
        if singleton_prefix:
            members_by_singleton_thread.setdefault(
                shipment_id,
                [],
            ).append(item_id)
            if normalized_metadata_id is not None:
                singleton_metadata_ids.append(item_id)
            expected_id = (
                f"{singleton_prefix}{item_id}"
                if isinstance(item_id, str) and item_id
                else None
            )
            if expected_id is None or shipment_id != expected_id:
                invalid_singleton_identity_ids.append(item_id)
            continue

        positions_by_real_thread.setdefault(shipment_id, []).append(index)
        members_by_real_thread.setdefault(shipment_id, []).append(item_id)
        if normalized_metadata_id != shipment_id:
            remapped_ids.append(item_id)

    split_thread_ids = [
        thread_id
        for thread_id, positions in positions_by_real_thread.items()
        if positions[-1] - positions[0] + 1 != len(positions)
    ]
    undersized_real_thread_ids = [
        thread_id
        for thread_id, members in members_by_real_thread.items()
        if len(members) < 2
    ]
    pooled_singleton_thread_ids = [
        thread_id
        for thread_id, members in members_by_singleton_thread.items()
        if len(members) != 1
    ]
    ok = not (
        missing_ids
        or remapped_ids
        or singleton_metadata_ids
        or invalid_singleton_identity_ids
        or split_thread_ids
        or undersized_real_thread_ids
        or pooled_singleton_thread_ids
    )
    return {
        "ok": ok,
        "missingStableThreadIds": missing_ids,
        "remappedThreadItemIds": remapped_ids,
        "splitThreadIds": split_thread_ids,
        "undersizedRealThreadIds": undersized_real_thread_ids,
        "singletonCount": len(members_by_singleton_thread),
        "singletonMetadataItemIds": singleton_metadata_ids,
        "invalidSingletonIdentityItemIds": invalid_singleton_identity_ids,
        "pooledSingletonThreadIds": pooled_singleton_thread_ids,
        "reason": (
            "real threads are stable and contiguous; singleton shipment ids are distinct and hidden"
            if ok
            else "thread identity was missing, remapped, split, pooled, or exposed as singleton display metadata"
        ),
    }


def check_truthful_completion_receipts(
    recent_curations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Validate completion facts without treating an item count as success."""
    issues: list[dict[str, Any]] = []
    for row in recent_curations:
        item_id = row.get("id")
        status = str(row.get("completion_status") or "").strip().lower()
        reason = str(row.get("completion_reason") or "").strip()
        items_added = row.get("items_added")

        if status not in TERMINAL_COMPLETION_STATUSES:
            issues.append({"id": item_id, "issue": "missing_or_invalid_status"})
        if not reason:
            issues.append({"id": item_id, "issue": "missing_reason"})
        if (
            not isinstance(items_added, int)
            or isinstance(items_added, bool)
            or items_added < 0
        ):
            issues.append({"id": item_id, "issue": "invalid_items_added"})
            continue
        if status == "success" and items_added == 0:
            issues.append({"id": item_id, "issue": "success_without_items"})
        if status in EMPTY_COMPLETION_STATUSES and items_added != 0:
            issues.append({"id": item_id, "issue": "empty_status_with_items"})

    return {
        "ok": not issues,
        "auditedCount": len(recent_curations),
        "issues": issues,
        "reason": (
            "completed cycles carry coherent status, count, and reason receipts"
            if not issues
            else "some completed cycles have missing or contradictory receipts"
        ),
    }


def build_report(conn: sqlite3.Connection) -> dict[str, Any]:
    recent_curations = rows(
        conn,
        """
        SELECT id, request_id, triggered_by, started_at, completed_at,
               items_added, completion_status, completion_reason
        FROM curation_log
        WHERE completed_at IS NOT NULL
        ORDER BY started_at DESC
        LIMIT 30
        """,
    )
    latest_arrangements = rows(
        conn,
        """
        SELECT id, source, created_at, ordering_count, thread_count,
               updated_item_count, carry_forward_audit,
               curator_carry_forward_audit
        FROM feed_arrangement_runs
        ORDER BY id DESC
        LIMIT 10
        """,
    )
    primary_slate_count = scalar(
        conn,
        """
        SELECT COUNT(*)
        FROM feed
        WHERE parent_id IS NULL
          AND display_order IS NOT NULL
          AND type IN ('tweet', 'article', 'analysis')
        """,
    )
    primary_slate = rows(
        conn,
        """
        SELECT
          id,
          display_order,
          NULLIF(TRIM(thread_id), '') AS shipment_thread_id,
          CASE
            WHEN TRIM(COALESCE(thread_id, '')) LIKE 'shipment-singleton:%'
              OR TRIM(COALESCE(thread_id, '')) LIKE 'carry-forward-singleton:%'
            THEN NULL
            ELSE COALESCE(
              NULLIF(TRIM(json_extract(
                CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                '$.thread.threadId'
              )), ''),
              NULLIF(TRIM(json_extract(
                CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                '$.threadId'
              )), '')
            )
          END AS metadata_thread_id,
          json_extract(
            CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
            '$.interest.score'
          ) AS interest_score,
          json_extract(
            CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
            '$.interest.durability'
          ) AS interest_durability
        FROM feed
        WHERE parent_id IS NULL
          AND display_order IS NOT NULL
          AND type IN ('tweet', 'article', 'analysis')
        ORDER BY display_order, created_at_ms DESC
        LIMIT 51
        """,
    )

    latest_arrangements = [
        summarize_arrangement(row)
        for row in latest_arrangements
    ]
    checks = {
        "full_eligible_set_presented": check_latest_eligible_review(
            latest_arrangements,
        ),
        "primary_slate_bounded": check_primary_slate(primary_slate_count),
        "runtime_judgment_present": check_runtime_judgment(primary_slate),
        "thread_identity_preserved": check_thread_integrity(primary_slate),
        "truthful_completion_receipts": check_truthful_completion_receipts(
            recent_curations,
        ),
    }
    return {
        "created_at": utc_now(),
        "status": (
            "pass"
            if all(check.get("ok") for check in checks.values())
            else "fail"
        ),
        "contracts": {
            "authority": (
                "phone runtime state and its private evidence ledger describe "
                "this deployment"
            ),
            "eligibility": (
                "mechanics present the full eligible set; the runtime agent "
                "privately judges current value and freshness"
            ),
            "primary_slate": (
                "at most 50 primary items, with no minimum, source quota, "
                "or item-type quota"
            ),
            "threads": (
                "stable shipment thread IDs, no split thread, and distinct "
                "singletons"
            ),
            "completion": (
                "every completed cycle has a truthful status, item count, "
                "and reason receipt"
            ),
        },
        "checks": checks,
        "recent_curations": recent_curations,
        "latest_arrangements": latest_arrangements,
        "primary_slate": primary_slate,
    }


def write_report(
    report: dict[str, Any],
    out_dir: Path,
) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    out_dir.chmod(0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"curator-contract-audit-{stamp}.json"
    latest = out_dir / "curator-contract-audit-latest.json"
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    path.write_text(text)
    latest.write_text(text)
    path.chmod(0o600)
    latest.chmod(0o600)
    return path, latest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_APP_DB,
        help="phone-local Evogent SQLite database",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help="private directory for audit artifacts",
    )
    args = parser.parse_args()

    with connect(args.db) as conn:
        report = build_report(conn)
    path, _latest = write_report(report, args.out_dir)
    summary = {
        "status": report["status"],
        "artifact": str(path),
        "checks": {
            name: {
                "ok": check.get("ok"),
                "reason": check.get("reason"),
            }
            for name, check in report["checks"].items()
        },
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    if report["status"] != "pass":
        print("curation intent audit failed; inspect the private artifact", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
