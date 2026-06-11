#!/usr/bin/env python3
"""Append current git, docs, and Codex transcript evidence to the intent ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_DB = Path(".intent-ledger/evogent-intent-ledger.sqlite")
DEFAULT_DOCS = [
    "AGENTS.md",
    "docs/intent-ledger.md",
    ".agents/skills/evogent-intent-audit/SKILL.md",
    ".claude/commands/curate.md",
    "data/curation-prompt.md",
    "data/preference-insights.md",
    "data/config.md",
]

DEFAULT_CLAUDE_PROJECT_GLOBS = [
    "/root/.claude/projects/-root-media-agent*",
    # Evogent evidence also lives outside the repo-cwd project dir: early
    # the-algo-era sessions, sessions run from /root, and the OpenClaw
    # curator's own workspace sessions.
    "/root/.claude/projects/-root-the-algo*",
    "/root/.claude/projects/-root",
    "/root/.claude/projects/-root--openclaw-workspace*",
]

KEYWORDS = {
    "feed_ui": ["feed", "thread", "card", "ordering", "connector", "heading", "bridge", "subtitle", "reason"],
    "user_pain": ["broken", "fail", "stale", "shallow", "disappear", "frustrat", "drift", "wrong"],
    "contract": ["should", "must", "do not", "never", "always", "target", "invariant", "intent", "require"],
    "cache_source": ["cache", "source", "browse", "twitter", "substack", "youtube", "hacker", "x.com"],
    "openclaw": ["openclaw", "curator", "agent", "heartbeat", "codex", "claude"],
    "regression": ["regression", "broken", "drift", "missing", "disappear", "under-ship", "shortcut"],
    "chat_sessions": ["chat", "session", "message", "transcript", "conversation"],
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def repo_root() -> Path:
    out = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
    return Path(out)


def resolve_db(path: str | None) -> Path:
    value = path or os.environ.get("EVOGENT_INTENT_LEDGER_DB") or str(DEFAULT_DB)
    db = Path(value)
    if not db.is_absolute():
        db = repo_root() / db
    if not db.exists():
        raise SystemExit(f"intent ledger DB not found: {db}")
    return db


def run_git(args: list[str]) -> str:
    return subprocess.check_output(["git", *args], cwd=repo_root(), text=True, stderr=subprocess.DEVNULL)


def commit_rows(since: str | None = None) -> Iterable[dict[str, Any]]:
    fmt = "%H%x1f%h%x1f%ct%x1f%cI%x1f%aI%x1f%an%x1f%P%x1f%D%x1f%s%x1f%b%x1e"
    args = ["log", "--all", f"--pretty=format:{fmt}"]
    if since:
        args.append(f"--since={since}")
    raw = run_git(args)
    head_ancestors = set(run_git(["rev-list", "HEAD"]).splitlines())
    for rec in raw.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        parts = rec.split("\x1f")
        if len(parts) < 10:
            continue
        sha, abbrev, ts, commit_date, author_date, author, parents, refs, subject, body = parts[:10]
        try:
            diffstat = run_git(["show", "--stat", "--oneline", "--format=", sha]).strip()
        except Exception:
            diffstat = ""
        yield {
            "sha": sha,
            "abbrev": abbrev,
            "commit_ts": int(ts),
            "commit_date": commit_date,
            "author_date": author_date,
            "author_name": author,
            "parents": parents,
            "refs": refs,
            "subject": subject,
            "body": body,
            "is_head_ancestor": 1 if sha in head_ancestors else 0,
            "diffstat": diffstat,
        }


def upsert_commits(conn: sqlite3.Connection, since: str | None = None, rebuild_fts: bool = True) -> int:
    count = 0
    for row in commit_rows(since):
        conn.execute(
            """
            insert into commits(sha, abbrev, commit_ts, commit_date, author_date, author_name, parents, refs, subject, body, is_head_ancestor, diffstat)
            values(:sha, :abbrev, :commit_ts, :commit_date, :author_date, :author_name, :parents, :refs, :subject, :body, :is_head_ancestor, :diffstat)
            on conflict(sha) do update set
              abbrev=excluded.abbrev,
              commit_ts=excluded.commit_ts,
              commit_date=excluded.commit_date,
              author_date=excluded.author_date,
              author_name=excluded.author_name,
              parents=excluded.parents,
              refs=excluded.refs,
              subject=excluded.subject,
              body=excluded.body,
              is_head_ancestor=excluded.is_head_ancestor,
              diffstat=excluded.diffstat
            """,
            row,
        )
        replace_signals(conn, "commits", row["sha"], row["commit_date"], row["subject"], f"{row['subject']}\n{row['body']}\n{row['diffstat']}")
        count += 1
    if rebuild_fts:
        rebuild_commit_fts(conn)
    return count


def upsert_docs(conn: sqlite3.Connection, paths: list[str], rebuild_fts: bool = True) -> int:
    root = repo_root()
    count = 0
    for rel in paths:
        path = root / rel
        if not path.exists() or not path.is_file():
            continue
        content = path.read_text(errors="ignore")
        stat = path.stat()
        title = first_title(content) or rel
        row = {
            "path": str(path),
            "rel_path": rel,
            "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "bytes": stat.st_size,
            "kind": infer_kind(rel),
            "title": title,
            "content": content,
            "content_hash": hashlib.sha256(content.encode()).hexdigest(),
        }
        conn.execute(
            """
            insert into docs(path, rel_path, mtime, bytes, kind, title, content, content_hash)
            values(:path, :rel_path, :mtime, :bytes, :kind, :title, :content, :content_hash)
            on conflict(path) do update set
              rel_path=excluded.rel_path,
              mtime=excluded.mtime,
              bytes=excluded.bytes,
              kind=excluded.kind,
              title=excluded.title,
              content=excluded.content,
              content_hash=excluded.content_hash
            """,
            row,
        )
        replace_signals(conn, "docs", row["path"], row["mtime"], row["title"], row["content"])
        count += 1
    if rebuild_fts:
        rebuild_doc_fts(conn)
    return count


def first_title(content: str) -> str | None:
    for line in content.splitlines():
        if line.startswith("#"):
            return line.lstrip("#").strip()
    return None


def infer_kind(rel: str) -> str:
    if rel.startswith(".claude/"):
        return "claude"
    if rel.startswith(".agents/"):
        return "codex_skill"
    if rel.startswith("docs/"):
        return "docs"
    if rel.startswith("data/"):
        return "data"
    return "repo"


def parse_codex_jsonl(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    session_id = path.stem
    root_dir = None
    cwd = None
    branch = None
    title = None
    rows: list[dict[str, Any]] = []
    seen_content: set[str] = set()
    seen_goals: set[str] = set()
    first_ts = None
    last_ts = None
    counts = {"user": 0, "assistant": 0, "tool": 0}
    with path.open(errors="ignore") as f:
        for line_no, line in enumerate(f, 1):
            try:
                obj = json.loads(line)
            except Exception:
                continue
            ts = obj.get("timestamp")
            if ts:
                first_ts = first_ts or ts
                last_ts = ts
            payload = obj.get("payload") or {}
            if obj.get("type") == "session_meta":
                session_id = payload.get("id") or obj.get("id") or session_id
            if obj.get("type") == "turn_context":
                cwd = payload.get("cwd") or obj.get("cwd") or cwd
                root_dir = (payload.get("workspace_roots") or [None])[0] if isinstance(payload.get("workspace_roots"), list) else root_dir
            role = None
            content = None
            typ = obj.get("type")
            user_type = None
            entrypoint = "codex"
            tool_name = None
            uuid = None
            parent_uuid = None
            if typ == "event_msg" and payload.get("type") == "user_message":
                role = "user"
                content = payload.get("message")
            elif typ == "event_msg" and payload.get("type") == "agent_message":
                role = "assistant"
                content = payload.get("message")
            elif typ == "event_msg" and payload.get("type") == "thread_goal_updated":
                role = "user"
                goal = payload.get("goal") or {}
                content = goal.get("objective")
                goal_hash = hashlib.sha256(content_text(content).encode()).hexdigest() if content else ""
                if goal_hash in seen_goals:
                    continue
                seen_goals.add(goal_hash)
            if not content:
                continue
            content = content_text(content)
            if len(content) > 12000:
                content = content[:12000] + "\n[truncated by intent-ledger importer]"
            content_hash = hashlib.sha256(content.encode()).hexdigest()
            if content_hash in seen_content:
                continue
            seen_content.add(content_hash)
            if role == "user":
                counts["user"] += 1
                title = title or first_line(content)
            elif role == "assistant":
                counts["assistant"] += 1
            elif role == "tool":
                counts["tool"] += 1
            rows.append({
                "session_id": session_id,
                "path": str(path),
                "line_no": line_no,
                "type": typ,
                "role": role,
                "timestamp": ts,
                "user_type": user_type,
                "entrypoint": entrypoint,
                "cwd": cwd,
                "git_branch": branch,
                "uuid": uuid,
                "parent_uuid": parent_uuid,
                "tool_name": tool_name,
                "content": content,
                "content_hash": content_hash,
            })
    meta = {
        "file_id": hashlib.sha256(str(path).encode()).hexdigest()[:16],
        "session_id": session_id,
        "path": str(path),
        "root_dir": root_dir,
        "is_subagent": 0,
        "cwd": cwd,
        "git_branch": branch,
        "title": title or path.name,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "entry_count": len(rows),
        "user_count": counts["user"],
        "assistant_count": counts["assistant"],
        "tool_use_count": counts["tool"],
        "bytes": path.stat().st_size,
    }
    return meta, rows


def parse_claude_jsonl(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    session_id = path.stem
    root_dir = infer_claude_root_dir(path)
    cwd = None
    branch = None
    title = None
    first_ts = None
    last_ts = None
    is_subagent = 1 if "subagents" in path.parts else 0
    counts = {"user": 0, "assistant": 0, "tool": 0}
    rows: list[dict[str, Any]] = []
    with path.open(errors="ignore") as f:
        for line_no, line in enumerate(f, 1):
            try:
                obj = json.loads(line)
            except Exception:
                continue
            typ = obj.get("type")
            if typ not in {"user", "assistant", "summary"}:
                continue
            session_id = obj.get("sessionId") or session_id
            cwd = obj.get("cwd") or cwd
            branch = obj.get("gitBranch") or branch
            is_subagent = 1 if obj.get("isSidechain") or is_subagent else 0
            ts = obj.get("timestamp")
            if ts:
                first_ts = first_ts or ts
                last_ts = ts
            role = None
            tool_name = None
            content = ""
            if typ == "summary":
                role = "assistant"
                content = obj.get("summary") or obj.get("text") or ""
            else:
                message = obj.get("message") or {}
                role = message.get("role") or typ
                content, tool_name = claude_message_content(message.get("content"))
            if not content:
                continue
            if len(content) > 12000:
                content = content[:12000] + "\n[truncated by intent-ledger importer]"
            if role == "user":
                counts["user"] += 1
                title = title or first_line(content)
            elif role == "assistant":
                counts["assistant"] += 1
            if tool_name:
                counts["tool"] += 1
            rows.append({
                "session_id": session_id,
                "path": str(path),
                "line_no": line_no,
                "type": typ,
                "role": role,
                "timestamp": ts,
                "user_type": obj.get("userType"),
                "entrypoint": None,
                "cwd": cwd,
                "git_branch": branch,
                "uuid": obj.get("uuid"),
                "parent_uuid": obj.get("parentUuid"),
                "tool_name": tool_name,
                "content": content,
                "content_hash": hashlib.sha256(content.encode()).hexdigest(),
            })
    meta = {
        "file_id": hashlib.sha256(str(path).encode()).hexdigest()[:16],
        "session_id": session_id,
        "path": str(path),
        "root_dir": root_dir,
        "is_subagent": is_subagent,
        "cwd": cwd,
        "git_branch": branch,
        "title": title or path.name,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "entry_count": len(rows),
        "user_count": counts["user"],
        "assistant_count": counts["assistant"],
        "tool_use_count": counts["tool"],
        "bytes": path.stat().st_size,
    }
    return meta, rows


def infer_claude_root_dir(path: Path) -> str | None:
    parts = path.parts
    try:
        idx = parts.index("projects")
        return parts[idx + 1]
    except Exception:
        return None


def claude_message_content(value: Any) -> tuple[str, str | None]:
    if isinstance(value, str):
        return value, None
    if not isinstance(value, list):
        return content_text(value), None
    parts: list[str] = []
    first_tool: str | None = None
    for item in value:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type == "text":
            text = item.get("text")
            if text:
                parts.append(str(text))
        elif item_type == "tool_use":
            first_tool = first_tool or str(item.get("name") or "")
            payload = json.dumps(item.get("input") or {}, sort_keys=True)
            parts.append(f"[tool_use:{item.get('name')}] {payload}")
        elif item_type == "tool_result":
            content = item.get("content")
            text = content_text(content)
            if text:
                parts.append(f"[tool_result] {text}")
        else:
            text = content_text(item)
            if text:
                parts.append(text)
    return "\n".join(parts), first_tool


def content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("input_text") or item.get("output_text") or ""))
        return "\n".join(part for part in parts if part)
    return str(value or "")


def first_line(value: str) -> str:
    return next((line.strip() for line in value.splitlines() if line.strip()), "")[:160]


def upsert_codex_session(conn: sqlite3.Connection, path: Path, rebuild_fts: bool = True) -> tuple[str, int]:
    meta, rows = parse_codex_jsonl(path)
    conn.execute(
        """
        insert into session_files(file_id, path, root_dir, is_subagent, session_id, cwd, git_branch, title, first_ts, last_ts, entry_count, user_count, assistant_count, tool_use_count, bytes)
        values(:file_id, :path, :root_dir, :is_subagent, :session_id, :cwd, :git_branch, :title, :first_ts, :last_ts, :entry_count, :user_count, :assistant_count, :tool_use_count, :bytes)
        on conflict(file_id) do update set
          path=excluded.path,
          root_dir=excluded.root_dir,
          is_subagent=excluded.is_subagent,
          session_id=excluded.session_id,
          cwd=excluded.cwd,
          git_branch=excluded.git_branch,
          title=excluded.title,
          first_ts=excluded.first_ts,
          last_ts=excluded.last_ts,
          entry_count=excluded.entry_count,
          user_count=excluded.user_count,
          assistant_count=excluded.assistant_count,
          tool_use_count=excluded.tool_use_count,
          bytes=excluded.bytes
        """,
        meta,
    )
    conn.execute(
        """
        insert into sessions(session_id, path, root_dir, is_subagent, cwd, git_branch, title, first_ts, last_ts, entry_count, user_count, assistant_count, tool_use_count, bytes)
        values(:session_id, :path, :root_dir, :is_subagent, :cwd, :git_branch, :title, :first_ts, :last_ts, :entry_count, :user_count, :assistant_count, :tool_use_count, :bytes)
        on conflict(session_id) do update set
          path=excluded.path,
          root_dir=excluded.root_dir,
          is_subagent=excluded.is_subagent,
          cwd=excluded.cwd,
          git_branch=excluded.git_branch,
          title=excluded.title,
          first_ts=excluded.first_ts,
          last_ts=excluded.last_ts,
          entry_count=excluded.entry_count,
          user_count=excluded.user_count,
          assistant_count=excluded.assistant_count,
          tool_use_count=excluded.tool_use_count,
          bytes=excluded.bytes
        """,
        meta,
    )
    delete_turn_signals_for_path(conn, str(path))
    conn.execute("delete from turns where session_id = ? and path = ?", (meta["session_id"], str(path)))
    for row in rows:
        cur = conn.execute(
            """
            insert into turns(session_id, path, line_no, type, role, timestamp, user_type, entrypoint, cwd, git_branch, uuid, parent_uuid, tool_name, content, content_hash)
            values(:session_id, :path, :line_no, :type, :role, :timestamp, :user_type, :entrypoint, :cwd, :git_branch, :uuid, :parent_uuid, :tool_name, :content, :content_hash)
            """,
            row,
        )
        source_id = f"{meta['session_id']}:{cur.lastrowid}"
        replace_signals(conn, "turns", source_id, row["timestamp"], meta["title"], row["content"])
    if rebuild_fts:
        rebuild_turn_fts(conn)
    return meta["session_id"], len(rows)


def upsert_claude_session_file(conn: sqlite3.Connection, path: Path, rebuild_fts: bool = True) -> tuple[str, int]:
    meta, rows = parse_claude_jsonl(path)
    conn.execute(
        """
        insert into session_files(file_id, path, root_dir, is_subagent, session_id, cwd, git_branch, title, first_ts, last_ts, entry_count, user_count, assistant_count, tool_use_count, bytes)
        values(:file_id, :path, :root_dir, :is_subagent, :session_id, :cwd, :git_branch, :title, :first_ts, :last_ts, :entry_count, :user_count, :assistant_count, :tool_use_count, :bytes)
        on conflict(file_id) do update set
          path=excluded.path,
          root_dir=excluded.root_dir,
          is_subagent=excluded.is_subagent,
          session_id=excluded.session_id,
          cwd=excluded.cwd,
          git_branch=excluded.git_branch,
          title=excluded.title,
          first_ts=excluded.first_ts,
          last_ts=excluded.last_ts,
          entry_count=excluded.entry_count,
          user_count=excluded.user_count,
          assistant_count=excluded.assistant_count,
          tool_use_count=excluded.tool_use_count,
          bytes=excluded.bytes
        """,
        meta,
    )
    conn.execute(
        """
        insert into sessions(session_id, path, root_dir, is_subagent, cwd, git_branch, title, first_ts, last_ts, entry_count, user_count, assistant_count, tool_use_count, bytes)
        values(:session_id, :path, :root_dir, :is_subagent, :cwd, :git_branch, :title, :first_ts, :last_ts, :entry_count, :user_count, :assistant_count, :tool_use_count, :bytes)
        on conflict(session_id) do update set
          path=excluded.path,
          root_dir=coalesce(sessions.root_dir, excluded.root_dir),
          is_subagent=max(sessions.is_subagent, excluded.is_subagent),
          cwd=coalesce(sessions.cwd, excluded.cwd),
          git_branch=coalesce(sessions.git_branch, excluded.git_branch),
          title=coalesce(sessions.title, excluded.title),
          first_ts=case
            when sessions.first_ts is null or sessions.first_ts = '' then excluded.first_ts
            when excluded.first_ts is null or excluded.first_ts = '' then sessions.first_ts
            when excluded.first_ts < sessions.first_ts then excluded.first_ts
            else sessions.first_ts
          end,
          last_ts=case
            when sessions.last_ts is null or sessions.last_ts = '' then excluded.last_ts
            when excluded.last_ts is null or excluded.last_ts = '' then sessions.last_ts
            when excluded.last_ts > sessions.last_ts then excluded.last_ts
            else sessions.last_ts
          end,
          entry_count=max(sessions.entry_count, excluded.entry_count),
          user_count=max(sessions.user_count, excluded.user_count),
          assistant_count=max(sessions.assistant_count, excluded.assistant_count),
          tool_use_count=max(sessions.tool_use_count, excluded.tool_use_count),
          bytes=max(sessions.bytes, excluded.bytes)
        """,
        meta,
    )
    delete_turn_signals_for_path(conn, str(path))
    conn.execute("delete from turns where path = ?", (str(path),))
    for row in rows:
        cur = conn.execute(
            """
            insert into turns(session_id, path, line_no, type, role, timestamp, user_type, entrypoint, cwd, git_branch, uuid, parent_uuid, tool_name, content, content_hash)
            values(:session_id, :path, :line_no, :type, :role, :timestamp, :user_type, :entrypoint, :cwd, :git_branch, :uuid, :parent_uuid, :tool_name, :content, :content_hash)
            """,
            row,
        )
        source_id = f"{meta['session_id']}:{cur.lastrowid}"
        replace_signals(conn, "turns", source_id, row["timestamp"], meta["title"], row["content"])
    if rebuild_fts:
        rebuild_turn_fts(conn)
    return meta["session_id"], len(rows)


def delete_turn_signals_for_path(conn: sqlite3.Connection, path: str) -> None:
    source_ids = [
        f"{row[0]}:{row[1]}"
        for row in conn.execute("select session_id, id from turns where path = ?", (path,))
    ]
    if not source_ids:
        return
    conn.executemany(
        "delete from signals where source_table = 'turns' and source_id = ?",
        [(source_id,) for source_id in source_ids],
    )


def discover_missing_claude_jsonl(conn: sqlite3.Connection, limit: int | None = None, extra_globs: list[str] | None = None) -> list[Path]:
    known = {row[0] for row in conn.execute("select path from session_files")}
    candidates: list[Path] = []
    for pattern in [*DEFAULT_CLAUDE_PROJECT_GLOBS, *(extra_globs or [])]:
        for root in Path("/").glob(pattern.lstrip("/")):
            if not root.exists():
                continue
            for path in root.rglob("*.jsonl"):
                if str(path) not in known:
                    candidates.append(path)
    candidates.sort(key=lambda p: (p.stat().st_mtime, str(p)))
    if limit is not None:
        return candidates[:limit]
    return candidates


def replace_signals(conn: sqlite3.Connection, source_table: str, source_id: str, timestamp: str | None, title: str | None, content: str) -> None:
    conn.execute("delete from signals where source_table = ? and source_id = ?", (source_table, source_id))
    lower = content.lower()
    for category, words in KEYWORDS.items():
        for word in words:
            if word in lower:
                excerpt = excerpt_around(content, word)
                conn.execute(
                    "insert into signals(source_table, source_id, category, keyword, timestamp, title, excerpt) values(?,?,?,?,?,?,?)",
                    (source_table, source_id, category, word, timestamp, title, excerpt),
                )


def excerpt_around(content: str, word: str, radius: int = 260) -> str:
    lower = content.lower()
    idx = lower.find(word)
    if idx < 0:
        return content[: radius * 2]
    start = max(0, idx - radius)
    end = min(len(content), idx + len(word) + radius)
    return content[start:end]


def rebuild_commit_fts(conn: sqlite3.Connection) -> None:
    conn.execute("delete from commit_fts")
    conn.execute("insert into commit_fts(subject, body, sha, commit_date) select subject, body, sha, commit_date from commits")


def rebuild_doc_fts(conn: sqlite3.Connection) -> None:
    conn.execute("delete from doc_fts")
    conn.execute("insert into doc_fts(content, rel_path, kind) select content, rel_path, kind from docs")


def rebuild_turn_fts(conn: sqlite3.Connection) -> None:
    conn.execute("delete from turn_fts")
    conn.execute("insert into turn_fts(content, session_id, timestamp, path) select content, session_id, timestamp, path from turns")


def update_meta(conn: sqlite3.Connection, db: Path, extra: dict[str, Any]) -> None:
    counts = {name: conn.execute(f"select count(*) from {name}").fetchone()[0] for name in ["commits", "sessions", "turns", "docs", "signals"]}
    summary = {
        "built_at": utc_now(),
        "db": str(db),
        **counts,
        **extra,
    }
    conn.execute("insert or replace into meta(key, value) values('summary', ?)", (json.dumps(summary, sort_keys=True),))
    summary_path = db.parent / "ledger-summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db")
    parser.add_argument("--git", action="store_true", help="Upsert current git history")
    parser.add_argument("--since", help="Only inspect git commits since this date when --git is used")
    parser.add_argument("--docs", action="store_true", help="Upsert key project docs")
    parser.add_argument("--doc", action="append", default=[], help="Additional doc path relative to repo root")
    parser.add_argument("--codex-session-jsonl", action="append", default=[], help="Codex transcript JSONL to ingest")
    parser.add_argument("--claude-jsonl", action="append", default=[], help="Claude project JSONL to ingest")
    parser.add_argument("--import-missing-claude-media-agent", action="store_true", help="Import Claude JSONL files under /root/.claude/projects/-root-media-agent* that are not in session_files")
    parser.add_argument("--missing-claude-limit", type=int, help="Limit missing Claude JSONL imports")
    parser.add_argument("--skip-fts-rebuild", action="store_true", help="Skip expensive full FTS rebuilds after append/update")
    args = parser.parse_args()

    db = resolve_db(args.db)
    changed: dict[str, Any] = {"updated_at": utc_now()}
    with sqlite3.connect(db) as conn:
        if args.git:
            changed["git_commits_seen"] = upsert_commits(conn, args.since, rebuild_fts=not args.skip_fts_rebuild)
        if args.docs:
            changed["docs_seen"] = upsert_docs(conn, list(dict.fromkeys([*DEFAULT_DOCS, *args.doc])), rebuild_fts=not args.skip_fts_rebuild)
        sessions = []
        for value in args.codex_session_jsonl:
            sid, turns = upsert_codex_session(conn, Path(value), rebuild_fts=not args.skip_fts_rebuild)
            sessions.append({"session_id": sid, "turns": turns, "path": value})
        if sessions:
            changed["codex_sessions"] = sessions
        claude_sessions = []
        claude_paths = [Path(value) for value in args.claude_jsonl]
        if args.import_missing_claude_media_agent:
            claude_paths.extend(discover_missing_claude_jsonl(conn, args.missing_claude_limit))
        for path in list(dict.fromkeys(claude_paths)):
            sid, turns = upsert_claude_session_file(conn, path, rebuild_fts=False)
            claude_sessions.append({"session_id": sid, "turns": turns, "path": str(path)})
        if claude_sessions:
            changed["claude_sessions"] = claude_sessions
            if not args.skip_fts_rebuild:
                rebuild_turn_fts(conn)
        update_meta(conn, db, changed)
        conn.commit()
    print(json.dumps(changed, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
