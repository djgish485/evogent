#!/bin/bash
# Host-side recovery of the Evogent phone runtime after a reboot.
#
# This helper may restart Evogent-owned processes, but it never wakes or unlocks display 0,
# changes the remembered HOME choice, edits Android secure settings, or grants special access.
# Missing owner-controlled capabilities are typed user actions and stay revoked until the owner
# enables them visibly in Android Settings.
set +e
DIR="$(cd "$(dirname "$0")" && pwd)"
# ssh helper lives in the session scratchpad; fall back to a direct ssh if that path is gone.
TSH="$DIR/scratchpad/termux/tsh"
[ -x "$TSH" ] || TSH=""
run_termux() {
  if [ -n "$TSH" ] && [ -x "$TSH" ]; then
    "$TSH" "$1"
    return
  fi
  [ -n "${TERMUX_SSH_USER:-}" ] || {
    echo "Set TERMUX_SSH_USER or provide the private helper path in TSH." >&2
    return 2
  }
  ssh -p 8022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "${TERMUX_SSH_USER}@127.0.0.1" "$1"
}

echo "== wait for device =="
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done

if adb forward --no-rebind tcp:8022 tcp:8022 >/dev/null 2>&1; then
  trap 'adb forward --remove tcp:8022 >/dev/null 2>&1 || true' EXIT
else
  echo "ERROR: local ADB endpoint tcp:8022 is already owned or unavailable" >&2
  exit 1
fi

echo "== verify owner-started Termux sshd =="
if ! run_termux 'true' >/dev/null 2>&1; then
  echo "USER_ACTION_REQUIRED kind=termux_sshd purpose=phone_runtime_recovery" >&2
  echo "Open Termux on the unlocked phone, run sshd, then rerun this helper." >&2
  exit 2
fi

echo "== start shizuku_server (dies each boot; the hidden-display privilege broker) =="
APK=$(adb shell "pm path moe.shizuku.privileged.api" 2>/dev/null | tr -d '\r' | sed 's/package://' | head -1)
if [ -n "$APK" ]; then
  adb shell "$(dirname "$APK")/lib/arm64/libshizuku.so" 2>&1 | grep -i "shizuku_server pid" || true
else
  echo "  WARN: Shizuku app not found"
fi
sleep 3

echo "== (re)start the Evogent server in tmux =="
run_termux 'bash ~/restart-evo.sh' 2>&1 | grep -v "Permanently added" | tail -1

echo "== wait for the server to actually serve the home page (not just boot) =="
code=000
for i in $(seq 1 30); do
  code=$(run_termux '~/phone-tools/evo-health >/dev/null 2>&1 && echo 200 || echo 000' 2>/dev/null | grep -v Permanently | tail -1)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "  home page: $code"

echo "== ensure the on-device periodic scheduler is running =="
# Periodic due-source browse and curation are driven on-device by evogent-scheduler.sh in its
# own tmux session. Idempotent: only starts if not already up.
run_termux 'tmux has-session -t "=evo-sched" 2>/dev/null && echo "  scheduler: already running" || { tmux new -d -s evo-sched "bash ~/phone-tools/evogent-scheduler.sh"; echo "  scheduler: started"; }' 2>&1 | grep -v "Permanently added" | tail -1

echo "== probe owner-controlled accessibility capability =="
home=$(run_termux '~/phone-tools/evo-health >/dev/null 2>&1 && echo 200 || echo 000' 2>/dev/null | grep -v Permanently | tail -1)
a11y=unavailable
if run_termux 'bash ~/phone-tools/a11y-heal.sh' >/dev/null 2>&1; then
  a11y=ready
else
  echo "USER_ACTION_REQUIRED kind=android_accessibility_access purpose=background_app_browsing" >&2
  echo "Enable Evogent visibly in Android Settings > Accessibility when you want background app browsing; this helper will not grant or regrant it." >&2
fi

echo "== FINAL health =="
echo "  home page:   $home"
echo "  accessibility: $a11y"
echo "  shizuku:     $(adb shell 'ps -A 2>/dev/null | grep -c shizuku_server' | tr -d '\r') running"
if [ "$home" = "200" ]; then
  echo "DONE — the private phone server is healthy."
else
  echo "WARN — the private phone server did not become healthy; inspect the Evogent runtime logs."
fi
