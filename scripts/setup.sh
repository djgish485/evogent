#!/usr/bin/env bash
# Last reviewed: 2026-03-05
#
# Evogent — Linux/systemd service setup script
#
# Run this after cloning the repo and running npm install && npm run build.
# It sets up:
#   1. systemd service (web app on port 3001)
#   2. cron jobs (orchestrator heartbeat safety check)
#   3. data directory and initial config
#
# Usage:
#   bash scripts/setup.sh
#
# Linux/systemd only. On macOS or Windows, run npm run setup:agent and use
# the local npm start + node worker.js path printed by that command.
#
# Prerequisites:
#   - Node.js 18+
#   - npm install && npm run build completed
#   - Either Claude Code CLI or Codex CLI installed and authenticated
#   - .env.local with AUTH_TOKEN and CT0 for Twitter (optional but recommended)
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="evogent"
CHROME_BROWSE_SERVICE="chrome-browse.service"
LEGACY_CHROME_SERVICE="chrome-twitter.service"
LOCAL_BIN_DIR="${HOME}/.local/bin"
KEYRING_DIR="${HOME}/.local/share/keyrings"
CHROME_BROWSE_PROFILE_DIR="${APP_DIR}/data/chrome-browse-profile"
LEGACY_CHROME_PROFILE_DIR="${HOME}/.config/chrome-twitter-profile"
STALE_WORKTREE_CLEANUP_SCRIPT="${APP_DIR}/scripts/cleanup-stale-worktree-processes.sh"
APP_AGENT_STATE_DIR="${APP_DIR}/data/agent-state"
LEGACY_AGENT_STATE_DIR="${HOME}/.clawdbot"

install_service_template() {
  local source_path="$1"
  local target_path="$2"

  sed \
    -e "s|__WORKING_DIR__|${APP_DIR}|g" \
    -e "s|__CHROME_PROFILE_DIR__|${CHROME_BROWSE_PROFILE_DIR}|g" \
    -e "s|__LOCAL_BIN__|${LOCAL_BIN_DIR}|g" \
    -e "s|__KEYRING_DIR__|${KEYRING_DIR}|g" \
    "$source_path" > "$target_path"
}

migrate_legacy_chrome_profile() {
  if [ ! -d "$LEGACY_CHROME_PROFILE_DIR" ]; then
    return
  fi

  if [ ! -d "$CHROME_BROWSE_PROFILE_DIR" ]; then
    mv "$LEGACY_CHROME_PROFILE_DIR" "$CHROME_BROWSE_PROFILE_DIR"
    echo "  Migrated legacy Chrome profile to $CHROME_BROWSE_PROFILE_DIR"
    return
  fi

  cp -a "$LEGACY_CHROME_PROFILE_DIR"/. "$CHROME_BROWSE_PROFILE_DIR"/
  echo "  Merged legacy Chrome profile into $CHROME_BROWSE_PROFILE_DIR"
}

cleanup_legacy_chrome_service() {
  if [ ! -f "/etc/systemd/system/${LEGACY_CHROME_SERVICE}" ]; then
    return
  fi

  systemctl disable --now "$LEGACY_CHROME_SERVICE" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${LEGACY_CHROME_SERVICE}"
  echo "  Removed legacy ${LEGACY_CHROME_SERVICE}"
}

migrate_legacy_agent_state() {
  mkdir -p "$APP_AGENT_STATE_DIR/logs"

  if [ -f "$LEGACY_AGENT_STATE_DIR/active-tasks.json" ] && [ ! -f "$APP_AGENT_STATE_DIR/active-tasks.json" ]; then
    cp "$LEGACY_AGENT_STATE_DIR/active-tasks.json" "$APP_AGENT_STATE_DIR/active-tasks.json"
    echo "  Migrated legacy active task registry to $APP_AGENT_STATE_DIR"
  fi

  if [ -d "$LEGACY_AGENT_STATE_DIR/logs" ] && [ ! -e "$APP_AGENT_STATE_DIR/logs/agent" ]; then
    cp -a "$LEGACY_AGENT_STATE_DIR/logs"/. "$APP_AGENT_STATE_DIR/logs"/ 2>/dev/null || true
    echo "  Migrated legacy agent logs to $APP_AGENT_STATE_DIR/logs"
  fi

  if [ -f "$APP_DIR/.env.local" ] && grep -q '^MEDIA_AGENT_STATE_DIR=/root/.clawdbot$' "$APP_DIR/.env.local"; then
    cp "$APP_DIR/.env.local" "$APP_DIR/.env.local.bak.$(date +%Y%m%d%H%M%S)"
    sed -i '/^MEDIA_AGENT_STATE_DIR=\/root\/\.clawdbot$/d' "$APP_DIR/.env.local"
    echo "  Removed legacy MEDIA_AGENT_STATE_DIR=/root/.clawdbot from .env.local"
  fi
}

cleanup_legacy_agent_cron() {
  local removed=0
  for cron_file in /etc/cron.d/clawdbot-monitor /etc/cron.d/clawdbot-cleanup /etc/cron.d/evogent-cleanup; do
    if [ -f "$cron_file" ]; then
      rm -f "$cron_file"
      echo "  Removed legacy cron file $cron_file"
      removed=1
    fi
  done

  if command -v crontab >/dev/null 2>&1; then
    local current_cron filtered_cron
    current_cron="$(mktemp)"
    filtered_cron="$(mktemp)"
    if crontab -l > "$current_cron" 2>/dev/null; then
      grep -vE '(\.clawdbot|claudecode-vm|check-agents\.sh|scripts/agents/cleanup\.sh)' "$current_cron" > "$filtered_cron" || true
      if ! cmp -s "$current_cron" "$filtered_cron"; then
        crontab "$filtered_cron"
        echo "  Removed legacy Evogent entries from root crontab"
        removed=1
      fi
    fi
    rm -f "$current_cron" "$filtered_cron"
  fi

  if [ "$removed" -eq 0 ]; then
    echo "  No legacy Evogent cron entries found"
  fi
}

echo "=== Evogent Setup ==="
echo "App directory: $APP_DIR"
echo ""

# ── 1. Data directory ──────────────────────────────────────────────────────

echo "[1/4] Setting up data directory..."
mkdir -p "$APP_DIR/data"
touch "$APP_DIR/data/feed-output.jsonl"
migrate_legacy_agent_state

if [ -f "$APP_DIR/data/config.md" ]; then
  echo "  data/config.md already exists, skipping"
else
  echo "  data/config.md not created by setup.sh; complete README Phase 2 choices before writing user config"
fi

if [ ! -f "$APP_DIR/data/preference-insights.md" ]; then
  cat > "$APP_DIR/data/preference-insights.md" << 'INSIGHTSEOF'
# Preference Insights
<!-- Last updated: never — will be populated by the first reflection cycle -->

## Strong Dislikes
No clear patterns yet.

## Emerging Interests
No clear patterns yet.

## Account Preferences
No clear patterns yet.

## Content Style Preferences
No clear patterns yet.

## Evolving Tastes
No clear patterns yet.
INSIGHTSEOF
  echo "  Created default data/preference-insights.md"
else
  echo "  data/preference-insights.md already exists, skipping"
fi

if [ ! -f "$APP_DIR/data/curation-prompt.md" ]; then
  cp "$APP_DIR/data/curation-prompt.default.md" "$APP_DIR/data/curation-prompt.md"
  echo "  Created data/curation-prompt.md from default template"
else
  echo "  data/curation-prompt.md already exists, skipping"
fi

if [ ! -f "$APP_DIR/data/tracked-events.json" ]; then
  cat > "$APP_DIR/data/tracked-events.json" << 'EOF_TRACKED'
{
  "events": [],
  "updatedAt": null
}
EOF_TRACKED
  echo "  Created default data/tracked-events.json"
else
  echo "  data/tracked-events.json already exists, skipping"
fi

# ── 2. systemd service ────────────────────────────────────────────────────

echo "[2/4] Installing systemd services..."

# Web server
install_service_template "${APP_DIR}/scripts/evogent.service" "/etc/systemd/system/evogent.service"
echo "  Installed evogent.service (web server, port 3001)"

# Background worker (curation, reflection, code-fix agents)
install_service_template "${APP_DIR}/scripts/evogent-worker.service" "/etc/systemd/system/evogent-worker.service"
echo "  Installed evogent-worker.service (background tasks)"

# Desktop-backed Chrome for browser-backed sources (optional)
if command -v google-chrome >/dev/null 2>&1 && command -v lightdm >/dev/null 2>&1 && command -v gnome-keyring-daemon >/dev/null 2>&1; then
  migrate_legacy_chrome_profile
  cleanup_legacy_chrome_service
  install_service_template "${APP_DIR}/scripts/chrome-browse.service" "/etc/systemd/system/${CHROME_BROWSE_SERVICE}"
  echo "  Installed ${CHROME_BROWSE_SERVICE} (desktop-backed Chrome for browser-backed sources)"
else
  echo "  Skipped ${CHROME_BROWSE_SERVICE} (desktop Chrome prerequisites not installed)"
  echo "  To enable browser-backed sources, run scripts/setup-desktop-browser.sh and then re-run setup"
fi

systemctl daemon-reload
bash "$STALE_WORKTREE_CLEANUP_SCRIPT"
systemctl enable evogent.service evogent-worker.service
systemctl restart evogent-worker.service evogent.service

if [ -f "/etc/systemd/system/${CHROME_BROWSE_SERVICE}" ]; then
  systemctl enable "$CHROME_BROWSE_SERVICE"
  systemctl restart "$CHROME_BROWSE_SERVICE"
fi

echo "  Services started"

# ── 3. Cron jobs ──────────────────────────────────────────────────────────

echo "[3/4] Installing cron jobs..."
cleanup_legacy_agent_cron
cat > "/etc/cron.d/${SERVICE_NAME}" << CRONEOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Backup heartbeat trigger (every 15 min). Main adaptive timer already runs in server.js.
# App-owned cleanup: deleted-worktree process cleanup hourly, terminal/orphaned agent data daily.
0 * * * * root /bin/bash "$STALE_WORKTREE_CLEANUP_SCRIPT" >/dev/null 2>&1 || true
17 3 * * * root MEDIA_AGENT_STATE_DIR="$APP_AGENT_STATE_DIR" /bin/bash "$APP_DIR/scripts/agents/cleanup.sh" >/dev/null 2>&1 || true
*/15 * * * * root /usr/bin/curl -fsS -X POST http://127.0.0.1:3001/api/internal/heartbeat/check -H 'Content-Type: application/json' -d '{"triggeredBy":"cron"}' >/dev/null 2>&1 || true

CRONEOF

echo "  /etc/cron.d/${SERVICE_NAME} installed"
echo "    - Heartbeat safety check: every 15 minutes via internal API"

# ── 4. Summary ────────────────────────────────────────────────────────────

echo ""
echo "[4/4] Setup complete!"
echo ""
echo "=== What's running ==="
echo "  Web app:   http://localhost:3001  (systemd: evogent.service)"
echo "  Worker:    background tasks       (systemd: evogent-worker.service)"
if systemctl is-active --quiet "$CHROME_BROWSE_SERVICE" 2>/dev/null; then
echo "  Chrome:    CDP on port 9222       (systemd: ${CHROME_BROWSE_SERVICE})"
fi
echo "  Logs:      journalctl -u evogent -f"
echo ""
echo "=== Next steps ==="
echo "  1. Open http://localhost:3001 and use General Agent chat to add sources, start curation, or drive development."
echo "  2. Run 'npm run setup:agent' and do not call setup complete until it has no REQUIRED lines."
echo "  3. Complete README Phase 2 before writing data/config.md: ask for agent name, brain provider, usage level, selected source(s), optional interests, and optional archive import."
echo "  4. Configure only the selected source(s), then install the matching source skill and run one packaged setup-smoke /cache-refresh proof for that source."
echo "  5. Ensure the chosen brain provider CLI is installed and authenticated."
echo "  6. Optional: edit data/curation-prompt.md for explicit steering; source/archive/feedback evidence teaches interests by default"
echo "  7. Optional: set up a reverse proxy or Cloudflare tunnel for HTTPS"
echo "  8. For browser-backed sources on Linux: run scripts/setup-desktop-browser.sh"
echo "     so Chrome starts inside one long-lived desktop/keyring session"
echo ""
echo "Chat runs in the web server. Background tasks (curation, reflection,"
echo "code-fix agents) run in the worker. Desktop Chrome is optional for browser-backed sources."
