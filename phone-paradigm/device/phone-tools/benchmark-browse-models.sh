#!/data/data/com.termux/files/usr/bin/bash
# benchmark-browse-models.sh — A/B the codex models on COMPUTER-USE source browsing (the
# hidden-display app driving), not just curation text. For each model, run the same YouTube
# browse prompt (a computer-use task: launch app, navigate, identify videos, share to Evogent)
# and measure: wall-clock, whether it actually cached items, and how complete those items are.
# Deterministic scrapers (hn/x-scrape) don't use a brain, so YouTube is a useful computer-use
# smoke test. The live recommendation surface changes between runs and this harness does not
# judge private relevance, so its receipts are deliberately ineligible for persistent routing.
#
# Usage: benchmark-browse-models.sh [model@effort ...]
#        the first route is the baseline; defaults compare the active route with lower-cost
#        candidates. Three rounds make screening steadier; this suite never changes routing.
set -u
EVO="$HOME/evogent"; TOOLS="$HOME/phone-tools"; BASE="http://127.0.0.1:${PORT:-3001}"
EVO_CURL="$TOOLS/evo-curl"
export EVOGENT_API_CURL="$EVO_CURL"
ROUTER="$TOOLS/model_routing.py"
FINALIZER="$TOOLS/benchmark-browse-finalize.py"
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
ACTIVE_RUN_ID=""
BENCH_TMP=""
cleanup_benchmark_proof() {
  local run_id="${1:-}"
  [ -n "$run_id" ] || return 0
  env EVOGENT_TASK_OWNER="$CONTROL_OWNER_ID" EVOGENT_CONTROL_ROOT="$CONTROL_ROOT" \
    python3 "$FINALIZER" cleanup --run-id "$run_id" >/dev/null 2>&1
}
bench_cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  control_kill_tagged "$CONTROL_OWNER_ID"
  [ -n "$ACTIVE_RUN_ID" ] && cleanup_benchmark_proof "$ACTIVE_RUN_ID" || true
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
control_lock_acquire "$BENCH_LOCK" browse-benchmark ||
  { say "another live task owns the hidden display"; exit 1; }
BENCH_LOCK_HELD=1
if control_release_transaction_pending \
    "${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"; then
  say "durable release transaction is pending; benchmark deferred"
  exit 75
fi
control_wake_acquire
mkdir -p "${TMPDIR:-$HOME/.cache}"
BENCH_TMP=$(mktemp -d "${TMPDIR:-$HOME/.cache}/evogent-browse-bench.XXXXXX") || exit 70
chmod 700 "$BENCH_TMP"
if [ "${#ROUTES[@]}" -eq 0 ]; then
  CURRENT=$(python3 "$ROUTER" resolve --task browse_youtube \
    --config "$EVO/data/config.md" \
    --policy "$TOOLS/model-routing.default.json" \
    --live "$EVO/data/model-routing.json" \
    --receipts "$LEDGER" 2>/dev/null || printf '%s\n' $'gpt-5.6-sol\tmedium\tfallback')
  IFS=$'\t' read -r CURRENT_MODEL CURRENT_EFFORT _ <<< "$CURRENT"
  ROUTES=("$CURRENT_MODEL@$CURRENT_EFFORT" "gpt-5.6-terra@low" "gpt-5.6-luna@low")
fi

for ROUND in $(seq 1 "$ROUNDS"); do
  MODEL_INDEX=0
  for SPEC in "${ROUTES[@]}"; do
    MODEL_INDEX=$((MODEL_INDEX + 1))
    MODEL="${SPEC%@*}"; EFFORT="${SPEC##*@}"; [ "$MODEL" = "$EFFORT" ] && EFFORT=medium
    ROLE=candidate; [ "$MODEL_INDEX" -eq 1 ] && ROLE=baseline
    say "=== $MODEL@$EFFORT round=$ROUND ==="
    RUN_ID="full-browse-${SUITE}-r${ROUND}-${ROLE}-${MODEL_INDEX}"
    EVENTS="$BENCH_TMP/events-$ROUND-$MODEL_INDEX.jsonl"
    FINAL_OUTPUT="$BENCH_TMP/final-$ROUND-$MODEL_INDEX.txt"
    : > "$EVENTS"; : > "$FINAL_OUTPUT"; chmod 600 "$EVENTS" "$FINAL_OUTPUT"
    T0_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
    RUN_DIGEST=$(python3 - "$RUN_ID" <<'PY'
import hashlib,sys
print(hashlib.sha256(sys.argv[1].encode()).hexdigest())
PY
)
    PROOF=$(printf '{"terminalProof":false,"terminalItems":0,"freshRows":0,"completeRows":0,"runDigest":"%s"}' "$RUN_DIGEST")
    RUN_PROMPT="$(cat "$PROMPT_FILE")

FULL_BROWSE BENCHMARK TERMINAL LAW:
- This run's exact identifier is $RUN_ID and its exact start time is $T0_MS.
- Each selected video needs its own one-shot proof. Immediately BEFORE tapping the Evogent
  Android share target for share number <N>, run:
  python3 ~/phone-tools/benchmark-browse-finalize.py arm-share --run-id '$RUN_ID' --sequence <N>
- Only continue when that prints BROWSE_SHARE_ARMED <N>. Tap Evogent exactly once, then
  immediately run:
  python3 ~/phone-tools/benchmark-browse-finalize.py confirm-share --run-id '$RUN_ID' --sequence <N>
- Only a share that prints BROWSE_SHARE_CONFIRMED <N> counts. Never arm the next share before
  confirming the current one. Use consecutive sequence numbers 1..5 and do not share a video
  twice. Cards merely visible on screen, prior cache rows, and unarmed shares never count.
- Before your final answer, you MUST run this exact helper, replacing <COUNT> with that count:
  python3 ~/phone-tools/benchmark-browse-finalize.py finalize --run-id '$RUN_ID' --started-at-ms '$T0_MS' --declared-count <COUNT>
- The helpers bind every counted share to this run's private one-shot token and exact durable
  ingest receipt, then write one content-free terminal receipt. Do not manufacture receipts.
- Only if it prints BROWSE_BENCHMARK_RECEIPT $RUN_ID <COUNT> may you finish with
  BROWSE_DONE <COUNT>. A missing or rejected helper receipt means the benchmark run failed."
    ACTIVE_RUN_ID="$RUN_ID"
    if ! python3 "$FINALIZER" begin --run-id "$RUN_ID" \
        --started-at-ms "$T0_MS" >/dev/null; then
      RC=70
      MECHANICS=failed
      QUALITY=not_scored
    elif ! control_safe_force_stop_package com.google.android.youtube; then
      RC=70
      MECHANICS=failed
      QUALITY=not_scored
    else
      sleep 2
      ( cd "$EVO" && run_owned_timeout 420 30 codex exec --model "$MODEL" \
          -c model_reasoning_effort="$EFFORT" --dangerously-bypass-approvals-and-sandbox \
          --json --output-last-message "$FINAL_OUTPUT" "$RUN_PROMPT" \
          >"$EVENTS" 2>>"$TOOLS/scheduler.log" )
      RC=$?
      if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ] || [ "$RC" -eq 143 ]; then
        MECHANICS=timeout
        QUALITY=not_scored
      elif [ "$RC" -ne 0 ]; then
        MECHANICS=runner_failed
        QUALITY=not_scored
      else
        MECHANICS=terminal_proof_pending
        QUALITY=not_scored
      fi
    fi
    T1_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
    USAGE=$(python3 "$ROUTER" codex-usage --events "$EVENTS" 2>/dev/null || echo '{}')
    if [ "$MECHANICS" = terminal_proof_pending ]; then
      if PROOF=$(python3 "$FINALIZER" --database "$EVO/data/media-agent.db" verify \
          --run-id "$RUN_ID" \
          --started-at-ms "$T0_MS" \
          --max-completed-at-ms "$T1_MS" 2>/dev/null); then
        MECHANICS=passed
        # Canonical shares prove driver mechanics and yield, not whether the
        # live, mutable recommendations matched the private taste model.
        QUALITY=not_scored
      else
        MECHANICS=terminal_proof_failed
        QUALITY=not_scored
      fi
    fi
    if [ "$MECHANICS" = passed ] && [ "$USAGE" = '{}' ]; then
      MECHANICS=terminal_proof_failed
      QUALITY=not_scored
    fi
    if ! cleanup_benchmark_proof "$RUN_ID"; then
      MECHANICS=terminal_proof_failed
      QUALITY=not_scored
    fi
    ACTIVE_RUN_ID=""
    ELAPSED_MS=$((T1_MS - T0_MS))
    METRICS=$(python3 - "$PROOF" "$USAGE" "$ELAPSED_MS" <<'PY' 2>/dev/null
import json,sys
try: value=json.loads(sys.argv[1])
except Exception: value={}
try: usage=json.loads(sys.argv[2])
except Exception: usage={}
if isinstance(usage,dict): value.update(usage)
value["elapsedMs"]=int(sys.argv[3])
print(json.dumps(value,separators=(",",":")))
PY
)
    RECEIPT=$(python3 - "$SUITE" "$ROUND" "$ROLE" "$MODEL" "$EFFORT" \
      "$MECHANICS" "$QUALITY" "$METRICS" <<'PY'
import json,sys
print(json.dumps({
  "suiteId":sys.argv[1],"round":int(sys.argv[2]),"task":"browse_youtube_smoke_v1","role":sys.argv[3],
  "benchmarkKind":"full_browse_youtube_smoke",
  "model":sys.argv[4],"effort":sys.argv[5],"mechanicsStatus":sys.argv[6],
  "qualityStatus":sys.argv[7],"metrics":json.loads(sys.argv[8]),
},separators=(",",":")))
PY
)
    python3 "$ROUTER" record --ledger "$LEDGER" --receipt-json "$RECEIPT" \
      || say "$MODEL round=$ROUND: receipt write failed"
    FRESH=$(printf '%s' "$METRICS" | python3 -c \
      'import json,sys; print(int((json.load(sys.stdin) or {}).get("freshRows") or 0))' \
      2>/dev/null || echo 0)
    TOKENS=$(printf '%s' "$METRICS" | python3 -c \
      'import json,sys; print((json.load(sys.stdin) or {}).get("totalTokens","unknown"))' \
      2>/dev/null || echo unknown)
    say "$MODEL@$EFFORT round=$ROUND: $((ELAPSED_MS/1000))s tokens=$TOKENS mechanics=$MECHANICS quality=$QUALITY exactFresh=$FRESH"
    : > "$EVENTS"; : > "$FINAL_OUTPUT"
  done
done

say "=== SUMMARY ==="
grep -E "mechanics=.*quality=" "$RESULTS" || true
say "This live-feed smoke evidence compares mechanics, yield, latency, and tokens only; quality remains not_scored. It cannot qualify any persistent route because runs see a changing feed and do not receive a blinded private-relevance review. Timeouts, driver failures, and missing usage are mechanics evidence, never model-quality scores."
