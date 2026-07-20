#!/data/data/com.termux/files/usr/bin/bash
# Atomic .next swap + server restart; run detached so USB drops cannot half-apply it.
# SINGLE-INSTANCE: two overlapping deploys race on the .next rename and can leave .next without
# a BUILD_ID (happened twice 2026-07-18). flock serializes deploys.
#
# LOCK HYGIENE (2026-07-20 incident): fd 9 is INHERITED by every child. A trailing
# restart-evo.sh call did `tmux kill-server` + respawn, so the NEW tmux server (and node under
# it) inherited fd 9 and held the flock for as long as the server lived — every later deploy
# blocked forever behind a lock owned by the running production server. Rules that keep this
# dead: (1) never spawn a daemon without `9>&-`; (2) bounded `flock -w`, never infinite;
# (3) NOTHING runs after "deploy done" — especially not restart-evo (it kills the scheduler).
exec >> ~/deploy.log 2>&1
exec 9> ~/.deploy-next.lock
if ! flock -n 9; then
  echo "=== deploy $(date): another deploy holds the lock — waiting up to 300s ==="
  if ! flock -w 300 9; then
    echo "=== deploy $(date): LOCK STUCK >300s — likely an fd-9 leak into a daemon; aborting loudly ==="
    exit 1
  fi
fi
echo "=== deploy $(date) ==="
cd ~/evogent || exit 1
rm -rf .next.new && mkdir .next.new
tar xzf ~/next-deploy2.tar.gz -C .next.new --strip-components=1 2>/dev/null
[ -f .next.new/BUILD_ID ] || { echo "extract FAILED — leaving current .next untouched"; rm -rf .next.new; exit 1; }
if [ -f .next/BUILD_ID ] && [ "$(cat .next/BUILD_ID)" = "$(cat .next.new/BUILD_ID)" ]; then
  echo "already at BUILD_ID $(cat .next/BUILD_ID) — skipping swap"; rm -rf .next.new; exit 0
fi
rm -rf .next.old && mv .next .next.old && mv .next.new .next
if [ ! -f .next/BUILD_ID ]; then
  echo "SWAP PRODUCED NO BUILD_ID — rolling back to .next.old"
  rm -rf .next.broken; mv .next .next.broken 2>/dev/null; cp -a .next.old .next
fi
echo "swapped to BUILD_ID $(cat .next/BUILD_ID 2>/dev/null)"
tmux kill-session -t evo 2>/dev/null
pkill -f "[n]ode server.js" 2>/dev/null
sleep 2
# 9>&- : the spawned tmux/node tree must NOT inherit the deploy lock (see header).
tmux new-session -d -s evo "cd ~/evogent && NODE_ENV=production PORT=3001 node server.js >> ~/evo-boot.log 2>&1" 9>&-
for i in $(seq 1 30); do
  sleep 4
  code=$(curl -s -m5 http://127.0.0.1:3001/api/feed?limit=1 -o /dev/null -w "%{http_code}")
  [ "$code" = "200" ] && { echo "server UP after $((i*4))s"; break; }
done
curl -s -m30 -X POST http://127.0.0.1:3001/api/internal/feed/rearrange -H "content-type: application/json" -d "{}" -o /dev/null -w "rearrange HTTP %{http_code}\n"
echo "=== deploy done ==="
