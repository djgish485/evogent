import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const installerPath = path.join(
  root,
  'phone-paradigm/device/install-release.sh',
);
const controlPath = path.join(
  root,
  'phone-paradigm/device/phone-tools/control-plane.sh',
);

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
    const match = line.match(/<<-?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (match) {
      heredoc = match[1];
      continue;
    }
    if (line === '}') return lines.slice(start, index + 1).join('\n');
  }
  assert.fail(`unterminated shell function ${name}`);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ signal: child.signalCode, status: child.exitCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ signal, status }));
  });
}

test('installer bounds a wedged rish transport and gives package work explicit budgets', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  const helper = shellFunction(installer, 'rish_command');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-rish-bound-'));
  const rishDir = path.join(fixture, 'rish-bin');
  fs.mkdirSync(rishDir);
  fs.writeFileSync(
    path.join(rishDir, 'rish'),
    '#!/bin/sh\nprintf launched > "$RISH_TRACE"\nexec sleep 60\n',
    { mode: 0o700 },
  );
  const fakeBin = path.join(fixture, 'bin');
  const trace = path.join(fixture, 'rish-trace');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, 'setsid'),
    '#!/bin/sh\nshift 2\nexec "$@"\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(fakeBin, 'timeout'),
    '#!/bin/sh\nshift 2\nbudget="$1"; shift\n"$@" & pid=$!\n'
      + 'sleep "$budget"\nkill -TERM "$pid" 2>/dev/null\n'
      + 'wait "$pid" 2>/dev/null\nexit 124\n',
    { mode: 0o700 },
  );
  const started = Date.now();
  const result = spawnSync(
    'bash',
    ['-c', `set -u\n${helper}\nrish_command id 1`, 'rish-bound'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fixture,
        PATH: `${fakeBin}:${process.env.PATH}`,
        RISH_TRACE: trace,
      },
      timeout: 5_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'launched');
  assert.ok(Date.now() - started >= 900, 'test rish did not reach timeout');
  assert.ok(Date.now() - started < 4_000, 'wedged rish was not bounded');
  assert.match(helper, /timeout -k 5 "\$budget"/);
  assert.match(installer, /install_apk\(\)[\s\S]*\n    480 \\\n/);
  assert.match(installer, /wait_for_package_manager_idle\(\)[\s\S]*\n    300 \\\n/);
});

test('installer reaps exact dead-owner descendants and crash residues', async () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  const helper = shellFunction(
    installer,
    'reap_abandoned_control_workers_and_prove_absent',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-owner-reap-'));
  const owners = path.join(fixture, 'phone-tools/.control/owners');
  const owner = path.join(owners, 'dead-owner-token');
  fs.mkdirSync(path.join(owner, 'roots'), { recursive: true });
  fs.mkdirSync(path.join(owner, 'packages'));
  fs.writeFileSync(
    path.join(owner, 'owner'),
    'owner=dead-owner-token\npid=999999999\nstart=1\nlabel=cycle\ncreated=1\n',
    { mode: 0o600 },
  );
  const child = spawn(
    'bash',
    ['-c', 'trap "" TERM; while :; do sleep 1; done'],
    {
      env: { ...process.env, EVOGENT_TASK_OWNER: 'dead-owner-token' },
      stdio: 'ignore',
    },
  );
  const childExit = waitForExit(child);
  const mockProc = path.join(fixture, 'mock-proc');
  const mockChild = path.join(mockProc, String(child.pid));
  fs.mkdirSync(mockChild, { recursive: true });
  const statFields = ['S', ...Array(18).fill('0'), '777'];
  fs.writeFileSync(
    path.join(mockChild, 'stat'),
    `${child.pid} (bash) ${statFields.join(' ')}\n`,
  );
  fs.writeFileSync(
    path.join(mockChild, 'environ'),
    Buffer.from('EVOGENT_TASK_OWNER=dead-owner-token\0'),
  );
  const monitor = spawn(
    'bash',
    [
      '-c',
      'sleep 2.5; rm -f -- "$2/stat" "$2/environ"; rmdir -- "$2"',
      'owner-monitor',
      String(child.pid),
      mockChild,
    ],
    { stdio: 'ignore' },
  );
  const mockHelper = helper.replace(
    'proc_root="/proc"',
    'proc_root="$TEST_PROC_ROOT"',
  );
  const result = spawnSync(
    'bash',
    ['-c', `set -u\n${mockHelper}\nreap_abandoned_control_workers_and_prove_absent`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fixture,
        TEST_PROC_ROOT: mockProc,
      },
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const exited = await Promise.race([
    childExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
  ]);
  if (exited === null) child.kill('SIGKILL');
  assert.notEqual(exited, null, 'tagged abandoned child survived');
  await waitForExit(monitor);
  assert.deepEqual(fs.readdirSync(owners), []);

  const recent = path.join(owners, 'recent-init');
  fs.mkdirSync(path.join(recent, 'roots'), { recursive: true });
  fs.mkdirSync(path.join(recent, 'packages'));
  let initResult = spawnSync(
    'bash',
    ['-c', `set -u\n${mockHelper}\nreap_abandoned_control_workers_and_prove_absent`],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: fixture, TEST_PROC_ROOT: mockProc },
    },
  );
  assert.notEqual(initResult.status, 0);
  assert.ok(fs.existsSync(recent));
  const old = new Date(Date.now() - 180_000);
  fs.utimesSync(recent, old, old);
  initResult = spawnSync(
    'bash',
    ['-c', `set -u\n${mockHelper}\nreap_abandoned_control_workers_and_prove_absent`],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: fixture, TEST_PROC_ROOT: mockProc },
    },
  );
  assert.equal(initResult.status, 0, initResult.stderr);

  const residueSource = path.join(owners, 'residue-source');
  fs.mkdirSync(residueSource);
  const residueStat = fs.statSync(residueSource);
  const residue = path.join(
    owners,
    `.reaped-owner-fixture-${residueStat.dev}-${residueStat.ino}`,
  );
  fs.renameSync(residueSource, residue);
  const residueResult = spawnSync(
    'bash',
    ['-c', `set -u\n${mockHelper}\nreap_abandoned_control_workers_and_prove_absent`],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: fixture, TEST_PROC_ROOT: mockProc },
    },
  );
  assert.equal(residueResult.status, 0, residueResult.stderr);
  assert.deepEqual(fs.readdirSync(owners), []);
});

test('post-acquire journal detection never forgets an unretired mutation gate', () => {
  const control = fs.readFileSync(controlPath, 'utf8');
  const acquire = shellFunction(
    control,
    'control_release_mutation_gate_acquire',
  );
  const release = shellFunction(
    control,
    'control_release_mutation_gate_release',
  );
  const harness = `
set -u
${acquire}
${release}
RELEASE_ATTEMPTS=0
control_lock_acquire() { CONTROL_ACTIVE_LOCK="$1"; }
control_lock_release() {
  RELEASE_ATTEMPTS=$((RELEASE_ATTEMPTS + 1))
  [ "$RELEASE_ATTEMPTS" -gt 1 ] || return 1
  CONTROL_ACTIVE_LOCK=""
}
control_release_transaction_pending() { return 0; }
CONTROL_ACTIVE_LOCK=/prior.lock
CONTROL_RELEASE_MUTATION_GATE=""
CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK=""
if control_release_mutation_gate_acquire /release test; then
  exit 90
else
  printf 'blocked=%s gate=%s active=%s\\n' \
    "$?" "$CONTROL_RELEASE_MUTATION_GATE" "$CONTROL_ACTIVE_LOCK"
fi
control_release_mutation_gate_release
printf 'released=%s active=%s attempts=%s\\n' \
  "$CONTROL_RELEASE_MUTATION_GATE" "$CONTROL_ACTIVE_LOCK" "$RELEASE_ATTEMPTS"
`;
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'blocked=70 gate=/release/control-plane-mutation.lock '
      + 'active=/release/control-plane-mutation.lock\n'
      + 'released= active=/prior.lock attempts=2\n',
  );

  for (const file of [
    'evogent-boot.sh',
    'evogent-scheduler.sh',
    'evogent-watchdog.sh',
  ]) {
    const source = fs.readFileSync(
      path.join(root, 'phone-paradigm/device/phone-tools', file),
      'utf8',
    );
    assert.match(
      source,
      /\[ -n "\$CONTROL_RELEASE_MUTATION_GATE" \]/,
      `${file} does not honor retained gate ownership`,
    );
  }
});

test('rollback decision precedes predecessor exposure and journal retirement follows proof', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  const rollback = shellFunction(installer, 'rollback_release');
  const cleanup = shellFunction(installer, 'cleanup');
  assert.match(rollback, /commit_rolled_back_decision/);
  assert.doesNotMatch(rollback, /restart-evo|rearm_legacy_server|evogent-boot/);
  assert.ok(
    cleanup.indexOf('release_lock_dir "$INSTALL_LOCK"')
      < cleanup.indexOf('rearm_legacy_server'),
  );
  assert.ok(
    cleanup.indexOf('wait_for_authenticated_release_control_plane')
      < cleanup.indexOf('retire_rolled_back_transaction_journal'),
  );
  assert.match(
    shellFunction(installer, 'commit_rolled_back_decision'),
    /write_transaction_journal rolled_back/,
  );
  const marker = installer.indexOf(
    'printf \'%s\\n\' "$PREVIOUS_TARGET" > "$BACKUP_DIR/previous-release"',
  );
  const quiesce = installer.indexOf('write_transaction_journal quiesce_pending');
  assert.ok(marker !== -1 && marker < quiesce);
});

test('early rolled-back v3 journal is recoverable without pretending backups were ready', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  const validate = shellFunction(installer, 'validate_transaction_journal');
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-early-rolled-back-'),
  );
  const home = path.join(fixture, 'home');
  const releaseRoot = path.join(home, '.local/share/evogent');
  const releases = path.join(releaseRoot, 'releases');
  const backups = path.join(releaseRoot, 'backups');
  const migrations = path.join(releaseRoot, 'migrations');
  const state = path.join(releaseRoot, 'state');
  const phoneState = path.join(state, 'phone-tools');
  const transaction = path.join(releaseRoot, 'install-transaction');
  const newRelease = path.join(releases, 'release-new');
  const previous = path.join(releases, 'release-prior');
  const backup = path.join(backups, 'install-fixture');
  const migration = path.join(migrations, 'install-fixture');
  for (const directory of [
    newRelease,
    previous,
    backup,
    migration,
    phoneState,
    transaction,
    path.join(state, 'data'),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(backup, 'previous-release'),
    `${previous}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(path.join(backup, 'previous-release'), 0o600);
  const journal = path.join(transaction, 'journal.json');
  const payload = {
    schema: 'evogent.phone.install-transaction.v3',
    root: releaseRoot,
    phase: 'rolled_back',
    releaseId: 'release-new',
    newRelease,
    previousTarget: previous,
    backupDir: backup,
    dbBackup: path.join(backup, 'media-agent.db'),
    dbBackupReady: 0,
    dbExisted: 0,
    apkBackup: path.join(backup, 'evogent.apk'),
    apkBackupReady: 0,
    apkChanged: 1,
    apkInstallAttempted: 0,
    packageOperation: '',
    previousApkCode: '7',
    previousApkSigner: 'fixture',
    initialMigration: 0,
    legacyRuntimeExpected: 0,
    legacyControlPlaneExpected: 0,
    legacySnapshotReady: 0,
    legacyPlanSha256: '',
    migrationStarted: 0,
    switchStarted: 0,
    migrationDir: migration,
    cycleGate: path.join(phoneState, '.cycle.lock'),
    controlToken: path.join(state, 'data/control-token.txt'),
    controlTokenBackup: path.join(backup, 'control-token.txt'),
    controlTokenExisted: 0,
    controlTokenBackupReady: 0,
    controlTokenBridge: '',
    androidRoleBackup: path.join(backup, 'android-role-holders.json'),
    androidRoleBackupReady: 0,
    androidRoleBackupSha256: '',
    androidRoleUserId: -1,
    androidRoleRestoreRequired: 0,
    androidRoleMutationAttempted: 0,
    androidRolesApplied: 0,
  };
  const run = (value) => {
    fs.writeFileSync(journal, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return spawnSync(
      'bash',
      [
        '-c',
        `set -u
${validate}
HOME="$2"
ROOT="$3"
RELEASES="$ROOT/releases"
BACKUPS="$ROOT/backups"
MIGRATIONS="$ROOT/migrations"
STATE="$ROOT/state"
PHONE_STATE="$STATE/phone-tools"
TRANSACTION_DIR="$ROOT/install-transaction"
CONTROL_TOKEN="$STATE/data/control-token.txt"
validate_transaction_journal "$1"
`,
        'early-rollback',
        journal,
        home,
        releaseRoot,
      ],
      { encoding: 'utf8' },
    );
  };
  const accepted = run(payload);
  assert.equal(accepted.status, 0, accepted.stderr);
  const missingRoleProof = run({
    ...payload,
    androidRoleRestoreRequired: 1,
  });
  assert.notEqual(missingRoleProof.status, 0);
});
