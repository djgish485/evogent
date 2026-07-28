#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import socket
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
    acknowledge_queued_task,
    claim_task,
    enqueue_task,
    ensure_nightly_task,
    finish_task,
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
    artifact_identity,
    artifact_was_atomically_rewritten,
    source_cadence_valid,
)
from scheduler_timing import (  # noqa: E402
    clear_cycle_failure_backoff,
    cycle_failure_remaining_seconds,
    ensure_watchdog_success_reference,
    initial_floor_remaining_seconds,
    normalize_scheduler_bounds,
    record_cycle_failure,
    watchdog_success_reference_overdue,
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
            stamp = Path(temporary) / "last-cycle-newitems"
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
            stamp = Path(temporary) / "last-cycle-newitems"
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

    def test_watchdog_missing_success_baseline_eventually_becomes_overdue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            success = root / ".last-successful-cycle"
            baseline = root / ".no-success-cycle-baseline"
            reference = ensure_watchdog_success_reference(
                success,
                baseline,
                now_seconds=10_000,
            )
            self.assertEqual(reference, baseline)
            self.assertTrue(baseline.exists())
            self.assertEqual(baseline.stat().st_mode & 0o777, 0o600)
            self.assertFalse(watchdog_success_reference_overdue(
                reference,
                overdue_minutes=780,
                now_seconds=10_000 + 780 * 60,
            ))
            self.assertTrue(watchdog_success_reference_overdue(
                reference,
                overdue_minutes=780,
                now_seconds=10_000 + 781 * 60,
            ))

            success.write_text("completed\n", encoding="utf-8")
            success.chmod(0o600)
            os.utime(success, (60_000, 60_000))
            reference = ensure_watchdog_success_reference(
                success,
                baseline,
                now_seconds=60_001,
            )
            self.assertEqual(reference, success)
            self.assertFalse(baseline.exists())
            self.assertFalse(watchdog_success_reference_overdue(
                reference,
                overdue_minutes=780,
                now_seconds=60_001,
            ))


class PrivateArtifactPostconditionTests(unittest.TestCase):
    def test_empty_or_zero_cadence_cannot_ack_the_daily_overseer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source-cadence.json"
            for value in ({}, {"twitter": {"cadenceHours": 0, "why": "always"}}):
                path.write_text(json.dumps(value), encoding="utf-8")
                path.chmod(0o600)
                self.assertFalse(source_cadence_valid(path))

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
