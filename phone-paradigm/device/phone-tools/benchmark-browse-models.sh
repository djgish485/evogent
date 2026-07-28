#!/data/data/com.termux/files/usr/bin/bash
# benchmark-browse-models.sh — A/B the codex models on COMPUTER-USE source browsing (the
# hidden-display app driving), not just curation text. For each model, run the same YouTube
# browse prompt (a computer-use task: launch app, navigate, identify videos, share to Evogent)
# and measure: wall-clock, whether it actually cached items, and how complete those items are.
# Deterministic scrapers (hn/x-scrape) don't use a brain, so YouTube is the fair computer-use test.
#
# Usage: benchmark-browse-models.sh [model@effort ...]
#        the first route is the baseline; defaults compare the active route with lower-cost
#        candidates. Set EVOGENT_BENCH_ROUNDS=3 before using a suite to change routing.
set -u
EVO="$HOME/evogent"; TOOLS="$HOME/phone-tools"; BASE="http://127.0.0.1:${PORT:-3001}"
EVO_CURL="$TOOLS/evo-curl"
export EVOGENT_API_CURL="$EVO_CURL"
ROUTER="$TOOLS/model_routing.py"
LEDGER="$TOOLS/model-benchmark-results.jsonl"
ROUTES=("$@")
ROUNDS="${EVOGENT_BENCH_ROUNDS:-1}"
[[ "$ROUNDS" =~ ^[1-5]$ ]] || { echo "EVOGENT_BENCH_ROUNDS must be 1..5" >&2; exit 64; }
SUITE="browse-$(date +%s)-$$"
PROMPT_FILE="$TOOLS/browse-youtube.txt"
RESULTS="$TOOLS/browse-benchmark-results.txt"
: > "$RESULTS"; chmod 600 "$RESULTS"
say(){ echo "[browse-bench] $*" | tee -a "$RESULTS" >&2; }
. "$TOOLS/control-plane.sh"
control_init_owner browse-benchmark
BENCH_LOCK="$TOOLS/.cycle.lock"
BENCH_LOCK_HELD=0
bench_cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  control_kill_tagged "$CONTROL_OWNER_ID"
  [ "$BENCH_LOCK_HELD" = 1 ] && control_cleanup_tracked_packages || true
  [ "$BENCH_LOCK_HELD" = 1 ] && control_close_hidden_displays || true
  control_wake_release
  [ "$BENCH_LOCK_HELD" = 1 ] && control_lock_release "$BENCH_LOCK" || true
  control_finish_owner
  exit "$rc"
}
trap bench_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
control_lock_acquire "$BENCH_LOCK" browse-benchmark ||
  { say "another live task owns the hidden display"; exit 1; }
BENCH_LOCK_HELD=1
if control_release_transaction_pending \
    "${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"; then
  say "durable release transaction is pending; benchmark deferred"
  exit 75
fi
control_wake_acquire
if [ "${#ROUTES[@]}" -eq 0 ]; then
  CURRENT=$(python3 "$ROUTER" resolve --task browse \
    --config "$EVO/data/config.md" \
    --policy "$TOOLS/model-routing.default.json" \
    --live "$EVO/data/model-routing.json" \
    --receipts "$LEDGER" 2>/dev/null || printf '%s\n' $'gpt-5.6-sol\tmedium\tfallback')
  IFS=$'\t' read -r CURRENT_MODEL CURRENT_EFFORT _ <<< "$CURRENT"
  ROUTES=("$CURRENT_MODEL@$CURRENT_EFFORT" "gpt-5.6-terra@low" "gpt-5.6-luna@low")
fi

# Flow metrics must read the store, never a capped endpoint that can saturate.
src_count(){ ( cd "$EVO" && node -e '
  const db=require("better-sqlite3")("data/media-agent.db");
  console.log(db.prepare("SELECT COUNT(*) AS n FROM browse_cache_items WHERE source=?").get("youtube").n);
' 2>/dev/null || echo 0 ); }

# Completeness of the freshest N youtube rows: fraction carrying a canonical watch URL + title.
completeness(){ ( cd "$EVO" && node -e '
  const db=require("better-sqlite3")("data/media-agent.db");
  const since=Number(process.argv[1]||0);
  const rows=db.prepare("SELECT url,title,payload_json FROM browse_cache_items WHERE source=? AND fetched_at_ms>=? ORDER BY fetched_at_ms DESC LIMIT 10").all("youtube", since);
  let n=rows.length, url=0, title=0;
  for(const r of rows){ let p={}; try{p=JSON.parse(r.payload_json||"{}")}catch(e){}
    if(/watch\?v=|youtu\.be\//.test(r.url||p.url||p.canonicalUrl||"")) url++;
    if((r.title||p.title||"").length>5) title++; }
  console.log(JSON.stringify({fresh:n, withCanonicalUrl:url, withTitle:title}));
' "$1" 2>/dev/null || echo "{}" ); }

for ROUND in $(seq 1 "$ROUNDS"); do
  MODEL_INDEX=0
  for SPEC in "${ROUTES[@]}"; do
    MODEL_INDEX=$((MODEL_INDEX + 1))
    MODEL="${SPEC%@*}"; EFFORT="${SPEC##*@}"; [ "$MODEL" = "$EFFORT" ] && EFFORT=medium
    ROLE=candidate; [ "$MODEL_INDEX" -eq 1 ] && ROLE=baseline
    say "=== $MODEL@$EFFORT round=$ROUND ==="
    before=$(src_count)
    T0_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
    if ! control_safe_force_stop_package com.google.android.youtube; then
      RC=70
      MECHANICS=failed
      QUALITY=not_scored
    else
      sleep 2
      ( cd "$EVO" && run_owned_timeout 420 30 codex exec --model "$MODEL" \
          -c model_reasoning_effort="$EFFORT" --dangerously-bypass-approvals-and-sandbox \
          "$(cat "$PROMPT_FILE")" >>"$TOOLS/scheduler.log" 2>&1 )
      RC=$?
      if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ] || [ "$RC" -eq 143 ]; then
        MECHANICS=timeout
        QUALITY=not_scored
      elif [ "$RC" -ne 0 ]; then
        MECHANICS=runner_failed
        QUALITY=not_scored
      else
        MECHANICS=passed
        QUALITY=pending
      fi
    fi
    T1_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
    after=$(src_count)
    gained=$(( after - before )); [ "$gained" -lt 0 ] && gained=0
    comp=$(completeness "$T0_MS")
    if [ "$MECHANICS" = passed ]; then
      QUALITY=$(printf '%s' "$comp" | python3 -c '
import json,sys
try: d=json.load(sys.stdin); n=int(d.get("fresh") or 0)
except Exception: n=0; d={}
print("passed" if n>0 and int(d.get("withCanonicalUrl") or 0)==n and int(d.get("withTitle") or 0)==n else "failed")
' 2>/dev/null || echo failed)
    fi
    ELAPSED_MS=$((T1_MS - T0_MS))
    METRICS=$(python3 - "$comp" "$ELAPSED_MS" "$gained" <<'PY' 2>/dev/null
import json,sys
try: value=json.loads(sys.argv[1])
except Exception: value={}
value.update({"elapsedMs":int(sys.argv[2]),"itemsAdded":int(sys.argv[3])})
print(json.dumps(value,separators=(",",":")))
PY
)
    RECEIPT=$(python3 - "$SUITE" "$ROUND" "$ROLE" "$MODEL" "$EFFORT" \
      "$MECHANICS" "$QUALITY" "$METRICS" <<'PY'
import json,sys
print(json.dumps({
  "suiteId":sys.argv[1],"round":int(sys.argv[2]),"task":"browse","role":sys.argv[3],
  "model":sys.argv[4],"effort":sys.argv[5],"mechanicsStatus":sys.argv[6],
  "qualityStatus":sys.argv[7],"metrics":json.loads(sys.argv[8]),
},separators=(",",":")))
PY
)
    python3 "$ROUTER" record --ledger "$LEDGER" --receipt-json "$RECEIPT" \
      || say "$MODEL round=$ROUND: receipt write failed"
    say "$MODEL@$EFFORT round=$ROUND: $((ELAPSED_MS/1000))s mechanics=$MECHANICS quality=$QUALITY items=$gained completeness=$comp"
  done
done

say "=== SUMMARY ==="
grep -E "mechanics=.*quality=" "$RESULTS" || true
say "Routing needs paired quality passes. Timeouts and driver failures are mechanics evidence, never model-quality scores."
