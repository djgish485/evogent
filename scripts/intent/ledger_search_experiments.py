#!/usr/bin/env python3
"""Compare intent-ledger retrieval strategies on known Evogent intent questions."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from ledger_query import resolve_db, search_ledger, utc_now


QUERIES = [
    {
        "name": "bounded slate without a minimum",
        "query": "primary slate maximum 50 no minimum output quota",
        "must": ["50", "minimum", "quota"],
    },
    {
        "name": "complete eligible review",
        "query": "deterministic mechanics present full eligible accepted unviewed set runtime agent judges value freshness",
        "must": ["eligible", "unviewed", "judg"],
    },
    {
        "name": "connector headings",
        "query": "connector headings quick curator reason why included",
        "must": ["connector", "headings", "why"],
    },
    {
        "name": "shipment thread integrity",
        "query": "stable shipment thread id no split thread singleton remains singleton",
        "must": ["thread", "singleton"],
    },
    {
        "name": "scratch ledger mistake",
        "query": "small scratch ledger cannot replace canonical phone private evidence",
        "must": ["scratch", "ledger"],
    },
    {
        "name": "query workflow guardrail",
        "query": "when working on Evogent read public product laws and canonical phone private intent ledger before changing behavior",
        "must": ["phone", "ledger"],
    },
    {
        "name": "semantic small curation",
        "query": "is a small or empty curation allowed when only a few things are worthwhile",
        "expanded_query": "no minimum volume quota runtime agent judgment truthful completion receipt",
        "must": ["minimum", "receipt"],
    },
]


def direct_like(conn: sqlite3.Connection, query: str, limit: int = 8) -> list[dict]:
    terms = [word.lower() for word in query.split() if len(word) > 2]
    needle_clauses = " or ".join(["lower(coalesce(excerpt,'') || ' ' || coalesce(title,'')) like ?" for _ in terms])
    if not needle_clauses:
        return []
    sql = f"""
    select 'signals' as source, category, keyword, timestamp, title, substr(excerpt, 1, 320) as excerpt
    from signals
    where ({needle_clauses})
      and coalesce(source_id, '') not like 'data/intent-audits/%'
      and instr(coalesce(source_id, ''), '/data/intent-audits/') = 0
      and coalesce(title, '') not like 'data/intent-audits/%'
      and not (
        source_table = 'docs'
        and (
          source_id = '.intent/contracts.jsonl'
          or source_id like '%/.intent/contracts.jsonl'
        )
      )
    order by timestamp desc
    limit ?
    """
    params = [f"%{term}%" for term in terms]
    params.append(limit)
    return [dict(row) for row in conn.execute(sql, params)]


def score(rows: list[dict], must: list[str]) -> dict:
    blob = "\n".join(json.dumps(row, sort_keys=True).lower() for row in rows)
    hits = [term for term in must if term.lower() in blob]
    missing = [term for term in must if term.lower() not in blob]
    return {"hits": hits, "missing": missing, "hit_count": len(hits), "row_count": len(rows)}


def passes(scorecard: dict) -> bool:
    return bool(scorecard["row_count"]) and not scorecard["missing"]


def run_vector_search(query: str, limit: int = 5) -> tuple[list[dict], float, str | None]:
    started = time.perf_counter()
    try:
        proc = subprocess.run(
            [
                "npx",
                "tsx",
                "scripts/intent/vectorize-intent-ledger.ts",
                "search",
                "--limit",
                str(limit),
                "--query",
                query,
            ],
            check=False,
            text=True,
            capture_output=True,
            timeout=30,
        )
    except Exception as exc:
        return [], round((time.perf_counter() - started) * 1000, 2), str(exc)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    if proc.returncode != 0:
        return [], elapsed_ms, (proc.stderr or proc.stdout).strip()
    try:
        payload = json.loads(extract_json_object(proc.stdout))
    except Exception as exc:
        return [], elapsed_ms, f"could not parse vector output: {exc}"
    return payload.get("rows", []), elapsed_ms, None


def extract_json_object(output: str) -> str:
    start = output.find("{")
    end = output.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object found")
    return output[start : end + 1]


def compact_row(case: dict) -> dict:
    workflow_score = case["expanded_hybrid_score"] or case["hybrid_score"]
    vector_errors = [
        value
        for value in [case.get("vector_error"), case.get("expanded_vector_error")]
        if value
    ]
    return {
        "name": case["name"],
        "workflow_pass": passes(workflow_score),
        "workflow_missing": workflow_score["missing"],
        "hybrid_ms": case["hybrid_ms"],
        "hybrid_hits": case["hybrid_score"]["hits"],
        "vector_ms": case["vector_ms"],
        "vector_hits": case["vector_score"]["hits"],
        "expanded_hybrid_ms": case.get("expanded_hybrid_ms"),
        "expanded_hybrid_hits": (case.get("expanded_hybrid_score") or {}).get("hits") or [],
        "vector_error": "; ".join(vector_errors),
    }


def render_markdown(report: dict) -> str:
    rows = [compact_row(case) for case in report["queries"]]
    lines = [
        "# Intent Ledger Search Experiments",
        "",
        f"- Created: `{report['created_at']}`",
        f"- DB: `{report['db']}`",
        "",
        "## Verdict",
        "",
        "Hybrid retrieval is the default workflow: run the user's natural-language query, then use an Evogent-domain expansion for current contracts such as `full eligible set`, `private judgment`, `maximum 50`, `no minimum`, `stable thread id`, `singleton`, and `completion receipt`.",
        "",
        "Vector search is useful as a semantic second pass, but these fixtures deliberately keep it from becoming the only source of truth. Structural product contracts must still be checked with committed and runtime evidence.",
        "",
        "## Results",
        "",
        "| Case | Workflow | Hybrid | Vector | Expanded Hybrid | Missing |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        workflow = "pass" if row["workflow_pass"] else "fail"
        hybrid = f"{row['hybrid_ms']}ms: {', '.join(row['hybrid_hits']) or '-'}"
        vector = f"{row['vector_ms']}ms: {', '.join(row['vector_hits']) or '-'}"
        expanded = "-"
        if row["expanded_hybrid_ms"] is not None:
            expanded = f"{row['expanded_hybrid_ms']}ms: {', '.join(row['expanded_hybrid_hits']) or '-'}"
        missing = ", ".join(row["workflow_missing"]) or "-"
        lines.append(f"| {row['name']} | {workflow} | {hybrid} | {vector} | {expanded} | {missing} |")
    lines.extend([
        "",
        "## Guardrail",
        "",
        "The experiment exits nonzero when the recommended workflow cannot retrieve all required fixture terms or when vector search errors. A vector miss is not a failure by itself; it is evidence that vector-only querying is unsafe for hard contracts.",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    db = resolve_db(None)
    report = {"created_at": utc_now(), "db": str(db), "queries": []}
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        for case in QUERIES:
            expanded_query = case.get("expanded_query")
            started = time.perf_counter()
            hybrid = search_ledger(conn, [case["query"]], 8)[case["query"]]
            hybrid_ms = round((time.perf_counter() - started) * 1000, 2)
            expanded_hybrid = []
            expanded_hybrid_ms = None
            if expanded_query:
                started = time.perf_counter()
                expanded_hybrid = search_ledger(conn, [expanded_query], 8)[expanded_query]
                expanded_hybrid_ms = round((time.perf_counter() - started) * 1000, 2)
            started = time.perf_counter()
            like = direct_like(conn, case["query"], 8)
            like_ms = round((time.perf_counter() - started) * 1000, 2)
            vector, vector_ms, vector_error = run_vector_search(case["query"])
            expanded_vector = []
            expanded_vector_ms = None
            expanded_vector_error = None
            if expanded_query:
                expanded_vector, expanded_vector_ms, expanded_vector_error = run_vector_search(expanded_query)
            hybrid_score = score(hybrid, case["must"])
            expanded_hybrid_score = score(expanded_hybrid, case["must"]) if expanded_query else None
            vector_score = score(vector, case["must"])
            expanded_vector_score = score(expanded_vector, case["must"]) if expanded_query else None
            report["queries"].append({
                "name": case["name"],
                "query": case["query"],
                "expanded_query": expanded_query,
                "hybrid_ms": hybrid_ms,
                "hybrid_score": hybrid_score,
                "hybrid_top": hybrid[:3],
                "expanded_hybrid_ms": expanded_hybrid_ms,
                "expanded_hybrid_score": expanded_hybrid_score,
                "expanded_hybrid_top": expanded_hybrid[:3],
                "like_ms": like_ms,
                "like_score": score(like, case["must"]),
                "like_top": like[:3],
                "vector_ms": vector_ms,
                "vector_score": vector_score,
                "vector_top": vector[:3],
                "vector_error": vector_error,
                "expanded_vector_ms": expanded_vector_ms,
                "expanded_vector_score": expanded_vector_score,
                "expanded_vector_top": expanded_vector[:3],
                "expanded_vector_error": expanded_vector_error,
            })
    out_dir = Path("data/intent-audits")
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "ledger-search-experiments-latest.json"
    md_path = out_dir / "ledger-search-experiments-latest.md"
    json_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    md_path.write_text(render_markdown(report))

    rows = [compact_row(case) for case in report["queries"]]
    failures = [
        row
        for row in rows
        if not row["workflow_pass"] or row["vector_error"]
    ]
    print(render_markdown(report))
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")
    if failures:
        print(json.dumps({"failures": failures}, indent=2, sort_keys=True), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
