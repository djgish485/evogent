#!/data/data/com.termux/files/usr/bin/bash
# benchmark-browse-models.sh — A/B the codex models on COMPUTER-USE source browsing (the
# hidden-display app driving), not just curation text. For each model, run the same YouTube
# browse prompt (a computer-use task: launch app, navigate, identify videos, share to Evogent)
# and measure: wall-clock, whether it actually cached items, and how complete those items are.
# Deterministic scrapers (hn/x-scrape) don't use a brain, so YouTube is the fair computer-use test.
#
# Usage: benchmark-browse-models.sh [model1 model2 model3]
#        defaults to gpt-5.5 gpt-5.6-sol gpt-5.6-luna
set -u
EVO="$HOME/evogent"; TOOLS="$HOME/phone-tools"; BASE="http://127.0.0.1:3001"
MODELS=("${@:-}")
[ -z "${MODELS[*]}" ] && MODELS=(gpt-5.5 gpt-5.6-sol gpt-5.6-luna)
PROMPT_FILE="$TOOLS/browse-youtube.txt"
RESULTS="$TOOLS/browse-benchmark-results.txt"
: > "$RESULTS"
say(){ echo "[browse-bench] $*" | tee -a "$RESULTS" >&2; }

src_count(){ curl -s -m8 "$BASE/api/internal/browse-cache/items?source=youtube&limit=400" \
  | python3 -c 'import sys,json;print(len((json.load(sys.stdin).get("items") or [])))' 2>/dev/null || echo 0; }

# Completeness of the freshest N youtube rows: fraction carrying a canonical watch URL + title.
completeness(){ ( cd "$EVO" && node -e '
  const db=require("better-sqlite3")("data/media-agent.db");
  const now=Date.now();
  const rows=db.prepare("SELECT url,title,payload_json FROM browse_cache_items WHERE source=? AND fetched_at_ms>? ORDER BY fetched_at_ms DESC LIMIT 10").all("youtube", now-15*60000);
  let n=rows.length, url=0, title=0;
  for(const r of rows){ let p={}; try{p=JSON.parse(r.payload_json||"{}")}catch(e){}
    if(/watch\?v=|youtu\.be\//.test(r.url||p.url||p.canonicalUrl||"")) url++;
    if((r.title||p.title||"").length>5) title++; }
  console.log(JSON.stringify({fresh:n, withCanonicalUrl:url, withTitle:title}));
' 2>/dev/null || echo "{}" ); }

for MODEL in "${MODELS[@]}"; do
  say "=== $MODEL ==="
  # Reap the app so each model starts from a cold launch (fair timing).
  ~/rish-bin/rish -c "am force-stop com.google.android.youtube" >/dev/null 2>&1; sleep 2
  before=$(src_count)
  T0=$(date +%s)
  ( cd "$EVO" && EVOGENT_CODEX_MODEL="$MODEL" timeout -k 30 420 codex exec --model "$MODEL" \
      -c model_reasoning_effort=medium --dangerously-bypass-approvals-and-sandbox \
      "$(cat "$PROMPT_FILE")" >>"$TOOLS/scheduler.log" 2>&1 )
  RC=$?
  T1=$(date +%s)
  after=$(src_count)
  gained=$(( after - before )); [ "$gained" -lt 0 ] && gained=0
  comp=$(completeness)
  say "$MODEL: ${gained} new youtube items in $((T1-T0))s (rc=$RC); completeness=$comp"
done

say "=== SUMMARY ==="
cat "$RESULTS" | grep -E "new youtube items"
say "Judge on: items cached (more=better), wall-clock (less=better), withCanonicalUrl (should = fresh; low = data we'd have to enrich later)."
