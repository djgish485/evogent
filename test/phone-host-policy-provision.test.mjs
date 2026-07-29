import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const provisioner = path.join(
  root,
  'phone-paradigm/device/phone-tools/provision-host-policy.sh',
);

function makeHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-host-policy-'));
  const home = path.join(directory, 'home');
  const tools = path.join(home, 'phone-tools');
  const policyState = path.join(directory, 'policy.json');
  const mutationState = path.join(directory, 'mutations.json');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(policyState, JSON.stringify({
    settings_enable_monitor_phantom_procs: 'true',
    force_desktop_mode_on_external_displays: '0',
    enable_freeform_support: '0',
  }));
  fs.writeFileSync(mutationState, JSON.stringify({ count: 0 }));
  fs.writeFileSync(path.join(tools, 'fake-policy.py'), `import json, os, pathlib, shlex, sys
policy_path = pathlib.Path(os.environ["FAKE_POLICY_STATE"])
mutation_path = pathlib.Path(os.environ["FAKE_MUTATION_STATE"])
command = sys.argv[1]
policy = json.loads(policy_path.read_text())
if command.startswith('printf "phantom=%s desktop=%s freeform=%s'):
    print(
        "phantom=" + policy["settings_enable_monitor_phantom_procs"]
        + " desktop=" + policy["force_desktop_mode_on_external_displays"]
        + " freeform=" + policy["enable_freeform_support"]
    )
    raise SystemExit(0)
parts = shlex.split(command)
if len(parts) != 5 or parts[:3] not in (
    ["settings", "put", "global"],
    ["settings", "delete", "global"],
):
    raise SystemExit("unexpected command: " + command)
mutation = json.loads(mutation_path.read_text())
mutation["count"] += 1
mutation_path.write_text(json.dumps(mutation))
count = mutation["count"]
if count == int(os.environ.get("FAKE_FAIL_AT", "0")):
    raise SystemExit(1)
key = parts[3]
value = parts[4] if parts[1] == "put" else "null"
if count != int(os.environ.get("FAKE_NOOP_AT", "0")):
    policy[key] = value
    policy_path.write_text(json.dumps(policy))
`);
  fs.writeFileSync(path.join(tools, 'control-plane.sh'), `
control_init_owner(){ :; }
control_finish_owner(){ :; }
control_rish_bounded(){ python3 "$TOOLS/fake-policy.py" "$1"; }
`);
  return {
    directory,
    home,
    tools,
    policyState,
    mutationState,
    savedState: path.join(tools, '.host-policy-before.json'),
  };
}

function run(harness, action, extraEnv = {}, script = provisioner) {
  return spawnSync('bash', [script, action], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: harness.home,
      FAKE_POLICY_STATE: harness.policyState,
      FAKE_MUTATION_STATE: harness.mutationState,
      ...extraEnv,
    },
  });
}

function readPolicy(harness) {
  return JSON.parse(fs.readFileSync(harness.policyState, 'utf8'));
}

function requiredPolicy() {
  return {
    settings_enable_monitor_phantom_procs: 'false',
    force_desktop_mode_on_external_displays: '1',
    enable_freeform_support: '1',
  };
}

function originalPolicy() {
  return {
    settings_enable_monitor_phantom_procs: 'true',
    force_desktop_mode_on_external_displays: '0',
    enable_freeform_support: '0',
  };
}

test('host-policy provisioning is explicit, private, reversible, and status-only by default', () => {
  const harness = makeHarness();
  try {
    const status = run(harness, '--status');
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /HOST_POLICY phantom=true desktop=0 freeform=0/);
    assert.equal(JSON.parse(fs.readFileSync(harness.mutationState, 'utf8')).count, 0);
    assert.equal(fs.existsSync(harness.savedState), false);

    const apply = run(harness, '--apply');
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepStrictEqual(readPolicy(harness), requiredPolicy());
    assert.equal(fs.statSync(harness.savedState).mode & 0o777, 0o600);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(harness.savedState, 'utf8')).settings,
      originalPolicy(),
    );

    const restore = run(harness, '--restore');
    assert.equal(restore.status, 0, restore.stderr);
    assert.deepStrictEqual(readPolicy(harness), originalPolicy());
  } finally {
    fs.rmSync(harness.directory, { recursive: true, force: true });
  }
});

test('host-policy apply refuses unsafe or corrupt reversal authority before mutation', () => {
  for (const kind of ['symlink', 'corrupt']) {
    const harness = makeHarness();
    try {
      if (kind === 'symlink') {
        const victim = path.join(harness.directory, 'victim');
        fs.writeFileSync(victim, 'do not touch\n', { mode: 0o644 });
        fs.symlinkSync(victim, harness.savedState);
      } else {
        fs.writeFileSync(harness.savedState, '{not-json}\n', { mode: 0o600 });
      }
      const result = run(harness, '--apply');
      assert.notEqual(result.status, 0);
      assert.deepStrictEqual(readPolicy(harness), originalPolicy());
      assert.equal(JSON.parse(fs.readFileSync(harness.mutationState, 'utf8')).count, 0);
    } finally {
      fs.rmSync(harness.directory, { recursive: true, force: true });
    }
  }
});

test('host-policy apply fails before Android writes when snapshot directory fsync fails', () => {
  const harness = makeHarness();
  try {
    const injected = path.join(harness.directory, 'provision-dir-fsync-failure.sh');
    const source = fs.readFileSync(provisioner, 'utf8');
    assert.match(source, /os[.]fsync\(directory\)/);
    fs.writeFileSync(
      injected,
      source.replace(
        '    os.fsync(directory)\n',
        '    raise OSError("injected directory fsync failure")\n',
      ),
      { mode: 0o700 },
    );
    const result = run(harness, '--apply', {}, injected);
    assert.notEqual(result.status, 0);
    assert.deepStrictEqual(readPolicy(harness), originalPolicy());
    assert.equal(JSON.parse(fs.readFileSync(harness.mutationState, 'utf8')).count, 0);
  } finally {
    fs.rmSync(harness.directory, { recursive: true, force: true });
  }
});

test('host-policy apply rolls back every partial write and verification failure', () => {
  for (const [variable, values] of [
    ['FAKE_FAIL_AT', [1, 2, 3]],
    ['FAKE_NOOP_AT', [1, 2, 3]],
  ]) {
    for (const value of values) {
      const harness = makeHarness();
      try {
        const result = run(harness, '--apply', { [variable]: String(value) });
        assert.notEqual(result.status, 0, `${variable}=${value} unexpectedly succeeded`);
        assert.deepStrictEqual(readPolicy(harness), originalPolicy());
        assert.match(result.stderr, /rolling back|rolled back/);
      } finally {
        fs.rmSync(harness.directory, { recursive: true, force: true });
      }
    }
  }
});

test('host-policy restore rolls back to the pre-command required state on partial failure', () => {
  for (const failureAt of [1, 2, 3]) {
    const harness = makeHarness();
    try {
      const apply = run(harness, '--apply');
      assert.equal(apply.status, 0, apply.stderr);
      fs.writeFileSync(harness.mutationState, JSON.stringify({ count: 0 }));

      const restore = run(harness, '--restore', { FAKE_FAIL_AT: String(failureAt) });
      assert.notEqual(restore.status, 0);
      assert.deepStrictEqual(readPolicy(harness), requiredPolicy());
      assert.match(restore.stderr, /rolling back|rolled back/);
    } finally {
      fs.rmSync(harness.directory, { recursive: true, force: true });
    }
  }
});
