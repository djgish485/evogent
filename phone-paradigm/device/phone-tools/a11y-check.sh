#!/data/data/com.termux/files/usr/bin/bash
# Prints the byte count returned by a nonce-authenticated op=nodes request. >0 means the
# accessibility service is actually CONNECTED and responding, not merely enabled in settings.
# phone.sh owns the per-request OS-assigned loopback receiver and validates the response nonce.
TOOLS="$HOME/phone-tools"
TMPBASE="${TMPDIR:-${PREFIX:-$HOME}/tmp}"
mkdir -p "$TMPBASE"
OUT=$(mktemp "$TMPBASE/evogent-a11y-check.XXXXXX")
cleanup(){ rm -f -- "$OUT"; }
trap cleanup EXIT INT TERM HUP
if ! bash "$TOOLS/phone.sh" see 0 >"$OUT" 2>/dev/null; then
  echo 0
  exit 1
fi
wc -c < "$OUT" | tr -d ' '
