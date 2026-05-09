Refresh exactly one source into the ambient browse cache.

Usage: `/cache-refresh <source>`

## Execution Model

- Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"`.
- Refresh only the requested source for this run.
- If `MEDIA_AGENT_CACHE_REFRESH_SOURCE` is set, it is the requested source and must match the invocation source.
- Read the matching source skill directly at `.claude/skills/<source>-cache/SKILL.md`, where `<source>` is the source argument or `MEDIA_AGENT_CACHE_REFRESH_SOURCE`, and follow its **Cacher Mode** instructions.
  Use a direct read (`cat` or Read tool). Do not use `rg`, `find`, or any tool that respects `.gitignore` for skill discovery, because the cache-skill directories are runtime-installed and gitignored.
- Cacher Mode must use the same selectors, extracted fields, and quality thresholds as that skill's Curation Mode.

## Setup Smoke Mode

When `MEDIA_AGENT_CACHE_REFRESH_MODE=setup-smoke`, this run is source setup proof, not a broad scheduled refresh.

- Use only the selected provider's available browser tools for this task. Do not switch to another browser MCP, launch a separate Chrome profile, or use one-off CDP extraction scripts.
- Treat `MEDIA_AGENT_CACHE_REFRESH_RUN_ID` as required. Submit it as `runId`.
- Submit `triggeredBy` as `MEDIA_AGENT_CACHE_REFRESH_TRIGGERED_BY` when set; for setup smoke this should be `setup-source-smoke`.
- Extract a small working batch only: stop after `MEDIA_AGENT_CACHE_REFRESH_MAX_ITEMS` kept items, defaulting to 5 if unset.
- The success criterion is a completed `/api/internal/browse-cache/submit` response for this run id with at least one item.
- On failure, submit a failed refresh run with `items: []`, the same `runId`, and an error string that starts with one exact layer:
  - `chrome_login:`
  - `provider_mcp_endpoint:`
  - `unsupported_provider_cli:`
  - `scraper_runtime:`
  - `submit_failure:`
  - `no_rows:`

## Required Behavior

- Read `data/config.md` for cache interval context when relevant.
- Extract raw items for the requested source.
- Preserve the same field shape curation expects from the direct-browse skill.
- Persist the refresh result through `POST ${API_BASE}/api/internal/browse-cache/submit`.

## Submit Contract

- Success payload:
  - `runId` (required in setup smoke mode)
  - `source`
  - `triggeredBy`
  - `startedAtMs`
  - `completedAtMs`
  - `status: "completed"`
  - `items: [...]`
  - `cycleSummary` when the source produced audit counts; for Twitter this must include text-completeness and source-id dedupe counts from the source skill
- Failure payload:
  - same run metadata
  - `status: "failed"`
  - `error` with the exact failure layer prefix in setup smoke mode
  - `items: []`

## Item Contract

- Every cached item must include:
  - `source`
  - `sourceId`
  - `payload`
  - `fetchedAtMs`
  - `expiresAtMs`
- Include `url`, `title`, `authorUsername`, `authorDisplayName`, and `publishedAtMs` when known.
- For Twitter/X items, `sourceId` must be the bare numeric tweet id. Do not submit both `twitter:<id>` and `<id>` for the same tweet; if both were seen, keep the row with complete status-page text and report the duplicate in `cycleSummary.textCompletenessAudit.deduped`.

## Guardrails

- Do not submit feed items here. This command only refreshes cache storage.
- Do not invent source-specific selectors here; use the installed skill file as the source of truth.
