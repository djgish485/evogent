#!/usr/bin/env python3
"""Append intent backlog entries: writes to .intent/backlog.jsonl (the
committed, append-only source of truth) and re-syncs the SQLite index.

The backlog is the fine-grained, dated register of the product owner's
intentions (Drew Breunig-style: the story of why, mined from chat logs and
git history) — one row per distinct intention, with verbatim quote, normalized
intent statement, lifecycle status, and supersedes-chains for evolution.

Input JSONL fields: ts, kind, area, intent, quote, [status], [status_note], [supersedes_hint]
Idempotent: entries are keyed by sha1(ts + quote); re-loading updates in place.

Usage:
  python3 scripts/intent/load_intent_backlog.py --jsonl FILE [--added-by WHO] [--db PATH]
  python3 scripts/intent/load_intent_backlog.py --summary
"""
import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone

LEDGER_DB = "/root/media-agent/.intent-ledger/evogent-intent-ledger.sqlite"
KINDS = {"directive", "complaint", "preference", "idea", "pivot", "approval"}
STATUSES = {"implemented", "fixed", "open", "superseded", "rejected", "unknown"}


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
      CREATE TABLE IF NOT EXISTS intent_backlog (
        key TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        area TEXT NOT NULL,
        intent TEXT NOT NULL,
        quote TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        status_note TEXT,
        supersedes TEXT,
        added_by TEXT,
        added_at TEXT
      )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS intent_backlog_ts_idx ON intent_backlog (ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS intent_backlog_area_idx ON intent_backlog (area, status)")
    conn.execute("""
      CREATE VIRTUAL TABLE IF NOT EXISTS intent_backlog_fts USING fts5(
        intent, quote, key UNINDEXED, ts UNINDEXED, area UNINDEXED, status UNINDEXED
      )
    """)


def entry_key(ts: str, quote: str, intent: str) -> str:
    return hashlib.sha1(f"{ts}|{quote or intent}".encode()).hexdigest()[:16]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jsonl")
    parser.add_argument("--added-by", default="manual")
    parser.add_argument("--db", default=LEDGER_DB)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    ensure_schema(conn)

    if args.summary or not args.jsonl:
        total = conn.execute("SELECT count(*) FROM intent_backlog").fetchone()[0]
        print(f"intent_backlog: {total} entries")
        for row in conn.execute(
            "SELECT area, status, count(*) FROM intent_backlog GROUP BY area, status ORDER BY area, status"
        ):
            print(f"  {row[0]:14s} {row[1]:12s} {row[2]}")
        return

    now = datetime.now(timezone.utc).isoformat()
    upserted = skipped = 0
    with open(args.jsonl) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            ts, intent = (d.get("ts") or "").strip(), (d.get("intent") or "").strip()
            if not ts or not intent:
                skipped += 1
                continue
            kind = d.get("kind") if d.get("kind") in KINDS else "directive"
            status = d.get("status") if d.get("status") in STATUSES else "unknown"
            quote = (d.get("quote") or "").strip()[:400]
            key = entry_key(ts, quote, intent)
            conn.execute(
                """
                INSERT INTO intent_backlog (key, ts, kind, area, intent, quote, status, status_note, supersedes, added_by, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  kind=excluded.kind, area=excluded.area, intent=excluded.intent,
                  status=excluded.status, status_note=excluded.status_note,
                  supersedes=excluded.supersedes
                """,
                (
                    key, ts, kind, (d.get("area") or "other")[:24], intent[:600], quote,
                    status, (d.get("status_note") or "")[:300] or None,
                    (d.get("supersedes") or None), args.added_by, now,
                ),
            )
            conn.execute("DELETE FROM intent_backlog_fts WHERE key = ?", (key,))
            conn.execute(
                "INSERT INTO intent_backlog_fts (intent, quote, key, ts, area, status) VALUES (?, ?, ?, ?, ?, ?)",
                (intent, quote, key, ts, (d.get("area") or "other")[:24], status),
            )
            upserted += 1
    conn.commit()
    # source of truth: append normalized entries to the repo JSONL
    import os
    repo_jsonl = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".intent", "backlog.jsonl")
    existing_keys = set()
    if os.path.exists(repo_jsonl):
        with open(repo_jsonl) as rf:
            for raw in rf:
                raw = raw.strip()
                if raw:
                    try:
                        existing_keys.add(json.loads(raw)["key"])
                    except (json.JSONDecodeError, KeyError):
                        pass
    appended = 0
    with open(repo_jsonl, "a") as af:
        for row in conn.execute("SELECT key, ts, kind, area, intent, quote, status, status_note, supersedes, added_by FROM intent_backlog"):
            if row[0] in existing_keys:
                continue
            entry = {"key": row[0], "ts": row[1], "kind": row[2], "area": row[3], "intent": row[4],
                     "quote": row[5], "status": row[6], "status_note": row[7], "supersedes": row[8],
                     "author": args.added_by, "added_by": row[9]}
            af.write(json.dumps({k: v for k, v in entry.items() if v not in (None, "")}, ensure_ascii=False) + "\n")
            appended += 1
    if appended:
        print(f"appended {appended} entries to .intent/backlog.jsonl - COMMIT IT")
    total = conn.execute("SELECT count(*) FROM intent_backlog").fetchone()[0]
    print(f"upserted {upserted}, skipped {skipped}, total {total}")


if __name__ == "__main__":
    main()
