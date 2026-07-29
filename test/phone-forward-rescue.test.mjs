import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const rescue = path.join(root, 'phone-paradigm/device/forward-rescue.sh');
const installer = path.join(root, 'phone-paradigm/device/install-release.sh');
const builder = path.join(root, 'scripts/build-phone-release.sh');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 20_000,
    ...options,
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for test process state');
}

function loadPrelude() {
  return `
import importlib.machinery
import importlib.util
import pathlib
import sys
loader = importlib.machinery.SourceFileLoader("forward_rescue_test", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
rescue = importlib.util.module_from_spec(spec)
loader.exec_module(rescue)
`;
}

function treeSnapshot(rootPath) {
  const values = [];
  function visit(value, relative = '.') {
    const info = fs.lstatSync(value);
    const base = {
      mode: info.mode & 0o7777,
      path: relative,
      type: info.isDirectory()
        ? 'directory'
        : info.isSymbolicLink()
          ? 'symlink'
          : 'file',
    };
    if (info.isSymbolicLink()) {
      base.target = fs.readlinkSync(value);
    } else if (info.isFile()) {
      base.bytes = fs.readFileSync(value).toString('base64');
    }
    values.push(base);
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(value).sort()) {
        visit(path.join(value, name), relative === '.' ? name : `${relative}/${name}`);
      }
    }
  }
  visit(rootPath);
  return values;
}

test('forward rescue has equivalent Bash, Python, and direct entrypoints', () => {
  const invocations = [
    run('bash', [rescue]),
    run('python3', [rescue]),
    run(rescue, []),
  ];
  for (const result of invocations) {
    assert.equal(result.status, 70, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.equal(invocations[0].stderr, invocations[1].stderr);
  assert.equal(invocations[1].stderr, invocations[2].stderr);
  assert.match(invocations[0].stderr, /--activate.*--recover/);
});

test('new recoverer treats retained v3 and v4 predecision crashes as inert', () => {
  for (const schema of [
    'evogent.phone.install-transaction.v3',
    'evogent.phone.install-transaction.v4',
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-old-'));
    const privateRoot = path.join(home, '.local/share/evogent');
    const transaction = path.join(privateRoot, 'install-transaction');
    for (const relative of ['releases', 'state', 'migrations', 'install-transaction']) {
      fs.mkdirSync(path.join(privateRoot, relative), { recursive: true, mode: 0o700 });
    }
    const journal = path.join(transaction, 'journal.json');
    fs.writeFileSync(
      journal,
      `${JSON.stringify({
        phase: 'health_pending',
        root: privateRoot,
        schema,
      })}\n`,
      { mode: 0o600 },
    );
    const pinned = path.join(transaction, 'install-release.sh');
    fs.copyFileSync(rescue, pinned);
    fs.chmodSync(pinned, 0o700);
    const before = treeSnapshot(privateRoot);
    for (const [command, prefix] of [
      ['bash', [pinned]],
      ['python3', [pinned]],
      [pinned, []],
    ]) {
      const result = run(command, [...prefix, '--recover', journal], {
        env: { ...process.env, HOME: home },
      });
      assert.equal(result.status, 70, result.stderr);
      assert.match(result.stderr, /forward decision is not durably visible/);
      assert.deepEqual(treeSnapshot(privateRoot), before);
    }
  }
});

test('forward admission accepts v4 health only with an empty install-action state', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-v4-action-'));
  const script = `${loadPrelude()}
import json
import os
import pathlib
import types
import sys

base = pathlib.Path(sys.argv[2])
root = base / "root"
releases = root / "releases"
tx = root / "install-transaction"
tx.mkdir(parents=True)
releases.mkdir()
journal = tx / "journal.json"
ctx = types.SimpleNamespace(
    journal=journal,
    releases=releases,
    root=root,
)
old = {
    "schema": "evogent.phone.install-transaction.v4",
    "phase": "health_pending",
    "root": str(root),
    "previousTarget": "",
    "previousApkCode": "0",
    "controlTokenBridge": "",
    "packageOperation": "",
    **{key: 1 for key in rescue.OLD_ONES},
}

def rejection(payload):
    journal.write_text(json.dumps(payload) + "\\n")
    os.chmod(journal, 0o600)
    try:
        rescue.old_state(ctx, releases / "B")
    except rescue.Error as error:
        return str(error)
    raise AssertionError("incomplete fixture unexpectedly completed admission")

assert "retained transaction is not" not in rejection(old)
with_action = dict(old)
with_action["apkUserActionKind"] = "android_install_review"
assert "retained transaction is not" in rejection(with_action)
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('invalid forward journals fail without filesystem mutation', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-invalid-'));
  const journal = path.join(fixture, 'journal.json');
  fs.writeFileSync(journal, '{"schema":"not-forward","schema":"also-not-forward"}\n', {
    mode: 0o600,
  });
  const before = treeSnapshot(fixture);
  const result = run('python3', [rescue, '--recover', journal], {
    env: { ...process.env, HOME: fixture },
  });
  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /duplicate JSON field/);
  assert.deepEqual(treeSnapshot(fixture), before);
});

test('forward admission accepts only exact restored HOME snapshots and topology', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-home-layout-'));
  const script = `${loadPrelude()}
import copy
import os
import pathlib
import shutil
import types
import sys

base = pathlib.Path(sys.argv[2])
home = base / "home"
migration = base / "migration"
snapshot_home = migration / "home"
runtime = home / "evogent"
phone = home / "phone-tools"
phone_snapshot = migration / "phone-tools"
for value in (
    snapshot_home,
    runtime / "data",
    runtime / "node_modules",
    phone,
    phone_snapshot,
):
    value.mkdir(parents=True, exist_ok=True)

def planned(path):
    value = rescue.capture(path)
    value.pop("nlink", None)
    return value

for name in (
    "evogent-boot.sh",
    "evogent-scheduler.sh",
    "evogent-watchdog.sh",
):
    for root in (phone, phone_snapshot):
        (root / name).write_text(name + "\\n")
        os.chmod(root / name, 0o600)

(home / "start-prod-sub.sh").write_text("start\\n")
os.chmod(home / "start-prod-sub.sh", 0o700)
os.symlink("start-prod-sub.sh", home / "restart-evo.sh")

ctx = types.SimpleNamespace(home=home)
entries = {
    key: planned(path)
    for key, path in rescue.paths(ctx).items()
}
shutil.copy2(
    home / "start-prod-sub.sh",
    snapshot_home / "start-prod-sub.sh",
    follow_symlinks=False,
)
os.symlink(
    os.readlink(home / "restart-evo.sh"),
    snapshot_home / "restart-evo.sh",
)
phone_value = planned(phone_snapshot)
phone_value["controlPrograms"] = {
    name: planned(phone_snapshot / name)
    for name in (
        "evogent-boot.sh",
        "evogent-scheduler.sh",
        "evogent-watchdog.sh",
    )
}
snapshots = {"phoneTools": phone_value}
for name in rescue.HOME_NAMES:
    snapshots["home:" + name] = planned(snapshot_home / name)
plan = {"entries": entries, "snapshots": snapshots}

os.rename(phone, migration / "rolled-back-phone-state")
os.rename(phone_snapshot, phone)
os.unlink(home / "start-prod-sub.sh")
os.unlink(home / "restart-evo.sh")
os.rename(
    snapshot_home / "start-prod-sub.sh",
    home / "start-prod-sub.sh",
)
os.rename(
    snapshot_home / "restart-evo.sh",
    home / "restart-evo.sh",
)
assert rescue.valid_plan_snapshots(plan)
assert rescue.admitted_live_entries(ctx, migration, plan) is not None

# Equal bytes and metadata on an unbound inode are not admissible.
exact = base / "exact-start"
os.rename(home / "start-prod-sub.sh", exact)
shutil.copy2(exact, home / "start-prod-sub.sh")
assert rescue.admitted_live_entries(ctx, migration, plan) is None
os.unlink(home / "start-prod-sub.sh")
os.rename(exact, home / "start-prod-sub.sh")
assert rescue.admitted_live_entries(ctx, migration, plan) is not None

program = phone / "evogent-boot.sh"
program.write_text("changed\\n")
assert rescue.admitted_live_entries(ctx, migration, plan) is None
program.write_text("evogent-boot.sh\\n")
os.chmod(program, 0o600)
assert rescue.admitted_live_entries(ctx, migration, plan) is not None

extra = copy.deepcopy(plan)
extra["snapshots"]["home:unexpected.sh"] = {"type": "absent"}
assert not rescue.valid_plan_snapshots(extra)

linked = copy.deepcopy(plan)
linked["snapshots"]["home:restart-evo.sh"]["dev"] = (
    linked["snapshots"]["home:start-prod-sub.sh"]["dev"]
)
linked["snapshots"]["home:restart-evo.sh"]["ino"] = (
    linked["snapshots"]["home:start-prod-sub.sh"]["ino"]
)
assert not rescue.valid_plan_snapshots(linked)

malformed = copy.deepcopy(plan)
malformed["snapshots"]["home:start-prod-sub.sh"]["nlink"] = 1
assert not rescue.valid_plan_snapshots(malformed)
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('durable decisions migrate snapshot-live and mixed identities across crash replay', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-bound-live-'));
  const script = `${loadPrelude()}
import copy
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import types
import sys

fixture = pathlib.Path(sys.argv[2])

def planned(path):
    value = rescue.capture(path)
    value.pop("nlink", None)
    return value

def build(label, snapshot_tools, snapshot_home_names, crash_after):
    base = fixture / label
    home = base / "home"
    root = home / ".local/share/evogent"
    state = root / "state"
    releases = root / "releases"
    incoming = releases / "B"
    migration = root / "migrations/source"
    workspace = root / ("migrations/legacy-forward-B-" + label)
    tx = root / "install-transaction"
    runtime = home / "evogent"
    phone = home / "phone-tools"
    for value in (
        state,
        incoming,
        migration / "home",
        workspace / "home",
        workspace / "phone-tools",
        tx,
        runtime / "data",
        runtime / "node_modules",
        phone,
    ):
        value.mkdir(parents=True, exist_ok=True)

    database = sqlite3.connect(runtime / "data/media-agent.db")
    database.execute("create table proof(value text)")
    database.execute("insert into proof values (?)", (label,))
    database.commit()
    database.close()
    token = ("token-" + label).encode()
    (runtime / "data/control-token.txt").write_bytes(token)
    os.chmod(runtime / "data/control-token.txt", 0o600)
    for name in (
        "evogent-boot.sh",
        "evogent-scheduler.sh",
        "evogent-watchdog.sh",
    ):
        (phone / name).write_text(name + "\\n")
        os.chmod(phone / name, 0o600)
    for name in rescue.HOME_NAMES:
        (home / name).write_text(name + "\\n")
        os.chmod(home / name, 0o700)

    entries = {
        key: planned(path)
        for key, path in rescue.paths(types.SimpleNamespace(home=home)).items()
    }
    shutil.copytree(
        phone,
        migration / "phone-tools",
        copy_function=shutil.copy2,
    )
    for name in rescue.HOME_NAMES:
        shutil.copy2(home / name, migration / "home" / name)
    phone_snapshot = planned(migration / "phone-tools")
    phone_snapshot["controlPrograms"] = {
        name: planned(migration / "phone-tools" / name)
        for name in (
            "evogent-boot.sh",
            "evogent-scheduler.sh",
            "evogent-watchdog.sh",
        )
    }
    snapshots = {"phoneTools": phone_snapshot}
    for name in rescue.HOME_NAMES:
        snapshots["home:" + name] = planned(migration / "home" / name)
    plan = {"entries": entries, "snapshots": snapshots}
    assert rescue.valid_plan_snapshots(plan)
    source_bytes = rescue.encode(plan)
    source_plan = workspace / "source-rollback-plan.json"
    source_plan.write_bytes(source_bytes)
    os.chmod(source_plan, 0o600)

    if snapshot_tools:
        os.rename(phone, migration / "rolled-back-phone-state")
        os.rename(migration / "phone-tools", phone)
    for name in snapshot_home_names:
        os.unlink(home / name)
        os.rename(migration / "home" / name, home / name)
    (phone / ".cycle.lock").mkdir()

    ctx = types.SimpleNamespace(
        home=home,
        root=root,
        state=state,
        releases=releases,
        tx=tx,
        journal=tx / "journal.json",
        recoverer=tx / "install-release.sh",
        old_recoverer=tx / "source-install-release.sh",
    )
    admitted = rescue.admitted_live_entries(ctx, migration, plan)
    assert admitted is not None
    expected_phone = (
        rescue.migration_snapshot(plan, "phoneTools")
        if snapshot_tools
        else entries["phoneTools"]
    )
    assert admitted["phoneTools"] == expected_phone
    for name in rescue.HOME_NAMES:
        key = "home:" + name
        expected = (
            rescue.migration_snapshot(plan, key)
            if name in snapshot_home_names
            else entries[key]
        )
        assert admitted[key] == expected
    nlinks = rescue.admitted_nlinks(ctx, migration, plan, admitted)

    manifest = {
        "android": {"versionCode": 7, "sha256": "a" * 64},
        "phoneTls": {"certificateDerSha256": "b" * 64},
        "dependencies": {"packageLockSha256": "c" * 64},
    }
    (incoming / "manifest.json").write_text(json.dumps(manifest) + "\\n")
    source_journal = {
        "schema": "evogent.phone.install-transaction.v3",
        "label": label,
    }
    ctx.journal.write_bytes(rescue.encode(source_journal))
    os.chmod(ctx.journal, 0o600)
    shutil.copy2(ctx.journal, workspace / "source-journal.json")
    shutil.copy2(rescue.__file__, ctx.recoverer)
    os.chmod(ctx.recoverer, 0o700)
    (workspace / "source-install-release.sh").write_text("pinned source\\n")
    os.chmod(workspace / "source-install-release.sh", 0o700)
    (workspace / "source-android-role-holders.json").write_text("{}\\n")
    os.chmod(workspace / "source-android-role-holders.json", 0o600)
    old = {
        "packageOperation": "/data/local/tmp/evogent-package-op." + "d" * 32,
        "previousApkCode": "0",
    }
    proof = {
        "databaseLogicalSha256": rescue.logical_db(
            runtime / "data/media-agent.db"),
        "controlTokenSha256": hashlib.sha256(token).hexdigest(),
        "admittedEntries": admitted,
        "nlinks": nlinks,
        "rollbackTerminalProof": {
            "schema": rescue.TERMINAL_ROLLBACK_SCHEMA,
            "disposition": "terminal",
            "package": rescue.PACKAGE,
            "fromVersion": 7,
            "toVersion": 0,
            "rows": [{
                "rollbackId": 11,
                "committedSessionId": 21,
            }],
            "successorValidatorAccepted": True,
        },
    }
    decision = rescue.forward_journal(
        ctx,
        old,
        source_plan,
        workspace / "source-android-role-holders.json",
        incoming,
        manifest,
        proof,
        workspace,
    )
    decision["phase"] = "migration_pending"
    rescue.jput(ctx.journal, decision, True)
    rescue.release = lambda _ctx, _path: manifest
    durable = rescue.load_forward(ctx)
    assert durable["admittedEntries"] == admitted
    assert source_plan.read_bytes() == source_bytes

    real_rename = rescue.os.rename
    renames = {"count": 0}
    class Crash(Exception):
        pass
    def crash(source, target):
        real_rename(source, target)
        renames["count"] += 1
        if renames["count"] == crash_after:
            raise Crash(str(target))
    rescue.os.rename = crash
    try:
        rescue.migrate(ctx, durable)
    except Crash:
        pass
    else:
        raise AssertionError("migration fault did not fire")
    finally:
        rescue.os.rename = real_rename

    replay = rescue.load_forward(ctx)
    assert replay["admittedEntries"] == admitted
    rescue.migrate(ctx, replay)
    rescue.migrate(ctx, replay)
    rescue.migrated_topology(ctx, replay)
    assert source_plan.read_bytes() == source_bytes
    assert rescue.same(
        state / "phone-tools", admitted["phoneTools"], core=True)
    for name in rescue.HOME_NAMES:
        assert rescue.same(
            workspace / "home" / name,
            admitted["home:" + name],
        )

    alternate = copy.deepcopy(replay)
    changed = "home:" + next(iter(snapshot_home_names))
    alternate["admittedEntries"][changed] = plan["entries"][changed]
    try:
        rescue.migrated_topology(ctx, alternate)
    except rescue.Error:
        pass
    else:
        raise AssertionError("alternate admitted identity was accepted after migration")
    return ctx, replay, manifest, source_bytes

all_names = set(rescue.HOME_NAMES)
ctx, prior, manifest, source_bytes = build(
    "all-snapshot", True, all_names, 2)
build(
    "mixed-snapshot-tools",
    True,
    {rescue.HOME_NAMES[0], rescue.HOME_NAMES[2], rescue.HOME_NAMES[4]},
    1,
)
build(
    "mixed-original-tools",
    False,
    {rescue.HOME_NAMES[1], rescue.HOME_NAMES[3]},
    3,
)

# A chained decision must preserve the origin's exact admitted identities.
prior["phase"] = "prepare_pending"
rescue.jput(ctx.journal, prior, True)
chain_incoming = ctx.releases / "C"
chain_incoming.mkdir()
chain_manifest = {
    **manifest,
    "dependencies": {"packageLockSha256": "e" * 64},
}
(chain_incoming / "manifest.json").write_text(
    json.dumps(chain_manifest) + "\\n")
chain_workspace = ctx.root / "migrations/legacy-forward-chain-C"
chain_workspace.mkdir()
shutil.copy2(ctx.journal, chain_workspace / "source-forward-journal.json")
shutil.copy2(
    ctx.recoverer,
    chain_workspace / "source-forward-recoverer.sh",
)
os.chmod(chain_workspace / "source-forward-recoverer.sh", 0o700)
chain_proof = {
    "databaseLogicalSha256": prior["databaseLogicalSha256"],
    "controlTokenSha256": prior["controlTokenSha256"],
}
chained = rescue.chained_journal(
    ctx, prior, chain_incoming, chain_manifest, chain_proof, chain_workspace)
rescue.jput(ctx.journal, chained, True)
rescue.release = lambda _ctx, path: (
    chain_manifest if pathlib.Path(path).name == "C" else manifest)
loaded_chain = rescue.load_forward(ctx)
assert loaded_chain["admittedEntries"] == prior["admittedEntries"]
rescue.migrated_authorities(ctx, loaded_chain)

tampered = copy.deepcopy(chained)
tampered["admittedEntries"]["home:start-prod-sub.sh"] = (
    json.loads(source_bytes)["entries"]["home:start-prod-sub.sh"]
)
rescue.jput(ctx.journal, tampered, True)
try:
    rescue.load_forward(ctx)
except rescue.Error:
    pass
else:
    raise AssertionError("chained decision changed its origin admission")
`;
  const result = run('python3', ['-c', script, rescue, fixture], {
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('forward native proof uses the successor rollback validator', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-validator-'));
  const script = `${loadPrelude()}
import pathlib
import types
import sys

base = pathlib.Path(sys.argv[2])
home = base / "home"
incoming = base / "incoming"
old_release = base / "old"
for value in (
    home / "evogent/data",
    home / "phone-tools",
    incoming / "device",
    old_release / "device",
):
    value.mkdir(parents=True, exist_ok=True)
ctx = types.SimpleNamespace(home=home)
entries = {}
for key, value in rescue.paths(ctx).items():
    entries[key] = rescue.capture(value)
plan = {"entries": entries}
manifest = {"android": {"versionCode": 7, "sha256": "a" * 64}}
old = {
    "newRelease": str(old_release),
    "migrationDir": str(base / "migration"),
    "packageOperation": "/data/local/tmp/evogent-package-op." + "d" * 32,
    "previousApkCode": "0",
    "androidRoleBackupSha256": "b" * 64,
    "androidRoleUserId": 0,
}
answers = {
    "package-idle": b"idle\\n",
    "package-namespace": b"absent\\n",
    "installed-apk": ("7\\n" + "a" * 64 + "\\n").encode(),
    "rollback-dump": b"""11:
  -state: committed
  -isStaged: false
  -originalSessionId: 20
  -packages:
    net.dangish.evogent 7 -> 0 [0]
  -committedSessionId: 21
Historical rollbacks:
Package Watchdog status
""",
    "package-installer": (
        b"Active install sessions:\\n\\nHistorical install sessions:\\n"
    ),
    "control-token": b"token",
}
android_scripts = {}
def fake_android(script, purpose, *_args, **_kwargs):
    android_scripts[purpose] = script
    return answers[purpose]
rescue.android = fake_android
calls = []
def record(args, **kwargs):
    calls.append((args, kwargs))
    return types.SimpleNamespace(returncode=0)
rescue.command = record
rescue.roles = lambda *_args: None
rescue.slurp = lambda *_args, **_kwargs: b"token"
rescue.logical_db = lambda *_args: "c" * 64
rescue.stopped = lambda *_args: None
rescue.admitted_nlinks = lambda *_args: {
    key: rescue.capture(value)["nlink"]
    for key, value in rescue.paths(ctx).items()
    if rescue.capture(value)["type"] != "absent"
}
proof = rescue.evidence(
    ctx, old, plan, base / "roles.json", manifest, incoming, {})
assert proof["databaseLogicalSha256"] == "c" * 64
assert proof["admittedEntries"] == {}
assert proof["rollbackTerminalProof"]["rows"] == [{
    "rollbackId": 11,
    "committedSessionId": 21,
}]
assert len(calls) == 1
assert pathlib.Path(calls[0][0][1]) == incoming / "device/rollback-state.py"
assert pathlib.Path(calls[0][0][1]) != old_release / "device/rollback-state.py"
assert calls[0][0][2] == "require-consumed"
assert (
    "cmd package wait-for-handler --timeout 120000 >/dev/null"
    in android_scripts["package-idle"]
)
assert (
    "cmd package wait-for-background-handler --timeout 120000 >/dev/null"
    in android_scripts["package-idle"]
)
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('terminal or expired rollback lineages reject only target PackageInstaller authority', () => {
  const script = `${loadPrelude()}
assert rescue.valid_package_operation("")
assert rescue.valid_package_operation(
    "/data/local/tmp/evogent-package-op." + "a" * 32)
assert not rescue.valid_package_operation("/data/local/tmp/unbound")
duplicate_terminal = b"""1599558273:
  -state: committed
  -stateDescription:
  -isStaged: false
  -originalSessionId: 100
  -packages:
    net.dangish.evogent 1785216876 -> 0 [0]
  -committedSessionId: 441583237
1292178639:
  -state: committed
  -stateDescription:
  -isStaged: false
  -originalSessionId: 101
  -packages:
    net.dangish.evogent 1785216876 -> 0 [0]
  -committedSessionId: 1286209599
Historical rollbacks:
Package Watchdog status
"""
proof = rescue.terminal_rollback_proof(
    duplicate_terminal, 1785216876, 0, False)
assert proof == {
    "schema": rescue.TERMINAL_ROLLBACK_SCHEMA,
    "disposition": "terminal",
    "package": rescue.PACKAGE,
    "fromVersion": 1785216876,
    "toVersion": 0,
    "rows": [
        {"rollbackId": 1292178639, "committedSessionId": 1286209599},
        {"rollbackId": 1599558273, "committedSessionId": 441583237},
    ],
    "successorValidatorAccepted": False,
}
assert rescue.valid_terminal_rollback_proof(proof, 1785216876, 0)
assert rescue.package_installer_quiescent(
    b"Active install sessions:\\n\\nHistorical install sessions:\\n",
    proof,
    1785216876,
)

stuck = b"""Active install sessions:
  Active Session 1286209599:
    mCommitted=true mSessionApplied=false mSessionFailed=false
    mChildSessionIds=[2122617521]
    Active Child Session 2122617521:
      mParentSessionId=1286209599 mCommitted=true
      mSessionApplied=false mSessionFailed=false

Historical install sessions:
"""
assert not rescue.package_installer_quiescent(stuck, proof, 1785216876)
unrelated = b"""Active install sessions:
  Active Session 99:
    mOriginalInstallerPackageName=com.android.vending
    appPackageName=com.android.module
    requiredInstalledVersionCode=42
    params.isStaged=true

Historical install sessions:
"""
assert rescue.package_installer_quiescent(unrelated, proof, 1785216876)
named_target = unrelated.replace(
    b"appPackageName=com.android.module",
    b"appPackageName=net.dangish.evogent",
)
assert not rescue.package_installer_quiescent(
    named_target, proof, 1785216876)
version_target = unrelated.replace(
    b"requiredInstalledVersionCode=42",
    b"requiredInstalledVersionCode=1785216876",
)
assert not rescue.package_installer_quiescent(
    version_target, proof, 1785216876)

expired = rescue.terminal_rollback_proof(
    b"""1:
  -state: enabling
  -stateDescription:
  -isStaged: true
  -originalSessionId: 21
  -packages:
    com.android.module.one 20 -> 19 [0]
  -extensionVersions:
    {30=20, 31=20, 1000000=20}
2:
  -state: enabling
  -stateDescription:
  -isStaged: true
  -originalSessionId: 22
  -packages:
    com.android.module.two 20 -> 19 [0]
  -extensionVersions:
    {30=20, 31=20, 1000000=20}
3:
  -state: enabling
  -stateDescription:
  -isStaged: true
  -originalSessionId: 23
  -packages:
    com.android.module.three 20 -> 19 [0]
  -extensionVersions:
    {30=20, 31=20, 1000000=20}
Historical rollbacks:
  11:
    -state: deleted
    -stateDescription: Expired by API
    -isStaged: false
    -originalSessionId: 31
    -packages:
      net.dangish.evogent 1785216876 -> 0 [0]
    -extensionVersions:
      {30=20, 31=20, 1000000=20}
  12:
    -state: deleted
    -stateDescription: Expired by API
    -isStaged: false
    -originalSessionId: 32
    -packages:
      net.dangish.evogent 1785216876 -> 0 [0]
    -extensionVersions:
      {30=20, 31=20, 1000000=20}
  13:
    -state: deleted
    -stateDescription: Expired by API
    -isStaged: false
    -originalSessionId: 33
    -packages:
      com.android.module.four 20 -> 19 [0]
    -extensionVersions:
      {30=20, 31=20, 1000000=20}
Package Watchdog status
""",
    1785216876,
    0,
    True,
)
assert expired["disposition"] == "expired"
assert expired["rows"] == [{
    "rollbackId": 11,
    "originalSessionId": 31,
}, {
    "rollbackId": 12,
    "originalSessionId": 32,
}]
assert rescue.valid_terminal_rollback_proof(expired, 1785216876, 0)
for unproved_absence in (
    b"",
    b"unrecognized rollback dump format\\n",
    b"""Historical rollbacks:
  11:
    -state: deleted
    -isStaged: false
    -originalSessionId: 31
    -packages:
      net.dangish.evogent 1785216876 -> 0 [0]
Package Watchdog status
""",
):
    try:
        rescue.terminal_rollback_proof(
            unproved_absence, 1785216876, 0, False)
    except rescue.Error:
        pass
    else:
        raise AssertionError("unproved active-row absence was admitted")
for changed in (
    duplicate_terminal.replace(
        b"-state: committed", b"-state: available", 1),
    duplicate_terminal.replace(
        b"-isStaged: false", b"-isStaged: true", 1),
    duplicate_terminal.replace(
        b"1785216876 -> 0", b"1785216876 -> 1", 1),
    duplicate_terminal.replace(
        b"-committedSessionId: 1286209599",
        b"-committedSessionId: 441583237"),
    duplicate_terminal.replace(
        b"-originalSessionId: 101",
        b"-originalSessionId: 100"),
    duplicate_terminal.replace(
        b"1292178639:", b"1599558273:"),
):
    try:
        rescue.terminal_rollback_proof(changed, 1785216876, 0, False)
    except rescue.Error:
        pass
    else:
        raise AssertionError("ambiguous native rollback state was admitted")
`;
  const result = run('python3', ['-c', script, rescue]);
  assert.equal(result.status, 0, result.stderr);
});

test('decision publication exits 76 after making only the forward schema visible', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-fsync-'));
  const transaction = path.join(fixture, 'install-transaction');
  fs.mkdirSync(transaction, { mode: 0o700 });
  const journal = path.join(transaction, 'journal.json');
  const candidate = path.join(transaction, 'forward-candidate.json');
  fs.writeFileSync(
    candidate,
    '{"forwardDecision":1,"schema":"evogent.phone.forward-rescue.v1"}\n',
    { mode: 0o600 },
  );
  const script = `${loadPrelude()}
from types import SimpleNamespace
ctx = SimpleNamespace(tx=pathlib.Path(sys.argv[2]), journal=pathlib.Path(sys.argv[3]))
rescue.publish_decision(ctx, pathlib.Path(sys.argv[4]))
`;
  const result = run('python3', ['-c', script, rescue, transaction, journal, candidate], {
    env: {
      ...process.env,
      EVOGENT_FORWARD_TEST_FAIL_DIR_FSYNC: '1',
    },
  });
  assert.equal(result.status, 76, result.stderr);
  assert.equal(fs.existsSync(candidate), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(journal, 'utf8')), {
    forwardDecision: 1,
    schema: 'evogent.phone.forward-rescue.v1',
  });
  assert.deepEqual(fs.readdirSync(transaction), ['journal.json']);
});

test('initial decision really pins, archives, publishes, and replays a predecision crash', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-decide-'));
  const script = `${loadPrelude()}
import json
import os
import pathlib
import types
import sys

root = pathlib.Path(sys.argv[2])
tx = root / "install-transaction"
incoming = root / "releases/B"
for value in (tx, root / "migrations", incoming):
    value.mkdir(parents=True, exist_ok=True)
journal = tx / "journal.json"
journal.write_text('{"schema":"evogent.phone.install-transaction.v3"}\\n')
os.chmod(journal, 0o600)
recoverer = tx / "install-release.sh"
recoverer.write_text("# old pinned installer\\n")
os.chmod(recoverer, 0o700)
plan = root / "source-plan.json"
role = root / "source-role.json"
plan.write_text("{}\\n")
role.write_text("{}\\n")
os.chmod(plan, 0o600)
os.chmod(role, 0o600)
(incoming / "manifest.json").write_text("{}\\n")
ctx = types.SimpleNamespace(
    home=root.parent,
    root=root,
    tx=tx,
    journal=journal,
    recoverer=recoverer,
    old_recoverer=tx / "source-install-release.sh",
)
old = {
    "packageOperation": "/data/local/tmp/evogent-package-op." + "a" * 32,
    "previousApkCode": "0",
}
manifest = {
    "android": {"versionCode": 7, "sha256": "a" * 64},
    "phoneTls": {"certificateDerSha256": "b" * 64},
    "dependencies": {"packageLockSha256": "c" * 64},
}
proof = {
    "databaseLogicalSha256": "d" * 64,
    "controlTokenSha256": "e" * 64,
    "admittedEntries": {},
    "nlinks": {},
}
rescue.old_state = lambda _ctx, _incoming: (
    old, {}, plan, role, manifest, {})
rescue.evidence = lambda *_args: proof
publish = rescue.publish_decision
faulted = {"value": False}
def fail_before_publication(_ctx, _candidate):
    faulted["value"] = True
    raise rescue.Error("predecision crash")
rescue.publish_decision = fail_before_publication
try:
    rescue.decide(ctx, incoming)
except rescue.Error:
    pass
else:
    raise AssertionError("predecision fault did not fire")
assert faulted["value"]
assert json.loads(journal.read_text())["schema"] == "evogent.phone.install-transaction.v3"
assert ctx.old_recoverer.read_text() == "# old pinned installer\\n"
assert recoverer.read_bytes() == pathlib.Path(rescue.__file__).read_bytes()
rescue.publish_decision = publish
rescue.decide(ctx, incoming)
published = json.loads(journal.read_text())
assert published["schema"] == rescue.SCHEMA
assert published["chainDepth"] == 0
assert published["phase"] == "forward_decided"
workspace = pathlib.Path(published["workspace"])
assert (workspace / "source-journal.json").read_text().startswith('{"schema"')
assert (workspace / "source-install-release.sh").read_text() == "# old pinned installer\\n"
assert not (tx / "forward-candidate.json").exists()
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('release inventory rechecks actual files, symlinks, state links, and extras', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-inventory-'));
  const script = `${loadPrelude()}
import hashlib
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[2])
(root / "runtime/.next/node_modules").mkdir(parents=True)
(root / "runtime/a").write_bytes(b"bound")
os.symlink("a", root / "runtime/link")
os.symlink("../../../state/data", root / "runtime/data")
os.symlink("../../../state/dependencies/lock/node_modules",
           root / "runtime/node_modules")
os.symlink("../../node_modules/pkg",
           root / "runtime/.next/node_modules/pkg-id")
for name in ("manifest.json", "files.sha256", "links.json"):
    (root / name).write_text("{}\\n")
row = hashlib.sha256(b"bound").hexdigest() + "  runtime/a\\n"
links = json.dumps({
    "runtime/link": "a",
    "runtime/.next/node_modules/pkg-id": "../../node_modules/pkg",
}, separators=(",", ":")).encode() + b"\\n"
manifest = {"stateLinks": {
    "runtime/data": "../../../state/data",
    "runtime/node_modules": "../../../state/dependencies/lock/node_modules",
}}
rescue.release_inventory(root, manifest, row.encode(), links)
os.unlink(root / "runtime/link")
os.symlink("changed", root / "runtime/link")
try:
    rescue.release_inventory(root, manifest, row.encode(), links)
except rescue.Error:
    pass
else:
    raise AssertionError("changed release symlink was accepted")
os.unlink(root / "runtime/link")
os.symlink("a", root / "runtime/link")
(root / "runtime/extra").write_text("extra")
try:
    rescue.release_inventory(root, manifest, row.encode(), links)
except rescue.Error:
    pass
else:
    raise AssertionError("unbound release file was accepted")
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('phase orchestration resumes idempotently after every low-level boundary', () => {
  const script = `${loadPrelude()}
import json

class Crash(Exception):
    pass

def exercise(crash_at):
    state = {
        "phase": "forward_decided",
        "event": 0,
        "retired": False,
        "database": "admitted",
    }
    calls = []

    def event(name, mutation=None):
        state["event"] += 1
        calls.append((name, state["phase"]))
        if mutation is not None:
            mutation()
        if crash_at == state["event"]:
            raise Crash(name)

    def load(_ctx):
        if state["retired"]:
            raise AssertionError("retired journal was reopened")
        return {"phase": state["phase"]}

    def transition(_ctx, old, new):
        assert state["phase"] == old
        event("transition:" + new, lambda: state.__setitem__("phase", new))

    rescue.load_forward = load
    rescue.transition = transition
    rescue.quiesce = lambda _ctx: event("quiesce")
    def migrate(_ctx, _journal):
        assert state["database"] == "admitted"
        event("migrate")

    def prepare(_ctx, _journal):
        event("prepare", lambda: state.__setitem__("database", "prepared"))

    rescue.migrate = migrate
    rescue.prepare_runtime = prepare
    rescue.switch = lambda _ctx, _journal: event("switch")
    rescue.topology = lambda _ctx, _journal: event("topology")
    rescue.start = lambda _ctx, _journal: event("start")
    rescue.healthy = lambda _ctx, _journal: event("healthy")
    rescue.retire = lambda _ctx, _journal: event(
        "retire", lambda: state.__setitem__("retired", True)
    )

    class Gate:
        def relocate(self, _path):
            event("relocate")

    held = [None, None, Gate()]
    ctx = type("Ctx", (), {"state": pathlib.Path("/state")})()
    attempts = 0
    while not state["retired"]:
        attempts += 1
        assert attempts < 20
        try:
            committed = rescue.advance(ctx, held)
            rescue.retire(ctx, committed)
        except Crash:
            crash_at = None

    assert ("migrate", "migration_pending") in calls
    assert ("prepare", "prepare_pending") in calls
    assert ("switch", "switch_pending") in calls
    assert ("start", "health_pending") in calls
    assert ("start", "committed") in calls
    assert ("retire", "committed") in calls
    return state["event"], attempts, calls

count, _, baseline = exercise(None)
attempts = []
for point in range(1, count + 1):
    observed, resumed, calls = exercise(point)
    assert observed >= count
    if point == baseline.index(("prepare", "prepare_pending")) + 1:
        assert [name for name, _phase in calls].count("migrate") == 1
        assert [name for name, _phase in calls].count("prepare") == 2
    attempts.append(resumed)
print(json.dumps({"boundaries": count, "maxAttempts": max(attempts)}))
`;
  const result = run('python3', ['-c', script, rescue]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.boundaries >= 16, result.stdout);
  assert.equal(report.maxAttempts, 2);
});

test('real journal transitions start twice, prove topology, and retire committed metadata', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-commit-'));
  const script = `${loadPrelude()}
import hashlib
import json
import os
import pathlib
import types
import sys

base = pathlib.Path(sys.argv[2]).resolve()
home = base / "home"
root = home / ".local/share/evogent"
state = root / "state"
incoming = root / "releases/B"
workspace = root / "migrations/legacy-forward-B"
tx = root / "install-transaction"
phone = state / "phone-tools"
for value in (incoming / "phone-tools", incoming / "device", workspace, tx, phone):
    value.mkdir(parents=True, exist_ok=True)
trace = base / "start.log"
restart = incoming / "device/restart-evo.sh"
boot = incoming / "phone-tools/evogent-boot.sh"
restart.write_text("#!/bin/sh\\necho restart >> " + str(trace) + "\\n")
boot.write_text("#!/bin/sh\\necho boot >> " + str(trace) + "\\n")
os.chmod(restart, 0o700)
os.chmod(boot, 0o700)
dependency = incoming / "device/dependency-tree-state.py"
dependency.write_text("raise SystemExit(0)\\n")
(incoming / "device/install-release.sh").write_text("installer\\n")
(incoming / "manifest.json").write_text("{}\\n")

os.symlink(str(root / "current/phone-tools/evogent-boot.sh"),
           phone / "evogent-boot.sh")
os.symlink(str(root / "current/device/install-release.sh"),
           phone / "install-release.sh")
(phone / ".cycle.lock").mkdir()
os.symlink("releases/B", root / "current")
assert (root / "current").resolve() == incoming, (
    (root / "current").resolve(), incoming)
for target, value in (
    (home / "evogent", str(root / "current/runtime")),
    (home / "phone-tools", str(phone)),
    (home / "start-prod.sh", str(root / "current/device/start-prod.sh")),
    (home / "restart-evo.sh", str(root / "current/device/restart-evo.sh")),
    (home / "deploy-next.sh", str(root / "current/phone-tools/deploy-next.sh")),
    (home / "install-evogent-release.sh",
     str(root / "current/device/install-release.sh")),
):
    target.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(value, target)

source_files = {}
for name, mode in (
    ("source-journal.json", 0o600),
    ("source-install-release.sh", 0o700),
    ("source-rollback-plan.json", 0o600),
    ("source-android-role-holders.json", 0o600),
):
    value = workspace / name
    value.write_text(name + "\\n")
    os.chmod(value, mode)
    source_files[name] = value
manifest = {
    "android": {"versionCode": 7, "sha256": "a" * 64},
    "phoneTls": {"certificateDerSha256": "b" * 64},
    "dependencies": {"packageLockSha256": "c" * 64},
}
ctx = types.SimpleNamespace(
    home=home, root=root, state=state, releases=root / "releases", tx=tx,
    journal=tx / "journal.json", recoverer=tx / "install-release.sh",
    old_recoverer=tx / "source-install-release.sh",
)
ctx.recoverer.write_text("recoverer\\n")
os.chmod(ctx.recoverer, 0o700)
payload = {
    "schema": rescue.SCHEMA,
    "forwardDecision": 1,
    "chainDepth": 0,
    "phase": "health_pending",
    "root": str(root),
    "home": str(home),
    "releaseId": "B",
    "newRelease": str(incoming),
    "workspace": str(workspace),
    "selfSha256": rescue.digest(rescue.__file__),
    "manifestSha256": rescue.digest(incoming / "manifest.json"),
    "sourceJournal": str(source_files["source-journal.json"]),
    "sourceJournalSha256": rescue.digest(source_files["source-journal.json"]),
    "sourceRecoverer": str(source_files["source-install-release.sh"]),
    "sourceRecovererSha256": rescue.digest(source_files["source-install-release.sh"]),
    "sourcePlan": str(source_files["source-rollback-plan.json"]),
    "sourcePlanSha256": rescue.digest(source_files["source-rollback-plan.json"]),
    "sourceRole": str(source_files["source-android-role-holders.json"]),
    "sourceRoleSha256": rescue.digest(source_files["source-android-role-holders.json"]),
    "sourcePackageOperation": "/data/local/tmp/evogent-package-op." + "a" * 32,
    "sourcePreviousApkCode": "0",
    "databaseLogicalSha256": "d" * 64,
    "controlTokenSha256": "e" * 64,
    "nlinks": {},
    **manifest,
}
ctx.journal.write_text(json.dumps(payload, separators=(",", ":")) + "\\n")
os.chmod(ctx.journal, 0o600)
rescue.release = lambda _ctx, _path: {"releaseId": "B", **manifest}
rescue.load_forward = lambda value: rescue.jread(value.journal, 0o600)
rescue.migrated_authorities = lambda *_args: None
health_calls = []
rescue.healthy = lambda _ctx, journal: health_calls.append(journal["phase"])
held = [None, None, types.SimpleNamespace(relocate=lambda _path: None)]
committed = rescue.advance(ctx, held)
assert committed["phase"] == "committed", committed
assert json.loads(ctx.journal.read_text())["phase"] == "committed"
assert health_calls == ["health_pending", "committed"], health_calls
assert trace.read_text().splitlines() == ["restart", "boot", "restart", "boot"], trace.read_text()
rescue.retire(ctx, committed)
assert not ctx.journal.exists(), "journal remains"
assert (workspace / "committed-journal.json").is_file(), "archive missing"
assert not ctx.recoverer.exists(), "recoverer remains"
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('shell publications, moved cycle locks, and stale owners stay identity-bound', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-binding-'));
  const script = `${loadPrelude()}
import os
import pathlib
import shutil
import stat
import sys

base = pathlib.Path(sys.argv[2])
rescue.ANDROID_SHELL_UID = os.geteuid()
current_pid = os.getpid()
rescue.proc_start = lambda pid: "test-start" if pid == current_pid else ""
payload = base / "payload"
payload.write_bytes(b"proof")
os.chmod(payload, 0o600)
entry = os.lstat(payload)
binding = (entry.st_dev, entry.st_ino, entry.st_uid, entry.st_nlink)
os.chmod(payload, 0o644)
assert rescue.shell_slurp(payload, 64, binding) == b"proof"
replacement = base / "replacement"
replacement.write_bytes(b"swap")
os.chmod(replacement, 0o644)
os.replace(replacement, payload)
try:
    rescue.shell_slurp(payload, 64, binding)
except rescue.Error:
    pass
else:
    raise AssertionError("capture pathname swap was accepted")

home_tools = base / "home-tools"
state_tools = base / "state-tools"
home_tools.mkdir()
gate = rescue.Lock(home_tools / ".cycle.lock", "cycle")
os.rename(home_tools, state_tools)
gate.relocate(state_tools / ".cycle.lock")
gate.release()
assert not (state_tools / ".cycle.lock").exists()

stale = base / "stale.lock"
stale.mkdir()
(stale / "owner").write_text("pid=999999999\\nstart=1\\nlabel=stale\\n")
os.chmod(stale / "owner", 0o600)
owned = rescue.Lock(stale, "stale")
owned.verify()
owned.release()
assert not stale.exists()

malformed = base / "malformed.lock"
malformed.mkdir()
(malformed / "owner").write_text("not-an-owner\\n")
os.chmod(malformed / "owner", 0o600)
owned = rescue.Lock(malformed, "malformed")
owned.release()
assert not malformed.exists()

pending = base / "pending.lock.pending.0123456789abcdef"
pending.mkdir()
(pending / "owner").write_text("pid=999999999\\nstart=1\\nlabel=pending\\n")
os.chmod(pending / "owner", 0o600)
old = 1_700_000_000
os.utime(pending, (old, old))
owned = rescue.Lock(base / "pending.lock", "pending")
owned.release()
assert not pending.exists()
`;
  const result = run('python3', ['-c', script, rescue, fixture], {
    env: { ...process.env, EVOGENT_INSTALL_WAIT_SECONDS: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a crash after pending-lock tombstoning is replayable without a poison glob', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-pending-reap-'));
  const pending = path.join(fixture, 'install.lock.pending.0123456789abcdef');
  fs.mkdirSync(pending, { mode: 0o700 });
  fs.writeFileSync(
    path.join(pending, 'owner'),
    'pid=999999999\nstart=1\nlabel=release-install\n',
    { mode: 0o600 },
  );
  fs.utimesSync(pending, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const crashScript = `${loadPrelude()}
import os
import pathlib
import sys
rescue.proc_start = lambda pid: "self-start" if pid == os.getpid() else ""
rescue.Lock(pathlib.Path(sys.argv[2]) / "install.lock", "release-install")
`;
  const crashed = run('python3', ['-c', crashScript, rescue, fixture], {
    env: {
      ...process.env,
      EVOGENT_FORWARD_TEST_CRASH_PENDING_REAP: '1',
      EVOGENT_INSTALL_WAIT_SECONDS: '1',
    },
  });
  assert.equal(crashed.status, 77, crashed.stderr);
  assert.deepEqual(
    fs.readdirSync(fixture).filter((name) => name.startsWith('install.lock.pending.')),
    [],
  );
  const tombstones = fs
    .readdirSync(fixture)
    .filter((name) => name.startsWith('install.lock.pending-stale.'));
  assert.equal(tombstones.length, 1);

  const replayScript = `${loadPrelude()}
import os
import pathlib
import sys
rescue.proc_start = lambda pid: "self-start" if pid == os.getpid() else ""
gate = rescue.Lock(pathlib.Path(sys.argv[2]) / "install.lock", "release-install")
gate.verify()
gate.release()
`;
  const replayed = run('python3', ['-c', replayScript, rescue, fixture], {
    env: { ...process.env, EVOGENT_INSTALL_WAIT_SECONDS: '1' },
  });
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.deepEqual(fs.readdirSync(fixture), []);
});

test('partial real lock retirement preserves intent and a fresh owner converges', () => {
  for (const [point, status] of [
    ['owner', 78],
    ['rmdir', 79],
  ]) {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), `evogent-forward-lock-release-${point}-`),
    );
    const journal = path.join(fixture, 'journal.json');
    fs.writeFileSync(journal, '{"durableIntent":true}\n', { mode: 0o600 });
    const crashScript = `${loadPrelude()}
import os
import pathlib
import sys
rescue.proc_start = lambda pid: "self-start" if pid == os.getpid() else ""
gate = rescue.Lock(pathlib.Path(sys.argv[2]) / "install.lock", "release-install")
gate.release()
`;
    const crashed = run('python3', ['-c', crashScript, rescue, fixture], {
      env: {
        ...process.env,
        EVOGENT_FORWARD_TEST_CRASH_LOCK_RELEASE: point,
        EVOGENT_INSTALL_WAIT_SECONDS: '1',
      },
    });
    assert.equal(crashed.status, status, crashed.stderr);
    assert.equal(fs.readFileSync(journal, 'utf8'), '{"durableIntent":true}\n');
    if (point === 'owner') {
      assert.equal(fs.existsSync(path.join(fixture, 'install.lock')), true);
      assert.equal(fs.existsSync(path.join(fixture, 'install.lock/owner')), false);
    } else {
      assert.equal(fs.existsSync(path.join(fixture, 'install.lock')), false);
    }

    const replayScript = `${loadPrelude()}
import os
import pathlib
import sys
rescue.proc_start = lambda pid: "self-start" if pid == os.getpid() else ""
gate = rescue.Lock(pathlib.Path(sys.argv[2]) / "install.lock", "release-install")
gate.verify()
gate.release()
`;
    const replayed = run('python3', ['-c', replayScript, rescue, fixture], {
      env: { ...process.env, EVOGENT_INSTALL_WAIT_SECONDS: '1' },
    });
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.deepEqual(fs.readdirSync(fixture), ['journal.json']);
  }
});

test('namespace syscall-to-fsync crashes replay every required parent barrier', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-fsync-replay-'));
  const script = `${loadPrelude()}
import os
import pathlib
import types
import sys

base = pathlib.Path(sys.argv[2])

def fail_sync(_path):
    raise OSError("injected post-syscall crash")

def record():
    seen = []
    rescue.sync_dir = lambda value: seen.append(pathlib.Path(value))
    return seen

published = base / "put/value"
published.parent.mkdir()
rescue.sync_dir = fail_sync
try:
    rescue.put(published, b"durable", 0o600)
except OSError:
    pass
else:
    raise AssertionError("put fault did not fire")
assert published.read_bytes() == b"durable"
seen = record()
rescue.put(published, b"durable", 0o600)
assert published.parent in seen, seen

created = base / "ensure/child"
created.parent.mkdir()
rescue.sync_dir = fail_sync
try:
    rescue.ensure_dir(created)
except OSError:
    pass
else:
    raise AssertionError("mkdir fault did not fire")
assert created.is_dir()
seen = record()
rescue.ensure_dir(created)
assert created.parent in seen and created in seen, seen

symlink = base / "links/value"
symlink.parent.mkdir()
rescue.sync_dir = fail_sync
try:
    rescue.link(symlink, "target")
except OSError:
    pass
else:
    raise AssertionError("symlink fault did not fire")
assert symlink.is_symlink() and os.readlink(symlink) == "target"
seen = record()
rescue.link(symlink, "target")
assert symlink.parent in seen, seen

source = base / "source/value"
target = base / "target/value"
source.parent.mkdir()
target.parent.mkdir()
source.write_bytes(b"move")
expected = rescue.capture(source)
rescue.sync_dir = fail_sync
try:
    rescue.move(expected, expected["nlink"], [source], target)
except OSError:
    pass
else:
    raise AssertionError("rename fault did not fire")
assert not source.exists() and target.read_bytes() == b"move"
seen = record()
rescue.move(expected, expected["nlink"], [source], target)
assert source.parent in seen and target.parent in seen, seen

mutable_source = base / "mutable-source/runtime"
mutable_target = base / "mutable-target/runtime"
mutable_source.parent.mkdir()
mutable_target.parent.mkdir()
mutable_source.mkdir()
mutable_expected = rescue.capture(mutable_source)
rescue.sync_dir = fail_sync
try:
    rescue.move(
        mutable_expected,
        mutable_expected["nlink"],
        [mutable_source],
        mutable_target,
        True,
    )
except OSError:
    pass
else:
    raise AssertionError("mutable rename fault did not fire")
(mutable_target / "post-move-child").mkdir()
seen = record()
rescue.move(
    mutable_expected,
    mutable_expected["nlink"],
    [mutable_source],
    mutable_target,
    True,
)
assert mutable_source.parent in seen and mutable_target.parent in seen, seen

incoming = base / "seed-release"
defaults = incoming / "defaults/data"
data = base / "seed-data"
defaults.mkdir(parents=True)
data.mkdir()
(defaults / "default.txt").write_bytes(b"default")
rescue.sync_dir = fail_sync
try:
    rescue.seed(incoming, data)
except OSError:
    pass
else:
    raise AssertionError("seed publication fault did not fire")
assert (data / "default.txt").read_bytes() == b"default"
seen = record()
rescue.seed(incoming, data)
assert data in seen, seen

migrations = base / "migrations"
migrations.mkdir()
workspace = migrations / "legacy-forward-replay"
rescue.sync_dir = fail_sync
try:
    rescue.ensure_dir(workspace)
except OSError:
    pass
else:
    raise AssertionError("workspace mkdir fault did not fire")
seen = record()
rescue.ensure_dir(workspace)
assert migrations in seen and workspace in seen, seen

root = base / "pointer"
(root / "releases/A").mkdir(parents=True)
(root / "releases/B").mkdir()
os.symlink("releases/A", root / "current")
ctx = types.SimpleNamespace(root=root)
journal = {
    "releaseId": "B",
    "chainDepth": 1,
    "previousReleaseId": "A",
    "previousPhase": "health_pending",
}
rescue.sync_dir = fail_sync
try:
    rescue.publish_current(ctx, journal)
except OSError:
    pass
else:
    raise AssertionError("pointer fault did not fire")
assert os.readlink(root / "current") == "releases/B"
seen = record()
rescue.publish_current(ctx, journal)
assert root in seen, seen

switch_home = base / "switch-home"
switch_root = base / "switch-root"
switch_state = switch_root / "state"
switch_phone = switch_state / "phone-tools"
switch_workspace = switch_root / "migrations/legacy-forward-switch"
switch_retired = switch_workspace / "phone-tools"
switch_incoming = switch_root / "releases/B"
for directory in (
    switch_home,
    switch_phone,
    switch_retired,
    switch_incoming,
):
    directory.mkdir(parents=True)
(switch_phone / "last-legacy-tool").write_text("legacy")
switch_ctx = types.SimpleNamespace(
    home=switch_home,
    root=switch_root,
    state=switch_state,
)
switch_journal = {
    "phase": "switch_pending",
    "newRelease": str(switch_incoming),
    "workspace": str(switch_workspace),
}
rescue.desired_phone_tools = lambda *_args: {}
rescue.link = lambda *_args: None
rescue.publish_current = lambda *_args: None
sync_count = {"value": 0}
def fail_after_retirement(path):
    sync_count["value"] += 1
    if sync_count["value"] == 3:
        raise OSError("injected final-retirement crash")
rescue.sync_dir = fail_after_retirement
try:
    rescue.switch(switch_ctx, switch_journal)
except OSError:
    pass
else:
    raise AssertionError("retirement fault did not fire")
assert not (switch_phone / "last-legacy-tool").exists()
assert (switch_retired / "last-legacy-tool").is_file()
seen = record()
rescue.switch(switch_ctx, switch_journal)
assert switch_phone in seen and switch_retired in seen, seen
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('a killed runtime prepare leaves a tagged worker that recovery quiesces', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-prepare-kill-'));
  const fakeBin = path.join(fixture, 'bin');
  const runtime = path.join(fixture, 'release/runtime');
  const state = path.join(fixture, 'state');
  const pidPath = path.join(fixture, 'prepare.pid');
  const tagPath = path.join(fixture, 'prepare.tag');
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(
    path.join(fakeBin, 'timeout'),
    '#!/bin/sh\n[ "$1" = "-k" ] || exit 64\nshift 2\nshift\nexec "$@"\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(fakeBin, 'node'),
    `#!/usr/bin/env python3
import os
import pathlib
import time
pathlib.Path(os.environ["EVOGENT_TEST_PREPARE_PID"]).write_text(str(os.getpid()))
pathlib.Path(os.environ["EVOGENT_TEST_PREPARE_TAG"]).write_text(
    os.environ.get("EVOGENT_TASK_OWNER", ""))
while True:
    time.sleep(1)
`,
    { mode: 0o700 },
  );
  const prepareScript = `${loadPrelude()}
import pathlib
import types
import sys
base = pathlib.Path(sys.argv[2])
ctx = types.SimpleNamespace(state=base / "state")
journal = {
    "releaseId": "B",
    "newRelease": str(base / "release"),
    "sourceJournalSha256": "a" * 64,
}
rescue.prepare_runtime(ctx, journal)
`;
  let stderr = '';
  const preparer = spawn('python3', ['-c', prepareScript, rescue, fixture], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      EVOGENT_TEST_PREPARE_PID: pidPath,
      EVOGENT_TEST_PREPARE_TAG: tagPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  preparer.stderr.setEncoding('utf8');
  preparer.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let orphanPid;
  try {
    await waitUntil(() => fs.existsSync(pidPath));
    orphanPid = Number.parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
    assert.match(
      fs.readFileSync(tagPath, 'utf8'),
      /^evogent-forward-prepare:[0-9a-f]{64}$/,
    );
    assert.doesNotThrow(() => process.kill(orphanPid, 0));
    preparer.kill('SIGKILL');
    await new Promise((resolve) => preparer.once('exit', resolve));
    assert.doesNotThrow(() => process.kill(orphanPid, 0));

    const recoveryScript = `${loadPrelude()}
import os
import types
import sys
pid = int(sys.argv[2])
def start(number):
    try:
        os.kill(number, 0)
    except ProcessLookupError:
        return ""
    return "bound"
rescue.proc_start = start
rescue.tagged = lambda: [pid] if start(pid) else []
rescue.control_processes = lambda _ctx: {}
rescue.command = lambda *_args, **_kwargs: types.SimpleNamespace(returncode=1)
def stopped(_ctx):
    assert not start(pid), "tagged prepare worker survived quiescence"
rescue.stopped = stopped
rescue.quiesce(types.SimpleNamespace())
`;
    const recovered = run(
      'python3',
      ['-c', recoveryScript, rescue, String(orphanPid)],
      { timeout: 15_000 },
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    await waitUntil(() => {
      try {
        process.kill(orphanPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    if (preparer.exitCode === null && preparer.signalCode === null) {
      preparer.kill('SIGKILL');
    }
    if (Number.isInteger(orphanPid)) {
      try {
        process.kill(orphanPid, 'SIGKILL');
      } catch {
        // Already quiesced.
      }
    }
  }
  assert.equal(stderr, '');
});

test('quiescence ignores an inherited owner tag on the recoverer itself', () => {
  const script = `${loadPrelude()}
import os
import types
rescue.tagged = lambda: [os.getpid()]
rescue.control_processes = lambda _ctx: {}
rescue.proc_start = lambda pid: "self-start" if pid == os.getpid() else ""
rescue.command = lambda *_args, **_kwargs: types.SimpleNamespace(returncode=1)
rescue.socket.create_connection = lambda *_args, **_kwargs: (_ for _ in ()).throw(
    OSError("closed"))
rescue.time.sleep = lambda *_args: None
rescue.os.kill = lambda *_args, **_kwargs: (_ for _ in ()).throw(
    AssertionError("recoverer tried to signal itself"))
rescue.quiesce(types.SimpleNamespace(home=rescue.P("/unreferenced"),
                                     state=rescue.P("/unreferenced")))
`;
  const result = run('python3', ['-c', script, rescue], {
    env: { ...process.env, EVOGENT_TASK_OWNER: 'inherited-control-owner' },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('lock retirement failure prevents committed metadata retirement', () => {
  const script = `${loadPrelude()}
calls = []
class Lock:
    def __init__(self, name, fail=False):
        self.name = name
        self.fail = fail
    def release(self):
        calls.append("release:" + self.name)
        if self.fail:
            raise rescue.Error("release failed")
held = [Lock("install"), Lock("control"), Lock("cycle", True)]
rescue.retire = lambda *_args: calls.append("retire")
try:
    rescue.finalize(object(), {}, held)
except rescue.Error:
    pass
else:
    raise AssertionError("lock release failure was swallowed")
assert calls == ["release:cycle"]
assert "retire" not in calls
`;
  const result = run('python3', ['-c', script, rescue]);
  assert.equal(result.status, 0, result.stderr);
});

test('a failure after durable journal retirement does not stop committed runtime', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-retire-failure-'));
  const script = `${loadPrelude()}
import os
import pathlib
import types
import sys

base = pathlib.Path(sys.argv[2])
root = base / ".local/share/evogent"
tx = root / "install-transaction"
workspace = root / "migrations/legacy-forward-retire"
incoming = root / "releases/B"
for directory in (tx, workspace, incoming / "device"):
    directory.mkdir(parents=True)
journal_path = tx / "journal.json"
journal_path.write_text('{"schema":"evogent.phone.forward-rescue.v1"}\\n')
os.chmod(journal_path, 0o600)
recoverer = tx / "install-release.sh"
old_recoverer = tx / "source-install-release.sh"
recoverer.write_text("recoverer")
old_recoverer.write_text("source")
ctx = types.SimpleNamespace(
    root=root,
    tx=tx,
    journal=journal_path,
    recoverer=recoverer,
    old_recoverer=old_recoverer,
)
committed = {
    "phase": "committed",
    "chainDepth": 0,
    "releaseId": "B",
    "newRelease": str(incoming),
    "workspace": str(workspace),
}
raw = {"schema": rescue.SCHEMA, "root": str(root)}
rescue.Ctx = lambda _root: ctx
rescue.jread = lambda *_args, **_kwargs: raw
rescue.load_forward = lambda *_args, **_kwargs: raw
released = []
class Gate:
    def __init__(self, name):
        self.name = name
    def release(self):
        released.append(self.name)
held = [Gate("install"), Gate("control"), Gate("cycle")]
rescue.locks = lambda *_args, **_kwargs: held
rescue.advance = lambda *_args, **_kwargs: committed
rescue.command = lambda *_args, **_kwargs: None
quiesced = []
rescue.quiesce = lambda *_args: quiesced.append(True)
real_sync = rescue.sync_dir
syncs = {"value": 0}
def fail_after_durable_removal(path):
    syncs["value"] += 1
    if syncs["value"] == 3:
        raise OSError("injected post-retirement cleanup failure")
    real_sync(path)
rescue.sync_dir = fail_after_durable_removal
try:
    rescue.orchestrate("recover", journal=journal_path)
except OSError:
    pass
else:
    raise AssertionError("retirement fault did not fire")
assert not journal_path.exists(), "live intent was not retired"
assert (workspace / "committed-journal.json").is_file(), "forensic archive missing"
assert quiesced == [], "healthy committed runtime was fail-stopped"
assert released == ["cycle", "control", "install"], released
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('real migration and default seeding resume after mutable data nlink changes', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-migrate-'));
  const script = `${loadPrelude()}
import hashlib
import json
import os
import pathlib
import sqlite3
import types
import sys

base = pathlib.Path(sys.argv[2])
home = base / "home"
root = home / ".local/share/evogent"
state = root / "state"
workspace = root / "migrations/legacy-forward-test"
incoming = root / "releases/B"
runtime = home / "evogent"
data = runtime / "data"
phone = home / "phone-tools"
for value in (state, workspace / "home", workspace / "phone-tools",
              incoming / "defaults/data/new/sub", data, phone,
              runtime / "node_modules"):
    value.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(data / "media-agent.db")
db.execute("create table proof(value text)")
db.execute("insert into proof values ('kept')")
db.commit()
db.close()
(data / "control-token.txt").write_bytes(b"token")
os.chmod(data / "control-token.txt", 0o600)
(runtime / ".env.local").write_text("PRIVATE=1\\n")
(phone / "legacy-only.sh").write_text("legacy\\n")
(home / "start-prod.sh").write_text("start\\n")
(incoming / "defaults/data/new/sub/default.txt").write_text("seeded\\n")

ctx = types.SimpleNamespace(home=home, root=root, state=state)
entries = {
    "runtime": rescue.capture(runtime),
    "data": rescue.capture(data),
    "nodeModules": rescue.capture(runtime / "node_modules"),
    "environment": rescue.capture(runtime / ".env.local"),
    "phoneTools": rescue.capture(phone),
}
for name in rescue.HOME_NAMES:
    entries["home:" + name] = rescue.capture(home / name)
(phone / ".cycle.lock").mkdir()
counts = {
    key: rescue.capture(
        {
            "runtime": runtime,
            "data": data,
            "nodeModules": runtime / "node_modules",
            "environment": runtime / ".env.local",
            "phoneTools": phone,
            **{"home:" + name: home / name for name in rescue.HOME_NAMES},
        }[key]
    )["nlink"]
    for key, value in entries.items() if value["type"] != "absent"
}
plan_path = workspace / "source-rollback-plan.json"
plan_path.write_text(json.dumps({"entries": entries}) + "\\n")
os.chmod(plan_path, 0o600)
journal = {
    "phase": "migration_pending",
    "sourcePlan": str(plan_path),
    "workspace": str(workspace),
    "admittedEntries": entries,
    "nlinks": counts,
    "databaseLogicalSha256": rescue.logical_db(data / "media-agent.db"),
    "controlTokenSha256": hashlib.sha256(b"token").hexdigest(),
    "sourceJournalSha256": "a" * 64,
    "releaseId": "B",
    "newRelease": str(incoming),
}
rescue.effective_entries = lambda _plan, admitted: admitted
rescue.migrate(ctx, journal)
first_nlink = os.lstat(state / "data").st_nlink
rescue.migrate(ctx, journal)
assert os.lstat(state / "data").st_nlink == first_nlink
assert (state / "data/new/sub/default.txt").read_text() == "seeded\\n"
assert rescue.logical_db(state / "data/media-agent.db") == journal["databaseLogicalSha256"]
assert (state / "phone-tools/.cycle.lock").is_dir()
assert not (home / "evogent").exists()
assert not (home / "phone-tools").exists()
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('phone-tools switch retires extras and resumes after an interrupted rename', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-tools-'));
  const script = `${loadPrelude()}
import os
import pathlib
import types
import sys

base = pathlib.Path(sys.argv[2])
root = base / "root"
home = base / "home"
incoming = root / "releases" / "successor"
phone = root / "state" / "phone-tools"
workspace = root / "migrations" / "legacy-forward-successor"
for value in (home, incoming / "phone-tools", incoming / "device", phone,
              workspace / "phone-tools"):
    value.mkdir(parents=True, exist_ok=True)
for name in ("alpha.sh", "beta.py"):
    (incoming / "phone-tools" / name).write_text(name)
(incoming / "device" / "install-release.sh").write_text("installer")
for name in ("alpha.sh", "legacy-only.sh"):
    (phone / name).write_text("legacy-" + name)
(phone / ".cycle.lock").mkdir()
ctx = types.SimpleNamespace(root=root, state=root / "state", home=home)
journal = {
    "chainDepth": 0,
    "phase": "switch_pending",
    "newRelease": str(incoming),
    "releaseId": "successor",
    "workspace": str(workspace),
}

original = rescue.os.rename
seen = {"value": False}
def crash_after_first(source, target):
    original(source, target)
    if not seen["value"]:
        seen["value"] = True
        raise RuntimeError("crash")
rescue.os.rename = crash_after_first
try:
    rescue.switch(ctx, journal)
except RuntimeError:
    pass
else:
    raise AssertionError("fault did not fire")
rescue.os.rename = original
rescue.switch(ctx, journal)
rescue.switch(ctx, journal)
expected = {"alpha.sh", "beta.py", "install-release.sh", ".cycle.lock"}
assert {item.name for item in phone.iterdir()} == expected
assert {item.name for item in (workspace / "phone-tools").iterdir()} == {
    "alpha.sh", "legacy-only.sh"
}
for name in expected - {".cycle.lock"}:
    assert (phone / name).is_symlink()
assert (phone / ".cycle.lock").is_dir()
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('chain admission is bounded to exact prepare/health native and dependency state', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-chain-'));
  const script = `${loadPrelude()}
import hashlib
import os
import pathlib
import types
import sys

base = pathlib.Path(sys.argv[2])
previous = base / "releases/A"
incoming = base / "releases/B"
state = base / "state"
for release in (previous, incoming):
    for name in ("apk", "tls"):
        (release / name).mkdir(parents=True, exist_ok=True)
    (release / "apk/evogent.apk").write_bytes(b"same-apk")
    (release / "tls/server-cert.pem").write_bytes(b"same-cert")
    (release / "tls/server-key.pem").write_bytes(b"same-key")
(state / "data").mkdir(parents=True)
(state / "data/control-token.txt").write_bytes(b"token")
os.chmod(state / "data/control-token.txt", 0o600)
apk_sha = hashlib.sha256(b"same-apk").hexdigest()
token_sha = hashlib.sha256(b"token").hexdigest()
manifest = {
    "android": {"versionCode": 7, "sha256": apk_sha},
    "phoneTls": {"certificateDerSha256": "a" * 64},
    "dependencies": {"packageLockSha256": "b" * 64},
}
successor_manifest = {
    **manifest,
    "dependencies": {"packageLockSha256": "e" * 64},
}
ctx = types.SimpleNamespace(
    home=base / "home", root=base, releases=base / "releases", state=state)
calls = []
phase = {"value": "prepare_pending"}
prior = {
    "chainDepth": 0,
    "phase": "prepare_pending",
    "newRelease": str(previous),
    "sourcePackageOperation": "/data/local/tmp/evogent-package-op." + "a" * 32,
    "sourcePreviousApkCode": "0",
    "sourcePlan": str(base / "plan.json"),
    "sourceRole": str(base / "role.json"),
    "sourceRoleSha256": "c" * 64,
    "controlTokenSha256": token_sha,
    "admittedEntries": {},
    "rollbackTerminalProof": {
        "schema": rescue.TERMINAL_ROLLBACK_SCHEMA,
        "disposition": "terminal",
        "package": rescue.PACKAGE,
        "fromVersion": 7,
        "toVersion": 0,
        "rows": [{"rollbackId": 11, "committedSessionId": 21}],
        "successorValidatorAccepted": True,
    },
}
rescue.load_forward = lambda _ctx: {**prior, "phase": phase["value"]}
rescue.release = lambda _ctx, release: (
    successor_manifest if pathlib.Path(release) == incoming else manifest
)
rescue.topology = lambda _ctx, _journal: calls.append("health-topology")
rescue.migrated_topology = lambda _ctx, _journal: calls.append("prepare-topology")
rescue.quiesce = lambda _ctx: calls.append("quiesce")
rescue.stopped = lambda _ctx: calls.append("stopped")
expected_data = rescue.capture(state / "data")
rescue.jread = lambda value, _mode=None: (
    {"entries": {"data": expected_data}}
    if pathlib.Path(value) == base / "plan.json"
    else {"userId": 0}
)
rescue.effective_entries = lambda plan, _admitted: plan["entries"]
rescue.roles = lambda *_args: calls.append("roles")
rescue.logical_db = lambda _path: "d" * 64
rescue.native_terminal_evidence = lambda *_args: (
    calls.append("native") or prior["rollbackTerminalProof"])
def android(_script, purpose, _limit=4096, _timeout=30):
    if purpose == "control-token":
        return b"token"
    raise AssertionError(purpose)
rescue.android = android

for value, expected in (("prepare_pending", "prepare-topology"),
                        ("health_pending", "health-topology")):
    phase["value"] = value
    calls.clear()
    observed, _manifest, proof = rescue.chain_state(ctx, incoming)
    assert observed["phase"] == value
    assert expected in calls
    assert calls.count("quiesce") == 1
    assert calls.count("stopped") == 1
    assert proof["databaseLogicalSha256"] == "d" * 64

original_data = state / "original-data"
os.rename(state / "data", original_data)
(state / "data").mkdir()
(state / "data/control-token.txt").write_bytes(b"token")
os.chmod(state / "data/control-token.txt", 0o600)
try:
    rescue.chain_state(ctx, incoming)
except rescue.Error:
    pass
else:
    raise AssertionError("substituted data authority was accepted")
os.rename(state / "data", state / "substituted-data")
os.rename(original_data, state / "data")

(incoming / "tls/server-key.pem").write_bytes(b"changed-key")
try:
    rescue.chain_state(ctx, incoming)
except rescue.Error:
    pass
else:
    raise AssertionError("native-byte change was accepted")
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('real chained decision archives A and publishes B from both admitted phases', () => {
  for (const phase of ['prepare_pending', 'health_pending']) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `evogent-chain-decide-${phase}-`));
    const pinned = path.join(fixture, 'root/install-transaction/install-release.sh');
    fs.mkdirSync(path.dirname(pinned), { recursive: true });
    fs.copyFileSync(rescue, pinned);
    fs.chmodSync(pinned, 0o700);
    const script = `${loadPrelude()}
import json
import os
import pathlib
import types
import sys

root = pathlib.Path(sys.argv[2])
phase = sys.argv[3]
tx = root / "install-transaction"
incoming = root / "releases/B"
previous = root / "releases/A"
origin = root / "migrations/legacy-forward-A"
for value in (incoming, previous, origin, root / "migrations"):
    value.mkdir(parents=True, exist_ok=True)
(incoming / "manifest.json").write_text('{"release":"B"}\\n')
(previous / "manifest.json").write_text('{"release":"A"}\\n')
journal = tx / "journal.json"
prior = {
    "schema": rescue.SCHEMA,
    "forwardDecision": 1,
    "chainDepth": 0,
    "phase": phase,
    "root": str(root),
    "home": str(root.parent),
    "releaseId": "A",
    "newRelease": str(previous),
    "workspace": str(origin),
    "selfSha256": rescue.digest(rescue.__file__),
    "manifestSha256": rescue.digest(previous / "manifest.json"),
    "sourceJournal": str(origin / "source-journal.json"),
    "sourceJournalSha256": "1" * 64,
    "sourceRecoverer": str(origin / "source-install-release.sh"),
    "sourceRecovererSha256": "2" * 64,
    "sourcePlan": str(origin / "source-rollback-plan.json"),
    "sourcePlanSha256": "3" * 64,
    "sourceRole": str(origin / "source-android-role-holders.json"),
    "sourceRoleSha256": "4" * 64,
    "sourcePackageOperation": "/data/local/tmp/evogent-package-op." + "a" * 32,
    "sourcePreviousApkCode": "0",
    "databaseLogicalSha256": "5" * 64,
    "controlTokenSha256": "6" * 64,
    "admittedEntries": {},
    "nlinks": {},
    "android": {"versionCode": 7, "sha256": "a" * 64},
    "phoneTls": {"certificateDerSha256": "b" * 64},
    "dependencies": {"packageLockSha256": "c" * 64},
}
journal.write_text(json.dumps(prior, separators=(",", ":")) + "\\n")
os.chmod(journal, 0o600)
manifest = {
    "android": prior["android"],
    "phoneTls": prior["phoneTls"],
    "dependencies": {"packageLockSha256": "d" * 64},
}
proof = {
    "databaseLogicalSha256": "7" * 64,
    "controlTokenSha256": prior["controlTokenSha256"],
}
ctx = types.SimpleNamespace(
    root=root, tx=tx, journal=journal,
    recoverer=pathlib.Path(rescue.__file__),
)
rescue.chain_state = lambda _ctx, _incoming: (prior, manifest, proof)
rescue.decide_chain(ctx, incoming)
published = json.loads(journal.read_text())
assert published["chainDepth"] == 1
assert published["phase"] == "prepare_pending"
assert published["previousPhase"] == phase
assert published["previousReleaseId"] == "A"
assert published["releaseId"] == "B"
workspace = pathlib.Path(published["workspace"])
assert json.loads((workspace / "source-forward-journal.json").read_text()) == prior
assert (workspace / "source-forward-recoverer.sh").read_bytes() == pathlib.Path(
    rescue.__file__).read_bytes()
`;
    const result = run('python3', ['-c', script, pinned, path.join(fixture, 'root'), phase]);
    assert.equal(result.status, 0, `${phase}\n${result.stderr}`);
  }
});

test('chain pointer publication resumes atomically from pre- and post-switch states', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-pointer-'));
  const script = `${loadPrelude()}
import os
import pathlib
import types
import sys

root = pathlib.Path(sys.argv[2])
(root / "releases/A").mkdir(parents=True)
(root / "releases/B").mkdir()
ctx = types.SimpleNamespace(root=root)
health = {
    "chainDepth": 1,
    "previousPhase": "health_pending",
    "previousReleaseId": "A",
    "releaseId": "B",
}
os.symlink("releases/A", root / "current")
os.environ["EVOGENT_FORWARD_TEST_FAIL_AFTER_POINTER"] = "1"
try:
    rescue.publish_current(ctx, health)
except rescue.Error:
    pass
else:
    raise AssertionError("pointer fault did not fire")
assert os.readlink(root / "current") == "releases/B"
os.environ.pop("EVOGENT_FORWARD_TEST_FAIL_AFTER_POINTER")
rescue.publish_current(ctx, health)
assert os.readlink(root / "current") == "releases/B"

os.unlink(root / "current")
prepared = {**health, "previousPhase": "prepare_pending"}
rescue.publish_current(ctx, prepared)
assert os.readlink(root / "current") == "releases/B"
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('prepare_pending creates the successor cache durably and resumes after prepare failure', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-cache-'));
  const script = `${loadPrelude()}
import pathlib
import types
import sys

base = pathlib.Path(sys.argv[2])
state = base / "state"
runtime = base / "releases/B/runtime"
(state / "next-cache").mkdir(parents=True)
runtime.mkdir(parents=True)
ctx = types.SimpleNamespace(state=state)
journal = {
    "releaseId": "B",
    "newRelease": str(runtime.parent),
    "sourceJournalSha256": "a" * 64,
}
calls = {"value": 0}
def fail_once(*_args, **_kwargs):
    calls["value"] += 1
    if calls["value"] == 1:
        raise rescue.Error("prepare failed")
rescue.command = fail_once
try:
    rescue.prepare_runtime(ctx, journal)
except rescue.Error:
    pass
else:
    raise AssertionError("prepare failure did not fire")
cache = state / "next-cache/B"
assert cache.is_dir()
assert (cache / ".evogent-forward-owner").read_text() == "a" * 64 + "\\n"
rescue.command = lambda *_args, **_kwargs: None
rescue.prepare_runtime(ctx, journal)
assert cache.is_dir()
`;
  const result = run('python3', ['-c', script, rescue, fixture]);
  assert.equal(result.status, 0, result.stderr);
});

test('new release activation delegates an old forward journal to its pinned recoverer', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-handoff-'));
  const privateRoot = path.join(home, '.local/share/evogent');
  const transaction = path.join(privateRoot, 'install-transaction');
  const incoming = path.join(privateRoot, 'releases/B');
  for (const value of [
    path.join(privateRoot, 'releases'),
    path.join(privateRoot, 'state'),
    path.join(privateRoot, 'migrations'),
    transaction,
    incoming,
  ]) {
    fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  }
  const trace = path.join(home, 'chain-argv.json');
  const pinned = path.join(transaction, 'install-release.sh');
  fs.writeFileSync(
    pinned,
    `import json,sys\nopen(${JSON.stringify(trace)}, "w").write(json.dumps(sys.argv[1:]))\n`,
    { mode: 0o700 },
  );
  const journal = path.join(transaction, 'journal.json');
  fs.writeFileSync(
    journal,
    '{"schema":"evogent.phone.forward-rescue.v1"}\n',
    { mode: 0o600 },
  );
  const before = treeSnapshot(privateRoot);
  const result = run(
    'python3',
    [rescue, '--activate', incoming, privateRoot, journal],
    { env: { ...process.env, HOME: home } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(trace, 'utf8')), [
    '--chain-activate',
    incoming,
    privateRoot,
    journal,
  ]);
  assert.deepEqual(treeSnapshot(privateRoot), before);
});

test('generic installer stages a valid archive under its lock and reaches pinned rescue', () => {
  const fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-installer-e2e-')),
  );
  const home = path.join(fixture, 'home');
  const privateRoot = path.join(home, '.local/share/evogent');
  const transaction = path.join(privateRoot, 'install-transaction');
  const state = path.join(privateRoot, 'state');
  const releaseSource = path.join(fixture, 'bundle/release');
  const fakeBin = path.join(fixture, 'bin');
  const shellTmp = path.join(fixture, 'android-shell-tmp');
  const installedApk = path.join(fixture, 'installed.apk');
  const archive = path.join(fixture, 'successor.tar.gz');
  const trace = path.join(fixture, 'pinned-trace.json');
  for (const directory of [
    home,
    transaction,
    state,
    fakeBin,
    shellTmp,
    path.join(releaseSource, 'runtime/.next/server'),
    path.join(releaseSource, 'phone-tools'),
    path.join(releaseSource, 'device'),
    path.join(releaseSource, 'apk'),
    path.join(releaseSource, 'tls'),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const makeApk = `
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1], "w") as apk:
    apk.writestr("META-INF/CERT.RSA", b"fixture-signature-block")
    apk.writestr("res/raw/evogent_phone_ca.pem", b"fixture-ca")
`;
  let result = run('python3', ['-c', makeApk, installedApk]);
  assert.equal(result.status, 0, result.stderr);
  fs.copyFileSync(installedApk, path.join(releaseSource, 'apk/evogent.apk'));

  const certDer = Buffer.from('fixture-certificate-der');
  const certSha = sha256(certDer);
  const apkSha = sha256(fs.readFileSync(installedApk));
  const identityDigest = sha256(
    `apk-sha256:${apkSha}\ntls-cert-der-sha256:${certSha}\n`,
  ).slice(0, 12);
  const releaseId = `fixture-forward-${identityDigest}`;
  const buildId = 'fixture-build';
  const packageJson = '{"name":"fixture","version":"1.0.0"}\n';
  const packageLock = '{"lockfileVersion":3,"name":"fixture"}\n';
  const dependencyLock = sha256(packageLock);
  fs.writeFileSync(path.join(releaseSource, 'runtime/package.json'), packageJson);
  fs.writeFileSync(path.join(releaseSource, 'runtime/package-lock.json'), packageLock);
  fs.writeFileSync(path.join(releaseSource, 'runtime/.next/BUILD_ID'), `${buildId}\n`);
  fs.writeFileSync(
    path.join(releaseSource, 'runtime/.evogent-release.json'),
    `${JSON.stringify({
      buildId,
      releaseFormat: 1,
      releaseId,
      releaseIdentityDigest: identityDigest,
    })}\n`,
  );
  fs.writeFileSync(path.join(releaseSource, 'runtime/.next/shared.js'), 'shared\n');
  fs.symlinkSync(
    '../shared.js',
    path.join(releaseSource, 'runtime/.next/server/legitimate-parent-link.js'),
  );
  fs.writeFileSync(path.join(releaseSource, 'tls/server-cert.pem'), 'fixture-cert\n');
  fs.writeFileSync(path.join(releaseSource, 'tls/server-key.pem'), 'fixture-key\n', {
    mode: 0o600,
  });
  fs.copyFileSync(rescue, path.join(releaseSource, 'device/forward-rescue.sh'));
  fs.chmodSync(path.join(releaseSource, 'device/forward-rescue.sh'), 0o755);
  const dependencyHelper = `#!/usr/bin/env python3
import pathlib
import sys
action = sys.argv[1]
if action == "candidate-add":
    root, release_id = pathlib.Path(sys.argv[2]), sys.argv[3]
    candidates = root / "state/release-candidates"
    candidates.mkdir(parents=True, exist_ok=True)
    (candidates / release_id).write_text(release_id + "\\n")
elif action == "verify":
    raise SystemExit(0)
else:
    raise SystemExit(64)
`;
  fs.writeFileSync(
    path.join(releaseSource, 'device/dependency-tree-state.py'),
    dependencyHelper,
  );
  fs.writeFileSync(path.join(releaseSource, 'device/rollback-state.py'), 'pass\n');
  fs.writeFileSync(path.join(releaseSource, 'device/android-role-state.py'), 'pass\n');

  const links = {
    'runtime/.next/server/legitimate-parent-link.js': '../shared.js',
  };
  fs.writeFileSync(
    path.join(releaseSource, 'links.json'),
    `${JSON.stringify(links)}\n`,
  );
  const inventoryRows = [];
  function inventoryWalk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const value = path.join(directory, name);
      const relative = path.relative(releaseSource, value).split(path.sep).join('/');
      const info = fs.lstatSync(value);
      if (info.isDirectory()) {
        inventoryWalk(value);
      } else if (info.isFile() && !['files.sha256', 'links.json', 'manifest.json'].includes(relative)) {
        inventoryRows.push(`${sha256(fs.readFileSync(value))}  ${relative}`);
      }
    }
  }
  inventoryWalk(releaseSource);
  inventoryRows.sort();
  fs.writeFileSync(
    path.join(releaseSource, 'files.sha256'),
    `${inventoryRows.join('\n')}\n`,
  );
  const stateLinks = {
    'runtime/node_modules':
      `../../../state/dependencies/${dependencyLock}/node_modules`,
  };
  const manifest = {
    android: {
      package: 'net.dangish.evogent',
      sha256: apkSha,
      signerSha256: certSha,
      versionCode: 7,
      versionName: 'fixture',
    },
    dependencies: { packageLockSha256: dependencyLock },
    inventory: {
      algorithm: 'sha256',
      linksPath: 'links.json',
      linksSha256: sha256(fs.readFileSync(path.join(releaseSource, 'links.json'))),
      path: 'files.sha256',
      sha256: sha256(fs.readFileSync(path.join(releaseSource, 'files.sha256'))),
    },
    phoneTls: {
      certificateDerSha256: certSha,
      host: '127.0.0.1',
      port: 3443,
    },
    releaseFormat: 1,
    releaseId,
    releaseIdentityDigest: identityDigest,
    requiredPaths: [
      'runtime/.next/BUILD_ID',
      'runtime/.next/server/legitimate-parent-link.js',
      'runtime/.evogent-release.json',
      'runtime/package.json',
      'runtime/package-lock.json',
      'device/android-role-state.py',
      'device/dependency-tree-state.py',
      'device/forward-rescue.sh',
      'device/rollback-state.py',
      'apk/evogent.apk',
      'tls/server-cert.pem',
      'tls/server-key.pem',
    ],
    schema: 'evogent.phone.release.v1',
    stateLinks,
    web: { buildId },
  };
  fs.writeFileSync(
    path.join(releaseSource, 'manifest.json'),
    `${JSON.stringify(manifest)}\n`,
  );

  fs.mkdirSync(
    path.join(state, 'dependencies', dependencyLock),
    { recursive: true, mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(transaction, 'journal.json'),
    `${JSON.stringify({ schema: 'evogent.phone.forward-rescue.v1' })}\n`,
    { mode: 0o600 },
  );
  const pinned = path.join(transaction, 'install-release.sh');
  fs.writeFileSync(
    pinned,
    `import importlib.machinery
import importlib.util
import json
import os
import pathlib
import sys
incoming = pathlib.Path(sys.argv[2])
root = pathlib.Path(sys.argv[3])
journal = pathlib.Path(sys.argv[4])
loader = importlib.machinery.SourceFileLoader(
    "staged_forward_rescue", str(incoming / "device/forward-rescue.sh"))
spec = importlib.util.spec_from_loader(loader.name, loader)
program = importlib.util.module_from_spec(spec)
loader.exec_module(program)
program.proc_start = lambda pid: (
    "host-test-" + str(pid) if pid == os.getpid() else "")
gate = program.Lock(root / "install.lock", "release-install", True)
owner = gate.owner()
adopted = (
    sys.argv[1] == "--chain-activate"
    and owner.get("pid") == str(os.getpid())
    and owner.get("start") == "host-test-" + str(os.getpid())
    and owner.get("label") == "release-install"
)
candidate = root / "state/release-candidates" / incoming.name
assert adopted and candidate.is_file()
pathlib.Path(os.environ["EVOGENT_TEST_PINNED_TRACE"]).write_text(json.dumps({
    "adopted": adopted,
    "argv": sys.argv[1:],
    "candidate": candidate.name,
    "releaseId": json.loads((incoming / "manifest.json").read_text())["releaseId"],
}))
gate.release()
`,
    { mode: 0o700 },
  );

  const writeExecutable = (name, source) => {
    const target = path.join(fakeBin, name);
    fs.writeFileSync(target, source, { mode: 0o700 });
    return target;
  };
  writeExecutable(
    'stat',
    `#!/bin/sh
if [ "$1" = "-c" ]; then
  case "$2" in
    %a) format=%Lp ;;
    %u) format=%u ;;
    %h) format=%l ;;
    *) exit 64 ;;
  esac
  shift 2
  exec /usr/bin/stat -f "$format" "$@"
fi
exec /usr/bin/stat "$@"
`,
  );
  writeExecutable(
    'timeout',
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --foreground) shift ;;
    -k) shift 2 ;;
    [0-9]*) shift; break ;;
    *) break ;;
  esac
done
exec "$@"
`,
  );
  writeExecutable('npm', '#!/bin/sh\nexit 0\n');
  writeExecutable('node', '#!/bin/sh\nexit 0\n');
  writeExecutable(
    'openssl',
    `#!/usr/bin/env python3
import hashlib
import pathlib
import sys
args = sys.argv[1:]
command = args[0] if args else ""
if command == "pkcs7":
    pathlib.Path(args[args.index("-out") + 1]).write_bytes(b"fixture-signer-cert")
elif command == "x509":
    if "-checkend" in args:
        pass
    elif "-ext" in args:
        print("X509v3 Subject Alternative Name:")
        print("    IP Address:127.0.0.1")
    elif "-pubkey" in args:
        sys.stdout.buffer.write(b"fixture-public-key")
    elif "-outform" in args and args[args.index("-outform") + 1] == "DER":
        sys.stdout.buffer.write(${JSON.stringify(certDer.toString())}.encode())
elif command == "pkey":
    sys.stdin.buffer.read()
    sys.stdout.buffer.write(b"fixture-public-key")
elif command == "verify":
    pass
elif command == "dgst":
    print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest() + " *stdin")
else:
    raise SystemExit("unexpected openssl fixture command: " + repr(args))
`,
  );
  const rishDir = path.join(home, 'rish-bin');
  fs.mkdirSync(rishDir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(rishDir, 'rish'),
    `#!/bin/bash
[ "$1" = "-c" ] || exit 64
pm() {
  [ "$1" = "path" ] || return 64
  printf 'package:%s\\n' "$EVOGENT_TEST_INSTALLED_APK"
}
dumpsys() {
  [ "$1" = "package" ] || return 64
  printf 'versionCode=%s minSdk=35\\n' "$EVOGENT_TEST_VERSION_CODE"
}
eval "$2"
`,
    { mode: 0o700 },
  );

  const tarScript = `
import pathlib
import sys
import tarfile
source, archive = map(pathlib.Path, sys.argv[1:])
with tarfile.open(archive, "w:gz") as bundle:
    bundle.add(source, arcname="release", recursive=True)
`;
  result = run('python3', ['-c', tarScript, releaseSource, archive]);
  assert.equal(result.status, 0, result.stderr);
  fs.chmodSync(archive, 0o600);

  const originalInstaller = fs.readFileSync(installer, 'utf8');
  const procStart = /^proc_start\(\) \{\n[\s\S]*?^\}\n/m;
  assert.match(originalInstaller, procStart);
  const adaptedInstaller = originalInstaller
    .replaceAll('/data/local/tmp', shellTmp)
    .replaceAll('${ACTUAL_ARCHIVE_SHA256,,}', '$ACTUAL_ARCHIVE_SHA256')
    .replaceAll('${EXPECTED_ARCHIVE_SHA256,,}', '$EXPECTED_ARCHIVE_SHA256')
    .replace(
      procStart,
      `proc_start() {
  local pid="\${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf 'host-test-%s\\n' "$pid"
}
`,
    );
  const extractedInstaller = path.join(fixture, 'adapted-install-release.sh');
  fs.writeFileSync(extractedInstaller, adaptedInstaller, { mode: 0o700 });

  result = run(
    'bash',
    [
      extractedInstaller,
      '--forward-supersede',
      archive,
      sha256(fs.readFileSync(archive)),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
        EVOGENT_INSTALL_WAIT_SECONDS: '5',
        EVOGENT_TEST_INSTALLED_APK: installedApk,
        EVOGENT_TEST_PINNED_TRACE: trace,
        EVOGENT_TEST_VERSION_CODE: '7',
      },
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const handoff = JSON.parse(fs.readFileSync(trace, 'utf8'));
  const installedRelease = path.join(privateRoot, 'releases', releaseId);
  assert.deepEqual(handoff, {
    adopted: true,
    argv: [
      '--chain-activate',
      installedRelease,
      privateRoot,
      path.join(transaction, 'journal.json'),
    ],
    candidate: releaseId,
    releaseId,
  });
  assert.equal(fs.existsSync(path.join(privateRoot, 'install.lock')), false);
  assert.equal(
    fs.readlinkSync(
      path.join(installedRelease, 'runtime/.next/server/legitimate-parent-link.js'),
    ),
    '../shared.js',
  );
  assert.deepEqual(fs.readdirSync(path.join(privateRoot, 'staging')), []);
});

test('extracted installer enforces exact argv before touching transaction state', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-forward-interface-'));
  const home = path.join(fixture, 'home');
  const extracted = path.join(fixture, 'release/device/install-release.sh');
  const transaction = path.join(home, '.local/share/evogent/install-transaction');
  fs.mkdirSync(path.dirname(extracted), { recursive: true });
  fs.mkdirSync(transaction, { recursive: true });
  fs.copyFileSync(installer, extracted);
  fs.chmodSync(extracted, 0o700);
  fs.writeFileSync(path.join(transaction, 'sentinel'), 'untouched\n', { mode: 0o600 });
  const before = treeSnapshot(home);
  const hash = 'a'.repeat(64);

  const accepted = run(
    'bash',
    [extracted, '--forward-supersede', path.join(fixture, 'missing.tar.gz'), hash],
    { env: { ...process.env, HOME: home } },
  );
  assert.equal(accepted.status, 66, accepted.stderr);
  assert.match(accepted.stderr, /archive not found/);
  assert.deepEqual(treeSnapshot(home), before);

  const rejected = [
    [],
    ['--unknown', hash],
    [path.join(fixture, 'missing.tar.gz')],
    [path.join(fixture, 'missing.tar.gz'), hash, 'extra'],
    ['--recover'],
    ['--recover', '/not/a/journal', 'extra'],
    ['--forward-supersede'],
    ['--forward-supersede', '--recover', '/not/a/journal'],
    ['--forward-supersede', path.join(fixture, 'missing.tar.gz'), hash, 'extra'],
  ];
  for (const argv of rejected) {
    const result = run('bash', [extracted, ...argv], {
      env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 65, `${argv.join(' ')}\n${result.stderr}`);
    assert.match(result.stderr, /^usage: install-release\.sh /);
    assert.deepEqual(treeSnapshot(home), before);
  }

  const installerSource = fs.readFileSync(installer, 'utf8');
  assert.match(installerSource, /FORWARD_SUPERSEDE=1/);
  assert.match(
    installerSource,
    /exec python3 "\$FORWARD_RESCUER" \\\n\s+--activate "\$NEW_RELEASE" "\$ROOT" "\$TRANSACTION_JOURNAL"/,
  );
  assert.doesNotMatch(installerSource, /EVOGENT_FORWARD_SUPERSEDE/);

  const builderSource = fs.readFileSync(builder, 'utf8');
  assert.ok(builderSource.includes('phone-paradigm/device/forward-rescue.sh'));
  assert.ok(builderSource.includes('"device/forward-rescue.sh"'));
});
