#!/data/data/com.termux/files/usr/bin/bash
# source-discovery.sh <package> <AppName> [source-name] — one-time heavy-brain discovery
# session for a new source: learns how to browse <package> on the hidden display, caches a
# first batch of items, and writes a repeatable recipe to ~/evogent/data/phone-sources/.
# Dispatched from a source-scout suggestion card's approve button (run it inside a detached
# tmux; it can take up to ~15 minutes). Reports completion as a feed notification.
set -u
PKG="${1:?usage: source-discovery.sh <package> <AppName> [source-name]}"
NAME="${2:?usage: source-discovery.sh <package> <AppName> [source-name]}"
SRC="${3:-$(echo "$NAME" | tr '[:upper:] ' '[:lower:]-')}"
TOOLS="$HOME/phone-tools"
EVO="$HOME/evogent"
LOG="$TOOLS/scheduler.log"
BASE="http://127.0.0.1:3001"
ts(){ date '+%F %T'; }
say(){ echo "[$(ts)] [source-discovery:$SRC] $*" | tee -a "$LOG" >&2; }

# Same lock as evogent-cycle.sh: exactly one hidden-display driver at a time. Wait up to
# 20 minutes for a running cycle to finish, then take the lock ourselves.
LOCKDIR="$TOOLS/.cycle.lock"
WAITED=0
until mkdir "$LOCKDIR" 2>/dev/null; do
  if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    say "reclaiming stale cycle lock (>30min)"; rm -rf "$LOCKDIR"; continue
  fi
  [ "$WAITED" -ge 1200 ] && { say "cycle lock still held after 20min — giving up"; exit 1; }
  [ "$WAITED" = 0 ] && say "waiting for the running cycle to release the hidden display..."
  sleep 30; WAITED=$(( WAITED + 30 ))
done
trap 'rm -rf "$LOCKDIR"' EXIT

mkdir -p "$EVO/data/phone-sources"

# The user can cancel an auto-added source by dismissing its announcement card — the server
# appends data/phone-sources/.optout. Honor a cancellation that landed before we started.
opted_out(){ grep -qw "$SRC" "$EVO/data/phone-sources/.optout" 2>/dev/null; }
if opted_out; then say "cancelled by user before start — aborting"; exit 0; fi

# App-specific notes from the catalog (best-effort).
NOTES=$(python3 - "$PKG" <<'PYEOF'
import json, sys, os
try:
    apps = json.load(open(os.path.expanduser("~/phone-tools/source-catalog.json")))["apps"]
    print(apps.get(sys.argv[1], {}).get("discoveryNotes", "none"))
except Exception:
    print("none")
PYEOF
)

PROMPT=$(sed -e "s|__PKG__|$PKG|g" -e "s|__NAME__|$NAME|g" -e "s|__SRC__|$SRC|g" \
             -e "s|__NOTES__|$NOTES|g" "$TOOLS/source-discovery-prompt.txt")

# Brain provider from data/config.md, same convention as evogent-cycle.sh.
BRAIN=$(awk '/^## Brain Provider/{f=1;next} f&&/^##[[:space:]]/{exit} f&&NF{print;exit}' \
        "$EVO/data/config.md" 2>/dev/null | grep -qi codex && echo codex || echo claude)
CODEX_MODEL="${EVOGENT_CODEX_MODEL:-$(awk '/^## Codex Model/{f=1;next} f&&/^##[[:space:]]/{exit} f&&NF{print;exit}' "$EVO/data/config.md" 2>/dev/null)}"; CODEX_MODEL="${CODEX_MODEL:-gpt-5.5}"

# Self-heal the a11y service: a disabled service reads as "app did not land on any display".
bash "$TOOLS/a11y-heal.sh" >>"$LOG" 2>&1 || say "a11y-heal: service unresponsive — discovery will likely fail"

say "discovery starting (brain=$BRAIN, budget 900s) — $NAME ($PKG) -> $SRC"
if [ "$BRAIN" = "codex" ]; then
  # '--' guards against prompts that begin with '-' (codex parses them as CLI options).
  ( cd "$EVO" && timeout 900 codex exec --model "$CODEX_MODEL" -c model_reasoning_effort=medium \
      --dangerously-bypass-approvals-and-sandbox -- "$PROMPT" >>"$LOG" 2>&1 )
else
  ( cd "$EVO" && export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.evogent-oauth-token" 2>/dev/null)"; unset ANTHROPIC_API_KEY
    timeout 900 claude -p "$PROMPT" --permission-mode bypassPermissions \
      --allowedTools "Bash,Read,Write,Glob,Grep" >>"$LOG" 2>&1 )
fi
RC=$?

RECIPE="$EVO/data/phone-sources/$SRC.txt"
# Cancellation raced the discovery: respect it — remove whatever was written and stop quietly.
if opted_out; then
  say "cancelled by user during discovery — removing recipe and exiting"
  rm -f "$RECIPE" "$EVO/data/phone-sources/$SRC.py"
  exit 0
fi
CACHED=$(curl -s -m8 "$BASE/api/internal/browse-cache/items?source=$SRC&limit=200" \
  | python3 -c 'import sys,json;print(len((json.load(sys.stdin).get("items") or [])))' 2>/dev/null || echo 0)

if [ -f "$RECIPE" ] && [ "${CACHED:-0}" -gt 0 ] 2>/dev/null; then
  say "discovery SUCCEEDED: recipe written ($RECIPE), $CACHED items cached"
elif [ -f "$RECIPE" ]; then
  say "discovery PARTIAL: recipe written but 0 items cached (rc=$RC) — recipe unproven"
else
  say "discovery FAILED: no recipe written (rc=$RC) — see $LOG"
  # The discovery agent posts its own notification on success; make sure failure is visible too.
  curl -s -m8 -X POST "$BASE/api/internal/curate/submit" -H "content-type: application/json" -d "{
    \"items\": [{\"type\": \"notification\", \"source\": \"phone\",
      \"sourceId\": \"source-discovery-$SRC-failed\",
      \"title\": \"$NAME source discovery failed\",
      \"text\": \"The one-time discovery session for $NAME did not produce a browse recipe (exit $RC). This is often hidden-display flakiness, not the app being unbrowsable - re-approve the source card to retry.\",
      \"metadata\": {\"notificationId\": \"source-discovery-$SRC-failed\", \"severity\": \"warning\"}}]}" >/dev/null 2>&1
fi
