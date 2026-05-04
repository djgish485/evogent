# Evogent — Dev Notes

## Read First

- Read `CLAUDE.md` first. It is the single source of truth for runtime instructions, design philosophy, feed content model, and boundary review.
- Read `docs/architecture-v2.md` before making feature, bug-fix, or architectural changes.
- Reference `docs/test-report-v2.md` for test coverage and verification notes.

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
| `docs/architecture-v2.md` | Master v2 architecture blueprint |
| `docs/reference/` | Runtime contracts, API references, and recipes |
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

## VM SSH Notes

When connecting to your dev VM through the Cloudflare tunnel, a successful SSH auth can still appear to "hang" at `Entering interactive session.` if the remote shell startup files block. Do not assume the tunnel is down until you have tried a no-profile shell.

Use this pattern for remote commands:

```bash
ssh -o 'ProxyCommand=cloudflared access ssh --hostname <your-ssh-host>' \
  -o ConnectTimeout=15 \
  root@<your-ssh-host> \
  "bash --norc --noprofile -c 'cd /root/evogent && <command>'"
```

Notes:
- `bash --norc --noprofile` skips the VM's `.bashrc` and `.profile`, which may hang after auth.
- A plain SSH session can succeed at auth and still stall during shell startup.
- Prefer this pattern for Codex/agent VM commands.
