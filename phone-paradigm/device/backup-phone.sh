#!/bin/bash
# backup-phone.sh — capture a working Evogent phone before migration. Produces a directory with
# a clean DB copy, the Termux runtime, the shell APK, and a manifest. Run from a development host
# with adb and the phone connected over USB.
#
#   ./backup-phone.sh <adb-serial> <out-dir> <termux-user> <host-forward-port>
set -uo pipefail
SERIAL="${1:?adb serial}"
OUT="${2:?out dir}"
TERMUX_USER="${3:?Termux ssh user}"
HOST_SSH_PORT="${4:?host adb-forward port}"
DEVICE_SSH_PORT="${PHONE_DEVICE_SSH_PORT:-8022}"
REMOTE="${TERMUX_USER}@127.0.0.1"
A(){ adb -s "$SERIAL" "$@"; }
SSH=(ssh -p "$HOST_SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$REMOTE")
SCP=(scp -P "$HOST_SSH_PORT" -o StrictHostKeyChecking=accept-new)
mkdir -p "$OUT"
A forward "tcp:$HOST_SSH_PORT" "tcp:$DEVICE_SSH_PORT" >/dev/null

echo "== clean online DB backup (safe while the server runs) + integrity check =="
"${SSH[@]}" 'cd ~/evogent && python3 -c "
import sqlite3
s=sqlite3.connect(\"data/media-agent.db\"); d=sqlite3.connect(\"/data/data/com.termux/files/home/media-agent.db\")
s.backup(d); d.close()
c=sqlite3.connect(\"/data/data/com.termux/files/home/media-agent.db\")
print(\"quick_check:\", c.execute(\"PRAGMA quick_check\").fetchone()[0])
print(\"feed/cache/interactions:\", c.execute(\"SELECT COUNT(*) FROM feed\").fetchone()[0],
      c.execute(\"SELECT COUNT(*) FROM browse_cache_items\").fetchone()[0],
      c.execute(\"SELECT COUNT(*) FROM interactions\").fetchone()[0])"'

echo "== full Termux runtime tar (home + usr/etc; excludes caches) =="
"${SSH[@]}" 'cd /data/data/com.termux/files && tar czf ~/phone-full.tar.gz \
  --exclude="home/.npm" --exclude="home/.cache" --exclude="home/phone-full.tar.gz" \
  --exclude="home/evogent/data/tmp" --exclude="usr/var/cache" home usr/etc 2>/dev/null; du -h ~/phone-full.tar.gz'
"${SSH[@]}" 'pkg list-installed 2>/dev/null > ~/pkg-list.txt
  { uname -a; getprop ro.build.fingerprint; node --version; python3 --version; codex --version; } > ~/device-info.txt 2>&1'

echo "== pull everything to $OUT =="
"${SCP[@]}" "$REMOTE:phone-full.tar.gz" "$REMOTE:media-agent.db" \
     "$REMOTE:pkg-list.txt" "$REMOTE:device-info.txt" "$OUT/"
APK=$(A shell pm path net.dangish.evogent | head -1 | sed 's/^package://' | tr -d '\r')
A pull "$APK" "$OUT/evogent-shell.apk" >/dev/null

echo "== verify the host copies =="
sqlite3 "$OUT/media-agent.db" 'PRAGMA quick_check; SELECT COUNT(*) FROM feed;' 2>/dev/null || echo "(install sqlite3 to verify DB)"
tar tzf "$OUT/phone-full.tar.gz" | grep -c '^home/' | xargs echo "tar home entries:"
echo "backup-phone: done -> $OUT"
