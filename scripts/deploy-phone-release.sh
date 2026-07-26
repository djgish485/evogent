#!/usr/bin/env bash
# Copy a complete release to a connected phone and invoke its transactional installer.
# Device-specific values are required through the environment and are never stored here.
set -euo pipefail
umask 077

ARCHIVE="${1:?usage: deploy-phone-release.sh <release.tar.gz>}"
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"
ARCHIVE_NAME="$(basename "$ARCHIVE")"
[[ "$ARCHIVE_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "phone deploy: release archive filename contains unsupported characters" >&2
  exit 65
}
[ -f "$ARCHIVE" ] && [ -f "$ARCHIVE.sha256" ] || {
  echo "phone deploy: archive and matching .sha256 sidecar are required" >&2
  exit 66
}
# The archive contains the release-matched TLS private key.  Tighten legacy
# outputs too, rather than trusting the builder's caller umask.
chmod 600 "$ARCHIVE" "$ARCHIVE.sha256"

: "${EVOGENT_ADB_SERIAL:?set EVOGENT_ADB_SERIAL from the private device notes}"
: "${EVOGENT_SSH_USER:?set EVOGENT_SSH_USER from the private device notes}"
[[ "$EVOGENT_SSH_USER" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "phone deploy: EVOGENT_SSH_USER is invalid" >&2
  exit 65
}
: "${EVOGENT_SSH_PORT:?set EVOGENT_SSH_PORT from the private device notes}"
SSH_PORT="$EVOGENT_SSH_PORT"
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] && [ "$SSH_PORT" -ge 1 ] && [ "$SSH_PORT" -le 65535 ] || {
  echo "phone deploy: EVOGENT_SSH_PORT must be a valid TCP port" >&2
  exit 65
}
REMOTE_DIR=".cache/evogent-release-incoming"
REMOTE_ARCHIVE="$REMOTE_DIR/$ARCHIVE_NAME"
EXPECTED_SHA256="$(awk 'NR == 1 { print $1 }' "$ARCHIVE.sha256")"
[[ "$EXPECTED_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo "phone deploy: invalid archive checksum sidecar" >&2
  exit 65
}

SSH_OPTIONS=(
  -p "$SSH_PORT"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=15
  -o LogLevel=ERROR
)

adb -s "$EVOGENT_ADB_SERIAL" forward "tcp:$SSH_PORT" tcp:8022 >/dev/null
ssh "${SSH_OPTIONS[@]}" "$EVOGENT_SSH_USER@127.0.0.1" \
  "umask 077; mkdir -p '$REMOTE_DIR'; chmod 700 '$REMOTE_DIR'"
scp -P "$SSH_PORT" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "$ARCHIVE" "$EVOGENT_SSH_USER@127.0.0.1:$REMOTE_ARCHIVE"
ssh "${SSH_OPTIONS[@]}" "$EVOGENT_SSH_USER@127.0.0.1" \
  "chmod 600 '$REMOTE_ARCHIVE'"

# Bootstrap from the bundle itself, so the first versioned install does not
# depend on whichever partial deploy script happens to be on the phone.
ssh "${SSH_OPTIONS[@]}" "$EVOGENT_SSH_USER@127.0.0.1" \
  "tar -xOf '$REMOTE_ARCHIVE' release/device/install-release.sh > '$REMOTE_DIR/install-release.sh' \
   && chmod 700 '$REMOTE_DIR/install-release.sh' \
   && bash '$REMOTE_DIR/install-release.sh' '$REMOTE_ARCHIVE' '$EXPECTED_SHA256' \
   && rm -f '$REMOTE_ARCHIVE' '$REMOTE_DIR/install-release.sh'"
