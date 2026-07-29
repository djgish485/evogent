#!/bin/bash
# Build the Evogent shell APK without Gradle: aapt2 + javac + d8 + apksigner.
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_VERSION_CODE="${EVOGENT_ANDROID_VERSION_CODE:-3}"
if ! [[ "$ANDROID_VERSION_CODE" =~ ^[1-9][0-9]{0,9}$ ]] \
        || [ "$ANDROID_VERSION_CODE" -gt 2147483647 ]; then
    echo "BUILD FAILED: EVOGENT_ANDROID_VERSION_CODE must be an integer from 1 through 2147483647" >&2
    exit 1
fi

resolve_android_sdk_root() {
    local candidate="" sdkmanager=""
    if [ "${EVOGENT_ANDROID_SDK_ROOT+x}" = x ]; then
        candidate="$EVOGENT_ANDROID_SDK_ROOT"
        [ -d "$candidate/build-tools" ] && [ -d "$candidate/platforms" ] || return 1
        (cd "$candidate" && pwd -P)
        return
    fi
    if [ "${ANDROID_SDK_ROOT+x}" = x ]; then
        candidate="$ANDROID_SDK_ROOT"
        [ -d "$candidate/build-tools" ] && [ -d "$candidate/platforms" ] || return 1
        (cd "$candidate" && pwd -P)
        return
    fi
    if [ "${ANDROID_HOME+x}" = x ]; then
        candidate="$ANDROID_HOME"
        [ -d "$candidate/build-tools" ] && [ -d "$candidate/platforms" ] || return 1
        (cd "$candidate" && pwd -P)
        return
    fi
    for candidate in \
        "$HOME/Library/Android/sdk" \
        "$HOME/Android/Sdk" \
        "$HOME/Android/sdk"; do
        if [ -d "$candidate/build-tools" ] && [ -d "$candidate/platforms" ]; then
            (cd "$candidate" && pwd -P)
            return
        fi
    done
    sdkmanager="$(command -v sdkmanager 2>/dev/null || true)"
    [ -n "$sdkmanager" ] || return 1
    python3 - "$sdkmanager" <<'PY'
import pathlib
import sys

tool = pathlib.Path(sys.argv[1]).resolve()
for parent in tool.parents:
    if (parent / "build-tools").is_dir() and (parent / "platforms").is_dir():
        print(parent)
        raise SystemExit(0)
raise SystemExit(1)
PY
}

java_home_has_build_tools() {
    local candidate="$1"
    [ -x "$candidate/bin/java" ] \
        && [ -x "$candidate/bin/javac" ] \
        && [ -x "$candidate/bin/keytool" ]
}

resolve_java_home() {
    local candidate="" javac_path="" formula=""
    if [ "${EVOGENT_JAVA_HOME+x}" = x ]; then
        java_home_has_build_tools "$EVOGENT_JAVA_HOME" || return 1
        (cd "$EVOGENT_JAVA_HOME" && pwd -P)
        return
    fi
    if [ "${JAVA_HOME+x}" = x ] && [ -n "$JAVA_HOME" ]; then
        java_home_has_build_tools "$JAVA_HOME" || return 1
        (cd "$JAVA_HOME" && pwd -P)
        return
    fi
    if [ -x /usr/libexec/java_home ]; then
        candidate="$(/usr/libexec/java_home 2>/dev/null || true)"
        if [ -n "$candidate" ] && java_home_has_build_tools "$candidate"; then
            (cd "$candidate" && pwd -P)
            return
        fi
    fi
    if command -v brew >/dev/null 2>&1; then
        for formula in openjdk@17 openjdk@11 openjdk; do
            candidate="$(brew --prefix "$formula" 2>/dev/null || true)"
            if [ -n "$candidate" ] && java_home_has_build_tools "$candidate"; then
                (cd "$candidate" && pwd -P)
                return
            fi
        done
    fi
    javac_path="$(command -v javac 2>/dev/null || true)"
    [ -n "$javac_path" ] || return 1
    candidate="$(python3 - "$javac_path" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve().parent.parent)
PY
)"
    java_home_has_build_tools "$candidate" || return 1
    (cd "$candidate" && pwd -P)
}

android_build_tools_complete() {
    local directory="$1" tool=""
    [ -d "$directory" ] || return 1
    for tool in aapt2 aidl apksigner d8 zipalign; do
        [ -x "$directory/$tool" ] || return 1
    done
}

find_android_build_tools_dir() {
    local sdk="$1"
    python3 - "$sdk" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]) / "build-tools"
required = ("aapt2", "aidl", "apksigner", "d8", "zipalign")

def version(path):
    parts = tuple(int(part) for part in re.findall(r"\d+", path.name))
    return parts, path.name

candidates = [
    path
    for path in root.iterdir()
    if path.is_dir() and all((path / tool).is_file() for tool in required)
] if root.is_dir() else []
if not candidates:
    raise SystemExit(1)
print(max(candidates, key=version))
PY
}

file_mode() {
    python3 - "$1" <<'PY'
import os
import stat
import sys

print(f"{stat.S_IMODE(os.stat(sys.argv[1], follow_symlinks=False).st_mode):o}")
PY
}

# Signing configuration. Key material is deployment-private and must live outside the checkout.
# Supply secrets through the environment so they never enter argv:
#   EVOGENT_ANDROID_KEYSTORE=/absolute/path/to/release.keystore
#   EVOGENT_ANDROID_KEYSTORE_PASSWORD=...
#   EVOGENT_ANDROID_KEY_PASSWORD=...              # defaults to the store password
#   EVOGENT_ANDROID_KEY_ALIAS=...                 # defaults to "evogent"
# Set EVOGENT_CREATE_ANDROID_KEYSTORE=1 only when intentionally initializing a new deployment.
ANDROID_KEYSTORE="${EVOGENT_ANDROID_KEYSTORE:-}"
[ -n "$ANDROID_KEYSTORE" ] || {
    echo "SIGNING FAILED: EVOGENT_ANDROID_KEYSTORE is required; signing keys must live outside the checkout" >&2
    exit 1
}
case "$ANDROID_KEYSTORE" in
    /*) ;;
    *) ANDROID_KEYSTORE="$PWD/$ANDROID_KEYSTORE" ;;
esac
[ ! -L "$ANDROID_KEYSTORE" ] || {
    echo "SIGNING FAILED: configured Android keystore must not be a symlink" >&2
    exit 1
}
REPOSITORY_ROOT="$(cd .. && pwd -P)"
ANDROID_KEYSTORE="$(python3 - "$ANDROID_KEYSTORE" <<'PY'
import pathlib
import sys
print(pathlib.Path(sys.argv[1]).resolve(strict=False))
PY
)"
case "$ANDROID_KEYSTORE" in
    "$REPOSITORY_ROOT"|"$REPOSITORY_ROOT"/*)
        echo "SIGNING FAILED: Android keystore must live outside the source checkout" >&2
        exit 1
        ;;
esac
ANDROID_KEY_ALIAS="${EVOGENT_ANDROID_KEY_ALIAS:-evogent}"
CREATE_ANDROID_KEYSTORE="${EVOGENT_CREATE_ANDROID_KEYSTORE:-0}"
case "$CREATE_ANDROID_KEYSTORE" in
    0|1) ;;
    *)
        echo "SIGNING FAILED: EVOGENT_CREATE_ANDROID_KEYSTORE must be 0 or 1" >&2
        exit 1
        ;;
esac
if [ -e "$ANDROID_KEYSTORE" ] && [ ! -f "$ANDROID_KEYSTORE" ]; then
    echo "SIGNING FAILED: configured Android keystore is not a regular file" >&2
    exit 1
fi
if [ ! -f "$ANDROID_KEYSTORE" ] && [ "$CREATE_ANDROID_KEYSTORE" != 1 ]; then
    echo "SIGNING FAILED: Android keystore is missing; set EVOGENT_CREATE_ANDROID_KEYSTORE=1 to create it intentionally" >&2
    exit 1
fi

# Disable xtrace while resolving passwords so even a caller's `bash -x` cannot print them.
SIGNING_XTRACE=0
case "$-" in *x*) SIGNING_XTRACE=1; set +x ;; esac
if [ -z "${EVOGENT_ANDROID_KEYSTORE_PASSWORD:-}" ]; then
    echo "SIGNING FAILED: EVOGENT_ANDROID_KEYSTORE_PASSWORD is required" >&2
    exit 1
fi
ANDROID_KEYSTORE_PASSWORD_VALUE="$EVOGENT_ANDROID_KEYSTORE_PASSWORD"
if [ "${EVOGENT_ANDROID_KEY_PASSWORD+x}" = x ]; then
    ANDROID_KEY_PASSWORD_VALUE="$EVOGENT_ANDROID_KEY_PASSWORD"
else
    ANDROID_KEY_PASSWORD_VALUE="$ANDROID_KEYSTORE_PASSWORD_VALUE"
fi
if [ -z "$ANDROID_KEYSTORE_PASSWORD_VALUE" ] || [ -z "$ANDROID_KEY_PASSWORD_VALUE" ]; then
    echo "SIGNING FAILED: Android signing passwords must not be empty" >&2
    exit 1
fi
# Imported caller variables are exported by default. Remove them before compilation and expose
# short-lived internal copies only to keytool/apksigner.
unset EVOGENT_ANDROID_KEYSTORE_PASSWORD EVOGENT_ANDROID_KEY_PASSWORD
export EVOGENT_SIGNING_STORE_PASSWORD="$ANDROID_KEYSTORE_PASSWORD_VALUE"
export EVOGENT_SIGNING_KEY_PASSWORD="$ANDROID_KEY_PASSWORD_VALUE"

SDK="$(resolve_android_sdk_root)" || {
    echo "BUILD FAILED: Android SDK not found; set EVOGENT_ANDROID_SDK_ROOT or ANDROID_SDK_ROOT" >&2
    exit 69
}
JAVA_HOME="$(resolve_java_home)" || {
    echo "BUILD FAILED: JDK not found; set EVOGENT_JAVA_HOME or JAVA_HOME" >&2
    exit 69
}
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

# Prefer the version already proven for this project, but discover the newest
# complete installed build-tools directory when that exact version is absent.
BTN="$SDK/build-tools/36.1.0"
if [ "${EVOGENT_ANDROID_BUILD_TOOLS_DIR+x}" = x ]; then
    BTN="$EVOGENT_ANDROID_BUILD_TOOLS_DIR"
elif ! android_build_tools_complete "$BTN"; then
    BTN="$(find_android_build_tools_dir "$SDK")" || {
        echo "BUILD FAILED: complete Android build tools were not found under $SDK" >&2
        exit 69
    }
fi
android_build_tools_complete "$BTN" || {
    echo "BUILD FAILED: Android build-tools override is incomplete" >&2
    exit 69
}

ANDROID_PLATFORM_API="${EVOGENT_ANDROID_PLATFORM_API:-35}"
[[ "$ANDROID_PLATFORM_API" =~ ^[1-9][0-9]{1,2}$ ]] || {
    echo "BUILD FAILED: EVOGENT_ANDROID_PLATFORM_API must be a positive API level" >&2
    exit 69
}
PLATFORM_DIR="$SDK/platforms/android-$ANDROID_PLATFORM_API"
PLATFORM="$PLATFORM_DIR/android.jar"
FRAMEWORK_AIDL="$PLATFORM_DIR/framework.aidl"
[ -f "$PLATFORM" ] && [ -f "$FRAMEWORK_AIDL" ] || {
    echo "BUILD FAILED: Android platform API $ANDROID_PLATFORM_API is incomplete under $SDK" >&2
    exit 69
}
JAVAC="$JAVA_HOME/bin/javac"
JAVA="$JAVA_HOME/bin/java"
KEYTOOL="$JAVA_HOME/bin/keytool"

if [ ! -f "$ANDROID_KEYSTORE" ]; then
    mkdir -p "$(dirname "$ANDROID_KEYSTORE")"
    (
        umask 077
        "$KEYTOOL" -genkeypair -keystore "$ANDROID_KEYSTORE" -storetype JKS \
            -alias "$ANDROID_KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
            -storepass:env EVOGENT_SIGNING_STORE_PASSWORD \
            -keypass:env EVOGENT_SIGNING_KEY_PASSWORD \
            -dname "CN=Evogent Android, OU=Deployment, O=Evogent"
    )
    chmod 600 "$ANDROID_KEYSTORE"
fi
ANDROID_KEYSTORE_MODE="$(file_mode "$ANDROID_KEYSTORE")"
if [ $((8#$ANDROID_KEYSTORE_MODE & 077)) -ne 0 ]; then
    echo "SIGNING FAILED: Android keystore must not be accessible to group or other users" >&2
    exit 1
fi
if ! "$KEYTOOL" -list -keystore "$ANDROID_KEYSTORE" -alias "$ANDROID_KEY_ALIAS" \
        -storepass:env EVOGENT_SIGNING_STORE_PASSWORD >/dev/null 2>&1; then
    echo "SIGNING FAILED: keystore password or key alias is invalid" >&2
    exit 1
fi
unset EVOGENT_SIGNING_STORE_PASSWORD EVOGENT_SIGNING_KEY_PASSWORD
if [ "$SIGNING_XTRACE" = 1 ]; then set -x; fi

rm -rf build
mkdir -p build/obj build/dex

# One Android release gets one private loopback PKI. A hostile Android app can bind the same
# 127.0.0.1 port after Termux exits, so URL/origin checks and HMAC bootstrap alone do not protect
# subsequent WebView requests. The APK trusts only this freshly generated CA; the matching leaf
# cert/key are emitted beside the APK for the immutable release builder to package with server.js.
# The CA private key exists only during this build and is destroyed before resource compilation.
command -v openssl >/dev/null 2>&1 || {
    echo "TLS BUILD FAILED: openssl is required" >&2
    exit 69
}
TLS_BUILD="$PWD/build/tls"
PACKAGE_RES="$PWD/build/package-res"
mkdir -p "$TLS_BUILD" "$PACKAGE_RES"
cp -R res/. "$PACKAGE_RES/"
mkdir -p "$PACKAGE_RES/raw"
(
    umask 077
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
        -keyout "$TLS_BUILD/ca-key.pem" \
        -out "$TLS_BUILD/ca-cert.pem" \
        -days 3650 \
        -subj "/CN=Evogent Phone Release CA" \
        -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" \
        -addext "subjectKeyIdentifier=hash" >/dev/null 2>&1
    openssl req -new -newkey rsa:2048 -sha256 -nodes \
        -keyout "$TLS_BUILD/server-key.pem" \
        -out "$TLS_BUILD/server.csr" \
        -subj "/CN=127.0.0.1" >/dev/null 2>&1
    {
        printf '%s\n' \
            'basicConstraints=critical,CA:FALSE' \
            'keyUsage=critical,digitalSignature,keyEncipherment' \
            'extendedKeyUsage=serverAuth' \
            'subjectAltName=IP:127.0.0.1' \
            'subjectKeyIdentifier=hash' \
            'authorityKeyIdentifier=keyid'
    } > "$TLS_BUILD/server.ext"
    openssl x509 -req -sha256 \
        -in "$TLS_BUILD/server.csr" \
        -CA "$TLS_BUILD/ca-cert.pem" \
        -CAkey "$TLS_BUILD/ca-key.pem" \
        -CAcreateserial \
        -out "$TLS_BUILD/server-cert.pem" \
        -days 3650 \
        -extfile "$TLS_BUILD/server.ext" >/dev/null 2>&1
)
openssl verify -purpose sslserver -verify_ip 127.0.0.1 \
    -CAfile "$TLS_BUILD/ca-cert.pem" "$TLS_BUILD/server-cert.pem" >/dev/null
openssl x509 -in "$TLS_BUILD/server-cert.pem" -noout -ext subjectAltName \
    | grep -Fq 'IP Address:127.0.0.1' || {
        echo "TLS BUILD FAILED: server certificate lacks the exact loopback IP SAN" >&2
        exit 1
    }
openssl x509 -in "$TLS_BUILD/server-cert.pem" -pubkey -noout \
    > "$TLS_BUILD/server-cert.pub"
openssl pkey -in "$TLS_BUILD/server-key.pem" -pubout \
    > "$TLS_BUILD/server-key.pub"
cmp -s "$TLS_BUILD/server-cert.pub" "$TLS_BUILD/server-key.pub" || {
    echo "TLS BUILD FAILED: server certificate and private key do not match" >&2
    exit 1
}

# A random self-signed takeover certificate must not chain to the APK's release CA.
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
    -keyout "$TLS_BUILD/fake-key.pem" \
    -out "$TLS_BUILD/fake-cert.pem" \
    -days 2 \
    -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1
if openssl verify -purpose sslserver -verify_ip 127.0.0.1 \
        -CAfile "$TLS_BUILD/ca-cert.pem" "$TLS_BUILD/fake-cert.pem" >/dev/null 2>&1; then
    echo "TLS BUILD FAILED: hostile self-signed takeover certificate was trusted" >&2
    exit 1
fi

cp "$TLS_BUILD/ca-cert.pem" "$PACKAGE_RES/raw/evogent_phone_ca.pem"
cp "$TLS_BUILD/server-cert.pem" build/server-cert.pem
cp "$TLS_BUILD/server-key.pem" build/server-key.pem
chmod 644 build/server-cert.pem "$PACKAGE_RES/raw/evogent_phone_ca.pem"
chmod 600 build/server-key.pem
rm -f "$TLS_BUILD/ca-key.pem" "$TLS_BUILD/ca-cert.srl" \
    "$TLS_BUILD/server.csr" "$TLS_BUILD/server.ext" \
    "$TLS_BUILD/server-cert.pem" "$TLS_BUILD/server-key.pem" \
    "$TLS_BUILD/server-cert.pub" "$TLS_BUILD/server-key.pub" \
    "$TLS_BUILD/fake-key.pem" "$TLS_BUILD/fake-cert.pem"
if find build -type f -name '*ca*key*' -print -quit | grep -q .; then
    echo "TLS BUILD FAILED: CA private key survived generation" >&2
    exit 1
fi

# Host-side security-policy tests. The policy intentionally has no Android dependencies so exact
# origin parsing and fail-closed token behavior can be checked before we package any APK.
mkdir -p build/test
"$JAVAC" -source 8 -target 8 -d build/test \
    src/net/dangish/evogent/EvogentSecurityPolicy.java \
    src/net/dangish/evogent/EvogentLoopbackAuthProtocol.java \
    src/net/dangish/evogent/EvogentDocumentAuthority.java \
    src/net/dangish/evogent/EvogentHomeNavigationPolicy.java \
    src/net/dangish/evogent/EvogentHomeChoicePolicy.java \
    src/net/dangish/evogent/EvogentHomeAvailabilityGate.java \
    src/net/dangish/evogent/EvogentAndroidHomeResolution.java \
    src/net/dangish/evogent/EvogentMainFrameLoadPolicy.java \
    src/net/dangish/evogent/EvogentAssistantLaunchGate.java \
    src/net/dangish/evogent/EvogentAssistantContextStore.java \
    src/net/dangish/evogent/EvogentAssistantTraversalPolicy.java \
    src/net/dangish/evogent/EvogentAccessibilityActionPolicy.java \
    src/net/dangish/evogent/EvogentPhysicalDisplayPolicy.java \
    src/net/dangish/evogent/EvogentProcessRunner.java \
    src/net/dangish/evogent/EvogentNotificationPolicy.java \
    src/net/dangish/evogent/EvogentNotificationReceiptRetentionPolicy.java \
    src/net/dangish/evogent/EvogentNotificationWorkQueue.java \
    src/net/dangish/evogent/EvogentBenchmarkSharePolicy.java \
    tests/EvogentSecurityPolicyTest.java \
    tests/EvogentLoopbackAuthProtocolTest.java \
    tests/EvogentDocumentAuthorityTest.java \
    tests/EvogentHomeNavigationPolicyTest.java \
    tests/EvogentHomeChoicePolicyTest.java \
    tests/EvogentHomeAvailabilityGateTest.java \
    tests/EvogentAndroidHomeResolutionTest.java \
    tests/EvogentMainFrameLoadPolicyTest.java \
    tests/EvogentAssistantLaunchGateTest.java \
    tests/EvogentAssistantContextStoreTest.java \
    tests/EvogentAccessibilityActionPolicyTest.java \
    tests/EvogentPhysicalDisplayPolicyTest.java \
    tests/EvogentProcessRunnerTest.java \
    tests/EvogentNotificationPolicyTest.java \
    tests/EvogentNotificationReceiptRetentionPolicyTest.java \
    tests/EvogentNotificationWorkQueueTest.java \
    tests/EvogentBenchmarkSharePolicyTest.java
"$JAVA" -cp build/test net.dangish.evogent.EvogentSecurityPolicyTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentLoopbackAuthProtocolTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentDocumentAuthorityTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentHomeNavigationPolicyTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentHomeChoicePolicyTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentHomeAvailabilityGateTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentAndroidHomeResolutionTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentMainFrameLoadPolicyTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentAssistantLaunchGateTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentAssistantContextStoreTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentAccessibilityActionPolicyTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentPhysicalDisplayPolicyTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentProcessRunnerTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentNotificationPolicyTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentNotificationReceiptRetentionPolicyTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentNotificationWorkQueueTest
"$JAVA" -cp build/test net.dangish.evogent.EvogentBenchmarkSharePolicyTest

"$BTN/aapt2" compile --dir "$PACKAGE_RES" -o build/res.zip

# --java emits R.java so code can reference res/drawable vector icons via R.drawable.*.
mkdir -p build/gen
"$BTN/aapt2" link -o build/base.apk \
    -I "$PLATFORM" \
    --manifest AndroidManifest.xml \
    --min-sdk-version 24 --target-sdk-version 34 \
    --version-code "$ANDROID_VERSION_CODE" \
    --replace-version \
    --java build/gen \
    build/res.zip

SHIZUKU_LIBS="libs/shizuku-api.jar:libs/shizuku-provider.jar:libs/shizuku-aidl.jar"

# Generate AIDL stubs (IEvoPrivileged used by the Shizuku UserService).
mkdir -p build/aidl-gen
for a in $(find src -name '*.aidl'); do
    "$BTN/aidl" -p"$FRAMEWORK_AIDL" -Isrc -obuild/aidl-gen "$a"
done

"$JAVAC" -source 8 -target 8 -bootclasspath "$PLATFORM" -classpath "$SHIZUKU_LIBS" \
    -d build/obj $(find src -name '*.java') $(find build/aidl-gen -name '*.java') \
    $(find build/gen -name '*.java')

# Newer d8 (36.1.0) — the 29.0.3 d8 NPEs on the Shizuku jars' bytecode.
"$BTN/d8" --release --lib "$PLATFORM" --min-api 24 \
    --output build/dex $(find build/obj -name '*.class') \
    libs/shizuku-api.jar libs/shizuku-provider.jar libs/shizuku-aidl.jar

cp build/base.apk build/evogent-unaligned.apk
(cd build/dex && zip -q -j ../evogent-unaligned.apk classes.dex)

"$BTN/zipalign" -f 4 build/evogent-unaligned.apk build/evogent-unsigned.apk

if [ "$SIGNING_XTRACE" = 1 ]; then set +x; fi
export EVOGENT_SIGNING_STORE_PASSWORD="$ANDROID_KEYSTORE_PASSWORD_VALUE"
export EVOGENT_SIGNING_KEY_PASSWORD="$ANDROID_KEY_PASSWORD_VALUE"
"$BTN/apksigner" sign --v1-signing-enabled true \
    --ks "$ANDROID_KEYSTORE" --ks-key-alias "$ANDROID_KEY_ALIAS" \
    --ks-pass env:EVOGENT_SIGNING_STORE_PASSWORD \
    --key-pass env:EVOGENT_SIGNING_KEY_PASSWORD \
    --out build/evogent.apk build/evogent-unsigned.apk
unset EVOGENT_SIGNING_STORE_PASSWORD EVOGENT_SIGNING_KEY_PASSWORD
if [ "$SIGNING_XTRACE" = 1 ]; then set -x; fi
"$BTN/apksigner" verify --verbose --min-sdk-version 23 \
    build/evogent.apk > build/apksigner-verify.txt
if ! grep -Fq 'Verified using v1 scheme (JAR signing): true' \
        build/apksigner-verify.txt \
        || ! grep -Fq 'Verified using v2 scheme (APK Signature Scheme v2): true' \
            build/apksigner-verify.txt \
        || ! grep -Fq 'Verified using v3 scheme (APK Signature Scheme v3): true' \
            build/apksigner-verify.txt \
        || ! grep -Fq 'Number of signers: 1' build/apksigner-verify.txt; then
    echo "BUILD CHECK FAILED: signed APK did not pass the expected signature verification" >&2
    exit 1
fi

# Artifact identity + security checks: verify the signed APK came from this exact source tree and
# contains the current feature set plus hardened phone-runtime identity before declaring success.
unzip -p build/evogent.apk classes.dex 2>/dev/null | strings > build/classes.strings
unzip -Z1 build/evogent.apk > build/apk-files.txt
"$BTN/aapt2" dump xmltree build/evogent.apk --file AndroidManifest.xml > build/manifest.txt
"$BTN/aapt2" dump xmltree build/evogent.apk \
    --file res/xml/network_security_config.xml > build/network-security.txt
"$BTN/aapt2" dump resources build/evogent.apk > build/resources.txt

if ! grep -Fq openAndroidHome build/classes.strings; then
    echo "BUILD CHECK FAILED: openAndroidHome missing from classes.dex — wrong tree or broken build" >&2
    exit 1
fi
if ! grep -Fq evogentHandleBack build/classes.strings \
        || ! grep -Fq 'Evogent is unavailable' build/resources.txt \
        || ! grep -Fq 'Android Home' build/resources.txt; then
    echo "BUILD CHECK FAILED: native HOME recovery or authenticated page Back is missing" >&2
    exit 1
fi
if grep -Fq '.apply()' src/net/dangish/evogent/MainActivity.java \
        || ! grep -Fq 'SYSTEM_HOME_READY_TIMEOUT_MS = 2500L' \
            src/net/dangish/evogent/MainActivity.java \
        || ! grep -Fq 'EvogentHomeAvailabilityGate' build/classes.strings \
        || ! grep -Fq 'refreshExplicitEvogentLaunch' build/classes.strings \
        || ! grep -Fq 'chooseAndLaunchAndroidHome' build/classes.strings \
        || ! grep -Fq 'launchRememberedAndroidHome' build/classes.strings \
        || ! grep -Fq 'launchAndroidHomeWithoutChangingChoice' build/classes.strings \
        || ! grep -Fq 'com.google.android.apps.nexuslauncher' build/classes.strings; then
    echo "BUILD CHECK FAILED: durable fail-safe system-HOME routing is missing" >&2
    exit 1
fi
if grep -Fq 'http://localhost:3001' build/classes.strings; then
    echo "BUILD CHECK FAILED: legacy localhost origin remains in classes.dex" >&2
    exit 1
fi
if grep -Fq 'http://127.0.0.1:' build/classes.strings \
        || ! grep -Fq 'https://127.0.0.1:3443' build/classes.strings; then
    echo "BUILD CHECK FAILED: APK contains an unpinned cleartext loopback origin" >&2
    exit 1
fi
if grep -Fq addJavascriptInterface build/classes.strings; then
    echo "BUILD CHECK FAILED: all-frame JavaScript interface remains in classes.dex" >&2
    exit 1
fi
if ! grep -Fq '__EVOGENT_SHELL_V2__' build/classes.strings \
        || ! grep -Fq '__EVOGENT_ASSISTANT_V1__' build/classes.strings \
        || ! grep -Fq 'DOCUMENT_START_SCRIPT:1' build/classes.strings; then
    echo "BUILD CHECK FAILED: exact-origin prompt facades missing from classes.dex" >&2
    exit 1
fi
if ! grep -Fq 'evogent/phone-auth/server/v1' build/classes.strings \
        || ! grep -Fq '/api/phone-auth/challenge' build/classes.strings \
        || ! grep -Fq '/api/phone-auth/complete' build/classes.strings \
        || ! grep -Fq 'evogent_phone_session' build/classes.strings \
        || ! grep -Fq '; Secure; HttpOnly' build/classes.strings \
        || ! grep -Fq 'SameSite=Strict' build/classes.strings \
        || ! grep -Fq 'EvogentSession ' build/classes.strings; then
    echo "BUILD CHECK FAILED: mutual loopback authentication protocol missing" >&2
    exit 1
fi
if grep -Fq '.openConnection()' \
        src/net/dangish/evogent/EvogentNotificationListenerService.java \
        src/net/dangish/evogent/ShareReceiverActivity.java; then
    echo "BUILD CHECK FAILED: native ingestion bypasses direct loopback authentication" >&2
    exit 1
fi
for authenticated_source in \
    src/net/dangish/evogent/EvogentNotificationListenerService.java \
    src/net/dangish/evogent/ShareReceiverActivity.java; do
    if ! grep -Fq 'EvogentLoopbackAuth.postJsonDirect' "$authenticated_source"; then
        echo "BUILD CHECK FAILED: native ingestion lacks direct loopback authentication" >&2
        exit 1
    fi
done
if grep -Fq 'webView.loadUrl(FEED_URL)' \
        src/net/dangish/evogent/MainActivity.java \
        || ! grep -Fq 'EvogentLoopbackAuth.authenticateWeb' \
            src/net/dangish/evogent/MainActivity.java \
        || ! grep -Fq 'setAcceptThirdPartyCookies(webView, false)' \
            src/net/dangish/evogent/EvogentLoopbackAuth.java; then
    echo "BUILD CHECK FAILED: privileged WebView authentication ordering is missing" >&2
    exit 1
fi
for bridge_source in src/net/dangish/evogent/MainActivity.java; do
    if ! grep -Fq 'EvogentLoopbackAuth.verifyServerAsync' "$bridge_source" \
            || ! grep -Fq 'EvogentLoopbackAuth.verifyServerBlocking' "$bridge_source" \
            || ! grep -Fq 'EvogentDocumentAuthority' "$bridge_source"; then
        echo "BUILD CHECK FAILED: per-document/per-call server proof is missing" >&2
        exit 1
    fi
done
if grep -R -E 'onReceivedSslError|SslErrorHandler|HostnameVerifier|setHostnameVerifier|setSSLSocketFactory' \
        src/net/dangish/evogent >/dev/null; then
    echo "BUILD CHECK FAILED: APK contains a TLS validation bypass hook" >&2
    exit 1
fi
if ! grep -Fq 'EVOGENT_A11Y_V1' build/classes.strings \
        || ! grep -Fq 'reply_port' build/classes.strings \
        || ! grep -Fq 'reply_nonce' build/classes.strings; then
    echo "BUILD CHECK FAILED: request-bound accessibility reply protocol missing" >&2
    exit 1
fi
if grep -Eq '8[7]90' \
        src/net/dangish/evogent/EvogentAccessibilityService.java; then
    echo "BUILD CHECK FAILED: fixed unauthenticated accessibility reply port remains" >&2
    exit 1
fi
if grep -q 'android:name="\.BrowseService"' AndroidManifest.xml \
        || grep -q 'android.permission.SCHEDULE_EXACT_ALARM' AndroidManifest.xml \
        || grep -q 'LOCKED_BOOT_COMPLETED' AndroidManifest.xml; then
    echo "BUILD CHECK FAILED: legacy autonomous browse scheduler remains in manifest" >&2
    exit 1
fi
if grep -Fq '.BrowseService' build/manifest.txt \
        || grep -Fq 'android.permission.SCHEDULE_EXACT_ALARM' build/manifest.txt \
        || grep -Fq 'LOCKED_BOOT_COMPLETED' build/manifest.txt; then
    echo "BUILD CHECK FAILED: packaged manifest contains the legacy browse scheduler" >&2
    exit 1
fi
if grep -Eq 'SYSTEM_ALERT_WINDOW|FOREGROUND_SERVICE_SPECIAL_USE|[.]OverlayService|anywhere_message_overlay' \
        AndroidManifest.xml build/manifest.txt build/classes.strings \
        || grep -R -Eq 'class (OverlayService|OverlayComposer)' \
            src/net/dangish/evogent; then
    echo "BUILD CHECK FAILED: persistent cross-app overlay capability remains" >&2
    exit 1
fi
if ! grep -Fq '.EvogentVoiceInteractionService' AndroidManifest.xml \
        || ! grep -Fq 'android.permission.BIND_VOICE_INTERACTION' AndroidManifest.xml \
        || ! grep -Fq '.EvogentAssistantActivity' AndroidManifest.xml \
        || ! grep -Fq 'android:supportsAssist="true"' \
            res/xml/voice_interaction_service.xml \
        || ! grep -Fq 'android:supportsLaunchVoiceAssistFromKeyguard="false"' \
            res/xml/voice_interaction_service.xml \
        || ! grep -Fq 'EvogentVoiceInteractionService' build/manifest.txt \
        || ! grep -Fq 'EvogentAssistantActivity' build/manifest.txt \
        || ! grep -Fq 'startAssistantActivity' build/classes.strings \
        || ! grep -Fq 'last_explicit_surface' build/classes.strings \
        || ! grep -Fq '/?overlay=1' build/classes.strings; then
    echo "BUILD CHECK FAILED: HOME memory or system-assistant composer integration is missing" >&2
    exit 1
fi
if grep -Fq 'EvogentAssistantContextStore.update' \
        src/net/dangish/evogent/EvogentVoiceInteractionSession.java \
        || grep -Fq 'hide();' \
            src/net/dangish/evogent/EvogentVoiceInteractionSession.java \
        || ! grep -Fq 'ASSIST_CONTEXT_WAIT_MS = 800L' \
            src/net/dangish/evogent/EvogentVoiceInteractionSession.java \
        || ! grep -Fq 'EvogentAssistantLaunchGate' build/classes.strings \
        || ! grep -Fq 'EvogentAssistantContextStore.seal' \
            src/net/dangish/evogent/EvogentVoiceInteractionSession.java \
        || ! grep -Fq 'EvogentAssistantTraversalPolicy.shouldPruneSubtree' \
            src/net/dangish/evogent/EvogentVoiceInteractionSession.java \
        || ! grep -Fq 'node.isAssistBlocked()' \
            src/net/dangish/evogent/EvogentVoiceInteractionSession.java; then
    echo "BUILD CHECK FAILED: exact-once assistant context/launch rendezvous is missing" >&2
    exit 1
fi
if ! awk '
    /android:name="[.]EvogentAssistantActivity"/ { in_assistant = 1; next }
    in_assistant && /android:exported="false"/ { found = 1; exit }
    in_assistant && /\/>/ { exit }
    END { exit(found ? 0 : 1) }
' AndroidManifest.xml \
        || ! awk '
    /name.*="[.]EvogentAssistantActivity"/ { in_assistant = 1; next }
    in_assistant && /exported.*=false/ { found = 1; exit }
    in_assistant && /E:/ { exit }
    END { exit(found ? 0 : 1) }
' build/manifest.txt; then
    echo "BUILD CHECK FAILED: assistant Activity is externally launchable" >&2
    exit 1
fi
if ! grep -Fq 'allowBackup(0x01010280)=false' build/manifest.txt; then
    echo "BUILD CHECK FAILED: APK backup of sensitive runtime data is not disabled" >&2
    exit 1
fi
if ! grep -Fq 'usesCleartextTraffic(0x010104ec)=false' build/manifest.txt \
        || [ "$(grep -Fc 'cleartextTrafficPermitted=false' build/network-security.txt)" -lt 2 ] \
        || ! grep -Fq 'includeSubdomains=false' build/network-security.txt \
        || ! grep -Fq "T: '127.0.0.1'" build/network-security.txt \
        || ! grep -Fq 'res/raw/evogent_phone_ca.pem' build/apk-files.txt; then
    echo "BUILD CHECK FAILED: release-pinned TLS network policy is missing" >&2
    exit 1
fi
if grep -Eqi '(server-key|ca-key|private.*key)' build/apk-files.txt; then
    echo "BUILD CHECK FAILED: private TLS key was packaged into the APK" >&2
    exit 1
fi
[ -s build/server-cert.pem ] && [ -s build/server-key.pem ] \
    && [ "$(file_mode build/server-key.pem)" = 600 ] || {
        echo "BUILD CHECK FAILED: matching server TLS material was not emitted safely" >&2
        exit 1
    }
if ! awk '
    /name.*="[.]BootReceiver"/ { in_boot = 1; next }
    in_boot && /exported.*=false/ { found = 1; exit }
    in_boot && /E:/ { exit }
    END { exit(found ? 0 : 1) }
' build/manifest.txt; then
    echo "BUILD CHECK FAILED: BootReceiver is not non-exported" >&2
    exit 1
fi
BADGING="$("$BTN/aapt2" dump badging build/evogent.apk)"
if ! printf '%s\n' "$BADGING" \
        | grep -q "package: name='net.dangish.evogent' versionCode='$ANDROID_VERSION_CODE' versionName='0.3.0'"; then
    echo "BUILD CHECK FAILED: APK package/version metadata is not Evogent 0.3.0 ($ANDROID_VERSION_CODE)" >&2
    exit 1
fi
echo "APK: $(pwd)/build/evogent.apk (security policy + version 0.3.0/$ANDROID_VERSION_CODE checks passed)"
