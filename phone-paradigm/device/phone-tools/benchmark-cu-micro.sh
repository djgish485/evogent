#!/data/data/com.termux/files/usr/bin/bash
# benchmark-cu-micro.sh — a FAIR, bounded computer-use micro-task to compare models' speed and
# accuracy at the core hidden-display loop (launch -> navigate -> read), without the fragile
# multi-step share flow that timed everyone out. Task: open YouTube, go to Subscriptions, read
# and report exactly 5 real video titles as JSON. The harness re-reads the hidden-display tree
# and proves that all five titles are grounded there. Raw titles and model output live only in
# a mode-0600 temporary directory and never enter benchmark receipts.
set -u
EVO="$HOME/evogent"; TOOLS="$HOME/phone-tools"
export EVOGENT_API_CURL="$TOOLS/evo-curl"
OUT="$TOOLS/cu-micro-results.txt"; : > "$OUT"; chmod 600 "$OUT"
LEDGER="$TOOLS/model-benchmark-results.jsonl"
ROUTER="$TOOLS/model_routing.py"
ROUTES=("$@")
ROUNDS="${EVOGENT_BENCH_ROUNDS:-3}"
[[ "$ROUNDS" =~ ^[1-5]$ ]] || { echo "EVOGENT_BENCH_ROUNDS must be 1..5" >&2; exit 64; }
SUITE="cu-$(date +%s)-$$"
BENCH_TMP=""
say(){ echo "[cu-micro] $*" | tee -a "$OUT" >&2; }
. "$TOOLS/control-plane.sh"
control_init_owner cu-benchmark
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
  [ -n "$BENCH_TMP" ] && [ -d "$BENCH_TMP" ] && rm -rf -- "$BENCH_TMP"
  control_finish_owner
  exit "$rc"
}
trap bench_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
control_lock_acquire "$BENCH_LOCK" cu-benchmark ||
  { say "another live task owns the hidden display"; exit 1; }
BENCH_LOCK_HELD=1
if control_release_transaction_pending \
    "${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"; then
  say "durable release transaction is pending; benchmark deferred"
  exit 75
fi
control_wake_acquire
mkdir -p "${TMPDIR:-$HOME/.cache}"
BENCH_TMP=$(mktemp -d "${TMPDIR:-$HOME/.cache}/evogent-cu-bench.XXXXXX") || exit 70
chmod 700 "$BENCH_TMP"
if [ "${#ROUTES[@]}" -eq 0 ]; then
  CURRENT=$(python3 "$ROUTER" resolve --task browse \
    --config "$EVO/data/config.md" \
    --policy "$TOOLS/model-routing.default.json" \
    --live "$EVO/data/model-routing.json" \
    --receipts "$LEDGER" 2>/dev/null || printf '%s\n' $'gpt-5.6-sol\tmedium\tfallback')
  IFS=$'\t' read -r CURRENT_MODEL CURRENT_EFFORT _ <<< "$CURRENT"
  ROUTES=("$CURRENT_MODEL@$CURRENT_EFFORT" "gpt-5.6-terra@low" "gpt-5.6-luna@low")
fi

read -r -d '' TASK <<'EOF'
Bounded computer-use task on the hidden display. Do exactly this, no more:
1. ~/phone-tools/phone.sh launch com.google.android.youtube ; wait 5s.
2. ~/phone-tools/phone.sh tap "Subscriptions" ; wait 3s.
3. ~/phone-tools/phone.sh see  — read the accessibility tree.
4. From what you SEE, extract exactly 5 real video titles currently on screen (skip Shorts, ads,
   nav labels). Do NOT scroll, share, or open anything.
Reply with ONLY this JSON on the last line: {"titles":["...","...","...","...","..."]}
EOF

for ROUND in $(seq 1 "$ROUNDS"); do
  MODEL_INDEX=0
  for SPEC in "${ROUTES[@]}"; do
    MODEL_INDEX=$((MODEL_INDEX + 1))
    MODEL="${SPEC%@*}"
    EFFORT="${SPEC##*@}"
    [ "$MODEL" = "$EFFORT" ] && EFFORT=low
    ROLE=candidate; [ "$MODEL_INDEX" -eq 1 ] && ROLE=baseline
    RESPONSE="$BENCH_TMP/response-$ROUND-$MODEL_INDEX.txt"
    TREE="$BENCH_TMP/tree-$ROUND-$MODEL_INDEX.txt"
    : > "$RESPONSE"; : > "$TREE"; chmod 600 "$RESPONSE" "$TREE"
    T0_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
    if ! control_safe_force_stop_package com.google.android.youtube; then
      RUN_RC=70
      MECHANICS=failed
      QUALITY=not_scored
      METRICS='{}'
    else
      sleep 2
      ( cd "$EVO" && printf '%s\n' "$TASK" | run_owned_timeout_stdin 180 15 \
          codex exec --model "$MODEL" -c model_reasoning_effort="$EFFORT" \
          --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check - \
          >"$RESPONSE" 2>/dev/null )
      RUN_RC=$?
      if [ "$RUN_RC" -eq 124 ] || [ "$RUN_RC" -eq 137 ] || [ "$RUN_RC" -eq 143 ]; then
        MECHANICS=timeout
        QUALITY=not_scored
        METRICS='{}'
      elif [ "$RUN_RC" -ne 0 ]; then
        MECHANICS=runner_failed
        QUALITY=not_scored
        METRICS='{}'
      elif ! "$TOOLS/phone.sh" see >"$TREE" 2>/dev/null; then
        MECHANICS=failed
        QUALITY=not_scored
        METRICS='{}'
      else
        VALIDATION=$(python3 "$ROUTER" grounded-titles \
          --response "$RESPONSE" --tree "$TREE" 2>/dev/null || echo '{}')
        MECHANICS=$(printf '%s' "$VALIDATION" | python3 -c \
          'import json,sys; print((json.load(sys.stdin) or {}).get("mechanicsStatus") or "failed")' \
          2>/dev/null || echo failed)
        QUALITY=$(printf '%s' "$VALIDATION" | python3 -c \
          'import json,sys; print((json.load(sys.stdin) or {}).get("qualityStatus") or "not_scored")' \
          2>/dev/null || echo not_scored)
        METRICS=$(printf '%s' "$VALIDATION" | python3 -c \
          'import json,sys; print(json.dumps((json.load(sys.stdin) or {}).get("metrics") or {},separators=(",",":")))' \
          2>/dev/null || echo '{}')
      fi
    fi
    T1_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
    ELAPSED_MS=$((T1_MS - T0_MS))
    METRICS=$(python3 - "$METRICS" "$ELAPSED_MS" <<'PY' 2>/dev/null
import json,sys
try: value=json.loads(sys.argv[1])
except Exception: value={}
value["elapsedMs"]=int(sys.argv[2])
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
    GROUNDED=$(printf '%s' "$METRICS" | python3 -c \
      'import json,sys; print((json.load(sys.stdin) or {}).get("groundedTitles",0))' \
      2>/dev/null || echo 0)
    say "$MODEL@$EFFORT round=$ROUND: $((ELAPSED_MS/1000))s mechanics=$MECHANICS quality=$QUALITY grounded=$GROUNDED/5"
    : > "$RESPONSE"; : > "$TREE"
  done
done
say "=== SUMMARY (qualified routing needs paired grounded passes; timeouts are not quality scores) ==="
