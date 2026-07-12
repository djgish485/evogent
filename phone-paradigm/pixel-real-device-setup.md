# Evogent on a real Pixel (10a, Android 16) — proven setup + findings

First real-device bring-up (2026-07-09). The full phone paradigm runs on a stock Pixel 10a:
background-browses the user's logged-in X app on a hidden display → caches tweets → curates
on-device → renders a tweet-heavy feed in the Evogent app, with Evogent as the home screen.
This is the sideload/Termux path (what a technical user does today); the productized path is a
flashed system image — see "Flashed image removes all friction" below.

## Install flow (Pixel, USB-connected, arm64 — same arch as the emulator)

1. **Sideload the 3 APKs** (pull from a working emulator for guaranteed-compatible versions):
   `adb pull $(pm path com.termux|...)` for `com.termux`, `net.dangish.evogent`,
   `moe.shizuku.privileged.api`. Termux install is blocked by Play Protect
   (`INSTALL_FAILED_VERIFICATION_FAILURE`) until `adb shell settings put global
   verifier_verify_adb_installs 0`; then `adb install -r -g`.
2. **Termux shell access:** launch Termux, let it bootstrap; grant all-files access
   (`appops set com.termux MANAGE_EXTERNAL_STORAGE allow`), push a setup script to
   `/sdcard/Download`, type `bash /sdcard/Download/...` via `adb shell input text` (spaces=`%s`);
   the script `pkg install openssh`, appends the Mac's authorized_key, starts `sshd`. Then
   `adb forward tcp:8023 tcp:8022` and SSH in (Pixel Termux user is a fresh `u0_aNNN`).
3. **Clone the runtime from the emulator** (both arm64, so binaries transfer): stream over SSH,
   no intermediate file — `tsh 'tar cf - evogent phone-tools .codex-bin .claude-bin ...' |
   psh 'tar xf -'` (exclude the DB → fresh feed). ~1.2GB: evogent (server + prebuilt .next +
   node_modules with native arm64 better-sqlite3), the codex musl binary, the claude glibc binary.
4. **Base packages + wrappers:** `pkg install nodejs-lts proot glibc-repo glibc-runner
   ca-certificates python tmux`. Re-apply the grun `"$@"` quoting patch (a fresh glibc-runner is
   unpatched). Recreate `$PREFIX/bin/{codex,claude}` wrappers. **resolv.conf must use PUBLIC DNS**
   on the phone (`8.8.8.8/8.8.4.4/1.1.1.1`), NOT the emulator's `10.0.2.3`.
5. **Shizuku:** already authorized for Evogent via the `install -g`; start `shizuku_server` by
   EXECUTING (not `sh`-ing) `.../lib/arm64/libshizuku.so` via adb.
6. **Accessibility:** `settings put secure enabled_accessibility_services
   net.dangish.evogent/net.dangish.evogent.EvogentAccessibilityService` + `accessibility_enabled 1`.
   On Android 16 a SIDELOADED a11y service normally needs a manual Settings toggle + "Allow
   restricted settings" — BUT here the service bound anyway (dumpsys `Bound services` showed it).
   **THE GOTCHA:** the loopback health check (`a11y-check.sh`) read the CLONED emulator control
   token and falsely returned 0. The a11y service writes its token to
   `/sdcard/Android/data/net.dangish.evogent/files/control-token.txt` — **sync that to
   `~/evogent/data/control-token.txt`** and the loopback works (returned 607 bytes; `phone.sh see`
   read the real X timeline). Accessibility was never actually the blocker.
7. **Persistence:** `settings put global settings_enable_monitor_phantom_procs false`,
   `appops set com.termux SYSTEM_ALERT_WINDOW allow`, `svc power stayon true`, `termux-wake-lock`
   (foreground service so Android doesn't kill Termux's background procs — needed on the phone,
   the emulator didn't), `dumpsys deviceidle whitelist +com.termux`.
8. **Evogent as home:** `adb shell cmd package set-home-activity net.dangish.evogent/.MainActivity`
   (MainActivity already declares the HOME intent-filter). Swipe-up/home → the feed; the app-drawer
   grid button opens `AppDrawerActivity`, and BACK returns to `MainActivity`.

## Findings that matter

- **Claude is TOO HEAVY on the phone.** A full curation took ~5 min and its sustained CPU load
  destabilized/crashed the Node server twice (a leftover node proc held the port; a Redis
  reconnect loop to :6379 — Redis is absent, non-fatal but noisy). On the Mac-backed emulator this
  was fine; the Pixel's Tensor G5 can't run the heavy glibc-Claude CLI alongside the server well.
  **Codex (a lean compiled binary) is the right brain for the phone** — the top follow-up.
- **Don't drive the browse with a heavy brain.** A brain-driven X browse starved the server for
  2+ min with no output. The light **`browse-x-parse.py`** (runs `phone.sh see`, regex-parses
  tweets from the a11y node desc, POSTs to browse-cache) is far lighter and reliable — but it
  scrapes few tweets per pass (scroll/filter tuning needed for volume).
- **Codex device-auth on-device:** a pre-filled URL
  `auth.openai.com/codex/device?user_code=<CODE>` skips the code field and jumps to the account
  chooser (clean). The browser reaches "Signed in to Codex", but the **raw-Termux CLI token pickup
  is flaky** (the polling process dies on SIGHUP under proot; `termux-wake-lock` + `setsid`/`nohup`
  help but it's fragile). A productized app uses the localhost callback flow and manages the
  process — this glitch is a hand-driven-setup artifact.
- **Server resilience:** it crashes under sustained brain load and the WebView then shows
  "webpage not available" (localhost:3001 refused). Needs a supervised restart + the WebView
  should auto-retry.
- **Verified end-to-end:** browsed the real X home timeline on hidden display (teortaxes on AI
  incumbents, ConjectureInst on constructor theory, SashaGusev) → cached → curated (Claude) into a
  thread "AI competition is holding; oversight is catching up" with @teortaxesTex's tweet →
  rendered in-app. Tweet-heavy config (see `emulator-curation-profile.md`, adapted: X is LIVE on
  a real device, so tweets are the heartbeat — no suspension).

## Boot-start: surviving a reboot (sideload/Termux path)

Evogent must come back on its own after the phone reboots. On the sideload/Termux path the
stack spans several components with different reboot behavior. **Install agents: set all of
this up, then verify with one real reboot.**

**Survives a reboot automatically (no action needed):**
- Accessibility + notification-listener **grants** — Android keeps the grant; the services
  re-bind on boot. (`a11y-heal.sh`, run by the boot script, re-asserts them to be safe.)
- Termux on the **battery-optimization whitelist** (`dumpsys deviceidle whitelist +com.termux`).
- **Persistent global settings** once set: `settings put global
  settings_enable_monitor_phantom_procs false` (the phantom-process killer that otherwise
  reaps the Node server + tmux) survives reboot. `device_config` values may not — the boot
  script re-applies them.

**Does NOT survive — and how it's handled:**
- **Server + periodic scheduler** → started by the **Evogent APK's `BootReceiver`**, which
  fires a **Termux `RUN_COMMAND` intent** running `~/phone-tools/evogent-boot.sh` (starts the
  Node server in tmux `evo`, then the scheduler in tmux `evo-sched`, then re-applies keep-alive
  settings via Shizuku). **No Termux:Boot addon is required** — Evogent bootstraps Termux
  itself. Requires `allow-external-apps=true` in `~/.termux/termux.properties` (set) and the
  `com.termux.permission.RUN_COMMAND` permission in the APK (declared). `evogent-boot.sh` is
  idempotent, so re-running it is harmless.
  - *Optional belt-and-suspenders:* install the **Termux:Boot addon**; `~/.termux/boot/
    10-evogent.sh` (deployed) defers to the same `evogent-boot.sh`.
- **Shizuku privileged server** (the shell-uid broker `rish`/hidden-display browse depend on)
  → the Shizuku **app** may auto-start, but the **`shizuku_server` process does NOT survive a
  reboot on a non-rooted device**. The durable fix is Shizuku's own **"Start on boot"** feature:
  in the Shizuku app, enable **Wireless debugging** pairing + **Start on boot**. Without it,
  the feed still works after reboot (server + scheduler + cached content), but **background
  source-browsing is down until `shizuku_server` is restarted** (dev: re-run `restore-device.sh`
  from the Mac; standalone: Shizuku start-on-boot). Known fragility: after a server restart the
  first `rish` calls can time out and Termux may need re-authorizing in the Shizuku app UI.
- **adb port-forward (`8023→8022`) + sshd** → **dev/Mac-access only**, NOT part of standalone
  operation. A user's phone runs the server, app, and browse fully on-device; it needs no Mac
  and no SSH. `evogent-boot.sh` starts `sshd` only when `~/.evogent-dev-ssh` exists (a dev opt-in).

**Install-agent boot-start checklist:**
1. Deploy `phone-tools/evogent-boot.sh` (+ `~/.termux/boot/10-evogent.sh` if using the addon).
2. Confirm the APK holds `com.termux.permission.RUN_COMMAND` and Termux has
   `allow-external-apps=true`.
3. `dumpsys deviceidle whitelist +com.termux` and `+moe.shizuku.privileged.api`.
4. Enable **Shizuku "Start on boot"** (needed for source-browsing to survive reboot).
5. Set the persistent phantom-process-killer + stayon settings once (the boot script re-applies).
6. **Reboot and verify:** feed loads (server 200), `tmux ls` shows `evo` + `evo-sched`, and — if
   Shizuku start-on-boot is on — `rish id` returns `uid=2000` so source-browsing works.

The flashed-image path below removes the Shizuku half of this entirely (system app = native
display privilege), leaving only the server/scheduler bringup, which the OS init handles.

## Flashed image removes ALL of this friction (for non-tech users)

Every friction above is a property of the **sideload/Termux** path. A flashed AOSP image with
Evogent as a **system/privileged app + bundled runtime** removes them: no Termux (so no
"allow background" dialog and no phantom-kill), accessibility **pre-granted** in the image
(the restricted-settings block only applies to sideloaded apps), **no Shizuku** (system app has
the display privileges natively), and Codex auth becomes a one-tap app-driven "Sign in with
ChatGPT" (localhost callback, no code). Precedent: Murena for the image model, OpenClaw for the
one-tap subscription auth. NOT built yet — this is the productization roadmap, credible and
precedented, not a proven finished experience.
