#!/usr/bin/env python3
"""Audit Evogent intent-ledger coverage and freshness."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_DB = Path(".intent-ledger/evogent-intent-ledger.sqlite")
AUDIT_DIR = Path("data/intent-audits")
CLAUDE_PROJECT_PATTERNS = [
    Path("/root/.claude/projects/-root-media-agent"),
]
KEY_DOCS = [
    "AGENTS.md",
    "docs/intent-ledger.md",
    ".agents/skills/evogent-intent-audit/SKILL.md",
    ".claude/commands/curate.md",
    "data/curation-prompt.md",
    "data/preference-insights.md",
    "data/config.md",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def repo_root() -> Path:
    return Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())


def resolve_db(value: str | None) -> Path:
    db = Path(value) if value else DEFAULT_DB
    if not db.is_absolute():
        db = repo_root() / db
    if not db.exists():
        raise SystemExit(f"intent ledger DB not found: {db}")
    return db


def connect(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    return conn


def scalar(conn: sqlite3.Connection, query: str, params: tuple[Any, ...] = ()) -> Any:
    row = conn.execute(query, params).fetchone()
    return row[0] if row else None


def table_count(conn: sqlite3.Connection, name: str) -> int:
    try:
        return int(scalar(conn, f"select count(*) from {name}") or 0)
    except sqlite3.Error:
        return 0


def current_git() -> dict[str, str | None]:
    root = repo_root()

    def run(args: list[str]) -> str | None:
        try:
            return subprocess.check_output(args, cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
        except Exception:
            return None

    return {
        "branch": run(["git", "branch", "--show-current"]),
        "head": run(["git", "rev-parse", "HEAD"]),
        "status_short_hash": hashlib.sha256((run(["git", "status", "--short"]) or "").encode()).hexdigest(),
    }


def media_agent_claude_files() -> list[Path]:
    paths: list[Path] = []
    for root in CLAUDE_PROJECT_PATTERNS:
        if root.exists():
            paths.extend(root.rglob("*.jsonl"))
    return sorted(set(paths), key=lambda p: (p.stat().st_mtime, str(p)))


def key_doc_status(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    root = repo_root()
    rows = []
    for rel in KEY_DOCS:
        path = root / rel
        current_hash = None
        current_mtime = None
        exists = path.exists()
        if exists:
            content = path.read_text(errors="ignore")
            current_hash = hashlib.sha256(content.encode()).hexdigest()
            current_mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
        ledger = conn.execute(
            "select mtime, bytes, content_hash from docs where path = ? or rel_path = ?",
            (str(path), rel),
        ).fetchone()
        rows.append({
            "path": rel,
            "exists": exists,
            "current_mtime": current_mtime,
            "ledger_mtime": ledger["mtime"] if ledger else None,
            "current_hash": current_hash,
            "ledger_hash": ledger["content_hash"] if ledger else None,
            "fresh": bool(ledger and current_hash == ledger["content_hash"]),
        })
    return rows


def sample_missing_claude_files(missing: list[Path], limit: int = 20) -> list[dict[str, Any]]:
    sample = []
    for path in missing[:limit]:
        sample.append({
            "path": str(path),
            "bytes": path.stat().st_size,
            "mtime": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
        })
    return sample


def audit(db: Path) -> dict[str, Any]:
    git = current_git()
    with connect(db) as conn:
        integrity = scalar(conn, "pragma integrity_check")
        tables = {
            name: table_count(conn, name)
            for name in [
                "commits",
                "commit_files",
                "sessions",
                "session_files",
                "turns",
                "docs",
                "feed_backups",
                "db_snapshots",
                "signals",
                "turn_fts",
                "doc_fts",
                "commit_fts",
                "intent_vector_docs",
            ]
        }
        session_span = dict(conn.execute(
            """
            select min(first_ts) as first_ts, max(last_ts) as last_ts,
                   count(*) as files, sum(entry_count) as entries,
                   sum(user_count) as user_entries, sum(assistant_count) as assistant_entries,
                   sum(tool_use_count) as tool_entries, sum(is_subagent) as subagent_files
            from session_files
            where coalesce(first_ts, '') != ''
            """
        ).fetchone())
        turn_span = dict(conn.execute(
            "select min(timestamp) as first_ts, max(timestamp) as last_ts, count(*) as turns from turns where coalesce(timestamp, '') != ''"
        ).fetchone())
        quality = {
            "empty_timestamp_turns": table_count_where(conn, "turns", "timestamp is null or timestamp = ''"),
            "empty_content_turns": table_count_where(conn, "turns", "content is null or trim(content) = ''"),
            "orphan_turns_without_session": int(scalar(conn, "select count(*) from turns t left join sessions s on s.session_id=t.session_id where s.session_id is null") or 0),
            "turns_without_session_file_path": int(scalar(conn, "select count(*) from turns t left join session_files sf on sf.path=t.path where sf.path is null") or 0),
            "turn_fts_missing_nonempty": max(0, table_count_where(conn, "turns", "coalesce(content, '') != ''") - tables["turn_fts"]),
            "doc_fts_missing": max(0, tables["docs"] - tables["doc_fts"]),
            "commit_fts_missing": max(0, tables["commits"] - tables["commit_fts"]),
            "current_head_indexed": bool(git["head"] and scalar(conn, "select 1 from commits where sha = ?", (git["head"],))),
        }
        signal_categories = [
            dict(row)
            for row in conn.execute("select category, count(*) as count from signals group by category order by count desc")
        ]
        sessions_by_month = [
            dict(row)
            for row in conn.execute(
                """
                select substr(first_ts,1,7) as month, count(*) as files, sum(entry_count) as entries
                from session_files
                where coalesce(first_ts, '') != ''
                group by month order by month
                """
            )
        ]
        known_paths = {row[0] for row in conn.execute("select path from session_files")}
        media_files = media_agent_claude_files()
        missing = [path for path in media_files if str(path) not in known_paths]
        payload = {
            "created_at": utc_now(),
            "db": str(db),
            "db_bytes": db.stat().st_size,
            "git": git,
            "integrity": integrity,
            "tables": tables,
            "session_file_span": session_span,
            "turn_span": turn_span,
            "quality": quality,
            "signal_categories": signal_categories,
            "sessions_by_month": sessions_by_month,
            "key_docs": key_doc_status(conn),
            "claude_media_agent_files": {
                "filesystem_count": len(media_files),
                "indexed_count": len(media_files) - len(missing),
                "missing_count": len(missing),
                "missing_sample": sample_missing_claude_files(missing),
            },
        }
        payload["assessment"] = assess(payload)
        return payload


def table_count_where(conn: sqlite3.Connection, table: str, where: str) -> int:
    return int(scalar(conn, f"select count(*) from {table} where {where}") or 0)


def assess(payload: dict[str, Any]) -> dict[str, Any]:
    issues: list[str] = []
    if payload["integrity"] != "ok":
        issues.append("SQLite integrity check is not ok.")
    quality = payload["quality"]
    if not quality["current_head_indexed"]:
        issues.append("Current git HEAD is not indexed in commits.")
    if quality["turns_without_session_file_path"]:
        issues.append("Some turns refer to paths missing from session_files.")
    if quality["turn_fts_missing_nonempty"] > 50:
        issues.append("turn_fts is missing many non-empty turns.")
    if payload["claude_media_agent_files"]["missing_count"]:
        issues.append("Some /root/.claude/projects/-root-media-agent JSONL files are not indexed.")
    stale_docs = [row["path"] for row in payload["key_docs"] if row["exists"] and not row["fresh"]]
    if stale_docs:
        issues.append(f"Key docs are stale or missing in docs table: {', '.join(stale_docs)}.")
    return {
        "status": "pass" if not issues else "warn",
        "issues": issues,
    }


def write_report(payload: dict[str, Any]) -> tuple[Path, Path]:
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = AUDIT_DIR / f"intent-ledger-quality-{stamp}.json"
    md_path = AUDIT_DIR / f"intent-ledger-quality-{stamp}.md"
    json_text = json.dumps(payload, indent=2, sort_keys=True)
    json_path.write_text(json_text + "\n")
    (AUDIT_DIR / "intent-ledger-quality-latest.json").write_text(json_text + "\n")
    md_text = render_markdown(payload)
    md_path.write_text(md_text)
    (AUDIT_DIR / "intent-ledger-quality-latest.md").write_text(md_text)
    return json_path, md_path


def render_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Intent Ledger Quality Audit",
        "",
        f"- Created: `{payload['created_at']}`",
        f"- DB: `{payload['db']}`",
        f"- Integrity: `{payload['integrity']}`",
        f"- Status: `{payload['assessment']['status']}`",
        "",
        "## Issues",
        "",
    ]
    issues = payload["assessment"]["issues"]
    if issues:
        for issue in issues:
            lines.append(f"- {issue}")
    else:
        lines.append("- None.")
    lines.extend(["", "## Counts", ""])
    for name, count in payload["tables"].items():
        lines.append(f"- `{name}`: {count}")
    lines.extend(["", "## Coverage", ""])
    span = payload["session_file_span"]
    lines.append(f"- Session file span: `{span.get('first_ts')}` to `{span.get('last_ts')}`")
    lines.append(f"- Turn span: `{payload['turn_span'].get('first_ts')}` to `{payload['turn_span'].get('last_ts')}`")
    claude = payload["claude_media_agent_files"]
    lines.append(f"- Claude media-agent JSONLs on disk: `{claude['filesystem_count']}`")
    lines.append(f"- Indexed Claude media-agent JSONLs: `{claude['indexed_count']}`")
    lines.append(f"- Missing Claude media-agent JSONLs: `{claude['missing_count']}`")
    lines.extend(["", "## Quality", ""])
    for name, value in payload["quality"].items():
        lines.append(f"- `{name}`: {value}")
    lines.extend(["", "## Key Docs", ""])
    for row in payload["key_docs"]:
        lines.append(f"- `{row['path']}` fresh: `{row['fresh']}`")
    if claude["missing_sample"]:
        lines.extend(["", "## Missing Claude Sample", ""])
        for row in claude["missing_sample"]:
            lines.append(f"- `{row['mtime']}` `{row['bytes']}` `{row['path']}`")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    payload = audit(resolve_db(args.db))
    json_path, md_path = write_report(payload)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"wrote {json_path}")
        print(f"wrote {md_path}")
        print(f"status {payload['assessment']['status']}")


if __name__ == "__main__":
    main()
