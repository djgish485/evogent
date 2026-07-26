#!/data/data/com.termux/files/usr/bin/env python3
"""Small durable task queue for Evogent's phone-side control plane.

The queue intentionally contains no editorial policy.  It only provides mechanics:

    queued -> leased -> acknowledged
                        -> queued (bounded retry)
                        -> quarantined

Queue files live directly under ``root`` for compatibility with the original
``data/phone-sources/.queue/*.json`` producers.  Leases, receipts, and quarantined
requests live in private subdirectories.  Every transition is an fsync'd atomic
replace under a flock, so a killed scheduler can recover an expired lease without
silently losing the request.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Iterator


DEFAULT_MAX_ATTEMPTS = 4
DEFAULT_LEASE_MS = 30 * 60 * 1000
BASE_BACKOFF_MS = 5 * 60 * 1000
MAX_BACKOFF_MS = 6 * 60 * 60 * 1000
TASK_ID_RE = re.compile(r"[^A-Za-z0-9_.-]+")


class TaskQueueError(RuntimeError):
    pass


def now_ms() -> int:
    return int(time.time() * 1000)


def safe_task_id(value: object) -> str:
    text = TASK_ID_RE.sub("-", str(value or "").strip()).strip(".-")
    return text[:120] or f"task-{secrets.token_hex(6)}"


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, separators=(",", ":"), sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        os.chmod(path, 0o600)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            # Some Android filesystems do not permit fsync on directory descriptors.
            pass
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise TaskQueueError("request must be a JSON object")
    return value


def _paths(root: Path) -> dict[str, Path]:
    return {
        "leased": root / ".leased",
        "receipts": root / ".receipts",
        "quarantine": root / ".quarantine",
    }


@contextlib.contextmanager
def queue_lock(root: Path) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    for directory in _paths(root).values():
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
    lock_path = root / ".tasks.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def retry_backoff_ms(attempt: int) -> int:
    # attempt is one-based.  5m, 10m, 20m, ... bounded at six hours.
    return min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** max(0, attempt - 1)))


def _normalise_request(
    value: dict[str, Any],
    *,
    fallback_id: str,
    created_at_ms: int,
) -> dict[str, Any]:
    request = dict(value)
    request["taskId"] = safe_task_id(request.get("taskId") or fallback_id)
    request["kind"] = str(request.get("kind") or "discovery").strip().lower()
    request["state"] = "queued"
    request["createdAtMs"] = int(request.get("createdAtMs") or created_at_ms)
    request["updatedAtMs"] = created_at_ms
    request["attempt"] = max(0, int(request.get("attempt") or 0))
    request["maxAttempts"] = max(
        1, min(20, int(request.get("maxAttempts") or DEFAULT_MAX_ATTEMPTS))
    )
    request["notBeforeMs"] = max(0, int(request.get("notBeforeMs") or created_at_ms))
    request.pop("lease", None)
    return request


def _request_is_valid(request: dict[str, Any]) -> tuple[bool, str]:
    kind = request.get("kind")
    if kind == "discovery":
        required = ("pkg", "name", "source")
    elif kind == "research":
        required = ("pkg",)
    elif kind in {"dream", "reflect"}:
        required = ("serviceDate",)
    else:
        return False, f"unsupported kind {kind!r}"
    for field in required:
        if not str(request.get(field) or "").strip():
            return False, f"missing required field {field}"
    return True, ""


def _receipt_path(root: Path, request: dict[str, Any], transition: str, stamp: int) -> Path:
    task_id = safe_task_id(request.get("taskId"))
    attempt = max(0, int(request.get("attempt") or 0))
    return _paths(root)["receipts"] / (
        f"{task_id}-attempt-{attempt:02d}-{stamp}-{safe_task_id(transition)}.json"
    )


def _write_transition_receipt(
    root: Path,
    request: dict[str, Any],
    *,
    transition: str,
    outcome: str,
    detail: str,
    stamp: int,
) -> dict[str, Any]:
    receipt = {
        "version": 1,
        "taskId": request.get("taskId"),
        "kind": request.get("kind"),
        "attempt": int(request.get("attempt") or 0),
        "transition": transition,
        "outcome": str(outcome or transition),
        "detail": str(detail or "")[:500],
        "recordedAtMs": stamp,
    }
    atomic_write_json(_receipt_path(root, request, transition, stamp), receipt)
    return receipt


def enqueue_task(
    root: Path | str,
    payload: dict[str, Any],
    *,
    task_id: str | None = None,
    stamp: int | None = None,
) -> dict[str, Any]:
    root = Path(root)
    stamp = now_ms() if stamp is None else int(stamp)
    fallback_id = task_id or payload.get("taskId") or payload.get("source")
    if not fallback_id and payload.get("kind") == "research":
        fallback_id = f"research-{payload.get('pkg', '')}"
    request = _normalise_request(payload, fallback_id=safe_task_id(fallback_id), created_at_ms=stamp)
    valid, error = _request_is_valid(request)
    if not valid:
        raise TaskQueueError(error)
    queue_path = root / f"{request['taskId']}.json"
    with queue_lock(root):
        paths = _paths(root)
        existing = [
            queue_path,
            paths["leased"] / queue_path.name,
            paths["quarantine"] / queue_path.name,
            paths["receipts"] / f"{request['taskId']}-final.json",
        ]
        if any(path.exists() for path in existing):
            return {"created": False, "taskId": request["taskId"], "path": str(queue_path)}
        atomic_write_json(queue_path, request)
    return {"created": True, "taskId": request["taskId"], "path": str(queue_path)}


def _quarantine_locked(
    root: Path,
    source_path: Path,
    request: dict[str, Any],
    *,
    outcome: str,
    detail: str,
    stamp: int,
) -> dict[str, Any]:
    quarantined = dict(request)
    quarantined.update(
        {
            "state": "quarantined",
            "outcome": outcome,
            "detail": str(detail or "")[:500],
            "updatedAtMs": stamp,
            "quarantinedAtMs": stamp,
        }
    )
    destination = _paths(root)["quarantine"] / f"{safe_task_id(request.get('taskId'))}.json"
    atomic_write_json(destination, quarantined)
    _write_transition_receipt(
        root,
        quarantined,
        transition="quarantine",
        outcome=outcome,
        detail=detail,
        stamp=stamp,
    )
    try:
        source_path.unlink()
    except FileNotFoundError:
        pass
    return {"action": "quarantine", "path": str(destination), "task": quarantined}


def _recover_expired_leases_locked(root: Path, stamp: int) -> None:
    for lease_path in sorted(_paths(root)["leased"].glob("*.json")):
        try:
            request = read_json(lease_path)
        except Exception as error:
            request = {
                "taskId": safe_task_id(lease_path.stem),
                "kind": "unknown",
                "attempt": DEFAULT_MAX_ATTEMPTS,
            }
            _quarantine_locked(
                root,
                lease_path,
                request,
                outcome="malformed_lease",
                detail=str(error),
                stamp=stamp,
            )
            continue

        task_id = safe_task_id(request.get("taskId") or lease_path.stem)
        final_receipt = _paths(root)["receipts"] / f"{task_id}-final.json"
        if final_receipt.exists():
            # Ack was made durable before an abrupt stop prevented lease cleanup.
            lease_path.unlink(missing_ok=True)
            continue
        quarantine_path = _paths(root)["quarantine"] / f"{task_id}.json"
        if quarantine_path.exists():
            # Quarantine was made durable before an abrupt stop prevented lease cleanup.
            lease_path.unlink(missing_ok=True)
            continue
        lease = request.get("lease") if isinstance(request.get("lease"), dict) else {}
        expires = int(lease.get("expiresAtMs") or 0)
        if expires > stamp:
            continue
        attempt = max(0, int(request.get("attempt") or 0))
        max_attempts = max(1, int(request.get("maxAttempts") or DEFAULT_MAX_ATTEMPTS))
        if attempt >= max_attempts:
            _quarantine_locked(
                root,
                lease_path,
                request,
                outcome="lease_expired",
                detail="worker did not acknowledge the final lease before its deadline",
                stamp=stamp,
            )
            continue
        queued = dict(request)
        queued.update(
            {
                "state": "queued",
                "updatedAtMs": stamp,
                "notBeforeMs": stamp + retry_backoff_ms(max(1, attempt)),
                "lastOutcome": "lease_expired",
                "lastDetail": "worker stopped before acknowledging its lease",
            }
        )
        queued.pop("lease", None)
        destination = root / f"{task_id}.json"
        atomic_write_json(destination, queued)
        _write_transition_receipt(
            root,
            queued,
            transition="retry",
            outcome="lease_expired",
            detail="expired lease recovered by the next scheduler pass",
            stamp=stamp,
        )
        lease_path.unlink(missing_ok=True)


def _priority(request: dict[str, Any], path: Path) -> tuple[float, float, str]:
    if request.get("kind") == "research":
        try:
            return (0, float(request.get("installedDaysAgo")), path.name)
        except (TypeError, ValueError):
            return (0, float("inf"), path.name)
    if request.get("kind") in {"dream", "reflect"}:
        return (1, float(request.get("notBeforeMs") or 0), path.name)
    return (2, float(request.get("createdAtMs") or 0), path.name)


def claim_task(
    root: Path | str,
    *,
    owner: str,
    stamp: int | None = None,
    lease_ms: int = DEFAULT_LEASE_MS,
    kind: str | None = None,
) -> dict[str, Any] | None:
    root = Path(root)
    stamp = now_ms() if stamp is None else int(stamp)
    with queue_lock(root):
        _recover_expired_leases_locked(root, stamp)
        candidates: list[tuple[tuple[float, float, str], Path, dict[str, Any]]] = []
        for path in sorted(root.glob("*.json")):
            try:
                raw = read_json(path)
                legacy_created_at = int(path.stat().st_mtime * 1000)
                request = _normalise_request(
                    raw,
                    fallback_id=path.stem,
                    created_at_ms=legacy_created_at,
                )
            except Exception as error:
                _quarantine_locked(
                    root,
                    path,
                    {"taskId": safe_task_id(path.stem), "kind": "unknown", "attempt": 0},
                    outcome="malformed_request",
                    detail=str(error),
                    stamp=stamp,
                )
                continue
            valid, error = _request_is_valid(request)
            if not valid:
                _quarantine_locked(
                    root,
                    path,
                    request,
                    outcome="invalid_request",
                    detail=error,
                    stamp=stamp,
                )
                continue
            if kind and request.get("kind") != kind:
                continue
            task_id = safe_task_id(request.get("taskId") or path.stem)
            # A retry transition writes the replacement queue file before dropping its lease.
            # If power dies between those two operations, never claim the duplicate base file
            # while the original lease remains authoritative.
            if (_paths(root)["leased"] / f"{task_id}.json").exists():
                continue
            if int(request.get("notBeforeMs") or 0) > stamp:
                continue
            candidates.append((_priority(request, path), path, request))
        if not candidates:
            return None
        _, queue_path, request = min(candidates, key=lambda item: item[0])
        task_id = safe_task_id(request.get("taskId") or queue_path.stem)
        lease_path = _paths(root)["leased"] / f"{task_id}.json"
        # The rename is the ownership linearization point.  If power dies before the
        # following rewrite, the next pass treats the missing lease metadata as expired.
        os.replace(queue_path, lease_path)
        attempt = int(request.get("attempt") or 0) + 1
        leased = dict(request)
        leased.update(
            {
                "state": "leased",
                "attempt": attempt,
                "updatedAtMs": stamp,
                "lease": {
                    "id": secrets.token_hex(12),
                    "owner": str(owner or "scheduler")[:200],
                    "leasedAtMs": stamp,
                    "expiresAtMs": stamp + max(1_000, int(lease_ms)),
                },
            }
        )
        atomic_write_json(lease_path, leased)
        return {**leased, "leasePath": str(lease_path)}


def finish_task(
    root: Path | str,
    lease_path: Path | str,
    *,
    result: str,
    outcome: str,
    detail: str = "",
    stamp: int | None = None,
) -> dict[str, Any]:
    root = Path(root)
    lease_path = Path(lease_path)
    stamp = now_ms() if stamp is None else int(stamp)
    result = result.strip().lower()
    if result not in {"ack", "retry", "quarantine"}:
        raise TaskQueueError("result must be ack, retry, or quarantine")
    with queue_lock(root):
        expected_parent = _paths(root)["leased"].resolve()
        try:
            resolved = lease_path.resolve(strict=True)
        except FileNotFoundError as error:
            raise TaskQueueError("lease no longer exists") from error
        if resolved.parent != expected_parent:
            raise TaskQueueError("lease path is outside this queue")
        request = read_json(resolved)
        if request.get("state") != "leased" or not isinstance(request.get("lease"), dict):
            raise TaskQueueError("request is not an active lease")
        task_id = safe_task_id(request.get("taskId") or resolved.stem)
        attempt = max(1, int(request.get("attempt") or 1))
        max_attempts = max(1, int(request.get("maxAttempts") or DEFAULT_MAX_ATTEMPTS))
        if result == "ack":
            acknowledged = dict(request)
            acknowledged.update(
                {
                    "state": "acknowledged",
                    "outcome": outcome or "completed",
                    "detail": str(detail or "")[:500],
                    "updatedAtMs": stamp,
                    "completedAtMs": stamp,
                }
            )
            acknowledged.pop("lease", None)
            final_path = _paths(root)["receipts"] / f"{task_id}-final.json"
            atomic_write_json(final_path, acknowledged)
            _write_transition_receipt(
                root,
                acknowledged,
                transition="ack",
                outcome=outcome,
                detail=detail,
                stamp=stamp,
            )
            resolved.unlink(missing_ok=True)
            return {"action": "ack", "path": str(final_path), "task": acknowledged}
        if result == "quarantine" or attempt >= max_attempts:
            return _quarantine_locked(
                root,
                resolved,
                request,
                outcome=outcome or "attempts_exhausted",
                detail=detail or f"attempt {attempt} of {max_attempts} failed",
                stamp=stamp,
            )
        queued = dict(request)
        queued.update(
            {
                "state": "queued",
                "updatedAtMs": stamp,
                "notBeforeMs": stamp + retry_backoff_ms(attempt),
                "lastOutcome": outcome or "retry",
                "lastDetail": str(detail or "")[:500],
            }
        )
        queued.pop("lease", None)
        queue_path = root / f"{task_id}.json"
        atomic_write_json(queue_path, queued)
        _write_transition_receipt(
            root,
            queued,
            transition="retry",
            outcome=outcome,
            detail=detail,
            stamp=stamp,
        )
        resolved.unlink(missing_ok=True)
        return {
            "action": "retry",
            "path": str(queue_path),
            "notBeforeMs": queued["notBeforeMs"],
            "task": queued,
        }


def acknowledge_queued_task(
    root: Path | str,
    task_id: str,
    *,
    outcome: str,
    detail: str = "",
    stamp: int | None = None,
) -> dict[str, Any]:
    """Durably acknowledge a request before it is leased.

    This is used when the source announcement submit proves the same suggestion was already
    handled.  The old scout simply unlinked the request; a final receipt now explains why no
    discovery worker should run it.
    """

    root = Path(root)
    stamp = now_ms() if stamp is None else int(stamp)
    task_id = safe_task_id(task_id)
    with queue_lock(root):
        final_path = _paths(root)["receipts"] / f"{task_id}-final.json"
        if final_path.exists():
            return {"action": "ack", "path": str(final_path), "existing": True}
        queue_path = root / f"{task_id}.json"
        if not queue_path.exists():
            raise TaskQueueError("queued request no longer exists")
        request = _normalise_request(
            read_json(queue_path),
            fallback_id=task_id,
            created_at_ms=int(queue_path.stat().st_mtime * 1000),
        )
        acknowledged = dict(request)
        acknowledged.update(
            {
                "state": "acknowledged",
                "outcome": outcome,
                "detail": str(detail or "")[:500],
                "updatedAtMs": stamp,
                "completedAtMs": stamp,
            }
        )
        acknowledged.pop("lease", None)
        atomic_write_json(final_path, acknowledged)
        _write_transition_receipt(
            root,
            acknowledged,
            transition="ack",
            outcome=outcome,
            detail=detail,
            stamp=stamp,
        )
        queue_path.unlink(missing_ok=True)
        return {"action": "ack", "path": str(final_path), "task": acknowledged}


def _local_due(service_date: dt.date, hour: int) -> dt.datetime:
    # A naive datetime's timestamp() applies the host's full local-time rules for that date.
    # Reusing ``now().astimezone().tzinfo`` would freeze today's UTC offset and mis-schedule the
    # configured local-hour task across a daylight-saving transition.
    return dt.datetime.combine(service_date, dt.time(hour=hour))


def ensure_nightly_task(
    root: Path | str,
    *,
    task: str,
    hour: int,
    stamp: int | None = None,
    legacy_stamp: Path | str | None = None,
) -> dict[str, Any]:
    """Ensure today's named nightly task exists, even before it becomes due."""

    root = Path(root)
    stamp = now_ms() if stamp is None else int(stamp)
    current = dt.datetime.fromtimestamp(stamp / 1000).astimezone()
    service_date = current.date()
    due = _local_due(service_date, hour)
    due_ms = int(due.timestamp() * 1000)
    task_id = safe_task_id(f"{task}-{service_date.isoformat()}")

    if legacy_stamp:
        legacy_path = Path(legacy_stamp)
        try:
            raw = legacy_path.read_text(encoding="utf-8").strip()
            legacy_ms = int(raw) * 1000 if raw.isdigit() else int(legacy_path.stat().st_mtime * 1000)
            legacy_at = dt.datetime.fromtimestamp(legacy_ms / 1000).astimezone()
            if legacy_at.date() == service_date and legacy_ms >= due_ms:
                with queue_lock(root):
                    final_path = _paths(root)["receipts"] / f"{task_id}-final.json"
                    if not final_path.exists():
                        migrated = {
                            "version": 1,
                            "taskId": task_id,
                            "kind": task,
                            "serviceDate": service_date.isoformat(),
                            "state": "acknowledged",
                            "outcome": "legacy_completion_migrated",
                            "attempt": 0,
                            "createdAtMs": due_ms,
                            "updatedAtMs": legacy_ms,
                            "completedAtMs": legacy_ms,
                        }
                        atomic_write_json(final_path, migrated)
        except (OSError, ValueError):
            pass

    result = enqueue_task(
        root,
        {
            "kind": task,
            "serviceDate": service_date.isoformat(),
            "notBeforeMs": due_ms,
            "createdAtMs": due_ms,
            "maxAttempts": 6,
        },
        task_id=task_id,
        stamp=stamp,
    )
    return {**result, "dueAtMs": due_ms, "serviceDate": service_date.isoformat()}


def _json_print(value: object) -> None:
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    enqueue = sub.add_parser("enqueue")
    enqueue.add_argument("--root", required=True)
    enqueue.add_argument(
        "--kind",
        required=True,
        choices=("discovery", "research", "dream", "reflect"),
    )
    enqueue.add_argument("--task-id")
    enqueue.add_argument("--pkg")
    enqueue.add_argument("--name")
    enqueue.add_argument("--source")
    enqueue.add_argument("--installed-days-ago", type=float)
    enqueue.add_argument("--service-date")
    enqueue.add_argument("--not-before-ms", type=int)
    enqueue.add_argument("--max-attempts", type=int)
    enqueue.add_argument("--now-ms", type=int)

    claim = sub.add_parser("claim")
    claim.add_argument("--root", required=True)
    claim.add_argument("--owner", required=True)
    claim.add_argument("--kind", choices=("discovery", "research", "dream", "reflect"))
    claim.add_argument("--lease-ms", type=int, default=DEFAULT_LEASE_MS)
    claim.add_argument("--now-ms", type=int)

    finish = sub.add_parser("finish")
    finish.add_argument("--root", required=True)
    finish.add_argument("--lease", required=True)
    finish.add_argument("--result", required=True, choices=("ack", "retry", "quarantine"))
    finish.add_argument("--outcome", required=True)
    finish.add_argument("--detail", default="")
    finish.add_argument("--now-ms", type=int)

    ack_queued = sub.add_parser("ack-queued")
    ack_queued.add_argument("--root", required=True)
    ack_queued.add_argument("--task-id", required=True)
    ack_queued.add_argument("--outcome", required=True)
    ack_queued.add_argument("--detail", default="")
    ack_queued.add_argument("--now-ms", type=int)

    nightly = sub.add_parser("ensure-nightly")
    nightly.add_argument("--root", required=True)
    nightly.add_argument("--task", default="dream", choices=("dream", "reflect"))
    nightly.add_argument("--hour", type=int, default=0)
    nightly.add_argument("--legacy-stamp")
    nightly.add_argument("--now-ms", type=int)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "enqueue":
            payload: dict[str, Any] = {"kind": args.kind}
            for field, value in (
                ("pkg", args.pkg),
                ("name", args.name),
                ("source", args.source),
                ("installedDaysAgo", args.installed_days_ago),
                ("serviceDate", args.service_date),
                ("notBeforeMs", args.not_before_ms),
                ("maxAttempts", args.max_attempts),
            ):
                if value is not None:
                    payload[field] = value
            _json_print(
                enqueue_task(
                    args.root,
                    payload,
                    task_id=args.task_id,
                    stamp=args.now_ms,
                )
            )
        elif args.command == "claim":
            _json_print(
                claim_task(
                    args.root,
                    owner=args.owner,
                    stamp=args.now_ms,
                    lease_ms=args.lease_ms,
                    kind=args.kind,
                )
                or {}
            )
        elif args.command == "finish":
            _json_print(
                finish_task(
                    args.root,
                    args.lease,
                    result=args.result,
                    outcome=args.outcome,
                    detail=args.detail,
                    stamp=args.now_ms,
                )
            )
        elif args.command == "ack-queued":
            _json_print(
                acknowledge_queued_task(
                    args.root,
                    args.task_id,
                    outcome=args.outcome,
                    detail=args.detail,
                    stamp=args.now_ms,
                )
            )
        elif args.command == "ensure-nightly":
            if not 0 <= args.hour <= 23:
                raise TaskQueueError("hour must be 0..23")
            _json_print(
                ensure_nightly_task(
                    args.root,
                    task=args.task,
                    hour=args.hour,
                    stamp=args.now_ms,
                    legacy_stamp=args.legacy_stamp,
                )
            )
        return 0
    except (OSError, ValueError, TaskQueueError) as error:
        print(f"durable-task-queue: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
