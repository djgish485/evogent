#!/usr/bin/env python3
"""Apply historical supporting interest judgments to feed item metadata.

Input: JSONL with {"id": feed_id, "s": 0-100 int, "dur": "evergreen"|"dated"|"news", "why": short}
Writes metadata.interest = { score (0-1), durability, reason, scoredBy, scoredAtMs }.
These fields are evidence only; they never decide shipment or display order.
Only fills items that do NOT already have a curator-stamped interest score
(scoredBy=curator wins; re-running this historical backfill may refresh its own
supporting evidence).

Usage: python3 apply_interest_scores.py --scores /tmp/merged-scores.jsonl [--db PATH] [--dry-run]
"""
import argparse
import json
import sqlite3
import time

SCORED_BY = "historical-interest-backfill"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scores", required=True)
    parser.add_argument("--db", default="/root/media-agent/data/media-agent.db")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    rows = []
    with open(args.scores) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            score = max(0, min(100, int(d["s"]))) / 100.0
            dur = d.get("dur", "dated")
            if dur not in ("evergreen", "dated", "news"):
                dur = "dated"
            rows.append((d["id"], round(score, 2), dur, (d.get("why") or "")[:140]))

    conn = sqlite3.connect(args.db)
    now_ms = int(time.time() * 1000)
    updated = skipped_curator = missing = 0
    for item_id, score, dur, why in rows:
        cur = conn.execute(
            "SELECT json_extract(metadata, '$.interest.scoredBy') FROM feed WHERE id = ?",
            (item_id,),
        ).fetchone()
        if cur is None:
            missing += 1
            continue
        if cur[0] == "curator":
            skipped_curator += 1
            continue
        if args.dry_run:
            updated += 1
            continue
        conn.execute(
            """
            UPDATE feed SET metadata = json_set(
              COALESCE(metadata, '{}'),
              '$.interest.score', ?,
              '$.interest.durability', ?,
              '$.interest.reason', ?,
              '$.interest.scoredBy', ?,
              '$.interest.scoredAtMs', ?
            ) WHERE id = ?
            """,
            (score, dur, why, SCORED_BY, now_ms, item_id),
        )
        updated += 1
    if not args.dry_run:
        conn.commit()
    total_with = conn.execute(
        "SELECT COUNT(*) FROM feed WHERE json_extract(metadata, '$.interest.score') IS NOT NULL"
    ).fetchone()[0]
    print(f"scores in file: {len(rows)}, updated: {updated}, curator-kept: {skipped_curator}, "
          f"missing ids: {missing}, total items with interest now: {total_with}")


if __name__ == "__main__":
    main()
