---
metadata:
  evogent:
    user-facing: true
---

Report whether configured Evogent sources are refreshing and serving usable cache data.

Usage: `/source-status`

## Execution Model

- This is a chat-answering diagnostic command. Submit exactly one concise chat reply to the current chat session.
- Do not submit feed items, code_fix suggestions, curation candidates, or notifications unless the user explicitly asks for a follow-up action.
- Resolve `API_BASE` from `MEDIA_AGENT_INTERNAL_BASE_URL` first, then `ORCHESTRATOR_INTERNAL_URL`, then `http://127.0.0.1:${PORT:-3001}`. Do not hardcode localhost or a production port.
- Use SQLite as the source of truth when local DB access is available. Use internal APIs where useful for installed-skill or item inspection, but do not replace DB evidence with API summaries when the DB can be read directly.

## Source Discovery

Discover sources dynamically. Do not start from a fixed source list.

1. Read `.claude/skills/*/SKILL.md`.
2. Parse YAML frontmatter and collect every skill with:
   - `metadata.evogent.feed-source`
   - optional `metadata.evogent.feed-source-label`
3. Treat each discovered `feed-source` as an installed source skill. Examples of source ids may include `twitter`, `youtube`, `substack`, or `hackernews`, but future installs may declare any source id and must work without code changes.
4. Query SQLite for distinct cache sources from both `browse_cache_refresh_runs.source` and `browse_cache_items.source`.
5. Report the union of installed source-skill ids and DB source ids. Account for both:
   - installed source skills with no cache rows yet
   - cache rows or refresh runs whose source has no installed skill

## Evidence To Inspect

Use `DATA_DIR/media-agent.db` when `DATA_DIR` is set; otherwise use `data/media-agent.db` under the repo root. If the DB cannot be opened, say that plainly and fall back to `API_BASE` endpoints where they exist.

For each discovered source, inspect:

- why it is considered configured: installed source skill, DB refresh runs, DB cache rows, source policy/config evidence, or a combination
- expected cadence when derivable from the source skill Cacher Mode, policy JSON, or config
- latest refresh run: `id`, `status`, age, `items_added`, and `error`
- recent completed and failed run counts, using a bounded recent window such as the latest 10 runs or the last 24 hours
- recent inserted-item totals from `browse_cache_refresh_runs.items_added`
- current cache row count from `browse_cache_items`
- fresh/unexpired count where `expires_at_ms > now`
- unseen count where `seen_by_curation_at_ms IS NULL`
- latest fetched and published timestamps from `browse_cache_items`
- relevant task-log or orchestrator failures from `data/task-logs`, `data/agent-logs`, or recent app/orchestrator status APIs when available
- a plain health opinion based on the evidence, separating content outage, stale cache, degraded refresh, no data yet, and healthy states

Useful SQLite checks:

```sql
SELECT DISTINCT source FROM browse_cache_refresh_runs
UNION
SELECT DISTINCT source FROM browse_cache_items
ORDER BY source;

SELECT id, status, started_at_ms, completed_at_ms, items_added, error
FROM browse_cache_refresh_runs
WHERE source = ?
ORDER BY started_at_ms DESC, id DESC
LIMIT 10;

SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN expires_at_ms > ? THEN 1 ELSE 0 END) AS fresh,
  SUM(CASE WHEN seen_by_curation_at_ms IS NULL THEN 1 ELSE 0 END) AS unseen,
  MAX(fetched_at_ms) AS latest_fetched_at_ms,
  MAX(published_at_ms) AS latest_published_at_ms
FROM browse_cache_items
WHERE source = ?;
```

## Deeper Diagnosis When A Source Looks Broken

Run this pass automatically for any source where one or more of these are true:

- latest run age is older than 4x the expected cadence
- the latest 3 runs all failed
- recent completed runs repeatedly have `items_added=0`
- an installed source skill has no DB refresh or cache rows

For each triggered source, run these probes in order and stop when a probe gives a clear root cause. Do not execute fixes, restart services, install skills, submit code_fix suggestions, or make follow-up changes unless the user explicitly asks.

1. Skill installation cross-check:
   - Check `.claude/skills/<source>-cache/SKILL.md` and the discovered skill path, if different.
   - Parse frontmatter and confirm `metadata.evogent.feed-source` equals the source id.
   - If the latest error says `not installed` but the skill file now exists with matching frontmatter, call it a stale error and continue diagnosis.
2. Orchestrator scheduling check:
   - Inspect `data/agent-state/active-tasks.json` or the current equivalent task-state file, plus recent `browse_cache_refresh_runs`.
   - Look for any `cache_refresh` task for the source enqueued within the latest expected-cadence window.
   - If nothing was enqueued, identify the heartbeat or pre-curation scheduler as the gap, not the source skill.
   - End the source bullet with `Suggested fix: investigate heartbeat scheduler coverage for <source>` unless probe 2.5 or a later live test points to a different cause.
2.5. Hook-vs-worker reconciliation:
   - Run this only after probe 2 found no enqueue or no run for this source within the expected-cadence window.
   - Read at most one bounded journal slice from each service: `journalctl -u media-agent.service` and `journalctl -u media-agent-worker.service`, using the last hour or the latest expected-cadence window, whichever is more relevant.
   - From the newest `pre-curation refresh completed` app log, parse `task <id>: <comma-separated sources>`.
   - If no completed hook line exists, or it does not name this source, keep the probe 2 scheduler-gap diagnosis.
   - For each claimed source in that line, look in the worker slice for `[worker] completed cache_refresh job cache-refresh-<source>-<task-id>` or a matching failed `cache_refresh` job for the same source and task id.
   - If the worker has a matching failure, report that failure normally and use the pattern map below.
   - If the hook claimed this source but the worker has no completion or failure record for that job id, call it `hook claimed but worker missing`: `Hook claimed <Source> refresh, worker has no record. Silent drop.`
   - If the hook line cannot be parsed into a task id and sources, say `This looks like a code bug in the pre-curation observability layer. Want me to file a code_fix?`
   - When several claimed sources are missing worker records, name each broken source separately but reuse the same bounded journal slices.
   - End the source bullet with `Suggested fix: drain stuck BullMQ cache_refresh job for <source> and re-enqueue`; do not inspect Redis or execute the fix unless the user explicitly asks.
3. Browser stack health for browser-backed sources only (`twitter`, `youtube`, `substack`):
   - Resolve `CDP_URL` from `CDP_URL`, `MEDIA_AGENT_SHARED_BROWSER_CDP_URL`, `SHARED_BROWSER_CDP_URL`, or `http://127.0.0.1:9222`.
   - Run one bounded CDP probe: `curl -fsS "$CDP_URL/json/version"`.
   - If CDP is unreachable, suggest restarting `chrome-browse.service` or running `scripts/setup-desktop-browser.sh`.
   - For `twitter`, check `/root/.config/x-auth-cookies.json` mtime and run the available runtime auth probe, preferring `node scripts/x-browser/whoami.ts` when present; if auth fails, suggest `/setup-source twitter`.
4. Live test refresh:
   - Only run this for a direct user `/source-status` invocation, not for scheduled audits or when merely reading this command.
   - POST `{"message":"/cache-refresh <source>","priority":"cache_refresh","source":"source-status-probe"}` to `$API_BASE/api/internal/orchestrator/enqueue`.
   - Poll the resulting task or refresh run for up to 60 seconds total.
   - If it fails immediately with the same error pattern, say the failure is reproducible in product code. If it succeeds after no recent enqueue, say the scheduler/heartbeat coverage is the bug.
5. Failure-error pattern map:
   - `not installed`, `unsupported_provider_cli`: Suggested fix: reinstall with `POST /api/skills/install registry=<source>-cache`, or verify skill frontmatter has `feed-source: <source>`.
   - `shared browser navigated away`, `CDP unreachable`: Suggested fix: restart `chrome-browse.service` or run `scripts/setup-desktop-browser.sh`.
   - `signed-out`, `login`, `interstitial`: Suggested fix: run `/setup-source <source>` to re-authenticate the shared Chrome profile.
   - `429`, `rate limit`, `Pro cap`: Suggested fix: wait for the provider window to reset and check `/api/usage/summary`.
   - `network`, `DNS`, `tls`: Suggested fix: check VM connectivity with `curl -fsS https://x.com`.
   - `hook claimed but worker missing`: Suggested fix: drain stuck BullMQ cache_refresh job for <source> and re-enqueue; investigate the cache-refresh worker logs.

When a clear operational cause is identified, end that source bullet with one `Suggested fix:` line naming the next action. When the cause looks like a code bug, such as heartbeat scheduling missing an installed source or runtime rejecting a correct source skill, end the diagnosis with: `This looks like a code bug in <subsystem>. Want me to file a code_fix?`

## Unknown Or Mismatch Section

Include a short "Unknown/mismatch" section when any of these appear:

- installed source skill with no cache data
- cache source with no installed skill
- invalid, missing, future, or non-monotonic refresh timestamps
- suspicious cadence when the latest run age is far beyond an expected cadence you could derive
- repeated completed refreshes with zero items added
- recent failures after the latest success
- DB unavailable or schema missing expected cache tables

## Response Format

Keep the answer compact:

- Start with one sentence summarizing overall source health.
- Then include one bullet per discovered source with the source id/label, health opinion, latest run, item counts, freshness, unseen count, and notable errors.
- When deeper diagnosis runs for a broken source, that source bullet may expand by 1-3 extra lines for latest error text, probe result, and suggested fix.
- End with the unknown/mismatch section only when needed.
