#!/data/data/com.termux/files/usr/bin/bash
# a11y-heal.sh — self-heal the Evogent accessibility service before computer-use work.
# A force-stopped or updated APK can leave the a11y service DISABLED, which silently zeroes
# every browse ("did not land on any display", empty `see` trees) and reads as app failure.
# Android may clear `enabled_accessibility_services` after an `am force-stop`.
# The shell uid (Shizuku rish) can re-enable it without touching the screen.
set -u
TOOLS="$HOME/phone-tools"
SVC="net.dangish.evogent/.EvogentAccessibilityService"
. "$TOOLS/control-plane.sh"

probe(){ bash "$TOOLS/phone.sh" health >/dev/null 2>&1; }

# Also (re)grant notification-listener access — free to attempt, self-heals after an APK
# reinstall drops the grant. Runs regardless of a11y state; it uses its own Shizuku path.
bash "$TOOLS/grant-notification-access.sh" >/dev/null 2>&1 || true

if probe; then
  exit 0   # a11y service answering; nothing more to do
fi

echo "[a11y-heal] a11y service not answering — re-arming via rish" >&2
control_rish_bounded \
  "settings put secure enabled_accessibility_services $SVC; settings put secure accessibility_enabled 1" 2>/dev/null
sleep 5
if probe; then
  echo "[a11y-heal] re-armed OK" >&2
  exit 0
fi
echo "[a11y-heal] still not answering after re-arm — browses will fail this run" >&2
exit 1
