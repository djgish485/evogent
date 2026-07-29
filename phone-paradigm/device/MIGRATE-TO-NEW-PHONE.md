# Provision or migrate an Evogent phone

This guide applies to an arm64 stock Android phone using the current
Termux/Shizuku technical-user path. It deliberately contains no serials, users,
account names, local addresses, or backup locations.

The repository is the source of product code. A verified private backup is the
source of personal state. Do not treat an old phone's copied application tree as
a release artifact: install the current host-built release, then restore only
compatible private state.

## Before starting

Keep these outside the checkout:

- `<DEVICE_SERIAL>` and `<TERMUX_USER>`;
- a private, unused `<HOST_FORWARD_PORT>`;
- an encrypted `<BACKUP_DIR>`;
- brain authentication and signing material; and
- the host's private device notes.

The migration scripts in this directory are transitional helpers. Read them
before use and compare their component list with the release contract in
`docs/phone-production.md`.

## Back up the old phone

With the old phone connected and unlocked:

```bash
./backup-phone.sh \
  <DEVICE_SERIAL> <NEW_BACKUP_DIR> <TERMUX_USER> <HOST_FORWARD_PORT>
```

`<NEW_BACKUP_DIR>` must not already exist. The helper publishes it only after
the remote staging area, its own ADB forward, every digest, the archive
inventory, and SQLite `PRAGMA quick_check` have been verified. A
migration-grade backup includes:

- an online SQLite backup, followed by `PRAGMA quick_check`;
- selected regular files from the canonical private `state/data` and
  `state/phone-tools` roots, including compatible preferences, local media,
  validated source recipes and their activation manifests, cadence, and measured
  routing evidence;
- when unleased discovery or app-research work is queued, a bounded
  `.migration-pending-source-intents.json` handoff containing only its validated
  package/source intent;
- Termux package/version inventory;
- the currently installed shell APK and its version;
- the current release/component manifest; and
- `state-inventory.json`, `backup-manifest.json`, and `SHA256SUMS`.

Do not interact with Evogent while the helper runs. It acquires the canonical
cycle fence before the database/state cut, reaps only abandoned exact-owner
workers, and refuses the backup while a live browse/provider cycle owns that
fence. This keeps the database, cadence, preferences, and measured routing state
at one provider-free point in time. It also checks the source queue while holding
its lock and refuses to proceed when any source lease exists, including a worker
that leased approved work before waiting on the cycle fence. Retry only after the
source worker finishes or lease recovery returns that intent to the base queue.

The helper deliberately excludes the whole Termux home and `usr`, release and
dependency trees, generated symlinks, logs, caches, locks, temporary files,
`.env*`, control tokens, source-provider cookies, provider login state, and SSH
configuration or keys. It also excludes device-local host-policy rollback,
dedicated-wake authority, cycle signals, scheduler/source queue files, leases,
retry counters, and unvalidated source-recipe candidates:
those grants and launch authorities must be established afresh on the new
phone. The source-intent handoff is the narrow exception for unfinished work:
the backup rebuilds it while holding the queue lock from validated, unleased
base requests, and never copies a queue file, lease, worker owner, or retry
state. It refuses rather than serializing or omitting a live lease; a malformed
or unsafe request likewise makes the backup fail instead of silently dropping
it. A validated discovery in reconciliation-only state must finish on the old
phone first, because converting it back to portable discovery intent would
wrongly authorize another provider run. It has no “include everything” mode.

Provider or SSH authentication transfer is a separate owner decision. Prefer
fresh provider sign-in and a new SSH key on the new phone. If the owner
explicitly chooses a transfer, export only the exact files documented by that
provider or SSH client into a separately named encrypted artifact, review the
paths and modes, and verify that artifact separately. Never broaden
`backup-phone.sh` to sweep a provider directory or Termux home.

Do not commit the backup, manifest, database, logs, screenshots, tokens, SSH
configuration, or account-bearing browse notes. Verify the archive can be listed
and that `SHA256SUMS`, its per-entry state inventory, and database quick check
all pass again before erasing the old phone.

Treat the final verified backup as the migration handoff point. Power down or
otherwise keep the old phone's Evogent scheduler offline before starting the new
one, so the two devices cannot browse, spend on providers, or mutate private
state from the same snapshot. If the old phone is used again, the backup is no
longer final: discard it as a handoff snapshot and take a new verified backup
before continuing the migration.

## Supported fresh-phone order

Keep the signed APK, visible Android grants, host policy, and release transaction
in this order. Do not pre-grant Evogent capabilities before Android knows the
installed package. For a clean checkout, first create or recover the stable
private signing identity and follow the exact archive-to-APK bootstrap in
[`docs/phone-signing-and-bootstrap.md`](../../docs/phone-signing-and-bootstrap.md):

1. Complete normal Android setup and sign into the content apps Evogent may use.
2. Enable developer options and USB debugging, then accept the debugging dialog.
3. Install and open Termux and Shizuku from trusted sources.
4. Pair/start Shizuku. Verify the host-built release and bootstrap-install its
   exact signed Evogent APK using the linked signing/bootstrap procedure, then
   launch it once. If Android offers or recommends a Play Protect scan, take the
   scan path. Wait for the installer/verifier to finish and prove the exact
   installed package bytes and version; the dialog or scan alone is not
   installation proof.
5. Only after that package proof, authorize Evogent in Shizuku and visibly enable
   the Evogent accessibility service and notification access in Settings.
   On Android 13+, return to Evogent and answer its one-time permission request
   for the private curated digest. A denial leaves every original notification
   in Android; it never authorizes silent suppression.
6. Where the current Android build requires it for the supported hidden-display
   mechanics, enable Termux's **Display over other apps** special access in
   Android Settings. Ordinary runtime scripts do not set that access with
   `appops` and do not restore it after the owner revokes it.
7. Run the exact host-policy helper from the same hash-verified release payload:

   ```bash
   ~/phone-tools/provision-host-policy.sh --status
   ```

   If the reported policy is not ready, explain the three changes and obtain
   explicit owner authorization before running:

   ```bash
   ~/phone-tools/provision-host-policy.sh --apply
   ```

   `--apply` records the original values in a private mode-0600 file, changes
   only the three documented global settings, and verifies their readback. It
   is a one-time provisioning action; boot, watchdog, and browse cycles only
   probe. To undo the authorized change and prove the saved values:

   ```bash
   ~/phone-tools/provision-host-policy.sh --restore
   ```

8. Resume or run the versioned bundle installer. It must qualify the same APK,
   complete its atomic runtime switch, and publish the canonical
   `~/phone-tools` dispatches; a bootstrap copy of the reviewed helper is not an
   independently supported runtime.
9. Open stock Android HOME. Preserve any existing shortcut by moving it to a
   free launcher-owned cell, then pin Evogent's ordinary app entry in the
   closest persistent position corresponding to Evogent's bottom-left
   Android-home control (the bottom-left hotseat position on a Pixel-style
   launcher). At physical display 0, tap Evogent, tap **Android Home**, and tap
   Evogent again. If either direction is not reachable in one tap, provisioning
   is incomplete. Do not use an overlay or mutate launcher storage.
10. Complete fresh brain-provider sign-in, or restore only an exact separately
   exported authentication artifact that the owner explicitly chose to transfer.
11. Choose the battery policy appropriate for this device. Runtime scripts may
   take a scoped wake lock while actively browsing or running a bounded
   scheduled private-learning task; they must release it after the work. Because
   Termux has one app-global wake lock, enable the documented private
   `.dedicated-termux-wake` marker only when that Termux installation has no
   unrelated workloads.

Evogent must never attempt to bypass Android's owner confirmation, first-unlock
requirement, account login, restricted-settings warning, debugging prompt, or a
Play Protect scan. Android does not offer a scan on every install; whenever it
offers or recommends one, choose the scan path and never choose an
install-without-scanning path.

## Complete the public runtime transaction

Install one internally consistent release built from the host checkout. The
release must include the web build, server/runtime libraries, skills,
phone-tools, and APK with one manifest.

Use the versioned bundle installer rather than assembling a release in place. It
performs these checks and changes as one recoverable transaction:

1. Stage the current release in a new directory; do not merge files into the old
   tree in place.
2. Verify its hashes, Next.js build ID, APK version, source commit, required
   runtime files, and schema compatibility.
3. Privately snapshot the exact current HOME and ASSISTANT role holders before
   installing or upgrading the APK.
4. Qualify the already bootstrap-installed matching APK, or install the
   candidate during an update, and prove its exact bytes, version, signer, and
   rollback availability.
5. Assign and stably verify both Evogent roles only after the APK qualifies. A
   failed transaction restores and verifies both prior role holders together
   with the previous APK and runtime.

On initial bootstrap before the supported installer can use its shell boundary,
or as a fallback when automated role provisioning is unavailable, select
Evogent as both the Home app and digital assistant through Android's role UI.
Manual role selection is not a routine reinstall step. Re-enable any service
grants Android clears during installation separately. Also ensure Termux has the
supported external-command setting required by the APK's boot signal.

After installation, open Settings → Phone Alerts in Evogent. New deployments
begin in Observe with a private lock-screen preview. Curated shade is an
explicit, reversible owner choice after Observe behavior is verified.

The Android APK must not contain a periodic browse scheduler. It starts or wakes
the Termux control plane; the Termux scheduler remains the sole cycle owner.

## Restore private state

Verify `SHA256SUMS` and `state-inventory.json` again. Stop the local server before
replacing SQLite. Restore into the new release's private state locations:

1. Restore the verified online database backup, not an uncertain live file copied
   from an archive.
2. Use the inventory to restore only compatible selected `state/data` and
   `state/phone-tools` regular files. Do not blindly extract over the whole
   release state, and do not restore locks, logs, caches, dependencies, or
   release code. Recreate scheduler queues, cycle/source signals, live ownership,
   host-policy rollback state, and dedicated-wake policy on the new device; never
   restore them from the old phone. Restore the inventoried
   `.migration-pending-source-intents.json` file as ordinary private state when
   present; it is not a queue.
3. Do not expect provider authentication or SSH access in the default backup.
   Sign in and provision a new key, or restore an exact separately exported
   artifact only after the owner explicitly authorizes that transfer; retain
   restrictive file modes.
4. Generate or retrieve the new APK installation's control token and synchronize
   the Termux-side copy. Never carry forward a token minted by a different APK
   installation.
5. Recreate source-script symlinks so there is one mechanics implementation,
   rather than copied device and repo variants.
6. Run any declared database migration through the current server; do not copy
   old server binaries around a newer schema.

Personal app sessions are owned by Android apps and should be established by the
owner on the new device. Evogent does not export or commit them.

On the first eligible source-scout pass, the new phone validates that handoff
again and recreates each installed app's task through its own durable queue. It
keeps intents for apps not installed yet, retains discovery while opt-out
authority is unavailable, drops explicitly cancelled sources, and removes each
intent only after the new queue already contains it or equivalent terminal
source evidence exists. App-research intents bypass `.researched-apps` during
this reconciliation because the old phone may have written that marker when it
first queued work. This prevents a transferred marker from hiding work whose
live queue was deliberately excluded.

## Start the phone control plane

Start through the canonical phone boot path. Verify:

- the server reports the `phone` runtime profile;
- it listens on loopback only;
- SQLite `quick_check` passes;
- no Redis/background worker is started;
- one scheduler lease and no duplicate cycle lease exist;
- the independent watchdog is alive;
- Shizuku-backed hidden display creation works; and
- the accessibility control-token check returns real data.

Android File-Based Encryption keeps Termux private files unavailable until the
first owner unlock after a reboot. This is expected. Test reboot recovery only
after the owner performs that first unlock.

## Prove the migration

Run a supervised, hint-free end-to-end cycle:

1. Browse every due source through the normal scheduler request path.
2. Confirm each source records an honest structured outcome: attempted,
   succeeded/empty/failed, new/deduplicated counts, and error class.
3. Confirm candidates land under the base source names the curator consumes.
4. Score, curate, and arrange through the normal cycle.
5. Inspect the rendered home feed on physical display 0.
6. Tap Evogent's **Android Home** control, verify the reciprocal Evogent icon in
   the corresponding persistent stock-workspace position, tap it, and repeat
   the two-way switch once. A missing reciprocal control fails acceptance.
7. Test native-app tap-through and one non-destructive suggestion action.
8. Disconnect the host and confirm the feed still operates.
9. If the backup contained a source-intent handoff, confirm source scout either
   recreated its installed-app tasks under the new queue or retained only
   not-yet-installed/temporarily-unverifiable intents; confirm no old lease was
   restored.
10. Observe the next naturally scheduled cycle and its cleanup/power release.

Do not declare success from a server `200`, a tmux session name, or an API payload
alone.

## Recovery and rollback

Keep the old verified backup unchanged until the new phone has passed a natural
scheduled cycle. If installation or health verification fails:

- return to the previous complete release rather than mixing component versions;
- preserve the restored private database and take a fresh online backup before
  retrying a schema-affecting release;
- record only privacy-safe failure metadata in public reports; and
- put serials, local paths, account details, and raw logs in the private host
  notes.

Before retiring the old phone, remove accounts and screen locks as required by
the platform, then use Android's factory reset. That is an owner action, not an
automated Evogent step.
