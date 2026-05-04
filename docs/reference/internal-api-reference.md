# Internal And Public API Reference

This table collects the endpoint summary that used to live in `.claude/CLAUDE.md`.

## HTTP Endpoints

| Method | Path | Purpose |
|------|------|---------|
| GET | `/api/feed` | Paginated feed (offset, limit, type filter) |
| GET | `/api/feed/[id]` | Single post detail |
| PATCH | `/api/feed/[id]` | Update existing feed row fields such as enrichment text, media, counters, and metadata |
| GET | `/api/feed/[id]/children` | Child posts (thread, replies, analysis) |
| POST | `/api/feed/[id]/enrich` | Trigger post enrichment task |
| GET | `/api/config` | Read `config.md` |
| POST | `/api/config` | Persist editable config docs through the shared integrity-checked mutation path and notify orchestrator |
| POST | `/api/interactions` | Thumbs up/down with optional reason |
| GET | `/api/preferences` | List learned preferences with stats |
| POST | `/api/import-archive` | Import Twitter data export as preferences |
| GET | `/api/skills` | List installed skills + registry |
| POST | `/api/skills/install` | Install skill from registry |
| POST | `/api/ping` | Enqueue a user ping task |
| POST | `/api/chat` | Enqueue a chat task |
| GET | `/api/status` | Runtime status + orchestrator state |
| GET | `/api/orchestrator/status` | Queue depth, current task, history |
| WS | `/ws/feed` | Real-time feed updates |
| WS | `/ws/chat` | Chat updates/status |
| WS | `/ws/orchestrator` | Orchestrator status stream |
| WS | `/ws/agent-progress` | Task progress stream |

## Runtime-Critical Internal Endpoints

- `POST /api/internal/curate/submit`: primary feed persistence path; validates, dedups, inserts, appends audit JSONL, and broadcasts updates. `items` are accepted feed entries; `candidates` are rejected-only log entries and must include `text`, `reason`, `rejectionReason`, `cycleId`, `sourceId`, and `timestamp`. Candidate `metadata` is optional for source-quality misses such as incomplete cached tweet text.
- `POST /api/internal/browse-cache/submit`: ambient source-cache persistence path. Cache refresh workers may include `cycleSummary`; it is stored in refresh-run metadata so source-recovery counts such as Twitter text-completeness audits remain inspectable.
- `POST /api/internal/orchestrator/enqueue`: direct fallback path for enqueueing work when command-driven orchestration is unavailable
