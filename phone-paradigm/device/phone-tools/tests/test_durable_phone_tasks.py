#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import os
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))

from durable_task_queue import (  # noqa: E402
    BASE_BACKOFF_MS,
    TaskQueueError,
    acknowledge_queued_task,
    claim_task,
    enqueue_task,
    ensure_nightly_task,
    finish_task,
    mark_discovery_reconciliation_only,
    mark_provider_launch_spent,
)
from interest_browse_runtime import (  # noqa: E402
    PNG_SIGNATURE,
    apply_submit_result,
    classify_interest_outcomes,
    derive_instagram_geometry,
    png_dimensions,
)
from private_artifact import (  # noqa: E402
    MAX_PRIVATE_ARTIFACT_BYTES,
    MAX_PREFERENCE_COMPACTION_SOURCE_BYTES,
    PREFERENCE_COMPACTED_TARGET_BYTES,
    artifact_identity,
    artifact_was_atomically_rewritten,
    atomic_rewrite_private_artifact,
    main as private_artifact_main,
    preference_insights_valid,
    source_cadence_valid,
)
from scheduler_timing import (  # noqa: E402
    advance_cycle_stamp,
    bind_curation_attempt_generation,
    bind_curation_attempt_task,
    clear_curation_attempt,
    clear_cycle_failure_backoff,
    clear_failed_curation_generation,
    clear_source_failure_backoff,
    compare_curation_generation,
    compare_failed_curation_generation,
    compute_curation_input_generation,
    cycle_failure_remaining_seconds,
    ensure_curation_attempt,
    ensure_watchdog_completion_reference,
    initial_floor_remaining_seconds,
    nightly_task_admission,
    normalize_scheduler_bounds,
    publish_curation_generation,
    record_cycle_failure,
    record_failed_curation_generation,
    record_source_failure_backoff,
    source_failure_admission,
    watchdog_completion_reference_overdue,
)
import source_cadence  # noqa: E402
from source_cadence import (  # noqa: E402
    SOURCE_DUE_SIGNAL_MARKER,
    SOURCE_DUE_SIGNAL_PENDING_MODE,
    acknowledge_browse_success,
    cadence_decision,
)
import public_http  # noqa: E402
from public_http import (  # noqa: E402
    PublicHttpLimitError,
    UnsafePublicUrlError,
    fetch_public_text,
)

HN_FETCH_SPEC = importlib.util.spec_from_file_location("phone_hn_fetch", TOOLS / "hn-fetch.py")
if HN_FETCH_SPEC is None or HN_FETCH_SPEC.loader is None:
    raise RuntimeError("Could not load hn-fetch.py for tests")
hn_fetch = importlib.util.module_from_spec(HN_FETCH_SPEC)
HN_FETCH_SPEC.loader.exec_module(hn_fetch)


def dns_answer(address: str, port: int) -> tuple[object, ...]:
    if ":" in address:
        return (
            socket.AF_INET6,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            (address, port, 0, 0),
        )
    return (
        socket.AF_INET,
        socket.SOCK_STREAM,
        socket.IPPROTO_TCP,
        "",
        (address, port),
    )


class FakeHttpResponse:
    def __init__(
        self,
        status: int,
        body: bytes = b"",
        headers: dict[str, str] | None = None,
    ):
        self.status = status
        self.body = body
        self.headers = headers or {}

    def getheader(self, name: str):
        return self.headers.get(name)

    def read(self, limit: int):
        return self.body[:limit]


class FakeHttpConnection:
    def __init__(self, response: FakeHttpResponse):
        self.response = response
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.closed = False

    def request(self, method: str, target: str, *, headers: dict[str, str]):
        self.requests.append((method, target, headers))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


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

    def test_terminal_authority_suppresses_a_replayed_base_request(self) -> None:
        payload = {
            "kind": "discovery",
            "pkg": "example.app",
            "name": "Example",
            "source": "example",
        }
        enqueue_task(self.root, payload, task_id="example", stamp=1_000)
        lease = claim_task(self.root, owner="worker", stamp=2_000)
        finish_task(
            self.root,
            lease["leasePath"],
            result="ack",
            outcome="discovery_fresh",
            stamp=3_000,
        )

        # Model a journal replay of the base directory entry after the final receipt was
        # already durable. The scheduler must clean it, never lease it.
        replayed = self.root / "example.json"
        replayed.write_text(
            json.dumps({**payload, "taskId": "example"}) + "\n",
            encoding="utf-8",
        )
        self.assertIsNone(claim_task(self.root, owner="must-not-run", stamp=4_000))
        self.assertFalse(replayed.exists())

    def test_discovery_identity_is_validated_at_enqueue_and_claim(self) -> None:
        valid = {
            "kind": "discovery",
            "pkg": "com.example_reader.app",
            "name": "Example Reader",
            "source": "example-reader",
        }
        for field, invalid in (
            ("pkg", "../outside"),
            ("pkg", "com.example;input"),
            ("name", "Example\nInjected"),
            ("name", "x" * 121),
            ("source", "../outside"),
            ("source", "MixedCase"),
            ("source", "source_with_underscore"),
        ):
            payload = {**valid, field: invalid}
            with self.assertRaises(TaskQueueError):
                enqueue_task(
                    self.root,
                    payload,
                    task_id=f"invalid-{field}",
                    stamp=1_000,
                )

        # Legacy/on-disk records are revalidated at claim, not trusted merely because they
        # bypassed the modern enqueue helper.
        self.root.mkdir(parents=True, exist_ok=True)
        unsafe_path = self.root / "legacy-invalid.json"
        unsafe_path.write_text(
            json.dumps({**valid, "source": "../../outside"}) + "\n",
            encoding="utf-8",
        )
        self.assertIsNone(claim_task(self.root, owner="claim-validator", stamp=2_000))
        quarantined = self.root / ".quarantine" / "legacy-invalid.json"
        self.assertTrue(quarantined.exists())
        self.assertEqual(
            json.loads(quarantined.read_text(encoding="utf-8"))["outcome"],
            "invalid_request",
        )

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

    def test_validated_discovery_reconciliation_survives_attempt_limit_and_expiry(
        self,
    ) -> None:
        enqueue_task(
            self.root,
            {
                "kind": "discovery",
                "pkg": "example.app",
                "name": "Example",
                "source": "example",
                "maxAttempts": 1,
            },
            task_id="example",
            stamp=1_000,
        )
        first = claim_task(
            self.root,
            owner="proof-worker",
            stamp=1_000,
            lease_ms=1_000,
        )
        marked = mark_discovery_reconciliation_only(
            self.root,
            first["leasePath"],
            stamp=1_500,
        )
        self.assertEqual(marked["action"], "marked")
        self.assertTrue(
            json.loads(Path(first["leasePath"]).read_text(encoding="utf-8"))[
                "reconciliationOnly"
            ]
        )

        # A generic failure path from an older worker is promoted to reconciliation
        # instead of quarantining at maxAttempts.
        reconciled = finish_task(
            self.root,
            first["leasePath"],
            result="retry",
            outcome="activation_pending",
            stamp=2_000,
        )
        self.assertEqual(reconciled["action"], "reconcile")
        self.assertTrue(reconciled["task"]["reconciliationOnly"])
        self.assertFalse((self.root / ".quarantine" / "example.json").exists())

        second = claim_task(
            self.root,
            owner="reconciliation-worker",
            stamp=reconciled["notBeforeMs"],
            lease_ms=1_000,
        )
        self.assertEqual(second["attempt"], 2)
        self.assertTrue(second["reconciliationOnly"])

        # A restart after that worker dies also preserves the proof-only state,
        # regardless of the already-exhausted attempt count.
        self.assertIsNone(
            claim_task(
                self.root,
                owner="expiry-recovery",
                stamp=second["lease"]["expiresAtMs"] + 1,
            )
        )
        queued = json.loads((self.root / "example.json").read_text(encoding="utf-8"))
        self.assertEqual(queued["lastOutcome"], "reconciliation_lease_expired")
        self.assertTrue(queued["reconciliationOnly"])
        self.assertFalse((self.root / ".quarantine" / "example.json").exists())
        third = claim_task(
            self.root,
            owner="final-reconciliation-worker",
            stamp=queued["notBeforeMs"],
        )
        self.assertEqual(third["attempt"], 3)
        self.assertTrue(third["reconciliationOnly"])

    def test_only_discovery_can_enter_reconciliation_only_state(self) -> None:
        enqueue_task(
            self.root,
            {
                "kind": "research",
                "pkg": "example.research",
                "installedDaysAgo": 0,
            },
            task_id="research-example",
            stamp=1_000,
        )
        lease = claim_task(self.root, owner="research-worker", stamp=1_000)
        with self.assertRaises(TaskQueueError):
            mark_discovery_reconciliation_only(
                self.root,
                lease["leasePath"],
                stamp=1_500,
            )

    def test_spent_overseer_lease_crash_quarantines_at_expiry(self) -> None:
        enqueue_task(
            self.root,
            {
                "kind": "oversee",
                "serviceDate": "2035-05-10",
                "notBeforeMs": 1_000,
                "maxAttempts": 6,
            },
            task_id="oversee-2035-05-10",
            stamp=1_000,
        )
        lease = claim_task(
            self.root,
            owner="scheduler-before-crash",
            kind="oversee",
            stamp=1_000,
            lease_ms=1_000,
        )
        marked = mark_provider_launch_spent(
            self.root,
            lease["leasePath"],
            stamp=1_500,
        )
        self.assertEqual(marked["action"], "marked")
        on_disk = json.loads(Path(lease["leasePath"]).read_text(encoding="utf-8"))
        self.assertEqual(
            on_disk["providerLaunchSpent"]["leaseId"],
            on_disk["lease"]["id"],
        )
        self.assertEqual(Path(lease["leasePath"]).stat().st_mode & 0o777, 0o600)

        # No finish transition models SIGKILL/power loss after the durable cost
        # linearization point. Expiry recovery must not produce a second lease.
        self.assertIsNone(
            claim_task(
                self.root,
                owner="scheduler-after-restart",
                kind="oversee",
                stamp=2_001,
            )
        )
        quarantine = self.root / ".quarantine" / "oversee-2035-05-10.json"
        recovered = json.loads(quarantine.read_text(encoding="utf-8"))
        self.assertEqual(recovered["state"], "quarantined")
        self.assertEqual(
            recovered["outcome"],
            "provider_launch_spent_lease_expired",
        )
        self.assertFalse(Path(lease["leasePath"]).exists())
        self.assertFalse((self.root / "oversee-2035-05-10.json").exists())

    def test_provider_spend_guard_survives_real_cli_process_restart(self) -> None:
        tool = TOOLS / "durable_task_queue.py"

        def invoke(*arguments: str) -> dict[str, object]:
            result = subprocess.run(
                [sys.executable, str(tool), *arguments],
                cwd=TOOLS,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

        invoke(
            "enqueue",
            "--root",
            str(self.root),
            "--kind",
            "oversee",
            "--task-id",
            "oversee-2035-05-11",
            "--service-date",
            "2035-05-11",
            "--not-before-ms",
            "1000",
            "--now-ms",
            "1000",
        )
        lease = invoke(
            "claim",
            "--root",
            str(self.root),
            "--kind",
            "oversee",
            "--owner",
            "first-process",
            "--lease-ms",
            "1000",
            "--now-ms",
            "1000",
        )
        first_mark = invoke(
            "mark-provider-launch-spent",
            "--root",
            str(self.root),
            "--lease",
            str(lease["leasePath"]),
            "--now-ms",
            "1500",
        )
        self.assertEqual(first_mark["action"], "marked")
        second_mark = invoke(
            "mark-provider-launch-spent",
            "--root",
            str(self.root),
            "--lease",
            str(lease["leasePath"]),
            "--now-ms",
            "1600",
        )
        self.assertEqual(second_mark["action"], "already_spent")

        # The marking process is gone and no provider result was recorded.
        # A fresh process performs the expiry scan and returns no launchable task.
        recovered = invoke(
            "claim",
            "--root",
            str(self.root),
            "--kind",
            "oversee",
            "--owner",
            "fresh-process",
            "--now-ms",
            "2001",
        )
        self.assertEqual(recovered, {})
        self.assertTrue(
            (self.root / ".quarantine" / "oversee-2035-05-11.json").is_file()
        )

    def test_retry_is_refused_after_overseer_provider_spend(self) -> None:
        enqueue_task(
            self.root,
            {
                "kind": "oversee",
                "serviceDate": "2035-05-12",
                "notBeforeMs": 1_000,
            },
            task_id="oversee-2035-05-12",
            stamp=1_000,
        )
        lease = claim_task(
            self.root,
            owner="scheduler",
            kind="oversee",
            stamp=1_000,
        )
        mark_provider_launch_spent(self.root, lease["leasePath"], stamp=1_001)
        result = finish_task(
            self.root,
            lease["leasePath"],
            result="retry",
            outcome="provider_transport_failed",
            stamp=1_002,
        )
        self.assertEqual(result["action"], "quarantine")
        self.assertEqual(
            result["task"]["outcome"],
            "provider_launch_already_spent",
        )

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
            task="oversee",
            hour=3,
            stamp=int(before_due.timestamp() * 1000),
        )
        self.assertTrue(Path(ensured["path"]).exists())
        self.assertIsNone(
            claim_task(
                self.root,
                owner="scheduler",
                kind="oversee",
                stamp=int(before_due.timestamp() * 1000),
            )
        )
        lease = claim_task(
            self.root,
            owner="scheduler",
            kind="oversee",
            stamp=int(after_due.timestamp() * 1000),
        )
        self.assertEqual(lease["serviceDate"], service_date.isoformat())

    def test_overseer_has_one_idempotent_daily_receipt(self) -> None:
        zone = dt.datetime.now().astimezone().tzinfo
        service_date = dt.date(2035, 5, 8)
        after_due = dt.datetime.combine(service_date, dt.time(4, 0), tzinfo=zone)
        stamp = int(after_due.timestamp() * 1000)
        first = ensure_nightly_task(self.root, task="oversee", hour=3, stamp=stamp)
        second = ensure_nightly_task(self.root, task="oversee", hour=3, stamp=stamp)
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])

        lease = claim_task(self.root, owner="scheduler", kind="oversee", stamp=stamp)
        self.assertEqual(lease["taskId"], f"oversee-{service_date.isoformat()}")
        finish_task(
            self.root,
            lease["leasePath"],
            result="ack",
            outcome="overseer_completed",
            stamp=stamp + 1,
        )
        ensure_nightly_task(self.root, task="oversee", hour=3, stamp=stamp + 2)
        self.assertIsNone(
            claim_task(self.root, owner="scheduler", kind="oversee", stamp=stamp + 2)
        )

    def test_legacy_reflection_stamp_prevents_a_duplicate_migration_day_review(self) -> None:
        zone = dt.datetime.now().astimezone().tzinfo
        service_date = dt.date(2035, 5, 9)
        due = dt.datetime.combine(service_date, dt.time(3, 0), tzinfo=zone)
        completed = dt.datetime.combine(service_date, dt.time(3, 30), tzinfo=zone)
        stamp = int(completed.timestamp() * 1000)
        legacy = Path(self.temporary.name) / "last-reflect"
        legacy.write_text(str(int(completed.timestamp())), encoding="utf-8")

        ensured = ensure_nightly_task(
            self.root,
            task="oversee",
            hour=3,
            stamp=stamp,
            legacy_stamp=[Path(self.temporary.name) / "missing", legacy],
        )
        self.assertFalse(ensured["created"])
        self.assertEqual(ensured["dueAtMs"], int(due.timestamp() * 1000))
        final = self.root / ".receipts" / f"oversee-{service_date.isoformat()}-final.json"
        self.assertEqual(
            json.loads(final.read_text(encoding="utf-8"))["outcome"],
            "legacy_completion_migrated",
        )


class SourceCadenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.live = self.root / "source-cadence.json"
        self.defaults = self.root / "source-cadence.default.json"
        self.stamp = self.root / "last-browse"
        self.signal_ack = self.root / "last-source-signal-ack"
        self.signal_directory = self.root / "source-due-signals"
        self.signal_directory.mkdir(mode=0o700)
        self.signal = self.signal_directory / "reddit.due"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_json(self, path: Path, value: object) -> None:
        path.write_text(json.dumps(value), encoding="utf-8")

    def write_signal(self, timestamp: float, marker: bytes = SOURCE_DUE_SIGNAL_MARKER) -> None:
        self.signal.write_bytes(marker)
        self.signal.chmod(0o600)
        timestamp_ns = int(timestamp * 1_000_000_000)
        os.utime(self.signal, ns=(timestamp_ns, timestamp_ns))

    def publish_pending_signal(self) -> tuple[int, int]:
        pending = self.signal_directory / ".reddit.due.pending"
        pending.write_bytes(SOURCE_DUE_SIGNAL_MARKER)
        pending.chmod(SOURCE_DUE_SIGNAL_PENDING_MODE)
        browse_started_ns = time.time_ns()
        os.replace(pending, self.signal)
        generation_ns = self.signal.stat().st_ctime_ns
        self.assertGreaterEqual(generation_ns, browse_started_ns)
        return browse_started_ns, generation_ns

    def test_fractional_hours_are_due_by_elapsed_seconds_without_shell_math(self) -> None:
        self.write_json(self.live, {"twitter": {"cadenceHours": 1.5}})
        self.stamp.touch()
        os.utime(self.stamp, (1_000, 1_000))
        before = cadence_decision(
            "twitter",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            now_seconds=1_000 + 89 * 60,
        )
        due = cadence_decision(
            "twitter",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            now_seconds=1_000 + 90 * 60,
        )
        self.assertFalse(before["due"])
        self.assertTrue(due["due"])
        self.assertEqual(due["hours"], 1.5)

    def test_missing_live_entry_and_invalid_value_use_nonzero_defaults(self) -> None:
        self.write_json(self.defaults, {
            "hackernews": {"cadenceHours": 2.25},
            "twitter": {"cadenceHours": 3.5},
        })
        self.write_json(self.live, {"twitter": {"cadenceHours": -1}})
        self.stamp.touch()
        os.utime(self.stamp, (10_000, 10_000))
        inherited = cadence_decision(
            "hackernews",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            now_seconds=10_000 + 60,
        )
        invalid = cadence_decision(
            "twitter",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            now_seconds=10_000 + 60,
        )
        self.assertFalse(inherited["due"])
        self.assertEqual(inherited["hours"], 2.25)
        self.assertFalse(invalid["due"])
        self.assertEqual(invalid["hours"], 3.5)
        self.assertEqual(invalid["reason"], "within_cadence")

    def test_broken_or_zero_configuration_uses_conservative_nonzero_fallback(self) -> None:
        self.write_json(self.defaults, {"twitter": {"cadenceHours": 0}})
        self.write_json(self.live, {"twitter": {"cadenceHours": 0}})
        self.stamp.touch()
        os.utime(self.stamp, (10_000, 10_000))
        decision = cadence_decision(
            "twitter",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            now_seconds=10_000 + 60,
        )
        self.assertFalse(decision["due"])
        self.assertEqual(decision["hours"], 6)
        self.assertEqual(decision["reason"], "within_cadence")

    def test_out_of_range_configuration_cannot_suppress_or_flood_a_source(self) -> None:
        for live_hours, default_hours in ((0.24, 4), (169, 4), (0.24, 169)):
            with self.subTest(live_hours=live_hours, default_hours=default_hours):
                self.write_json(
                    self.defaults,
                    {"twitter": {"cadenceHours": default_hours}},
                )
                self.write_json(
                    self.live,
                    {"twitter": {"cadenceHours": live_hours}},
                )
                self.stamp.touch()
                os.utime(self.stamp, (10_000, 10_000))
                decision = cadence_decision(
                    "twitter",
                    stamp_path=self.stamp,
                    live_path=self.live,
                    default_path=self.defaults,
                    now_seconds=10_000 + 60,
                )
                self.assertFalse(decision["due"])
                self.assertEqual(
                    decision["hours"],
                    4 if default_hours == 4 else 6,
                )

    def test_success_acknowledges_only_the_generation_covered_at_browse_start(self) -> None:
        self.write_json(self.live, {"reddit": {"cadenceHours": 24}})
        self.stamp.touch()
        os.utime(self.stamp, (10_000, 10_000))
        self.write_signal(10_001)

        signaled = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=10_002,
        )
        self.assertTrue(signaled["due"])
        self.assertEqual(signaled["reason"], "source_signal")
        self.assertEqual(signaled["signalState"], "signal_unacknowledged")

        browse_started_ns = 10_002 * 1_000_000_000
        # This notification lands after retrieval starts but before successful
        # post-processing would formerly have touched the completion stamp.
        self.write_signal(10_003)
        with patch("source_cadence.time.time_ns", return_value=10_004 * 1_000_000_000):
            acknowledge_browse_success(
                self.stamp,
                self.signal_ack,
                browse_started_ns,
            )
        still_due = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=10_005,
        )
        self.assertTrue(still_due["due"])
        self.assertEqual(still_due["reason"], "source_signal")
        self.assertEqual(self.stamp.stat().st_mtime_ns, 10_004 * 1_000_000_000)
        self.assertEqual(self.signal_ack.stat().st_mtime_ns, browse_started_ns)

        next_browse_started_ns = 10_006 * 1_000_000_000
        with patch("source_cadence.time.time_ns", return_value=10_007 * 1_000_000_000):
            acknowledge_browse_success(
                self.stamp,
                self.signal_ack,
                next_browse_started_ns,
            )
        acknowledged = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=10_008,
        )
        self.assertFalse(acknowledged["due"])
        self.assertLess(acknowledged["ageSeconds"], 2)
        self.assertEqual(acknowledged["signalState"], "signal_obsolete")
        self.assertTrue(self.signal.exists())

    def test_pending_publication_uses_final_rename_generation_at_the_browse_boundary(self) -> None:
        self.write_json(self.live, {"reddit": {"cadenceHours": 24}})
        self.stamp.touch()
        self.stamp.chmod(0o600)
        browse_started_ns, publication_generation_ns = self.publish_pending_signal()
        self.signal_ack.touch()
        self.signal_ack.chmod(0o600)
        os.utime(
            self.signal_ack,
            ns=(browse_started_ns, browse_started_ns),
        )
        now_seconds = max(
            time.time(),
            publication_generation_ns / 1_000_000_000 + 0.001,
        )

        raced = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=now_seconds,
        )
        self.assertTrue(raced["due"])
        self.assertEqual(raced["reason"], "source_signal")
        self.assertEqual(raced["signalState"], "signal_publication_pending")

        next_browse_started_ns = max(
            time.time_ns(),
            publication_generation_ns + 1,
        )
        with patch(
            "source_cadence.time.time_ns",
            return_value=next_browse_started_ns + 1_000_000,
        ):
            acknowledge_browse_success(
                self.stamp,
                self.signal_ack,
                next_browse_started_ns,
            )
        covered = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=(next_browse_started_ns + 2_000_000) / 1_000_000_000,
        )
        self.assertFalse(covered["due"])
        self.assertEqual(covered["signalState"], "signal_obsolete")

    def test_completion_is_published_before_ack_and_missing_ack_is_migration_safe(self) -> None:
        self.write_json(self.live, {"reddit": {"cadenceHours": 24}})
        self.stamp.touch()
        os.utime(self.stamp, (15_000, 15_000))
        self.write_signal(15_001)
        original_write = source_cadence._write_private_stamp
        writes: list[Path] = []

        def fail_ack(path: Path, timestamp_ns: int) -> None:
            writes.append(path)
            if len(writes) == 2:
                raise OSError("simulated ack failure")
            original_write(path, timestamp_ns)

        with (
            patch("source_cadence.time.time_ns", return_value=15_004 * 1_000_000_000),
            patch("source_cadence._write_private_stamp", side_effect=fail_ack),
            self.assertRaises(OSError),
        ):
            acknowledge_browse_success(
                self.stamp,
                self.signal_ack,
                15_002 * 1_000_000_000,
            )
        self.assertEqual(writes, [self.stamp, self.signal_ack])
        self.assertEqual(self.stamp.stat().st_mtime_ns, 15_004 * 1_000_000_000)
        self.assertFalse(self.signal_ack.exists())

        # A deployment upgraded with a signal but no acknowledgement, or a
        # crash between the two writes above, conservatively browses once.
        unacknowledged = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=15_005,
        )
        self.assertTrue(unacknowledged["due"])
        self.assertEqual(unacknowledged["signalState"], "signal_unacknowledged")

    def test_invalid_or_future_signal_ack_cannot_suppress_a_valid_marker(self) -> None:
        self.write_json(self.live, {"reddit": {"cadenceHours": 24}})
        self.stamp.touch()
        os.utime(self.stamp, (17_000, 17_000))
        self.write_signal(17_001)
        self.signal_ack.touch()
        self.signal_ack.chmod(0o644)
        os.utime(self.signal_ack, (17_002, 17_002))

        public_ack = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=17_003,
        )
        self.assertTrue(public_ack["due"])
        self.assertEqual(public_ack["signalState"], "signal_unacknowledged")

        self.signal_ack.chmod(0o600)
        os.utime(self.signal_ack, (18_000, 18_000))
        future_ack = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=17_004,
        )
        self.assertTrue(future_ack["due"])
        self.assertEqual(future_ack["signalState"], "signal_unacknowledged")

        self.signal_ack.unlink()
        ack_target = self.root / "ack-target"
        ack_target.touch()
        ack_target.chmod(0o600)
        os.utime(ack_target, (17_002, 17_002))
        self.signal_ack.symlink_to(ack_target)
        symlink_ack = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=17_005,
        )
        self.assertTrue(symlink_ack["due"])
        self.assertEqual(symlink_ack["signalState"], "signal_unacknowledged")

        self.signal_ack.unlink()
        os.link(ack_target, self.signal_ack)
        hardlink_ack = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=17_006,
        )
        self.assertTrue(hardlink_ack["due"])
        self.assertEqual(hardlink_ack["signalState"], "signal_unacknowledged")

    def test_ack_within_marker_skew_window_is_still_strictly_future_and_invalid(self) -> None:
        self.write_json(self.live, {"reddit": {"cadenceHours": 24}})
        self.stamp.touch()
        os.utime(self.stamp, (1_000, 1_000))
        self.write_signal(1_060)
        self.signal_ack.touch()
        self.signal_ack.chmod(0o600)
        os.utime(self.signal_ack, (1_120, 1_120))

        decision = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=1_061,
        )
        self.assertTrue(decision["due"])
        self.assertEqual(decision["reason"], "source_signal")
        self.assertEqual(decision["signalState"], "signal_unacknowledged")

        with (
            patch("source_cadence.time.time_ns", return_value=1_000 * 1_000_000_000),
            self.assertRaises(ValueError),
        ):
            acknowledge_browse_success(
                self.stamp,
                self.signal_ack,
                1_001 * 1_000_000_000,
            )

    def test_signal_with_arbitrary_content_or_public_file_permissions_is_ignored(self) -> None:
        self.write_json(self.live, {"reddit": {"cadenceHours": 24}})
        self.stamp.touch()
        os.utime(self.stamp, (20_000, 20_000))
        self.write_signal(20_001, b"PRIVATE notification text must never be a signal\n")

        arbitrary_content = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=20_002,
        )
        self.assertFalse(arbitrary_content["due"])
        self.assertEqual(arbitrary_content["signalState"], "signal_invalid")

        self.write_signal(20_003)
        self.signal.chmod(0o644)
        public_marker = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=20_004,
        )
        self.assertFalse(public_marker["due"])
        self.assertEqual(public_marker["signalState"], "signal_invalid")

    def test_signal_requires_exact_private_real_parent_and_final_file(self) -> None:
        self.write_json(self.live, {"reddit": {"cadenceHours": 24}})
        self.stamp.touch()
        os.utime(self.stamp, (30_000, 30_000))
        self.write_signal(30_001)

        self.signal_directory.chmod(0o755)
        public_parent = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=30_002,
        )
        self.assertFalse(public_parent["due"])
        self.assertEqual(public_parent["signalState"], "signal_invalid")

        self.signal_directory.chmod(0o700)
        self.signal.unlink()
        target = self.root / "marker-target"
        target.write_bytes(SOURCE_DUE_SIGNAL_MARKER)
        target.chmod(0o600)
        self.signal.symlink_to(target)
        symlink_file = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=30_003,
        )
        self.assertFalse(symlink_file["due"])
        self.assertEqual(symlink_file["signalState"], "signal_invalid")

        self.signal.unlink()
        self.write_signal(30_004)
        hardlink = self.root / "marker-hardlink"
        os.link(self.signal, hardlink)
        hardlinked_file = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=30_005,
        )
        self.assertFalse(hardlinked_file["due"])
        self.assertEqual(hardlinked_file["signalState"], "signal_invalid")

        hardlink.unlink()
        with patch("source_cadence.os.getuid", return_value=os.getuid() + 1):
            wrong_owner = cadence_decision(
                "reddit",
                stamp_path=self.stamp,
                live_path=self.live,
                default_path=self.defaults,
                signal_path=self.signal,
                signal_ack_path=self.signal_ack,
                now_seconds=30_006,
            )
        self.assertFalse(wrong_owner["due"])
        self.assertEqual(wrong_owner["signalState"], "signal_invalid")

        wrong_name = self.signal_directory / "other.due"
        self.signal.rename(wrong_name)
        wrong_final = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=wrong_name,
            signal_ack_path=self.signal_ack,
            now_seconds=30_007,
        )
        self.assertFalse(wrong_final["due"])
        self.assertEqual(wrong_final["signalState"], "signal_invalid")

    def test_symlink_parent_and_far_future_marker_are_selectively_ignored(self) -> None:
        self.write_json(self.live, {"reddit": {"cadenceHours": 24}})
        self.stamp.touch()
        os.utime(self.stamp, (40_000, 40_000))
        self.write_signal(40_001)

        real_directory = self.root / "real-source-due-signals"
        self.signal_directory.rename(real_directory)
        self.signal_directory.symlink_to(real_directory, target_is_directory=True)
        symlink_parent = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=40_002,
        )
        self.assertFalse(symlink_parent["due"])
        self.assertEqual(symlink_parent["signalState"], "signal_invalid")

        self.signal_directory.unlink()
        real_directory.rename(self.signal_directory)
        self.write_signal(40_000 + 60 * 60)
        future_marker = cadence_decision(
            "reddit",
            stamp_path=self.stamp,
            live_path=self.live,
            default_path=self.defaults,
            signal_path=self.signal,
            signal_ack_path=self.signal_ack,
            now_seconds=40_003,
        )
        self.assertFalse(future_marker["due"])
        self.assertEqual(future_marker["signalState"], "signal_future_skew")


class SchedulerTimingTests(unittest.TestCase):
    def test_scheduler_bounds_normalize_operator_values_for_bash(self) -> None:
        self.assertEqual(normalize_scheduler_bounds("30.2", "90.1"), (31, 91))
        self.assertEqual(normalize_scheduler_bounds("nope", "NaN"), (120, 720))
        self.assertEqual(normalize_scheduler_bounds("0", "-4"), (120, 720))
        self.assertEqual(
            normalize_scheduler_bounds("10", "20", fixed_value="2.2"),
            (3, 3),
        )
        self.assertEqual(
            normalize_scheduler_bounds("600", "300"),
            (600, 600),
        )
        # A malformed legacy fixed override is ignored rather than poisoning valid bounds.
        self.assertEqual(
            normalize_scheduler_bounds("45", "180", fixed_value="invalid"),
            (45, 180),
        )

    def test_curation_attempt_identity_and_generation_survive_restarts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / ".pending-curation-attempt.json"
            first_id = "phone-curation-11111111-1111-4111-8111-111111111111"
            other_id = "phone-curation-22222222-2222-4222-8222-222222222222"
            generation = "curation-input-v1:" + ("a" * 64)

            first = ensure_curation_attempt(
                state_path,
                candidate_cycle_id=first_id,
                now_seconds=10_000,
            )
            restarted = subprocess.run(
                [
                    sys.executable,
                    str(TOOLS / "scheduler_timing.py"),
                    "--curation-attempt-state",
                    str(state_path),
                    "--curation-attempt-action",
                    "ensure",
                    "--curation-attempt-cycle-id",
                    other_id,
                    "--now-seconds",
                    "20000",
                ],
                cwd=TOOLS,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(restarted.returncode, 0, restarted.stderr)
            retained_id, _, = (restarted.stdout.rstrip("\n") + "\t").split("\t")[:2]
            self.assertEqual(first["cycleId"], first_id)
            self.assertEqual(retained_id, first_id)
            self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)

            bound = bind_curation_attempt_generation(
                state_path,
                expected_cycle_id=first_id,
                generation=generation,
                now_seconds=10_001,
            )
            self.assertEqual(bound["editorialGeneration"], generation)
            task_bound = bind_curation_attempt_task(
                state_path,
                expected_cycle_id=first_id,
                task_request_id="chat-queue-33333333-3333-4333-8333-333333333333",
                now_seconds=10_002,
            )
            self.assertEqual(
                task_bound["taskRequestId"],
                "chat-queue-33333333-3333-4333-8333-333333333333",
            )
            with self.assertRaises(ValueError):
                bind_curation_attempt_task(
                    state_path,
                    expected_cycle_id=first_id,
                    task_request_id="chat-queue-44444444-4444-4444-8444-444444444444",
                    now_seconds=10_003,
                )
            with self.assertRaises(ValueError):
                clear_curation_attempt(
                    state_path,
                    expected_cycle_id=other_id,
                )
            self.assertTrue(state_path.exists())
            clear_curation_attempt(
                state_path,
                expected_cycle_id=first_id,
            )
            self.assertFalse(state_path.exists())

    def test_terminal_curation_failure_latches_only_its_exact_input_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / ".last-failed-curation-input-generation.json"
            failed_generation = "curation-input-v1:" + ("a" * 64)
            changed_generation = "curation-input-v1:" + ("b" * 64)

            self.assertEqual(
                compare_failed_curation_generation(state_path, failed_generation),
                "missing",
            )
            record_failed_curation_generation(
                state_path,
                failed_generation,
                "cancelled",
                now_seconds=10_000,
            )
            self.assertEqual(
                compare_failed_curation_generation(state_path, failed_generation),
                "failed_unchanged",
            )
            self.assertEqual(
                compare_failed_curation_generation(state_path, changed_generation),
                "changed",
            )
            self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
            state_text = state_path.read_text(encoding="utf-8")
            self.assertIn('"terminalStatus":"cancelled"', state_text)
            self.assertNotIn("editorial content", state_text)
            with self.assertRaises(ValueError):
                record_failed_curation_generation(
                    state_path,
                    failed_generation,
                    "pending",
                    now_seconds=10_001,
                )
            clear_failed_curation_generation(state_path)
            self.assertFalse(state_path.exists())

    def test_source_failure_backoff_is_distinct_and_new_signals_override_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_root = root / ".source-failure-backoff"
            state_path = state_root / "youtube.json"
            signal_root = root / "source-due-signals"
            signal_root.mkdir(mode=0o700)
            signal_path = signal_root / "youtube.due"
            signal_path.write_bytes(SOURCE_DUE_SIGNAL_MARKER)
            signal_path.chmod(0o600)
            os.utime(signal_path, ns=(98_000_000_000, 98_000_000_000))

            first = record_source_failure_backoff(
                state_path,
                "youtube",
                attempt_started_ns=99_000_000_000,
                now_seconds=100,
                base_seconds=10,
                max_seconds=60,
            )
            self.assertEqual(first["delaySeconds"], 10)
            self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(state_root.stat().st_mode & 0o777, 0o700)
            self.assertEqual(
                source_failure_admission(
                    state_path,
                    "youtube",
                    signal_path=signal_path,
                    now_seconds=105,
                    base_seconds=10,
                    max_seconds=60,
                ),
                ("backoff", 5),
            )

            # A source-specific marker published after the failed attempt is an exact,
            # one-attempt override. The marker stays unacknowledged until real success.
            os.utime(signal_path, ns=(106_000_000_000, 106_000_000_000))
            self.assertEqual(
                source_failure_admission(
                    state_path,
                    "youtube",
                    signal_path=signal_path,
                    now_seconds=105,
                    base_seconds=10,
                    max_seconds=60,
                ),
                ("backoff", 5),
            )
            self.assertEqual(
                source_failure_admission(
                    state_path,
                    "youtube",
                    signal_path=signal_path,
                    now_seconds=107,
                    base_seconds=10,
                    max_seconds=60,
                ),
                ("source_signal_override", 0),
            )
            second = record_source_failure_backoff(
                state_path,
                "youtube",
                attempt_started_ns=108_000_000_000,
                now_seconds=109,
                base_seconds=10,
                max_seconds=60,
            )
            self.assertEqual(second["delaySeconds"], 20)
            self.assertEqual(
                source_failure_admission(
                    state_path,
                    "youtube",
                    signal_path=signal_path,
                    now_seconds=110,
                    base_seconds=10,
                    max_seconds=60,
                ),
                ("backoff", 19),
            )
            self.assertEqual(
                source_failure_admission(
                    state_path,
                    "youtube",
                    signal_path=signal_path,
                    manual_override=True,
                    now_seconds=110,
                    base_seconds=10,
                    max_seconds=60,
                ),
                ("manual_override", 0),
            )
            clear_source_failure_backoff(state_path, "youtube")
            self.assertEqual(
                source_failure_admission(
                    state_path,
                    "youtube",
                    signal_path=signal_path,
                    now_seconds=110,
                    base_seconds=10,
                    max_seconds=60,
                ),
                ("ready", 0),
            )
            state_path.write_text("{broken\n", encoding="utf-8")
            state_path.chmod(0o600)
            self.assertEqual(
                source_failure_admission(
                    state_path,
                    "youtube",
                    signal_path=signal_path,
                    now_seconds=200,
                    base_seconds=10,
                    max_seconds=60,
                ),
                ("backoff", 10),
            )

    def test_curation_generation_covers_exact_editorial_inputs_only_as_a_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "media-agent.db"
            instruction = root / "curation-prompt.md"
            instruction.write_text("deployment guidance\n", encoding="utf-8")
            connection = sqlite3.connect(database)
            connection.executescript(
                """
                CREATE TABLE browse_cache_items (
                  source TEXT NOT NULL,
                  source_id TEXT NOT NULL,
                  url TEXT,
                  title TEXT,
                  author_username TEXT,
                  author_display_name TEXT,
                  published_at_ms INTEGER,
                  payload_json TEXT NOT NULL,
                  fetched_at_ms INTEGER NOT NULL,
                  expires_at_ms INTEGER NOT NULL,
                  seen_by_curation_at_ms INTEGER,
                  PRIMARY KEY (source, source_id)
                );
                CREATE TABLE feed (
                  id TEXT PRIMARY KEY,
                  type TEXT NOT NULL,
                  source TEXT,
                  source_id TEXT,
                  author_username TEXT,
                  title TEXT,
                  text TEXT NOT NULL,
                  excerpt TEXT,
                  reason TEXT,
                  url TEXT,
                  created_at TEXT,
                  created_at_ms INTEGER,
                  published_at TEXT,
                  display_order INTEGER,
                  thread_id TEXT,
                  metadata TEXT,
                  parent_id TEXT
                );
                CREATE TABLE interactions (
                  id INTEGER PRIMARY KEY,
                  feed_item_id TEXT NOT NULL,
                  action TEXT NOT NULL,
                  created_at TEXT
                );
                CREATE TABLE preferences (
                  id TEXT PRIMARY KEY,
                  feed_item_id TEXT,
                  signal_type TEXT,
                  source TEXT,
                  text TEXT,
                  reason TEXT,
                  author_username TEXT,
                  weight REAL,
                  source_id TEXT,
                  created_at TEXT
                );
                CREATE TABLE thread_feedback (
                  id TEXT PRIMARY KEY,
                  thread_id TEXT,
                  cycle_id TEXT,
                  feed_item_id TEXT,
                  vote TEXT,
                  thread_title TEXT,
                  reason TEXT,
                  category TEXT,
                  probe_reason TEXT,
                  probe_uncertainty TEXT,
                  source_item_ids TEXT,
                  origin_session_id TEXT,
                  created_at TEXT
                );
                """
            )
            connection.commit()

            initial = compute_curation_input_generation(
                database,
                input_files=[instruction],
                now_ms=1_000,
            )
            self.assertRegex(initial, r"^curation-input-v1:[0-9a-f]{64}$")
            self.assertNotIn("deployment guidance", initial)

            connection.execute(
                """
                INSERT INTO browse_cache_items (
                  source, source_id, title, payload_json, fetched_at_ms, expires_at_ms
                ) VALUES ('unit', 'eligible-1', 'Candidate', '{"text":"private"}', 900, 5000)
                """
            )
            connection.commit()
            cache_changed = compute_curation_input_generation(
                database,
                input_files=[instruction],
                now_ms=1_000,
            )
            self.assertNotEqual(cache_changed, initial)

            connection.execute(
                """
                INSERT INTO preferences (
                  id, signal_type, source, text, weight, created_at
                ) VALUES ('preference-1', 'explicit', 'app', 'More depth', 1, '2035-01-01')
                """
            )
            connection.commit()
            preference_changed = compute_curation_input_generation(
                database,
                input_files=[instruction],
                now_ms=1_000,
            )
            self.assertNotEqual(preference_changed, cache_changed)

            instruction.write_text("revised guidance\n", encoding="utf-8")
            file_changed = compute_curation_input_generation(
                database,
                input_files=[instruction],
                now_ms=1_000,
            )
            self.assertNotEqual(file_changed, preference_changed)

            connection.execute(
                """
                INSERT INTO feed (
                  id, type, source, source_id, text, created_at, created_at_ms,
                  published_at, metadata
                ) VALUES (
                  'carry-1', 'article', 'unit', 'carry-source-1', 'Accepted item',
                  '2035-01-01', 900, '2035-01-01', '{}'
                )
                """
            )
            connection.commit()
            carry_changed = compute_curation_input_generation(
                database,
                input_files=[instruction],
                now_ms=1_000,
            )
            self.assertNotEqual(carry_changed, file_changed)
            connection.execute(
                """
                INSERT INTO interactions (feed_item_id, action, created_at)
                VALUES ('carry-1', 'view', '2035-01-02')
                """
            )
            connection.commit()
            interaction_changed = compute_curation_input_generation(
                database,
                input_files=[instruction],
                now_ms=1_000,
            )
            self.assertNotEqual(interaction_changed, carry_changed)

            generation_state = root / ".last-curation-input-generation.json"
            self.assertEqual(
                compare_curation_generation(generation_state, interaction_changed),
                "missing",
            )
            publish_curation_generation(
                generation_state,
                interaction_changed,
                now_seconds=2_000,
            )
            self.assertEqual(
                compare_curation_generation(generation_state, interaction_changed),
                "unchanged",
            )
            self.assertEqual(generation_state.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(
                "revised guidance",
                generation_state.read_text(encoding="utf-8"),
            )
            connection.close()

    def test_nightly_state_is_classified_before_wake_and_expiry_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "tasks"
            zone = dt.datetime.now().astimezone().tzinfo
            service_date = dt.date(2035, 6, 1)
            before_due = dt.datetime.combine(service_date, dt.time(1, 0), tzinfo=zone)
            ensured = ensure_nightly_task(
                root,
                task="oversee",
                hour=3,
                stamp=int(before_due.timestamp() * 1000),
            )
            due_at_ms = int(ensured["dueAtMs"])
            self.assertEqual(
                nightly_task_admission(ensured, root, now_ms=due_at_ms - 1),
                ("not_due", "queued", due_at_ms),
            )
            self.assertEqual(
                nightly_task_admission(ensured, root, now_ms=due_at_ms),
                ("due", "queued", due_at_ms),
            )

            lease = claim_task(
                root,
                owner="scheduler",
                kind="oversee",
                stamp=due_at_ms,
                lease_ms=10_000,
            )
            self.assertEqual(
                nightly_task_admission(ensured, root, now_ms=due_at_ms + 1),
                ("leased", "leased", due_at_ms),
            )
            self.assertEqual(
                nightly_task_admission(ensured, root, now_ms=due_at_ms + 10_001),
                ("due_recovery", "leased", due_at_ms),
            )

            finish_task(
                root,
                lease["leasePath"],
                result="ack",
                outcome="overseer_completed",
                stamp=due_at_ms + 2,
            )
            self.assertEqual(
                nightly_task_admission(ensured, root, now_ms=due_at_ms + 3),
                ("terminal", "acknowledged", due_at_ms),
            )

    def test_cycle_failure_backoff_is_private_bounded_and_success_clears_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / ".cycle-failure-backoff.json"
            now = 10_000
            observed_delays = []
            for _ in range(8):
                state = record_cycle_failure(state_path, now_seconds=now)
                observed_delays.append(state["delaySeconds"])
                self.assertLessEqual(state_path.stat().st_size, 512)
                self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(
                    set(json.loads(state_path.read_text(encoding="utf-8"))),
                    {
                        "version",
                        "consecutiveFailures",
                        "delaySeconds",
                        "notBeforeEpochSeconds",
                        "updatedAtEpochSeconds",
                    },
                )
                self.assertEqual(
                    cycle_failure_remaining_seconds(
                        state_path,
                        now_seconds=now + 1,
                    ),
                    state["delaySeconds"] - 1,
                )
                now = state["notBeforeEpochSeconds"]
            self.assertEqual(
                observed_delays,
                [300, 600, 1200, 2400, 4800, 7200, 7200, 7200],
            )
            clear_cycle_failure_backoff(state_path)
            self.assertFalse(state_path.exists())
            self.assertEqual(
                cycle_failure_remaining_seconds(state_path, now_seconds=now),
                0,
            )

    def test_cycle_failure_backoff_survives_real_helper_process_restarts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / ".cycle-failure-backoff.json"
            tool = TOOLS / "scheduler_timing.py"

            def invoke(action: str, now_seconds: int) -> str:
                result = subprocess.run(
                    [
                        sys.executable,
                        str(tool),
                        "--cycle-failure-state",
                        str(state_path),
                        "--cycle-failure-action",
                        action,
                        "--now-seconds",
                        str(now_seconds),
                    ],
                    cwd=TOOLS,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()

            self.assertEqual(invoke("record-failure", 20_000), "300")
            # A new interpreter sees and honors the original deadline.
            self.assertEqual(invoke("remaining", 20_120), "180")
            # Model a scheduler killed during that wait and restarted later.
            self.assertEqual(invoke("remaining", 20_299), "1")
            self.assertEqual(invoke("remaining", 20_300), "0")
            self.assertEqual(invoke("record-failure", 20_301), "600")
            self.assertEqual(invoke("remaining", 20_302), "599")
            self.assertEqual(invoke("clear", 20_303), "0")
            self.assertEqual(invoke("remaining", 20_304), "0")

    def test_existing_invalid_backoff_is_repaired_to_one_base_window(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / ".cycle-failure-backoff.json"
            self.assertEqual(
                cycle_failure_remaining_seconds(state_path, now_seconds=30_000),
                0,
            )
            state_path.write_text('{"unexpected":"crash-fragment"}\n', encoding="utf-8")
            state_path.chmod(0o600)

            # Existing invalid evidence is not equivalent to a fresh install.
            # Repair it once, then count down that persisted base window.
            self.assertEqual(
                cycle_failure_remaining_seconds(state_path, now_seconds=30_000),
                300,
            )
            repaired = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(repaired["consecutiveFailures"], 1)
            self.assertEqual(repaired["delaySeconds"], 300)
            self.assertEqual(repaired["notBeforeEpochSeconds"], 30_300)
            self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                cycle_failure_remaining_seconds(state_path, now_seconds=30_120),
                180,
            )

    def test_large_future_clock_skew_is_repaired_to_one_bounded_window(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / ".cycle-failure-backoff.json"
            record_cycle_failure(state_path, now_seconds=100_000)
            # Rewind the clock by much more than the maximum. The first read
            # caps and persists one two-hour window instead of suppressing work
            # indefinitely on every process restart.
            self.assertEqual(
                cycle_failure_remaining_seconds(state_path, now_seconds=1_000),
                7200,
            )
            repaired = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(repaired["notBeforeEpochSeconds"], 8_200)
            self.assertEqual(
                cycle_failure_remaining_seconds(state_path, now_seconds=8_200),
                0,
            )

    def test_restart_with_recent_completion_waits_for_remaining_minimum(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            stamp = Path(temporary) / ".last-completed-cycle"
            stamp.touch()
            os.utime(stamp, (10_000, 10_000))
            self.assertEqual(
                initial_floor_remaining_seconds(
                    stamp,
                    minimum_interval_minutes=120,
                    now_seconds=10_000 + 30 * 60,
                ),
                90 * 60,
            )

    def test_no_stamp_or_overdue_stamp_is_immediately_due(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            stamp = Path(temporary) / ".last-completed-cycle"
            self.assertEqual(
                initial_floor_remaining_seconds(
                    stamp,
                    minimum_interval_minutes=120,
                    now_seconds=10_000,
                ),
                0,
            )
            stamp.touch()
            os.utime(stamp, (1_000, 1_000))
            self.assertEqual(
                initial_floor_remaining_seconds(
                    stamp,
                    minimum_interval_minutes=120,
                    now_seconds=1_000 + 121 * 60,
                ),
                0,
            )

    def test_future_completion_stamp_is_repaired_once_and_countdown_decreases(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            stamp = Path(temporary) / ".last-completed-cycle"
            stamp.touch()
            os.utime(stamp, (20_000, 20_000))
            first = initial_floor_remaining_seconds(
                stamp,
                minimum_interval_minutes=120,
                now_seconds=10_000,
            )
            self.assertEqual(first, 120 * 60)
            self.assertAlmostEqual(stamp.stat().st_mtime, 10_000, places=3)
            second = initial_floor_remaining_seconds(
                stamp,
                minimum_interval_minutes=120,
                now_seconds=10_060,
            )
            self.assertEqual(second, 119 * 60)
            self.assertEqual(
                initial_floor_remaining_seconds(
                    stamp,
                    minimum_interval_minutes=120,
                    now_seconds=10_000 + 120 * 60,
                ),
                0,
            )

    def test_completion_floor_refuses_symlink_timestamp_authority(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            victim = root / "victim"
            victim.write_text("untouched\n", encoding="utf-8")
            victim.chmod(0o644)
            os.utime(victim, (20_000, 20_000))
            stamp = root / ".last-completed-cycle"
            stamp.symlink_to(victim)
            self.assertEqual(
                initial_floor_remaining_seconds(
                    stamp,
                    minimum_interval_minutes=120,
                    now_seconds=10_000,
                ),
                0,
            )
            self.assertEqual(victim.read_text(encoding="utf-8"), "untouched\n")
            self.assertEqual(victim.stat().st_mode & 0o777, 0o644)
            self.assertAlmostEqual(victim.stat().st_mtime, 20_000, places=3)

    def test_cycle_stamp_publish_refuses_a_colliding_symlink_temp(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stamp = root / ".last-completed-cycle"
            victim = root / "victim"
            victim.write_text("untouched\n", encoding="utf-8")
            token = "fixed-token"
            temp = stamp.with_name(
                f".{stamp.name}.tmp-{os.getpid()}-{token}"
            )
            temp.symlink_to(victim)
            with patch("scheduler_timing.secrets.token_hex", return_value=token):
                with self.assertRaises(FileExistsError):
                    advance_cycle_stamp(stamp, now_seconds=12_345)
            self.assertEqual(victim.read_text(encoding="utf-8"), "untouched\n")
            self.assertFalse(stamp.exists())

    def test_cycle_stamp_publish_is_private_and_replaces_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            stamp = Path(temporary) / ".last-completed-cycle"
            stamp.write_text("old\n", encoding="utf-8")
            stamp.chmod(0o644)
            self.assertEqual(
                advance_cycle_stamp(stamp, now_seconds=12_345),
                12_345,
            )
            self.assertEqual(stamp.read_text(encoding="utf-8"), "12345\n")
            self.assertEqual(stamp.stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                list(stamp.parent.glob(f".{stamp.name}.tmp-*")),
                [],
            )

    def test_cycle_stamp_does_not_redispatch_after_post_replace_dir_fsync_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            stamp = Path(temporary) / ".last-completed-cycle"
            with patch(
                "scheduler_timing._fsync_parent",
                side_effect=OSError("directory fsync unsupported"),
            ):
                self.assertEqual(
                    advance_cycle_stamp(stamp, now_seconds=12_345),
                    12_345,
                )
            self.assertEqual(stamp.read_text(encoding="utf-8"), "12345\n")
            self.assertEqual(stamp.stat().st_mode & 0o777, 0o600)

    def test_watchdog_missing_completion_baseline_eventually_becomes_overdue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completion = root / ".last-completed-cycle"
            legacy_success = root / ".last-successful-cycle"
            baseline = root / ".no-completed-cycle-baseline"
            reference = ensure_watchdog_completion_reference(
                completion,
                legacy_success,
                baseline,
                now_seconds=10_000,
            )
            self.assertEqual(reference, baseline)
            self.assertTrue(baseline.exists())
            self.assertEqual(baseline.stat().st_mode & 0o777, 0o600)
            self.assertFalse(watchdog_completion_reference_overdue(
                reference,
                overdue_minutes=780,
                now_seconds=10_000 + 780 * 60,
            ))
            self.assertTrue(watchdog_completion_reference_overdue(
                reference,
                overdue_minutes=780,
                now_seconds=10_000 + 781 * 60,
            ))

            legacy_success.write_text("completed\n", encoding="utf-8")
            legacy_success.chmod(0o600)
            os.utime(legacy_success, (60_000, 60_000))
            reference = ensure_watchdog_completion_reference(
                completion,
                legacy_success,
                baseline,
                now_seconds=60_001,
            )
            self.assertEqual(reference, legacy_success)
            self.assertFalse(baseline.exists())
            self.assertFalse(watchdog_completion_reference_overdue(
                reference,
                overdue_minutes=780,
                now_seconds=60_001,
            ))

            completion.write_text("completed\n", encoding="utf-8")
            completion.chmod(0o600)
            os.utime(completion, (70_000, 70_000))
            reference = ensure_watchdog_completion_reference(
                completion,
                legacy_success,
                baseline,
                now_seconds=70_001,
            )
            self.assertEqual(reference, completion)

    def test_watchdog_replaces_same_owner_baseline_symlink_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completion = root / ".last-completed-cycle"
            legacy_success = root / ".last-successful-cycle"
            baseline = root / ".no-completed-cycle-baseline"
            victim = root / "victim"
            victim.write_text("untouched\n", encoding="utf-8")
            victim.chmod(0o644)
            baseline.symlink_to(victim)

            reference = ensure_watchdog_completion_reference(
                completion,
                legacy_success,
                baseline,
                now_seconds=10_000,
            )

            self.assertEqual(reference, baseline)
            self.assertFalse(baseline.is_symlink())
            self.assertTrue(baseline.is_file())
            self.assertEqual(baseline.stat().st_mode & 0o777, 0o600)
            self.assertEqual(victim.read_text(encoding="utf-8"), "untouched\n")
            self.assertEqual(victim.stat().st_mode & 0o777, 0o644)

    def test_watchdog_ignores_symlink_completion_and_overdue_reference(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            victim = root / "victim"
            victim.write_text("untouched\n", encoding="utf-8")
            victim.chmod(0o644)
            os.utime(victim, (20_000, 20_000))
            completion = root / ".last-completed-cycle"
            completion.symlink_to(victim)
            baseline = root / ".no-completed-cycle-baseline"

            reference = ensure_watchdog_completion_reference(
                completion,
                None,
                baseline,
                now_seconds=10_000,
            )
            self.assertEqual(reference, baseline)
            self.assertFalse(
                watchdog_completion_reference_overdue(
                    completion,
                    overdue_minutes=1,
                    now_seconds=30_000,
                )
            )
            self.assertEqual(victim.stat().st_mode & 0o777, 0o644)
            self.assertAlmostEqual(victim.stat().st_mtime, 20_000, places=3)


class PrivateArtifactPostconditionTests(unittest.TestCase):
    @staticmethod
    def _snapshot_result(path: Path, trusted_root: Path | None) -> tuple[int, str]:
        arguments = ["snapshot", "--path", str(path)]
        if trusted_root is not None:
            arguments.extend(["--trusted-data-root", str(trusted_root)])
        with patch("builtins.print") as output:
            result = private_artifact_main(arguments)
        output.assert_called_once()
        return result, str(output.call_args.args[0])

    def test_preference_memory_rejects_binary_or_non_text_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "preference-insights.md"
            for payload in (
                b"\xff\xfe not utf-8\n",
                b"# Preference Insights\x00hidden\n",
                b"# Preference Insights\x01hidden\n",
                b" \n\t",
            ):
                path.write_bytes(payload)
                path.chmod(0o600)
                self.assertFalse(preference_insights_valid(path))
                self.assertFalse(
                    atomic_rewrite_private_artifact(path, kind="preference")
                )

    def test_snapshot_requires_a_stable_bounded_private_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "preference-insights.md"
            path.write_text("# Preference Insights\n", encoding="utf-8")
            path.chmod(0o600)
            self.assertRegex(artifact_identity(path), r"^[0-9]+:[0-9]+$")

            path.chmod(0o644)
            self.assertEqual(artifact_identity(path), "missing")
            path.chmod(0o600)

            alias = root / "preference-alias.md"
            alias.symlink_to(path.name)
            self.assertEqual(artifact_identity(alias), "missing")

            oversized = root / "oversized.md"
            oversized.write_bytes(b"x" * (MAX_PRIVATE_ARTIFACT_BYTES + 1))
            oversized.chmod(0o600)
            self.assertEqual(artifact_identity(oversized), "missing")

    def test_snapshot_compacts_oversized_preference_deterministically_and_preserves_it(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary).resolve()
            payload = (
                "# Preference Insights\n\n"
                "BEGINNING-PRIVATE-SYNTHESIS\n"
                + "".join(
                    f"## Durable section {index}\nEvidence line {index}: "
                    + ("x" * 96)
                    + "\n"
                    for index in range(900)
                )
                + "MOST-RECENT-PRIVATE-SYNTHESIS\n"
            ).encode("utf-8")
            self.assertGreater(len(payload), MAX_PRIVATE_ARTIFACT_BYTES)
            compacted_payloads: list[bytes] = []
            receipt_payloads: list[bytes] = []

            for name in ("first", "second"):
                root = parent / name
                root.mkdir()
                path = root / "preference-insights.md"
                path.write_bytes(payload)
                path.chmod(0o600)
                result, before = self._snapshot_result(path, root)

                self.assertEqual(result, 0)
                self.assertRegex(before, r"^[0-9]+:[0-9]+$")
                compacted = path.read_bytes()
                self.assertLessEqual(
                    len(compacted),
                    PREFERENCE_COMPACTED_TARGET_BYTES,
                )
                self.assertTrue(preference_insights_valid(path))
                self.assertIn(b"BEGINNING-PRIVATE-SYNTHESIS", compacted)
                self.assertIn(b"MOST-RECENT-PRIVATE-SYNTHESIS", compacted)
                self.assertIn(b"Deterministic compaction receipt", compacted)
                self.assertIn(b"remains unchanged in the exact preserved source", compacted)

                digest = hashlib.sha256(payload).hexdigest()
                preserved = (
                    root
                    / f".preference-insights.md.preserved.{digest}.md"
                )
                receipt = (
                    root
                    / f".preference-insights.md.compaction.{digest}.json"
                )
                self.assertEqual(preserved.read_bytes(), payload)
                self.assertEqual(preserved.stat().st_mode & 0o777, 0o600)
                receipt_value = json.loads(receipt.read_text(encoding="utf-8"))
                self.assertEqual(receipt_value["preservedSource"]["sha256"], digest)
                self.assertEqual(receipt_value["preservedSource"]["bytes"], len(payload))
                self.assertEqual(
                    receipt_value["boundedView"]["sha256"],
                    hashlib.sha256(compacted).hexdigest(),
                )
                self.assertEqual(
                    receipt_value["status"],
                    "source_preserved_before_atomic_compaction",
                )
                self.assertNotIn(
                    "BEGINNING-PRIVATE-SYNTHESIS",
                    receipt.read_text(encoding="utf-8"),
                )
                self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                compacted_payloads.append(compacted)
                receipt_payloads.append(receipt.read_bytes())

                # A normal second snapshot is read-only and returns the same
                # admission identity without creating another archive.
                files_before = sorted(child.name for child in root.iterdir())
                second_result, second_identity = self._snapshot_result(path, root)
                self.assertEqual(second_result, 0)
                self.assertEqual(second_identity, before)
                self.assertEqual(
                    sorted(child.name for child in root.iterdir()),
                    files_before,
                )

                # The unchanged daily overseer finalizer still changes the live
                # inode and satisfies the scheduler's existing postcondition.
                self.assertEqual(
                    private_artifact_main([
                        "rewrite",
                        "--path",
                        str(path),
                        "--kind",
                        "preference",
                        "--trusted-data-root",
                        str(root),
                    ]),
                    0,
                )
                self.assertTrue(artifact_was_atomically_rewritten(
                    path,
                    before_identity=before,
                    kind="preference",
                    trusted_data_root=root,
                ))
                self.assertEqual(preserved.read_bytes(), payload)

            self.assertEqual(compacted_payloads[0], compacted_payloads[1])
            self.assertEqual(receipt_payloads[0], receipt_payloads[1])

    def test_oversized_preference_snapshot_fails_closed_outside_narrow_contract(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary).resolve()
            valid_oversized = (
                b"# Preference Insights\n"
                + b"private synthesis\n" * 4_000
            )
            cases = (
                ("wrong-name", "other-private-state.md", valid_oversized, 0o600, True),
                ("unsafe-mode", "preference-insights.md", valid_oversized, 0o644, True),
                (
                    "malformed",
                    "preference-insights.md",
                    b"\xff" * (MAX_PRIVATE_ARTIFACT_BYTES + 1),
                    0o600,
                    True,
                ),
                (
                    "too-large",
                    "preference-insights.md",
                    b"x" * (MAX_PREFERENCE_COMPACTION_SOURCE_BYTES + 1),
                    0o600,
                    True,
                ),
                (
                    "no-trust-root",
                    "preference-insights.md",
                    valid_oversized,
                    0o600,
                    False,
                ),
            )
            for case, filename, payload, mode, use_trust_root in cases:
                root = parent / case
                root.mkdir()
                path = root / filename
                path.write_bytes(payload)
                path.chmod(mode)
                result, identity = self._snapshot_result(
                    path,
                    root if use_trust_root else None,
                )
                self.assertEqual(result, 0)
                self.assertEqual(identity, "missing")
                self.assertEqual(path.read_bytes(), payload)
                self.assertEqual(
                    [
                        child.name
                        for child in root.iterdir()
                        if child.name.startswith(".preference-insights.md.")
                    ],
                    [],
                )

    def test_compaction_failure_keeps_live_source_and_retry_reuses_exact_archive(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / "preference-insights.md"
            payload = (
                b"# Preference Insights\n"
                + b"durable private synthesis\n" * 4_000
            )
            path.write_bytes(payload)
            path.chmod(0o600)
            digest = hashlib.sha256(payload).hexdigest()

            with patch(
                "private_artifact.os.replace",
                side_effect=OSError("simulated replacement failure"),
            ):
                result, identity = self._snapshot_result(path, root)
            self.assertEqual(result, 0)
            self.assertEqual(identity, "missing")
            self.assertEqual(path.read_bytes(), payload)
            preserved = (
                root
                / f".preference-insights.md.preserved.{digest}.md"
            )
            receipt = (
                root
                / f".preference-insights.md.compaction.{digest}.json"
            )
            self.assertEqual(preserved.read_bytes(), payload)
            self.assertTrue(receipt.is_file())

            result, identity = self._snapshot_result(path, root)
            self.assertEqual(result, 0)
            self.assertRegex(identity, r"^[0-9]+:[0-9]+$")
            self.assertTrue(preference_insights_valid(path))
            self.assertEqual(preserved.read_bytes(), payload)

    def test_compaction_race_never_overwrites_a_newer_live_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / "preference-insights.md"
            original = (
                b"# Preference Insights\n"
                + b"original private synthesis\n" * 4_000
            )
            concurrent = (
                b"# Preference Insights\n"
                + b"newer concurrent synthesis\n" * 4_000
            )
            path.write_bytes(original)
            path.chmod(0o600)
            artifact_module = sys.modules["private_artifact"]
            replace_exact = artifact_module._replace_private_artifact_exact_at

            def race_before_compare(*args, **kwargs):
                replacement = root / ".concurrent-preference.tmp"
                replacement.write_bytes(concurrent)
                replacement.chmod(0o600)
                os.replace(replacement, path)
                return replace_exact(*args, **kwargs)

            with patch(
                "private_artifact._replace_private_artifact_exact_at",
                side_effect=race_before_compare,
            ):
                result, identity = self._snapshot_result(path, root)
            self.assertEqual(result, 0)
            self.assertEqual(identity, "missing")
            self.assertEqual(path.read_bytes(), concurrent)
            original_digest = hashlib.sha256(original).hexdigest()
            self.assertEqual(
                (
                    root
                    / f".preference-insights.md.preserved.{original_digest}.md"
                ).read_bytes(),
                original,
            )

            result, identity = self._snapshot_result(path, root)
            self.assertEqual(result, 0)
            self.assertRegex(identity, r"^[0-9]+:[0-9]+$")
            concurrent_digest = hashlib.sha256(concurrent).hexdigest()
            self.assertEqual(
                (
                    root
                    / f".preference-insights.md.preserved.{concurrent_digest}.md"
                ).read_bytes(),
                concurrent,
            )

    def test_empty_or_zero_cadence_cannot_ack_the_daily_overseer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source-cadence.json"
            for value in ({}, {"twitter": {"cadenceHours": 0, "why": "always"}}):
                path.write_text(json.dumps(value), encoding="utf-8")
                path.chmod(0o600)
                self.assertFalse(source_cadence_valid(path))

    def test_live_cadence_rejects_public_comment_and_long_reason(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source-cadence.json"
            invalid_values = (
                {
                    "_comment": "public bootstrap explanation",
                    "twitter": {"cadenceHours": 4, "why": "bounded evidence cost"},
                },
                {
                    "_comment": {
                        "cadenceHours": 4,
                        "why": "a public comment shaped like a source is still not a source",
                    },
                    "twitter": {"cadenceHours": 4, "why": "bounded evidence cost"},
                },
                {"twitter": {"cadenceHours": 4, "why": "x" * 241}},
            )
            for value in invalid_values:
                path.write_text(json.dumps(value), encoding="utf-8")
                path.chmod(0o600)
                before = artifact_identity(path)
                self.assertFalse(source_cadence_valid(path))
                self.assertFalse(atomic_rewrite_private_artifact(path, kind="cadence"))
                self.assertEqual(artifact_identity(path), before)

    def test_safe_no_change_rewrite_preserves_bytes_and_changes_inode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cases = (
                (
                    root / "preference-insights.md",
                    b"# Durable private synthesis\n\nNo change today.\n",
                    "preference",
                ),
                (
                    root / "source-cadence.json",
                    (
                        b'{\n  "twitter": {"cadenceHours": 4, '
                        b'"why": "bounded evidence cost", '
                        b'"futurePrivateField": {"keep": true}}\n}\n'
                    ),
                    "cadence",
                ),
            )
            for path, payload, kind in cases:
                path.write_bytes(payload)
                path.chmod(0o600)
                before = artifact_identity(path)
                with patch("private_artifact.os.fsync", wraps=os.fsync) as fsync:
                    self.assertEqual(
                        private_artifact_main([
                            "rewrite",
                            "--path",
                            str(path),
                            "--kind",
                            kind,
                        ]),
                        0,
                    )
                self.assertGreaterEqual(fsync.call_count, 2)
                self.assertNotEqual(artifact_identity(path), before)
                self.assertEqual(path.read_bytes(), payload)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_rewrite_rejects_symlink_file_and_symlink_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            real = root / "real"
            real.mkdir()
            target = real / "source-cadence.json"
            payload = b'{"twitter":{"cadenceHours":4,"why":"bounded evidence cost"}}\n'
            target.write_bytes(payload)
            target.chmod(0o600)

            alias = root / "source-cadence.json"
            alias.symlink_to(target)
            self.assertFalse(source_cadence_valid(alias))
            self.assertFalse(atomic_rewrite_private_artifact(alias, kind="cadence"))
            self.assertTrue(alias.is_symlink())
            self.assertEqual(target.read_bytes(), payload)

            linked_parent = root / "linked-data"
            linked_parent.symlink_to(real, target_is_directory=True)
            linked_path = linked_parent / target.name
            self.assertFalse(source_cadence_valid(linked_path))
            self.assertFalse(atomic_rewrite_private_artifact(linked_path, kind="cadence"))
            self.assertFalse(source_cadence_valid(
                linked_path,
                trusted_data_root=real,
            ))
            self.assertFalse(atomic_rewrite_private_artifact(
                linked_path,
                kind="cadence",
                trusted_data_root=real,
            ))
            self.assertEqual(target.read_bytes(), payload)

    def test_compaction_uses_the_bound_release_runtime_data_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            release_root = Path(temporary).resolve() / "evogent"
            private_data = release_root / "state" / "data"
            runtime = release_root / "releases" / "release-id" / "runtime"
            private_data.mkdir(parents=True)
            runtime.mkdir(parents=True)
            (runtime / "data").symlink_to("../../../state/data")
            target = private_data / "preference-insights.md"
            payload = (
                b"# Preference Insights\n"
                + b"private durable synthesis\n" * 4_000
            )
            target.write_bytes(payload)
            target.chmod(0o600)
            linked_path = runtime / "data" / target.name

            self.assertEqual(
                self._snapshot_result(linked_path, None),
                (0, "missing"),
            )
            result, identity = self._snapshot_result(linked_path, private_data)
            self.assertEqual(result, 0)
            self.assertRegex(identity, r"^[0-9]+:[0-9]+$")
            self.assertTrue(preference_insights_valid(
                linked_path,
                trusted_data_root=private_data,
            ))
            digest = hashlib.sha256(payload).hexdigest()
            preserved = (
                private_data
                / f".preference-insights.md.preserved.{digest}.md"
            )
            self.assertEqual(preserved.read_bytes(), payload)

    def test_release_runtime_data_link_binds_to_canonical_private_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            # macOS exposes /var through a symlink to /private/var. The
            # production trust contract requires the caller to provide the
            # canonical root rather than an ancestor-symlink alias.
            release_root = Path(temporary).resolve() / "evogent"
            private_data = release_root / "state" / "data"
            runtime = release_root / "releases" / "release-id" / "runtime"
            private_data.mkdir(parents=True)
            runtime.mkdir(parents=True)
            (runtime / "data").symlink_to("../../../state/data")

            payload = (
                b'{"twitter":{"cadenceHours":4,'
                b'"why":"bounded evidence cost"}}\n'
            )
            target = private_data / "source-cadence.json"
            target.write_bytes(payload)
            target.chmod(0o600)
            linked_path = runtime / "data" / target.name

            self.assertFalse(source_cadence_valid(linked_path))
            self.assertTrue(source_cadence_valid(
                linked_path,
                trusted_data_root=private_data,
            ))
            previous_directory = Path.cwd()
            try:
                os.chdir(runtime)
                self.assertTrue(source_cadence_valid(
                    Path("data") / target.name,
                    trusted_data_root=private_data,
                ))
            finally:
                os.chdir(previous_directory)
            before = artifact_identity(
                linked_path,
                trusted_data_root=private_data,
            )
            self.assertEqual(
                private_artifact_main([
                    "rewrite",
                    "--path",
                    str(linked_path),
                    "--kind",
                    "cadence",
                    "--trusted-data-root",
                    str(private_data),
                ]),
                0,
            )
            self.assertTrue(artifact_was_atomically_rewritten(
                linked_path,
                before_identity=before,
                kind="cadence",
                trusted_data_root=private_data,
            ))
            self.assertEqual(linked_path.read_bytes(), payload)
            self.assertEqual(linked_path.stat().st_mode & 0o777, 0o600)

            leaf_alias = private_data / "leaf-alias.json"
            leaf_alias.symlink_to(target.name)
            linked_leaf_alias = runtime / "data" / leaf_alias.name
            self.assertFalse(source_cadence_valid(
                linked_leaf_alias,
                trusted_data_root=private_data,
            ))
            self.assertFalse(atomic_rewrite_private_artifact(
                linked_leaf_alias,
                kind="cadence",
                trusted_data_root=private_data,
            ))

            untrusted_root = release_root / "other-data"
            untrusted_root.mkdir()
            self.assertFalse(source_cadence_valid(
                linked_path,
                trusted_data_root=untrusted_root,
            ))

            trusted_root_alias = release_root / "data-root-alias"
            trusted_root_alias.symlink_to(private_data, target_is_directory=True)
            self.assertFalse(source_cadence_valid(
                linked_path,
                trusted_data_root=trusted_root_alias,
            ))

            decoy_runtime = release_root / "releases" / "release-id" / "not-runtime"
            decoy_runtime.mkdir()
            (decoy_runtime / "data").symlink_to("../../../state/data")
            self.assertFalse(source_cadence_valid(
                decoy_runtime / "data" / target.name,
                trusted_data_root=private_data,
            ))

    def test_exit_zero_without_atomic_rewrite_cannot_pass_postcondition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "preference-insights.md"
            path.write_text("# unchanged\n", encoding="utf-8")
            path.chmod(0o600)
            before = artifact_identity(path)
            self.assertFalse(artifact_was_atomically_rewritten(
                path,
                before_identity=before,
                kind="preference",
            ))
            # Even a valid in-place write is not the required atomic canonical replacement.
            path.write_text("# changed in place\n", encoding="utf-8")
            self.assertFalse(artifact_was_atomically_rewritten(
                path,
                before_identity=before,
                kind="preference",
            ))

    def test_valid_atomic_rewrite_passes_memory_and_cadence_postconditions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            insights = root / "preference-insights.md"
            insights.write_text("# before\n", encoding="utf-8")
            insights.chmod(0o600)
            before_insights = artifact_identity(insights)
            replacement = root / ".insights.tmp"
            replacement.write_text("# after\n", encoding="utf-8")
            replacement.chmod(0o600)
            os.replace(replacement, insights)
            self.assertTrue(artifact_was_atomically_rewritten(
                insights,
                before_identity=before_insights,
                kind="preference",
            ))

            cadence = root / "source-cadence.json"
            cadence.write_text('{"twitter":{"cadenceHours":1.5,"why":"bounded evidence cost"}}\n')
            cadence.chmod(0o600)
            before_cadence = artifact_identity(cadence)
            replacement = root / ".cadence.tmp"
            replacement.write_text(
                '{"twitter":{"cadenceHours":0.5,"why":"recent durable yield"}}\n',
                encoding="utf-8",
            )
            replacement.chmod(0o600)
            os.replace(replacement, cadence)
            self.assertTrue(artifact_was_atomically_rewritten(
                cadence,
                before_identity=before_cadence,
                kind="cadence",
            ))


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


class PublicHttpSafetyTests(unittest.TestCase):
    PUBLIC_IP = "93.184.216.34"

    @staticmethod
    def public_resolver(_hostname: str, port: int, **_kwargs):
        return [dns_answer(PublicHttpSafetyTests.PUBLIC_IP, port)]

    def test_loopback_story_url_is_rejected_before_connect(self) -> None:
        connections = []

        def resolver(_hostname: str, port: int, **_kwargs):
            return [dns_answer("127.0.0.1", port)]

        def factory(*args):
            connections.append(args)
            return FakeHttpConnection(FakeHttpResponse(200, b"should not run"))

        with self.assertRaises(UnsafePublicUrlError):
            fetch_public_text(
                "http://127.0.0.1/private",
                resolver=resolver,
                connection_factory=factory,
            )
        self.assertEqual(connections, [])

    def test_mixed_public_and_private_dns_answer_rejects_the_whole_host(self) -> None:
        def resolver(_hostname: str, port: int, **_kwargs):
            return [
                dns_answer(self.PUBLIC_IP, port),
                dns_answer("10.0.0.9", port),
            ]

        with self.assertRaises(UnsafePublicUrlError):
            fetch_public_text(
                "https://mixed.example/story",
                resolver=resolver,
                connection_factory=lambda *_args: self.fail("must not connect"),
            )

    def test_deprecated_ipv6_site_local_answer_is_rejected_before_connect(self) -> None:
        def resolver(_hostname: str, port: int, **_kwargs):
            return [dns_answer("fec0::1234", port)]

        with self.assertRaises(UnsafePublicUrlError):
            fetch_public_text(
                "https://site-local.example/story",
                resolver=resolver,
                connection_factory=lambda *_args: self.fail("must not connect"),
            )

    def test_validated_address_is_pinned_without_a_second_dns_lookup(self) -> None:
        resolver_calls = 0
        connected = []

        def rebinding_resolver(_hostname: str, port: int, **_kwargs):
            nonlocal resolver_calls
            resolver_calls += 1
            address = self.PUBLIC_IP if resolver_calls == 1 else "127.0.0.1"
            return [dns_answer(address, port)]

        def factory(scheme, hostname, port, pinned_ip, timeout):
            connected.append((scheme, hostname, port, pinned_ip, timeout))
            return FakeHttpConnection(FakeHttpResponse(200, b"safe body"))

        body = fetch_public_text(
            "https://rebind.example/story",
            resolver=rebinding_resolver,
            connection_factory=factory,
        )
        self.assertEqual(body, "safe body")
        self.assertEqual(resolver_calls, 1)
        self.assertEqual(connected[0][3], self.PUBLIC_IP)

    def test_private_redirect_target_is_validated_before_following(self) -> None:
        connections = []

        def resolver(hostname: str, port: int, **_kwargs):
            address = "127.0.0.1" if hostname == "127.0.0.1" else self.PUBLIC_IP
            return [dns_answer(address, port)]

        def factory(scheme, hostname, port, pinned_ip, timeout):
            connections.append((scheme, hostname, port, pinned_ip, timeout))
            return FakeHttpConnection(FakeHttpResponse(
                302,
                headers={"Location": "https://127.0.0.1/private"},
            ))

        with self.assertRaises(UnsafePublicUrlError):
            fetch_public_text(
                "https://public.example/story",
                resolver=resolver,
                connection_factory=factory,
            )
        self.assertEqual(len(connections), 1)

    def test_https_redirect_may_not_downgrade_to_http(self) -> None:
        def factory(_scheme, _hostname, _port, _pinned_ip, _timeout):
            return FakeHttpConnection(FakeHttpResponse(
                302,
                headers={"Location": "http://public-two.example/story"},
            ))

        with self.assertRaises(UnsafePublicUrlError):
            fetch_public_text(
                "https://public-one.example/story",
                resolver=self.public_resolver,
                connection_factory=factory,
            )

    def test_success_preserves_host_and_caps_the_response_body(self) -> None:
        connection = FakeHttpConnection(FakeHttpResponse(
            200,
            b"<html><meta property='og:description' content='Safe synopsis'></html>",
        ))
        pins = []

        def factory(scheme, hostname, port, pinned_ip, timeout):
            pins.append((scheme, hostname, port, pinned_ip, timeout))
            return connection

        text = fetch_public_text(
            "https://public.example:444/story?q=1",
            resolver=self.public_resolver,
            connection_factory=factory,
            max_bytes=1_000,
        )
        self.assertIn("Safe synopsis", text)
        self.assertEqual(pins[0][3], self.PUBLIC_IP)
        method, target, headers = connection.requests[0]
        self.assertEqual((method, target), ("GET", "/story?q=1"))
        self.assertEqual(headers["Host"], "public.example:444")
        self.assertTrue(connection.closed)

    def test_oversize_response_is_rejected_after_bounded_read(self) -> None:
        connection = FakeHttpConnection(FakeHttpResponse(200, b"123456"))
        with self.assertRaises(PublicHttpLimitError):
            fetch_public_text(
                "https://public.example/story",
                resolver=self.public_resolver,
                connection_factory=lambda *_args: connection,
                max_bytes=5,
            )
        self.assertTrue(connection.closed)

    def test_dns_and_body_work_are_bounded_by_wall_time(self) -> None:
        def slow_resolver(_hostname: str, port: int, **_kwargs):
            time.sleep(0.2)
            return [dns_answer(self.PUBLIC_IP, port)]

        started = time.monotonic()
        with self.assertRaises(PublicHttpLimitError):
            fetch_public_text(
                "https://slow-dns.example/story",
                resolver=slow_resolver,
                connection_factory=lambda *_args: self.fail("must not connect"),
                timeout=0.02,
            )
        self.assertLess(time.monotonic() - started, 0.15)

        class SlowResponse(FakeHttpResponse):
            def read(self, limit: int):
                time.sleep(0.2)
                return super().read(limit)

        connection = FakeHttpConnection(SlowResponse(200, b"eventual"))
        started = time.monotonic()
        with self.assertRaises(PublicHttpLimitError):
            fetch_public_text(
                "https://slow-body.example/story",
                resolver=self.public_resolver,
                connection_factory=lambda *_args: connection,
                timeout=0.02,
            )
        self.assertLess(time.monotonic() - started, 0.15)
        self.assertTrue(connection.closed)

    def test_redirect_hops_share_one_total_wall_clock_budget(self) -> None:
        connection_count = 0

        class SlowRedirectConnection(FakeHttpConnection):
            def getresponse(self):
                time.sleep(0.02)
                return self.response

        def factory(_scheme, _hostname, _port, _pinned_ip, _timeout):
            nonlocal connection_count
            connection_count += 1
            return SlowRedirectConnection(FakeHttpResponse(
                302,
                headers={"Location": f"https://public.example/hop-{connection_count}"},
            ))

        started = time.monotonic()
        with self.assertRaises(PublicHttpLimitError):
            fetch_public_text(
                "https://public.example/start",
                resolver=self.public_resolver,
                connection_factory=factory,
                timeout=0.035,
                max_redirects=10,
            )
        self.assertGreaterEqual(connection_count, 2)
        self.assertLess(time.monotonic() - started, 0.2)

    def test_default_connections_use_the_pinned_peer_and_https_sni(self) -> None:
        raw_socket = object()
        with patch.object(public_http, "_connect_pinned", return_value=raw_socket) as connect:
            connection = public_http._PinnedHttpConnection(
                "public.example",
                80,
                self.PUBLIC_IP,
                3,
            )
            connection.connect()
        connect.assert_called_once_with(self.PUBLIC_IP, 80, 3, None)
        self.assertIs(connection.sock, raw_socket)

        wrapped_socket = object()

        class FakeTlsContext:
            def __init__(self):
                self.calls = []

            def wrap_socket(self, sock, *, server_hostname):
                self.calls.append((sock, server_hostname))
                return wrapped_socket

        tls_context = FakeTlsContext()
        with patch.object(public_http, "_connect_pinned", return_value=raw_socket) as connect:
            secure_connection = public_http._PinnedHttpsConnection(
                "public.example",
                443,
                self.PUBLIC_IP,
                4,
            )
            secure_connection._context = tls_context
            secure_connection.connect()
        connect.assert_called_once_with(self.PUBLIC_IP, 443, 4, None)
        self.assertEqual(tls_context.calls, [(raw_socket, "public.example")])
        self.assertIs(secure_connection.sock, wrapped_socket)

    def test_pinned_socket_connect_never_calls_name_resolution(self) -> None:
        class FakeSocket:
            def __init__(self):
                self.timeout = None
                self.peer = None
                self.closed = False

            def settimeout(self, timeout):
                self.timeout = timeout

            def bind(self, _source):
                self.fail("source bind was not expected")

            def connect(self, peer):
                self.peer = peer

            def close(self):
                self.closed = True

            def fail(self, message):
                raise AssertionError(message)

        fake_socket = FakeSocket()
        with (
            patch.object(public_http.socket, "socket", return_value=fake_socket) as create_socket,
            patch.object(
                public_http.socket,
                "getaddrinfo",
                side_effect=AssertionError("pinned connect must not resolve"),
            ),
        ):
            result = public_http._connect_pinned(self.PUBLIC_IP, 443, 2)
        create_socket.assert_called_once_with(
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
        )
        self.assertIs(result, fake_socket)
        self.assertEqual(fake_socket.timeout, 2)
        self.assertEqual(fake_socket.peer, (self.PUBLIC_IP, 443))


class HackerNewsCollectionTests(unittest.TestCase):
    def test_low_popularity_live_story_reaches_agent_evidence(self) -> None:
        story_id = 101

        def fetch_json(url: str):
            if url.endswith("stories.json"):
                return [story_id]
            if url.endswith(f"/item/{story_id}.json"):
                return {
                    "id": story_id,
                    "type": "story",
                    "title": "A quiet but eligible story",
                    "url": "https://example.invalid/story",
                    "score": 0,
                    "descendants": 0,
                    "time": 1_700_000_000,
                }
            raise AssertionError(f"unexpected URL {url}")

        items, retrieval = hn_fetch.collect_hn_items(
            fetch_json=fetch_json,
            fetch_synopsis=lambda _url: "Grounded article synopsis for agent judgment.",
            now_ms=1_700_000_100_000,
        )
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["payload"]["score"], 0)
        self.assertEqual(retrieval["listSuccesses"], len(hn_fetch.HN_LISTS))
        receipt = hn_fetch.build_refresh_body(
            items,
            retrieval,
            started_at_ms=1_700_000_100_000,
            completed_at_ms=1_700_000_100_100,
        )
        self.assertEqual(receipt["status"], "completed")
        self.assertNotIn("outcomeEvidence", receipt["metadata"])

    def test_proven_empty_means_no_live_story_not_no_popular_story(self) -> None:
        dead_story_id = 202

        def fetch_json(url: str):
            if url.endswith("stories.json"):
                return [dead_story_id]
            if url.endswith(f"/item/{dead_story_id}.json"):
                return {"id": dead_story_id, "type": "story", "dead": True, "score": 500}
            raise AssertionError(f"unexpected URL {url}")

        items, retrieval = hn_fetch.collect_hn_items(
            fetch_json=fetch_json,
            fetch_synopsis=lambda _url: "",
            now_ms=1_700_000_100_000,
        )
        receipt = hn_fetch.build_refresh_body(
            items,
            retrieval,
            started_at_ms=1_700_000_100_000,
            completed_at_ms=1_700_000_100_100,
        )
        self.assertEqual(receipt["status"], "completed")
        evidence = receipt["metadata"]["outcomeEvidence"]
        self.assertTrue(evidence["provenEmpty"])
        self.assertNotIn("score", evidence["evidence"].lower())

    def test_partial_list_failure_is_not_proven_empty(self) -> None:
        def fetch_json(url: str):
            if url.endswith("/beststories.json"):
                raise TimeoutError("test timeout")
            if url.endswith("stories.json"):
                return []
            raise AssertionError(f"unexpected URL {url}")

        items, retrieval = hn_fetch.collect_hn_items(
            fetch_json=fetch_json,
            fetch_synopsis=lambda _url: "",
            now_ms=1_700_000_100_000,
        )
        receipt = hn_fetch.build_refresh_body(
            items,
            retrieval,
            started_at_ms=1_700_000_100_000,
            completed_at_ms=1_700_000_100_100,
        )
        self.assertEqual(receipt["status"], "failed")
        self.assertNotIn("outcomeEvidence", receipt["metadata"])


if __name__ == "__main__":
    unittest.main()
