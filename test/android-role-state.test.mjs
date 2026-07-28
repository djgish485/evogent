import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const helper = path.join(
  root,
  'phone-paradigm/device/android-role-state.py',
);
const HOME = 'android.app.role.HOME';
const ASSISTANT = 'android.app.role.ASSISTANT';
const HEADER = 'EVOGENT_ANDROID_ROLE_RAW_V1\n';

function fixture() {
  const canonicalTmp = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(
    path.join(canonicalTmp, 'evogent-role-state-'),
  );
  fs.chmodSync(directory, 0o700);
  return {
    directory,
    snapshot: path.join(directory, 'android-role-holders.json'),
  };
}

function cleanup(value) {
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function run(args, input = '') {
  return spawnSync('python3', [helper, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
  });
}

function capture(value, {
  userId = '0',
  home = '',
  assistant = '',
} = {}) {
  return run(
    ['capture', '--snapshot', value.snapshot, '--user-id', userId],
    `${HEADER}${home}\n${assistant}\n`,
  );
}

function snapshotArgs(command, value, digest, userId = '0') {
  return [
    command,
    '--snapshot',
    value.snapshot,
    '--sha256',
    digest,
    '--user-id',
    userId,
  ];
}

test('versioned query publications distinguish empty holders from missing or malformed results', () => {
  const currentHeader = 'EVOGENT_ANDROID_ROLE_QUERY_RESULT_V1\ncurrent-user\n';
  const holdersHeader = 'EVOGENT_ANDROID_ROLE_QUERY_RESULT_V1\nrole-holders\n';
  const lineFixtures = [
    {
      command: 'parse-assistant-setting-result',
      kind: 'assistant-setting',
      value: 'com.example.app/.Assistant',
    },
    {
      command: 'parse-voice-setting-result',
      kind: 'voice-setting',
      value: 'com.example.app/com.example.app.Assistant',
    },
    {
      command: 'parse-home-component-result',
      kind: 'home-component',
      value: 'com.example.app/.Home',
    },
  ];

  for (const input of [`${currentHeader}0`, `${currentHeader}10\n`]) {
    const result = run(['parse-current-user-result'], input);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^(?:0|10)\n$/);
    assert.equal(result.stderr, '');
  }

  const empty = run(['parse-role-holders-result'], holdersHeader);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '\n');
  assert.equal(empty.stderr, '');

  const blankLine = run(
    ['parse-role-holders-result'],
    `${holdersHeader}\n`,
  );
  assert.equal(blankLine.status, 0, blankLine.stderr);
  assert.equal(blankLine.stdout, '\n');

  const populated = run(
    ['parse-role-holders-result'],
    `${holdersHeader}com.example.home\n`,
  );
  assert.equal(populated.status, 0, populated.stderr);
  assert.equal(populated.stdout, 'com.example.home\n');

  for (const { command, kind, value } of lineFixtures) {
    const header = `EVOGENT_ANDROID_ROLE_QUERY_RESULT_V1\n${kind}\n`;
    let result = run([command], `${header}${value}\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${value}\n`);
    assert.equal(result.stderr, '');

    result = run([command], header);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '\n');

    for (const invalid of [
      `${header}${value}\nextra\n`,
      `${header}${value}\r\n`,
      `${header}${'x'.repeat(1025)}`,
      `${currentHeader}${value}\n`,
      `EVOGENT_ANDROID_ROLE_QUERY_RESULT_V2\n${kind}\n${value}\n`,
    ]) {
      result = run([command], invalid);
      assert.equal(result.status, 65);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        'android-role-state: invalid or unsafe role state\n',
      );
    }
  }

  const rejected = [
    { command: 'parse-current-user-result', input: '' },
    { command: 'parse-current-user-result', input: currentHeader },
    {
      command: 'parse-current-user-result',
      input: 'EVOGENT_ANDROID_ROLE_QUERY_RESULT_V2\ncurrent-user\n0\n',
    },
    {
      command: 'parse-current-user-result',
      input: `${holdersHeader}0\n`,
    },
    { command: 'parse-current-user-result', input: `${currentHeader}00\n` },
    {
      command: 'parse-current-user-result',
      input: `${currentHeader}2147483648\n`,
    },
    {
      command: 'parse-current-user-result',
      input: `${currentHeader}0\nextra\n`,
    },
    { command: 'parse-role-holders-result', input: '' },
    {
      command: 'parse-role-holders-result',
      input: `${currentHeader}com.example.home\n`,
    },
    {
      command: 'parse-role-holders-result',
      input: `${holdersHeader}not-a-package\n`,
    },
    {
      command: 'parse-role-holders-result',
      input: `${holdersHeader}com.example.one;com.example.two\n`,
    },
    {
      command: 'parse-role-holders-result',
      input: `${holdersHeader}com.example.home\nextra\n`,
    },
    {
      command: 'parse-role-holders-result',
      input: `${holdersHeader}com.example.private\r\n`,
    },
    {
      command: 'parse-role-holders-result',
      input: `${holdersHeader}com.example.${'a'.repeat(4096)}`,
    },
  ];
  for (const { command, input } of rejected) {
    const result = run([command], input);
    assert.equal(result.status, 65, `${command} accepted ${input.length} bytes`);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'android-role-state: invalid or unsafe role state\n',
    );
    assert.doesNotMatch(result.stderr, /private/);
  }
});

test('capture publishes one canonical private snapshot and explicit query is the only holder output', () => {
  const value = fixture();
  try {
    const result = capture(value, {
      home: 'com.example.home',
      assistant: '',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^[0-9a-f]{64}\n$/);
    assert.equal(result.stderr, '');

    const digest = result.stdout.trim();
    const bytes = fs.readFileSync(value.snapshot);
    assert.equal(
      crypto.createHash('sha256').update(bytes).digest('hex'),
      digest,
    );
    assert.equal(fs.statSync(value.snapshot).mode & 0o777, 0o600);
    assert.equal(
      bytes.toString('utf8'),
      '{"holders":{"android.app.role.ASSISTANT":[],"android.app.role.HOME":["com.example.home"]},"schema":"evogent.phone.android-role-holders.v1","userId":0}\n',
    );

    const valid = run(snapshotArgs('validate', value, digest));
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, '');
    assert.equal(valid.stderr, '');

    const home = run([
      ...snapshotArgs('query', value, digest),
      '--role',
      HOME,
    ]);
    assert.equal(home.status, 0, home.stderr);
    assert.equal(home.stdout, 'com.example.home\n');

    const assistant = run([
      ...snapshotArgs('query', value, digest),
      '--role',
      ASSISTANT,
    ]);
    assert.equal(assistant.status, 0, assistant.stderr);
    assert.equal(assistant.stdout, '\n');
  } finally {
    cleanup(value);
  }
});

test('capture traverses searchable unreadable ancestors on Linux', {
  skip: process.platform !== 'linux',
}, () => {
  const canonicalTmp = fs.realpathSync(os.tmpdir());
  const outer = fs.mkdtempSync(
    path.join(canonicalTmp, 'evogent-role-search-only-'),
  );
  const directory = path.join(outer, 'private');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.chmodSync(outer, 0o711);
  const value = {
    directory,
    snapshot: path.join(directory, 'android-role-holders.json'),
  };
  try {
    const result = capture(value, {
      home: 'com.example.home',
      assistant: 'com.example.assistant',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(value.snapshot).mode & 0o777, 0o600);
  } finally {
    fs.chmodSync(outer, 0o700);
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('snapshot and target comparisons are silent and distinguish mismatch from invalid input', () => {
  const value = fixture();
  try {
    const captured = capture(value, {
      home: 'com.example.home',
      assistant: '',
    });
    assert.equal(captured.status, 0, captured.stderr);
    const digest = captured.stdout.trim();

    const matchingSnapshot = run([
      ...snapshotArgs('compare-snapshot', value, digest),
      '--role',
      HOME,
    ], 'com.example.home\n');
    assert.equal(matchingSnapshot.status, 0);
    assert.equal(matchingSnapshot.stdout, '');
    assert.equal(matchingSnapshot.stderr, '');

    const emptySnapshot = run([
      ...snapshotArgs('compare-snapshot', value, digest),
      '--role',
      ASSISTANT,
    ], '\n');
    assert.equal(emptySnapshot.status, 0);
    assert.equal(emptySnapshot.stdout, '');
    assert.equal(emptySnapshot.stderr, '');

    const mismatch = run([
      ...snapshotArgs('compare-snapshot', value, digest),
      '--role',
      HOME,
    ], 'com.example.other\n');
    assert.equal(mismatch.status, 1);
    assert.equal(mismatch.stdout, '');
    assert.equal(mismatch.stderr, '');

    const target = run([
      'compare-target',
      '--role',
      ASSISTANT,
      '--target-package',
      'com.example.evogent',
    ], 'com.example.evogent\n');
    assert.equal(target.status, 0);
    assert.equal(target.stdout, '');
    assert.equal(target.stderr, '');

    const targetMismatch = run([
      'compare-target',
      '--role',
      ASSISTANT,
      '--target-package',
      'com.example.evogent',
    ], '\n');
    assert.equal(targetMismatch.status, 1);
    assert.equal(targetMismatch.stdout, '');
    assert.equal(targetMismatch.stderr, '');

    const invalid = run([
      'compare-target',
      '--role',
      ASSISTANT,
      '--target-package',
      'com.example.evogent',
    ], 'not a package\n');
    assert.equal(invalid.status, 65);
    assert.equal(invalid.stdout, '');
    assert.equal(
      invalid.stderr,
      'android-role-state: invalid or unsafe role state\n',
    );
  } finally {
    cleanup(value);
  }
});

test('capture accepts empty or one holder and rejects malformed, duplicate, multiple, or oversized raw output', () => {
  const accepted = [
    { home: '', assistant: '' },
    { home: 'com.example.home', assistant: 'com.example.assistant' },
  ];
  for (const values of accepted) {
    const value = fixture();
    try {
      const result = capture(value, values);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      cleanup(value);
    }
  }

  const rejected = [
    { home: 'not a package' },
    { home: 'com.example.home;com.example.home' },
    { home: 'com.example.home;com.example.other' },
    { home: 'com.example.home\r' },
    { home: `com.example.${'a'.repeat(5000)}` },
  ];
  for (const values of rejected) {
    const value = fixture();
    try {
      const result = capture(value, values);
      assert.equal(result.status, 65);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        'android-role-state: invalid or unsafe role state\n',
      );
      assert.equal(fs.existsSync(value.snapshot), false);
      assert.doesNotMatch(result.stderr, /com[.]example/);
    } finally {
      cleanup(value);
    }
  }

  const extraLine = fixture();
  try {
    const result = run(
      ['capture', '--snapshot', extraLine.snapshot, '--user-id', '0'],
      `${HEADER}com.example.home\nextra\n\n`,
    );
    assert.equal(result.status, 65);
    assert.equal(fs.existsSync(extraLine.snapshot), false);
  } finally {
    cleanup(extraLine);
  }
});

test('capture rejects noncanonical or out-of-range user ids', () => {
  for (const userId of ['00', '-1', '+1', ' 0', '2147483648']) {
    const value = fixture();
    try {
      const result = capture(value, { userId });
      assert.equal(result.status, 65);
      assert.equal(result.stdout, '');
      assert.equal(fs.existsSync(value.snapshot), false);
    } finally {
      cleanup(value);
    }
  }
});

test('capture is atomic no-clobber and validation binds mode, user, canonical bytes, and digest', () => {
  const value = fixture();
  try {
    const first = capture(value, { home: 'com.example.home' });
    assert.equal(first.status, 0, first.stderr);
    const digest = first.stdout.trim();
    const original = fs.readFileSync(value.snapshot);

    const second = capture(value, { home: 'com.example.other' });
    assert.equal(second.status, 65);
    assert.deepEqual(fs.readFileSync(value.snapshot), original);

    const wrongDigest = run(snapshotArgs(
      'validate',
      value,
      '0'.repeat(64),
    ));
    assert.equal(wrongDigest.status, 65);

    const wrongUser = run(snapshotArgs('validate', value, digest, '1'));
    assert.equal(wrongUser.status, 65);

    fs.chmodSync(value.snapshot, 0o644);
    const unsafeMode = run(snapshotArgs('validate', value, digest));
    assert.equal(unsafeMode.status, 65);
  } finally {
    cleanup(value);
  }
});

test('atomic capture uses renameat2 when Python omits os.link', {
  skip: process.platform !== 'linux',
}, () => {
  const value = fixture();
  const harness = `
import base64
import hashlib
import importlib.util
import os
import pathlib
import sys

helper = pathlib.Path(sys.argv[1])
snapshot = pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("role_state_fallback", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = base64.b64decode(sys.argv[3], validate=True)
original = os.link
try:
    del os.link
    module._publish_snapshot(snapshot, payload)
finally:
    os.link = original
digest = hashlib.sha256(payload).hexdigest()
module._read_snapshot(str(snapshot), digest, 0)
`;
  try {
    // _read_snapshot also validates canonical role JSON, so publish a real
    // snapshot first and exercise only publication through the fallback.
    const payload = Buffer.from(
      '{"holders":{"android.app.role.ASSISTANT":[],"android.app.role.HOME":[]},"schema":"evogent.phone.android-role-holders.v1","userId":0}\n',
    );
    const result = spawnSync(
      'python3',
      ['-c', harness, helper, value.snapshot, payload.toString('base64')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(value.snapshot), payload);
    assert.equal(fs.statSync(value.snapshot).mode & 0o777, 0o600);
  } finally {
    cleanup(value);
  }
});

test('validation rejects symlinks, unsafe parents, noncanonical paths, and duplicate JSON keys', () => {
  const symlinked = fixture();
  try {
    const target = path.join(symlinked.directory, 'private-target.json');
    fs.writeFileSync(target, 'unchanged\n', { mode: 0o600 });
    fs.symlinkSync(target, symlinked.snapshot);
    const result = capture(symlinked, { home: 'com.example.home' });
    assert.equal(result.status, 65);
    assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged\n');
  } finally {
    cleanup(symlinked);
  }

  const unsafeParent = fixture();
  try {
    fs.chmodSync(unsafeParent.directory, 0o755);
    const result = capture(unsafeParent);
    assert.equal(result.status, 65);
    assert.equal(fs.existsSync(unsafeParent.snapshot), false);
  } finally {
    fs.chmodSync(unsafeParent.directory, 0o700);
    cleanup(unsafeParent);
  }

  const noncanonical = fixture();
  try {
    const result = run(
      [
        'capture',
        '--snapshot',
        `${noncanonical.directory}/./android-role-holders.json`,
        '--user-id',
        '0',
      ],
      `${HEADER}\n\n`,
    );
    assert.equal(result.status, 65);
    assert.equal(fs.existsSync(noncanonical.snapshot), false);
  } finally {
    cleanup(noncanonical);
  }

  const duplicateJson = fixture();
  try {
    const payload = Buffer.from(
      '{"holders":{"android.app.role.ASSISTANT":[],"android.app.role.HOME":[]},"schema":"evogent.phone.android-role-holders.v1","schema":"evogent.phone.android-role-holders.v1","userId":0}\n',
    );
    fs.writeFileSync(duplicateJson.snapshot, payload, { mode: 0o600 });
    fs.chmodSync(duplicateJson.snapshot, 0o600);
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const result = run(snapshotArgs('validate', duplicateJson, digest));
    assert.equal(result.status, 65);
  } finally {
    cleanup(duplicateJson);
  }
});

test('holder values never appear in errors and are emitted only by explicit query', () => {
  const value = fixture();
  try {
    const secretFixture = 'com.example.privateholder';
    const rejected = capture(value, {
      home: `${secretFixture};com.example.other`,
    });
    assert.equal(rejected.status, 65);
    assert.doesNotMatch(rejected.stdout, /privateholder/);
    assert.doesNotMatch(rejected.stderr, /privateholder/);

    const captured = capture(value, { home: secretFixture });
    assert.equal(captured.status, 0, captured.stderr);
    assert.doesNotMatch(captured.stdout, /privateholder/);
    assert.doesNotMatch(captured.stderr, /privateholder/);

    const digest = captured.stdout.trim();
    const compared = run([
      ...snapshotArgs('compare-snapshot', value, digest),
      '--role',
      HOME,
    ], 'com.example.other\n');
    assert.equal(compared.status, 1);
    assert.equal(compared.stdout, '');
    assert.equal(compared.stderr, '');

    const queried = run([
      ...snapshotArgs('query', value, digest),
      '--role',
      HOME,
    ]);
    assert.equal(queried.status, 0);
    assert.equal(queried.stdout, `${secretFixture}\n`);
  } finally {
    cleanup(value);
  }
});
