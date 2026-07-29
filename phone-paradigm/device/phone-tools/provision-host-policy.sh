#!/data/data/com.termux/files/usr/bin/bash
# Explicit, reversible technical-user provisioning for Android policy required by the current
# Termux + hidden-display runtime. Ordinary boot and cycles are read-only with respect to these
# settings. Nothing is changed unless the owner/assisting agent deliberately invokes --apply.
set -euo pipefail

TOOLS="$HOME/phone-tools"
STATE="$TOOLS/.host-policy-before.json"
ACTION="${1:---status}"

. "$TOOLS/control-plane.sh"
control_init_owner host-policy-provision
cleanup(){
  local rc=$?
  trap - EXIT INT TERM HUP
  control_finish_owner
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

rish_read(){
  control_rish_bounded \
    'printf "phantom=%s desktop=%s freeform=%s\n" "$(settings get global settings_enable_monitor_phantom_procs)" "$(settings get global force_desktop_mode_on_external_displays)" "$(settings get global enable_freeform_support)"'
}

read_values(){
  local record
  record=$(rish_read)
  if [[ "$record" =~ ^phantom=(true|false|null|0|1)[[:space:]]desktop=(0|1|null)[[:space:]]freeform=(0|1|null)$ ]]; then
    PHANTOM_VALUE="${BASH_REMATCH[1]}"
    DESKTOP_VALUE="${BASH_REMATCH[2]}"
    FREEFORM_VALUE="${BASH_REMATCH[3]}"
    return 0
  fi
  echo "Host-policy state could not be read safely." >&2
  return 1
}

load_saved_values(){
  local record
  record=$(python3 - "$STATE" <<'PY'
import json
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(path, flags)
try:
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or metadata.st_size < 2
        or metadata.st_size > 1024
    ):
        raise SystemExit("saved host policy has unsafe metadata")
    os.fchmod(descriptor, 0o600)
    encoded = b""
    while len(encoded) < metadata.st_size:
        chunk = os.read(descriptor, metadata.st_size - len(encoded))
        if not chunk:
            raise SystemExit("saved host policy ended before its proven size")
        encoded += chunk
finally:
    os.close(descriptor)
value = json.loads(encoded.decode("utf-8"))
if value.get("schemaVersion") != 1 or set(value.get("settings", {})) != {
    "settings_enable_monitor_phantom_procs",
    "force_desktop_mode_on_external_displays",
    "enable_freeform_support",
}:
    raise SystemExit("saved host policy has an unknown schema")
settings = value["settings"]
phantom = settings["settings_enable_monitor_phantom_procs"]
desktop = settings["force_desktop_mode_on_external_displays"]
freeform = settings["enable_freeform_support"]
if phantom not in {"true", "false", "null", "0", "1"}:
    raise SystemExit("saved phantom-process policy is invalid")
if desktop not in {"0", "1", "null"} or freeform not in {"0", "1", "null"}:
    raise SystemExit("saved windowing policy is invalid")
print(f"{phantom}\t{desktop}\t{freeform}")
PY
  )
  IFS=$'\t' read -r SAVED_PHANTOM SAVED_DESKTOP SAVED_FREEFORM <<< "$record"
}

save_original_once(){
  if [ -e "$STATE" ] || [ -L "$STATE" ]; then
    # A prior explicit apply owns the original snapshot. It must be fully safe and parseable
    # before another mutation may proceed; never replace or ignore corrupt reversal authority.
    load_saved_values
    return
  fi
  python3 - "$STATE" "$PHANTOM_VALUE" "$DESKTOP_VALUE" "$FREEFORM_VALUE" <<'PY'
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
payload = {
    "schemaVersion": 1,
    "settings": {
        "settings_enable_monitor_phantom_procs": sys.argv[2],
        "force_desktop_mode_on_external_displays": sys.argv[3],
        "enable_freeform_support": sys.argv[4],
    },
}
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(path, flags, 0o600)
try:
    encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
    offset = 0
    while offset < len(encoded):
        written = os.write(descriptor, encoded[offset:])
        if written <= 0:
            raise OSError("short write while saving host policy")
        offset += written
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
directory = os.open(path.parent, os.O_RDONLY)
try:
    # This snapshot is the only reversal authority for external Android policy. Unlike a
    # post-provider cadence stamp, losing its directory entry can strand a mutation, so an
    # unsupported or failed parent fsync must stop before any settings write.
    os.fsync(directory)
finally:
    os.close(directory)
PY
  load_saved_values
}

write_setting(){
  local key="$1" value="$2"
  if [ "$value" = null ]; then
    control_rish_bounded "settings delete global $key" >/dev/null
  else
    control_rish_bounded "settings put global $key $value" >/dev/null
  fi
}

write_values(){
  local phantom="$1" desktop="$2" freeform="$3"
  write_setting settings_enable_monitor_phantom_procs "$phantom" || return
  write_setting force_desktop_mode_on_external_displays "$desktop" || return
  write_setting enable_freeform_support "$freeform"
}

write_values_best_effort(){
  local phantom="$1" desktop="$2" freeform="$3" rc=0
  write_setting settings_enable_monitor_phantom_procs "$phantom" || rc=1
  write_setting force_desktop_mode_on_external_displays "$desktop" || rc=1
  write_setting enable_freeform_support "$freeform" || rc=1
  return "$rc"
}

values_are(){
  local expected_phantom="$1" expected_desktop="$2" expected_freeform="$3"
  read_values || return
  [ "$PHANTOM_VALUE" = "$expected_phantom" ] &&
    [ "$DESKTOP_VALUE" = "$expected_desktop" ] &&
    [ "$FREEFORM_VALUE" = "$expected_freeform" ]
}

rollback_or_critical(){
  local phantom="$1" desktop="$2" freeform="$3"
  if write_values_best_effort "$phantom" "$desktop" "$freeform" \
      && values_are "$phantom" "$desktop" "$freeform"; then
    echo "Host-policy transaction rolled back to its pre-command state." >&2
    return 0
  fi
  echo "CRITICAL: host-policy transaction failed and rollback could not be verified." >&2
  return 70
}

case "$ACTION" in
  --status)
    read_values
    printf 'HOST_POLICY phantom=%s desktop=%s freeform=%s\n' \
      "$PHANTOM_VALUE" "$DESKTOP_VALUE" "$FREEFORM_VALUE"
    ;;
  --apply)
    read_values
    before_phantom="$PHANTOM_VALUE"
    before_desktop="$DESKTOP_VALUE"
    before_freeform="$FREEFORM_VALUE"
    save_original_once
    if ! write_values false 1 1; then
      echo "Host-policy apply failed; rolling back this command." >&2
      rollback_or_critical "$before_phantom" "$before_desktop" "$before_freeform" ||
        exit $?
      exit 1
    fi
    if ! values_are false 1 1; then
      echo "Host-policy apply could not be verified; rolling back this command." >&2
      rollback_or_critical "$before_phantom" "$before_desktop" "$before_freeform" ||
        exit $?
      exit 1
    fi
    echo "HOST_POLICY_APPLIED reversible_state=$STATE"
    ;;
  --restore)
    read_values
    before_phantom="$PHANTOM_VALUE"
    before_desktop="$DESKTOP_VALUE"
    before_freeform="$FREEFORM_VALUE"
    load_saved_values || {
      echo "No safe saved host-policy state is available." >&2
      exit 1
    }
    if ! write_values "$SAVED_PHANTOM" "$SAVED_DESKTOP" "$SAVED_FREEFORM"; then
      echo "Host-policy restore failed; rolling back this command." >&2
      rollback_or_critical "$before_phantom" "$before_desktop" "$before_freeform" ||
        exit $?
      exit 1
    fi
    if ! values_are "$SAVED_PHANTOM" "$SAVED_DESKTOP" "$SAVED_FREEFORM"; then
      echo "Host-policy restore could not be verified; rolling back this command." >&2
      rollback_or_critical "$before_phantom" "$before_desktop" "$before_freeform" ||
        exit $?
      exit 1
    fi
    echo "HOST_POLICY_RESTORED"
    ;;
  *)
    echo "usage: provision-host-policy.sh --status | --apply | --restore" >&2
    exit 64
    ;;
esac
