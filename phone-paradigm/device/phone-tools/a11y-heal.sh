#!/data/data/com.termux/files/usr/bin/bash
# a11y-heal.sh — legacy-named, read-only accessibility prerequisite probe.
#
# Accessibility is an owner-granted Android capability. A force-stop, APK update, or owner
# revocation can leave the service unavailable; ordinary boot and browse cycles must detect that
# state and defer app-backed work, never rewrite secure settings or silently restore the grant.
set -u
TOOLS="$HOME/phone-tools"
BASE="http://127.0.0.1:${PORT:-3001}"
EVO_CURL="$TOOLS/evo-curl"
ACTION_ID="accessibility-action-required"
INCIDENT_DIR="$TOOLS/.incident-accessibility-action-required"

probe(){ bash "$TOOLS/phone.sh" health >/dev/null 2>&1; }
surface_owner_action(){
  [ -x "$EVO_CURL" ] || return 1
  if ! mkdir -m 700 "$INCIDENT_DIR" 2>/dev/null; then
    [ -d "$INCIDENT_DIR" ] && [ ! -L "$INCIDENT_DIR" ]
    return
  fi
  if ! "$EVO_CURL" -fsS -m8 -X POST "$BASE/api/internal/curate/submit" \
    -H 'content-type: application/json' \
    -d '{
      "items":[{
        "type":"notification",
        "source":"phone",
        "sourceId":"accessibility-action-required",
        "title":"Background app browsing needs Accessibility access",
        "text":"Evogent left this owner-controlled capability off. To resume app-backed browsing, open Android Settings > Accessibility and enable Evogent; or turn Background Source Browsing off in Evogent if you do not want this integration.",
        "metadata":{
          "notificationId":"accessibility-action-required",
          "incidentKey":"phone-capability-accessibility",
          "reactivateOnRepeat":true,
          "severity":"warning",
          "userActionKind":"android_accessibility_access"
        }
      }]
    }' >/dev/null 2>&1; then
    rmdir "$INCIDENT_DIR" 2>/dev/null || true
    return 1
  fi
}
clear_owner_action(){
  [ -x "$EVO_CURL" ] || return 1
  [ -d "$INCIDENT_DIR" ] && [ ! -L "$INCIDENT_DIR" ] || return 0
  "$EVO_CURL" -fsS -m8 -X POST "$BASE/api/internal/notifications/resolve" \
    -H 'content-type: application/json' \
    -d "{\"notificationId\":\"$ACTION_ID\"}" >/dev/null 2>&1 || return 1
  rmdir "$INCIDENT_DIR" 2>/dev/null
}

if [ "${EVOGENT_CAPABILITY_FEATURE_ENABLED:-1}" = 0 ]; then
  clear_owner_action || true
  exit 0
fi

if probe; then
  clear_owner_action || true
  exit 0
fi

echo "[a11y-probe] USER_ACTION_REQUIRED kind=android_accessibility_access purpose=background_app_browsing" >&2
echo "[a11y-probe] Evogent accessibility is not responding. Re-enable it in Android Settings; Evogent will not grant or regrant it automatically. App-backed browsing is deferred." >&2
surface_owner_action || true
exit 1
