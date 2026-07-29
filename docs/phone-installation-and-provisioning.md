# Phone installation and provisioning

Evogent has one signed phone product and two installation channels. They serve
different users, but they must preserve the same runtime, privacy, release, and
Android-security boundaries.

| Channel | Intended user | Status | Setup boundary |
|---|---|---|---|
| Agent-assisted stock Android | A technical user working with a local coding agent | Current path; foreground-gate acceptance and safe-recovery tests are release gates | USB/ADB and host tooling may assist installation and recovery, but the phone operates without the host afterward |
| Managed fleet | A nontechnical user receiving a phone provisioned by an authorized operator | Roadmap until a supported management adapter and fleet acceptance suite ship | Verified managed-app distribution plus Android Enterprise/device-owner, OEM, or system-image provisioning |

The manual channel is not a prototype to delete when the fleet channel ships.
It remains the inspectable, repairable path for developers and other technical
owners. The managed channel removes setup work for a nontechnical user; it does
not remove Android's protections or turn private state into a shared image.

## Shared invariants

Both channels:

- install one immutable release whose runtime, mechanics, APK, manifest, source
  identity, and hashes agree;
- preserve one package name and signing lineage across ordinary updates;
- keep credentials, app sessions, control tokens, personal data, and learned
  state separate for each phone;
- verify the installed APK and Android grants from fresh platform state rather
  than trusting a command exit or management-console request;
- retain the durable rollback and runtime-health contract in
  `docs/phone-production.md`; and
- never disable Play Protect, developer verification, restricted-settings
  warnings, package-signature checks, enrollment disclosure, or another Android
  security control to make installation appear unattended; and
- respect later owner revocation of accessibility, notification access, special
  app access, or another capability: ordinary runtime may probe, explain, and
  defer, but it must not silently grant or regrant the capability.

Broad distribution must keep the developer identity, package registration, and
signing keys ready for certified Android devices. ADB remains the technical
development and recovery channel; power-user exceptions are not the fleet
distribution plan. Android's current supported choices are documented in the
[developer-verification guide](https://developer.android.com/developer-verification/guides),
[managed-device provisioning guide](https://developers.google.com/android/management/provision-device),
[managed-app distribution guide](https://developers.google.com/android/management/apps),
and [Android Management API permissible-use policy](https://developers.google.com/android/management/permissible-usage).

## Foreground gates in the technical-user channel

Android owns some installation decisions. It does not present a Play Protect
scan on every install. Whenever Play Protect offers or recommends a scan, the
supported Evogent path requires that scan. Neither the owner nor an assisting
agent may choose an install-without-scanning path, dismiss or suppress the gate
in order to continue, or disable verification. The package installer may also
require confirmation, developer verification may require a supported power-user
or registered-developer path, and Settings may require owner confirmation for
roles or restricted capabilities. Button text, layout, and the number of steps
can vary by OS release, locale, and device.

During every changed-APK install and every predecessor restoration performed by
the current workflow through Android native rollback, the release workflow
enters the composite `android_install_review` state. Recovery also preserves
this state when an interrupted transaction already contains a predecessor
review. This is mandatory even when its content-free display-0 probe never
identifies a known Android installer or verifier. A
foreground disappearing, an exact installed APK, and an idle package manager
are necessary platform proofs, but none is authority to continue. The workflow
deliberately does not infer localized screen text or export UI content merely to
distinguish “scan” from “confirm”:

1. Persist the current transaction phase, exact target identity, a fresh
   256-bit challenge and expiry, and whether a trusted verifier was observed
   even once.
2. Report only the content-free action kind and whether the candidate install
   or predecessor restoration is waiting.
3. Explain the required foreground action in plain language. If a Play Protect
   scan is offered or recommended, say explicitly that taking the scan path is
   required and that bypassing it is unsupported. Keep any screenshot and
   device-specific evidence private.
4. A local coding agent may assist under the user's explicit installation
   authorization, but it must inspect a fresh display-0 image before input and
   must not blindly tap coordinates. If Android requires owner presence or the
   authorization is absent, pause for the owner.
5. After the action is resolved, inspect a new display-0 image and invoke the
   exact pinned helper command printed by the installer:
   `python3 ~/.local/share/evogent/install-transaction/attest-install-review.py
   --fresh-display-0 <challenge> <outcome>`. Use `scan-completed` when a scan
   was offered and completed without a security verdict. Use
   `no-scan-offered` only when the fresh display shows that no scan was offered.
6. The helper re-reads the private live journal and binds its private receipt to
   that release, migration, purpose, APK hash/version/signer, challenge, expiry,
   and journal digest. If the installer observed a trusted verifier even once,
   `no-scan-offered` is rejected and only `scan-completed` can authorize
   progress. A later trusted observation rotates the challenge and invalidates
   any earlier receipt.
7. For a bounded wait, re-read the exact installed APK bytes, version, signer,
   package-manager state, roles, service grants, and durable transaction phase.
   Continue only after those proofs and the fresh matching receipt agree. If
   the owner process is interrupted before any Android package command launches,
   recovery may remove only that exact prepared staging namespace. Once the
   command crossed its durable launch fence, recovery stays manual and inert; it
   never starts an overlapping install or claims completion from foreground
   disappearance, handler-idle, or already-present APK bytes.

After an interrupted package operation, recovery conservatively treats the
launched attempt as ambiguous. The exact operation nonce and
`prepared`/`launched` state are journaled before Android can mutate the package.
A prepared operation can be reaped without launching it. A launched operation
cannot: foreground observation, receipt publication, and Android session
completion are not atomic, and package-manager handler-idle is not an
authoritative PackageInstaller session result. If a persisted candidate-install
or predecessor-restoration review is interrupted while the same trusted review
remains visible, a rotated fresh `scan-completed` challenge may finish that
review. If it is no longer visibly bound to Android, the transaction reports
manual recovery and performs no package mutation. It does not consume a
pre-crash receipt, accept target bytes as authority, or reissue the install.

The predecessor-restoration review has one durable generation. This bounds
`MY_PACKAGE_REPLACED` recovery feedback and prevents repeated package mutation
while Android restores the prior APK natively or an interrupted predecessor
review is being recovered. Its scan-required bit is sticky across challenge
rotation until a matching `scan-completed` receipt is accepted. The current
technical-user workflow never initiates a downgrade or fallback reinstall. It
requires an exact native rollback mapping before switching the runtime; a failed
or unparseable availability probe is `unknown`, not proof of absence, and aborts
the update. Once native rollback crosses its launch fence, no second package
mutation can overlap it. Recovery may complete a persisted review only while
the same trusted Android foreground remains visible; otherwise it stays
manual and inert. A crash after the launch fence therefore trades automatic
liveness for safety: the existing technical-user channel needs an owner or
coding agent to resolve the Android session. Future managed-fleet automation
must own and journal a supported PackageInstaller session identifier whose
exact terminal or abandoned state it can prove; it may not weaken this boundary
by scripting around Android UI.

Android may return a successful package status and publish the target APK before
a verifier raises its foreground review. The versioned installer therefore
observes a bounded post-success display-0 foreground window as well as the
command-failure path, then requires the same attestation in both cases. A
status-zero package command and automated foreground disappearance never
authorize roles, runtime activation, or release commit.

Completing an offered scan without a harmful verdict is not proof that
installation finished. A benign command failure while a platform screen is
waiting is not proof that installation failed. Refusal or inability to complete
an offered scan, a harmful-app or other security verdict, a signature conflict,
or an unresolvable security block fails closed and preserves or restores the
prior healthy release.

Automated proof covers policy emission and exact installed APK identity; it does
not prove which foreground scan choice was accepted. Only fresh physical-device
observation followed by the transaction-bound owner or authorized-operator
attestation records the required choice. The receipt contains no screenshot or
UI text, is consumed by that transaction, and cannot be replayed after a
challenge rotation, rollback, timeout, or later install.

The coding agent must leave the device usable while waiting. If Evogent is a
HOME role holder, stock Android HOME remains reachable according to the launcher
availability contract.

The stock technical-user path also requires owner-granted runtime capabilities.
Where the supported hidden-display mechanics on a given Android build require
Termux's **Display over other apps** special access, the owner enables it through
Android Settings. Boot, watchdog, and browse-cycle code may probe the resulting
capability and defer work after revocation; they must not restore it with
`appops`. The same owner-controlled rule applies to Evogent accessibility and
notification access. Evogent's native notification Settings surface owns
notification-access recovery.

For a fresh technical-user phone, the supported order is:

1. complete base Android setup, then install/open Termux and Shizuku from
   trusted sources and start Shizuku;
2. use [`phone-signing-and-bootstrap.md`](phone-signing-and-bootstrap.md) to
   create or recover one stable private signing identity, verify one host-built
   release, bootstrap-install its exact signed Evogent APK, launch it, take a
   Play Protect scan whenever one is offered or recommended, and prove the
   resulting installed bytes and version;
3. only after Android knows that package, visibly grant Evogent accessibility,
   notification access, and any restricted setting, and grant Termux **Display
   over other apps** only when the supported hidden-display mechanics require it;
4. run `~/phone-tools/provision-host-policy.sh --status`; if the three documented
   values are not ready, explain the changes and obtain explicit owner
   authorization before `~/phone-tools/provision-host-policy.sh --apply`. The
   helper saves the prior values privately, limits its writes to those three
   settings, verifies readback, and supports
   `~/phone-tools/provision-host-policy.sh --restore`. Ordinary runtime never
   invokes `--apply`; and
5. resume or run the versioned bundle installer so the same APK and the complete
   runtime become one atomic current release.

A technical bootstrap may place the exact reviewed helper from that verified
bundle at the canonical command path before the transaction resumes. That copy
is not an independently supported runtime: successful installation must replace
it with the manifest-qualified current-release dispatch.

Migration backups follow the same separation. The supported backup contains an
online-verified database, selected mutable Evogent state, package/version
inventory, the installed APK, and hashes. It does not archive Termux home or
`usr`, provider login directories, SSH configuration, environment files,
control tokens, releases, dependencies, transient runtime state, device-local
host-policy/wake authority, live scheduler/source queues and signals, or
unvalidated source-recipe candidates.
Provider or SSH authentication transfer is a separate, explicit owner decision
using an exact provider-supported export; fresh sign-in and a new SSH key are
preferred. A final migration snapshot is a handoff boundary: keep the old
scheduler offline before the new one starts so one snapshot cannot authorize
work or provider spend on two phones. The backup itself holds the canonical
cycle fence across its database/state cut and refuses to run over a live
browse/provider owner.

## Managed fleet channel

Bulk provisioning is a separate deployment adapter around the same release, not
a loop that drives Settings or package-installer screens across many phones.
Do not assume that a first-party project may directly use Android Management
API for any retail scenario. The selected channel must fit its current
permissible-use rules; otherwise use a qualifying management partner, a verified
app-distribution channel, or an OEM/system integration.

The selected supported path should:

1. enroll eligible devices transparently through Android Enterprise,
   fully-managed/device-owner provisioning, an OEM agreement, or a deliberately
   maintained system image;
2. distribute Evogent as a verified private or public managed app and apply only
   policies the platform allows that management mode to set;
3. run a visible first-use setup action for account sign-in, consent, or a grant
   that Android does not delegate to the administrator;
4. mint device-local control identity and private state after enrollment rather
   than cloning either from a golden phone;
5. bind the installed APK proof to the same atomic runtime release transaction;
   and
6. support ordinary updates, failed-update recovery, device replacement,
   administrator removal, and data erasure without depending on a development
   Mac or an interactive coding agent.

Managed ownership has user-visible consequences. Setup and product language must
say who manages the phone and what that administrator can do. A personally owned
device must not be silently converted into a fully managed device. If the chosen
management mode cannot grant a required capability, Evogent must either use a
supported OEM/system integration, expose one clear owner step, or declare the
configuration unsupported.

A managed adapter may configure accessibility, notification access, special app
access such as **Display over other apps**, or an equivalent capability only
when the selected platform or OEM management mode explicitly authorizes that
grant. Otherwise it remains a visible first-use owner step or the configuration
is unsupported; fleet scale does not justify scripting Settings taps or
restoring a revoked grant.

The managed channel is not shipped merely because one phone can be installed
with ADB. It qualifies only after generic reset-device tests cover enrollment,
release identity, per-device state isolation, required first-use actions,
security refusal, offline restart, update and rollback, device replacement, and
unenrollment.

## Related documents

- `docs/phone-production.md` — runtime architecture and atomic release contract
- `phone-paradigm/device/MIGRATE-TO-NEW-PHONE.md` — current technical-user procedure
- `phone-paradigm/pixel-real-device-setup.md` — stock-device capability setup
- `phone-paradigm/device/DEV-LOOP.md` — host-agent release and glass verification
