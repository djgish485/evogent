# Plan: Separate Agent Worker from Web Server

## Context

The evogent web server (server.js) currently does everything: serves the UI, runs WebSocket connections, AND spawns/manages all AI agents (chat, curation, enrichment, code-fix, reflection). When agents merge code and the post-merge hook restarts the server, it causes restart storms, port conflicts, killed agents mid-run, and CSS staleness. Multiple concurrent agents finishing simultaneously can crash-loop the app.

**Goal:** Split into two services — a web server that serves the UI, and a worker that runs agents. The web server can restart freely without affecting running agents.

## Architecture

```
┌─────────────────────┐     Redis pub/sub     ┌──────────────────────┐
│   Web Server        │◄────────────────────►│   Worker Service      │
│   (evogent)     │                       │   (evogent-worker)│
│                     │     Redis queue        │                      │
│ - Next.js app       │────────────────────►│ - BrainOrchestrator   │
│ - WebSocket servers │                       │ - Agent spawning      │
│ - API routes        │                       │ - Curation lifecycle  │
│ - Auth              │                       │ - Heartbeat/reflection│
│ - Static files      │                       │ - Code-fix orchestr.  │
│                     │                       │ - Enrichment agents   │
│ Port 3001           │                       │ No port (queue-based) │
└─────────────────────┘                       └──────────────────────┘
```

## What Moves to Worker

| Component | Currently | Moves to Worker |
|-----------|----------|-----------------|
| BrainOrchestrator queue + processLoop | In-memory in server.js | BullMQ queue in Redis |
| `_runClaudeTask()` (chat, curation, etc.) | Child process from server.js | Child process from worker |
| Heartbeat timer (5min) | `setInterval` in server.js | `setInterval` in worker |
| Reflection timer | `setInterval` in server.js | `setInterval` in worker |
| Code-fix sync timer (30s) | `setInterval` in server.js | `setInterval` in worker |
| `queueForOrchestrator()` | Module in server.js memory | Worker reads from Redis queue |
| `launchOrchestrator()` (tmux sessions) | Called from server.js | Called from worker |
| `agentManager` (enrichment agents) | In Next.js process | In worker |

## What Stays in Web Server

| Component | Why |
|-----------|-----|
| WebSocket servers (4) | Clients connect here |
| Broadcast functions | Push to WS clients |
| Next.js request handler | UI rendering |
| Auth middleware | Session cookies |
| `/api/internal/feed-notify` | Worker POSTs here to push to WS |
| `/api/internal/chat-notify` | Worker POSTs here to push to WS |
| `/api/internal/agent-progress` | Worker POSTs here to push to WS |
| All Next.js API routes | Serve client requests |

## Communication: Web Server ↔ Worker

### Web → Worker (task submission)
The web server enqueues tasks to Redis (BullMQ):
- `POST /api/chat` → enqueue `{priority: 'user_chat', message: '...'}` to Redis
- `POST /api/orchestrator/enqueue` → enqueue to Redis
- `POST /api/internal/code-fix-orchestrator/enqueue` → enqueue to Redis
- Heartbeat/reflection triggers → enqueue to Redis (from worker's own timers)

### Worker → Web (status updates)
The worker POSTs to the web server's internal endpoints:
- Chat streaming/progress → `POST http://127.0.0.1:3001/api/internal/chat-notify` (per-line, throttled)
- Orchestrator status → `POST http://127.0.0.1:3001/api/internal/orchestrator-status` (new endpoint)
- Agent progress → `POST http://127.0.0.1:3001/api/internal/agent-progress` (already exists)
- Feed updates → `POST http://127.0.0.1:3001/api/internal/feed-notify` (already exists)

**Why HTTP POST instead of Redis pub/sub:** Simpler. The web server already has these internal endpoints. No new pub/sub infrastructure needed. HTTP POST to localhost is <1ms. For chat streaming (high frequency), the worker can batch lines and POST every 100ms.

### Shared State
- **SQLite DB:** Both processes read/write. WAL mode handles concurrent access fine.
- **Disk files:** `curation-status.json`, `reflection-status.json`, `orchestrator-chat-session.json` — worker writes, web reads for status APIs. File-based, no coordination needed.
- **`/root/.clawdbot/active-tasks.json`:** Worker writes, web reads for code-fix status.

## Implementation Steps

### Step 1: Set up BullMQ queue
- Install `bullmq` package (Redis already installed on VM)
- Create `lib/queue.ts` with queue connection and job types
- Define job types: `user_chat`, `code_fix_spawn`, `user_ping`, `post_enrichment`, `heartbeat`, `reflection`

### Step 2: Create worker entry point
- New file: `worker.js` (standalone Node.js process)
- Move `BrainOrchestrator` class from server.js to `lib/brain-orchestrator.js` (extract, don't rewrite)
- Worker initializes BullMQ worker, processes jobs by calling `orchestrator.processTask()`
- Worker starts heartbeat/reflection/code-fix-sync timers

### Step 3: Modify server.js to enqueue instead of process
- Remove `BrainOrchestrator` instantiation from server.js
- `POST /api/orchestrator/enqueue` → add job to BullMQ queue instead of `orchestrator.enqueue()`
- `POST /api/chat` route → enqueue to BullMQ instead of `enqueueOrchestratorMessage()`
- Remove all `setInterval` timers from server.js
- Keep all WebSocket servers and broadcast functions
- Keep all `/api/internal/*-notify` endpoints (worker will POST to them)

### Step 4: Wire worker → web status updates
- In worker's `_runClaudeTask()`, replace direct `broadcastChatStreaming()` calls with HTTP POST to `http://127.0.0.1:3001/api/internal/chat-notify`
- Add new endpoint `POST /api/internal/orchestrator-status` in server.js that receives status and broadcasts to WS clients
- Worker calls this endpoint on every status change (enqueue, start, complete, fail)

### Step 5: Create systemd service for worker
```ini
# /etc/systemd/system/evogent-worker.service
[Unit]
Description=Evogent Worker
After=network.target redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/evogent
Environment=NODE_ENV=production
ExecStart=/usr/bin/node worker.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Step 6: Update post-merge hook
```bash
# Only restart the web server, never the worker
npm run build
systemctl restart evogent.service
# Worker keeps running — agents are unaffected
```

### Step 7: Move code-fix orchestration
- `queueForOrchestrator()` in `orchestrator-session.js` → worker enqueues to BullMQ
- `launchOrchestrator()` stays in worker (spawns tmux sessions)
- Web server endpoint for accepting suggestions → enqueues to Redis

### Step 8: Move enrichment agents
- `agentManager.spawnAgent()` currently runs in Next.js process
- Move to worker — when `/api/feed/[id]/enrich` is called, it enqueues an enrichment job
- Worker picks it up and spawns the Claude sub-agent

## Post-Merge Hook After This Change

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npm install --prefer-offline
npm run build
systemctl restart evogent.service
# Worker is NOT restarted — agents keep running
# Web server restarts in ~2 seconds, serves new code
```

## What This Fixes

1. **Restart storms:** Only web server restarts. Worker never restarts during deploys. No more 3 agents all calling `systemctl restart` and fighting over port 3001.
2. **EADDRINUSE:** Only one process owns port 3001. Worker has no port.
3. **Killed curation mid-run:** Curation runs in worker, which doesn't restart.
4. **CSS staleness:** Web server restart is atomic — stop old, start new. No overlap.
5. **Concurrent agent safety:** Agents don't affect web server at all.

## What This Doesn't Fix

- Bad code merged by agents still breaks the web app
- The need for a build step before restart (inherent to Next.js)

## Verification

1. Start both services
2. Send a chat message → web enqueues to Redis → worker processes → POSTs streaming back to web → WS pushes to browser
3. Accept a code-fix suggestion → web enqueues → worker spawns orchestrator → agent works → merges → post-merge restarts web server ONLY → app comes back in 2 seconds → worker is still running, other agents unaffected
4. Trigger curation → worker runs curation agent → restart web server mid-curation → curation continues uninterrupted → results appear when complete
5. Run 3 concurrent code-fix agents → all merge simultaneously → 3 post-merge hooks fire → web server restarts 3 times in succession → each restart is clean (port freed by fuser) → app stabilizes in seconds → zero effect on running agents

## Files to Create/Modify

| File | Action |
|------|--------|
| `worker.js` | **Create** — worker entry point |
| `lib/queue.ts` | **Create** — BullMQ queue setup |
| `lib/brain-orchestrator.js` | **Extract** from server.js (rename, don't rewrite) |
| `server.js` | **Remove** orchestrator, timers; **add** Redis enqueue |
| `scripts/evogent-worker.service` | **Create** — systemd service template |
| `.claude/hooks/post-merge.sh` | **Modify** — only restart web server |
| `src/app/api/chat/route.ts` | **Modify** — enqueue to Redis instead of HTTP POST to self |
| `src/app/api/internal/orchestrator-status/route.ts` | **Create** — receive status from worker |
| `lib/orchestrator-session.js` | **Modify** — enqueue to Redis instead of in-memory |
| `package.json` | **Add** bullmq dependency |

## Estimated Effort

This is a 2-3 session project. The biggest piece is extracting `BrainOrchestrator` from server.js (it's ~1500 lines tightly coupled to the WebSocket broadcasts) and rewiring the chat streaming path.

The safest approach: do it in 3 phases, each independently deployable:
1. Phase 1: Extract BrainOrchestrator to its own module (no behavioral change)
2. Phase 2: Add BullMQ queue, create worker, move background tasks (curation/reflection/heartbeat)
3. Phase 3: Move foreground tasks (chat, enrichment) to worker, add streaming relay
