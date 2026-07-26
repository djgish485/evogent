#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
EVO_HOME="${EVOGENT_HOME:-$HOME/evogent}"
EVO_HOME_REAL="$(readlink -f "$EVO_HOME")"
[ -n "$EVO_HOME_REAL" ] && [ -d "$EVO_HOME_REAL" ] || {
    echo "start-prod: release runtime could not be resolved" >&2
    exit 66
}
EVO_RELEASE_ROOT="$(dirname "$EVO_HOME_REAL")"
TLS_CERT="$EVO_RELEASE_ROOT/tls/server-cert.pem"
TLS_KEY="$EVO_RELEASE_ROOT/tls/server-key.pem"
[ -f "$TLS_CERT" ] && [ -f "$TLS_KEY" ] || {
    echo "start-prod: release-matched phone TLS material is missing" >&2
    exit 66
}
[ "$(stat -c '%a' "$TLS_KEY")" = 600 ] || {
    echo "start-prod: phone TLS private key permissions must be 0600" >&2
    exit 66
}
cd "$EVO_HOME_REAL"
export NODE_ENV=production
export HOST=127.0.0.1
export LISTEN_HOST=127.0.0.1
export PORT=3001
export EVOGENT_PHONE_HTTPS_PORT=3443
export EVOGENT_PHONE_TLS_CERT_PATH="$TLS_CERT"
export EVOGENT_PHONE_TLS_KEY_PATH="$TLS_KEY"
export EVOGENT_RUNTIME_PROFILE=phone
export MEDIA_AGENT_DISABLE_BACKGROUND_JOBS=1
export DATA_DIR="$EVO_HOME/data"
export MEDIA_AGENT_DB_PATH="$DATA_DIR/media-agent.db"
export EVOGENT_PHONE_CYCLE_REQUEST_PATH="$DATA_DIR/phone-cycle-request.json"
export EVOGENT_PHONE_CONTROL_STATUS_PATH="$DATA_DIR/phone-control-status.json"
export EVOGENT_API_CURL="$HOME/phone-tools/evo-curl"
# Run the configured headless agent from the signed-in subscription, not a pay-per-use API key.
# ANTHROPIC_API_KEY has HIGHER precedence than the subscription OAuth token and forces
# API billing (the "Credit balance is too low" failures), so it must NOT be set here.
# The long-lived subscription token comes from `claude setup-token` (one-time browser
# approval) and lives in ~/.evogent-oauth-token.
unset ANTHROPIC_API_KEY
[ -f "$HOME/.evogent-oauth-token" ] && export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.evogent-oauth-token")"
echo "START profile=$EVOGENT_RUNTIME_PROFILE release=$(cat .evogent-release.json 2>/dev/null || echo legacy)"
exec node server.js
