#!/data/data/com.termux/files/usr/bin/env python3
"""Provider-compatible CLI invocation for phone-side bounded agent helpers.

Model routing happens before these helpers start. This module preserves that exact
provider/model/effort choice instead of silently sending a Claude model to Codex
or dropping the selected Claude effort. Deterministic helpers never import it.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import IO, Iterable, Mapping


SAFE_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$")
ALLOWED_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max", "ultra"})
ALLOWED_PROVIDERS = frozenset({"claude", "codex"})
CLAUDE_ALLOWED_TOOLS = "Bash,Read,Write,Glob,Grep"


def selected_provider(value: str | None = None) -> str:
    """Return the explicit phone brain provider, defaulting only for standalone use."""

    raw = os.environ.get("EVOGENT_BRAIN_PROVIDER", "codex") if value is None else value
    normalized = re.sub(r"[^a-z0-9]+", "", str(raw).strip().lower())
    if normalized in {"claude", "claudecode", "claudecodecli"}:
        return "claude"
    if normalized in {"codex", "codexcli"}:
        return "codex"
    raise ValueError("unsupported phone brain provider")


def _validated_route(provider: str, model: str, effort: str) -> tuple[str, str, str]:
    provider = selected_provider(provider)
    model = str(model or "").strip()
    effort = str(effort or "").strip().lower()
    if SAFE_MODEL.fullmatch(model) is None:
        raise ValueError("unsafe provider model")
    if effort not in ALLOWED_EFFORTS:
        raise ValueError("unsupported provider effort")
    normalized_model = model.lower()
    if provider == "claude":
        if not (
            normalized_model.startswith("claude-")
            or normalized_model in {"haiku", "sonnet", "opus"}
        ):
            raise ValueError("Claude provider received a non-Claude model")
    elif (
        normalized_model.startswith("claude-")
        or normalized_model in {"haiku", "sonnet", "opus"}
    ):
        raise ValueError("Codex provider received a Claude model")
    return provider, model, effort


def _claude_environment(base: Mapping[str, str] | None = None) -> dict[str, str]:
    environment = dict(os.environ if base is None else base)
    environment.pop("ANTHROPIC_API_KEY", None)
    try:
        token = (Path.home() / ".evogent-oauth-token").read_text(
            encoding="utf-8"
        ).strip()
    except OSError:
        token = ""
    if token:
        environment["CLAUDE_CODE_OAUTH_TOKEN"] = token
    return environment


def provider_invocation(
    prompt: str,
    *,
    provider: str,
    model: str,
    effort: str,
    image_paths: Iterable[str | os.PathLike[str]] = (),
    environment: Mapping[str, str] | None = None,
) -> tuple[list[str], bytes, dict[str, str]]:
    """Build one exact selected-provider command and its stdin/environment."""

    provider, model, effort = _validated_route(provider, model, effort)
    images = [str(Path(value).expanduser().resolve()) for value in image_paths]
    if provider == "codex":
        command = [
            "codex",
            "exec",
            "--model",
            model,
            "-c",
            f"model_reasoning_effort={effort}",
            "--dangerously-bypass-approvals-and-sandbox",
        ]
        for image_path in images:
            command.extend(("-i", image_path))
        command.append("-")
        return command, prompt.encode(), dict(os.environ if environment is None else environment)

    if images:
        prompt = (
            prompt
            + "\n\nLOCAL IMAGE EVIDENCE (use the Read tool on each exact path):\n"
            + "\n".join(f"- {image_path}" for image_path in images)
            + "\n"
        )
    command = [
        "claude",
        "-p",
        "--model",
        model,
        "--effort",
        effort,
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        CLAUDE_ALLOWED_TOOLS,
    ]
    return command, prompt.encode(), _claude_environment(environment)


def run_provider(
    prompt: str,
    *,
    provider: str,
    model: str,
    effort: str,
    cwd: str | os.PathLike[str],
    timeout: int | float,
    image_paths: Iterable[str | os.PathLike[str]] = (),
    stdout: int | IO[bytes] | None = None,
    stderr: int | IO[bytes] | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    """Run one bounded helper call through the already resolved provider route."""

    command, stdin, environment = provider_invocation(
        prompt,
        provider=provider,
        model=model,
        effort=effort,
        image_paths=image_paths,
    )
    return subprocess.run(
        command,
        cwd=cwd,
        input=stdin,
        timeout=timeout,
        stdout=stdout,
        stderr=stderr,
        check=check,
        env=environment,
    )
