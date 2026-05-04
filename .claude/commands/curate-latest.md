---
metadata:
  evogent:
    user-facing: true
---
Run one lightweight latest-content curation pass in this invocation.

Usage: `/curate-latest [optional focus]`

`$ARGUMENTS` is optional extra editorial focus for this pass.

## Execution model

- This is the lightweight latest-content counterpart to `.claude/commands/curate.md`: live discovery between full cycles, not a replacement for full curation.
- Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"` before internal API calls.
- Use `${MEDIA_AGENT_ROOT}` when set. Otherwise work from the current project root.
- Read `data/curation-prompt.md`, `data/preferences-context.md`, and `data/preference-insights.md` when present. Use `$ARGUMENTS` as an editorial filter, not a hard source filter.
- When this runs from a curator chat session, also follow `.claude/commands/curate-chat.md` for request-level chat submission rules.
- Reuse the anti-slop gate and feed-submit contract from `.claude/commands/curate.md` and `data/curation-prompt.md`. Do not invent a parallel policy here.

## 1. Compute the cutoff

Use the EARLIER of these two times as the cutoff:

- last curation time: `MAX(created_at_ms)` from `feed` where `metadata.cycleId` starts with `curate-` (covers both `curate-*` and `curate-latest-*`).
- last twitter cache refresh time: `MAX(fetched_at_ms)` from `browse_cache_items` where `source = 'twitter'`.

Why the earlier one: if the twitter cache is older than the last curation, the prior curation didn't see the gap between those two times. Using the earlier timestamp as the cutoff means /curate-latest never skips over tweets that were published before the most recent cache pull and after the one before it.

If either query returns nothing, use `now - 30 minutes`.

Record the chosen cutoff on every shipped item as cycle metadata: include both a machine value and a readable ISO timestamp.

## 2. Gather only live since-cutoff candidates

- This command MUST be direct browse, not cache-first. The `/api/internal/browse-cache/items` endpoint is off-limits here — it will silently return stale data. Reason: `browse_cache_items` only contains what the scraper had at its last refresh; tweets published AFTER that refresh won't appear until the next scraper pull. `/curate-latest` is specifically the path for the window between cache refreshes, so querying the cache defeats the whole purpose.
- Live-browse `https://x.com/home` in the shared authenticated browser session with the `Following` tab selected and `Most Recent` active.
- Follow `.claude/skills/tweet-cache/SKILL.md` plus `data/tweet-cache-policy.json` for X DOM/auth guidance.
- Keep only tweets where the tweet `datetime` / `publishedAtMs` is greater than `lastCycleMs`, excluding already-shipped `sourceId`s.
- To scroll deeper, use browser JavaScript evaluation with `window.scrollBy(0, window.innerHeight * 3)`. Never use keyboard scrolling shortcuts.
- Run 1-3 targeted web searches for news newer than `lastCycleMs`. Prioritize:
  - `## Current Focus` lanes from `data/curation-prompt.md`
  - topics that were active in the last 2-3 `curate-*` or `curate-latest-*` cycles from recent feed rows
- Do not browse or ship YouTube or Substack in `/curate-latest`.

## 2.5. Dig deeper before shipping zero

If the default Following-Most-Recent pass plus web searches leaves you with nothing substantive — either because the gather came up empty or because the filter ate most of what you found — dig deeper before returning zero. You're smart enough to figure out where to look next.

## 3. Filter hard

- Apply the quality and anti-slop rules from `data/curation-prompt.md`.
- Drop promotional material, novelty bait, satisfying-video/manufacturing-spectacle content, and reply chains whose context is not clear enough to stand on their own.
- Drop items where the interesting bit was already captured by the most recent full `/curate` cycle.
- Do not pad. Zero substantive tweets or zero web stories is a valid outcome.

## 4. Ship one thread, one batch

- Every surviving item goes under one thread:
  - `metadata.thread.threadId: "latest-since-<cutoff-compact-ts>"`
  - `metadata.thread.threadTitle: "Latest — since last curation"`
  - `metadata.thread.threadRationale`: one short sentence saying what the thread is for a reader, with no cutoff, source-check list, or `since ...` wording
- Every surviving item must carry:
  - `metadata.cycleId: "curate-latest-<compact-ts>"`
  - `metadata.cutoff: { lastCycleMs, lastCycleIso }`
- When this runs from a curator chat session, include:
  - request-level `originSessionId`
  - item-level `metadata.originSessionId`
  - item-level `metadata.originKind: "curator_chat"`
- Submit all accepted items in one POST to `${API_BASE}/api/internal/curate/submit`.

## 5. Reply contract

- Persist exactly one concise chat reply.
- Keep the reply to 1-2 sentences total.
- Give a plain-English overview of what shipped, plus an optional freshness note when it materially affected the pass.
- Include a brief simplicity-gate note. Pick whichever shape fits: (a) a problem passed the gate and an analysis shipped — name it in a few words; (b) a problem was considered but the gate failed — say which step failed in under ~15 words (e.g. "couldn't state it without jargon" / "couldn't propose a solution without consulting-speak"); (c) nothing in the pool raised a clear problem worth analysis this cycle — say so plainly. Do not fabricate a gate attempt to satisfy the rule.
- Do not report the cutoff timestamp in the chat reply and do not list each shipped item line by line.
- If nothing survives, say so plainly: no substantive tweets/articles since the cutoff is a valid result.
