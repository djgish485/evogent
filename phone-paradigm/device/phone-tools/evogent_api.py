"""Small authenticated client for Python phone-browse mechanics.

Public-source reads continue to use urllib directly. Calls back into the local
Evogent process go through ``evo-curl`` so mutual authentication, pinned
transport, destination checks, and the no-leak policy stay centralized.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional
from urllib.parse import urlsplit


PORT = int(os.environ.get("PORT", "3001"))
ORIGIN = f"http://127.0.0.1:{PORT}"
EVO_CURL = Path(__file__).with_name("evo-curl")
_STATUS_MARKER = b"\nEVOGENT_HTTP_STATUS:"


@dataclass(frozen=True)
class Response:
    body: bytes
    status: int

    def read(self) -> bytes:
        return self.body

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def _validate_url(url: str) -> None:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.port != PORT
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("Evogent API URL must use the exact on-phone loopback origin")


def request(
    url: str,
    *,
    data: Optional[bytes] = None,
    headers: Optional[Mapping[str, str]] = None,
    timeout: int = 20,
    method: Optional[str] = None,
) -> Response:
    """Call one local Evogent endpoint through the fail-closed shell client."""

    _validate_url(url)
    command = [
        str(EVO_CURL),
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--max-time",
        str(timeout),
        "--write-out",
        "\nEVOGENT_HTTP_STATUS:%{http_code}",
    ]
    if method:
        command.extend(["--request", method])
    if headers:
        for name, value in headers.items():
            if name.lower() == "x-evogent-server-secret":
                raise ValueError("callers may not provide the server credential header")
            command.extend(["--header", f"{name}: {value}"])
    if data is not None:
        command.extend(["--data-binary", "@-"])
    command.append(url)

    completed = subprocess.run(
        command,
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(detail or f"Evogent API request failed ({completed.returncode})")
    body, marker, status_bytes = completed.stdout.rpartition(_STATUS_MARKER)
    if not marker or not status_bytes.isdigit():
        raise RuntimeError("Evogent API response did not include an HTTP status")
    return Response(body=body, status=int(status_bytes))


def post_json(url: str, payload: bytes, *, timeout: int = 20) -> Response:
    return request(
        url,
        data=payload,
        headers={"content-type": "application/json"},
        timeout=timeout,
        method="POST",
    )
