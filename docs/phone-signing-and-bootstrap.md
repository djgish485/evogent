# Phone signing and first-install bootstrap

This is the public, agent-followable path from a clean checkout to the first
exact Evogent APK on a stock Android phone. It is the bootstrap edge of the
technical-user channel, not the future managed-fleet installer.

The normal versioned release transaction remains authoritative. Bootstrap
installs only the APK needed to establish Android package identity; the same
verified release archive must then be passed to `scripts/deploy-phone-release.sh`
so the runtime, roles, state links, rollback assets, and APK become one release.

## Host toolchain

Install a JDK with `java`, `javac`, and `keytool`, plus an Android SDK containing
platform API 35 (or the explicitly selected API), platform tools, and one
complete build-tools directory with `aapt2`, `aidl`, `apksigner`, `d8`, and
`zipalign`. Put `adb` on `PATH`.

The build discovers a JDK from `JAVA_HOME`, macOS's Java locator, Homebrew, or
`PATH`. It discovers the Android SDK from the standard Android environment
variables, common per-user SDK directories, or `sdkmanager`. Explicit
deployment-local overrides are:

```bash
export EVOGENT_JAVA_HOME="<ABSOLUTE_JDK_HOME>"
export EVOGENT_ANDROID_SDK_ROOT="<ABSOLUTE_ANDROID_SDK_ROOT>"
```

Optional overrides are
`EVOGENT_ANDROID_BUILD_TOOLS_DIR=<ABSOLUTE_BUILD_TOOLS_DIRECTORY>` and
`EVOGENT_ANDROID_PLATFORM_API=<API_LEVEL>`. Overrides fail closed when they are
missing or incomplete; they do not silently select a different installation.
Do not put host-specific paths in the repository.

## Create one private signing identity

Android updates require the same package name and signing identity. Create the
keystore once for a deployment, outside the checkout, and preserve it for every
later build. A new keystore is not an update key: Android will reject it for the
installed `net.dangish.evogent` package.

Choose a private host path and enter a new strong password without putting it in
shell history:

```bash
EVOGENT_SIGNING_DIRECTORY="${XDG_DATA_HOME:-$HOME/.local/share}/evogent/signing"
install -d -m 700 "$EVOGENT_SIGNING_DIRECTORY"
export EVOGENT_ANDROID_KEYSTORE="$EVOGENT_SIGNING_DIRECTORY/release.keystore"
read -r -s -p "Evogent Android keystore password: " \
  EVOGENT_ANDROID_KEYSTORE_PASSWORD
printf '\n'
export EVOGENT_ANDROID_KEYSTORE_PASSWORD
export EVOGENT_CREATE_ANDROID_KEYSTORE=1
```

`EVOGENT_ANDROID_KEY_ALIAS` defaults to `evogent`.
`EVOGENT_ANDROID_KEY_PASSWORD` defaults to the store password. If either is
overridden, record that choice in the same private recovery system as the
keystore, never in this checkout.

Build from the intended committed, clean tree:

```bash
bash scripts/build-phone-release.sh
unset EVOGENT_CREATE_ANDROID_KEYSTORE
unset EVOGENT_ANDROID_KEYSTORE_PASSWORD EVOGENT_ANDROID_KEY_PASSWORD
```

The build prints the exact release archive path and SHA-256. Save that path as
`<RELEASE_ARCHIVE>` for the remaining commands. Later builds use the same
`EVOGENT_ANDROID_KEYSTORE`, alias, and passwords without setting
`EVOGENT_CREATE_ANDROID_KEYSTORE`.

Before relying on this identity, make an encrypted offline backup of the
keystore and a separate recoverable record of its alias/password procedure.
Restore and list the backup with `keytool` in a temporary private directory.
Keep at least one verified copy away from the development laptop. Losing this
identity prevents ordinary in-place updates; uninstalling to use a replacement
identity also destroys APK-private state and invalidates grants and the
per-install control token.

## Verify and extract only the archive APK

The archive contains a private TLS key, so retain its mode-0600 sidecar unit and
never unpack the complete bundle into a shared directory. The extraction helper
requires the archive and `<RELEASE_ARCHIVE>.sha256` to be owner-only regular
files. It verifies the exact sidecar, validates every archive member, binds the
release ID to its APK/TLS identity, and writes only the manifest, APK, and a
content-free identity receipt:

```bash
EVOGENT_RELEASE_ARCHIVE="<RELEASE_ARCHIVE>"
EVOGENT_BOOTSTRAP_DIRECTORY="$(mktemp -d \
  "${TMPDIR:-/tmp}/evogent-phone-bootstrap.XXXXXX")"
chmod 700 "$EVOGENT_BOOTSTRAP_DIRECTORY"
python3 scripts/extract-phone-bootstrap-apk.py \
  "$EVOGENT_RELEASE_ARCHIVE" "$EVOGENT_BOOTSTRAP_DIRECTORY"
```

Inspect `bootstrap-identity.json`. It must name package
`net.dangish.evogent`; do not edit the APK, manifest, receipt, archive, or
sidecar after verification.

## Install with Android security visible

Connect one unlocked phone, accept its USB-debugging prompt, and bind commands
to its exact serial:

```bash
export ANDROID_SERIAL="<DEVICE_SERIAL>"
adb get-state
adb install --no-streaming "$EVOGENT_BOOTSTRAP_DIRECTORY/evogent.apk"
```

Keep display 0 visible. A command exit is not final acceptance: Android or Play
Protect can surface a scan, install confirmation, or developer-verification
screen asynchronously. Whenever a Play Protect scan is offered or recommended,
take the scan path. If Android says **App scan recommended**, choose **Scan**.
Never choose install-without-scanning, dismiss or suppress the gate to continue,
disable verification, or blindly tap coordinates. A refusal, timeout, inability
to complete the scan, or harmful/security verdict stops bootstrap.

After the trusted Android foreground has resolved, prove that Android exposes
one base APK for the expected package and that its bytes are exactly the
verified archive APK:

```bash
EVOGENT_INSTALLED_APK_PATH="$(
  adb shell pm path net.dangish.evogent \
    | tr -d '\r' \
    | sed -n 's/^package://p'
)"
case "$EVOGENT_INSTALLED_APK_PATH" in
  /data/app/*/base.apk) ;;
  *) printf '%s\n' "unexpected installed APK path" >&2; exit 1 ;;
esac
adb pull "$EVOGENT_INSTALLED_APK_PATH" \
  "$EVOGENT_BOOTSTRAP_DIRECTORY/installed-evogent.apk"
if ! cmp -s \
    "$EVOGENT_BOOTSTRAP_DIRECTORY/evogent.apk" \
    "$EVOGENT_BOOTSTRAP_DIRECTORY/installed-evogent.apk"; then
  printf '%s\n' "installed APK does not match the verified release" >&2
  exit 1
fi
adb shell am start -W -n net.dangish.evogent/.MainActivity
```

`cmp` must succeed. The scan or dialog alone is not package proof, and exact APK
bytes alone do not prove which scan choice was taken; the fresh physical
observation is separate private operator evidence.

## Resume the complete release transaction

Start and authorize the documented Termux/Shizuku shell boundary, then deploy
the same archive—not a rebuilt or similarly named one:

```bash
EVOGENT_ADB_SERIAL="<DEVICE_SERIAL>" \
EVOGENT_SSH_USER="<TERMUX_USER>" \
EVOGENT_SSH_PORT="<PRIVATE_HOST_FORWARD_PORT>" \
bash scripts/deploy-phone-release.sh "$EVOGENT_RELEASE_ARCHIVE"
```

The installer qualifies the already installed identical APK, snapshots and
assigns Android roles, installs the immutable runtime, and proves local health
before commit. Continue the owner-visible capabilities and verify-at-the-glass
steps in `phone-paradigm/device/MIGRATE-TO-NEW-PHONE.md`. Do not call the phone
ready from `adb install`, an HTTP `200`, or the release pointer alone.

Remove the temporary bootstrap directory after the full transaction succeeds.
Keep the original release archive and sidecar according to the private release
retention policy; they are the exact recovery/deployment unit.
