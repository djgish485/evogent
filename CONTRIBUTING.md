# Contributing to Evogent

Evogent keeps the *why* behind every behavior as data in the repo — the Intent Ledger:

- `.intent/backlog.jsonl` — append-only log of every intention behind the product, with
  dates, verbatim quotes, and lifecycle statuses. Open entries are the project backlog.
- `.intent/contracts.jsonl` — the rules currently in force. `law` entries apply to every
  change: generalize to any user, prefer agent instructions over deterministic code, verify
  by running the real thing, keep the repo self-contained, explain simply.

For any PR (human or agent-authored):

1. Before designing, search both files for the territory you're touching.
2. Ship the intent WITH the change: append a backlog entry for the intention behind your PR
   (your PR description is fine as the quote) and update statuses of entries you implement,
   fix, or supersede — in the same PR as the code.
3. Run `git config core.hooksPath .githooks` once after cloning; a warn-only pre-commit
   reminder will nudge you when a behavior change ships without an intent change.

Agent runtimes pick this up automatically: Codex via AGENTS.md, Claude Code via CLAUDE.md.
The SQLite search index is optional; rebuild with `python3 scripts/intent/sync_intent_index.py`.
