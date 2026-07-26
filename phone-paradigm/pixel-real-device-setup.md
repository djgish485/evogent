# Stock Android phone setup notes

This document records the technical-user setup constraints proven on stock arm64
Android phones. It complements, but does not replace:

- [`docs/phone-production.md`](../docs/phone-production.md) — architecture
- [`device/MIGRATE-TO-NEW-PHONE.md`](device/MIGRATE-TO-NEW-PHONE.md) — procedure
- [`device/DEV-LOOP.md`](device/DEV-LOOP.md) — host development workflow

Use placeholders in public commands. Put the real serial, SSH user, ports, and
device observations in the uncommitted host notes file.

## Components

The current stock-device path requires:

- the Evogent shell APK, selected for the Android HOME role;
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
2. Install the current Evogent APK, launch it once, and assign the HOME role.
3. Enable the accessibility service, notification access, and any restricted
   settings Android requires for a sideloaded accessibility tool.
4. Pair/start Shizuku and authorize Evogent.
5. Enable the Android windowing capabilities required by the current OS build for
   an app launched onto a shell-created virtual display to render. Verify this
   with a harmless app; a created display ID alone is not proof.
6. Install the current phone release in Termux and start it through
   `device/start-prod.sh`.
7. Synchronize the control token minted by this APK installation. A token copied
   from another device or install fails closed.
8. Select and authenticate a brain provider on the device.
9. Request one scheduler-owned cycle, then inspect the rendered result on display
   0.

After any APK reinstall, expect Android to clear or restrict some grants. Launch
the package once, re-check the HOME role and accessibility service, and verify
the control token before debugging higher layers.

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

Android may block hidden-display launch in deep Doze. The runtime can take a
scoped wake lock or request an idle exit immediately before due app browsing, but
it must release that state in cleanup after success, empty yield, timeout,
signal, or error.

Do not use a permanent wake lock as the default production fix. Record the
attempted source, power action, elapsed time, yield, and cleanup outcome so the
private cadence model can balance freshness and battery use.

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
APK installation, HOME/service repair, and device-level diagnostics. Normal
source browsing and curation run on-device without the host.

## Consumer path

A future privileged/system-image distribution can remove much of the
Termux/Shizuku setup friction, preconfigure required grants, and integrate
provider sign-in. It must preserve the same local-data boundary, single scheduler
owner, agent/mechanics separation, and host-built release contract. It is a
roadmap, not a currently shipped installer.
