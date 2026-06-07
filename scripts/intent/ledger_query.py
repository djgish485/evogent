#!/usr/bin/env python3
"""Query and record evidence from the Evogent intent ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_DB = Path(".intent-ledger/evogent-intent-ledger.sqlite")
AUDIT_DIR = Path("data/intent-audits")
VECTOR_SCRIPT = Path("scripts/intent/vectorize-intent-ledger.ts")
AUDIT_ARTIFACT_MARKERS = ("data/intent-audits/", "/data/intent-audits/")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def repo_root() -> Path:
    try:
        out = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
        return Path(out)
    except Exception:
        return Path.cwd()


def resolve_db(path: str | None) -> Path:
    value = path or os.environ.get("EVOGENT_INTENT_LEDGER_DB") or str(DEFAULT_DB)
    db = Path(value)
    if not db.is_absolute():
        db = repo_root() / db
    if not db.exists():
        raise SystemExit(f"intent ledger DB not found: {db}")
    return db


def connect(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    return conn


def current_git() -> dict[str, str | None]:
    root = repo_root()
    def run(args: list[str]) -> str | None:
        try:
            return subprocess.check_output(args, cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
        except Exception:
            return None
    return {
        "root": str(root),
        "branch": run(["git", "branch", "--show-current"]),
        "head": run(["git", "rev-parse", "HEAD"]),
        "status_short_hash": hashlib.sha256((run(["git", "status", "--short"]) or "").encode()).hexdigest(),
    }


def table_count(conn: sqlite3.Connection, name: str) -> int:
    try:
        return int(conn.execute(f"select count(*) from {name}").fetchone()[0])
    except sqlite3.Error:
        return 0


def summary(conn: sqlite3.Connection, db: Path) -> dict[str, Any]:
    meta_rows = conn.execute("select key, value from meta order by key").fetchall()
    meta = {row["key"]: maybe_json(row["value"]) for row in meta_rows}
    tables = [
        "commits",
        "commit_files",
        "sessions",
        "session_files",
        "turns",
        "docs",
        "feed_backups",
        "db_snapshots",
        "signals",
    ]
    return {
        "db": str(db),
        "generated_at": utc_now(),
        "git": current_git(),
        "meta": meta,
        "counts": {name: table_count(conn, name) for name in tables},
    }


def maybe_json(value: str) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return value


def like(term: str) -> str:
    return f"%{term.lower()}%"


def search_ledger(conn: sqlite3.Connection, terms: list[str], limit: int) -> dict[str, list[dict[str, Any]]]:
    results: dict[str, list[dict[str, Any]]] = {}
    for term in terms:
        needle = like(term)
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        fts_query = to_fts_query(term)
        if fts_query:
            for row in conn.execute(
                """
                select 'turn_fts' as source, 'turn' as category, session_id as keyword, timestamp, session_id as title,
                       snippet(turn_fts, 0, '[', ']', '...', 48) as excerpt,
                       'turns' as source_table, path || ':' || timestamp as source_id,
                       bm25(turn_fts) as rank
                from turn_fts
                where turn_fts match ?
                order by rank
                limit ?
                """,
                (fts_query, limit),
            ):
                add_row(rows, seen, dict(row))
            for row in conn.execute(
                """
                select 'doc_fts' as source, kind as category, rel_path as keyword, null as timestamp, rel_path as title,
                       snippet(doc_fts, 0, '[', ']', '...', 48) as excerpt,
                       'docs' as source_table, rel_path as source_id,
                       bm25(doc_fts) as rank
                from doc_fts
                where doc_fts match ?
                  and rel_path not like 'data/intent-audits/%'
                order by rank
                limit ?
                """,
                (fts_query, max(3, limit // 2) * 5),
            ):
                add_row(rows, seen, dict(row))
            for row in conn.execute(
                """
                select 'commit_fts' as source, 'commit' as category, sha as keyword, commit_date as timestamp, subject as title,
                       snippet(commit_fts, 1, '[', ']', '...', 48) as excerpt,
                       'commits' as source_table, sha as source_id,
                       bm25(commit_fts) as rank
                from commit_fts
                where commit_fts match ?
                order by rank
                limit ?
                """,
                (fts_query, max(3, limit // 2)),
            ):
                add_row(rows, seen, dict(row))
        for row in conn.execute(
            """
            select 'signals' as source, category, keyword, timestamp, title, excerpt, source_table, source_id
            from signals
            where lower(coalesce(title,'') || ' ' || coalesce(excerpt,'') || ' ' || coalesce(category,'') || ' ' || coalesce(keyword,'')) like ?
              and coalesce(source_id, '') not like 'data/intent-audits/%'
              and instr(coalesce(source_id, ''), '/data/intent-audits/') = 0
              and coalesce(title, '') not like 'data/intent-audits/%'
            order by timestamp desc
            limit ?
            """,
            (needle, limit * 5),
        ):
            add_row(rows, seen, dict(row))
        remaining = max(0, limit - len(rows))
        if remaining:
            for row in conn.execute(
                """
                select 'turns' as source, type as category, role as keyword, timestamp, session_id as title,
                       substr(content, 1, 500) as excerpt, 'turns' as source_table, cast(id as text) as source_id
                from turns
                where lower(coalesce(content,'')) like ?
                order by timestamp desc
                limit ?
                """,
                (needle, remaining),
            ):
                add_row(rows, seen, dict(row))
        remaining = max(0, limit - len(rows))
        if remaining:
            for row in conn.execute(
                """
                select 'docs' as source, kind as category, rel_path as keyword, mtime as timestamp, title,
                       substr(content, 1, 500) as excerpt, 'docs' as source_table, path as source_id
                from docs
                where lower(coalesce(content,'') || ' ' || coalesce(rel_path,'')) like ?
                  and rel_path not like 'data/intent-audits/%'
                order by mtime desc
                limit ?
                """,
                (needle, remaining * 5),
            ):
                add_row(rows, seen, dict(row))
        remaining = max(0, limit - len(rows))
        if remaining:
            for row in conn.execute(
                """
                select 'commits' as source, 'commit' as category, abbrev as keyword, commit_date as timestamp,
                       subject as title, substr(coalesce(body,'') || char(10) || coalesce(diffstat,''), 1, 500) as excerpt,
                       'commits' as source_table, sha as source_id
                from commits
                where lower(coalesce(subject,'') || ' ' || coalesce(body,'') || ' ' || coalesce(diffstat,'')) like ?
                order by commit_ts desc
                limit ?
                """,
                (needle, remaining),
            ):
                add_row(rows, seen, dict(row))
        results[term] = rows
    return results


def vector_searches(db: Path, terms: list[str], limit: int, timeout: int) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    for term in terms:
        results[term] = vector_search(db, term, limit, timeout)
    return results


def vector_search(db: Path, term: str, limit: int, timeout: int) -> dict[str, Any]:
    started = time.perf_counter()
    env = os.environ.copy()
    env["EVOGENT_INTENT_LEDGER_DB"] = str(db)
    try:
        proc = subprocess.run(
            [
                "npx",
                "tsx",
                str(VECTOR_SCRIPT),
                "search",
                "--limit",
                str(limit),
                "--query",
                term,
            ],
            cwd=repo_root(),
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except Exception as exc:
        return {
            "elapsed_ms": elapsed_ms(started),
            "error": str(exc),
            "rows": [],
        }
    if proc.returncode != 0:
        return {
            "elapsed_ms": elapsed_ms(started),
            "error": (proc.stderr or proc.stdout).strip(),
            "rows": [],
        }
    try:
        payload = json.loads(extract_json_object(proc.stdout))
    except Exception as exc:
        return {
            "elapsed_ms": elapsed_ms(started),
            "error": f"could not parse vector output: {exc}",
            "rows": [],
        }
    return {
        "elapsed_ms": elapsed_ms(started),
        "error": None,
        "rows": payload.get("rows", []),
    }


def elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


def extract_json_object(output: str) -> str:
    start = output.find("{")
    end = output.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object found")
    return output[start : end + 1]


def add_row(rows: list[dict[str, Any]], seen: set[str], row: dict[str, Any]) -> None:
    if is_generated_audit_artifact(row):
        return
    key = f"{row.get('source_table') or row.get('source')}:{row.get('source_id') or row.get('title')}"
    excerpt_key = excerpt_fingerprint(row)
    if key in seen or (excerpt_key and excerpt_key in seen):
        return
    seen.add(key)
    if excerpt_key:
        seen.add(excerpt_key)
    rows.append(row)


def is_generated_audit_artifact(row: dict[str, Any]) -> bool:
    """Keep generated audit notes from becoming primary intent evidence."""
    fields = [
        row.get("source_id"),
        row.get("title"),
        row.get("keyword"),
    ]
    return any(
        any(marker in str(field) for marker in AUDIT_ARTIFACT_MARKERS)
        for field in fields
        if field
    )


def excerpt_fingerprint(row: dict[str, Any]) -> str:
    excerpt = " ".join(str(row.get("excerpt") or "").split()).lower()
    if len(excerpt) < 120:
        return ""
    return "excerpt:" + excerpt[:320]


def to_fts_query(term: str) -> str:
    words = [word for word in re_words(term) if len(word) > 1]
    if not words:
        return ""
    if len(words) == 1:
        return escape_fts(words[0])
    return " OR ".join(escape_fts(word) for word in words)


def re_words(value: str) -> list[str]:
    import re

    return re.findall(r"[A-Za-z0-9_'-]+", value.lower())


def escape_fts(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def write_audit(payload: dict[str, Any]) -> tuple[Path, Path]:
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = AUDIT_DIR / f"intent-audit-{stamp}.json"
    md_path = AUDIT_DIR / f"intent-audit-{stamp}.md"
    latest_path = AUDIT_DIR / "latest.json"
    latest_md = AUDIT_DIR / "latest.md"
    text = render_markdown(payload)
    json_text = json.dumps(payload, indent=2, sort_keys=True)
    json_path.write_text(json_text + "\n")
    latest_path.write_text(json_text + "\n")
    md_path.write_text(text)
    latest_md.write_text(text)
    return json_path, md_path


def render_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Intent Audit",
        "",
        f"- Created: `{payload['created_at']}`",
        f"- Ledger DB: `{payload['ledger']['db']}`",
        f"- Git branch: `{payload['git'].get('branch')}`",
        f"- Git HEAD: `{payload['git'].get('head')}`",
        "",
        "## Terms",
        "",
    ]
    for term in payload["terms"]:
        lines.append(f"- `{term}`")
    lines.extend(["", "## Evidence", ""])
    for term, rows in payload["hits"].items():
        lines.append(f"### {term}")
        if not rows:
            lines.append("")
            lines.append("No hits.")
            lines.append("")
            continue
        for row in rows:
            title = row.get("title") or row.get("source_id") or "(untitled)"
            excerpt = " ".join(str(row.get("excerpt") or "").split())
            if len(excerpt) > 360:
                excerpt = excerpt[:357] + "..."
            lines.append(f"- `{row.get('timestamp')}` `{row.get('source')}` `{row.get('category')}` {title}: {excerpt}")
        lines.append("")
    vector_hits = payload.get("vector_hits") or {}
    if vector_hits:
        lines.extend(["## Vector Evidence", ""])
        for term, result in vector_hits.items():
            lines.append(f"### {term}")
            elapsed = result.get("elapsed_ms")
            if elapsed is not None:
                lines.append(f"- Search time: `{elapsed}ms`")
            error = result.get("error")
            if error:
                lines.append(f"- Error: `{error}`")
                lines.append("")
                continue
            rows = result.get("rows") or []
            if not rows:
                lines.append("")
                lines.append("No vector hits.")
                lines.append("")
                continue
            for row in rows:
                title = row.get("title") or row.get("source_id") or "(untitled)"
                excerpt = " ".join(str(row.get("excerpt") or "").split())
                if len(excerpt) > 360:
                    excerpt = excerpt[:357] + "..."
                distance = row.get("distance")
                distance_text = f" distance={distance:.3f}" if isinstance(distance, (int, float)) else ""
                lines.append(
                    f"- `{row.get('timestamp')}` `{row.get('source_table')}`{distance_text} {title}: {excerpt}"
                )
            lines.append("")
    lines.append("## Ledger Counts")
    lines.append("")
    for name, count in payload["ledger"].get("counts", {}).items():
        lines.append(f"- `{name}`: {count}")
    lines.append("")
    return "\n".join(lines)


def read_query_terms(args: argparse.Namespace) -> list[str]:
    terms: list[str] = []
    for query in getattr(args, "query", []) or []:
        value = query.strip()
        if value:
            terms.append(value)
    for term in getattr(args, "terms", []) or []:
        value = term.strip()
        if value:
            terms.append(value)
    positional = " ".join(getattr(args, "query_text", []) or []).strip()
    if positional:
        terms.append(positional)
    if not terms:
        raise SystemExit("search/audit requires --query, --terms, or positional query text")
    return terms


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", help="Path to intent ledger DB")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("summary")

    search = sub.add_parser("search")
    search.add_argument("--terms", nargs="+", default=[])
    search.add_argument("--query", action="append", default=[])
    search.add_argument("query_text", nargs="*")
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--json", action="store_true")

    audit = sub.add_parser("audit")
    audit.add_argument("--terms", nargs="+", default=[])
    audit.add_argument("--query", action="append", default=[])
    audit.add_argument("query_text", nargs="*")
    audit.add_argument("--limit", type=int, default=12)
    audit.add_argument("--vector", action="store_true", help="Include optional local vector-search evidence")
    audit.add_argument("--vector-limit", type=int, default=5)
    audit.add_argument("--vector-timeout", type=int, default=60)

    args = parser.parse_args()
    db = resolve_db(args.db)
    with connect(db) as conn:
        if args.cmd == "summary":
            print(json.dumps(summary(conn, db), indent=2, sort_keys=True))
            return
        terms = read_query_terms(args)
        hits = search_ledger(conn, terms, args.limit)
        if args.cmd == "search":
            if args.json:
                print(json.dumps(hits, indent=2, sort_keys=True))
            else:
                print(render_markdown({"created_at": utc_now(), "ledger": summary(conn, db), "git": current_git(), "terms": terms, "hits": hits}))
            return
        payload = {
            "created_at": utc_now(),
            "ledger": summary(conn, db),
            "git": current_git(),
            "terms": terms,
            "hits": hits,
        }
        if args.vector:
            payload["vector_hits"] = vector_searches(db, terms, args.vector_limit, args.vector_timeout)
        json_path, md_path = write_audit(payload)
        print(f"wrote {json_path}")
        print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
