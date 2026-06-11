#!/usr/bin/env python3
"""Codex hook helper for Evogent intent-ledger guardrails."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any


TRIGGER = re.compile(
    r"\b(evogent|curat|feed|thread|connector|heading|openclaw|cache|source|regression|intent|ledger|why database|older|unviewed)\b",
    re.IGNORECASE,
)
PROMPT_MARKER = Path(".intent-ledger/current-intent-sensitive-prompt.json")
LATEST_AUDIT = Path("data/intent-audits/latest.json")


def load() -> dict[str, Any]:
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def emit_context(event: str, text: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": text,
        }
    }))


def is_evogent_repo(cwd: Path) -> bool:
    return (cwd / "AGENTS.md").exists() and ((cwd / "data/media-agent.db").exists() or (cwd / ".intent-ledger").exists())


def marker_path(cwd: Path) -> Path:
    return cwd / PROMPT_MARKER


def latest_audit_path(cwd: Path) -> Path:
    return cwd / LATEST_AUDIT


def latest_audit_is_fresh(cwd: Path) -> bool:
    latest = latest_audit_path(cwd)
    marker = marker_path(cwd)
    if not latest.exists() or not marker.exists():
        return False
    try:
        return latest.stat().st_mtime >= marker.stat().st_mtime
    except OSError:
        return False


def write_prompt_marker(cwd: Path, prompt: str) -> None:
    marker = marker_path(cwd)
    marker.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "created_at_epoch": time.time(),
        "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
        "prompt_excerpt": " ".join(prompt.split())[:500],
    }
    marker.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def main() -> None:
    event = load()
    name = event.get("hook_event_name")
    cwd = Path(event.get("cwd") or ".")
    if not is_evogent_repo(cwd):
        return

    if name == "SessionStart":
        emit_context(
            "SessionStart",
            "Evogent intent guardrail: for curation/feed/thread/connector/OpenClaw/regression work, query the canonical ledger with `python3 scripts/intent/query_relevant_intent.py \"<current task>\"` before editing or claiming behavior is correct.",
        )
        return

    if name == "UserPromptSubmit":
        prompt = str(event.get("prompt") or "")
        if TRIGGER.search(prompt):
            write_prompt_marker(cwd, prompt)
            emit_context(
                "UserPromptSubmit",
                "This Evogent prompt appears intent-sensitive. Use the canonical intent ledger, not scratch notes: run `python3 scripts/intent/query_relevant_intent.py \"<current task in the user's words>\"` and inspect `data/intent-audits/latest.md` before implementation or final claims.",
            )
        return

    if name == "Stop":
        marker = marker_path(cwd)
        if marker.exists() and not latest_audit_is_fresh(cwd):
            print(json.dumps({
                "decision": "block",
                "reason": "Before finishing this Evogent intent-sensitive task, run `python3 scripts/intent/query_relevant_intent.py \"<current task>\"` and use the fresh `data/intent-audits/latest.md` evidence artifact. The latest audit must be newer than the current intent-sensitive prompt marker.",
            }))
            return

        last = str(event.get("last_assistant_message") or "")
        if TRIGGER.search(last) and not latest_audit_path(cwd).exists():
            print(json.dumps({
                "decision": "block",
                "reason": "Before finishing Evogent intent-sensitive work, run `python3 scripts/intent/query_relevant_intent.py \"<current task>\"` and use the generated evidence artifact. The canonical ledger guardrail exists to prevent scratch-ledger shortcuts.",
            }))


if __name__ == "__main__":
    main()
