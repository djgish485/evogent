#!/data/data/com.termux/files/usr/bin/bash
# source-discovery.sh <package> <AppName> [source-name] — one-time heavy-brain discovery
# session for a new source: learns how to browse <package> on the hidden display, caches a
# first batch of items, and writes a repeatable recipe to ~/evogent/data/phone-sources/.
# Dispatched from a source-scout suggestion card's approve button (run it inside a detached
# tmux; it can take up to ~15 minutes). Reports completion as a feed notification.
set -u
TOOLS="$HOME/phone-tools"
EVO="$HOME/evogent"
LOG="$TOOLS/scheduler.log"
BASE="http://127.0.0.1:${PORT:-3001}"
EVO_CURL="$TOOLS/evo-curl"
TASK_QUEUE="$TOOLS/durable_task_queue.py"
REQUEST_QUEUE="$EVO/data/phone-sources/.queue"
REQUEST_LEASE=""
if [ "${1:-}" = "--lease" ]; then
  REQUEST_LEASE="${2:?usage: source-discovery.sh --lease <leased-request.json>}"
  PKG=$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1])).get("pkg") or ""))' "$REQUEST_LEASE" 2>/dev/null)
  NAME=$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1])).get("name") or ""))' "$REQUEST_LEASE" 2>/dev/null)
  SRC=$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1])).get("source") or ""))' "$REQUEST_LEASE" 2>/dev/null)
  [ -n "$PKG" ] && [ -n "$NAME" ] && [ -n "$SRC" ] || {
    echo "source-discovery: leased request is missing pkg/name/source" >&2
    exit 2
  }
else
  PKG="${1:?usage: source-discovery.sh <package> <AppName> [source-name]}"
  NAME="${2:?usage: source-discovery.sh <package> <AppName> [source-name]}"
  SRC="${3:-$(echo "$NAME" | tr '[:upper:] ' '[:lower:]-')}"
fi
export EVOGENT_API_CURL="$EVO_CURL"
ts(){ date '+%F %T'; }
say(){ echo "[$(ts)] [source-discovery:$SRC] $*" | tee -a "$LOG" >&2; }

. "$TOOLS/control-plane.sh"
control_init_owner source-discovery
control_reap_abandoned_owners

# Same PID+start-aware lease as evogent-cycle.sh: exactly one hidden-display driver at a time.
# A live owner is never evicted merely because its task crossed an arbitrary age threshold.
LOCKDIR="$TOOLS/.cycle.lock"
WAITED=0
DISC_LOCK_HELD=0
DISC_WAKE_HELD=0
DISC_REPORTED=0
DISC_REQUEST_FINISHED=0
finish_request() {
  local result="$1" outcome="$2" detail="${3:-}" transition
  [ -n "$REQUEST_LEASE" ] || return 0
  [ "$DISC_REQUEST_FINISHED" = 0 ] || return 0
  transition=$(python3 "$TASK_QUEUE" finish --root "$REQUEST_QUEUE" --lease "$REQUEST_LEASE" \
    --result "$result" --outcome "$outcome" --detail "$detail" 2>>"$LOG") || {
      say "request ledger transition failed; lease remains durable for expiry recovery"
      return 1
    }
  DISC_REQUEST_FINISHED=1
  say "request ledger: $(printf '%s' "$transition" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("action") or "updated")' 2>/dev/null || echo updated)"
}
discovery_cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  control_kill_tagged "$CONTROL_OWNER_ID"
  if [ "$DISC_LOCK_HELD" = 1 ]; then
    control_cleanup_tracked_packages
    control_close_hidden_displays
  fi
  [ "$DISC_WAKE_HELD" = 1 ] && control_wake_release || true
  if [ "$DISC_LOCK_HELD" = 1 ] && [ "$DISC_REPORTED" = 0 ]; then
    control_status_write sources "$SRC" failed discovery_interrupted 0 "$rc" \
      "source discovery exited before a terminal result"
  fi
  if [ "$DISC_REQUEST_FINISHED" = 0 ]; then
    finish_request retry discovery_interrupted "worker exited rc=$rc before a terminal result" || true
  fi
  [ "$DISC_LOCK_HELD" = 1 ] && control_lock_release "$LOCKDIR" || true
  control_finish_owner
  exit "$rc"
}
trap discovery_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

until control_lock_acquire "$LOCKDIR" source-discovery; do
  [ "$WAITED" -ge 1200 ] && { say "cycle lock still held after 20min — giving up"; exit 1; }
  [ "$WAITED" = 0 ] && say "waiting for the live cycle owner to release the hidden display..."
  sleep 30; WAITED=$(( WAITED + 30 ))
done
DISC_LOCK_HELD=1
if control_release_transaction_pending \
    "${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"; then
  say "durable release transaction is pending; discovery remains queued"
  exit 75
fi
if control_wake_acquire; then
  DISC_WAKE_HELD=1
else
  [ "$CONTROL_WAKE_HELD" = 1 ] && DISC_WAKE_HELD=1
  say "scoped CPU wake lock unavailable — continuing, but discovery is not power-protected"
fi
control_status_write sources "$SRC" running discovery "" "" "source discovery"

mkdir -p "$EVO/data/phone-sources"

# The user can cancel an auto-added source by dismissing its announcement card — the server
# appends data/phone-sources/.optout. Honor a cancellation that landed before we started.
opted_out(){ grep -qw "$SRC" "$EVO/data/phone-sources/.optout" 2>/dev/null; }
if opted_out; then
  say "cancelled by user before start — aborting"
  control_status_write sources "$SRC" completed discovery_cancelled 0 0 "cancelled before start"
  finish_request ack discovery_cancelled "cancelled by the user before discovery began" || true
  DISC_REPORTED=1
  exit 0
fi

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

# Source discovery is a one-time instruction-authoring/research task, not routine extraction.
# It deliberately keeps the independently configured Codex route; a browse benchmark must not
# silently change the model that writes a new durable source recipe.
# Brain provider from data/config.md, same convention as evogent-cycle.sh.
BRAIN=$(awk '/^## Brain Provider/{f=1;next} f&&/^##[[:space:]]/{exit} f&&NF{print;exit}' \
        "$EVO/data/config.md" 2>/dev/null | grep -qi codex && echo codex || echo claude)
CODEX_MODEL="${EVOGENT_CODEX_MODEL:-$(awk '/^## Codex Model/{f=1;next} f&&/^##[[:space:]]/{exit} f&&NF{print;exit}' "$EVO/data/config.md" 2>/dev/null)}"; CODEX_MODEL="${CODEX_MODEL:-gpt-5.5}"

# Self-heal the a11y service: a disabled service reads as "app did not land on any display".
EVOGENT_TASK_OWNER="$CONTROL_OWNER_ID" bash "$TOOLS/a11y-heal.sh" >>"$LOG" 2>&1 \
  || say "a11y-heal: service unresponsive — discovery will likely fail"

say "discovery starting (brain=$BRAIN, budget 900s) — $NAME ($PKG) -> $SRC"
if [ "$BRAIN" = "codex" ]; then
  # '--' guards against prompts that begin with '-' (codex parses them as CLI options).
  ( cd "$EVO" && run_owned_timeout 900 30 codex exec --model "$CODEX_MODEL" -c model_reasoning_effort=medium \
      --dangerously-bypass-approvals-and-sandbox -- "$PROMPT" >>"$LOG" 2>&1 )
else
  ( cd "$EVO" && run_owned_timeout 900 30 env -u ANTHROPIC_API_KEY \
    CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.evogent-oauth-token" 2>/dev/null)" \
    claude -p "$PROMPT" --permission-mode bypassPermissions \
      --allowedTools "Bash,Read,Write,Glob,Grep" >>"$LOG" 2>&1 )
fi
RC=$?

RECIPE="$EVO/data/phone-sources/$SRC.txt"
# Cancellation raced the discovery: respect it — remove whatever was written and stop quietly.
if opted_out; then
  say "cancelled by user during discovery — removing recipe and exiting"
  rm -f "$RECIPE" "$EVO/data/phone-sources/$SRC.py"
  control_status_write sources "$SRC" completed discovery_cancelled 0 "$RC" \
    "cancelled during discovery"
  finish_request ack discovery_cancelled "cancelled by the user during discovery" || true
  DISC_REPORTED=1
  exit 0
fi
CACHED=$("$EVO_CURL" -s -m8 "$BASE/api/internal/browse-cache/items?source=$SRC&limit=200" \
  | python3 -c 'import sys,json;print(len((json.load(sys.stdin).get("items") or [])))' 2>/dev/null || echo 0)

if [ -f "$RECIPE" ] && [ "${CACHED:-0}" -gt 0 ] 2>/dev/null; then
  say "discovery SUCCEEDED: recipe written ($RECIPE), $CACHED items cached"
  control_status_write sources "$SRC" completed discovery_fresh "$CACHED" "$RC" \
    "source discovery wrote a recipe and cached items"
  finish_request ack discovery_fresh "recipe written and $CACHED items cached" || true
  DISC_REPORTED=1
elif [ -f "$RECIPE" ]; then
  say "discovery PARTIAL: recipe written but 0 items cached (rc=$RC) — recipe unproven"
  control_status_write sources "$SRC" failed discovery_partial 0 "$RC" \
    "recipe written but no items cached"
  finish_request retry discovery_partial "recipe written but no items cached (rc=$RC)" || true
  DISC_REPORTED=1
else
  say "discovery FAILED: no recipe written (rc=$RC) — see $LOG"
  control_status_write sources "$SRC" failed discovery_failure 0 "$RC" \
    "no recipe written"
  finish_request retry discovery_failure "no recipe written (rc=$RC)" || true
  DISC_REPORTED=1
  # The discovery agent posts its own notification on success; make sure failure is visible too.
  "$EVO_CURL" -s -m8 -X POST "$BASE/api/internal/curate/submit" -H "content-type: application/json" -d "{
    \"items\": [{\"type\": \"notification\", \"source\": \"phone\",
      \"sourceId\": \"source-discovery-$SRC-failed\",
      \"title\": \"$NAME source discovery failed\",
      \"text\": \"The source discovery session for $NAME did not produce a browse recipe (exit $RC). Evogent retained the request and will retry with bounded backoff; repeated failures are quarantined for diagnosis.\",
      \"metadata\": {\"notificationId\": \"source-discovery-$SRC-failed\", \"severity\": \"warning\"}}]}" >/dev/null 2>&1
fi
