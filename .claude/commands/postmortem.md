Schedule a post-operation report that writes automatically when all running agents finish.
Call this EARLY — before development completes — and it will watch agents in the background,
then write the full report once everything is done. If the session stalls, the report file
will still be written as long as the monitors complete.

Usage: /postmortem [filename]

Examples:
  /postmortem                           # Auto-generates docs/postmortem-YYYY-MM-DD.md
  /postmortem docs/v2-test-report.md    # Specific output path

Steps:

1. Determine the output file path IMMEDIATELY and tell the user:
   - If `$ARGUMENTS` provides a path, use it
   - Otherwise: `docs/postmortem-YYYY-MM-DD.md` (create docs/ dir if needed)
   - **Say the path right away**: "Post-report will be written to: `<path>`. If this session disconnects, check that file."

2. Take a snapshot of the CURRENT state (what's been done so far):
   - Resolve the repo root first: `REPO_ROOT=$(git rev-parse --show-toplevel)`
   - Read `$REPO_ROOT/scripts/agents/active-tasks.json` — note all tasks with today's date or recent tasks
   - Run `git log --oneline -20` to capture recent commits
   - Note any plans, merge conflicts, test results already completed
   - Note any context from the current conversation (features built, decisions made)
   - Store all of this in memory — you'll need it for the report later

3. Check for running agents:
   - Parse `$REPO_ROOT/scripts/agents/active-tasks.json` for `"status": "running"` entries
   - If agents ARE running: launch background monitors (like /watch) for each one, then CONTINUE the conversation normally. You will be notified when each monitor completes.
   - If NO agents are running: skip to step 5 (write report immediately)

4. As agents finish (background monitors notify you):
   - Record each agent's final status, output, merge result
   - Check if ALL monitored agents are now done
   - If all done → proceed to step 5
   - If some still running → wait for remaining notifications
   - **IMPORTANT**: Even if the user sends other messages or starts new work, remember that you owe a postmortem. When all agents finish, write the report.

5. When all agents are complete, write the report file:

   ```markdown
   # Post-Operation Report
   **Date:** YYYY-MM-DD HH:MM UTC
   **Project:** <project name from package.json or directory>
   **Session summary:** <1-2 sentence overview of what this session accomplished>

   ## What Was Done
   - Bullet list of completed work items
   - Include commit hashes where applicable
   - Note any plans that were created/executed

   ## Agents Spawned
   | Task ID | Agent | Status | Tests | Lines Changed | Commit |
   |---------|-------|--------|-------|---------------|--------|
   (table of all agents from this session with results)

   ## Merge Results
   - Which agents merged cleanly
   - Which had conflicts and how they were resolved
   - Final state of main branch

   ## Issues Encountered
   - Merge conflicts, test failures, build errors
   - How each was resolved
   - Any workarounds applied

   ## Test Results
   - Unit tests: X passed, Y failed
   - E2E tests: X passed, Y failed
   - Include actual output snippets if available

   ## Current State
   - Server: running/stopped
   - Build: green/broken
   - Uncommitted changes: yes/no
   - Running agents: none / list

   ## What's Next
   - Remaining work from any plan
   - Follow-up items discovered during the session
   - Known issues to address

   ## Commits (this session)
   | Hash | Message |
   |------|---------|
   (all commits from this session, newest first)
   ```

6. After writing, confirm:
   - "Post-report written to `<path>`"
   - One-line summary

7. Run a final verification if appropriate:
   - `npm run build` — is it green?
   - `npm run test` — all passing?
   - Server status check
   - Include results in the report

Tips:
- The KEY behavior is: schedule early, write late. The user calls /postmortem at the START of a batch of work, and the report appears when everything finishes.
- Use background Bash monitors (run_in_background: true) to watch agents — same pattern as /watch
- Even if you're doing other work while agents run, ALWAYS remember to write the report when notified
- Be specific — commit hashes, test counts, line counts, file paths
- The report should be self-contained — someone reading it tomorrow morning should understand everything
- If the session is about to hit context limits, prioritize writing the report before compaction
