#!/data/data/com.termux/files/usr/bin/bash
# benchmark-cu-micro.sh — a FAIR, bounded computer-use micro-task to compare models' speed and
# accuracy at the core hidden-display loop (launch -> navigate -> read), without the fragile
# multi-step share flow that timed everyone out. Task: open YouTube, go to Subscriptions, read
# and report exactly 5 real video titles as JSON. Measures wall-clock + whether output parses to
# 5 plausible titles. Isolates hidden-display navigation and reading ability.
set -u
EVO="$HOME/evogent"; TOOLS="$HOME/phone-tools"
export EVOGENT_API_CURL="$TOOLS/evo-curl"
OUT="$TOOLS/cu-micro-results.txt"; : > "$OUT"
MODELS=("${@:-}"); [ -z "${MODELS[*]}" ] && MODELS=(gpt-5.5 gpt-5.6-sol gpt-5.6-luna gpt-5.6-terra)
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
control_wake_acquire

read -r -d '' TASK <<'EOF'
Bounded computer-use task on the hidden display. Do exactly this, no more:
1. ~/phone-tools/phone.sh launch com.google.android.youtube ; wait 5s.
2. ~/phone-tools/phone.sh tap "Subscriptions" ; wait 3s.
3. ~/phone-tools/phone.sh see  — read the accessibility tree.
4. From what you SEE, extract exactly 5 real video titles currently on screen (skip Shorts, ads,
   nav labels). Do NOT scroll, share, or open anything.
Reply with ONLY this JSON on the last line: {"titles":["...","...","...","...","..."]}
EOF

for MODEL in "${MODELS[@]}"; do
  if ! control_safe_force_stop_package com.google.android.youtube; then
    say "$MODEL: skipped — YouTube could not be stopped without risking physical-screen use"
    continue
  fi
  sleep 2
  T0=$(date +%s)
  RESP=$( cd "$EVO" && printf '%s\n' "$TASK" | run_owned_timeout_stdin 180 15 codex exec --model "$MODEL" \
      -c model_reasoning_effort=low --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check - 2>/dev/null \
      | grep -oE '\{"titles":\[[^]]*\]\}' | tail -1 )
  T1=$(date +%s)
  N=$(echo "$RESP" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); t=[x for x in (d.get("titles") or []) if isinstance(x,str) and len(x)>3]
  print(len(t))
except Exception: print(0)' 2>/dev/null || echo 0)
  say "$MODEL: $((T1-T0))s, ${N}/5 titles read | $(echo "$RESP" | cut -c1-90)"
done
say "=== SUMMARY (speed + accuracy of navigate+read; more titles + less time = better) ==="
