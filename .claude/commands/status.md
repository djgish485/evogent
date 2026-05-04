Check the status of running agents and recent tasks.

Steps:
1. Resolve the repo root first: `REPO_ROOT=$(git rev-parse --show-toplevel)`
2. Read `$REPO_ROOT/scripts/agents/active-tasks.json` and display code tasks
3. Read `$REPO_ROOT/scripts/agents/research-tasks.json` and display research tasks
4. Run `tmux list-sessions 2>/dev/null` to show active tmux sessions
5. Summarize: how many running, done, failed, needs-attention
