import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const contracts = fs
  .readFileSync('.intent/contracts.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const backlog = fs
  .readFileSync('.intent/backlog.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const failureModes = fs
  .readFileSync('.intent/failure-modes.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const architecture = fs.readFileSync(
  'docs/phone-installation-and-provisioning.md',
  'utf8',
);
const architectureProse = architecture.replace(/\s+/g, ' ');
const installer = fs.readFileSync(
  'phone-paradigm/device/install-release.sh',
  'utf8',
);
const installSecurityScriptPaths = [
  'scripts/deploy-phone-release.sh',
  'phone-paradigm/device/install-release.sh',
  'phone-paradigm/device/attest-install-review.py',
];

function contractByKey(key) {
  return contracts.findLast((entry) => entry.key === key);
}

test('technical-user installation is agent-assisted, resumable, and security preserving', () => {
  const contract = contractByKey('phone-install-agent-assisted-resumable');
  assert.ok(contract);
  assert.equal(contract.status, 'law');
  assert.match(contract.statement, /technical user aided by a local coding agent/);
  assert.match(contract.statement, /typed nonterminal user_action_required state/);
  assert.match(contract.statement, /resumes idempotently/);
  assert.match(contract.statement, /does not present a Play Protect scan on every install/);
  assert.match(contract.statement, /requires the scan/);
  assert.match(contract.statement, /forbids install-without-scanning, suppression, or verifier disablement/);
  assert.match(contract.statement, /never falsely reports success/);
  assert.match(
    contract.statement,
    /requires a proven exact native rollback mapping[\s\S]*never initiates a downgrade or fallback reinstall/,
  );
  assert.match(contract.statement, /Capability revocation remains effective/);
  assert.match(contract.statement, /ordinary boot and runtime probe, explain, and defer/);
  assert.match(
    contract.evidence,
    /automated policy and exact installed-identity proof/i,
  );
  assert.match(contract.evidence, /physical.*scan-choice acceptance/i);

  assert.match(architectureProse, /does not present a Play Protect scan on every install/);
  assert.match(architectureProse, /Whenever Play Protect offers or recommends a scan, the supported Evogent path requires that scan/);
  assert.match(architectureProse, /App scan recommended.*choose.*Scan/);
  assert.match(
    architectureProse,
    /Neither the owner nor an assisting agent may choose an install-without-scanning path/,
  );
  assert.match(
    architectureProse,
    /Automated proof covers policy emission and exact installed APK identity; it does not prove which foreground scan choice was accepted/,
  );
  assert.match(
    architectureProse,
    /Only fresh physical-device observation followed by the transaction-bound owner or authorized-operator attestation records the required choice/,
  );
  assert.match(
    architectureProse,
    /After an interrupted package operation, recovery conservatively treats the launched attempt as ambiguous/,
  );
  assert.match(
    architectureProse,
    /persisted candidate-install or predecessor-restoration review[\s\S]*rotated fresh `scan-completed` challenge/,
  );
  assert.match(
    architectureProse,
    /never initiates a downgrade or fallback reinstall[\s\S]*failed or unparseable availability probe is `unknown`/,
  );
  assert.match(
    architectureProse,
    /A launched operation[\s\S]*transaction reports manual recovery and performs no package mutation/,
  );
  assert.match(
    architectureProse,
    /Future managed-fleet automation must own and journal a supported PackageInstaller session identifier/,
  );
  assert.match(architectureProse, /inspect a fresh display-0 image before input/);
  assert.match(architectureProse, /Completing an offered scan without a harmful verdict is not proof that installation finished/);
  assert.match(architectureProse, /Refusal or inability to complete an offered scan/);
  assert.match(
    architectureProse,
    /successful package status and publish the target APK before[\s\S]*foreground review/,
  );
  assert.match(
    architectureProse,
    /status-zero package command and automated foreground disappearance never authorize roles, runtime activation, or release commit/,
  );
  assert.match(installer, /play_protect_scan=required_when_offered bypass=prohibited/);
  assert.match(installer, /App scan recommended.*choose Scan/);
  assert.match(installer, /never choose an install-without-scanning option or suppress verification/);
  assert.match(installer, /reconcile_successful_android_install_foreground/);
  assert.match(installer, /android_install_foreground_state_once/);
  assert.doesNotMatch(
    installer,
    /apk_rollback_retry_pending|cmd package install[^\n]*\s-d(?:\s|")|install_apk "\$APK_BACKUP" fallback/,
  );
  for (const scriptPath of installSecurityScriptPaths) {
    const script = fs.readFileSync(scriptPath, 'utf8');
    assert.doesNotMatch(
      script,
      /package_verifier_enable|verifier_verify_adb_installs|verify_apps_over_usb|pm\s+disable(?:-user)?\s+(?:com[.]android[.]vending|com[.]google[.]android[.]gms)/,
      `${scriptPath} must not disable Android install verification`,
    );
  }
});

test('scan guidance precedes package launch and remains visible during attestation', () => {
  const installStart = installer.indexOf('\ninstall_apk() {');
  const installEnd = installer.indexOf(
    '\nwait_for_package_manager_idle() {',
    installStart,
  );
  assert.notEqual(installStart, -1);
  assert.notEqual(installEnd, -1);
  const installBody = installer.slice(installStart, installEnd);
  const prelaunchGuidance = installBody.indexOf(
    'announce_android_install_security_policy',
  );
  const durableLaunchFence = installBody.indexOf(
    'PACKAGE_OPERATION_STATE=launched',
  );
  const packageCommand = installBody.indexOf('rish_command \\\n');
  assert.notEqual(prelaunchGuidance, -1);
  assert.notEqual(durableLaunchFence, -1);
  assert.notEqual(packageCommand, -1);
  assert.ok(prelaunchGuidance < durableLaunchFence);
  assert.ok(prelaunchGuidance < packageCommand);

  const reviewStart = installer.indexOf(
    '\npersist_and_wait_android_install_review() {',
  );
  const reviewEnd = installer.indexOf(
    '\nreconcile_android_install_user_action() {',
    reviewStart,
  );
  assert.notEqual(reviewStart, -1);
  assert.notEqual(reviewEnd, -1);
  const reviewBody = installer.slice(reviewStart, reviewEnd);
  const reviewGuidance = reviewBody.indexOf(
    'announce_android_install_security_policy "$context"',
  );
  const attestationInstructions = reviewBody.indexOf(
    'announce_android_install_review_attestation',
  );
  assert.notEqual(reviewGuidance, -1);
  assert.notEqual(attestationInstructions, -1);
  assert.ok(reviewGuidance < attestationInstructions);
});

test('nontechnical bulk installation is a supported managed channel, not a sideload loop', () => {
  const contract = contractByKey('phone-install-managed-fleet');
  assert.ok(contract);
  assert.equal(contract.status, 'law');
  assert.match(contract.statement, /supported managed provisioning/);
  assert.match(contract.statement, /separate private state per device/);
  assert.match(contract.statement, /Android security boundaries remain explicit/);

  assert.match(architectureProse, /verified private or public managed app/);
  assert.match(architectureProse, /A personally owned device must not be silently converted into a fully managed device/);
  assert.match(architectureProse, /must fit its current permissible-use rules/);
  assert.match(architectureProse, /Repeating ADB sideloads|installed with ADB/);
  assert.match(architectureProse, /roadmap/i);
});

test('public intent remembers the two channels and foreground scan failure class', () => {
  const pivot = backlog.find(
    (entry) => entry.key === 'phone-installation-two-channel-product',
  );
  assert.ok(pivot);
  assert.equal(pivot.privacy_scope, 'product-wide');
  assert.equal(pivot.status, 'active');

  const foregroundGate = failureModes.find(
    (entry) => entry.class === 'user-action-required',
  );
  assert.ok(foregroundGate);
  assert.equal(foregroundGate.phoneRelevant, true);
  assert.match(foregroundGate.mode, /Android or Play Protect/);
  assert.match(foregroundGate.selfHeal, /require the scan path/);
  assert.match(foregroundGate.selfHeal, /prohibit install-without-scanning or suppression/);
  assert.match(foregroundGate.selfHeal, /fails closed/);
});
