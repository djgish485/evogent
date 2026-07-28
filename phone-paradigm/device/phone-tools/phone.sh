#!/data/data/com.termux/files/usr/bin/bash
# On-device background computer use for the Evogent chat agent (no adb, no root).
# Drives the user's real logged-in apps on a HIDDEN virtual display via Evogent's Shizuku
# UserService + accessibility service; the physical screen (display 0) keeps showing the
# Evogent feed the whole time. Results come back over a request-scoped loopback receiver
# (Termux is a different uid and cannot read Evogent's files or logcat).
#
# Usage:
#   phone.sh launch <pkg>          open <pkg> on a hidden display; prints + remembers its id
#   phone.sh see [display]         dump the node tree of that display (default: last launched)
#   phone.sh tap <text> [display]  tap the element whose text/desc contains <text>
#   phone.sh scroll [display]      scroll the display's list forward
#   phone.sh swipe <x1> <y1> <x2> <y2> [ms] [display]   coordinate swipe on the display
#   phone.sh swipe-rel <x1> <y1> <x2> <y2> [ms] [display]
#                                  swipe using per-thousand display coordinates
#   phone.sh benchmark-share-arm <run-id> <sequence> <token> <armed-at-ms>
#   phone.sh benchmark-share-clear <run-id>
#                                  authenticated one-shot benchmark provenance
set -euo pipefail
TOKEN=$(cat "$HOME/evogent/data/control-token.txt")
DISPFILE="$HOME/.phone-display"
OUT="$HOME/.phone-screen.txt"
EVO=net.dangish.evogent
TOOLS="$HOME/phone-tools"
. "$TOOLS/control-plane.sh"
A11Y_LISTENER_PID=""
A11Y_REQUEST_DIR=""
A11Y_LAST_REPLY=""
PHONE_COMMAND_LOCK_HELD=0
PHONE_COMMAND_OWNER_CREATED=0
PHONE_COMMAND_LOCK="$TOOLS/.cycle.lock"

stop_a11y_listener() {
  if [[ "$A11Y_LISTENER_PID" =~ ^[0-9]+$ ]]; then
    kill -TERM "$A11Y_LISTENER_PID" 2>/dev/null || true
    wait "$A11Y_LISTENER_PID" 2>/dev/null || true
  fi
  A11Y_LISTENER_PID=""
  if [ -n "$A11Y_REQUEST_DIR" ] && [ -d "$A11Y_REQUEST_DIR" ]; then
    rm -rf -- "$A11Y_REQUEST_DIR"
  fi
  A11Y_REQUEST_DIR=""
  A11Y_LAST_REPLY=""
}

phone_cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  stop_a11y_listener
  [ "$PHONE_COMMAND_LOCK_HELD" = 1 ] \
    && control_lock_release "$PHONE_COMMAND_LOCK" || true
  [ "$PHONE_COMMAND_OWNER_CREATED" = 1 ] && control_finish_owner || true
  exit "$rc"
}
trap phone_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Every mechanics invocation either proves that it inherited the live cycle
# owner or takes the same lease itself. The post-acquire journal check closes
# both release and scheduler TOCTOU windows; an already-admitted command is
# short and the installer waits for its lease before switching state.
acquire_display_lease() {
  local owner caller="${EVOGENT_TASK_OWNER:-}"
  if control_lock_live "$PHONE_COMMAND_LOCK"; then
    owner=$(control_lock_owner_id "$PHONE_COMMAND_LOCK")
    if [ -z "$caller" ] || [ "$caller" != "$owner" ]; then
      echo "ERROR: hidden display is leased by another live Evogent task"
      exit 75
    fi
  else
    control_init_owner phone-command || exit 70
    PHONE_COMMAND_OWNER_CREATED=1
    if ! control_lock_acquire "$PHONE_COMMAND_LOCK" phone-command; then
      echo "ERROR: hidden display lease changed before this command"
      exit 75
    fi
    PHONE_COMMAND_LOCK_HELD=1
  fi
  if control_release_transaction_pending \
      "${EVOGENT_RELEASE_ROOT:-$HOME/.local/share/evogent}"; then
    echo "ERROR: durable release transaction owns hidden-display mechanics"
    exit 75
  fi
  if ! control_lock_live "$PHONE_COMMAND_LOCK"; then
    echo "ERROR: hidden display is leased by another live Evogent task"
    exit 75
  fi
}

# Start a one-shot receiver on an OS-assigned loopback port. The 256-bit nonce is sent inside
# the already-token-authenticated explicit broadcast and must be repeated by the service inside
# the response envelope. Wrong/missing nonces are ignored until the bounded receiver times out.
start_a11y_listener() {
  local nonce="$1" tmpbase portfile
  stop_a11y_listener
  tmpbase="${TMPDIR:-${PREFIX:-$HOME}/tmp}"
  mkdir -p "$tmpbase"
  A11Y_REQUEST_DIR=$(mktemp -d "$tmpbase/evogent-a11y.XXXXXX")
  chmod 700 "$A11Y_REQUEST_DIR" 2>/dev/null || true
  portfile="$A11Y_REQUEST_DIR/port"
  A11Y_LAST_REPLY="$A11Y_REQUEST_DIR/reply"

  env A11Y_REPLY_NONCE="$nonce" A11Y_REPLY_PORT_FILE="$portfile" \
    node - >"$A11Y_LAST_REPLY" 2>/dev/null <<'NODE' &
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");

const nonce = process.env.A11Y_REPLY_NONCE || "";
const portFile = process.env.A11Y_REPLY_PORT_FILE || "";
const magic = "EVOGENT_A11Y_V1 ";
const maxBytes = 2 * 1024 * 1024;
if (!/^[0-9a-f]{64}$/.test(nonce) || !portFile) process.exit(2);

let accepted = false;
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(2000, () => socket.destroy());
  let body = "";
  let bytes = 0;
  socket.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > maxBytes) {
      socket.destroy();
      return;
    }
    body += chunk;
  });
  socket.on("error", () => {});
  socket.on("end", () => {
    if (accepted) return;
    const newline = body.indexOf("\n");
    if (newline < 0) return;
    const supplied = body.slice(magic.length, newline);
    const expectedBytes = Buffer.from(nonce, "ascii");
    const suppliedBytes = Buffer.from(supplied, "ascii");
    if (!body.startsWith(magic)
        || suppliedBytes.length !== expectedBytes.length
        || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) return;
    accepted = true;
    clearTimeout(deadline);
    server.close();
    process.stdout.write(body.slice(newline + 1), () => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
});
server.on("error", () => process.exit(3));
server.listen(0, "127.0.0.1", () => {
  const temp = portFile + "." + process.pid;
  fs.writeFileSync(temp, String(server.address().port) + "\n", {
    encoding: "ascii",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temp, portFile);
});
const deadline = setTimeout(() => {
  if (accepted) return;
  server.close(() => process.exit(4));
  setTimeout(() => process.exit(4), 250).unref();
}, 5000);
NODE
  A11Y_LISTENER_PID=$!

  local attempt port=""
  for attempt in $(seq 1 100); do
    if [ -s "$portfile" ]; then
      port=$(tr -dc '0-9' < "$portfile")
      break
    fi
    kill -0 "$A11Y_LISTENER_PID" 2>/dev/null || break
    sleep 0.05
  done
  if [[ ! "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
    stop_a11y_listener
    return 1
  fi
  A11Y_REPLY_PORT="$port"
}

# Fire an A11Y op and capture only its nonce-authenticated loopback response.
a11y_grab() {
  local nonce reply_rc snapshot
  nonce=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
  [[ "$nonce" =~ ^[0-9a-f]{64}$ ]] || return 1
  start_a11y_listener "$nonce" || return 1
  if ! am broadcast -a "$EVO.A11Y" "$@" --es token "$TOKEN" \
      --ei reply_port "$A11Y_REPLY_PORT" --es reply_nonce "$nonce" \
      -p "$EVO" >/dev/null 2>&1; then
    stop_a11y_listener
    return 1
  fi
  if wait "$A11Y_LISTENER_PID"; then reply_rc=0; else reply_rc=$?; fi
  A11Y_LISTENER_PID=""
  if [ "$reply_rc" -ne 0 ] || [ ! -f "$A11Y_LAST_REPLY" ]; then
    echo "ERROR: no authenticated accessibility reply" >&2
    return 1
  fi
  # Keep the legacy snapshot for diagnostics, but current callers read their unique reply file
  # so concurrent requests cannot overwrite one another between receive and parse.
  snapshot="$OUT.tmp.$$.$RANDOM"
  cp "$A11Y_LAST_REPLY" "$snapshot"
  mv "$snapshot" "$OUT"
}
a11y_fire() { am broadcast -a $EVO.A11Y "$@" --es token "$TOKEN" -p $EVO >/dev/null 2>&1; sleep 2; }
cur_disp() {
  local display="${1:-}"
  if [ -z "$display" ]; then
    display=$(cat "$DISPFILE" 2>/dev/null || true)
  fi
  if [[ ! "$display" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: no proved hidden display is selected; refusing to target physical display 0" >&2
    return 1
  fi
  printf '%s\n' "$display"
}

display_size() {
  local display="$1" output dimensions
  [[ "$display" =~ ^[0-9]+$ ]] || return 1
  output=$(control_rish_bounded "wm size -d $display" 2>/dev/null) || return 1
  dimensions=$(printf '%s\n' "$output" |
    sed -nE 's/.*[^0-9]([0-9]{2,5})x([0-9]{2,5}).*/\1 \2/p' | tail -1)
  [[ "$dimensions" =~ ^[0-9]+[[:space:]][0-9]+$ ]] || return 1
  printf '%s\n' "$dimensions"
}

case "${1:-}" in
  launch|see|tap|scroll|swipe|swipe-rel|shot|clip|paste|shotnode|stop|close|benchmark-share-arm|benchmark-share-clear) acquire_display_lease ;;
esac

case "${1:-}" in
  benchmark-share-arm)
    RUN_ID="${2:-}"
    SEQUENCE="${3:-}"
    SHARE_TOKEN="${4:-}"
    ARMED_AT_MS="${5:-}"
    [[ "$RUN_ID" =~ ^full-browse-[A-Za-z0-9][A-Za-z0-9._:-]{7,140}$ ]] || {
      echo "ERROR: invalid benchmark run identity" >&2
      exit 64
    }
    [[ "$SEQUENCE" =~ ^[1-5]$ ]] || {
      echo "ERROR: benchmark share sequence must be 1..5" >&2
      exit 64
    }
    [[ "$SHARE_TOKEN" =~ ^[a-f0-9]{64}$ ]] || {
      echo "ERROR: invalid benchmark share token" >&2
      exit 64
    }
    [[ "$ARMED_AT_MS" =~ ^[1-9][0-9]{11,14}$ ]] || {
      echo "ERROR: invalid benchmark share arm timestamp" >&2
      exit 64
    }
    if ! a11y_grab --es op benchmark_share_arm --es run_id "$RUN_ID" \
        --ei sequence "$SEQUENCE" --es share_token "$SHARE_TOKEN" \
        --el armed_at_ms "$ARMED_AT_MS"; then
      echo "ERROR: benchmark share arm was not acknowledged" >&2
      exit 1
    fi
    ARM_RESULT=$(tr -d '\r\n' < "$A11Y_LAST_REPLY")
    if [ "$ARM_RESULT" != "armed" ]; then
      echo "ERROR: benchmark share arm was refused" >&2
      exit 1
    fi
    echo "BROWSE_SHARE_ARMED $SEQUENCE"
    ;;
  benchmark-share-clear)
    RUN_ID="${2:-}"
    [[ "$RUN_ID" =~ ^full-browse-[A-Za-z0-9][A-Za-z0-9._:-]{7,140}$ ]] || {
      echo "ERROR: invalid benchmark run identity" >&2
      exit 64
    }
    if ! a11y_grab --es op benchmark_share_clear --es run_id "$RUN_ID"; then
      echo "ERROR: benchmark share cleanup was not acknowledged" >&2
      exit 1
    fi
    CLEAR_RESULT=$(tr -d '\r\n' < "$A11Y_LAST_REPLY")
    if [ "$CLEAR_RESULT" != "cleared" ]; then
      echo "ERROR: benchmark share cleanup was refused" >&2
      exit 1
    fi
    echo "BROWSE_SHARE_CLEARED"
    ;;
  launch)
    PKG="$2"
    [[ "$PKG" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || {
      echo "ERROR: invalid Android package name"
      exit 2
    }
    # Active-use guard: the privileged launch FORCE-STOPS the target app to move it to the
    # hidden display. If the user is holding the phone with that very app foregrounded on
    # display 0, that would kill the app in their hands.
    # Prove state from complete dumps rather than grepping a lossy task summary. Missing rish,
    # timeouts, changed dumpsys formats, and ambiguous fields all produce "refuse-unproven".
    POWER_DUMP=$(control_rish_bounded 'dumpsys power 2>/dev/null' 2>/dev/null || true)
    WINDOW_DUMP=$(control_rish_bounded 'dumpsys window 2>/dev/null' 2>/dev/null || true)
    WAKE_STATE=$(printf '%s\n' "$POWER_DUMP" | control_screen_wake_state_from_dump)
    LOCK_STATE=$(printf '%s\n' "$WINDOW_DUMP" | control_lockscreen_state_from_dump)
    DISPLAY_ZERO_PACKAGE=""
    if [ "$WAKE_STATE" = "awake" ] && [ "$LOCK_STATE" = "unlocked" ]; then
      ACTIVITY_DUMP=$(control_rish_bounded 'dumpsys activity activities 2>/dev/null' \
        2>/dev/null || true)
      DISPLAY_ZERO_PACKAGE=$(printf '%s\n' "$ACTIVITY_DUMP" |
        control_display_zero_top_resumed_from_dump 2>/dev/null || true)
    fi
    LAUNCH_VERDICT=$(control_hidden_launch_verdict \
      "$WAKE_STATE" "$LOCK_STATE" "$DISPLAY_ZERO_PACKAGE" "$PKG")
    case "$LAUNCH_VERDICT" in
      safe-unattended|safe-locked|safe-different-app) ;;
      refuse-active-target)
        echo "ERROR: $PKG is in active foreground use on the real screen - refusing to yank it"
        exit 1
        ;;
      *)
        echo "ERROR: could not prove the physical screen safe for a hidden-display launch"
        exit 1
        ;;
    esac
    am broadcast -a $EVO.SHIZUKU --es op launch --es pkg "$PKG" --es token "$TOKEN" -p $EVO >/dev/null 2>&1
    # The app window can take a variable time to appear on the hidden display (cold start, first
    # composite after the desktop-windowing power-on). A single fixed wait + one windows dump
    # raced and reported "did not land" while the app was still coming up. Poll the a11y windows
    # list until the package shows up, up to ~24s.
    DISP=""
    for _try in 1 2 3 4 5 6; do
      sleep 4
      if ! a11y_grab --es op windows; then
        continue
      fi
      DISP=$(control_hidden_display_for_package_from_windows_dump "$PKG" \
        < "$A11Y_LAST_REPLY" 2>/dev/null || true)
      [ -n "$DISP" ] && break
    done
    [[ "$DISP" =~ ^[1-9][0-9]*$ ]] || {
      echo "ERROR: $PKG did not land unambiguously on a hidden display"
      exit 1
    }
    echo "$DISP" > "$DISPFILE"
    control_track_package "$PKG" || true
    echo "launched $PKG on hidden display $DISP (physical display 0 unchanged)"
    ;;
  see)
    D=$(cur_disp "${2:-}")
    a11y_grab --es op nodes --ei display "$D"
    cat "$A11Y_LAST_REPLY"
    ;;
  tap)
    D=$(cur_disp "${3:-}")
    if ! a11y_grab --es op clicktext --ei display "$D" --es text "$2"; then
      echo "ERROR: no authenticated click result for '$2' on display $D"
      exit 1
    fi
    CLICK_RESULT=$(tr -d '\r\n' < "$A11Y_LAST_REPLY")
    if [ "$CLICK_RESULT" != "performed" ]; then
      echo "ERROR: click '$2' on display $D was not performed ($CLICK_RESULT)"
      exit 1
    fi
    sleep 2
    echo "tapped '$2' on display $D (performed)"
    ;;
  scroll)
    D=$(cur_disp "${2:-}")
    a11y_fire --es op scroll --ei display "$D"
    echo "scrolled display $D"
    ;;
  swipe)
    D=$(cur_disp "${7:-}")
    a11y_fire --es op gesture --ei display "$D" --ei x1 "$2" --ei y1 "$3" --ei x2 "$4" --ei y2 "$5" --ei ms "${6:-250}"
    echo "swiped display $D"
    ;;
  swipe-rel)
    # Relative inputs are integers in [0,1000], so checked-in recipes describe portable
    # gestures rather than one person's screen dimensions.
    D=$(cur_disp "${7:-}")
    for PART in "$2" "$3" "$4" "$5"; do
      [[ "$PART" =~ ^[0-9]+$ ]] && [ "$PART" -le 1000 ] || {
        echo "ERROR: relative swipe coordinates must be integers from 0 through 1000" >&2
        exit 64
      }
    done
    SIZE=$(display_size "$D") || {
      echo "ERROR: could not derive dimensions for display $D" >&2
      exit 69
    }
    read -r WIDTH HEIGHT <<<"$SIZE"
    X1=$(( WIDTH * $2 / 1000 )); Y1=$(( HEIGHT * $3 / 1000 ))
    X2=$(( WIDTH * $4 / 1000 )); Y2=$(( HEIGHT * $5 / 1000 ))
    a11y_fire --es op gesture --ei display "$D" \
      --ei x1 "$X1" --ei y1 "$Y1" --ei x2 "$X2" --ei y2 "$Y2" --ei ms "${6:-250}"
    echo "swiped display $D using relative geometry"
    ;;
  shot)
    # Capture real pixels of the (hidden) display to a PNG. The a11y service writes
    # <name>.png into its own external files dir; sync it out to $2 (default ~/.phone-shot.png)
    # so Termux (a different uid) can read it. This is the generalizable image-capture primitive
    # (works for ANY app: Instagram post images, etc. — no per-app parser).
    D=$(cur_disp "${3:-}")
    NAME="evo-shot-$D"
    a11y_fire --es op shot --ei display "$D" --es name "$NAME"
    sleep 1
    SRC="/sdcard/Android/data/$EVO/files/$NAME.png"
    DEST="${2:-$HOME/.phone-shot.png}"
    # Piping PNG bytes through `rish -c cat` can corrupt or truncate them. Have the privileged
    # shell copy the file to /sdcard root, then read it with normal storage access.
    STAGE="/sdcard/$NAME.png"
    control_rish_bounded "cp '$SRC' '$STAGE'" >/dev/null 2>&1
    if cp "$STAGE" "$DEST" 2>/dev/null && [ -s "$DEST" ]; then
      control_rish_bounded "rm -f '$STAGE'" >/dev/null 2>&1 || true
      echo "shot display $D -> $DEST ($(wc -c < "$DEST") bytes)"
    else
      echo "ERROR: shot for display $D not readable at $SRC (staged $STAGE)"
    fi
    ;;
  clip)
    # Read the system clipboard directly (the Evogent foreground app is allowed to). Used to read
    # a "Copy link" URL an app only exposes via the clipboard.
    a11y_grab --es op clip
    cat "$A11Y_LAST_REPLY"
    ;;
  paste)
    # Paste the clipboard into a focused editable field on the display and print the field text
    # (how we read a "Copy link" URL an app only exposes via clipboard). Tap the field first.
    D=$(cur_disp "${2:-}")
    a11y_grab --es op paste --ei display "$D"
    cat "$A11Y_LAST_REPLY"
    ;;
  shotnode)
    # Crop just the CONTENT IMAGE of a matched item to a PNG. The a11y service finds the
    # container whose text/desc contains <match>, then crops the screenshot to the largest
    # full-width image-shaped element inside it (the post photo). General image-card primitive:
    #   phone.sh shotnode "<match substring>" [dest] [display] [name]
    D=$(cur_disp "${4:-}")
    NAME="${5:-evo-node-$D}"
    a11y_fire --es op shotnode --ei display "$D" --es match "$2" --es name "$NAME"
    sleep 1
    SRC="/sdcard/Android/data/$EVO/files/$NAME.png"
    DEST="${3:-$HOME/.phone-node.png}"
    STAGE="/sdcard/$NAME.png"
    control_rish_bounded "cp '$SRC' '$STAGE'" >/dev/null 2>&1
    if cp "$STAGE" "$DEST" 2>/dev/null && [ -s "$DEST" ]; then
      control_rish_bounded "rm -f '$STAGE'" >/dev/null 2>&1 || true
      echo "shotnode '$2' display $D -> $DEST ($(wc -c < "$DEST") bytes)"
    else
      echo "ERROR: shotnode for '$2' on display $D not readable at $SRC (staged $STAGE)"
    fi
    ;;
  stop)
    PKG="${2:-}"
    if control_safe_force_stop_package "$PKG"; then
      echo "stopped $PKG after physical-screen safety proof"
    else
      echo "ERROR: refusing to stop $PKG without physical-screen safety proof"
      exit 75
    fi
    ;;
  close)
    control_close_hidden_displays
    echo "closed Evogent hidden display"
    ;;
  *)
    echo "usage: phone.sh {launch <pkg>|see [display]|tap <text> [display]|scroll [display]|swipe x1 y1 x2 y2 [ms] [display]|swipe-rel x1‰ y1‰ x2‰ y2‰ [ms] [display]|shot [dest] [display]|shotnode <match> [dest] [display] [name]|benchmark-share-arm <run-id> <sequence> <token> <armed-at-ms>|benchmark-share-clear <run-id>|stop <pkg>|close}"; exit 1;;
esac
