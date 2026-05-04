# Shared Audit Core

This is the single audit framework for Evogent.

It runs inline during every curation cycle and every reflection cycle. The `pipeline-audit` skill is only a manual entrypoint into this same core. Do not create a third audit path with different rules, outputs, or lifecycle handling.

## Invocation modes

### `curation`

- Run this core during every curation cycle.
- Gather the evidence early enough to shape sourcing decisions, then reuse the same evidence after submit and `cache-hints.json`.
- Curation owns current-cycle operational state:
  - live source access
  - browsing coverage for this cycle
  - current feed-quality problems
  - active incidents that must be surfaced now

### `reflection`

- Run this core during every reflection cycle.
- Use the same audit dimensions and routing rules, but evaluate them across multiple cycles.
- Reflection owns cross-cycle synthesis:
  - durable feed-quality patterns
  - durable source-health trends
  - config and prompt recommendations
  - preference-insight maintenance
  - tracked-event lifecycle recommendations

### `manual`

- `pipeline-audit` uses this mode when the user explicitly asks to run an audit.
- Use the same evidence, routing, and lifecycle rules as `curation` and `reflection`.

## Shared constraints

- Do the work inline in the current invocation. Do not spawn nested orchestration just to audit.
- Do not add product-code heuristics to compensate for instruction drift. Fix the instructions and diagnostics instead.
- Use `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"` for internal endpoints.
- When `MEDIA_AGENT_INTERNAL_BASE_URL` is present, never replace it with another guessed port.
- Treat rendered-page evidence as stronger than pessimistic status heuristics.

## Shared evidence bundle

Gather this evidence once per invocation and reuse it for decisions and output routing.

### 1. Deployment and incident state

- Check `GET /api/status` and inspect deployment state.
- Check existing feed notifications and suggestions for the same incident or recurring failure pattern before creating anything new.

### 2. Source health and browsing coverage

- Inspect installed source skills in `.claude/skills/*/SKILL.md` first and use `metadata.evogent.feed-source` to identify active sources.
- Judge source health by direct browsing coverage, shared-browser access, task logs, scratchpads, and recent feed outcomes.
- Read `/api/internal/reflection/upstream-health` before escalating browser-access failures. Use:
  - `dependencies` for shared-browser state
  - `sourceDiagnoses` for source-local notes
  - `incident` for provider-aware routing and duplicate suppression
- For browser-backed sources, trust rendered-page evidence over stale operational guesses. If the browser shows real content, treat coverage as available and ask why curation missed it.
- Use recent task logs, scratchpads, service logs, and relevant code/database checks as the second evidence layer.

### 3. Feed quality and persistence

- Inspect recent raw `/api/feed` results to understand continuity, duplication risk, and missing content classes.
- Review `data/curation-prompt.md`, `data/preferences-context.md`, and `data/preference-insights.md`.
- Review `data/curation-candidates.jsonl` when available, plus `/api/internal/reflection/rejection-scorecard` during reflection or manual audits.
- Check whether preference context and insights were fresh enough for the cycle you are auditing.
- Check whether `data/cache-hints.json` was rewritten for the current cycle when curation was responsible for doing so.
- Inspect curation lifecycle logging, submit and dedup behavior, and recent operational logs when outputs suggest missing data or quality drift.
- Ask whether the system is losing useful directly-browsed information, reacquiring discarded data later, or encoding browsing judgment in product code that belongs in skills, prompts, and the browser session.

### 4. Reflection-only evidence

When running in `reflection` mode, also gather:

- config history and curation-prompt history
- recent chat output from `data/chat-output.jsonl` and/or `GET /api/chat/messages?limit=200`; classify recent user messages yourself as `content_interest`, `product_dev_setup`, or `operational_blob` with one-sentence reasoning
- recent preference records, reasoned likes, and reasoned dislikes
- `data/tracked-events.json`

## Outcome routing

Route findings through the normal feed schema only.

### `type: "notification"`

Use for active degraded state in the current cycle and current incidents the user should see without approving a change.

### `type: "suggestion"` with `metadata.suggestionType: "code_fix"`

Use for durable infrastructure, instrumentation, persistence, or diagnosis gaps.

This includes approved edits to `data/config.md` and `data/curation-prompt.md`.

Keep `metadata.proposedValue` directional. Describe what is broken, why it matters, the desired outcome, and hard constraints. Do not pre-write the exact implementation.

For browser-backed findings, prefer fix directions such as removing infrastructure gating, moving browsing behavior into skills and prompts, or strengthening diagnostics.

## Role boundaries

- Curation handles current-cycle operational state and current-cycle evidence.
- Reflection handles cross-cycle synthesis and durable recommendations.
- Manual audit runs the same core but must still respect the same output ownership.
