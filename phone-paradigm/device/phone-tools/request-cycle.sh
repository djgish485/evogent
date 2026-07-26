#!/data/data/com.termux/files/usr/bin/bash
# Signal the sole Termux scheduler that a browse+curation cycle is wanted.
# Server heartbeat/app-open code should call this instead of dispatching /curate itself.
set -euo pipefail
TOOLS="$HOME/phone-tools"
. "$TOOLS/control-plane.sh"
reason="${*:-external}"
control_request_cycle "$reason"
printf 'cycle requested: %s\n' "$reason"
