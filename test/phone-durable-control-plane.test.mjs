import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'phone-paradigm', 'device', 'phone-tools');

function read(name) {
  return fs.readFileSync(path.join(tools, name), 'utf8');
}

function shellFunction(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => (
    line === `${name}(){` || line === `${name}() {`
  ));
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

function runControlFunction(name, input, args = []) {
  const result = spawnSync(
    'bash',
    ['-c', '. "$CONTROL_PLANE"; "$CONTROL_FUNCTION" "$@"', 'control-test', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTROL_PLANE: path.join(tools, 'control-plane.sh'),
        CONTROL_FUNCTION: name,
      },
      input,
    },
  );
  return result;
}

function runWatchdogSuccessReference(successStamp, missingBaseline, nowSeconds, overdueMinutes = 780) {
  const result = spawnSync(
    'bash',
    ['-c', `
set -u
SUCCESS_REFERENCE_RECORD="$(python3 "$TIMING" \
  --watchdog-success-stamp "$SUCCESS_STAMP" \
  --watchdog-missing-baseline "$MISSING_BASELINE" \
  --watchdog-overdue-minutes "$OVERDUE_MINUTES" \
  --now-seconds "$NOW_SECONDS")"
IFS=$'\\t' read -r SUCCESS_REFERENCE_PATH SUCCESS_REFERENCE_OVERDUE \
  <<< "$SUCCESS_REFERENCE_RECORD"
printf '%s\\t%s\\n' "$SUCCESS_REFERENCE_PATH" "$SUCCESS_REFERENCE_OVERDUE"
`],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        TIMING: path.join(tools, 'scheduler_timing.py'),
        SUCCESS_STAMP: successStamp,
        MISSING_BASELINE: missingBaseline,
        NOW_SECONDS: String(nowSeconds),
        OVERDUE_MINUTES: String(overdueMinutes),
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const [reference, overdue] = result.stdout.trim().split('\t');
  return { reference, overdue };
}

test('Python durability, collection, and live-geometry unit tests pass', () => {
  const result = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', path.join(tools, 'tests'), '-p', 'test_*.py'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('display-0 foreground parser ignores hidden displays and accepts dumpsys variants', () => {
  const pixel = runControlFunction(
    'control_display_zero_top_resumed_from_dump',
    `Display #0 (activities from top to bottom):
  topResumedActivity=ActivityRecord{123 u0 com.example.reader/.MainActivity t42}
Display #7 (activities from top to bottom):
  topResumedActivity=ActivityRecord{456 u0 com.twitter.android/.StartActivity t91}
`,
  );
  assert.equal(pixel.status, 0, pixel.stderr);
  assert.equal(pixel.stdout.trim(), 'com.example.reader');

  const alternate = runControlFunction(
    'control_display_zero_top_resumed_from_dump',
    `Display 0:
  mResumedActivity: ActivityRecord{abc u10 net.dangish.evogent/net.dangish.evogent.MainActivity t8}
Display 12:
  mResumedActivity: ActivityRecord{def u0 com.instagram.android/.activity.MainTabActivity t9}
`,
  );
  assert.equal(alternate.status, 0, alternate.stderr);
  assert.equal(alternate.stdout.trim(), 'net.dangish.evogent');
});

test('display-0 foreground parser fails closed on missing or ambiguous activity state', () => {
  const missing = runControlFunction(
    'control_display_zero_top_resumed_from_dump',
    `Display #0 (activities from top to bottom):
  topDisplayFocusedRootTask=Task{123 type=home}
`,
  );
  assert.notEqual(missing.status, 0);

  const ambiguous = runControlFunction(
    'control_display_zero_top_resumed_from_dump',
    `Display #0 (activities from top to bottom):
  topResumedActivity=ActivityRecord{123 u0 com.example.one/.MainActivity t42}
  mResumedActivity: ActivityRecord{456 u0 com.example.two/.MainActivity t43}
`,
  );
  assert.notEqual(ambiguous.status, 0);
});

test('wake and lockscreen parsers normalize variants and reject contradictory or missing state', () => {
  assert.equal(
    runControlFunction('control_screen_wake_state_from_dump', '  mWakefulness=Awake\n').stdout.trim(),
    'awake',
  );
  assert.equal(
    runControlFunction('control_screen_wake_state_from_dump', '  mWakefulness=1\n').stdout.trim(),
    'awake',
  );
  assert.equal(
    runControlFunction('control_screen_wake_state_from_dump', '  mInteractive=false\n').stdout.trim(),
    'not-awake',
  );
  assert.equal(
    runControlFunction(
      'control_screen_wake_state_from_dump',
      '  mWakefulness=Awake\n  mInteractive=false\n',
    ).stdout.trim(),
    'unknown',
  );
  assert.equal(
    runControlFunction('control_screen_wake_state_from_dump', 'unrelated=true\n').stdout.trim(),
    'unknown',
  );

  assert.equal(
    runControlFunction('control_lockscreen_state_from_dump', 'mDreamingLockscreen=false\n').stdout.trim(),
    'unlocked',
  );
  assert.equal(
    runControlFunction('control_lockscreen_state_from_dump', 'mKeyguardShowing=true\n').stdout.trim(),
    'locked',
  );
  assert.equal(
    runControlFunction(
      'control_lockscreen_state_from_dump',
      'mDreamingLockscreen=false mShowingLockscreen=true\n',
    ).stdout.trim(),
    'unknown',
  );
  assert.equal(
    runControlFunction('control_lockscreen_state_from_dump', 'mShowingDream=false\n').stdout.trim(),
    'unknown',
  );
});

test('hidden launch verdict permits only proved unattended or exact different-package states', () => {
  const verdict = (...args) =>
    runControlFunction('control_hidden_launch_verdict', '', args).stdout.trim();
  assert.equal(verdict('not-awake', 'unknown', '', 'com.twitter.android'), 'safe-unattended');
  assert.equal(verdict('unknown', 'locked', '', 'com.twitter.android'), 'safe-locked');
  assert.equal(
    verdict('awake', 'unlocked', 'com.example.reader', 'com.twitter.android'),
    'safe-different-app',
  );
  assert.equal(
    verdict('awake', 'unlocked', 'com.twitter.android', 'com.twitter.android'),
    'refuse-active-target',
  );
  assert.equal(verdict('awake', 'unlocked', '', 'com.twitter.android'), 'refuse-unproven');
  assert.equal(verdict('unknown', 'unlocked', 'com.example.reader', 'com.twitter.android'), 'refuse-unproven');
  assert.equal(verdict('awake', 'unknown', 'com.example.reader', 'com.twitter.android'), 'refuse-unproven');
});

test('hidden-display discovery rejects physical, substring, missing, and ambiguous matches', () => {
  const windows = `WINDOWS getWindows() count=1
  win id=1 display=0 type=1 pkg=com.twitter.android
getWindowsOnAllDisplays() displays=2
  display 0 windows=1
    win id=1 pkg=com.twitter.android
  display 14 windows=2
    win id=8 pkg=com.example.reader
    win id=9 pkg=com.twitter.android
`;
  const hidden = runControlFunction(
    'control_hidden_display_for_package_from_windows_dump',
    windows,
    ['com.twitter.android'],
  );
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stdout.trim(), '14');

  const physicalOnly = runControlFunction(
    'control_hidden_display_for_package_from_windows_dump',
    `  display 0 windows=1
    win id=1 pkg=com.twitter.android
`,
    ['com.twitter.android'],
  );
  assert.notEqual(physicalOnly.status, 0);

  const substring = runControlFunction(
    'control_hidden_display_for_package_from_windows_dump',
    `  display 9 windows=1
    win id=1 pkg=com.twitter.android.beta
`,
    ['com.twitter.android'],
  );
  assert.notEqual(substring.status, 0);

  const ambiguous = runControlFunction(
    'control_hidden_display_for_package_from_windows_dump',
    `  display 9 windows=1
    win id=1 pkg=com.twitter.android
  display 11 windows=1
    win id=2 pkg=com.twitter.android
`,
    ['com.twitter.android'],
  );
  assert.notEqual(ambiguous.status, 0);
});

test('text taps require an authenticated performed result before reporting success', () => {
  const phone = read('phone.sh');
  assert.doesNotMatch(phone, /cat "\$DISPFILE" 2>\/dev\/null \|\| echo 0/);
  assert.ok(phone.includes('[[ ! "$display" =~ ^[1-9][0-9]*$ ]]'));
  const tapCase = phone.slice(phone.indexOf('  tap)'), phone.indexOf('  scroll)'));
  assert.match(tapCase, /a11y_grab --es op clicktext/);
  assert.match(tapCase, /\[ "\$CLICK_RESULT" != "performed" \]/);
  assert.doesNotMatch(tapCase, /a11y_fire --es op clicktext/);

  const service = fs.readFileSync(
    path.join(
      root,
      'android-shell',
      'src',
      'net',
      'dangish',
      'evogent',
      'EvogentAccessibilityService.java',
    ),
    'utf8',
  );
  const clickCase = service.slice(
    service.indexOf('case "clicktext"'),
    service.indexOf('case "makedisplay"'),
  );
  assert.match(clickCase, /String clickResult = clickTextOnDisplay/);
  assert.match(clickCase, /sendToLocalAgent\(reply, clickResult\)/);
});

test('all phone-runtime force-stops pass through the physical-screen safety proof', () => {
  const control = read('control-plane.sh');
  const cycle = read('evogent-cycle.sh');
  const interests = read('browse-interests.py');
  const micro = read('benchmark-cu-micro.sh');
  const browseBenchmark = read('benchmark-browse-models.sh');

  assert.match(control, /control_safe_force_stop_package\(\)/);
  assert.match(control, /control_display_zero_top_resumed_from_dump/);
  assert.match(cycle, /control_safe_force_stop_package "\$pkg"/);
  assert.doesNotMatch(cycle, /control_rish_bounded "am force-stop \$pkg"/);
  assert.doesNotMatch(interests, /rish\(f?"am force-stop/);
  assert.match(interests, /sh\("stop", "com\.instagram\.android"\)/);
  assert.match(micro, /control_safe_force_stop_package com\.google\.android\.youtube/);
  assert.match(browseBenchmark, /control_safe_force_stop_package com\.google\.android\.youtube/);
});

test('shell CLI proof exercises queued, leased, retry, ack, and quarantine', () => {
  const result = spawnSync('bash', [path.join(root, 'test', 'phone-durable-task-queue.sh')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /shell test: ok/);
});

test('standing-interest browser gates cadence on durable submit and never orders the feed', () => {
  const source = read('browse-interests.py');
  const submitGate = source.indexOf('submit_persisted = True');
  const cadenceGate = source.indexOf('completed_ids = apply_submit_result(');
  assert.ok(submitGate >= 0 && cadenceGate > submitGate);
  assert.doesNotMatch(source, /UPDATE\s+feed\s+SET\s+display_order/i);
  assert.match(source, /interest-browse-outcomes\.json/);
  assert.match(read('interest_browse_runtime.py'), /cache_submit_failure/);
});

test('standing-interest Instagram taps derive from screenshot dimensions and report anomalies', () => {
  const source = read('browse-interests.py');
  assert.match(source, /png_dimensions\(geometry_shot\)/);
  assert.match(source, /derive_instagram_geometry\(width, height, rect\)/);
  assert.match(source, /instagram_grid_geometry_unavailable/);
  assert.doesNotMatch(source, /grid_top\s*\+\s*180/);
  assert.doesNotMatch(source, /"540",\s*"1700",\s*"540",\s*"500"/);
});

test('phone request consumers use a durable lease rather than remove-before-work', () => {
  const cycle = read('evogent-cycle.sh');
  const discovery = read('source-discovery.sh');
  assert.match(cycle, /durable_task_queue\.py/);
  assert.match(cycle, /claim --root "\$QUEUE_DIR"/);
  assert.match(cycle, /finish_queued_task "\$TASK_LEASE" retry/);
  assert.match(cycle, /source-discovery\.sh' --lease/);
  assert.doesNotMatch(cycle, /rm -f "\$NEXT_Q"/);
  assert.match(discovery, /finish_request ack discovery_fresh/);
  assert.match(discovery, /finish_request retry discovery_failure/);
});

test('phone scheduler acknowledges a request only after the exact validated curation receipt', () => {
  const scheduler = read('evogent-scheduler.sh');
  const cycle = read('evogent-cycle.sh');

  assert.match(scheduler, /phone-curation-" \+ str\(uuid\.uuid4\(\)\)/);
  assert.match(scheduler, /EVOGENT_CURATION_CYCLE_ID="\$CURATION_CYCLE_ID"/);
  assert.match(scheduler, /if \[ "\$CYCLE_RC" -eq 0 \]; then[\s\S]*control_ack_cycle_claims/);
  assert.match(scheduler, /request claim retained for retry/);
  assert.match(scheduler, /CYCLE_FAILURE_BACKOFF_STATE="\$TOOLS\/\.cycle-failure-backoff\.json"/);
  assert.match(scheduler, /--cycle-failure-action record-failure/);
  assert.match(scheduler, /--cycle-failure-action remaining/);
  assert.match(scheduler, /--cycle-failure-action clear/);
  assert.match(scheduler, /wait_for_persisted_cycle_failure_backoff/);
  assert.match(scheduler, /cycle retry is deferred/);
  assert.doesNotMatch(scheduler, /CYCLE_FAILURE_BACKOFF_SECONDS=/);
  assert.doesNotMatch(
    scheduler,
    /if \[ "\$CYCLE_RC" -ne 0 \]; then\s+sleep 60/,
  );

  assert.match(cycle, /"curationCycleId":sys\.argv\[4\]/);
  assert.match(cycle, /WHERE request_id=\?/);
  assert.match(cycle, /success\|successful_empty\)/);
  assert.match(cycle, /exact terminal receipt missing or failed/);
  assert.match(cycle, /CYCLE_RECEIPT_FAILED=1/);
  assert.match(cycle, /if \[ "\$CYCLE_RECEIPT_FAILED" = 1 \]; then[\s\S]*exit 76/);
  assert.doesNotMatch(cycle, /completion_status\s*=\s*['"]success['"][\s\S]*COUNT\(\*\).*feed/s);
});

test('one daily overseer replaces dream and reflection as the durable private due task', () => {
  const scheduler = read('evogent-scheduler.sh');
  const cycle = read('evogent-cycle.sh');
  assert.match(scheduler, /ensure-nightly --root "\$SCHEDULED_TASK_ROOT"/);
  assert.match(scheduler, /--task oversee/);
  assert.match(scheduler, /--kind oversee/);
  assert.match(scheduler, /claim --root "\$SCHEDULED_TASK_ROOT"/);
  assert.match(scheduler, /run_due_overseer \|\| true/);
  assert.doesNotMatch(scheduler, /run_due_(?:dream|reflection)|--task (?:dream|reflect)/);
  assert.match(scheduler, /finish --root "\$SCHEDULED_TASK_ROOT".*--result ack/s);
  assert.match(
    scheduler,
    /run_owned_timeout 1200 30 codex exec[\s\S]*--result quarantine --outcome overseer_failure/,
  );
  const spendMark = scheduler.indexOf('mark-provider-launch-spent');
  const providerCall = scheduler.indexOf('run_owned_timeout 1200 30 codex exec');
  assert.ok(spendMark >= 0 && providerCall > spendMark);
  assert.match(scheduler, /\[ "\$provider_spend_action" != "marked" \]/);
  assert.equal((scheduler.match(/codex exec --model "\$model"/g) || []).length, 1);
  assert.match(scheduler, /\[ "\$terminal_result" = "OVERSEER_RESULT completed" \]/);
  assert.match(scheduler, /resolve[\s\\]*\n[\s\S]{0,120}--task overseer/);
  assert.doesNotMatch(cycle, /DREAM_AGE|HOUR=.*date \+%H|overnight taste pass/);
  assert.doesNotMatch(cycle, /\.last-reflect|\/reflect\b|reflection age|opportunistic reflection/i);
});

test('daily provider spend and cycle retry cost guards fail closed across restarts', () => {
  const scheduler = read('evogent-scheduler.sh');
  const queue = read('durable_task_queue.py');
  const timing = read('scheduler_timing.py');

  assert.match(queue, /def mark_provider_launch_spent\(/);
  assert.match(queue, /provider_launch_spent_lease_expired/);
  assert.match(queue, /result == "retry" and _provider_launch_spent\(request\)/);
  assert.match(timing, /def record_cycle_failure\(/);
  assert.match(timing, /def cycle_failure_remaining_seconds\(/);
  assert.match(timing, /def clear_cycle_failure_backoff\(/);
  assert.match(timing, /MAX_CYCLE_FAILURE_STATE_BYTES = 512/);

  const contentionStart = scheduler.indexOf('if [ "$CYCLE_RC" -eq 75 ]; then');
  const expensiveStart = scheduler.indexOf('else', contentionStart);
  const failureEnd = scheduler.indexOf('continue', expensiveStart);
  assert.ok(contentionStart >= 0 && expensiveStart > contentionStart && failureEnd > expensiveStart);
  const contention = scheduler.slice(contentionStart, expensiveStart);
  const expensive = scheduler.slice(expensiveStart, failureEnd);
  assert.match(contention, /FAILURE_WAIT_SECONDS=60/);
  assert.doesNotMatch(contention, /record-failure/);
  assert.match(expensive, /--cycle-failure-action record-failure/);
  assert.match(expensive, /wait_for_persisted_cycle_failure_backoff/);
});

test('phone-native preference memory is canonical and overseer postconditions are bounded', () => {
  const cycle = read('evogent-cycle.sh');
  const scheduler = read('evogent-scheduler.sh');
  const oversee = fs.readFileSync(path.join(root, '.claude', 'commands', 'oversee.md'), 'utf8');
  for (const source of [cycle, scheduler, oversee]) {
    assert.doesNotMatch(source, /\.openclaw\/agents\/curator\/USER\.md/);
  }
  assert.doesNotMatch(cycle, /preference_insights_valid|private_artifact\.py/);
  assert.match(scheduler, /private_artifact\.py" snapshot[\s\S]*preference-insights\.md/);
  assert.match(scheduler, /private_artifact\.py" verify[\s\S]*--kind preference/);
  assert.match(scheduler, /source-cadence\.json[\s\S]*--kind cadence/);
  assert.match(oversee, /atomically rewrite both `data\/preference-insights\.md` and/);
  assert.match(oversee, /`data\/source-cadence\.json` even when their values remain unchanged/);
});

test('scheduled phone overseer reviews runtime state without doing host development work', () => {
  const oversee = fs.readFileSync(path.join(root, '.claude', 'commands', 'oversee.md'), 'utf8');
  const auditCore = fs.readFileSync(path.join(root, '.claude', 'shared', 'audit-core.md'), 'utf8');
  assert.match(oversee, /Do not edit product code/);
  assert.match(oversee, /Do not inspect git history or host-agent state/);
  assert.doesNotMatch(oversee, /Recent-merge audit|git show|data\/agent-receipts\.jsonl|\/root\/\.claude/);
  assert.doesNotMatch(oversee, /Code Audit Patterns/);
  assert.match(auditCore, /Scheduled phone curation and the daily overseer are runtime roles/);
  assert.match(auditCore, /Only a manual host audit may add product-code inspection/);
});

test('daily overseer owns the shared cross-cycle audit while legacy review commands stay manual', () => {
  const oversee = fs.readFileSync(path.join(root, '.claude', 'commands', 'oversee.md'), 'utf8');
  const reflect = fs.readFileSync(path.join(root, '.claude', 'commands', 'reflect.md'), 'utf8');
  const dream = fs.readFileSync(path.join(root, '.claude', 'commands', 'dream.md'), 'utf8');
  const auditCore = fs.readFileSync(path.join(root, '.claude', 'shared', 'audit-core.md'), 'utf8');

  assert.match(oversee, /audit-core\.md/);
  assert.match(oversee, /execute it in `overseer` mode/);
  assert.match(auditCore, /### `overseer`/);
  assert.match(auditCore, /one scheduler-owned daily\s+overseer/);
  assert.doesNotMatch(auditCore, /### `reflection`/);
  for (const legacy of [reflect, dream]) {
    assert.match(legacy, /unscheduled compatibility command/);
    assert.match(legacy, /scheduler runs one\s+daily `\/oversee` task/);
  }
  assert.match(reflect, /execute it in `overseer` mode/);
});

test('source cadence advances only after a completed terminal browse receipt', () => {
  const cycle = read('evogent-cycle.sh');
  assert.match(cycle, /source_cadence\.py/);
  assert.match(cycle, /--signal "\$signal"/);
  assert.match(cycle, /--signal-ack "\$signal_ack"/);
  assert.match(cycle, /--signal-ack "\$TOOLS\/\.last-source-signal-ack-\$src"/);
  assert.match(cycle, /source_browse_start_ns/);
  assert.match(cycle, /content-free notification signal overrides cadence/);
  assert.doesNotMatch(cycle, /payload_json LIKE.*phone-notification-listener/);
  assert.doesNotMatch(cycle, /\$\(\(\s*hours\s*\*\s*60/);
  assert.match(cycle, /Only a completed receipt can advance source cadence/);
  assert.match(cycle, /SELECT COUNT\(\*\) FROM browse_cache_items[\s\S]*fetched_at_ms>=\?/);
  assert.match(cycle, /not the worker's self-reported itemsAdded field/);
  assert.match(cycle, /partial harvest retained, but cadence remains due[\s\S]*return 1/);
  assert.match(cycle, /if browse_source "\$src" "\$prompt_file" "\$budget"; then[\s\S]*mark_browsed "\$src"/);
  assert.doesNotMatch(cycle, /browse_source youtube[^\\n]*;[^\\n]*mark_browsed youtube/);

  const recipeLoop = cycle.slice(
    cycle.indexOf('for rf in "$EVO"/data/phone-sources/*.py'),
    cycle.indexOf('# CRITICAL memory hygiene'),
  );
  assert.ok(recipeLoop.length > 0);
  assert.ok(recipeLoop.indexOf('harvest_watch "$rsrc"') < recipeLoop.indexOf('mark_browsed "$rsrc"'));
  assert.doesNotMatch(recipeLoop, /src_due "\$rsrc" \|\| continue\s+mark_browsed/);

  const hackerNewsBlock = cycle.slice(
    cycle.indexOf('if src_due hackernews'),
    cycle.indexOf('if src_due twitter'),
  );
  assert.ok(hackerNewsBlock.indexOf('harvest_watch hackernews') < hackerNewsBlock.indexOf('mark_browsed hackernews'));
  const twitterBlock = cycle.slice(
    cycle.indexOf('if src_due twitter'),
    cycle.indexOf('browse_due_source youtube'),
  );
  assert.ok(twitterBlock.indexOf('harvest_watch twitter') < twitterBlock.indexOf('mark_browsed twitter'));
});

test('cadence helper execution and parse failures defer every source without browsing', () => {
  const cycle = read('evogent-cycle.sh');
  const helpers = [
    shellFunction(cycle, 'cadence_helper_defer'),
    shellFunction(cycle, 'src_due'),
  ].join('\n');
  const fixture = fs.mkdtempSync(path.join(
    process.env.TMPDIR || '/tmp',
    'evogent-cadence-helper-failure-',
  ));
  const fakeBin = path.join(fixture, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'python3'), `#!/bin/sh
case "$FAKE_CADENCE_MODE" in
  exit) exit 70 ;;
  malformed) printf '1\\t6\\telapsed\\nunexpected\\n' ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  const harness = `
set -u
${helpers}
say() { printf 'log:%s\\n' "$*" >> "$TRACE"; }
control_status_write() { printf 'status:%s\\n' "$*" >> "$TRACE"; }
TOOLS="$FIXTURE/tools"
EVO="$FIXTURE/evogent"
CYCLE_DEGRADED=0
: > "$TRACE"
for source in hackernews twitter youtube substack gmail instagram; do
  if src_due "$source"; then
    printf 'browse:%s\\n' "$source" >> "$TRACE"
  fi
done
printf 'degraded:%s\\n' "$CYCLE_DEGRADED" >> "$TRACE"
`;

  try {
    for (const mode of ['exit', 'malformed']) {
      const trace = path.join(fixture, `trace-${mode}`);
      const result = spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
          FAKE_CADENCE_MODE: mode,
          FIXTURE: fixture,
          TRACE: trace,
        },
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const lines = fs.readFileSync(trace, 'utf8').trim().split('\n');
      assert.equal(lines.some((line) => line.startsWith('browse:')), false);
      assert.equal(
        lines.filter((line) => (
          line.startsWith('status:sources ')
          && line.includes(' degraded cadence_helper_failure 0 70 ')
          && line.endsWith('cadence helper unavailable; browse deferred')
        )).length,
        6,
      );
      assert.equal(
        lines.filter((line) => (
          line.startsWith('log:source-browse[')
          && line.endsWith('cadence decision unavailable — browsing deferred')
        )).length,
        6,
      );
      assert.equal(lines.at(-1), 'degraded:1');
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('public cadence bootstrap is nonzero and source-specific', () => {
  const defaults = JSON.parse(
    fs.readFileSync(path.join(root, 'data', 'source-cadence.default.json'), 'utf8'),
  );
  const entries = Object.entries(defaults)
    .filter(([source]) => !source.startsWith('_'))
    .map(([, value]) => value);
  assert.ok(entries.length > 1);
  const hours = entries.map((entry) => Number(entry.cadenceHours));
  assert.ok(hours.every((value) => Number.isFinite(value) && value > 0));
  assert.ok(new Set(hours).size > 1);
});

test('successful-cycle timing is independent from every-attempt productivity', () => {
  const cycle = read('evogent-cycle.sh');
  const scheduler = read('evogent-scheduler.sh');
  const watchdog = read('evogent-watchdog.sh');
  assert.match(cycle, /SUCCESSFUL_CYCLE_STAMP="\$TOOLS\/\.last-successful-cycle"/);
  assert.match(cycle, /if \[ "\$CYCLE_DEGRADED" = 0 \]; then[\s\S]*"\$SUCCESSFUL_CYCLE_STAMP"/);
  assert.match(cycle, /degraded attempt did not advance the successful-completion stamp/);
  assert.match(scheduler, /--completion-stamp "\$TOOLS\/\.last-successful-cycle"/);
  assert.doesNotMatch(scheduler, /--completion-stamp "\$TOOLS\/last-cycle-newitems"/);
  assert.match(watchdog, /STAMP="\$TOOLS\/\.last-successful-cycle"/);
  assert.match(watchdog, /NO_SUCCESS_BASELINE="\$TOOLS\/\.no-success-cycle-baseline"/);
  assert.match(watchdog, /IFS=\$'\\t' read -r SUCCESS_REFERENCE_PATH SUCCESS_REFERENCE_OVERDUE/);
});

test('scheduler interval overrides are normalized before every Bash arithmetic path', () => {
  const scheduler = read('evogent-scheduler.sh');
  const watchdog = read('evogent-watchdog.sh');
  const timing = read('scheduler_timing.py');

  assert.match(scheduler, /Falls back to the generic 120 \/ 720 bounds/);
  assert.match(scheduler, /normalized_scheduler_bounds\(\)/);
  assert.match(scheduler, /--scheduler-minimum-value="\$1"/);
  assert.match(scheduler, /IFS=\$'\\t' read -r MIN MAX/);
  assert.match(scheduler, /\[ "\$MAX" -lt "\$MIN" \][\s\S]*MIN=120[\s\S]*MAX=720/);
  assert.doesNotMatch(
    scheduler,
    /(?:^|\n)(?:MIN|MAX)="\$\{EVOGENT_(?:MIN|MAX)_INTERVAL_MIN:-[^}]+\}"/,
  );
  assert.match(watchdog, /--scheduler-fixed-value="\$\{EVOGENT_CYCLE_INTERVAL_MIN:-\}"/);
  assert.match(timing, /def normalize_scheduler_bounds\(/);
  assert.match(timing, /maximum = max\(minimum, maximum\)/);
});

test('watchdog shell/helper protocol advances missing-success baseline and repairs clock skew', () => {
  const tempDir = fs.mkdtempSync('/tmp/evogent-watchdog-reference-');
  try {
    const success = path.join(tempDir, '.last-successful-cycle');
    const baseline = path.join(tempDir, '.no-success-cycle-baseline');
    const observedAt = 1_000_000;

    const first = runWatchdogSuccessReference(success, baseline, observedAt);
    assert.deepStrictEqual(first, { reference: baseline, overdue: '0' });
    assert.equal(fs.statSync(baseline).mode & 0o777, 0o600);

    const overdue = runWatchdogSuccessReference(success, baseline, observedAt + 781 * 60);
    assert.deepStrictEqual(overdue, { reference: baseline, overdue: '1' });

    fs.writeFileSync(success, 'completed\n', { mode: 0o600 });
    fs.utimesSync(success, observedAt + 800 * 60, observedAt + 800 * 60);
    const completed = runWatchdogSuccessReference(
      success,
      baseline,
      observedAt + 800 * 60 + 1,
    );
    assert.deepStrictEqual(completed, { reference: success, overdue: '0' });
    assert.equal(fs.existsSync(baseline), false);

    const repairedAt = observedAt + 900 * 60;
    fs.utimesSync(success, repairedAt + 300, repairedAt + 300);
    const repaired = runWatchdogSuccessReference(success, baseline, repairedAt);
    assert.deepStrictEqual(repaired, { reference: success, overdue: '0' });
    assert.ok(Math.abs(fs.statSync(success).mtimeMs / 1000 - repairedAt) < 0.01);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('life-admin evidence is judged inline by curate, never swept by a second publisher', () => {
  const cycle = read('evogent-cycle.sh');
  const curate = fs.readFileSync(path.join(root, '.claude', 'commands', 'curate.md'), 'utf8');
  assert.doesNotMatch(cycle, /\.last-life-admin-sweep|phone-life-admin\/SKILL\.md|life-admin sweep/i);
  assert.match(curate, /\.claude\/skills\/phone-life-admin\/SKILL\.md/);
  assert.match(curate, /phone-cached Gmail evidence/);
  assert.match(curate, /zero life-admin output is valid/);
});

test('duplicate watchdog exit cannot clobber the live owner heartbeat', () => {
  const watchdog = read('evogent-watchdog.sh');
  const cleanup = watchdog.slice(
    watchdog.indexOf('watchdog_cleanup()'),
    watchdog.indexOf('trap watchdog_cleanup EXIT'),
  );
  assert.match(cleanup, /\[ "\$WATCHDOG_LOCK_HELD" = 1 \][\s\S]*control_status_write watchdog - stopped/);
  assert.match(watchdog, /if ! control_lock_acquire "\$WATCHDOG_LOCK" watchdog; then[\s\S]*exit 0/);
});

test('X extraction preserves short, promotional, non-English, quote-only, and media-only evidence', () => {
  const source = read('browse-x-scrape.py');
  assert.doesNotMatch(source, /AD_HANDLES|ad-handles\.txt/);
  assert.doesNotMatch(source, /if len\(own\) >= 15|len\(text\)\s*[<]=?\s*15/);
  assert.match(source, /never omit a post because of them/);
  assert.match(source, /mediaDescription/);
  assert.match(source, /not text and not qt and not media_description/);
  assert.match(source, /promotionLabelObserved/);
  assert.match(source, /observedLanguage/);
});

test('Hacker News story enrichment uses the pinned public-only HTTP boundary', () => {
  const hackerNews = read('hn-fetch.py');
  const publicHttp = read('public_http.py');
  assert.match(hackerNews, /from public_http import fetch_public_text/);
  assert.match(hackerNews, /fetch_public_text\(/);
  assert.doesNotMatch(hackerNews, /h = get\(url, timeout=5\)/);
  assert.match(publicHttp, /not comparable\.is_global/);
  assert.match(publicHttp, /self\._pinned_ip/);
  assert.match(publicHttp, /HTTPS redirects may not downgrade to HTTP/);
  assert.match(publicHttp, /response\.read\(max_bytes \+ 1\)/);
});
