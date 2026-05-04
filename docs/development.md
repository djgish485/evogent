# Development

Evogent is a Next.js app with a custom Node runtime. The orchestrator runs queued tasks as ephemeral Claude Code or Codex CLI sessions, and those tasks submit feed and chat output through internal APIs backed by SQLite.

## Commands

```bash
npm run build
npm run test
npm run lint
npx tsx scripts/seed-test-data.ts
```

For local development:

```bash
npm run build && npm start
node worker.js
```

The worker needs Redis for background jobs.

## Runtime Shape

```text
Orchestrator queue
  \- spawn Claude Code or Codex CLI task (ephemeral)
         \- POSTs feed/chat output to internal APIs
                              v
                       SQLite -> WebSocket
                              v
                    Next.js app (port 3001)
```

## Key Runtime Files

- `data/feed-output.jsonl` is the curated feed item and background analysis fallback output.
- `data/chat-output.jsonl` is an audit log for chat replies already persisted through `/api/internal/chat/submit`.
- `data/preference-insights.md` stores synthesized preference patterns maintained by reflection.
- `data/tracked-events.json` stores current event tracking lifecycle data.

See [architecture-v2.md](architecture-v2.md) for the full system design.
