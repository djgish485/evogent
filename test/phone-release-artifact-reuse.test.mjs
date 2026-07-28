import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const builderPath = path.join(root, 'scripts/build-phone-release.sh');
const builder = fs.readFileSync(builderPath, 'utf8');
const provenanceMarker = '# EVOGENT_ANDROID_ARTIFACT_PROVENANCE_HELPER_V1\n';
const helperStart = builder.indexOf(provenanceMarker);
const helperEnd = builder.indexOf('\nPY\n}', helperStart);
assert.notEqual(helperStart, -1);
assert.notEqual(helperEnd, -1);
const provenanceHelper = builder.slice(helperStart, helperEnd);

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runHelper(...args) {
  return spawnSync('python3', ['-', ...args], {
    encoding: 'utf8',
    input: provenanceHelper,
  });
}

function privateTemp(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function writeFileWithMode(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  fs.writeFileSync(file, data, { mode });
  fs.chmodSync(file, mode);
}

function createReleaseArchive({
  fixture,
  repo = root,
  sourceCommit = git(repo, 'rev-parse', 'HEAD'),
  provenance,
} = {}) {
  const base = fixture ?? privateTemp('evogent-reuse-release-');
  const container = path.join(base, 'contents');
  const release = path.join(container, 'release');
  fs.mkdirSync(release, { mode: 0o700, recursive: true });
  fs.chmodSync(release, 0o700);

  const apk = Buffer.from('synthetic-apk-artifact\n');
  const certificate = Buffer.from('synthetic-server-certificate\n');
  const key = Buffer.from('synthetic-server-private-key\n');
  const runtime = Buffer.from('synthetic-runtime\n');
  const files = new Map([
    ['apk/evogent.apk', { data: apk, mode: 0o600 }],
    ['runtime/server.js', { data: runtime, mode: 0o600 }],
    ['tls/server-cert.pem', { data: certificate, mode: 0o644 }],
    ['tls/server-key.pem', { data: key, mode: 0o600 }],
  ]);
  for (const [relative, entry] of files) {
    writeFileWithMode(path.join(release, relative), entry.data, entry.mode);
  }

  const inventory = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relative, entry]) => `${sha256(entry.data)}  ${relative}`)
    .join('\n') + '\n';
  const links = '{}\n';
  const apkSha256 = sha256(apk);
  const certificateDerSha256 = sha256('synthetic-certificate-der');
  const versionCode = 123456789;
  const identity = sha256(
    `apk-sha256:${apkSha256}\n`
      + `tls-cert-der-sha256:${certificateDerSha256}\n`,
  ).slice(0, 12);
  const releaseId = `${sourceCommit.slice(0, 12)}-fixture-apk${versionCode}-${identity}`;
  const manifest = {
    schema: 'evogent.phone.release.v1',
    releaseFormat: 1,
    releaseId,
    releaseIdentityDigest: identity,
    source: {
      commit: sourceCommit,
      commitShort: sourceCommit.slice(0, 12),
    },
    android: {
      package: 'net.dangish.evogent',
      versionCode,
      versionName: '0.3.0',
      signerSha256: sha256('synthetic-signer'),
      sha256: apkSha256,
    },
    phoneTls: {
      host: '127.0.0.1',
      port: 3443,
      certificateDerSha256,
      certificateNotAfter: 'Jan 1 00:00:00 2035 GMT',
    },
    inventory: {
      algorithm: 'sha256',
      path: 'files.sha256',
      sha256: sha256(inventory),
      linksPath: 'links.json',
      linksSha256: sha256(links),
    },
  };
  if (provenance !== undefined) manifest.artifactProvenance = provenance;
  writeFileWithMode(
    path.join(release, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  writeFileWithMode(path.join(release, 'files.sha256'), inventory, 0o600);
  writeFileWithMode(path.join(release, 'links.json'), links, 0o600);

  const archive = path.join(base, 'prior-release.tar.gz');
  const pack = () => {
    execFileSync(
      'tar',
      ['-czf', archive, '-C', container, 'release'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'pipe' },
    );
    fs.chmodSync(archive, 0o600);
    const archiveDigest = sha256(fs.readFileSync(archive));
    fs.writeFileSync(
      `${archive}.sha256`,
      `${archiveDigest}  ${path.basename(archive)}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(`${archive}.sha256`, 0o600);
  };
  pack();
  return {
    apk,
    archive,
    base,
    certificate,
    key,
    manifest,
    pack,
    release,
  };
}

test('release builder makes Android/TLS artifact reuse explicit and side-effect free', () => {
  assert.match(
    builder,
    /EVOGENT_REUSE_ANDROID_TLS_FROM_RELEASE/,
  );
  assert.match(
    builder,
    /an Android version override cannot accompany exact artifact reuse/,
  );
  assert.match(
    builder,
    /if \[ -n "\$REUSE_ANDROID_TLS_ARCHIVE" \]; then[\s\S]*?stage-reuse[\s\S]*?else\n  ANDROID_VERSION_STATE_FILE=[\s\S]*?allocate-android-version-code\.py[\s\S]*?\nfi\n\necho "phone release: building web application/,
  );
  assert.match(
    builder,
    /if \[ -n "\$REUSE_ANDROID_TLS_ARCHIVE" \]; then\n  echo "phone release: reusing verified Android\/TLS artifact[\s\S]*?else[\s\S]*?bash android-shell\/build\.sh/,
  );
  assert.doesNotMatch(builder, /echo[^\n]*REUSE_ANDROID_TLS_ARCHIVE/);
  assert.match(
    builder,
    /"schema": "evogent\.android-tls\.artifact-provenance\.v1"/,
  );
  assert.match(builder, /"originReleaseId": "\$ANDROID_TLS_ORIGIN_RELEASE_ID"/);
  assert.match(builder, /"path": "android-shell"/);
});

test('reuse branch invokes neither allocator, signer build, nor Python fallback', (t) => {
  const fixture = privateTemp('evogent-reuse-flow-');
  t.after(() => fs.rmSync(fixture, { force: true, recursive: true }));
  const trace = path.join(fixture, 'trace');
  const flowStart = builder.indexOf(
    'REUSE_ANDROID_TLS_ARCHIVE="${EVOGENT_REUSE_ANDROID_TLS_FROM_RELEASE:-}"',
  );
  const flowEnd = builder.indexOf(
    '\n# A build script must not be able to quietly edit the source',
    flowStart,
  );
  assert.ok(flowStart > 0 && flowEnd > flowStart);
  const flow = builder.slice(flowStart, flowEnd);
  const harness = `
set -euo pipefail
WORK_DIR="$1"
TRACE="$2"
ROOT=/synthetic/source
SOURCE_COMMIT=${'1'.repeat(40)}
SOURCE_SHORT=${'1'.repeat(12)}
ANDROID_SOURCE_TREE_OID=${'2'.repeat(40)}
EVOGENT_REUSE_ANDROID_TLS_FROM_RELEASE=/synthetic/private/prior.tar.gz
unset EVOGENT_ANDROID_VERSION_CODE
android_artifact_provenance() {
  case "$1" in
    stage-reuse)
      mkdir -p "$5/artifacts"
      ;;
    metadata)
      case "$3" in
        versionCode) printf '123456789\\n' ;;
        package) printf 'net.dangish.evogent\\n' ;;
        versionName) printf '0.3.0\\n' ;;
        signerSha256|apkSha256|tlsCertificateDerSha256) printf '%064d\\n' 0 ;;
        originReleaseId|priorReleaseId) printf 'origin-release\\n' ;;
        originSourceCommit) printf '%040d\\n' 1 ;;
        originSourceTreeOid) printf '%040d\\n' 2 ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}
npm() { printf 'npm:%s\\n' "$*" >> "$TRACE"; }
python3() { printf 'python3:%s\\n' "$*" >> "$TRACE"; return 97; }
bash() { printf 'bash:%s\\n' "$*" >> "$TRACE"; return 98; }
${flow}
`;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'reuse-flow', fixture, trace],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'npm:run build\n');
});

test('legacy trusted release stages the exact inseparable APK/TLS artifact set', (t) => {
  const fixture = createReleaseArchive();
  t.after(() => fs.rmSync(fixture.base, { force: true, recursive: true }));
  const stage = path.join(fixture.base, 'staged');
  const result = runHelper(
    'stage-reuse',
    root,
    git(root, 'rev-parse', 'HEAD'),
    fixture.archive,
    stage,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readFileSync(path.join(stage, 'artifacts/evogent.apk')),
    fixture.apk,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(stage, 'artifacts/server-cert.pem')),
    fixture.certificate,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(stage, 'artifacts/server-key.pem')),
    fixture.key,
  );
  const metadataText = fs.readFileSync(path.join(stage, 'metadata.json'), 'utf8');
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.priorReleaseId, fixture.manifest.releaseId);
  assert.equal(metadata.originReleaseId, fixture.manifest.releaseId);
  assert.equal(metadata.originSourceCommit, fixture.manifest.source.commit);
  assert.equal(
    metadata.originSourceTreeOid,
    git(root, 'rev-parse', `${fixture.manifest.source.commit}:android-shell`),
  );
  assert.equal(metadataText.includes(fixture.archive), false);
});

test('declared built provenance is checked against its exact Git tree', (t) => {
  const commit = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', `${commit}:android-shell`);
  const fixture = createReleaseArchive({
    sourceCommit: commit,
    provenance: {
      androidTls: {
        schema: 'evogent.android-tls.artifact-provenance.v1',
        mode: 'built',
        originReleaseId: 'placeholder',
        sourceCommit: commit,
        sourceTree: { path: 'android-shell', oid: tree },
      },
    },
  });
  t.after(() => fs.rmSync(fixture.base, { force: true, recursive: true }));
  const manifestPath = path.join(fixture.release, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.artifactProvenance.androidTls.originReleaseId = manifest.releaseId;
  writeFileWithMode(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  fixture.pack();
  let result = runHelper(
    'stage-reuse',
    root,
    commit,
    fixture.archive,
    path.join(fixture.base, 'valid-stage'),
  );
  assert.equal(result.status, 0, result.stderr);

  manifest.artifactProvenance.androidTls.sourceTree.oid = '0'.repeat(40);
  writeFileWithMode(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  fixture.pack();
  result = runHelper(
    'stage-reuse',
    root,
    commit,
    fixture.archive,
    path.join(fixture.base, 'invalid-stage'),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provenance is inconsistent/);
});

test('reused provenance binds its origin release to the source and artifact identity', (t) => {
  const commit = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', `${commit}:android-shell`);
  const fixture = createReleaseArchive({ sourceCommit: commit });
  t.after(() => fs.rmSync(fixture.base, { force: true, recursive: true }));
  const manifestPath = path.join(fixture.release, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.artifactProvenance = {
    androidTls: {
      schema: 'evogent.android-tls.artifact-provenance.v1',
      mode: 'reused',
      originReleaseId: `${commit.slice(0, 12)}-origin-apk`
        + `${manifest.android.versionCode}-${manifest.releaseIdentityDigest}`,
      sourceCommit: commit,
      sourceTree: { path: 'android-shell', oid: tree },
    },
  };
  writeFileWithMode(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  fixture.pack();
  let result = runHelper(
    'stage-reuse',
    root,
    commit,
    fixture.archive,
    path.join(fixture.base, 'valid-stage'),
  );
  assert.equal(result.status, 0, result.stderr);

  manifest.artifactProvenance.androidTls.originReleaseId = 'false-origin';
  writeFileWithMode(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  fixture.pack();
  result = runHelper(
    'stage-reuse',
    root,
    commit,
    fixture.archive,
    path.join(fixture.base, 'invalid-stage'),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /origin identity is inconsistent/);
});

test('reuse rejects changed Android inputs even when runtime source can advance', (t) => {
  const base = privateTemp('evogent-reuse-source-');
  t.after(() => fs.rmSync(base, { force: true, recursive: true }));
  const repo = path.join(base, 'source');
  fs.mkdirSync(path.join(repo, 'android-shell'), { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(repo, 'android-shell/native.txt'), 'first\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync(
    'git',
    ['config', 'user.email', 'release-test@example.invalid'],
    { cwd: repo },
  );
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'first'], { cwd: repo });
  const priorCommit = git(repo, 'rev-parse', 'HEAD');
  const fixture = createReleaseArchive({
    fixture: path.join(base, 'prior'),
    repo,
    sourceCommit: priorCommit,
  });
  fs.writeFileSync(path.join(repo, 'android-shell/native.txt'), 'second\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'second'], { cwd: repo });
  const successorCommit = git(repo, 'rev-parse', 'HEAD');

  const result = runHelper(
    'stage-reuse',
    repo,
    successorCommit,
    fixture.archive,
    path.join(base, 'stage'),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Android source inputs changed/);
});

test('reuse rejects archive, inventory, path, and permission tampering', async (t) => {
  await t.test('archive bytes no longer match the private sidecar', (subtest) => {
    const fixture = createReleaseArchive();
    subtest.after(() => fs.rmSync(fixture.base, { force: true, recursive: true }));
    fs.appendFileSync(fixture.archive, 'tamper');
    const result = runHelper(
      'stage-reuse',
      root,
      git(root, 'rev-parse', 'HEAD'),
      fixture.archive,
      path.join(fixture.base, 'stage'),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum does not match/);
    assert.equal(result.stderr.includes(fixture.archive), false);
  });

  await t.test('full release inventory detects changed content', (subtest) => {
    const fixture = createReleaseArchive();
    subtest.after(() => fs.rmSync(fixture.base, { force: true, recursive: true }));
    fs.writeFileSync(
      path.join(fixture.release, 'runtime/server.js'),
      'changed-after-inventory\n',
    );
    fs.chmodSync(path.join(fixture.release, 'runtime/server.js'), 0o600);
    fixture.pack();
    const result = runHelper(
      'stage-reuse',
      root,
      git(root, 'rev-parse', 'HEAD'),
      fixture.archive,
      path.join(fixture.base, 'stage'),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match its inventory/);
  });

  await t.test('symlink input cannot redirect the trusted archive', (subtest) => {
    const fixture = createReleaseArchive();
    subtest.after(() => fs.rmSync(fixture.base, { force: true, recursive: true }));
    const linked = path.join(fixture.base, 'linked-release.tar.gz');
    fs.symlinkSync(path.basename(fixture.archive), linked);
    const result = runHelper(
      'stage-reuse',
      root,
      git(root, 'rev-parse', 'HEAD'),
      linked,
      path.join(fixture.base, 'stage'),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical|symlink/);
  });

  await t.test('group-readable input is not a private recovery artifact', (subtest) => {
    const fixture = createReleaseArchive();
    subtest.after(() => fs.rmSync(fixture.base, { force: true, recursive: true }));
    fs.chmodSync(fixture.archive, 0o640);
    const result = runHelper(
      'stage-reuse',
      root,
      git(root, 'rev-parse', 'HEAD'),
      fixture.archive,
      path.join(fixture.base, 'stage'),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be private, owned, and regular/);
  });

  await t.test('archive traversal is rejected before metadata use', (subtest) => {
    const base = privateTemp('evogent-reuse-traversal-');
    subtest.after(() => fs.rmSync(base, { force: true, recursive: true }));
    const archive = path.join(base, 'unsafe-release.tar.gz');
    const script = `
import io
import tarfile
import sys
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    payload = b"escape"
    member = tarfile.TarInfo("../escape")
    member.mode = 0o600
    member.size = len(payload)
    bundle.addfile(member, io.BytesIO(payload))
`;
    execFileSync('python3', ['-c', script, archive]);
    fs.chmodSync(archive, 0o600);
    fs.writeFileSync(
      `${archive}.sha256`,
      `${sha256(fs.readFileSync(archive))}  ${path.basename(archive)}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(`${archive}.sha256`, 0o600);
    const result = runHelper(
      'stage-reuse',
      root,
      git(root, 'rev-parse', 'HEAD'),
      archive,
      path.join(base, 'stage'),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe member/);
  });
});
