#!/usr/bin/env python3
"""Write an intent-audit artifact for the current Evogent task.

This is a low-friction wrapper around ledger_query.py. It keeps the user's
wording, adds Evogent's known guardrail wording, and includes vector evidence
by default so repair agents do not rely on memory when starting work.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

from ledger_query import (
    connect,
    current_git,
    resolve_db,
    search_ledger,
    summary,
    utc_now,
    vector_searches,
    write_audit,
)


BASE_GUARDRAIL_QUERY = " ".join(
    [
        "Evogent phone runtime private intent ledger public product laws no stale VM scratch shortcut",
        "full eligible set accepted unviewed runtime agent private freshness value judgment",
        "primary slate maximum 50 no minimum output source type analysis quota truthful completion receipt",
        "stable shipment thread id no split thread singleton remains singleton",
        "connector headings curator reason primary rows remain visible",
    ]
)

TOPICAL_QUERIES = [
    (
        {"curate", "curation", "curator", "openclaw", "heartbeat", "cadence", "frequency"},
        "phone-owned hint-free runtime curator full eligible set private judgment primary slate maximum 50 no minimum quota truthful completion receipt",
    ),
    (
        {"feed", "thread", "threads", "heading", "headings", "connector", "reorder", "ordering", "unread", "unviewed"},
        "feed primary slate full eligible accepted unviewed private value freshness judgment stable thread id no split singleton connector heading primary rows visible",
    ),
    (
        {"browse", "cache", "source", "sources", "candidate", "candidates", "duplicate", "published"},
        "browse cache source candidates publishedAt duplicate sourceId submittable curation candidate quality",
    ),
    (
        {"permission", "permissions", "approval", "approve", "ask", "sandbox", "escalation"},
        "full permission do not ask approval request_user_input sandbox escalation full-access session",
    ),
    (
        {"intent", "ledger", "database", "vector", "why", "history", "commit", "chat", "scratch"},
        "public product laws canonical phone private intent ledger runtime database no stale host VM scratch ledger shortcut",
    ),
]


def words(value: str) -> set[str]:
    import re

    return {word.lower() for word in re.findall(r"[A-Za-z0-9_'-]+", value)}


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        cleaned = " ".join(value.split())
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(cleaned)
    return result


def infer_queries(task: str) -> list[str]:
    task_words = words(task)
    queries = [BASE_GUARDRAIL_QUERY]
    for triggers, query in TOPICAL_QUERIES:
        if task_words & triggers:
            queries.append(query)
    return queries


def render_console_summary(payload: dict[str, Any], json_path: object, md_path: object) -> dict[str, Any]:
    terms = payload["terms"]
    hits = payload["hits"]
    vector_hits = payload.get("vector_hits") or {}
    return {
        "artifact_json": str(json_path),
        "artifact_md": str(md_path),
        "query_count": len(terms),
        "queries": terms,
        "hit_counts": {term: len(hits.get(term) or []) for term in terms},
        "vector_hit_counts": {
            term: len((result or {}).get("rows") or [])
            for term, result in vector_hits.items()
        },
        "ledger_counts": payload["ledger"].get("counts", {}),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", nargs="*", help="Current task or concern, in the user's words")
    parser.add_argument("--query", action="append", default=[], help="Additional exact query to include")
    parser.add_argument("--extra", action="append", default=[], help="Additional domain query to include")
    parser.add_argument("--db", help="Path to the canonical intent ledger DB")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--vector-limit", type=int, default=5)
    parser.add_argument("--vector-timeout", type=int, default=60)
    parser.add_argument("--no-vector", action="store_true", help="Skip the vector second pass")
    args = parser.parse_args()

    task = " ".join(args.task).strip()
    if not task and not args.query:
        raise SystemExit("usage: query_relevant_intent.py <current task> [--query ...]")

    terms = dedupe([task, *args.query, *infer_queries(task), *args.extra])
    db = resolve_db(args.db)
    with connect(db) as conn:
        payload: dict[str, Any] = {
            "created_at": utc_now(),
            "purpose": "task_intent_context",
            "ledger": summary(conn, db),
            "git": current_git(),
            "terms": terms,
            "hits": search_ledger(conn, terms, args.limit),
        }
    if not args.no_vector:
        payload["vector_hits"] = vector_searches(db, terms, args.vector_limit, args.vector_timeout)
    json_path, md_path = write_audit(payload)
    print(json.dumps(render_console_summary(payload, json_path, md_path), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
