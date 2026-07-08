#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/evogent"
export NODE_ENV=production
export HOST=127.0.0.1
export PORT=3001
# Run headless Claude Code off Dan's SUBSCRIPTION, not a pay-per-use API key.
# ANTHROPIC_API_KEY has HIGHER precedence than the subscription OAuth token and forces
# API billing (the "Credit balance is too low" failures), so it must NOT be set here.
# The long-lived subscription token comes from `claude setup-token` (one-time browser
# approval) and lives in ~/.evogent-oauth-token.
unset ANTHROPIC_API_KEY
[ -f "$HOME/.evogent-oauth-token" ] && export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.evogent-oauth-token")"
echo "START NODE_ENV=$NODE_ENV auth=$([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo subscription-oauth || echo NONE-set-oauth-token)"
exec node server.js
