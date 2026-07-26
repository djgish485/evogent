# Evogent on Android

Android is Evogent's canonical production paradigm. Evogent is the phone's home
screen, and the complete personal runtime stays on the phone:

- the shell APK supplies the launcher, WebView, native-app routing, overlay, and
  accessibility mechanics;
- Termux runs the local Next.js server, SQLite database, brain CLI, source
  mechanics, one scheduler, and its independent watchdog;
- hidden-display browsing reads the user's real logged-in apps without replacing
  display 0; and
- the curated feed and personal model remain local to the device.

A Mac or other host is needed to develop and release Evogent, not to operate it.
The original VM path remains available for the public demo and legacy
self-hosting, but it is no longer the reference architecture.

Read [`docs/phone-production.md`](../docs/phone-production.md) first. It defines
the layer boundaries, single-owner control plane, privacy boundary, release
contract, and verification standard.

## Current technical-user stack

The proven stock-device path uses:

- an arm64 Android phone;
- the Evogent shell APK as the selected HOME app;
- Termux for Node, SQLite, the selected subscription-backed brain CLI, and the
  runtime scripts;
- Shizuku for the shell-uid capabilities needed by hidden displays; and
- the Evogent accessibility service, protected by a per-install control token.

This is an engineering preview, not yet a consumer installer. A system-image
distribution could remove Termux/Shizuku setup friction later without changing
the product's on-device ownership model.

## Runtime components

| Component | Responsibility |
|---|---|
| `android-shell/` | HOME activity, local WebView, overlay/composer, app routing, accessibility mechanics, boot signal |
| `device/start-prod.sh` | Canonical phone-profile server environment: loopback, no Redis/background worker |
| `device/phone-tools/phone.sh` | Deterministic hidden-display launch, capture, tap, and scroll primitives |
| `device/phone-tools/evogent-scheduler.sh` | Sole scheduling authority; coalesces open, heartbeat, notification, and recovery signals |
| `device/phone-tools/evogent-cycle.sh` | One leased browse/cache/score/curate/arrange cycle with structured outcomes |
| `device/phone-tools/evogent-watchdog.sh` | Independent liveness guard; wakes the owner instead of running a competing cycle |
| `device/skills/phone-browse/` | General instructions for on-phone agent judgment |

The deleted APK browse service and its periodic alarm are legacy architecture.
Android may start the Termux control plane, but it must not become another
scheduler.

## Brain provider

The brain provider is deployment-configurable. On constrained phones, use the
lighter provider that passes the real workload and leaves the Node server
responsive. Authentication belongs in private device files and is never copied
into the repo or a release bundle.

Provider wrappers may need Android-specific DNS, certificates, or binary
compatibility support. `device/start-prod.sh` is the canonical environment
boundary; do not add a second ad-hoc server start path with different variables.

## What belongs where

- General product behavior belongs in committed code, templates, and `.intent/`.
- Personal taste, accounts, source cadence, and learned context belong in private
  `data/` state on the phone.
- Agents decide what content means and what would help.
- Scripts perform measurable mechanics and report outcomes honestly.
- Source-code fixes are queued for host review; the phone does not run its own
  software-development agents.

## Setup and operations

- [`device/MIGRATE-TO-NEW-PHONE.md`](device/MIGRATE-TO-NEW-PHONE.md) — provision
  or migrate a private deployment
- [`pixel-real-device-setup.md`](pixel-real-device-setup.md) — current
  stock-device setup details and Android constraints
- [`device/DEV-LOOP.md`](device/DEV-LOOP.md) — host development and release loop
- [`device/AGENTS.phone-browse.md`](device/AGENTS.phone-browse.md) — runtime
  browsing capability supplied to an on-device brain

All examples use placeholders. Put serials, ports, SSH users, account facts, and
other deployment-specific notes in an uncommitted host-side file outside the
checkout.
