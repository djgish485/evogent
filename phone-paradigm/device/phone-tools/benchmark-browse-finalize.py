#!/data/data/com.termux/files/usr/bin/env python3
"""Issue and verify content-free, per-share full-browse benchmark receipts."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


RUN_ID_PATTERN = re.compile(r"^full-browse-[A-Za-z0-9][A-Za-z0-9._:-]{7,140}$")
DIGEST_PATTERN = re.compile(r"^[a-f0-9]{64}$")
TOKEN_PATTERN = DIGEST_PATTERN
RECEIPT_ID_PATTERN = re.compile(r"^benchmark-share-[a-f0-9]{64}$")
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
YOUTUBE_URL = re.compile(
    r"(?:youtube\.com/watch\?(?:[^#\s]*&)?v=|youtu\.be/)([A-Za-z0-9_-]{11})",
    re.IGNORECASE,
)

SOURCE = "youtube"
TERMINAL_TRIGGERED_BY = "phone-benchmark-full-browse"
SHARE_TRIGGERED_BY = "phone-benchmark-full-browse-share"
TERMINAL_PROOF_KIND = "full_browse"
SHARE_PROOF_KIND = "full_browse_share"
TERMINAL_SCHEMA_VERSION = 2
SHARE_SCHEMA_VERSION = 1
STATE_SCHEMA_VERSION = 1
MAX_ITEMS = 5
MAX_RUN_AGE_MS = 30 * 60 * 1000
MAX_SHARE_ARM_AGE_MS = 2 * 60 * 1000
MAX_STATE_BYTES = 32 * 1024

SHARE_PROOF_KEYS = frozenset(
    {
        "schemaVersion",
        "kind",
        "benchmarkRunId",
        "sequence",
        "receiptId",
        "tokenDigest",
        "sourceIdDigest",
        "armedAtMs",
        "fetchedAtMs",
    }
)
PUBLIC_SHARE_KEYS = frozenset(
    {
        "sequence",
        "receiptId",
        "tokenDigest",
        "sourceIdDigest",
        "armedAtMs",
        "fetchedAtMs",
    }
)
TERMINAL_PROOF_KEYS = frozenset(
    {
        "schemaVersion",
        "kind",
        "runId",
        "freshRows",
        "completeRows",
        "sourceSetDigest",
        "shareReceiptSetDigest",
        "shares",
    }
)


class ProofError(Exception):
    """A benchmark proof failed closed."""


def reject(message: str) -> None:
    raise ProofError(message)


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def now_ms() -> int:
    return int(time.time() * 1000)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def run_digest(run_id: str) -> str:
    return sha256_text(run_id)


def receipt_id_for_token_digest(token_digest: str) -> str:
    return f"benchmark-share-{token_digest}"


def validate_run_id(run_id: str) -> None:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        reject("invalid run identity")


def validate_identity(run_id: str, started_at_ms: int) -> None:
    validate_run_id(run_id)
    current_ms = now_ms()
    if (
        not is_int(started_at_ms)
        or started_at_ms < current_ms - MAX_RUN_AGE_MS
        or started_at_ms > current_ms + 5 * 60 * 1000
    ):
        reject("invalid run start")


def parse_object(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def clean_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def row_url(row: sqlite3.Row) -> str:
    payload = parse_object(row["payload_json"])
    return (
        clean_text(row["url"])
        or clean_text(payload.get("url"))
        or clean_text(payload.get("canonicalUrl"))
    )


def row_title(row: sqlite3.Row) -> str:
    payload = parse_object(row["payload_json"])
    return clean_text(row["title"]) or clean_text(payload.get("title"))


def row_is_complete(row: sqlite3.Row) -> bool:
    source_id = clean_text(row["source_id"])
    match = YOUTUBE_URL.search(row_url(row))
    return (
        bool(VIDEO_ID_PATTERN.fullmatch(source_id))
        and len(row_title(row)) > 5
        and match is not None
        and match.group(1) == source_id
    )


def connect_readonly(database: Path) -> sqlite3.Connection:
    if not database.is_file() or database.is_symlink():
        reject("database unavailable")
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    except sqlite3.Error as error:
        reject(f"database unavailable ({type(error).__name__})")
    connection.row_factory = sqlite3.Row
    return connection


def prepare_state_dir(directory: Path) -> None:
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.lstat()
    except OSError:
        reject("private proof state directory unavailable")
    if directory.is_symlink() or not stat.S_ISDIR(info.st_mode):
        reject("private proof state directory is unsafe")
    try:
        os.chmod(directory, 0o700)
    except OSError:
        reject("private proof state directory permissions unavailable")


def state_paths(directory: Path, run_id: str) -> tuple[Path, Path]:
    identity = run_digest(run_id)
    return directory / f"{identity}.json", directory / f"{identity}.lock"


@contextmanager
def lock_state(directory: Path, run_id: str) -> Iterator[Path]:
    prepare_state_dir(directory)
    state_path, lock_path = state_paths(directory, run_id)
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
    except OSError:
        reject("private proof state lock unavailable")
    try:
        yield state_path
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def read_state(path: Path, run_id: str) -> dict[str, Any]:
    try:
        info = path.lstat()
    except OSError:
        reject("benchmark proof state missing")
    if (
        path.is_symlink()
        or not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > MAX_STATE_BYTES
    ):
        reject("benchmark proof state is unsafe")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        reject("benchmark proof state is invalid")
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != STATE_SCHEMA_VERSION
        or value.get("runId") != run_id
        or not is_int(value.get("startedAtMs"))
        or not isinstance(value.get("shares"), list)
        or value.get("pending") is not None
        and not isinstance(value.get("pending"), dict)
    ):
        reject("benchmark proof state identity is invalid")
    validate_identity(run_id, value["startedAtMs"])
    return value


def write_state(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(6)}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, separators=(",", ":"), sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except OSError:
        try:
            temporary.unlink()
        except OSError:
            pass
        reject("benchmark proof state write failed")


def remove_state(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError:
        reject("benchmark proof state cleanup failed")


def validate_sequence(sequence: int) -> None:
    if not is_int(sequence) or sequence < 1 or sequence > MAX_ITEMS:
        reject("share sequence outside benchmark bounds")


def validate_public_share(
    value: Any,
    *,
    run_id: str,
    started_at_ms: int,
    max_completed_at_ms: int,
) -> dict[str, Any]:
    if not isinstance(value, dict) or frozenset(value) != PUBLIC_SHARE_KEYS:
        reject("terminal share proof shape is invalid")
    sequence = value.get("sequence")
    receipt_id = value.get("receiptId")
    token_digest = value.get("tokenDigest")
    source_id_digest = value.get("sourceIdDigest")
    armed_at_ms = value.get("armedAtMs")
    fetched_at_ms = value.get("fetchedAtMs")
    validate_sequence(sequence)
    if (
        not isinstance(token_digest, str)
        or not DIGEST_PATTERN.fullmatch(token_digest)
        or not isinstance(receipt_id, str)
        or not RECEIPT_ID_PATTERN.fullmatch(receipt_id)
        or receipt_id != receipt_id_for_token_digest(token_digest)
        or not isinstance(source_id_digest, str)
        or not DIGEST_PATTERN.fullmatch(source_id_digest)
        or not is_int(armed_at_ms)
        or not is_int(fetched_at_ms)
        or armed_at_ms < started_at_ms
        or fetched_at_ms < armed_at_ms
        or fetched_at_ms > max_completed_at_ms
        or fetched_at_ms - armed_at_ms > MAX_SHARE_ARM_AGE_MS
    ):
        reject("terminal share proof fields are invalid")
    return {
        "sequence": sequence,
        "receiptId": receipt_id,
        "tokenDigest": token_digest,
        "sourceIdDigest": source_id_digest,
        "armedAtMs": armed_at_ms,
        "fetchedAtMs": fetched_at_ms,
    }


def verify_share_receipt(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    started_at_ms: int,
    expected: dict[str, Any],
    max_completed_at_ms: int,
) -> dict[str, Any]:
    receipt_id = expected.get("receiptId")
    if not isinstance(receipt_id, str) or not RECEIPT_ID_PATTERN.fullmatch(receipt_id):
        reject("expected share receipt identity is invalid")
    run = connection.execute(
        """
        SELECT id, source, triggered_by, started_at_ms, completed_at_ms,
               status, items_added, error, metadata_json
        FROM browse_cache_refresh_runs
        WHERE id = ?
        """,
        (receipt_id,),
    ).fetchone()
    if run is None:
        reject("exact per-share receipt missing")

    metadata = parse_object(run["metadata_json"])
    proof = metadata.get("benchmarkShareProof")
    if not isinstance(proof, dict) or frozenset(proof) != SHARE_PROOF_KEYS:
        reject("per-share receipt proof metadata missing")

    candidate = {
        "sequence": proof.get("sequence"),
        "receiptId": proof.get("receiptId"),
        "tokenDigest": proof.get("tokenDigest"),
        "sourceIdDigest": proof.get("sourceIdDigest"),
        "armedAtMs": proof.get("armedAtMs"),
        "fetchedAtMs": proof.get("fetchedAtMs"),
    }
    public_share = validate_public_share(
        candidate,
        run_id=run_id,
        started_at_ms=started_at_ms,
        max_completed_at_ms=max_completed_at_ms,
    )
    if (
        proof.get("schemaVersion") != SHARE_SCHEMA_VERSION
        or proof.get("kind") != SHARE_PROOF_KIND
        or proof.get("benchmarkRunId") != run_id
    ):
        reject("per-share receipt is bound to another benchmark")

    for key in (
        "sequence",
        "receiptId",
        "tokenDigest",
        "armedAtMs",
        "sourceIdDigest",
        "fetchedAtMs",
    ):
        if key in expected and expected[key] != public_share[key]:
            reject("per-share receipt does not match its armed token")

    fetched_at_ms = public_share["fetchedAtMs"]
    if (
        run["id"] != receipt_id
        or run["source"] != SOURCE
        or run["triggered_by"] != SHARE_TRIGGERED_BY
        or int(run["started_at_ms"] or 0) != fetched_at_ms
        or int(run["completed_at_ms"] or 0) != fetched_at_ms
        or run["status"] != "completed"
        or int(run["items_added"] or 0) != 1
        or clean_text(run["error"])
    ):
        reject("per-share receipt fields do not match the share")

    matches: list[sqlite3.Row] = []
    for row in connection.execute(
        """
        SELECT source_id, url, title, payload_json, fetched_at_ms
        FROM browse_cache_items
        WHERE source = ?
        """,
        (SOURCE,),
    ).fetchall():
        if sha256_text(clean_text(row["source_id"])) == public_share["sourceIdDigest"]:
            matches.append(row)
    if (
        len(matches) != 1
        or int(matches[0]["fetched_at_ms"] or 0) != fetched_at_ms
        or not row_is_complete(matches[0])
    ):
        reject("per-share receipt does not bind one complete cache row")
    return public_share


def source_set_digest(shares: list[dict[str, Any]]) -> str:
    values = "\n".join(sorted(share["sourceIdDigest"] for share in shares))
    return sha256_text(values)


def share_receipt_set_digest(shares: list[dict[str, Any]]) -> str:
    canonical = json.dumps(shares, separators=(",", ":"), sort_keys=True)
    return sha256_text(canonical)


def invoke_phone_helper(
    helper: Path,
    command: str,
    arguments: list[str],
    expected_output: str,
) -> None:
    if not helper.is_file():
        reject("authenticated phone helper unavailable")
    try:
        result = subprocess.run(
            [str(helper), command, *arguments],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        reject("authenticated phone proof command failed")
    if result.returncode != 0 or result.stdout.strip() != expected_output:
        reject("authenticated phone proof command was not acknowledged exactly")


def begin_state(directory: Path, *, run_id: str, started_at_ms: int) -> None:
    validate_identity(run_id, started_at_ms)
    with lock_state(directory, run_id) as path:
        if path.exists() or path.is_symlink():
            reject("benchmark proof state already exists")
        write_state(
            path,
            {
                "schemaVersion": STATE_SCHEMA_VERSION,
                "runId": run_id,
                "startedAtMs": started_at_ms,
                "pending": None,
                "shares": [],
            },
        )


def arm_share(
    directory: Path,
    *,
    run_id: str,
    sequence: int,
    phone_helper: Path,
) -> None:
    validate_run_id(run_id)
    validate_sequence(sequence)
    with lock_state(directory, run_id) as path:
        state = read_state(path, run_id)
        shares = state["shares"]
        if state["pending"] is not None:
            reject("a benchmark share is already armed")
        if sequence != len(shares) + 1:
            reject("share sequence is not the next unconfirmed share")
        token = secrets.token_hex(32)
        if not TOKEN_PATTERN.fullmatch(token):
            reject("secure share token generation failed")
        token_digest = sha256_text(token)
        armed_at_ms = now_ms()
        state["pending"] = {
            "sequence": sequence,
            "receiptId": receipt_id_for_token_digest(token_digest),
            "tokenDigest": token_digest,
            "armedAtMs": armed_at_ms,
        }
        write_state(path, state)
        invoke_phone_helper(
            phone_helper,
            "benchmark-share-arm",
            [run_id, str(sequence), token, str(armed_at_ms)],
            f"BROWSE_SHARE_ARMED {sequence}",
        )
    print(f"BROWSE_SHARE_ARMED {sequence}")


def confirm_share(
    directory: Path,
    database: Path,
    *,
    run_id: str,
    sequence: int,
    wait_seconds: float,
) -> None:
    validate_run_id(run_id)
    validate_sequence(sequence)
    with lock_state(directory, run_id) as path:
        state = read_state(path, run_id)
        pending = state.get("pending")
        if not isinstance(pending, dict) or pending.get("sequence") != sequence:
            reject("the requested benchmark share is not armed")
        deadline = time.monotonic() + max(0.0, wait_seconds)
        last_error = "exact per-share receipt missing"
        share: dict[str, Any] | None = None
        while True:
            connection = connect_readonly(database)
            try:
                try:
                    share = verify_share_receipt(
                        connection,
                        run_id=run_id,
                        started_at_ms=state["startedAtMs"],
                        expected=pending,
                        max_completed_at_ms=now_ms(),
                    )
                except ProofError as error:
                    last_error = str(error)
            finally:
                connection.close()
            if share is not None or time.monotonic() >= deadline:
                break
            time.sleep(0.25)
        if share is None:
            reject(last_error)
        if any(
            existing.get("sourceIdDigest") == share["sourceIdDigest"]
            for existing in state["shares"]
            if isinstance(existing, dict)
        ):
            reject("the same video cannot qualify twice")
        state["shares"].append(share)
        state["pending"] = None
        write_state(path, state)
    print(f"BROWSE_SHARE_CONFIRMED {sequence}")


def post_terminal_receipt(
    *,
    curl_path: Path,
    endpoint: str,
    run_id: str,
    started_at_ms: int,
    completed_at_ms: int,
    shares: list[dict[str, Any]],
) -> None:
    count = len(shares)
    payload = {
        "runId": run_id,
        "source": SOURCE,
        "triggeredBy": TERMINAL_TRIGGERED_BY,
        "startedAtMs": started_at_ms,
        "completedAtMs": completed_at_ms,
        "status": "completed",
        "itemsAdded": count,
        "items": [],
        "metadata": {
            "benchmarkProof": {
                "schemaVersion": TERMINAL_SCHEMA_VERSION,
                "kind": TERMINAL_PROOF_KIND,
                "runId": run_id,
                "freshRows": count,
                "completeRows": count,
                "sourceSetDigest": source_set_digest(shares),
                "shareReceiptSetDigest": share_receipt_set_digest(shares),
                "shares": shares,
            },
        },
    }
    if not curl_path.is_file():
        reject("authenticated loopback client unavailable")
    try:
        result = subprocess.run(
            [
                str(curl_path),
                "-sS",
                "-m",
                "15",
                "-X",
                "POST",
                endpoint,
                "-H",
                "content-type: application/json",
                "--data-binary",
                json.dumps(payload, separators=(",", ":")),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        reject("terminal receipt request failed")
    if result.returncode != 0:
        reject("terminal receipt request failed")
    try:
        response = json.loads(result.stdout)
    except ValueError:
        reject("terminal receipt response was invalid")
    run = response.get("run") if isinstance(response, dict) else None
    if (
        not isinstance(response, dict)
        or response.get("ok") is not True
        or not isinstance(run, dict)
        or run.get("id") != run_id
        or run.get("status") != "completed"
        or run.get("itemsAdded") != count
    ):
        reject("terminal receipt was not acknowledged exactly")


def finalize_state(
    directory: Path,
    database: Path,
    *,
    run_id: str,
    started_at_ms: int,
    declared_count: int,
    curl_path: Path,
    endpoint: str,
) -> None:
    validate_identity(run_id, started_at_ms)
    if declared_count < 1 or declared_count > MAX_ITEMS:
        reject("declared count outside benchmark bounds")
    with lock_state(directory, run_id) as path:
        state = read_state(path, run_id)
        if state["startedAtMs"] != started_at_ms:
            reject("benchmark start does not match private state")
        if state["pending"] is not None:
            reject("an armed share has not been confirmed")
        if len(state["shares"]) != declared_count:
            reject("declared count does not match confirmed shares")

        completed_at_ms = now_ms()
        connection = connect_readonly(database)
        try:
            shares = [
                verify_share_receipt(
                    connection,
                    run_id=run_id,
                    started_at_ms=started_at_ms,
                    expected=expected,
                    max_completed_at_ms=completed_at_ms,
                )
                for expected in state["shares"]
                if isinstance(expected, dict)
            ]
        finally:
            connection.close()
        if len(shares) != declared_count:
            reject("private share proof state is invalid")
        if [share["sequence"] for share in shares] != list(range(1, declared_count + 1)):
            reject("confirmed share sequence is not exact")
        if len({share["sourceIdDigest"] for share in shares}) != declared_count:
            reject("confirmed shares are not distinct")

        post_terminal_receipt(
            curl_path=curl_path,
            endpoint=endpoint,
            run_id=run_id,
            started_at_ms=started_at_ms,
            completed_at_ms=completed_at_ms,
            shares=shares,
        )
    print(f"BROWSE_BENCHMARK_RECEIPT {run_id} {declared_count}")


def verify_terminal_receipt(
    database: Path,
    *,
    run_id: str,
    started_at_ms: int,
    max_completed_at_ms: int,
) -> dict[str, Any]:
    validate_identity(run_id, started_at_ms)
    if not is_int(max_completed_at_ms) or max_completed_at_ms < started_at_ms:
        reject("invalid benchmark completion bound")
    connection = connect_readonly(database)
    try:
        run = connection.execute(
            """
            SELECT id, source, triggered_by, started_at_ms, completed_at_ms,
                   status, items_added, error, metadata_json
            FROM browse_cache_refresh_runs
            WHERE id = ?
            """,
            (run_id,),
        ).fetchone()
        if run is None:
            reject("exact terminal receipt missing")
        completed_at_ms = int(run["completed_at_ms"] or 0)
        count = int(run["items_added"] or 0)
        if (
            run["source"] != SOURCE
            or run["triggered_by"] != TERMINAL_TRIGGERED_BY
            or int(run["started_at_ms"] or 0) != started_at_ms
            or completed_at_ms < started_at_ms
            or completed_at_ms > max_completed_at_ms
            or run["status"] != "completed"
            or count < 1
            or count > MAX_ITEMS
            or clean_text(run["error"])
        ):
            reject("terminal receipt fields do not match the benchmark run")

        metadata = parse_object(run["metadata_json"])
        proof = metadata.get("benchmarkProof")
        if not isinstance(proof, dict) or frozenset(proof) != TERMINAL_PROOF_KEYS:
            reject("terminal receipt proof metadata missing")
        raw_shares = proof.get("shares")
        if not isinstance(raw_shares, list) or len(raw_shares) != count:
            reject("terminal receipt share set is invalid")
        shares = [
            validate_public_share(
                value,
                run_id=run_id,
                started_at_ms=started_at_ms,
                max_completed_at_ms=completed_at_ms,
            )
            for value in raw_shares
        ]
        if (
            proof.get("schemaVersion") != TERMINAL_SCHEMA_VERSION
            or proof.get("kind") != TERMINAL_PROOF_KIND
            or proof.get("runId") != run_id
            or proof.get("freshRows") != count
            or proof.get("completeRows") != count
            or proof.get("sourceSetDigest") != source_set_digest(shares)
            or proof.get("shareReceiptSetDigest") != share_receipt_set_digest(shares)
            or [share["sequence"] for share in shares] != list(range(1, count + 1))
            or len({share["receiptId"] for share in shares}) != count
            or len({share["tokenDigest"] for share in shares}) != count
            or len({share["sourceIdDigest"] for share in shares}) != count
        ):
            reject("terminal receipt does not bind an exact per-share proof set")

        verified = [
            verify_share_receipt(
                connection,
                run_id=run_id,
                started_at_ms=started_at_ms,
                expected=share,
                max_completed_at_ms=completed_at_ms,
            )
            for share in shares
        ]
        if verified != shares:
            reject("terminal receipt per-share verification changed")
    finally:
        connection.close()

    return {
        "terminalProof": True,
        "terminalItems": count,
        "freshRows": count,
        "completeRows": count,
        "runDigest": run_digest(run_id),
    }


def cleanup_state(
    directory: Path,
    *,
    run_id: str,
    phone_helper: Path,
) -> None:
    validate_run_id(run_id)
    cleanup_error: ProofError | None = None
    try:
        invoke_phone_helper(
            phone_helper,
            "benchmark-share-clear",
            [run_id],
            "BROWSE_SHARE_CLEARED",
        )
    except ProofError as error:
        cleanup_error = error
    with lock_state(directory, run_id) as path:
        remove_state(path)
    _, lock_path = state_paths(directory, run_id)
    remove_state(lock_path)
    if cleanup_error is not None:
        raise cleanup_error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--database",
        default=os.path.expanduser("~/evogent/data/media-agent.db"),
    )
    parser.add_argument(
        "--state-dir",
        default=os.path.expanduser("~/phone-tools/.browse-benchmark-proof"),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    begin = subparsers.add_parser("begin")
    begin.add_argument("--run-id", required=True)
    begin.add_argument("--started-at-ms", required=True, type=int)

    arm = subparsers.add_parser("arm-share")
    arm.add_argument("--run-id", required=True)
    arm.add_argument("--sequence", required=True, type=int)
    arm.add_argument(
        "--phone-helper",
        default=os.path.expanduser("~/phone-tools/phone.sh"),
    )

    confirm = subparsers.add_parser("confirm-share")
    confirm.add_argument("--run-id", required=True)
    confirm.add_argument("--sequence", required=True, type=int)
    confirm.add_argument("--wait-seconds", type=float, default=20.0)

    finalize = subparsers.add_parser("finalize")
    finalize.add_argument("--run-id", required=True)
    finalize.add_argument("--started-at-ms", required=True, type=int)
    finalize.add_argument("--declared-count", required=True, type=int)
    finalize.add_argument(
        "--curl",
        default=os.environ.get(
            "EVOGENT_API_CURL",
            os.path.expanduser("~/phone-tools/evo-curl"),
        ),
    )
    finalize.add_argument(
        "--endpoint",
        default=f"http://127.0.0.1:{os.environ.get('PORT', '3001')}"
        "/api/internal/browse-cache/submit",
    )

    verify = subparsers.add_parser("verify")
    verify.add_argument("--run-id", required=True)
    verify.add_argument("--started-at-ms", required=True, type=int)
    verify.add_argument("--max-completed-at-ms", required=True, type=int)

    cleanup = subparsers.add_parser("cleanup")
    cleanup.add_argument("--run-id", required=True)
    cleanup.add_argument(
        "--phone-helper",
        default=os.path.expanduser("~/phone-tools/phone.sh"),
    )
    return parser


def run_command(args: argparse.Namespace) -> int:
    database = Path(args.database).expanduser()
    state_dir = Path(args.state_dir).expanduser()

    if args.command == "begin":
        begin_state(
            state_dir,
            run_id=args.run_id,
            started_at_ms=args.started_at_ms,
        )
        print(f"BROWSE_BENCHMARK_READY {args.run_id}")
        return 0
    if args.command == "arm-share":
        arm_share(
            state_dir,
            run_id=args.run_id,
            sequence=args.sequence,
            phone_helper=Path(args.phone_helper).expanduser(),
        )
        return 0
    if args.command == "confirm-share":
        confirm_share(
            state_dir,
            database,
            run_id=args.run_id,
            sequence=args.sequence,
            wait_seconds=args.wait_seconds,
        )
        return 0
    if args.command == "finalize":
        finalize_state(
            state_dir,
            database,
            run_id=args.run_id,
            started_at_ms=args.started_at_ms,
            declared_count=args.declared_count,
            curl_path=Path(args.curl).expanduser(),
            endpoint=args.endpoint,
        )
        return 0
    if args.command == "cleanup":
        cleanup_state(
            state_dir,
            run_id=args.run_id,
            phone_helper=Path(args.phone_helper).expanduser(),
        )
        return 0

    proof = verify_terminal_receipt(
        database,
        run_id=args.run_id,
        started_at_ms=args.started_at_ms,
        max_completed_at_ms=args.max_completed_at_ms,
    )
    print(json.dumps(proof, separators=(",", ":")))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run_command(args)
    except ProofError as error:
        print(f"benchmark proof rejected: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
