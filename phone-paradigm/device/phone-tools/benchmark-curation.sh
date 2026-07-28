#!/data/data/com.termux/files/usr/bin/bash
# benchmark-curation.sh <modelA[@effort]> <modelB[@effort]> — A/B two Codex routes on the SAME browse cache and
# compare their output shape and elapsed time on-device.
#
# Method: snapshot the feed, run a full /curate with modelA, measure, RESTORE the feed snapshot,
# run /curate with modelB, measure, restore again. Same cache both times = a fair comparison.
# Measures per model: items shipped, real multi-member threads, truthful singleton shipments,
# average items per thread, and wall-clock. Counts are diagnostic, not quality targets: inspect
# the resulting judgments and reasons before preferring a model. This diagnostic
# never qualifies a cheaper route by itself: counts and latency are not editorial quality.
set -euo pipefail
A="${1:?usage: benchmark-curation.sh <modelA[@effort]> <modelB[@effort]>}"
B="${2:?usage: benchmark-curation.sh <modelA[@effort]> <modelB[@effort]>}"
EVO="$HOME/evogent"; TOOLS="$HOME/phone-tools"; BASE="http://127.0.0.1:3001"
DB="$EVO/data/media-agent.db"
say(){ echo "[benchmark] $*" >&2; }
SNAPSHOT_READY=0

node_q(){ ( cd "$EVO" && node -e "$1" ) 2>/dev/null; }

sqlite_backup(){ python3 - "$1" "$2" <<'PY'
import sqlite3, sys
source, destination = sys.argv[1:]
src = sqlite3.connect(source)
dst = sqlite3.connect(destination)
src.backup(dst)
dst.close()
src.close()
check = sqlite3.connect(destination)
assert check.execute("PRAGMA quick_check").fetchone()[0] == "ok"
check.close()
PY
}
snapshot(){ rm -f "$HOME/.bench-feed-snapshot.db"; sqlite_backup "$DB" "$HOME/.bench-feed-snapshot.db"; }
restore(){
  tmux kill-session -t evo 2>/dev/null || true
  for _ in $(seq 1 20); do
    tmux has-session -t evo 2>/dev/null || break
    sleep 1
  done
  tmux has-session -t evo 2>/dev/null && {
    say "scoped evo session would not stop; refusing unsafe database restore"
    return 70
  }
  rm -f "$DB-wal" "$DB-shm"
  sqlite_backup "$HOME/.bench-feed-snapshot.db" "$DB"
  bash "$HOME/restart-evo.sh"
}
cleanup(){
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "$SNAPSHOT_READY" = 1 ] && [ -f "$HOME/.bench-feed-snapshot.db" ]; then
    say "restoring original feed after benchmark exit"
    restore || say "CRITICAL: benchmark snapshot restore failed"
    rm -f "$HOME/.bench-feed-snapshot.db"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Run one full curation with a given model, on the current (snapshot) cache. Returns metrics.
measure(){
  local route="$1" model effort t0 t1
  model="${route%@*}"
  effort="${route##*@}"
  [ "$model" = "$effort" ] && effort=""
  # Reset cache seen-flags so both models see the identical unshipped pool.
  node_q "const db=require('./node_modules/better-sqlite3')('data/media-agent.db');db.prepare('UPDATE browse_cache_items SET seen_by_curation_at_ms=NULL').run();"
  local before; before=$(node_q "const db=require('./node_modules/better-sqlite3')('data/media-agent.db');console.log(db.prepare(\"SELECT COUNT(*) n FROM feed WHERE type IN ('tweet','article','analysis')\").get().n);")
  t0=$(date +%s)
  # The cycle now carries this model into the exact curator task metadata. Disable
  # source browsing so both restored snapshots expose the same candidate cache.
  EVOGENT_CODEX_MODEL="$model" EVOGENT_CURATOR_REASONING="$effort" \
    EVOGENT_BACKGROUND_SOURCE_BROWSING=Off \
    bash "$TOOLS/evogent-cycle.sh" >>"$TOOLS/scheduler.log" 2>&1
  t1=$(date +%s)
  node_q "
const db=require('./node_modules/better-sqlite3')('data/media-agent.db');
const shipped=db.prepare(\"SELECT id,thread_id,metadata FROM feed WHERE type IN ('tweet','article','analysis') AND display_order IS NOT NULL\").all();
const threads={}; let oneoffs=0;
for(const r of shipped){let tid=r.thread_id;if(!tid){try{tid=(JSON.parse(r.metadata||'{}').thread||{}).threadId||null}catch(e){}}if(tid){threads[tid]=(threads[tid]||0)+1}else{oneoffs++}}
const tk=Object.keys(threads);
const multi=tk.filter(k=>threads[k]>=2).length;
console.log(JSON.stringify({shipped:shipped.length,threads:tk.length,multiMemberThreads:multi,oneoffs,avgPerThread:tk.length?(shipped.length/tk.length).toFixed(1):0,elapsedS:$t1-$t0,before:${before}}));
"
}

say "snapshotting feed..."; snapshot; SNAPSHOT_READY=1
say "=== model A: $A ==="; RESA=$(measure "$A"); echo "A ($A): $RESA"
say "restoring feed for fair B run..."; restore
say "=== model B: $B ==="; RESB=$(measure "$B"); echo "B ($B): $RESB"
say "restoring original feed..."; restore
rm -f "$HOME/.bench-feed-snapshot.db"
SNAPSHOT_READY=0
echo ""
echo "=== BENCHMARK RESULT ==="
echo "A $A -> $RESA"
echo "B $B -> $RESB"
echo "Judge on: item quality and reasons first; use shipped/thread/singleton counts and elapsedS only as diagnostic context."
