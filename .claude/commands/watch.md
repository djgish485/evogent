Monitor running dev agents until they all complete, checking every 60 seconds.
Keeps you informed so you can walk away from the session without worrying about stalls.

Usage: /watch [timeout_minutes]

Examples:
  /watch                    # Watch all running agents, default 30 min timeout
  /watch 60                 # Watch with 60 min timeout

Steps:

1. Parse timeout from `$ARGUMENTS` (default: 30 minutes if not specified).

2. Resolve the repo root first: `REPO_ROOT=$(git rev-parse --show-toplevel)`

3. Read `$REPO_ROOT/scripts/agents/active-tasks.json` and find all tasks with `"status": "running"`. Display them:
   - Task ID, agent type, tmux session name
   - If none are running, say so and stop.

4. For EACH running task, start a background Bash monitor:
   ```bash
   REPO_ROOT=$(git rev-parse --show-toplevel)
   TASKS_FILE="$REPO_ROOT/scripts/agents/active-tasks.json"
   TASK_ID="<id>"
   TIMEOUT=<timeout_minutes>
   END=$(($(date +%s) + TIMEOUT * 60))
   while [ $(date +%s) -lt $END ]; do
     STATUS=$(jq -r --arg id "$TASK_ID" '.[] | select(.id == $id) | .status' "$TASKS_FILE" 2>/dev/null)
     if [ "$STATUS" != "running" ]; then
       echo "=== $TASK_ID finished with status: $STATUS at $(date) ==="
       # Show last lines of output log if available
       LOG_DIR="$REPO_ROOT/scripts/agents/logs/agent/$TASK_ID"
       [ -f "$LOG_DIR/agent.log" ] && echo "--- Last 20 lines ---" && tail -20 "$LOG_DIR/agent.log"
       break
     fi
     sleep 60
   done
   if [ $(date +%s) -ge $END ]; then
     echo "=== $TASK_ID: TIMEOUT after ${TIMEOUT}m — still running ==="
   fi
   ```

5. After launching all monitors, tell the user:
   - "Watching N agents. I'll notify you as each one completes."
   - "Timeout: X minutes per agent."
   - "You can walk away — I'll report results when they finish."

6. As each background monitor completes (you'll be notified), report:
   - Task ID, final status (done/failed/needs-attention)
   - Key output lines (test results, commit hash, merge status)
   - Whether the pipeline (merge/validate) succeeded

7. When ALL monitors have reported back, give a final summary:
   - Total agents watched
   - How many succeeded vs failed
   - Any that need attention
   - Suggest next steps (e.g., "All passed — ready to move on" or "2 failed — check logs")

8. If the user had a plan with remaining work (like spawning more agents after these finish), proactively ask if they'd like to proceed with the next wave.

Tips:
- Use `run_in_background: true` for the Bash monitors so they don't block the conversation
- Read the task output file at `/tmp/claude-0/-root-<project>/tasks/<monitor_id>.output` when notified
- If a task transitions to "needs-attention", flag it prominently
- The check-agents.sh cron (every 10 min) handles respawns and pipeline — your job is just to WATCH and REPORT
