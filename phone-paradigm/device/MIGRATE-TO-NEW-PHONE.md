# Migrating Evogent to a new phone

Written 2026-07-18 for the Pixel 10a → Pixel Pro exchange; applies to any arm64/Android-16+
device. The runtime is portable: everything lives in Termux home + one tiny shell APK, so
migration = restore tar + rewire grants.

## TL;DR — the scripted path (do this)

Two scripts in this directory automate the whole thing; the prose below is the reference for
when a step needs hand-holding.

1. **On the OLD phone, before wiping:** `./backup-phone.sh <serial> <out-dir>` — clean DB copy,
   full Termux runtime tar, shell APK, manifest, all verified. Also grab `termux.apk` (F-Droid)
   and `shizuku.apk` (GitHub) into `<out-dir>` for the new phone.
2. **Human does the manual bits on the NEW phone** (see "owner's interactive steps"): sign into
   Google + the content apps, enable USB debugging + accept the dialog, install Termux+Shizuku
   (or let step 3 push them), and — once Termux is open — leave it foregrounded.
3. **From the Mac:** `./setup-new-phone.sh <serial> <backup-dir>` — installs APKs, starts
   Shizuku, bootstraps sshd, restores the runtime+DB, reinstalls packages, wires grants + the
   HOME role + control token, and starts the stack. Idempotent; pass a phase name to re-run one.

⚠️ **KNOWN OPEN ITEM — the phone comes up as a fully interactive restored feed, but the
autonomous browse/curate cycle stays PAUSED**: the codex brain (glibc) can't reach the network
on Android 16 (bionic works; glibc sockets get no route; not fixable via LD_PRELOAD because
codex uses raw syscalls). Full diagnosis + the two fix paths (bionic-native brain, or a ptrace
shim) are in [`research/README-brain-networking.md`](research/README-brain-networking.md).
Everything else — feed, app tap-through, thumbs-down, data — works.

## What the backup contains

`/Users/<private-value>/code-git/evogent-app/phone-backups/<device>-<date>/`:
- `pixel10a-full.tar.gz` — entire Termux `home` + `usr/etc` (evogent app with prebuilt `.next`
  and arm64 `node_modules`, `data/` incl. media crops, `phone-tools/`, `.codex/` auth,
  `.ssh/` host+authorized keys, home-dir scripts: `deploy-next.sh`, `restart-evo.sh`, …).
  Excludes caches and `data/tmp`.
- `media-agent-migration.db` — clean online `.backup` of the DB (taken while server ran; the
  tar's copy may be mid-write — **prefer this file**, quick_check verified).
- `evogent-shell-current.apk`, `pkg-list.txt`, `device-info.txt` (OS/tool versions to match).

## Old phone, before handing it in

1. Verify the backup exists on the Mac and quick_check passes (done for 2026-07-18).
2. Settings → Passwords & accounts → **remove the Google account** (clears Factory Reset
   Protection so the store can reuse the device), remove the screen-lock PIN.
3. Settings → System → Reset options → **Erase all data**. FBE crypto-erase destroys keys;
   nothing recoverable. Logged-in app sessions die with it.

## New phone — owner's interactive steps (~10 min of taps, must be human)

1. Normal Android setup; sign into Google; restore/install the content apps (X, Instagram,
   Gmail, YouTube, …) and **log into each** (Google restore usually carries most).
2. Enable Developer options → USB debugging; plug into the Mac and **accept the USB-debugging
   dialog** (never bypassed by the agent — house rule).
3. Install Termux (F-Droid build) + Shizuku (Play). Start Shizuku via wireless-debugging
   pairing (the pairing-code dialog is a human step).
4. Termux: allow battery-unrestricted; run `pkg install openssh && sshd` and add the Mac key
   (or `passwd` + `ssh-copy-id` once).
5. First `codex` run: one-tap ChatGPT auth **only if** the restored `~/.codex` doesn't just
   work (it usually does — try first).

## New phone — automated restore (agent, over adb-forwarded ssh)

1. `adb forward tcp:8023 tcp:8022`; scp the tar; extract from `/data/data/com.termux/files`:
   `tar xzf home/pixel10a-full.tar.gz` (restores home + usr/etc in place).
   `pkg install` from `pkg-list.txt` top-ups (node, python, tmux, **sqlite** — the 10a lacked
   the sqlite CLI, so the boot-time `PRAGMA quick_check` guard silently skipped; install it).
2. Replace `~/evogent/data/media-agent.db` with `media-agent-migration.db` (the clean copy).
3. Install the shell APK — gotchas from the 10a (memory: evogent-instagram-image-cards):
   push to `/data/local/tmp` (not /sdcard) for `pm install`; then
   `cmd role add-role-holder --user 0 android.app.role.HOME net.dangish.evogent` via rish.
4. Sync the control token: `/sdcard/Android/data/net.dangish.evogent/files/control-token.txt`
   → `~/evogent/data/control-token.txt` (fresh install mints a new one; stale clone token =
   silent a11y-loopback failure).
5. Grants via rish: run `phone-tools/a11y-heal.sh` (a11y service + notification listener),
   then `evogent-boot.sh` keep-alive block (phantom-procs, stayon, Shizuku oom pin).
6. Boot wiring: the APK BootReceiver → Termux RUN_COMMAND path needs
   `allow-external-apps=true` in `~/.termux/termux.properties` (restored by tar) and one
   manual Termux launch post-install. Remember FBE: nothing starts until first PIN unlock.
7. Verify `data/phone-sources/*.py` **symlinks** survived the tar (they point into
   `~/phone-tools/` — single-source-of-truth law); relink if not.
8. Start: `evogent-boot.sh` → server + scheduler + watchdog; then `verify-intents.py` and one
   supervised cycle end-to-end (browse → cache → curate → arrange) before trusting it.
9. Update the Mac side: nothing changes (repo is canonical); only the adb serial in any
   pinned commands and the 6:47 morning-audit's device expectations.

## Known migration risks

- **New IG/X/Gmail sessions** = story tray, engagement signals rebuild from zero; the
  account-tiers.json and preference data carry over (they're in `data/`).
- Codex token pickup was flaky on raw Termux once (memory: evogent-pixel-real-device) — if
  `codex` loops on auth, re-run the one-tap flow rather than fighting it.
- Screen geometry differs (Pro is larger): the story-viewer advance tap (`980,1200`) and
  swipe coordinates in `browse-instagram.py` / `phone.sh` are percentage-safe on most ops but
  audit any absolute coordinates on first supervised run.
- A Pro as the DAILY phone raises the bar: the feed is now the real home screen. Watch the
  first days' verify-intents and morning audits closely; real usage will surface taste gaps
  the PoC never saw (that's the point).
- **Magic Cue is ENABLED on the Pro** (owner's choice, 2026-07-18 — partly as competitive
  research for the anticipation engine). It injects suggestion chips into Gmail/Messages/
  Phone UIs → extra a11y nodes and occasional layout shifts in browsed apps, plus Gemini
  Nano memory pressure. If browse yield or extraction quality degrades on the Pro, Magic
  Cue is a first-class suspect: toggle it off for one cycle before deeper debugging.
