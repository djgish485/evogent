#!/usr/bin/env python3
"""Verify one phone release and extract only its exact bootstrap APK identity."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import posixpath
import re
import stat
import sys
import tarfile
from typing import NoReturn


MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024
MAX_APK_BYTES = 256 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_SIDECAR_BYTES = 1024
PACKAGE_NAME = "net.dangish.evogent"
SHA256 = re.compile(r"[0-9a-f]{64}")
SAFE_RELEASE_ID = re.compile(r"[A-Za-z0-9._-]{1,180}")
SAFE_ARCHIVE_NAME = re.compile(r"[A-Za-z0-9._-]{1,220}")


def fail(message: str) -> NoReturn:
    raise SystemExit(f"phone bootstrap: {message}")


def checked_private_file(path: pathlib.Path, maximum: int) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError:
        fail(f"required file is unavailable: {path}")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_nlink != 1
        or metadata.st_size < 1
        or metadata.st_size > maximum
        or stat.S_IMODE(metadata.st_mode) & 0o077
    ):
        fail(f"file is not a private owner-only regular file: {path}")
    return metadata


def read_exact_file(path: pathlib.Path, maximum: int) -> bytes:
    before = checked_private_file(path, maximum)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
            != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            or not stat.S_ISREG(opened.st_mode)
        ):
            fail(f"file identity changed while opening: {path}")
        chunks: list[bytes] = []
        remaining = maximum + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) != opened.st_size or len(payload) > maximum:
            fail(f"file changed or exceeded its bound while reading: {path}")
        after = os.fstat(descriptor)
        if (
            after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            fail(f"file changed while reading: {path}")
        return payload
    finally:
        os.close(descriptor)


def open_exact_file(path: pathlib.Path, maximum: int) -> tuple[int, os.stat_result]:
    before = checked_private_file(path, maximum)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    opened = os.fstat(descriptor)
    if (
        (
            opened.st_dev,
            opened.st_ino,
            opened.st_size,
            opened.st_mtime_ns,
            opened.st_ctime_ns,
        )
        != (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        or not stat.S_ISREG(opened.st_mode)
    ):
        os.close(descriptor)
        fail(f"file identity changed while opening: {path}")
    return descriptor, opened


def hash_open_file(descriptor: int, expected_size: int) -> str:
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > expected_size:
            fail("release archive grew while hashing")
        digest.update(chunk)
    if total != expected_size:
        fail("release archive changed while hashing")
    return digest.hexdigest()


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            fail(f"release manifest repeats key {key!r}")
        result[key] = value
    return result


def validate_archive_member(member: tarfile.TarInfo) -> None:
    name = member.name
    pure = pathlib.PurePosixPath(name)
    if (
        pure.is_absolute()
        or ".." in pure.parts
        or not pure.parts
        or pure.parts[0] != "release"
    ):
        fail(f"unsafe archive member: {name!r}")
    if (
        member.isdev()
        or member.isfifo()
        or member.ischr()
        or member.isblk()
        or member.islnk()
    ):
        fail(f"unsupported archive member type: {name!r}")
    if member.issym():
        resolved = posixpath.normpath(
            posixpath.join(posixpath.dirname(name), member.linkname),
        )
        if not resolved.startswith("release/"):
            fail(f"archive symlink escapes release: {name!r}")


def require_member(
    bundle: tarfile.TarFile,
    members: list[tarfile.TarInfo],
    name: str,
    maximum: int,
) -> bytes:
    matches = [member for member in members if member.name == name]
    if len(matches) != 1:
        fail(f"archive must contain exactly one {name}")
    member = matches[0]
    if not member.isfile() or member.size < 1 or member.size > maximum:
        fail(f"archive member is not a bounded regular file: {name}")
    source = bundle.extractfile(member)
    if source is None:
        fail(f"archive member could not be read: {name}")
    payload = source.read(maximum + 1)
    if len(payload) != member.size or len(payload) > maximum:
        fail(f"archive member changed or exceeded its bound: {name}")
    return payload


def checked_output_directory(path: pathlib.Path) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except OSError:
        fail("output directory must already exist as a private empty directory")
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        fail("output directory must be owner-owned, nonsymlinked, and mode 0700")
    if any(path.iterdir()):
        fail("output directory must be empty")
    return path.resolve(strict=True)


def write_private(path: pathlib.Path, payload: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    created = os.fstat(descriptor)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written < 1:
                fail(f"could not write {path.name}")
            view = view[written:]
        os.fsync(descriptor)
    except BaseException:
        try:
            current = path.lstat()
            if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                path.unlink()
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(descriptor)


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: extract-phone-bootstrap-apk.py <release.tar.gz> <empty-output-dir>")
    archive = pathlib.Path(sys.argv[1]).expanduser()
    if not archive.is_absolute():
        archive = pathlib.Path.cwd() / archive
    if SAFE_ARCHIVE_NAME.fullmatch(archive.name) is None:
        fail("release archive filename is unsafe")
    sidecar = pathlib.Path(f"{archive}.sha256")
    output = checked_output_directory(
        pathlib.Path(sys.argv[2]).expanduser(),
    )

    sidecar_bytes = read_exact_file(sidecar, MAX_SIDECAR_BYTES)
    archive_descriptor, archive_metadata = open_exact_file(archive, MAX_ARCHIVE_BYTES)
    try:
        archive_sha256 = hash_open_file(archive_descriptor, archive_metadata.st_size)
        expected_sidecar = f"{archive_sha256}  {archive.name}\n".encode("ascii")
        if sidecar_bytes != expected_sidecar:
            fail("archive checksum sidecar does not exactly match the release")

        os.lseek(archive_descriptor, 0, os.SEEK_SET)
        try:
            with os.fdopen(os.dup(archive_descriptor), "rb") as archive_handle:
                with tarfile.open(fileobj=archive_handle, mode="r:gz") as bundle:
                    members = bundle.getmembers()
                    for member in members:
                        validate_archive_member(member)
                    manifest_bytes = require_member(
                        bundle,
                        members,
                        "release/manifest.json",
                        MAX_MANIFEST_BYTES,
                    )
                    apk_bytes = require_member(
                        bundle,
                        members,
                        "release/apk/evogent.apk",
                        MAX_APK_BYTES,
                    )
        except (OSError, tarfile.TarError):
            fail("release archive could not be parsed safely")
        after = os.fstat(archive_descriptor)
        if (
            after.st_size != archive_metadata.st_size
            or after.st_mtime_ns != archive_metadata.st_mtime_ns
            or after.st_ctime_ns != archive_metadata.st_ctime_ns
        ):
            fail("release archive changed while being inspected")
    finally:
        os.close(archive_descriptor)

    try:
        manifest = json.loads(
            manifest_bytes,
            object_pairs_hook=unique_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("release manifest is not valid unique-key JSON")
    if not isinstance(manifest, dict) or manifest.get("schema") != "evogent.phone.release.v1":
        fail("release manifest schema is invalid")
    android = manifest.get("android")
    phone_tls = manifest.get("phoneTls")
    if not isinstance(android, dict) or not isinstance(phone_tls, dict):
        fail("release manifest lacks Android or phone TLS identity")

    apk_sha256 = hashlib.sha256(apk_bytes).hexdigest()
    package = android.get("package")
    version_code = android.get("versionCode")
    version_name = android.get("versionName")
    signer_sha256 = android.get("signerSha256")
    manifest_apk_sha256 = android.get("sha256")
    tls_sha256 = phone_tls.get("certificateDerSha256")
    release_id = manifest.get("releaseId")
    release_identity_digest = manifest.get("releaseIdentityDigest")
    if (
        package != PACKAGE_NAME
        or not isinstance(version_code, int)
        or isinstance(version_code, bool)
        or version_code < 1
        or version_code > 2_147_483_647
        or not isinstance(version_name, str)
        or not version_name
        or len(version_name) > 120
        or not isinstance(signer_sha256, str)
        or SHA256.fullmatch(signer_sha256) is None
        or manifest_apk_sha256 != apk_sha256
        or not isinstance(tls_sha256, str)
        or SHA256.fullmatch(tls_sha256) is None
        or not isinstance(release_id, str)
        or SAFE_RELEASE_ID.fullmatch(release_id) is None
    ):
        fail("release manifest Android identity does not match its APK")
    identity = (
        f"apk-sha256:{apk_sha256}\n"
        f"tls-cert-der-sha256:{tls_sha256}\n"
    )
    expected_identity_digest = hashlib.sha256(identity.encode("ascii")).hexdigest()[:12]
    if (
        release_identity_digest != expected_identity_digest
        or not release_id.endswith(f"-{expected_identity_digest}")
    ):
        fail("release ID is not bound to its APK/TLS identity")

    receipt = {
        "schema": "evogent.phone.bootstrap-apk.v1",
        "archiveSha256": archive_sha256,
        "package": package,
        "releaseId": release_id,
        "sha256": apk_sha256,
        "signerSha256": signer_sha256,
        "versionCode": version_code,
        "versionName": version_name,
    }
    created: list[pathlib.Path] = []
    try:
        for name, payload in (
            ("evogent.apk", apk_bytes),
            ("manifest.json", manifest_bytes),
            (
                "bootstrap-identity.json",
                (json.dumps(receipt, separators=(",", ":"), sort_keys=True) + "\n").encode(),
            ),
        ):
            destination = output / name
            write_private(destination, payload)
            created.append(destination)
        directory = os.open(output, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        for path in created:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        raise

    print(f"phone bootstrap APK: {output / 'evogent.apk'}")
    print(f"phone bootstrap identity: {output / 'bootstrap-identity.json'}")


if __name__ == "__main__":
    main()
