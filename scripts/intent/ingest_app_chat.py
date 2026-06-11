#!/usr/bin/env python3
"""Ingest the Evogent in-app chat history (chat_messages) into the intent ledger.

These are the user's direct conversations with the app's agents — first-class
intent evidence that the ledger previously missed (it only indexed Claude/Codex
project JSONLs). One ledger session per chat session, source path
app-chat://<session_id>; idempotent (replaces rows for each session on re-run).

Usage: python3 scripts/intent/ingest_app_chat.py [--app-db PATH] [--db PATH]
"""
import argparse
import sqlite3

APP_DB = "/root/media-agent/data/media-agent.db"
LEDGER_DB = "/root/media-agent/.intent-ledger/evogent-intent-ledger.sqlite"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-db", default=APP_DB)
    parser.add_argument("--db", default=LEDGER_DB)
    args = parser.parse_args()

    app = sqlite3.connect(f"file:{args.app_db}?mode=ro", uri=True)
    ledger = sqlite3.connect(args.db)

    sessions = app.execute(
        """
        SELECT m.session_id,
               coalesce(s.title, ''),
               min(m.created_at), max(m.created_at), count(*),
               sum(m.role = 'user'), sum(m.role != 'user')
        FROM chat_messages m
        LEFT JOIN chat_sessions s ON s.id = m.session_id
        GROUP BY m.session_id
        """
    ).fetchall()

    ingested_sessions = ingested_turns = 0
    for sid, title, first_ts, last_ts, count, user_n, agent_n in sessions:
        path = f"app-chat://{sid}"
        ledger.execute("DELETE FROM turns WHERE path = ?", (path,))
        ledger.execute("DELETE FROM sessions WHERE path = ?", (path,))
        ledger.execute(
            "DELETE FROM turn_fts WHERE path = ?",
            (path,),
        )
        ledger.execute(
            """
            INSERT OR REPLACE INTO sessions
              (session_id, path, root_dir, is_subagent, cwd, git_branch, title,
               first_ts, last_ts, entry_count, user_count, assistant_count, tool_use_count, bytes)
            VALUES (?, ?, 'app-chat', 0, '/root/media-agent', NULL, ?, ?, ?, ?, ?, ?, 0, 0)
            """,
            (f"app-chat:{sid}", path, title or f"In-app chat {sid}", first_ts, last_ts, count, user_n, agent_n),
        )
        ingested_sessions += 1

        rows = app.execute(
            "SELECT rowid, role, created_at, substr(coalesce(text,''),1,8000) FROM chat_messages WHERE session_id = ? ORDER BY rowid",
            (sid,),
        ).fetchall()
        for rowid, role, created_at, text in rows:
            if not (text or "").strip():
                continue
            normalized_role = "user" if role == "user" else "assistant"
            ledger.execute(
                """
                INSERT INTO turns (session_id, path, line_no, type, role, timestamp, user_type,
                                   entrypoint, cwd, git_branch, uuid, parent_uuid, tool_name, content, content_hash)
                VALUES (?, ?, ?, 'app-chat', ?, ?, ?, 'app-chat', '/root/media-agent', NULL, ?, NULL, NULL, ?, NULL)
                """,
                (
                    f"app-chat:{sid}", path, rowid, normalized_role, created_at,
                    "human" if normalized_role == "user" else "agent",
                    f"app-chat-{sid}-{rowid}", text,
                ),
            )
            ledger.execute(
                "INSERT INTO turn_fts (content, session_id, timestamp, path) VALUES (?, ?, ?, ?)",
                (text, f"app-chat:{sid}", created_at, path),
            )
            ingested_turns += 1

    ledger.commit()
    total = ledger.execute("SELECT count(*) FROM turns WHERE type = 'app-chat'").fetchone()[0]
    print(f"app-chat ingest: {ingested_sessions} sessions, {ingested_turns} turns inserted (total app-chat turns: {total})")


if __name__ == "__main__":
    main()
