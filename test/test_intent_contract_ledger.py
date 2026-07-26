from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INTENT_SCRIPTS = ROOT / "scripts" / "intent"
sys.path.insert(0, str(INTENT_SCRIPTS))

from contract_ledger import (  # noqa: E402
    ContractLedgerError,
    resolve_contract_lines,
    stable_contract_key,
)


def contract(
    statement: str,
    *,
    area: str = "feed-ordering",
    status: str = "fixed",
    key: str | None = None,
    supersedes: list[str] | None = None,
) -> dict[str, object]:
    record: dict[str, object] = {
        "area": area,
        "statement": statement,
        "status": status,
        "evidence": "Public contract-ledger tests.",
        "confidence": "product-law",
        "verify_hint": "Run the contract-ledger tests.",
    }
    if key is not None:
        record["key"] = key
    if supersedes is not None:
        record["supersedes"] = supersedes
    return record


def lines(*records: dict[str, object]) -> list[str]:
    return [json.dumps(record) for record in records]


class ContractLedgerTests(unittest.TestCase):
    def test_replacement_hides_superseded_text_but_preserves_history(self) -> None:
        old = contract("retiredmarker mechanical ranking")
        old_key = stable_contract_key(
            str(old["area"]),
            str(old["statement"]),
        )
        current = contract(
            "currentmarker explicit agent shipment order",
            status="law",
            key="feed-ordering-agent-order",
            supersedes=[old_key],
        )

        ledger = resolve_contract_lines(lines(old, current))

        self.assertEqual(
            [revision.record["statement"] for revision in ledger.active],
            ["currentmarker explicit agent shipment order"],
        )
        self.assertEqual(len(ledger.history), 2)
        self.assertEqual(ledger.superseded_by[old_key], "feed-ordering-agent-order")
        self.assertEqual(
            stable_contract_key(str(old["area"]), str(old["statement"])),
            old_key,
        )

    def test_explicit_tombstone_is_a_valid_last_record_revision(self) -> None:
        old = contract("obsolete durability interleaving")
        old_key = stable_contract_key(str(old["area"]), str(old["statement"]))
        tombstone = contract(
            "obsolete durability interleaving",
            status="superseded",
            key=old_key,
            supersedes=[old_key],
        )

        ledger = resolve_contract_lines(lines(old, tombstone))

        self.assertEqual(ledger.active, ())
        self.assertEqual(ledger.latest_by_key[old_key].record["status"], "superseded")
        self.assertEqual(len(ledger.history), 2)

    def test_malformed_supersedes_shape_is_rejected(self) -> None:
        old = contract("old")
        malformed = contract("new", key="new-contract")
        malformed["supersedes"] = "old-contract"

        with self.assertRaisesRegex(
            ContractLedgerError,
            "non-empty array",
        ):
            resolve_contract_lines(lines(old, malformed))

    def test_duplicate_key_requires_an_explicit_self_revision(self) -> None:
        first = contract("first", key="stable-contract")
        duplicate = contract("silent rewrite", key="stable-contract")

        with self.assertRaisesRegex(
            ContractLedgerError,
            "duplicate key",
        ):
            resolve_contract_lines(lines(first, duplicate))

    def test_unknown_supersession_is_rejected(self) -> None:
        replacement = contract(
            "replacement",
            key="replacement-contract",
            supersedes=["missing-contract"],
        )

        with self.assertRaisesRegex(
            ContractLedgerError,
            "unknown contract key",
        ):
            resolve_contract_lines(lines(replacement))

    def test_a_contract_cannot_be_superseded_twice(self) -> None:
        old = contract("old")
        old_key = stable_contract_key(str(old["area"]), str(old["statement"]))
        first = contract(
            "first replacement",
            key="first-replacement",
            supersedes=[old_key],
        )
        second = contract(
            "second replacement",
            key="second-replacement",
            supersedes=[old_key],
        )

        with self.assertRaisesRegex(
            ContractLedgerError,
            "already superseded",
        ):
            resolve_contract_lines(lines(old, first, second))

    def test_cli_query_and_sync_expose_only_active_contracts(self) -> None:
        old = contract("retiredmarker promotion count penalty")
        old_key = stable_contract_key(str(old["area"]), str(old["statement"]))
        current = contract(
            "currentmarker explicit agent order",
            status="law",
            key="feed-ordering-current-agent-order",
            supersedes=[old_key],
        )

        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            intent_dir = repo / ".intent"
            intent_dir.mkdir()
            (intent_dir / "contracts.jsonl").write_text(
                "\n".join(lines(old, current)) + "\n",
                encoding="utf-8",
            )
            (intent_dir / "backlog.jsonl").write_text("", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)

            retired_query = subprocess.run(
                [
                    "python3",
                    str(INTENT_SCRIPTS / "intent"),
                    "query",
                    "retiredmarker",
                ],
                cwd=repo,
                check=True,
                text=True,
                capture_output=True,
            )
            current_query = subprocess.run(
                [
                    "python3",
                    str(INTENT_SCRIPTS / "intent"),
                    "query",
                    "currentmarker",
                ],
                cwd=repo,
                check=True,
                text=True,
                capture_output=True,
            )
            self.assertIn("no matches", retired_query.stdout)
            self.assertIn("currentmarker explicit agent order", current_query.stdout)

            db_path = repo / "intent.sqlite"
            subprocess.run(
                [
                    "python3",
                    str(INTENT_SCRIPTS / "sync_intent_index.py"),
                    "--repo",
                    str(repo),
                    "--db",
                    str(db_path),
                ],
                cwd=repo,
                check=True,
                text=True,
                capture_output=True,
            )
            with sqlite3.connect(db_path) as conn:
                active = conn.execute(
                    "SELECT statement FROM intent_contracts ORDER BY source_line"
                ).fetchall()
                history = conn.execute(
                    """
                    SELECT statement, is_active
                    FROM intent_contract_history
                    ORDER BY source_line
                    """
                ).fetchall()
            self.assertEqual(active, [("currentmarker explicit agent order",)])
            self.assertEqual(
                history,
                [
                    ("retiredmarker promotion count penalty", 0),
                    ("currentmarker explicit agent order", 1),
                ],
            )


if __name__ == "__main__":
    unittest.main()
