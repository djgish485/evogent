#!/data/data/com.termux/files/usr/bin/bash
# Transactionally install one host-built Evogent phone release.
#
# Usage: install-release.sh <evogent-phone-*.tar.gz> <archive-sha256>
#
# One atomic `current` link selects both the web runtime and phone mechanics.
# Private data, Android-built node_modules, and phone control state live outside
# releases and survive every switch.
set -euo pipefail
umask 077

RECOVERY_JOURNAL_ARG=""
if [ "${1:-}" = "--recover" ]; then
  RECOVERY_JOURNAL_ARG="${2:?transaction journal required}"
  ARCHIVE=""
  EXPECTED_ARCHIVE_SHA256=""
else
  ARCHIVE="${1:?release archive required}"
  EXPECTED_ARCHIVE_SHA256="${2:?expected archive sha256 required}"
  [[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "release install: expected archive SHA-256 is invalid" >&2
    exit 65
  }
  [ -f "$ARCHIVE" ] || {
    echo "release install: archive not found" >&2
    exit 66
  }
  chmod 600 "$ARCHIVE"
  [ "$(stat -c '%a' "$ARCHIVE")" = 600 ] || {
    echo "release install: archive containing TLS key is not mode 0600" >&2
    exit 66
  }
fi

ROOT="${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"
RELEASES="$ROOT/releases"
STATE="$ROOT/state"
DEPENDENCIES="$STATE/dependencies"
DEPENDENCY_BUILDS="$STATE/dependency-builds"
DEPENDENCY_QUARANTINE="$STATE/dependency-quarantine"
RELEASE_CANDIDATES="$STATE/release-candidates"
PHONE_STATE="$STATE/phone-tools"
CURRENT="$ROOT/current"
STAGING_ROOT="$ROOT/staging"
BACKUPS="$ROOT/backups"
MIGRATIONS="$ROOT/migrations"
LOGS="$ROOT/logs"
INSTALL_LOCK="$ROOT/install.lock"
TRANSACTION_DIR="$ROOT/install-transaction"
TRANSACTION_JOURNAL="$TRANSACTION_DIR/journal.json"
TRANSACTION_RECOVERER="$TRANSACTION_DIR/install-release.sh"
PACKAGE_NAME="net.dangish.evogent"
APP_CONTROL_TOKEN_PATH="/sdcard/Android/data/$PACKAGE_NAME/files/control-token.txt"
PHONE_PORT="${PORT:-3001}"
PHONE_HTTPS_PORT=3443
HEALTH_URL="${EVOGENT_PHONE_HEALTH_URL:-http://127.0.0.1:${PHONE_PORT}/api/internal/phone-health}"
FEED_URL="${EVOGENT_PHONE_FEED_URL:-http://127.0.0.1:${PHONE_PORT}/api/feed?limit=1}"
DEPLOYMENT_URL="${EVOGENT_PHONE_DEPLOYMENT_URL:-http://127.0.0.1:${PHONE_PORT}/api/internal/deployment-status}"
INSTALL_WAIT_SECONDS="${EVOGENT_INSTALL_WAIT_SECONDS:-21600}"
KEEP_RELEASES="${EVOGENT_KEEP_RELEASES:-5}"
KEEP_BACKUPS="${EVOGENT_KEEP_BACKUPS:-7}"
KEEP_LOGS="${EVOGENT_KEEP_INSTALL_LOGS:-20}"
for numeric in "$INSTALL_WAIT_SECONDS" "$KEEP_RELEASES" "$KEEP_BACKUPS" "$KEEP_LOGS"; do
  [[ "$numeric" =~ ^[0-9]+$ ]] || {
    echo "release install: numeric configuration is invalid" >&2
    exit 65
  }
done

mkdir -p "$RELEASES" "$STATE" "$DEPENDENCIES" "$DEPENDENCY_BUILDS" \
  "$DEPENDENCY_QUARANTINE" "$RELEASE_CANDIDATES" "$STAGING_ROOT" \
  "$BACKUPS" "$MIGRATIONS" "$LOGS" "$TRANSACTION_DIR"
chmod 700 "$TRANSACTION_DIR"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
LOG="$LOGS/install-$STAMP-$$.log"
exec > >(tee -a "$LOG") 2>&1

say() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

evo_curl() {
  local client candidate
  for candidate in \
    "${NEW_RELEASE:-}/phone-tools/evo-curl" \
    "$HOME/phone-tools/evo-curl"; do
    if [ -x "$candidate" ]; then
      client="$candidate"
      break
    fi
  done
  [ -n "${client:-}" ] || {
    say "authenticated Evogent HTTP client is unavailable"
    return 127
  }
  EVOGENT_PHONE_TOOLS="$(dirname "$client")" "$client" "$@"
}

loopback_port_open() {
  local probe_port="${1:-$PHONE_PORT}"
  python3 - "$probe_port" <<'PY' >/dev/null 2>&1
import socket
import sys
with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=1):
    pass
PY
}

phone_ports_open() {
  loopback_port_open "$PHONE_PORT" || loopback_port_open "$PHONE_HTTPS_PORT"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fsync_regular_file_and_parent() {
  python3 - "$1" <<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
descriptor = os.open(
    path,
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0),
)
try:
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        raise SystemExit("durability target is not a regular file")
    os.fsync(descriptor)
finally:
    os.close(descriptor)
directory = os.open(
    path.parent,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

fsync_directory() {
  python3 - "$1" <<'PY'
import os
import pathlib
import sys

directory = os.open(
    pathlib.Path(sys.argv[1]),
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

proc_start() {
  local pid="${1:-}" stat
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ -r "/proc/$pid/stat" ] || return 1
  stat=$(<"/proc/$pid/stat") || return 1
  printf '%s\n' "${stat##*) }" | awk '{print $20}'
}

pid_matches() {
  local pid="${1:-}" expected="${2:-}" actual
  [ -n "$expected" ] || return 1
  actual="$(proc_start "$pid" 2>/dev/null)" || return 1
  [ "$actual" = "$expected" ]
}

meta_field() {
  sed -n "s/^${2}=//p" "$1" 2>/dev/null | head -1
}

lock_live() {
  local lock="$1" pid start
  [ -d "$lock" ] || return 1
  if [ -f "$lock/owner" ]; then
    pid="$(meta_field "$lock/owner" pid)"
    start="$(meta_field "$lock/owner" start)"
    pid_matches "$pid" "$start"
    return
  fi
  # Legacy cycle locks had no owner metadata. They are always treated as live:
  # age alone is never grounds to kill work. An interrupted install-lock mkdir
  # window is reclaimable only after it is no longer recent.
  case "$lock" in
    *.cycle.lock) return 0 ;;
  esac
  [ -n "$(find "$lock" -maxdepth 0 -mmin -2 2>/dev/null)" ]
}

acquire_lock_dir() {
  local lock="$1" label="$2" deadline=$(( $(date +%s) + INSTALL_WAIT_SECONDS ))
  local stale="$lock.stale.$$" self_start
  self_start="$(proc_start "$$")"
  while ! mkdir "$lock" 2>/dev/null; do
    if ! lock_live "$lock"; then
      if mv "$lock" "$stale" 2>/dev/null; then
        rm -rf -- "$stale"
        continue
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      say "timed out waiting for $label"
      return 1
    fi
    sleep 2
  done
  {
    printf 'owner=release-install-%s-%s\n' "$$" "$self_start"
    printf 'pid=%s\n' "$$"
    printf 'start=%s\n' "$self_start"
    printf 'label=%s\n' "$label"
    printf 'acquired=%s\n' "$(date +%s)"
  } > "$lock/owner.tmp"
  mv "$lock/owner.tmp" "$lock/owner"
}

release_lock_dir() {
  local lock="$1" pid start
  [ -d "$lock" ] || return 0
  pid="$(meta_field "$lock/owner" pid)"
  start="$(meta_field "$lock/owner" start)"
  [ "$pid" = "$$" ] && pid_matches "$pid" "$start" && rm -rf -- "$lock"
}

INSTALL_LOCK_HELD=0
CYCLE_GATE=""
CYCLE_GATE_HELD=0
STAGE=""
RELEASE_ID=""
NEW_RELEASE=""
PREVIOUS_TARGET=""
BACKUP_DIR=""
DB_BACKUP=""
DB_BACKUP_READY=0
APK_BACKUP=""
APK_BACKUP_READY=0
APK_CHANGED=0
APK_INSTALL_ATTEMPTED=0
PACKAGE_OPERATION=""
PREVIOUS_APK_CODE=""
PREVIOUS_APK_SIGNER=""
ROLLBACK_FAILED=0
ROLLBACK_ATTEMPTED=0
REARM_PRIOR_CONTROL_PLANE=0
SWITCH_STARTED=0
QUIESCED=0
CONTROL_PLANE_MUTATION_STARTED=0
INITIAL_MIGRATION=0
MIGRATION_STARTED=0
MIGRATION_DIR=""
SUCCESS=0
RECOVERY_ACTIVE=0
CONTROL_TOKEN="$STATE/data/control-token.txt"
CONTROL_TOKEN_BACKUP=""
CONTROL_TOKEN_EXISTED=0
CONTROL_TOKEN_BACKUP_READY=0
TRANSACTION_PHASE=""
TRANSACTION_JOURNAL_WRITTEN=0
DEPENDENCY_BUILD=""
DEPENDENCY_STATE_HELPER=""
ROLLBACK_STATE_HELPER=""

stop_tmux_session() {
  local name="$1"
  tmux has-session -t "$name" 2>/dev/null || return 0
  tmux kill-session -t "$name" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    tmux has-session -t "$name" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

stop_and_prove_runtime() {
  stop_tmux_session evo || return 1
  for _ in $(seq 1 20); do
    phone_ports_open || return 0
    sleep 1
  done
  say "one of the server ports is still owned after the scoped evo session stopped"
  return 1
}

stop_scoped_lock_owner() {
  local lock="$1" expected_label="$2" pid start label
  [ -f "$lock/owner" ] || return 0
  pid="$(meta_field "$lock/owner" pid)"
  start="$(meta_field "$lock/owner" start)"
  label="$(meta_field "$lock/owner" label)"
  [ "$label" = "$expected_label" ] || {
    say "refusing to stop unexpected $expected_label lock owner (label=$label)"
    return 1
  }
  pid_matches "$pid" "$start" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    pid_matches "$pid" "$start" || return 0
    sleep 1
  done
  kill -KILL "$pid" 2>/dev/null || true
  for _ in $(seq 1 5); do
    pid_matches "$pid" "$start" || return 0
    sleep 1
  done
  return 1
}

stop_scoped_watchdog() {
  local lock="$HOME/phone-tools/.watchdog.lock" pid cmd
  if [ -f "$lock/owner" ]; then
    stop_scoped_lock_owner "$lock" watchdog
    return
  fi

  # Compatibility with the pre-control-plane watchdog. Verify its exact script
  # before touching the PID; never use a name or command-pattern kill.
  if [ -f "$HOME/phone-tools/.watchdog.pid" ]; then
    pid="$(tr -dc '0-9' < "$HOME/phone-tools/.watchdog.pid")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && [ -r "/proc/$pid/cmdline" ]; then
      cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
      case "$cmd" in
        *"/phone-tools/evogent-watchdog.sh"*)
          kill -TERM "$pid" 2>/dev/null || true
          ;;
      esac
    fi
  fi
}

quiesce_control_plane() {
  local scheduler_lock="$HOME/phone-tools/.scheduler.lock"
  local watchdog_lock="$HOME/phone-tools/.watchdog.lock"
  for _ in $(seq 1 3); do
    stop_tmux_session evo-sched
    stop_scoped_lock_owner "$scheduler_lock" scheduler
    stop_scoped_watchdog
    sleep 1
    if ! tmux has-session -t evo-sched 2>/dev/null \
        && ! lock_live "$scheduler_lock" \
        && ! lock_live "$watchdog_lock"; then
      return 0
    fi
  done
  say "scheduler/watchdog control plane could not be quiesced safely"
  return 1
}

rish_command() {
  local command="$1" rish_bin="$HOME/rish-bin/rish"
  [ -x "$rish_bin" ] || return 1
  if command -v setsid >/dev/null 2>&1; then
    # Force rish to fork away from an inherited SSH/PTY session, then wait for
    # the actual Android-shell child. Without -f/-w a detached caller can see
    # success before a large stream or package-manager mutation has finished.
    setsid -f -w env RISH_APPLICATION_ID=com.termux \
      "$rish_bin" -c "$command" </dev/null
  else
    env RISH_APPLICATION_ID=com.termux "$rish_bin" -c "$command" </dev/null
  fi
}

allocate_shell_staging_file() {
  local purpose="$1" operation="" path="" nonce="" attempt probe
  case "$purpose" in
    control-token|installed-apk|package-version|rollback-dump) ;;
    *) return 1 ;;
  esac
  for attempt in $(seq 1 3); do
    nonce="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
    [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || return 1
    operation="/data/local/tmp/evogent-${purpose}.${nonce}"
    path="$operation/payload"
    rish_command \
      "mkdir -m 0700 '$operation' && : > '$path' && chmod 0600 '$path' && chmod 0711 '$operation'" \
      >/dev/null 2>&1 || true
    for probe in $(seq 1 100); do
      if [ -d "$operation" ] && [ ! -L "$operation" ] \
          && [ -f "$path" ] && [ ! -L "$path" ] \
          && [ "$(stat -c '%a' "$operation" 2>/dev/null || true)" = 711 ] \
          && [ "$(stat -c '%a' "$path" 2>/dev/null || true)" = 600 ]; then
        printf '%s\n' "$path"
        return 0
      fi
      sleep 0.1
    done
    rish_command "rm -rf '$operation'" >/dev/null 2>&1 || true
  done
  return 1
}

remove_shell_staging_file() {
  local path="$1" operation
  [[ "$path" =~ ^/data/local/tmp/evogent-(control-token|installed-apk|package-version|rollback-dump)\.[0-9a-f]{32}/payload$ ]] \
    || return 1
  operation="${path%/payload}"
  rish_command "rm -rf '$operation'" >/dev/null 2>&1
}

copy_published_shell_file() {
  local source="$1" destination="$2" attempts="${3:-100}" probe
  local partial="${destination}.bridge.$$"
  [[ "$attempts" =~ ^[0-9]+$ ]] && [ "$attempts" -gt 0 ] || return 1
  [ ! -L "$destination" ] || return 1
  rm -f -- "$partial"
  for probe in $(seq 1 "$attempts"); do
    if [ -f "$source" ] && [ ! -L "$source" ] \
        && [ "$(stat -c '%a' "$source" 2>/dev/null || true)" = 644 ] \
        && cp "$source" "$partial"; then
      chmod 600 "$partial"
      mv -f -- "$partial" "$destination"
      return 0
    fi
    rm -f -- "$partial"
    sleep 0.1
  done
  return 1
}

allocate_shell_package_operation() {
  local path="" nonce="" attempt probe
  for attempt in $(seq 1 3); do
    nonce="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
    [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || return 1
    path="/data/local/tmp/evogent-package-op.${nonce}"
    rish_command \
      "mkdir -m 0700 '$path' && : > '$path/candidate.apk' && chmod 0666 '$path/candidate.apk' && chmod 0711 '$path'" \
      >/dev/null 2>&1 || true
    for probe in $(seq 1 100); do
      if [ -d "$path" ] && [ ! -L "$path" ] \
          && [ -f "$path/candidate.apk" ] && [ ! -L "$path/candidate.apk" ] \
          && [ "$(stat -c '%a' "$path" 2>/dev/null || true)" = 711 ] \
          && [ "$(stat -c '%a' "$path/candidate.apk" 2>/dev/null || true)" = 666 ]; then
        printf '%s\n' "$path"
        return 0
      fi
      sleep 0.1
    done
    rish_command "rm -rf '$path'" >/dev/null 2>&1 || true
  done
  return 1
}

remove_shell_package_operation() {
  local path="$1" probe
  [[ "$path" =~ ^/data/local/tmp/evogent-package-op\.[0-9a-f]{32}$ ]] \
    || return 1
  rish_command "rm -rf '$path'" >/dev/null 2>&1 || true
  for probe in $(seq 1 100); do
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

read_package_result_status() {
  python3 - "$1" <<'PY'
import os
import re
import stat
import sys

path = sys.argv[1]
descriptor = os.open(
    path,
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0),
)
try:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 64:
        raise SystemExit(1)
    payload = os.read(descriptor, 65)
finally:
    os.close(descriptor)
match = re.fullmatch(rb"EVOGENT_PACKAGE_RESULT_V1\n(0|[1-9][0-9]{0,2})\n", payload)
if match is None:
    raise SystemExit(1)
status = int(match.group(1))
if status > 255:
    raise SystemExit(1)
print(status)
PY
}

package_manager_supports_apk_rollback() {
  rish_command \
    "cmd package help | grep -q -- '--enable-rollback'" \
    >/dev/null 2>&1 || return 1
  if rish_command \
      "cmd package help | grep -q -- 'rollback-app'" \
      >/dev/null 2>&1; then
    return 0
  fi

  # Android 16's Pixel package-manager help omits this hidden command even
  # though PackageManagerShellCommand implements it. With no package argument,
  # the command cannot mutate state; reaching its arity check proves dispatch.
  rish_command \
    "cmd package rollback-app 2>&1 | grep -Fq 'Argument expected after \"rollback-app\"'" \
    >/dev/null 2>&1
}

install_apk() {
  local apk="$1" mode="${2:-upgrade}" operation="" candidate=""
  local expected_apk_sha256="" install_command="" completed=0 operation_removed=0
  local private_output="$STAGE/package-manager-output.txt"
  local private_status="$STAGE/package-manager-status.txt"
  local retained_result="${LOG%.log}-package-manager.log"
  local package_status="" rish_status=0
  case "$mode" in
    upgrade)
      install_command="cmd package install -r --enable-rollback"
      ;;
    fallback)
      # Last-resort fallback only. Android native rollback is the supported
      # path; `-d` may reject non-debuggable downgrades and cannot be trusted.
      install_command="cmd package install -r -d"
      ;;
    *) return 1 ;;
  esac
  expected_apk_sha256="$(sha256_file "$apk")"
  [[ "$expected_apk_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  if [ "$mode" = fallback ] && [ -n "$PACKAGE_OPERATION" ]; then
    remove_shell_package_operation "$PACKAGE_OPERATION" || return 1
    PACKAGE_OPERATION=""
  fi
  if [ -n "$PACKAGE_OPERATION" ]; then
    [[ "$PACKAGE_OPERATION" =~ ^/data/local/tmp/evogent-package-op\.[0-9a-f]{32}$ ]] \
      || return 1
    operation="$PACKAGE_OPERATION"
    [ -d "$operation" ] && [ ! -L "$operation" ] \
      && [ -f "$operation/candidate.apk" ] \
      && [ ! -L "$operation/candidate.apk" ] || return 1
  else
    operation="$(allocate_shell_package_operation)" || return 1
    PACKAGE_OPERATION="$operation"
    if [ "${TRANSACTION_JOURNAL_WRITTEN:-0}" = 1 ]; then
      write_transaction_journal "${TRANSACTION_PHASE:-apk_install_pending}"
    fi
  fi
  candidate="$operation/candidate.apk"
  if ! cp "$apk" "$candidate" \
      || [ "$(sha256_file "$candidate")" != "$expected_apk_sha256" ]; then
    if remove_shell_package_operation "$operation"; then
      [ "$operation" != "$PACKAGE_OPERATION" ] || PACKAGE_OPERATION=""
    fi
    return 1
  fi

  # Some rish transports return before a large stdout stream or package
  # operation is complete. The shell privately rechecks immutable candidate
  # bytes, captures diagnostics, and publishes a versioned status marker last.
  # Its directory becomes traversable only after that complete marker exists.
  rish_command \
    "package_rc=125; : > '$operation/details.tmp'; if chmod 0700 '$operation' && [ -f '$candidate' ] && [ ! -L '$candidate' ] && chmod 0400 '$candidate'; then actual_sha256=\$(sha256sum '$candidate' 2>/dev/null | awk '{print \$1}'); if [ \"\$actual_sha256\" = '$expected_apk_sha256' ]; then $install_command '$candidate' > '$operation/details.tmp' 2>&1; package_rc=\$?; if [ \"\$package_rc\" -eq 0 ]; then cmd package wait-for-handler --timeout 120000 >> '$operation/details.tmp' 2>&1 && cmd package wait-for-background-handler --timeout 120000 >> '$operation/details.tmp' 2>&1 || package_rc=\$?; fi; else printf '%s\\n' 'candidate APK identity check failed' > '$operation/details.tmp'; fi; else printf '%s\\n' 'candidate APK staging check failed' > '$operation/details.tmp'; fi; rm -f '$candidate'; printf 'EVOGENT_PACKAGE_RESULT_V1\\n%s\\n' \"\$package_rc\" > '$operation/status.tmp'; chmod 0444 '$operation/details.tmp' '$operation/status.tmp' && mv '$operation/details.tmp' '$operation/details' && mv '$operation/status.tmp' '$operation/status' && chmod 0755 '$operation'; exit 0" \
    >/dev/null 2>&1 || rish_status=$?
  for _ in $(seq 1 120); do
    if [ -d "$operation" ] && [ ! -L "$operation" ] \
        && [ -f "$operation/status" ] && [ ! -L "$operation/status" ] \
        && cp "$operation/status" "$private_status" 2>/dev/null; then
      chmod 600 "$private_status"
      if package_status="$(read_package_result_status "$private_status" 2>/dev/null)"; then
        completed=1
        break
      fi
    fi
    package_status=""
    sleep 1
  done
  if [ "$completed" = 1 ] \
      && [ -f "$operation/details" ] && [ ! -L "$operation/details" ]; then
    cp "$operation/details" "$private_output" 2>/dev/null || : > "$private_output"
  else
    : > "$private_output"
  fi
  chmod 600 "$private_output"
  if [ "$completed" = 1 ]; then
    if remove_shell_package_operation "$operation"; then
      operation_removed=1
      [ "$operation" != "$PACKAGE_OPERATION" ] || PACKAGE_OPERATION=""
    fi
  fi

  if [ "$completed" = 0 ] || [ "$package_status" -ne 0 ] \
      || [ "$operation_removed" = 0 ]; then
    [ ! -e "$retained_result" ] && [ ! -L "$retained_result" ] || return 1
    {
      printf 'rishStatus=%s\n' "$rish_status"
      printf 'completionPublished=%s\n' "$completed"
      printf 'packageStatus=%s\n' "${package_status:-unavailable}"
      printf '%s\n' '--- private package-manager output ---'
      cat "$private_output"
    } > "$retained_result"
    chmod 600 "$retained_result"
    fsync_regular_file_and_parent "$retained_result"
    say "Android package installation failed; private package-manager details were retained"
    return 1
  fi
  rm -f -- "$retained_result"
}

wait_for_package_manager_idle() {
  rish_command \
    "cmd package wait-for-handler --timeout 120000 && cmd package wait-for-background-handler --timeout 120000" \
    >/dev/null 2>&1
}

backup_installed_apk() {
  local output="$1" attempt partial="${1}.partial-$$" shell_path
  rm -f -- "$partial"
  for attempt in 1 2 3; do
    shell_path="$(allocate_shell_staging_file installed-apk 2>/dev/null || true)"
    if [ -n "$shell_path" ]; then
      rish_command \
        "installed_path=\$(pm path '$PACKAGE_NAME' | sed -n 's/^package://p' | head -1); [ -n \"\$installed_path\" ] && [ -f \"\$installed_path\" ] && [ ! -L \"\$installed_path\" ] && cp \"\$installed_path\" '$shell_path' && chmod 0644 '$shell_path'" \
        >/dev/null 2>&1 || true
      if copy_published_shell_file "$shell_path" "$partial" 100 \
          && [ -s "$partial" ] \
          && unzip -tqq "$partial" >/dev/null 2>&1; then
        remove_shell_staging_file "$shell_path" || true
        mv -f -- "$partial" "$output"
        return 0
      fi
    fi
    [ -z "$shell_path" ] || remove_shell_staging_file "$shell_path" || true
    rm -f -- "$partial"
    [ "$attempt" -eq 3 ] || sleep 1
  done
  return 1
}

apk_signer_sha256() {
  local apk="$1" entry block cert der
  command -v unzip >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1 || return 1
  entry="$(unzip -Z1 "$apk" 2>/dev/null \
    | awk 'toupper($0) ~ /^META-INF\/.*\.(RSA|DSA|EC)$/ {print; exit}')"
  [ -n "$entry" ] || return 1
  block="$(mktemp "$STAGING_ROOT/signer-block.XXXXXX")"
  cert="$(mktemp "$STAGING_ROOT/signer-cert.XXXXXX")"
  der="$(mktemp "$STAGING_ROOT/signer-der.XXXXXX")"
  if ! unzip -p "$apk" "$entry" > "$block" \
      || ! openssl pkcs7 -inform DER -in "$block" -print_certs -out "$cert" 2>/dev/null \
      || ! openssl x509 -in "$cert" -outform DER > "$der" 2>/dev/null; then
    rm -f "$block" "$cert" "$der"
    return 1
  fi
  sha256_file "$der"
  rm -f "$block" "$cert" "$der"
}

installed_apk_version_code() {
  local shell_path="" private_result="$STAGE/installed-version-code.txt" code=""
  shell_path="$(allocate_shell_staging_file package-version 2>/dev/null || true)"
  [ -n "$shell_path" ] || return 1
  rish_command \
    "dumpsys package '$PACKAGE_NAME' | sed -n 's/.*versionCode=\\([0-9]*\\).*/\\1/p' | head -1 > '$shell_path' && chmod 0644 '$shell_path'" \
    >/dev/null 2>&1 || true
  if copy_published_shell_file "$shell_path" "$private_result" 100; then
    code="$(tr -d '\r\n' < "$private_result")"
    [[ "$code" =~ ^[0-9]{1,18}$ ]] || code=""
  fi
  remove_shell_staging_file "$shell_path" || true
  [ -n "$code" ] || return 1
  printf '%s\n' "$code"
}

installed_apk_matches_backup() {
  local probe="$1" code signer
  backup_installed_apk "$probe" || return 1
  code="$(installed_apk_version_code)"
  signer="$(apk_signer_sha256 "$probe" 2>/dev/null || true)"
  [ "$code" = "$PREVIOUS_APK_CODE" ] \
    && [ "$signer" = "$PREVIOUS_APK_SIGNER" ] \
    && [ "$(sha256_file "$probe")" = "$(sha256_file "$APK_BACKUP")" ]
}

wait_for_apk_backup_identity() {
  local probe="$1" stable=0
  for _ in $(seq 1 60); do
    if installed_apk_matches_backup "$probe"; then
      stable=$((stable + 1))
      [ "$stable" -ge 3 ] && return 0
    else
      stable=0
    fi
    sleep 2
  done
  return 1
}

rollback_apk_native() {
  local probe="$STAGING_ROOT/installed-after-rollback.apk"
  [ "$APK_INSTALL_ATTEMPTED" = 1 ] || return 0
  [ "$APK_BACKUP_READY" = 1 ] || {
    say "CRITICAL: APK install was attempted without a proven rollback backup"
    return 1
  }

  # An interrupted rish/package-manager command can finish after its parent
  # installer dies. First cross the package-manager handler barrier and accept
  # an already-restored APK only after three stable exact-identity observations.
  # This avoids mutating a phone that had already rolled itself back.
  if wait_for_package_manager_idle \
      && wait_for_apk_backup_identity "$probe"; then
    return 0
  fi

  # Otherwise serialize a native rollback (or exact-byte fallback reinstall)
  # behind any pending package operation and prove its exact identity.
  if rish_command "cmd package rollback-app '$PACKAGE_NAME'" >/dev/null 2>&1 \
      && wait_for_apk_backup_identity "$probe"; then
    return 0
  fi

  say "CRITICAL: Android native rollback did not restore the backed-up APK; trying -d fallback"
  install_apk "$APK_BACKUP" fallback >/dev/null 2>&1 || {
    say "CRITICAL: backed-up APK fallback install was rejected"
    return 1
  }
  wait_for_apk_backup_identity "$probe" && return 0
  say "CRITICAL: installed APK did not return to its backed-up identity"
  return 1
}

wait_for_apk_rollback_availability() {
  local expected_installed="$1" expected_backup="$2"
  local dump="$STAGING_ROOT/rollback-state.txt" shell_path=""
  [ -f "$ROLLBACK_STATE_HELPER" ] && [ ! -L "$ROLLBACK_STATE_HELPER" ] || return 1
  for _ in $(seq 1 30); do
    shell_path="$(allocate_shell_staging_file rollback-dump 2>/dev/null || true)"
    if [ -n "$shell_path" ]; then
      rish_command \
        "dumpsys rollback > '$shell_path' && chmod 0644 '$shell_path'" \
        >/dev/null 2>&1 || true
      if copy_published_shell_file "$shell_path" "$dump" 30; then
        remove_shell_staging_file "$shell_path" || true
        shell_path=""
      fi
    fi
    if [ -s "$dump" ] \
        && python3 "$ROLLBACK_STATE_HELPER" check \
          "$PACKAGE_NAME" "$expected_installed" "$expected_backup" < "$dump"; then
      rm -f -- "$dump"
      return 0
    fi
    [ -z "$shell_path" ] || remove_shell_staging_file "$shell_path" || true
    shell_path=""
    rm -f -- "$dump"
    sleep 1
  done
  return 1
}

backup_database() {
  local source="$1" output="$2"
  DB_BACKUP_READY=0
  [ -f "$source" ] || return 0
  python3 - "$source" "$output" <<'PY'
import sqlite3
import sys

source, output = sys.argv[1:]
src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
dst = sqlite3.connect(output)
src.backup(dst)
dst.close()
src.close()
check = sqlite3.connect(f"file:{output}?mode=ro", uri=True)
result = check.execute("PRAGMA quick_check").fetchone()[0]
check.close()
if result != "ok":
    raise SystemExit(f"database backup quick_check failed: {result}")
PY
  chmod 600 "$output"
  fsync_regular_file_and_parent "$output"
  DB_BACKUP_READY=1
}

restore_database() {
  local target="${1:-$STATE/data/media-agent.db}"
  [ "$DB_BACKUP_READY" = 1 ] || return 0
  [ -n "$DB_BACKUP" ] && [ -f "$DB_BACKUP" ] && [ ! -L "$DB_BACKUP" ] \
    && [ "$(stat -c '%a' "$DB_BACKUP")" = 600 ] || {
      say "CRITICAL: proven database backup is missing or unsafe"
      return 1
    }
  python3 - "$DB_BACKUP" <<'PY'
import sqlite3
import sys

database = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
result = database.execute("PRAGMA quick_check").fetchone()[0]
database.close()
if result != "ok":
    raise SystemExit(f"database rollback quick_check failed: {result}")
PY
  mkdir -p "$(dirname "$target")"
  rm -f "$target-wal" "$target-shm"
  cp "$DB_BACKUP" "$target"
  fsync_regular_file_and_parent "$target"
}

backup_apk_for_rollback() {
  local source="$1" output="$2"
  APK_BACKUP_READY=0
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  cp "$source" "$output"
  chmod 600 "$output"
  fsync_regular_file_and_parent "$output"
  cmp -s "$source" "$output" || return 1
  APK_BACKUP_READY=1
}

atomic_link() {
  python3 - "$1" "$2" "$$" <<'PY'
import os
import pathlib
import sys

target, raw_link, owner = sys.argv[1:]
link = pathlib.Path(raw_link)
temporary = link.with_name(f"{link.name}.new.{owner}")
try:
    temporary.unlink()
except FileNotFoundError:
    pass
os.symlink(target, temporary)
try:
    os.replace(temporary, link)
finally:
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
directory = os.open(
    link.parent,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

is_real_release_target() {
  python3 - "$1" "$RELEASES" <<'PY' >/dev/null 2>&1
import os
import pathlib
import re
import stat
import sys

target = pathlib.Path(sys.argv[1])
releases = pathlib.Path(sys.argv[2])
if re.fullmatch(r"[A-Za-z0-9._-]{1,120}", target.name) is None:
    raise SystemExit(1)
target_stat = os.lstat(target)
releases_stat = os.lstat(releases)
if not stat.S_ISDIR(target_stat.st_mode) or not stat.S_ISDIR(releases_stat.st_mode):
    raise SystemExit(1)
if not os.path.samefile(target.parent, releases):
    raise SystemExit(1)
PY
}

backup_control_token() {
  local source="$1"
  CONTROL_TOKEN_BACKUP="$BACKUP_DIR/control-token.txt"
  CONTROL_TOKEN_EXISTED=0
  CONTROL_TOKEN_BACKUP_READY=0
  if [ -e "$source" ] || [ -L "$source" ]; then
    [ -f "$source" ] && [ ! -L "$source" ] || {
      say "phone control token is not a regular private file"
      return 1
    }
    cp "$source" "$CONTROL_TOKEN_BACKUP"
    chmod 600 "$CONTROL_TOKEN_BACKUP"
    fsync_regular_file_and_parent "$CONTROL_TOKEN_BACKUP"
    CONTROL_TOKEN_EXISTED=1
  else
    : > "$BACKUP_DIR/control-token.absent"
    chmod 600 "$BACKUP_DIR/control-token.absent"
    fsync_regular_file_and_parent "$BACKUP_DIR/control-token.absent"
  fi
  CONTROL_TOKEN_BACKUP_READY=1
}

restore_control_token() {
  local target="$CONTROL_TOKEN" temp
  [ "$CONTROL_TOKEN_BACKUP_READY" = 1 ] || return 0
  if [ "$INITIAL_MIGRATION" = 1 ] \
      && [ -d "$HOME/evogent" ] && [ ! -L "$HOME/evogent" ]; then
    target="$HOME/evogent/data/control-token.txt"
  elif [ "$INITIAL_MIGRATION" = 1 ] \
      && [ -d "$MIGRATION_DIR/evogent/data" ] \
      && [ ! -d "$STATE/data" ]; then
    target="$MIGRATION_DIR/evogent/data/control-token.txt"
  fi
  if [ "$CONTROL_TOKEN_EXISTED" = 1 ]; then
    [ -f "$CONTROL_TOKEN_BACKUP" ] && [ ! -L "$CONTROL_TOKEN_BACKUP" ] || {
      say "CRITICAL: prior phone control token backup is unavailable"
      return 1
    }
    mkdir -p "$(dirname "$target")"
    temp="$(mktemp "$(dirname "$target")/.control-token.rollback.XXXXXX")"
    cp "$CONTROL_TOKEN_BACKUP" "$temp"
    chmod 600 "$temp"
    mv -f "$temp" "$target"
    fsync_regular_file_and_parent "$target"
  else
    if [ -d "$(dirname "$target")" ]; then
      rm -f "$target"
      fsync_directory "$(dirname "$target")"
    fi
  fi
}

sync_control_token_from_apk() {
  local writer="$NEW_RELEASE/device/write-control-token.py"
  local shell_path="" staged_token="$STAGE/control-token.candidate"
  [ -f "$writer" ] && [ ! -L "$writer" ] || {
    say "phone control-token writer is unavailable"
    return 1
  }
  mkdir -p "$(dirname "$CONTROL_TOKEN")"
  if [ -e "$CONTROL_TOKEN" ] || [ -L "$CONTROL_TOKEN" ]; then
    [ -f "$CONTROL_TOKEN" ] && [ ! -L "$CONTROL_TOKEN" ] || {
      say "phone control token destination is not a regular private file"
      return 1
    }
  fi

  # Launching clears Android's package-stopped state and causes every supported
  # app entry path to create the per-install token if this is a fresh install.
  # Rish can return before a large stdout stream has reached a detached caller.
  # Use the same permission-gated filesystem bridge as APK rollback capture;
  # wait for its read-only publication into the private stage, remove the
  # shell-visible inode, and only then validate and persist the token.
  rish_command "am start -n '$PACKAGE_NAME/.MainActivity' >/dev/null" \
    >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    shell_path="$(allocate_shell_staging_file control-token 2>/dev/null || true)"
    if [ -n "$shell_path" ]; then
      rish_command \
        "cp '$APP_CONTROL_TOKEN_PATH' '$shell_path' && chmod 0644 '$shell_path'" \
        >/dev/null 2>&1 || true
      if copy_published_shell_file "$shell_path" "$staged_token" 30; then
        remove_shell_staging_file "$shell_path" || true
        shell_path=""
      fi
    fi
    if [ -s "$staged_token" ] \
        && python3 "$writer" "$CONTROL_TOKEN" < "$staged_token"; then
      rm -f -- "$staged_token"
      say "phone control token synchronized from APK-scoped storage"
      return 0
    fi
    [ -z "$shell_path" ] || remove_shell_staging_file "$shell_path" || true
    shell_path=""
    rm -f -- "$staged_token"
    sleep 1
  done
  say "APK-scoped phone control token was not available in time"
  return 1
}

prepare_transaction_recoverer() {
  local source="$NEW_RELEASE/device/install-release.sh"
  local temporary="$TRANSACTION_RECOVERER.new.$$"
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  cp "$source" "$temporary"
  chmod 700 "$temporary"
  mv -f "$temporary" "$TRANSACTION_RECOVERER"
  fsync_regular_file_and_parent "$TRANSACTION_RECOVERER"
}

write_transaction_journal() {
  local phase="$1" temporary="$TRANSACTION_JOURNAL.new.$$"
  TRANSACTION_PHASE="$phase"
  python3 - "$temporary" "$TRANSACTION_JOURNAL" \
    "$ROOT" "$phase" "$RELEASE_ID" "$NEW_RELEASE" "$PREVIOUS_TARGET" \
    "$BACKUP_DIR" "$DB_BACKUP" "$DB_BACKUP_READY" \
    "$APK_BACKUP" "$APK_BACKUP_READY" "$APK_CHANGED" \
    "$APK_INSTALL_ATTEMPTED" "$PACKAGE_OPERATION" \
    "$PREVIOUS_APK_CODE" "$PREVIOUS_APK_SIGNER" \
    "$INITIAL_MIGRATION" "$MIGRATION_STARTED" "$SWITCH_STARTED" \
    "$MIGRATION_DIR" "$CYCLE_GATE" "$CONTROL_TOKEN" "$CONTROL_TOKEN_BACKUP" \
    "$CONTROL_TOKEN_EXISTED" "$CONTROL_TOKEN_BACKUP_READY" <<'PY'
import json
import os
import pathlib
import sys

(
    temporary,
    journal,
    root,
    phase,
    release_id,
    new_release,
    previous_target,
    backup_dir,
    db_backup,
    db_backup_ready,
    apk_backup,
    apk_backup_ready,
    apk_changed,
    apk_install_attempted,
    package_operation,
    previous_apk_code,
    previous_apk_signer,
    initial_migration,
    migration_started,
    switch_started,
    migration_dir,
    cycle_gate,
    control_token,
    control_token_backup,
    control_token_existed,
    control_token_backup_ready,
) = sys.argv[1:]
payload = {
    "schema": "evogent.phone.install-transaction.v1",
    "root": root,
    "phase": phase,
    "releaseId": release_id,
    "newRelease": new_release,
    "previousTarget": previous_target,
    "backupDir": backup_dir,
    "dbBackup": db_backup,
    "dbBackupReady": int(db_backup_ready),
    "apkBackup": apk_backup,
    "apkBackupReady": int(apk_backup_ready),
    "apkChanged": int(apk_changed),
    "apkInstallAttempted": int(apk_install_attempted),
    "packageOperation": package_operation,
    "previousApkCode": previous_apk_code,
    "previousApkSigner": previous_apk_signer,
    "initialMigration": int(initial_migration),
    "migrationStarted": int(migration_started),
    "switchStarted": int(switch_started),
    "migrationDir": migration_dir,
    "cycleGate": cycle_gate,
    "controlToken": control_token,
    "controlTokenBackup": control_token_backup,
    "controlTokenExisted": int(control_token_existed),
    "controlTokenBackupReady": int(control_token_backup_ready),
}
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, 0o600)
os.replace(temporary, journal)
directory = os.open(pathlib.Path(journal).parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  TRANSACTION_JOURNAL_WRITTEN=1
}

clear_transaction_journal() {
  python3 - "$TRANSACTION_JOURNAL" "$TRANSACTION_RECOVERER" <<'PY'
import os
import pathlib
import sys

journal, recoverer = map(pathlib.Path, sys.argv[1:])
try:
    journal.unlink()
except FileNotFoundError:
    pass
directory = os.open(journal.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
try:
    recoverer.unlink()
except FileNotFoundError:
    pass
directory = os.open(journal.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

validate_transaction_journal() {
  python3 - "$1" "$ROOT" "$RELEASES" "$BACKUPS" "$MIGRATIONS" \
    "$CONTROL_TOKEN" "$HOME/phone-tools/.cycle.lock" "$PHONE_STATE/.cycle.lock" <<'PY'
import json
import pathlib
import re
import sys

journal, root, releases, backups, migrations, token, home_gate, state_gate = sys.argv[1:]
data = json.load(open(journal, encoding="utf-8"))
if data.get("schema") != "evogent.phone.install-transaction.v1":
    raise SystemExit("unsupported install transaction journal")
if data.get("root") != root:
    raise SystemExit("install transaction belongs to a different release root")
if data.get("phase") not in {
    "quiesce_pending",
    "backup_pending",
    "prepared",
    "switch_pending",
    "apk_install_pending",
    "token_sync_pending",
    "health_pending",
}:
    raise SystemExit("invalid install transaction phase")
if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", str(data.get("releaseId", ""))):
    raise SystemExit("invalid transaction release id")

def exact_child(value, parent, *, optional=False):
    if optional and not value:
        return
    path = pathlib.Path(value).resolve(strict=False)
    parent_path = pathlib.Path(parent).resolve(strict=False)
    try:
        relative = path.relative_to(parent_path)
    except ValueError:
        raise SystemExit("transaction path escapes its private root")
    if not relative.parts:
        raise SystemExit("transaction path does not name a private child")

exact_child(data.get("newRelease", ""), releases)
exact_child(data.get("previousTarget", ""), releases, optional=True)
exact_child(data.get("backupDir", ""), backups)
exact_child(data.get("dbBackup", ""), backups)
exact_child(data.get("apkBackup", ""), backups)
exact_child(data.get("migrationDir", ""), migrations)
exact_child(data.get("controlTokenBackup", ""), backups, optional=True)
package_operation = data.get("packageOperation", "")
if not isinstance(package_operation, str) or (
    package_operation
    and re.fullmatch(
        r"/data/local/tmp/evogent-package-op\.[0-9a-f]{32}",
        package_operation,
    )
    is None
):
    raise SystemExit("transaction package operation is invalid")
if data.get("controlToken") != token:
    raise SystemExit("transaction control-token destination changed")
if data.get("cycleGate") not in {home_gate, state_gate}:
    raise SystemExit("transaction cycle gate is invalid")
for key in (
    "apkChanged",
    "apkInstallAttempted",
    "apkBackupReady",
    "dbBackupReady",
    "initialMigration",
    "migrationStarted",
    "switchStarted",
    "controlTokenExisted",
    "controlTokenBackupReady",
):
    if data.get(key) not in {0, 1}:
        raise SystemExit("transaction flag is invalid")
PY
}

journal_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]]
print(value)
PY
}

journal_optional_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2], "")
print(value)
PY
}

rollback_initial_migration() {
  [ "$INITIAL_MIGRATION" = 1 ] && [ "$MIGRATION_STARTED" = 1 ] || return 0
  rm -f "$CURRENT"
  if [ -d "$MIGRATION_DIR/evogent" ]; then
    if [ -d "$STATE/data" ]; then
      if [ -d "$MIGRATION_DIR/evogent/data" ]; then
        rm -rf -- "$STATE/data"
      else
        mv "$STATE/data" "$MIGRATION_DIR/evogent/data"
      fi
    fi
    if [ -d "$STATE/node_modules" ]; then
      if [ -d "$MIGRATION_DIR/evogent/node_modules" ]; then
        rm -rf -- "$STATE/node_modules"
      else
        mv "$STATE/node_modules" "$MIGRATION_DIR/evogent/node_modules"
      fi
    fi
    if [ -f "$STATE/config/.env.local" ]; then
      if [ -f "$MIGRATION_DIR/evogent/.env.local" ]; then
        rm -f "$STATE/config/.env.local"
      else
        mv "$STATE/config/.env.local" "$MIGRATION_DIR/evogent/.env.local"
      fi
    fi
    rm -rf -- "$HOME/evogent"
    mv "$MIGRATION_DIR/evogent" "$HOME/evogent"
  fi
  rm -rf -- "$HOME/phone-tools"
  rm -rf -- "$PHONE_STATE"
  if [ -d "$MIGRATION_DIR/phone-tools" ]; then
    mv "$MIGRATION_DIR/phone-tools" "$HOME/phone-tools"
  fi
  for name in start-prod.sh start-prod-sub.sh restart-evo.sh deploy-next.sh \
      install-evogent-release.sh; do
    rm -f "$HOME/$name"
    if [ -e "$MIGRATION_DIR/home/$name" ] || [ -L "$MIGRATION_DIR/home/$name" ]; then
      mv "$MIGRATION_DIR/home/$name" "$HOME/$name"
    fi
  done
  fsync_directory "$HOME"
  [ -d "$HOME/evogent" ] && fsync_directory "$HOME/evogent"
  [ -d "$STATE" ] && fsync_directory "$STATE"
  [ -d "$MIGRATIONS" ] && fsync_directory "$MIGRATIONS"
}

rollback_phone_dispatch_changes() {
  [ "$INITIAL_MIGRATION" = 0 ] || return 0
  [ -n "$MIGRATION_DIR" ] || return 0
  if [ -f "$MIGRATION_DIR/created-phone-links" ]; then
    while IFS= read -r name; do
      [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] && rm -f "$PHONE_STATE/$name"
    done < "$MIGRATION_DIR/created-phone-links"
  fi
  if [ -d "$MIGRATION_DIR/replaced-phone-tools" ]; then
    find "$MIGRATION_DIR/replaced-phone-tools" -mindepth 1 -maxdepth 1 \
      | while IFS= read -r source; do
          name="$(basename "$source")"
          rm -rf -- "$PHONE_STATE/$name"
          cp -a "$source" "$PHONE_STATE/$name"
        done
  fi
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET/phone-tools" ]; then
    find "$PREVIOUS_TARGET/phone-tools" -mindepth 1 -maxdepth 1 \
      | while IFS= read -r source; do
          name="$(basename "$source")"
          target="$PHONE_STATE/$name"
          if [ -L "$target" ] || [ ! -e "$target" ]; then
            rm -f "$target"
            ln -s "$ROOT/current/phone-tools/$name" "$target"
          fi
        done
  fi
  [ -d "$PHONE_STATE" ] && fsync_directory "$PHONE_STATE"
}

normalize_dangling_legacy_predecessor() {
  [ "$INITIAL_MIGRATION" = 0 ] || return 0
  [ "$SWITCH_STARTED" = 0 ] || return 0
  [ "$MIGRATION_STARTED" = 0 ] || return 0
  [ -n "$PREVIOUS_TARGET" ] || return 0
  local normalized
  if ! normalized="$(python3 - "$CURRENT" "$PREVIOUS_TARGET" "$RELEASES" \
      "$HOME/evogent" "$HOME/phone-tools" <<'PY'
import os
import pathlib
import re
import stat
import sys

current, previous, releases, legacy_runtime, legacy_tools = sys.argv[1:]

def is_real_directory(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except FileNotFoundError:
        return False

previous_path = pathlib.Path(previous)
if re.fullmatch(r"[A-Za-z0-9._-]{1,120}", previous_path.name) is None:
    raise SystemExit("journal predecessor has an invalid release identity")
try:
    if not os.path.samefile(previous_path.parent, releases):
        raise SystemExit("journal predecessor is not a direct release child")
except FileNotFoundError:
    raise SystemExit("release directory is unavailable during recovery")
try:
    previous_stat = os.lstat(previous)
except FileNotFoundError:
    pass
else:
    if stat.S_ISDIR(previous_stat.st_mode):
        print("versioned")
        raise SystemExit(0)
    raise SystemExit("prior release target is not a real directory")
if not is_real_directory(legacy_runtime) or not is_real_directory(legacy_tools):
    raise SystemExit("missing prior release has no intact legacy runtime")
try:
    current_stat = os.lstat(current)
except FileNotFoundError:
    # Crash-reentrant second half: a prior recovery may already have unlinked
    # the exact dangling pointer before it could update the in-memory flags.
    directory = os.open(
        os.path.dirname(current),
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    print("normalized")
    raise SystemExit(0)
if not stat.S_ISLNK(current_stat.st_mode):
    raise SystemExit("missing prior release has an unexpected current entry")
raw_target = os.readlink(current)
lexical_target = raw_target
if not os.path.isabs(lexical_target):
    lexical_target = os.path.join(os.path.dirname(current), lexical_target)
if os.path.normpath(os.path.abspath(lexical_target)) != os.path.normpath(
    os.path.abspath(previous)
):
    raise SystemExit("dangling current pointer does not name the journal predecessor")

# Recheck the same inode and raw target immediately before unlinking. The
# release install lock excludes cooperating writers; this closes accidental
# replacement races without following the dangling link.
latest = os.lstat(current)
if (
    latest.st_dev != current_stat.st_dev
    or latest.st_ino != current_stat.st_ino
    or os.readlink(current) != raw_target
):
    raise SystemExit("legacy predecessor pointer changed during recovery")
os.unlink(current)
directory = os.open(
    os.path.dirname(current),
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
print("normalized")
PY
  )"; then
    return 1
  fi
  case "$normalized" in
    versioned) return 0 ;;
    normalized)
      PREVIOUS_TARGET=""
      INITIAL_MIGRATION=1
      say "normalized a pre-switch dangling release pointer to the intact legacy runtime"
      ;;
    *) return 1 ;;
  esac
}

reap_recorded_package_operation() {
  [ -n "$PACKAGE_OPERATION" ] || return 0
  if remove_shell_package_operation "$PACKAGE_OPERATION"; then
    PACKAGE_OPERATION=""
    return 0
  fi
  say "CRITICAL: recorded Android package operation could not be reaped"
  return 1
}

rollback_release() {
  say "install failed; rolling back the complete release"
  ROLLBACK_ATTEMPTED=1
  set +e
  CONTROL_PLANE_MUTATION_STARTED=1
  if ! quiesce_control_plane; then
    ROLLBACK_FAILED=1
    if [ "$SWITCH_STARTED" = 0 ] && [ "$MIGRATION_STARTED" = 0 ] \
        && [ "$APK_INSTALL_ATTEMPTED" = 0 ]; then
      REARM_PRIOR_CONTROL_PLANE=1
    fi
    say "CRITICAL: rollback cannot prove the scheduler/watchdog control plane is quiescent"
    set -e
    return 1
  fi
  if ! stop_and_prove_runtime; then
    ROLLBACK_FAILED=1
    if [ "$SWITCH_STARTED" = 0 ] && [ "$MIGRATION_STARTED" = 0 ] \
        && [ "$APK_INSTALL_ATTEMPTED" = 0 ]; then
      REARM_PRIOR_CONTROL_PLANE=1
    fi
    say "CRITICAL: rollback cannot prove the prior runtime is stopped"
    set -e
    return 1
  fi
  QUIESCED=1
  if ! normalize_dangling_legacy_predecessor; then
    ROLLBACK_FAILED=1
    say "CRITICAL: rollback could not safely normalize the prior runtime topology"
    set -e
    return 1
  fi
  if [ "$SWITCH_STARTED" = 1 ] || [ "$MIGRATION_STARTED" = 1 ]; then
    rollback_phone_dispatch_changes || ROLLBACK_FAILED=1
  fi
  if [ -n "$PREVIOUS_TARGET" ] && ! is_real_release_target "$PREVIOUS_TARGET"; then
    say "CRITICAL: prior release target is unavailable or unsafe"
    ROLLBACK_FAILED=1
    if [ "$APK_CHANGED" = 1 ] && ! rollback_apk_native; then
      ROLLBACK_FAILED=1
    fi
    if ! restore_control_token; then
      ROLLBACK_FAILED=1
    fi
  elif [ -n "$PREVIOUS_TARGET" ]; then
    atomic_link "$PREVIOUS_TARGET" "$CURRENT" || ROLLBACK_FAILED=1
    restore_database || ROLLBACK_FAILED=1
    if [ "$APK_CHANGED" = 1 ] && ! rollback_apk_native; then
      ROLLBACK_FAILED=1
    fi
    if ! restore_control_token; then
      ROLLBACK_FAILED=1
    fi
    bash "$HOME/restart-evo.sh" || ROLLBACK_FAILED=1
    EVOGENT_RELEASE_RECOVERY=1 EVOGENT_RELEASE_BOOT=1 \
      bash "$HOME/phone-tools/evogent-boot.sh" || ROLLBACK_FAILED=1
  else
    if [ "$APK_CHANGED" = 1 ] && ! rollback_apk_native; then
      ROLLBACK_FAILED=1
    fi
    if ! restore_control_token; then
      ROLLBACK_FAILED=1
    fi
    rollback_initial_migration || ROLLBACK_FAILED=1
    restore_database "$HOME/evogent/data/media-agent.db" || ROLLBACK_FAILED=1
    if [ -x "$HOME/start-prod.sh" ]; then
      tmux kill-session -t evo 2>/dev/null || true
      tmux new-session -d -s evo \
        "exec bash '$HOME/start-prod.sh' >> '$HOME/evogent-server.log' 2>&1"
      for _ in $(seq 1 60); do
        evo_curl -sS -m 5 "$FEED_URL" >/dev/null 2>&1 && break
        sleep 2
      done
      if [ -x "$HOME/phone-tools/evogent-boot.sh" ]; then
        EVOGENT_RELEASE_RECOVERY=1 EVOGENT_RELEASE_BOOT=1 \
          bash "$HOME/phone-tools/evogent-boot.sh" || ROLLBACK_FAILED=1
      fi
    fi
  fi
  reap_recorded_package_operation || ROLLBACK_FAILED=1
  if [ -n "$PREVIOUS_TARGET" ]; then
    is_real_release_target "$PREVIOUS_TARGET" \
      && [ -L "$CURRENT" ] \
      && [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" = "$PREVIOUS_TARGET" ] \
      || ROLLBACK_FAILED=1
  elif [ -e "$CURRENT" ] || [ -L "$CURRENT" ]; then
    ROLLBACK_FAILED=1
  fi
  set -e
  [ "$ROLLBACK_FAILED" = 0 ]
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "$rc" -ne 0 ] \
    && [ "$ROLLBACK_ATTEMPTED" = 0 ] \
    && { [ "$SWITCH_STARTED" = 1 ] || [ "$MIGRATION_STARTED" = 1 ] \
      || [ "$QUIESCED" = 1 ] || [ "$CONTROL_PLANE_MUTATION_STARTED" = 1 ]; }; then
    rollback_release || true
    if [ "$ROLLBACK_FAILED" = 0 ]; then
      clear_transaction_journal || true
    fi
  elif [ "$rc" -ne 0 ] && [ "$ROLLBACK_ATTEMPTED" = 0 ] \
      && [ "$TRANSACTION_JOURNAL_WRITTEN" = 1 ]; then
    # The durable intent exists but no production mutation began. A graceful
    # failure can discard it; SIGKILL/reboot still leaves it for recovery.
    clear_transaction_journal || true
  fi
  [ "$CYCLE_GATE_HELD" = 1 ] && release_lock_dir "$CYCLE_GATE" || true
  [ -n "$STAGE" ] && [ -d "$STAGE" ] && rm -rf -- "$STAGE"
  if [ "$INSTALL_LOCK_HELD" = 1 ] \
      && [ -f "$DEPENDENCY_STATE_HELPER" ] \
      && [ ! -L "$DEPENDENCY_STATE_HELPER" ]; then
    # This safely makes sealed trees removable and also reaps a failed release
    # candidate once rollback has cleared its transaction journal.
    python3 "$DEPENDENCY_STATE_HELPER" prune "$ROOT" || true
  elif [ -n "$DEPENDENCY_BUILD" ] \
      && [ -d "$DEPENDENCY_BUILD" ] \
      && [ "$(dirname "$DEPENDENCY_BUILD")" = "$DEPENDENCY_BUILDS" ]; then
    rm -rf -- "$DEPENDENCY_BUILD"
  fi
  [ "$INSTALL_LOCK_HELD" = 1 ] && release_lock_dir "$INSTALL_LOCK" || true
  if [ "$REARM_PRIOR_CONTROL_PLANE" = 1 ]; then
    if [ -x "$HOME/phone-tools/evogent-boot.sh" ]; then
      EVOGENT_RELEASE_RECOVERY=1 EVOGENT_RELEASE_BOOT=1 \
        bash "$HOME/phone-tools/evogent-boot.sh" \
        || say "CRITICAL: prior control plane could not be re-armed after safe rollback deferral"
    else
      say "CRITICAL: prior control plane could not be re-armed; boot program is unavailable"
    fi
  fi
  if [ "$SUCCESS" = 1 ] && [ "$RECOVERY_ACTIVE" = 1 ]; then
    say "interrupted release transaction recovered"
  elif [ "$SUCCESS" = 1 ]; then
    say "release install complete: $RELEASE_ID"
  else
    say "release install exited with status $rc"
    [ "$ROLLBACK_FAILED" = 1 ] \
      && say "CRITICAL: complete release rollback could not be proven; the recovery journal was retained"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

recover_interrupted_transaction() {
  local journal="$1" restored_target
  RECOVERY_ACTIVE=1
  [ "$journal" = "$TRANSACTION_JOURNAL" ] || {
    say "interrupted install recovery path is invalid"
    return 65
  }
  acquire_lock_dir "$INSTALL_LOCK" release-install-recovery
  INSTALL_LOCK_HELD=1
  if [ ! -e "$journal" ] && [ ! -L "$journal" ]; then
    # A concurrent recoverer may have completed while this process waited.
    SUCCESS=1
    return 0
  fi
  [ -f "$journal" ] && [ ! -L "$journal" ] \
    && [ -f "$TRANSACTION_RECOVERER" ] && [ ! -L "$TRANSACTION_RECOVERER" ] || {
      say "interrupted install recovery metadata is missing or unsafe"
      return 65
    }
  [ "$(stat -c '%a' "$journal")" = 600 ] \
    && [ "$(stat -c '%a' "$TRANSACTION_RECOVERER")" = 700 ] || {
      say "interrupted install recovery metadata is not private"
      return 65
    }
  validate_transaction_journal "$journal" || return 65

  TRANSACTION_PHASE="$(journal_field "$journal" phase)"
  RELEASE_ID="$(journal_field "$journal" releaseId)"
  NEW_RELEASE="$(journal_field "$journal" newRelease)"
  PREVIOUS_TARGET="$(journal_field "$journal" previousTarget)"
  BACKUP_DIR="$(journal_field "$journal" backupDir)"
  DB_BACKUP="$(journal_field "$journal" dbBackup)"
  DB_BACKUP_READY="$(journal_field "$journal" dbBackupReady)"
  APK_BACKUP="$(journal_field "$journal" apkBackup)"
  APK_BACKUP_READY="$(journal_field "$journal" apkBackupReady)"
  APK_CHANGED="$(journal_field "$journal" apkChanged)"
  APK_INSTALL_ATTEMPTED="$(journal_field "$journal" apkInstallAttempted)"
  PACKAGE_OPERATION="$(journal_optional_field "$journal" packageOperation)"
  PREVIOUS_APK_CODE="$(journal_field "$journal" previousApkCode)"
  PREVIOUS_APK_SIGNER="$(journal_field "$journal" previousApkSigner)"
  INITIAL_MIGRATION="$(journal_field "$journal" initialMigration)"
  MIGRATION_STARTED="$(journal_field "$journal" migrationStarted)"
  SWITCH_STARTED="$(journal_field "$journal" switchStarted)"
  MIGRATION_DIR="$(journal_field "$journal" migrationDir)"
  CYCLE_GATE="$(journal_field "$journal" cycleGate)"
  CONTROL_TOKEN="$(journal_field "$journal" controlToken)"
  CONTROL_TOKEN_BACKUP="$(journal_field "$journal" controlTokenBackup)"
  CONTROL_TOKEN_EXISTED="$(journal_field "$journal" controlTokenExisted)"
  CONTROL_TOKEN_BACKUP_READY="$(journal_field "$journal" controlTokenBackupReady)"
  TRANSACTION_JOURNAL_WRITTEN=1
  MANIFEST_PATH="$NEW_RELEASE/manifest.json"
  STAGE="$(mktemp -d "$STAGING_ROOT/recover.XXXXXX")"

  if [ -d "$PHONE_STATE/.cycle.lock" ]; then
    CYCLE_GATE="$PHONE_STATE/.cycle.lock"
  elif [ ! -d "$(dirname "$CYCLE_GATE")" ]; then
    mkdir -p "$PHONE_STATE"
    CYCLE_GATE="$PHONE_STATE/.cycle.lock"
  fi
  acquire_lock_dir "$CYCLE_GATE" release-install-recovery-cycle-gate
  CYCLE_GATE_HELD=1

  if [ "$APK_INSTALL_ATTEMPTED" = 1 ]; then
    for _ in $(seq 1 12); do
      rish_command "id" 2>/dev/null | grep -q 'uid=2000' && break
      sleep 5
    done
  fi

  say "recovering interrupted release transaction at phase $TRANSACTION_PHASE"
  rollback_release || true
  [ "$ROLLBACK_FAILED" = 0 ] || return 70
  if [ -n "$PREVIOUS_TARGET" ]; then
    restored_target="$(readlink -f "$CURRENT" 2>/dev/null || true)"
    is_real_release_target "$PREVIOUS_TARGET" \
      && [ -L "$CURRENT" ] && [ "$restored_target" = "$PREVIOUS_TARGET" ] || {
      say "CRITICAL: interrupted install did not restore the prior release pointer"
      return 70
    }
  elif [ -e "$CURRENT" ] || [ -L "$CURRENT" ]; then
    say "CRITICAL: interrupted initial install left a release pointer behind"
    return 70
  fi
  if [ "$CONTROL_TOKEN_BACKUP_READY" = 1 ] && [ "$CONTROL_TOKEN_EXISTED" = 1 ]; then
    local restored_token="$CONTROL_TOKEN"
    if [ "$INITIAL_MIGRATION" = 1 ]; then
      restored_token="$HOME/evogent/data/control-token.txt"
    fi
    cmp -s "$CONTROL_TOKEN_BACKUP" "$restored_token" || {
      say "CRITICAL: interrupted install did not restore the prior phone control token"
      return 70
    }
    [ "$(stat -c '%a' "$restored_token")" = 600 ] || {
      say "CRITICAL: restored phone control token permissions are unsafe"
      return 70
    }
  fi
  clear_transaction_journal
  SUCCESS=1
}

if [ -n "$RECOVERY_JOURNAL_ARG" ]; then
  recover_interrupted_transaction "$RECOVERY_JOURNAL_ARG"
  exit 0
fi

acquire_install_lock_and_recover_prior_transactions() {
  acquire_lock_dir "$INSTALL_LOCK" release-install
  INSTALL_LOCK_HELD=1
  while [ -e "$TRANSACTION_JOURNAL" ] || [ -L "$TRANSACTION_JOURNAL" ]; do
    [ -f "$TRANSACTION_RECOVERER" ] && [ ! -L "$TRANSACTION_RECOVERER" ] \
      && [ "$(stat -c '%a' "$TRANSACTION_RECOVERER")" = 700 ] || {
        say "a prior interrupted install has no safe private recovery program"
        return 70
      }
    say "recovering the prior interrupted release before accepting a new archive"
    release_lock_dir "$INSTALL_LOCK"
    INSTALL_LOCK_HELD=0
    bash "$TRANSACTION_RECOVERER" --recover "$TRANSACTION_JOURNAL" || return 70
    acquire_lock_dir "$INSTALL_LOCK" release-install
    INSTALL_LOCK_HELD=1
    # Recheck under the reacquired lock. Another transaction may have started
    # and been interrupted while this process waited for the first recoverer.
  done
}

acquire_install_lock_and_recover_prior_transactions

ACTUAL_ARCHIVE_SHA256="$(sha256_file "$ARCHIVE")"
[ "${ACTUAL_ARCHIVE_SHA256,,}" = "${EXPECTED_ARCHIVE_SHA256,,}" ] || {
  say "archive checksum mismatch"
  exit 65
}

STAGE="$(mktemp -d "$STAGING_ROOT/install.XXXXXX")"
python3 - "$ARCHIVE" "$STAGE" <<'PY'
import pathlib
import posixpath
import sys
import tarfile

archive, destination = sys.argv[1:]
root = pathlib.Path(destination).resolve()
with tarfile.open(archive, "r:gz") as bundle:
    for member in bundle.getmembers():
        name = member.name
        pure = pathlib.PurePosixPath(name)
        if pure.is_absolute() or ".." in pure.parts or not pure.parts or pure.parts[0] != "release":
            raise SystemExit(f"unsafe archive member: {name!r}")
        if member.isdev() or member.isfifo() or member.ischr() or member.isblk() or member.islnk():
            raise SystemExit(f"unsupported archive member type: {name!r}")
        if member.issym():
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if not resolved.startswith("release/"):
                raise SystemExit(f"symlink escapes release: {name!r}")
    bundle.extractall(root)
PY

EXTRACTED="$STAGE/release"
[ -f "$EXTRACTED/manifest.json" ] \
  && [ -f "$EXTRACTED/files.sha256" ] \
  && [ -f "$EXTRACTED/links.json" ] || {
    say "release metadata is incomplete"
    exit 65
}
[ -f "$EXTRACTED/tls/server-key.pem" ] \
  && [ ! -L "$EXTRACTED/tls/server-key.pem" ] \
  && chmod 600 "$EXTRACTED/tls/server-key.pem"

MANIFEST_PATH="$EXTRACTED/manifest.json"
read_manifest() {
  python3 - "$MANIFEST_PATH" "$1" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
}

smoke_android_dependency_tree() {
  local tree="$1"
  (
    cd "$tree"
    npm ls --omit=dev --depth=0 >/dev/null
    node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES (1)');
if (db.prepare('SELECT value FROM proof').get().value !== 1) {
  throw new Error('better-sqlite3 Android smoke check failed');
}
db.close();
for (const name of ['next', 'better-sqlite3', 'ws', 'dotenv', 'bullmq']) {
  require.resolve(name);
}
NODE
  )
}

verify_android_dependency_tree() {
  local tree="$1" expected_lock="$2"
  [ -f "$DEPENDENCY_STATE_HELPER" ] && [ ! -L "$DEPENDENCY_STATE_HELPER" ] || return 1
  python3 "$DEPENDENCY_STATE_HELPER" verify "$tree" "$expected_lock" || return 1
  smoke_android_dependency_tree "$tree"
}

prepare_android_dependency_tree() {
  local expected_lock="$1" target="$DEPENDENCIES/$1"
  local node_gyp
  [[ "$expected_lock" =~ ^[0-9a-f]{64}$ ]] || {
    say "release dependency identity is invalid"
    return 65
  }
  if verify_android_dependency_tree "$target" "$expected_lock"; then
    say "reusing verified Android dependency tree"
    return 0
  fi

  DEPENDENCY_BUILD="$(mktemp -d "$DEPENDENCY_BUILDS/$expected_lock.XXXXXX")"
  cp "$NEW_RELEASE/runtime/package.json" "$DEPENDENCY_BUILD/package.json"
  cp "$NEW_RELEASE/runtime/package-lock.json" "$DEPENDENCY_BUILD/package-lock.json"
  chmod 600 "$DEPENDENCY_BUILD/package.json" "$DEPENDENCY_BUILD/package-lock.json"

  # Android packages do not publish a compatible better-sqlite3 prebuild. Install the exact
  # public lock without lifecycle scripts, then compile that one native addon against the
  # Termux toolchain. Unsupported optional packages (the host embedding model, SWC, image
  # optimizers) remain absent; the runtime has explicit Android fallbacks for them.
  (
    cd "$DEPENDENCY_BUILD"
    npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
  )
  node_gyp="$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js"
  [ -f "$node_gyp" ] || {
    say "Termux npm does not expose its bundled node-gyp"
    return 69
  }
  (
    cd "$DEPENDENCY_BUILD/node_modules/better-sqlite3"
    GYP_DEFINES="android_ndk_path=$PREFIX" \
      node "$node_gyp" rebuild --release
  )

  printf '%s\n' "$expected_lock" > "$DEPENDENCY_BUILD/.evogent-package-lock.sha256"
  chmod 600 "$DEPENDENCY_BUILD/.evogent-package-lock.sha256"
  python3 "$DEPENDENCY_STATE_HELPER" seal "$DEPENDENCY_BUILD" "$expected_lock" || {
    say "new Android dependency tree could not be inventoried and sealed"
    return 70
  }
  sync -f "$DEPENDENCY_BUILD"
  if [ -e "$target" ] || [ -L "$target" ]; then
    say "quarantining invalid Android dependency tree during atomic replacement"
  fi
  python3 "$DEPENDENCY_STATE_HELPER" publish \
    "$DEPENDENCY_BUILD" "$target" "$DEPENDENCY_QUARANTINE" "$expected_lock" || {
      say "Android dependency tree could not be published atomically"
      return 70
    }
  DEPENDENCY_BUILD=""
  smoke_android_dependency_tree "$target" || {
    say "published Android dependency tree failed its native runtime smoke test"
    return 70
  }
  say "built and verified versioned Android dependency tree"
}

verify_release_tls_material() {
  local release_root="$1"
  local cert="$release_root/tls/server-cert.pem"
  local key="$release_root/tls/server-key.pem"
  local embedded_ca="$STAGE/release-ca.pem"
  [ -f "$cert" ] && [ ! -L "$cert" ] \
    && [ -f "$key" ] && [ ! -L "$key" ] || {
      say "release TLS certificate/key are missing or not regular files"
      return 1
    }
  [ "$(stat -c '%a' "$key")" = 600 ] || {
    say "release TLS private key permissions are not 0600"
    return 1
  }
  unzip -p "$release_root/apk/evogent.apk" res/raw/evogent_phone_ca.pem \
    > "$embedded_ca" || return 1
  [ -s "$embedded_ca" ] || {
    say "release APK does not contain its private CA certificate"
    return 1
  }
  openssl x509 -in "$cert" -noout -checkend 0 >/dev/null || {
    say "release TLS certificate is not currently valid"
    return 1
  }
  openssl verify -purpose sslserver -CAfile "$embedded_ca" "$cert" >/dev/null || {
    say "release TLS certificate does not chain to the APK CA"
    return 1
  }
  local san cert_hash expected_hash
  san="$(openssl x509 -in "$cert" -noout -ext subjectAltName \
    | tail -n +2 | tr -d '[:space:]')"
  [ "$san" = "IPAddress:127.0.0.1" ] || {
    say "release TLS certificate does not have the exact loopback IP SAN"
    return 1
  }
  openssl x509 -in "$cert" -pubkey -noout \
    | openssl pkey -pubin -outform DER > "$STAGE/release-cert.pub" || return 1
  openssl pkey -in "$key" -pubout -outform DER > "$STAGE/release-key.pub" || return 1
  cmp -s "$STAGE/release-cert.pub" "$STAGE/release-key.pub" || {
    say "release TLS certificate and private key do not match"
    return 1
  }
  cert_hash="$(openssl x509 -in "$cert" -outform DER \
    | openssl dgst -sha256 -r | awk '{print $1}')"
  expected_hash="$(read_manifest phoneTls.certificateDerSha256)"
  [ "$cert_hash" = "$expected_hash" ] || {
    say "release TLS certificate identity does not match the manifest"
    return 1
  }
  [ "$(read_manifest phoneTls.host)" = 127.0.0.1 ] \
    && [ "$(read_manifest phoneTls.port)" = "$PHONE_HTTPS_PORT" ] || {
      say "release TLS listener identity is incompatible with the APK"
      return 1
    }
}

verify_phone_tls_listener() {
  local release_root="$1"
  python3 - "$release_root/apk/evogent.apk" "$release_root/manifest.json" \
    "$PHONE_HTTPS_PORT" <<'PY'
import hashlib
import json
import socket
import ssl
import sys
import zipfile

apk_path, manifest_path, raw_port = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding="utf-8"))
expected = manifest["phoneTls"]["certificateDerSha256"]
with zipfile.ZipFile(apk_path) as apk:
    ca_pem = apk.read("res/raw/evogent_phone_ca.pem").decode("ascii")

context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
context.minimum_version = ssl.TLSVersion.TLSv1_2
context.check_hostname = True
context.verify_mode = ssl.CERT_REQUIRED
context.load_verify_locations(cadata=ca_pem)
with socket.create_connection(("127.0.0.1", int(raw_port)), timeout=3) as plain:
    with context.wrap_socket(plain, server_hostname="127.0.0.1") as secure:
        actual = hashlib.sha256(secure.getpeercert(binary_form=True)).hexdigest()
        if actual != expected:
            raise SystemExit("running TLS listener certificate does not match release")
        secure.sendall(
            b"GET /api/internal/phone-health HTTP/1.1\r\n"
            b"Host: 127.0.0.1:3443\r\n"
            b"Connection: close\r\n\r\n"
        )
        response = b""
        while b"\r\n\r\n" not in response and len(response) <= 32768:
            chunk = secure.recv(4096)
            if not chunk:
                break
            response += chunk
headers = response.split(b"\r\n\r\n", 1)[0].lower()
if not headers.startswith(b"http/1.1 401 "):
    raise SystemExit("running TLS listener did not enforce the phone session gate")
if b"\r\nwww-authenticate: evogentphonesession\r\n" not in b"\r\n" + headers + b"\r\n":
    raise SystemExit("running TLS listener returned the wrong authentication gate")
PY
}

[ "$(read_manifest schema)" = "evogent.phone.release.v1" ] \
  && [ "$(read_manifest releaseFormat)" = 1 ] || {
    say "unsupported release schema"
    exit 65
}
RELEASE_ID="$(read_manifest releaseId)"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]{1,120}$ ]] \
  && [ "$RELEASE_ID" != . ] && [ "$RELEASE_ID" != .. ] || {
  say "unsafe release id"
  exit 65
}
[ "$(read_manifest phoneTls.host)" = 127.0.0.1 ] \
  && [ "$(read_manifest phoneTls.port)" = "$PHONE_HTTPS_PORT" ] || {
    say "release does not target the exact Android HTTPS origin"
    exit 65
  }
EXPECTED_INVENTORY="$(read_manifest inventory.sha256)"
EXPECTED_LINKS="$(read_manifest inventory.linksSha256)"
[ "$(sha256_file "$EXTRACTED/files.sha256")" = "$EXPECTED_INVENTORY" ] \
  && [ "$(sha256_file "$EXTRACTED/links.json")" = "$EXPECTED_LINKS" ] || {
    say "release inventory metadata mismatch"
    exit 65
}

(cd "$EXTRACTED" && sha256sum -c files.sha256)
verify_release_tls_material "$EXTRACTED" || exit 65
python3 - "$EXTRACTED" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
links = json.loads((root / "links.json").read_text(encoding="utf-8"))
for relative, expected in links.items():
    path = root / relative
    if not path.is_symlink() or os.readlink(path) != expected:
        raise SystemExit(f"symlink inventory mismatch: {relative}")
for relative in manifest["requiredPaths"]:
    if not (root / relative).exists():
        raise SystemExit(f"required release path missing: {relative}")
identity = json.loads((root / "runtime/.evogent-release.json").read_text(encoding="utf-8"))
if identity["releaseId"] != manifest["releaseId"]:
    raise SystemExit("runtime identity does not match manifest")
release_identity = (
    f"apk-sha256:{manifest['android']['sha256']}\n"
    f"tls-cert-der-sha256:{manifest['phoneTls']['certificateDerSha256']}\n"
)
identity_digest = hashlib.sha256(release_identity.encode("ascii")).hexdigest()[:12]
if manifest.get("releaseIdentityDigest") != identity_digest:
    raise SystemExit("manifest APK/TLS release identity digest is invalid")
if identity.get("releaseIdentityDigest") != identity_digest:
    raise SystemExit("runtime APK/TLS release identity digest is invalid")
if not manifest["releaseId"].endswith("-" + identity_digest):
    raise SystemExit("release id is not bound to its APK/TLS identity")
if (root / "runtime/.next/BUILD_ID").read_text().strip() != manifest["web"]["buildId"]:
    raise SystemExit("Next.js BUILD_ID does not match manifest")
PY

DEPENDENCY_STATE_HELPER="$EXTRACTED/device/dependency-tree-state.py"
[ -f "$DEPENDENCY_STATE_HELPER" ] && [ ! -L "$DEPENDENCY_STATE_HELPER" ] || {
  say "release dependency-state helper is missing or unsafe"
  exit 65
}
ROLLBACK_STATE_HELPER="$EXTRACTED/device/rollback-state.py"
[ -f "$ROLLBACK_STATE_HELPER" ] && [ ! -L "$ROLLBACK_STATE_HELPER" ] || {
  say "release rollback-state helper is missing or unsafe"
  exit 65
}
# This runs while the exclusive install lock is held and before a new dependency
# build begins. It bounds artifacts left by SIGKILL, reboot, or a failed candidate.
python3 "$DEPENDENCY_STATE_HELPER" prune "$ROOT" || {
  say "stale dependency/release state could not be pruned safely"
  exit 70
}

NEW_RELEASE="$RELEASES/$RELEASE_ID"
if [ -e "$NEW_RELEASE" ]; then
  [ -f "$NEW_RELEASE/manifest.json" ] \
    && [ "$(sha256_file "$NEW_RELEASE/manifest.json")" = "$(sha256_file "$EXTRACTED/manifest.json")" ] || {
      say "release id collision with different contents"
      exit 65
    }
  (cd "$NEW_RELEASE" && sha256sum -c files.sha256 >/dev/null) || {
    say "existing release directory failed its file inventory"
    exit 65
  }
  rm -rf -- "$EXTRACTED"
else
  python3 "$DEPENDENCY_STATE_HELPER" candidate-add "$ROOT" "$RELEASE_ID"
  python3 - "$EXTRACTED" <<'PY'
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
for relative, target in manifest["stateLinks"].items():
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(target, path)
PY
  mv "$EXTRACTED" "$NEW_RELEASE"
fi
MANIFEST_PATH="$NEW_RELEASE/manifest.json"
DEPENDENCY_STATE_HELPER="$NEW_RELEASE/device/dependency-tree-state.py"
ROLLBACK_STATE_HELPER="$NEW_RELEASE/device/rollback-state.py"
[ "$(sha256_file "$NEW_RELEASE/files.sha256")" = "$(read_manifest inventory.sha256)" ] \
  && [ "$(sha256_file "$NEW_RELEASE/links.json")" = "$(read_manifest inventory.linksSha256)" ] || {
  say "installed release inventory metadata mismatch"
  exit 65
}
(cd "$NEW_RELEASE" && sha256sum -c files.sha256 >/dev/null) || {
  say "installed release directory failed its file inventory"
  exit 65
}
python3 - "$NEW_RELEASE" <<'PY'
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
links = json.loads((root / "links.json").read_text(encoding="utf-8"))
for relative, expected in links.items():
    path = root / relative
    if not path.is_symlink() or os.readlink(path) != expected:
        raise SystemExit(f"installed release symlink inventory mismatch: {relative}")
for relative, expected in manifest["stateLinks"].items():
    path = root / relative
    if not path.is_symlink() or os.readlink(path) != expected:
        raise SystemExit(f"state link mismatch: {relative}")
PY

# Releases are read-only once staged. Runtime writes have explicit state links
# (data, Android node_modules, private env, and Next cache).
python3 - "$NEW_RELEASE" <<'PY'
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
for path in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
    if path.is_symlink():
        continue
    mode = path.stat().st_mode
    if path.is_dir():
        os.chmod(path, 0o555)
    elif path.is_file():
        relative = path.relative_to(root).as_posix()
        if relative == "tls/server-key.pem":
            os.chmod(path, 0o600)
        else:
            os.chmod(path, 0o555 if mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH) else 0o444)
os.chmod(root, 0o555)
PY
[ "$(stat -c '%a' "$NEW_RELEASE/tls/server-key.pem")" = 600 ] || {
  say "installed TLS private key permissions changed across immutable staging"
  exit 65
}
verify_release_tls_material "$NEW_RELEASE" || exit 65

# Build dependencies before taking the cycle gate or stopping production. The exact lock hash
# names the tree, so a failed build cannot mutate the currently running release and a later
# release with the same lock can reuse the verified Android-native result.
EXPECTED_PACKAGE_LOCK="$(read_manifest dependencies.packageLockSha256)"
EXPECTED_DEPENDENCY_LINK="../../../state/dependencies/$EXPECTED_PACKAGE_LOCK/node_modules"
[ "$(read_manifest stateLinks.runtime/node_modules)" = "$EXPECTED_DEPENDENCY_LINK" ] || {
  say "release dependency link does not match its lock identity"
  exit 65
}
prepare_android_dependency_tree "$EXPECTED_PACKAGE_LOCK"

# Same release + matching APK metadata is an intentional no-op. Still prove the
# local server is healthy instead of trusting a symlink alone.
CURRENT_RESOLVED="$(readlink -f "$CURRENT" 2>/dev/null || true)"
PREVIOUS_TARGET="$CURRENT_RESOLVED"
if [ -e "$CURRENT" ] || [ -L "$CURRENT" ]; then
  [ -L "$CURRENT" ] && [ -n "$CURRENT_RESOLVED" ] \
    && is_real_release_target "$CURRENT_RESOLVED" || {
      say "current release pointer is dangling or unsafe; recover it before installing"
      exit 69
    }
fi
if [ -z "$CURRENT_RESOLVED" ] && [ -d "$HOME/evogent" ] && [ ! -L "$HOME/evogent" ] \
    && { [ -e "$STATE/data" ] || [ -e "$STATE/node_modules" ]; }; then
  say "initial migration found ambiguous pre-existing versioned state; recover it before retrying"
  exit 69
fi
if [ -z "$CURRENT_RESOLVED" ] && [ -d "$HOME/phone-tools" ] \
    && [ ! -L "$HOME/phone-tools" ] && [ -e "$PHONE_STATE" ]; then
  say "initial migration found ambiguous pre-existing phone control state; recover it before retrying"
  exit 69
fi
EXPECTED_APK_CODE="$(read_manifest android.versionCode)"
EXPECTED_APK_SIGNER="$(read_manifest android.signerSha256)"
EXPECTED_APK_SHA256="$(read_manifest android.sha256)"
INCOMING_APK_SIGNER="$(apk_signer_sha256 "$NEW_RELEASE/apk/evogent.apk" 2>/dev/null || true)"
[ "$INCOMING_APK_SIGNER" = "$EXPECTED_APK_SIGNER" ] \
  && [ "$(sha256_file "$NEW_RELEASE/apk/evogent.apk")" = "$EXPECTED_APK_SHA256" ] || {
  say "release APK bytes or signer do not match the manifest"
  exit 65
}
CURRENT_APK_PROBE="$STAGE/installed-current.apk"
backup_installed_apk "$CURRENT_APK_PROBE" || {
  say "could not read the currently installed APK"
  exit 70
}
INSTALLED_APK_CODE="$(installed_apk_version_code)"
INSTALLED_APK_SIGNER="$(apk_signer_sha256 "$CURRENT_APK_PROBE" 2>/dev/null || true)"
PREVIOUS_APK_CODE="$INSTALLED_APK_CODE"
PREVIOUS_APK_SIGNER="$INSTALLED_APK_SIGNER"
CURRENT_APK_SHA256="$(sha256_file "$CURRENT_APK_PROBE")"
if [ "$CURRENT_APK_SHA256" != "$EXPECTED_APK_SHA256" ]; then
  APK_CHANGED=1
  [[ "$INSTALLED_APK_CODE" =~ ^[0-9]+$ ]] \
    && [[ "$EXPECTED_APK_CODE" =~ ^[0-9]+$ ]] \
    && [ "$EXPECTED_APK_CODE" -gt "$INSTALLED_APK_CODE" ] || {
      say "changed APK requires a strictly higher Android version code"
      exit 65
    }
  package_manager_supports_apk_rollback || {
      say "Android package manager does not expose native app rollback; refusing the APK upgrade"
      exit 69
    }
fi
if [ "$CURRENT_RESOLVED" = "$NEW_RELEASE" ] \
    && [ "$INSTALLED_APK_CODE" = "$EXPECTED_APK_CODE" ] \
    && [ "$INSTALLED_APK_SIGNER" = "$EXPECTED_APK_SIGNER" ] \
    && [ "$(sha256_file "$CURRENT_APK_PROBE")" = "$EXPECTED_APK_SHA256" ]; then
  NOOP_HEALTH="$(evo_curl -sS -m 15 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
  NOOP_DEPLOYMENT="$(evo_curl -sS -m 15 -o "$STAGE/deployment-noop.json" -w '%{http_code}' \
    "$DEPLOYMENT_URL" 2>/dev/null || true)"
  if [ "$NOOP_HEALTH" = 200 ] && [ "$NOOP_DEPLOYMENT" = 200 ] \
      && verify_phone_tls_listener "$NEW_RELEASE" \
      && python3 - "$STAGE/deployment-noop.json" "$NEW_RELEASE/manifest.json" <<'PY'
import json
import sys
running = json.load(open(sys.argv[1], encoding="utf-8"))["running"]
manifest = json.load(open(sys.argv[2], encoding="utf-8"))
assert running["releaseId"] == manifest["releaseId"]
assert running["releaseFormat"] == manifest["releaseFormat"]
assert running["buildId"] == manifest["web"]["buildId"]
assert running["commitFull"] == manifest["source"]["commit"]
PY
  then
    SUCCESS=1
    exit 0
  fi
fi

# Allocate every recovery path and durably record intent before the first cycle
# gate or control-plane side effect. A SIGKILL from this point onward therefore
# leaves BootReceiver/next install enough truthful state to restart the prior
# runtime, while readiness flags prevent partial backups from being restored.
BACKUP_DIR="$BACKUPS/$STAMP-$RELEASE_ID"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
DB_BACKUP="$BACKUP_DIR/media-agent.db"
APK_BACKUP="$BACKUP_DIR/evogent.apk"
CONTROL_TOKEN_BACKUP="$BACKUP_DIR/control-token.txt"
if [ -z "$CURRENT_RESOLVED" ]; then
  INITIAL_MIGRATION=1
  MIGRATION_DIR="$MIGRATIONS/legacy-$STAMP"
  mkdir -p "$MIGRATION_DIR/home"
else
  MIGRATION_DIR="$MIGRATIONS/install-$STAMP-$RELEASE_ID"
  mkdir -p "$MIGRATION_DIR"
fi

# Establish a cycle gate with the exact same mkdir/PID-start lease understood by
# old and new cycles. Once held, no browse/curate task can begin during a switch.
CYCLE_GATE="$HOME/phone-tools/.cycle.lock"
if [ ! -e "$HOME/phone-tools" ]; then
  mkdir -p "$PHONE_STATE"
  CYCLE_GATE="$PHONE_STATE/.cycle.lock"
fi

prepare_transaction_recoverer
write_transaction_journal quiesce_pending
acquire_lock_dir "$CYCLE_GATE" release-install-cycle-gate
CYCLE_GATE_HELD=1

CONTROL_PLANE_MUTATION_STARTED=1
quiesce_control_plane
QUIESCED=1

# Stop and prove the exact server owner and both listeners before moving its cwd
# or private data.
# The cycle gate prevents a new background writer; taking the checked snapshot
# here also closes the display-0/user-write race during initial migration.
if ! stop_and_prove_runtime; then
  say "refusing an unsafe migration while a server listener remains"
  exit 70
fi

write_transaction_journal backup_pending
backup_database "$HOME/evogent/data/media-agent.db" "$DB_BACKUP"
backup_apk_for_rollback "$CURRENT_APK_PROBE" "$APK_BACKUP"
printf '%s\n' "$PREVIOUS_TARGET" > "$BACKUP_DIR/previous-release"
cp "$NEW_RELEASE/manifest.json" "$BACKUP_DIR/new-release-manifest.json"

# Record the pre-transaction authentication state before any migration.  The
# backup contains the secret; the journal contains only private paths/flags.
backup_control_token "$HOME/evogent/data/control-token.txt"

# Copy the small legacy dispatch surface before marking migration intent. If
# this copy is interrupted, the pre-quiesce journal leaves the originals alone.
if [ "$INITIAL_MIGRATION" = 1 ]; then
  if [ -d "$HOME/phone-tools" ] && [ ! -L "$HOME/phone-tools" ]; then
    cp -a "$HOME/phone-tools" "$MIGRATION_DIR/phone-tools"
  fi
  for name in start-prod.sh start-prod-sub.sh restart-evo.sh deploy-next.sh \
      install-evogent-release.sh; do
    if [ -e "$HOME/$name" ] || [ -L "$HOME/$name" ]; then
      cp -a "$HOME/$name" "$MIGRATION_DIR/home/$name"
    fi
  done
fi
write_transaction_journal prepared

# Install and prove the release APK before moving any legacy HOME path.  From
# this point onward BootReceiver itself knows the stable journal/recoverer path,
# so even a reboot during the first versioned migration can recover without
# depending on a temporarily moving ~/phone-tools symlink.
if [ "$APK_CHANGED" = 1 ]; then
  PACKAGE_OPERATION="$(allocate_shell_package_operation)" || {
    say "could not allocate a private Android package operation"
    exit 70
  }
  APK_INSTALL_ATTEMPTED=1
  write_transaction_journal apk_install_pending
  install_apk "$NEW_RELEASE/apk/evogent.apk" upgrade
fi
INSTALLED_APK_CODE="$(installed_apk_version_code)"
INSTALLED_APK_PROBE="$STAGE/installed-release.apk"
backup_installed_apk "$INSTALLED_APK_PROBE" || {
  say "could not read the installed release APK"
  exit 70
}
INSTALLED_APK_SIGNER="$(apk_signer_sha256 "$INSTALLED_APK_PROBE" 2>/dev/null || true)"
[ "$INSTALLED_APK_CODE" = "$EXPECTED_APK_CODE" ] \
  && [ "$INSTALLED_APK_SIGNER" = "$EXPECTED_APK_SIGNER" ] \
  && [ "$(sha256_file "$INSTALLED_APK_PROBE")" = "$EXPECTED_APK_SHA256" ] || {
  say "installed APK bytes, version, or signer do not match the release manifest"
  exit 70
}
if [ "$APK_CHANGED" = 1 ] \
    && ! wait_for_apk_rollback_availability \
        "$EXPECTED_APK_CODE" "$PREVIOUS_APK_CODE"; then
  say "Android did not make the exact APK rollback available; recovering before the runtime switch"
  exit 70
fi

# Initial migration preserves the full legacy runtime for recovery, then moves
# only private/machine-built state out of it. No user file is copied into a
# release or its manifest.
SWITCH_STARTED=1
if [ "$INITIAL_MIGRATION" = 1 ]; then
  MIGRATION_STARTED=1
fi
write_transaction_journal switch_pending
if [ -z "$CURRENT_RESOLVED" ]; then
  if [ -d "$HOME/evogent" ] && [ ! -L "$HOME/evogent" ]; then
    mv "$HOME/evogent" "$MIGRATION_DIR/evogent"
    [ -d "$MIGRATION_DIR/evogent/data" ] \
      && mv "$MIGRATION_DIR/evogent/data" "$STATE/data"
    [ -d "$MIGRATION_DIR/evogent/node_modules" ] \
      && mv "$MIGRATION_DIR/evogent/node_modules" "$STATE/node_modules"
    if [ -f "$MIGRATION_DIR/evogent/.env.local" ]; then
      mkdir -p "$STATE/config"
      mv "$MIGRATION_DIR/evogent/.env.local" "$STATE/config/.env.local"
    fi
  fi
  if [ -d "$HOME/phone-tools" ] && [ ! -L "$HOME/phone-tools" ]; then
    # The original becomes the stable state/dispatch directory so all existing
    # locks, logs, cadence artifacts, and recovery metadata live on.
    if [ "$HOME/phone-tools" != "$PHONE_STATE" ]; then
      rm -rf -- "$PHONE_STATE"
      mv "$HOME/phone-tools" "$PHONE_STATE"
      CYCLE_GATE="$PHONE_STATE/.cycle.lock"
    fi
  fi
  for name in start-prod.sh start-prod-sub.sh restart-evo.sh deploy-next.sh \
      install-evogent-release.sh; do
    if [ -e "$HOME/$name" ] || [ -L "$HOME/$name" ]; then
      rm -f "$HOME/$name"
    fi
  done
fi

mkdir -p "$STATE/data" "$STATE/config" "$STATE/next-cache/$RELEASE_ID" \
  "$PHONE_STATE"

# Public defaults seed only missing private files.
if [ -d "$NEW_RELEASE/defaults/data" ]; then
  (cd "$NEW_RELEASE/defaults/data" && find . -type f -print) | while IFS= read -r relative; do
    destination="$STATE/data/${relative#./}"
    if [ ! -e "$destination" ]; then
      mkdir -p "$(dirname "$destination")"
      cp "$NEW_RELEASE/defaults/data/${relative#./}" "$destination"
    fi
  done
fi

# The destination must remain a private regular file until the APK-scoped copy
# replaces it atomically below.
if [ -e "$CONTROL_TOKEN" ] || [ -L "$CONTROL_TOKEN" ]; then
  [ -f "$CONTROL_TOKEN" ] && [ ! -L "$CONTROL_TOKEN" ] || {
    say "phone control token is not a regular private file"
    exit 65
  }
  chmod 600 "$CONTROL_TOKEN"
fi

# Re-prove native loading through the release link immediately before the switch.
smoke_android_dependency_tree "$DEPENDENCIES/$EXPECTED_PACKAGE_LOCK" || {
  say "versioned Android dependency tree failed its pre-switch runtime smoke test"
  exit 70
}
(cd "$NEW_RELEASE/runtime" && npm ls --omit=dev --depth=0 >/dev/null)
(cd "$NEW_RELEASE/runtime" && node -e '
for (const name of ["next", "better-sqlite3", "ws", "dotenv"]) require.resolve(name);
')

# Build a stable phone-tools dispatch directory. Code links all travel through
# one current pointer; locks, logs, yield histories, and browse stamps stay here.
find "$NEW_RELEASE/phone-tools" -mindepth 1 -maxdepth 1 | while IFS= read -r source; do
  name="$(basename "$source")"
  target="$PHONE_STATE/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    mkdir -p "$MIGRATION_DIR/replaced-phone-tools"
    cp -a "$target" "$MIGRATION_DIR/replaced-phone-tools/$name"
  fi
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    printf '%s\n' "$name" >> "$MIGRATION_DIR/created-phone-links"
  fi
  rm -rf -- "$target"
  ln -s "$ROOT/current/phone-tools/$name" "$target"
done
rm -f "$PHONE_STATE/install-release.sh"
ln -s "$ROOT/current/device/install-release.sh" "$PHONE_STATE/install-release.sh"

# Stable public entrypoints all resolve through the same atomic release pointer.
rm -f "$HOME/evogent" "$HOME/phone-tools"
ln -s "$ROOT/current/runtime" "$HOME/evogent"
ln -s "$PHONE_STATE" "$HOME/phone-tools"
atomic_link "$ROOT/current/device/start-prod.sh" "$HOME/start-prod.sh"
rm -f "$HOME/start-prod-sub.sh"
atomic_link "$ROOT/current/device/restart-evo.sh" "$HOME/restart-evo.sh"
atomic_link "$ROOT/current/phone-tools/deploy-next.sh" "$HOME/deploy-next.sh"
atomic_link "$ROOT/current/device/install-release.sh" "$HOME/install-evogent-release.sh"

atomic_link "releases/$RELEASE_ID" "$CURRENT"

write_transaction_journal token_sync_pending
sync_control_token_from_apk
write_transaction_journal health_pending
bash "$HOME/restart-evo.sh"
EVOGENT_RELEASE_RECOVERY=1 EVOGENT_RELEASE_BOOT=1 \
  bash "$HOME/phone-tools/evogent-boot.sh"

READY=0
for _ in $(seq 1 60); do
  FEED_CODE="$(evo_curl -sS -m 10 -o /dev/null -w '%{http_code}' "$FEED_URL" 2>/dev/null || true)"
  HEALTH_CODE="$(evo_curl -sS -m 15 -o "$STAGE/health.json" -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
  DEPLOYMENT_CODE="$(evo_curl -sS -m 15 -o "$STAGE/deployment.json" -w '%{http_code}' "$DEPLOYMENT_URL" 2>/dev/null || true)"
  if [ "$FEED_CODE" = 200 ] && [ "$HEALTH_CODE" = 200 ] && [ "$DEPLOYMENT_CODE" = 200 ] \
      && verify_phone_tls_listener "$NEW_RELEASE" >/dev/null 2>&1; then
    if python3 - "$STAGE/health.json" "$STAGE/deployment.json" \
        "$NEW_RELEASE/manifest.json" <<'PY'
import json
import sys

health = json.load(open(sys.argv[1], encoding="utf-8"))
deployment = json.load(open(sys.argv[2], encoding="utf-8"))
manifest = json.load(open(sys.argv[3], encoding="utf-8"))
running = deployment["running"]
assert health["ok"] is True
assert health["runtime"]["profile"] == "phone"
assert health["runtime"]["backgroundJobsDisabled"] is True
assert running["releaseId"] == manifest["releaseId"]
assert running["releaseFormat"] == manifest["releaseFormat"]
assert running["buildId"] == manifest["web"]["buildId"]
assert running["commitFull"] == manifest["source"]["commit"]
PY
    then
      READY=1
      break
    fi
  fi
  sleep 2
done
[ "$READY" = 1 ] || {
  say "new release did not pass local phone health"
  exit 70
}

# The new runtime and synchronized authentication boundary are proven healthy.
# Commit durably before reopening the cycle gate; a reboot after this point
# keeps the verified release instead of conservatively rolling it back.
clear_transaction_journal
release_lock_dir "$CYCLE_GATE"
CYCLE_GATE_HELD=0
if [ "$INITIAL_MIGRATION" = 1 ]; then
  python3 "$DEPENDENCY_STATE_HELPER" reclaim-legacy "$ROOT" \
    || say "warning: committed legacy dependency state could not be reclaimed"
fi
python3 "$DEPENDENCY_STATE_HELPER" candidate-clear "$ROOT" "$RELEASE_ID" \
  || say "warning: committed release candidate marker could not be cleared"

# Bounded retention. Targets are validated release/backup/log names under exact
# narrow directories; current and previous releases are never removed. Retention
# is post-commit housekeeping: a cleanup error must not roll back a healthy
# release after its cycle gate has been reopened.
python3 - "$ROOT" "$KEEP_RELEASES" "$KEEP_BACKUPS" "$KEEP_LOGS" <<'PY' \
  || say "warning: release retention cleanup did not complete"
import json
import os
import pathlib
import re
import shutil
import sys

root = pathlib.Path(sys.argv[1])
keep_releases, keep_backups, keep_logs = map(int, sys.argv[2:])
safe = re.compile(r"^[A-Za-z0-9._-]+$")
protected = set()
current = root / "current"
if current.is_symlink():
    protected.add(current.resolve())
backups = root / "backups"
for marker in backups.glob("*/previous-release"):
    try:
        value = marker.read_text(encoding="utf-8").strip()
        if value:
            protected.add(pathlib.Path(value).resolve())
    except OSError:
        pass

releases = sorted(
    (p for p in (root / "releases").iterdir() if p.is_dir() and safe.fullmatch(p.name)),
    key=lambda p: p.stat().st_mtime,
    reverse=True,
)
for release in releases[keep_releases:]:
    if release.resolve() not in protected:
        for path in sorted(release.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            if not path.is_symlink():
                try:
                    os.chmod(path, 0o755 if path.is_dir() else 0o644)
                except OSError:
                    pass
        os.chmod(release, 0o755)
        shutil.rmtree(release)
        cache = root / "state" / "next-cache" / release.name
        if cache.is_dir():
            shutil.rmtree(cache)

referenced_dependencies = set()
for release in (root / "releases").iterdir():
    manifest = release / "manifest.json"
    if not release.is_dir() or release.is_symlink() or not manifest.is_file():
        continue
    try:
        lock = json.loads(manifest.read_text(encoding="utf-8"))["dependencies"]["packageLockSha256"]
        if re.fullmatch(r"[0-9a-f]{64}", lock):
            referenced_dependencies.add(lock)
    except (KeyError, OSError, ValueError, TypeError):
        pass
dependencies = root / "state" / "dependencies"
if dependencies.is_dir() and not dependencies.is_symlink():
    for tree in dependencies.iterdir():
        if (
            tree.is_dir()
            and not tree.is_symlink()
            and re.fullmatch(r"[0-9a-f]{64}", tree.name)
            and tree.name not in referenced_dependencies
        ):
            for path in sorted(tree.rglob("*"), key=lambda item: len(item.parts), reverse=True):
                if not path.is_symlink():
                    os.chmod(path, 0o700 if path.is_dir() else 0o600)
            os.chmod(tree, 0o700)
            shutil.rmtree(tree)

backup_dirs = sorted(
    (p for p in backups.iterdir() if p.is_dir() and safe.fullmatch(p.name)),
    key=lambda p: p.stat().st_mtime,
    reverse=True,
)
for backup in backup_dirs[keep_backups:]:
    shutil.rmtree(backup)

logs = sorted((root / "logs").glob("install-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
for log in logs[keep_logs:]:
    log.unlink()
PY
SUCCESS=1
