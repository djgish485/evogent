#!/bin/bash
# One-command recovery of the Evogent phone-paradigm stack after an emulator (re)boot.
# Restores the runtime bits that DON'T survive a reboot on a non-rooted emulator: Shizuku
# (dies every boot), keep-awake, the persisted settings, the server — and reloads the app
# WebView once the server is actually serving (on boot the home app loads before the server
# is up and caches "webpage not found"). Run from the Mac; needs `adb` + the Termux ssh helper.
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

echo "== keep awake / unlock =="
adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
adb shell wm dismiss-keyguard >/dev/null 2>&1
adb shell "svc power stayon true" >/dev/null 2>&1
adb shell "dumpsys battery set ac 1" >/dev/null 2>&1

echo "== phantom-process killer OFF (keeps Termux bg procs alive) =="
adb shell "settings put global settings_enable_monitor_phantom_procs false" >/dev/null 2>&1
adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent" >/dev/null 2>&1
adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647" >/dev/null 2>&1

echo "== Termux background-activity-launch exemption =="
adb shell "appops set com.termux SYSTEM_ALERT_WINDOW allow" >/dev/null 2>&1

echo "== default home = Evogent (no 'Select a Home app' chooser) =="
adb shell "cmd package set-home-activity net.dangish.evogent/.MainActivity" >/dev/null 2>&1

echo "== start Termux + sshd (a cold boot has nothing running) =="
if [ "$(adb shell 'ps -A 2>/dev/null | grep -c sshd' | tr -d '\r')" = "0" ]; then
  adb shell "am start -n com.termux/.app.TermuxActivity" >/dev/null 2>&1; sleep 6
  adb shell input text 'sshd' >/dev/null 2>&1; adb shell input keyevent 66 >/dev/null 2>&1; sleep 3
fi
adb forward tcp:8022 tcp:8022 >/dev/null 2>&1

SVC="net.dangish.evogent/net.dangish.evogent.EvogentAccessibilityService"

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
# The deployed build's adaptive heartbeat dispatches automatic curation through the removed
# /api/openclaw/chat endpoint (404), so periodic source-browse + curation are driven on-device
# by evogent-scheduler.sh in its own tmux session. Idempotent: only starts if not already up.
run_termux 'tmux has-session -t evo-sched 2>/dev/null && echo "  scheduler: already running" || { tmux new -d -s evo-sched "bash ~/phone-tools/evogent-scheduler.sh"; echo "  scheduler: started"; }' 2>&1 | grep -v "Permanently added" | tail -1

echo "== CONVERGE: reload WebView + a11y until BOTH the feed serves AND a11y actually responds =="
# Every force-stop can disable the a11y service (Android drops a service it thinks crashed),
# and the boot-time WebView caches "webpage not found". So we loop: assert the a11y setting,
# force-stop + relaunch (fresh WebView against the ready server AND reconnects the a11y service),
# then VERIFY a11y responds over the loopback (bytes>0) and the home page is 200. Only stop when
# both hold — never trust the setting string alone.
a11y_bytes=0; home=000
for attempt in 1 2 3 4 5; do
  # ORDER MATTERS: force-stop FIRST, then set the a11y setting, then start. Setting the a11y
  # value and THEN force-stopping drops the service; force-stop -> put -> start reconnects it.
  adb shell "am force-stop net.dangish.evogent" >/dev/null 2>&1; sleep 1
  adb shell "settings put secure enabled_accessibility_services $SVC" >/dev/null 2>&1
  adb shell "settings put secure accessibility_enabled 1" >/dev/null 2>&1
  adb shell "am start -n net.dangish.evogent/.MainActivity" >/dev/null 2>&1; sleep 6
  home=$(run_termux '~/phone-tools/evo-health >/dev/null 2>&1 && echo 200 || echo 000' 2>/dev/null | grep -v Permanently | tail -1)
  a11y_bytes=$(run_termux 'bash ~/phone-tools/a11y-check.sh' 2>/dev/null | grep -v Permanently | tr -dc '0-9')
  echo "  attempt $attempt: home=$home a11y_bytes=${a11y_bytes:-0}"
  [ "$home" = "200" ] && [ "${a11y_bytes:-0}" -gt 0 ] 2>/dev/null && break
done

echo "== FINAL health =="
echo "  home page:   $home"
echo "  a11y responds: ${a11y_bytes:-0} bytes  (>0 = service connected)"
echo "  shizuku:     $(adb shell 'ps -A 2>/dev/null | grep -c shizuku_server' | tr -d '\r') running"
if [ "$home" = "200" ] && [ "${a11y_bytes:-0}" -gt 0 ] 2>/dev/null; then
  echo "DONE — feed loads AND accessibility responds; background browse will work."
else
  echo "WARN — did not converge; a11y or server still not healthy. Re-run or check manually."
fi
