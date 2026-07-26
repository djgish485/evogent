#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))

from durable_task_queue import (  # noqa: E402
    BASE_BACKOFF_MS,
    acknowledge_queued_task,
    claim_task,
    enqueue_task,
    ensure_nightly_task,
    finish_task,
)
from interest_browse_runtime import (  # noqa: E402
    PNG_SIGNATURE,
    apply_submit_result,
    classify_interest_outcomes,
    derive_instagram_geometry,
    png_dimensions,
)


class DurableQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "queue"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_ack_is_durable_before_lease_disappears(self) -> None:
        created = enqueue_task(
            self.root,
            {"kind": "discovery", "pkg": "example.app", "name": "Example", "source": "example"},
            task_id="example",
            stamp=1_000,
        )
        self.assertTrue(created["created"])
        lease = claim_task(self.root, owner="test-owner", stamp=2_000, lease_ms=20_000)
        self.assertEqual(lease["state"], "leased")
        result = finish_task(
            self.root,
            lease["leasePath"],
            result="ack",
            outcome="discovery_fresh",
            detail="recipe and cache verified",
            stamp=3_000,
        )
        final_path = Path(result["path"])
        self.assertEqual(result["action"], "ack")
        self.assertTrue(final_path.exists())
        self.assertFalse(Path(lease["leasePath"]).exists())
        self.assertEqual(json.loads(final_path.read_text())["state"], "acknowledged")
        self.assertIsNone(claim_task(self.root, owner="other", stamp=50_000))

    def test_prelease_duplicate_resolution_has_a_terminal_receipt(self) -> None:
        enqueue_task(
            self.root,
            {"kind": "discovery", "pkg": "example.app", "name": "Example", "source": "example"},
            task_id="example",
            stamp=1_000,
        )
        result = acknowledge_queued_task(
            self.root,
            "example",
            outcome="announcement_already_handled",
            detail="duplicate card",
            stamp=2_000,
        )
        self.assertEqual(result["action"], "ack")
        self.assertFalse((self.root / "example.json").exists())
        final = json.loads(Path(result["path"]).read_text())
        self.assertEqual(final["outcome"], "announcement_already_handled")

    def test_retry_has_bounded_backoff_then_quarantines(self) -> None:
        enqueue_task(
            self.root,
            {
                "kind": "research",
                "pkg": "example.research",
                "installedDaysAgo": 0,
                "maxAttempts": 2,
            },
            task_id="research-example",
            stamp=1_000,
        )
        first = claim_task(self.root, owner="one", stamp=1_000)
        retried = finish_task(
            self.root,
            first["leasePath"],
            result="retry",
            outcome="infra_failure",
            stamp=2_000,
        )
        self.assertEqual(retried["action"], "retry")
        self.assertEqual(retried["notBeforeMs"], 2_000 + BASE_BACKOFF_MS)
        self.assertIsNone(claim_task(self.root, owner="too-early", stamp=2_001))
        second = claim_task(
            self.root,
            owner="two",
            stamp=2_000 + BASE_BACKOFF_MS,
        )
        quarantined = finish_task(
            self.root,
            second["leasePath"],
            result="retry",
            outcome="infra_failure",
            stamp=3_000 + BASE_BACKOFF_MS,
        )
        self.assertEqual(quarantined["action"], "quarantine")
        self.assertEqual(json.loads(Path(quarantined["path"]).read_text())["state"], "quarantined")

    def test_expired_lease_requeues_instead_of_disappearing(self) -> None:
        enqueue_task(
            self.root,
            {"kind": "discovery", "pkg": "example.app", "name": "Example", "source": "example"},
            task_id="example",
            stamp=1_000,
        )
        lease = claim_task(self.root, owner="crashed", stamp=1_000, lease_ms=1_000)
        self.assertTrue(Path(lease["leasePath"]).exists())
        self.assertIsNone(claim_task(self.root, owner="recover", stamp=2_001))
        queued = json.loads((self.root / "example.json").read_text())
        self.assertEqual(queued["state"], "queued")
        self.assertEqual(queued["lastOutcome"], "lease_expired")
        recovered = claim_task(
            self.root,
            owner="recover",
            stamp=queued["notBeforeMs"],
        )
        self.assertEqual(recovered["attempt"], 2)

    def test_crash_between_retry_write_and_lease_cleanup_cannot_double_claim(self) -> None:
        enqueue_task(
            self.root,
            {"kind": "discovery", "pkg": "example.app", "name": "Example", "source": "example"},
            task_id="example",
            stamp=1_000,
        )
        lease = claim_task(self.root, owner="live-worker", stamp=1_000, lease_ms=10_000)
        # Model the only duplicate window: retry replacement is durable but power stops before
        # the old lease is unlinked.
        replacement = dict(lease)
        replacement.pop("leasePath", None)
        replacement.pop("lease", None)
        replacement["state"] = "queued"
        replacement["notBeforeMs"] = 2_000
        (self.root / "example.json").write_text(json.dumps(replacement))
        self.assertIsNone(claim_task(self.root, owner="duplicate", stamp=2_000))
        self.assertTrue(Path(lease["leasePath"]).exists())

    def test_nightly_task_is_written_before_due_and_claimable_after_due(self) -> None:
        zone = dt.datetime.now().astimezone().tzinfo
        service_date = dt.date(2035, 5, 7)
        before_due = dt.datetime.combine(service_date, dt.time(1, 0), tzinfo=zone)
        after_due = dt.datetime.combine(service_date, dt.time(4, 0), tzinfo=zone)
        ensured = ensure_nightly_task(
            self.root,
            task="dream",
            hour=3,
            stamp=int(before_due.timestamp() * 1000),
        )
        self.assertTrue(Path(ensured["path"]).exists())
        self.assertIsNone(
            claim_task(
                self.root,
                owner="scheduler",
                kind="dream",
                stamp=int(before_due.timestamp() * 1000),
            )
        )
        lease = claim_task(
            self.root,
            owner="scheduler",
            kind="dream",
            stamp=int(after_due.timestamp() * 1000),
        )
        self.assertEqual(lease["serviceDate"], service_date.isoformat())


class InstagramGeometryTests(unittest.TestCase):
    def test_geometry_scales_with_the_captured_display(self) -> None:
        small = derive_instagram_geometry(1080, 2400, (720, 410, 1080, 500))
        large = derive_instagram_geometry(1440, 3120, (960, 520, 1440, 640))
        self.assertEqual(small["firstTile"], (180, 680))
        self.assertEqual(large["firstTile"], (240, 880))
        self.assertNotEqual(small["nextPostSwipe"], large["nextPostSwipe"])

    def test_implausible_tab_anchor_refuses_a_blind_tap(self) -> None:
        self.assertIsNone(derive_instagram_geometry(1080, 2400, (0, 2300, 360, 2390)))
        self.assertIsNone(derive_instagram_geometry(1080, 2400, (-1, 100, 360, 200)))

    def test_png_dimensions_reads_the_live_capture_header(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "capture.png"
            # Only the signature and IHDR header are needed by png_dimensions.
            path.write_bytes(
                PNG_SIGNATURE
                + struct.pack(">I", 13)
                + b"IHDR"
                + struct.pack(">II", 1344, 2992)
            )
            self.assertEqual(png_dimensions(path), (1344, 2992))
            path.write_bytes(b"not a png")
            self.assertIsNone(png_dimensions(path))


class InterestOutcomeTests(unittest.TestCase):
    def test_cache_failure_revokes_every_cadence_stamp(self) -> None:
        outcomes = classify_interest_outcomes(
            {
                "with-event": {
                    "interestId": "with-event",
                    "evidenceCount": 2,
                    "anomalies": [],
                    "errors": [],
                },
                "proved-empty": {
                    "interestId": "proved-empty",
                    "evidenceCount": 1,
                    "anomalies": [],
                    "errors": [],
                },
            },
            {"with-event": 1, "proved-empty": 0},
            extraction_ok=True,
            extraction_error="",
        )
        self.assertEqual([row["outcome"] for row in outcomes], ["fresh", "empty"])
        completed = apply_submit_result(
            outcomes,
            submit_persisted=False,
            submit_error="cache_submit_failed:RuntimeError",
        )
        self.assertEqual(completed, set())
        self.assertTrue(all(row["outcome"] == "cache_submit_failure" for row in outcomes))

    def test_geometry_anomaly_is_not_misreported_as_proven_empty(self) -> None:
        outcomes = classify_interest_outcomes(
            {
                "geometry-miss": {
                    "interestId": "geometry-miss",
                    "evidenceCount": 1,
                    "anomalies": ["instagram_grid_geometry_unavailable"],
                    "errors": [],
                }
            },
            {"geometry-miss": 0},
            extraction_ok=True,
            extraction_error="",
        )
        self.assertEqual(outcomes[0]["state"], "failed")
        self.assertEqual(outcomes[0]["outcome"], "mechanics_failure")
        self.assertEqual(
            apply_submit_result(outcomes, submit_persisted=True, submit_error=""),
            set(),
        )

    def test_partial_source_failure_is_not_misreported_as_empty(self) -> None:
        outcomes = classify_interest_outcomes(
            {
                "partial": {
                    "interestId": "partial",
                    "evidenceCount": 1,
                    "anomalies": [],
                    "errors": ["calendar_fetch_failed:TimeoutError"],
                }
            },
            {"partial": 0},
            extraction_ok=True,
            extraction_error="",
        )
        self.assertEqual(outcomes[0]["state"], "failed")
        self.assertNotEqual(outcomes[0]["outcome"], "empty")


if __name__ == "__main__":
    unittest.main()
