from __future__ import annotations

import importlib.util
import json
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "intent"))
from contract_ledger import active_contract_records  # noqa: E402

MODULE_PATH = ROOT / "scripts" / "intent" / "audit_curator_contracts.py"
SPEC = importlib.util.spec_from_file_location("audit_curator_contracts", MODULE_PATH)
assert SPEC and SPEC.loader
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class IntentAuditContractTests(unittest.TestCase):
    def test_build_report_queries_current_runtime_receipts(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE curation_log (
              id INTEGER PRIMARY KEY,
              request_id TEXT,
              triggered_by TEXT,
              started_at TEXT,
              completed_at TEXT,
              items_added INTEGER,
              completion_status TEXT,
              completion_reason TEXT
            );
            CREATE TABLE feed_arrangement_runs (
              id INTEGER PRIMARY KEY,
              source TEXT,
              created_at TEXT,
              ordering_count INTEGER,
              thread_count INTEGER,
              updated_item_count INTEGER,
              carry_forward_audit TEXT,
              curator_carry_forward_audit TEXT
            );
            CREATE TABLE feed (
              id TEXT PRIMARY KEY,
              type TEXT NOT NULL,
              display_order INTEGER,
              thread_id TEXT,
              metadata TEXT,
              parent_id TEXT,
              created_at_ms INTEGER
            );
            """
        )
        conn.execute(
            """
            INSERT INTO curation_log
              (id, request_id, triggered_by, started_at, completed_at,
               items_added, completion_status, completion_reason)
            VALUES (1, 'request', 'phone', 'start', 'done', 1, 'success',
                    'accepted one worthwhile item')
            """
        )
        conn.execute(
            """
            INSERT INTO feed_arrangement_runs
              (id, source, created_at, ordering_count, thread_count,
               updated_item_count, carry_forward_audit,
               curator_carry_forward_audit)
            VALUES (1, 'phone', 'now', 1, 0, 1, ?, NULL)
            """,
            (
                json.dumps(
                    {
                        "eligibleCount": 1,
                        "reviewedCount": 1,
                        "returnedCount": 1,
                        "includeAllUnviewed": True,
                        "includeDisplayed": True,
                        "promotedIds": [],
                    }
                ),
            ),
        )
        conn.execute(
            """
            INSERT INTO feed
              (id, type, display_order, thread_id, metadata, parent_id, created_at_ms)
            VALUES ('item', 'article', 1, 'shipment-singleton:item', ?, NULL, 1)
            """,
            (
                json.dumps(
                    {
                        "thread": {
                            "threadId": "historical-topic",
                            "threadTitle": "Historical topic",
                        },
                        "interest": {
                            "score": 0.8,
                            "durability": "evergreen",
                        },
                    }
                ),
            ),
        )
        conn.execute(
            """
            INSERT INTO feed
              (id, type, display_order, thread_id, metadata, parent_id, created_at_ms)
            VALUES (
              'pending-suggestion',
              'suggestion',
              2,
              'shipment-singleton:pending-suggestion',
              '{}',
              NULL,
              2
            )
            """
        )

        report = AUDIT.build_report(conn)

        self.assertEqual(report["status"], "pass")
        self.assertTrue(all(check["ok"] for check in report["checks"].values()))
        self.assertEqual(report["checks"]["primary_slate_bounded"]["count"], 1)
        self.assertEqual(
            report["checks"]["runtime_judgment_present"]["primarySlateCount"],
            1,
        )
        self.assertEqual(
            [row["id"] for row in report["primary_slate"]],
            ["item"],
        )
        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory) / "audits"
            path, latest = AUDIT.write_report(report, out_dir)
            self.assertEqual(out_dir.stat().st_mode & 0o777, 0o700)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(latest.stat().st_mode & 0o777, 0o600)

    def test_complete_eligible_set_is_required_without_promotion_count(self) -> None:
        arrangement = AUDIT.summarize_arrangement(
            {
                "id": 7,
                "carry_forward_audit": {
                        "eligibleCount": 8,
                        "reviewedCount": 8,
                        "returnedCount": 8,
                    "includeAllUnviewed": True,
                    "includeDisplayed": True,
                    "promotedIds": [],
                },
            }
        )

        self.assertTrue(AUDIT.check_latest_eligible_review([arrangement])["ok"])

        arrangement["carry_forward_audit"]["reviewedCount"] = 7
        self.assertFalse(AUDIT.check_latest_eligible_review([arrangement])["ok"])
        arrangement["carry_forward_audit"]["reviewedCount"] = 8
        arrangement["carry_forward_audit"]["returnedCount"] = 7
        self.assertFalse(AUDIT.check_latest_eligible_review([arrangement])["ok"])

    def test_primary_slate_has_only_a_ceiling(self) -> None:
        self.assertTrue(AUDIT.check_primary_slate(0)["ok"])
        self.assertTrue(AUDIT.check_primary_slate(1)["ok"])
        self.assertTrue(AUDIT.check_primary_slate(50)["ok"])
        self.assertFalse(AUDIT.check_primary_slate(51)["ok"])

    def test_runtime_judgment_requires_score_and_durability(self) -> None:
        judged = [
            {
                "id": "item-a",
                "interest_score": 0.91,
                "interest_durability": "evergreen",
            },
            {
                "id": "item-b",
                "interest_score": 0.42,
                "interest_durability": "news",
            },
        ]
        self.assertTrue(AUDIT.check_runtime_judgment(judged)["ok"])

        missing = [*judged, {"id": "item-c"}]
        result = AUDIT.check_runtime_judgment(missing)
        self.assertFalse(result["ok"])
        self.assertEqual(result["missingJudgmentIds"], ["item-c"])

    def test_threads_are_stable_contiguous_and_singletons_remain_distinct(self) -> None:
        valid = [
            {
                "id": "cluster-a",
                "metadata_thread_id": "thread-a",
                "shipment_thread_id": "thread-a",
            },
            {
                "id": "cluster-b",
                "metadata_thread_id": "thread-a",
                "shipment_thread_id": "thread-a",
            },
            {
                "id": "singleton",
                "metadata_thread_id": None,
                "shipment_thread_id": "shipment-singleton:singleton",
            },
        ]
        self.assertTrue(AUDIT.check_thread_integrity(valid)["ok"])

        split = [
            valid[0],
            valid[2],
            valid[1],
        ]
        self.assertEqual(
            AUDIT.check_thread_integrity(split)["splitThreadIds"],
            ["thread-a"],
        )

        remapped_real_thread = [
            {
                "id": "cluster-a",
                "metadata_thread_id": "thread-a",
                "shipment_thread_id": "thread-b",
            },
            {
                "id": "cluster-b",
                "metadata_thread_id": "thread-b",
                "shipment_thread_id": "thread-b",
            },
        ]
        result = AUDIT.check_thread_integrity(remapped_real_thread)
        self.assertFalse(result["ok"])
        self.assertEqual(result["remappedThreadItemIds"], ["cluster-a"])

        pooled_singletons = [
            {
                "id": "singleton-a",
                "metadata_thread_id": None,
                "shipment_thread_id": "shipment-singleton:singleton-a",
            },
            {
                "id": "singleton-b",
                "metadata_thread_id": None,
                "shipment_thread_id": "shipment-singleton:singleton-a",
            },
        ]
        pooled_result = AUDIT.check_thread_integrity(pooled_singletons)
        self.assertFalse(pooled_result["ok"])
        self.assertEqual(
            pooled_result["pooledSingletonThreadIds"],
            ["shipment-singleton:singleton-a"],
        )
        self.assertEqual(
            pooled_result["invalidSingletonIdentityItemIds"],
            ["singleton-b"],
        )

        legacy_hidden_singleton = [{
            "id": "legacy-singleton",
            "metadata_thread_id": None,
            "shipment_thread_id": "carry-forward-singleton:legacy-singleton",
        }]
        self.assertTrue(
            AUDIT.check_thread_integrity(legacy_hidden_singleton)["ok"]
        )

        exposed_singleton = [{
            "id": "legacy-singleton",
            "metadata_thread_id": "carry-forward-singleton:legacy-singleton",
            "shipment_thread_id": "carry-forward-singleton:legacy-singleton",
        }]
        exposed_result = AUDIT.check_thread_integrity(exposed_singleton)
        self.assertFalse(exposed_result["ok"])
        self.assertEqual(
            exposed_result["singletonMetadataItemIds"],
            ["legacy-singleton"],
        )

    def test_completion_receipts_are_coherent_not_volume_gated(self) -> None:
        valid = [
            {
                "id": 1,
                "completion_status": "success",
                "items_added": 1,
                "completion_reason": "accepted the one worthwhile item",
            },
            {
                "id": 2,
                "completion_status": "successful_empty",
                "items_added": 0,
                "completion_reason": "runtime agent found nothing worth shipping",
            },
        ]
        self.assertTrue(AUDIT.check_truthful_completion_receipts(valid)["ok"])

        contradictory = [
            {
                "id": 3,
                "completion_status": "success",
                "items_added": 0,
                "completion_reason": "",
            }
        ]
        issues = AUDIT.check_truthful_completion_receipts(contradictory)["issues"]
        self.assertEqual(
            {issue["issue"] for issue in issues},
            {"missing_reason", "success_without_items"},
        )

    def test_public_audit_instructions_do_not_reintroduce_old_quotas(self) -> None:
        paths = [
            ROOT / "AGENTS.md",
            ROOT / "CLAUDE.md",
            ROOT / ".agents" / "skills" / "evogent-intent-audit" / "SKILL.md",
            ROOT / "docs" / "intent-ledger.md",
            ROOT / "docs" / "openclaw-curator-migration.md",
            ROOT / "docs" / "openclaw-integration.md",
            ROOT / "scripts" / "intent" / "audit_curator_contracts.py",
            ROOT / "scripts" / "intent" / "query_relevant_intent.py",
            ROOT / "scripts" / "intent" / "ledger_search_experiments.py",
            ROOT / "skills-library" / "account-mirror" / "SKILL.md",
            ROOT / "skills-library" / "current-event-tracker" / "SKILL.md",
            ROOT / "skills-library" / "full-text" / "SKILL.md",
            ROOT / "skills-library" / "phone-life-admin" / "SKILL.md",
            ROOT / "skills-library" / "tweet-cache-bird" / "SKILL.md",
        ]
        active_contracts = active_contract_records(
            ROOT / ".intent" / "contracts.jsonl"
        )
        combined = (
            "\n".join(path.read_text() for path in paths)
            + "\n"
            + "\n".join(
                str(record["statement"]) for record in active_contracts
            )
        ).lower()

        stale_phrases = (
            "-".join(("40", "50")),
            "-".join(("4", "7")) + " named threads",
            "at least one original " + "analysis item",
            "reserves " + "about half",
            "-".join(("2026", "06", "01")),
        )
        for stale in stale_phrases:
            self.assertNotIn(stale, combined)

        self.assertIn("no minimum", combined)
        self.assertIn("stable hidden shipment identity", combined)
        self.assertIn("shipment-singleton:<item-id>", combined)
        self.assertIn("2+ unique members", combined)
        self.assertNotIn(
            "every root item still carries a stable shipment\n   `threadid`",
            combined,
        )
        self.assertIn("truthful completion receipt", combined)

    def test_ranking_formulas_survive_only_as_superseded_history(self) -> None:
        contracts_path = ROOT / ".intent" / "contracts.jsonl"
        raw_history = contracts_path.read_text().lower()
        active_text = "\n".join(
            str(record["statement"])
            for record in active_contract_records(contracts_path)
        ).lower()
        retired_formulas = (
            "promotion-count penalty",
            "durability-decayed",
            "ranking applies durability decay",
            "deterministic heuristics may expose candidates or break ties",
        )
        for formula in retired_formulas:
            self.assertIn(formula, raw_history)
            self.assertNotIn(formula, active_text)

        runtime_paths = [
            ROOT / "data" / "interestingness-rubric.default.md",
            ROOT / ".claude" / "commands" / "curate.md",
            ROOT / ".claude" / "commands" / "dream.md",
            ROOT / "scripts" / "install-openclaw-curator-agent.sh",
            ROOT / "src" / "lib" / "feed-carry-forward.ts",
            ROOT / "src" / "app" / "api" / "internal" / "curate" / "arrange" / "route.ts",
            ROOT / "phone-paradigm" / "device" / "phone-tools" / "verify-intents.py",
        ]
        runtime_text = "\n".join(
            path.read_text() for path in runtime_paths if path.exists()
        )
        self.assertIsNone(
            re.search(
                r"promotion[-_ ]count penalty|durability[-_ ]decay|"
                r"effective[-_ ]interest|seen[-_ ]demotion|"
                r"favorite-account-in-top|heuristics may [^\r\n]{0,120}break ties",
                runtime_text,
                re.IGNORECASE,
            )
        )


if __name__ == "__main__":
    unittest.main()
