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

test('lockscreen parser accepts Android 16 state only in its exact keyguard hierarchy', () => {
  const locked = `PhoneWindowManager
  KeyguardServiceDelegate
    showing=true
    occluded=false
    inputRestricted=true
    KeyguardStateMonitor
      mIsShowing=true
      mInputRestricted=true
`;
  assert.equal(
    runControlFunction('control_lockscreen_state_from_dump', locked).stdout.trim(),
    'locked',
  );
  assert.equal(
    runControlFunction('control_keyguard_occlusion_state_from_dump', locked).stdout.trim(),
    'non-occluded',
  );

  const unlocked = `KeyguardServiceDelegate
  showing=false
  occluded=false
  KeyguardStateMonitor
    mIsShowing=false
`;
  assert.equal(
    runControlFunction('control_lockscreen_state_from_dump', unlocked).stdout.trim(),
    'unlocked',
  );

  const unrelated = `SomeOtherService
  showing=true
  KeyguardStateMonitor
    mIsShowing=true
`;
  assert.equal(
    runControlFunction('control_lockscreen_state_from_dump', unrelated).stdout.trim(),
    'unknown',
  );
  assert.equal(
    runControlFunction('control_keyguard_occlusion_state_from_dump', unrelated).stdout.trim(),
    'unknown',
  );
  assert.equal(
    runControlFunction(
      'control_lockscreen_state_from_dump',
      'showing=true\nmIsShowing=true\n',
    ).stdout.trim(),
    'unknown',
  );

  const nestedDecoy = `KeyguardServiceDelegate
  SomeOtherState
    showing=true
    occluded=false
`;
  assert.equal(
    runControlFunction('control_lockscreen_state_from_dump', nestedDecoy).stdout.trim(),
    'unknown',
  );
  assert.equal(
    runControlFunction('control_keyguard_occlusion_state_from_dump', nestedDecoy).stdout.trim(),
    'unknown',
  );

  const conflicting = `KeyguardServiceDelegate
  showing=true
  occluded=false
  occluded=true
  KeyguardStateMonitor
    mIsShowing=false
`;
  assert.equal(
    runControlFunction('control_lockscreen_state_from_dump', conflicting).stdout.trim(),
    'unknown',
  );
  assert.equal(
    runControlFunction('control_keyguard_occlusion_state_from_dump', conflicting).stdout.trim(),
    'unknown',
  );

  const occluded = `KeyguardServiceDelegate
  showing=true
  occluded=true
  KeyguardStateMonitor
    mIsShowing=true
`;
  assert.equal(
    runControlFunction('control_keyguard_occlusion_state_from_dump', occluded).stdout.trim(),
    'occluded',
  );
  const missingOcclusion = `KeyguardServiceDelegate
  showing=true
  KeyguardStateMonitor
    mIsShowing=true
`;
  assert.equal(
    runControlFunction(
      'control_keyguard_occlusion_state_from_dump',
      missingOcclusion,
    ).stdout.trim(),
    'unknown',
  );
});

test('hidden launch verdict permits only proved unattended or exact different-package states', () => {
  const verdict = (...args) =>
    runControlFunction('control_hidden_launch_verdict', '', args).stdout.trim();
  assert.equal(
    verdict('not-awake', 'unknown', 'unknown', '', 'com.twitter.android'),
    'safe-unattended',
  );
  assert.equal(
    verdict('unknown', 'locked', 'non-occluded', '', 'com.twitter.android'),
    'safe-locked',
  );
  assert.equal(
    verdict('awake', 'locked', 'occluded', 'com.twitter.android', 'com.twitter.android'),
    'refuse-unproven',
  );
  assert.equal(
    verdict('unknown', 'locked', 'unknown', '', 'com.twitter.android'),
    'refuse-unproven',
  );
  assert.equal(
    verdict('awake', 'unlocked', 'non-occluded', 'com.example.reader', 'com.twitter.android'),
    'safe-different-app',
  );
  assert.equal(
    verdict('awake', 'unlocked', 'non-occluded', 'com.twitter.android', 'com.twitter.android'),
    'refuse-active-target',
  );
  assert.equal(
    verdict('awake', 'unlocked', 'non-occluded', '', 'com.twitter.android'),
    'refuse-unproven',
  );
  assert.equal(
    verdict('unknown', 'unlocked', 'unknown', 'com.example.reader', 'com.twitter.android'),
    'refuse-unproven',
  );
  assert.equal(
    verdict('awake', 'unknown', 'unknown', 'com.example.reader', 'com.twitter.android'),
    'refuse-unproven',
  );
});

test('shell force-stop proof refuses occluded keyguard and observes activity last', () => {
  const control = read('control-plane.sh');
  const functions = [
    shellFunction(control, 'control_display_zero_top_resumed_from_dump'),
    shellFunction(control, 'control_screen_wake_state_from_dump'),
    shellFunction(control, 'control_lockscreen_state_from_dump'),
    shellFunction(control, 'control_keyguard_occlusion_state_from_dump'),
    shellFunction(control, 'control_safe_force_stop_package'),
  ].join('\n');
  const fixture = fs.mkdtempSync(path.join(
    process.env.TMPDIR || '/tmp',
    'evogent-shell-force-stop-proof-',
  ));
  const windowDump = path.join(fixture, 'window');
  const powerDump = path.join(fixture, 'power');
  const activityDump = path.join(fixture, 'activity');
  const trace = path.join(fixture, 'trace');
  const harness = `
set -u
${functions}
control_rish_bounded() {
  printf '%s\\n' "$1" >> "$TRACE"
  case "$1" in
    'dumpsys window 2>/dev/null') cat "$WINDOW_DUMP" ;;
    'dumpsys power 2>/dev/null') cat "$POWER_DUMP" ;;
    'dumpsys activity activities 2>/dev/null') cat "$ACTIVITY_DUMP" ;;
    'am force-stop com.twitter.android') return 0 ;;
    *) return 64 ;;
  esac
}
control_safe_force_stop_package com.twitter.android
printf '%s\\n' "$?"
`;
  const targetForeground = `Display #0:
  topResumedActivity=ActivityRecord{1 u0 com.twitter.android/.StartActivity t1}
`;
  const differentForeground = `Display #0:
  topResumedActivity=ActivityRecord{1 u0 com.example.reader/.MainActivity t1}
`;
  const awake = 'mWakefulness=Awake\nmInteractive=true\n';
  const asleep = 'mWakefulness=Asleep\nmInteractive=false\n';
  const locked = (occlusion) => `KeyguardServiceDelegate
  showing=true
${occlusion}
  KeyguardStateMonitor
    mIsShowing=true
`;
  const unlocked = `KeyguardServiceDelegate
  showing=false
  occluded=false
  KeyguardStateMonitor
    mIsShowing=false
`;
  const runFixture = (window, power, activity) => {
    fs.writeFileSync(windowDump, window);
    fs.writeFileSync(powerDump, power);
    fs.writeFileSync(activityDump, activity);
    fs.rmSync(trace, { force: true });
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTIVITY_DUMP: activityDump,
        POWER_DUMP: powerDump,
        TRACE: trace,
        WINDOW_DUMP: windowDump,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return {
      verdict: result.stdout.trim(),
      trace: fs.readFileSync(trace, 'utf8').trim().split('\n'),
    };
  };

  try {
    const lockedSafe = runFixture(
      locked('  occluded=false'),
      awake,
      targetForeground,
    );
    assert.equal(lockedSafe.verdict, '0');
    assert.deepEqual(lockedSafe.trace, [
      'dumpsys window 2>/dev/null',
      'am force-stop com.twitter.android',
    ]);

    for (const unsafeOcclusion of [
      '  occluded=true',
      '',
      '  occluded=false\n  occluded=true',
    ]) {
      const refused = runFixture(locked(unsafeOcclusion), awake, targetForeground);
      assert.equal(refused.verdict, '75');
      assert.deepEqual(refused.trace, [
        'dumpsys window 2>/dev/null',
        'dumpsys power 2>/dev/null',
      ]);
    }

    const targetActive = runFixture(unlocked, awake, targetForeground);
    assert.equal(targetActive.verdict, '75');
    assert.deepEqual(targetActive.trace, [
      'dumpsys window 2>/dev/null',
      'dumpsys power 2>/dev/null',
      'dumpsys activity activities 2>/dev/null',
    ]);

    const differentActive = runFixture(unlocked, awake, differentForeground);
    assert.equal(differentActive.verdict, '0');
    assert.deepEqual(differentActive.trace, [
      'dumpsys window 2>/dev/null',
      'dumpsys power 2>/dev/null',
      'dumpsys activity activities 2>/dev/null',
      'am force-stop com.twitter.android',
    ]);

    const sleeping = runFixture(locked('  occluded=true'), asleep, targetForeground);
    assert.equal(sleeping.verdict, '0');
    assert.deepEqual(sleeping.trace, [
      'dumpsys window 2>/dev/null',
      'dumpsys power 2>/dev/null',
      'am force-stop com.twitter.android',
    ]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
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

test('accessibility health is a fixed authenticated reply with no display dependency', () => {
  const phone = read('phone.sh');
  const check = read('a11y-check.sh');
  const heal = read('a11y-heal.sh');
  const healthCase = phone.slice(
    phone.indexOf('  health)'),
    phone.indexOf('  launch)'),
  );
  assert.match(healthCase, /A11Y_PERSIST_SNAPSHOT=0 a11y_grab --es op health/);
  assert.match(healthCase, /\[ "\$HEALTH_RESULT" != ready \]/);
  assert.doesNotMatch(healthCase, /cur_disp|op (?:nodes|windows)|--ei display/);
  assert.match(check, /phone\.sh" health/);
  assert.doesNotMatch(check, /phone\.sh" see/);
  assert.match(heal, /probe\(\)\{ bash "\$TOOLS\/phone\.sh" health/);
  assert.doesNotMatch(heal, /phone\.sh" see/);

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
  const healthServiceCase = service.slice(
    service.indexOf('case "health"'),
    service.indexOf('case "nodes"'),
  );
  assert.match(healthServiceCase, /String healthResult = "ready"/);
  assert.match(healthServiceCase, /sendToLocalAgent\(reply, healthResult\)/);
  assert.doesNotMatch(
    healthServiceCase,
    /dumpActiveTree|dumpTreeOnDisplay|dumpAllWindows|getRootInActiveWindow/,
  );
  assert.ok(
    service.indexOf('EvogentSecurityPolicy.tokenMatches') < service.indexOf('case "health"'),
  );
  assert.match(service, /return "health"\.equals\(op\)/);
  assert.match(phone, /--es token "\$TOKEN"[\s\S]*--es reply_nonce "\$nonce"/);
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
  const phone = read('phone.sh');
  const cycle = read('evogent-cycle.sh');
  const interests = read('browse-interests.py');
  const micro = read('benchmark-cu-micro.sh');
  const browseBenchmark = read('benchmark-browse-models.sh');
  const privilegedService = fs.readFileSync(
    path.join(
      root,
      'android-shell',
      'src',
      'net',
      'dangish',
      'evogent',
      'EvoPrivilegedService.java',
    ),
    'utf8',
  );
  const privilegedLaunch = privilegedService.slice(
    privilegedService.indexOf('public boolean launch('),
    privilegedService.indexOf('private String commandOutput('),
  );
  const shellForceStop = shellFunction(control, 'control_safe_force_stop_package');
  const phoneLaunch = phone.slice(phone.indexOf('  launch)'), phone.indexOf('  see)'));
  const windowDump = privilegedLaunch.indexOf('new String[]{"dumpsys", "window"}');
  const lockedProof = privilegedLaunch.indexOf('isStrictlyLockedAndNonOccluded(windows)');
  const lockedMutation = privilegedLaunch.indexOf('forceStopAndLaunch(', lockedProof);
  const powerDump = privilegedLaunch.indexOf('new String[]{"dumpsys", "power"}');
  const asleepProof = privilegedLaunch.indexOf('isStrictlyNotAwake(power)');
  const asleepMutation = privilegedLaunch.indexOf('forceStopAndLaunch(', asleepProof);
  const unlockedProof = privilegedLaunch.indexOf('isStrictlyUnlocked(windows)');
  const awakeProof = privilegedLaunch.indexOf('isStrictlyAwake(power)');
  const activityDump = privilegedLaunch.indexOf(
    'new String[]{"dumpsys", "activity", "activities"}',
  );
  const foregroundProof = privilegedLaunch.indexOf(
    'hasExactDifferentDisplayZeroForeground(',
  );
  const foregroundMutation = privilegedLaunch.indexOf(
    'forceStopAndLaunch(',
    foregroundProof,
  );

  assert.match(control, /control_safe_force_stop_package\(\)/);
  assert.match(control, /control_display_zero_top_resumed_from_dump/);
  assert.match(cycle, /control_safe_force_stop_package "\$pkg"/);
  assert.doesNotMatch(cycle, /control_rish_bounded "am force-stop \$pkg"/);
  assert.doesNotMatch(interests, /rish\(f?"am force-stop/);
  assert.match(interests, /sh\("stop", "com\.instagram\.android"\)/);
  assert.match(micro, /control_safe_force_stop_package com\.google\.android\.youtube/);
  assert.match(browseBenchmark, /control_safe_force_stop_package com\.google\.android\.youtube/);
  assert.ok(
    windowDump >= 0
      && windowDump < lockedProof
      && lockedProof < lockedMutation
      && lockedMutation < powerDump,
    'locked proof must mutate before collecting any newer snapshot',
  );
  assert.ok(
    powerDump < asleepProof
      && asleepProof < asleepMutation
      && asleepMutation < unlockedProof
      && unlockedProof < awakeProof
      && awakeProof < activityDump,
    'asleep proof must mutate immediately; active branch must prove unlocked and awake first',
  );
  assert.ok(
    activityDump < foregroundProof && foregroundProof < foregroundMutation,
    'activity must be the last observation before the active-display mutation',
  );
  assert.doesNotMatch(privilegedLaunch, /\bmayForceStop\(/);
  assert.match(
    privilegedLaunch,
    /if \(EvogentPhysicalDisplayPolicy\.isStrictlyLockedAndNonOccluded\(windows\)\) \{\s*return forceStopAndLaunch/,
  );
  assert.match(
    privilegedLaunch,
    /if \(EvogentPhysicalDisplayPolicy\.isStrictlyNotAwake\(power\)\) \{\s*return forceStopAndLaunch/,
  );

  const shellWindow = shellForceStop.indexOf("control_rish_bounded 'dumpsys window");
  const shellLocked = shellForceStop.indexOf('[ "$lock" = "locked" ]');
  const shellNonOccluded = shellForceStop.indexOf('[ "$occlusion" = "non-occluded" ]');
  const shellLockedMutation = shellForceStop.indexOf(
    'control_rish_bounded "am force-stop $package"',
    shellNonOccluded,
  );
  const shellPower = shellForceStop.indexOf("control_rish_bounded 'dumpsys power");
  const shellAsleep = shellForceStop.indexOf('[ "$wake" = "not-awake" ]');
  const shellAsleepMutation = shellForceStop.indexOf(
    'control_rish_bounded "am force-stop $package"',
    shellAsleep,
  );
  const shellUnlockedAwake = shellForceStop.indexOf(
    '[ "$lock" = "unlocked" ] && [ "$wake" = "awake" ]',
  );
  const shellActivity = shellForceStop.indexOf(
    "control_rish_bounded 'dumpsys activity activities",
  );
  const shellForeground = shellForceStop.indexOf(
    'control_display_zero_top_resumed_from_dump',
  );
  const shellForegroundMutation = shellForceStop.lastIndexOf(
    'control_rish_bounded "am force-stop $package"',
  );
  assert.ok(
    shellWindow >= 0
      && shellWindow < shellLocked
      && shellLocked <= shellNonOccluded
      && shellNonOccluded < shellLockedMutation
      && shellLockedMutation < shellPower,
    'shell locked+non-occluded proof must mutate before power or activity collection',
  );
  assert.ok(
    shellPower < shellAsleep
      && shellAsleep < shellAsleepMutation
      && shellAsleepMutation < shellUnlockedAwake
      && shellUnlockedAwake < shellActivity,
    'shell sleep proof must mutate immediately and reserve activity for awake+unlocked',
  );
  assert.ok(
    shellActivity < shellForeground && shellForeground < shellForegroundMutation,
    'shell activity proof must be the final observation before force-stop',
  );

  const phoneWindow = phoneLaunch.indexOf("control_rish_bounded 'dumpsys window");
  const phoneOcclusion = phoneLaunch.indexOf('control_keyguard_occlusion_state_from_dump');
  const phoneLocked = phoneLaunch.indexOf('LAUNCH_VERDICT=safe-locked');
  const phonePower = phoneLaunch.indexOf("control_rish_bounded 'dumpsys power");
  const phoneAsleep = phoneLaunch.indexOf('LAUNCH_VERDICT=safe-unattended');
  const phoneUnlockedAwake = phoneLaunch.indexOf(
    '[ "$WAKE_STATE" = "awake" ] && [ "$LOCK_STATE" = "unlocked" ]',
  );
  const phoneActivity = phoneLaunch.indexOf(
    "control_rish_bounded 'dumpsys activity activities",
  );
  const phoneForeground = phoneLaunch.indexOf(
    'control_display_zero_top_resumed_from_dump',
  );
  const phoneVerdict = phoneLaunch.indexOf('control_hidden_launch_verdict');
  const phoneMutation = phoneLaunch.indexOf('am broadcast -a $EVO.SHIZUKU');
  assert.ok(
    phoneWindow >= 0
      && phoneWindow < phoneOcclusion
      && phoneOcclusion < phoneLocked
      && phoneLocked < phonePower
      && phonePower < phoneAsleep,
    'phone launch must prove window lock+occlusion before collecting power',
  );
  assert.ok(
    phoneAsleep < phoneUnlockedAwake
      && phoneUnlockedAwake < phoneActivity
      && phoneActivity < phoneForeground
      && phoneForeground < phoneVerdict
      && phoneVerdict < phoneMutation,
    'phone launch activity must be last and only on the awake+unlocked branch',
  );
});

test('privileged launch is off-main and every child has a hard sub-24-second budget', () => {
  const androidSource = (...parts) => fs.readFileSync(
    path.join(root, 'android-shell', 'src', 'net', 'dangish', 'evogent', ...parts),
    'utf8',
  );
  const service = androidSource('EvoPrivilegedService.java');
  const runner = androidSource('EvogentProcessRunner.java');
  const controller = androidSource('ShizukuController.java');
  const mainActivity = androidSource('MainActivity.java');
  const submitLaunch = controller.slice(
    controller.indexOf('private void submitLaunch('),
    controller.indexOf('private void deliverResult('),
  );
  const deliverResult = controller.slice(
    controller.indexOf('private void deliverResult('),
    controller.indexOf('/** Tear down the current hidden display'),
  );

  assert.match(controller, /Executors\.newSingleThreadExecutor\(\)/);
  assert.ok(
    submitLaunch.indexOf('launchWorker.execute(') < submitLaunch.indexOf('service.createDisplay(')
      && submitLaunch.indexOf('service.createDisplay(') < submitLaunch.indexOf('service.launch('),
    'createDisplay and launch Binder calls must run inside the one launch worker',
  );
  assert.match(deliverResult, /main\.post\([\s\S]*callback\.ready\(displayId\)/);
  assert.match(mainActivity, /if \(shizuku != null\) shizuku\.shutdown\(\)/);
  assert.match(controller, /Shizuku binder not available[\s\S]{0,120}onFailure\.run\(\)/);
  assert.match(controller, /Shizuku permission denied[\s\S]{0,220}failure\.run\(\)/);
  assert.match(controller, /bindUserService failed[\s\S]{0,120}request\.failure\.run\(\)/);
  assert.match(controller, /new PendingRequest\(\+\+nextPendingGeneration, ready, failure\)/);
  assert.match(controller, /if \(superseded != null\) superseded\.failure\.run\(\)/);
  assert.match(
    controller,
    /main\.postDelayed\([\s\S]{0,180}if \(!clearPending\(request\)\) return;[\s\S]{0,260}request\.failure\.run\(\);[\s\S]{0,80}PENDING_READY_TIMEOUT_MS/,
  );
  assert.match(controller, /if \(pending != request\) return false/);
  assert.match(
    controller,
    /onServiceConnected[\s\S]{0,260}PendingRequest request = takePending\(\);[\s\S]{0,100}request\.ready\.run\(\)/,
  );

  assert.doesNotMatch(service, /\.waitFor\(|\.readLine\(|Runtime\.getRuntime\(\)\.exec/);
  assert.doesNotMatch(service, /new ProcessBuilder\(/);
  assert.match(service, /EvogentProcessRunner\.run\(/);
  assert.doesNotMatch(runner, /\.waitFor\(|\.readLine\(/);
  assert.match(runner, /process\.destroy\(\)/);
  assert.match(runner, /getMethod\("destroyForcibly"\)/);
  assert.match(runner, /thread\.join\(remainingMs\)/);
  assert.match(runner, /if \(!drained\) return new Result\(false, false, exitCode, ""\)/);

  const javaLong = (source, name) => {
    const match = source.match(new RegExp(`${name} = ([0-9]+)L`));
    assert.ok(match, `missing ${name}`);
    return Number(match[1]);
  };
  const dumpsysMs = javaLong(service, 'DUMPSYS_TIMEOUT_MS');
  const packageMs = javaLong(service, 'PACKAGE_COMMAND_TIMEOUT_MS');
  const startMs = javaLong(service, 'ACTIVITY_START_TIMEOUT_MS');
  const terminateMs = javaLong(runner, 'TERMINATE_GRACE_MS');
  const forceTerminateMs = javaLong(runner, 'FORCE_TERMINATE_GRACE_MS');
  const readerDrainMs = javaLong(runner, 'READER_DRAIN_MS');
  const pendingReadyMs = javaLong(controller, 'PENDING_READY_TIMEOUT_MS');
  const childCount = 6;
  const worstCleanupPerChild = (2 * (terminateMs + forceTerminateMs)) + readerDrainMs;
  const awakeBranchMaxMs = (3 * dumpsysMs)
    + (2 * packageMs)
    + startMs
    + (childCount * worstCleanupPerChild);
  assert.ok(
    awakeBranchMaxMs < 24000,
    `privileged awake branch max ${awakeBranchMaxMs}ms must fit caller's ~24s poll`,
  );
  assert.ok(
    pendingReadyMs <= 10000,
    `Shizuku readiness timeout ${pendingReadyMs}ms must expire well before the caller`,
  );
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

test('source discovery re-proves phone control after lock wait before provider spend', () => {
  const discovery = read('source-discovery.sh');
  const reprove = shellFunction(discovery, 'discovery_phone_reprove');
  const launch = shellFunction(discovery, 'launch_discovery_provider');
  assert.match(
    reprove,
    /A11Y_PERSIST_SNAPSHOT=0[\s\S]*bash "\$TOOLS\/phone\.sh" health >\/dev\/null/,
  );
  assert.match(reprove, /control_rish_bounded 'id'/);
  assert.match(reprove, /uid=2000/);
  assert.doesNotMatch(reprove, /a11y-heal|sleep|until |while |for /);
  assert.ok(
    launch.indexOf('discovery_phone_reprove')
      < launch.indexOf('codex exec --model "$CODEX_MODEL"'),
  );
  assert.ok(
    launch.indexOf('discovery_phone_reprove')
      < launch.indexOf('claude -p "$PROMPT"'),
  );
  assert.match(
    launch,
    /finish_request retry discovery_prerequisites_unavailable[\s\S]*DISC_PROVIDER_DEFERRED=1[\s\S]*return 0/,
  );
  const lockAcquired = discovery.indexOf('DISC_LOCK_HELD=1');
  const launchCall = discovery.indexOf(
    '\nlaunch_discovery_provider\n',
    discovery.indexOf('say "discovery starting'),
  );
  assert.ok(lockAcquired >= 0 && launchCall > lockAcquired);
  assert.doesNotMatch(discovery, /a11y-heal\.sh/);

  const fixture = fs.mkdtempSync(path.join(
    process.env.TMPDIR || '/tmp',
    'evogent-discovery-lock-loss-',
  ));
  const fakeTools = path.join(fixture, 'phone-tools');
  const evo = path.join(fixture, 'evogent');
  const phoneSequence = path.join(fixture, 'phone-sequence');
  const phoneCount = path.join(fixture, 'phone-count');
  const shellCount = path.join(fixture, 'shell-count');
  const lockCount = path.join(fixture, 'lock-count');
  const providerTrace = path.join(fixture, 'provider-trace');
  const queueTrace = path.join(fixture, 'queue-trace');
  const sayTrace = path.join(fixture, 'say-trace');
  const statusTrace = path.join(fixture, 'status-trace');
  fs.mkdirSync(fakeTools);
  fs.mkdirSync(evo);
  fs.writeFileSync(phoneSequence, 'ready\ndown\nready\n');
  fs.writeFileSync(path.join(fakeTools, 'phone.sh'), `#!/bin/bash
count=$(cat "$PHONE_COUNT" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\\n' "$count" > "$PHONE_COUNT"
value=$(sed -n "$count"'p' "$PHONE_SEQUENCE")
[ "$1" = health ] && [ "$value" = ready ]
`);
  const harness = `
set -u
${reprove}
${launch}
say() { printf '%s\\n' "$*" >> "$SAY_TRACE"; }
control_rish_bounded() {
  [ "$1" = id ] || return 1
  count=$(cat "$SHELL_COUNT" 2>/dev/null || printf 0)
  count=$((count + 1))
  printf '%s\\n' "$count" > "$SHELL_COUNT"
  printf 'uid=2000(shell) gid=2000(shell)\\n'
}
control_lock_acquire() {
  count=$(cat "$LOCK_COUNT" 2>/dev/null || printf 0)
  count=$((count + 1))
  printf '%s\\n' "$count" > "$LOCK_COUNT"
  [ "$count" -ge 2 ]
}
control_status_write() { printf '%s\\n' "$*" >> "$STATUS_TRACE"; }
finish_request() {
  printf '%s|%s|%s\\n' "$1" "$2" "$3" >> "$QUEUE_TRACE"
  DISC_REQUEST_FINISHED=1
}
run_owned_timeout() {
  printf '%s\\n' "$*" >> "$PROVIDER_TRACE"
  return 0
}
CONTROL_OWNER_ID=test-discovery-owner
LOG="$FIXTURE/scheduler.log"
TOOLS="$FAKE_TOOLS"
EVO="$EVO_ROOT"
SRC=test-source
BRAIN=codex
CODEX_MODEL=test-model
CODEX_EFFORT=medium
PROMPT=test-prompt
DISC_REPORTED=0
DISC_REQUEST_FINISHED=0
DISC_PROVIDER_DEFERRED=0

# This represents the scheduler's once-live admission proof before the detached worker waits.
discovery_phone_reprove
printf 'prior=%s\\n' "$?"
until control_lock_acquire ignored source-discovery; do :; done

# Accessibility disappears during the lock wait. The post-lock proof must retry the queue and
# must not invoke the provider even though the older proof succeeded.
launch_discovery_provider
printf 'deferred=%s request_finished=%s\\n' \
  "$DISC_PROVIDER_DEFERRED" "$DISC_REQUEST_FINISHED"

# A later worker may recover only through another complete fresh proof.
launch_discovery_provider
printf 'recovered=%s\\n' "$DISC_PROVIDER_DEFERRED"
`;

  try {
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVO_ROOT: evo,
        FAKE_TOOLS: fakeTools,
        FIXTURE: fixture,
        LOCK_COUNT: lockCount,
        PHONE_COUNT: phoneCount,
        PHONE_SEQUENCE: phoneSequence,
        PROVIDER_TRACE: providerTrace,
        QUEUE_TRACE: queueTrace,
        SAY_TRACE: sayTrace,
        SHELL_COUNT: shellCount,
        STATUS_TRACE: statusTrace,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      result.stdout,
      'prior=0\ndeferred=1 request_finished=1\nrecovered=0\n',
    );
    assert.equal(fs.readFileSync(lockCount, 'utf8'), '2\n');
    assert.equal(fs.readFileSync(phoneCount, 'utf8'), '3\n');
    assert.equal(fs.readFileSync(shellCount, 'utf8'), '2\n');
    assert.equal(fs.readFileSync(providerTrace, 'utf8').trim().split('\n').length, 1);
    assert.match(
      fs.readFileSync(queueTrace, 'utf8'),
      /^retry\|discovery_prerequisites_unavailable\|/,
    );
    assert.match(
      fs.readFileSync(statusTrace, 'utf8'),
      /degraded discovery_prerequisites_unavailable 0 75/,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
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
    /run_owned_timeout 1200 30 env[\s\S]{0,300}codex exec[\s\S]*--result quarantine --outcome overseer_failure/,
  );
  const spendMark = scheduler.indexOf('mark-provider-launch-spent');
  const providerCall = scheduler.indexOf('codex exec --model "$model"');
  assert.ok(spendMark >= 0 && providerCall > spendMark);
  const overseer = shellFunction(scheduler, 'run_due_overseer');
  const configGate = overseer.indexOf('ensure-phone-config');
  const liveRouteGate = overseer.indexOf('validate-live');
  const durableClaim = overseer.indexOf('claim --root "$SCHEDULED_TASK_ROOT"');
  const overseerSpend = overseer.indexOf('mark-provider-launch-spent');
  const overseerProvider = overseer.indexOf('codex exec --model "$model"');
  assert.ok(configGate >= 0 && configGate < durableClaim);
  assert.ok(liveRouteGate >= 0 && liveRouteGate < durableClaim);
  assert.ok(durableClaim >= 0 && durableClaim < overseerSpend);
  assert.ok(overseerSpend >= 0 && overseerSpend < overseerProvider);
  assert.match(overseer, /config_bootstrap[\s\S]*provider not launched/);
  assert.match(overseer, /model_route_precondition[\s\S]*provider not launched/);
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
  assert.match(scheduler, /PRIVATE_DATA_ROOT="\$\(readlink -f "\$RELEASE_ROOT\/state\/data"/);
  assert.match(scheduler, /EVOGENT_PRIVATE_ARTIFACT_TOOL="\$TOOLS\/private_artifact\.py"/);
  assert.match(scheduler, /EVOGENT_PRIVATE_DATA_ROOT="\$PRIVATE_DATA_ROOT"/);
  assert.equal((scheduler.match(/--trusted-data-root "\$PRIVATE_DATA_ROOT"/g) || []).length, 4);
  const artifactGate = scheduler.indexOf('--outcome overseer_artifact_precondition');
  const providerSpend = scheduler.indexOf('mark-provider-launch-spent');
  assert.ok(artifactGate >= 0 && providerSpend > artifactGate);
  assert.match(scheduler, /insights_before=missing[\s\S]{0,80}cadence_before=missing/);
  assert.match(scheduler, /if \[ -n "\$PRIVATE_DATA_ROOT" \]; then/);
  assert.match(
    scheduler,
    /--result retry --outcome overseer_artifact_precondition[\s\S]{0,800}control_status_write overseer - failed artifact_precondition[\s\S]{0,300}scheduled_task_wake_release[\s\S]{0,80}return 2/,
  );
  assert.match(oversee, /atomically rewrite both `data\/preference-insights\.md` and/);
  assert.match(oversee, /`data\/source-cadence\.json` even when their values remain unchanged/);
  assert.match(oversee, /"\$EVOGENT_PRIVATE_ARTIFACT_TOOL" rewrite/);
  assert.equal((oversee.match(/--trusted-data-root "\$EVOGENT_PRIVATE_DATA_ROOT"/g) || []).length, 2);
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
  const browseDue = shellFunction(cycle, 'browse_due_source');
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
  assert.ok(
    browseDue.indexOf('browse_source "$src" "$prompt_file" "$budget"')
      < browseDue.indexOf('mark_browsed "$src"'),
  );
  assert.match(browseDue, /browse_rc=\$\?[\s\S]*\[ "\$browse_rc" -eq 0 \][\s\S]*mark_browsed "\$src"/);
  assert.match(
    browseDue,
    /\[ "\$browse_rc" -eq 75 \][\s\S]*cadence and failure state untouched/,
  );
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

test('phone-control prerequisites gate app browsing without consuming source state', () => {
  const cycle = read('evogent-cycle.sh');
  const reprove = shellFunction(cycle, 'app_browse_reprove');
  const browseSource = shellFunction(cycle, 'browse_source');
  const diagnosisClaim = shellFunction(cycle, 'automatic_diagnosis_claim');
  const prerequisiteStart = cycle.indexOf('  a11y_live=0');
  const hackerNewsStart = cycle.indexOf('if src_due hackernews', prerequisiteStart);
  const appGateStart = cycle.indexOf(
    '  if [ "$APP_BROWSE_READY" = 1 ]; then',
    hackerNewsStart,
  );
  const appGateEnd = cycle.indexOf(
    '\n  fi\n\n  # ALWAYS-ON SHIPMENT JUDGMENT',
    appGateStart,
  );
  assert.ok(prerequisiteStart > 0 && hackerNewsStart > prerequisiteStart);
  assert.ok(appGateStart > hackerNewsStart && appGateEnd > appGateStart);

  const hackerNewsBlock = cycle.slice(hackerNewsStart, appGateStart);
  assert.match(hackerNewsBlock, /python3 "\$TOOLS\/hn-fetch\.py"/);
  assert.match(hackerNewsBlock, /harvest_watch hackernews/);
  assert.match(hackerNewsBlock, /mark_browsed hackernews/);

  const appBlock = cycle.slice(appGateStart, appGateEnd);
  for (const expected of [
    'src_due twitter',
    'browse_due_source youtube',
    'browse_due_source substack',
    'browse_due_source gmail',
    'browse-interests.py',
    'data/phone-sources/*.txt',
    'data/phone-sources/*.py',
    'control_safe_force_stop_package',
  ]) {
    assert.ok(appBlock.includes(expected), `app gate is missing ${expected}`);
  }

  const deferStart = cycle.indexOf(
    '  else\n    CYCLE_DEGRADED=1\n    say "source-browse: app prerequisites unavailable',
    prerequisiteStart,
  );
  const deferEnd = cycle.indexOf('\n  fi\n\n  # HN is a public', deferStart);
  const deferBranch = cycle.slice(deferStart, deferEnd);
  assert.match(deferBranch, /cadence and failure counters untouched/);
  assert.doesNotMatch(
    deferBranch,
    /src_due|browse_due_source|harvest_watch|mark_browsed|automatic_diagnosis|\.barren-|\.failure-/,
  );

  assert.match(
    cycle,
    /if \[ "\$a11y_live" = 1 \] && \[ "\$shizuku_live" = 1 \]; then[\s\S]*APP_BROWSE_READY=1/,
  );
  assert.match(reprove, /APP_BROWSE_READY=0/);
  assert.match(
    reprove,
    /A11Y_PERSIST_SNAPSHOT=0[\s\S]*bash "\$TOOLS\/phone\.sh" health >\/dev\/null/,
  );
  assert.match(reprove, /control_rish_bounded 'id'/);
  assert.match(reprove, /uid=2000/);
  assert.match(reprove, /APP_BROWSE_READY=1/);
  assert.doesNotMatch(reprove, /a11y-heal|sleep|for [_A-Za-z]|while /);

  assert.ok(
    browseSource.indexOf('app_browse_reprove "source-browse[$src]: provider launch"')
      < browseSource.indexOf('codex exec --model "$route_model"'),
  );
  assert.ok(
    browseSource.indexOf('app_browse_reprove "source-browse[$src]: provider launch"')
      < browseSource.indexOf('claude -p "$prompt"'),
  );
  assert.ok(
    diagnosisClaim.indexOf('--dispatcher-unavailable')
      < diagnosisClaim.indexOf('app_browse_reprove "automatic-diagnosis[$src]: claim"'),
  );
  assert.ok(
    diagnosisClaim.lastIndexOf('python3 "$DIAGNOSIS_BUDGET_HELPER"')
      > diagnosisClaim.indexOf('app_browse_reprove "automatic-diagnosis[$src]: claim"'),
  );
  assert.match(diagnosisClaim, /threshold is already durable[\s\S]*paid slot remains untouched/);

  const twitterBlock = cycle.slice(
    cycle.indexOf('if src_due twitter'),
    cycle.indexOf('browse_due_source youtube'),
  );
  assert.ok(
    twitterBlock.indexOf('app_browse_reprove "source-browse[twitter]: driver launch"')
      < twitterBlock.indexOf('python3 "$TOOLS/browse-x-scrape.py"'),
  );
  const interestsBlock = cycle.slice(
    cycle.indexOf('if [ -s "$EVO/data/interests.jsonl" ]'),
    cycle.indexOf('# User-discovered sources:'),
  );
  assert.ok(
    interestsBlock.indexOf('app_browse_reprove "source-browse[interests]: worker launch"')
      < interestsBlock.indexOf('python3 "$TOOLS/browse-interests.py"'),
  );
  const recipeBlock = cycle.slice(
    cycle.indexOf('for rf in "$EVO"/data/phone-sources/*.py'),
    cycle.indexOf('# CRITICAL memory hygiene'),
  );
  assert.ok(
    recipeBlock.indexOf('app_browse_reprove "source-browse[$rsrc]: recipe launch"')
      < recipeBlock.indexOf('python3 "$rf"'),
  );
  assert.doesNotMatch(
    shellFunction(cycle, 'browse_due_source'),
    /app_browse_reprove[\s\S]*src_due/,
  );

  const scoutBlock = cycle.slice(
    cycle.indexOf('SCOUT_STAMP='),
    cycle.indexOf('# feed post count'),
  );
  assert.match(
    scoutBlock,
    /\[ "\$ONLINE" = 1 \] && is_on "\$BG_BROWSE"[\s\S]*app_browse_reprove "source-scout: launch"[\s\S]*source-scout\.py/,
  );
  const permalinkBlock = cycle.slice(
    cycle.indexOf('VP=$(python3 "$TOOLS/validate-tweet-permalinks.py"'),
    cycle.indexOf('VERDICT=$(python3 "$TOOLS/verify-intents.py"'),
  );
  assert.match(
    permalinkBlock,
    /\[ "\$ONLINE" = 1 \] && is_on "\$BG_BROWSE"[\s\S]*app_browse_reprove "permalink-backfill: launch"[\s\S]*backfill-tweet-permalinks\.py/,
  );
  const queueBlock = cycle.slice(
    cycle.indexOf("if [ \"$ONLINE\" = 1 ] && is_on \"$BG_BROWSE\"", cycle.indexOf('finish_queued_task(){')),
    cycle.indexOf('if [ -n "$TASK_LEASE" ]'),
  );
  assert.match(
    queueBlock,
    /! tmux has-session[\s\S]*app_browse_reprove "request-ledger: app task claim"[\s\S]*"\$TASK_QUEUE" claim/,
  );
  assert.ok(
    cycle.indexOf('# ---------- 2. Curation:') > appGateEnd,
    'curation must remain outside the app prerequisite gate',
  );
});

test('mid-cycle prerequisite loss invalidates admission and only a fresh two-part proof recovers', () => {
  const cycle = read('evogent-cycle.sh');
  const reprove = shellFunction(cycle, 'app_browse_reprove');
  const fixture = fs.mkdtempSync(path.join(
    process.env.TMPDIR || '/tmp',
    'evogent-mid-cycle-phone-loss-',
  ));
  const fakeTools = path.join(fixture, 'phone-tools');
  const phoneSequence = path.join(fixture, 'phone-sequence');
  const phoneCount = path.join(fixture, 'phone-count');
  const shellSequence = path.join(fixture, 'shell-sequence');
  const shellCount = path.join(fixture, 'shell-count');
  const actionTrace = path.join(fixture, 'actions');
  const sayTrace = path.join(fixture, 'say');
  const log = path.join(fixture, 'scheduler.log');
  fs.mkdirSync(fakeTools);
  fs.writeFileSync(phoneSequence, 'down\nready\nready\n');
  fs.writeFileSync(shellSequence, 'uid=0(root) gid=0(root)\nuid=2000(shell) gid=2000(shell)\n');
  fs.writeFileSync(path.join(fakeTools, 'phone.sh'), `#!/bin/bash
count=$(cat "$PHONE_COUNT" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\\n' "$count" > "$PHONE_COUNT"
value=$(sed -n "$count"'p' "$PHONE_SEQUENCE")
[ "$1" = health ] && [ "$value" = ready ]
`);
  const harness = `
set -u
${reprove}
say() { printf '%s\\n' "$*" >> "$SAY_TRACE"; }
control_rish_bounded() {
  [ "$1" = id ] || return 1
  count=$(cat "$SHELL_COUNT" 2>/dev/null || printf 0)
  count=$((count + 1))
  printf '%s\\n' "$count" > "$SHELL_COUNT"
  sed -n "$count"'p' "$SHELL_SEQUENCE"
}
APP_BROWSE_READY=1
CYCLE_DEGRADED=0
attempt() {
  if app_browse_reprove "$1"; then
    printf '%s\\n' "$1" >> "$ACTION_TRACE"
  fi
  printf '%s:%s\\n' "$APP_BROWSE_READY" "$CYCLE_DEGRADED"
}
attempt lost-accessibility
attempt lost-shell
attempt recovered
`;

  try {
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION_TRACE: actionTrace,
        CONTROL_OWNER_ID: 'test-cycle-owner',
        LOG: log,
        PHONE_COUNT: phoneCount,
        PHONE_SEQUENCE: phoneSequence,
        SAY_TRACE: sayTrace,
        SHELL_COUNT: shellCount,
        SHELL_SEQUENCE: shellSequence,
        TOOLS: fakeTools,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, '0:1\n0:1\n1:1\n');
    assert.equal(fs.readFileSync(phoneCount, 'utf8'), '3\n');
    assert.equal(fs.readFileSync(shellCount, 'utf8'), '2\n');
    assert.equal(fs.readFileSync(actionTrace, 'utf8'), 'recovered\n');
    assert.match(fs.readFileSync(sayTrace, 'utf8'), /lost-accessibility: accessibility health proof failed/);
    assert.match(fs.readFileSync(sayTrace, 'utf8'), /lost-shell: shell uid proof failed/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('automatic mechanics and barren diagnosis stay unspent behind the phone gate', () => {
  const cycle = read('evogent-cycle.sh');
  const reprove = shellFunction(cycle, 'app_browse_reprove');
  const diagnosisClaim = shellFunction(cycle, 'automatic_diagnosis_claim');
  const harvest = shellFunction(cycle, 'harvest_watch');
  const fixture = fs.mkdtempSync(path.join(
    process.env.TMPDIR || '/tmp',
    'evogent-diagnosis-phone-gate-',
  ));
  const helper = path.join(fixture, 'diagnosis-helper.py');
  const state = path.join(fixture, 'diagnosis-state.json');
  const helperTrace = path.join(fixture, 'helper-trace');
  const log = path.join(fixture, 'scheduler.log');
  const fakeTools = path.join(fixture, 'phone-tools');
  const phoneSequence = path.join(fixture, 'phone-sequence');
  const phoneCount = path.join(fixture, 'phone-count');
  const shellSequence = path.join(fixture, 'shell-sequence');
  const shellCount = path.join(fixture, 'shell-count');
  fs.mkdirSync(fakeTools);
  fs.writeFileSync(phoneSequence, 'down\nready\nready\n');
  fs.writeFileSync(shellSequence, 'uid=0(root) gid=0(root)\nuid=2000(shell) gid=2000(shell)\n');
  fs.writeFileSync(path.join(fakeTools, 'phone.sh'), `#!/bin/bash
count=$(cat "$PHONE_COUNT" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\\n' "$count" > "$PHONE_COUNT"
value=$(sed -n "$count"'p' "$PHONE_SEQUENCE")
[ "$1" = health ] && [ "$value" = ready ]
`);
  fs.writeFileSync(helper, `import os, pathlib, sys
pathlib.Path(os.environ["HELPER_TRACE"]).open("a", encoding="utf-8").write(
    " ".join(sys.argv[1:]) + "\\n"
)
state = pathlib.Path(sys.argv[sys.argv.index("--state") + 1])
if "--dispatcher-unavailable" in sys.argv:
    state.write_text("pending\\n", encoding="utf-8")
    print("0\\tdispatcher_unavailable")
else:
    state.write_text("spent\\n", encoding="utf-8")
    print("1\\tclaimed")
`);
  const harness = `
set -u
${reprove}
${diagnosisClaim}
say() { printf '%s\\n' "$*" >> "$SAY_TRACE"; }
control_rish_bounded() {
  [ "$1" = id ] || return 1
  count=$(cat "$SHELL_COUNT" 2>/dev/null || printf 0)
  count=$((count + 1))
  printf '%s\\n' "$count" > "$SHELL_COUNT"
  sed -n "$count"'p' "$SHELL_SEQUENCE"
}
DIAGNOSIS_BUDGET_HELPER="$HELPER"
DIAGNOSIS_BUDGET_STATE="$STATE"
LOG="$LOG_FILE"
BRAIN=codex
CONTROL_OWNER_ID=test-cycle-owner
APP_BROWSE_READY=1
CYCLE_DEGRADED=0
AUTOMATIC_DIAGNOSIS_CLAIMED=0
AUTOMATIC_DIAGNOSIS_REASON=threshold_not_due
automatic_diagnosis_claim hackernews 3 mechanics
printf '%s|%s|%s|%s\\n' "$AUTOMATIC_DIAGNOSIS_CLAIMED" \
  "$AUTOMATIC_DIAGNOSIS_REASON" "$APP_BROWSE_READY" "$(cat "$STATE")"
automatic_diagnosis_claim hackernews 3 barren
printf '%s|%s|%s|%s\\n' "$AUTOMATIC_DIAGNOSIS_CLAIMED" \
  "$AUTOMATIC_DIAGNOSIS_REASON" "$APP_BROWSE_READY" "$(cat "$STATE")"
automatic_diagnosis_claim hackernews 3 barren
printf '%s|%s|%s|%s\\n' "$AUTOMATIC_DIAGNOSIS_CLAIMED" \
  "$AUTOMATIC_DIAGNOSIS_REASON" "$APP_BROWSE_READY" "$(cat "$STATE")"
`;

  try {
    fs.writeFileSync(state, 'pending\n');
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HELPER: helper,
        HELPER_TRACE: helperTrace,
        LOG_FILE: log,
        PHONE_COUNT: phoneCount,
        PHONE_SEQUENCE: phoneSequence,
        SAY_TRACE: path.join(fixture, 'say'),
        SHELL_COUNT: shellCount,
        SHELL_SEQUENCE: shellSequence,
        STATE: state,
        TOOLS: fakeTools,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      result.stdout,
      '0|prerequisites_unavailable|0|pending\n'
        + '0|prerequisites_unavailable|0|pending\n'
        + '1|claimed|1|spent\n',
    );
    assert.equal(fs.readFileSync(phoneCount, 'utf8'), '3\n');
    assert.equal(fs.readFileSync(shellCount, 'utf8'), '2\n');
    const helperCalls = fs.readFileSync(helperTrace, 'utf8').trim().split('\n');
    assert.equal(helperCalls.length, 4);
    assert.ok(helperCalls[0].includes('--lane mechanics'));
    assert.ok(helperCalls.slice(0, 3).every((call) => call.includes('--dispatcher-unavailable')));
    assert.ok(helperCalls[3].includes('--lane barren'));
    assert.ok(!helperCalls[3].includes('--dispatcher-unavailable'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  assert.match(
    harvest,
    /if \[ "\$APP_BROWSE_READY" = 1 \] && \[ "\$mechanics_claimed" = 1 \]; then[\s\S]*dispatching diagnosis agent within daily budget \(mechanics incident\)/,
  );
  assert.match(
    harvest,
    /if \[ "\$APP_BROWSE_READY" = 1 \] && \[ "\$diagnosis_claimed" = 1 \]; then[\s\S]*dispatching diagnosis agent within daily budget \(barren streak \$n\)/,
  );
  assert.match(
    harvest,
    /mechanics diagnosis remains pending until phone-control prerequisites recover/,
  );
  assert.match(
    harvest,
    /automatic diagnosis remains pending until phone-control prerequisites recover/,
  );
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

test('control status publication is bounded and proves the exact live lock owner', () => {
  const fixture = fs.mkdtempSync(path.join(
    process.env.TMPDIR || '/tmp',
    'evogent-control-status-',
  ));
  const home = path.join(fixture, 'home');
  const data = path.join(home, 'evogent', 'data');
  const lock = path.join(home, 'phone-tools', '.scheduler.lock');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  fs.chmodSync(lock, 0o700);
  const owner = path.join(lock, 'owner');
  const harness = `
set -u
. "$CONTROL_PLANE"
CONTROL_OWNER_ID=status-owner
CONTROL_SELF_START=424242
{
  printf 'owner=status-owner\\n'
  printf 'pid=%s\\n' "$$"
  printf 'start=%s\\n' "$CONTROL_SELF_START"
  printf 'label=scheduler\\n'
  printf 'acquired=%s\\n' "$(date +%s)"
} > "$OWNER"
chmod 600 "$OWNER"
control_status_write scheduler - running "" "" "" "fixture"
control_status_owner_live scheduler "$LOCK" 5
python3 - "$HOME/evogent/data/phone-control-status.json" <<'PY'
import json
import sys
path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
data["scheduler"]["processStartTicks"] += 1
with open(path, "w", encoding="utf-8") as output:
    json.dump(data, output)
PY
if control_status_owner_live scheduler "$LOCK" 5; then
  exit 70
fi
printf 'status-proof-ok\\n'
`;

  try {
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CONTROL_PLANE: path.join(tools, 'control-plane.sh'),
        LOCK: lock,
        OWNER: owner,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, 'status-proof-ok\n');

    const contention = `
set -u
holder=""
cleanup() {
  [ -n "$holder" ] || return 0
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
}
trap cleanup EXIT
python3 - "$STATUS_LOCK" "$READY" <<'PY' &
import fcntl
import pathlib
import sys
import time
lock, ready = map(pathlib.Path, sys.argv[1:])
with open(lock, "a+", encoding="utf-8") as descriptor:
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    ready.touch()
    time.sleep(10)
PY
holder=$!
for _ in $(seq 1 100); do
  [ -f "$READY" ] && break
  sleep 0.01
done
[ -f "$READY" ] || exit 71
. "$CONTROL_PLANE"
CONTROL_OWNER_ID=blocked-owner
CONTROL_SELF_START=1
control_status_write watchdog - running "" "" "" "blocked fixture"
write_rc=$?
[ "$write_rc" = 75 ] || exit 72
printf 'bounded-failure-ok\\n'
`;
    const ready = path.join(fixture, 'holder-ready');
    const startedAt = Date.now();
    const blocked = spawnSync('bash', ['-c', contention], {
      cwd: root,
      encoding: 'utf8',
      timeout: 3_000,
      env: {
        ...process.env,
        HOME: home,
        CONTROL_PLANE: path.join(tools, 'control-plane.sh'),
        STATUS_LOCK: path.join(data, 'phone-control-status.json.lock'),
        READY: ready,
        EVOGENT_CONTROL_STATUS_WRITE_TIMEOUT_SECONDS: '0.1',
      },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(blocked.status, 0, `${blocked.stdout}\n${blocked.stderr}`);
    assert.equal(blocked.stdout, 'bounded-failure-ok\n');
    assert.match(
      blocked.stderr,
      /control status: watchdog publication timed out; retry deferred/,
    );
    assert.ok(elapsedMs < 2_000, `status contention took ${elapsedMs}ms`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('live scheduler and watchdog owners retain transient status timeouts only after readiness', () => {
  const schedulerStatus = shellFunction(
    read('evogent-scheduler.sh'),
    'scheduler_status_write',
  );
  const watchdogStatus = shellFunction(
    read('evogent-watchdog.sh'),
    'watchdog_status_write',
  );
  const harness = `
set -u
say() { printf '%s\\n' "$*" >&2; }
control_status_write() { return "$STATUS_RESULT"; }
${schedulerStatus}
${watchdogStatus}
"$STATUS_FUNCTION" "$STATUS_POLICY" - running "" "" "" fixture
`;
  const runPolicy = (statusFunction, statusPolicy, statusResult) => spawnSync(
    'bash',
    ['-c', harness],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        STATUS_FUNCTION: statusFunction,
        STATUS_POLICY: statusPolicy,
        STATUS_RESULT: String(statusResult),
      },
    },
  );

  for (const statusFunction of [
    'scheduler_status_write',
    'watchdog_status_write',
  ]) {
    let result = runPolicy(statusFunction, 'heartbeat', 75);
    assert.equal(result.status, 0, `${statusFunction}\n${result.stderr}`);
    assert.match(result.stderr, /heartbeat timed out; live owner retained for retry/);

    result = runPolicy(statusFunction, 'required', 75);
    assert.equal(result.status, 75, statusFunction);
    assert.match(result.stderr, /initial .* status publication timed out/);

    result = runPolicy(statusFunction, 'heartbeat', 1);
    assert.equal(result.status, 1, statusFunction);
    assert.match(result.stderr, /status publication failed structurally/);

    result = runPolicy(statusFunction, 'heartbeat', 0);
    assert.equal(result.status, 0, `${statusFunction}\n${result.stderr}`);
  }
});

test('boot reports control readiness only after PID-start-bound status proof', () => {
  const control = read('control-plane.sh');
  const scheduler = read('evogent-scheduler.sh');
  const watchdog = read('evogent-watchdog.sh');
  const boot = read('evogent-boot.sh');

  assert.match(control, /fcntl\.LOCK_EX \| fcntl\.LOCK_NB/);
  assert.match(control, /EVOGENT_CONTROL_STATUS_WRITE_TIMEOUT_SECONDS/);
  assert.match(control, /signal\.setitimer\(signal\.ITIMER_REAL, lock_timeout\)/);
  assert.match(control, /control_status_owner_live\(\)/);
  assert.match(
    scheduler,
    /scheduler_status_write required - running[\s\S]*\|\| exit 70/,
  );
  assert.match(
    watchdog,
    /watchdog_status_write required - running[\s\S]*\|\| exit 70/,
  );
  assert.match(scheduler, /scheduler_status_write heartbeat - running/);
  assert.match(watchdog, /watchdog_status_write heartbeat - running/);

  const schedulerLaunch = boot.indexOf('scheduler launch requested');
  const schedulerProof = boot.indexOf(
    'wait_for_control_owner_status scheduler "$TOOLS/.scheduler.lock" 0',
  );
  const schedulerReady = boot.indexOf('scheduler ready');
  const watchdogLaunch = boot.indexOf('watchdog launch requested');
  const watchdogProof = boot.indexOf(
    'wait_for_control_owner_status watchdog "$TOOLS/.watchdog.lock" 180',
  );
  const watchdogReady = boot.indexOf('watchdog ready');
  const done = boot.indexOf('=== evogent-boot done:');
  assert.ok(
    schedulerLaunch >= 0
      && schedulerLaunch < schedulerProof
      && schedulerProof < schedulerReady
      && schedulerReady < watchdogLaunch
      && watchdogLaunch < watchdogProof
      && watchdogProof < watchdogReady
      && watchdogReady < done,
  );
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
