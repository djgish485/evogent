#!/data/data/com.termux/files/usr/bin/env python3
"""Bounded HTTP(S) fetches that cannot be redirected or rebound onto a private address."""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import threading
import time
import urllib.parse
from collections.abc import Callable, Mapping, Sequence
from typing import Any, TypeVar


DEFAULT_MAX_BYTES = 200_000
DEFAULT_MAX_REDIRECTS = 4
DEFAULT_TIMEOUT_SECONDS = 8.0
REDIRECT_STATUSES = frozenset((301, 302, 303, 307, 308))


class PublicHttpError(RuntimeError):
    """Base error for a rejected or failed bounded public fetch."""


class UnsafePublicUrlError(PublicHttpError):
    """The URL or one of its resolved addresses is not safe for a public fetch."""


class PublicHttpLimitError(PublicHttpError):
    """The response exceeded a configured time, redirect, or body-size bound."""


Resolver = Callable[..., Sequence[tuple[Any, ...]]]
ConnectionFactory = Callable[
    [str, str, int, str, float],
    http.client.HTTPConnection,
]
ResultT = TypeVar("ResultT")


def _run_bounded(operation: Callable[[], ResultT], timeout: float, message: str) -> ResultT:
    """Bound blocking DNS/socket work by wall time, not only by socket inactivity."""
    if timeout <= 0:
        raise PublicHttpLimitError(message)
    results: list[ResultT] = []
    errors: list[BaseException] = []
    finished = threading.Event()

    def run() -> None:
        try:
            results.append(operation())
        except BaseException as error:  # propagate the worker's exact failure on the caller thread
            errors.append(error)
        finally:
            finished.set()

    threading.Thread(target=run, daemon=True, name="evogent-public-http-bound").start()
    if not finished.wait(timeout):
        raise PublicHttpLimitError(message)
    if errors:
        raise errors[0]
    return results[0]


def _public_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise UnsafePublicUrlError(f"DNS returned an invalid address: {value!r}") from error

    comparable = address.ipv4_mapped if isinstance(address, ipaddress.IPv6Address) else None
    if comparable is None:
        comparable = address
    if (
        not comparable.is_global
        or comparable.is_private
        or comparable.is_loopback
        or comparable.is_link_local
        or getattr(comparable, "is_site_local", False)
        or comparable.is_multicast
        or comparable.is_reserved
        or comparable.is_unspecified
    ):
        raise UnsafePublicUrlError(f"refusing non-public address {address.compressed}")
    return address


def _normalized_target(url: str) -> tuple[urllib.parse.SplitResult, str, int]:
    if not isinstance(url, str) or not url.strip():
        raise UnsafePublicUrlError("URL must be a non-empty string")
    if any(ord(character) < 32 or ord(character) == 127 for character in url):
        raise UnsafePublicUrlError("URL contains control characters")

    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise UnsafePublicUrlError("URL has an invalid authority or port") from error

    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise UnsafePublicUrlError("only public http(s) URLs may be fetched")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafePublicUrlError("credential-bearing URLs are not allowed")
    if not parsed.hostname:
        raise UnsafePublicUrlError("URL hostname is required")

    try:
        hostname = parsed.hostname.encode("idna").decode("ascii").rstrip(".").lower()
    except UnicodeError as error:
        raise UnsafePublicUrlError("URL hostname is not valid IDNA") from error
    if not hostname:
        raise UnsafePublicUrlError("URL hostname is required")

    resolved_port = port if port is not None else (443 if scheme == "https" else 80)
    if resolved_port < 1 or resolved_port > 65535:
        raise UnsafePublicUrlError("URL port is out of range")
    return parsed, hostname, resolved_port


def resolve_public_addresses(
    hostname: str,
    port: int,
    *,
    resolver: Resolver = socket.getaddrinfo,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> tuple[str, ...]:
    """Resolve once, reject the whole answer set if any address is non-public."""
    try:
        answers = _run_bounded(
            lambda: resolver(
                hostname,
                port,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
                proto=socket.IPPROTO_TCP,
            ),
            timeout,
            f"public DNS resolution for {hostname} exceeded its time bound",
        )
    except (OSError, socket.gaierror) as error:
        raise PublicHttpError(f"public DNS resolution failed for {hostname}") from error

    addresses: list[str] = []
    seen: set[str] = set()
    for answer in answers:
        try:
            sockaddr = answer[4]
            raw_address = str(sockaddr[0])
        except (IndexError, TypeError) as error:
            raise UnsafePublicUrlError("DNS returned a malformed socket address") from error
        address = _public_ip(raw_address).compressed
        if address not in seen:
            seen.add(address)
            addresses.append(address)
    if not addresses:
        raise UnsafePublicUrlError(f"DNS returned no public addresses for {hostname}")
    return tuple(addresses)


def _connect_pinned(
    pinned_ip: str,
    port: int,
    timeout: float,
    source_address: tuple[str, int] | None = None,
) -> socket.socket:
    """Open a socket to a numeric validated peer without invoking name resolution."""
    address = ipaddress.ip_address(pinned_ip)
    family = socket.AF_INET6 if isinstance(address, ipaddress.IPv6Address) else socket.AF_INET
    peer: tuple[Any, ...] = (
        (address.compressed, port, 0, 0)
        if family == socket.AF_INET6
        else (address.compressed, port)
    )
    connection = socket.socket(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
    try:
        connection.settimeout(timeout)
        if source_address is not None:
            connection.bind(source_address)
        connection.connect(peer)
        return connection
    except BaseException:
        connection.close()
        raise


class _PinnedHttpConnection(http.client.HTTPConnection):
    def __init__(self, hostname: str, port: int, pinned_ip: str, timeout: float):
        self._pinned_ip = pinned_ip
        super().__init__(hostname, port=port, timeout=timeout)

    def connect(self) -> None:
        # Connect to the already-validated address. Never resolve self.host a second time.
        self.sock = _connect_pinned(
            self._pinned_ip,
            self.port,
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self._tunnel()


class _PinnedHttpsConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, port: int, pinned_ip: str, timeout: float):
        self._pinned_ip = pinned_ip
        super().__init__(
            hostname,
            port=port,
            timeout=timeout,
            context=ssl.create_default_context(),
        )

    def connect(self) -> None:
        # The TCP peer is pinned, while SNI and certificate verification remain bound to the
        # original public hostname. A DNS change between validation and connect has no effect.
        self.sock = _connect_pinned(
            self._pinned_ip,
            self.port,
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self._tunnel()
        server_hostname = self._tunnel_host or self.host
        self.sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname)


def _default_connection_factory(
    scheme: str,
    hostname: str,
    port: int,
    pinned_ip: str,
    timeout: float,
) -> http.client.HTTPConnection:
    if scheme == "https":
        return _PinnedHttpsConnection(hostname, port, pinned_ip, timeout)
    return _PinnedHttpConnection(hostname, port, pinned_ip, timeout)


def _host_header(hostname: str, port: int, scheme: str) -> str:
    display_hostname = f"[{hostname}]" if ":" in hostname else hostname
    default_port = 443 if scheme == "https" else 80
    return display_hostname if port == default_port else f"{display_hostname}:{port}"


def _request_target(parsed: urllib.parse.SplitResult) -> str:
    path = parsed.path or "/"
    return f"{path}?{parsed.query}" if parsed.query else path


def fetch_public_text(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_redirects: int = DEFAULT_MAX_REDIRECTS,
    resolver: Resolver = socket.getaddrinfo,
    connection_factory: ConnectionFactory = _default_connection_factory,
) -> str:
    """Fetch text with DNS pinning and one wall-clock budget across every redirect."""
    if timeout <= 0:
        raise PublicHttpLimitError("timeout must be positive")
    if max_bytes < 1:
        raise PublicHttpLimitError("max_bytes must be positive")
    if max_redirects < 0:
        raise PublicHttpLimitError("max_redirects must be non-negative")

    current_url = url
    deadline = time.monotonic() + timeout
    redirects = 0
    base_headers = {
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Connection": "close",
        **(dict(headers) if headers else {}),
    }

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PublicHttpLimitError("public fetch exceeded its time bound")
        parsed, hostname, port = _normalized_target(current_url)
        addresses = resolve_public_addresses(
            hostname,
            port,
            resolver=resolver,
            timeout=remaining,
        )
        pinned_ip = addresses[0]
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PublicHttpLimitError("public fetch exceeded its time bound")

        connection = connection_factory(
            parsed.scheme.lower(),
            hostname,
            port,
            pinned_ip,
            remaining,
        )
        request_headers = {
            **base_headers,
            "Host": _host_header(hostname, port, parsed.scheme.lower()),
        }
        try:
            def perform_request() -> tuple[int, str | None, bytes | None]:
                connection.request("GET", _request_target(parsed), headers=request_headers)
                response = connection.getresponse()
                status = int(response.status)
                location = response.getheader("Location") if status in REDIRECT_STATUSES else None
                if status in REDIRECT_STATUSES:
                    return status, location, None
                if status < 200 or status >= 300:
                    raise PublicHttpError(f"public fetch returned HTTP {status}")
                body = response.read(max_bytes + 1)
                if len(body) > max_bytes:
                    raise PublicHttpLimitError("public fetch exceeded its body-size bound")
                return status, None, body

            status, location, body = _run_bounded(
                perform_request,
                remaining,
                "public fetch exceeded its time bound",
            )
            if status in REDIRECT_STATUSES:
                if not location:
                    raise PublicHttpError(f"redirect {status} omitted Location")
                if redirects >= max_redirects:
                    raise PublicHttpLimitError("public fetch exceeded its redirect bound")
                next_url = urllib.parse.urljoin(current_url, location)
                next_parsed, _, _ = _normalized_target(next_url)
                if parsed.scheme.lower() == "https" and next_parsed.scheme.lower() != "https":
                    raise UnsafePublicUrlError("HTTPS redirects may not downgrade to HTTP")
                current_url = urllib.parse.urldefrag(next_url).url
                redirects += 1
                continue
            if body is None:
                raise PublicHttpError("public fetch returned no body")
            return body.decode("utf-8", "replace")
        except (OSError, http.client.HTTPException, ssl.SSLError) as error:
            raise PublicHttpError("bounded public fetch failed") from error
        finally:
            connection.close()
