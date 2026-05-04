# Evogent — Agent Instructions

Evogent is a personal AI-curated feed that learns what you are trying to understand, not just what you clicked on once.

If pointed at this repo and asked to install Evogent for the user, follow `docs/setup-for-coding-agents.md` end-to-end.

## Explain Simply

Try to explain things simply. If you cannot explain something simply, you do not understand it yet, so try harder and seek clarification; if you still can't, say so plainly.

## Tech Stack

- Next.js 16 (App Router), TypeScript, Tailwind CSS
- SQLite (`better-sqlite3`) + `sqlite-vec` for vector search
- Custom `server.js` (orchestrator + WebSocket + internal endpoints)
- `ws` library for WebSocket

## Key Paths

| Path | Purpose |
|------|---------|
| `server.js` | Orchestrator runtime + WebSockets |
| `src/` | Next.js app (App Router) |
| `src/lib/db/schema.ts` | Database schema (5 tables) |
| `data/media-agent.db` | SQLite database (source of truth) |
| `data/config.md` | User preferences |
| `.claude/skills/` | Runtime skill plugins |
| `docs/reference/` | API refs, output contracts, recipes |

## Development

```bash
npm run build          # Build
npm run test           # Unit tests
npm run lint           # Lint
```

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
- Prefer this pattern for all Codex/agent VM commands in future sessions.
