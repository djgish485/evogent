# Android/TLS artifact reuse for forward recovery

This is a recovery-only release-builder path. It creates a successor runtime
release while carrying forward one previously verified Android artifact set:

- the signed APK, including its embedded private release CA;
- the matching loopback TLS server certificate;
- the matching loopback TLS private key.

These three files are one identity. Never copy, replace, or reuse them
individually. Normal releases build a fresh APK/TLS set and reserve a higher
Android `versionCode`.

## When reuse is allowed

Use this path only when a known-good private phone release must be superseded
without changing the installed APK version. The prior archive must have its
builder-created `.sha256` sidecar beside it. Both files must be canonical
absolute paths, owned by the current user, mode `0600`, regular files with one
link, outside the source checkout, and reached without any symlink component.

The builder snapshots both inputs into its private temporary directory before
validation. It then verifies:

- the sidecar and safe archive member topology;
- the complete `files.sha256` and `links.json` inventories bound by the
  manifest;
- the manifest package, version, signer, APK hash, TLS certificate hash, and
  combined release identity;
- the APK signature and package metadata with Android build tools;
- the APK-embedded CA to TLS leaf chain, exact loopback SAN, leaf/key match,
  and certificate validity;
- the prior source commit and `android-shell` Git tree.

The prior release's `android-shell` tree must be byte-identical to the
successor source commit's tree. Any native source, resource, manifest, library,
test, or build-script change rejects reuse. Server/native protocol
compatibility still needs engineering review: tree equality prevents carrying
an old APK across native changes, but it cannot make an incompatible server
change safe.

## Build

With the usual release output and privacy-marker settings, add the explicit
archive opt-in:

```sh
EVOGENT_REUSE_ANDROID_TLS_FROM_RELEASE=/absolute/private/path/prior-release.tar.gz \
  scripts/build-phone-release.sh
```

Do not also set `EVOGENT_ANDROID_VERSION_CODE`. Reuse neither reads nor advances
the private Android version allocator and does not require signing-key
environment variables. The archive path is not written into the release
manifest or emitted in normal status output.

The successor manifest keeps its own `source.commit` and `web.buildId`. Its
additive `artifactProvenance.androidTls` object separately records whether the
native identity was built or reused, the original release that built it, and
the exact origin commit plus `android-shell` tree object. Old release manifests
without this object remain valid reuse inputs: their origin is inferred from
their manifest source commit, which must still exist in the local Git object
database and match the successor Android tree.

The finished archive uses the ordinary deployment path unless it is rescuing
the exact retained failed-initial-migration transaction. That exceptional case
must invoke:

```sh
scripts/deploy-phone-release.sh --forward-supersede <successor-release.tar.gz>
```

The explicit flag is accepted only when the device independently proves the
retained v3 source shape, restored predecessor state, terminal or expired exact
native rollback lineages, no active PackageInstaller session reachable from
those lineages or naming the target, and equal installed APK/TLS identity.
Unrelated staged Play/Mainline sessions do not block recovery. Duplicate
committed rollback records are accepted only with unique rollback/session
identities; an active committed session that has not applied or failed remains
a blocker no matter how long it appears stuck. Exact APK SHA equality fixes
both bytes and signer and lets the installer
avoid an Android package-manager mutation while still switching and
health-checking the successor runtime. Once the versioned forward decision is
durable, recovery is one-way. If the first successor fails only at the bounded
pre-switch preparation or post-start health phase, one explicit chained
successor with the same native identity may replace it; further chaining fails
closed.
