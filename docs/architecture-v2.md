# Evogent v2 Architecture

## Overview

Evogent v2 is an orchestrated system of ephemeral `claude -p` tasks. The orchestrator queues all work, runs one task at a time by priority, and each task persists feed items and chat replies through the app's internal APIs backed by SQLite, then exits. Chat JSONL is audit output written after persistence, not an input channel.

There is no persistent tmux brain session.

## 1. Orchestrator Queue (Core Concurrency)

All inputs pass through a single queue in `server.js` so tasks do not collide.

```text
All inputs -> Orchestrator Queue -> Spawn ephemeral claude -p task -> SQLite-backed internal API -> audit output -> exit
```

**Lives in:** `server.js` (runtime), `src/lib/orchestrator.ts` (API wrapper)

**Responsibilities:**
- Receives work from adaptive heartbeat, chat, ping, enrichment, config changes, reflection timer
- Priority ordering: **user chat > user ping > post enrichment > heartbeat > reflection**
- Spawns exactly one task at a time
- Tracks queue state/history and task transcript tail
- Exposes status for UI and APIs

**Task session behavior:**
- Chat tasks: `--session-id` on first message, then `--resume <id>` for continuity
- Non-chat tasks: `--no-session-persistence`

**API endpoints:**
- `POST /api/orchestrator/enqueue` — internal queue entrypoint
- `GET /api/orchestrator/status` — queue depth, current task, task history

## 2. Ephemeral Task Architecture

Heavy work is done directly in task invocations. No nested task spawning is required for `/curate` or `/reflect`.

### Curation

Heartbeat or `/curate` task runs a full cycle inline:
- Reads `data/config.md` (app settings), `data/curation-prompt.md` (curation personality), `data/preferences-context.md`, installed skills
- Sources Twitter + web content
- Runs the shared audit core inline for current-cycle source health, freshness/coverage, feed quality, and incident routing
- Submits feed items through `POST /api/internal/curate/submit`, which writes to SQLite and appends the audit log
- Exits

### Post Enrichment

Enrichment task researches one selected post, appends thread/reply/analysis children, then exits.

Behavior details:
- Enrichment explicitly targets the main tweet URL, not quoted tweet URLs
- Reply filtering skips replies addressed to the quoted tweet author

### Reflection

Reflection task reviews recent feedback/chat/config history, appends `type: "suggestion"` items when justified, then exits.

It also maintains longer-lived preference and tracking state:
- Writes synthesized long-term preference patterns directly to `data/preference-insights.md`
- Reads `data/tracked-events.json` for event lifecycle management
- Can propose tracked event status changes such as `active` -> `monitoring` -> `retired`
- Runs the same shared audit core used by curation, but applies it across multiple cycles for durable recommendations and incident synthesis

### Why this model

- No always-on CLI session to manage
- Better isolation (fresh process per task)
- Clearer observability in queue history and agent-progress logs

## 3. Inline Chat with Continuity (`--resume`)

Chat is still conversational even though tasks are ephemeral.

### Flow

1. User sends message in UI -> `POST /api/chat`
2. Orchestrator enqueues `user_chat` task
3. Runtime invokes `claude -p` with `--resume <chatSessionId>` (or `--session-id` for first turn)
4. Task submits one reply to `POST /api/internal/chat/submit`
5. The submit endpoint validates, persists, appends `data/chat-output.jsonl` as audit output, marks the user message delivered, and broadcasts via `/ws/chat`

`data/chat-output.jsonl` is audit output only. It is not watched or imported as a chat delivery fallback.

Research-style chat requests follow the same entrypoint, but chat can detect that the user wants a deeper report and enqueue a `user_ping` task to the orchestrator. The background task performs the research, submits a `type: "analysis"` item through `POST /api/internal/curate/submit`, and chat immediately replies with confirmation instead of blocking on the long-running work.

### Chat response shape

```json
{
  "type": "chat",
  "id": "chat-20260301-001",
  "inReplyTo": "user-msg-id",
  "text": "Here's what I found...",
  "timestamp": "2026-03-01T12:00:00Z"
}
```

### Chat UI

- Slide-over panel on desktop, bottom sheet on mobile
- Live status indicators from orchestrator state
- Optional agent-activity transcript view
- Persisted history in SQLite/JSONL pipeline
- Text selection in posts can open an Ask Agent tooltip to start chat from the selected content

### Suggestion Apply System

Approved product/source/docs changes route through the existing `code_fix` orchestration pipeline. Explicit, concrete, safe edits to gitignored user-owned runtime config, such as changing `data/config.md` `## Agent Name`, may be applied directly by chat tasks; broader behavior changes and tracked files remain `code_fix` suggestions.

## 4. Adaptive Heartbeat

Adaptive heartbeat replaces static cron cadence with usage-aware checks.

### Inputs

- App activity (`POST /api/activity`)
- Pull-to-refresh
- User ping patterns
- Time since last curation
- Historical usage signals in SQLite

### Logic

- Predicts likely usage windows and curates ahead of demand
- Triggers immediate cycle for stale feed + explicit refresh behavior
- Enforces interval bounds (minimum and maximum windows)
- Routes every trigger through orchestrator queue

### Runtime implementation

- Timer in `server.js` runs every 5 minutes
- Internal check endpoint: `/api/internal/heartbeat/check`
- Backup cron in setup: every 15 minutes to same endpoint
- Completion callback: `/api/internal/heartbeat/complete`

## 5. Post Detail & Enrichment

When a user opens a post, app shows current DB state immediately and enrichment fills in additional context.

### Enrichment outputs

1. Thread reconstruction (parents/continuations)
2. Curated replies
3. Related reporting/context
4. Agent analysis child post

### Schema

```sql
ALTER TABLE feed ADD COLUMN parent_id TEXT REFERENCES feed(id);
ALTER TABLE feed ADD COLUMN relationship TEXT;
-- relationship: parent, child, reply, analysis, related, thread
```

### APIs

- `GET /api/feed/[id]`
- `GET /api/feed/[id]/children`
- `POST /api/feed/[id]/enrich`

## 6. Skills / Plugin System

Skills use file-based `SKILL.md` instructions.

### Directory model

```text
skills-library/
  account-mirror/
    SKILL.md
    scripts/sync.sh
  archive-import/
    SKILL.md
  current-event-tracker/
    SKILL.md
  full-text/
    SKILL.md
  tweet-cache/
    SKILL.md

.claude/skills/
  setup-wizard/
    SKILL.md
  <installed-skill>/
    SKILL.md
    scripts/*
```

### Principles

- Installed = active
- Catalog (`skills-library/`) is versioned but inactive until installed
- Runtime state lives in `.claude/skills/`
- Optional `scripts/` copied during install

### Activation behavior

- Runtime scans `.claude/skills/*/SKILL.md` each cycle
- Skills with `metadata.evogent.heartbeat-task: true` run during curation cycles
- The `/setup-wizard` chat command handles first-run onboarding
- `tweet-cache` is the browser-backed X/Twitter source skill and relies on the shared Chrome browse profile when browser mode is used
- `current-event-tracker` is a user-invocable skill for structured event tracking
- It manages `data/tracked-events.json` with lifecycle statuses: `active`, `monitoring`, `retired`
- It can adjust curation volume caps based on the number of tracked events
- `pipeline-audit` is manual/user-invocable only and enters the same shared audit core that already runs during curation and reflection

## 7. User Preferences & Learning

Signals:
- Thumbs up/down votes (+ optional reason)
- Twitter archive imports (likes/tweets/interests/blocks/mutes)

Data flow:

```text
User action -> preferences table -> vector store (sqlite-vec) -> data/preferences-context.md
          -> consumed by curation/reflection tasks
```

Core files:
- `src/lib/db/preferences.ts`
- `src/lib/vectors/embeddings.ts`
- `src/lib/vectors/store.ts`
- `src/lib/preferences-context.ts`
- `src/lib/import-archive.ts`

## 8. Mobile UX

### Pull-to-refresh
- Triggers orchestrated refresh task
- Uses same queue path as other triggers

### Chat access
- Always-visible chat entry in header
- Reflects runtime status
- Supports unread indicator

### Responsive behavior
- Feed and detail pages optimized for touch widths
- Chat panel adapts to desktop/mobile patterns

---

## Development Workstreams

| # | Task | Status | Description |
|---|------|--------|-------------|
| 1 | Orchestrator Queue | Done | Priority queue, ephemeral task spawning, status/history tracking |
| 2 | Inline Chat UI | Done | Chat panel, submit API delivery, chat WS channel, resume continuity |
| 3 | Task Progress Streaming | Done | Agent logs/progress events for long-running work |
| 4 | Adaptive Heartbeat | Done | Activity tracking, smart timer, internal heartbeat endpoints |
| 5 | Post Detail + Enrichment | Done | Detail page, relationship schema, enrichment task path |
| 6 | Skills System | Done | Library model, setup-wizard bootstrap, install API |
| 7 | Mobile UX | Done | Pull-to-refresh, responsive layout, chat panel behavior |
| 8 | User Preferences | Done | Votes, vectors, preferences-context, archive import |

---

## Agent Development Pipeline

Dev agents work in isolated git worktrees via `/develop`.

```text
/develop <task> -> isolated worktree -> agent work -> .agent-done
                                                  -> merge pipeline -> post-merge hook
```

Post-merge hook (`.claude/hooks/post-merge.sh`) runs:
- `npm install`
- `npm run build`
- `systemctl restart evogent.service`

Pipeline mode: `merge`.

## Key Architecture Decisions

1. **Ephemeral task runtime**: one process per queued task, no persistent session.
2. **File-based communication**: JSONL append + watchers keep data flow simple and debuggable.
3. **Chat continuity via `--resume`**: conversational state without a long-lived daemon process.
4. **Config + curation + preferences split**: `config.md` for app settings, `curation-prompt.md` for explicit curation personality, `preferences-context.md` for learned signals.
5. **Progressive enrichment**: show immediate content, enrich asynchronously.
6. **Skills standard**: `SKILL.md` catalog/runtime model.
7. **Vector similarity for preferences**: semantic matching over large preference history.
