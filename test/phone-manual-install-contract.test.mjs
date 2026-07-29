import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const androidBuildPath = path.join(root, 'android-shell/build.sh');
const releaseBuildPath = path.join(root, 'scripts/build-phone-release.sh');
const extractorPath = path.join(root, 'scripts/extract-phone-bootstrap-apk.py');

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

function makeExecutable(file) {
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
}

function createReleaseFixture(parent, name = 'release.tar.gz') {
  const staging = path.join(parent, `staging-${crypto.randomBytes(4).toString('hex')}`);
  const release = path.join(staging, 'release');
  fs.mkdirSync(path.join(release, 'apk'), { recursive: true });
  const apk = Buffer.from('synthetic signed APK fixture bytes\n');
  const apkSha = crypto.createHash('sha256').update(apk).digest('hex');
  const tlsSha = 'c'.repeat(64);
  const identity = `apk-sha256:${apkSha}\ntls-cert-der-sha256:${tlsSha}\n`;
  const identityDigest = crypto
    .createHash('sha256')
    .update(identity, 'ascii')
    .digest('hex')
    .slice(0, 12);
  const manifest = {
    android: {
      package: 'net.dangish.evogent',
      sha256: apkSha,
      signerSha256: 'b'.repeat(64),
      versionCode: 42,
      versionName: '0.3.0',
    },
    phoneTls: {
      certificateDerSha256: tlsSha,
      host: '127.0.0.1',
      port: 3443,
    },
    releaseFormat: 1,
    releaseId: `fixture-${identityDigest}`,
    releaseIdentityDigest: identityDigest,
    schema: 'evogent.phone.release.v1',
  };
  fs.writeFileSync(path.join(release, 'apk/evogent.apk'), apk);
  fs.writeFileSync(
    path.join(release, 'manifest.json'),
    `${JSON.stringify(manifest)}\n`,
  );
  const archive = path.join(parent, name);
  execFileSync('tar', ['-czf', archive, '-C', staging, 'release'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  fs.chmodSync(archive, 0o600);
  const archiveBytes = fs.readFileSync(archive);
  const archiveSha = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  fs.writeFileSync(
    `${archive}.sha256`,
    `${archiveSha}  ${path.basename(archive)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(`${archive}.sha256`, 0o600);
  return { apk, archive, manifest, staging };
}

test('repo install routing defaults to the canonical Android profile', () => {
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(
    agents,
    /stock\s+Android as the canonical production target[\s\S]*docs\/phone-production[.]md[\s\S]*MIGRATE-TO-NEW-PHONE[.]md/,
  );
  assert.match(
    agents,
    /setup-for-coding-agents[.]md[\s\S]*only when the user explicitly asks[\s\S]*local\/legacy-VM profile/,
  );
});

test('Android SDK and JDK inputs are discoverable and explicitly overrideable', () => {
  const androidBuild = fs.readFileSync(androidBuildPath, 'utf8');
  const releaseBuild = fs.readFileSync(releaseBuildPath, 'utf8');
  assert.doesNotMatch(androidBuild, /\/usr\/local\/opt\/openjdk/);
  assert.doesNotMatch(releaseBuild, /\/usr\/local\/opt\/openjdk/);
  assert.match(androidBuild, /EVOGENT_ANDROID_SDK_ROOT/);
  assert.match(androidBuild, /ANDROID_SDK_ROOT/);
  assert.match(androidBuild, /ANDROID_HOME/);
  assert.match(androidBuild, /EVOGENT_JAVA_HOME/);
  assert.match(androidBuild, /\/usr\/libexec\/java_home/);
  assert.match(androidBuild, /brew --prefix/);
  assert.match(androidBuild, /command -v javac/);
  assert.match(androidBuild, /EVOGENT_ANDROID_BUILD_TOOLS_DIR/);
  assert.match(androidBuild, /EVOGENT_ANDROID_PLATFORM_API/);
  assert.match(releaseBuild, /resolve_android_sdk_root/);
  assert.match(releaseBuild, /EVOGENT_ANDROID_BUILD_TOOLS_DIR/);

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-toolchain-'));
  const sdk = path.join(fixture, 'sdk');
  fs.mkdirSync(path.join(sdk, 'build-tools'), { recursive: true });
  fs.mkdirSync(path.join(sdk, 'platforms'));
  const sdkHarness = `
set -euo pipefail
${shellFunction(androidBuild, 'resolve_android_sdk_root')}
resolve_android_sdk_root
`;
  let result = spawnSync('bash', ['-c', sdkHarness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVOGENT_ANDROID_SDK_ROOT: sdk,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fs.realpathSync(sdk));

  const jdk = path.join(fixture, 'jdk');
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  for (const tool of ['java', 'javac', 'keytool']) {
    makeExecutable(path.join(jdk, 'bin', tool));
  }
  const javaHarness = `
set -euo pipefail
${shellFunction(androidBuild, 'java_home_has_build_tools')}
${shellFunction(androidBuild, 'resolve_java_home')}
resolve_java_home
`;
  result = spawnSync('bash', ['-c', javaHarness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVOGENT_JAVA_HOME: jdk,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fs.realpathSync(jdk));

  for (const version of ['35.0.0', '36.2.1']) {
    const directory = path.join(sdk, 'build-tools', version);
    fs.mkdirSync(directory);
    for (const tool of ['aapt2', 'aidl', 'apksigner', 'd8', 'zipalign']) {
      makeExecutable(path.join(directory, tool));
    }
  }
  const buildToolsHarness = `
set -euo pipefail
${shellFunction(androidBuild, 'find_android_build_tools_dir')}
find_android_build_tools_dir "$1"
`;
  result = spawnSync('bash', ['-c', buildToolsHarness, 'tools', sdk], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(sdk, 'build-tools/36.2.1'));
});

test('bootstrap extractor binds the private archive, manifest, and exact APK', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-bootstrap-'));
  const { apk, archive, manifest } = createReleaseFixture(fixture);
  const output = path.join(fixture, 'output');
  fs.mkdirSync(output, { mode: 0o700 });
  fs.chmodSync(output, 0o700);

  let result = spawnSync(
    'python3',
    [extractorPath, archive, output],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(output, 'evogent.apk')), apk);
  const receipt = JSON.parse(
    fs.readFileSync(path.join(output, 'bootstrap-identity.json'), 'utf8'),
  );
  assert.equal(receipt.schema, 'evogent.phone.bootstrap-apk.v1');
  assert.equal(receipt.package, 'net.dangish.evogent');
  assert.equal(receipt.releaseId, manifest.releaseId);
  assert.equal(receipt.sha256, manifest.android.sha256);
  for (const name of ['evogent.apk', 'manifest.json', 'bootstrap-identity.json']) {
    assert.equal(fs.statSync(path.join(output, name)).mode & 0o777, 0o600);
  }

  const tamperedOutput = path.join(fixture, 'tampered-output');
  fs.mkdirSync(tamperedOutput, { mode: 0o700 });
  fs.chmodSync(tamperedOutput, 0o700);
  fs.writeFileSync(
    `${archive}.sha256`,
    `${'0'.repeat(64)}  ${path.basename(archive)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(`${archive}.sha256`, 0o600);
  result = spawnSync(
    'python3',
    [extractorPath, archive, tamperedOutput],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum sidecar does not exactly match/);
  assert.deepEqual(fs.readdirSync(tamperedOutput), []);

  const archiveSha = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archive))
    .digest('hex');
  const linkedArchive = path.join(fixture, 'linked-release.tar.gz');
  fs.symlinkSync(archive, linkedArchive);
  fs.writeFileSync(
    `${linkedArchive}.sha256`,
    `${archiveSha}  ${path.basename(linkedArchive)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(`${linkedArchive}.sha256`, 0o600);
  const linkedOutput = path.join(fixture, 'linked-output');
  fs.mkdirSync(linkedOutput, { mode: 0o700 });
  fs.chmodSync(linkedOutput, 0o700);
  result = spawnSync(
    'python3',
    [extractorPath, linkedArchive, linkedOutput],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a private owner-only regular file/);
  assert.deepEqual(fs.readdirSync(linkedOutput), []);
});

test('public first-install procedure preserves signer identity and Android security', () => {
  const bootstrap = fs.readFileSync(
    path.join(root, 'docs/phone-signing-and-bootstrap.md'),
    'utf8',
  );
  const bootstrapProse = bootstrap.replace(/\s+/g, ' ');
  const migrate = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/MIGRATE-TO-NEW-PHONE.md'),
    'utf8',
  );
  const devLoop = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/DEV-LOOP.md'),
    'utf8',
  );
  assert.match(bootstrapProse, /Create the keystore once[\s\S]*preserve it for every later build/);
  assert.match(bootstrapProse, /encrypted offline backup/);
  assert.match(bootstrapProse, /Losing this identity prevents ordinary in-place updates/);
  assert.match(bootstrap, /extract-phone-bootstrap-apk[.]py/);
  assert.match(bootstrap, /adb install --no-streaming/);
  assert.match(bootstrapProse, /Whenever a Play Protect scan is offered or recommended,[\s\S]*take the scan path/);
  assert.match(bootstrapProse, /Never choose install-without-scanning/);
  assert.match(
    bootstrap,
    /if ! cmp -s[\s\S]*installed APK does not match the verified release[\s\S]*exit 1[\s\S]*adb shell am start/,
  );
  assert.match(bootstrap, /deploy-phone-release[.]sh "\$EVOGENT_RELEASE_ARCHIVE"/);
  assert.match(bootstrapProse, /same archive—not a rebuilt or similarly named one/);
  assert.match(migrate, /phone-signing-and-bootstrap[.]md/);
  assert.match(devLoop, /phone-signing-and-bootstrap[.]md/);
});

test('rollback restoration keeps Android foreground-action guidance visible', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const attester = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/attest-install-review.py'),
    'utf8',
  );
  const provisioning = fs.readFileSync(
    path.join(root, 'docs/phone-installation-and-provisioning.md'),
    'utf8',
  ).replace(/\s+/g, ' ');
  assert.doesNotMatch(
    installer,
    /apk_rollback_retry_pending|begin_fresh_rollback_install_retry|retry_pending_rollback_install_review|cmd package install[^\n]*\s-d(?:\s|")|install_apk "\$APK_BACKUP" fallback/,
  );
  assert.match(
    installer,
    /reconcile_successful_android_install_foreground\(\)[\s\S]*persist_and_wait_android_install_review/,
  );
  assert.match(
    installer,
    /complete_native_apk_rollback_operation\(\)[\s\S]*persist_restored_apk_review[\s\S]*persist_and_wait_android_install_review/,
  );
  assert.match(
    installer,
    /read_install_review_attestation[\s\S]*write_transaction_journal "\$prior_phase"[\s\S]*Fresh display-0 operator attestation accepted/,
  );
  assert.match(attester, /--fresh-display-0/);
  assert.match(
    attester,
    /trusted == 1 and outcome != "scan-completed"/,
  );
  assert.match(
    provisioning,
    /foreground disappearing,[\s\S]*none is authority to continue/,
  );
  assert.match(
    provisioning,
    /`no-scan-offered` is rejected and only `scan-completed`/,
  );
  assert.match(
    installer,
    /PACKAGE_OPERATION_STATE=launched[\s\S]*write_transaction_journal[\s\S]*Android PackageInstaller session/,
  );
  assert.match(
    provisioning,
    /crossed its durable launch fence[\s\S]*manual and inert/,
  );
  assert.match(
    provisioning,
    /never initiates a downgrade or fallback reinstall/,
  );
  assert.match(
    provisioning,
    /Agent-assisted stock Android[\s\S]*Current path[\s\S]*Managed fleet[\s\S]*Roadmap/,
  );
});
