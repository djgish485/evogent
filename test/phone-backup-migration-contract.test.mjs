import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const backup = fs.readFileSync(
  'phone-paradigm/device/backup-phone.sh',
  'utf8',
);
const migration = fs.readFileSync(
  'phone-paradigm/device/MIGRATE-TO-NEW-PHONE.md',
  'utf8',
);
const installation = fs.readFileSync(
  'docs/phone-installation-and-provisioning.md',
  'utf8',
);
const pixelSetup = fs.readFileSync(
  'phone-paradigm/pixel-real-device-setup.md',
  'utf8',
);
const backupScript = path.resolve('phone-paradigm/device/backup-phone.sh');

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function makePhoneFixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-backup-contract-'));
  const phoneHome = path.join(temporary, 'phone-home');
  const fakeBin = path.join(temporary, 'bin');
  const releaseRoot = path.join(phoneHome, '.local/share/evogent');
  const release = path.join(releaseRoot, 'releases/release-test');
  const state = path.join(releaseRoot, 'state');
  const data = path.join(state, 'data');
  const phoneTools = path.join(state, 'phone-tools');
  const releasePhoneTools = path.join(release, 'phone-tools');
  fs.mkdirSync(path.join(data, 'media'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(data, 'tmp'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(data, '.scheduler-tasks/.leased'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(data, 'phone-sources/.queue'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(data, 'phone-sources/.queue/.leased'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(data, 'phone-sources/.candidates'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(data, 'phone-sources/.active'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(data, 'source-due-signals'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(phoneTools, 'logs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(phoneTools, '.source-failure-backoff'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(releasePhoneTools, { recursive: true, mode: 0o700 });
  fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });

  const apk = Buffer.from('exact signed Evogent APK fixture\n');
  const apkPath = path.join(temporary, 'installed.apk');
  fs.writeFileSync(apkPath, apk, { mode: 0o600 });
  const releaseManifest = {
    schemaVersion: 1,
    releaseId: 'release-test',
    sourceCommit: '1111111111111111111111111111111111111111',
    android: {
      package: 'net.dangish.evogent',
      versionCode: 1785308073,
      versionName: '0.3.0',
      sha256: sha256(apk),
    },
  };
  fs.writeFileSync(
    path.join(release, 'manifest.json'),
    `${JSON.stringify(releaseManifest)}\n`,
    { mode: 0o600 },
  );
  fs.symlinkSync(release, path.join(releaseRoot, 'current'));
  writeExecutable(
    path.join(releasePhoneTools, 'control-plane.sh'),
    `#!/usr/bin/env bash
CONTROL_OWNER_ID=""
control_init_owner() { CONTROL_OWNER_ID="migration-backup-test"; }
control_reap_abandoned_owners() { :; }
control_lock_acquire() {
  [ ! -e "$FAKE_CYCLE_BUSY_FILE" ] || return 1
  mkdir "$1"
}
control_lock_release() { rm -rf -- "$1"; }
control_finish_owner() { CONTROL_OWNER_ID=""; }
`,
  );
  fs.symlinkSync(
    path.join(releasePhoneTools, 'control-plane.sh'),
    path.join(phoneTools, 'control-plane.sh'),
  );
  fs.symlinkSync(phoneTools, path.join(phoneHome, 'phone-tools'));

  const databaseResult = spawnSync(
    'python3',
    [
      '-c',
      [
        'import sqlite3, sys',
        'db = sqlite3.connect(sys.argv[1])',
        'db.execute("CREATE TABLE feed (id INTEGER PRIMARY KEY, title TEXT)")',
        'db.execute("INSERT INTO feed(title) VALUES (?)", ("fixture",))',
        'db.commit()',
        'db.close()',
      ].join('; '),
      path.join(data, 'media-agent.db'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(databaseResult.status, 0, databaseResult.stderr);

  fs.writeFileSync(path.join(data, 'config.md'), '## Brain Provider\nCodex CLI\n');
  fs.writeFileSync(path.join(data, 'source-cadence.json'), '{"x":{"cadenceHours":4}}\n');
  fs.writeFileSync(path.join(data, 'media/example.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(data, 'control-token.txt'), 'must-not-transfer\n');
  fs.writeFileSync(path.join(data, '.env.local'), 'AUTH_TOKEN=must-not-transfer\n');
  fs.writeFileSync(path.join(data, 'tmp/transient.txt'), 'must-not-transfer\n');
  fs.writeFileSync(path.join(data, '.scheduler-tasks/.leased/overseer.json'), '{}\n');
  fs.writeFileSync(
    path.join(data, 'phone-sources/.queue/discovery-v2-private-chat.json'),
    `${JSON.stringify({
      taskId: 'discovery-v2-private-chat',
      kind: 'discovery',
      pkg: 'com.example.privatechat',
      name: 'Example Private Chat',
      source: 'private-chat',
      state: 'queued',
      createdAtMs: 1700000000000,
      updatedAtMs: 1700000000000,
      attempt: 0,
      maxAttempts: 4,
      notBeforeMs: 1700000000000,
    })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(data, 'phone-sources/.queue/research-com.example.fresh.json'),
    `${JSON.stringify({
      taskId: 'research-com.example.fresh',
      kind: 'research',
      pkg: 'com.example.fresh',
      installedDaysAgo: 1.25,
      state: 'queued',
      createdAtMs: 1700000001000,
      updatedAtMs: 1700000001000,
      attempt: 0,
      maxAttempts: 4,
      notBeforeMs: 1700000001000,
    })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(data, 'phone-sources/.candidates/source.candidate'),
    'unvalidated recipe\n',
  );
  fs.writeFileSync(
    path.join(data, 'phone-sources/.active/source.json'),
    '{"format":1,"source":"source"}\n',
  );
  fs.writeFileSync(path.join(data, 'source-due-signals/x.due'), '{}\n');
  fs.writeFileSync(path.join(data, 'phone-cycle-request.json'), '{}\n');
  fs.writeFileSync(path.join(phoneTools, 'model-benchmark-results.jsonl'), '{"ok":true}\n');
  fs.writeFileSync(path.join(phoneTools, 'logs/scheduler.log'), 'must-not-transfer\n');
  fs.writeFileSync(path.join(phoneTools, '.curation-control'), 'owner=old-phone\n');
  fs.writeFileSync(
    path.join(phoneTools, '.last-failed-curation-input-generation.json'),
    '{"version":1,"generation":"device-local-spend"}\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(phoneTools, '.source-failure-backoff/youtube.json'),
    '{"version":1,"source":"youtube","notBeforeEpochSeconds":9999999999}\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(phoneTools, '.host-policy-before.json'), '{}\n');
  fs.writeFileSync(path.join(phoneTools, '.last-source-scout'), '1700000000\n', {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(phoneTools, '.researched-apps'),
    'com.example.fresh\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(phoneTools, '.dedicated-termux-wake'),
    'EVOGENT_DEDICATED_TERMUX_WAKE_V1\n',
  );
  fs.symlinkSync(
    path.join(release, 'phone-tools/example.sh'),
    path.join(phoneTools, 'example.sh'),
  );
  fs.mkdirSync(path.join(phoneHome, '.ssh'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(phoneHome, '.ssh/id_test'), 'must-not-transfer\n');
  fs.mkdirSync(path.join(phoneHome, '.codex'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(phoneHome, '.codex/auth.json'), 'must-not-transfer\n');

  const forwardState = path.join(temporary, 'forward-state');
  const forwardLog = path.join(temporary, 'forward-log');
  fs.writeFileSync(forwardState, '');
  fs.writeFileSync(forwardLog, '');

  writeExecutable(
    path.join(fakeBin, 'adb'),
    `#!/usr/bin/env bash
set -euo pipefail
serial=""
if [ "\${1:-}" = "-s" ]; then
  serial="$2"
  shift 2
fi
case "\${1:-}" in
  get-state)
    printf 'device\\n'
    ;;
  forward)
    shift
    case "\${1:-}" in
      --list)
        cat "$FAKE_FORWARD_STATE"
        ;;
      --no-rebind)
        [ -n "$serial" ] && [ "$3" = "tcp:8022" ]
        [ ! -s "$FAKE_FORWARD_STATE" ] || exit 73
        printf '%s %s %s\\n' "$serial" "$2" "$3" > "$FAKE_FORWARD_STATE"
        printf 'create\\n' >> "$FAKE_FORWARD_LOG"
        ;;
      --remove)
        [ -n "$serial" ]
        : > "$FAKE_FORWARD_STATE"
        printf 'remove\\n' >> "$FAKE_FORWARD_LOG"
        ;;
      *)
        exit 64
        ;;
    esac
    ;;
  shell)
    shift
    case "\${1:-} \${2:-}" in
      "pm path")
        printf 'package:/data/app/evogent/base.apk\\n'
        ;;
      "dumpsys package")
        printf 'Packages:\\n  Package [net.dangish.evogent]\\n    versionCode=1785308073 minSdk=35\\n    versionName=0.3.0\\n'
        ;;
      "sha256sum /data/app/evogent/base.apk")
        shasum -a 256 "$FAKE_APK" | awk '{print $1 "  /data/app/evogent/base.apk"}'
        ;;
      *)
        exit 64
        ;;
    esac
    ;;
  pull)
    [ "$2" = "/data/app/evogent/base.apk" ] || exit 64
    cp "$FAKE_APK" "$3"
    ;;
  *)
    exit 64
    ;;
esac
`,
  );

  writeExecutable(
    path.join(fakeBin, 'ssh'),
    `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|-o)
      shift 2
      ;;
    *)
      break
      ;;
  esac
done
[ "$#" -ge 2 ] || exit 64
shift
if [ "$#" -eq 1 ]; then
  command_text="$1"
  case "$command_text" in
    *EVOGENT_BACKUP_SSH_READY*)
      printf 'EVOGENT_BACKUP_SSH_READY'
      ;;
    *evogent-backup.XXXXXXXX*)
      mkdir -p "$FAKE_PHONE_HOME/.cache"
      chmod 700 "$FAKE_PHONE_HOME/.cache"
      suffix="TEST$$"
      mkdir "$FAKE_PHONE_HOME/.cache/evogent-backup.$suffix"
      chmod 700 "$FAKE_PHONE_HOME/.cache/evogent-backup.$suffix"
      printf '/data/data/com.termux/files/home/.cache/evogent-backup.%s\\n' "$suffix"
      ;;
    *)
      HOME="$FAKE_PHONE_HOME" bash -c "$command_text"
      ;;
  esac
  exit
fi
[ "$1" = "bash" ] && [ "$2" = "-s" ] && [ "$3" = "--" ] || exit 64
canonical="$4"
prefix="/data/data/com.termux/files/home"
case "$canonical" in
  "$prefix"/*) actual="$FAKE_PHONE_HOME\${canonical#"$prefix"}" ;;
  *) exit 65 ;;
esac
shift 4
HOME="$FAKE_PHONE_HOME" PATH="$FAKE_BIN:$ORIGINAL_PATH" bash -s -- "$actual" "$@"
`,
  );

  writeExecutable(
    path.join(fakeBin, 'scp'),
    `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    -P|-o)
      shift 2
      ;;
    *)
      break
      ;;
  esac
done
[ "$#" -eq 2 ] || exit 64
[ ! -e "$FAKE_SCP_FAIL_FILE" ] || exit 74
source_spec="$1"
destination="$2"
canonical="\${source_spec#*:}"
prefix="/data/data/com.termux/files/home"
case "$canonical" in
  "$prefix"/*) actual="$FAKE_PHONE_HOME\${canonical#"$prefix"}" ;;
  *) exit 65 ;;
esac
cp "$actual" "$destination"
`,
  );

  writeExecutable(
    path.join(fakeBin, 'pkg'),
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "list-installed" ] || exit 64
printf 'bash/stable 5.2 arm [installed]\\npython/stable 3.12 arm [installed]\\n'
`,
  );
  writeExecutable(
    path.join(fakeBin, 'getprop'),
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "ro.build.fingerprint" ] || exit 64
printf 'google/fixture/fixture:16/TEST/release-keys\\n'
`,
  );

  return {
    temporary,
    phoneHome,
    fakeBin,
    apkPath,
    data,
    phoneTools,
    forwardState,
    forwardLog,
    scpFailFile: path.join(temporary, 'fail-scp'),
    cycleBusyFile: path.join(temporary, 'cycle-busy'),
  };
}

function runBackup(fixture, output, additions = {}) {
  return spawnSync(
    'bash',
    [
      backupScript,
      'SERIAL',
      output,
      'termux-user',
      '18023',
    ],
    {
      cwd: path.dirname(backupScript),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH}`,
        ORIGINAL_PATH: process.env.PATH,
        FAKE_BIN: fixture.fakeBin,
        FAKE_PHONE_HOME: fixture.phoneHome,
        FAKE_APK: fixture.apkPath,
        FAKE_FORWARD_STATE: fixture.forwardState,
        FAKE_FORWARD_LOG: fixture.forwardLog,
        FAKE_SCP_FAIL_FILE: fixture.scpFailFile,
        FAKE_CYCLE_BUSY_FILE: fixture.cycleBusyFile,
        ...additions,
      },
    },
  );
}

test('phone migration backup is selective, private by default, and fail closed', () => {
  assert.match(backup, /^set -euo pipefail$/m);
  assert.match(backup, /\[ "\$#" -eq 4 \] \|\| usage/);
  assert.match(
    backup,
    /<adb-serial> <new-out-dir> <termux-ssh-user> <host-forward-port>/,
  );
  assert.match(backup, /output already exists; choose a new directory/);

  assert.match(backup, /allowed_roots = \("data", "phone-tools"\)/);
  assert.match(backup, /state \/ "data" \/ "media-agent[.]db"/);
  assert.match(backup, /source[.]backup\(destination\)/);
  assert.match(backup, /PRAGMA quick_check/g);
  assert.match(backup, /evogent-state[.]tar[.]gz/);
  assert.match(backup, /state-inventory[.]json/);
  assert.match(backup, /backup-manifest[.]json/);
  assert.match(backup, /SHA256SUMS/);
  assert.match(backup, /state archive inventory verification failed/);
  assert.match(backup, /remote payload verification failed/);
  assert.match(backup, /installed APK and current release do not agree/);
  assert.match(backup, /control_lock_acquire "\$cycle_gate" migration-backup/);
  assert.match(backup, /for chunk in iter\(lambda: handle[.]read\(1024 \* 1024\), b""\)/);
  assert.match(backup, /collect_migration_source_intents/);
  assert.match(backup, /fcntl[.]flock\(lock_descriptor, fcntl[.]LOCK_EX\)/);
  assert.match(backup, /MIGRATION_SOURCE_INTENTS/);
  assert.match(backup, /value[.]get\("state"\) != "queued"/);
  assert.match(backup, /"lease" in value/);
  assert.match(backup, /leased source intent exists/);
  assert.match(backup, /reconciliation-only source task must finish/);

  assert.doesNotMatch(backup, /phone-full[.]tar/);
  assert.doesNotMatch(backup, /tar\s+\S*f[^\n]*\bhome\b/);
  assert.doesNotMatch(backup, /\busr\/etc\b/);
  assert.match(backup, /whole Termux home and usr/);
  assert.match(backup, /provider authentication/);
  assert.match(backup, /SSH configuration and keys/);
  assert.match(backup, /environment files and source-provider cookies/);
  assert.match(backup, /Evogent control tokens/);
  assert.match(backup, /name[.]startswith\("[.]env[.]"\)/);
  assert.match(backup, /"control-token"/);
  assert.match(backup, /"cookie"/);

  assert.match(backup, /forward --no-rebind/);
  assert.match(backup, /refusing to remove a forward whose identity changed/);
  assert.match(backup, /remove_remote_stage\nremove_owned_forward/);
  assert.match(backup, /PUBLISHED=1/);
  assert.match(backup, /verified backup complete/);
});

test('fresh-phone docs put signed installation before grants and runtime resume', () => {
  const migrationProse = migration.replace(/\s+/g, ' ');
  const installationProse = installation.replace(/\s+/g, ' ');
  const pixelProse = pixelSetup.replace(/\s+/g, ' ');

  assert.match(
    migration,
    /backup-phone[.]sh \\\n\s+<DEVICE_SERIAL> <NEW_BACKUP_DIR> <TERMUX_USER> <HOST_FORWARD_PORT>/,
  );
  assert.match(migrationProse, /bootstrap-install its exact signed Evogent APK/);
  assert.match(migrationProse, /Only after that package proof/);
  assert.match(migrationProse, /Resume or run the versioned bundle installer/);
  assert.ok(
    migrationProse.indexOf('bootstrap-install its exact signed Evogent APK')
      < migrationProse.indexOf('Only after that package proof'),
  );
  assert.ok(
    migrationProse.indexOf('Only after that package proof')
      < migrationProse.indexOf('Resume or run the versioned bundle installer'),
  );

  for (const document of [migration, installation, pixelSetup]) {
    assert.match(document, /provision-host-policy[.]sh --status/);
    assert.match(document, /provision-host-policy[.]sh --apply/);
    assert.match(document, /provision-host-policy[.]sh --restore/);
    assert.match(document, /explicit\s+owner\s+authorization/i);
  }

  assert.match(installationProse, /bootstrap-install its exact signed Evogent APK/);
  assert.match(installationProse, /only after Android knows that package/);
  assert.match(installationProse, /resume or run the versioned bundle installer/);
  assert.match(pixelProse, /After proving the exact installed APK bytes and version/);
  assert.match(pixelProse, /Resume or run the current phone release transaction/);
  assert.match(pixelProse, /whenever it offers or recommends one/);
});

test('authentication transfer is separate and owner-explicit', () => {
  const migrationProse = migration.replace(/\s+/g, ' ');
  const installationProse = installation.replace(/\s+/g, ' ');
  const pixelProse = pixelSetup.replace(/\s+/g, ' ');

  assert.match(migrationProse, /Provider or SSH authentication transfer is a separate owner decision/);
  assert.match(migrationProse, /It has no “include everything” mode/);
  assert.match(migrationProse, /Do not expect provider authentication or SSH access in the default backup/);
  assert.match(installationProse, /Provider or SSH authentication transfer is a separate, explicit owner decision/);
  assert.match(pixelProse, /Transfer authentication only when the owner explicitly chooses/);
});

test('migration docs distinguish portable intent from old-phone queue authority', () => {
  const prose = migration.replace(/\s+/g, ' ');
  assert.match(prose, /[.]migration-pending-source-intents[.]json/);
  assert.match(
    prose,
    /never copies a queue file, lease, worker owner, or retry state/,
  );
  assert.match(prose, /refuses rather than serializing or omitting a live lease/);
  assert.match(prose, /reconciliation-only state must finish on the old phone/);
  assert.match(
    prose,
    /App-research intents bypass `[.]researched-apps` during this reconciliation/,
  );
  assert.match(prose, /confirm no old lease was restored/);
});

test('backup transaction publishes only after verified copy and owned cleanup', () => {
  const fixture = makePhoneFixture();
  try {
    const output = path.join(fixture.temporary, 'verified-backup');
    const result = runBackup(fixture, output);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /verified backup complete/);
    assert.ok(fs.statSync(output).isDirectory());
    assert.ok(fs.statSync(path.join(output, 'media-agent.db')).isFile());
    assert.ok(fs.statSync(path.join(output, 'evogent-shell.apk')).isFile());
    assert.ok(fs.statSync(path.join(output, 'SHA256SUMS')).isFile());
    assert.equal(fs.readFileSync(fixture.forwardState, 'utf8'), '');
    assert.equal(fs.readFileSync(fixture.forwardLog, 'utf8'), 'create\nremove\n');
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.phoneHome, '.cache')),
      [],
    );

    const inventory = JSON.parse(
      fs.readFileSync(path.join(output, 'state-inventory.json'), 'utf8'),
    );
    const included = inventory.included.map((entry) => entry.path);
    assert.ok(included.includes('data/config.md'));
    assert.ok(included.includes('data/media/example.bin'));
    assert.ok(included.includes('data/phone-sources/.active/source.json'));
    assert.ok(
      included.includes(
        'data/phone-sources/.migration-pending-source-intents.json',
      ),
    );
    assert.ok(included.includes('phone-tools/model-benchmark-results.jsonl'));
    assert.ok(included.includes('phone-tools/.researched-apps'));
    assert.ok(
      !included.some(
        (entry) => /control-token|[.]env|logs|tmp|scheduler-tasks|[.]queue|[.]candidates|source-due-signals|source-failure-backoff|phone-cycle-request|curation-control|last-failed-curation-input-generation|host-policy-before|dedicated-termux-wake|last-source-scout/.test(entry),
      ),
    );
    const archive = path.join(output, 'evogent-state.tar.gz');
    const handoffResult = spawnSync(
      'tar',
      [
        '-xOzf',
        archive,
        'state/data/phone-sources/.migration-pending-source-intents.json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(handoffResult.status, 0, handoffResult.stderr);
    const handoff = JSON.parse(handoffResult.stdout);
    assert.equal(handoff.schemaVersion, 1);
    assert.ok(Number.isSafeInteger(handoff.capturedAtMs));
    assert.deepEqual(handoff.intents, [
      {
        taskId: 'discovery-v2-private-chat',
        kind: 'discovery',
        pkg: 'com.example.privatechat',
        name: 'Example Private Chat',
        source: 'private-chat',
        createdAtMs: 1700000000000,
      },
      {
        taskId: 'research-com.example.fresh',
        kind: 'research',
        pkg: 'com.example.fresh',
        installedDaysAgo: 1.25,
        createdAtMs: 1700000001000,
      },
    ]);
    const archiveList = spawnSync('tar', ['-tzf', archive], {
      encoding: 'utf8',
    });
    assert.equal(archiveList.status, 0, archiveList.stderr);
    assert.doesNotMatch(archiveList.stdout, /\/[.]queue(?:\/|$)/);
    assert.doesNotMatch(archiveList.stdout, /leased-source/);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(output, 'backup-manifest.json'), 'utf8'),
    );
    assert.ok(
      manifest.contents.includes(
        'bounded validated unleased source-intent handoff when queued work exists',
      ),
    );
    assert.ok(inventory.excludedCounts.device_local_owner_policy >= 2);
    assert.ok(inventory.excludedCounts.device_local_task_authority >= 4);
  } finally {
    fs.rmSync(fixture.temporary, { force: true, recursive: true });
  }
});

test('malformed unleased source work aborts instead of disappearing from migration', () => {
  const fixture = makePhoneFixture();
  try {
    fs.writeFileSync(
      path.join(
        fixture.data,
        'phone-sources/.queue/discovery-v2-private-chat.json',
      ),
      '{}\n',
      { mode: 0o600 },
    );
    const output = path.join(fixture.temporary, 'must-not-drop-source-intent');
    const result = runBackup(fixture, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /queued source task/);
    assert.ok(!fs.existsSync(output));
    assert.equal(fs.readFileSync(fixture.forwardState, 'utf8'), '');
  } finally {
    fs.rmSync(fixture.temporary, { force: true, recursive: true });
  }
});

test('leased source work aborts instead of silently disappearing from migration', () => {
  const fixture = makePhoneFixture();
  try {
    fs.writeFileSync(
      path.join(
        fixture.data,
        'phone-sources/.queue/.leased/discovery-v2-leased-source.json',
      ),
      `${JSON.stringify({
        taskId: 'discovery-v2-leased-source',
        kind: 'discovery',
        pkg: 'com.example.leased',
        name: 'Leased Source',
        source: 'leased-source',
        state: 'leased',
        createdAtMs: 1699999999000,
        attempt: 1,
        maxAttempts: 4,
        lease: {
          id: 'lease-fixture',
          leasedAtMs: 1700000000000,
          expiresAtMs: 1800000000000,
        },
      })}\n`,
      { mode: 0o600 },
    );
    const output = path.join(fixture.temporary, 'must-not-drop-leased-source-intent');
    const result = runBackup(fixture, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /leased source intent exists/);
    assert.ok(!fs.existsSync(output));
    assert.equal(fs.readFileSync(fixture.forwardState, 'utf8'), '');
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.phoneHome, '.cache')),
      [],
    );
  } finally {
    fs.rmSync(fixture.temporary, { force: true, recursive: true });
  }
});

test('reconciliation-only proof cannot be downgraded to portable provider intent', () => {
  const fixture = makePhoneFixture();
  try {
    const queuedPath = path.join(
      fixture.data,
      'phone-sources/.queue/discovery-v2-private-chat.json',
    );
    const queued = JSON.parse(fs.readFileSync(queuedPath, 'utf8'));
    fs.writeFileSync(
      queuedPath,
      `${JSON.stringify({ ...queued, reconciliationOnly: true })}\n`,
      { mode: 0o600 },
    );
    const output = path.join(fixture.temporary, 'must-not-replay-provider');
    const result = runBackup(fixture, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reconciliation-only source task must finish/);
    assert.ok(!fs.existsSync(output));
    assert.equal(fs.readFileSync(fixture.forwardState, 'utf8'), '');
  } finally {
    fs.rmSync(fixture.temporary, { force: true, recursive: true });
  }
});

test('copy failure leaves no published output and cleans owned remote state', () => {
  const fixture = makePhoneFixture();
  try {
    fs.writeFileSync(fixture.scpFailFile, 'fail\n');
    const output = path.join(fixture.temporary, 'must-not-publish');
    const result = runBackup(fixture, output);
    assert.notEqual(result.status, 0);
    assert.ok(!fs.existsSync(output));
    assert.equal(fs.readFileSync(fixture.forwardState, 'utf8'), '');
    assert.equal(fs.readFileSync(fixture.forwardLog, 'utf8'), 'create\nremove\n');
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.phoneHome, '.cache')),
      [],
    );
    assert.ok(
      !fs.readdirSync(fixture.temporary).some(
        (entry) => entry.startsWith('.evogent-backup.pending.'),
      ),
    );
  } finally {
    fs.rmSync(fixture.temporary, { force: true, recursive: true });
  }
});

test('active provider cycle fails before snapshot and leaves no output', () => {
  const fixture = makePhoneFixture();
  try {
    fs.writeFileSync(fixture.cycleBusyFile, 'busy\n');
    const output = path.join(fixture.temporary, 'must-not-snapshot-live-cycle');
    const result = runBackup(fixture, output);
    assert.equal(result.status, 75);
    assert.match(result.stderr, /browse\/provider cycle is active/);
    assert.ok(!fs.existsSync(output));
    assert.equal(fs.readFileSync(fixture.forwardState, 'utf8'), '');
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.phoneHome, '.cache')),
      [],
    );
  } finally {
    fs.rmSync(fixture.temporary, { force: true, recursive: true });
  }
});

test('pre-existing exact adb forward is reused and preserved', () => {
  const fixture = makePhoneFixture();
  try {
    const existing = ['SERIAL', 'tcp:18023', 'tcp:8022'].join(' ') + '\n';
    fs.writeFileSync(fixture.forwardState, existing);
    const output = path.join(fixture.temporary, 'forward-preserving-backup');
    const result = runBackup(fixture, output);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.readFileSync(fixture.forwardState, 'utf8'), existing);
    assert.equal(fs.readFileSync(fixture.forwardLog, 'utf8'), '');
  } finally {
    fs.rmSync(fixture.temporary, { force: true, recursive: true });
  }
});

test('post-rename durability failure rolls publication back to private staging', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-backup-publish-'));
  try {
    const source = path.join(temporary, '.pending');
    const destination = path.join(temporary, 'backup');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SHA256SUMS'), 'fixture\n');
    const publication = [...backup.matchAll(/<<'PY'\n(.*?)\nPY\n/gs)]
      .map((match) => match[1])
      .find((block) => block.includes('os.rename(source, destination)'));
    assert.ok(publication);
    const injected = [
      'import os as _injected_os',
      'def _fail_fsync(_descriptor):',
      '    raise OSError("injected post-rename fsync failure")',
      '_injected_os.fsync = _fail_fsync',
      publication,
    ].join('\n');
    const result = spawnSync(
      'python3',
      ['-c', injected, source, destination, temporary],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.ok(fs.statSync(source).isDirectory());
    assert.ok(!fs.existsSync(destination));
  } finally {
    fs.rmSync(temporary, { force: true, recursive: true });
  }
});
