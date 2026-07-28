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
- an encrypted `<BACKUP_DIR>`;
- brain authentication and signing material; and
- the host's private device notes.

The migration scripts in this directory are transitional helpers. Read them
before use and compare their component list with the release contract in
`docs/phone-production.md`.

## Back up the old phone

With the old phone connected and unlocked:

```bash
./backup-phone.sh <DEVICE_SERIAL> <BACKUP_DIR>
```

A migration-grade backup includes:

- an online SQLite backup, followed by `PRAGMA quick_check`;
- private `data/` state, local media, installed skills, and source cadence;
- Termux package/version inventory;
- the currently installed shell APK and its version;
- a release/component manifest and file hashes; and
- private brain authentication only if the owner explicitly intends to transfer
  it through the encrypted backup.

Do not commit the backup, manifest, database, logs, screenshots, tokens, SSH
configuration, or account-bearing browse notes. Verify the archive can be listed
and the database can be opened before erasing the old phone.

## Owner-only steps on the new phone

These steps require the device owner:

1. Complete normal Android setup and sign into the content apps Evogent may use.
2. Enable developer options and USB debugging, then accept the debugging dialog.
3. Install and open Termux and Shizuku from trusted sources.
4. Pair/start Shizuku and authorize the capabilities required by the Evogent
   shell.
5. Enable the Evogent accessibility service and notification access in Settings.
   On Android 13+, return to Evogent and answer its one-time permission request
   for the private curated digest. A denial leaves every original notification
   in Android; it never authorizes silent suppression.
6. Complete brain-provider sign-in if transferred credentials do not work.
7. Choose the battery policy appropriate for this device. Runtime scripts may
   take a scoped wake lock while actively browsing or running a bounded
   scheduled private-learning task; they must release it after the work. Because
   Termux has one app-global wake lock, enable the documented private
   `.dedicated-termux-wake` marker only when that Termux installation has no
   unrelated workloads.

Evogent must never attempt to bypass Android's owner confirmation, first-unlock
requirement, account login, restricted-settings warning, or debugging prompt.

## Install the public runtime

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
4. Install the APK from a package-manager-readable temporary path and prove its
   exact bytes, version, signer, and rollback availability.
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

Stop the local server before replacing SQLite. Restore into the new release's
private data location:

1. Restore the verified online database backup, not an uncertain live file copied
   from an archive.
2. Restore compatible `data/` preferences, learned context, cadence, source
   recipes, and media.
3. Restore provider authentication and SSH access only from the encrypted private
   backup, with restrictive file modes.
4. Generate or retrieve the new APK installation's control token and synchronize
   the Termux-side copy. Never carry forward a token minted by a different APK
   installation.
5. Recreate source-script symlinks so there is one mechanics implementation,
   rather than copied device and repo variants.
6. Run any declared database migration through the current server; do not copy
   old server binaries around a newer schema.

Personal app sessions are owned by Android apps and should be established by the
owner on the new device. Evogent does not export or commit them.

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
6. Test native-app tap-through and one non-destructive suggestion action.
7. Disconnect the host and confirm the feed still operates.
8. Observe the next naturally scheduled cycle and its cleanup/power release.

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
