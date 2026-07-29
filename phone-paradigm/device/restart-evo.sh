#!/data/data/com.termux/files/usr/bin/bash
# Restart only Evogent's production-server tmux session. The scheduler, active
# cycle, watchdog, and unrelated Node/agent processes are deliberately untouched.
set -euo pipefail
LOG="$HOME/evogent-server.log"
TOOLS="$HOME/phone-tools"

tmux kill-session -t '=evo' 2>/dev/null || true
for _ in $(seq 1 20); do
  tmux has-session -t '=evo' 2>/dev/null || break
  sleep 1
done
tmux has-session -t '=evo' 2>/dev/null && {
  echo "restart-evo: scoped evo session would not stop" >&2
  exit 70
}

if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 10485760 ]; then
  mv "$LOG" "$LOG.previous"
fi
tmux new-session -d -s evo \
  "exec bash '$HOME/start-prod.sh' >> '$LOG' 2>&1"

for _ in $(seq 1 60); do
  if "$TOOLS/evo-health"; then
    echo "restart-evo: server ready"
    exit 0
  fi
  sleep 2
done
echo "restart-evo: server did not become ready" >&2
exit 70
