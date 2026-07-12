#!/data/data/com.termux/files/usr/bin/bash
# Grant Evogent's NotificationListenerService access WITHOUT any Settings dialog, via the
# Shizuku shell uid (same channel that grants the hidden-display / a11y capabilities). The
# listener reads ONLY allowlisted content-app notifications (privacy enforced in the service
# itself). Idempotent: appends to enabled_notification_listeners only if absent.
set -u
COMP="net.dangish.evogent/net.dangish.evogent.EvogentNotificationListenerService"
rish(){ RISH_APPLICATION_ID=com.termux "$HOME/rish-bin/rish" -c "$1" 2>/dev/null; }

CUR="$(rish 'settings get secure enabled_notification_listeners')"
if echo "$CUR" | grep -q "net.dangish.evogent/.*NotificationListenerService"; then
  echo "[grant-notif] already granted"
  exit 0
fi

# Prefer the first-class command when present (Android 12+); fall back to editing the setting.
if rish 'cmd notification --help 2>&1 | grep -q allow_listener' >/dev/null 2>&1 || \
   rish 'cmd notification 2>&1 | grep -q allow_listener' >/dev/null 2>&1; then
  rish "cmd notification allow_listener $COMP" >/dev/null 2>&1
fi

CUR="$(rish 'settings get secure enabled_notification_listeners')"
if ! echo "$CUR" | grep -q "net.dangish.evogent/.*NotificationListenerService"; then
  if [ -z "$CUR" ] || [ "$CUR" = "null" ]; then NEW="$COMP"; else NEW="$CUR:$COMP"; fi
  rish "settings put secure enabled_notification_listeners '$NEW'" >/dev/null 2>&1
fi

CUR="$(rish 'settings get secure enabled_notification_listeners')"
if echo "$CUR" | grep -q "net.dangish.evogent/.*NotificationListenerService"; then
  echo "[grant-notif] granted"
  exit 0
fi
echo "[grant-notif] FAILED to grant (Shizuku down?)"
exit 1
