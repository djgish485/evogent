Run one full reflection cycle in this invocation.

Usage: `/reflect [optional focus]`

`$ARGUMENTS` can add extra focus.

## Execution model

- You are the reflection worker for this task.
- Perform the analysis directly in this run.
- Submit suggestion items, if any, via the feed submit API. Use feed JSONL only as a last-resort fallback.
- Do not spawn another agent CLI process.
- Do not use tmux.

## 1. Resolve project root and reflection depth

Use `${MEDIA_AGENT_ROOT}` when set. Reflection depth still follows `data/config.md` usage level:

- `low`: conservative, only obvious high-signal changes
- `medium`: balanced evidence review
- `high`: deeper review across more recent history

## 2. Reflection status lock and lifecycle tracking

Use `data/reflection-status.json` as lock/status source. Do not run if another reflection is already active.

## 3. Gather reflection evidence

Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"` before calling internal endpoints.

Read `.claude/shared/audit-core.md` and execute it in `reflection` mode. Reflection uses the same audit core as curation; it does not maintain a separate cache-health workflow.

Read all of the following before deciding whether to propose any change:
1. `data/config.md`
2. `data/curation-prompt.md`
3. Newest 5 files from `data/config-history/` when present
4. Newest 5 files from `data/curation-prompt-history/` when present
5. `data/preferences-context.md`
6. `data/preference-insights.md` when present
7. Last 24-48 hours from `data/chat-output.jsonl`
8. Last 24 hours from the feed source of truth
9. Last 48 hours from `data/curation-candidates.jsonl` when present
10. `.claude/skills/*/SKILL.md` for active source boundaries

Also gather:

- recent preferences and reasoned likes/dislikes
- rejection scorecard
- `GET ${API_BASE}/api/internal/reflection/upstream-health?hours=168`
- `data/tracked-events.json`

Use the upstream-health endpoint as shared-browser and source-coverage evidence, not as a cache-ledger check.

For recent chat, read the raw history yourself instead of calling a classifier endpoint. Use `data/chat-output.jsonl` plus `GET ${API_BASE}/api/chat/messages?limit=200` when the app is reachable, filtering to recent user chat messages. Classify each relevant user message as `content_interest`, `product_dev_setup`, or `operational_blob`, with one sentence of reasoning per message. Put a compact structured summary in the reflection scratchpad: counts by class, top content topics, and any product-dev/setup themes that should be ignored for durable preference memory.

## 4. Reflection decision rules

Goal: propose thoughtful improvements only when evidence is strong.

Hard guardrails:

- Never edit `data/config.md` directly.
- Never edit `data/curation-prompt.md` directly.
- Use feed suggestions so the user can accept or dismiss them in the UI.
- If a similar change was recently dismissed or reversed, hold back.
- Zero suggestions is often the correct outcome.
- Reflection owns cross-cycle synthesis and durable recommendations.

## Authoring freeform UI cards

Any submitted feed item type may include `metadata.mcpAppHtml`. The renderer will show that HTML as the card body, so use it when a plain suggestion or notification would hide the useful next action.

Card actions:
- Use `data-evogent-action="<actionId>"` on clickable elements, or call `window.evogentAction(actionId, payload)` from card JavaScript.
- For simple buttons, attach payload fields as `data-payload-<name>="value"` attributes. They become payload keys, for example `data-payload-handle="nickcammarata"` becomes `{ "handle": "nickcammarata" }`.
- Built-in UI actions such as `dismiss_notification`, `open_detail`, `accept_suggestion`, and `dismiss_suggestion` still work.
- Source actions use dotted namespaces owned by installed source skills: `x.follow`, `youtube.subscribe`, `substack.subscribe`. The namespace before the dot must be declared in that skill's SKILL.md frontmatter under `metadata.media-agent.action-namespaces`.
- Product code only dispatches the action. The source skill's "Feed action handlers" section defines what the action means and how to perform it.

Example follow-candidate card body:

```html
<section>
  <h2>Consider following @nickcammarata</h2>
  <p>Concrete reason from recent evidence.</p>
  <button data-evogent-action="x.follow" data-payload-handle="nickcammarata">Follow @nickcammarata</button>
  <button data-evogent-action="dismiss_notification">Dismiss</button>
</section>
```

Autonomous reflection must not follow accounts or click source actions on its own. Only the user-initiated card-action path may dispatch a source action.

## 5. Recent-merge audit

Audit recent dev-agent merges against the project's design and boundary rules. This is reflection-scale synthesis, not a substitute for `/review` or `/security-review`.

Use `data/agent-receipts.jsonl` as the authoritative merge list. Do not use `git log` discovery for this audit. If the receipts file is missing, unreadable, or empty, skip this section and continue reflection normally.

Selection rules:

- Respect reflection depth when choosing how many receipt-backed merges to inspect: `low` = last 5 merges, `medium` = last 15, `high` = last 40.
- Prefer merges from the last 24 hours, and widen to 48 hours only when depth permits or recent volume is low.
- Skip entries with no merge commit SHA or no receipt metadata tying the merge to the dev-agent flow.
- Pre-receipt backlog and manual merges are out of scope. Skip them silently.

Evidence to read for each selected merge:

1. `git show --stat <merge-sha>`
2. `git show <merge-sha>` when the diff is small enough to inspect directly
3. `CLAUDE.md` and `.claude/CLAUDE.md` for boundary-review and design-philosophy rules
4. `/root/.claude/projects/-root-evogent/memory/feedback_design_philosophy.md`
5. `/root/.claude/projects/-root-evogent/memory/feedback_develop_prompts.md`
6. `/root/.claude/projects/-root-evogent/memory/feedback_fix_detector_not_defect.md` when present

Audit heuristics:

- Score only material violations. Reflection is not doing line-by-line review.
- Check for large single-file additions, especially 100+ added lines in one file, unless the file is clearly durable infrastructure such as storage, APIs, queues, WebSocket plumbing, or similarly load-bearing primitives.
- Check for browsing or model judgment encoded into product code when the behavior should have stayed in runtime instructions, skills, or diagnostics.
- Check for infrastructure-constraint bypasses and workarounds that evade the real boundary instead of fixing the misconfigured constraint.
- Check for speculative features, premature abstraction, backward-compat shims that should have been removed, and unused code left behind after the merge.
- Check whether the net line count goes up when the accepted suggestion or receipt context said the change should reduce, simplify, or delete code.
- Cross-check the diff against the durable philosophy notes and develop-prompt feedback. Repeatedly known anti-patterns should count more heavily than one-off style concerns.
- Do not flag formatting, import order, or other stylistic preferences.

Submission rules:

- Only submit a `code_fix` suggestion when the merge clearly violates a rule and the violation is material.
- Submit at most one `code_fix` suggestion per offending merge.
- Name the merge commit SHA, the violated rule, the concrete file or subsystem, and the narrow revert/refinement needed. Keep scope tight to the violation rather than rewriting the whole feature.
- Submit through `POST ${API_BASE}/api/internal/curate/submit` using the existing suggestion mechanism.
- Before submitting, inspect `data/agent-receipts.jsonl` for an earlier reflection or audit suggestion already targeting the same merge SHA. Do not duplicate it.
- Do not re-flag a merge that a later merge has already repaired, reverted, or otherwise addressed.
- Zero suggestions is a correct outcome when no merge crosses the materiality threshold.

Recurring-pattern rules:

- When the same class of violations repeats across merges, promote that pattern into `data/preference-insights.md` under a `Code Audit Patterns` section.
- Only promote durable patterns: repeated violations by the same agent, in the same file or subsystem, or against the same boundary rule.
- Record the pattern in synthesis form with evidence counts and recent examples, not as a raw changelog.

## 6. Preference insights maintenance

Maintain `data/preference-insights.md` directly.

If user feedback patterns reveal a systematic content gap, you may also overwrite `data/cache-hints.json` as lightweight browse steering for the next direct-browse cycle.

Keep the existing sections:

- `Strong Dislikes`
- `Emerging Interests`
- `Active Chat Interests`
- `Account Preferences`
- `Content Style Preferences`
- `Curation Blind Spots`
- `Evolving Tastes`

Add `Code Audit Patterns` only when recurring recent-merge audit evidence supports it.

Rules:

- Replies signal engagement, not agreement.
- Synthesize, do not dump.
- Cite evidence counts.
- Favor recent signals.
- Replace stale sections when evidence no longer supports them.
- When thread-level feedback repeats across cycles, promote that pattern into `data/preference-insights.md` as durable memory rather than leaving it as one-cycle steering only.
