import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
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
  'phone-paradigm/device/setup-new-phone.sh',
];

test('phone release shell entrypoints parse', () => {
  execFileSync('bash', ['-n', ...scripts], { cwd: root, stdio: 'pipe' });
});

test('release builder refuses a dirty Git source before running a build', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-release-dirty-'));
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
  fs.writeFileSync(path.join(fixture, 'tracked.txt'), 'dirty\n');

  const result = spawnSync('bash', ['scripts/build-phone-release.sh'], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.equal(result.status, 65);
  assert.match(result.stderr, /refusing to build from a dirty source tree/);
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
  assert.match(installer, /EXPECTED_APK_SIGNER/);
  assert.match(installer, /EXPECTED_APK_SHA256/);
  assert.match(installer, /APK_INSTALL_ATTEMPTED/);
  assert.match(installer, /DEPENDENCY_MARKER/);
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
  assert.match(installer, /fsync_regular_file_and_parent "\$APK_BACKUP"/);
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

test('fresh-phone setup streams the exact APK token and grants real components', () => {
  const setup = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/setup-new-phone.sh'),
    'utf8',
  );
  assert.match(
    setup,
    /net\.dangish\.evogent\/net\.dangish\.evogent\.EvogentNotificationListenerService/,
  );
  assert.doesNotMatch(
    setup,
    /net\.dangish\.evogent(?:\/|\.)EvogentNotificationListener(?!Service)/,
  );
  assert.match(setup, /enabled_notification_listeners/);
  assert.match(
    setup,
    /A shell 'cat \/sdcard\/Android\/data\/net\.dangish\.evogent\/files\/control-token\.txt'\s+\\\n\s+\| \$SSH 'python3 /,
  );
  assert.doesNotMatch(setup, /\bTOK=/);
  assert.doesNotMatch(setup, /printf\s+['"]%s['"]\s+['"]?\$TOK/);
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
