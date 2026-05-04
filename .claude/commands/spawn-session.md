Spawn a new Claude Code remote-control session in a tmux window with full permissions.

Usage: /spawn-session <name> [directory]
- name: short name for the session (e.g., "frontend", "research", "backend")
- directory: optional working directory (default: current repo root when available, otherwise current directory)

Examples:
  /spawn-session frontend $(git rev-parse --show-toplevel)
  /spawn-session research
  /spawn-session backend $(git rev-parse --show-toplevel)

Steps:
1. Parse session name and optional directory from: $ARGUMENTS
   - First word is the name, rest is the directory path
   - Default directory: `$(git rev-parse --show-toplevel 2>/dev/null || pwd)`
2. Check if a tmux session with that name already exists:
   - Run: tmux has-session -t <name> 2>/dev/null
   - If it exists, tell the user and ask if they want to kill it and restart
3. Create the working directory if it doesn't exist:
   - Run: mkdir -p <directory>
4. Start the new Claude Code session in tmux:
   ```bash
   tmux new-session -d -s <name> -c <directory> "export PATH=/root/.local/bin:$PATH && claude --model claude-opus-4-7[1m] --effort high --allowedTools 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,LSP,NotebookEdit,Task' --permission-mode dontAsk"
   ```
5. Wait 10 seconds for Claude Code to start, then accept workspace trust:
   ```bash
   sleep 10
   tmux send-keys -t <name> Enter
   ```
6. Wait 8 seconds, then enable remote control:
   ```bash
   sleep 8
   tmux send-keys -t <name> '/rc' Enter
   sleep 3
   tmux send-keys -t <name> Enter
   sleep 3
   tmux send-keys -t <name> Enter
   ```
7. Wait 15 seconds for the bridge to connect, then extract the session URL:
   ```bash
   sleep 15
   tmux capture-pane -t <name> -p -S -15
   ```
8. Look for the URL containing "claude.ai/code/session_" in the captured output
9. If no URL found (bridge registration failed), retry:
   ```bash
   tmux send-keys -t <name> '/rc' Enter
   sleep 3
   tmux send-keys -t <name> Enter
   sleep 3
   tmux send-keys -t <name> Enter
   sleep 15
   tmux capture-pane -t <name> -p -S -15
   ```
10. Present the session URL to the user so they can open it in the Claude app
11. Also show: `tmux list-sessions` to confirm it's running
