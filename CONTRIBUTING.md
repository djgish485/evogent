# Contributing to Evogent

Evogent keeps the *why* behind every behavior as data in the repo — the Intent Ledger:

- `.intent/backlog.jsonl` — append-oriented log of product-wide decisions, with
  privacy-safe provenance and lifecycle statuses. Keep it deliberately small:
  every row needs `privacy_scope: "product-wide"` and must stand on its own
  without direct user evidence.
- `.intent/contracts.jsonl` — the rules currently in force. `law` entries apply to every
  change: generalize to any user, prefer agent instructions over deterministic code, verify
  by running the real thing, keep the repo self-contained, explain simply.

Android is the canonical production environment. Read
`docs/phone-production.md` before changing runtime ownership, scheduling,
networking, releases, or privacy boundaries.

Committed intent is product-wide and privacy-safe. Personal taste, accounts,
device values, private evidence, and populated `data/` instances stay outside
git. Preserve useful provenance with generic descriptions and placeholders rather
than committing identifying values.

Contract `evidence` cites public docs, tests, or mechanisms. It never embeds a
dated conversation, direct quote, private runtime observation, or account
example. `.intent/audit-log.jsonl` is only a boundary stub; detailed audit
records stay in ignored private data.

For any PR (human or agent-authored):

1. Before designing, search both files for the territory you're touching.
2. Ship the intent WITH the change: append a backlog entry for the intention behind your PR
   (your PR description is fine as the quote) and update statuses of entries you implement,
   fix, or supersede — in the same PR as the code.
3. Run `git config core.hooksPath .githooks` once after cloning; a warn-only pre-commit
   reminder will nudge you when a behavior change ships without an intent change.
4. Run `npm run privacy:check` before publishing. It scans tracked and unignored
   candidate files without echoing matched values. A private deployment can add
   exact local values with
   `node scripts/check-public-privacy.mjs --private-markers-file /private/path/markers.txt`;
   keep that marker file outside the checkout with mode `0600`.

Agent runtimes pick this up automatically: Codex via AGENTS.md, Claude Code via CLAUDE.md.
The SQLite search index is optional; rebuild with `python3 scripts/intent/sync_intent_index.py`.
