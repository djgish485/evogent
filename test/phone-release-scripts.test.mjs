import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const dependencyStateHelper = path.join(
  root,
  'phone-paradigm/device/dependency-tree-state.py',
);
const rollbackStateHelper = path.join(
  root,
  'phone-paradigm/device/rollback-state.py',
);
const androidVersionAllocator = path.join(
  root,
  'scripts/allocate-android-version-code.py',
);
const scripts = [
  'scripts/build-phone-release.sh',
  'scripts/deploy-phone-release.sh',
  'phone-paradigm/device/install-release.sh',
  'phone-paradigm/device/start-prod.sh',
  'phone-paradigm/device/restart-evo.sh',
  'phone-paradigm/device/phone-tools/deploy-next.sh',
  'phone-paradigm/device/phone-tools/evo-curl',
  'phone-paradigm/device/phone-tools/evo-health',
  'phone-paradigm/device/home/deploy-next.sh',
  'phone-paradigm/device/phone-tools/evogent-boot.sh',
  'phone-paradigm/device/phone-tools/evogent-scheduler.sh',
  'phone-paradigm/device/phone-tools/evogent-watchdog.sh',
  'phone-paradigm/device/phone-tools/benchmark-curation.sh',
];

function shellFunction(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  assert.notEqual(start, -1, `missing shell function ${name}`);
  let heredoc = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (heredoc !== null) {
      if (line === heredoc) heredoc = null;
      continue;
    }
    const heredocMatch = line.match(/<<-?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (heredocMatch) {
      heredoc = heredocMatch[1];
      continue;
    }
    if (line === '}') return lines.slice(start, index + 1).join('\n');
  }
  assert.fail(`unterminated shell function ${name}`);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      signal: child.signalCode,
      status: child.exitCode,
      stderr: '',
      stdout: '',
    });
  }
  return new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({
      signal,
      status,
      stderr,
      stdout,
    }));
  });
}

function createReleaseBuilderFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-release-fixture-'));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.copyFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    path.join(fixture, 'scripts/build-phone-release.sh'),
  );
  fs.writeFileSync(path.join(fixture, 'tracked.txt'), 'committed\n');
  execFileSync('git', ['init', '-q'], { cwd: fixture });
  execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: fixture });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: fixture });
  execFileSync('git', ['add', '.'], { cwd: fixture });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: fixture });
  return fixture;
}

test('phone release shell entrypoints parse', () => {
  execFileSync('bash', ['-n', ...scripts], { cwd: root, stdio: 'pipe' });
});

test('Android releases use one external signer across v1, v2, and v3', () => {
  const androidBuild = fs.readFileSync(
    path.join(root, 'android-shell/build.sh'),
    'utf8',
  );
  const releaseBuild = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );

  assert.match(androidBuild, /BTN="\$SDK\/build-tools\/36\.1\.0"/);
  assert.match(androidBuild, /EVOGENT_ANDROID_VERSION_CODE:-3/);
  assert.match(androidBuild, /--version-code "\$ANDROID_VERSION_CODE"/);
  assert.match(androidBuild, /--replace-version/);
  assert.match(androidBuild, /versionCode='\$ANDROID_VERSION_CODE'/);
  assert.match(androidBuild, /EVOGENT_ANDROID_KEYSTORE is required/);
  assert.match(androidBuild, /Android keystore must live outside the source checkout/);
  assert.match(androidBuild, /Android keystore must not be a symlink/);
  assert.match(androidBuild, /Android keystore must not be accessible to group or other users/);
  assert.match(androidBuild, /EVOGENT_ANDROID_KEYSTORE_PASSWORD is required/);
  assert.match(androidBuild, /--v1-signing-enabled true/);
  assert.match(androidBuild, /--min-sdk-version 23/);
  assert.match(androidBuild, /Verified using v1 scheme \(JAR signing\): true/);
  assert.match(
    androidBuild,
    /Verified using v2 scheme \(APK Signature Scheme v2\): true/,
  );
  assert.match(
    androidBuild,
    /Verified using v3 scheme \(APK Signature Scheme v3\): true/,
  );
  assert.match(androidBuild, /Number of signers: 1/);
  assert.doesNotMatch(androidBuild, /DEFAULT_ANDROID_KEYSTORE|evogent-dev/);
  assert.doesNotMatch(
    androidBuild,
    /SIGNING_LINEAGE|COMPAT_KEYSTORE|--lineage|--next-signer|--rotation-min-sdk-version/,
  );

  assert.match(releaseBuild, /APK_SIGNER_SHA256=/);
  assert.match(releaseBuild, /allocate-android-version-code\.py/);
  assert.match(releaseBuild, /EVOGENT_ANDROID_VERSION_CODE="\$ANDROID_VERSION_CODE"/);
  assert.match(releaseBuild, /"signerSha256": "\$APK_SIGNER_SHA256"\.lower\(\)/);
  assert.match(releaseBuild, /phone-paradigm\/device\/rollback-state\.py/);
  assert.match(releaseBuild, /"device\/rollback-state\.py"/);
  assert.doesNotMatch(releaseBuild, /currentSignerSha256|COMPAT_SIGNER/);
  assert.match(installer, /EXPECTED_APK_SIGNER="\$\(read_manifest android\.signerSha256\)"/);
  assert.doesNotMatch(installer, /currentSignerSha256|EXPECTED_CURRENT_APK_SIGNER/);
});

test('Android version allocation is monotonic, bounded, and overrideable', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-android-version-'));
  const state = path.join(fixture, 'state', 'version');
  const forbidden = path.join(fixture, 'source');
  fs.mkdirSync(forbidden);
  const allocate = (args = []) => spawnSync(
    'python3',
    [
      androidVersionAllocator,
      '--state-file',
      state,
      '--forbid-root',
      forbidden,
      ...args,
    ],
    { encoding: 'utf8' },
  );

  let result = allocate(['--now', '1800000000']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1800000000');
  result = allocate(['--now', '1800000000']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1800000001');
  result = allocate(['--now', '1799999999']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1800000002');
  result = allocate(['--now', '1800000000', '--override', '1800000100']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1800000100');
  assert.equal(fs.statSync(state).mode & 0o777, 0o600);

  for (const invalid of ['0', '-1', 'not-a-version', '2147483648', '1800000100']) {
    result = allocate(['--now', '1800000000', '--override', invalid]);
    assert.notEqual(result.status, 0);
  }

  result = spawnSync('python3', [
    androidVersionAllocator,
    '--state-file',
    path.join(forbidden, 'version'),
    '--forbid-root',
    forbidden,
    '--now',
    '1800000000',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the source checkout/);
});

test('standalone Android version overrides fail closed before signing', () => {
  for (const invalid of ['0', '-1', 'abc', '2147483648']) {
    const result = spawnSync('bash', ['android-shell/build.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EVOGENT_ANDROID_VERSION_CODE: invalid },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EVOGENT_ANDROID_VERSION_CODE must be an integer/);
  }
  const accepted = spawnSync('bash', ['android-shell/build.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      EVOGENT_ANDROID_VERSION_CODE: '1800000101',
      EVOGENT_ANDROID_KEYSTORE: '',
    },
  });
  assert.equal(accepted.status, 1);
  assert.match(accepted.stderr, /EVOGENT_ANDROID_KEYSTORE is required/);
  assert.doesNotMatch(accepted.stderr, /EVOGENT_ANDROID_VERSION_CODE must be an integer/);
});

test('release builder refuses a dirty Git source before running a build', () => {
  const fixture = createReleaseBuilderFixture();
  fs.writeFileSync(path.join(fixture, 'tracked.txt'), 'dirty\n');

  const result = spawnSync('bash', ['scripts/build-phone-release.sh'], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.equal(result.status, 65);
  assert.match(result.stderr, /refusing to build from a dirty source tree/);
});

test('release output rejects direct and symlink-resolved checkout descendants before building', () => {
  const fixture = createReleaseBuilderFixture();
  const outside = path.dirname(fixture);
  const alias = path.join(outside, `${path.basename(fixture)}-alias`);
  fs.symlinkSync(fixture, alias, 'dir');
  for (const output of [
    fixture,
    path.join(fixture, 'private-release-output'),
    path.join(alias, 'private-release-output'),
  ]) {
    const result = spawnSync('bash', ['scripts/build-phone-release.sh', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.equal(result.status, 65);
    assert.match(result.stderr, /must resolve outside the source checkout/);
    assert.equal(fs.existsSync(path.join(fixture, 'private-release-output')), false);
  }
});

test('checkout build lock serializes concurrent host builds', async () => {
  const source = fs.readFileSync(path.join(root, 'scripts/build-phone-release.sh'), 'utf8');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-build-lock-'));
  const lock = path.join(fixture, 'checkout.lock');
  const trace = path.join(fixture, 'trace');
  const harness = `
set -euo pipefail
${shellFunction(source, 'acquire_build_lock')}
${shellFunction(source, 'release_build_lock')}
BUILD_LOCK="$1"
BUILD_LOCK_WAIT_SECONDS=10
BUILD_LOCK_HELD=0
trap release_build_lock EXIT
acquire_build_lock
printf 'acquired-%s\\n' "$2" >> "$3"
sleep "$4"
printf 'released-%s\\n' "$2" >> "$3"
release_build_lock
  `;
  const first = spawn('bash', ['-c', harness, 'harness', lock, 'first', trace, '0.2']);
  const firstExitPromise = waitForExit(first);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(trace) && fs.readFileSync(trace, 'utf8').includes('acquired-first')) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const second = spawn('bash', ['-c', harness, 'harness', lock, 'second', trace, '0']);
  const secondExitPromise = waitForExit(second);
  const [firstExit, secondExit] = await Promise.all([firstExitPromise, secondExitPromise]);
  assert.equal(firstExit.status, 0, firstExit.stderr);
  assert.equal(secondExit.status, 0, secondExit.stderr);
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), [
    'acquired-first',
    'released-first',
    'acquired-second',
    'released-second',
  ]);
});

test('installer contract is complete and process-scoped', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  assert.match(installer, /EXPECTED_ARCHIVE_SHA256/);
  assert.match(installer, /sha256sum -c files\.sha256/);
  assert.match(installer, /release-install-cycle-gate/);
  assert.match(installer, /atomic_link "releases\/\$RELEASE_ID" "\$CURRENT"/);
  assert.match(installer, /backup_database/);
  assert.match(installer, /backup_installed_apk/);
  assert.match(installer, /rollback_release/);
  assert.match(installer, /cmd package install -r --enable-rollback/);
  assert.match(installer, /cmd package rollback-app/);
  assert.match(installer, /package_manager_supports_apk_rollback/);
  assert.match(installer, /Argument expected after "rollback-app"/);
  assert.match(installer, /EXPECTED_APK_SIGNER/);
  assert.match(installer, /EXPECTED_APK_SHA256/);
  assert.match(installer, /APK_INSTALL_ATTEMPTED/);
  assert.match(installer, /changed APK requires a strictly higher Android version code/);
  assert.match(installer, /wait_for_apk_rollback_availability/);
  assert.match(installer, /dumpsys rollback/);
  assert.match(installer, /Android did not make the exact APK rollback available/);
  assert.match(installer, /ROLLBACK_STATE_HELPER=.*device\/rollback-state\.py/);
  assert.match(installer, /prepare_android_dependency_tree/);
  assert.match(installer, /state\/dependencies\/\$EXPECTED_PACKAGE_LOCK\/node_modules/);
  assert.match(installer, /npm ci --ignore-scripts --omit=dev --omit=optional/);
  assert.match(installer, /GYP_DEFINES="android_ndk_path=\$PREFIX"/);
  assert.match(installer, /verify_android_dependency_tree/);
  assert.match(installer, /dependency-tree-state\.py/);
  assert.match(installer, /candidate-add/);
  assert.match(installer, /candidate-clear/);
  assert.match(installer, /reclaim-legacy/);
  assert.match(installer, /installed release inventory metadata mismatch/);
  assert.match(installer, /running\["releaseFormat"\]/);
  assert.match(installer, /api\/internal\/phone-health/);
  assert.match(installer, /api\/internal\/deployment-status/);
  assert.match(installer, /verify_release_tls_material/);
  assert.match(installer, /verify_phone_tls_listener/);
  assert.match(installer, /certificateDerSha256/);
  assert.match(installer, /tls\/server-key\.pem/);
  assert.match(installer, /relative == "tls\/server-key\.pem"[\s\S]*0o600/);
  assert.match(installer, /phone_ports_open/);
  assert.match(installer, /write_transaction_journal prepared/);
  assert.match(installer, /recover_interrupted_transaction/);
  assert.match(
    installer,
    /atomic_link\(\)[\s\S]*os\.replace\(temporary, link\)[\s\S]*os\.fsync\(directory\)/,
  );
  assert.match(
    installer,
    /backup_apk_for_rollback\(\)[\s\S]*fsync_regular_file_and_parent "\$output"[\s\S]*APK_BACKUP_READY=1/,
  );
  assert.match(
    installer,
    /prepare_transaction_recoverer\(\)[\s\S]*fsync_regular_file_and_parent "\$TRANSACTION_RECOVERER"/,
  );
  assert.match(installer, /sync_control_token_from_apk/);
  assert.match(installer, /restore_control_token/);
  assert.match(installer, /rish_command "cat '\$APP_CONTROL_TOKEN_PATH'" 2>\/dev\/null\s+\\\n\s+\| python3 "\$writer" "\$CONTROL_TOKEN"/);
  assert.doesNotMatch(installer, /\bpkill\b|\bkillall\b|tmux kill-server/);

  const bootReceiver = fs.readFileSync(
    path.join(
      root,
      'android-shell/src/net/dangish/evogent/BootReceiver.java',
    ),
    'utf8',
  );
  assert.match(bootReceiver, /install-transaction\/journal\.json/);
  assert.match(bootReceiver, /--recover/);
  assert.match(
    installer,
    /write_transaction_journal apk_install_pending\s+install_apk[\s\S]*# Initial migration preserves/,
  );
  const versionGate = installer.indexOf(
    'changed APK requires a strictly higher Android version code',
  );
  const cycleGate = installer.indexOf(
    'acquire_lock_dir "$CYCLE_GATE" release-install-cycle-gate',
  );
  const apkInstall = installer.indexOf(
    'install_apk "$NEW_RELEASE/apk/evogent.apk" upgrade',
  );
  const rollbackAvailabilityGate = installer.indexOf(
    'wait_for_apk_rollback_availability',
    apkInstall,
  );
  const runtimeMigration = installer.indexOf(
    '# Initial migration preserves',
    rollbackAvailabilityGate,
  );
  assert.ok(versionGate !== -1 && versionGate < cycleGate);
  assert.ok(
    apkInstall !== -1
      && apkInstall < rollbackAvailabilityGate
      && rollbackAvailabilityGate < runtimeMigration,
  );
});

test('transaction intent is durable before quiesce and backup readiness is explicit', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const journalIntent = installer.indexOf('write_transaction_journal quiesce_pending');
  const cycleGate = installer.indexOf(
    'acquire_lock_dir "$CYCLE_GATE" release-install-cycle-gate',
    journalIntent,
  );
  const mutationIntent = installer.indexOf('CONTROL_PLANE_MUTATION_STARTED=1', cycleGate);
  const quiesce = installer.indexOf('quiesce_control_plane', mutationIntent);
  const databaseBackup = installer.indexOf('backup_database "$HOME/evogent/data/media-agent.db"');
  const prepared = installer.indexOf('write_transaction_journal prepared', databaseBackup);
  assert.ok(journalIntent !== -1 && journalIntent < cycleGate);
  assert.ok(cycleGate < mutationIntent && mutationIntent < quiesce);
  assert.ok(quiesce < databaseBackup && databaseBackup < prepared);
  for (const field of [
    'dbBackupReady',
    'apkBackupReady',
    'controlTokenBackupReady',
    'switchStarted',
  ]) {
    assert.match(installer, new RegExp(`"${field}"`));
  }
  assert.match(
    installer,
    /rollback_initial_migration\(\) \{\s+\[ "\$INITIAL_MIGRATION" = 1 \] && \[ "\$MIGRATION_STARTED" = 1 \]/,
  );

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-journal-writer-'));
  const journal = path.join(fixture, 'journal.json');
  const harness = `
set -euo pipefail
${shellFunction(installer, 'write_transaction_journal')}
TRANSACTION_JOURNAL="$1"
ROOT="$2"
RELEASE_ID=release-1
NEW_RELEASE="$2/releases/release-1"
PREVIOUS_TARGET="$2/releases/release-0"
BACKUP_DIR="$2/backups/backup-1"
DB_BACKUP="$2/backups/backup-1/database.db"
DB_BACKUP_READY=0
APK_BACKUP="$2/backups/backup-1/app.apk"
APK_BACKUP_READY=1
APK_CHANGED=1
APK_INSTALL_ATTEMPTED=0
PREVIOUS_APK_CODE=7
PREVIOUS_APK_SIGNER=signer
INITIAL_MIGRATION=0
MIGRATION_STARTED=0
SWITCH_STARTED=0
MIGRATION_DIR="$2/migrations/migration-1"
CYCLE_GATE="$2/state/phone-tools/.cycle.lock"
CONTROL_TOKEN="$2/state/data/control-token.txt"
CONTROL_TOKEN_BACKUP="$2/backups/backup-1/control-token.txt"
CONTROL_TOKEN_EXISTED=1
CONTROL_TOKEN_BACKUP_READY=1
TRANSACTION_JOURNAL_WRITTEN=0
write_transaction_journal quiesce_pending
`;
  const writer = spawnSync('bash', ['-c', harness, 'journal', journal, fixture], {
    encoding: 'utf8',
  });
  assert.equal(writer.status, 0, writer.stderr);
  const payload = JSON.parse(fs.readFileSync(journal, 'utf8'));
  assert.equal(payload.dbBackupReady, 0);
  assert.equal(payload.apkBackupReady, 1);
  assert.equal(payload.controlTokenBackupReady, 1);
  assert.equal(payload.switchStarted, 0);
});

test('partial database backup is never restored without durable readiness proof', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-db-rollback-'));
  const target = path.join(fixture, 'database.db');
  const partial = path.join(fixture, 'partial.db');
  fs.writeFileSync(target, 'original database bytes');
  fs.writeFileSync(partial, 'partial backup bytes', { mode: 0o600 });
  const harness = `
set -euo pipefail
${shellFunction(installer, 'restore_database')}
say() { :; }
fsync_regular_file_and_parent() { :; }
STATE="$1"
DB_BACKUP="$2"
DB_BACKUP_READY="$3"
restore_database "$4"
`;
  let result = spawnSync(
    'bash',
    ['-c', harness, 'harness', fixture, partial, '0', target],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original database bytes');

  result = spawnSync(
    'bash',
    ['-c', harness, 'harness', fixture, path.join(fixture, 'missing.db'), '1', target],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original database bytes');
});

test('rollback fails closed before mutation and rearms only an untouched prior phase', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const rollback = shellFunction(installer, 'rollback_release');
  const harness = `
set -uo pipefail
${rollback}
say() { :; }
quiesce_control_plane() { return "$QUIESCE_RESULT"; }
stop_and_prove_runtime() { return "$STOP_RESULT"; }
record() { printf '%s\\n' "$1" >> "$TRACE"; }
rollback_phone_dispatch_changes() { record dispatch; }
atomic_link() { record pointer; }
restore_database() { record database; }
rollback_apk_native() { record apk; }
restore_control_token() { record token; }
rollback_initial_migration() { record migration; }
rish_command() { record rish; }
bash() { record boot; }
set +e
if rollback_release; then rc=0; else rc=$?; fi
printf 'rc=%s failed=%s rearm=%s\\n' "$rc" "$ROLLBACK_FAILED" "$REARM_PRIOR_CONTROL_PLANE"
`;
  for (const scenario of [
    { switchStarted: '0', migrationStarted: '0', apkAttempted: '0', rearm: '1' },
    { switchStarted: '1', migrationStarted: '0', apkAttempted: '0', rearm: '0' },
    { switchStarted: '0', migrationStarted: '0', apkAttempted: '1', rearm: '0' },
  ]) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-rollback-proof-'));
    const trace = path.join(fixture, 'trace');
    const result = spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APK_INSTALL_ATTEMPTED: scenario.apkAttempted,
        INITIAL_MIGRATION: '0',
        MIGRATION_STARTED: scenario.migrationStarted,
        QUIESCE_RESULT: '1',
        REARM_PRIOR_CONTROL_PLANE: '0',
        ROLLBACK_ATTEMPTED: '0',
        ROLLBACK_FAILED: '0',
        STOP_RESULT: '0',
        SWITCH_STARTED: scenario.switchStarted,
        TRACE: trace,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`rc=1 failed=1 rearm=${scenario.rearm}`));
    assert.equal(fs.existsSync(trace), false);
  }
  assert.match(
    installer,
    /rollback_release\(\)[\s\S]*if ! stop_and_prove_runtime; then[\s\S]*return 1/,
  );
  const releaseInstallLock = installer.indexOf(
    '[ "$INSTALL_LOCK_HELD" = 1 ] && release_lock_dir "$INSTALL_LOCK"',
  );
  const rearm = installer.indexOf('if [ "$REARM_PRIOR_CONTROL_PLANE" = 1 ]', releaseInstallLock);
  assert.ok(releaseInstallLock !== -1 && releaseInstallLock < rearm);
});

test('runtime shutdown proof rejects detached listeners after tmux disappears', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'stop_and_prove_runtime');
  const harness = `
set -uo pipefail
${helper}
stop_tmux_session() { return 0; }
say() { :; }
sleep() { :; }
PORT_CALLS=0
phone_ports_open() { PORT_CALLS=$((PORT_CALLS + 1)); return "$PORT_RESULT"; }
if stop_and_prove_runtime; then rc=0; else rc=$?; fi
printf 'rc=%s calls=%s\\n' "$rc" "$PORT_CALLS"
`;
  let result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, PORT_RESULT: '0' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /rc=1 calls=20/);
  result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, PORT_RESULT: '1' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /rc=0 calls=1/);
});

test('a waiter rechecks and recovers a durable journal after the owner is SIGKILLed', async () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-install-sigkill-'));
  const lock = path.join(fixture, 'install.lock');
  const journal = path.join(fixture, 'journal.json');
  const recoverer = path.join(fixture, 'recover.sh');
  const recovered = path.join(fixture, 'recovered');
  const ready = path.join(fixture, 'owner-ready');
  fs.writeFileSync(
    recoverer,
    '#!/bin/bash\nrm -f -- "$2"\ntouch "$RECOVERED_MARKER"\n',
    { mode: 0o700 },
  );
  const owner = spawn('bash', ['-c', `
set -e
mkdir "$1"
printf 'pid=%s\\n' "$$" > "$1/owner"
printf '{"phase":"quiesce_pending"}\\n' > "$2"
touch "$3"
while :; do sleep 1; done
`, 'owner', lock, journal, ready]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(ready)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(ready), true);

  const helper = shellFunction(
    installer,
    'acquire_install_lock_and_recover_prior_transactions',
  );
  const waiterHarness = `
set -euo pipefail
acquire_lock_dir() {
  while ! mkdir "$1" 2>/dev/null; do
    owner="$(sed -n 's/^pid=//p' "$1/owner" 2>/dev/null | head -1)"
    if ! kill -0 "$owner" 2>/dev/null; then rm -rf -- "$1"; fi
    sleep 0.02
  done
  printf 'pid=%s\\n' "$$" > "$1/owner"
}
release_lock_dir() { rm -rf -- "$1"; }
stat() { printf '700\\n'; }
say() { :; }
${helper}
INSTALL_LOCK="$1"
TRANSACTION_JOURNAL="$2"
TRANSACTION_RECOVERER="$3"
INSTALL_LOCK_HELD=0
acquire_install_lock_and_recover_prior_transactions
test ! -e "$TRANSACTION_JOURNAL"
test -e "$RECOVERED_MARKER"
release_lock_dir "$INSTALL_LOCK"
`;
  const waiter = spawn(
    'bash',
    ['-c', waiterHarness, 'waiter', lock, journal, recoverer],
    { env: { ...process.env, RECOVERED_MARKER: recovered } },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  owner.kill('SIGKILL');
  const [ownerExit, waiterExit] = await Promise.all([
    waitForExit(owner),
    waitForExit(waiter),
  ]);
  assert.equal(ownerExit.signal, 'SIGKILL');
  assert.equal(waiterExit.status, 0);
  assert.equal(fs.existsSync(recovered), true);
});

function checkRollbackDump(dump, installed = '8', backup = '7') {
  return spawnSync(
    'python3',
    [rollbackStateHelper, 'check', 'com.example.evogent', installed, backup],
    { encoding: 'utf8', input: dump },
  );
}

test('rollback-state parser accepts only one exact available non-staged transition', () => {
  const available = `
Rollback manager state:
  12345:
    -state: available
    -stateDescription:
    -timestamp: 2030-01-01T00:00:00Z
    -isStaged: false
    -originalSessionId: 42
    -packages:
      com.example.evogent 8 -> 7 [0]
`;
  assert.equal(checkRollbackDump(available).status, 0);

  const legacyAvailable = `
  54321:
    -state: available
    -packages:
      com.example.evogent 8 -> 7
`;
  assert.equal(checkRollbackDump(legacyAvailable).status, 0);

  for (const rejected of [
    '',
    available.replace('-state: available', '-state: committed'),
    available.replace('com.example.evogent', 'com.example.other'),
    available.replace('8 -> 7', '9 -> 7'),
    available.replace('8 -> 7', '8 -> 6'),
    available.replace('-isStaged: false', '-isStaged: true'),
    available.replace('-isStaged: false', '-isStaged: unknown'),
    legacyAvailable.replace('-packages:', '-stagedSessionId: 91\n    -packages:'),
    available.replace(
      'com.example.evogent 8 -> 7 [0]',
      'com.example.evogent 8 -> 7 [0]\n      malformed package row',
    ),
    available.replace(
      'com.example.evogent 8 -> 7 [0]',
      'com.example.evogent 8 -> 7 [0]\n      com.example.other 4 -> 3 [0]',
    ),
  ]) {
    assert.equal(checkRollbackDump(rejected).status, 1);
  }
});

function createDependencyTree(parent, name = 'tree') {
  const tree = path.join(parent, name);
  const packageLock = '{"lockfileVersion":3,"name":"fixture","packages":{}}\n';
  const lock = crypto.createHash('sha256').update(packageLock).digest('hex');
  fs.mkdirSync(path.join(tree, 'node_modules/pkg/bin'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(tree, 'package-lock.json'), packageLock);
  fs.writeFileSync(path.join(tree, '.evogent-package-lock.sha256'), `${lock}\n`);
  fs.writeFileSync(path.join(tree, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  const executable = path.join(tree, 'node_modules/pkg/bin/tool');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('../pkg/bin/tool', path.join(tree, 'node_modules/.bin/tool'));
  return { executable, lock, tree };
}

function runDependencyHelper(args, options = {}) {
  return spawnSync('python3', [dependencyStateHelper, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

test('dependency trees receive a deterministic full inventory and become read-only', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-dependency-inventory-'));
  const first = createDependencyTree(fixture, 'first');
  const second = createDependencyTree(fixture, 'second');

  for (const dependency of [first, second]) {
    const sealed = runDependencyHelper(['seal', dependency.tree, dependency.lock]);
    assert.equal(sealed.status, 0, sealed.stderr);
    const verified = runDependencyHelper(['verify', dependency.tree, dependency.lock]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(fs.statSync(dependency.tree).mode & 0o222, 0);
    assert.equal(fs.statSync(dependency.executable).mode & 0o222, 0);
    assert.notEqual(fs.statSync(dependency.executable).mode & 0o111, 0);
  }

  const inventoryName = '.evogent-dependency-inventory.json';
  assert.equal(
    fs.readFileSync(path.join(first.tree, inventoryName), 'utf8'),
    fs.readFileSync(path.join(second.tree, inventoryName), 'utf8'),
  );

  fs.chmodSync(first.executable, 0o444);
  const changedModeResult = runDependencyHelper(['verify', first.tree, first.lock]);
  assert.notEqual(changedModeResult.status, 0);
  assert.match(changedModeResult.stderr, /differs from its deterministic inventory/);
  fs.chmodSync(first.executable, 0o555);
  assert.equal(runDependencyHelper(['verify', first.tree, first.lock]).status, 0);

  const changedFile = path.join(first.tree, 'node_modules/pkg/index.js');
  fs.chmodSync(changedFile, 0o600);
  fs.writeFileSync(changedFile, 'module.exports = 2;\n');
  const changedFileResult = runDependencyHelper(['verify', first.tree, first.lock]);
  assert.notEqual(changedFileResult.status, 0);
  assert.match(changedFileResult.stderr, /differs from its deterministic inventory/);

  const binDirectory = path.join(second.tree, 'node_modules/.bin');
  const changedLink = path.join(binDirectory, 'tool');
  fs.chmodSync(binDirectory, 0o700);
  fs.unlinkSync(changedLink);
  fs.symlinkSync('../pkg/index.js', changedLink);
  const changedLinkResult = runDependencyHelper(['verify', second.tree, second.lock]);
  assert.notEqual(changedLinkResult.status, 0);
  assert.match(changedLinkResult.stderr, /differs from its deterministic inventory/);
});

test('invalid dependency targets are atomically exchanged into quarantine', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-dependency-publish-'));
  const dependencies = path.join(fixture, 'dependencies');
  const builds = path.join(fixture, 'dependency-builds');
  const quarantine = path.join(fixture, 'dependency-quarantine');
  fs.mkdirSync(dependencies);
  fs.mkdirSync(builds);
  fs.mkdirSync(quarantine);
  const build = createDependencyTree(builds, 'temporary-build');
  const safeBuildPath = path.join(builds, `${build.lock}.fixture123`);
  fs.renameSync(build.tree, safeBuildPath);
  build.tree = safeBuildPath;
  assert.equal(runDependencyHelper(['seal', build.tree, build.lock]).status, 0);

  const target = path.join(dependencies, build.lock);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'invalid-sentinel'), 'old tree\n');
  const published = runDependencyHelper([
    'publish',
    build.tree,
    target,
    quarantine,
    build.lock,
  ]);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(runDependencyHelper(['verify', target, build.lock]).status, 0);
  assert.equal(fs.existsSync(build.tree), false);
  const quarantined = fs.readdirSync(quarantine);
  assert.equal(quarantined.length, 1);
  assert.equal(
    fs.readFileSync(path.join(quarantine, quarantined[0], 'invalid-sentinel'), 'utf8'),
    'old tree\n',
  );
});

function createReleaseStateFixture() {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-state-prune-'));
  for (const relative of [
    'releases',
    'state/dependencies',
    'state/dependency-builds',
    'state/dependency-quarantine',
    'state/release-candidates',
    'state/next-cache',
    'backups',
    'install-transaction',
  ]) {
    fs.mkdirSync(path.join(rootDirectory, relative), { recursive: true });
  }
  return rootDirectory;
}

test('stale builds and failed candidates are pruned without crossing transaction boundaries', () => {
  const stateRoot = createReleaseStateFixture();
  const lock = 'a'.repeat(64);
  const staleBuild = path.join(stateRoot, 'state/dependency-builds', `${lock}.stale123`);
  fs.mkdirSync(staleBuild);
  fs.writeFileSync(path.join(staleBuild, 'partial'), 'partial\n');
  const interruptedPublish = path.join(
    stateRoot,
    'state/dependencies',
    `.incoming-${lock}.publish123`,
  );
  fs.mkdirSync(interruptedPublish);
  fs.writeFileSync(path.join(interruptedPublish, 'partial'), 'partial\n');
  fs.chmodSync(path.join(interruptedPublish, 'partial'), 0o444);
  fs.chmodSync(interruptedPublish, 0o555);

  for (const [name, age] of [[`${lock}.10000000000.1`, 1], [`${lock}.10000000001.2`, 2]]) {
    const directory = path.join(stateRoot, 'state/dependency-quarantine', name);
    const nested = path.join(directory, 'node_modules/pkg');
    fs.mkdirSync(nested, { recursive: true });
    const oldFile = path.join(nested, 'old');
    fs.writeFileSync(oldFile, 'old\n');
    if (age === 1) {
      fs.chmodSync(oldFile, 0o444);
      fs.chmodSync(nested, 0o555);
      fs.chmodSync(path.dirname(nested), 0o555);
      fs.chmodSync(directory, 0o555);
    }
    fs.utimesSync(directory, age, age);
  }

  const releaseId = 'failed-release';
  const failedRelease = path.join(stateRoot, 'releases', releaseId);
  fs.mkdirSync(failedRelease);
  fs.writeFileSync(path.join(failedRelease, 'candidate'), 'candidate\n');
  fs.chmodSync(failedRelease, 0o555);
  fs.writeFileSync(
    path.join(stateRoot, 'state/release-candidates', releaseId),
    `${releaseId}\n`,
  );
  fs.writeFileSync(path.join(stateRoot, 'install-transaction/journal.json'), '{}\n');

  let pruned = runDependencyHelper(['prune', stateRoot, '--keep-quarantines', '1']);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(fs.existsSync(staleBuild), false);
  assert.equal(fs.existsSync(interruptedPublish), false);
  assert.equal(fs.existsSync(failedRelease), true);
  assert.equal(fs.readdirSync(path.join(stateRoot, 'state/dependency-quarantine')).length, 1);

  fs.unlinkSync(path.join(stateRoot, 'install-transaction/journal.json'));
  pruned = runDependencyHelper(['prune', stateRoot, '--keep-quarantines', '1']);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(fs.existsSync(failedRelease), false);
  assert.equal(
    fs.existsSync(path.join(stateRoot, 'state/release-candidates', releaseId)),
    false,
  );
});

test('legacy node_modules is reclaimed only once a versioned release is current', () => {
  const stateRoot = createReleaseStateFixture();
  const legacy = path.join(stateRoot, 'state/node_modules');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'legacy-package'), 'rollback dependency\n');

  let pruned = runDependencyHelper(['prune', stateRoot]);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(fs.existsSync(legacy), true);

  const releaseId = 'committed-release';
  const release = path.join(stateRoot, 'releases', releaseId);
  fs.mkdirSync(release);
  fs.writeFileSync(
    path.join(release, 'manifest.json'),
    JSON.stringify({
      stateLinks: {
        'runtime/node_modules': `../../../state/dependencies/${'b'.repeat(64)}/node_modules`,
      },
    }),
  );
  fs.symlinkSync(`releases/${releaseId}`, path.join(stateRoot, 'current'));
  pruned = runDependencyHelper(['prune', stateRoot]);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(fs.existsSync(legacy), false);

  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const committed = installer.indexOf(
    'clear_transaction_journal\nrelease_lock_dir "$CYCLE_GATE"',
  );
  const reclaimed = installer.indexOf('reclaim-legacy', committed);
  assert.notEqual(committed, -1);
  assert.notEqual(reclaimed, -1);
  assert.ok(committed < reclaimed);
  assert.match(
    installer,
    /rollback_initial_migration\(\)[\s\S]*mv "\$STATE\/node_modules" "\$MIGRATION_DIR\/evogent\/node_modules"/,
  );
});

test('release builder and phone runtime bind the APK to one private HTTPS listener', () => {
  const builder = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const start = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/start-prod.sh'),
    'utf8',
  );
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert.match(builder, /res\/raw\/evogent_phone_ca\.pem/);
  assert.match(builder, /openssl verify -purpose sslserver/);
  assert.match(builder, /tls\/server-cert\.pem/);
  assert.match(builder, /tls\/server-key\.pem/);
  assert.match(builder, /RELEASE_IDENTITY_DIGEST/);
  assert.match(builder, /apk-sha256:/);
  assert.match(builder, /tls-cert-der-sha256:/);
  assert.match(builder, /"phoneTls"/);
  assert.match(start, /EVOGENT_PHONE_HTTPS_PORT=3443/);
  assert.match(start, /EVOGENT_PHONE_TLS_CERT_PATH/);
  assert.match(start, /EVOGENT_PHONE_TLS_KEY_PATH/);
  assert.match(server, /createHttpsServer/);
  assert.match(server, /checkPrivateKey/);
  assert.match(server, /checkIP\('127\.0\.0\.1'\)/);
});

test('release archives and private-key transit are owner-only', () => {
  const builder = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const deploy = fs.readFileSync(
    path.join(root, 'scripts/deploy-phone-release.sh'),
    'utf8',
  );
  assert.match(builder, /set -euo pipefail\s+umask 077/);
  assert.match(builder, /tar -czf "\$ARCHIVE"[\s\S]*chmod 600 "\$ARCHIVE"/);
  assert.match(builder, /chmod 600 "\$ARCHIVE\.sha256"/);
  assert.match(deploy, /set -euo pipefail\s+umask 077/);
  assert.match(deploy, /chmod 600 "\$ARCHIVE" "\$ARCHIVE\.sha256"/);
  assert.match(deploy, /mkdir -p '\$REMOTE_DIR'; chmod 700 '\$REMOTE_DIR'/);
  assert.match(deploy, /chmod 600 '\$REMOTE_ARCHIVE'/);
});

test('fresh APK token install is atomic, private, and non-disclosing', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-token-install-'));
  const destination = path.join(fixture, 'control-token.txt');
  const writer = path.join(
    root,
    'phone-paradigm/device/write-control-token.py',
  );
  const token = '12345678-1234-4234-9234-123456789abc';
  const installed = spawnSync('python3', [writer, destination], {
    input: token,
    encoding: 'utf8',
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.readFileSync(destination, 'utf8'), token);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.doesNotMatch(installed.stdout + installed.stderr, new RegExp(token));

  const rejectedToken = 'not-a-valid-secret-value';
  const rejected = spawnSync('python3', [writer, destination], {
    input: rejectedToken,
    encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0);
  assert.equal(fs.readFileSync(destination, 'utf8'), token);
  assert.doesNotMatch(
    rejected.stdout + rejected.stderr,
    new RegExp(rejectedToken),
  );
});

test('authenticated phone HTTP client ships executable in every release', () => {
  const builder = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const clients = ['evo-curl', 'evo-health'].map((name) => path.join(
    root,
    'phone-paradigm/device/phone-tools',
    name,
  ));
  assert.match(builder, /"phone-tools\/evo-curl"/);
  assert.match(builder, /"phone-tools\/evo-health"/);
  assert.match(builder, /"phone-tools\/evo_curl_transport\.py"/);
  assert.match(builder, /"phone-tools\/evogent_api\.py"/);
  for (const clientPath of clients) {
    assert.ok(fs.statSync(clientPath).mode & 0o111);
  }
});

test('watchdog reaps abandoned scoped wake-lock owners', () => {
  const watchdog = fs.readFileSync(
    path.join(
      root,
      'phone-paradigm/device/phone-tools/evogent-watchdog.sh',
    ),
    'utf8',
  );
  const controlPlane = fs.readFileSync(
    path.join(
      root,
      'phone-paradigm/device/phone-tools/control-plane.sh',
    ),
    'utf8',
  );
  assert.match(watchdog, /while true; do[\s\S]*control_release_legacy_wake_if_idle/);
  assert.match(controlPlane, /\.evogent-held/);
  assert.match(controlPlane, /\.legacy-release-attempted/);
  assert.match(controlPlane, /mkdir -> atomic owner-file window/);
  assert.match(controlPlane, /\[ -f "\$marker" \][\s\S]*termux-wake-unlock/);
});

test('release builder strips host identity and excludes historical personal evidence', () => {
  const builder = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  assert.match(builder, /payload\["appDir"\] = "\."/);
  assert.match(builder, /EVOGENT_RELEASE_PRIVATE_MARKERS_FILE/);
  assert.match(builder, /\.intent\/contracts\.jsonl/);
  assert.match(builder, /\.intent\/failure-modes\.jsonl/);
  assert.doesNotMatch(builder, /\.intent\/backlog\.jsonl/);
  assert.doesNotMatch(builder, /\.intent\/audit-log\.jsonl/);
});

test('legacy partial deploy entrypoints fail closed', () => {
  for (const relative of [
    'phone-paradigm/device/phone-tools/deploy-next.sh',
    'phone-paradigm/device/home/deploy-next.sh',
  ]) {
    const result = spawnSync('bash', [relative], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /retired/);
  }
});
