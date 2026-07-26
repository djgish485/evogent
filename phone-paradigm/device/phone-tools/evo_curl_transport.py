"""Mutually authenticated, connection-pinned transport for ``evo-curl``.

The first challenge contains no protected material. The durable control token
is used only as an HMAC key and never crosses a socket. After authenticating the
server, challenge completion and the caller's real curl request travel on that
same TCP connection. A different Android app that takes the port after Node
dies therefore cannot receive the request body, a session, or either secret.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import errno
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
from typing import Iterable
from urllib.parse import urlsplit


PROTOCOL_VERSION = 1
CHALLENGE_DOMAIN = "evogent/phone-auth/server/v1"
CLIENT_DOMAIN = "evogent/phone-auth/client/v1"
SESSION_DOMAIN = "evogent/phone-auth/session/v1"
MAX_AUTH_RESPONSE_BYTES = 8192
AUTH_TIMEOUT_SECONDS = 8
HEX_32_BYTES = re.compile(r"^[a-f0-9]{64}$")
HEX_16_BYTES = re.compile(r"^[a-f0-9]{32}$")
BASE64URL_32_BYTES = re.compile(r"^[A-Za-z0-9_-]{43}$")
LONG_VALUE_OPTIONS = frozenset({
    "--connect-timeout",
    "--cookie",
    "--cookie-jar",
    "--create-file-mode",
    "--data",
    "--data-ascii",
    "--data-binary",
    "--data-raw",
    "--data-urlencode",
    "--dump-header",
    "--etag-compare",
    "--etag-save",
    "--expect100-timeout",
    "--form",
    "--form-string",
    "--header",
    "--json",
    "--limit-rate",
    "--max-filesize",
    "--max-time",
    "--output",
    "--output-dir",
    "--range",
    "--referer",
    "--request",
    "--speed-limit",
    "--speed-time",
    "--time-cond",
    "--upload-file",
    "--url-query",
    "--user-agent",
    "--write-out",
})
LONG_SWITCH_OPTIONS = frozenset({
    "--compressed",
    "--create-dirs",
    "--disable",
    "--disallow-username-in-url",
    "--fail",
    "--fail-early",
    "--fail-with-body",
    "--get",
    "--globoff",
    "--head",
    "--include",
    "--no-buffer",
    "--no-progress-meter",
    "--path-as-is",
    "--raw",
    "--remove-on-error",
    "--show-error",
    "--silent",
})
SHORT_VALUE_OPTIONS = frozenset("HdmXowFbcDerATzYyC")
SHORT_SWITCH_OPTIONS = frozenset("fsSiINGgq")


class TransportError(RuntimeError):
    pass


def _encode_field(value: object) -> bytes:
    raw = str(value).encode("utf-8")
    return len(raw).to_bytes(4, "big") + raw


def _hmac_hex(key: bytes, domain: str, fields: Iterable[object]) -> str:
    transcript = b"".join(
        [_encode_field(domain), *(_encode_field(field) for field in fields)]
    )
    return hmac.new(key, transcript, hashlib.sha256).hexdigest()


def _read_control_key(token_path: Path) -> bytes:
    try:
        descriptor = os.open(
            token_path,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise TransportError(
                "control token is not a regular private file"
            ) from error
        raise TransportError("phone authentication is not provisioned") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise TransportError("control token is not a regular private file")
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise TransportError("control token permissions must be 0600")
        if metadata.st_uid != os.getuid():
            raise TransportError("control token is not owned by this user")
        if metadata.st_size < 24 or metadata.st_size > 513:
            raise TransportError("control token has an invalid length")
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            descriptor = -1
            raw_token = handle.read(514)
        if len(raw_token) > 513:
            raise TransportError("control token has an invalid length")
        token = raw_token.decode("utf-8").strip()
    except UnicodeError as error:
        raise TransportError("control token could not be read") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not 24 <= len(token) <= 512 or any(char in token for char in "\r\n\0"):
        raise TransportError("control token has an invalid format")
    return token.encode("utf-8")


def _unsafe_option(argument: str) -> bool:
    lowered = argument.lower()
    exact_or_value = (
        "--config",
        "--proxy",
        "--preproxy",
        "--connect-to",
        "--resolve",
        "--doh-url",
        "--location",
        "--location-trusted",
        "--max-redirs",
        "--url",
        "--next",
        "--alt-svc",
        "--hsts",
        "--verbose",
        "--trace",
        "--trace-ascii",
        "--trace-config",
        "--libcurl",
        "--noproxy",
        "--unix-socket",
        "--abstract-unix-socket",
        "--proto",
        "--proto-default",
        "--proto-redir",
        "--request-target",
        "--variable",
        "--expand-url",
        "--expand-header",
        "--expand-data",
        "--expand-json",
        "--parallel",
        "--parallel-max",
        "--parallel-immediate",
        "--connect-only",
        "--haproxy-protocol",
        "--haproxy-clientip",
        "--retry",
        "--retry-all-errors",
        "--retry-connrefused",
        "--retry-delay",
        "--retry-max-time",
        "--http0.9",
        "--http1.0",
        "--http1.1",
        "--http2",
        "--http2-prior-knowledge",
        "--http3",
        "--http3-only",
        "--user",
        "--oauth2-bearer",
        "--aws-sigv4",
        "--netrc",
        "--netrc-file",
        "--netrc-optional",
        "--anyauth",
        "--basic",
        "--digest",
        "--negotiate",
        "--ntlm",
        "--ntlm-wb",
    )
    if any(lowered == option or lowered.startswith(f"{option}=") for option in exact_or_value):
        return True
    if lowered.startswith("--proxy") or lowered.startswith("--socks"):
        return True
    if argument.startswith("-") and not argument.startswith("--"):
        body = argument[1:]
        if not body:
            return False
        # Do not let bundled short options hide -K/-x/-u/-L/-v or override
        # the wrapper's HTTP/connection behavior. Common data/output options
        # may carry their value in the same argv element; simple display flags
        # may be safely combined (for example -fsS).
        if body[0] in SHORT_VALUE_OPTIONS:
            return False
        return not all(character in SHORT_SWITCH_OPTIONS for character in body)
    return False


def _validate_header(value: str) -> None:
    if any(character in value for character in "\r\n\0"):
        raise TransportError("curl header contains a forbidden control character")
    if value.startswith("@"):
        raise TransportError("curl header files are not allowed")
    name = value.split(":", 1)[0].strip().lower()
    if name in {
        "authorization",
        "connection",
        "host",
        "proxy-authorization",
        "x-evogent-server-secret",
    }:
        raise TransportError(f"caller may not provide the {name or 'protected'} header")


def _validate_arguments(arguments: list[str], port: int) -> str:
    if not arguments:
        raise TransportError(
            f"usage: evo-curl [curl options] http://127.0.0.1:{port}/path"
        )

    urls: list[str] = []
    expecting_value_for: str | None = None
    for argument in arguments:
        if expecting_value_for is not None:
            if expecting_value_for in {"--header", "H"}:
                _validate_header(argument)
            expecting_value_for = None
            continue
        if _unsafe_option(argument):
            option_name = argument.split("=", 1)[0]
            if option_name.startswith("-") and not option_name.startswith("--"):
                option_name = option_name[:2]
            raise TransportError(
                f"unsafe curl option is not allowed: {option_name}"
            )

        if argument.startswith("--"):
            option_name, separator, option_value = argument.partition("=")
            if option_name in LONG_VALUE_OPTIONS:
                if separator:
                    if option_name == "--header":
                        _validate_header(option_value)
                else:
                    expecting_value_for = option_name
                continue
            if option_name in LONG_SWITCH_OPTIONS and not separator:
                continue
            raise TransportError(f"unsupported curl option: {option_name}")

        if argument.startswith("-") and argument != "-":
            body = argument[1:]
            if body and all(
                character in SHORT_SWITCH_OPTIONS for character in body
            ):
                continue
            if body and body[0] in SHORT_VALUE_OPTIONS:
                if len(body) == 1:
                    expecting_value_for = body[0]
                elif body[0] == "H":
                    _validate_header(body[1:])
                continue
            raise TransportError(
                f"unsupported curl option: {argument[:2]}"
            )

        urls.append(argument)

    if expecting_value_for is not None:
        name = (
            f"-{expecting_value_for}"
            if len(expecting_value_for) == 1
            else expecting_value_for
        )
        raise TransportError(f"curl option is missing its value: {name}")
    if len(urls) != 1:
        raise TransportError("exactly one explicit on-phone Evogent URL is required")

    url = urls[0]
    try:
        parsed = urlsplit(url)
        parsed_port = parsed.port
    except ValueError as error:
        raise TransportError("destination URL is invalid") from error
    if (
        parsed.scheme != "http"
        or parsed.netloc != f"127.0.0.1:{port}"
        or parsed.hostname != "127.0.0.1"
        or parsed_port != port
        or parsed.username is not None
        or parsed.password is not None
        or any(ord(char) < 0x20 for char in url)
    ):
        raise TransportError(
            f"destination must be the exact on-phone Evogent origin "
            f"http://127.0.0.1:{port}"
        )
    return url


def _read_json_response(
    connection: http.client.HTTPConnection,
    *,
    pinned_socket: socket.socket | None = None,
) -> tuple[dict[str, object], socket.socket]:
    response = connection.getresponse()
    body = response.read(MAX_AUTH_RESPONSE_BYTES + 1)
    if len(body) > MAX_AUTH_RESPONSE_BYTES:
        raise TransportError("phone authentication response is too large")
    if response.status != 200:
        raise TransportError(f"phone authentication failed with HTTP {response.status}")
    if response.will_close or connection.sock is None:
        raise TransportError("phone authentication connection was not reusable")
    if pinned_socket is not None and connection.sock is not pinned_socket:
        raise TransportError("phone authentication connection changed")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise TransportError("phone authentication response is invalid") from error
    if not isinstance(payload, dict):
        raise TransportError("phone authentication response is invalid")
    return payload, connection.sock


def _assert_pinned_peer(upstream: socket.socket, port: int) -> None:
    try:
        peer = upstream.getpeername()
    except OSError as error:
        raise TransportError("phone authentication connection was lost") from error
    if not isinstance(peer, tuple) or peer[0] != "127.0.0.1" or peer[1] != port:
        raise TransportError("phone authentication peer changed")


def _authenticate(
    port: int,
    key: bytes,
    connection: http.client.HTTPConnection,
) -> tuple[http.client.HTTPConnection, socket.socket, str]:
    client_nonce = secrets.token_hex(32)
    challenge_body = json.dumps(
        {"clientNonce": client_nonce},
        separators=(",", ":"),
    ).encode("utf-8")
    connection.request(
        "POST",
        "/api/phone-auth/challenge",
        body=challenge_body,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(challenge_body)),
            "Cache-Control": "no-store",
            "Connection": "keep-alive",
        },
    )
    challenge, pinned = _read_json_response(connection)
    _assert_pinned_peer(pinned, port)

    version = challenge.get("version")
    echoed_nonce = challenge.get("clientNonce")
    instance_id = challenge.get("serverInstanceId")
    challenge_id = challenge.get("challengeId")
    server_nonce = challenge.get("serverNonce")
    expires_at = challenge.get("expiresAtMs")
    server_proof = challenge.get("serverProof")
    now_ms = int(time.time() * 1000)
    if (
        version != PROTOCOL_VERSION
        or echoed_nonce != client_nonce
        or not isinstance(instance_id, str)
        or not HEX_16_BYTES.fullmatch(instance_id)
        or not isinstance(challenge_id, str)
        or not HEX_16_BYTES.fullmatch(challenge_id)
        or not isinstance(server_nonce, str)
        or not HEX_32_BYTES.fullmatch(server_nonce)
        or not isinstance(expires_at, int)
        or isinstance(expires_at, bool)
        or expires_at < now_ms - 5000
        or expires_at > now_ms + 60_000
        or not isinstance(server_proof, str)
        or not HEX_32_BYTES.fullmatch(server_proof)
    ):
        raise TransportError("phone server challenge is invalid")

    fields: list[object] = [
        str(PROTOCOL_VERSION),
        client_nonce,
        instance_id,
        challenge_id,
        server_nonce,
        str(expires_at),
    ]
    expected_server_proof = _hmac_hex(key, CHALLENGE_DOMAIN, fields)
    if not hmac.compare_digest(server_proof, expected_server_proof):
        raise TransportError("phone server could not prove its identity")

    client_proof = _hmac_hex(key, CLIENT_DOMAIN, [*fields, "direct"])
    completion = {
        "version": PROTOCOL_VERSION,
        "clientNonce": client_nonce,
        "serverInstanceId": instance_id,
        "challengeId": challenge_id,
        "serverNonce": server_nonce,
        "expiresAtMs": expires_at,
        "sessionKind": "direct",
        "clientProof": client_proof,
    }
    completion_body = json.dumps(completion, separators=(",", ":")).encode("utf-8")
    if connection.sock is not pinned:
        raise TransportError("phone authentication connection changed")
    connection.request(
        "POST",
        "/api/phone-auth/complete",
        body=completion_body,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(completion_body)),
            "Cache-Control": "no-store",
            "Connection": "keep-alive",
        },
    )
    session, session_socket = _read_json_response(
        connection,
        pinned_socket=pinned,
    )
    _assert_pinned_peer(session_socket, port)

    session_kind = session.get("sessionKind")
    session_token = session.get("sessionToken")
    session_expires_at = session.get("sessionExpiresAtMs")
    session_proof = session.get("sessionProof")
    now_ms = int(time.time() * 1000)
    if (
        session.get("version") != PROTOCOL_VERSION
        or session_kind != "direct"
        or not isinstance(session_token, str)
        or not BASE64URL_32_BYTES.fullmatch(session_token)
        or not isinstance(session_expires_at, int)
        or isinstance(session_expires_at, bool)
        or session_expires_at <= now_ms
        or session_expires_at > now_ms + 60_000
        or not isinstance(session_proof, str)
        or not HEX_32_BYTES.fullmatch(session_proof)
    ):
        raise TransportError("phone session response is invalid")
    expected_session_proof = _hmac_hex(
        key,
        SESSION_DOMAIN,
        [*fields, "direct", session_token, str(session_expires_at)],
    )
    if not hmac.compare_digest(session_proof, expected_session_proof):
        raise TransportError("phone session could not prove its identity")
    if connection.sock is not pinned:
        raise TransportError("phone authentication connection changed")
    return connection, pinned, session_token


def _copy_socket(source: socket.socket, destination: socket.socket) -> None:
    try:
        while True:
            chunk = source.recv(64 * 1024)
            if not chunk:
                break
            destination.sendall(chunk)
    except OSError:
        pass
    try:
        destination.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def _accept_curl(
    listener: socket.socket,
    process: subprocess.Popen[bytes],
) -> socket.socket:
    listener.settimeout(0.1)
    deadline = time.monotonic() + AUTH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            client, _ = listener.accept()
            if hasattr(socket, "SO_PEERCRED"):
                raw_credentials = client.getsockopt(
                    socket.SOL_SOCKET,
                    socket.SO_PEERCRED,
                    struct.calcsize("3i"),
                )
                peer_pid, peer_uid, _ = struct.unpack("3i", raw_credentials)
                if peer_pid != process.pid or peer_uid != os.getuid():
                    client.close()
                    continue
            return client
        except socket.timeout:
            if process.poll() is not None:
                raise TransportError(
                    f"curl exited before opening its protected transport ({process.returncode})"
                )
    raise TransportError("curl did not open its protected transport")


def _run_curl_over_pinned_socket(
    arguments: list[str],
    connection: http.client.HTTPConnection,
    upstream: socket.socket,
    session_token: str,
    data_dir: Path,
) -> int:
    # The short bootstrap timeout must not truncate a legitimate slow API call
    # (some curation/refresh endpoints intentionally allow 90 seconds). Curl's
    # own --max-time remains the caller-visible request deadline.
    upstream.settimeout(None)

    configured_temp = (
        os.environ.get("EVOGENT_TRANSPORT_TMP", "").strip()
        or os.environ.get("TMPDIR", "").strip()
    )
    temp_root = Path(configured_temp) if configured_temp else data_dir / "tmp"
    temp_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not configured_temp:
        try:
            os.chmod(temp_root, 0o700)
        except OSError:
            pass
    transport_dir = Path(tempfile.mkdtemp(prefix=".evo-", dir=temp_root))
    os.chmod(transport_dir, 0o700)
    socket_path = transport_dir / "s"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(socket_path))
    os.chmod(socket_path, 0o600)
    listener.listen(1)

    curl_binary = os.environ.get("EVOGENT_CURL_BIN", "").strip() or shutil.which("curl")
    if not curl_binary:
        raise TransportError("curl is not installed")
    command = [
        curl_binary,
        "--disable",
        "--noproxy",
        "*",
        "--proto",
        "=http",
        "--max-redirs",
        "0",
        "--globoff",
        "--http1.1",
        "--unix-socket",
        str(socket_path),
        *arguments,
        "--header",
        f"Authorization: EvogentSession {session_token}",
        "--header",
        "Connection: close",
    ]

    process: subprocess.Popen[bytes] | None = None
    local: socket.socket | None = None
    try:
        if connection.sock is not upstream:
            raise TransportError("phone authentication connection changed")
        process = subprocess.Popen(command)
        local = _accept_curl(listener, process)
        listener.close()
        if connection.sock is not upstream:
            raise TransportError("phone authentication connection changed")

        to_server = threading.Thread(
            target=_copy_socket,
            args=(local, upstream),
            daemon=True,
        )
        to_curl = threading.Thread(
            target=_copy_socket,
            args=(upstream, local),
            daemon=True,
        )
        to_server.start()
        to_curl.start()
        return_code = process.wait()
        try:
            local.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        local.close()
        local = None
        try:
            upstream.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        upstream.close()
        to_server.join(timeout=1)
        to_curl.join(timeout=1)
        return return_code
    finally:
        listener.close()
        if local is not None:
            local.close()
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass
        try:
            transport_dir.rmdir()
        except OSError:
            pass


def main(arguments: list[str]) -> int:
    raw_port = os.environ.get("PORT", "3001")
    if not raw_port.isdecimal():
        raise TransportError("PORT must be a decimal TCP port")
    port = int(raw_port)
    if not 1 <= port <= 65535:
        raise TransportError("PORT is outside the TCP port range")
    _validate_arguments(arguments, port)

    data_dir = Path(
        os.environ.get("DATA_DIR", "").strip()
        or Path.home() / "evogent" / "data"
    )
    key = _read_control_key(data_dir / "control-token.txt")
    connection: http.client.HTTPConnection | None = http.client.HTTPConnection(
        "127.0.0.1",
        port,
        timeout=AUTH_TIMEOUT_SECONDS,
    )
    upstream: socket.socket | None = None
    try:
        connection, upstream, session_token = _authenticate(port, key, connection)
        return _run_curl_over_pinned_socket(
            arguments,
            connection,
            upstream,
            session_token,
            data_dir,
        )
    finally:
        if connection is not None:
            connection.close()
        elif upstream is not None:
            upstream.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except TransportError as error:
        print(f"evo-curl: {error}", file=sys.stderr)
        raise SystemExit(64)
    except (OSError, http.client.HTTPException, ValueError) as error:
        # Deliberately omit response bodies, HMAC material, and tokens.
        print(f"evo-curl: protected transport failed ({type(error).__name__})", file=sys.stderr)
        raise SystemExit(69)
