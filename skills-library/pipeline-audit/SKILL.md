---
name: pipeline-audit
description: General-purpose bottom-up pipeline audit that traces data from storage outward to find efficiency issues, data loss, redundant work, and architectural bypasses
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    requires:
      env: []
---
# Pipeline Audit

Reusable audit skill for tracing a pipeline bottom-up from its persisted store.

## Purpose

Use this skill when you need a read-only Claude Code sub-agent to audit a pipeline for:

- rich captured data becoming thin persisted storage
- later stages re-fetching discarded data
- command families repeating work against the same logical target
- abstractions being bypassed by direct provider or browser calls

This is an opt-in diagnostic tool. Do not run it on every heartbeat or curation cycle.

## Audit Prompt Template

Use this prompt exactly unless you are adapting the pipeline target:

```text
You are a read-only systems audit agent inside a repository.

Constraints:
- Do not modify files, install packages, run builds, or change the system.
- Use only Read, Glob, Grep, and read-only Bash commands — EXCEPT for the feed cleanup APIs listed in step 1 and the submit API in the output step, which require POST requests via curl.

Task:
Audit the main external-content pipeline bottom-up from its persisted cache/store. Focus on finding where rich captured data becomes thin storage, where later stages reacquire that lost data, and where command families repeat work against the same logical target.

Procedure:

Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"` before calling any internal Evogent endpoint. When `MEDIA_AGENT_INTERNAL_BASE_URL` is present, never replace it with `localhost:3001`, `127.0.0.1:3001`, or another guessed port from old examples.

**Step 0 — Check deployment state**

Before triaging prior fixes, fetch deployment status:

```bash
curl -s "$API_BASE/api/status" | jq '.deployment'
```

Interpret it this way:
- `deployment.running.commit` and `deployment.running.buildId` are the code and build the live app is actually serving now.
- `deployment.pendingRestart` means newer merged code exists on disk but the live app may still be serving an older commit.
- If a prior fix is marked merged but `deployment.pendingRestart.commit` differs from `deployment.running.commit`, treat that fix as awaiting deployment. Do not mark it verified or failed until the live app has restarted onto the merged commit.

**Step 1 — Triage existing audit items (ALWAYS do this first)**

Before investigating anything, find and triage ALL previous audit-originated items in the feed. Audit items have used many sourceId prefixes historically — do NOT hardcode a single prefix. Instead, use a broad search:

a. Fetch ALL suggestions and notifications, then filter for audit-related items by checking sourceId and text/title for audit keywords:
   ```bash
   # Fetch suggestions — filter broadly for any audit-originated item
   curl -s "$API_BASE/api/feed?type=suggestion&limit=50" | jq '[.items[] | select(.sourceId | test("audit|pipeline-audit"; "i")) // select(.title | test("audit"; "i"))]'

   # Fetch notifications — same broad filter
   curl -s "$API_BASE/api/feed?type=notification&limit=50" | jq '[.items[] | select(.sourceId | test("audit|pipeline-audit"; "i")) // select(.title | test("audit"; "i"))]'
   ```

b. Check which suggestions have already been acted on — look at metadata.codeFixOrchestratorStatus (values: dispatched, merged, failed) and metadata.suggestionStatus (values: accepted, dismissed). A merged fix is not yet live evidence if step 0 shows the app is still running an older commit.

c. Check git log for recent merges that may have addressed previous findings:
   git log --oneline --since='48 hours ago' | grep -i 'fix\|audit\|cache\|enrich\|pref'

d. Dismiss stale items. For each existing audit notification or suggestion that has been addressed (code is live on the running commit and the finding no longer reproduces) or is now obsolete, dismiss it:
   - Notifications: curl -s -X POST "$API_BASE/api/internal/notifications/resolve" -H 'Content-Type: application/json' -d '{"feedItemId": "<id>"}'
   - Suggestions: curl -s -X POST "$API_BASE/api/internal/code-fix-suggestions/sync" -H 'Content-Type: application/json' -d '{"suggestions": [{"id": "<id>", "suggestionStatus": "dismissed"}]}'

e. Note which findings are still valid and unaddressed — do NOT recreate them. Only create new items for genuinely new findings.

**Step 2 — Resolve the previous audit summary**

Before creating a new summary notification, resolve the previous one so only one audit summary is active at a time. The summary uses `metadata.notificationId: "pipeline-audit-summary"` — search for it and resolve if found. Use a timestamped sourceId for the new summary to avoid UNIQUE constraint conflicts with dismissed predecessors.

**Step 3 — Auto-resolve transient health notifications**

For each previous audit notification that reported a transient condition (cache refresh failure, auth expired, etc.), re-check the current state. If the condition has cleared, resolve the notification. If it persists, leave it.

For browse refresh failures, always fetch `/api/internal/reflection/upstream-health` and use it as a provider-aware classifier before creating new items:

- If `incident.scope` is `provider`, route the outage once at that shared dependency. Do not write separate twitter/youtube/substack fixes when they are symptoms of the same hung shared browse provider.
- Use `sourceDiagnoses[*].failureKind` to distinguish `auth`, `rate_limited`, `source_regression`, and `provider_hung`.
- Include `metadata.incidentKey` on any notification or suggestion you submit for that outage.
- If the routed `incident.notification.active` or `incident.suggestion.active` flag is already true, do not create another item for that same incident in this audit cycle.
- For configured browser-backed sources that return zero items, also call `POST /api/internal/browse-cache/direct-page-probe` with `{"source":"twitter|youtube|substack","allowRecovery":true}` before treating the source as healthy or truly empty. Use that probe's `blockingState`, `recovered`, `itemCount`, `currentUrl`, and `error` as the last-mile evidence layer.
- Treat `blockingState = consent_wall|signed_out|age_gate|interstitial` as blocked. Treat `blockingState = empty` as truly empty only after the direct-page probe confirms it. If the probe sees visible items while the cache refresh produced zero, classify that as a source-local regression.

1. Identify the primary persisted cache/store and its stored shape.
2. Trace the writer that receives the richest captured object before that store.
3. Compare the rich object shape to the persisted shape. Explicitly list major categories retained vs discarded.
4. Trace downstream consumers that later need the discarded categories. Show whether they reacquire them by calling external CLIs, alternate providers, or browser commands.
5. Build a provider/routing map. If one stage uses an abstraction but another calls a concrete backend directly, flag it.
6. Build a same-target command map. For operations like single-item read, replies, thread, or equivalent views of one resource, check whether helpers independently reconnect, reopen sessions, or reload the same target instead of reusing a shared capture.
7. Prefer findings that combine rich-to-thin boundary, repeated fetch, provider bypass, repeated browser/session setup, or repeated same-target navigation.

Search limits:
- Stay on the main pipeline only.
- Return at most 5 findings.
```

## Invocation Modes

### User-invoked via chat or ping

When the user says "run an audit" or "audit the pipeline", spawn a read-only Claude sub-agent with the audit prompt template:

```bash
claude -p '<audit prompt>' --allowedTools 'Read,Glob,Grep,Bash(read-only commands only)' --permission-mode dontAsk --no-session-persistence
```

Use the full prompt template above. Keep the sub-agent read-only.

### Called by reflection

Reflection can invoke this skill when it detects quality drift, repeated failures, or recurring evidence that the upstream pipeline is wasting work or dropping needed data.

### Adaptable target

The template defaults to "main external-content pipeline". To adapt it, replace only the `Task:` line with a pipeline-specific target description.

Examples:

- `Audit the enrichment pipeline from feed items through enrich-tweet to submission`
- `Audit the preferences pipeline from interaction capture through vectorization to context assembly`
- `Audit the chat pipeline from message receipt through orchestrator to response delivery`

## Output Format

Submit audit results as:

- One brief `type='notification'` feed item summarizing the audit's overall findings
- One `type='suggestion'` feed item per actionable finding with `metadata.suggestionType='code_fix'`
- Link all suggestions to the summary notification via `parentId`
- Do not submit an analysis post. The notification plus suggestions keep the feed clean.
- For recurring refresh outages, include `metadata.incidentKey` so future cycles can suppress duplicates and route back to the existing incident item.

### sourceId conventions

- Summary notification sourceId: `pipeline-audit-summary-<YYYYMMDD-HHMMSS>` (unique per run)
- Summary notification `metadata.notificationId`: `pipeline-audit-summary` (stable — used by resolve API)
- Suggestion sourceIds: `pipeline-audit-sug-<finding-slug>` (e.g., `pipeline-audit-sug-cache-stale`)

### Conciseness rules

- **Summary notification**: Max 2 sentences.
- **Suggestion titles**: Max 8 words. No implementation detail.
- **Suggestion text**: Max 2-3 sentences. What's wrong and fix direction only.
- **Suggestion reason**: One sentence.

### Lifecycle rules

1. **Supersede old summaries**: Resolve the previous summary before creating a new one.
2. **Auto-resolve cleared conditions**: Resolve transient notifications when the underlying issue clears.
3. **Don't recreate existing findings**: Leave unaddressed duplicates in place.
4. **Dismissed items still occupy UNIQUE(source_id)**: Use timestamped sourceIds for summaries.

Keep findings concrete. Prefer issues that connect a rich-to-thin boundary to repeated downstream fetches, provider bypasses, or repeated session/navigation setup.
