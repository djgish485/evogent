Run one full reflection cycle in this invocation.

Usage: `/reflect [optional focus]`

`$ARGUMENTS` can add extra focus.

## Execution model

- You are the reflection worker for this task.
- Perform the analysis directly in this run.
- Submit suggestion items, if any, via the feed submit API. Use feed JSONL only as a last-resort fallback.
- Do not spawn another agent CLI process.
- Do not use tmux.
- This scheduled phone worker is not a software-development agent. Do not inspect git history,
  merge receipts, host-agent memory, or product-code diffs. Do not edit code, scripts, skills,
  tests, or development artifacts. Host development owns implementation review and repair.

## 1. Resolve project root and reflection depth

Use `${MEDIA_AGENT_ROOT}` when set. Reflection depth still follows `data/config.md` usage level:

- `low`: conservative, only obvious high-signal changes
- `medium`: balanced evidence review
- `high`: deeper review across more recent history

## 2. Reflection status lock and lifecycle tracking

Use `data/reflection-status.json` as lock/status source. Do not run if another reflection is already active.

## 3. Gather reflection evidence

Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"` before calling internal endpoints.
Resolve `API_CURL="${EVOGENT_API_CURL:-curl}"` too, and use
`"$API_CURL"` for every request to `API_BASE`.

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

- recent raw interaction rows from `interactions`, joined to their feed items. Prefer `GET ${API_BASE}/api/internal/interactions/recent?limit=200` when reachable; otherwise query SQLite directly for the last 48 hours of `action`, `created_at`, feed id, title, source, author, and text.
- recent preferences and reasoned likes/dislikes
- rejection scorecard
- `GET ${API_BASE}/api/internal/reflection/upstream-health?hours=168`
- `data/tracked-events.json`

Use the upstream-health endpoint as shared-browser and source-coverage evidence, not as a cache-ledger check.

For recent chat, read the raw history yourself instead of calling a classifier endpoint. Use `data/chat-output.jsonl` plus `GET ${API_BASE}/api/chat/messages?limit=200` when the app is reachable, filtering to recent user chat messages. Classify each relevant user message as `content_interest`, `product_dev_setup`, or `operational_blob`, with one sentence of reasoning per message. Put a compact structured summary in the reflection scratchpad: counts by class, top content topics, and any product-dev/setup themes that should be ignored for durable preference memory.

## 4. Reflection decision rules

Goal: learn durable private preferences and source cadence, and surface product observations only
when runtime evidence is strong.

Hard guardrails:

- Never edit `data/config.md` directly.
- Never edit `data/curation-prompt.md` directly.
- **Check runtime evidence first**: use status endpoints, receipts, logs, configuration, and
  deployed instructions to avoid proposing a control that is already operating. Do not inspect
  implementation code. If a durable product problem remains, describe the observable failure,
  evidence, desired outcome, and boundary constraints; leave diagnosis and implementation to
  host development.
- **Automate reversible repairs; ask about the rest**: a low-risk, easily undone tuning that touches only
  files reflection owns (`preference-insights.md`, account tiers, cadence data files) gets
  APPLIED, with a notification card stating what changed, why, and how to undo. Only changes
  that are risky, hard to reverse, or touch the user's own config/prompt files become
  approval suggestions.
- **Every suggestion card carries its full case IN the card**: the evidence, the concrete
  change, the expected effect, and what approving will do. A card whose body cannot explain
  why approval is warranted must not ship.
- If a similar change was recently dismissed or reversed, hold back.
- Zero suggestions is often the correct outcome.
- Reflection owns cross-cycle synthesis and durable recommendations.

## Authoring freeform UI cards

Any submitted feed item type may include `metadata.mcpAppHtml`. The renderer will show that HTML as the card body, so use it when a plain suggestion or notification would hide the useful next action.

Card actions:
- Use `data-evogent-action="<actionId>"` on clickable elements, or call `window.evogentAction(actionId, payload)` from card JavaScript.
- For simple buttons, attach payload fields as `data-payload-<name>="value"` attributes. They become payload keys, for example `data-payload-handle="example_candidate"` becomes `{ "handle": "example_candidate" }`.
- Built-in UI actions such as `dismiss_notification`, `open_detail`, `accept_suggestion`, and `dismiss_suggestion` still work.
- Source actions use dotted namespaces owned by installed source skills: `x.follow`, `youtube.subscribe`, `substack.subscribe`. The namespace before the dot must be declared in that skill's SKILL.md frontmatter under `metadata.media-agent.action-namespaces`.
- Product code only dispatches the action. The source skill's "Feed action handlers" section defines what the action means and how to perform it.

Example follow-candidate card body:

```html
<section>
  <h2>Consider following @example_candidate</h2>
  <p>Concrete reason from recent evidence.</p>
  <button data-evogent-action="x.follow" data-payload-handle="example_candidate">Follow @example_candidate</button>
  <button data-evogent-action="dismiss_notification">Dismiss</button>
</section>
```

Autonomous reflection must not follow accounts or click source actions on its own. Only the user-initiated card-action path may dispatch a source action.

## 5. Preference insights maintenance

Maintain `data/preference-insights.md` directly.

If user feedback patterns reveal a systematic content gap, you may also overwrite `data/cache-hints.json` as lightweight browse steering for the next direct-browse cycle.

This file is durable synthesis, not an event log. Its UTF-8 size must be at most
49,152 bytes (48 KiB) when this run finishes. If the existing file is larger, consolidating
it is required work even when there are no new preferences:

- merge repeated observations into one current statement with aggregate evidence counts;
- remove dated narration, superseded conclusions, raw excerpts, and duplicate examples;
- keep contrary evidence or uncertainty when it materially changes the conclusion;
- do not discard a durable preference merely to meet the limit—the raw evidence remains in
  SQLite and the bounded `preferences-context.md` carries recent behavior.

Keep the existing sections:

- `Strong Dislikes`
- `Emerging Interests` — when the same lane receives expands across 3+ recent cycles with no negative counterweight, promote it here explicitly as a weak-positive lane signal, noting it is expand-backed rather than like-backed. Views stay neutral; expands are the endorsed moderate-positive signal.
- `Active Chat Interests`
- `Account Preferences`
- `Content Style Preferences`
- `Curation Blind Spots`
- `Evolving Tastes`

Rules:

- Replies signal engagement, not agreement.
- Weight interaction evidence explicitly:
  - `like` / `thumbsup` = strong positive.
  - `dislike` / `thumbsdown` = strong negative.
  - `expand` = moderate positive; the user was curious enough to open detail.
  - `view` = mild positive only when paired with a pattern; it means the user read long enough to count.
  - `suggestion_dismissed` / `dismiss_suggestion` = strong negative on the underlying suggestion topic.
  - `view` with no `expand`, `like`, or `dislike` = neutral "saw it, did not react", not a strong preference.
  - No `view` row = genuinely unread; preserve that as latent signal for curator reordering rather than interpreting it as dislike.
- Synthesize, do not dump or append a chronological changelog.
- Cite evidence counts.
- Favor recent signals.
- Replace stale sections when evidence no longer supports them.
- When thread-level feedback repeats across cycles, promote that pattern into `data/preference-insights.md` as durable memory rather than leaving it as one-cycle steering only.
- While the reflection status lock is still held, write the final preference-insights bytes
  atomically to canonical phone-native state at `data/preference-insights.md`: create a
  mode-`0600` temp file beside the destination, `fsync`/close it, then `mv` it into place.
  Verify mode `0600` and the 49,152-byte limit before the lock is released. No retired runtime
  mirror is a success dependency. Do not update `MEMORY.md` here.

## 6. Private source-cadence maintenance

Maintain `data/source-cadence.json` as private runtime state. The public
`data/source-cadence.default.json` is bootstrap-only and intentionally carries no per-person
source schedule.

- Read recent browse-run receipts/yields, source health, attention/interaction evidence, and
  battery or provider cost before choosing a cadence.
- Tune sources independently from that evidence. Product code launches and records work; it
  does not decide which source deserves more of the deployment's attention budget.
- A notification-driven source may use a slower baseline because a relevant notification can
  still override its clock. A high-yield source may run every cycle (`cadenceHours: 0`).
- Preserve unknown sources and existing reasons unless current evidence warrants a change.
- Write valid JSON atomically with mode `0600`. Each source entry must contain a non-negative
  numeric `cadenceHours` and a short synthesized `why`; never copy raw private evidence into
  the reason.
- Apply reversible evidence-backed tuning directly. Mention only material cadence changes in
  the reflection card, with the reason and how to undo them.
