#!/data/data/com.termux/files/usr/bin/bash
# Restart the on-device Evogent production server in a detached tmux session.
# Kill by exact process name (comm), NOT pgrep -f, to avoid self-matching this script's text.
pkill -9 -x node 2>/dev/null
tmux kill-server 2>/dev/null
sleep 2
: > "$HOME/evogent-server.log"
tmux new-session -d -s evo "bash $HOME/start-prod.sh > $HOME/evogent-server.log 2>&1"
sleep 1
echo "launched; tmux=[$(tmux ls 2>&1)]"
