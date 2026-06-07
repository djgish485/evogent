#!/usr/bin/env python3
"""Codex hook helper for Evogent intent-ledger guardrails."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


TRIGGER = re.compile(
    r"\b(evogent|curat|feed|thread|connector|heading|openclaw|cache|source|regression|intent|ledger|why database|older|unviewed)\b",
    re.IGNORECASE,
)


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


def latest_audit_exists(cwd: Path) -> bool:
    return (cwd / "data/intent-audits/latest.json").exists()


def main() -> None:
    event = load()
    name = event.get("hook_event_name")
    cwd = Path(event.get("cwd") or ".")
    if not is_evogent_repo(cwd):
        return

    if name == "SessionStart":
        emit_context(
            "SessionStart",
            "Evogent intent guardrail: for curation/feed/thread/connector/OpenClaw/regression work, query `.intent-ledger/evogent-intent-ledger.sqlite` with `python3 scripts/intent/ledger_query.py audit --query ...` before editing or claiming behavior is correct.",
        )
        return

    if name == "UserPromptSubmit":
        prompt = str(event.get("prompt") or "")
        if TRIGGER.search(prompt):
            emit_context(
                "UserPromptSubmit",
                "This Evogent prompt appears intent-sensitive. Use the canonical intent ledger, not scratch notes: run `python3 scripts/intent/ledger_query.py audit --query ...` and inspect `data/intent-audits/latest.md` before implementation or final claims.",
            )
        return

    if name == "Stop":
        last = str(event.get("last_assistant_message") or "")
        if TRIGGER.search(last) and not latest_audit_exists(cwd):
            print(json.dumps({
                "decision": "block",
                "reason": "Before finishing Evogent intent-sensitive work, run `python3 scripts/intent/ledger_query.py audit --query ...` and use the generated evidence artifact. The canonical ledger guardrail exists to prevent scratch-ledger shortcuts.",
            }))


if __name__ == "__main__":
    main()
