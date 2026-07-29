# Stock Android phone setup notes

This document records the technical-user setup constraints proven on stock arm64
Android phones. It complements, but does not replace:

- [`docs/phone-production.md`](../docs/phone-production.md) — architecture
- [`docs/phone-installation-and-provisioning.md`](../docs/phone-installation-and-provisioning.md) — manual and managed installation channels
- [`device/MIGRATE-TO-NEW-PHONE.md`](device/MIGRATE-TO-NEW-PHONE.md) — procedure
- [`device/DEV-LOOP.md`](device/DEV-LOOP.md) — host development workflow

Use placeholders in public commands. Put the real serial, SSH user, ports, and
device observations in the uncommitted host notes file.

## Components

The current stock-device path requires:

- the Evogent shell APK, selected for the Android HOME and ASSISTANT roles;
- Termux with Node, SQLite, Python, tmux, the configured brain CLI, and the
  on-phone release;
- Shizuku for shell-uid hidden-display capabilities;
- Evogent accessibility and notification-listener grants; and
- the per-install accessibility control token synchronized to the private Termux
  runtime.

Do not clone an old application tree as the release. Install one host-built,
versioned component set and restore compatible private data separately.

## Bring-up sequence

1. Install and open Termux and Shizuku from trusted sources.
2. Install the current Evogent APK and launch it once. A Play Protect scan,
   package-installer confirmation, or developer-verification screen is a
   foreground `user_action_required` step. Preserve the release transaction and
   resume it after fresh package proof; never disable or bypass the platform
   control. During initial bootstrap before the versioned installer is
   available, select Evogent as both the Home app and digital assistant through
   Android's role UI.
3. Enable the accessibility service, notification access, and any restricted
   settings Android requires for a sideloaded accessibility tool. On Android
   13+, return to the Evogent HOME surface after notification access is enabled:
   Evogent asks once for permission to post its own curated digest. Denial is
   respected and leaves every original notification untouched.
4. Pair/start Shizuku and authorize Evogent.
5. Enable the Android windowing capabilities required by the current OS build for
   an app launched onto a shell-created virtual display to render. Verify this
   with a harmless app; a created display ID alone is not proof.
6. Install the current phone release with the versioned bundle installer. It
   privately snapshots both prior role holders, proves the APK, assigns and
   verifies HOME and ASSISTANT, and restores both prior holders on rollback.
   The installed runtime starts through the canonical `device/start-prod.sh`
   path.
7. Synchronize the control token minted by this APK installation. A token copied
   from another device or install fails closed.
8. Select and authenticate a brain provider on the device.
9. Request one scheduler-owned cycle, then inspect the rendered result on display
   0.

After any APK reinstall, expect Android to clear or restrict some grants. The
supported release installer re-checks both roles transactionally; use Android's
role UI only for initial setup or fallback. Launch the package once, re-check
the accessibility service, and verify the control token before debugging higher
layers.

## Hidden-display verification

The privileged service must create a trusted hidden display capable of hosting
tasks. Verify all of these:

- the activity is actually placed on that display;
- the app reports itself visible and draws a non-blank frame;
- accessibility returns a non-null tree for that display;
- a gesture changes the expected screen state; and
- teardown removes the display and stale ownership state.

A display ID, successful binder return, blank screenshot, or old display-state
file is not sufficient.

App UIs change. Mechanics should report launch/capture/gesture outcomes, and an
agent should diagnose anomalous yield from the live surface. Avoid hard-coding
editorial or account-specific behavior into the driver.

## Boot and first unlock

Android File-Based Encryption keeps Termux's credential-encrypted files
unavailable until the owner completes the first unlock after a reboot. Evogent
cannot bypass that boundary.

After first unlock:

1. Android's Evogent boot receiver wakes the Termux boot path.
2. The canonical boot script starts the loopback phone-profile server, sole
   scheduler, and independent watchdog.
3. Shizuku must be running before hidden-display sources can browse.

The APK does not own a periodic browse alarm. The Termux scheduler is the only
cycle authority. Termux:Boot may provide redundant startup signaling, but it must
enter the same idempotent boot path rather than create another scheduler.

Test recovery with a real reboot followed by owner unlock. Verify local health,
one scheduler lease, Shizuku capability, accessibility data, and a scheduled
cycle. A tmux session name alone is not proof.

## Power behavior

Android may block hidden-display launch or suspend long-running private-learning
work in deep Doze. The runtime can take a scoped wake lock for an active browse
or bounded scheduled task, or request an idle exit immediately before due app
browsing, but it must release that state in cleanup after success, empty yield,
timeout, signal, or error.

Termux exposes one app-global wake lock, not independently owned locks per
script. Evogent therefore refuses to touch it by default. On a phone where the
Termux installation is dedicated to Evogent, the owner may create the private
mode-0600 marker `~/phone-tools/.dedicated-termux-wake` containing exactly
`EVOGENT_DEDICATED_TERMUX_WAKE_V1`. Never enable this on a shared Termux
installation: an unlock would affect its other work.

Do not use a permanent wake lock as the default production fix. Record the
attempted source, power action, elapsed time, yield, and cleanup outcome so the
private cadence model can balance freshness and battery use.

## Notification and lock-screen curation

Notification access is device-wide, not per-app. Evogent therefore enforces its
own local safety boundary, defaults to Observe, and exposes mode, private/detailed
lock-screen preview, and per-app preservation controls under Settings → Phone
Alerts. Curated shade replaces only eligible ordinary notifications after an
exact durable receipt and an active replacement digest. Calls, alarms,
navigation, foreground services, high-importance, system/safety, secret, and
group-summary originals remain.

`NotificationListenerService` runs after Android posts a notification. It cannot
replace Android's lock screen, At a Glance, media, alarm, call, authentication,
emergency, or other System UI. Use the capability and failure drills in
[`docs/phone-notification-curation.md`](../docs/phone-notification-curation.md);
never describe the listener as pre-display interception or full lock-screen
control.

## Server behavior on the phone

The canonical phone start path sets the phone runtime profile:

- listen on `127.0.0.1`;
- no Redis or VM background worker;
- SQLite as the durable state source;
- adaptive heartbeat writes a phone-cycle signal; and
- code-fix suggestions wait for host review.

If logs show Redis reconnects, an all-interface listener, or a direct adaptive
curator beside the Termux scheduler, the phone has entered the wrong profile or
an obsolete start path.

## Brain-provider notes

Use the provider that can complete the real on-phone workload without starving
the Node server. Authentication stays in private device files. Android binary
compatibility, DNS, and certificate handling belong in the provider wrapper and
canonical start path, not in scattered one-off shell invocations.

Provider stderr is diagnostic evidence. A task that exits without a valid
stdout/provider response fails; stderr text must never become the delivered
reply.

## Development access

USB ADB forwarding and Termux SSH are optional development/recovery channels.
They must not be required after release installation. Do not commit their real
values.

Some operations require Android shell privilege through ADB or Shizuku, such as
APK installation, HOME/ASSISTANT/service repair, and device-level diagnostics.
Normal source browsing and curation run on-device without the host.

## Managed fleet path

A future verified managed-app distribution with Android
Enterprise/device-owner, OEM, or system-image provisioning can remove much of
the Termux/Shizuku setup friction for nontechnical users. It may apply only
grants that its platform management mode authorizes; unavoidable consent and
account sign-in remain visible setup actions. It must preserve per-device
private state, the same local-data boundary, one scheduler owner,
agent/mechanics separation, and the host-built release contract.

This is a roadmap, not a currently shipped installer. Repeating ADB sideloads or
automating Settings taps across phones does not qualify as fleet provisioning.
