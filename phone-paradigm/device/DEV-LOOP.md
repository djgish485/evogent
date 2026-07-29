# Phone development loop

This is the cold-start guide for a host development agent working on an
Evogent phone. The phone is production; the host builds and releases it. Read
these first:

1. `CLAUDE.md` — mission, agent philosophy, and runtime boundaries
2. `docs/phone-production.md` — canonical phone architecture and release contract
3. this file — connection, release, and verification mechanics
4. `MIGRATE-TO-NEW-PHONE.md` — provisioning and private-state migration

Before changing behavior, search `.intent/contracts.jsonl` and
`.intent/backlog.jsonl`. The large local intent database is optional private
evidence; the committed ledgers remain available when that database is absent.

## Local device notes

Device-specific facts must live outside the checkout. The host convention is
`../PIXEL-DEV-LOCAL.md`, a sibling of the repo directory. It may contain:

- the current ADB serial and forwarding command;
- the local SSH port and Termux user;
- canonical device paths and backup locations;
- current deployed release/build identifiers; and
- private operational decisions or unresolved device observations.

Never paste that file into commits, commit messages, release manifests, test
fixtures, public issues, or agent handoffs that leave the machine. If the file is
missing, recover values from the connected device and recreate it locally with
permissions appropriate for private notes.

## Role hierarchy

- The host development agent changes product code, skills, mechanics, guards,
  tests, and releases.
- Evogent's on-phone agents perform runtime work: source interpretation,
  curation, life administration, and anomaly diagnosis.
- Deterministic scripts drive and measure the phone. They do not decide what the
  user should care about.
- A phone-generated code-fix suggestion enters the host-review queue. It never
  launches a software-development agent on the phone.

An optional host maintainer may periodically review that privacy-safe queue,
edit product code and instructions, run tests, build and release, and verify the
result at the physical glass. Its model and schedule are deployment-private.
This host convenience never gives the on-phone overseer development authority.

When a runtime task fails, improve the general container, then dispatch the
natural skill trigger again without item-specific hints. Do not hand-author the
runtime output as a shortcut.

## Connect over USB

Termux SSH normally listens on device port 8022. Bridge it through ADB with local
values from the private notes file:

```bash
adb -s <DEVICE_SERIAL> forward tcp:<LOCAL_PORT> tcp:8022
ssh -p <LOCAL_PORT> \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  <TERMUX_USER>@127.0.0.1
```

Typical on-phone layout:

- `~/evogent` — server, build, libraries, skills, and private `data/`
- `~/phone-tools` — canonical mechanics and control-plane scripts
- `~/evogent/phone-sources` — symlinks into `~/phone-tools`, never copied twins
- `~/.local/share/evogent/state/dependencies/<package-lock-sha256>/` — immutable,
  verified Android dependency trees selected by each release manifest
- tmux `evo` — local Node server
- tmux `evo-sched` — the sole Termux scheduler
- control-plane leases and outcome state under `~/phone-tools/`

tmux target names prefix-match unless the target is explicitly exact. Production
mechanics use `'=evo'` for a session and `'=evo:'` for a session-scoped
`list-panes` target; keep the leading equals quoted through every host and
Termux shell.

ADB and SSH are development/recovery channels. Normal phone operation must keep
working after the host disconnects.

## Runtime invariants before a release

Confirm the phone is running the `phone` profile:

- the server starts through `device/start-prod.sh`;
- HTTP listens on `127.0.0.1`, not Wi-Fi or all interfaces;
- Redis and the VM background worker are disabled;
- one live scheduler owns the scheduler lease;
- at most one cycle owns the cycle lease; and
- Android has no independent periodic browse alarm.

Never start a second scheduler to “test” scheduling. Write a cycle request through
the supported signal path and let the owner claim it.

## Build and install a release

Commit the intended source first; release builds deliberately reject dirty
trees. Build into the default sibling output directory:

```bash
bash scripts/build-phone-release.sh
```

Load the device-specific values from the private notes into the environment,
then deploy the resulting archive:

```bash
EVOGENT_ADB_SERIAL=<DEVICE_SERIAL> \
EVOGENT_SSH_USER=<TERMUX_USER> \
EVOGENT_SSH_PORT=<LOCAL_PORT> \
bash scripts/deploy-phone-release.sh <RELEASE_ARCHIVE>
```

The archive and its `.sha256` sidecar are one release unit. Its manifest pins
`runtime/node_modules` to
`state/dependencies/<package-lock-sha256>/node_modules`. The installer reuses
that tree only after verification. If the exact tree is missing, it builds one
before acquiring the cycle gate with
`npm ci --ignore-scripts --omit=dev --omit=optional`, compiles
`better-sqlite3` against Termux's bundled `node-gyp`, and proves native
SQLite plus a complete production Next preparation. Host-only optional
embedding, SWC, and image-optimizer packages remain absent. The production Next
config is plain CommonJS, so startup never needs the omitted SWC compiler;
Android runtime features use their documented fallbacks. The completed tree is
published immutably under the lock hash, and older trees remain while installed
releases reference them.

The installer then waits for and owns a safe cycle boundary, preserves private
data, switches runtime and mechanics through one atomic pointer, installs the
signed APK, and passes local health. It rolls back the release, database, APK,
and compatible dependency reference together on failure. Re-presenting the same
healthy release is a no-op.

The durable transaction journal—not the installer PID or its preflight lock—is
the control-plane mutation barrier. A live install lock without a journal may be
building or verifying dependencies while production continues. Once the journal
exists, scheduler dispatch and watchdog revival stay gated until rollback or
committed finalization removes it; boot invokes the pinned recovery copy first.

### Exact equal-APK forward recovery

Do not use this for an ordinary failure. It accepts only the one fail-closed
initial-migration shape documented in `docs/phone-production.md`: private v3 or
v4 `health_pending` metadata (with no pending v4 foreground-action state), a
fully restored legacy database/token/role
snapshot, the exact installed failed-release APK/TLS identity, and positive
RollbackManager proof that every rollback capable of moving that installed APK
is committed and terminal, or has been deleted/expired. Multiple exact
committed rows are permitted only when their rollback IDs and committed
PackageInstaller session IDs are unique. The package-manager handlers must be
idle and every valid `evogent-package-op.<32-hex>` shell operation must be
absent. PackageInstaller may retain unrelated staged Play/Mainline sessions,
but no active parent/child may be reachable from the exact rollback session
IDs, name Evogent, or require its installed version. A committed parent/child
session with neither `applied` nor `failed` is still live authority, even if it
appears stuck; forward recovery fails closed until Android makes it terminal.
There is no stuck-session override.

Build the successor from committed source while reusing the complete private
APK/TLS artifact set:

```bash
EVOGENT_REUSE_ANDROID_TLS_FROM_RELEASE=<ABSOLUTE_PRIVATE_PRIOR_ARCHIVE> \
bash scripts/build-phone-release.sh
```

Then make the exceptional installer intent explicit:

```bash
EVOGENT_ADB_SERIAL=<DEVICE_SERIAL> \
EVOGENT_SSH_USER=<TERMUX_USER> \
EVOGENT_SSH_PORT=<LOCAL_PORT> \
bash scripts/deploy-phone-release.sh --forward-supersede <RELEASE_ARCHIVE>
```

There is no environment-variable alias, automatic fallback, version-code
downgrade, or `pm install -d` escape hatch. Activation revalidates the retained
v3 transaction and exact native identity before publishing the
`evogent.phone.forward-rescue.v1` decision journal. Before that publication,
the retained source transaction remains untouched. After it, recovery is
forward-only and boot always invokes the pinned recoverer before ordinary
installer logic.

If that successor fails in `prepare_pending` or `health_pending`, exactly one
later explicit forward-supersede may chain a second runtime successor that
retains the same APK/TLS identity and bound private state. No second chain or
native change is accepted.

`deploy-next.sh` is a fail-closed compatibility tombstone. Do not revive partial
`.next`, APK-only, skill-only, or direct-copy production paths.

## Runtime-agent verification

Dispatch runtime judgment through the local app API, using the local base URL
from the runtime environment rather than a public endpoint. Prompts are general
and hint-free, for example:

```text
Run the phone-life-admin sweep now, per the skill.
```

Use the scheduler's cycle-request mechanism for a full source cycle. Do not invoke
the browse, curator, and arranger independently in a way the natural control
plane never does.

SQLite is the state source of truth. JSONL output is audit evidence only.
Suggestion lifecycle belongs in suggestion metadata, not an assumed top-level
feed status.

## Verify at the glass

API state and rendered state can diverge. For every user-visible change:

1. Run focused tests and a production build on the host.
2. Install the complete component set and verify its inventory.
3. Run a hint-free browse → cache → score → curate → arrange cycle.
4. Capture physical display 0 and inspect the actual top slate.
5. Exercise the affected interaction on display 0.
6. Observe one naturally scheduled cycle after the manual verification.

Use explicit display 0 for host-driven input:

```bash
adb -s <DEVICE_SERIAL> exec-out screencap -p > <LOCAL_SCREENSHOT_PATH>
adb -s <DEVICE_SERIAL> shell input -d 0 tap <X> <Y>
adb -s <DEVICE_SERIAL> shell input -d 0 swipe <X1> <Y1> <X2> <Y2> <DURATION_MS>
```

Take a fresh screenshot immediately before a tap. Live feed updates and reorder
banners can move hit targets.

## Known operational traps

- Termux does not provide the conventional `/tmp`; use an app-private path or
  `$TMPDIR`.
- A detached shell may not inherit the brain/browse environment. Enter through
  the canonical start or cycle script.
- A timeout that creates a separate process group can suspend Android shell
  children; phone-driving timeouts must use foreground semantics.
- A successful `rish` exit and its captured stdout are not a completion proof:
  fast Android-shell output can arrive empty nondeterministically. Safety-
  critical reads must publish a bounded, typed result to a randomized
  `/data/local/tmp` capability path, change it to readable only after command
  success, and let Termux poll, parse, and remove that exact result.
- Never use a broad process-name kill for brain CLIs. Track and terminate only the
  process tree owned by the current task.
- A stale hidden-display file is not proof that a display is live; validate the
  recorded owner lease.
- Deep Doze can prevent hidden-display launch and suspend bounded scheduled
  private-learning work. Power handling must be scoped to the active browse or
  scheduled task and released afterward, with a measured outcome. Termux's wake
  lock is app-global, so Evogent touches it only when the owner has installed
  the exact private dedicated-Termux marker documented in
  `pixel-real-device-setup.md`.
- A deploy must not inherit its lock into the restarted server or scheduler.
- A response printed only on stderr is an error transcript, not a delivered agent
  reply.
- An API-only or hidden-display-only check does not verify the home-screen result.

## Completion evidence

A handoff should state, without private values:

- source commit and release/build identifiers;
- automated checks run and their results;
- component inventory match;
- local health result and single scheduler/cycle owners;
- manual display-0 behavior observed;
- scheduled-run time and structured source outcomes; and
- any remaining open intent-ledger entries.
