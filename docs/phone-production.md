# Phone production architecture

Android is Evogent's canonical production environment. The phone is not a remote
control for a VM: the launcher, local web app, SQLite database, source mechanics,
and brain CLI all run on the device. A host computer is a development and release
tool only.

The current technical-user path uses a stock Android phone, the Evogent shell APK,
Termux, and Shizuku. A future system-image distribution may remove that setup
friction without changing the product architecture below.

## The five layers

| Layer | Owns | Must not own |
|---|---|---|
| Product laws | General behavior that should hold for every Evogent user. These live in committed code, templates, and `.intent/`. | One person's accounts, taste, schedule, or private history. |
| Personal model | The user's interests, feedback, source cadence, account tiers, and learned context. These live in the phone's private `data/` directory and SQLite database. | Public defaults or repo-wide laws. |
| Agent judgment | What is interesting now, what an item means, what action would help, and how to diagnose an anomalous source. | Process supervision, locks, health checks, or brittle UI-driving boilerplate. |
| Deterministic mechanics | Launch, capture, tap, scroll, count, persist, deduplicate, lock, signal, measure, and report outcomes. | Editorial judgment or a hand-coded imitation of an agent. |
| Host development | Source changes, tests, builds, signed APKs, releases, and review of development suggestions queued by the phone. | Routine curation, personal browsing, or a second production scheduler. |

This separation is load-bearing. A runtime failure should improve the general
container: mechanics expose an honest outcome, an on-phone agent diagnoses or
adapts instructions where it can, and work requiring source changes is queued for
host review. Development agents do not hand-author the user's cards or browse
private apps in place of Evogent's runtime agents.

## Runtime ownership

There is one scheduling authority on the phone:

1. Android starts or wakes the Termux control plane. It does not run its own
   periodic browse alarm.
2. The Termux scheduler owns the cycle lease. App-open freshness requests,
   adaptive-heartbeat requests, notification signals, and watchdog recovery all
   become durable signals to that scheduler.
3. The scheduler coalesces signals and runs at most one browse/curate/arrange
   cycle at a time.
4. App research, source discovery, and standing-interest work use durable
   queued/leased/acknowledged requests with bounded retry and quarantine.
   One daily private overseer is a scheduler-owned due task, not an opportunistic
   side effect of whichever cycle happens to cross a clock window.
5. An independent watchdog checks that the scheduler, server, and cycle outcomes
   remain live. It wakes the owner; it does not become a second scheduler.

The Android shell owns preference-aware launcher mechanics, the WebView, native-app routing,
the system-assistant composer, local notification observation/replacement mechanics,
accessibility mechanics, boot signaling, and the per-install control-token boundary. The
notification stream enters a deterministic local light-curation lane; supported
runtime-agent evidence APIs omit notification content, policy forbids provider
workers from reading its shared SQLite rows, and urgent/system/safety originals
remain Android-owned. Provider workers currently share the server's Unix UID,
so this is not OS isolation from a compromised or adversarial same-UID process;
the hard-boundary requirement is documented in
`docs/phone-notification-curation.md`. The Android shell does not
choose primary-feed content, run editorial policy, or accept arbitrary external commands. Until a
successful main-frame page proves the authenticated
server process and an HTTP-success document, the WebView stays invisible behind
an opaque native Starting/Error surface with Retry and stock-app escape actions.

Model routing follows the same scope law. Notifications are deterministic and
model-free. An explicit `Browse Model` wins; otherwise routine browsing
preserves the deployment's existing `Codex Model`, with Terra only as the
public fallback when neither is configured. Persistent overrides for global
browse, YouTube browse, and curation are disabled in policy and code. The
current computer-use harnesses are screening only: the YouTube feed changes
between sequential runs, successful sharing does not prove private relevance,
and the existing mixed-browse receipt does not bind a frozen, blinded review.
The curator harness is unavailable until it can isolate every production side
effect. The harnesses retain content-free mechanics, yield, latency, and token
metrics while raw source text and model output remain in short-lived private
files. A future browse qualifier must use a new versioned receipt, give both
routes the same frozen workload, and bind a blinded private-relevance review to
every pair. The daily private overseer reviews receipts once per service day;
it does not edit product code or promote a model route while those gates are
closed.

Android Back first unwinds one React layer, then traverses only reauthenticated
trusted history; it never exits launcher root.

The Node server owns local APIs, WebSocket updates, agent orchestration, and
SQLite persistence. In the `phone` runtime profile it:

- listens on loopback only;
- serves the Android shell on release-pinned HTTPS while keeping a separate
  internal HTTP listener for Termux mechanics;
- treats loopback as transport, not identity, because Android apps share that
  namespace;
- requires a mutually authenticated, process-bound session for the Android
  WebView, native submissions, APIs, SSE, and WebSockets;
- rotates a separate mode-`0600` process credential for its own recursive
  server calls on every start;
- mutually authenticates Termux mechanics with an HMAC challenge and carries
  each one-shot direct session plus protected request on the same pinned
  connection, so a stale or hostile loopback listener receives no secret or
  request body;
- does not start Redis, a background worker, or VM-era queues;
- turns adaptive heartbeat decisions into a durable phone-cycle signal;
- queues accepted code-fix suggestions for host review instead of launching
  software-development agents on the phone.

The phone remains useful without a connected host. USB forwarding and SSH exist
for development and recovery, not for normal operation.

## Private data boundary

Committed files contain mechanisms and `.default.md` templates. The following
belong only to a deployment and must not enter commits, release manifests, logs
copied to public issues, or intent evidence:

- device serials, local addresses, SSH users, tokens, and signing material;
- email addresses, account handles, message content, contacts, and app sessions;
- `data/config.md`, preference instances, account tiers, browse notes, media,
  SQLite data, and brain authentication.

Use placeholders such as `<DEVICE_SERIAL>`, `<LOCAL_PORT>`, `<TERMUX_USER>`, and
`<PRIVATE_EMAIL>` in public instructions. The local host handoff file described
in `phone-paradigm/device/DEV-LOOP.md` is deliberately outside the checkout.

## Release contract

`scripts/build-phone-release.sh` creates one versioned, immutable bundle on the
host. It refuses a dirty Git tree, builds the web app and signed shell APK, and
records the exact mutually compatible state of:

- `.next`, `server.js`, and required runtime libraries;
- on-phone skills and mechanics scripts;
- the shell APK;
- a manifest with the source commit, Next.js build ID, APK version, file hashes,
  schema compatibility, and release format version.

The builder rewrites Next's generated build-machine path to a portable value and
fails if release text contains a non-example email address or the host
path/user/hostname.
Release builds reserve a monotonic Android `versionCode` in the host's private
state directory. The default is Unix epoch seconds; an atomic reservation bumps
past a same-second or clock-regression collision. A deliberate higher value can
be supplied through `EVOGENT_ANDROID_VERSION_CODE`. The shell APK's tracked
manifest remains at version 3 for standalone development builds, while `aapt2`
overrides only the immutable release artifact. The signed 32-bit epoch scheme
must be replaced before its 2038 limit.
Additional exact strings can be checked through
`EVOGENT_RELEASE_PRIVATE_MARKERS_FILE` (one private marker per line). Historical
intent backlog and audit evidence do not ship; only the privacy-safe product
contracts and failure-mode registry belong in the runtime.

`scripts/deploy-phone-release.sh` copies that bundle over the private USB/SSH
development channel and invokes its own installer. The device keeps releases
under `~/.local/share/evogent/releases/`; one atomic `current` symlink selects
both the runtime and mechanics. `~/evogent` resolves through that pointer.
`~/phone-tools` is deliberately a stable state/dispatch directory because its
locks, logs, cadence stamps, and outcome records are mutable; its code entries
resolve through the same `current` pointer.

The installer verifies the host-provided archive SHA-256, every bundled file
hash, symlink inventory, required paths, web build identity, APK identity,
APK-pinned CA/server-certificate pairing, and dependency tree. The manifest
links `runtime/node_modules` to the lock-addressed
`state/dependencies/<package-lock-sha256>/node_modules` tree. A verified exact
tree is reused. When it is missing, the installer builds a new staging tree
before acquiring the cycle gate:
`npm ci --ignore-scripts --omit=dev --omit=optional` installs the required
public runtime lock without running package lifecycle code or host-only
optional packages, then Termux's bundled `node-gyp` compiles
`better-sqlite3`. A native in-memory SQLite smoke test and
required-package resolution gate publishing the tree. Before publication, a
deterministic inventory records every directory, regular-file digest, and
symlink target. The complete inventory is re-verified and the entire tree is
made read-only. Unsupported optional host packages such as the embedding
backend, SWC, and image optimizers remain absent. The release uses a plain
CommonJS Next config, so production startup does not need the omitted SWC
compiler or an on-device download. The installer runs a complete production
Next preparation against the sealed Android dependency tree before switching;
Android runtime fallbacks own the remaining optional paths.

The new dependency tree is published under its lock hash without mutating an
existing tree. If that name contains an invalid tree, the installer builds and
seals the replacement first, atomically exchanges the two directories, and
moves the old tree into bounded quarantine. Older valid trees remain available
while installed releases reference them, so rollback restores a compatible
runtime instead of reusing whatever `node_modules` happens to be current.
The exclusive install lock also bounds staging trees and failed release
candidates left by a reboot or Android process death.

After dependency preparation, the installer atomically owns the cycle lease
before quiescing the exact scheduler/watchdog/server owners, takes a checked
SQLite backup and a copy of the installed APK, switches, restarts through the
phone profile, and requires local phone health plus the served release identity.
Every changed APK must advance `versionCode`. APK upgrades opt into Android's
native rollback manager, then the installer requires an available, non-staged
rollback with the exact new-to-prior version mapping before switching the
runtime; Android's enable flag alone is only best-effort. Any failure restores
the prior release, database, and APK and verifies the restored APK identity.

One narrow recovery exception exists for a failed initial migration that
reached `health_pending` after installing its APK, restored the complete legacy
database/token/role snapshot, and then proved every native rollback that can
move the installed release APK was terminally committed or deleted/expired.
Duplicate exact committed rollback records are admissible only when their
rollback and committed-session identities are independently unique.
Package-manager handlers must be idle and no valid
`evogent-package-op.<32-hex>` shell operation may remain. Unrelated staged
Play/Mainline sessions are allowed, but no active PackageInstaller parent/child
may be reachable from an exact rollback session ID, name Evogent, or require its
installed version. A committed parent/child session whose `applied` and
`failed` flags are both false is unresolved, not terminal; an apparently stuck
session blocks the exception rather than being treated as success. It is not a
force-install or downgrade path. The builder must reuse the failed release's
exact APK, embedded CA, TLS certificate, and TLS key as one verified artifact
set; the installer accepts
`--forward-supersede` only for that exact private v3 transaction shape and exact
installed APK/TLS identity.

The successor revalidates and hashes the retained v3 journal, rollback plan,
role snapshot, restored private state, installed APK/TLS identity, complete
release inventories, terminal-or-absent rollback/session proof, the empty valid
shell package-operation namespace, and its pinned recovery program before
publishing the `evogent.phone.forward-rescue.v1` decision journal. Nothing in
the new release may mutate production before that journal is durable. Once
published, the
transaction is deliberately forward-only: recovery stops the exact prior
writers, migrates the already-restored private state, prepares the sealed
runtime, switches mechanics and `current`, starts and health-checks the exact
successor, commits, and only then retires live recovery intent. It never
replays a database/token backup, invokes APK rollback, downgrades, or changes
the installed package.

The terminal native proof is repeated around decision publication, before a
chained successor, and during final health. Exact installed APK byte equality
also fixes its signing-certificate identity; a version-code-only observation is
never sufficient. The terminal rollback rows and committed session IDs are
bound into the durable forward journal so a later active session or changed
lineage cannot be hidden by replay.

If the selected successor itself proves unusable before switching
(`prepare_pending`) or after its runtime health attempt (`health_pending`), one
later explicit `--forward-supersede` may chain exactly one more runtime
successor with the same APK/TLS identity. The chained decision rebinds all
private-state and native evidence, quiesces the failed successor, and resumes
at preparation. A second chain, a native-identity change, an unbound state
inode, or any ambiguous journal fails closed. See
`docs/phone-release-artifact-reuse.md` for the private artifact input contract.

Ordinary releases preserve the app signing certificate: moving the keystore
outside the checkout or re-encrypting it does not rotate that identity. Signing
certificate rotation is a separate, intentionally one-way migration. Android
cannot natively roll an app back across a rotation unless the new lineage grants
the old certificate rollback capability, and that grant defeats the security
benefit by allowing the old key to sign a later update.
Re-presenting the same healthy release is a no-op. Releases, rollback backups,
dependency quarantine, dependency build staging, and install logs have bounded
retention. During the one-time legacy migration, the old shared `node_modules`
tree remains intact until the new release passes health and the transaction
journal commits; only then is that rollback-only copy reclaimed.

The old `deploy-next.sh` names remain only as fail-closed tombstones. A copy that
ships only `.next`, only an APK, or only a skill is not a deployment.

## Verification standard

Tests and API responses are necessary but not sufficient. A phone-affecting
change is complete only after:

1. build and focused automated checks pass;
2. the complete release is installed and its manifest matches the host source;
3. local health reports the phone profile, loopback binding, healthy SQLite, one
   scheduler owner, and no Redis/worker dependency;
4. the real hint-free pipeline runs: browse, cache, score, curate, and arrange;
5. the rendered result is inspected on physical display 0; and
6. the next naturally scheduled run is observed without host prompting.

Display-0 interactions require a fresh screenshot because live feed updates can
move tap targets. Runtime agents do private source work; host developers verify
the framework and the final rendered behavior. Passive detail-view attention is
weak curiosity evidence only after sustained reading or a recent user-initiated
scroll; initial viewport depth and restored/programmatic position do not qualify.

## Related documents

- `phone-paradigm/README.md` — phone runtime components and status
- `phone-paradigm/device/DEV-LOOP.md` — host-to-phone development workflow
- `phone-paradigm/device/MIGRATE-TO-NEW-PHONE.md` — private-data-safe migration
- `phone-paradigm/pixel-real-device-setup.md` — technical-user stock-device setup
- `docs/phone-notification-curation.md` — local notification and lock-screen digest contract
- `docs/development.md` — repository development commands and profiles

The VM documents remain useful for the public demo and legacy self-hosting, but
they are not the production architecture.
