#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))

from automatic_diagnosis_budget import (  # noqa: E402
    DiagnosisBudgetError,
    claim_automatic_diagnosis,
    clear_source_state,
    observe_mechanics_failure,
    reset_source_streak,
)


class AutomaticDiagnosisBudgetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.state = Path(self.temporary.name) / ".automatic-diagnosis-budget.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def claim(
        self,
        source: str,
        count: int,
        service_date: str,
        *,
        available: bool = True,
        stamp: int = 1_800_000_000_000,
        lane: str = "barren",
    ):
        return claim_automatic_diagnosis(
            self.state,
            source=source,
            barren_count=count,
            dispatcher_available=available,
            service_date=service_date,
            stamp_ms=stamp,
            lane=lane,
        )

    def test_one_global_attempt_per_service_date_and_deferred_source_runs_later(self) -> None:
        first = self.claim("source-a", 3, "2027-01-10")
        deferred = self.claim("source-b", 3, "2027-01-10", stamp=1_800_000_001_000)
        still_deferred = self.claim(
            "source-b", 4, "2027-01-10", stamp=1_800_000_002_000
        )
        next_day = self.claim(
            # A mechanics/provider failure may have reset the shell's
            # consecutive-empty file. The already-pending threshold survives.
            "source-b", 1, "2027-01-11", stamp=1_800_086_400_000
        )

        self.assertTrue(first["claimed"])
        self.assertEqual(deferred["reason"], "daily_budget_spent")
        self.assertEqual(still_deferred["reason"], "daily_budget_spent")
        self.assertTrue(next_day["claimed"])

        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(set(state["claims"]), {"2027-01-10", "2027-01-11"})
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        self.assertEqual(
            self.state.with_name(f"{self.state.name}.lock").stat().st_mode & 0o777,
            0o600,
        )

    def test_rearms_only_at_each_third_barren_count(self) -> None:
        self.assertEqual(
            self.claim("source-a", 2, "2027-02-01")["reason"],
            "threshold_not_due",
        )
        self.assertTrue(self.claim("source-a", 3, "2027-02-01")["claimed"])
        self.assertEqual(
            self.claim("source-a", 4, "2027-02-02")["reason"],
            "threshold_not_due",
        )
        self.assertTrue(self.claim("source-a", 6, "2027-02-02")["claimed"])

    def test_dispatcher_unavailability_keeps_threshold_pending_without_spend(self) -> None:
        unavailable = self.claim(
            "source-a", 3, "2027-03-01", available=False
        )
        later = self.claim("source-a", 4, "2027-03-01")

        self.assertEqual(unavailable["reason"], "dispatcher_unavailable")
        self.assertTrue(later["claimed"])

    def test_unavailable_first_threshold_survives_an_interrupted_streak(self) -> None:
        unavailable = self.claim(
            "source-a", 3, "2027-03-10", available=False
        )
        self.assertEqual(unavailable["reason"], "dispatcher_unavailable")
        self.assertTrue(
            reset_source_streak(
                self.state,
                source="source-a",
                stamp_ms=1_800_000_001_000,
            )
        )

        later = self.claim(
            "source-a",
            1,
            "2027-03-11",
            stamp=1_800_086_400_000,
        )
        self.assertTrue(later["claimed"])

    def test_clear_resets_source_streak_but_never_refunds_daily_claim(self) -> None:
        self.assertTrue(self.claim("source-a", 3, "2027-04-01")["claimed"])
        self.assertTrue(clear_source_state(self.state, source="source-a"))
        same_day = self.claim("source-a", 3, "2027-04-01")
        next_day = self.claim("source-a", 3, "2027-04-02")

        self.assertEqual(same_day["reason"], "daily_budget_spent")
        self.assertTrue(next_day["claimed"])

    def test_interrupted_handled_streak_rearms_without_refunding_daily_claim(self) -> None:
        self.assertTrue(self.claim("source-a", 3, "2027-04-10")["claimed"])
        self.assertTrue(
            reset_source_streak(
                self.state,
                source="source-a",
                stamp_ms=1_800_000_001_000,
            )
        )

        same_day = self.claim("source-a", 3, "2027-04-10")
        next_day = self.claim("source-a", 3, "2027-04-11")

        self.assertEqual(same_day["reason"], "daily_budget_spent")
        self.assertTrue(next_day["claimed"])
        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(set(state["claims"]), {"2027-04-10", "2027-04-11"})

    def test_pending_old_streak_survives_reset_without_suppressing_new_streak(self) -> None:
        self.assertTrue(self.claim("source-a", 3, "2027-04-20")["claimed"])
        deferred = self.claim("source-b", 6, "2027-04-20")
        self.assertEqual(deferred["reason"], "daily_budget_spent")
        self.assertTrue(
            reset_source_streak(
                self.state,
                source="source-b",
                stamp_ms=1_800_000_001_000,
            )
        )

        old_pending = self.claim("source-b", 1, "2027-04-21")
        new_streak = self.claim("source-b", 3, "2027-04-22")

        self.assertTrue(old_pending["claimed"])
        self.assertTrue(new_streak["claimed"])

    def test_mechanics_incidents_are_durable_and_independent_from_barren_state(self) -> None:
        counts = [
            observe_mechanics_failure(
                self.state,
                source="source-a",
                stamp_ms=1_800_000_000_000 + index,
            )
            for index in range(3)
        ]
        mechanics = self.claim(
            "source-a",
            counts[-1],
            "2027-04-25",
            lane="mechanics",
        )
        barren = self.claim("source-a", 3, "2027-04-26")

        self.assertEqual(counts, [1, 2, 3])
        self.assertTrue(mechanics["claimed"])
        self.assertTrue(barren["claimed"])

        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(state["mechanicsSources"]["source-a"]["streakCount"], 3)
        self.assertEqual(state["sources"]["source-a"]["handledThrough"], 3)
        self.assertEqual(state["claims"]["2027-04-25"]["lane"], "mechanics")
        self.assertNotIn("lane", state["claims"]["2027-04-26"])

        self.assertTrue(
            clear_source_state(self.state, source="source-a", lane="mechanics")
        )
        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertNotIn("source-a", state["mechanicsSources"])
        self.assertIn("source-a", state["sources"])

    def test_corrupt_or_symlinked_state_fails_closed(self) -> None:
        self.state.write_text("{not-json", encoding="utf-8")
        with self.assertRaises(DiagnosisBudgetError):
            self.claim("source-a", 3, "2027-05-01")
        self.assertEqual(self.state.read_text(encoding="utf-8"), "{not-json")

        self.state.unlink()
        target = Path(self.temporary.name) / "target.json"
        target.write_text(
            '{"schemaVersion":1,"claims":{},"sources":{}}\n',
            encoding="utf-8",
        )
        self.state.symlink_to(target)
        with self.assertRaises(DiagnosisBudgetError):
            self.claim("source-a", 3, "2027-05-01")

    def test_old_claims_compact_to_a_bounded_fail_closed_boundary(self) -> None:
        first_date = dt.date(2020, 1, 1)
        dates = [(first_date + dt.timedelta(days=index)).isoformat() for index in range(403)]
        claims = {
            service_date: {
                "attemptedAtMs": 1_600_000_000_000 + index,
                "source": f"source-{index}",
                "threshold": 3,
            }
            for index, service_date in enumerate(dates)
        }
        self.state.write_text(
            json.dumps(
                {"schemaVersion": 1, "claims": claims, "sources": {}}
            ),
            encoding="utf-8",
        )

        compacted = self.claim("current", 1, "2027-05-10")
        self.assertEqual(compacted["reason"], "threshold_not_due")
        value = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(len(value["claims"]), 400)
        self.assertEqual(value["closedThroughServiceDate"], dates[2])
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)

        archived = self.claim("archived", 3, dates[0])
        self.assertEqual(archived["reason"], "daily_budget_spent")
        current = self.claim("current", 3, "2027-05-10")
        duplicate = self.claim("other", 3, "2027-05-10")
        self.assertTrue(current["claimed"])
        self.assertEqual(duplicate["reason"], "daily_budget_spent")

        value = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(len(value["claims"]), 400)
        self.assertIn("2027-05-10", value["claims"])

    def test_concurrent_claims_have_one_winner(self) -> None:
        command = [
            sys.executable,
            str(TOOLS / "automatic_diagnosis_budget.py"),
            "claim",
            "--state",
            str(self.state),
            "--barren-count",
            "3",
            "--service-date",
            "2027-06-01",
            "--now-ms",
            "1800000000000",
        ]
        processes = [
            subprocess.Popen(
                [*command, "--source", f"source-{index}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for index in range(12)
        ]
        results = [process.communicate(timeout=10) for process in processes]
        self.assertTrue(all(process.returncode == 0 for process in processes))
        self.assertEqual(sum(stdout.startswith("1\t") for stdout, _ in results), 1)

        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(len(state["claims"]), 1)
        self.assertEqual(len(state["sources"]), 12)


if __name__ == "__main__":
    unittest.main()
