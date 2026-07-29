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
  security control to make installation appear unattended.

Broad distribution must keep the developer identity, package registration, and
signing keys ready for certified Android devices. ADB remains the technical
development and recovery channel; power-user exceptions are not the fleet
distribution plan. Android's current supported choices are documented in the
[developer-verification guide](https://developer.android.com/developer-verification/guides),
[managed-device provisioning guide](https://developers.google.com/android/management/provision-device),
[managed-app distribution guide](https://developers.google.com/android/management/apps),
and [Android Management API permissible-use policy](https://developers.google.com/android/management/permissible-usage).

## Foreground gates in the technical-user channel

Android owns some installation decisions. Play Protect may recommend a scan,
the package installer may require confirmation, developer verification may
require a supported power-user or registered-developer path, and Settings may
require owner confirmation for roles or restricted capabilities. Button text,
layout, and the number of steps can vary by OS release, locale, and device.

During a versioned update, the release workflow treats a trusted Android
installer or verifier foreground as the composite
`android_install_review` state, not as success and not yet as
rollback-worthy failure. It deliberately does not infer localized screen text
or export UI content merely to distinguish “scan” from “confirm”:

1. Persist the current transaction phase and exact candidate identity.
2. Report only the content-free action kind and whether the candidate install
   or predecessor restoration is waiting.
3. Explain the required foreground action in plain language. Keep any screenshot
   and device-specific evidence private.
4. A local coding agent may assist under the user's explicit installation
   authorization, but it must inspect a fresh display-0 image before input and
   must not blindly tap coordinates. If Android requires owner presence or the
   authorization is absent, pause for the owner.
5. For a bounded wait, re-read the exact installed APK bytes, version, signer,
   package-manager state, roles, service grants, and durable transaction phase.
   If the exact target becomes stable, continue the same transaction
   idempotently. If the owner process is interrupted or the wait expires,
   recovery restores and proves the predecessor before a later retry; it never
   starts an overlapping install or claims completion from the dialog alone.

An accepted scan is not proof that installation finished. A benign command
failure while a platform screen is waiting is not proof that installation
failed. An explicit refusal, harmful-app verdict, signature conflict, or
unresolvable security block fails closed and preserves or restores the prior
healthy release.

The coding agent must leave the device usable while waiting. If Evogent is a
HOME role holder, stock Android HOME remains reachable according to the launcher
availability contract.

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
