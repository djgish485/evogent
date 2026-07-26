#!/usr/bin/env python3
"""Rebuild the intent search index from the repo's .intent/ files.

Source of truth (committed to the repo, append-only):
  .intent/backlog.jsonl   — generalized product decisions with lifecycle status
                            and supersedes-chains; never raw private evidence
  .intent/contracts.jsonl — the rules currently in force (status 'law' =
                            permanently in force)

This script derives the SQLite FTS index inside the local intent ledger so
agents can search fast. The index is disposable; the JSONL files are not.
Run after any pull or append. Appends go to the JSONL files first (then
commit them), never to the index directly. Dated deployment observations,
direct user quotes, account identifiers, and personal taste stay in ignored
private runtime state.

Usage: python3 scripts/intent/sync_intent_index.py [--repo PATH] [--db PATH]
"""
import argparse
import json
import sqlite3
from pathlib import Path

from contract_ledger import load_contract_ledger

DEFAULT_REPO = Path(__file__).resolve().parents[2]
DEFAULT_DB = str(DEFAULT_REPO / ".intent-ledger" / "evogent-intent-ledger.sqlite")


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
      CREATE TABLE IF NOT EXISTS intent_backlog (
        key TEXT PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, area TEXT NOT NULL,
        intent TEXT NOT NULL, quote TEXT, status TEXT NOT NULL DEFAULT 'unknown',
        status_note TEXT, supersedes TEXT, added_by TEXT, added_at TEXT
      )""")
    conn.execute("""
      CREATE VIRTUAL TABLE IF NOT EXISTS intent_backlog_fts USING fts5(
        intent, quote, key UNINDEXED, ts UNINDEXED, area UNINDEXED, status UNINDEXED
      )""")
    # This index is disposable. Recreate the contract projection so older local
    # schemas cannot silently omit stable keys or append-only history.
    conn.execute("DROP TABLE IF EXISTS intent_contracts")
    conn.execute("DROP TABLE IF EXISTS intent_contract_history")
    conn.execute("""
      CREATE TABLE intent_contracts (
        contract_key TEXT PRIMARY KEY, seed_source TEXT NOT NULL, area TEXT NOT NULL,
        statement TEXT NOT NULL, evidence TEXT, verify_hint TEXT, confidence TEXT,
        status TEXT NOT NULL, supersedes TEXT, source_line INTEGER NOT NULL
      )""")
    conn.execute("""
      CREATE TABLE intent_contract_history (
        revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_key TEXT NOT NULL, seed_source TEXT NOT NULL, area TEXT NOT NULL,
        statement TEXT NOT NULL, evidence TEXT, verify_hint TEXT, confidence TEXT,
        status TEXT NOT NULL, supersedes TEXT, source_line INTEGER NOT NULL,
        is_active INTEGER NOT NULL
      )""")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(DEFAULT_REPO))
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()
    repo = Path(args.repo)
    contracts_path = repo / ".intent" / "contracts.jsonl"
    contract_ledger = load_contract_ledger(contracts_path)

    conn = sqlite3.connect(args.db)
    ensure_schema(conn)

    backlog_path = repo / ".intent" / "backlog.jsonl"
    rows = 0
    conn.execute("DELETE FROM intent_backlog")
    conn.execute("DELETE FROM intent_backlog_fts")
    for line in backlog_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        conn.execute(
            """INSERT OR REPLACE INTO intent_backlog
               (key, ts, kind, area, intent, quote, status, status_note, supersedes, added_by, added_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (d["key"], d["ts"], d.get("kind", "directive"), d.get("area", "other"),
             d["intent"], d.get("quote"), d.get("status", "unknown"), d.get("status_note"),
             d.get("supersedes"), d.get("added_by"), d.get("added_at")),
        )
        conn.execute(
            "INSERT INTO intent_backlog_fts (intent, quote, key, ts, area, status) VALUES (?, ?, ?, ?, ?, ?)",
            (d["intent"], d.get("quote", ""), d["key"], d["ts"], d.get("area", "other"), d.get("status", "unknown")),
        )
        rows += 1

    active_keys = {revision.key for revision in contract_ledger.active}
    for revision in contract_ledger.history:
        d = revision.record
        conn.execute(
            """INSERT INTO intent_contract_history
               (contract_key, seed_source, area, statement, evidence, verify_hint,
                confidence, status, supersedes, source_line, is_active)
               VALUES (?, 'repo-jsonl', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                revision.key,
                d["area"],
                d["statement"],
                d.get("evidence"),
                d.get("verify_hint"),
                d.get("confidence"),
                d.get("status"),
                json.dumps(revision.supersedes),
                revision.line_number,
                1 if revision.key in active_keys
                and contract_ledger.latest_by_key[revision.key] is revision
                else 0,
            ),
        )
    for revision in contract_ledger.active:
        d = revision.record
        conn.execute(
            """INSERT INTO intent_contracts
               (contract_key, seed_source, area, statement, evidence, verify_hint,
                confidence, status, supersedes, source_line)
               VALUES (?, 'repo-jsonl', ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                revision.key,
                d["area"],
                d["statement"],
                d.get("evidence"),
                d.get("verify_hint"),
                d.get("confidence"),
                d.get("status"),
                json.dumps(revision.supersedes),
                revision.line_number,
            ),
        )

    conn.commit()
    n_contracts = len(contract_ledger.active)
    laws = conn.execute("SELECT count(*) FROM intent_contracts WHERE status='law'").fetchone()[0]
    print(
        f"index rebuilt: {rows} backlog entries, "
        f"{n_contracts} active contracts ({len(contract_ledger.history)} revisions, "
        f"{laws} laws)"
    )


if __name__ == "__main__":
    main()
