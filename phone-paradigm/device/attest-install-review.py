#!/data/data/com.termux/files/usr/bin/python3
"""Record one transaction-bound fresh-display-0 Android install attestation."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import sys
import time

JOURNAL_SCHEMA = "evogent.phone.install-transaction.v6"
ATTESTATION_SCHEMA = "evogent.phone.install-review-attestation.v1"
ACTION_EVIDENCE = "fresh_display_0_operator_attestation_v1"
DISPLAY_EVIDENCE = "fresh_display_0_operator_v1"
MAX_JOURNAL_BYTES = 131_072


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"install review attestation: {message}")


def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def private_file_bytes(path: pathlib.Path, maximum: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        fail(f"{path.name} is unavailable or unsafe")
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid != os.getuid()
            or metadata.st_nlink != 1
            or metadata.st_size < 2
            or metadata.st_size > maximum
        ):
            fail(f"{path.name} is not one private bounded regular file")
        payload = b""
        while len(payload) <= maximum:
            chunk = os.read(descriptor, maximum + 1 - len(payload))
            if not chunk:
                break
            payload += chunk
        if len(payload) > maximum:
            fail(f"{path.name} is oversized")
        return payload
    finally:
        os.close(descriptor)


def read_journal(path: pathlib.Path, root: pathlib.Path) -> tuple[bytes, dict]:
    raw = private_file_bytes(path, MAX_JOURNAL_BYTES)
    try:
        data = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicate_keys,
        )
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        fail("journal JSON is invalid")
    if not isinstance(data, dict):
        fail("journal payload is invalid")
    if (
        data.get("schema") != JOURNAL_SCHEMA
        or data.get("root") != str(root)
        or data.get("phase") != "apk_user_action_required"
        or data.get("apkUserActionKind") != "android_install_review"
        or data.get("apkUserActionPurpose")
        not in {"candidate_install", "rollback_restore"}
        or data.get("apkUserActionEvidence") != ACTION_EVIDENCE
        or data.get("apkChanged") != 1
        or data.get("apkInstallAttempted") != 1
        or data.get("apkBackupReady") != 1
        or data.get("packageOperation") != ""
        or data.get("packageOperationState") != ""
        or data.get("controlTokenBridge") != ""
    ):
        fail("journal is not waiting for this operator attestation")
    release_id = data.get("releaseId")
    migration_dir = data.get("migrationDir")
    if (
        not isinstance(release_id, str)
        or re.fullmatch(r"[A-Za-z0-9._-]{1,120}", release_id) is None
        or not isinstance(migration_dir, str)
        or pathlib.Path(migration_dir).parent != root / "migrations"
    ):
        fail("journal transaction identity is invalid")
    if (
        re.fullmatch(
            r"[0-9a-f]{64}",
            str(data.get("apkUserActionTargetSha256", "")),
        )
        is None
        or re.fullmatch(
            r"[0-9a-f]{64}",
            str(data.get("apkUserActionTargetSignerSha256", "")),
        )
        is None
        or type(data.get("apkUserActionTargetVersionCode")) is not int
        or not 1 <= data["apkUserActionTargetVersionCode"] <= 9_223_372_036_854_775_807
        or re.fullmatch(
            r"[0-9a-f]{64}",
            str(data.get("apkUserActionChallenge", "")),
        )
        is None
        or type(data.get("apkUserActionChallengeCreatedAtEpochSeconds")) is not int
        or type(data.get("apkUserActionChallengeExpiresAtEpochSeconds")) is not int
        or type(data.get("apkUserActionTrustedVerifierObserved")) is not int
        or data["apkUserActionTrustedVerifierObserved"] not in {0, 1}
        or type(data.get("apkInstallScanRequired")) is not int
        or data["apkInstallScanRequired"] not in {0, 1}
        or data["apkInstallScanRequired"]
        != data["apkUserActionTrustedVerifierObserved"]
        or type(data.get("apkRollbackRetryGeneration")) is not int
        or data["apkRollbackRetryGeneration"] not in {0, 1}
    ):
        fail("journal attestation authority is invalid")
    if (
        data["apkUserActionPurpose"] == "candidate_install"
        and data["apkRollbackRetryGeneration"] != 0
    ) or (
        data["apkUserActionPurpose"] == "rollback_restore"
        and data["apkRollbackRetryGeneration"] != 1
    ):
        fail("journal install-review generation is invalid")
    created_at = data["apkUserActionChallengeCreatedAtEpochSeconds"]
    expires_at = data["apkUserActionChallengeExpiresAtEpochSeconds"]
    now = int(time.time())
    if (
        created_at < 1
        or expires_at < created_at
        or expires_at - created_at > 3_600
        or now < created_at - 5
        or now > expires_at
    ):
        fail("journal attestation challenge is expired or invalid")
    return raw, data


def write_attestation(
    path: pathlib.Path,
    payload: dict[str, object],
    journal: pathlib.Path,
    journal_bytes: bytes,
    root: pathlib.Path,
) -> None:
    # Re-read before publication so an action rotation, rollback, or commit
    # revokes a helper invocation that began against an older journal.
    current_bytes, current = read_journal(journal, root)
    if (
        current_bytes != journal_bytes
        or current.get("apkUserActionChallenge") != payload["challenge"]
    ):
        fail("journal changed before attestation publication")
    temporary = path.with_name(
        f"{path.name}.new.{os.getpid()}.{secrets.token_hex(8)}"
    )
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(temporary, flags, 0o600)
    try:
        encoded = (
            json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n"
        ).encode("utf-8")
        written = 0
        while written < len(encoded):
            count = os.write(descriptor, encoded[written:])
            if count < 1:
                fail("attestation write did not make progress")
            written += count
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)
    try:
        # One last check closes the practical race with challenge rotation.
        final_bytes, final = read_journal(journal, root)
        if (
            final_bytes != journal_bytes
            or final.get("apkUserActionChallenge") != payload["challenge"]
        ):
            fail("journal changed before attestation publication")
        os.replace(temporary, path)
        directory = os.open(
            path.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] != "--fresh-display-0":
        fail(
            "usage: attest-install-review.py --fresh-display-0 "
            "<challenge> <scan-completed|no-scan-offered>"
        )
    challenge, outcome = sys.argv[2:]
    if re.fullmatch(r"[0-9a-f]{64}", challenge) is None:
        fail("challenge is invalid")
    if outcome not in {"scan-completed", "no-scan-offered"}:
        fail("outcome is invalid")

    raw_home = os.environ.get("HOME", "")
    home = pathlib.Path(raw_home)
    if (
        not raw_home
        or not home.is_absolute()
        or raw_home.startswith("//")
        or os.path.normpath(raw_home) != raw_home
    ):
        fail("HOME is not an exact absolute path")
    root = home / ".local/share/evogent"
    transaction = root / "install-transaction"
    metadata = os.lstat(transaction)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o700
        or metadata.st_uid != os.getuid()
    ):
        fail("transaction directory is unsafe")
    expected_self = transaction / "attest-install-review.py"
    self_metadata = os.lstat(expected_self)
    if (
        not stat.S_ISREG(self_metadata.st_mode)
        or stat.S_ISLNK(self_metadata.st_mode)
        or stat.S_IMODE(self_metadata.st_mode) != 0o700
        or self_metadata.st_uid != os.getuid()
        or self_metadata.st_nlink != 1
        or not os.path.samefile(pathlib.Path(__file__), expected_self)
    ):
        fail("run the pinned private transaction attester")

    journal = transaction / "journal.json"
    journal_bytes, data = read_journal(journal, root)
    if data["apkUserActionChallenge"] != challenge:
        fail("challenge does not match the live transaction")
    trusted = data["apkUserActionTrustedVerifierObserved"]
    if trusted == 1 and outcome != "scan-completed":
        fail("a trusted verifier was observed; only scan-completed is accepted")
    now = int(time.time())
    payload = {
        "schema": ATTESTATION_SCHEMA,
        "displayEvidence": DISPLAY_EVIDENCE,
        "journalSha256": hashlib.sha256(journal_bytes).hexdigest(),
        "releaseId": data["releaseId"],
        "migrationDir": data["migrationDir"],
        "purpose": data["apkUserActionPurpose"],
        "targetSha256": data["apkUserActionTargetSha256"],
        "targetVersionCode": data["apkUserActionTargetVersionCode"],
        "targetSignerSha256": data["apkUserActionTargetSignerSha256"],
        "challenge": challenge,
        "challengeCreatedAtEpochSeconds": (
            data["apkUserActionChallengeCreatedAtEpochSeconds"]
        ),
        "challengeExpiresAtEpochSeconds": (
            data["apkUserActionChallengeExpiresAtEpochSeconds"]
        ),
        "trustedVerifierObserved": trusted,
        "outcome": outcome,
        "attestedAtEpochSeconds": now,
    }
    write_attestation(
        transaction / "install-review-attestation.json",
        payload,
        journal,
        journal_bytes,
        root,
    )
    print(
        "install review attestation: recorded "
        f"{outcome} for {data['apkUserActionPurpose']}"
    )


if __name__ == "__main__":
    main()
