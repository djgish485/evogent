#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DISPLAY_NUMBER=":99"
PROFILE_DIR="/root/.config/playwright-browse-profile/"
XVFB_PID=""

install_xvfb_if_needed() {
  if command -v xvfb-run >/dev/null 2>&1 && command -v Xvfb >/dev/null 2>&1; then
    return
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Xvfb is required but apt-get is not available to install it." >&2
    exit 1
  fi

  echo "Installing Xvfb..."
  apt-get update
  apt-get install -y xvfb
}

start_xvfb() {
  if pgrep -f "Xvfb ${DISPLAY_NUMBER}" >/dev/null 2>&1; then
    return
  fi

  Xvfb "${DISPLAY_NUMBER}" -screen 0 1280x720x24 >/tmp/browser-login-xvfb.log 2>&1 &
  XVFB_PID=$!
  sleep 1

  if ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
    echo "Failed to start Xvfb on ${DISPLAY_NUMBER}." >&2
    exit 1
  fi
}

cleanup() {
  local exit_code=$?

  if [ -n "$XVFB_PID" ] && kill -0 "$XVFB_PID" >/dev/null 2>&1; then
    kill "$XVFB_PID" >/dev/null 2>&1 || true
    wait "$XVFB_PID" >/dev/null 2>&1 || true
  fi

  exit "$exit_code"
}

trap cleanup EXIT

install_xvfb_if_needed
start_xvfb

mkdir -p "$PROFILE_DIR"

cd "$WORKTREE_DIR"
DISPLAY="$DISPLAY_NUMBER" npx tsx scripts/browser-login.ts "$@"
