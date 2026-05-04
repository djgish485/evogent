---
name: review-landed-merge
description: Review a landed code-fix merge for request fit, boundary fit, revert risk, and hard constraint violations.
user-invocable: false
metadata:
  evogent:
    heartbeat-task: false
---
# Review Landed Merge

Use this when a chat session receives an automatic post-merge review turn for a landed `code_fix`.

## Goal

Audit the landed merge quickly and speak up only for high-signal problems:

- The landed diff does not fit what the originating suggestion asked for.
- The landed diff visibly conflicts with Evogent's development philosophy or boundary review instructions.
- The merge appears to revert or undo a recent landed `fix:` or `feat:` commit.
- The landed diff visibly violates a hard constraint from the suggestion's `proposedValue`.

Default to a short clean result. Do not create noise.

## Inputs

The queued user turn should include:

- merge SHA
- suggestion ID when available
- touched files summary
- a pointer to this skill file

## Time Box

- Finish within 2 minutes.
- If `git show --stat <merge-sha>` or `git diff --shortstat <merge-sha>^1 <merge-sha>` shows a very large change (roughly over 600 changed lines), skip the deep audit and post: `Manual review recommended — too large to auto-audit.`

## Steps

1. Load the receipt row.
   - Run:
     ```bash
     jq -c 'select(.mergeCommit == "<merge-sha>")' data/agent-receipts.jsonl | tail -n 1
     ```
   - Capture `filesTouched`, `suggestionId`, `agentModel`, `validationResult`, and `diffSummary`.

2. Inspect the landed diff.
   - Always run:
     ```bash
     git show --stat <merge-sha>
     ```
   - If the change is modest, also run:
     ```bash
     git show <merge-sha>
     ```

3. Read the originating suggestion.
   - If `suggestionId` is present, fetch:
     ```bash
     curl -fsS "$MEDIA_AGENT_INTERNAL_BASE_URL/api/feed/<suggestion-id>"
     ```
   - Read the suggestion `title` and `proposedValue`.
   - If the fetch fails, continue with the receipt and diff only.

4. Audit recent related commits.
   - For each touched file, run:
     ```bash
     git log --format="%H %s" --since="30 days ago" -- <file>
     ```
   - For recent commits whose subjects suggest landed work on the same files, inspect:
     ```bash
     git show --stat <commit-sha>
     ```

5. Run a bounded validation data hygiene pass when warranted.
   - Do this after the diff/regression audit and before the final reply if validation was skipped, validation touched app APIs or SQLite, or the receipt/diff/test names mention fixtures, suggestions, notifications, chat sessions, cleanup, or validation data.
   - Look for leaked production test data using exact evidence from the current merge/task/suggestion context: `suggestionId`, task IDs, merge SHA, recent validation timestamps, fixture IDs from tests, `sourceId`/`source_id` values, origin session IDs, and known validation markers such as `api-like-test-*`, `api-test-*`, `probe-*`, `ws-probe-*`, `code-fix-ws-probe-*`, notification fixture IDs, and WebSocket/API fixture source IDs.
   - Inspect the live app/API or SQLite with exact predicates, for example:
     ```sql
     SELECT id, source_id, type, created_at, origin_session_id
     FROM feed
     WHERE id IN ('<exact-feed-id>')
        OR source_id IN ('<exact-source-id>')
        OR origin_session_id IN ('<exact-origin-session-id>');
     ```
   - Prefer the supported cleanup endpoint when exact identifiers are available:
     ```bash
     curl -fsS "$MEDIA_AGENT_INTERNAL_BASE_URL/api/internal/validation/cleanup" \
       -H 'Content-Type: application/json' \
       -d '{"ids":["<exact-feed-id>"],"sourceIds":["<exact-source-id>"],"originSessionIds":["<exact-origin-session-id>"]}'
     ```
   - Direct SQLite cleanup is acceptable only for bounded data maintenance when no supported API can remove the exact rows. Include direct dependents such as `interactions` and `code_fix_tasks` rows for the same exact feed IDs or suggestion IDs.
   - Verify cleanup by re-querying the exact IDs/source IDs/session IDs and confirming zero remaining rows before replying.
   - If the match is ambiguous, do not delete. Leave the row in place and report the ambiguity as a concrete concern or follow-up.

## High-Signal Checks

Check only these first-pass cases:

1. Fit to the request.
   - Read the suggestion title and `proposedValue` literally.
   - State whether the landed diff appears to do what was asked.

2. Fit to the development philosophy and boundary review.
   - Check whether the landed diff keeps logic in the right layer.
   - Flag only visible mismatches, such as product code doing agent judgment that belongs in a skill/instruction.

3. Unintended revert of recent landed work.
   - Flag it when the current merge removes or undoes code that a recent `fix:` or `feat:` commit added on the same files.
   - Include the earlier SHA and subject if you have them.

4. Hard constraint violation from `proposedValue`.
   - Read the suggestion text literally.
   - If it says something concrete such as:
     - `net line count should go DOWN`
     - `do NOT add a backward-compat shim`
     - `no new endpoint`
   - Compare that constraint to the landed diff and call it out only when the mismatch is visible from the diff.

5. Validation data hygiene.
   - This is a short hygiene pass, not a forensic audit.
   - Delete only high-confidence leaked validation fixtures tied to exact IDs, source IDs, origin session IDs, provenance, recent validation timestamps, or fixture markers from the current task.
   - Never delete by broad title alone.
   - Do not delete real user chat sessions, real suggestions, or real feed items just because their title contains words like `test`, `docs`, `general`, or `session`.
   - If cleanup removes rows, verify the exact lookup returns zero remaining rows.

## Do Not Escalate On

- Style disagreements
- Broader refactor preferences
- Speculation about intent that is not grounded in the suggestion or diff
- Weak similarity to older commits without a clear undo/revert signal

## Output

Post exactly one short chat reply in the same session.

If clean:

```text
✅ Review clean — <suggestion title or suggestion id>, +X/-Y across N files.
Request fit: <simple phrase>
Philosophy fit: <simple phrase>
Unintended revert risk: <none seen, or brief note>
Data cleanup: <none found, removed N leaked fixture rows, or ambiguous fixture evidence left in place>
```

If you found a concrete problem:

```text
Review concern
Request fit: <what the suggestion required vs. what landed>
Philosophy fit: <visible philosophy or boundary mismatch, or "no issue seen">
Unintended revert risk: <older sha and subject, or "none seen">
Data cleanup: <none found, removed N leaked fixture rows, or ambiguous fixture evidence left in place>
Recommendation: <specific follow-up, such as a revert suggestion or targeted fix>
```

If the diff is too large:

```text
Manual review recommended — too large to auto-audit.
```

## Guardrails

- Be conservative. `✅ Review clean` is the default.
- Do not auto-revert.
- Do not submit a new `code_fix` for clean reviews, style disagreements, speculative risks, or broad refactor ideas. If the review finds a concrete, bounded, high-confidence defect that violates the originating suggestion or a hard constraint, submit one follow-up `code_fix` suggestion and mention its ID in the same compact review reply.
- Keep the response compact.
- Keep validation cleanup exact and bounded; ambiguous data stays.
