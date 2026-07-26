#!/usr/bin/env bash
# Build one immutable, content-verified Evogent phone release.
#
# Output defaults outside the checkout so creating a release cannot make the
# source tree dirty. The bundle is accepted by device/install-release.sh.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
cd "$ROOT"

OUTPUT_DIR="${EVOGENT_RELEASE_OUTPUT_DIR:-$(dirname "$ROOT")/evogent-phone-releases}"
if [ "$#" -gt 0 ]; then
  OUTPUT_DIR="$1"
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "phone release: required command not found: $1" >&2
    exit 69
  }
}

require_command git
require_command node
require_command npm
require_command python3
require_command tar
require_command unzip
require_command openssl

OUTPUT_DIR="$(python3 - "$OUTPUT_DIR" "$ROOT" <<'PY'
import pathlib
import sys

raw_output, raw_root = sys.argv[1:]
root = pathlib.Path(raw_root).resolve(strict=True)
try:
    output = pathlib.Path(raw_output).expanduser().resolve(strict=False)
    output.relative_to(root)
except ValueError:
    print(output)
except (OSError, RuntimeError):
    print("phone release: release output path could not be resolved safely", file=sys.stderr)
    raise SystemExit(65)
else:
    print(
        "phone release: release output must resolve outside the source checkout",
        file=sys.stderr,
    )
    raise SystemExit(65)
PY
)"

BUILD_LOCK_WAIT_SECONDS="${EVOGENT_PHONE_BUILD_LOCK_WAIT_SECONDS:-21600}"
[[ "$BUILD_LOCK_WAIT_SECONDS" =~ ^[0-9]+$ ]] || {
  echo "phone release: build-lock wait must be a non-negative integer" >&2
  exit 65
}
BUILD_LOCK_PARENT="${TMPDIR:-/tmp}/evogent-phone-release-locks"
mkdir -p "$BUILD_LOCK_PARENT"
chmod 700 "$BUILD_LOCK_PARENT"
BUILD_LOCK_KEY="$(python3 - "$ROOT" <<'PY'
import hashlib
import pathlib
import sys
print(hashlib.sha256(str(pathlib.Path(sys.argv[1]).resolve()).encode()).hexdigest())
PY
)"
BUILD_LOCK="$BUILD_LOCK_PARENT/$BUILD_LOCK_KEY.lock"
BUILD_LOCK_HELD=0

acquire_build_lock() {
  local deadline=$(( $(date +%s) + BUILD_LOCK_WAIT_SECONDS ))
  local owner stale="$BUILD_LOCK.stale.$$"
  while ! mkdir "$BUILD_LOCK" 2>/dev/null; do
    owner="$(sed -n 's/^pid=//p' "$BUILD_LOCK/owner" 2>/dev/null | head -1)"
    if ! [[ "$owner" =~ ^[0-9]+$ ]] || ! kill -0 "$owner" 2>/dev/null; then
      if python3 - "$BUILD_LOCK" <<'PY'
import pathlib
import sys
import time
path = pathlib.Path(sys.argv[1])
raise SystemExit(0 if time.time() - path.stat().st_mtime >= 2 else 1)
PY
      then
        if mv "$BUILD_LOCK" "$stale" 2>/dev/null; then
          rm -rf -- "$stale"
          continue
        fi
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "phone release: timed out waiting for the checkout build lock" >&2
      return 1
    fi
    sleep 1
  done
  printf 'pid=%s\n' "$$" > "$BUILD_LOCK/owner"
  BUILD_LOCK_HELD=1
}

release_build_lock() {
  local owner
  [ "$BUILD_LOCK_HELD" = 1 ] || return 0
  owner="$(sed -n 's/^pid=//p' "$BUILD_LOCK/owner" 2>/dev/null | head -1)"
  if [ "$owner" = "$$" ]; then
    rm -rf -- "$BUILD_LOCK"
  fi
  BUILD_LOCK_HELD=0
}

trap release_build_lock EXIT
acquire_build_lock

if [ -z "${JAVA_HOME:-}" ] && [ -d /usr/local/opt/openjdk@11 ]; then
  export JAVA_HOME=/usr/local/opt/openjdk@11
  export PATH="$JAVA_HOME/bin:$PATH"
fi

assert_clean_source() {
  local status
  status="$(git status --porcelain=v1 --untracked-files=all)"
  if [ -n "$status" ]; then
    echo "phone release: refusing to build from a dirty source tree" >&2
    printf '%s\n' "$status" >&2
    exit 65
  fi
}

find_android_tool() {
  local name="$1" sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
  python3 - "$sdk" "$name" <<'PY'
import glob
import os
import re
import sys

sdk, name = sys.argv[1:]
paths = glob.glob(os.path.join(sdk, "build-tools", "*", name))
def version(path):
    raw = os.path.basename(os.path.dirname(path))
    return tuple(int(part) for part in re.findall(r"\d+", raw))
paths.sort(key=version)
if paths:
    print(paths[-1])
PY
}

assert_clean_source
SOURCE_COMMIT="$(git rev-parse HEAD)"
SOURCE_SHORT="$(git rev-parse --short=12 HEAD)"
ANDROID_VERSION_STATE_FILE="${EVOGENT_ANDROID_VERSION_STATE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/evogent/android-version-code}"
ANDROID_VERSION_ARGUMENTS=(
  --state-file "$ANDROID_VERSION_STATE_FILE"
  --forbid-root "$ROOT"
)
if [ "${EVOGENT_ANDROID_VERSION_CODE+x}" = x ]; then
  ANDROID_VERSION_ARGUMENTS+=(--override "$EVOGENT_ANDROID_VERSION_CODE")
fi
ANDROID_VERSION_CODE="$(python3 scripts/allocate-android-version-code.py \
  "${ANDROID_VERSION_ARGUMENTS[@]}")"
export EVOGENT_ANDROID_VERSION_CODE="$ANDROID_VERSION_CODE"

echo "phone release: building web application at $SOURCE_SHORT"
npm run build

echo "phone release: building and signing Android shell version $ANDROID_VERSION_CODE"
bash android-shell/build.sh

# A build script must not be able to quietly edit the source it claims to represent.
assert_clean_source

BUILD_ID="$(tr -d '\r\n' < .next/BUILD_ID)"
[ -n "$BUILD_ID" ] || {
  echo "phone release: .next/BUILD_ID is empty" >&2
  exit 66
}

APK="$ROOT/android-shell/build/evogent.apk"
[ -s "$APK" ] || {
  echo "phone release: signed APK missing: $APK" >&2
  exit 66
}

AAPT2="$(find_android_tool aapt2)"
APKSIGNER="$(find_android_tool apksigner)"
[ -x "$AAPT2" ] && [ -x "$APKSIGNER" ] || {
  echo "phone release: Android build tools aapt2/apksigner were not found" >&2
  exit 69
}

"$APKSIGNER" verify --verbose --print-certs "$APK" >/dev/null
unzip -Z1 "$APK" | grep -Eqi '^META-INF/.*\.(RSA|DSA|EC)$' || {
  echo "phone release: APK lacks the certificate block required for on-device signer verification" >&2
  exit 66
}
BADGING="$("$AAPT2" dump badging "$APK")"
APK_PACKAGE="$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\\([^']*\\)'.*/\\1/p" | head -1)"
APK_VERSION_CODE="$(printf '%s\n' "$BADGING" | sed -n "s/^package: .*versionCode='\\([^']*\\)'.*/\\1/p" | head -1)"
APK_VERSION_NAME="$(printf '%s\n' "$BADGING" | sed -n "s/^package: .*versionName='\\([^']*\\)'.*/\\1/p" | head -1)"
APK_SIGNER_SHA256="$("$APKSIGNER" verify --print-certs "$APK" \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -1)"
APK_SHA256="$(python3 - "$APK" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"

[ "$APK_PACKAGE" = "net.dangish.evogent" ] \
  && [[ "$APK_VERSION_CODE" =~ ^[0-9]+$ ]] \
  && [ -n "$APK_VERSION_NAME" ] \
  && [[ "$APK_SIGNER_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "phone release: could not verify APK package, version, and signer" >&2
    exit 66
  }

SAFE_BUILD_ID="$(printf '%s' "$BUILD_ID" | tr -cd 'A-Za-z0-9._-' | cut -c1-20)"
[ -n "$SAFE_BUILD_ID" ] || SAFE_BUILD_ID=build
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/evogent-phone-release.XXXXXX")"
trap 'rm -rf -- "$WORK_DIR"; release_build_lock' EXIT
TLS_CERT="$ROOT/android-shell/build/server-cert.pem"
TLS_KEY="$ROOT/android-shell/build/server-key.pem"
EMBEDDED_CA="$WORK_DIR/evogent-phone-ca.pem"
[ -f "$TLS_CERT" ] && [ ! -L "$TLS_CERT" ] \
  && [ -f "$TLS_KEY" ] && [ ! -L "$TLS_KEY" ] || {
    echo "phone release: Android build did not emit regular TLS certificate/key artifacts" >&2
    exit 66
  }
[ "$(stat -f '%Lp' "$TLS_KEY")" = 600 ] || {
  echo "phone release: Android TLS private key permissions must be 0600" >&2
  exit 66
}
unzip -p "$APK" res/raw/evogent_phone_ca.pem > "$EMBEDDED_CA"
[ -s "$EMBEDDED_CA" ] || {
  echo "phone release: APK does not contain its release CA certificate" >&2
  exit 66
}
openssl x509 -in "$TLS_CERT" -noout -checkend 0 >/dev/null || {
  echo "phone release: Android TLS certificate is not currently valid" >&2
  exit 66
}
openssl verify -purpose sslserver -CAfile "$EMBEDDED_CA" "$TLS_CERT" >/dev/null || {
  echo "phone release: Android TLS certificate does not chain to the APK release CA" >&2
  exit 66
}
TLS_SAN="$(openssl x509 -in "$TLS_CERT" -noout -ext subjectAltName \
  | tail -n +2 | tr -d '[:space:]')"
[ "$TLS_SAN" = "IPAddress:127.0.0.1" ] || {
  echo "phone release: Android TLS certificate must contain only the exact 127.0.0.1 IP SAN" >&2
  exit 66
}
openssl x509 -in "$TLS_CERT" -pubkey -noout \
  | openssl pkey -pubin -outform DER > "$WORK_DIR/server-cert.pub"
openssl pkey -in "$TLS_KEY" -pubout -outform DER > "$WORK_DIR/server-key.pub"
cmp -s "$WORK_DIR/server-cert.pub" "$WORK_DIR/server-key.pub" || {
  echo "phone release: Android TLS certificate/private key mismatch" >&2
  exit 66
}
TLS_CERT_DER_SHA256="$(openssl x509 -in "$TLS_CERT" -outform DER \
  | openssl dgst -sha256 -r | awk '{print $1}')"
TLS_CERT_NOT_AFTER="$(openssl x509 -in "$TLS_CERT" -noout -enddate | cut -d= -f2-)"
[[ "$TLS_CERT_DER_SHA256" =~ ^[0-9a-f]{64}$ ]] && [ -n "$TLS_CERT_NOT_AFTER" ] || {
  echo "phone release: Android TLS certificate identity could not be read" >&2
  exit 66
}

RELEASE_IDENTITY_DIGEST="$(python3 - "$APK_SHA256" "$TLS_CERT_DER_SHA256" <<'PY'
import hashlib
import sys

apk_sha256, certificate_sha256 = sys.argv[1:]
identity = f"apk-sha256:{apk_sha256}\ntls-cert-der-sha256:{certificate_sha256}\n"
print(hashlib.sha256(identity.encode("ascii")).hexdigest()[:12])
PY
)"
[[ "$RELEASE_IDENTITY_DIGEST" =~ ^[0-9a-f]{12}$ ]] || {
  echo "phone release: APK/TLS release identity could not be derived" >&2
  exit 66
}
# The APK embeds a freshly generated private CA, so two clean builds from the
# same source/build/version are intentionally different releases.  Bind the
# directory/archive identity to the actual APK plus its matching TLS leaf.
RELEASE_ID="${SOURCE_SHORT}-${SAFE_BUILD_ID}-apk${APK_VERSION_CODE}-${RELEASE_IDENTITY_DIGEST}"
RELEASE="$WORK_DIR/release"
RUNTIME="$RELEASE/runtime"

mkdir -p "$RUNTIME" "$RELEASE/phone-tools" "$RELEASE/device" "$RELEASE/apk" \
  "$RELEASE/tls" \
  "$RELEASE/defaults"

# The clean tree equals HEAD, but archive from Git anyway: ignored build caches,
# local secrets, worktrees, and private data can never enter a release by accident.
git archive HEAD \
  server.js worker.js package.json package-lock.json next.config.ts tsconfig.json \
  CLAUDE.md AGENTS.md LICENSE lib src scripts .claude \
  .intent/contracts.jsonl .intent/failure-modes.jsonl skills-library data \
  | tar -xf - -C "$RUNTIME"
# Host-development agent orchestration is disabled on the phone and contains
# host-specific state symlinks. It cannot enter a portable runtime bundle.
rm -rf "$RUNTIME/scripts/agents"

# Private data is a shared deployment state directory. Seedable public defaults
# travel beside the runtime, while runtime/data is created as a state link by the
# installer.
mv "$RUNTIME/data" "$RELEASE/defaults/data"

# Copy the build output without its disposable host cache.
mkdir -p "$RUNTIME/.next"
(cd "$ROOT/.next" && tar --exclude='./cache' -cf - .) | (cd "$RUNTIME/.next" && tar -xf -)

# Next records the build machine's absolute checkout in its generated server
# manifests. The custom server reads only their config, so retain the manifests
# with a portable appDir and regenerate their JavaScript twin exactly.
python3 - "$RUNTIME/.next/required-server-files.json" \
  "$RUNTIME/.next/required-server-files.js" <<'PY'
import json
import pathlib
import sys

json_path = pathlib.Path(sys.argv[1])
js_path = pathlib.Path(sys.argv[2])
payload = json.loads(json_path.read_text(encoding="utf-8"))
payload["appDir"] = "."
formatted = json.dumps(payload, indent=2)
json_path.write_text(formatted + "\n", encoding="utf-8")
js_path.write_text("self.__SERVER_FILES_MANIFEST=" + formatted, encoding="utf-8")
PY

cp "$APK" "$RELEASE/apk/evogent.apk"
cp "$TLS_CERT" "$RELEASE/tls/server-cert.pem"
cp "$TLS_KEY" "$RELEASE/tls/server-key.pem"
chmod 644 "$RELEASE/tls/server-cert.pem"
chmod 600 "$RELEASE/tls/server-key.pem"
cp -R "$ROOT/phone-paradigm/device/phone-tools/." "$RELEASE/phone-tools/"
cp "$ROOT/phone-paradigm/device/start-prod.sh" \
  "$ROOT/phone-paradigm/device/restart-evo.sh" \
  "$ROOT/phone-paradigm/device/install-release.sh" \
  "$ROOT/phone-paradigm/device/dependency-tree-state.py" \
  "$ROOT/phone-paradigm/device/rollback-state.py" \
  "$ROOT/phone-paradigm/device/write-control-token.py" \
  "$RELEASE/device/"
cp -R "$ROOT/phone-paradigm/device/bin" "$RELEASE/device/bin"

# Mutable paths are linked by the installer only after extraction. Keeping them
# out of the archive makes traversal validation and the immutable boundary clear.
rm -rf "$RUNTIME/data" "$RUNTIME/node_modules" "$RUNTIME/.env.local"

# Fail closed if a tracked/generated text artifact still contains an email
# address or this build machine's identity/path. Optional exact private markers
# can be supplied one per line without ever copying that file into the release.
python3 - "$RELEASE" "$ROOT" "$HOME" \
  "${EVOGENT_RELEASE_PRIVATE_MARKERS_FILE:-}" <<'PY'
import os
import pathlib
import re
import socket
import sys

release = pathlib.Path(sys.argv[1])
root = sys.argv[2]
home = sys.argv[3]
markers_path = sys.argv[4]
markers = {root, home, pathlib.Path(home).name, socket.gethostname()}
if markers_path:
    marker_file = pathlib.Path(markers_path)
    if not marker_file.is_file():
        raise SystemExit("phone release: private marker file was not found")
    markers.update(
        line.strip()
        for line in marker_file.read_text(encoding="utf-8").splitlines()
        if len(line.strip()) >= 4
    )
markers = {marker.encode() for marker in markers if len(marker) >= 4}
email = re.compile(rb"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
reserved_email_domains = {b"example.com", b"example.org", b"example.net", b"example.invalid"}

for path in release.rglob("*"):
    if not path.is_file() or path.is_symlink():
        continue
    data = path.read_bytes()
    if b"\0" in data:
        continue
    relative_path = path.relative_to(release)
    # Third-party source maps legitimately contain their authors' addresses.
    # Project source is scanned before compilation; generated .next text still
    # receives the exact host/private-marker checks below.
    private_email = ".next" not in relative_path.parts and any(
        match.group().rsplit(b"@", 1)[1].lower() not in reserved_email_domains
        for match in email.finditer(data)
    )
    if any(marker in data for marker in markers) or private_email:
        relative = relative_path.as_posix()
        raise SystemExit(f"phone release: private text detected in {relative}")
PY

BUILT_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
PACKAGE_LOCK_SHA256="$(python3 - "$ROOT/package-lock.json" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"

# Runtime-visible identity does not depend on a .git directory being deployed.
python3 - "$RUNTIME/.evogent-release.json" <<PY
import json
import sys
payload = {
    "releaseFormat": 1,
    "releaseId": "$RELEASE_ID",
    "sourceCommit": "$SOURCE_COMMIT",
    "sourceCommitShort": "$SOURCE_SHORT",
    "buildId": "$BUILD_ID",
    "builtAt": "$BUILT_AT",
    "apkVersionCode": int("$APK_VERSION_CODE"),
    "apkVersionName": "$APK_VERSION_NAME",
    "releaseIdentityDigest": "$RELEASE_IDENTITY_DIGEST",
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\\n")
PY

# Hash every regular file in a stable path order. Symlinks in .next are recorded
# separately in the manifest and are also bounded by the outer archive checksum.
python3 - "$RELEASE" "$RELEASE/files.sha256" "$RELEASE/links.json" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
inventory = pathlib.Path(sys.argv[2])
links_path = pathlib.Path(sys.argv[3])
excluded = {"files.sha256", "links.json", "manifest.json"}
rows = []
links = {}
for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
    relative = path.relative_to(root).as_posix()
    if relative in excluded:
        continue
    if path.is_symlink():
        target = os.readlink(path)
        if os.path.isabs(target):
            raise SystemExit(f"absolute symlink cannot enter a phone release: {relative}")
        resolved = (path.parent / target).resolve(strict=False)
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            raise SystemExit(f"symlink escapes phone release: {relative}")
        links[relative] = target
    elif path.is_file():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append(f"{digest}  {relative}")
inventory.write_text("\n".join(rows) + "\n", encoding="utf-8")
links_path.write_text(
    json.dumps(links, separators=(",", ":"), sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

INVENTORY_SHA256="$(python3 - "$RELEASE/files.sha256" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
LINKS_SHA256="$(python3 - "$RELEASE/links.json" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"

python3 - "$RELEASE/manifest.json" <<PY
import json
import sys
manifest = {
    "schema": "evogent.phone.release.v1",
    "releaseFormat": 1,
    "releaseId": "$RELEASE_ID",
    "releaseIdentityDigest": "$RELEASE_IDENTITY_DIGEST",
    "builtAt": "$BUILT_AT",
    "source": {
        "commit": "$SOURCE_COMMIT",
        "commitShort": "$SOURCE_SHORT",
    },
    "web": {"buildId": "$BUILD_ID"},
    "android": {
        "package": "$APK_PACKAGE",
        "versionCode": int("$APK_VERSION_CODE"),
        "versionName": "$APK_VERSION_NAME",
        "signerSha256": "$APK_SIGNER_SHA256".lower(),
        "sha256": "$APK_SHA256",
    },
    "phoneTls": {
        "host": "127.0.0.1",
        "port": 3443,
        "certificateDerSha256": "$TLS_CERT_DER_SHA256",
        "certificateNotAfter": "$TLS_CERT_NOT_AFTER",
    },
    "databaseSchema": {
        "version": 1,
        "strategy": "idempotent-startup-migrations",
        "rollbackRequiresSnapshot": True,
    },
    "stateLinks": {
        "runtime/data": "../../../state/data",
        "runtime/node_modules": "../../../state/dependencies/$PACKAGE_LOCK_SHA256/node_modules",
        "runtime/.env.local": "../../../state/config/.env.local",
        "runtime/.next/cache": "../../../../state/next-cache/$RELEASE_ID",
    },
    "dependencies": {"packageLockSha256": "$PACKAGE_LOCK_SHA256"},
    "inventory": {
        "algorithm": "sha256",
        "path": "files.sha256",
        "sha256": "$INVENTORY_SHA256",
        "linksPath": "links.json",
        "linksSha256": "$LINKS_SHA256",
    },
    "requiredPaths": [
        "runtime/.next/BUILD_ID",
        "runtime/.evogent-release.json",
        "runtime/server.js",
        "runtime/package.json",
        "runtime/package-lock.json",
        "runtime/lib",
        "runtime/src/lib/runtime-profile.js",
        "runtime/.claude",
        "runtime/.intent/contracts.jsonl",
        "runtime/.intent/failure-modes.jsonl",
        "runtime/skills-library",
        "phone-tools/evo-curl",
        "phone-tools/evo-health",
        "phone-tools/evo_curl_transport.py",
        "phone-tools/evogent_api.py",
        "phone-tools/control-plane.sh",
        "phone-tools/evogent-cycle.sh",
        "phone-tools/evogent-scheduler.sh",
        "phone-tools/evogent-watchdog.sh",
        "device/start-prod.sh",
        "device/restart-evo.sh",
        "device/install-release.sh",
        "device/dependency-tree-state.py",
        "device/rollback-state.py",
        "device/write-control-token.py",
        "apk/evogent.apk",
        "tls/server-cert.pem",
        "tls/server-key.pem",
    ],
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write("\\n")
PY

mkdir -p "$OUTPUT_DIR"
ARCHIVE="$OUTPUT_DIR/evogent-phone-${RELEASE_ID}.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK_DIR" release
chmod 600 "$ARCHIVE"
[ "$(stat -f '%Lp' "$ARCHIVE")" = 600 ] || {
  echo "phone release: archive containing TLS key is not mode 0600" >&2
  exit 66
}
ARCHIVE_SHA256="$(python3 - "$ARCHIVE" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
printf '%s  %s\n' "$ARCHIVE_SHA256" "$(basename "$ARCHIVE")" > "$ARCHIVE.sha256"
chmod 600 "$ARCHIVE.sha256"
[ "$(stat -f '%Lp' "$ARCHIVE.sha256")" = 600 ] || {
  echo "phone release: archive checksum sidecar is not mode 0600" >&2
  exit 66
}

echo "phone release: $ARCHIVE"
echo "phone release sha256: $ARCHIVE_SHA256"
echo "source: $SOURCE_COMMIT"
echo "build: $BUILD_ID"
echo "apk: $APK_VERSION_NAME ($APK_VERSION_CODE)"
