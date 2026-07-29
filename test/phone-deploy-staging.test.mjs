import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const deployScript = path.join(root, 'scripts/deploy-phone-release.sh');

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

function createHarness() {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-deploy-staging-'),
  );
  const bin = path.join(fixture, 'bin');
  const remoteHome = path.join(fixture, 'remote-home');
  const artifacts = path.join(fixture, 'artifacts');
  const localTmp = path.join(fixture, 'local-tmp');
  fs.mkdirSync(bin);
  fs.mkdirSync(remoteHome);
  fs.mkdirSync(artifacts);
  fs.mkdirSync(localTmp);

  executable(
    path.join(bin, 'adb'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DEPLOY_ADB_LOG"
if [[ "$*" == *" forward --list" ]] && [ -n "\${DEPLOY_ADB_EXISTING_ENDPOINT:-}" ]; then
  printf 'TEST-SERIAL %s tcp:8022\\n' "$DEPLOY_ADB_EXISTING_ENDPOINT"
fi
if [[ "$*" == *" forward --no-rebind "* ]] && [ "\${DEPLOY_ADB_FORWARD_FAIL:-0}" = 1 ]; then
  exit 1
fi
`,
  );
  executable(
    path.join(bin, 'ssh'),
    `#!/usr/bin/env python3
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time


arguments = sys.argv[1:]
index = 0
while index < len(arguments):
    argument = arguments[index]
    if argument in {"-p", "-o"}:
        index += 2
    elif argument.startswith("-"):
        index += 1
    else:
        index += 1
        break
command = " ".join(arguments[index:])
home = pathlib.Path(os.environ["FAKE_REMOTE_HOME"])
environment = dict(os.environ)
environment["HOME"] = str(home)
payload = sys.stdin.buffer.read()

mutate_source = os.environ.get("DEPLOY_MUTATE_SOURCE")
if mutate_source:
    with open(mutate_source, "ab") as changed:
        changed.write(b"changed-after-snapshot\\n")

if os.environ.get("DEPLOY_LOCAL_CLEANUP_BLOCKER") == "1":
    temporary_root = pathlib.Path(os.environ["TMPDIR"])
    for staging in temporary_root.glob("evogent-phone-deploy.*"):
        (staging / "cleanup-blocker").write_text(
            "retain\\n",
            encoding="utf-8",
        )


def frame_parts(data):
    length_end = data.index(b"\\n")
    source_length = int(data[:length_end])
    source_end = length_end + 1 + source_length
    header_end = data.index(b"\\n", source_end) + 1
    header = json.loads(data[source_end:header_end])
    return source_end, header_end, header


source_end, header_end, header = frame_parts(payload)
replacement_sidecar = os.environ.get("DEPLOY_REPLACE_SIDECAR")
if replacement_sidecar:
    replacement = pathlib.Path(replacement_sidecar).read_bytes()
    archive_end = header_end + header["archiveSize"]
    header["sidecarSize"] = len(replacement)
    encoded_header = (
        json.dumps(header, separators=(",", ":"), sort_keys=True).encode("ascii")
        + b"\\n"
    )
    payload = (
        payload[:source_end]
        + encoded_header
        + payload[header_end:archive_end]
        + replacement
    )
    header_end = source_end + len(encoded_header)

incoming = home / ".cache" / "evogent-release-incoming"
existing = set(incoming.glob("deploy.*")) if incoming.exists() else set()
pause_for_hook = any(
    os.environ.get(name)
    for name in (
        "DEPLOY_ABANDON_UPLOAD",
        "DEPLOY_FAIL_SIDECAR_UPLOAD",
        "DEPLOY_PREPLANT_BOOTSTRAP",
        "DEPLOY_PREPLANT_FINAL_SYMLINK",
        "DEPLOY_SWAP_CACHE",
        "DEPLOY_UPLOAD_SIGNAL",
    )
)


def normalized(returncode):
    return returncode if returncode >= 0 else 128 - returncode


if not pause_for_hook:
    with tempfile.TemporaryFile() as framed:
        framed.write(payload)
        framed.seek(0)
        completed = subprocess.run(
            command,
            shell=True,
            executable="/bin/bash",
            cwd=home,
            env=environment,
            stdin=framed,
            check=False,
        )
    raise SystemExit(normalized(completed.returncode))

process = subprocess.Popen(
    command,
    shell=True,
    executable="/bin/bash",
    cwd=home,
    env=environment,
    stdin=subprocess.PIPE,
)
process.stdin.write(payload[:header_end])
process.stdin.flush()
leaf = None
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    candidates = (
        set(incoming.glob("deploy.*")) - existing
        if incoming.exists()
        else set()
    )
    for candidate in candidates:
        if (candidate / "deploy-metadata.json").is_file():
            leaf = candidate
            break
    if leaf is not None:
        break
    if process.poll() is not None:
        break
    time.sleep(0.002)

if leaf is None:
    process.stdin.close()
    raise SystemExit(normalized(process.wait()))

if os.environ.get("DEPLOY_ABANDON_UPLOAD") == "1":
    process.kill()
    process.wait()
    os.kill(os.getppid(), signal.SIGKILL)
    os._exit(137)

if os.environ.get("DEPLOY_FAIL_SIDECAR_UPLOAD") == "1":
    process.send_signal(signal.SIGTERM)
    process.stdin.close()
    raise SystemExit(normalized(process.wait()))

if os.environ.get("DEPLOY_PREPLANT_FINAL_SYMLINK") == "1":
    os.symlink(
        os.environ["DEPLOY_OUTSIDE_FILE"],
        leaf / os.environ["DEPLOY_TEST_ARCHIVE_NAME"],
    )

if os.environ.get("DEPLOY_PREPLANT_BOOTSTRAP") == "1":
    bootstrap = leaf / "install-release.sh"
    bootstrap.write_text(
        "#!/usr/bin/env bash\\nprintf 'mixed-bootstrap\\\\n' >> "
        "\\"$DEPLOY_INSTALL_LOG\\"\\n",
        encoding="utf-8",
    )
    bootstrap.chmod(0o700)

if os.environ.get("DEPLOY_SWAP_CACHE") == "1":
    anchored = home / ".cache-anchored"
    os.rename(home / ".cache", anchored)
    os.symlink(os.environ["DEPLOY_SWAP_OUTSIDE"], home / ".cache")

upload_signal = os.environ.get("DEPLOY_UPLOAD_SIGNAL")
if upload_signal:
    os.kill(os.getppid(), getattr(signal, f"SIG{upload_signal}"))

try:
    process.stdin.write(payload[header_end:])
    process.stdin.close()
except BrokenPipeError:
    pass
raise SystemExit(normalized(process.wait()))
`,
  );
  executable(
    path.join(bin, 'scp'),
    `#!/usr/bin/env bash
set -euo pipefail
arguments=("$@")
index=0
while [ "$index" -lt "\${#arguments[@]}" ]; do
  argument="\${arguments[$index]}"
  case "$argument" in
    -P|-o)
      index=$((index + 2))
      ;;
    -*)
      index=$((index + 1))
      ;;
    *)
      break
      ;;
  esac
done
source_path="\${arguments[$index]}"
index=$((index + 1))
remote_spec="\${arguments[$index]}"
remote_path="\${remote_spec#*:}"
destination="$FAKE_REMOTE_HOME/$remote_path"
mkdir -p "$(dirname "$destination")"

if [[ "$destination" == *.tar.gz.partial ]] && [ "\${DEPLOY_ABANDON_UPLOAD:-0}" = 1 ]; then
  kill -KILL "$PPID"
  exit 0
fi

if [[ "$destination" == *.tar.gz.partial ]] && [ -n "\${DEPLOY_UPLOAD_SIGNAL:-}" ]; then
  kill -s "$DEPLOY_UPLOAD_SIGNAL" "$PPID"
  exit 0
fi

if [[ "$destination" == *.tar.gz.sha256.partial ]] && [ "\${DEPLOY_FAIL_SIDECAR_UPLOAD:-0}" = 1 ]; then
  exit 75
fi

if [[ "$destination" == *.tar.gz.partial ]] && [ -n "\${DEPLOY_MUTATE_SOURCE:-}" ]; then
  printf 'changed-after-snapshot\\n' >> "$DEPLOY_MUTATE_SOURCE"
fi

cp "$source_path" "$destination"
chmod 600 "$destination"
printf '%s\\t%s\\n' "$source_path" "$remote_path" >> "$DEPLOY_SCP_LOG"

if [[ "$destination" == *.tar.gz.sha256.partial ]] && [ -n "\${DEPLOY_REPLACE_SIDECAR:-}" ]; then
  cp "$DEPLOY_REPLACE_SIDECAR" "$destination"
  chmod 600 "$destination"
fi

if [[ "$destination" == *.tar.gz.partial ]] && [ "\${DEPLOY_PREPLANT_FINAL_SYMLINK:-0}" = 1 ]; then
  final_path="\${destination%.partial}"
  ln -s "$DEPLOY_OUTSIDE_FILE" "$final_path"
fi

if [[ "$destination" == *.tar.gz.partial ]] && [ "\${DEPLOY_PREPLANT_BOOTSTRAP:-0}" = 1 ]; then
  bootstrap="$(dirname "$destination")/install-release.sh"
  printf '#!/usr/bin/env bash\\nprintf "mixed-bootstrap\\\\n" >> "$DEPLOY_INSTALL_LOG"\\n' > "$bootstrap"
  chmod 700 "$bootstrap"
fi
`,
  );

  const env = {
    ...process.env,
    DEPLOY_ADB_LOG: path.join(fixture, 'adb.log'),
    DEPLOY_INSTALL_LOG: path.join(fixture, 'install.log'),
    DEPLOY_SCP_LOG: path.join(fixture, 'scp.log'),
    EVOGENT_ADB_SERIAL: 'TEST-SERIAL',
    EVOGENT_SSH_PORT: '2222',
    EVOGENT_SSH_USER: 'test-user',
    FAKE_REMOTE_HOME: remoteHome,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: localTmp,
  };
  return {
    artifacts,
    env,
    fixture,
    localTmp,
    remoteHome,
  };
}

function createRelease(harness, name, marker) {
  const staging = path.join(harness.fixture, `bundle-${marker}`);
  const device = path.join(staging, 'release', 'device');
  fs.mkdirSync(device, { recursive: true });
  executable(
    path.join(device, 'install-release.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\t%s\\n' '${marker}' "$PWD" "$*" >> "$DEPLOY_INSTALL_LOG"
if [ -n "\${DEPLOY_REMOTE_INSTALL_SIGNAL:-}" ]; then
  kill -s "$DEPLOY_REMOTE_INSTALL_SIGNAL" "$PPID"
fi
if [ -n "\${DEPLOY_INSTALL_PAUSE:-}" ]; then
  sleep "$DEPLOY_INSTALL_PAUSE"
fi
if [ "\${DEPLOY_INSTALL_CLEANUP_BLOCKER:-0}" = 1 ]; then
  mkdir "cleanup-blocker"
fi
[ "\${DEPLOY_INSTALL_FAIL:-0}" != 1 ]
`,
  );
  const archive = path.join(harness.artifacts, name);
  const made = spawnSync(
    'tar',
    ['-czf', archive, '-C', staging, 'release'],
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, made.stderr);
  fs.chmodSync(archive, 0o600);
  const digest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archive))
    .digest('hex');
  const sidecar = `${archive}.sha256`;
  fs.writeFileSync(sidecar, `${digest}  ${path.basename(archive)}\n`, {
    mode: 0o600,
  });
  return { archive, digest, sidecar };
}

function deploy(harness, release, args = [], env = {}) {
  return spawnSync('bash', [deployScript, ...args, release.archive], {
    encoding: 'utf8',
    env: {
      ...harness.env,
      DEPLOY_TEST_ARCHIVE_NAME: path.basename(release.archive),
      ...env,
    },
  });
}

function deployAsync(harness, release, args = [], env = {}) {
  const child = spawn('bash', [deployScript, ...args, release.archive], {
    env: {
      ...harness.env,
      DEPLOY_TEST_ARCHIVE_NAME: path.basename(release.archive),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      resolve({ signal, status, stderr, stdout });
    });
  });
}

function incomingRoot(harness) {
  return path.join(
    harness.remoteHome,
    '.cache',
    'evogent-release-incoming',
  );
}

function incomingEntries(harness) {
  const incoming = incomingRoot(harness);
  return fs.existsSync(incoming) ? fs.readdirSync(incoming).sort() : [];
}

function writeStagingMetadata(directory, leaf, archiveName, createdAt) {
  const metadata = path.join(directory, 'deploy-metadata.json');
  fs.writeFileSync(
    metadata,
    `${JSON.stringify({
      archiveBasename: archiveName,
      createdAt,
      leaf,
      schema: 'evogent.phone.deploy-staging.v1',
    })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(metadata, 0o600);
  return metadata;
}

function createStagingLeaf(
  harness,
  leaf,
  archiveName,
  createdAt,
  entryNames = [],
) {
  const directory = path.join(incomingRoot(harness), leaf);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const metadata = writeStagingMetadata(
    directory,
    leaf,
    archiveName,
    createdAt,
  );
  const entries = [];
  for (const name of entryNames) {
    const entry = path.join(directory, name);
    fs.writeFileSync(entry, `${name}\n`, { mode: 0o600 });
    fs.chmodSync(entry, 0o600);
    entries.push(entry);
  }
  return { directory, entries, metadata };
}

function ageStagingLeaf(staging, milliseconds) {
  const timestamp = new Date(Date.now() - milliseconds);
  for (const entry of [staging.metadata, ...staging.entries]) {
    fs.utimesSync(entry, timestamp, timestamp);
  }
  fs.utimesSync(staging.directory, timestamp, timestamp);
}

function createCleanupSiblings(harness, leaf) {
  const localSibling = path.join(
    harness.localTmp,
    'evogent-phone-deploy.sibling',
  );
  fs.mkdirSync(localSibling);
  fs.writeFileSync(path.join(localSibling, 'sentinel'), 'keep-local\n');
  const remoteSibling = path.join(
    harness.remoteHome,
    '.cache',
    'evogent-release-incoming',
    leaf,
  );
  fs.mkdirSync(remoteSibling, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(remoteSibling, 'sentinel'), 'keep-remote\n');
  return { localSibling, remoteSibling };
}

test('deployer owns one collision-free ADB forward and removes it', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-forward-lifecycle.tar.gz',
    'forward-lifecycle',
  );

  const result = deploy(harness, release);
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(harness.env.DEPLOY_ADB_LOG, 'utf8')
    .trim()
    .split('\n');
  assert.deepEqual(calls, [
    '-s TEST-SERIAL forward --list',
    '-s TEST-SERIAL forward --no-rebind tcp:2222 tcp:8022',
    '-s TEST-SERIAL forward --remove tcp:2222',
  ]);

  fs.rmSync(harness.env.DEPLOY_ADB_LOG);
  const collision = deploy(harness, release, [], {
    DEPLOY_ADB_EXISTING_ENDPOINT: 'tcp:2222',
  });
  assert.equal(collision.status, 73);
  assert.match(collision.stderr, /configured SSH port is already forwarded/);
  assert.deepEqual(
    fs.readFileSync(harness.env.DEPLOY_ADB_LOG, 'utf8').trim().split('\n'),
    ['-s TEST-SERIAL forward --list'],
  );

  fs.rmSync(harness.env.DEPLOY_ADB_LOG);
  const raced = deploy(harness, release, [], {
    DEPLOY_ADB_FORWARD_FAIL: '1',
  });
  assert.equal(raced.status, 69);
  assert.match(raced.stderr, /device forwarding failed/);
  assert.deepEqual(
    fs.readFileSync(harness.env.DEPLOY_ADB_LOG, 'utf8').trim().split('\n'),
    [
      '-s TEST-SERIAL forward --list',
      '-s TEST-SERIAL forward --no-rebind tcp:2222 tcp:8022',
    ],
  );
});

test('deploy rejects local symlinks and multiply-linked artifacts before transport', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-local-guard.tar.gz',
    'local-guard',
  );

  const archiveLink = path.join(harness.artifacts, 'archive-link.tar.gz');
  fs.symlinkSync(release.archive, archiveLink);
  fs.symlinkSync(release.sidecar, `${archiveLink}.sha256`);
  const linked = deploy(harness, { archive: archiveLink });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /local release artifacts were rejected/);
  assert.equal(fs.existsSync(harness.env.DEPLOY_ADB_LOG), false);

  const hardArchive = path.join(harness.artifacts, 'archive-hard.tar.gz');
  const hardSidecar = `${hardArchive}.sha256`;
  fs.linkSync(release.archive, hardArchive);
  fs.writeFileSync(
    hardSidecar,
    `${release.digest}  ${path.basename(hardArchive)}\n`,
    { mode: 0o600 },
  );
  const hardlinked = deploy(harness, { archive: hardArchive });
  assert.notEqual(hardlinked.status, 0);
  assert.match(hardlinked.stderr, /local release artifacts were rejected/);

  const cleanArchive = path.join(harness.artifacts, 'sidecar-hard.tar.gz');
  fs.copyFileSync(release.archive, cleanArchive);
  fs.chmodSync(cleanArchive, 0o600);
  const cleanSidecar = `${cleanArchive}.sha256`;
  fs.writeFileSync(
    cleanSidecar,
    `${release.digest}  ${path.basename(cleanArchive)}\n`,
    { mode: 0o600 },
  );
  fs.linkSync(cleanSidecar, `${cleanSidecar}.second-link`);
  const hardSidecarResult = deploy(harness, { archive: cleanArchive });
  assert.notEqual(hardSidecarResult.status, 0);
  assert.match(
    hardSidecarResult.stderr,
    /local release artifacts were rejected/,
  );
});

test('deploy uploads immutable snapshots when the caller source changes later', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-stable-snapshot.tar.gz',
    'stable-snapshot',
  );
  const before = release.digest;
  const result = deploy(harness, release, [], {
    DEPLOY_MUTATE_SOURCE: release.archive,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(
    crypto.createHash('sha256').update(fs.readFileSync(release.archive)).digest('hex'),
    before,
  );
  assert.match(
    fs.readFileSync(harness.env.DEPLOY_INSTALL_LOG, 'utf8'),
    /^stable-snapshot\t/,
  );
  assert.equal(fs.existsSync(harness.env.DEPLOY_SCP_LOG), false);
  assert.deepEqual(fs.readdirSync(harness.localTmp), []);
});

test('deploy rejects a symlinked remote incoming parent without touching its target', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-parent-symlink.tar.gz',
    'parent-symlink',
  );
  const outside = path.join(harness.fixture, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(harness.remoteHome, '.cache'));
  fs.symlinkSync(
    outside,
    path.join(
      harness.remoteHome,
      '.cache',
      'evogent-release-incoming',
    ),
  );
  const result = deploy(harness, release);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /remote staging directory was rejected/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('deploy refuses remote final-name collisions and does not follow symlinks', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-remote-collision.tar.gz',
    'remote-collision',
  );
  const outside = path.join(harness.fixture, 'outside-sentinel');
  fs.writeFileSync(outside, 'unchanged\n');
  const result = deploy(harness, release, [], {
    DEPLOY_OUTSIDE_FILE: outside,
    DEPLOY_PREPLANT_FINAL_SYMLINK: '1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /remote release staging was rejected/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged\n');
  assert.equal(fs.existsSync(harness.env.DEPLOY_INSTALL_LOG), false);
  assert.deepEqual(incomingEntries(harness), []);
});

test('one anchored remote process survives an intermediate cache-path swap', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-anchored-stream.tar.gz',
    'anchored-stream',
  );
  const outside = path.join(harness.fixture, 'redirect-target');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'outside\n');
  const result = deploy(harness, release, [], {
    DEPLOY_SWAP_CACHE: '1',
    DEPLOY_SWAP_OUTSIDE: outside,
  });
  assert.equal(result.status, 0, result.stderr);
  const cache = path.join(harness.remoteHome, '.cache');
  assert.equal(fs.lstatSync(cache).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(cache), fs.realpathSync(outside));
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  assert.equal(
    fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'),
    'outside\n',
  );
  assert.deepEqual(
    fs.readdirSync(path.join(
      harness.remoteHome,
      '.cache-anchored',
      'evogent-release-incoming',
    )),
    [],
  );
  assert.match(
    fs.readFileSync(harness.env.DEPLOY_INSTALL_LOG, 'utf8'),
    /^anchored-stream\t/,
  );
});

test('concurrent deployments remain isolated and forward mode is explicit', async () => {
  const harness = createHarness();
  const first = createRelease(
    harness,
    'evogent-phone-concurrent-one.tar.gz',
    'concurrent-one',
  );
  const second = createRelease(
    harness,
    'evogent-phone-concurrent-two.tar.gz',
    'concurrent-two',
  );
  const [firstResult, secondResult] = await Promise.all([
    deployAsync(harness, first, ['--forward-supersede'], {
      DEPLOY_INSTALL_PAUSE: '0.2',
    }),
    deployAsync(harness, second, [], { DEPLOY_INSTALL_PAUSE: '0.2' }),
  ]);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);

  const records = fs
    .readFileSync(harness.env.DEPLOY_INSTALL_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split('\t'));
  assert.equal(records.length, 2);
  const byMarker = new Map(records.map((record) => [record[0], record]));
  assert.notEqual(byMarker.get('concurrent-one')[1], byMarker.get('concurrent-two')[1]);
  assert.match(
    byMarker.get('concurrent-one')[2],
    /^--forward-supersede .*evogent-phone-concurrent-one\.tar\.gz [0-9a-f]{64}$/,
  );
  assert.match(
    byMarker.get('concurrent-two')[2],
    /^.*evogent-phone-concurrent-two\.tar\.gz [0-9a-f]{64}$/,
  );
  assert.doesNotMatch(
    byMarker.get('concurrent-two')[2],
    /--forward-supersede/,
  );
  assert.deepEqual(incomingEntries(harness), []);
});

test('reconciliation prunes only proven old staging and retains fresh work', () => {
  const harness = createHarness();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oldLeaf = 'deploy.5555555555555555';
  const oldArchive = 'old-release.tar.gz';
  const oldStaging = createStagingLeaf(
    harness,
    oldLeaf,
    oldArchive,
    nowSeconds - (8 * 24 * 60 * 60),
    [
      `${oldArchive}.partial`,
      `${oldArchive}.sha256.partial`,
      oldArchive,
      `${oldArchive}.sha256`,
    ],
  );
  ageStagingLeaf(oldStaging, 8 * 24 * 60 * 60 * 1000);

  const freshLeaf = 'deploy.6666666666666666';
  createStagingLeaf(
    harness,
    freshLeaf,
    'fresh-release.tar.gz',
    nowSeconds,
  );
  const release = createRelease(
    harness,
    'evogent-phone-reconcile.tar.gz',
    'reconcile',
  );
  const result = deploy(harness, release);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /stale remote staging entry was retained/);
  assert.deepEqual(incomingEntries(harness), [freshLeaf]);
});

test('a disconnected upload orphan is pruned only after it becomes old', () => {
  const harness = createHarness();
  const abandonedRelease = createRelease(
    harness,
    'evogent-phone-abandoned.tar.gz',
    'abandoned',
  );
  const abandoned = deploy(harness, abandonedRelease, [], {
    DEPLOY_ABANDON_UPLOAD: '1',
  });
  assert.equal(abandoned.status, null);
  assert.equal(abandoned.signal, 'SIGKILL');
  const [leaf] = incomingEntries(harness);
  assert.match(leaf, /^deploy\.[0-9a-f]{16}$/);
  const directory = path.join(incomingRoot(harness), leaf);
  const metadata = writeStagingMetadata(
    directory,
    leaf,
    path.basename(abandonedRelease.archive),
    Math.floor(Date.now() / 1000) - (8 * 24 * 60 * 60),
  );
  const entries = fs
    .readdirSync(directory)
    .filter((name) => name !== 'deploy-metadata.json')
    .map((name) => path.join(directory, name));
  ageStagingLeaf(
    { directory, entries, metadata },
    8 * 24 * 60 * 60 * 1000,
  );

  const nextRelease = createRelease(
    harness,
    'evogent-phone-after-abandon.tar.gz',
    'after-abandon',
  );
  const recovered = deploy(harness, nextRelease);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.doesNotMatch(
    recovered.stderr,
    /stale remote staging entry was retained/,
  );
  assert.deepEqual(incomingEntries(harness), []);
});

test('unsafe stale entries and future timestamps are retained with one warning', () => {
  const harness = createHarness();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oldSeconds = nowSeconds - (8 * 24 * 60 * 60);
  const oldMilliseconds = 8 * 24 * 60 * 60 * 1000;
  const outsideDirectory = path.join(harness.fixture, 'outside-staging');
  const outsideFile = path.join(harness.fixture, 'outside-file');
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(outsideDirectory, 'sentinel'), 'outside-dir\n');
  fs.writeFileSync(outsideFile, 'outside-file\n');
  fs.mkdirSync(incomingRoot(harness), { recursive: true });

  const symlinkLeaf = 'deploy.7777777777777777';
  fs.symlinkSync(
    outsideDirectory,
    path.join(incomingRoot(harness), symlinkLeaf),
  );

  const futureLeaf = 'deploy.8888888888888888';
  const futureStaging = createStagingLeaf(
    harness,
    futureLeaf,
    'future.tar.gz',
    nowSeconds + 3600,
  );
  const futureTime = new Date(Date.now() + (60 * 60 * 1000));
  fs.utimesSync(futureStaging.metadata, futureTime, futureTime);
  fs.utimesSync(futureStaging.directory, futureTime, futureTime);

  const unexpectedLeaf = 'deploy.9999999999999999';
  const unexpectedStaging = createStagingLeaf(
    harness,
    unexpectedLeaf,
    'unexpected.tar.gz',
    oldSeconds,
    ['unexpected-entry'],
  );
  ageStagingLeaf(unexpectedStaging, oldMilliseconds);

  const linkedLeaf = 'deploy.aaaaaaaaaaaaaaaa';
  const linkedArchive = 'linked.tar.gz';
  const linkedStaging = createStagingLeaf(
    harness,
    linkedLeaf,
    linkedArchive,
    oldSeconds,
    [`${linkedArchive}.partial`],
  );
  fs.linkSync(linkedStaging.entries[0], path.join(harness.fixture, 'linked-copy'));
  ageStagingLeaf(linkedStaging, oldMilliseconds);

  const entrySymlinkLeaf = 'deploy.bbbbbbbbbbbbbbbb';
  const entrySymlinkStaging = createStagingLeaf(
    harness,
    entrySymlinkLeaf,
    'entry-symlink.tar.gz',
    oldSeconds,
  );
  const entrySymlink = path.join(
    entrySymlinkStaging.directory,
    'entry-symlink.tar.gz.partial',
  );
  fs.symlinkSync(outsideFile, entrySymlink);
  ageStagingLeaf(entrySymlinkStaging, oldMilliseconds);

  const subdirectoryLeaf = 'deploy.cccccccccccccccc';
  const subdirectoryStaging = createStagingLeaf(
    harness,
    subdirectoryLeaf,
    'subdirectory.tar.gz',
    oldSeconds,
  );
  const unexpectedDirectory = path.join(
    subdirectoryStaging.directory,
    'subdirectory.tar.gz.partial',
  );
  fs.mkdirSync(unexpectedDirectory);
  subdirectoryStaging.entries.push(unexpectedDirectory);
  ageStagingLeaf(subdirectoryStaging, oldMilliseconds);

  const malformedLeaf = 'deploy.dddddddddddddddd';
  const malformedStaging = createStagingLeaf(
    harness,
    malformedLeaf,
    'malformed.tar.gz',
    oldSeconds,
  );
  fs.writeFileSync(malformedStaging.metadata, '{bad-json}\n', { mode: 0o600 });
  ageStagingLeaf(malformedStaging, oldMilliseconds);

  const release = createRelease(
    harness,
    'evogent-phone-unsafe-reconcile.tar.gz',
    'unsafe-reconcile',
  );
  const result = deploy(harness, release);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stderr.match(/stale remote staging entry was retained/g)?.length,
    1,
  );
  assert.deepEqual(incomingEntries(harness), [
    linkedLeaf,
    entrySymlinkLeaf,
    subdirectoryLeaf,
    malformedLeaf,
    symlinkLeaf,
    futureLeaf,
    unexpectedLeaf,
  ].sort());
  assert.equal(
    fs.readFileSync(path.join(outsideDirectory, 'sentinel'), 'utf8'),
    'outside-dir\n',
  );
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-file\n');
  assert.equal(
    fs.readFileSync(path.join(harness.fixture, 'linked-copy'), 'utf8'),
    `${linkedArchive}.partial\n`,
  );
});

test('failed deployment cleans only its unique directory and leaves stale siblings', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-cleanup-scope.tar.gz',
    'cleanup-scope',
  );
  const stale = path.join(
    harness.remoteHome,
    '.cache',
    'evogent-release-incoming',
    'deploy.aaaaaaaaaaaaaaaa',
  );
  fs.mkdirSync(stale, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stale, 'sentinel'), 'keep\n');
  const result = deploy(harness, release, [], { DEPLOY_INSTALL_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(stale, 'sentinel'), 'utf8'), 'keep\n');
  assert.deepEqual(incomingEntries(harness), ['deploy.aaaaaaaaaaaaaaaa']);
  assert.deepEqual(fs.readdirSync(harness.localTmp), []);

  const uploadHarness = createHarness();
  const uploadRelease = createRelease(
    uploadHarness,
    'evogent-phone-upload-cleanup.tar.gz',
    'upload-cleanup',
  );
  const uploadResult = deploy(uploadHarness, uploadRelease, [], {
    DEPLOY_FAIL_SIDECAR_UPLOAD: '1',
  });
  assert.notEqual(uploadResult.status, 0);
  assert.deepEqual(incomingEntries(uploadHarness), []);
  assert.deepEqual(fs.readdirSync(uploadHarness.localTmp), []);
});

test('cleanup failure preserves primary status and emits one generic warning', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-cleanup-warning.tar.gz',
    'cleanup-warning',
  );
  const result = deploy(harness, release, [], {
    DEPLOY_INSTALL_CLEANUP_BLOCKER: '1',
    DEPLOY_INSTALL_FAIL: '1',
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'phone deploy: staging cleanup was incomplete\n',
  );
  assert.doesNotMatch(result.stderr, /cleanup-warning|cleanup-blocker|deploy\./);
  const [leaf] = incomingEntries(harness);
  assert.match(leaf, /^deploy\.[0-9a-f]{16}$/);
  assert.deepEqual(
    fs.readdirSync(path.join(incomingRoot(harness), leaf)),
    ['cleanup-blocker'],
  );
});

test('local cleanup failure is silent except for one generic warning', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-local-cleanup-warning.tar.gz',
    'local-cleanup-warning',
  );
  const result = deploy(harness, release, [], {
    DEPLOY_LOCAL_CLEANUP_BLOCKER: '1',
  });
  assert.equal(result.status, 0);
  assert.equal(
    result.stderr,
    'phone deploy: staging cleanup was incomplete\n',
  );
  assert.doesNotMatch(
    result.stderr,
    /local-cleanup-warning|cleanup-blocker|evogent-phone-deploy\./,
  );
  const [staging] = fs.readdirSync(harness.localTmp);
  assert.match(staging, /^evogent-phone-deploy\./);
  assert.deepEqual(
    fs.readdirSync(path.join(harness.localTmp, staging)),
    ['cleanup-blocker'],
  );
});

test('upload signals keep conventional status and clean only this deployment', () => {
  for (const [signal, expectedStatus, leaf] of [
    ['HUP', 129, 'deploy.1111111111111111'],
    ['INT', 130, 'deploy.2222222222222222'],
    ['TERM', 143, 'deploy.3333333333333333'],
  ]) {
    const harness = createHarness();
    const release = createRelease(
      harness,
      `evogent-phone-upload-${signal.toLowerCase()}.tar.gz`,
      `upload-${signal.toLowerCase()}`,
    );
    const siblings = createCleanupSiblings(harness, leaf);
    const result = deploy(harness, release, [], {
      DEPLOY_UPLOAD_SIGNAL: signal,
    });
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(siblings.localSibling, 'sentinel'), 'utf8'),
      'keep-local\n',
    );
    assert.equal(
      fs.readFileSync(path.join(siblings.remoteSibling, 'sentinel'), 'utf8'),
      'keep-remote\n',
    );
    assert.deepEqual(fs.readdirSync(harness.localTmp), [
      'evogent-phone-deploy.sibling',
    ]);
    assert.deepEqual(incomingEntries(harness), [leaf]);
  }
});

test('remote installer signal exits nonzero and scopes both cleanup traps', () => {
  const harness = createHarness();
  const release = createRelease(
    harness,
    'evogent-phone-remote-signal.tar.gz',
    'remote-signal',
  );
  const leaf = 'deploy.4444444444444444';
  const siblings = createCleanupSiblings(harness, leaf);
  const result = deploy(harness, release, [], {
    DEPLOY_REMOTE_INSTALL_SIGNAL: 'TERM',
  });
  assert.equal(result.signal, null);
  assert.equal(result.status, 143, result.stderr);
  assert.match(
    fs.readFileSync(harness.env.DEPLOY_INSTALL_LOG, 'utf8'),
    /^remote-signal\t/,
  );
  assert.equal(
    fs.readFileSync(path.join(siblings.localSibling, 'sentinel'), 'utf8'),
    'keep-local\n',
  );
  assert.equal(
    fs.readFileSync(path.join(siblings.remoteSibling, 'sentinel'), 'utf8'),
    'keep-remote\n',
  );
  assert.deepEqual(fs.readdirSync(harness.localTmp), [
    'evogent-phone-deploy.sibling',
  ]);
  assert.deepEqual(incomingEntries(harness), [leaf]);
});

test('verified bootstrap bytes are bound to Bash without reopening its path', () => {
  const source = fs.readFileSync(deployScript, 'utf8');
  assert.match(
    source,
    /active_child = subprocess\.Popen\(\s*installer_arguments,\s*stdin=subprocess\.PIPE,/,
  );
  assert.match(
    source,
    /active_child\.communicate\(input=bootstrap_bytes\)/,
  );
  assert.doesNotMatch(source, /bash "\.\/install-release\.sh"/);
  assert.doesNotMatch(source, /\bscp\b/);
});

test('checksum and bootstrap mixing are rejected before installer execution', () => {
  const checksumHarness = createHarness();
  const first = createRelease(
    checksumHarness,
    'evogent-phone-checksum-one.tar.gz',
    'checksum-one',
  );
  const second = createRelease(
    checksumHarness,
    'evogent-phone-checksum-two.tar.gz',
    'checksum-two',
  );
  const checksumResult = deploy(checksumHarness, first, [], {
    DEPLOY_REPLACE_SIDECAR: second.sidecar,
  });
  assert.notEqual(checksumResult.status, 0);
  assert.match(
    checksumResult.stderr,
    /remote release staging was rejected/,
  );
  assert.equal(fs.existsSync(checksumHarness.env.DEPLOY_INSTALL_LOG), false);
  assert.deepEqual(incomingEntries(checksumHarness), []);

  const bootstrapHarness = createHarness();
  const bootstrapRelease = createRelease(
    bootstrapHarness,
    'evogent-phone-bootstrap-one.tar.gz',
    'bootstrap-one',
  );
  const bootstrapResult = deploy(bootstrapHarness, bootstrapRelease, [], {
    DEPLOY_PREPLANT_BOOTSTRAP: '1',
  });
  assert.notEqual(bootstrapResult.status, 0);
  assert.match(
    bootstrapResult.stderr,
    /remote release staging was rejected/,
  );
  assert.equal(
    fs.existsSync(bootstrapHarness.env.DEPLOY_INSTALL_LOG),
    false,
  );
  assert.deepEqual(incomingEntries(bootstrapHarness), []);
});
