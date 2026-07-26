# Evogent — Dev Notes

## Read First

- Read `CLAUDE.md` first. It is the single source of truth for runtime instructions, design philosophy, feed content model, and boundary review.
- For phone work, read `docs/phone-production.md` and
  `phone-paradigm/device/DEV-LOOP.md`. Android is the canonical production
  environment; VM notes are legacy/demo guidance.

## Tech Stack

- Next.js 16 (App Router)
- SQLite (`better-sqlite3`) + `sqlite-vec`
- Tailwind CSS
- TypeScript
- `ws` library for WebSocket
- Custom `server.js` (orchestrator + WebSocket + internal endpoints)

## Key Paths

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | Runtime instructions and shared policy source of truth |
| `.claude/CLAUDE.md` | This file — dev-only project notes |
| `.claude/commands/` | Slash-command instruction files |
| `.claude/skills/` | Runtime-installed skill plugins |
| `skills-library/` | Skill catalog committed to the repo |
| `.claude/hooks/post-merge.sh` | Post-merge dependency install + pending-restart flag |
| `server.js` | Orchestrator runtime + WebSockets |
| `src/` | Next.js app |
| `src/lib/db/schema.ts` | Database schema |
| `data/config.md` | User preferences |
| `data/preferences-context.md` | Learned user preferences |
| `data/media-agent.db` | SQLite database |
| `docs/reference/` | Runtime contracts, API references, and recipes |
| `docs/phone-production.md` | Canonical phone architecture, privacy, release, and verification contract |
| `phone-paradigm/device/DEV-LOOP.md` | Host-to-phone development workflow |
| `scripts/agents/` | Repo-local agent orchestration scripts and logs |
| `.env.local` | Environment variables (not in git) |

## Development

```bash
# Build and run
npm run build
npm start

# Test and lint
npm run lint
npm run test
```

## Dev Notes

- Use `MEDIA_AGENT_INTERNAL_BASE_URL` when calling the running app from tooling or validation flows; do not hardcode port `3001`.
- SQLite is the source of truth. JSONL files are audit-only and never replayed.
- In the `phone` profile, bind loopback, disable Redis/background workers, and
  signal the sole Termux scheduler instead of dispatching direct curation.
- The Android shell owns launcher and input mechanics, not editorial judgment or
  scheduling.
- On-phone runtime agents own curation and source diagnosis. Host development
  agents own source changes and the host-review development queue.
- The per-file and `.next` deploy scripts are transitional. Follow the complete
  release contract in `docs/phone-production.md` and verify on display 0.
- Keep device serials, SSH values, account identifiers, private `data/`, and raw
  device evidence outside the checkout.
