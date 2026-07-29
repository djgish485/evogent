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
  'phone-paradigm/device/phone-tools/source-discovery.sh',
  'phone-paradigm/device/phone-tools/phone.sh',
  'phone-paradigm/device/phone-tools/benchmark-browse-models.sh',
  'phone-paradigm/device/phone-tools/benchmark-cu-micro.sh',
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

test('phone release packaging derives deterministic valid live learning defaults', (t) => {
  const builder = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const helper = shellFunction(builder, 'prepare_phone_live_defaults');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-live-defaults-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const outputs = [];
  for (const name of ['first', 'second']) {
    const defaults = path.join(fixture, name);
    fs.mkdirSync(defaults);
    for (const template of [
      'preference-insights.default.md',
      'source-cadence.default.json',
    ]) {
      fs.copyFileSync(
        path.join(root, 'data', template),
        path.join(defaults, template),
      );
    }
    const result = spawnSync(
      'bash',
      ['-c', `set -euo pipefail\n${helper}\nprepare_phone_live_defaults "$1"`, 'derive', defaults],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    outputs.push(defaults);
  }

  for (const liveName of ['preference-insights.md', 'source-cadence.json']) {
    const first = path.join(outputs[0], liveName);
    const second = path.join(outputs[1], liveName);
    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
    assert.equal(fs.statSync(first).mode & 0o777, 0o600);
    assert.equal(fs.statSync(second).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    fs.readFileSync(path.join(outputs[0], 'preference-insights.md')),
    fs.readFileSync(path.join(root, 'data/preference-insights.default.md')),
  );

  const cadence = JSON.parse(
    fs.readFileSync(path.join(outputs[0], 'source-cadence.json'), 'utf8'),
  );
  assert.ok(Object.keys(cadence).length > 1);
  assert.equal(Object.keys(cadence).some((source) => source.startsWith('_')), false);
  for (const [source, entry] of Object.entries(cadence)) {
    assert.equal(source, source.trim());
    assert.ok(Number.isFinite(entry.cadenceHours));
    assert.ok(entry.cadenceHours >= 0.25 && entry.cadenceHours <= 168);
    assert.ok(entry.why.trim().length > 0 && entry.why.length <= 240);
  }

  const privateArtifact = path.join(
    root,
    'phone-paradigm/device/phone-tools/private_artifact.py',
  );
  execFileSync(
    'python3',
    [
      privateArtifact,
      'validate',
      '--path',
      path.join(outputs[0], 'preference-insights.md'),
      '--kind',
      'preference',
    ],
    { stdio: 'pipe' },
  );
  execFileSync(
    'python3',
    [
      privateArtifact,
      'validate',
      '--path',
      path.join(outputs[0], 'source-cadence.json'),
      '--kind',
      'cadence',
    ],
    { stdio: 'pipe' },
  );
  assert.match(builder, /prepare_phone_live_defaults "\$RELEASE\/defaults\/data"/);
  assert.match(builder, /"defaults\/data\/preference-insights\.md"/);
  assert.match(builder, /"defaults\/data\/source-cadence\.json"/);
});

test('phone tmux selectors cannot prefix-match a sibling session', (t) => {
  const productionFiles = [
    'phone-paradigm/device/install-release.sh',
    'phone-paradigm/device/restart-evo.sh',
    'phone-paradigm/device/phone-tools/evogent-boot.sh',
    'phone-paradigm/device/phone-tools/evogent-watchdog.sh',
    'phone-paradigm/device/phone-tools/evogent-cycle.sh',
    'phone-paradigm/restore-device.sh',
  ];
  for (const relative of productionFiles) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(
      source,
      /tmux (?:has-session|kill-session) -t (?!['"]?=)/,
      relative,
    );
  }

  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  assert.match(
    shellFunction(installer, 'single_tmux_pane_pid'),
    /tmux list-panes -t "=\$1:"/,
  );
  const forwardRescue = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/forward-rescue.sh'),
    'utf8',
  );
  assert.match(
    forwardRescue,
    /"has-session", "-t", f"=\{name\}"/,
  );
  assert.match(
    forwardRescue,
    /"kill-session", "-t", f"=\{name\}"/,
  );

  if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) {
    t.skip('tmux is unavailable');
    return;
  }
  const socket = `evogent-exact-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const harness = `
set -euo pipefail
tmux() { command tmux -L "$SOCKET" "$@"; }
${shellFunction(installer, 'stop_tmux_session')}
${shellFunction(installer, 'single_tmux_pane_pid')}
cleanup_tmux() { command tmux -L "$SOCKET" kill-server 2>/dev/null || true; }
trap cleanup_tmux EXIT
tmux new-session -d -s evo-sched "exec sleep 30"
stop_tmux_session evo
tmux has-session -t '=evo-sched'
if single_tmux_pane_pid evo >/dev/null 2>&1; then
  exit 71
fi
tmux new-session -d -s evo "exec sleep 30"
pane="$(single_tmux_pane_pid evo)"
[[ "$pane" =~ ^[0-9]+$ ]]
stop_tmux_session evo
! tmux has-session -t '=evo' 2>/dev/null
tmux has-session -t '=evo-sched'
printf 'exact_tmux_scope=ok\\n'
`;
  const result = spawnSync(
    'bash',
    ['-c', harness],
    { encoding: 'utf8', env: { ...process.env, SOCKET: socket } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'exact_tmux_scope=ok\n');
});

test('scheduler gates every private-task and cycle dispatch behind release commit', () => {
  const scheduler = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/evogent-scheduler.sh'),
    'utf8',
  );
  const helpers = [
    'release_transaction_pending',
    'run_due_private_tasks_if_committed',
  ].map((name) => shellFunction(scheduler, name)).join('\n');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-scheduler-gate-'));
  const trace = path.join(fixture, 'trace');
  const harness = `
set -u
${helpers}
control_release_transaction_pending() { return "$TRANSACTION_RESULT"; }
control_lock_acquire() {
  printf 'acquire\\n' >> "$TRACE"
  [ "\${ACQUIRE_PUBLISHES_JOURNAL:-0}" = 1 ] && TRANSACTION_RESULT=0
  return 0
}
control_lock_release() { printf 'release\\n' >> "$TRACE"; }
run_due_overseer() {
  printf 'overseer\\n'
  [ "\${OVERSEER_PUBLISHES_JOURNAL:-0}" = 1 ] && TRANSACTION_RESULT=0
  return 0
}
RELEASE_ROOT="$1"
SCHEDULED_TASK_GATE="/cycle.lock"
SCHEDULED_TASK_GATE_HELD=0
SCHED_LOCK="/scheduler.lock"
CONTROL_ACTIVE_LOCK="$SCHED_LOCK"
TRACE="$2"
run_due_private_tasks_if_committed
`;
  let result = spawnSync(
    'bash',
    ['-c', harness, 'scheduler-gate', '/release-root', trace],
    { encoding: 'utf8', env: { ...process.env, TRANSACTION_RESULT: '0' } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.readFileSync(trace, 'utf8'), 'acquire\nrelease\n');
  fs.rmSync(trace);
  result = spawnSync(
    'bash',
    ['-c', harness, 'scheduler-gate', '/release-root', trace],
    { encoding: 'utf8', env: { ...process.env, TRANSACTION_RESULT: '1' } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'overseer\n');
  assert.equal(fs.readFileSync(trace, 'utf8'), 'acquire\nrelease\n');
  fs.rmSync(trace);
  result = spawnSync(
    'bash',
    ['-c', harness, 'scheduler-gate', '/release-root', trace],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TRANSACTION_RESULT: '1',
        ACQUIRE_PUBLISHES_JOURNAL: '1',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  fs.rmSync(trace);
  result = spawnSync(
    'bash',
    ['-c', harness, 'scheduler-gate', '/release-root', trace],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TRANSACTION_RESULT: '1',
        OVERSEER_PUBLISHES_JOURNAL: '1',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'overseer\n');

  assert.equal(
    (scheduler.match(/^[ \t]*run_due_overseer \|\| true$/gm) || []).length,
    1,
  );
  assert.equal(
    (scheduler.match(/run_due_(?:dream|reflection) \|\| true/g) || []).length,
    0,
  );
  assert.equal(
    (scheduler.match(/^[ \t]*run_due_private_tasks_if_committed$/gm) || []).length,
    5,
  );
  const schedulerLoop = scheduler.slice(
    scheduler.indexOf('NEXT_MIN=""\nINITIAL_FLOOR_CHECKED=0\n'),
  );
  assert.match(
    schedulerLoop,
    /while true; do\n  if pause_for_release_transaction; then\n    continue\n  fi\n  ensure_watchdog/,
  );
  assert.match(
    schedulerLoop,
    /if pause_for_release_transaction; then\n    continue\n  fi[\s\S]*?wait_for_persisted_cycle_failure_backoff\n  REQUEST_REASON=""/,
  );
  assert.match(
    scheduler,
    /wait_scheduler_seconds\(\) \{[\s\S]*?while \[ "\$remaining" -gt 0 \]; do[\s\S]*?run_due_private_tasks_if_committed[\s\S]*?ensure_watchdog/,
  );
  assert.match(
    scheduler,
    /wait_for_persisted_cycle_failure_backoff\(\) \{[\s\S]*?--cycle-failure-action remaining[\s\S]*?run_due_private_tasks_if_committed[\s\S]*?ensure_watchdog/,
  );
});

test('durable journal, not a preflight installer lease, gates the control plane', () => {
  const controlPlane = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/control-plane.sh'),
    'utf8',
  );
  const helper = shellFunction(controlPlane, 'control_release_transaction_pending');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-transaction-gate-'));
  const transaction = path.join(fixture, 'install-transaction');
  const harness = `
set -u
${helper}
control_release_transaction_pending "$1"
`;
  const pending = () => spawnSync(
    'bash',
    ['-c', harness, 'transaction-gate', fixture],
    { encoding: 'utf8' },
  );

  assert.equal(pending().status, 0);
  fs.mkdirSync(transaction);
  assert.equal(pending().status, 1);
  fs.mkdirSync(path.join(fixture, 'install.lock'));
  assert.equal(pending().status, 1);
  fs.writeFileSync(path.join(transaction, 'journal.json'), '{}\n');
  assert.equal(pending().status, 0);
  fs.unlinkSync(path.join(transaction, 'journal.json'));
  fs.symlinkSync('missing-journal', path.join(transaction, 'journal.json'));
  assert.equal(pending().status, 0);

  const mutationHelper = shellFunction(
    controlPlane,
    'control_release_mutation_gate_acquire',
  );
  const mutationRelease = shellFunction(
    controlPlane,
    'control_release_mutation_gate_release',
  );
  const mutationHarness = `
set -u
${mutationHelper}
${mutationRelease}
control_lock_acquire() {
  CONTROL_ACTIVE_LOCK="$1"
  printf 'acquire\\n' >> "$TRACE"
  [ "\${PUBLISH_DURING_ACQUIRE:-0}" = 1 ] && TRANSACTION_RESULT=0
  return 0
}
control_lock_release() { printf 'release\\n' >> "$TRACE"; CONTROL_ACTIVE_LOCK=""; }
control_release_transaction_pending() { return "$TRANSACTION_RESULT"; }
HOME="$1"
TRACE="$2"
CONTROL_ACTIVE_LOCK="/prior.lock"
CONTROL_RELEASE_MUTATION_GATE=""
CONTROL_RELEASE_MUTATION_PREVIOUS_ACTIVE_LOCK=""
if control_release_mutation_gate_acquire "$HOME" test-mutation; then
  printf 'admitted:%s\\n' "$CONTROL_ACTIVE_LOCK"
  control_release_mutation_gate_release
  printf 'restored:%s\\n' "$CONTROL_ACTIVE_LOCK"
else
  printf 'blocked:%s\\n' "$?"
fi
`;
  const mutationTrace = path.join(fixture, 'mutation-trace');
  let mutationResult = spawnSync(
    'bash',
    ['-c', mutationHarness, 'mutation', fixture, mutationTrace],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TRANSACTION_RESULT: '1',
        PUBLISH_DURING_ACQUIRE: '1',
      },
    },
  );
  assert.equal(mutationResult.status, 0, mutationResult.stderr);
  assert.equal(mutationResult.stdout, 'blocked:75\n');
  assert.equal(fs.readFileSync(mutationTrace, 'utf8'), 'acquire\nrelease\n');
  fs.rmSync(mutationTrace);
  mutationResult = spawnSync(
    'bash',
    ['-c', mutationHarness, 'mutation', fixture, mutationTrace],
    { encoding: 'utf8', env: { ...process.env, TRANSACTION_RESULT: '1' } },
  );
  assert.equal(mutationResult.status, 0, mutationResult.stderr);
  assert.equal(
    mutationResult.stdout,
    `admitted:${fixture}/control-plane-mutation.lock\nrestored:/prior.lock\n`,
  );

  const watchdog = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/evogent-watchdog.sh'),
    'utf8',
  );
  const boot = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/evogent-boot.sh'),
    'utf8',
  );
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const cycle = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/evogent-cycle.sh'),
    'utf8',
  );
  assert.match(watchdog, /control_release_transaction_pending "\$RELEASE_ROOT"/);
  assert.match(boot, /control_release_transaction_pending "\$RELEASE_ROOT"/);
  const barrierAcquire = installer.indexOf(
    'acquire_lock_dir "$CONTROL_MUTATION_GATE" release-install-control-barrier',
  );
  const journalPublish = installer.indexOf(
    'write_transaction_journal quiesce_pending',
    barrierAcquire,
  );
  const barrierRelease = installer.indexOf(
    'release_lock_dir "$CONTROL_MUTATION_GATE"',
    journalPublish,
  );
  const cycleAcquire = installer.indexOf(
    'acquire_lock_dir "$CYCLE_GATE" release-install-cycle-gate',
    barrierRelease,
  );
  assert.ok(
    barrierAcquire !== -1
      && barrierAcquire < journalPublish
      && journalPublish < barrierRelease
      && barrierRelease < cycleAcquire,
  );
  assert.ok(
    boot.indexOf('control_release_mutation_gate_acquire "$RELEASE_ROOT" boot-bringup')
      < boot.indexOf('DB integrity gate'),
  );
  assert.ok(
    watchdog.indexOf('control_release_mutation_gate_acquire')
      < watchdog.indexOf('tmux new-session -d -s evo-sched'),
  );
  assert.ok(
    cycle.indexOf('CYCLE_LOCK_HELD=1')
      < cycle.indexOf('control_release_transaction_pending'),
  );
  assert.ok(
    cycle.indexOf('control_release_transaction_pending')
      < cycle.indexOf('control_wake_acquire'),
  );
});

test('overseer proves health and wake before claim, then retires every held reference', () => {
  const scheduler = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/evogent-scheduler.sh'),
    'utf8',
  );
  const body = shellFunction(scheduler, 'run_due_overseer');
  const healthAt = body.indexOf('"$TOOLS/evo-health"');
  const ensureConfigAt = body.indexOf('ensure-phone-config');
  const ensureDueAt = body.indexOf('ensure-nightly');
  const acquiredAt = body.indexOf('if ! scheduled_task_wake_acquire overseer; then');
  const claimAt = body.indexOf('claim --root "$SCHEDULED_TASK_ROOT"');
  const providerAt = body.indexOf('codex exec --model "$model"');
  assert.ok(
    healthAt >= 0
      && healthAt < ensureConfigAt
      && ensureConfigAt < ensureDueAt
      && ensureDueAt < acquiredAt
      && acquiredAt < claimAt
      && claimAt < providerAt,
  );
  const hardWakeBranch = body.slice(acquiredAt, claimAt);
  assert.match(
    hardWakeBranch,
    /wake_acquire_failed[\s\S]*scheduled_task_wake_release \|\| true[\s\S]*return 2/,
  );
  assert.doesNotMatch(hardWakeBranch, /claim --root|codex exec|claude -p/);
  const claimedBody = body.slice(acquiredAt);
  const returns = [...claimedBody.matchAll(/^[ \t]*return [02]$/gm)];
  assert.ok(returns.length >= 3);
  for (const match of returns) {
    const priorLines = claimedBody.slice(0, match.index).trimEnd().split('\n');
    assert.match(
      priorLines.at(-1).trim(),
      /^scheduled_task_wake_release(?: \|\| true)?$/,
    );
  }
  const acquire = shellFunction(scheduler, 'scheduled_task_wake_acquire');
  const cleanup = shellFunction(scheduler, 'scheduler_cleanup');
  assert.match(
    cleanup,
    /for attempt in 1 2 3; do[\s\S]*?\[ "\$SCHEDULED_WAKE_HELD" = 1 \] \|\| break[\s\S]*?scheduled_task_wake_release && break/,
  );
  const releaseHarness = `
set -euo pipefail
${shellFunction(scheduler, 'scheduled_task_wake_release')}
attempts=0
SCHEDULED_WAKE_HELD=1
control_wake_release() {
  attempts=$((attempts + 1))
  [ "$attempts" -ge 2 ]
}
say() { :; }
sleep() { :; }
scheduled_task_wake_release
test "$attempts" = 2
test "$SCHEDULED_WAKE_HELD" = 0
`;
  const releaseResult = spawnSync(
    'bash',
    ['-c', releaseHarness, 'wake-release'],
    { encoding: 'utf8' },
  );
  assert.equal(releaseResult.status, 0, releaseResult.stderr);

  const acquireHarness = `
set -u
${acquire}
say() { :; }
control_wake_acquire() {
  CONTROL_WAKE_HELD="$CONTROL_HELD"
  return "$WAKE_RC"
}
SCHEDULED_WAKE_HELD=0
CONTROL_WAKE_HELD=0
if scheduled_task_wake_acquire overseer; then
  rc=0
else
  rc=$?
fi
printf '%s\\t%s\\t%s\\n' "$rc" "$SCHEDULED_WAKE_HELD" "$CONTROL_WAKE_HELD"
`;
  const runAcquire = (wakeRc, controlHeld) => spawnSync(
    'bash',
    ['-c', acquireHarness, 'wake-acquire'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTROL_HELD: String(controlHeld),
        WAKE_RC: String(wakeRc),
      },
    },
  );
  let acquireResult = runAcquire(125, 0);
  assert.equal(acquireResult.status, 0, acquireResult.stderr);
  assert.equal(acquireResult.stdout, '0\t0\t0\n');
  acquireResult = runAcquire(1, 1);
  assert.equal(acquireResult.status, 0, acquireResult.stderr);
  assert.equal(acquireResult.stdout, '76\t1\t1\n');
});

test('wake acquire refuses an undedicated Termux without touching its global lock', () => {
  const controlPlane = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/control-plane.sh'),
    'utf8',
  );
  const helpers = [
    'control_dedicated_termux_wake_enabled',
    'control_wake_acquire',
  ].map((name) => shellFunction(controlPlane, name)).join('\n');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-wake-policy-'));
  const fakeBin = path.join(fixture, 'bin');
  const trace = path.join(fixture, 'wake-trace');
  fs.mkdirSync(fakeBin);
  for (const binary of ['termux-wake-lock', 'termux-wake-unlock']) {
    fs.writeFileSync(
      path.join(fakeBin, binary),
      '#!/bin/sh\nprintf "%s\\n" "${0##*/}" >> "$TRACE"\n',
      { mode: 0o700 },
    );
  }
  const harness = `
set -euo pipefail
${helpers}
CONTROL_ROOT="$HOME/phone-tools/.control"
CONTROL_OWNER_ID=""
CONTROL_WAKE_HELD=0
status=0
control_wake_acquire || status=$?
test "$status" = 125
test "$CONTROL_WAKE_HELD" = 0
test ! -e "$TRACE"
`;
  const env = {
    ...process.env,
    HOME: fixture,
    PATH: `${fakeBin}:${process.env.PATH}`,
    TRACE: trace,
  };
  delete env.EVOGENT_DEDICATED_TERMUX_WAKE;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'wake-policy'],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(trace), false);
});

test('wake registry serializes global lock transitions and preserves live owners', async () => {
  const controlPlane = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/control-plane.sh'),
    'utf8',
  );
  const registryHelpers = [
    'control_wake_registry_acquire',
    'control_wake_registry_release',
  ].map((name) => shellFunction(controlPlane, name)).join('\n');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-wake-registry-'));
  const registryTrace = path.join(fixture, 'registry-trace');
  const registryHarness = `
set -u
${registryHelpers}
control_lock_acquire() {
  if mkdir "$1" 2>/dev/null; then
    CONTROL_ACTIVE_LOCK="$1"
    return 0
  fi
  return 1
}
control_lock_release() { rmdir "$1"; CONTROL_ACTIVE_LOCK=""; }
CONTROL_ROOT="$1"
CONTROL_ACTIVE_LOCK="/prior.lock"
CONTROL_WAKE_REGISTRY_HELD=0
CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK=""
control_wake_registry_acquire
printf 'enter-%s\\n' "$2" >> "$3"
sleep "$4"
printf 'leave-%s\\n' "$2" >> "$3"
control_wake_registry_release
test "$CONTROL_ACTIVE_LOCK" = /prior.lock
`;
  const first = spawn(
    'bash',
    ['-c', registryHarness, 'wake-registry', fixture, 'first', registryTrace, '0.2'],
  );
  const firstExitPromise = waitForExit(first);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      fs.existsSync(registryTrace)
      && fs.readFileSync(registryTrace, 'utf8').includes('enter-first')
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const second = spawn(
    'bash',
    ['-c', registryHarness, 'wake-registry', fixture, 'second', registryTrace, '0'],
  );
  const [firstExit, secondExit] = await Promise.all([
    firstExitPromise,
    waitForExit(second),
  ]);
  assert.equal(firstExit.status, 0, firstExit.stderr);
  assert.equal(secondExit.status, 0, secondExit.stderr);
  assert.deepEqual(fs.readFileSync(registryTrace, 'utf8').trim().split('\n'), [
    'enter-first',
    'leave-first',
    'enter-second',
    'leave-second',
  ]);

  const fakeBin = path.join(fixture, 'bin');
  const unlockTrace = path.join(fixture, 'unlock-trace');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, 'termux-wake-unlock'),
    '#!/bin/sh\nprintf "unlock\\n" >> "$TRACE"\n',
    { mode: 0o700 },
  );
  const wakeHelpers = [
    'control_wake_command',
    'control_dedicated_termux_wake_enabled',
    'control_wake_marker_state',
    'control_wake_marker_write_locked',
    'control_wake_establish_locked',
    'control_wake_registry_acquire',
    'control_wake_registry_release',
    'control_wake_prune_locked',
    'control_wake_release',
    'control_release_legacy_wake_if_idle',
  ].map((name) => shellFunction(controlPlane, name)).join('\n');
  const ownerHarness = `
set -euo pipefail
${wakeHelpers}
control_lock_acquire() { mkdir "$1"; CONTROL_ACTIVE_LOCK="$1"; }
control_lock_release() { rmdir "$1"; CONTROL_ACTIVE_LOCK=""; }
control_meta_field() { sed -n "s/^\${2}=//p" "$1" | head -1; }
control_pid_matches() { return "$LIVE_RESULT"; }
# This harness exercises wake-reference serialization, not GNU timeout portability.
# Keep the device implementation's bounded wrapper covered by the assertions below.
control_wake_command() { command "$1"; }
CONTROL_ROOT="$1"
CONTROL_OWNER_ID=A
CONTROL_ACTIVE_LOCK="/worker.lock"
CONTROL_WAKE_HELD=1
CONTROL_WAKE_REGISTRY_HELD=0
CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK=""
mkdir -p "$CONTROL_ROOT/wake/A" "$CONTROL_ROOT/wake/B"
printf 'pid=1\\nstart=1\\n' > "$CONTROL_ROOT/wake/A/owner"
printf 'pid=2\\nstart=2\\n' > "$CONTROL_ROOT/wake/B/owner"
printf 'held\\n' > "$CONTROL_ROOT/wake/.evogent-held"
LIVE_RESULT=0
control_wake_release
test -d "$CONTROL_ROOT/wake/B"
test ! -e "$TRACE"
LIVE_RESULT=1
control_release_legacy_wake_if_idle
test ! -d "$CONTROL_ROOT/wake/B"
test ! -e "$CONTROL_ROOT/wake/.evogent-held"
`;
  const ownerResult = spawnSync(
    'bash',
    ['-c', ownerHarness, 'wake-owner', fixture],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TRACE: unlockTrace,
        EVOGENT_DEDICATED_TERMUX_WAKE: '1',
      },
    },
  );
  assert.equal(ownerResult.status, 0, ownerResult.stderr);
  assert.equal(fs.readFileSync(unlockTrace, 'utf8'), 'unlock\n');

  const failedWakeRoot = path.join(fixture, 'failed-wake');
  const failedWakeTrace = path.join(fixture, 'failed-wake-trace');
  const failedWakeHelpers = [
    'control_dedicated_termux_wake_enabled',
    'control_wake_marker_state',
    'control_wake_marker_write_locked',
    'control_wake_establish_locked',
    'control_wake_registry_acquire',
    'control_wake_registry_release',
    'control_wake_prune_locked',
    'control_wake_acquire',
    'control_wake_release',
  ].map((name) => shellFunction(controlPlane, name)).join('\n');
  const failedWakeHarness = `
set -euo pipefail
${failedWakeHelpers}
control_lock_acquire() { mkdir "$1"; CONTROL_ACTIVE_LOCK="$1"; }
control_lock_release() { rmdir "$1"; CONTROL_ACTIVE_LOCK=""; }
control_meta_field() { sed -n "s/^\${2}=//p" "$1" | head -1; }
control_pid_matches() { return 0; }
control_wake_command() {
  printf '%s\\n' "$1" >> "$TRACE"
  [ "$1" != termux-wake-lock ]
}
CONTROL_ROOT="$1"
CONTROL_OWNER_ID=A
CONTROL_SELF_START=1
CONTROL_ACTIVE_LOCK=""
CONTROL_WAKE_HELD=0
CONTROL_WAKE_REGISTRY_HELD=0
CONTROL_WAKE_PREVIOUS_ACTIVE_LOCK=""
if control_wake_acquire; then exit 1; fi
test "$CONTROL_WAKE_HELD" = 1
if control_wake_release; then exit 1; fi
test "$CONTROL_WAKE_HELD" = 1
test -d "$CONTROL_ROOT/wake/A"
test "$(cat "$CONTROL_ROOT/wake/.evogent-held")" = uncertain
! grep -q termux-wake-unlock "$TRACE"
`;
  const failedWake = spawnSync(
    'bash',
    ['-c', failedWakeHarness, 'failed-wake', failedWakeRoot],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TRACE: failedWakeTrace,
        EVOGENT_DEDICATED_TERMUX_WAKE: '1',
      },
    },
  );
  assert.equal(failedWake.status, 0, failedWake.stderr);
  assert.deepEqual(
    fs.readFileSync(failedWakeTrace, 'utf8').trim().split('\n'),
    ['termux-wake-lock', 'termux-wake-lock', 'termux-wake-lock'],
  );

  const acquire = shellFunction(controlPlane, 'control_wake_acquire');
  assert.ok(
    acquire.indexOf('control_wake_marker_write_locked acquiring')
      < acquire.indexOf('control_wake_establish_locked'),
  );
  const boundedWake = shellFunction(controlPlane, 'control_wake_command');
  assert.match(boundedWake, /CONTROL_WAKE_COMMAND_SECONDS:-8/);
  assert.match(boundedWake, /timeout -k 2 "\$budget" "\$binary"/);
  assert.match(boundedWake, /<\/dev\/null/);
  assert.match(
    shellFunction(controlPlane, 'control_dedicated_termux_wake_enabled'),
    /EVOGENT_DEDICATED_TERMUX_WAKE_V1/,
  );
});

test('control lock reaper accepts dead legacy modes but defers a live legacy owner', () => {
  const controlPlane = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/control-plane.sh'),
    'utf8',
  );
  const operation = shellFunction(
    controlPlane,
    'control_lock_directory_operation',
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-control-lock-legacy-'),
  );
  const lock = path.join(fixture, 'scheduler.lock');
  const stale = path.join(fixture, 'scheduler.lock.stale');
  const writeLegacyLock = (pid) => {
    fs.mkdirSync(lock, { mode: 0o755 });
    fs.writeFileSync(
      path.join(lock, 'owner'),
      `owner=legacy\npid=${pid}\nstart=1\nlabel=scheduler\nacquired=1\n`,
      { mode: 0o644 },
    );
    fs.writeFileSync(path.join(lock, 'heartbeat'), '', { mode: 0o644 });
  };

  writeLegacyLock(999_999_999);
  const dead = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${operation}
control_lock_directory_operation reap "$1" "$2"
`,
      'dead-legacy',
      lock,
      stale,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(dead.status, 0, dead.stderr);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.statSync(stale).isDirectory(), true);
  fs.rmSync(stale, { recursive: true });

  writeLegacyLock(process.pid);
  const live = spawnSync(
    'bash',
    [
      '-c',
      `set -uo pipefail
${operation}
status=0
control_lock_directory_operation reap "$1" "$2" || status=$?
test "$status" = 75
test -d "$1"
`,
      'live-legacy',
      lock,
      stale,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(live.status, 0, live.stderr);
});

test('control lock publication durably fsyncs through the canonical phone-tools symlink', () => {
  const controlPlane = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/control-plane.sh'),
    'utf8',
  );
  const operation = shellFunction(
    controlPlane,
    'control_lock_directory_operation',
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-control-lock-symlink-parent-'),
  );
  const stateTools = path.join(fixture, 'state', 'phone-tools');
  const dispatchTools = path.join(fixture, 'phone-tools');
  fs.mkdirSync(stateTools, { recursive: true, mode: 0o700 });
  fs.symlinkSync(stateTools, dispatchTools, 'dir');
  const candidate = path.join(dispatchTools, '.scheduler.lock.pending.fixture');
  const lock = path.join(dispatchTools, '.scheduler.lock');
  fs.mkdirSync(candidate, { mode: 0o700 });
  fs.writeFileSync(
    path.join(candidate, 'owner'),
    `owner=fixture\npid=${process.pid}\nstart=1\nlabel=scheduler\nacquired=1\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(candidate, 'heartbeat'), '', { mode: 0o600 });

  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${operation}
control_lock_directory_operation publish "$1" "$2"
`,
        'symlink-parent',
        candidate,
        lock,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(candidate), false);
    assert.equal(fs.statSync(lock).isDirectory(), true);
    assert.equal(fs.realpathSync(path.dirname(lock)), fs.realpathSync(stateTools));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('installer creates its private tree with no-follow component walks', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const prepare = shellFunction(
    installer,
    'prepare_private_release_directories',
  );
  const fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-private-tree-')),
  );
  const home = path.join(fixture, 'home');
  fs.mkdirSync(home);
  const harness = `
set -euo pipefail
${prepare}
HOME="$1"
ROOT="$2"
RELEASES="$ROOT/releases"
STATE="$ROOT/state"
DEPENDENCIES="$STATE/dependencies"
DEPENDENCY_BUILDS="$STATE/dependency-builds"
DEPENDENCY_QUARANTINE="$STATE/dependency-quarantine"
RELEASE_CANDIDATES="$STATE/release-candidates"
STAGING_ROOT="$ROOT/staging"
BACKUPS="$ROOT/backups"
MIGRATIONS="$ROOT/migrations"
LOGS="$ROOT/logs"
TRANSACTION_DIR="$ROOT/install-transaction"
prepare_private_release_directories
`;
  const prepareTree = (releaseRoot) => spawnSync(
    'bash',
    ['-c', harness, 'prepare', home, releaseRoot],
    { encoding: 'utf8' },
  );

  const deepRoot = path.join(fixture, 'custom/deep/release-root');
  let prepared = prepareTree(deepRoot);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(
    fs.lstatSync(path.join(deepRoot, 'state/dependencies')).isDirectory(),
    true,
  );
  assert.equal(
    fs.lstatSync(path.join(deepRoot, 'install-transaction')).mode & 0o777,
    0o700,
  );

  const attacker = path.join(fixture, 'attacker');
  fs.mkdirSync(attacker);
  const pivot = path.join(fixture, 'pivot');
  fs.symlinkSync(attacker, pivot);
  prepared = prepareTree(path.join(pivot, 'nested/release-root'));
  assert.notEqual(prepared.status, 0);
  assert.equal(fs.existsSync(path.join(attacker, 'nested')), false);

  const leafRoot = path.join(fixture, 'leaf-root');
  fs.mkdirSync(leafRoot);
  fs.symlinkSync(attacker, path.join(leafRoot, 'releases'));
  prepared = prepareTree(leafRoot);
  assert.notEqual(prepared.status, 0);
  assert.equal(fs.existsSync(path.join(leafRoot, 'state')), false);
  assert.equal(fs.readdirSync(attacker).length, 0);

  const transactionRoot = path.join(fixture, 'transaction-root');
  fs.mkdirSync(transactionRoot);
  fs.chmodSync(attacker, 0o755);
  fs.symlinkSync(attacker, path.join(transactionRoot, 'install-transaction'));
  prepared = prepareTree(transactionRoot);
  assert.notEqual(prepared.status, 0);
  assert.equal(fs.lstatSync(attacker).mode & 0o777, 0o755);

  const alternateRoot = path.join(fixture, 'unsupported-production-root');
  const rejectedArchive = path.join(fixture, 'rejected-release.tar.gz');
  fs.writeFileSync(rejectedArchive, 'untouched archive\n', { mode: 0o644 });
  const rejectedProductionRoot = spawnSync(
    'bash',
    [
      path.join(root, 'phone-paradigm/device/install-release.sh'),
      rejectedArchive,
      '0'.repeat(64),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVOGENT_RELEASE_ROOT: alternateRoot,
        HOME: home,
      },
    },
  );
  assert.equal(rejectedProductionRoot.status, 65);
  assert.match(rejectedProductionRoot.stderr, /not reboot-safe/);
  assert.equal(fs.existsSync(alternateRoot), false);
  assert.equal(fs.lstatSync(rejectedArchive).mode & 0o777, 0o644);

  assert.match(prepare, /getattr\(os, "O_PATH", os\.O_RDONLY\)/);
  assert.match(prepare, /os\.open\(component, walk_flags, dir_fd=descriptor\)/);
  assert.match(prepare, /os\.mkdir\(component, 0o700, dir_fd=descriptor\)/);
  assert.match(prepare, /sync_walked_directory\(child, mode=0o700\)/);
  assert.match(prepare, /sync_walked_directory\(descriptor\)/);
});

test('versioned state preparation rejects symlinked canonical components', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'prepare_versioned_state_directories');
  const harness = `
set -u
${helper}
STATE="$1"
prepare_versioned_state_directories release-fixture
`;
  const prepare = (state) => spawnSync(
    'bash',
    ['-c', harness, 'state-prepare', state],
    { encoding: 'utf8' },
  );

  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-state-clean-'));
  const cleanState = path.join(clean, 'state');
  fs.mkdirSync(cleanState);
  let result = prepare(cleanState);
  assert.equal(result.status, 0, result.stderr);
  for (const relative of [
    'data',
    'config',
    'next-cache',
    'next-cache/release-fixture',
    'phone-tools',
  ]) {
    assert.equal(fs.lstatSync(path.join(cleanState, relative)).isDirectory(), true);
  }

  for (const component of ['data', 'config', 'next-cache', 'phone-tools']) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-state-link-'));
    const state = path.join(fixture, 'state');
    const attacker = path.join(fixture, 'attacker');
    fs.mkdirSync(state);
    fs.mkdirSync(attacker);
    fs.symlinkSync(attacker, path.join(state, component));
    result = prepare(state);
    assert.notEqual(result.status, 0, `${component} symlink was accepted`);
    assert.deepEqual(fs.readdirSync(attacker), []);
  }
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
${shellFunction(source, 'move_proven_build_lock')}
${shellFunction(source, 'discard_build_lock_candidate')}
${shellFunction(source, 'build_process_start')}
BUILD_LOCK="$1"
BUILD_LOCK_WAIT_SECONDS=10
BUILD_LOCK_HELD=0
BUILD_LOCK_CANDIDATE=""
BUILD_LOCK_SELF_START="$(build_process_start "$$")"
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

test('build lock publishes fully owned and reaps malformed or PID-reused stale holders', async () => {
  const source = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-build-lock-publication-'),
  );
  const lock = path.join(fixture, 'checkout.lock');
  const trace = path.join(fixture, 'trace');
  const helpers = [
    'acquire_build_lock',
    'release_build_lock',
    'move_proven_build_lock',
    'discard_build_lock_candidate',
    'build_process_start',
  ].map((name) => shellFunction(source, name)).join('\n');
  const setup = `
${helpers}
BUILD_LOCK="$1"
BUILD_LOCK_WAIT_SECONDS=10
BUILD_LOCK_HELD=0
BUILD_LOCK_CANDIDATE=""
BUILD_LOCK_SELF_START="$(build_process_start "$$")"
trap release_build_lock EXIT
`;
  const pausedPublisher = `
set -euo pipefail
${setup}
BUILD_LOCK_CANDIDATE="$(mktemp -d "$BUILD_LOCK.pending.XXXXXXXX")"
chmod 700 "$BUILD_LOCK_CANDIDATE"
printf 'pid=%s\\nstart=%s\\n' "$$" "$BUILD_LOCK_SELF_START" \
  > "$BUILD_LOCK_CANDIDATE/owner"
chmod 600 "$BUILD_LOCK_CANDIDATE/owner"
printf 'prepared-first\\n' >> "$2"
sleep 2.2
status=0
move_proven_build_lock publish "$BUILD_LOCK_CANDIDATE" "$BUILD_LOCK" \
  "$$" "$BUILD_LOCK_SELF_START" || status=$?
if [ "$status" = 0 ]; then
  BUILD_LOCK_CANDIDATE=""
  BUILD_LOCK_HELD=1
else
  test "$status" = 75
  discard_build_lock_candidate
  acquire_build_lock
fi
printf 'acquired-first\\n' >> "$2"
printf 'released-first\\n' >> "$2"
release_build_lock
`;
  const normalPublisher = `
set -euo pipefail
${setup}
acquire_build_lock
printf 'acquired-%s\\n' "$2" >> "$3"
sleep "$4"
printf 'released-%s\\n' "$2" >> "$3"
release_build_lock
`;
  const first = spawn(
    'bash',
    ['-c', pausedPublisher, 'paused', lock, trace],
  );
  const firstExitPromise = waitForExit(first);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      fs.existsSync(trace)
      && fs.readFileSync(trace, 'utf8').includes('prepared-first')
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const second = spawn(
    'bash',
    ['-c', normalPublisher, 'normal', lock, 'second', trace, '3'],
  );
  const [firstExit, secondExit] = await Promise.all([
    firstExitPromise,
    waitForExit(second),
  ]);
  assert.equal(firstExit.status, 0, firstExit.stderr);
  assert.equal(secondExit.status, 0, secondExit.stderr);
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), [
    'prepared-first',
    'acquired-second',
    'released-second',
    'acquired-first',
    'released-first',
  ]);

  const staleTime = new Date(Date.now() - 10_000);
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(
    path.join(lock, 'owner'),
    `pid=${process.pid}\nstart=${'0'.repeat(64)}\n`,
    { mode: 0o600 },
  );
  fs.utimesSync(lock, staleTime, staleTime);
  const reusedPid = spawnSync(
    'bash',
    ['-c', normalPublisher, 'reused', lock, 'reused', trace, '0'],
    { encoding: 'utf8' },
  );
  assert.equal(reusedPid.status, 0, reusedPid.stderr);
  assert.equal(fs.existsSync(lock), false);

  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, 'owner'), 'malformed\n', { mode: 0o600 });
  fs.utimesSync(lock, staleTime, staleTime);
  const malformed = spawnSync(
    'bash',
    ['-c', normalPublisher, 'malformed', lock, 'malformed', trace, '0'],
    { encoding: 'utf8' },
  );
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(fs.existsSync(lock), false);

  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(
    path.join(lock, 'owner'),
    `pid=${process.pid}\n`,
    { mode: 0o600 },
  );
  fs.utimesSync(lock, staleTime, staleTime);
  const liveLegacy = spawnSync(
    'bash',
    [
      '-c',
      `set -uo pipefail
${helpers}
BUILD_LOCK_SELF_START="$(build_process_start "$$")"
status=0
move_proven_build_lock reap "$1" "$1.legacy-stale" \
  "$$" "$BUILD_LOCK_SELF_START" || status=$?
test "$status" = 75
test -d "$1"
`,
      'legacy',
      lock,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(liveLegacy.status, 0, liveLegacy.stderr);
  fs.rmSync(lock, { recursive: true });

  const acquire = shellFunction(source, 'acquire_build_lock');
  assert.match(acquire, /mktemp -d[\s\S]*move_proven_build_lock publish/);
  assert.doesNotMatch(acquire, /mkdir "\$BUILD_LOCK"/);
});

test('stale lock reaping serializes contenders and preserves a replacement lease', async () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-lock-reap-'));
  const lock = path.join(fixture, 'install.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, 'owner'),
    'pid=999999999\nstart=1\nlabel=stale\n',
    { mode: 0o600 },
  );
  const harness = `
set -uo pipefail
${shellFunction(installer, 'reap_dead_lock_dir')}
if reap_dead_lock_dir "$1" "$2"; then
  printf 'reaped\\n'
else
  printf 'deferred:%s\\n' "$?"
fi
`;
  const first = spawn(
    'bash',
    ['-c', harness, 'reap', lock, `${lock}.stale.first`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const second = spawn(
    'bash',
    ['-c', harness, 'reap', lock, `${lock}.stale.second`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const results = await Promise.all([waitForExit(first), waitForExit(second)]);
  assert.deepEqual(
    results.map((result) => result.stdout.trim()).sort(),
    ['deferred:75', 'reaped'],
  );
  assert.equal(fs.existsSync(lock), false);

  // An ownerless but recent replacement is the publication window of legacy
  // code and must not be confused with the stale inode just reaped.
  fs.mkdirSync(lock);
  const replacement = spawnSync(
    'bash',
    ['-c', harness, 'reap', lock, `${lock}.stale.replacement`],
    { encoding: 'utf8' },
  );
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.equal(replacement.stdout, 'deferred:75\n');
  assert.equal(fs.statSync(lock).isDirectory(), true);
});

test('rollback retires only exact dead background-control locks', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-background-lock-reap-'),
  );
  const home = path.join(fixture, 'home');
  const tools = path.join(home, 'phone-tools');
  const lock = path.join(tools, '.watchdog.lock');
  fs.mkdirSync(tools, { recursive: true });

  const harness = `
set -uo pipefail
${shellFunction(installer, 'pid_matches')}
${shellFunction(installer, 'meta_field')}
${shellFunction(installer, 'lock_live')}
${shellFunction(installer, 'reap_dead_lock_dir')}
${shellFunction(installer, 'reap_dead_background_control_lock')}
proc_start() {
  [ "$1" = "$$" ] || return 1
  printf '1\\n'
}
fsync_directory() { :; }
HOME="$1"
LOCK="$HOME/phone-tools/.watchdog.lock"
if [ "$2" = live ]; then
  printf 'pid=%s\\nstart=%s\\nlabel=watchdog\\n' \
    "$$" "$(proc_start "$$")" > "$LOCK/owner"
fi
status=0
reap_dead_background_control_lock "$LOCK" || status=$?
if [ -e "$LOCK" ] || [ -L "$LOCK" ]; then present=yes; else present=no; fi
printf 'status=%s present=%s\\n' "$status" "$present"
`;

  function makeLock(payload) {
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner'), payload, { mode: 0o600 });
  }
  function run(mode) {
    return spawnSync(
      'bash',
      ['-c', harness, 'background-lock-reap', home, mode],
      { encoding: 'utf8' },
    );
  }

  makeLock('pid=999999999\nstart=1\nlabel=watchdog\n');
  let result = run('dead');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'status=0 present=no\n');
  assert.equal(
    fs.readdirSync(tools).some((name) => name.includes('rollback-stale')),
    false,
  );

  makeLock('pid=1\nstart=1\nlabel=watchdog\n');
  result = run('live');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'status=1 present=yes\n');
  assert.equal(fs.statSync(lock).isDirectory(), true);

  fs.rmSync(lock, { recursive: true });
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, lock);
  result = run('symlink');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'status=1 present=yes\n');
  assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);

  const rejectHarness = `
set -uo pipefail
${shellFunction(installer, 'reap_dead_background_control_lock')}
HOME="$1"
status=0
reap_dead_background_control_lock "$HOME/phone-tools/.cycle.lock" || status=$?
printf 'status=%s\\n' "$status"
`;
  result = spawnSync(
    'bash',
    ['-c', rejectHarness, 'background-lock-scope', home],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'status=2\n');

  const rollback = shellFunction(installer, 'rollback_release');
  assert.match(
    rollback,
    /rollback_apk_native[\s\S]*reap_dead_background_control_locks[\s\S]*restored_background_control_stopped[\s\S]*commit_rolled_back_decision/,
  );
  assert.match(
    rollback,
    /rollback_apk_native[\s\S]*restore_android_roles[\s\S]*quiesce_control_plane[\s\S]*restore_database/,
  );
  const recovery = shellFunction(
    installer,
    'recover_interrupted_transaction',
  );
  assert.match(
    recovery,
    /release_dispatch_matches_target[\s\S]*reap_dead_background_control_locks[\s\S]*restored_background_control_stopped/,
  );
});

test('owned lock retirement removes the live path before recursive cleanup', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-lock-retire-'));
  const lock = path.join(fixture, '.cycle.lock');
  const quarantine = path.join(fixture, '.cycle.lock.released.fixture');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'pid=123\nstart=456\n', {
    mode: 0o600,
  });
  const harness = `
set -euo pipefail
${shellFunction(installer, 'retire_owned_lock_dir')}
retire_owned_lock_dir "$1" "$2" 123 456
`;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'retire', lock, quarantine],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.statSync(quarantine).isDirectory(), true);
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
  assert.match(
    installer,
    /rish_command\(\)[\s\S]*setsid -f -w timeout -k 5 "\$budget" env RISH_APPLICATION_ID=com\.termux[\s\S]*<\/dev\/null/,
  );
  assert.match(installer, /backup_installed_apk/);
  assert.match(
    installer,
    /backup_installed_apk\(\)[\s\S]*for attempt in 1 2 3[\s\S]*allocate_shell_staging_file installed-apk[\s\S]*installed_path=\\\$\(pm path[\s\S]*cp \\"\\\$installed_path\\" '\$shell_path' && chmod 0644[\s\S]*unzip -tqq "\$partial"[\s\S]*mv -f -- "\$partial" "\$output"/,
  );
  assert.doesNotMatch(installer, /installed_path="\$\(rish_command/);
  assert.match(
    installer,
    /installed_apk_version_code\(\)[\s\S]*allocate_shell_staging_file package-version[\s\S]*dumpsys package[\s\S]*chmod 0644[\s\S]*\^\[0-9\]\{1,18\}\$/,
  );
  assert.match(
    installer,
    /select_shell_package_operation\(\)[\s\S]*secrets\.token_hex\(16\)[\s\S]*prepare_shell_package_operation\(\)[\s\S]*write_transaction_journal "\$phase"[\s\S]*allocate_shell_package_operation "\$operation"/,
  );
  assert.match(
    installer,
    /allocate_shell_package_operation\(\)[\s\S]*mkdir -m 0700[\s\S]*candidate\.apk[\s\S]*chmod 0666[\s\S]*chmod 0711/,
  );
  assert.doesNotMatch(
    shellFunction(installer, 'allocate_shell_package_operation'),
    /path="\$\(rish_command/,
  );
  assert.doesNotMatch(
    shellFunction(installer, 'allocate_shell_staging_file'),
    /path="\$\(rish_command/,
  );
  assert.doesNotMatch(installer, /rish_command "cat > '\$shell_path'/);
  assert.match(installer, /rollback_release/);
  assert.match(installer, /cmd package install -r --enable-rollback/);
  assert.match(installer, /cmd package rollback-app/);
  assert.match(installer, /package_manager_supports_apk_rollback/);
  assert.match(installer, /cmd package help \| grep -q/);
  assert.match(installer, /Argument expected after \\"rollback-app\\"/);
  assert.match(installer, /EXPECTED_APK_SIGNER/);
  assert.match(installer, /EXPECTED_APK_SHA256/);
  assert.match(installer, /APK_INSTALL_ATTEMPTED/);
  assert.match(installer, /"packageOperation": package_operation/);
  assert.match(installer, /"packageOperationState": package_operation_state/);
  assert.match(installer, /"apkRollbackRetryGeneration": int/);
  assert.match(installer, /"apkInstallScanRequired": int/);
  assert.match(installer, /"controlTokenBridge": control_token_bridge/);
  assert.match(
    installer,
    /if \[ "\$TRANSACTION_PHASE" = committed \] \\\n      \|\| \[ "\$APK_INSTALL_ATTEMPTED" = 1 \] \\\n      \|\| \[ -n "\$CONTROL_TOKEN_BRIDGE" \]; then/,
  );
  assert.match(installer, /changed APK requires a strictly higher Android version code/);
  assert.match(installer, /wait_for_apk_rollback_availability/);
  assert.match(
    installer,
    /wait_for_apk_rollback_availability\(\)[\s\S]*allocate_shell_staging_file rollback-dump[\s\S]*dumpsys rollback > '\$shell_path'[\s\S]*ROLLBACK_STATE_HELPER/,
  );
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
  assert.match(
    installer,
    /sync_control_token_from_apk\(\)[\s\S]*allocate_shell_staging_file control-token[\s\S]*cp '\$APP_CONTROL_TOKEN_PATH' '\$shell_path' && chmod 0644[\s\S]*python3 "\$writer" "\$CONTROL_TOKEN" < "\$staged_token"/,
  );
  assert.match(
    installer,
    /sync_control_token_from_apk\(\)[\s\S]*CONTROL_TOKEN_BRIDGE="\$shell_path"[\s\S]*write_transaction_journal "\$TRANSACTION_PHASE"[\s\S]*copy_published_shell_file "\$shell_path" "\$staged_token"[\s\S]*if ! remove_shell_staging_file "\$shell_path"[\s\S]*CONTROL_TOKEN_BRIDGE=""/,
  );
  assert.match(
    installer,
    /install_apk\(\)[\s\S]*prepare_shell_package_operation[\s\S]*PACKAGE_OPERATION_STATE=launched[\s\S]*write_transaction_journal[\s\S]*sha256sum '\$candidate'[\s\S]*cmd package wait-for-handler --timeout 120000[\s\S]*EVOGENT_PACKAGE_RESULT_V1[\s\S]*mv '\$operation\/details\.tmp' '\$operation\/details'[\s\S]*mv '\$operation\/status\.tmp' '\$operation\/status'[\s\S]*chmod 0755/,
  );
  assert.match(
    installer,
    /read_package_result_status\(\)[\s\S]*O_NOFOLLOW[\s\S]*status > 255/,
  );
  assert.match(
    installer,
    /private package-manager output[\s\S]*fsync_regular_file_and_parent "\$retained_result"/,
  );
  assert.doesNotMatch(installer, /cmd package install[^;\n]*\|\s*tee/);
  assert.doesNotMatch(installer, /rish_command "cat '\$APP_CONTROL_TOKEN_PATH'"/);
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

test('APK rollback skips the slow preflight identity window on a proven version mismatch', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const rollback = shellFunction(installer, 'rollback_apk_native');
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-apk-rollback-fast-gate-'),
  );
  const trace = path.join(fixture, 'trace');
  const harness = `
set -euo pipefail
${rollback}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
reap_recorded_package_operation() { record reap; }
wait_for_package_manager_idle() { record idle; }
installed_apk_version_code() {
  record version
  [ "$VERSION_RESULT" = available ] || return 1
  printf '%s\\n' "$CURRENT_CODE"
}
wait_for_apk_backup_identity() {
  record exact
  [ "$(grep -c '^exact$' "$TRACE")" -ge "$EXACT_SUCCESS_AT" ]
}
wait_for_apk_rollback_availability() { return 0; }
launch_native_apk_rollback() { record rollback; }
complete_native_apk_rollback_operation() { record complete; }
persist_restored_apk_review() { record review; }
TRACE="$1"
STAGING_ROOT="$2"
APK_INSTALL_ATTEMPTED=1
APK_BACKUP_READY=1
APK_ROLLBACK_RETRY_GENERATION=0
EXPECTED_APK_CODE=200
PACKAGE_OPERATION=
PACKAGE_OPERATION_STATE=
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=0
PREVIOUS_APK_CODE="$3"
PACKAGE_NAME=net.dangish.evogent
APK_BACKUP="$2/backup.apk"
rollback_apk_native
`;
  function run({
    currentCode,
    previousCode = 100,
    versionResult = 'available',
    exactSuccessAt,
  }) {
    fs.rmSync(trace, { force: true });
    return spawnSync(
      'bash',
      ['-c', harness, 'rollback', trace, fixture, String(previousCode)],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CURRENT_CODE: String(currentCode),
          EXACT_SUCCESS_AT: String(exactSuccessAt),
          VERSION_RESULT: versionResult,
        },
      },
    );
  }

  let result = run({ currentCode: 200, exactSuccessAt: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'idle\nversion\nrollback\nidle\nexact\ncomplete\n',
  );

  result = run({ currentCode: 100, exactSuccessAt: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'idle\nversion\nexact\nreview\n',
  );

  result = run({
    currentCode: 200,
    versionResult: 'unavailable',
    exactSuccessAt: 1,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'idle\nversion\nexact\nreview\n',
  );

  result = run({
    currentCode: 200,
    previousCode: 'unproven',
    exactSuccessAt: 1,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'idle\nversion\nexact\nreview\n',
  );
});

test('phone release production config stays SWC-independent on the sealed Android tree', () => {
  const builder = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );

  assert.match(
    builder,
    /package\.json package-lock\.json next\.config\.js tsconfig\.json/,
  );
  assert.doesNotMatch(builder, /next\.config\.ts/);
  assert.equal(fs.existsSync(path.join(root, 'next.config.ts')), false);

  const omitOptionalAt = installer.indexOf(
    'npm ci --ignore-scripts --omit=dev --omit=optional',
  );
  const sealTreeAt = installer.indexOf(
    'python3 "$DEPENDENCY_STATE_HELPER" seal',
  );
  const boundedPrepareAt = installer.indexOf(
    'timeout -k 5 120 env NODE_ENV=production node',
  );
  const productionPrepareAt = installer.indexOf('app.prepare()');
  const deterministicCloseAt = installer.indexOf('await app.close()');
  const prepareCatchAt = installer.indexOf('prepareAndClose().catch');
  assert.ok(
    omitOptionalAt !== -1
      && omitOptionalAt < sealTreeAt
      && sealTreeAt < boundedPrepareAt
      && boundedPrepareAt < productionPrepareAt
      && productionPrepareAt < deterministicCloseAt
      && deterministicCloseAt < prepareCatchAt,
    'bounded production preparation must exercise and close the optional-free sealed dependency tree',
  );
  assert.match(
    installer.slice(boundedPrepareAt, prepareCatchAt),
    /try \{\s+await app\.prepare\(\);\s+\} finally \{\s+await app\.close\(\);\s+\}/,
  );

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-next-config-'));
  const runtime = path.join(fixture, 'runtime');
  fs.mkdirSync(runtime);
  fs.copyFileSync(
    path.join(root, 'next.config.js'),
    path.join(runtime, 'next.config.js'),
  );
  fs.chmodSync(path.join(runtime, 'next.config.js'), 0o444);
  fs.chmodSync(runtime, 0o555);

  const probe = String.raw`
const assert = require('node:assert/strict');
const Module = require('node:module');
const runtime = process.argv[1];
const swcEntry = require.resolve('next/dist/build/swc');
const originalLoad = Module._load;

Module._load = function guardedLoad(request, parent, isMain) {
  let resolved = '';
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    // Preserve the original resolver's error and stack for non-SWC modules.
  }
  if (resolved === swcEntry) {
    throw new Error('production config attempted to load the omitted SWC compiler');
  }
  return Reflect.apply(originalLoad, this, arguments);
};

const loadConfig = require('next/dist/server/config').default;
const { PHASE_PRODUCTION_SERVER } = require('next/constants');

loadConfig(PHASE_PRODUCTION_SERVER, runtime, { silent: true })
  .then((config) => {
    assert.equal(config.reactStrictMode, false);
    assert.deepEqual(
      config.serverExternalPackages,
      ['better-sqlite3', 'sqlite-vec', 'sqlite-vec-linux-x64'],
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
`;
  const env = {
    ...process.env,
    NODE_PATH: path.join(root, 'node_modules'),
  };
  delete env.__NEXT_NODE_NATIVE_TS_LOADER_ENABLED;
  const result = spawnSync(
    process.execPath,
    ['-e', probe, runtime],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, result.stderr);
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
DB_EXISTED=0
APK_BACKUP="$2/backups/backup-1/app.apk"
APK_BACKUP_READY=1
APK_CHANGED=1
APK_INSTALL_ATTEMPTED=0
PACKAGE_OPERATION=""
PACKAGE_OPERATION_STATE=""
APK_ROLLBACK_RETRY_GENERATION=0
APK_INSTALL_SCAN_REQUIRED=0
APK_USER_ACTION_KIND=""
APK_USER_ACTION_PURPOSE=""
APK_USER_ACTION_EVIDENCE=""
APK_USER_ACTION_TARGET_SHA256=""
APK_USER_ACTION_TARGET_VERSION_CODE=""
APK_USER_ACTION_TARGET_SIGNER_SHA256=""
APK_USER_ACTION_CHALLENGE=""
APK_USER_ACTION_CHALLENGE_CREATED_AT=""
APK_USER_ACTION_CHALLENGE_EXPIRES_AT=""
APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED=0
PREVIOUS_APK_CODE=7
PREVIOUS_APK_SIGNER=signer
INITIAL_MIGRATION=0
LEGACY_RUNTIME_EXPECTED=0
LEGACY_CONTROL_PLANE_EXPECTED=0
LEGACY_SNAPSHOT_READY=0
LEGACY_PLAN_SHA256=""
MIGRATION_STARTED=0
SWITCH_STARTED=0
MIGRATION_DIR="$2/migrations/migration-1"
CYCLE_GATE="$2/state/phone-tools/.cycle.lock"
CONTROL_TOKEN="$2/state/data/control-token.txt"
CONTROL_TOKEN_BACKUP="$2/backups/backup-1/control-token.txt"
CONTROL_TOKEN_EXISTED=1
CONTROL_TOKEN_BACKUP_READY=1
CONTROL_TOKEN_BRIDGE=""
ANDROID_ROLE_BACKUP="$2/backups/backup-1/android-role-holders.json"
ANDROID_ROLE_BACKUP_READY=0
ANDROID_ROLE_BACKUP_SHA256=""
ANDROID_ROLE_USER_ID=""
ANDROID_ROLE_RESTORE_REQUIRED=0
ANDROID_ROLE_MUTATION_ATTEMPTED=0
ANDROID_ROLES_APPLIED=0
TRANSACTION_JOURNAL_WRITTEN=0
write_transaction_journal quiesce_pending
`;
  const writer = spawnSync('bash', ['-c', harness, 'journal', journal, fixture], {
    encoding: 'utf8',
  });
  assert.equal(writer.status, 0, writer.stderr);
  const payload = JSON.parse(fs.readFileSync(journal, 'utf8'));
  assert.equal(payload.dbBackupReady, 0);
  assert.equal(payload.dbExisted, 0);
  assert.equal(payload.apkBackupReady, 1);
  assert.equal(payload.controlTokenBackupReady, 1);
  assert.equal(payload.controlTokenBridge, '');
  assert.equal(payload.packageOperation, '');
  assert.equal(payload.switchStarted, 0);
  assert.equal(payload.legacyRuntimeExpected, 0);
  assert.equal(payload.legacyControlPlaneExpected, 0);
  assert.equal(payload.legacySnapshotReady, 0);
  assert.equal(payload.legacyPlanSha256, '');
  assert.equal(payload.androidRoleBackupReady, 0);
  assert.equal(payload.androidRoleUserId, -1);
  assert.equal(payload.apkUserActionKind, '');
  assert.equal(payload.apkUserActionTargetVersionCode, -1);
  assert.equal(payload.apkUserActionChallenge, '');
  assert.equal(payload.apkUserActionChallengeCreatedAtEpochSeconds, -1);
  assert.equal(payload.apkUserActionChallengeExpiresAtEpochSeconds, -1);
  assert.equal(payload.apkUserActionTrustedVerifierObserved, 0);
  assert.equal(payload.packageOperationState, '');
  assert.equal(payload.apkRollbackRetryGeneration, 0);
  assert.equal(payload.apkInstallScanRequired, 0);
  assert.equal(payload.schema, 'evogent.phone.install-transaction.v6');
});

test('durable committed decisions can never fall back into rollback', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const commit = shellFunction(installer, 'commit_new_release_decision');
  const harness = `
set -u
${commit}
canonicalize_cycle_gate_for_commit() { CYCLE_GATE="/state/.cycle.lock"; }
write_transaction_journal() {
  if [ "$WRITER_STATUS" = 0 ] || [ "$WRITER_STATUS" = 76 ]; then
    TRANSACTION_PHASE="$1"
  fi
  return "$WRITER_STATUS"
}
TRANSACTION_PHASE=health_pending
SWITCH_STARTED=1
MIGRATION_STARTED=0
INITIAL_MIGRATION=0
ANDROID_ROLE_BACKUP_READY=1
ANDROID_ROLES_APPLIED=1
PACKAGE_OPERATION=
PACKAGE_OPERATION_STATE=
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=0
APK_ROLLBACK_RETRY_GENERATION=0
APK_INSTALL_SCAN_REQUIRED=0
APK_USER_ACTION_KIND=
COMMITTED=0
CYCLE_GATE="/synthetic-home/.cycle.lock"
WRITER_STATUS="$1"
commit_new_release_decision
rc=$?
printf 'rc=%s committed=%s phase=%s gate=%s\\n' \
  "$rc" "$COMMITTED" "$TRANSACTION_PHASE" "$CYCLE_GATE"
`;
  const run = (status) => spawnSync(
    'bash',
    ['-c', harness, 'commit', String(status)],
    { encoding: 'utf8' },
  );
  let result = run(0);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /rc=0 committed=1 phase=committed gate=\/state\/\.cycle\.lock/,
  );
  result = run(76);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=76 committed=1 phase=committed/);
  result = run(1);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 committed=0 phase=health_pending/);

  const recovery = shellFunction(installer, 'recover_interrupted_transaction');
  const phaseLoaded = recovery.indexOf(
    'TRANSACTION_PHASE="$(journal_field "$journal" phase)"',
  );
  const committedInMemory = recovery.indexOf('COMMITTED=1', phaseLoaded);
  const releaseLoaded = recovery.indexOf(
    'RELEASE_ID="$(journal_field "$journal" releaseId)"',
  );
  const committedBranch = recovery.indexOf(
    'if [ "$TRANSACTION_PHASE" = committed ]; then',
    releaseLoaded,
  );
  const rollback = recovery.indexOf('rollback_release || true', committedBranch);
  assert.ok(phaseLoaded >= 0);
  assert.ok(phaseLoaded < committedInMemory);
  assert.ok(committedInMemory < releaseLoaded);
  assert.ok(releaseLoaded < committedBranch);
  assert.ok(committedBranch < rollback);
  assert.match(
    recovery.slice(committedBranch, rollback),
    /verify_committed_release_state[\s\S]*finalize_committed_transaction_state[\s\S]*clear_transaction_journal/,
  );
  assert.match(
    shellFunction(installer, 'write_transaction_journal'),
    /raise SystemExit\(76\)/,
  );
});

test('recovery normalizes absent numeric APK action fields before terminal guards', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const optional = shellFunction(installer, 'journal_optional_field');
  const actionInteger = shellFunction(
    installer,
    'journal_optional_action_integer',
  );
  const recovery = shellFunction(installer, 'recover_interrupted_transaction');
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-action-integer-recovery-'),
  );
  const journal = path.join(fixture, 'journal.json');
  fs.writeFileSync(
    journal,
    `${JSON.stringify({
      apkUserActionChallengeCreatedAtEpochSeconds: -1,
      apkUserActionChallengeExpiresAtEpochSeconds: 200,
      apkUserActionTargetVersionCode: -1,
    })}\n`,
  );
  const harness = `
set -euo pipefail
${optional}
${actionInteger}
printf 'version=[%s] created=[%s] expires=[%s]\\n' \
  "$(journal_optional_action_integer "$1" apkUserActionTargetVersionCode)" \
  "$(journal_optional_action_integer "$1" apkUserActionChallengeCreatedAtEpochSeconds)" \
  "$(journal_optional_action_integer "$1" apkUserActionChallengeExpiresAtEpochSeconds)"
`;
  const result = spawnSync('bash', ['-c', harness, 'normalize-action', journal], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'version=[] created=[] expires=[200]\n');
  assert.match(
    recovery,
    /journal_optional_action_integer[\s\S]*apkUserActionTargetVersionCode[\s\S]*journal_optional_action_integer[\s\S]*apkUserActionChallengeCreatedAtEpochSeconds[\s\S]*journal_optional_action_integer[\s\S]*apkUserActionChallengeExpiresAtEpochSeconds/,
  );
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
reconcile_android_install_user_action() { return 1; }
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

  fs.chmodSync(partial, 0o600);
  result = spawnSync(
    'bash',
    ['-c', harness, 'harness', fixture, partial, '1', target],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original database bytes');
});

test('rollback removes a candidate database when durable pre-state was absent', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-db-absent-'));
  const home = path.join(fixture, 'home');
  const state = path.join(fixture, 'state');
  const backup = path.join(fixture, 'backups/install-fixture');
  const migration = path.join(fixture, 'migrations/install-fixture');
  const target = path.join(state, 'data/media-agent.db');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(migration, { recursive: true });
  fs.writeFileSync(path.join(backup, 'media-agent.absent'), '', {
    mode: 0o600,
  });
  const helpers = [
    'transaction_rollback_temp_path',
    'remove_transaction_rollback_temp',
    'reap_transaction_rollback_temps',
    'restore_database',
  ].map((name) => shellFunction(installer, name)).join('\n');
  const harness = `
set -euo pipefail
${helpers}
say() { :; }
fsync_directory() { :; }
stat() {
  if [ "$1" = -c ] && [ "$2" = %a ]; then
    python3 - "$3" <<'PY'
import os
import stat
import sys
print(oct(stat.S_IMODE(os.lstat(sys.argv[1]).st_mode))[2:])
PY
  else
    command stat "$@"
  fi
}
HOME="$1"
STATE="$2"
BACKUP_DIR="$3"
MIGRATION_DIR="$4"
DB_BACKUP="$BACKUP_DIR/media-agent.db"
DB_BACKUP_READY=1
DB_EXISTED=0
target="$5"
temporary="$(transaction_rollback_temp_path "$target" database)"
printf 'orphaned secret copy\\n' > "$temporary"
chmod 600 "$temporary"
printf 'candidate database\\n' > "$target"
printf 'candidate wal\\n' > "$target-wal"
printf 'candidate shm\\n' > "$target-shm"
restore_database "$target"
restore_database "$target"
test ! -e "$temporary"
test ! -e "$target"
test ! -e "$target-wal"
test ! -e "$target-shm"
`;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'rollback', home, state, backup, migration, target],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('seeded-default rollback consumes intent before state namespace moves', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-defaults-'));
  const state = path.join(fixture, 'state');
  const backup = path.join(fixture, 'backups/install-fixture');
  const source = path.join(fixture, 'default.txt');
  fs.mkdirSync(path.join(state, 'data'), { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(source, 'public default\n', { mode: 0o644 });
  const helpers = [
    'record_default_seed_intent',
    'publish_recorded_default_seed',
    'rollback_seeded_defaults',
  ].map((name) => shellFunction(installer, name)).join('\n');
  const harness = `
set -euo pipefail
${helpers}
STATE="$1"
BACKUP_DIR="$2"
source="$3"
fixture="$4"
record_default_seed_intent "$source" nested/default.txt >/dev/null
publish_recorded_default_seed "$source" nested/default.txt
# Model a crash after the durable no-clobber rename but before the final phase
# update: prepared generation proof must authenticate the new target.
python3 - "$BACKUP_DIR/seeded-defaults" <<'PY'
import json
import pathlib
import sys
marker = next(pathlib.Path(sys.argv[1]).glob("*.json"))
payload = json.loads(marker.read_text())
payload["phase"] = "prepared"
marker.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\\n")
marker.chmod(0o600)
PY
rollback_seeded_defaults
test ! -e "$STATE/data/nested/default.txt"
test -d "$STATE/data/nested"
test -d "$BACKUP_DIR/seeded-defaults/rollback-quarantine"
record_default_seed_intent "$source" nested/promoted-update.txt >/dev/null
python3 - "$BACKUP_DIR/seeded-defaults" <<'PY'
import pathlib
import sys
intents = pathlib.Path(sys.argv[1])
marker = next(intents.glob("*.json"))
update = marker.with_suffix(".json.new")
update.write_bytes(marker.read_bytes())
update.chmod(0o600)
PY
rollback_seeded_defaults
test ! -e "$BACKUP_DIR/seeded-defaults/"*.json.new
temporary="$(record_default_seed_intent "$source" nested/partial.txt)"
mkdir -p "$STATE/data/nested"
printf 'partial' > "$STATE/data/$temporary"
python3 - "$BACKUP_DIR/seeded-defaults" "$STATE/data/$temporary" \
    "$STATE/data/nested" <<'PY'
import json
import os
import pathlib
import sys
intents, temporary, parent = map(pathlib.Path, sys.argv[1:])
marker = next(intents.glob("*.json"))
payload = json.loads(marker.read_text())
temporary_stat = os.lstat(temporary)
parent_stat = os.lstat(parent)
payload["phase"] = "copying"
payload["temporaryIdentity"] = {
    "device": temporary_stat.st_dev,
    "inode": temporary_stat.st_ino,
}
payload["createdParents"] = [{
    "relative": "nested",
    "device": parent_stat.st_dev,
    "inode": parent_stat.st_ino,
}]
marker.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\\n")
PY
rollback_seeded_defaults
test ! -e "$STATE/data/$temporary"
test -d "$STATE/data/nested"
test -d "$BACKUP_DIR/seeded-defaults/rollback-quarantine"
record_default_seed_intent "$source" nested/unrelated.txt >/dev/null
mkdir -p "$STATE/data/nested"
cp "$source" "$STATE/data/nested/unrelated.txt"
rollback_seeded_defaults
cmp -s "$source" "$STATE/data/nested/unrelated.txt"
test -d "$STATE/data/nested"
test -d "$BACKUP_DIR/seeded-defaults/rollback-quarantine"
rm "$STATE/data/nested/unrelated.txt"
rmdir "$STATE/data/nested"
record_default_seed_intent "$source" unrelated-parent/default.txt >/dev/null
mkdir "$STATE/data/unrelated-parent"
rollback_seeded_defaults
test -d "$STATE/data/unrelated-parent"
test -d "$BACKUP_DIR/seeded-defaults/rollback-quarantine"
rmdir "$STATE/data/unrelated-parent"
record_default_seed_intent "$source" nested/replaced.txt >/dev/null
publish_recorded_default_seed "$source" nested/replaced.txt
cp "$source" "$fixture/replacement.txt"
mv -f "$fixture/replacement.txt" "$STATE/data/nested/replaced.txt"
rollback_seeded_defaults
cmp -s "$source" "$STATE/data/nested/replaced.txt"
test -d "$STATE/data/nested"
test -d "$BACKUP_DIR/seeded-defaults/rollback-quarantine"
rm "$STATE/data/nested/replaced.txt"
rmdir "$STATE/data/nested"
record_default_seed_intent "$source" nested/preserved.txt >/dev/null
publish_recorded_default_seed "$source" nested/preserved.txt
printf 'private change\\n' > "$STATE/data/nested/preserved.txt"
rollback_seeded_defaults
test "$(cat "$STATE/data/nested/preserved.txt")" = "private change"
test -d "$STATE/data/nested"
test -d "$BACKUP_DIR/seeded-defaults/rollback-quarantine"
mv "$STATE/data" "$fixture/moved-data"
rollback_seeded_defaults
`;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'rollback', state, backup, source, fixture],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const rollback = shellFunction(installer, 'rollback_seeded_defaults');
  assert.match(
    rollback,
    /os\.rename\([\s\S]*?src_dir_fd=intents_descriptor[\s\S]*?dst_dir_fd=intents_descriptor/,
  );
  assert.doesNotMatch(
    rollback,
    /os\.replace\([\s\S]*?src_dir_fd=intents_descriptor/,
  );
});

test('installer transaction seeds missing live learning defaults without replacing private state', (t) => {
  const builder = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-live-seed-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const defaults = path.join(fixture, 'defaults');
  const state = path.join(fixture, 'state');
  const backup = path.join(fixture, 'backup');
  fs.mkdirSync(defaults);
  fs.mkdirSync(path.join(state, 'data'), { recursive: true });
  fs.mkdirSync(backup);
  for (const template of [
    'preference-insights.default.md',
    'source-cadence.default.json',
  ]) {
    fs.copyFileSync(
      path.join(root, 'data', template),
      path.join(defaults, template),
    );
  }

  const helpers = [
    shellFunction(builder, 'prepare_phone_live_defaults'),
    shellFunction(installer, 'record_default_seed_intent'),
    shellFunction(installer, 'publish_recorded_default_seed'),
    shellFunction(installer, 'seed_missing_public_defaults'),
    shellFunction(installer, 'rollback_seeded_defaults'),
  ].join('\n');
  const run = (command, runState = state, runBackup = backup) => spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${helpers}
say() { :; }
STATE="$1"
BACKUP_DIR="$2"
defaults="$3"
${command}
`,
      'live-seed',
      runState,
      runBackup,
      defaults,
    ],
    { encoding: 'utf8' },
  );

  let result = run(
    'prepare_phone_live_defaults "$defaults"\nseed_missing_public_defaults "$defaults"',
  );
  assert.equal(result.status, 0, result.stderr);
  const livePreference = path.join(state, 'data/preference-insights.md');
  const liveCadence = path.join(state, 'data/source-cadence.json');
  assert.equal(fs.statSync(livePreference).mode & 0o777, 0o600);
  assert.equal(fs.statSync(liveCadence).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readFileSync(livePreference),
    fs.readFileSync(path.join(defaults, 'preference-insights.md')),
  );
  assert.deepEqual(
    fs.readFileSync(liveCadence),
    fs.readFileSync(path.join(defaults, 'source-cadence.json')),
  );

  const liveIntents = fs.readdirSync(path.join(backup, 'seeded-defaults'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(
      fs.readFileSync(path.join(backup, 'seeded-defaults', name), 'utf8'),
    ))
    .filter((intent) => [
      'preference-insights.md',
      'source-cadence.json',
    ].includes(intent.relative));
  assert.deepEqual(
    liveIntents.map((intent) => intent.relative).sort(),
    ['preference-insights.md', 'source-cadence.json'],
  );
  assert.ok(liveIntents.every((intent) => (
    intent.schema === 'evogent.phone.seeded-default.v3'
    && intent.phase === 'published'
  )));

  const privatePreference = 'owner-specific preference evidence\n';
  const privateCadence = '{"private":{"cadenceHours":24,"why":"owner-specific evidence"}}\n';
  fs.writeFileSync(livePreference, privatePreference, { mode: 0o600 });
  fs.writeFileSync(liveCadence, privateCadence, { mode: 0o600 });
  result = run('seed_missing_public_defaults "$defaults"\nrollback_seeded_defaults');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(livePreference, 'utf8'), privatePreference);
  assert.equal(fs.readFileSync(liveCadence, 'utf8'), privateCadence);

  const protectedState = path.join(fixture, 'protected-state');
  const protectedBackup = path.join(fixture, 'protected-backup');
  const outsideCadence = path.join(fixture, 'outside-cadence.json');
  fs.mkdirSync(path.join(protectedState, 'data'), { recursive: true });
  fs.mkdirSync(protectedBackup);
  fs.writeFileSync(outsideCadence, 'outside sentinel\n', { mode: 0o600 });
  fs.symlinkSync(
    outsideCadence,
    path.join(protectedState, 'data/source-cadence.json'),
  );
  fs.writeFileSync(
    path.join(protectedState, 'data/preference-insights.md'),
    privatePreference,
    { mode: 0o600 },
  );
  result = run(
    'seed_missing_public_defaults "$defaults"',
    protectedState,
    protectedBackup,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.lstatSync(path.join(protectedState, 'data/source-cadence.json')).isSymbolicLink(),
    true,
  );
  assert.equal(fs.readFileSync(outsideCadence, 'utf8'), 'outside sentinel\n');
  assert.equal(
    fs.readFileSync(
      path.join(protectedState, 'data/preference-insights.md'),
      'utf8',
    ),
    privatePreference,
  );
});

test('seeded-default rollback refuses a swapped parent without crossing it', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-seed-swap-'));
  const state = path.join(fixture, 'state');
  const backup = path.join(fixture, 'backups/install-fixture');
  const source = path.join(fixture, 'default.txt');
  const attacker = path.join(fixture, 'attacker');
  const original = path.join(fixture, 'original-parent');
  fs.mkdirSync(path.join(state, 'data'), { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(attacker);
  fs.writeFileSync(source, 'public default\n', { mode: 0o644 });
  fs.writeFileSync(path.join(attacker, 'default.txt'), 'outside sentinel\n');
  const helpers = [
    'record_default_seed_intent',
    'publish_recorded_default_seed',
    'rollback_seeded_defaults',
  ].map((name) => shellFunction(installer, name)).join('\n');
  const harness = `
set -euo pipefail
${helpers}
STATE="$1"
BACKUP_DIR="$2"
source="$3"
attacker="$4"
original="$5"
record_default_seed_intent "$source" nested/default.txt >/dev/null
publish_recorded_default_seed "$source" nested/default.txt
mv "$STATE/data/nested" "$original"
ln -s "$attacker" "$STATE/data/nested"
rollback_seeded_defaults
`;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'rollback-swap', state, backup, source, attacker, original],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(attacker, 'default.txt'), 'utf8'), 'outside sentinel\n');
  assert.equal(fs.readFileSync(path.join(original, 'default.txt'), 'utf8'), 'public default\n');
  assert.equal(fs.lstatSync(path.join(state, 'data/nested')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(backup, 'seeded-defaults')), true);
});

test('recovery normalizes only the exact pre-switch dangling legacy predecessor', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'normalize_dangling_legacy_predecessor');
  function runScenario({
    currentPresent = true,
    currentTarget = null,
    initialMigration = '0',
    legacyTools = true,
    migrationStarted = '0',
    previousExists = false,
    regularCurrent = false,
    selfPredecessor = false,
    switchStarted = '0',
  } = {}) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-legacy-pointer-'));
    const home = path.join(fixture, 'home');
    const rootDirectory = path.join(home, '.local/share/evogent');
    const releases = path.join(rootDirectory, 'releases');
    const releasePrevious = path.join(releases, 'release-old');
    const current = path.join(rootDirectory, 'current');
    const previous = selfPredecessor ? current : releasePrevious;
    fs.mkdirSync(path.join(home, 'evogent'), { recursive: true });
    if (legacyTools) fs.mkdirSync(path.join(home, 'phone-tools'), { recursive: true });
    fs.mkdirSync(releases, { recursive: true });
    if (previousExists) fs.mkdirSync(previous);
    if (currentPresent) {
      if (regularCurrent) {
        fs.writeFileSync(current, 'unsafe current entry\n');
      } else {
        fs.symlinkSync(currentTarget ?? previous, current);
      }
    }
    const harness = `
set -euo pipefail
${helper}
say() { :; }
HOME="$1"
CURRENT="$2"
PREVIOUS_TARGET="$3"
RELEASES="$7"
INITIAL_MIGRATION="$4"
MIGRATION_STARTED="$5"
SWITCH_STARTED="$6"
normalize_dangling_legacy_predecessor
printf 'previous=%s\\ninitial=%s\\n' "$PREVIOUS_TARGET" "$INITIAL_MIGRATION"
`;
    const result = spawnSync(
      'bash',
      [
        '-c',
        harness,
        'harness',
        home,
        current,
        previous,
        initialMigration,
        migrationStarted,
        switchStarted,
        releases,
      ],
      { encoding: 'utf8' },
    );
    return { current, previous, result };
  }

  const normalized = runScenario();
  assert.equal(normalized.result.status, 0, normalized.result.stderr);
  assert.throws(
    () => fs.lstatSync(normalized.current),
    (error) => error?.code === 'ENOENT',
  );
  assert.equal(fs.lstatSync(path.dirname(normalized.current)).isDirectory(), true);
  assert.match(normalized.result.stdout, /previous=\ninitial=1/);

  const resumed = runScenario({ currentPresent: false });
  assert.equal(resumed.result.status, 0, resumed.result.stderr);
  assert.match(resumed.result.stdout, /previous=\ninitial=1/);

  const selfPredecessor = runScenario({ selfPredecessor: true });
  assert.equal(
    selfPredecessor.result.status,
    0,
    selfPredecessor.result.stderr,
  );
  assert.throws(
    () => fs.lstatSync(selfPredecessor.current),
    (error) => error?.code === 'ENOENT',
  );
  assert.match(selfPredecessor.result.stdout, /previous=\ninitial=1/);

  const disguisedSelfPredecessor = runScenario({
    currentTarget: 'pivot/../current',
    selfPredecessor: true,
  });
  assert.notEqual(disguisedSelfPredecessor.result.status, 0);
  assert.equal(
    fs.lstatSync(disguisedSelfPredecessor.current).isSymbolicLink(),
    true,
  );

  const switched = runScenario({ switchStarted: '1' });
  assert.equal(switched.result.status, 0, switched.result.stderr);
  assert.equal(fs.lstatSync(switched.current).isSymbolicLink(), true);
  assert.match(switched.result.stdout, /initial=0/);

  const wrongTarget = runScenario({ currentTarget: '/missing/unrelated-release' });
  assert.notEqual(wrongTarget.result.status, 0);
  assert.equal(fs.lstatSync(wrongTarget.current).isSymbolicLink(), true);

  const regularCurrent = runScenario({ regularCurrent: true });
  assert.notEqual(regularCurrent.result.status, 0);
  assert.equal(fs.lstatSync(regularCurrent.current).isFile(), true);

  const missingLegacy = runScenario({ legacyTools: false });
  assert.notEqual(missingLegacy.result.status, 0);
  assert.equal(fs.lstatSync(missingLegacy.current).isSymbolicLink(), true);

  const existing = runScenario({ previousExists: true });
  assert.equal(existing.result.status, 0, existing.result.stderr);
  assert.equal(fs.lstatSync(existing.current).isSymbolicLink(), true);
  assert.match(existing.result.stdout, /initial=0/);
});

test('versioned rollback targets only a real direct release child', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'is_real_release_target');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-release-target-'));
  const releases = path.join(fixture, 'releases');
  const valid = path.join(releases, 'release-valid');
  const nested = path.join(valid, 'nested-release');
  const outside = path.join(fixture, 'outside-release');
  const linked = path.join(releases, 'release-linked');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, linked);
  const harness = `
set -euo pipefail
${helper}
RELEASES="$1"
is_real_release_target "$2"
`;
  function check(target) {
    return spawnSync('bash', ['-c', harness, 'target', releases, target], {
      encoding: 'utf8',
    });
  }
  assert.equal(check(valid).status, 0);
  assert.notEqual(check(nested).status, 0);
  assert.notEqual(check(outside).status, 0);
  assert.notEqual(check(linked).status, 0);
  assert.notEqual(check(path.join(releases, 'release invalid')).status, 0);
});

test('journal validation admits only the pre-switch legacy self-pointer', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'validate_transaction_journal');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-self-journal-'));
  const home = path.join(fixture, 'home');
  const releaseRoot = path.join(home, '.local/share/evogent');
  const releases = path.join(releaseRoot, 'releases');
  const backups = path.join(releaseRoot, 'backups');
  const migrations = path.join(releaseRoot, 'migrations');
  const phoneState = path.join(releaseRoot, 'state/phone-tools');
  const current = path.join(releaseRoot, 'current');
  const journal = path.join(fixture, 'journal.json');
  for (const directory of [
    releases,
    backups,
    migrations,
    phoneState,
    path.join(releaseRoot, 'state/data'),
    path.join(home, 'phone-tools'),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.symlinkSync(current, current);
  const payload = {
    apkBackup: path.join(backups, 'backup/app.apk'),
    apkBackupReady: 1,
    apkChanged: 1,
    apkInstallAttempted: 1,
    backupDir: path.join(backups, 'backup'),
    controlToken: path.join(releaseRoot, 'state/data/control-token.txt'),
    controlTokenBackup: path.join(backups, 'backup/control-token.txt'),
    controlTokenBackupReady: 1,
    controlTokenBridge: '',
    controlTokenExisted: 1,
    cycleGate: path.join(home, 'phone-tools/.cycle.lock'),
    dbBackup: path.join(backups, 'backup/database.db'),
    dbBackupReady: 1,
    initialMigration: 0,
    migrationDir: path.join(migrations, 'migration'),
    migrationStarted: 0,
    newRelease: path.join(releases, 'release-new'),
    packageOperation: '',
    phase: 'apk_install_pending',
    previousApkCode: '1',
    previousApkSigner: 'signer',
    previousTarget: current,
    releaseId: 'release-new',
    root: releaseRoot,
    schema: 'evogent.phone.install-transaction.v1',
    switchStarted: 0,
  };
  const harness = `
set -euo pipefail
${helper}
HOME="$1"
ROOT="$2"
RELEASES="$ROOT/releases"
BACKUPS="$ROOT/backups"
MIGRATIONS="$ROOT/migrations"
PHONE_STATE="$ROOT/state/phone-tools"
TRANSACTION_DIR="$ROOT/install-transaction"
CONTROL_TOKEN="$ROOT/state/data/control-token.txt"
validate_transaction_journal "$3"
`;
  function validate() {
    return spawnSync(
      'bash',
      ['-c', harness, 'journal', home, releaseRoot, journal],
      { encoding: 'utf8' },
    );
  }
  fs.writeFileSync(journal, JSON.stringify(payload));
  let result = validate();
  assert.equal(result.status, 0, result.stderr);

  payload.phase = 'committed';
  fs.writeFileSync(journal, JSON.stringify(payload));
  result = validate();
  assert.notEqual(result.status, 0);
  payload.phase = 'apk_install_pending';

  payload.switchStarted = 1;
  fs.writeFileSync(journal, JSON.stringify(payload));
  result = validate();
  assert.notEqual(result.status, 0);

  payload.switchStarted = 0;
  fs.unlinkSync(current);
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(releaseRoot, 'pivot'));
  fs.symlinkSync(`${releaseRoot}/pivot/../current`, current);
  fs.writeFileSync(journal, JSON.stringify(payload));
  result = validate();
  assert.notEqual(result.status, 0);

  fs.unlinkSync(current);
  fs.symlinkSync(path.join(releaseRoot, 'different'), current);
  fs.writeFileSync(journal, JSON.stringify(payload));
  result = validate();
  assert.notEqual(result.status, 0);
});

test('v2 journal validation binds exact legacy intent and rollback snapshots', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'validate_transaction_journal');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-v2-journal-'));
  const home = path.join(fixture, 'home');
  const releaseRoot = path.join(home, '.local/share/evogent');
  const releases = path.join(releaseRoot, 'releases');
  const backups = path.join(releaseRoot, 'backups');
  const migrations = path.join(releaseRoot, 'migrations');
  const phoneState = path.join(releaseRoot, 'state/phone-tools');
  let migration = path.join(migrations, 'install-fixture');
  const backup = path.join(backups, 'backup');
  const journal = path.join(fixture, 'journal.json');
  for (const directory of [
    releases,
    backups,
    backup,
    migration,
    path.join(releases, 'release-new'),
    path.join(releases, 'release-old'),
    phoneState,
    path.join(releaseRoot, 'state/data'),
    path.join(home, 'phone-tools'),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const payload = {
    apkBackup: path.join(backup, 'evogent.apk'),
    apkBackupReady: 1,
    apkChanged: 0,
    apkInstallAttempted: 0,
    backupDir: backup,
    controlToken: path.join(releaseRoot, 'state/data/control-token.txt'),
    controlTokenBackup: path.join(backup, 'control-token.txt'),
    controlTokenBackupReady: 1,
    controlTokenBridge: '',
    controlTokenExisted: 1,
    cycleGate: path.join(home, 'phone-tools/.cycle.lock'),
    dbBackup: path.join(backup, 'media-agent.db'),
    dbBackupReady: 1,
    dbExisted: 1,
    initialMigration: 0,
    legacyControlPlaneExpected: 0,
    legacyPlanSha256: '',
    legacyRuntimeExpected: 0,
    legacySnapshotReady: 0,
    migrationDir: migration,
    migrationStarted: 0,
    newRelease: path.join(releases, 'release-new'),
    packageOperation: '',
    phase: 'prepared',
    previousApkCode: '1',
    previousApkSigner: 'signer',
    previousTarget: path.join(releases, 'release-old'),
    releaseId: 'release-new',
    root: releaseRoot,
    schema: 'evogent.phone.install-transaction.v2',
    switchStarted: 0,
  };
  fs.writeFileSync(
    path.join(backup, 'previous-release'),
    `${payload.previousTarget}\n`,
    { mode: 0o600 },
  );
  const harness = `
set -euo pipefail
${helper}
HOME="$1"
ROOT="$2"
RELEASES="$ROOT/releases"
BACKUPS="$ROOT/backups"
MIGRATIONS="$ROOT/migrations"
PHONE_STATE="$ROOT/state/phone-tools"
TRANSACTION_DIR="$ROOT/install-transaction"
CONTROL_TOKEN="$ROOT/state/data/control-token.txt"
validate_transaction_journal "$3"
`;
  function validate() {
    fs.writeFileSync(journal, `${JSON.stringify(payload)}\n`);
    return spawnSync(
      'bash',
      ['-c', harness, 'journal', home, releaseRoot, journal],
      { encoding: 'utf8' },
    );
  }
  assert.equal(validate().status, 0);

  payload.cycleGate = path.join(
    releaseRoot,
    'install-transaction/recovery-cycle.lock',
  );
  assert.equal(validate().status, 0);
  payload.cycleGate = path.join(
    releaseRoot,
    'install-transaction/unbound-cycle.lock',
  );
  assert.notEqual(validate().status, 0);
  payload.cycleGate = path.join(home, 'phone-tools/.cycle.lock');

  payload.dbBackup = path.join(backup, 'other.db');
  assert.notEqual(validate().status, 0);
  payload.dbBackup = path.join(backup, 'media-agent.db');
  fs.writeFileSync(path.join(backup, 'previous-release'), 'wrong\n', {
    mode: 0o600,
  });
  assert.notEqual(validate().status, 0);
  fs.writeFileSync(
    path.join(backup, 'previous-release'),
    `${payload.previousTarget}\n`,
    { mode: 0o600 },
  );
  payload.newRelease = path.join(releases, 'other-release');
  assert.notEqual(validate().status, 0);
  payload.newRelease = path.join(releases, payload.releaseId);

  const current = path.join(releaseRoot, 'current');
  fs.symlinkSync(`releases/${payload.releaseId}`, current);
  payload.phase = 'committed';
  payload.switchStarted = 1;
  payload.cycleGate = path.join(phoneState, '.cycle.lock');
  assert.equal(validate().status, 0);
  payload.packageOperation = '/data/local/tmp/evogent-package-op.'
    + 'a'.repeat(32);
  payload.apkChanged = 1;
  payload.apkInstallAttempted = 1;
  assert.notEqual(validate().status, 0);
  payload.packageOperation = '';
  payload.apkChanged = 0;
  payload.apkInstallAttempted = 0;
  payload.controlTokenBackupReady = 0;
  assert.notEqual(validate().status, 0);
  payload.controlTokenBackupReady = 1;
  fs.renameSync(migration, `${migration}.held`);
  assert.equal(validate().status, 0);
  fs.renameSync(`${migration}.held`, migration);
  fs.unlinkSync(current);
  payload.phase = 'prepared';
  payload.switchStarted = 0;
  payload.cycleGate = path.join(home, 'phone-tools/.cycle.lock');

  payload.previousTarget = '';
  fs.writeFileSync(path.join(backup, 'previous-release'), '\n', {
    mode: 0o600,
  });
  assert.notEqual(validate().status, 0);
  payload.previousTarget = path.join(releases, 'release-old');
  fs.writeFileSync(
    path.join(backup, 'previous-release'),
    `${payload.previousTarget}\n`,
    { mode: 0o600 },
  );

  payload.legacyRuntimeExpected = true;
  assert.notEqual(validate().status, 0);
  payload.legacyRuntimeExpected = 1;
  assert.notEqual(validate().status, 0);

  payload.initialMigration = 1;
  payload.previousTarget = '';
  migration = path.join(migrations, 'legacy-fixture');
  fs.mkdirSync(migration);
  payload.migrationDir = migration;
  fs.writeFileSync(path.join(backup, 'previous-release'), '\n', {
    mode: 0o600,
  });
  const planPath = path.join(migration, 'rollback-plan.json');
  const plan = {
    entries: {},
    generatedMarker: 'a'.repeat(64),
    home,
    legacyControlPlaneExpected: 0,
    legacyRuntimeExpected: 1,
    migrationDir: migration,
    phoneState,
    rearmProgram: 'start-prod.sh',
    releaseId: payload.releaseId,
    root: releaseRoot,
    schema: 'evogent.phone.legacy-rollback-plan.v1',
    snapshotReady: 0,
    snapshots: {},
    state: path.join(releaseRoot, 'state'),
  };
  fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  fs.chmodSync(planPath, 0o600);
  assert.equal(validate().status, 0);

  payload.previousTarget = path.join(releases, 'release-old');
  fs.writeFileSync(
    path.join(backup, 'previous-release'),
    `${payload.previousTarget}\n`,
    { mode: 0o600 },
  );
  assert.notEqual(validate().status, 0);
  payload.previousTarget = '';
  fs.writeFileSync(path.join(backup, 'previous-release'), '\n', {
    mode: 0o600,
  });

  payload.migrationStarted = 1;
  assert.notEqual(validate().status, 0);
  payload.migrationStarted = 0;

  plan.snapshotReady = 1;
  fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  fs.chmodSync(planPath, 0o600);
  payload.legacySnapshotReady = 1;
  payload.legacyPlanSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(planPath))
    .digest('hex');
  assert.equal(validate().status, 0);

  plan.releaseId = 'different-release';
  fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  fs.chmodSync(planPath, 0o600);
  assert.notEqual(validate().status, 0);

  fs.rmSync(planPath);
  assert.notEqual(validate().status, 0);
});

test('v4-v6 attestation journals bind one exact APK target and restoration fence', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'validate_transaction_journal');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-v4-action-'));
  const home = path.join(fixture, 'home');
  const releaseRoot = path.join(home, '.local/share/evogent');
  const releases = path.join(releaseRoot, 'releases');
  const backup = path.join(releaseRoot, 'backups/backup');
  const migrations = path.join(releaseRoot, 'migrations');
  const migration = path.join(migrations, 'install-fixture');
  const phoneState = path.join(releaseRoot, 'state/phone-tools');
  const next = path.join(releases, 'release-new');
  const previous = path.join(releases, 'release-old');
  const journal = path.join(fixture, 'journal.json');
  for (const directory of [
    next,
    previous,
    backup,
    migration,
    phoneState,
    path.join(releaseRoot, 'state/data'),
    path.join(home, 'phone-tools'),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const candidateSha = 'a'.repeat(64);
  const candidateSigner = 'b'.repeat(64);
  const previousSigner = 'c'.repeat(64);
  fs.writeFileSync(
    path.join(next, 'manifest.json'),
    `${JSON.stringify({
      android: {
        sha256: candidateSha,
        signerSha256: candidateSigner,
        versionCode: 8,
      },
    })}\n`,
  );
  const apkBackup = path.join(backup, 'evogent.apk');
  fs.writeFileSync(apkBackup, 'prior apk fixture\n', { mode: 0o600 });
  fs.chmodSync(apkBackup, 0o600);
  const roleBackup = path.join(backup, 'android-role-holders.json');
  fs.writeFileSync(roleBackup, '{}\n', { mode: 0o600 });
  fs.chmodSync(roleBackup, 0o600);
  const roleDigest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(roleBackup))
    .digest('hex');
  fs.writeFileSync(path.join(backup, 'previous-release'), `${previous}\n`, {
    mode: 0o600,
  });

  const payload = {
    androidRoleBackup: roleBackup,
    androidRoleBackupReady: 1,
    androidRoleBackupSha256: roleDigest,
    androidRoleMutationAttempted: 0,
    androidRoleRestoreRequired: 1,
    androidRoleUserId: 0,
    androidRolesApplied: 0,
    apkBackup,
    apkBackupReady: 1,
    apkChanged: 1,
    apkInstallAttempted: 1,
    apkUserActionEvidence: 'trusted_system_installer_foreground_v1',
    apkUserActionKind: 'android_install_review',
    apkUserActionPurpose: 'candidate_install',
    apkUserActionTargetSha256: candidateSha,
    apkUserActionTargetSignerSha256: candidateSigner,
    apkUserActionTargetVersionCode: 8,
    backupDir: backup,
    controlToken: path.join(releaseRoot, 'state/data/control-token.txt'),
    controlTokenBackup: path.join(backup, 'control-token.txt'),
    controlTokenBackupReady: 1,
    controlTokenBridge: '',
    controlTokenExisted: 1,
    cycleGate: path.join(home, 'phone-tools/.cycle.lock'),
    dbBackup: path.join(backup, 'media-agent.db'),
    dbBackupReady: 1,
    dbExisted: 1,
    initialMigration: 0,
    legacyControlPlaneExpected: 0,
    legacyPlanSha256: '',
    legacyRuntimeExpected: 0,
    legacySnapshotReady: 0,
    migrationDir: migration,
    migrationStarted: 0,
    newRelease: next,
    packageOperation: '',
    phase: 'apk_user_action_required',
    previousApkCode: '7',
    previousApkSigner: previousSigner,
    previousTarget: previous,
    releaseId: 'release-new',
    root: releaseRoot,
    schema: 'evogent.phone.install-transaction.v4',
    switchStarted: 0,
  };
  const harness = `
set -euo pipefail
${helper}
HOME="$1"
ROOT="$2"
RELEASES="$ROOT/releases"
BACKUPS="$ROOT/backups"
MIGRATIONS="$ROOT/migrations"
PHONE_STATE="$ROOT/state/phone-tools"
TRANSACTION_DIR="$ROOT/install-transaction"
CONTROL_TOKEN="$ROOT/state/data/control-token.txt"
validate_transaction_journal "$3"
`;
  function validate() {
    fs.writeFileSync(journal, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return spawnSync(
      'bash',
      ['-c', harness, 'v4-action', home, releaseRoot, journal],
      { encoding: 'utf8' },
    );
  }

  let result = validate();
  assert.equal(result.status, 0, result.stderr);
  payload.apkUserActionTargetSha256 = 'd'.repeat(64);
  assert.notEqual(validate().status, 0);
  payload.apkUserActionTargetSha256 = candidateSha;

  payload.apkUserActionPurpose = 'rollback_restore';
  payload.apkUserActionTargetSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(apkBackup))
    .digest('hex');
  payload.apkUserActionTargetVersionCode = 7;
  payload.apkUserActionTargetSignerSha256 = previousSigner;
  result = validate();
  assert.equal(result.status, 0, result.stderr);

  payload.schema = 'evogent.phone.install-transaction.v5';
  payload.apkUserActionEvidence = 'fresh_display_0_operator_attestation_v1';
  payload.apkUserActionChallenge = 'e'.repeat(64);
  payload.apkUserActionChallengeCreatedAtEpochSeconds = 1_800_000_000;
  payload.apkUserActionChallengeExpiresAtEpochSeconds = 1_800_000_900;
  payload.apkUserActionTrustedVerifierObserved = 1;
  result = validate();
  assert.equal(result.status, 0, result.stderr);
  payload.apkUserActionChallenge = 'short';
  assert.notEqual(validate().status, 0);
  payload.apkUserActionChallenge = 'e'.repeat(64);
  payload.apkUserActionTrustedVerifierObserved = true;
  assert.notEqual(validate().status, 0);
  payload.apkUserActionTrustedVerifierObserved = 1;

  payload.schema = 'evogent.phone.install-transaction.v6';
  payload.packageOperationState = '';
  payload.apkRollbackRetryGeneration = 1;
  payload.apkInstallScanRequired = 1;
  result = validate();
  assert.equal(result.status, 0, result.stderr);
  delete payload.packageOperationState;
  assert.notEqual(validate().status, 0);
  payload.packageOperationState = '';
  payload.apkRollbackRetryGeneration = 0;
  assert.notEqual(validate().status, 0);
  payload.apkRollbackRetryGeneration = 1;

  for (const invalidCode of [
    '',
    '0',
    '01',
    7,
    '9223372036854775808',
  ]) {
    payload.previousApkCode = invalidCode;
    assert.notEqual(
      validate().status,
      0,
      `accepted invalid predecessor version code ${String(invalidCode)}`,
    );
  }
  payload.previousApkCode = '7';
  for (const invalidSigner of [
    '',
    'c'.repeat(63),
    'C'.repeat(64),
    null,
  ]) {
    payload.previousApkSigner = invalidSigner;
    assert.notEqual(validate().status, 0, 'accepted invalid predecessor signer');
  }
  payload.previousApkSigner = previousSigner;
  for (const [key, invalidValue] of [
    ['apkChanged', 0],
    ['apkInstallAttempted', 0],
    ['apkBackupReady', 0],
    ['androidRoleBackupReady', 0],
    ['androidRoleRestoreRequired', 0],
    [
      'controlTokenBridge',
      `/data/local/tmp/evogent-control-token.${'a'.repeat(32)}/payload`,
    ],
  ]) {
    const original = payload[key];
    payload[key] = invalidValue;
    assert.notEqual(
      validate().status,
      0,
      `accepted incomplete restoration-review authority ${key}`,
    );
    payload[key] = original;
  }

  payload.apkUserActionKind = '';
  assert.notEqual(validate().status, 0);
  payload.apkUserActionKind = 'android_install_review';
  payload.schema = 'evogent.phone.install-transaction.v3';
  assert.notEqual(validate().status, 0);

  payload.schema = 'evogent.phone.install-transaction.v6';
  payload.phase = 'apk_rollback_retry_pending';
  result = validate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid install transaction phase/);
});

test('pinned display-0 attester rejects stale challenges and verifier bypass', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const source = path.join(
    root,
    'phone-paradigm/device/attest-install-review.py',
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-install-attestation-'),
  );
  const home = path.join(fixture, 'home');
  const releaseRoot = path.join(home, '.local/share/evogent');
  const transaction = path.join(releaseRoot, 'install-transaction');
  const migrations = path.join(releaseRoot, 'migrations');
  const migration = path.join(migrations, 'install-release-new');
  fs.mkdirSync(transaction, { recursive: true, mode: 0o700 });
  fs.chmodSync(transaction, 0o700);
  fs.mkdirSync(migration, { recursive: true, mode: 0o700 });
  const attester = path.join(transaction, 'attest-install-review.py');
  fs.copyFileSync(source, attester);
  fs.chmodSync(attester, 0o700);
  const journal = path.join(transaction, 'journal.json');
  const attestation = path.join(
    transaction,
    'install-review-attestation.json',
  );
  const now = Math.floor(Date.now() / 1000);
  const firstChallenge = 'a'.repeat(64);
  const secondChallenge = 'b'.repeat(64);
  const payload = {
    apkBackupReady: 1,
    apkChanged: 1,
    apkInstallAttempted: 1,
    apkInstallScanRequired: 0,
    apkRollbackRetryGeneration: 0,
    apkUserActionChallenge: firstChallenge,
    apkUserActionChallengeCreatedAtEpochSeconds: now - 1,
    apkUserActionChallengeExpiresAtEpochSeconds: now + 300,
    apkUserActionEvidence: 'fresh_display_0_operator_attestation_v1',
    apkUserActionKind: 'android_install_review',
    apkUserActionPurpose: 'candidate_install',
    apkUserActionTargetSha256: 'c'.repeat(64),
    apkUserActionTargetSignerSha256: 'd'.repeat(64),
    apkUserActionTargetVersionCode: 8,
    apkUserActionTrustedVerifierObserved: 0,
    controlTokenBridge: '',
    migrationDir: migration,
    packageOperation: '',
    packageOperationState: '',
    phase: 'apk_user_action_required',
    releaseId: 'release-new',
    root: releaseRoot,
    schema: 'evogent.phone.install-transaction.v6',
  };
  const writeJournal = () => {
    fs.writeFileSync(journal, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.chmodSync(journal, 0o600);
  };
  const attest = (challenge, outcome) => spawnSync(
    'python3',
    [attester, '--fresh-display-0', challenge, outcome],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    },
  );

  writeJournal();
  let result = attest(firstChallenge, 'no-scan-offered');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(attestation).mode & 0o777, 0o600);
  const firstReceipt = fs.readFileSync(attestation);
  const firstData = JSON.parse(firstReceipt);
  assert.equal(firstData.challenge, firstChallenge);
  assert.equal(firstData.displayEvidence, 'fresh_display_0_operator_v1');
  assert.equal(
    firstData.journalSha256,
    crypto.createHash('sha256').update(fs.readFileSync(journal)).digest('hex'),
  );

  payload.apkUserActionChallenge = secondChallenge;
  payload.apkUserActionChallengeCreatedAtEpochSeconds = now;
  payload.apkUserActionTrustedVerifierObserved = 1;
  payload.apkInstallScanRequired = 1;
  fs.rmSync(attestation);
  writeJournal();
  fs.writeFileSync(attestation, firstReceipt, { mode: 0o600 });
  fs.chmodSync(attestation, 0o600);
  const readHarness = `
set -uo pipefail
${shellFunction(installer, 'read_install_review_attestation')}
INSTALL_REVIEW_ATTESTATION="$1"
TRANSACTION_JOURNAL="$2"
RELEASE_ID=release-new
MIGRATION_DIR="$3"
APK_USER_ACTION_PURPOSE=candidate_install
APK_USER_ACTION_TARGET_SHA256="${'c'.repeat(64)}"
APK_USER_ACTION_TARGET_VERSION_CODE=8
APK_USER_ACTION_TARGET_SIGNER_SHA256="${'d'.repeat(64)}"
APK_USER_ACTION_CHALLENGE="${secondChallenge}"
APK_USER_ACTION_CHALLENGE_CREATED_AT="${now}"
APK_USER_ACTION_CHALLENGE_EXPIRES_AT="${now + 300}"
APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED=1
read_install_review_attestation
`;
  result = spawnSync(
    'bash',
    ['-c', readHarness, 'read-attestation', attestation, journal, migration],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0, 'pre-rotation receipt must be invalid');

  fs.rmSync(attestation);
  assert.notEqual(attest(firstChallenge, 'scan-completed').status, 0);
  assert.notEqual(attest(secondChallenge, 'no-scan-offered').status, 0);
  assert.equal(fs.existsSync(attestation), false);
  result = attest(secondChallenge, 'scan-completed');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(attestation, 'utf8')).outcome,
    'scan-completed',
  );
});

test('package install result parser accepts only one bounded versioned status', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'read_package_result_status');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-package-result-'));
  const status = path.join(fixture, 'status');
  const harness = `
set -euo pipefail
${helper}
read_package_result_status "$1"
`;
  function parse(payload) {
    fs.rmSync(status, { force: true });
    fs.writeFileSync(status, payload, { mode: 0o600 });
    return spawnSync('bash', ['-c', harness, 'parser', status], {
      encoding: 'utf8',
    });
  }

  let result = parse('EVOGENT_PACKAGE_RESULT_V1\n0\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '0\n');
  result = parse('EVOGENT_PACKAGE_RESULT_V1\n255\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '255\n');

  for (const rejected of [
    '',
    'EVOGENT_PACKAGE_RESULT_V1\n',
    'EVOGENT_PACKAGE_RESULT_V1\n00\n',
    'EVOGENT_PACKAGE_RESULT_V1\n256\n',
    'EVOGENT_PACKAGE_RESULT_V1\n1\nextra\n',
    'EVOGENT_PACKAGE_RESULT_V2\n0\n',
  ]) {
    assert.notEqual(parse(rejected).status, 0);
  }
  const target = path.join(fixture, 'real-status');
  fs.writeFileSync(target, 'EVOGENT_PACKAGE_RESULT_V1\n0\n');
  fs.rmSync(status, { force: true });
  fs.symlinkSync(target, status);
  result = spawnSync('bash', ['-c', harness, 'parser', status], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
});

test('install review foreground parser is display-0-only and fails closed', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(
    installer,
    'display_zero_top_resumed_package_from_dump',
  );
  function parse(payload) {
    return spawnSync(
      'bash',
      ['-c', `${helper}\ndisplay_zero_top_resumed_package_from_dump`],
      { encoding: 'utf8', input: payload },
    );
  }

  let result = parse(`Display #0 (activities from top to bottom):
  topResumedActivity=ActivityRecord{123 u0 com.google.android.permissioncontroller/.ReviewActivity t42}
Display #7 (activities from top to bottom):
  topResumedActivity=ActivityRecord{456 u0 com.example.hidden/.MainActivity t91}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'com.google.android.permissioncontroller\n');

  result = parse(`Display 0:
  mResumedActivity: ActivityRecord{abc u0 com.android.vending/.AssetBrowserActivity t8}
Display 12:
  mResumedActivity: ActivityRecord{def u0 com.example.hidden/.MainActivity t9}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'com.android.vending\n');

  for (const payload of [
    `Display #0 (activities from top to bottom):
  topDisplayFocusedRootTask=Task{123 type=home}
`,
    `Display #0 (activities from top to bottom):
  topResumedActivity=ActivityRecord{123 u0 com.example.one/.MainActivity t42}
  mResumedActivity: ActivityRecord{456 u0 com.example.two/.MainActivity t43}
`,
    `Display #9 (activities from top to bottom):
  topResumedActivity=ActivityRecord{123 u0 com.android.vending/.MainActivity t42}
`,
  ]) {
    assert.notEqual(parse(payload).status, 0);
  }
});

test('install review observation distinguishes trusted, known-other, and unknown', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const harness = `
set -uo pipefail
${shellFunction(installer, 'display_zero_top_resumed_package_from_dump')}
${shellFunction(installer, 'android_install_foreground_state_once')}
rish_command() {
  cat "$DUMP_FILE"
  return "$RISH_RC"
}
android_install_foreground_state_once
`;
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-install-foreground-state-'),
  );
  function observe(payload, rishRc = 0) {
    const dump = path.join(fixture, crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(dump, payload);
    return spawnSync(
      'bash',
      ['-c', harness],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DUMP_FILE: dump,
          RISH_RC: String(rishRc),
        },
      },
    );
  }

  let result = observe(`Display #0 (activities from top to bottom):
  topResumedActivity=ActivityRecord{123 u0 com.android.vending/.ReviewActivity t42}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'trusted\n');

  result = observe(`Display #0 (activities from top to bottom):
  topResumedActivity=ActivityRecord{123 u0 com.example.reader/.MainActivity t42}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'other\n');

  result = observe('unparseable activity state\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'unknown\n');

  result = observe(`Display #0:
  mResumedActivity: ActivityRecord{123 u0 com.example.reader/.MainActivity t42}
`, 1);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'unknown\n');
});

test('foreground Android install review is typed, identity-bound, and resumable in place', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-install-user-action-'),
  );
  const retained = path.join(fixture, 'package-manager.log');
  fs.writeFileSync(retained, 'private fixture\n', { mode: 0o600 });
  const targetSha = 'a'.repeat(64);
  const targetSigner = 'b'.repeat(64);
  const priorSha = 'c'.repeat(64);
  const priorSigner = 'd'.repeat(64);
  const harness = `
set -uo pipefail
${shellFunction(installer, 'clear_apk_user_action_state')}
${shellFunction(installer, 'reconcile_android_install_user_action')}
say() { printf 'status=%s\\n' "$*"; }
persist_and_wait_android_install_review() {
  prior_phase="$1"
  APK_USER_ACTION_KIND=android_install_review
  APK_USER_ACTION_PURPOSE="$2"
  APK_USER_ACTION_EVIDENCE=fresh_display_0_operator_attestation_v1
  APK_USER_ACTION_TARGET_VERSION_CODE="$3"
  APK_USER_ACTION_TARGET_SIGNER_SHA256="$4"
  APK_USER_ACTION_TARGET_SHA256="$5"
  APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED="$8"
  write_transaction_journal apk_user_action_required
  say "USER_ACTION_REQUIRED kind=android_install_review purpose=$2"
  say "INSTALL_SECURITY_POLICY play_protect_scan=required_when_offered bypass=prohibited"
  say "never choose an install-without-scanning option or suppress verification"
  outcome="$INITIAL_ATTESTATION"
  [ "$outcome" != missing ] || return 1
  if [ "$8" = 1 ] && [ "$outcome" != scan-completed ]; then
    say "Install-review attestation was rejected"
    return 1
  fi
  clear_apk_user_action_state
  write_transaction_journal "$prior_phase"
  say "Fresh display-0 operator attestation accepted ($outcome)"
}
stat() {
  case "$2" in
    %a)
      [ "$3" != "$TRANSACTION_ATTESTER" ] || { printf '700\\n'; return; }
      printf '600\\n'
      ;;
    %u) id -u ;;
    %h) printf '1\\n' ;;
    *) return 1 ;;
  esac
}
clear_install_review_attestation() {
  rm -f -- "$INSTALL_REVIEW_ATTESTATION"
}
rotate_android_install_review_challenge() {
  CHALLENGE_COUNT=$((CHALLENGE_COUNT + 1))
  APK_USER_ACTION_CHALLENGE="$(printf '%064d' "$CHALLENGE_COUNT")"
  APK_USER_ACTION_CHALLENGE_CREATED_AT=1
  APK_USER_ACTION_CHALLENGE_EXPIRES_AT="$2"
  APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED="$1"
  clear_install_review_attestation
  write_transaction_journal apk_user_action_required
  outcome="$INITIAL_ATTESTATION"
  [ "$CHALLENGE_COUNT" -eq 1 ] || outcome="$ROTATED_ATTESTATION"
  if [ "$outcome" != missing ]; then
    printf '%s\\n' "$outcome" > "$INSTALL_REVIEW_ATTESTATION"
    chmod 600 "$INSTALL_REVIEW_ATTESTATION"
  fi
}
announce_android_install_review_attestation() {
  say "INSTALL_REVIEW_ATTESTATION challenge=$APK_USER_ACTION_CHALLENGE"
  say "Inspect a fresh display-0 image immediately before recording the outcome."
}
read_install_review_attestation() {
  [ -f "$INSTALL_REVIEW_ATTESTATION" ] || return 1
  outcome="$(cat "$INSTALL_REVIEW_ATTESTATION")"
  [ "$outcome" = scan-completed ] || [ "$outcome" = no-scan-offered ] || return 1
  if [ "$APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED" = 1 ]; then
    [ "$outcome" = scan-completed ] || return 1
  fi
  printf '%s\\n' "$outcome"
}
sha256_file() {
  if [ "$1" = /candidate.apk ]; then
    printf '%s\\n' "$TARGET_SHA"
  else
    printf '%s\\n' "$PRIOR_SHA"
  fi
}
installed_apk_identity_stable() {
  if [ "$2" = "$EXPECTED_APK_CODE" ]; then
    [ "$TARGET_ALREADY" = 1 ] || [ -e "$ACTION_MARKER" ]
  else
    [ "$COUNTERPART_KNOWN" = 1 ]
  fi
}
installed_apk_matches_identity() {
  [ "$ACTION_WRITTEN" = 1 ] && [ "$2" = "$EXPECTED_APK_CODE" ]
}
wait_for_package_manager_idle() { return 0; }
android_install_foreground_state_once() {
  if [ -e "$ACTION_MARKER" ]; then
    if [ "$ROTATE_AFTER_ATTESTATION" = 1 ] \
        && [ "$CHALLENGE_COUNT" -eq 1 ] \
        && [ ! -e "$ROTATION_SEEN" ]; then
      : > "$ROTATION_SEEN"
      printf 'trusted\\n'
      return
    fi
    printf 'other\\n'
  elif [ "$TRUSTED_FOREGROUND" = 1 ]; then
    printf 'trusted\\n'
  else
    printf 'other\\n'
  fi
}
trusted_android_install_foreground() {
  [ "$(android_install_foreground_state_once)" = trusted ]
}
write_transaction_journal() {
  printf 'phase=%s\\n' "$1" >> "$TRACE"
  TRANSACTION_PHASE="$1"
  [ "$1" != apk_user_action_required ] || {
    ACTION_WRITTEN=1
    : > "$ACTION_MARKER"
  }
}
date() {
  if [ "\${1:-}" = +%s ]; then
    now=$(cat "$CLOCK_FILE")
    now=$((now + 1))
    printf '%s\\n' "$now" > "$CLOCK_FILE"
    printf '%s\\n' "$now"
  else
    command date "$@"
  fi
}
sleep() { :; }
STAGE="$1"
TRACE="$2"
RETAINED="$3"
INSTALL_REVIEW_ATTESTATION="$1/install-review-attestation.json"
TRANSACTION_ATTESTER="$1/attest-install-review.py"
ACTION_MARKER="$1/install-review-action"
TRANSACTION_JOURNAL_WRITTEN=1
TRANSACTION_PHASE=apk_install_pending
APK_BACKUP=/backup.apk
EXPECTED_APK_CODE=8
EXPECTED_APK_SIGNER="$TARGET_SIGNER"
EXPECTED_APK_SHA256="$TARGET_SHA"
PREVIOUS_APK_CODE=7
PREVIOUS_APK_SIGNER="$PRIOR_SIGNER"
INSTALL_USER_ACTION_WAIT_SECONDS=4
ACTION_WRITTEN=0
CHALLENGE_COUNT=0
rm -f -- "$ACTION_MARKER"
clear_apk_user_action_state
if reconcile_android_install_user_action \
    /candidate.apk upgrade "$RETAINED"; then
  rc=0
else
  rc=$?
fi
printf 'result=%s action=%s purpose=%s evidence=%s\\n' \
  "$rc" "$APK_USER_ACTION_KIND" "$APK_USER_ACTION_PURPOSE" \
  "$APK_USER_ACTION_EVIDENCE"
`;
  function run(env) {
    const trace = path.join(fixture, `trace-${crypto.randomBytes(4).toString('hex')}`);
    const clock = path.join(fixture, `clock-${crypto.randomBytes(4).toString('hex')}`);
    const rotationSeen = path.join(
      fixture,
      `rotation-${crypto.randomBytes(4).toString('hex')}`,
    );
    const attester = path.join(fixture, 'attest-install-review.py');
    fs.writeFileSync(attester, '#!/bin/sh\\n', { mode: 0o700 });
    fs.chmodSync(attester, 0o700);
    fs.writeFileSync(clock, '0\\n');
    const result = spawnSync(
      'bash',
      ['-c', harness, 'install-user-action', fixture, trace, retained],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION_WRITTEN: '0',
          COUNTERPART_KNOWN: '1',
          CLOCK_FILE: clock,
          INITIAL_ATTESTATION: 'scan-completed',
          PRIOR_SHA: priorSha,
          PRIOR_SIGNER: priorSigner,
          ROTATED_ATTESTATION: 'missing',
          ROTATE_AFTER_ATTESTATION: '0',
          ROTATION_SEEN: rotationSeen,
          TARGET_ALREADY: '0',
          TARGET_SHA: targetSha,
          TARGET_SIGNER: targetSigner,
          TRACE: trace,
          TRUSTED_FOREGROUND: '1',
          ...env,
        },
      },
    );
    return {
      result,
      trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '',
    };
  }

  let outcome = run({});
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /USER_ACTION_REQUIRED/);
  assert.match(
    outcome.result.stdout,
    /play_protect_scan=required_when_offered bypass=prohibited/,
  );
  assert.match(
    outcome.result.stdout,
    /never choose an install-without-scanning option or suppress verification/,
  );
  assert.match(
    outcome.result.stdout,
    /Fresh display-0 operator attestation accepted \(scan-completed\)/,
  );
  assert.match(outcome.result.stdout, /result=0 action= purpose= evidence=/);
  assert.equal(
    outcome.trace,
    'phase=apk_user_action_required\nphase=apk_install_pending\n',
  );
  assert.doesNotMatch(outcome.result.stdout, /private fixture|package-manager/);

  outcome = run({ TRUSTED_FOREGROUND: '0' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /result=1 action= purpose= evidence=/);
  assert.equal(outcome.trace, '');

  outcome = run({
    INITIAL_ATTESTATION: 'no-scan-offered',
    TARGET_ALREADY: '1',
    COUNTERPART_KNOWN: '0',
    TRUSTED_FOREGROUND: '0',
  });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /result=0 action= purpose= evidence=/);
  assert.equal(
    outcome.trace,
    'phase=apk_user_action_required\nphase=apk_install_pending\n',
  );

  outcome = run({
    INITIAL_ATTESTATION: 'missing',
    TARGET_ALREADY: '1',
    COUNTERPART_KNOWN: '0',
    TRUSTED_FOREGROUND: '0',
  });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /result=1/);
  assert.equal(outcome.trace, 'phase=apk_user_action_required\n');

  outcome = run({ INITIAL_ATTESTATION: 'no-scan-offered' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /attestation was rejected/);
  assert.match(outcome.result.stdout, /result=1/);
  assert.equal(outcome.trace, 'phase=apk_user_action_required\n');

  assert.match(
    shellFunction(installer, 'install_apk'),
    /completionPublished[\s\S]*reconcile_android_install_user_action/,
  );
  assert.match(
    installer,
    /"schema": "evogent[.]phone[.]install-transaction[.]v6"/,
  );
});

test('successful package install still gates an asynchronously surfaced verifier review', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-post-success-install-review-'),
  );
  const targetSha = 'a'.repeat(64);
  const targetSigner = 'b'.repeat(64);
  const harness = `
set -uo pipefail
${shellFunction(installer, 'clear_apk_user_action_state')}
${shellFunction(installer, 'announce_android_install_security_policy')}
${shellFunction(installer, 'persist_and_wait_android_install_review')}
${shellFunction(installer, 'reconcile_successful_android_install_foreground')}
say() { printf 'status=%s\\n' "$*"; }
stat() {
  case "$2" in
    %a)
      [ "$3" != "$TRANSACTION_ATTESTER" ] || { printf '700\\n'; return; }
      printf '600\\n'
      ;;
    %u) id -u ;;
    %h) printf '1\\n' ;;
    *) return 1 ;;
  esac
}
clear_install_review_attestation() {
  rm -f -- "$INSTALL_REVIEW_ATTESTATION"
}
rotate_android_install_review_challenge() {
  CHALLENGE_COUNT=$((CHALLENGE_COUNT + 1))
  APK_USER_ACTION_CHALLENGE="$(printf '%064d' "$CHALLENGE_COUNT")"
  APK_USER_ACTION_CHALLENGE_CREATED_AT=1
  APK_USER_ACTION_CHALLENGE_EXPIRES_AT="$2"
  APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED="$1"
  clear_install_review_attestation
  write_transaction_journal apk_user_action_required
  outcome="$INITIAL_ATTESTATION"
  [ "$CHALLENGE_COUNT" -eq 1 ] || outcome="$ROTATED_ATTESTATION"
  if [ "$outcome" = auto ]; then
    outcome=no-scan-offered
    [ "$1" = 0 ] || outcome=scan-completed
  fi
  if [ "$outcome" != missing ]; then
    printf '%s\\n' "$outcome" > "$INSTALL_REVIEW_ATTESTATION"
    chmod 600 "$INSTALL_REVIEW_ATTESTATION"
  fi
}
announce_android_install_review_attestation() {
  say "INSTALL_REVIEW_ATTESTATION challenge=$APK_USER_ACTION_CHALLENGE"
}
read_install_review_attestation() {
  [ -f "$INSTALL_REVIEW_ATTESTATION" ] || return 1
  outcome="$(cat "$INSTALL_REVIEW_ATTESTATION")"
  [ "$outcome" = scan-completed ] || [ "$outcome" = no-scan-offered ] || return 1
  if [ "$APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED" = 1 ]; then
    [ "$outcome" = scan-completed ] || return 1
  fi
  printf '%s\\n' "$outcome"
}
sha256_file() { printf '%s\\n' "$TARGET_SHA"; }
installed_apk_identity_stable() { [ "$IDENTITY_READY" = 1 ]; }
wait_for_package_manager_idle() { return 0; }
android_install_foreground_state_once() {
  if [ "$ACTION_WRITTEN" = 1 ]; then
    if [ "$RESOLUTION_STATE" = trusted-once ]; then
      if [ ! -e "$ROTATION_SEEN" ]; then
        : > "$ROTATION_SEEN"
        printf 'trusted\\n'
      else
        printf 'other\\n'
      fi
      return
    fi
    if [ "$RESOLUTION_STATE" = trusted-delayed ]; then
      now="$(cat "$CLOCK_FILE")"
      if [ "$now" -ge "$DELAYED_TRUST_AT" ] \
          && [ ! -e "$ROTATION_SEEN" ]; then
        : > "$ROTATION_SEEN"
        printf 'trusted\\n'
      else
        printf 'other\\n'
      fi
      return
    fi
    printf '%s\\n' "$RESOLUTION_STATE"
  elif [ "$PROMPT_SEEN" = 1 ]; then
    printf 'trusted\\n'
  else
    printf 'other\\n'
  fi
}
write_transaction_journal() {
  printf 'phase=%s\\n' "$1" >> "$TRACE"
  TRANSACTION_PHASE="$1"
  [ "$1" != apk_user_action_required ] || ACTION_WRITTEN=1
}
date() {
  if [ "\${1:-}" = +%s ]; then
    now=$(cat "$CLOCK_FILE")
    now=$((now + 1))
    printf '%s\\n' "$now" > "$CLOCK_FILE"
    printf '%s\\n' "$now"
  else
    command date "$@"
  fi
}
sleep() { :; }
STAGE="$1"
TRACE="$2"
INSTALL_REVIEW_ATTESTATION="$1/install-review-attestation.json"
TRANSACTION_ATTESTER="$1/attest-install-review.py"
TRANSACTION_JOURNAL_WRITTEN=1
TRANSACTION_PHASE=apk_install_pending
EXPECTED_APK_CODE=8
EXPECTED_APK_SIGNER="$TARGET_SIGNER"
PREVIOUS_APK_CODE=7
PREVIOUS_APK_SIGNER="${'c'.repeat(64)}"
INSTALL_POST_SUCCESS_REVIEW_SECONDS=3
INSTALL_USER_ACTION_WAIT_SECONDS=4
ACTION_WRITTEN=0
CHALLENGE_COUNT=0
clear_apk_user_action_state
if reconcile_successful_android_install_foreground /candidate.apk upgrade; then
  rc=0
else
  rc=$?
fi
printf 'result=%s action=%s purpose=%s evidence=%s\\n' \\
  "$rc" "$APK_USER_ACTION_KIND" "$APK_USER_ACTION_PURPOSE" \\
  "$APK_USER_ACTION_EVIDENCE"
`;
  function run(env) {
    const trace = path.join(fixture, `trace-${crypto.randomBytes(4).toString('hex')}`);
    const clock = path.join(fixture, `clock-${crypto.randomBytes(4).toString('hex')}`);
    const rotationSeen = path.join(
      fixture,
      `rotation-${crypto.randomBytes(4).toString('hex')}`,
    );
    const attester = path.join(fixture, 'attest-install-review.py');
    fs.writeFileSync(attester, '#!/bin/sh\\n', { mode: 0o700 });
    fs.chmodSync(attester, 0o700);
    fs.writeFileSync(clock, '0\n');
    const result = spawnSync(
      'bash',
      ['-c', harness, 'post-success-review', fixture, trace],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION_WRITTEN: '0',
          DELAYED_TRUST_AT: '4',
          IDENTITY_READY: '1',
          INITIAL_ATTESTATION: 'auto',
          PROMPT_SEEN: '1',
          RESOLUTION_STATE: 'other',
          ROTATED_ATTESTATION: 'auto',
          ROTATION_SEEN: rotationSeen,
          TARGET_SHA: targetSha,
          TARGET_SIGNER: targetSigner,
          TRACE: trace,
          CLOCK_FILE: clock,
          ...env,
        },
      },
    );
    return {
      result,
      trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '',
    };
  }

  let outcome = run({});
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /USER_ACTION_REQUIRED/);
  assert.match(
    outcome.result.stdout,
    /surfaced a trusted install or verification review after package success/,
  );
  assert.match(
    outcome.result.stdout,
    /Fresh display-0 operator attestation accepted \(scan-completed\); exact installed identity reproved/,
  );
  assert.match(outcome.result.stdout, /result=0 action= purpose= evidence=/);
  assert.equal(
    outcome.trace,
    'phase=apk_user_action_required\nphase=apk_install_pending\n',
  );

  outcome = run({ PROMPT_SEEN: '0' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /result=0 action= purpose= evidence=/);
  assert.match(
    outcome.result.stdout,
    /operator attestation is still required/,
  );
  assert.equal(
    outcome.trace,
    'phase=apk_user_action_required\nphase=apk_install_pending\n',
  );

  outcome = run({
    INITIAL_ATTESTATION: 'missing',
    PROMPT_SEEN: '0',
  });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /result=1/);
  assert.equal(outcome.trace, 'phase=apk_user_action_required\n');

  outcome = run({
    INITIAL_ATTESTATION: 'no-scan-offered',
    PROMPT_SEEN: '0',
    RESOLUTION_STATE: 'trusted-once',
    ROTATED_ATTESTATION: 'missing',
  });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /prior attestation challenge was revoked/);
  assert.match(outcome.result.stdout, /result=1/);
  assert.equal(
    outcome.trace,
    'phase=apk_user_action_required\nphase=apk_user_action_required\n',
  );

  outcome = run({
    INITIAL_ATTESTATION: 'no-scan-offered',
    PROMPT_SEEN: '0',
    RESOLUTION_STATE: 'trusted-delayed',
    ROTATED_ATTESTATION: 'missing',
  });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /prior attestation challenge was revoked/);
  assert.match(outcome.result.stdout, /result=1/);
  assert.equal(
    outcome.trace,
    'phase=apk_user_action_required\nphase=apk_user_action_required\n',
  );

  outcome = run({ IDENTITY_READY: '0' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /result=1/);
  assert.equal(outcome.trace, 'phase=apk_user_action_required\n');

  outcome = run({ RESOLUTION_STATE: 'unknown' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /result=1/);
  assert.equal(outcome.trace, 'phase=apk_user_action_required\n');

  outcome = run({ RESOLUTION_STATE: 'trusted' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /result=1/);
  assert.equal(outcome.trace, 'phase=apk_user_action_required\n');

  const installFunction = shellFunction(installer, 'install_apk');
  assert.match(
    installFunction,
    /package_status.*-ne 0[\s\S]*reconcile_android_install_user_action[\s\S]*return 0/,
  );
  assert.match(
    installFunction,
    /rm -f -- "\$retained_result"[\s\S]*reconcile_successful_android_install_foreground "\$apk" "\$mode"/,
  );
});

test('foreground install polling reads version before copying the installed APK', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'installed_apk_matches_identity');
  const harness = `
set -uo pipefail
${helper}
installed_apk_version_code() {
  printf 'version\\n' >> "$TRACE"
  printf '%s\\n' "$INSTALLED_CODE"
}
backup_installed_apk() {
  printf 'backup\\n' >> "$TRACE"
}
apk_signer_sha256() {
  printf 'signer\\n' >> "$TRACE"
  printf '%s\\n' "$EXPECTED_SIGNER"
}
sha256_file() {
  printf 'hash\\n' >> "$TRACE"
  printf '%s\\n' "$EXPECTED_SHA"
}
installed_apk_matches_identity \
  /probe.apk 8 "$EXPECTED_SIGNER" "$EXPECTED_SHA"
`;
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-install-version-first-'),
  );
  function run(installedCode) {
    const trace = path.join(fixture, `trace-${installedCode}`);
    const result = spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPECTED_SHA: 'a'.repeat(64),
        EXPECTED_SIGNER: 'b'.repeat(64),
        INSTALLED_CODE: installedCode,
        TRACE: trace,
      },
    });
    return {
      result,
      trace: fs.readFileSync(trace, 'utf8'),
    };
  }

  let outcome = run('7');
  assert.notEqual(outcome.result.status, 0);
  assert.equal(outcome.trace, 'version\n');

  outcome = run('8');
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.equal(outcome.trace, 'version\nbackup\nsigner\nhash\n');
});

test('filesystem bridge waits for a regular read-only shell publication', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'copy_published_shell_file');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-shell-publish-'));
  const source = path.join(fixture, 'source');
  const destination = path.join(fixture, 'destination');
  fs.writeFileSync(source, '', { mode: 0o600 });
  const delayedHarness = `
set -euo pipefail
${helper}
stat() {
  if [ "$1" = -c ] && [ "$2" = %a ]; then
    python3 - "$3" <<'PY'
import os, stat, sys
print(oct(stat.S_IMODE(os.lstat(sys.argv[1]).st_mode))[2:])
PY
  else
    command stat "$@"
  fi
}
(
  sleep 0.2
  printf 'published bytes\\n' > "$1"
  chmod 0644 "$1"
) &
copy_published_shell_file "$1" "$2" 20
`;
  let result = spawnSync(
    'bash',
    ['-c', delayedHarness, 'bridge', source, destination],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'published bytes\n');
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);

  const realSource = path.join(fixture, 'real-source');
  const linkedSource = path.join(fixture, 'linked-source');
  fs.writeFileSync(realSource, 'unsafe indirection\n', { mode: 0o644 });
  fs.symlinkSync(realSource, linkedSource);
  const rejectHarness = `
set -euo pipefail
${helper}
stat() {
  if [ "$1" = -c ] && [ "$2" = %a ]; then
    python3 - "$3" <<'PY'
import os, stat, sys
print(oct(stat.S_IMODE(os.lstat(sys.argv[1]).st_mode))[2:])
PY
  else
    command stat "$@"
  fi
}
copy_published_shell_file "$1" "$2" 1
`;
  result = spawnSync(
    'bash',
    ['-c', rejectHarness, 'bridge', linkedSource, destination],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
});

test('rollback routes an exact dangling predecessor to inert legacy state before durable rearm', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const normalize = shellFunction(
    installer,
    'normalize_dangling_legacy_predecessor',
  );
  const rollback = shellFunction(installer, 'rollback_release');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-legacy-rollback-'));
  const home = path.join(fixture, 'home');
  const releaseRoot = path.join(home, '.local/share/evogent');
  const current = path.join(releaseRoot, 'current');
  const previous = path.join(releaseRoot, 'releases/release-missing');
  const trace = path.join(fixture, 'trace');
  fs.mkdirSync(path.join(home, 'evogent'), { recursive: true });
  fs.mkdirSync(path.join(home, 'phone-tools'), { recursive: true });
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.symlinkSync(previous, current);
  const harness = `
set -uo pipefail
${normalize}
${rollback}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
quiesce_control_plane() { return 0; }
stop_and_prove_runtime() { RUNTIME_PROVEN_STOPPED=1; return 0; }
reap_abandoned_control_workers_and_prove_absent() { return 0; }
rollback_phone_dispatch_changes() { record dispatch; }
rollback_seeded_defaults() { :; }
atomic_link() { record pointer; }
restore_database() { record database; }
rollback_apk_native() { record apk; }
restore_android_roles() { record roles; }
restore_control_token() { record token; }
rollback_initial_migration() { record migration; }
legacy_runtime_topology() { printf 'present\\n'; }
legacy_control_plane_stopped() { return 0; }
commit_rolled_back_decision() { record decision; return 0; }
resolve_legacy_compat_expectation() { :; }
reap_recorded_package_operation() { :; }
reap_recorded_control_token_bridge() { :; }
rish_command() { record rish; }
bash() { record boot; }
HOME="$1"
CURRENT="$2"
PREVIOUS_TARGET="$3"
TRACE="$4"
RELEASES="$(dirname "$3")"
STATE="$1/.local/share/evogent/state"
PHONE_STATE="$STATE/phone-tools"
APK_CHANGED=0
APK_INSTALL_ATTEMPTED=1
PACKAGE_OPERATION=""
PACKAGE_OPERATION_STATE=""
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=0
CONTROL_TOKEN_BRIDGE=""
ANDROID_ROLE_RESTORE_REQUIRED=0
INITIAL_MIGRATION=0
MIGRATION_STARTED=0
QUIESCED=0
REARM_PRIOR_CONTROL_PLANE=0
ROLLBACK_ATTEMPTED=0
ROLLBACK_FAILED=0
TRANSACTION_PHASE=prepared
LEGACY_RUNTIME_EXPECTED=1
LEGACY_CONTROL_PLANE_EXPECTED=1
LEGACY_EXPECTATION_COMPAT=0
RESTORED_LEGACY_CONTROL_PLANE=0
SWITCH_STARTED=0
RUNTIME_PROVEN_STOPPED=0
if rollback_release; then rc=0; else rc=$?; fi
printf 'rc=%s previous=%s initial=%s\\n' "$rc" "$PREVIOUS_TARGET" "$INITIAL_MIGRATION"
`;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'harness', home, current, previous, trace],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 previous= initial=1/);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'migration\ndatabase\ntoken\ndecision\n',
  );
  assert.throws(
    () => fs.lstatSync(current),
    (error) => error?.code === 'ENOENT',
  );
});

test('legacy recovery starts a real fallback program and proves all owners live', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const safeProgram = shellFunction(installer, 'safe_private_program');
  const controlPlaneLive = shellFunction(
    installer,
    'legacy_control_plane_live',
  );
  const abortRearm = shellFunction(installer, 'abort_partial_legacy_rearm');
  const serverHelper = shellFunction(installer, 'rearm_legacy_server');
  const controlHelper = shellFunction(installer, 'rearm_legacy_control_plane');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-legacy-rearm-'));
  const home = path.join(fixture, 'home');
  const tools = path.join(home, 'phone-tools');
  const primary = path.join(home, 'start-prod.sh');
  const fallback = path.join(home, 'start-prod-sub.sh');
  const boot = path.join(tools, 'evogent-boot.sh');
  const trace = path.join(fixture, 'trace');
  fs.mkdirSync(tools, { recursive: true });
  const harness = `
set -uo pipefail
${safeProgram}
${controlPlaneLive}
${abortRearm}
${serverHelper}
${controlHelper}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
sleep() { :; }
fsync_directory() { return "$FSYNC_RESULT"; }
stop_tmux_session() { record stop; return "$STOP_RESULT"; }
legacy_server_owner_live() { return "$SERVER_RESULT"; }
restored_background_control_stopped() { return "$BACKGROUND_RESULT"; }
scheduler_owner_live() { return "$SCHEDULER_RESULT"; }
watchdog_owner_live() { return "$WATCHDOG_RESULT"; }
quiesce_control_plane() { record quiesce; return 0; }
stop_and_prove_runtime() { record stop-runtime; return 0; }
tmux() {
  case "$1" in
    new-session)
      case "$*" in
        *start-prod-sub.sh*) record start-fallback ;;
        *) record wrong-start ;;
      esac
      return "$TMUX_START_RESULT"
      ;;
    *) return 64 ;;
  esac
}
bash() {
  case "$1" in
    */phone-tools/evogent-boot.sh) record boot ;;
    *) record wrong-boot ;;
  esac
  return "$BOOT_RESULT"
}
HOME="$1"
TRACE="$2"
RUNTIME_PROVEN_STOPPED=1
LEGACY_RECOVERY_LAUNCH_ID=""
LEGACY_SNAPSHOT_READY=0
if rearm_legacy_server && rearm_legacy_control_plane; then rc=0; else rc=$?; fi
printf 'rc=%s\\n' "$rc"
`;
  function writePrograms({
    bootMode = 0o600,
    fallbackMode = 0o600,
    fallbackSymlink = false,
  } = {}) {
    fs.rmSync(primary, { force: true });
    fs.rmSync(fallback, { force: true });
    fs.rmSync(boot, { force: true });
    if (fallbackSymlink) {
      fs.symlinkSync(path.join(fixture, 'outside-start.sh'), fallback);
    } else {
      fs.writeFileSync(fallback, 'legacy start fixture\n', {
        mode: fallbackMode,
      });
      fs.chmodSync(fallback, fallbackMode);
    }
    fs.writeFileSync(boot, 'legacy boot fixture\n', { mode: bootMode });
    fs.chmodSync(boot, bootMode);
  }
  function runRearm(overrides = {}, programs = {}) {
    fs.rmSync(trace, { force: true });
    writePrograms(programs);
    return spawnSync('bash', ['-c', harness, 'harness', home, trace], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOOT_RESULT: '0',
        BACKGROUND_RESULT: '0',
        FSYNC_RESULT: '0',
        SCHEDULER_RESULT: '0',
        SERVER_RESULT: '0',
        STOP_RESULT: '0',
        TMUX_START_RESULT: '0',
        WATCHDOG_RESULT: '0',
        ...overrides,
      },
    });
  }

  let result = runRearm();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0/);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'stop\nstart-fallback\nboot\n');
  assert.equal(fs.existsSync(primary), false);

  result = runRearm({ FSYNC_RESULT: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1/);
  assert.equal(fs.existsSync(primary), false);

  fs.rmSync(trace, { force: true });
  result = spawnSync('bash', ['-c', harness, 'harness', home, trace], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BOOT_RESULT: '0',
      BACKGROUND_RESULT: '0',
      FSYNC_RESULT: '0',
      SCHEDULER_RESULT: '0',
      SERVER_RESULT: '0',
      STOP_RESULT: '0',
      TMUX_START_RESULT: '0',
      WATCHDOG_RESULT: '0',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0/);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'stop\nstart-fallback\nboot\n');

  for (const overrides of [
    { SERVER_RESULT: '1' },
    { BACKGROUND_RESULT: '1' },
    { SCHEDULER_RESULT: '1' },
    { WATCHDOG_RESULT: '1' },
    { BOOT_RESULT: '1' },
    { TMUX_START_RESULT: '1' },
  ]) {
    result = runRearm(overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rc=1/);
    assert.match(fs.readFileSync(trace, 'utf8'), /quiesce\nstop-runtime\n$/);
  }

  for (const programs of [
    { fallbackMode: 0o666 },
    { fallbackMode: 0o000 },
    { fallbackSymlink: true },
    { bootMode: 0o666 },
  ]) {
    result = runRearm({}, programs);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rc=1/);
    assert.equal(fs.existsSync(trace), false);
  }

  assert.match(
    installer,
    /previous_boot="\$PREVIOUS_TARGET\/phone-tools\/evogent-boot[.]sh"[\s\S]*EVOGENT_CONTROL_RELEASE_ROOT="\$PREVIOUS_TARGET"[\s\S]*bash "\$previous_boot"[\s\S]*wait_for_authenticated_release_control_plane "\$PREVIOUS_TARGET"/,
  );
  assert.match(
    installer,
    /recover_interrupted_transaction\(\)[\s\S]*legacy_control_plane_stopped \|\| \{[\s\S]*REARM_PRIOR_CONTROL_PLANE=1/,
  );
});

test('legacy snapshot accepts a genuine pre-helper surface and binds any optional control helper', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const planHarness = `
set -euo pipefail
${shellFunction(installer, 'fsync_tree')}
${shellFunction(installer, 'copy_legacy_home_snapshots')}
${shellFunction(installer, 'prepare_legacy_rollback_plan')}
${shellFunction(installer, 'finalize_legacy_rollback_plan')}
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
HOME="$1"
ROOT="$2"
STATE="$ROOT/state"
PHONE_STATE="$STATE/phone-tools"
MIGRATION_DIR="$ROOT/migrations/legacy-fixture"
RELEASE_ID=release-1
LEGACY_RUNTIME_EXPECTED=1
LEGACY_CONTROL_PLANE_EXPECTED=1
LEGACY_SNAPSHOT_READY=0
LEGACY_PLAN_SHA256=""
prepare_legacy_rollback_plan
cp -a "$HOME/phone-tools" "$MIGRATION_DIR/phone-tools"
fsync_tree "$MIGRATION_DIR/phone-tools"
copy_legacy_home_snapshots "$MIGRATION_DIR/home" "$HOME/start-prod.sh"
fsync_tree "$MIGRATION_DIR/home"
finalize_legacy_rollback_plan
printf '%s\\n' "$LEGACY_PLAN_SHA256"
`;
  const snapshotProbeHarness = `
set -euo pipefail
${shellFunction(installer, 'legacy_plan_snapshot_location')}
MIGRATION_DIR="$1"
legacy_plan_snapshot_location phoneTools "$MIGRATION_DIR/phone-tools"
`;

  function makeLegacyFixture({
    helper = 'absent',
    referencesMissingHelper = false,
  } = {}) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-pre-helper-'));
    const home = path.join(fixture, 'home');
    const releaseRoot = path.join(home, '.local/share/evogent');
    const migration = path.join(releaseRoot, 'migrations/legacy-fixture');
    const tools = path.join(home, 'phone-tools');
    fs.mkdirSync(path.join(home, 'evogent'), { recursive: true });
    fs.mkdirSync(tools);
    fs.mkdirSync(path.join(releaseRoot, 'state'), { recursive: true });
    fs.mkdirSync(path.join(migration, 'home'), { recursive: true });
    fs.writeFileSync(path.join(home, 'start-prod.sh'), 'start legacy server\\n', {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(tools, 'evogent-boot.sh'),
      referencesMissingHelper
        ? 'source "$HOME/phone-tools/control-plane.sh"\\n'
        : 'bash "$HOME/phone-tools/evogent-scheduler.sh"\\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(tools, 'evogent-scheduler.sh'),
      'scheduler legacy loop\\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(tools, 'evogent-watchdog.sh'),
      'watchdog legacy loop\\n',
      { mode: 0o600 },
    );
    const helperPath = path.join(tools, 'control-plane.sh');
    if (helper === 'safe' || helper === 'writable') {
      fs.writeFileSync(helperPath, 'shared control helpers\\n', { mode: 0o600 });
      if (helper === 'writable') fs.chmodSync(helperPath, 0o666);
    } else if (helper === 'symlink') {
      fs.symlinkSync('evogent-watchdog.sh', helperPath);
    }
    return {
      home,
      releaseRoot,
      migration,
      snapshotHelper: path.join(migration, 'phone-tools/control-plane.sh'),
    };
  }

  function runPlan(fixture) {
    return spawnSync(
      'bash',
      ['-c', planHarness, 'plan', fixture.home, fixture.releaseRoot],
      { encoding: 'utf8' },
    );
  }

  const preHelper = makeLegacyFixture();
  let result = runPlan(preHelper);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^[0-9a-f]{64}$/);
  let plan = JSON.parse(
    fs.readFileSync(path.join(preHelper.migration, 'rollback-plan.json'), 'utf8'),
  );
  assert.deepEqual(
    Object.keys(plan.snapshots.phoneTools.controlPrograms).sort(),
    [
      'evogent-boot.sh',
      'evogent-scheduler.sh',
      'evogent-watchdog.sh',
    ],
  );

  const missingDependency = makeLegacyFixture({ referencesMissingHelper: true });
  result = runPlan(missingDependency);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /legacy recovery program references missing control-plane[.]sh/,
  );

  for (const helper of ['symlink', 'writable']) {
    const unsafe = makeLegacyFixture({ helper });
    result = runPlan(unsafe);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /legacy control helper is unsafe: control-plane[.]sh/,
    );
  }

  const helperPresent = makeLegacyFixture({ helper: 'safe' });
  result = runPlan(helperPresent);
  assert.equal(result.status, 0, result.stderr);
  plan = JSON.parse(
    fs.readFileSync(
      path.join(helperPresent.migration, 'rollback-plan.json'),
      'utf8',
    ),
  );
  assert.equal(
    plan.snapshots.phoneTools.controlPrograms['control-plane.sh'].type,
    'regular',
  );
  const probe = () => spawnSync(
    'bash',
    ['-c', snapshotProbeHarness, 'probe', helperPresent.migration],
    { encoding: 'utf8' },
  );
  result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(helperPresent.migration, 'phone-tools'));

  const helperBytes = fs.readFileSync(helperPresent.snapshotHelper);
  fs.appendFileSync(helperPresent.snapshotHelper, 'tampered\\n');
  result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'missing');
  fs.writeFileSync(helperPresent.snapshotHelper, helperBytes);

  const originalHelper = `${helperPresent.snapshotHelper}.original`;
  fs.renameSync(helperPresent.snapshotHelper, originalHelper);
  fs.writeFileSync(helperPresent.snapshotHelper, helperBytes, { mode: 0o600 });
  result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'missing');
  fs.unlinkSync(helperPresent.snapshotHelper);
  fs.renameSync(originalHelper, helperPresent.snapshotHelper);
  result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(helperPresent.migration, 'phone-tools'));
});

test('v2 legacy rollback is inode-bound and idempotent across every forward move', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const planHarness = `
set -euo pipefail
${shellFunction(installer, 'fsync_tree')}
${shellFunction(installer, 'copy_legacy_home_snapshots')}
${shellFunction(installer, 'prepare_legacy_rollback_plan')}
${shellFunction(installer, 'finalize_legacy_rollback_plan')}
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
HOME="$1"
ROOT="$2"
STATE="$ROOT/state"
PHONE_STATE="$STATE/phone-tools"
MIGRATION_DIR="$ROOT/migrations/legacy-fixture"
RELEASE_ID=release-1
LEGACY_RUNTIME_EXPECTED=1
LEGACY_CONTROL_PLANE_EXPECTED=1
LEGACY_SNAPSHOT_READY=0
LEGACY_PLAN_SHA256=""
prepare_legacy_rollback_plan
cp -a "$HOME/phone-tools" "$MIGRATION_DIR/phone-tools"
rm -rf -- "$MIGRATION_DIR/phone-tools/.cycle.lock" \
  "$MIGRATION_DIR/phone-tools/.scheduler.lock" \
  "$MIGRATION_DIR/phone-tools/.watchdog.lock"
rm -f -- "$MIGRATION_DIR/phone-tools/.watchdog.pid"
fsync_tree "$MIGRATION_DIR/phone-tools"
HOME_SNAPSHOT_SOURCES=()
for name in start-prod.sh start-prod-sub.sh restart-evo.sh deploy-next.sh \
    install-evogent-release.sh; do
  if [ -e "$HOME/$name" ] || [ -L "$HOME/$name" ]; then
    HOME_SNAPSHOT_SOURCES+=("$HOME/$name")
  fi
done
if [ "\${#HOME_SNAPSHOT_SOURCES[@]}" -gt 0 ]; then
  copy_legacy_home_snapshots \
    "$MIGRATION_DIR/home" "\${HOME_SNAPSHOT_SOURCES[@]}"
fi
fsync_tree "$MIGRATION_DIR/home"
finalize_legacy_rollback_plan
printf '%s\\n' "$LEGACY_PLAN_SHA256"
`;
  const rollbackFunctions = [
    'legacy_plan_entry_location',
    'legacy_plan_snapshot_location',
    'legacy_plan_original_type',
    'legacy_plan_generated_marker',
    'remove_exact_generated_symlink',
    'remove_candidate_current_pointer',
    'generated_home_target',
    'remove_generated_home_entry',
    'quarantine_real_directory',
    'generated_directory_owned',
    'quarantine_generated_directory',
    'rename_no_copy',
    'restore_planned_runtime_component',
    'fsync_real_directory_if_present',
    'rollback_initial_namespace_barrier',
    'restore_planned_phone_tools',
    'restore_planned_home_entry',
    'reconcile_planned_home_link_groups',
    'rollback_fresh_initial_install',
    'rollback_initial_migration',
  ].map((name) => shellFunction(installer, name)).join('\n');
  const rollbackHarness = `
set -euo pipefail
${rollbackFunctions}
say() { :; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
fsync_directory() { :; }
cycle_gate_owned_by_current() { [ -d "$1" ]; }
acquire_lock_dir() { mkdir -p "$1"; }
release_lock_dir() { rm -rf -- "$1"; }
HOME="$1"
ROOT="$2"
STATE="$ROOT/state"
PHONE_STATE="$STATE/phone-tools"
CURRENT="$ROOT/current"
MIGRATION_DIR="$ROOT/migrations/legacy-fixture"
RELEASE_ID=release-1
INITIAL_MIGRATION=1
MIGRATION_STARTED=1
LEGACY_RUNTIME_EXPECTED=1
LEGACY_CONTROL_PLANE_EXPECTED=1
LEGACY_EXPECTATION_COMPAT=0
LEGACY_SNAPSHOT_READY=1
LEGACY_PLAN_SHA256="$3"
CYCLE_GATE="$4"
CYCLE_GATE_HELD=1
rollback_initial_migration
printf 'post-first\\n'
printf 'runtime update\\n' >> "$HOME/phone-tools/runtime.log"
if [ ! -e "$HOME/start-prod.sh" ] && [ -f "$HOME/start-prod-sub.sh" ]; then
  ln "$HOME/start-prod-sub.sh" "$HOME/start-prod.sh"
fi
rollback_initial_migration
printf 'post-second\\n'
`;

  for (let forwardStep = 0; forwardStep <= 4; forwardStep += 1) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-v2-retry-'));
    const home = path.join(fixture, 'home');
    const releaseRoot = path.join(home, '.local/share/evogent');
    const state = path.join(releaseRoot, 'state');
    const migrations = path.join(releaseRoot, 'migrations');
    const migration = path.join(migrations, 'legacy-fixture');
    const runtime = path.join(home, 'evogent');
    const data = path.join(runtime, 'data');
    const modules = path.join(runtime, 'node_modules');
    const tools = path.join(home, 'phone-tools');
    fs.mkdirSync(path.join(modules, 'nested'), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(tools, '.cycle.lock'), { recursive: true });
    fs.mkdirSync(path.join(tools, '.scheduler.lock'));
    fs.mkdirSync(path.join(tools, '.watchdog.lock'));
    fs.mkdirSync(path.join(migration, 'home'), { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(path.join(releaseRoot, 'releases/release-1'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'server.js'), 'legacy runtime\n');
    fs.writeFileSync(path.join(data, 'media-agent.db'), 'database bytes\n');
    fs.writeFileSync(path.join(modules, 'nested/package'), 'native tree\n');
    fs.writeFileSync(path.join(runtime, '.env.local'), 'PRIVATE=value\n', {
      mode: 0o600,
    });
    for (const name of [
      'control-plane.sh',
      'evogent-boot.sh',
      'evogent-scheduler.sh',
      'evogent-watchdog.sh',
    ]) {
      fs.writeFileSync(path.join(tools, name), `${name}\n`, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(tools, '.watchdog.pid'), '123\n', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'start-prod-sub.sh'), 'start\n', {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(home, 'restart-evo.sh'), 'restart\n', {
      mode: 0o700,
    });
    fs.symlinkSync('start-prod-sub.sh', path.join(home, 'deploy-next.sh'));

    const originalInodes = {
      data: fs.statSync(data).ino,
      modules: fs.statSync(modules).ino,
      runtime: fs.statSync(runtime).ino,
      tools: fs.statSync(tools).ino,
    };
    const planned = spawnSync(
      'bash',
      ['-c', planHarness, 'plan', home, releaseRoot],
      { encoding: 'utf8' },
    );
    assert.equal(planned.status, 0, planned.stderr);
    const planDigest = planned.stdout.trim();
    assert.match(planDigest, /^[0-9a-f]{64}$/);
    const plan = JSON.parse(
      fs.readFileSync(path.join(migration, 'rollback-plan.json'), 'utf8'),
    );
    assert.equal(plan.snapshotReady, 1);
    assert.equal(plan.snapshots.phoneTools.type, 'directory');
    assert.deepEqual(
      Object.keys(plan.snapshots.phoneTools.controlPrograms).sort(),
      [
        'control-plane.sh',
        'evogent-boot.sh',
        'evogent-scheduler.sh',
        'evogent-watchdog.sh',
      ],
    );
    assert.notEqual(plan.snapshots.phoneTools.ino, originalInodes.tools);
    for (const transient of [
      '.scheduler.lock',
      '.watchdog.lock',
      '.watchdog.pid',
    ]) {
      fs.rmSync(path.join(tools, transient), { recursive: true, force: true });
    }

    if (forwardStep >= 1) {
      fs.renameSync(runtime, path.join(migration, 'evogent'));
    }
    if (forwardStep >= 2) {
      const moved = path.join(migration, 'evogent');
      fs.renameSync(path.join(moved, 'data'), path.join(state, 'data'));
      fs.renameSync(path.join(moved, 'node_modules'), path.join(state, 'node_modules'));
      fs.mkdirSync(path.join(state, 'config'));
      fs.writeFileSync(
        path.join(state, 'config/.evogent-install-owner'),
        `${plan.generatedMarker}\n`,
        { mode: 0o600 },
      );
      fs.renameSync(
        path.join(moved, '.env.local'),
        path.join(state, 'config/.env.local'),
      );
    }
    let gate = path.join(home, 'phone-tools/.cycle.lock');
    if (forwardStep >= 3) {
      fs.renameSync(tools, path.join(state, 'phone-tools'));
      gate = path.join(state, 'phone-tools/.cycle.lock');
    }
    if (forwardStep >= 4) {
      for (const name of [
        'start-prod-sub.sh',
        'restart-evo.sh',
        'deploy-next.sh',
      ]) {
        try {
          fs.unlinkSync(path.join(home, name));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      fs.symlinkSync(
        `${releaseRoot}/current/runtime`,
        path.join(home, 'evogent'),
      );
      fs.symlinkSync(path.join(state, 'phone-tools'), path.join(home, 'phone-tools'));
      fs.symlinkSync(
        `${releaseRoot}/current/device/start-prod.sh`,
        path.join(home, 'start-prod.sh'),
      );
      fs.symlinkSync(
        `${releaseRoot}/current/device/restart-evo.sh`,
        path.join(home, 'restart-evo.sh'),
      );
      fs.symlinkSync(
        `${releaseRoot}/current/phone-tools/deploy-next.sh`,
        path.join(home, 'deploy-next.sh'),
      );
      fs.symlinkSync(
        `${releaseRoot}/current/device/install-release.sh`,
        path.join(home, 'install-evogent-release.sh'),
      );
      fs.symlinkSync('releases/release-1', path.join(releaseRoot, 'current'));
      fs.mkdirSync(path.join(state, 'next-cache/release-1'), { recursive: true });
      fs.writeFileSync(
        path.join(
          state,
          'next-cache/release-1/.evogent-install-owner',
        ),
        `${plan.generatedMarker}\n`,
        { mode: 0o600 },
      );
    }

    const rolledBack = spawnSync(
      'bash',
      ['-c', rollbackHarness, 'rollback', home, releaseRoot, planDigest, gate],
      { encoding: 'utf8' },
    );
    assert.equal(
      rolledBack.status,
      0,
      `forward step ${forwardStep}: ${rolledBack.stderr}`,
    );
    assert.equal(rolledBack.stdout, 'post-first\npost-second\n');
    assert.equal(fs.statSync(path.join(home, 'evogent')).ino, originalInodes.runtime);
    assert.equal(fs.statSync(path.join(home, 'evogent/data')).ino, originalInodes.data);
    assert.equal(
      fs.statSync(path.join(home, 'evogent/node_modules')).ino,
      originalInodes.modules,
    );
    const expectedToolsInode = forwardStep >= 3
      ? plan.snapshots.phoneTools.ino
      : originalInodes.tools;
    assert.equal(fs.statSync(path.join(home, 'phone-tools')).ino, expectedToolsInode);
    assert.equal(fs.existsSync(path.join(home, 'start-prod.sh')), false);
    assert.equal(fs.existsSync(path.join(releaseRoot, 'current')), false);
    if (forwardStep >= 3) {
      assert.equal(
        fs.statSync(path.join(migration, 'rolled-back-phone-state')).ino,
        originalInodes.tools,
      );
    }
  }
});

test('initial recovery selects only the exact planned phone-tools gate topology', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const selectGate = shellFunction(installer, 'select_recovery_cycle_gate');
  const harness = `
set -euo pipefail
${selectGate}
HOME="$1"; ROOT="$2"; STATE="$ROOT/state"; PHONE_STATE="$STATE/phone-tools"
MIGRATION_DIR="$3"; TRANSACTION_DIR="$ROOT/install-transaction"
INITIAL_MIGRATION=1; LEGACY_EXPECTATION_COMPAT=0
LEGACY_RUNTIME_EXPECTED="$4"; LEGACY_SNAPSHOT_READY="$5"
MIGRATION_STARTED="$6"; CYCLE_GATE="$7"
select_recovery_cycle_gate
printf '%s\\n' "$CYCLE_GATE"
`;

  const absent = () => ({ type: 'absent' });
  const metadata = (target) => {
    const value = fs.lstatSync(target);
    return {
      dev: value.dev,
      ino: value.ino,
      mode: value.mode & 0o7777,
      type: value.isDirectory() ? 'directory' : 'regular',
      uid: value.uid,
    };
  };
  const entryNames = [
    'runtime',
    'data',
    'nodeModules',
    'environment',
    'phoneTools',
    'home:start-prod-sub.sh',
    'home:start-prod.sh',
    'home:restart-evo.sh',
    'home:deploy-next.sh',
    'home:install-evogent-release.sh',
  ];
  const snapshotNames = [
    'phoneTools',
    'home:start-prod-sub.sh',
    'home:start-prod.sh',
    'home:restart-evo.sh',
    'home:deploy-next.sh',
    'home:install-evogent-release.sh',
  ];

  function makeFixture({ runtimeExpected = 1, snapshotReady = 1 } = {}) {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), 'evogent-recovery-tools-gate-'),
    );
    const home = path.join(fixture, 'home');
    const releaseRoot = path.join(home, '.local/share/evogent');
    const state = path.join(releaseRoot, 'state');
    const migration = path.join(releaseRoot, 'migrations/legacy-fixture');
    const transaction = path.join(releaseRoot, 'install-transaction');
    const objects = path.join(fixture, 'objects');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(migration, { recursive: true });
    fs.mkdirSync(transaction, { recursive: true });
    fs.mkdirSync(objects);
    const originalSource = path.join(objects, 'original');
    const snapshotSource = path.join(objects, 'snapshot');
    if (runtimeExpected === 1) {
      fs.mkdirSync(originalSource);
      if (snapshotReady === 1) fs.mkdirSync(snapshotSource);
    }
    const original = runtimeExpected === 1
      ? metadata(originalSource)
      : absent();
    const snapshot = runtimeExpected === 1 && snapshotReady === 1
      ? metadata(snapshotSource)
      : absent();
    const entries = Object.fromEntries(entryNames.map((name) => [name, absent()]));
    entries.phoneTools = original;
    const snapshots = snapshotReady === 1
      ? Object.fromEntries(snapshotNames.map((name) => [name, absent()]))
      : {};
    if (snapshotReady === 1) snapshots.phoneTools = snapshot;
    const plan = {
      entries,
      generatedMarker: 'a'.repeat(64),
      home,
      legacyControlPlaneExpected: 0,
      legacyRuntimeExpected: runtimeExpected,
      migrationDir: migration,
      phoneState: path.join(state, 'phone-tools'),
      rearmProgram: runtimeExpected === 1 ? 'start-prod.sh' : '',
      releaseId: 'release-1',
      root: releaseRoot,
      schema: 'evogent.phone.legacy-rollback-plan.v1',
      snapshotReady,
      snapshots,
      state,
    };
    const planPath = path.join(migration, 'rollback-plan.json');
    fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
    fs.chmodSync(planPath, 0o600);
    return {
      fixture,
      home,
      releaseRoot,
      state,
      migration,
      transaction,
      originalSource,
      snapshotSource,
      homeTools: path.join(home, 'phone-tools'),
      stateTools: path.join(state, 'phone-tools'),
      snapshotTools: path.join(migration, 'phone-tools'),
      quarantineTools: path.join(migration, 'rolled-back-phone-state'),
      marker: plan.generatedMarker,
      runtimeExpected,
      snapshotReady,
    };
  }

  function place(directory, source, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    return directory;
  }

  function generatedDirectory(target, marker) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.chmodSync(target, 0o700);
    fs.writeFileSync(
      path.join(target, '.evogent-install-owner'),
      `${marker}\n`,
      { mode: 0o600 },
    );
  }

  function emptyPrivateDirectory(target) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.chmodSync(target, 0o700);
  }

  function run(fixture, {
    journalGate = path.join(fixture.stateTools, '.cycle.lock'),
    migrationStarted = fixture.snapshotReady,
  } = {}) {
    return spawnSync(
      'bash',
      [
        '-c',
        harness,
        'gate',
        fixture.home,
        fixture.releaseRoot,
        fixture.migration,
        String(fixture.runtimeExpected),
        String(fixture.snapshotReady),
        String(migrationStarted),
        journalGate,
      ],
      { encoding: 'utf8' },
    );
  }

  const legacyCases = [
    {
      name: 'pre-move original at HOME',
      original: 'homeTools',
      snapshot: 'snapshotTools',
      expected: 'homeTools',
    },
    {
      name: 'post-move original at state with generated HOME link',
      original: 'stateTools',
      snapshot: 'snapshotTools',
      homeLink: true,
      expected: 'stateTools',
    },
    {
      name: 'rollback midpoint snapshot at HOME and original at state',
      original: 'stateTools',
      snapshot: 'homeTools',
      expected: 'homeTools',
    },
    {
      name: 'rolled back snapshot at HOME and original in quarantine',
      original: 'quarantineTools',
      snapshot: 'homeTools',
      expected: 'homeTools',
    },
    {
      name: 'rolled back with exact empty recovery state parent',
      original: 'quarantineTools',
      snapshot: 'homeTools',
      emptyState: true,
      expected: 'homeTools',
    },
  ];
  for (const scenario of legacyCases) {
    const fixture = makeFixture();
    place(fixture, fixture.originalSource, fixture[scenario.original]);
    place(fixture, fixture.snapshotSource, fixture[scenario.snapshot]);
    if (scenario.homeLink) {
      fs.symlinkSync(fixture.stateTools, fixture.homeTools);
    }
    if (scenario.emptyState) emptyPrivateDirectory(fixture.stateTools);
    const result = run(fixture);
    assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      path.join(fixture[scenario.expected], '.cycle.lock'),
      scenario.name,
    );
  }

  const preSnapshot = makeFixture({ snapshotReady: 0 });
  place(preSnapshot, preSnapshot.originalSource, preSnapshot.homeTools);
  let result = run(preSnapshot, {
    journalGate: path.join(preSnapshot.homeTools, '.cycle.lock'),
    migrationStarted: 0,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    path.join(preSnapshot.homeTools, '.cycle.lock'),
  );

  for (const scenario of [
    {
      name: 'arbitrary real HOME cannot shadow exact state',
      setup(fixture) {
        place(fixture, fixture.originalSource, fixture.stateTools);
        place(fixture, fixture.snapshotSource, fixture.snapshotTools);
        fs.mkdirSync(fixture.homeTools);
      },
    },
    {
      name: 'arbitrary HOME symlink cannot shadow exact state',
      setup(fixture) {
        place(fixture, fixture.originalSource, fixture.stateTools);
        place(fixture, fixture.snapshotSource, fixture.snapshotTools);
        fs.symlinkSync(fixture.fixture, fixture.homeTools);
      },
    },
    {
      name: 'missing planned original fails closed',
      setup(fixture) {
        place(fixture, fixture.snapshotSource, fixture.snapshotTools);
      },
    },
    {
      name: 'missing planned snapshot fails closed',
      setup(fixture) {
        place(fixture, fixture.originalSource, fixture.homeTools);
      },
    },
    {
      name: 'swapped dual parents fail closed',
      setup(fixture) {
        place(fixture, fixture.originalSource, fixture.homeTools);
        place(fixture, fixture.snapshotSource, fixture.stateTools);
      },
    },
    {
      name: 'unplanned state beside pre-move HOME fails closed',
      setup(fixture) {
        place(fixture, fixture.originalSource, fixture.homeTools);
        place(fixture, fixture.snapshotSource, fixture.snapshotTools);
        emptyPrivateDirectory(fixture.stateTools);
      },
    },
    {
      name: 'nonempty recovery state beside restored HOME fails closed',
      setup(fixture) {
        place(fixture, fixture.originalSource, fixture.quarantineTools);
        place(fixture, fixture.snapshotSource, fixture.homeTools);
        emptyPrivateDirectory(fixture.stateTools);
        fs.writeFileSync(path.join(fixture.stateTools, 'unexpected'), 'data\n');
      },
    },
    {
      name: 'unstarted migration cannot admit moved planned identities',
      setup(fixture) {
        place(fixture, fixture.originalSource, fixture.stateTools);
        place(fixture, fixture.snapshotSource, fixture.snapshotTools);
        fs.symlinkSync(fixture.stateTools, fixture.homeTools);
      },
      runOptions: { migrationStarted: 0 },
    },
  ]) {
    const fixture = makeFixture();
    scenario.setup(fixture);
    result = run(fixture, scenario.runOptions);
    assert.notEqual(result.status, 0, scenario.name);
  }

  const freshInitial = makeFixture({ runtimeExpected: 0 });
  result = run(freshInitial, {
    journalGate: path.join(freshInitial.transaction, 'initial-cycle.lock'),
    migrationStarted: 0,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    path.join(freshInitial.transaction, 'initial-cycle.lock'),
  );

  const freshActive = makeFixture({ runtimeExpected: 0 });
  generatedDirectory(freshActive.stateTools, freshActive.marker);
  fs.symlinkSync(freshActive.stateTools, freshActive.homeTools);
  result = run(freshActive);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    path.join(freshActive.stateTools, '.cycle.lock'),
  );

  const freshRolledBack = makeFixture({ runtimeExpected: 0 });
  generatedDirectory(freshRolledBack.quarantineTools, freshRolledBack.marker);
  emptyPrivateDirectory(freshRolledBack.stateTools);
  result = run(freshRolledBack);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    path.join(freshRolledBack.transaction, 'recovery-cycle.lock'),
  );

  for (const scenario of [
    {
      name: 'fresh state symlink fails closed',
      setup(fixture) {
        fs.symlinkSync(fixture.fixture, fixture.stateTools);
      },
    },
    {
      name: 'fresh state journal with missing parent fails closed',
      setup() {},
    },
    {
      name: 'fresh generated dual parents fail closed',
      setup(fixture) {
        generatedDirectory(fixture.stateTools, fixture.marker);
        generatedDirectory(fixture.quarantineTools, fixture.marker);
      },
    },
    {
      name: 'unstarted fresh migration cannot admit generated state',
      setup(fixture) {
        generatedDirectory(fixture.stateTools, fixture.marker);
      },
      runOptions: { migrationStarted: 0 },
    },
  ]) {
    const fixture = makeFixture({ runtimeExpected: 0 });
    scenario.setup(fixture);
    result = run(fixture, scenario.runOptions);
    assert.notEqual(result.status, 0, scenario.name);
  }
});

test('rolled-back recovery retires only an exact empty generated phone-state parent', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const removeParent = shellFunction(
    installer,
    'remove_exact_empty_recovery_phone_state_parent',
  );
  const retire = shellFunction(
    installer,
    'retire_rolled_back_transaction_journal',
  );
  assert.match(removeParent, /os\.rmdir\("phone-tools", dir_fd=parent\)/);
  assert.match(removeParent, /os\.fsync\(parent\)/);
  assert.ok(
    retire.indexOf('remove_exact_empty_recovery_phone_state_parent')
      < retire.indexOf('clear_transaction_journal'),
  );

  const absent = () => ({ type: 'absent' });
  const metadata = (target) => {
    const value = fs.lstatSync(target);
    return {
      dev: value.dev,
      ino: value.ino,
      mode: value.mode & 0o7777,
      type: 'directory',
      uid: value.uid,
    };
  };
  const entryNames = [
    'runtime',
    'data',
    'nodeModules',
    'environment',
    'phoneTools',
    'home:start-prod-sub.sh',
    'home:start-prod.sh',
    'home:restart-evo.sh',
    'home:deploy-next.sh',
    'home:install-evogent-release.sh',
  ];
  const snapshotNames = [
    'phoneTools',
    'home:start-prod-sub.sh',
    'home:start-prod.sh',
    'home:restart-evo.sh',
    'home:deploy-next.sh',
    'home:install-evogent-release.sh',
  ];

  function makeFixture({ fresh = false } = {}) {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), 'evogent-recovery-state-retire-'),
    );
    const home = path.join(fixture, 'home');
    const releaseRoot = path.join(home, '.local/share/evogent');
    const state = path.join(releaseRoot, 'state');
    const migration = path.join(releaseRoot, 'migrations/legacy-fixture');
    const phoneState = path.join(state, 'phone-tools');
    const homeTools = path.join(home, 'phone-tools');
    const snapshotTools = path.join(migration, 'phone-tools');
    const quarantineTools = path.join(migration, 'rolled-back-phone-state');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(migration, { recursive: true });
    let original = absent();
    let snapshot = absent();
    if (fresh) {
      fs.mkdirSync(quarantineTools);
      fs.writeFileSync(
        path.join(quarantineTools, '.evogent-install-owner'),
        `${'b'.repeat(64)}\n`,
        { mode: 0o600 },
      );
    } else {
      fs.mkdirSync(homeTools);
      fs.mkdirSync(quarantineTools);
      snapshot = metadata(homeTools);
      original = metadata(quarantineTools);
    }
    fs.mkdirSync(phoneState, { mode: 0o700 });
    fs.chmodSync(phoneState, 0o700);
    const entries = Object.fromEntries(entryNames.map((name) => [name, absent()]));
    entries.phoneTools = original;
    const snapshots = Object.fromEntries(
      snapshotNames.map((name) => [name, absent()]),
    );
    snapshots.phoneTools = snapshot;
    const plan = {
      entries,
      generatedMarker: 'b'.repeat(64),
      home,
      legacyControlPlaneExpected: 0,
      legacyRuntimeExpected: fresh ? 0 : 1,
      migrationDir: migration,
      phoneState,
      rearmProgram: fresh ? '' : 'start-prod.sh',
      releaseId: 'release-1',
      root: releaseRoot,
      schema: 'evogent.phone.legacy-rollback-plan.v1',
      snapshotReady: 1,
      snapshots,
      state,
    };
    const planPath = path.join(migration, 'rollback-plan.json');
    fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
    fs.chmodSync(planPath, 0o600);
    return {
      fixture,
      home,
      releaseRoot,
      state,
      migration,
      phoneState,
      homeTools,
      snapshotTools,
      quarantineTools,
      fresh,
    };
  }

  const harness = `
set -euo pipefail
${removeParent}
HOME="$1"; ROOT="$2"; STATE="$ROOT/state"; PHONE_STATE="$STATE/phone-tools"
MIGRATION_DIR="$3"; LEGACY_RUNTIME_EXPECTED="$4"
LEGACY_SNAPSHOT_READY=1; LEGACY_EXPECTATION_COMPAT=0
INITIAL_MIGRATION=1; RECOVERY_ACTIVE="$5"
remove_exact_empty_recovery_phone_state_parent
`;
  function run(fixture, recoveryActive = 1) {
    return spawnSync(
      'bash',
      [
        '-c',
        harness,
        'retire-parent',
        fixture.home,
        fixture.releaseRoot,
        fixture.migration,
        fixture.fresh ? '0' : '1',
        String(recoveryActive),
      ],
      { encoding: 'utf8' },
    );
  }

  let fixture = makeFixture();
  let result = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(fixture.phoneState), false);

  fixture = makeFixture({ fresh: true });
  result = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(fixture.phoneState), false);
  assert.equal(fs.existsSync(fixture.quarantineTools), true);

  fixture = makeFixture();
  fs.writeFileSync(path.join(fixture.phoneState, 'private-state'), 'keep\n');
  result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.equal(
    fs.readFileSync(path.join(fixture.phoneState, 'private-state'), 'utf8'),
    'keep\n',
  );

  fixture = makeFixture();
  fs.rmSync(fixture.phoneState, { recursive: true });
  fs.symlinkSync(fixture.fixture, fixture.phoneState);
  result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.equal(fs.lstatSync(fixture.phoneState).isSymbolicLink(), true);

  fixture = makeFixture();
  fs.renameSync(fixture.homeTools, fixture.snapshotTools);
  fs.mkdirSync(fixture.homeTools);
  result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(fixture.phoneState), true);

  fixture = makeFixture();
  result = run(fixture, 0);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(fixture.phoneState), true);

  const retireHarness = `
set -euo pipefail
${retire}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
remove_exact_empty_recovery_phone_state_parent() {
  record cleanup
  return "$CLEANUP_RESULT"
}
clear_transaction_journal() { record clear; }
TRANSACTION_PHASE=rolled_back
ROLLBACK_DECISION_DURABLE=1
COMMITTED=0
TRACE="$1"
retire_rolled_back_transaction_journal
printf 'committed=%s\\n' "$COMMITTED"
`;
  const trace = path.join(os.tmpdir(), `evogent-retire-trace-${process.pid}`);
  fs.rmSync(trace, { force: true });
  result = spawnSync('bash', ['-c', retireHarness, 'retire', trace], {
    encoding: 'utf8',
    env: { ...process.env, CLEANUP_RESULT: '1' },
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'cleanup\n');

  fs.rmSync(trace, { force: true });
  result = spawnSync('bash', ['-c', retireHarness, 'retire', trace], {
    encoding: 'utf8',
    env: { ...process.env, CLEANUP_RESULT: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'cleanup\nclear\n');
  assert.match(result.stdout, /committed=1/);
});

test('legacy HOME hard-link topology fails closed before snapshot mutation', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-home-links-'));
  const home = path.join(fixture, 'home');
  const snapshotHome = path.join(fixture, 'snapshot');
  fs.mkdirSync(home);
  fs.mkdirSync(snapshotHome, { recursive: true });

  const primary = path.join(home, 'start-prod-sub.sh');
  const sibling = path.join(home, 'restart-evo.sh');
  fs.writeFileSync(primary, 'legacy start\n', { mode: 0o700 });
  fs.linkSync(primary, sibling);

  const copySnapshots = shellFunction(
    installer,
    'copy_legacy_home_snapshots',
  );
  const rejected = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${copySnapshots}
copy_legacy_home_snapshots "$1" "$2" "$3"
`,
      'reject-hard-links',
      snapshotHome,
      primary,
      sibling,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /legacy HOME hard-link topology cannot be preserved on Android/,
  );
  assert.deepEqual(fs.readdirSync(snapshotHome), []);
  assert.equal(fs.readFileSync(primary, 'utf8'), 'legacy start\n');
  assert.equal(fs.statSync(primary).ino, fs.statSync(sibling).ino);
  assert.match(
    shellFunction(installer, 'prepare_legacy_rollback_plan'),
    /legacy hard-link topology cannot be preserved on Android/,
  );
  assert.match(
    shellFunction(installer, 'reconcile_planned_home_link_groups'),
    /legacy HOME hard-link topology cannot be recovered on Android/,
  );
});

test('v2 fresh-install rollback never invents a legacy control plane', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-v2-fresh-'));
  const home = path.join(fixture, 'home');
  const releaseRoot = path.join(home, '.local/share/evogent');
  const state = path.join(releaseRoot, 'state');
  const migration = path.join(releaseRoot, 'migrations/legacy-fixture');
  fs.mkdirSync(path.join(migration, 'home'), { recursive: true });
  fs.mkdirSync(path.join(releaseRoot, 'releases/release-1'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const prepare = `
set -euo pipefail
${shellFunction(installer, 'prepare_legacy_rollback_plan')}
${shellFunction(installer, 'finalize_legacy_rollback_plan')}
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
HOME="$1"; ROOT="$2"; STATE="$ROOT/state"; PHONE_STATE="$STATE/phone-tools"
MIGRATION_DIR="$ROOT/migrations/legacy-fixture"; RELEASE_ID=release-1
LEGACY_RUNTIME_EXPECTED=0; LEGACY_CONTROL_PLANE_EXPECTED=0
LEGACY_SNAPSHOT_READY=0; LEGACY_PLAN_SHA256=""
prepare_legacy_rollback_plan
finalize_legacy_rollback_plan
printf '%s\\n' "$LEGACY_PLAN_SHA256"
`;
  const planned = spawnSync('bash', ['-c', prepare, 'plan', home, releaseRoot], {
    encoding: 'utf8',
  });
  assert.equal(planned.status, 0, planned.stderr);
  const planDigest = planned.stdout.trim();
  const freshPlan = JSON.parse(
    fs.readFileSync(path.join(migration, 'rollback-plan.json'), 'utf8'),
  );

  fs.mkdirSync(path.join(state, 'data'), { recursive: true });
  fs.mkdirSync(path.join(state, 'config'));
  fs.mkdirSync(path.join(state, 'next-cache/release-1'), { recursive: true });
  fs.mkdirSync(path.join(state, 'phone-tools/.cycle.lock'), { recursive: true });
  fs.writeFileSync(path.join(state, 'data/generated'), 'candidate state\n');
  for (const directory of [
    path.join(state, 'data'),
    path.join(state, 'config'),
    path.join(state, 'next-cache/release-1'),
    path.join(state, 'phone-tools'),
  ]) {
    fs.writeFileSync(
      path.join(directory, '.evogent-install-owner'),
      `${freshPlan.generatedMarker}\n`,
      { mode: 0o600 },
    );
  }
  fs.symlinkSync(`${releaseRoot}/current/runtime`, path.join(home, 'evogent'));
  fs.symlinkSync(path.join(state, 'phone-tools'), path.join(home, 'phone-tools'));
  for (const [name, target] of [
    ['start-prod.sh', `${releaseRoot}/current/device/start-prod.sh`],
    ['restart-evo.sh', `${releaseRoot}/current/device/restart-evo.sh`],
    ['deploy-next.sh', `${releaseRoot}/current/phone-tools/deploy-next.sh`],
    [
      'install-evogent-release.sh',
      `${releaseRoot}/current/device/install-release.sh`,
    ],
  ]) {
    fs.symlinkSync(target, path.join(home, name));
  }
  fs.symlinkSync('releases/release-1', path.join(releaseRoot, 'current'));

  const functions = [
    'legacy_plan_entry_location',
    'legacy_plan_snapshot_location',
    'legacy_plan_original_type',
    'legacy_plan_generated_marker',
    'remove_exact_generated_symlink',
    'remove_candidate_current_pointer',
    'generated_home_target',
    'remove_generated_home_entry',
    'quarantine_real_directory',
    'generated_directory_owned',
    'quarantine_generated_directory',
    'rename_no_copy',
    'restore_planned_runtime_component',
    'fsync_real_directory_if_present',
    'rollback_initial_namespace_barrier',
    'restore_planned_phone_tools',
    'restore_planned_home_entry',
    'rollback_fresh_initial_install',
    'rollback_initial_migration',
  ].map((name) => shellFunction(installer, name)).join('\n');
  const rollback = `
set -euo pipefail
${functions}
say() { :; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
fsync_directory() { :; }
cycle_gate_owned_by_current() { [ -d "$1" ]; }
acquire_lock_dir() { mkdir -p "$1"; }
release_lock_dir() { rm -rf -- "$1"; }
HOME="$1"; ROOT="$2"; STATE="$ROOT/state"; PHONE_STATE="$STATE/phone-tools"
CURRENT="$ROOT/current"; MIGRATION_DIR="$ROOT/migrations/legacy-fixture"
RELEASE_ID=release-1; INITIAL_MIGRATION=1; MIGRATION_STARTED=1
LEGACY_RUNTIME_EXPECTED=0; LEGACY_CONTROL_PLANE_EXPECTED=0
LEGACY_EXPECTATION_COMPAT=0; LEGACY_SNAPSHOT_READY=1
LEGACY_PLAN_SHA256="$3"; CYCLE_GATE="$PHONE_STATE/.cycle.lock"; CYCLE_GATE_HELD=1
rollback_initial_migration
rollback_initial_migration
`;
  const result = spawnSync(
    'bash',
    ['-c', rollback, 'rollback', home, releaseRoot, planDigest],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  for (const name of [
    'evogent',
    'phone-tools',
    'start-prod.sh',
    'start-prod-sub.sh',
    'restart-evo.sh',
    'deploy-next.sh',
    'install-evogent-release.sh',
  ]) {
    assert.equal(fs.existsSync(path.join(home, name)), false);
    assert.throws(
      () => fs.lstatSync(path.join(home, name)),
      (error) => error?.code === 'ENOENT',
    );
  }
  assert.equal(fs.existsSync(path.join(releaseRoot, 'current')), false);
  assert.equal(
    fs.readFileSync(path.join(migration, 'rolled-back-state-data/generated'), 'utf8'),
    'candidate state\n',
  );
  assert.equal(
    fs.existsSync(path.join(migration, 'rolled-back-phone-state')),
    true,
  );
});

test('scheduler and watchdog recovery proofs bind exact owners and programs', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const safeProgram = shellFunction(installer, 'safe_private_program');
  const scheduler = shellFunction(installer, 'scheduler_owner_live');
  const watchdog = shellFunction(installer, 'watchdog_owner_live');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-owner-proof-'));
  const home = path.join(fixture, 'home');
  const tools = path.join(home, 'phone-tools');
  const schedulerLock = path.join(tools, '.scheduler.lock');
  const watchdogLock = path.join(tools, '.watchdog.lock');
  const watchdogPid = path.join(tools, '.watchdog.pid');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(watchdogPid, '456\n', { mode: 0o600 });
  const harness = `
set -uo pipefail
${safeProgram}
${scheduler}
${watchdog}
single_tmux_pane_pid() {
  [ "$1" = evo-sched ] || return 1
  printf '%s\\n' "$PANE_PID"
}
process_has_exact_script() {
  case "$MODE:$2" in
    scheduler:"$HOME/phone-tools/evogent-scheduler.sh") ;;
    watchdog:"$HOME/phone-tools/evogent-watchdog.sh") ;;
    *) return 1 ;;
  esac
  return "$SCRIPT_RESULT"
}
legacy_wrapped_scheduler_fingerprint() {
  [ "$WRAPPER_RESULT" = 0 ] || return "$WRAPPER_RESULT"
  printf '%s\\n' "$WRAPPER_FINGERPRINT"
}
meta_field() {
  case "$2" in
    pid) printf '%s\\n' "$OWNER_PID" ;;
    start) printf '%s\\n' "$OWNER_START" ;;
    label) printf '%s\\n' "$OWNER_LABEL" ;;
    *) return 1 ;;
  esac
}
pid_matches() {
  [ "$1" = "$OWNER_PID" ] && [ "$2" = "$OWNER_START" ] \
    && return "$PID_RESULT"
  return 1
}
kill() { return "$KILL_RESULT"; }
HOME="$1"
case "$MODE" in
  scheduler) scheduler_owner_live "\${SCHEDULER_RELEASE_TARGET:-}" ;;
  watchdog) watchdog_owner_live ;;
  *) exit 64 ;;
esac
`;
  function clearLock(directory) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  function writeOwner(directory) {
    clearLock(directory);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'owner'), 'fixture\n', {
      mode: 0o600,
    });
  }
  function prove(mode, overrides = {}) {
    return spawnSync('bash', ['-c', harness, 'proof', home], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KILL_RESULT: '0',
        MODE: mode,
        OWNER_LABEL: mode,
        OWNER_PID: mode === 'scheduler' ? '123' : '456',
        OWNER_START: '789',
        PANE_PID: '123',
        PID_RESULT: '0',
        SCRIPT_RESULT: '0',
        WRAPPER_FINGERPRINT: '456:789',
        WRAPPER_RESULT: '1',
        ...overrides,
      },
    });
  }

  clearLock(schedulerLock);
  assert.equal(prove('scheduler').status, 0);
  assert.equal(
    prove('scheduler', {
      OWNER_PID: '456',
      SCRIPT_RESULT: '1',
      WRAPPER_RESULT: '0',
    }).status,
    0,
  );
  assert.notEqual(
    prove('scheduler', {
      SCHEDULER_RELEASE_TARGET: '/release',
      OWNER_PID: '456',
      SCRIPT_RESULT: '1',
      WRAPPER_RESULT: '0',
    }).status,
    0,
  );
  assert.notEqual(
    prove('scheduler', {
      OWNER_PID: '456',
      SCRIPT_RESULT: '1',
      WRAPPER_FINGERPRINT: '456',
      WRAPPER_RESULT: '0',
    }).status,
    0,
  );
  assert.notEqual(
    prove('scheduler', {
      OWNER_PID: '456',
      SCRIPT_RESULT: '1',
      WRAPPER_FINGERPRINT: '456:790',
      WRAPPER_RESULT: '0',
    }).status,
    0,
  );
  assert.notEqual(prove('scheduler', { SCRIPT_RESULT: '1' }).status, 0);
  writeOwner(schedulerLock);
  assert.equal(prove('scheduler').status, 0);
  assert.equal(
    prove('scheduler', {
      OWNER_PID: '456',
      SCRIPT_RESULT: '1',
      WRAPPER_RESULT: '0',
    }).status,
    0,
  );
  assert.notEqual(
    prove('scheduler', { OWNER_LABEL: 'watchdog' }).status,
    0,
  );
  assert.notEqual(prove('scheduler', { OWNER_PID: '999' }).status, 0);
  assert.notEqual(prove('scheduler', { PID_RESULT: '1' }).status, 0);

  clearLock(watchdogLock);
  assert.equal(prove('watchdog').status, 0);
  assert.notEqual(prove('watchdog', { SCRIPT_RESULT: '1' }).status, 0);
  assert.notEqual(prove('watchdog', { KILL_RESULT: '1' }).status, 0);
  writeOwner(watchdogLock);
  assert.equal(prove('watchdog').status, 0);
  assert.notEqual(
    prove('watchdog', { OWNER_LABEL: 'scheduler' }).status,
    0,
  );
  assert.notEqual(prove('watchdog', { PID_RESULT: '1' }).status, 0);
});

test('legacy scheduler wrapper proof binds one exact direct child', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(
    installer,
    'legacy_wrapped_scheduler_fingerprint',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-legacy-scheduler-'));
  const proc = path.join(fixture, 'proc');
  const scheduler = path.join(fixture, 'home/phone-tools/evogent-scheduler.sh');
  const log = path.join(fixture, 'home/evo-sched.log');
  const trustedBash = fs.realpathSync('/bin/bash');
  fs.mkdirSync(path.dirname(scheduler), { recursive: true });
  fs.writeFileSync(scheduler, '#!/bin/bash\n', { mode: 0o700 });

  function writeProcess(
    pid,
    parent,
    args,
    start = pid * 10,
    executable = trustedBash,
  ) {
    const directory = path.join(proc, String(pid));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'cmdline'),
      `${args.join('\0')}\0`,
    );
    fs.writeFileSync(
      path.join(directory, 'stat'),
      `${pid} (bash) ${[
        'S',
        String(parent),
        ...Array(17).fill('0'),
        String(start),
        '0',
      ].join(' ')}\n`,
    );
    fs.rmSync(path.join(directory, 'exe'), { force: true });
    fs.symlinkSync(executable, path.join(directory, 'exe'));
  }
  writeProcess(999, 1, ['bash'], 9990);
  writeProcess(
    123,
    1,
    ['bash', '-c', `bash ${scheduler} >> ${log} 2>&1`],
  );
  writeProcess(456, 123, ['bash', scheduler]);

  const harness = `
set -u
${helper}
legacy_wrapped_scheduler_fingerprint 123 "$1" "$2" "$3" "$4" 999
`;
  function prove() {
    return spawnSync(
      'bash',
      ['-c', harness, 'legacy-scheduler', scheduler, log, proc, trustedBash],
      { encoding: 'utf8' },
    );
  }
  let result = prove();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '456:4560\n');

  writeProcess(789, 1, ['bash', scheduler]);
  result = prove();
  assert.notEqual(result.status, 0);
  fs.rmSync(path.join(proc, '789'), { force: true, recursive: true });

  writeProcess(123, 1, ['bash', '-c', `bash ${scheduler} > ${log} 2>&1`]);
  result = prove();
  assert.notEqual(result.status, 0);

  writeProcess(999, 1, ['bash'], 9990, '/usr/bin/true');
  result = prove();
  assert.notEqual(result.status, 0);

  writeProcess(999, 1, ['bash'], 9990);
  writeProcess(
    123,
    1,
    ['bash', '-c', `bash ${scheduler} >> ${log} 2>&1`],
  );
  writeProcess(456, 123, ['bash', scheduler], 4560, '/usr/bin/true');
  result = prove();
  assert.notEqual(result.status, 0);

  writeProcess(456, 123, ['bash', scheduler]);
  writeProcess(
    123,
    1,
    ['bash', '-c', `bash ${scheduler} >> ${log} 2>&1`],
    1230,
    '/usr/bin/true',
  );
  result = prove();
  assert.notEqual(result.status, 0);

  writeProcess(
    123,
    1,
    ['bash', '-c', `bash ${scheduler} >> ${log} 2>&1`],
  );
  const paneStat = `123 (bash) ${[
    'S',
    '1',
    ...Array(17).fill('0'),
    '1230',
    '0',
  ].join(' ')}`;
  const changedPaneStat = paneStat.replace('1230', '1231');
  const childStat = `456 (bash) ${[
    'S',
    '123',
    ...Array(17).fill('0'),
    '4560',
    '0',
  ].join(' ')}`;
  const changedChildStat = childStat.replace('4560', '4561');
  const raceHarness = `
set -u
${helper}
feed_two() {
  exec 3> "$1.first"
  printf '%s\\n' "$2" >&3
  mv -f "$1.next" "$1"
  exec 3>&-
  printf '%s\\n' "$3" > "$1.second"
}
feed_two "$3/123/stat" "$PANE_STAT" "$CHANGED_PANE_STAT" &
pane_writer=$!
feed_two "$3/456/stat" "$CHILD_STAT" "$CHANGED_CHILD_STAT" &
child_writer=$!
set +e
legacy_wrapped_scheduler_fingerprint 123 "$1" "$2" "$3" "$4" 999
status=$?
kill "$pane_writer" "$child_writer" 2>/dev/null || true
wait "$pane_writer" "$child_writer" 2>/dev/null || true
exit "$status"
`;
  function proveIdentityMutation(secondPaneStat, secondChildStat) {
    for (const pid of [123, 456]) {
      const statPath = path.join(proc, String(pid), 'stat');
      for (const suffix of ['', '.first', '.second', '.next']) {
        fs.rmSync(`${statPath}${suffix}`, { force: true });
      }
      const made = spawnSync(
        'mkfifo',
        [`${statPath}.first`, `${statPath}.second`],
        { encoding: 'utf8' },
      );
      assert.equal(made.status, 0, made.stderr);
      fs.symlinkSync('stat.first', statPath);
      fs.symlinkSync('stat.second', `${statPath}.next`);
    }
    const mutationResult = spawnSync(
      'bash',
      [
        '-c',
        raceHarness,
        'legacy-scheduler-race',
        scheduler,
        log,
        proc,
        trustedBash,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          CHILD_STAT: childStat,
          CHANGED_CHILD_STAT: secondChildStat,
          PANE_STAT: paneStat,
          CHANGED_PANE_STAT: secondPaneStat,
        },
      },
    );
    assert.equal(mutationResult.error, undefined);
    return mutationResult;
  }

  result = proveIdentityMutation(paneStat, changedChildStat);
  assert.notEqual(result.status, 0);
  result = proveIdentityMutation(changedPaneStat, childStat);
  assert.notEqual(result.status, 0);
});

test('release dispatch proof covers every artifact and rejects stale or direct links', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-dispatch-'));
  const home = path.join(fixture, 'home');
  const releaseRoot = path.join(home, '.local/share/evogent');
  const target = path.join(releaseRoot, 'releases/release-1');
  const phoneState = path.join(releaseRoot, 'state/phone-tools');
  const current = path.join(releaseRoot, 'current');
  fs.mkdirSync(path.join(target, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(target, 'phone-tools/tests'), { recursive: true });
  fs.mkdirSync(path.join(target, 'device'), { recursive: true });
  fs.mkdirSync(phoneState, { recursive: true });
  fs.writeFileSync(path.join(target, 'phone-tools/helper.py'), 'pass\n');
  fs.writeFileSync(path.join(target, 'phone-tools/deploy-next.sh'), ':\n');
  for (const name of [
    'start-prod.sh',
    'restart-evo.sh',
    'install-release.sh',
  ]) {
    fs.writeFileSync(path.join(target, 'device', name), ':\n');
  }
  fs.symlinkSync('releases/release-1', current);
  fs.symlinkSync(`${releaseRoot}/current/runtime`, path.join(home, 'evogent'));
  fs.symlinkSync(phoneState, path.join(home, 'phone-tools'));
  const homeLinks = {
    'start-prod.sh': `${releaseRoot}/current/device/start-prod.sh`,
    'restart-evo.sh': `${releaseRoot}/current/device/restart-evo.sh`,
    'deploy-next.sh': `${releaseRoot}/current/phone-tools/deploy-next.sh`,
    'install-evogent-release.sh':
      `${releaseRoot}/current/device/install-release.sh`,
  };
  for (const [name, destination] of Object.entries(homeLinks)) {
    fs.symlinkSync(destination, path.join(home, name));
  }
  for (const name of ['helper.py', 'deploy-next.sh', 'tests']) {
    fs.symlinkSync(
      `${releaseRoot}/current/phone-tools/${name}`,
      path.join(phoneState, name),
    );
  }
  fs.symlinkSync(
    `${releaseRoot}/current/device/install-release.sh`,
    path.join(phoneState, 'install-release.sh'),
  );
  const harness = `
set -euo pipefail
${shellFunction(installer, 'release_dispatch_matches_target')}
HOME="$1"
CURRENT="$2"
PHONE_STATE="$3"
release_dispatch_matches_target "$4"
`;
  const prove = () => spawnSync(
    'bash',
    ['-c', harness, 'dispatch', home, current, phoneState, target],
    { encoding: 'utf8' },
  );
  assert.equal(prove().status, 0);

  fs.unlinkSync(path.join(phoneState, 'helper.py'));
  fs.symlinkSync(
    path.join(target, 'phone-tools/helper.py'),
    path.join(phoneState, 'helper.py'),
  );
  assert.notEqual(prove().status, 0);

  fs.unlinkSync(path.join(phoneState, 'helper.py'));
  fs.symlinkSync(
    `${releaseRoot}/current/phone-tools/helper.py`,
    path.join(phoneState, 'helper.py'),
  );
  fs.symlinkSync(
    `${releaseRoot}/current/phone-tools/removed.py`,
    path.join(phoneState, 'removed.py'),
  );
  assert.notEqual(prove().status, 0);
});

test('obsolete release dispatch is removed transactionally and restored on rollback', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-obsolete-'));
  const releaseRoot = path.join(fixture, 'root');
  const previous = path.join(releaseRoot, 'releases/release-old');
  const candidate = path.join(releaseRoot, 'releases/release-new');
  const phoneState = path.join(releaseRoot, 'state/phone-tools');
  const migration = path.join(releaseRoot, 'migrations/install-fixture');
  fs.mkdirSync(path.join(previous, 'phone-tools'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'phone-tools'), { recursive: true });
  fs.mkdirSync(phoneState, { recursive: true });
  fs.mkdirSync(migration, { recursive: true });
  fs.writeFileSync(path.join(previous, 'phone-tools/.removed.sh'), ':\n');
  fs.symlinkSync('releases/release-old', path.join(releaseRoot, 'current'));
  const stable = `${releaseRoot}/current/phone-tools/.removed.sh`;
  fs.symlinkSync(stable, path.join(phoneState, '.removed.sh'));
  const helpers = [
    'phone_dispatch_target',
    'fsync_copied_entry',
    'phone_dispatch_entries_equivalent',
    'rename_no_copy',
    'record_phone_dispatch_predecessor',
    'remove_obsolete_phone_dispatch_links',
    'remove_exact_generated_symlink',
    'restore_phone_dispatch_backup',
    'rollback_phone_dispatch_changes',
  ].map((name) => shellFunction(installer, name)).join('\n');
  const harness = `
set -euo pipefail
${helpers}
fsync_directory() { :; }
fsync_regular_file_and_parent() { :; }
fsync_tree() { :; }
ROOT="$1"
PHONE_STATE="$2"
MIGRATION_DIR="$3"
PREVIOUS_TARGET="$4"
INITIAL_MIGRATION=0
remove_obsolete_phone_dispatch_links "$5"
remove_obsolete_phone_dispatch_links "$5"
test ! -e "$PHONE_STATE/.removed.sh"
test ! -L "$PHONE_STATE/.removed.sh"
rollback_phone_dispatch_changes
rollback_phone_dispatch_changes
`;
  const result = spawnSync(
    'bash',
    [
      '-c',
      harness,
      'dispatch',
      releaseRoot,
      phoneState,
      migration,
      previous,
      candidate,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readlinkSync(path.join(phoneState, '.removed.sh')), stable);
});

test('versioned dispatch refuses mutable state while initial conversion can retire it', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-dispatch-move-'));
  const releaseRoot = path.join(fixture, 'root');
  const phoneState = path.join(releaseRoot, 'state/phone-tools');
  const migration = path.join(releaseRoot, 'migrations/install-fixture');
  const predecessor = path.join(phoneState, 'helper.py');
  const backup = path.join(migration, 'replaced-phone-tools/helper.py');
  fs.mkdirSync(path.join(predecessor, 'nested'), { recursive: true });
  fs.mkdirSync(migration, { recursive: true });
  fs.writeFileSync(path.join(predecessor, 'nested/state'), 'private state\n');
  const helpers = [
    'phone_dispatch_target',
    'fsync_copied_entry',
    'phone_dispatch_entries_equivalent',
    'rename_no_copy',
    'record_phone_dispatch_predecessor',
    'publish_phone_dispatch_link',
    'remove_exact_generated_symlink',
    'restore_phone_dispatch_backup',
    'rollback_phone_dispatch_changes',
  ].map((name) => shellFunction(installer, name)).join('\n');
  const harness = `
set -euo pipefail
${helpers}
fsync_directory() { :; }
fsync_regular_file_and_parent() { :; }
fsync_tree() { :; }
ROOT="$1"
PHONE_STATE="$2"
MIGRATION_DIR="$3"
PREVIOUS_TARGET=""
INITIAL_MIGRATION=0
if publish_phone_dispatch_link helper.py; then
  exit 1
fi
test -d "$PHONE_STATE/helper.py"
test "$(cat "$PHONE_STATE/helper.py/nested/state")" = "private state"
test ! -e "$MIGRATION_DIR/replaced-phone-tools/helper.py"
INITIAL_MIGRATION=1
before="$(python3 - "$PHONE_STATE/helper.py" <<'PY'
import os
import sys
print(os.lstat(sys.argv[1]).st_ino)
PY
)"
publish_phone_dispatch_link helper.py
test -L "$PHONE_STATE/helper.py"
test "$(readlink "$PHONE_STATE/helper.py")" \
  = "$ROOT/current/phone-tools/helper.py"
after="$(python3 - "$MIGRATION_DIR/replaced-phone-tools/helper.py" <<'PY'
import os
import sys
print(os.lstat(sys.argv[1]).st_ino)
PY
)"
test "$before" = "$after"
INITIAL_MIGRATION=0
rollback_phone_dispatch_changes
test -d "$PHONE_STATE/helper.py"
test "$(cat "$PHONE_STATE/helper.py/nested/state")" = "private state"
`;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'dispatch', releaseRoot, phoneState, migration],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.lstatSync(backup).isDirectory(), true);
  const publish = shellFunction(installer, 'publish_phone_dispatch_link');
  assert.doesNotMatch(publish, /rm\s+-r/);
});

test('recovery program checks remain fail-closed under optimized Python', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-optimize-'));
  const program = path.join(fixture, 'program.sh');
  const commandLine = path.join(fixture, 'cmdline');
  fs.writeFileSync(program, 'fixture\n', { mode: 0o600 });
  fs.writeFileSync(
    commandLine,
    Buffer.from(`/bin/bash\0${program}\0`, 'utf8'),
    { mode: 0o600 },
  );
  const harness = `
set -euo pipefail
${shellFunction(installer, 'safe_private_program')}
${shellFunction(installer, 'process_has_exact_script')}
safe_private_program "$1"
process_has_exact_script 123 "$1" "$2"
`;
  function check(target = program) {
    return spawnSync(
      'bash',
      ['-c', harness, 'optimized-check', target, commandLine],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONOPTIMIZE: '2' },
      },
    );
  }
  assert.equal(check().status, 0);

  fs.appendFileSync(commandLine, Buffer.from('spoof\0', 'utf8'));
  assert.notEqual(check().status, 0);

  fs.writeFileSync(
    commandLine,
    Buffer.from(`/bin/bash\0${fixture}\0`, 'utf8'),
  );
  assert.notEqual(check(fixture).status, 0);
  assert.match(
    installer,
    /unset PYTHONOPTIMIZE PYTHONPATH PYTHONHOME PYTHONUSERBASE/,
  );
});

test('server ownership proof correlates two accepts with one exact process', async () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-accept-proof-'));
  const runtime = path.join(fixture, 'runtime');
  const proc = path.join(fixture, 'proc');
  const ready = path.join(fixture, 'ready');
  const serverFd = path.join(proc, '101/fd');
  fs.mkdirSync(runtime);
  fs.mkdirSync(path.join(proc, '100/fd'), { recursive: true });
  fs.mkdirSync(serverFd, { recursive: true });

  function writeProcess(pid, parent, start, command, environment) {
    const directory = path.join(proc, String(pid));
    fs.mkdirSync(path.join(directory, 'fd'), { recursive: true });
    const fields = ['S', String(parent), ...Array(17).fill('0'), String(start)];
    fs.writeFileSync(
      path.join(directory, 'stat'),
      `${pid} (fixture) ${fields.join(' ')}\n`,
    );
    fs.writeFileSync(
      path.join(directory, 'cmdline'),
      Buffer.from(`${command.join('\0')}\0`, 'utf8'),
    );
    fs.writeFileSync(
      path.join(directory, 'environ'),
      Buffer.from(
        `${Object.entries(environment)
          .map(([key, value]) => `${key}=${value}`)
          .join('\0')}\0`,
        'utf8',
      ),
    );
    fs.symlinkSync(runtime, path.join(directory, 'cwd'));
  }

  const childCode = `
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const fd = process.argv[1];
const ready = process.argv[2];
const log = ready + '.log';
let next = 1000;
const server = net.createServer((socket) => {
  const name = 'accepted-' + next;
  const descriptor = path.join(fd, name);
  fs.symlinkSync('socket:[' + next + ']', descriptor);
  fs.appendFileSync(log, 'accepted ' + name + '\\n');
  next += 1;
  socket.resume();
  socket.on('error', (error) => {
    fs.appendFileSync(log, 'error ' + name + ' ' + error.code + '\\n');
  });
  socket.on('end', () => {
    fs.appendFileSync(log, 'end ' + name + '\\n');
    socket.destroy();
  });
  socket.on('close', () => {
    fs.appendFileSync(log, 'close ' + name + '\\n');
    try {
      fs.unlinkSync(descriptor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(ready, String(server.address().port));
});
`;
  const child = spawn(process.execPath, ['-e', childCode, serverFd, ready], {
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 200 && !fs.existsSync(ready); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(ready), true);
    const port = fs.readFileSync(ready, 'utf8');
    writeProcess(100, 1, 111, ['/bin/tmux'], {});
    writeProcess(
      101,
      100,
      222,
      ['/usr/bin/node', 'server.js'],
      { HOST: '127.0.0.1', NODE_ENV: 'production', PORT: port },
    );
    fs.symlinkSync('socket:[900]', path.join(serverFd, 'baseline'));
    const ownerProof = shellFunction(
      installer,
      'phone_server_owner_fingerprint',
    ).replace("<<'PY' 2>/dev/null", "<<'PY'");
    const harness = `
set -euo pipefail
${ownerProof}
phone_server_owner_fingerprint 100 "$1" "$2" "" "$2" "$3"
`;
    function prove() {
      return spawnSync(
        'bash',
        ['-c', harness, 'owner-proof', runtime, port, proc],
        { encoding: 'utf8' },
      );
    }
    let result = prove();
    assert.equal(
      result.status,
      0,
      result.stderr + fs.readFileSync(`${ready}.log`, 'utf8'),
    );
    assert.equal(result.stdout.trim(), '101:222');

    writeProcess(
      102,
      1,
      333,
      ['/usr/bin/node', 'server.js'],
      { HOST: '127.0.0.1', NODE_ENV: 'production', PORT: port },
    );
    fs.symlinkSync('socket:[901]', path.join(proc, '102/fd/baseline'));
    result = prove();
    assert.notEqual(result.status, 0);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
  }
});

test('control-plane health waits for consecutive exact proofs after transient misses', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const probe = shellFunction(
    installer,
    'authenticated_release_control_plane_live',
  );
  const wait = shellFunction(
    installer,
    'wait_for_authenticated_release_control_plane',
  );
  const harness = `
set -uo pipefail
${wait}
PROBE_CALLS=0
SLEEP_TOTAL=0
RELEASE_CONTROL_PROBE_REASON=not_run
authenticated_release_control_plane_live() {
  PROBE_CALLS=$((PROBE_CALLS + 1))
  case "$SCENARIO:$PROBE_CALLS" in
    transient:1)
      RELEASE_CONTROL_PROBE_REASON=server_proof
      return 1
      ;;
    transient:2|transient:4|transient:5|transient:6|immediate:*)
      RELEASE_CONTROL_PROBE_REASON=healthy
      return 0
      ;;
    transient:3)
      RELEASE_CONTROL_PROBE_REASON=watchdog_owner
      return 1
      ;;
    unknown:1)
      RELEASE_CONTROL_PROBE_REASON=private-runtime-detail
      return 1
      ;;
    unknown:*)
      RELEASE_CONTROL_PROBE_REASON=healthy
      return 0
      ;;
    permanent:*)
      RELEASE_CONTROL_PROBE_REASON=server_proof
      return 1
      ;;
    *)
      RELEASE_CONTROL_PROBE_REASON=unexpected-fixture-state
      return 1
      ;;
  esac
}
sleep() {
  SLEEP_TOTAL=$((SLEEP_TOTAL + $1))
}
say() {
  printf 'diagnostic=%s\\n' "$*"
}
SCENARIO="$1"
wait_for_authenticated_release_control_plane /fixture/release
rc=$?
printf 'result=%s calls=%s sleep=%s\\n' "$rc" "$PROBE_CALLS" "$SLEEP_TOTAL"
exit 0
`;
  function run(scenario) {
    return spawnSync(
      'bash',
      ['-c', harness, 'control-health-wait', scenario],
      { encoding: 'utf8' },
    );
  }

  let result = run('transient');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /diagnostic=.*server_proof/);
  assert.match(result.stdout, /diagnostic=.*watchdog_owner/);
  assert.match(result.stdout, /result=0 calls=6 sleep=7/);
  assert.doesNotMatch(result.stdout, /did not stabilize/);

  result = run('immediate');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'result=0 calls=3 sleep=2\n');

  result = run('permanent');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.split('diagnostic=').length - 1,
    2,
    result.stdout,
  );
  assert.match(result.stdout, /did not stabilize \(server_proof\)/);
  assert.match(result.stdout, /result=1 calls=60 sleep=120/);

  result = run('unknown');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /diagnostic=.*unknown/);
  assert.doesNotMatch(result.stdout, /private-runtime-detail/);
  assert.match(result.stdout, /result=0 calls=4 sleep=4/);

  assert.match(
    probe,
    /RELEASE_CONTROL_PROBE_REASON=server_proof[\s\S]*authenticated_release_server_live/,
  );
  assert.match(
    probe,
    /RELEASE_CONTROL_PROBE_REASON=scheduler_owner[\s\S]*scheduler_owner_live/,
  );
  assert.match(
    probe,
    /RELEASE_CONTROL_PROBE_REASON=watchdog_owner[\s\S]*watchdog_owner_live/,
  );
  assert.match(
    probe,
    /RELEASE_CONTROL_PROBE_REASON=release_identity[\s\S]*"\$health_client"/,
  );
  assert.match(
    probe,
    /RELEASE_CONTROL_PROBE_REASON=control_health_payload[\s\S]*health\["ok"\] is True/,
  );
});

test('package install trusts a complete private marker, not rish transport output', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const parser = shellFunction(installer, 'read_package_result_status');
  const install = shellFunction(installer, 'install_apk');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-package-install-'));
  const apk = path.join(fixture, 'candidate.apk');
  const stage = path.join(fixture, 'stage');
  const operation = path.join(
    fixture,
    `evogent-package-op.${'a'.repeat(32)}`,
  );
  const log = path.join(fixture, 'install-fixture.log');
  const trace = path.join(fixture, 'trace');
  const fakeBin = path.join(fixture, 'bin');
  fs.writeFileSync(apk, 'signed APK fixture bytes\n');
  fs.mkdirSync(stage);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, 'cmd'),
    `#!/bin/bash
if [ "$1" != package ]; then exit 64; fi
case "$2" in
  install)
    printf '%s\\n' "$PRIVATE_DETAIL"
    exit "$PACKAGE_STATUS"
    ;;
  wait-for-handler|wait-for-background-handler) exit 0 ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  const harness = `
set -uo pipefail
${parser}
${install}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { printf '%s\\n' "$*"; }
sleep() { :; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }
fsync_regular_file_and_parent() { :; }
reconcile_android_install_user_action() { return 1; }
reconcile_successful_android_install_foreground() {
  record post-success-review
  return "$POST_REVIEW_RESULT"
}
prepare_shell_package_operation() {
  record allocate
  mkdir -p "$OPERATION"
  : > "$OPERATION/candidate.apk"
  chmod 0666 "$OPERATION/candidate.apk"
  PACKAGE_OPERATION="$OPERATION"
  PACKAGE_OPERATION_STATE=prepared
}
write_transaction_journal() {
  record "journal:$PACKAGE_OPERATION_STATE"
  TRANSACTION_PHASE="$1"
}
remove_shell_package_operation() {
  record cleanup
  rm -rf -- "$1"
}
rish_command() {
  record rish
  if [ "$PUBLISH_RESULT" = actual ]; then
    PATH="$FAKE_BIN:$PATH" bash -c "$1" >/dev/null 2>&1
  elif [ "$PUBLISH_RESULT" = valid ]; then
    rm -f -- "$OPERATION/candidate.apk"
    printf '%s\\n' "$PRIVATE_DETAIL" > "$OPERATION/details"
    printf 'EVOGENT_PACKAGE_RESULT_V1\\n%s\\n' "$PACKAGE_STATUS" > "$OPERATION/status"
    chmod 0444 "$OPERATION/details" "$OPERATION/status"
  elif [ "$PUBLISH_RESULT" = invalid ]; then
    printf 'partial\\n' > "$OPERATION/status"
    chmod 0444 "$OPERATION/status"
  fi
  return "$RISH_RESULT"
}
STAGE="$STAGE_DIR"
LOG="$INSTALL_LOG"
PACKAGE_OPERATION=""
PACKAGE_OPERATION_STATE=""
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=0
TRANSACTION_JOURNAL_WRITTEN=1
TRANSACTION_PHASE=apk_install_pending
if install_apk "$APK_PATH" "$INSTALL_MODE"; then rc=0; else rc=$?; fi
if [ -n "$PACKAGE_OPERATION" ]; then retained=yes; else retained=no; fi
printf 'rc=%s state=%s retained=%s unresolved=%s\\n' \
  "$rc" "$PACKAGE_OPERATION_STATE" "$retained" \
  "$PACKAGE_OPERATION_LAUNCH_UNRESOLVED"
`;
  function runInstall({
    installMode = 'upgrade',
    packageStatus = '0',
    publishResult = 'actual',
    rishResult = '0',
    postReviewResult = '0',
  } = {}) {
    fs.rmSync(operation, { recursive: true, force: true });
    fs.rmSync(trace, { force: true });
    fs.rmSync(
      `${log.slice(0, -4)}-package-manager-${installMode}-${'a'.repeat(32)}.log`,
      { force: true },
    );
    return spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APK_PATH: apk,
        FAKE_BIN: fakeBin,
        INSTALL_LOG: log,
        INSTALL_MODE: installMode,
        OPERATION: operation,
        PACKAGE_STATUS: packageStatus,
        PRIVATE_DETAIL: 'diagnostic that must stay private',
        POST_REVIEW_RESULT: postReviewResult,
        PUBLISH_RESULT: publishResult,
        RISH_RESULT: rishResult,
        STAGE_DIR: stage,
        TRACE: trace,
      },
    });
  }

  let result = runInstall({ rishResult: '9' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 state= retained=no unresolved=0/);
  assert.doesNotMatch(result.stdout + result.stderr, /diagnostic that must stay private/);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'allocate\njournal:launched\nrish\ncleanup\npost-success-review\n',
  );
  assert.equal(fs.existsSync(operation), false);

  result = runInstall({ postReviewResult: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /rc=1 state=launched retained=yes unresolved=1/,
  );
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'allocate\njournal:launched\nrish\ncleanup\npost-success-review\n',
  );

  result = runInstall({ packageStatus: '7' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 state=launched retained=yes unresolved=1/);
  assert.doesNotMatch(result.stdout + result.stderr, /diagnostic that must stay private/);
  const retained =
    `${log.slice(0, -4)}-package-manager-upgrade-${'a'.repeat(32)}.log`;
  assert.match(fs.readFileSync(retained, 'utf8'), /diagnostic that must stay private/);
  assert.equal(fs.statSync(retained).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'allocate\njournal:launched\nrish\ncleanup\n',
  );

  result = runInstall({ publishResult: 'none' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 state=launched retained=yes unresolved=1/);
  assert.equal(fs.existsSync(operation), true);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'allocate\njournal:launched\nrish\n',
  );

  result = runInstall({ installMode: 'unknown' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1/);
  assert.equal(fs.existsSync(trace), false);
});

test('native APK rollback is durably fenced through result and review publication', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const parser = shellFunction(installer, 'read_package_result_status');
  const launch = shellFunction(installer, 'launch_native_apk_rollback');
  const complete = shellFunction(
    installer,
    'complete_native_apk_rollback_operation',
  );
  const restoredReview = shellFunction(
    installer,
    'persist_restored_apk_review',
  );
  const launchJournal = launch.indexOf(
    'write_transaction_journal "$TRANSACTION_PHASE"',
  );
  const rollbackCommand = launch.indexOf("cmd package rollback-app");
  assert.ok(launchJournal >= 0 && launchJournal < rollbackCommand);
  const removeNonce = complete.indexOf(
    'remove_shell_package_operation "$operation"',
  );
  const clearOperation = complete.indexOf('PACKAGE_OPERATION=""', removeNonce);
  const publishReview = complete.indexOf(
    'persist_restored_apk_review',
    clearOperation,
  );
  const clearGuard = complete.indexOf(
    'PACKAGE_OPERATION_LAUNCH_UNRESOLVED=0',
    publishReview,
  );
  assert.ok(
    removeNonce >= 0
      && removeNonce < clearOperation
      && clearOperation < publishReview
      && publishReview < clearGuard,
  );

  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-native-rollback-fence-'),
  );
  const stage = path.join(fixture, 'stage');
  const operation = path.join(
    fixture,
    `evogent-package-op.${'a'.repeat(32)}`,
  );
  const log = path.join(fixture, 'install.log');
  const trace = path.join(fixture, 'trace');
  const retained =
    `${log.slice(0, -4)}-package-manager-native-rollback-${'a'.repeat(32)}.log`;
  const launchHarness = `
set -uo pipefail
${parser}
${launch}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
sleep() { :; }
fsync_regular_file_and_parent() { record fsync; }
write_transaction_journal() {
  JOURNAL_CALLS=$((JOURNAL_CALLS + 1))
  record "journal:$1:$PACKAGE_OPERATION_STATE:\${PACKAGE_OPERATION_LAUNCH_UNRESOLVED:-0}"
  if [ "$JOURNAL_CALLS" = "$FAIL_JOURNAL_AT" ]; then
    if [ "$JOURNAL_RESULT" = 76 ]; then TRANSACTION_PHASE="$1"; fi
    return "$JOURNAL_RESULT"
  fi
  TRANSACTION_PHASE="$1"
  return 0
}
prepare_shell_package_operation() {
  PACKAGE_OPERATION="$OPERATION"
  PACKAGE_OPERATION_STATE=prepared
  write_transaction_journal "$TRANSACTION_PHASE" || return 1
  record allocate
  mkdir -p "$OPERATION"
  : > "$OPERATION/candidate.apk"
  chmod 0666 "$OPERATION/candidate.apk"
}
rish_command() {
  record rish
  if [ "$PUBLISH_RESULT" = valid ]; then
    printf '%s\\n' "$PRIVATE_DETAIL" > "$OPERATION/details"
    printf 'EVOGENT_PACKAGE_RESULT_V1\\n%s\\n' \
      "$PACKAGE_STATUS" > "$OPERATION/status"
    chmod 0444 "$OPERATION/details" "$OPERATION/status"
  elif [ "$PUBLISH_RESULT" = invalid ]; then
    printf 'partial\\n' > "$OPERATION/status"
    chmod 0444 "$OPERATION/status"
  fi
  return "$RISH_RESULT"
}
JOURNAL_CALLS=0
STAGE="$STAGE_DIR"
LOG="$INSTALL_LOG"
PACKAGE_NAME=net.dangish.evogent
PACKAGE_OPERATION=""
PACKAGE_OPERATION_STATE=""
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=0
APK_ROLLBACK_RETRY_GENERATION=0
TRANSACTION_JOURNAL_WRITTEN=1
TRANSACTION_PHASE=health_pending
if launch_native_apk_rollback; then rc=0; else rc=$?; fi
if [ -n "$PACKAGE_OPERATION" ]; then retained=yes; else retained=no; fi
printf 'rc=%s phase=%s state=%s guard=%s retained=%s\\n' \
  "$rc" "$TRANSACTION_PHASE" "$PACKAGE_OPERATION_STATE" \
  "$PACKAGE_OPERATION_LAUNCH_UNRESOLVED" "$retained"
`;
  function runLaunch({
    failJournalAt = '0',
    journalResult = '1',
    packageStatus = '0',
    publishResult = 'valid',
    rishResult = '0',
  } = {}) {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(operation, { recursive: true, force: true });
    fs.rmSync(trace, { force: true });
    fs.rmSync(retained, { force: true });
    fs.mkdirSync(stage);
    return spawnSync('bash', ['-c', launchHarness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAIL_JOURNAL_AT: failJournalAt,
        INSTALL_LOG: log,
        JOURNAL_RESULT: journalResult,
        OPERATION: operation,
        PACKAGE_STATUS: packageStatus,
        PRIVATE_DETAIL: 'private native rollback diagnostic',
        PUBLISH_RESULT: publishResult,
        RISH_RESULT: rishResult,
        STAGE_DIR: stage,
        TRACE: trace,
      },
    });
  }

  let result = runLaunch();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /rc=0 phase=apk_install_pending state=launched guard=1 retained=yes/,
  );
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'journal:apk_install_pending::0\n'
      + 'journal:apk_install_pending:prepared:0\n'
      + 'allocate\n'
      + 'journal:apk_install_pending:launched:1\n'
      + 'rish\n',
  );

  result = runLaunch({ packageStatus: '7' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 .*state=launched guard=1 retained=yes/);
  assert.equal(fs.statSync(retained).mode & 0o777, 0o600);
  assert.match(
    fs.readFileSync(retained, 'utf8'),
    /private native rollback diagnostic/,
  );

  result = runLaunch({ publishResult: 'none' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 .*state=launched guard=1 retained=yes/);

  result = runLaunch({ failJournalAt: '3', journalResult: '76' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 .*state=launched guard=1 retained=yes/);
  assert.doesNotMatch(fs.readFileSync(trace, 'utf8'), /^rish$/m);

  const completeHarness = `
set -uo pipefail
${complete}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
remove_shell_package_operation() {
  record "remove:$1"
  return "$REMOVE_RESULT"
}
persist_restored_apk_review() {
  record "review:$REVIEW_RESULT"
  return "$REVIEW_RESULT"
}
PACKAGE_OPERATION="/data/local/tmp/evogent-package-op.${'b'.repeat(32)}"
PACKAGE_OPERATION_STATE=launched
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=1
TRANSACTION_PHASE=apk_install_pending
if complete_native_apk_rollback_operation; then rc=0; else rc=$?; fi
if [ -n "$PACKAGE_OPERATION" ]; then retained=yes; else retained=no; fi
printf 'rc=%s state=%s guard=%s retained=%s\\n' \
  "$rc" "$PACKAGE_OPERATION_STATE" \
  "$PACKAGE_OPERATION_LAUNCH_UNRESOLVED" "$retained"
`;
  function runComplete(removeResult = '0', reviewResult = '0') {
    fs.rmSync(trace, { force: true });
    return spawnSync('bash', ['-c', completeHarness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        REMOVE_RESULT: removeResult,
        REVIEW_RESULT: reviewResult,
        TRACE: trace,
      },
    });
  }

  result = runComplete();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 state= guard=0 retained=no/);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    `remove:/data/local/tmp/evogent-package-op.${'b'.repeat(32)}\nreview:0\n`,
  );

  result = runComplete('0', '76');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 state=launched guard=1 retained=yes/);

  result = runComplete('1', '0');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 state=launched guard=1 retained=yes/);
  assert.doesNotMatch(fs.readFileSync(trace, 'utf8'), /^review:/m);

  const restoredHarness = `
set -uo pipefail
${restoredReview}
sha256_file() { printf '%s\\n' "${'d'.repeat(64)}"; }
persist_and_wait_android_install_review() {
  printf '%s:%s:%s:%s:%s:trusted=%s:generation=%s\\n' \
    "$1" "$2" "$3" "$4" "$5" "$8" \
    "$APK_ROLLBACK_RETRY_GENERATION" >> "$TRACE"
  return "$REVIEW_RESULT"
}
STAGE="$1"
APK_BACKUP="$1/backup.apk"
PREVIOUS_APK_CODE=7
PREVIOUS_APK_SIGNER="${'c'.repeat(64)}"
APK_ROLLBACK_RETRY_GENERATION="$INITIAL_GENERATION"
PACKAGE_OPERATION=""
PACKAGE_OPERATION_STATE=""
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=1
APK_INSTALL_SCAN_REQUIRED=0
APK_USER_ACTION_KIND=""
if persist_restored_apk_review; then rc=0; else rc=$?; fi
printf 'rc=%s generation=%s\\n' "$rc" "$APK_ROLLBACK_RETRY_GENERATION"
`;
  function runRestored(initialGeneration = '0', reviewResult = '0') {
    fs.rmSync(trace, { force: true });
    return spawnSync('bash', ['-c', restoredHarness, 'review', fixture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        INITIAL_GENERATION: initialGeneration,
        REVIEW_RESULT: reviewResult,
        TRACE: trace,
      },
    });
  }
  result = runRestored();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 generation=1/);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    `apk_install_pending:rollback_restore:7:${'c'.repeat(64)}:${'d'.repeat(64)}:trusted=0:generation=1\n`,
  );
  result = runRestored('1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 generation=1/);
  assert.equal(fs.existsSync(trace), false);
});

test('EXIT cleanup cannot mutate or discard across the live launch-fence gap', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const rollback = shellFunction(installer, 'rollback_release');
  const cleanup = shellFunction(installer, 'cleanup');
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-launch-gap-cleanup-'),
  );
  const trace = path.join(fixture, 'trace');
  const harness = `
set -uo pipefail
${rollback}
${cleanup}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
quiesce_control_plane() { record mutation; }
clear_transaction_journal() { record clear; }
COMMITTED=0
ROLLBACK_ATTEMPTED=0
ROLLBACK_FAILED=0
SWITCH_STARTED="$MUTATED"
MIGRATION_STARTED=0
QUIESCED=0
CONTROL_PLANE_MUTATION_STARTED=0
TRANSACTION_JOURNAL_WRITTEN=1
PACKAGE_OPERATION=""
PACKAGE_OPERATION_STATE=""
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=1
CYCLE_GATE_HELD=0
CONTROL_MUTATION_GATE_HELD=0
STAGE=""
REARM_PRIOR_CONTROL_PLANE=0
ROLLBACK_DECISION_DURABLE=0
INSTALL_LOCK_HELD=0
DEPENDENCY_STATE_HELPER=""
DEPENDENCY_BUILD=""
DEPENDENCY_BUILDS="$1/dependency-builds"
SUCCESS=0
RECOVERY_ACTIVE=0
false
cleanup
`;
  for (const mutated of ['0', '1']) {
    fs.rmSync(trace, { force: true });
    const result = spawnSync('bash', ['-c', harness, 'cleanup', fixture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MUTATED: mutated,
        TRACE: trace,
      },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      fs.existsSync(trace),
      false,
      `launch-gap cleanup mutated state for mutated=${mutated}`,
    );
  }
});

test('APK rollback proves an already-restored identity before any package mutation', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'rollback_apk_native');
  assert.match(
    helper,
    /operation_state="\$PACKAGE_OPERATION_STATE"[\s\S]*PACKAGE_OPERATION_LAUNCH_UNRESOLVED:-0[\s\S]*operation_state" = launched[\s\S]*return 1/,
  );
  assert.match(
    helper,
    /persist_restored_apk_review[\s\S]*launch_native_apk_rollback[\s\S]*complete_native_apk_rollback_operation/,
  );
  assert.doesNotMatch(helper, /wait_for_apk_rollback_availability/);
  const harness = `
set -uo pipefail
${helper}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
reap_recorded_package_operation() {
  record cancel
  PACKAGE_OPERATION=
  PACKAGE_OPERATION_STATE=
  return 0
}
wait_for_package_manager_idle() { record barrier; return 0; }
wait_for_apk_backup_identity() {
  record proof
  PROOF_CALLS=$((PROOF_CALLS + 1))
  case "$PROOF_CALLS" in
    1) return "$PROOF_ONE" ;;
    2) return "$PROOF_TWO" ;;
    *) return "$PROOF_THREE" ;;
  esac
}
launch_native_apk_rollback() {
  record native
  return "$NATIVE_RESULT"
}
complete_native_apk_rollback_operation() {
  record complete
  return "$COMPLETE_RESULT"
}
persist_restored_apk_review() {
  record review
  return "$REVIEW_RESULT"
}
PROOF_CALLS=0
if rollback_apk_native; then rc=0; else rc=$?; fi
printf 'rc=%s\\n' "$rc"
`;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-apk-rollback-'));
  const trace = path.join(fixture, 'trace');
  function runRollback({
    proofOne,
    proofTwo = '0',
    proofThree = '0',
    initialOperation = '',
    initialOperationState = '',
    launchUnresolved = '0',
    nativeResult = '0',
    completeResult = '0',
    restoreGeneration = '0',
    reviewResult = '0',
  }) {
    fs.rmSync(trace, { force: true });
    return spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APK_BACKUP: path.join(fixture, 'backup.apk'),
        APK_BACKUP_READY: '1',
        APK_INSTALL_ATTEMPTED: '1',
        APK_ROLLBACK_RETRY_GENERATION: restoreGeneration,
        COMPLETE_RESULT: completeResult,
        NATIVE_RESULT: nativeResult,
        PACKAGE_OPERATION: initialOperation,
        PACKAGE_OPERATION_LAUNCH_UNRESOLVED: launchUnresolved,
        PACKAGE_OPERATION_STATE: initialOperationState,
        PACKAGE_NAME: 'com.example.evogent',
        PREVIOUS_APK_CODE: '100',
        PROOF_ONE: proofOne,
        PROOF_THREE: proofThree,
        PROOF_TWO: proofTwo,
        REVIEW_RESULT: reviewResult,
        STAGING_ROOT: fixture,
        TRACE: trace,
      },
    });
  }

  let result = runRollback({ proofOne: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'barrier\nproof\nreview\n');
  assert.match(result.stdout, /rc=0/);

  result = runRollback({ proofOne: '0', restoreGeneration: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'barrier\nproof\n');
  assert.match(result.stdout, /rc=0/);

  result = runRollback({ proofOne: '1', proofTwo: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'barrier\nproof\nnative\nbarrier\nproof\ncomplete\n',
  );
  assert.match(result.stdout, /rc=0/);

  result = runRollback({ proofOne: '1', proofTwo: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'barrier\nproof\nnative\nbarrier\nproof\n',
  );
  assert.match(result.stdout, /rc=1/);

  result = runRollback({ proofOne: '1', nativeResult: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'barrier\nproof\nnative\n',
  );
  assert.match(result.stdout, /rc=1/);

  result = runRollback({
    proofOne: '0',
    initialOperation:
      '/data/local/tmp/evogent-package-op.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    initialOperationState: 'prepared',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'cancel\nbarrier\nproof\nreview\n',
  );
  assert.match(result.stdout, /rc=0/);

  result = runRollback({
    proofOne: '0',
    initialOperation:
      '/data/local/tmp/evogent-package-op.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    initialOperationState: 'launched',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(trace), false);
  assert.match(result.stdout, /rc=1/);

  result = runRollback({ proofOne: '0', launchUnresolved: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(trace), false);
  assert.match(result.stdout, /rc=1/);
});

test('terminal rollback rejects unresolved APK review authority', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'commit_rolled_back_decision');
  const harness = `
set -uo pipefail
${helper}
write_transaction_journal() {
  printf '%s\\n' "$1" >> "$TRACE"
}
ROLLBACK_FAILED=0
RUNTIME_PROVEN_STOPPED=1
TRANSACTION_PHASE="$PHASE"
PACKAGE_OPERATION=
PACKAGE_OPERATION_STATE=
PACKAGE_OPERATION_LAUNCH_UNRESOLVED=0
CONTROL_TOKEN_BRIDGE=
APK_USER_ACTION_KIND="$ACTION_KIND"
APK_USER_ACTION_PURPOSE="$ACTION_PURPOSE"
APK_USER_ACTION_EVIDENCE="$ACTION_EVIDENCE"
APK_USER_ACTION_TARGET_SHA256="$ACTION_SHA256"
APK_USER_ACTION_TARGET_VERSION_CODE="$ACTION_VERSION"
APK_USER_ACTION_TARGET_SIGNER_SHA256="$ACTION_SIGNER"
APK_USER_ACTION_CHALLENGE="$ACTION_CHALLENGE"
APK_USER_ACTION_CHALLENGE_CREATED_AT="$ACTION_CREATED"
APK_USER_ACTION_CHALLENGE_EXPIRES_AT="$ACTION_EXPIRES"
APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED="$ACTION_TRUSTED"
APK_INSTALL_SCAN_REQUIRED="$ACTION_TRUSTED"
APK_INSTALL_ATTEMPTED=1
APK_BACKUP_READY=1
ANDROID_ROLE_RESTORE_REQUIRED=0
ANDROID_ROLE_BACKUP_READY=0
MIGRATION_STARTED=0
SWITCH_STARTED=0
DB_BACKUP_READY=0
CONTROL_TOKEN_BACKUP_READY=0
ROLLBACK_DECISION_DURABLE=0
if commit_rolled_back_decision; then rc=0; else rc=$?; fi
printf 'rc=%s durable=%s\\n' "$rc" "$ROLLBACK_DECISION_DURABLE"
`;
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-terminal-rollback-review-'),
  );
  const trace = path.join(fixture, 'trace');
  const emptyAction = {
    ACTION_CHALLENGE: '',
    ACTION_CREATED: '',
    ACTION_EVIDENCE: '',
    ACTION_EXPIRES: '',
    ACTION_KIND: '',
    ACTION_PURPOSE: '',
    ACTION_SHA256: '',
    ACTION_SIGNER: '',
    ACTION_TRUSTED: '0',
    ACTION_VERSION: '',
  };
  function run(overrides = {}) {
    fs.rmSync(trace, { force: true });
    return spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...emptyAction,
        PHASE: 'apk_install_pending',
        TRACE: trace,
        ...overrides,
      },
    });
  }

  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 durable=1/);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'rolled_back\n');

  result = run({
    ACTION_CHALLENGE: 'a'.repeat(64),
    ACTION_CREATED: '1',
    ACTION_EVIDENCE: 'fresh_display_0_operator_attestation_v1',
    ACTION_EXPIRES: '2',
    ACTION_KIND: 'android_install_review',
    ACTION_PURPOSE: 'rollback_restore',
    ACTION_SHA256: 'b'.repeat(64),
    ACTION_SIGNER: 'c'.repeat(64),
    ACTION_TRUSTED: '1',
    ACTION_VERSION: '100',
    PHASE: 'apk_user_action_required',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=70 durable=0/);
  assert.equal(fs.existsSync(trace), false);
});

test('rollback recovery preserves predecessor-review authority until re-attested', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const prepare = shellFunction(
    installer,
    'prepare_android_install_review_for_rollback',
  );
  const resume = shellFunction(
    installer,
    'resume_pending_rollback_install_review',
  );
  assert.doesNotMatch(
    installer,
    /apk_rollback_retry_pending|begin_fresh_rollback_install_retry|retry_pending_rollback_install_review|cmd package install[^\n]*\s-d(?:\s|")|install_apk "\$APK_BACKUP" fallback/,
  );
  const rollback = shellFunction(installer, 'rollback_release');
  assert.match(
    rollback,
    /prepare_android_install_review_for_rollback[\s\S]*quiesce_control_plane[\s\S]*resume_pending_rollback_install_review[\s\S]*rollback_apk_native/,
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-rollback-review-recovery-'),
  );
  const backup = path.join(fixture, 'backup.apk');
  const trace = path.join(fixture, 'trace');
  fs.writeFileSync(backup, 'exact predecessor APK bytes\n');
  const backupSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(backup))
    .digest('hex');
  const candidateSha256 = 'd'.repeat(64);
  const candidateSigner = 'e'.repeat(64);
  const harness = `
set -uo pipefail
${prepare}
${resume}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }
clear_install_review_attestation() { record clear-receipt; }
clear_apk_user_action_state() {
  record clear-action
  APK_USER_ACTION_KIND=
  APK_USER_ACTION_PURPOSE=
  APK_USER_ACTION_EVIDENCE=
  APK_USER_ACTION_TARGET_SHA256=
  APK_USER_ACTION_TARGET_VERSION_CODE=
  APK_USER_ACTION_TARGET_SIGNER_SHA256=
  APK_USER_ACTION_CHALLENGE=
  APK_USER_ACTION_CHALLENGE_CREATED_AT=
  APK_USER_ACTION_CHALLENGE_EXPIRES_AT=
  APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED=0
}
write_transaction_journal() {
  record "phase:$1"
  TRANSACTION_PHASE="$1"
}
persist_and_wait_android_install_review() {
  record "resume:$1:$2:$8"
  [ "$RESUME_RESULT" = 0 ] || return 1
  APK_INSTALL_SCAN_REQUIRED=0
  clear_apk_user_action_state
  TRANSACTION_PHASE="$1"
}
android_install_foreground_state_once() {
  printf '%s\\n' "$FOREGROUND_STATE"
}
TRANSACTION_PHASE=apk_user_action_required
APK_USER_ACTION_KIND=android_install_review
APK_USER_ACTION_PURPOSE="$PURPOSE"
APK_USER_ACTION_EVIDENCE=fresh_display_0_operator_attestation_v1
if [ "$PURPOSE" = candidate_install ]; then
  APK_USER_ACTION_TARGET_SHA256="$CANDIDATE_SHA256"
  APK_USER_ACTION_TARGET_VERSION_CODE=101
  APK_USER_ACTION_TARGET_SIGNER_SHA256="$CANDIDATE_SIGNER"
else
  APK_USER_ACTION_TARGET_SHA256="$BACKUP_SHA256"
  APK_USER_ACTION_TARGET_VERSION_CODE=100
  APK_USER_ACTION_TARGET_SIGNER_SHA256="${'c'.repeat(64)}"
fi
APK_USER_ACTION_CHALLENGE="${'a'.repeat(64)}"
APK_USER_ACTION_CHALLENGE_CREATED_AT=1780000000
APK_USER_ACTION_CHALLENGE_EXPIRES_AT=1780000900
APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED="$ACTION_TRUSTED"
APK_INSTALL_SCAN_REQUIRED="$ACTION_TRUSTED"
APK_BACKUP="$BACKUP"
PREVIOUS_APK_CODE=100
PREVIOUS_APK_SIGNER="${'c'.repeat(64)}"
EXPECTED_APK_CODE=101
EXPECTED_APK_SHA256="$CANDIDATE_SHA256"
EXPECTED_APK_SIGNER="$CANDIDATE_SIGNER"
STAGE="$STAGE_DIR"
if prepare_android_install_review_for_rollback; then prepare_rc=0; else prepare_rc=$?; fi
if [ "$RUN_RESUME" = 1 ]; then
  if resume_pending_rollback_install_review; then resume_rc=0; else resume_rc=$?; fi
else
  resume_rc=skipped
fi
printf 'prepare=%s resume=%s phase=%s purpose=%s\\n' \
  "$prepare_rc" "$resume_rc" "$TRANSACTION_PHASE" "$APK_USER_ACTION_PURPOSE"
`;
  function run({
    actionTrusted = '1',
    foregroundState = 'trusted',
    purpose = 'rollback_restore',
    resumeResult = '1',
    runResume = '1',
  } = {}) {
    fs.rmSync(trace, { force: true });
    return spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION_TRUSTED: actionTrusted,
        BACKUP: backup,
        BACKUP_SHA256: backupSha256,
        CANDIDATE_SHA256: candidateSha256,
        CANDIDATE_SIGNER: candidateSigner,
        FOREGROUND_STATE: foregroundState,
        PURPOSE: purpose,
        RESUME_RESULT: resumeResult,
        RUN_RESUME: runResume,
        STAGE_DIR: fixture,
        TRACE: trace,
      },
    });
  }

  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /prepare=0 resume=1 phase=apk_user_action_required purpose=rollback_restore/,
  );
  assert.equal(fs.readFileSync(trace, 'utf8'), 'resume:apk_install_pending:rollback_restore:1\n');

  result = run({ resumeResult: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /prepare=0 resume=0 phase=apk_install_pending purpose=/,
  );
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'resume:apk_install_pending:rollback_restore:1\nclear-action\n',
  );

  result = run({ actionTrusted: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /prepare=0 resume=1 phase=apk_user_action_required purpose=rollback_restore/,
  );
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'resume:apk_install_pending:rollback_restore:1\n',
  );

  result = run({ foregroundState: 'other' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /prepare=0 resume=1 phase=apk_user_action_required purpose=rollback_restore/,
  );
  assert.equal(fs.existsSync(trace), false);

  result = run({ foregroundState: 'unknown' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /prepare=0 resume=1 phase=apk_user_action_required purpose=rollback_restore/,
  );
  assert.equal(fs.existsSync(trace), false);

  result = run({
    purpose: 'candidate_install',
    resumeResult: '0',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /prepare=0 resume=0 phase=apk_install_pending purpose=/,
  );
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'resume:apk_install_pending:candidate_install:1\nclear-action\n',
  );
});

test('interrupted candidate review rotates away pre-crash receipts before visible recovery', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-candidate-review-recovery-'),
  );
  const receipt = path.join(fixture, 'install-review-attestation.json');
  const receiptPublished = path.join(fixture, 'fresh-receipt-published');
  const attester = path.join(fixture, 'attest-install-review.py');
  const trace = path.join(fixture, 'trace');
  const clock = path.join(fixture, 'clock');
  const candidateSha256 = 'd'.repeat(64);
  const candidateSigner = 'e'.repeat(64);
  fs.writeFileSync(attester, '#!/bin/sh\n', { mode: 0o700 });
  fs.chmodSync(attester, 0o700);
  const harness = `
set -uo pipefail
${shellFunction(installer, 'clear_apk_user_action_state')}
${shellFunction(installer, 'clear_install_review_attestation')}
${shellFunction(installer, 'rotate_android_install_review_challenge')}
${shellFunction(installer, 'announce_android_install_security_policy')}
${shellFunction(installer, 'persist_and_wait_android_install_review')}
${shellFunction(installer, 'prepare_android_install_review_for_rollback')}
${shellFunction(installer, 'resume_pending_rollback_install_review')}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
stat() {
  case "$2" in
    %a) printf '700\\n' ;;
    %u) id -u ;;
    %h) printf '1\\n' ;;
    *) return 1 ;;
  esac
}
write_transaction_journal() {
  record "phase:$1:trusted=$APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED"
  TRANSACTION_PHASE="$1"
  [ "$1" != apk_user_action_required ] || ACTION_ROTATED=1
}
announce_android_install_review_attestation() { :; }
read_install_review_attestation() {
  if [ ! -f "$INSTALL_REVIEW_ATTESTATION" ]; then
    record read:missing
    return 1
  fi
  outcome="$(cat "$INSTALL_REVIEW_ATTESTATION")"
  record "read:$outcome"
  [ "$outcome" = scan-completed ] || return 1
  printf '%s\\n' "$outcome"
}
wait_for_package_manager_idle() { return 0; }
installed_apk_identity_stable() {
  record "identity:$2:$3:$4"
  [ "$IDENTITY_READY" = 1 ] \
    && [ "$2" = "$EXPECTED_APK_CODE" ] \
    && [ "$3" = "$EXPECTED_APK_SIGNER" ] \
    && [ "$4" = "$EXPECTED_APK_SHA256" ]
}
android_install_foreground_state_once() {
  if [ "$ACTION_ROTATED" = 0 ]; then
    printf '%s\\n' "$INITIAL_FOREGROUND"
    return
  fi
  if [ "$FRESH_RECEIPT" = 1 ] \
      && [ ! -e "$FRESH_RECEIPT_PUBLISHED" ]; then
    printf 'scan-completed\\n' > "$INSTALL_REVIEW_ATTESTATION"
    chmod 600 "$INSTALL_REVIEW_ATTESTATION"
    : > "$FRESH_RECEIPT_PUBLISHED"
  fi
  printf 'other\\n'
}
date() {
  if [ "\${1:-}" = +%s ]; then
    now="$(cat "$CLOCK_FILE")"
    now=$((now + 1))
    printf '%s\\n' "$now" > "$CLOCK_FILE"
    printf '%s\\n' "$now"
  else
    command date "$@"
  fi
}
sleep() { :; }
TRANSACTION_PHASE=apk_user_action_required
APK_USER_ACTION_KIND=android_install_review
APK_USER_ACTION_PURPOSE=candidate_install
APK_USER_ACTION_EVIDENCE=fresh_display_0_operator_attestation_v1
APK_USER_ACTION_TARGET_SHA256="$ACTION_SHA256"
APK_USER_ACTION_TARGET_VERSION_CODE=101
APK_USER_ACTION_TARGET_SIGNER_SHA256="$CANDIDATE_SIGNER"
APK_USER_ACTION_CHALLENGE="${'a'.repeat(64)}"
APK_USER_ACTION_CHALLENGE_CREATED_AT=1780000000
APK_USER_ACTION_CHALLENGE_EXPIRES_AT=1780000900
APK_USER_ACTION_TRUSTED_VERIFIER_OBSERVED=0
APK_INSTALL_SCAN_REQUIRED=0
EXPECTED_APK_CODE=101
EXPECTED_APK_SHA256="$CANDIDATE_SHA256"
EXPECTED_APK_SIGNER="$CANDIDATE_SIGNER"
APK_BACKUP="$STAGE/unused-backup.apk"
PREVIOUS_APK_CODE=100
PREVIOUS_APK_SIGNER="${'c'.repeat(64)}"
INSTALL_POST_SUCCESS_REVIEW_SECONDS=1
INSTALL_USER_ACTION_WAIT_SECONDS=8
INSTALL_REVIEW_ATTESTATION="$RECEIPT"
TRANSACTION_ATTESTER="$ATTESTER"
STAGE="$STAGE"
ACTION_ROTATED=0
printf 'scan-completed\\n' > "$INSTALL_REVIEW_ATTESTATION"
chmod 600 "$INSTALL_REVIEW_ATTESTATION"
if prepare_android_install_review_for_rollback; then prepare_rc=0; else prepare_rc=$?; fi
if resume_pending_rollback_install_review; then resume_rc=0; else resume_rc=$?; fi
if [ -e "$INSTALL_REVIEW_ATTESTATION" ]; then receipt_after=present; else receipt_after=absent; fi
printf 'prepare=%s resume=%s phase=%s purpose=%s scan=%s receipt=%s\\n' \
  "$prepare_rc" "$resume_rc" "$TRANSACTION_PHASE" \
  "$APK_USER_ACTION_PURPOSE" "$APK_INSTALL_SCAN_REQUIRED" "$receipt_after"
`;

  function run({
    actionSha256 = candidateSha256,
    freshReceipt = '0',
    identityReady = '1',
    initialForeground = 'trusted',
  } = {}) {
    fs.rmSync(trace, { force: true });
    fs.rmSync(receipt, { force: true });
    fs.rmSync(receiptPublished, { force: true });
    fs.writeFileSync(clock, '1800000000\n');
    const result = spawnSync(
      'bash',
      ['-c', harness, 'candidate-review-recovery'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION_SHA256: actionSha256,
          ATTESTER: attester,
          CANDIDATE_SHA256: candidateSha256,
          CANDIDATE_SIGNER: candidateSigner,
          CLOCK_FILE: clock,
          FRESH_RECEIPT: freshReceipt,
          FRESH_RECEIPT_PUBLISHED: receiptPublished,
          IDENTITY_READY: identityReady,
          INITIAL_FOREGROUND: initialForeground,
          RECEIPT: receipt,
          STAGE: fixture,
          TRACE: trace,
        },
      },
    );
    return {
      result,
      trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '',
    };
  }

  let outcome = run();
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(
    outcome.result.stdout,
    /prepare=0 resume=1 phase=apk_user_action_required purpose=candidate_install scan=1 receipt=absent/,
  );
  assert.match(outcome.trace, /^phase:apk_user_action_required:trusted=1\n/);
  assert.match(outcome.trace, /read:missing/);
  assert.doesNotMatch(outcome.trace, /phase:apk_install_pending/);

  outcome = run({ freshReceipt: '1' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(
    outcome.result.stdout,
    /prepare=0 resume=0 phase=apk_install_pending purpose= scan=0 receipt=absent/,
  );
  assert.match(outcome.trace, /^phase:apk_user_action_required:trusted=1\n/);
  assert.match(
    outcome.trace,
    new RegExp(`identity:101:${candidateSigner}:${candidateSha256}`),
  );
  assert.match(outcome.trace, /read:scan-completed/);
  assert.match(outcome.trace, /phase:apk_install_pending:trusted=0/);

  outcome = run({ initialForeground: 'other' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(
    outcome.result.stdout,
    /prepare=0 resume=1 phase=apk_user_action_required purpose=candidate_install scan=0 receipt=present/,
  );
  assert.equal(outcome.trace, '');

  outcome = run({ initialForeground: 'unknown' });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(
    outcome.result.stdout,
    /prepare=0 resume=1 phase=apk_user_action_required purpose=candidate_install scan=0 receipt=present/,
  );
  assert.equal(outcome.trace, '');

  outcome = run({ actionSha256: 'f'.repeat(64) });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(
    outcome.result.stdout,
    /prepare=1 resume=1 phase=apk_user_action_required purpose=candidate_install scan=0 receipt=present/,
  );
  assert.equal(outcome.trace, '');
});

test('rollback reaps only its exact journaled package operation', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'reap_recorded_package_operation');
  const harness = `
set -uo pipefail
${helper}
say() { :; }
remove_shell_package_operation() {
  printf '%s\\n' "$1" > "$TRACE"
  return "$REMOVE_RESULT"
}
PACKAGE_OPERATION="/data/local/tmp/evogent-package-op.${'a'.repeat(32)}"
PACKAGE_OPERATION_STATE="$OPERATION_STATE"
if reap_recorded_package_operation; then rc=0; else rc=$?; fi
if [ -n "$PACKAGE_OPERATION" ]; then retained=yes; else retained=no; fi
printf 'rc=%s retained=%s\\n' "$rc" "$retained"
`;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-package-reap-'));
  const trace = path.join(fixture, 'trace');
  let result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPERATION_STATE: 'prepared',
      REMOVE_RESULT: '0',
      TRACE: trace,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 retained=no/);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    `/data/local/tmp/evogent-package-op.${'a'.repeat(32)}\n`,
  );

  result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPERATION_STATE: 'prepared',
      REMOVE_RESULT: '1',
      TRACE: trace,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 retained=yes/);

  fs.rmSync(trace, { force: true });
  result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPERATION_STATE: 'launched',
      REMOVE_RESULT: '0',
      TRACE: trace,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 retained=yes/);
  assert.equal(fs.existsSync(trace), false);
});

test('rollback retains its journal until the private token bridge is gone', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const helper = shellFunction(installer, 'reap_recorded_control_token_bridge');
  const harness = `
set -uo pipefail
${helper}
say() { :; }
remove_shell_staging_file() {
  printf '%s\\n' "$1" > "$TRACE"
  return "$REMOVE_RESULT"
}
CONTROL_TOKEN_BRIDGE="/data/local/tmp/evogent-control-token.${'b'.repeat(32)}/payload"
if reap_recorded_control_token_bridge; then rc=0; else rc=$?; fi
if [ -n "$CONTROL_TOKEN_BRIDGE" ]; then retained=yes; else retained=no; fi
printf 'rc=%s retained=%s\\n' "$rc" "$retained"
`;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-token-reap-'));
  const trace = path.join(fixture, 'trace');
  let result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, REMOVE_RESULT: '0', TRACE: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 retained=no/);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    `/data/local/tmp/evogent-control-token.${'b'.repeat(32)}/payload\n`,
  );

  result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, REMOVE_RESULT: '1', TRACE: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=1 retained=yes/);
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
        PACKAGE_OPERATION: '',
        PACKAGE_OPERATION_LAUNCH_UNRESOLVED: '0',
        PACKAGE_OPERATION_STATE: '',
        QUIESCE_RESULT: '1',
        REARM_PRIOR_CONTROL_PLANE: '0',
        ROLLBACK_ATTEMPTED: '0',
        ROLLBACK_FAILED: '0',
        STOP_RESULT: '0',
        SWITCH_STARTED: scenario.switchStarted,
        TRANSACTION_PHASE: 'prepared',
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
  const cleanup = shellFunction(installer, 'cleanup');
  assert.match(
    cleanup,
    /if \[ -n "\$PREVIOUS_TARGET" \]; then[\s\S]*safe_private_program "\$previous_boot"[\s\S]*elif safe_private_program "\$HOME\/phone-tools\/evogent-boot[.]sh"; then/,
  );
  assert.doesNotMatch(
    cleanup,
    /\[ -x "\$HOME\/phone-tools\/evogent-boot[.]sh" \]/,
  );
  const releaseInstallLock = cleanup.indexOf('release_lock_dir "$INSTALL_LOCK"');
  const rearm = cleanup.indexOf(
    'if [ "$REARM_PRIOR_CONTROL_PLANE" = 1 ]',
  );
  const retire = cleanup.indexOf(
    'if retire_rolled_back_transaction_journal; then',
    rearm,
  );
  assert.ok(
    rearm !== -1
      && retire > rearm
      && releaseInstallLock > retire,
  );
});

test('cleanup rearms legacy and versioned predecessors through their exact safe boot programs', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const safeProgram = shellFunction(installer, 'safe_private_program');
  const cleanup = shellFunction(installer, 'cleanup');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-cleanup-rearm-'));
  const home = path.join(fixture, 'home');
  const legacyBoot = path.join(home, 'phone-tools/evogent-boot.sh');
  const previous = path.join(fixture, 'releases/release-previous');
  const previousBoot = path.join(previous, 'phone-tools/evogent-boot.sh');
  const journal = path.join(fixture, 'journal.json');
  const trace = path.join(fixture, 'trace');
  fs.mkdirSync(path.dirname(legacyBoot), { recursive: true });
  fs.mkdirSync(path.dirname(previousBoot), { recursive: true });
  fs.writeFileSync(journal, '{}\n', { mode: 0o600 });
  fs.writeFileSync(previousBoot, 'versioned boot fixture\n', { mode: 0o555 });
  fs.chmodSync(previousBoot, 0o555);

  const harness = `
set -uo pipefail
${safeProgram}
${cleanup}
record() { printf '%s\\n' "$1" >> "$TRACE"; }
say() { :; }
is_real_release_target() { record "target:$1"; return 0; }
SERVER=0
set_tmux_control_release_root() {
  [ "$SERVER" = 1 ] || return 1
  record "release-root:$1"
}
bash() {
  record "bash:$1"
  SERVER=1
}
wait_for_authenticated_release_control_plane() {
  record "wait:$1"
  return 0
}
rearm_legacy_server() { record legacy-server; return 0; }
rearm_legacy_control_plane() { record legacy-control; return 0; }
retire_rolled_back_transaction_journal() { record retire; return 0; }
release_lock_dir() { record unlock; return 0; }
remove_transaction_recoverer() { :; }
prune_orphan_migrations() { :; }
HOME="$1"
TRACE="$2"
TRANSACTION_JOURNAL="$3"
PREVIOUS_TARGET="$4"
INSTALL_LOCK="$HOME/install.lock"
CYCLE_GATE_HELD=0
CONTROL_MUTATION_GATE_HELD=0
STAGE=""
INSTALL_LOCK_HELD=1
DEPENDENCY_STATE_HELPER=""
DEPENDENCY_BUILD=""
REARM_PRIOR_CONTROL_PLANE=1
ROLLBACK_DECISION_DURABLE=1
TRANSACTION_PHASE=rolled_back
LEGACY_CONTROL_PLANE_EXPECTED=1
SUCCESS=1
RECOVERY_ACTIVE=1
cleanup
`;
  function run(previousTarget) {
    fs.rmSync(trace, { force: true });
    return spawnSync(
      'bash',
      ['-c', harness, 'cleanup-rearm', home, trace, journal, previousTarget],
      { encoding: 'utf8' },
    );
  }

  let result = run(previous);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    `target:${previous}\n`
      + `bash:${previousBoot}\n`
      + `release-root:${previous}\n`
      + `wait:${previous}\n`
      + 'retire\n'
      + 'unlock\n',
  );

  fs.writeFileSync(legacyBoot, 'legacy boot fixture\n', { mode: 0o600 });
  fs.chmodSync(legacyBoot, 0o600);
  result = run('');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(trace, 'utf8'),
    'legacy-server\nlegacy-control\nretire\nunlock\n',
  );
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
  assert.match(result.stdout, /rc=0 calls=3/);
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
FORWARD_SUPERSEDE=0
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
  assert.equal(waiterExit.status, 0, waiterExit.stderr);
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
  const journalCommit = installer.lastIndexOf('\ncommit_new_release_decision ');
  const finalized = installer.indexOf(
    'finalize_committed_transaction_state',
    journalCommit,
  );
  const journalCleared = installer.indexOf(
    'clear_transaction_journal',
    finalized,
  );
  const gateReleased = installer.indexOf(
    'release_lock_dir "$CYCLE_GATE"',
    journalCleared,
  );
  assert.notEqual(journalCommit, -1);
  assert.notEqual(finalized, -1);
  assert.notEqual(journalCleared, -1);
  assert.notEqual(gateReleased, -1);
  assert.ok(journalCommit < finalized);
  assert.ok(finalized < journalCleared);
  assert.ok(journalCleared < gateReleased);
  const transactionCommit = shellFunction(
    installer,
    'commit_new_release_decision',
  );
  const signalsMasked = transactionCommit.indexOf("trap '' INT TERM HUP");
  const journalPublished = transactionCommit.indexOf(
    'write_transaction_journal committed',
  );
  const committed = transactionCommit.indexOf('COMMITTED=1');
  const signalsRestored = transactionCommit.indexOf("trap 'exit 130' INT");
  assert.ok(signalsMasked >= 0);
  assert.ok(signalsMasked < journalPublished);
  assert.ok(journalPublished < committed);
  assert.ok(committed < signalsRestored);
  const committedFinalizer = shellFunction(
    installer,
    'finalize_committed_transaction_state',
  );
  assert.match(committedFinalizer, /reclaim-legacy/);
  assert.match(committedFinalizer, /candidate-clear/);
  assert.match(committedFinalizer, /prune_committed_migration/);
  assert.match(
    installer,
    /restore_planned_runtime_component \\\n    nodeModules "\$holder" node_modules "\$STATE\/node_modules"/,
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
  assert.match(
    builder,
    /tar --no-xattrs -czf "\$ARCHIVE"[\s\S]*chmod 600 "\$ARCHIVE"/,
  );
  assert.match(builder, /chmod 600 "\$ARCHIVE\.sha256"/);
  assert.match(deploy, /set -euo pipefail\s+umask 077/);
  assert.match(deploy, /nofollow = getattr\(os, "O_NOFOLLOW", 0\)/);
  assert.match(
    deploy,
    /source_fd = os\.open\(\s*source,\s*os\.O_RDONLY \| nofollow \| getattr\(os, "O_CLOEXEC", 0\),\s*\)/,
  );
  assert.match(deploy, /os\.fchmod\(source_fd, 0o600\)/);
  assert.match(deploy, /os\.fchmod\(destination_fd, 0o600\)/);
  assert.match(
    deploy,
    /incoming_fd = open_owned_directory\([\s\S]*?exact_mode=0o700/,
  );
  assert.match(
    deploy,
    /archive_fd = checked_open\(leaf_fd, archive_name, 0o600\)/,
  );
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

test('release packages every device helper referenced by the installer', () => {
  const builder = fs.readFileSync(
    path.join(root, 'scripts/build-phone-release.sh'),
    'utf8',
  );
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const referencedHelpers = new Set(
    Array.from(
      installer.matchAll(
        /\$(?:EXTRACTED|NEW_RELEASE)\/device\/([A-Za-z0-9][A-Za-z0-9._-]*)/g,
      ),
      (match) => match[1],
    ),
  );
  assert.ok(referencedHelpers.has('android-role-state.py'));
  assert.ok(referencedHelpers.has('attest-install-review.py'));

  const deviceArchive = builder.match(
    /git archive "\$SOURCE_COMMIT":phone-paradigm\/device\/phone-tools \\\n  \| tar -xf - -C "\$RELEASE\/phone-tools"\ngit archive "\$SOURCE_COMMIT" \\\n([\s\S]*?)  \| tar --strip-components=2 -xf - -C "\$RELEASE\/device"/,
  );
  assert.ok(deviceArchive, 'missing committed device archive allowlist');
  const archivedHelpers = new Set(
    Array.from(
      deviceArchive[1].matchAll(/phone-paradigm\/device\/([A-Za-z0-9][A-Za-z0-9._-]*)/g),
      (match) => match[1],
    ),
  );

  const requiredPaths = builder.match(
    /"requiredPaths": \[([\s\S]*?)\n    \],/,
  );
  assert.ok(requiredPaths, 'missing release manifest requiredPaths');
  const requiredHelpers = new Set(
    Array.from(
      requiredPaths[1].matchAll(/"device\/([A-Za-z0-9][A-Za-z0-9._-]*)"/g),
      (match) => match[1],
    ),
  );

  for (const helper of referencedHelpers) {
    assert.ok(archivedHelpers.has(helper), `${helper} is absent from the device archive`);
    assert.ok(requiredHelpers.has(helper), `${helper} is absent from requiredPaths`);
  }
});

test('an absent current pointer remains an initial migration when readlink -f accepts it', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const preflight = installer.match(
    /CURRENT_RESOLVED=""\n([\s\S]*?)\nEXPECTED_APK_CODE=/,
  );
  assert.ok(preflight, 'missing current-release preflight block');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-missing-current-'));
  const fakeBin = path.join(fixture, 'bin');
  const trace = path.join(fixture, 'readlink.trace');
  fs.mkdirSync(fakeBin);
  const fakeReadlink = path.join(fakeBin, 'readlink');
  fs.writeFileSync(
    fakeReadlink,
    '#!/bin/sh\nprintf "%s\\n" "$1" > "$READLINK_TRACE"\nprintf "%s\\n" "$1"\n',
    { mode: 0o755 },
  );
  const harness = `
set -u
CURRENT="$1/current"
STATE="$1/state"
PHONE_STATE="$STATE/phone-tools"
HOME="$1/home"
PREVIOUS_TARGET="unset"
CURRENT_RESOLVED=""
say() { printf '%s\\n' "$*" >&2; }
is_real_release_target() { return 0; }
release_dispatch_matches_target() { return 1; }
${preflight[1]}
printf 'current=<%s> previous=<%s>\\n' "$CURRENT_RESOLVED" "$PREVIOUS_TARGET"
`;
  const result = spawnSync(
    'bash',
    ['-c', harness, 'missing-current', fixture],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        READLINK_TRACE: trace,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'current=<> previous=<>\n');
  assert.equal(fs.existsSync(trace), false);
});

test('changed APK predecessor identity fails before journal or package authority', () => {
  const installer = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/install-release.sh'),
    'utf8',
  );
  const changed = installer.match(
    /(if \[ "\$CURRENT_APK_SHA256" != "\$EXPECTED_APK_SHA256" \]; then[\s\S]*?\nfi)\nif \[ "\$CURRENT_RESOLVED"/,
  );
  assert.ok(changed, 'missing changed-APK predecessor gate');
  const identityGate = installer.indexOf(
    'changed APK predecessor identity is invalid',
  );
  const firstJournal = installer.indexOf(
    '\nprepare_transaction_recoverer\n',
    identityGate,
  );
  const packageLaunch = installer.indexOf(
    'install_apk "$NEW_RELEASE/apk/evogent.apk" upgrade',
    identityGate,
  );
  assert.ok(
    identityGate >= 0
      && identityGate < firstJournal
      && firstJournal < packageLaunch,
  );

  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evogent-predecessor-identity-'),
  );
  const trace = path.join(fixture, 'trace');
  const harness = `
set -uo pipefail
say() { :; }
package_manager_supports_apk_rollback() {
  printf 'rollback-support\\n' >> "$TRACE"
}
CURRENT_APK_SHA256=old
EXPECTED_APK_SHA256=new
EXPECTED_APK_CODE=8
INSTALLED_APK_CODE="$CODE"
INSTALLED_APK_SIGNER="$SIGNER"
APK_CHANGED=0
${changed[1]}
printf 'changed=%s\\n' "$APK_CHANGED"
`;
  function run(code, signer) {
    fs.rmSync(trace, { force: true });
    return spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODE: code,
        SIGNER: signer,
        TRACE: trace,
      },
    });
  }
  for (const code of ['', '0', '01', '9223372036854775808']) {
    const result = run(code, 'a'.repeat(64));
    assert.equal(result.status, 65, result.stderr);
    assert.equal(fs.existsSync(trace), false);
  }
  for (const signer of ['', 'a'.repeat(63), 'A'.repeat(64)]) {
    const result = run('7', signer);
    assert.equal(result.status, 65, result.stderr);
    assert.equal(fs.existsSync(trace), false);
  }
  const valid = run('7', 'a'.repeat(64));
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, 'changed=1\n');
  assert.equal(fs.readFileSync(trace, 'utf8'), 'rollback-support\n');
});

test('boot recovery preserves the recovered contract and binds tmux release identity', () => {
  const boot = fs.readFileSync(
    path.join(
      root,
      'phone-paradigm/device/phone-tools/evogent-boot.sh',
    ),
    'utf8',
  );
  assert.match(
    boot,
    /bash "\$INSTALL_RECOVERER" --recover[\s\S]*?# The pinned recoverer[\s\S]*?exit 0\s+fi/,
  );
  const identity = boot.indexOf(
    'tmux set-environment -g EVOGENT_CONTROL_RELEASE_ROOT',
  );
  const scheduler = boot.indexOf('tmux new -d -s evo-sched');
  assert.ok(identity !== -1 && identity < scheduler);
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
  assert.match(builder, /config\["outputFileTracingRoot"\] = "\."/);
  assert.match(builder, /turbopack\["root"\] = "\."/);
  assert.match(builder, /export COPYFILE_DISABLE=1/);
  assert.match(builder, /tar --no-xattrs -czf "\$ARCHIVE"/);
  assert.match(builder, /pure\.parts\[0\] != "release"/);
  assert.match(builder, /phone release: unsafe archive member/);
  assert.match(builder, /EVOGENT_RELEASE_PRIVATE_MARKERS_FILE/);
  assert.match(
    builder,
    /git archive "\$SOURCE_COMMIT":phone-paradigm\/device\/phone-tools/,
  );
  assert.doesNotMatch(
    builder,
    /cp -R "\$ROOT\/phone-paradigm\/device\/phone-tools/,
  );
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

test('rollback-state requires positive proof that the exact rollback was consumed', () => {
  const command = (dump, mode = 'require-consumed') => spawnSync(
    'python3',
    [
      rollbackStateHelper,
      mode,
      'com.example.evogent',
      '8',
      '7',
    ],
    { encoding: 'utf8', input: dump },
  );
  const record = (state, id = 123, session = 42, packageName = 'com.example.evogent') => `
  ${id}:
    -state: ${state}
    -isStaged: false
    -originalSessionId: ${session}
    -packages:
      ${packageName} 8 -> 7 [0]
${state === 'committed' ? `    -committedSessionId: ${session + 1000}\n` : ''}
`;
  const dump = (active, historical) => `${active}
Historical rollbacks:
${historical}
Package Watchdog status
  watchdog details that are outside rollback authority
`;
  assert.equal(command(dump(record('committed'), '')).status, 0);
  assert.equal(command(dump('', record('deleted'))).status, 0);
  assert.notEqual(command(dump(record('available'), '')).status, 0);
  assert.notEqual(
    command(dump(`${record('committed')}
  124:
    -state: available
    -isStaged: true
    -originalSessionId: 43
    -packages:
      com.example.evogent 8 -> 7 [0]
`, '')).status,
    0,
  );
  assert.notEqual(
    command(dump(`${record('committed')}
  125:
    -state: available
    -isStaged: false
    -originalSessionId: 44
    -packages:
      com.example.evogent 8 -> 7 [0]
      com.example.companion 4 -> 3 [0]
`, '')).status,
    0,
  );
  assert.notEqual(
    command(dump(`${record('committed')}
  126:
    -state: committed
    -isStaged: false
    -originalSessionId: 45
    -packages:
      com.example.evogent 8 -> 7 [0]
      malformed competing package row
`, '')).status,
    0,
  );
  const duplicateState = `
  123:
    -state: available
    -state: committed
    -isStaged: false
    -originalSessionId: 42
    -packages:
      com.example.evogent 8 -> 7 [0]
`;
  assert.notEqual(command(dump(duplicateState, '')).status, 0);
  const duplicatePackages = `
  123:
    -state: committed
    -isStaged: false
    -originalSessionId: 42
    -packages:
      com.example.evogent 8 -> 7 [0]
    -packages:
`;
  assert.notEqual(command(dump(duplicatePackages, '')).status, 0);
  const duplicateRow = `
  123:
    -state: committed
    -isStaged: false
    -originalSessionId: 42
    -packages:
      com.example.evogent 8 -> 7 [0]
      com.example.evogent 8 -> 7 [0]
`;
  assert.notEqual(command(dump(duplicateRow, '')).status, 0);
  assert.equal(
    command(dump('', `${record('deleted', 123, 42)}${record('deleted', 124, 43)}`)).status,
    0,
  );
  assert.notEqual(
    command(dump('', `${record('deleted', 123, 42)}${record('deleted', 123, 43)}`)).status,
    0,
  );
  assert.notEqual(
    command(dump('', `${record('deleted', 123, 42)}${record('deleted', 124, 42)}`)).status,
    0,
  );
  assert.equal(
    command(duplicateState.replace('committed', 'available'), 'check').status,
    0,
    'ordinary availability checking retains its existing permissive parser',
  );
  assert.notEqual(command('').status, 0);
});

test('rollback-state accepts the framed Pixel dump while rejecting target authority drift', () => {
  const command = (dump) => spawnSync(
    'python3',
    [
      rollbackStateHelper,
      'require-consumed',
      'com.example.evogent',
      '8',
      '0',
    ],
    { encoding: 'utf8', input: dump },
  );
  const activeMainline = (id, session, packageName) => `${id}:
 -state: enabling
 -stateDescription:
 -timestamp: 2030-01-01T00:00:00Z
 -rollbackLifetimeMillis: 1209600000
 -isStaged: true
 -originalSessionId: ${session}
 -packages:
  ${packageName} 20 -> 19 [0]
 -extensionVersions:
  {30=20, 31=20, 1000000=20}
`;
  const expiredTarget = (id, session) => ` ${id}:
  -state: deleted
  -stateDescription: Expired by API
  -timestamp: 2030-01-01T00:00:00Z
  -rollbackLifetimeMillis: 1209600000
  -isStaged: false
  -originalSessionId: ${session}
  -packages:
   com.example.evogent 8 -> 0 [0]
  -extensionVersions:
   {30=20, 31=20, 1000000=20}
`;
  const framed = (active, historical) => `${active}
Historical rollbacks:
${historical}
Package Watchdog status
  999:
    watchdog data must not become a rollback
`;
  const live = framed(
    `${activeMainline(1, 101, 'com.android.module.one')}${activeMainline(2, 102, 'com.android.module.two')}${activeMainline(3, 103, 'com.android.module.three')}`,
    `${expiredTarget(11, 201)}${expiredTarget(12, 202)}
 13:
  -state: deleted
  -stateDescription: Expired by API
  -timestamp: 2030-01-01T00:00:00Z
  -rollbackLifetimeMillis: 1209600000
  -isStaged: false
  -originalSessionId: 203
  -packages:
   com.android.module.four 20 -> 19 [0]
  -extensionVersions:
   {30=20, 31=20, 1000000=20}
`,
  );
  assert.equal(command(live).status, 0);
  for (const [label, rejected] of [
    ['available target', live.replace('-state: deleted', '-state: available')],
    ['staged target', live.replace('-isStaged: false', '-isStaged: true')],
    ['wrong target version', live.replace('8 -> 0', '8 -> 1')],
    ['multi-package target', live.replace(
      'com.example.evogent 8 -> 0 [0]',
      'com.example.evogent 8 -> 0 [0]\n   com.example.companion 2 -> 1 [0]',
    )],
    ['duplicate extension SDK', live.replace(
      '{30=20, 31=20, 1000000=20}',
      '{30=20, 30=21}',
    )],
    ['zero target session', live.replace(
      '-originalSessionId: 201',
      '-originalSessionId: 0',
    )],
    ['duplicate scalar', live.replace(
      '-stateDescription: Expired by API',
      '-stateDescription: Expired by API\n  -stateDescription: duplicate',
    )],
    ['unknown target field', live.replace(
      '-stateDescription: Expired by API',
      '-stateDescription: Expired by API\n  -unknownAuthority: com.example.evogent',
    )],
    ['duplicate cause section', live.replace(
      '-stateDescription: Expired by API',
      '-stateDescription: Expired by API\n  -causePackages:\n  -causePackages:',
    )],
    ['historical framing', live.replace(
      'Historical rollbacks:',
      'Historical rollback records:',
    )],
    ['watchdog framing', live.replace(
      'Package Watchdog status',
      'Package Watchdog status:',
    )],
  ]) {
    assert.notEqual(command(rejected).status, 0, label);
  }
});
