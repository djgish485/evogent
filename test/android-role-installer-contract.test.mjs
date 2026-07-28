import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const installer = fs.readFileSync(
  path.join(root, 'phone-paradigm/device/install-release.sh'),
  'utf8',
);

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
    const match = line.match(/<<-?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (match) {
      heredoc = match[1];
      continue;
    }
    if (line === '}') return lines.slice(start, index + 1).join('\n');
  }
  assert.fail(`unterminated shell function ${name}`);
}

test('role snapshot, APK proof, assignment, switch, and commit are strictly ordered', () => {
  const capture = installer.indexOf('capture_android_role_backup || {');
  const restoreIntent = installer.indexOf('ANDROID_ROLE_RESTORE_REQUIRED=1', capture);
  const apkAttempt = installer.indexOf('APK_INSTALL_ATTEMPTED=1', restoreIntent);
  const apkProof = installer.indexOf(
    '[ "$INSTALLED_APK_CODE" = "$EXPECTED_APK_CODE" ]',
    apkAttempt,
  );
  const rollbackProof = installer.indexOf(
    'wait_for_apk_rollback_availability',
    apkProof,
  );
  const assign = installer.indexOf('assign_release_android_roles || {', rollbackProof);
  const switchStarted = installer.indexOf('SWITCH_STARTED=1', assign);
  const finalRoleProof = installer.indexOf(
    'verify_release_android_roles "$ANDROID_ROLE_USER_ID"',
    switchStarted,
  );
  const commit = installer.indexOf('commit_new_release_decision || exit $?', finalRoleProof);
  assert.ok(
    capture !== -1
      && capture < restoreIntent
      && restoreIntent < apkAttempt
      && apkAttempt < apkProof
      && apkProof < rollbackProof
      && rollbackProof < assign
      && assign < switchStarted
      && switchStarted < finalRoleProof
      && finalRoleProof < commit,
  );
  const noOp = installer.slice(
    installer.indexOf('if [ "$CURRENT_RESOLVED" = "$NEW_RELEASE" ]'),
    installer.indexOf('# Allocate every recovery path'),
  );
  assert.match(noOp, /verify_release_android_roles/);
});

test('failed role capture leaves journal proof fields wholly unready', () => {
  const capture = shellFunction(installer, 'capture_android_role_backup');
  const fixture = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'evogent-role-capture-failure-'),
  );
  const backup = path.join(fixture, 'backup');
  fs.mkdirSync(backup, { mode: 0o700 });
  const harness = `
set -u
${capture}
android_role_state_helper_safe() { return 0; }
read_android_current_user() { printf '%s\\n' 0; }
read_android_role_holders() { printf '%s\\n' com.example.holder; }
python3() { return 65; }
validate_android_role_backup() { return 0; }
BACKUP_DIR="$1"
ANDROID_ROLE_BACKUP="$1/android-role-holders.json"
ANDROID_ROLE_BACKUP_READY=0
ANDROID_ROLE_BACKUP_SHA256=""
ANDROID_ROLE_USER_ID=""
ANDROID_ROLE_STATE_HELPER=/fixture/android-role-state.py
ANDROID_HOME_ROLE=android.app.role.HOME
ANDROID_ASSISTANT_ROLE=android.app.role.ASSISTANT
if capture_android_role_backup; then exit 91; fi
[ "$ANDROID_ROLE_BACKUP" = "$1/android-role-holders.json" ]
[ "$ANDROID_ROLE_BACKUP_READY" = 0 ]
[ -z "$ANDROID_ROLE_BACKUP_SHA256" ]
[ -z "$ANDROID_ROLE_USER_ID" ]
printf '%s\\n' preserved
`;
  try {
    const result = spawnSync('bash', ['-c', harness, 'capture', backup], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'preserved\n');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Android role reads use bounded typed filesystem publication, not rish stdout', () => {
  const query = shellFunction(installer, 'read_android_role_query_result');
  const current = shellFunction(installer, 'read_android_current_user');
  const holders = shellFunction(installer, 'read_android_role_holders');
  const assistant = shellFunction(installer, 'read_android_assistant_setting');
  const voice = shellFunction(installer, 'read_android_voice_setting');
  const home = shellFunction(installer, 'read_android_home_component');
  assert.match(query, /allocate_shell_staging_file android-role-query/);
  assert.match(query, /EVOGENT_ANDROID_ROLE_QUERY_RESULT_V1/);
  assert.match(query, /copy_published_shell_file "\$shell_path" "\$private_result" 100/);
  assert.match(query, /remove_shell_staging_file "\$shell_path"/);
  assert.match(query, /rish_command[\s\S]*30 >\/dev\/null 2>&1 \|\| true/);
  assert.doesNotMatch(current, /\$\(\s*rish_command/);
  assert.doesNotMatch(holders, /\$\(\s*rish_command/);
  assert.doesNotMatch(assistant, /\$\(\s*rish_command/);
  assert.doesNotMatch(voice, /\$\(\s*rish_command/);
  assert.doesNotMatch(home, /\$\(\s*rish_command/);
  assert.match(assistant, /read_android_role_query_result/);
  assert.match(voice, /read_android_role_query_result/);
  assert.match(home, /read_android_role_query_result/);
  assert.doesNotMatch(
    shellFunction(installer, 'android_assistant_components_match'),
    /rish_command/,
  );
  assert.doesNotMatch(
    shellFunction(installer, 'android_home_component_matches'),
    /rish_command/,
  );
  assert.match(
    installer,
    /evogent-\(android-role-query\|control-token\|installed-apk\|package-version\|rollback-dump\)/,
  );
});

test('filesystem role query accepts explicit empty holder and rejects missing publication silently', () => {
  const query = shellFunction(installer, 'read_android_role_query_result');
  const current = shellFunction(installer, 'read_android_current_user');
  const holders = shellFunction(installer, 'read_android_role_holders');
  const assistant = shellFunction(installer, 'read_android_assistant_setting');
  const voice = shellFunction(installer, 'read_android_voice_setting');
  const home = shellFunction(installer, 'read_android_home_component');
  const componentsMatch = shellFunction(
    installer,
    'android_assistant_components_match',
  );
  const homeMatch = shellFunction(installer, 'android_home_component_matches');
  const fixture = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'evogent-role-query-'),
  );
  fs.chmodSync(fixture, 0o700);
  const stage = path.join(fixture, 'stage');
  const shellRoot = path.join(fixture, 'shell');
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.mkdirSync(shellRoot, { mode: 0o700 });
  const helper = path.join(
    root,
    'phone-paradigm/device/android-role-state.py',
  );
  const harness = `
set -u
${query}
${current}
${holders}
${assistant}
${voice}
${home}
${componentsMatch}
${homeMatch}
android_role_state_helper_safe() {
  [ -f "$ANDROID_ROLE_STATE_HELPER" ] && [ ! -L "$ANDROID_ROLE_STATE_HELPER" ]
}
android_role_name_valid() {
  case "\${1:-}" in
    "$ANDROID_HOME_ROLE"|"$ANDROID_ASSISTANT_ROLE") return 0 ;;
    *) return 1 ;;
  esac
}
allocate_shell_staging_file() {
  operation="$SHELL_ROOT/query-$ALLOCATIONS"
  ALLOCATIONS=$((ALLOCATIONS + 1))
  mkdir -m 0700 "$operation"
  : > "$operation/payload"
  chmod 0600 "$operation/payload"
  chmod 0711 "$operation"
  printf '%s\\n' "$operation/payload"
}
copy_published_shell_file() {
  source="$1" destination="$2" attempts="$3"
  COPY_ATTEMPTS="$attempts"
  for _ in $(seq 1 "$attempts"); do
    if [ -f "$source" ] && [ ! -L "$source" ]; then
      cp "$source" "$destination"
      chmod 600 "$destination"
      return 0
    fi
    sleep 0.01
  done
  return 1
}
remove_shell_staging_file() {
  path="$1"
  rm -rf -- "\${path%/payload}"
}
rish_command() {
  command="$1" budget="$2"
  printf '%s\\n' "$budget" >> "$TRACE"
  [ "$RISH_MODE" = publish ] && bash -c "$command"
  # Intentionally publish no stdout even on rc=0, matching the device fault.
  return 0
}
STAGE="$STAGE_PATH"
SHELL_ROOT="$SHELL_PATH"
TRACE="$TRACE_PATH"
ANDROID_ROLE_STATE_HELPER="$HELPER_PATH"
ANDROID_HOME_ROLE=android.app.role.HOME
ANDROID_ASSISTANT_ROLE=android.app.role.ASSISTANT
PACKAGE_NAME=net.dangish.evogent
ALLOCATIONS=0
COPY_ATTEMPTS=0
RISH_MODE="$1"
case "$2" in
  current) read_android_current_user ;;
  empty) read_android_role_holders "$ANDROID_ASSISTANT_ROLE" 10 ;;
  holder) read_android_role_holders "$ANDROID_HOME_ROLE" 10 ;;
  components) android_assistant_components_match 10 ;;
  home-match) android_home_component_matches 10 ;;
  *) exit 99 ;;
esac
`;
  const fakeBin = path.join(fixture, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, 'am'),
    '#!/bin/sh\n[ "$1" = get-current-user ] || exit 65\nprintf "10\\n"\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(fakeBin, 'cmd'),
    '#!/bin/sh\n'
      + 'case "$1:$2" in\n'
      + '  role:get-role-holders)\n'
      + '    case "$5" in\n'
      + '      android.app.role.HOME) printf "com.example.home\\n" ;;\n'
      + '      android.app.role.ASSISTANT) : ;;\n'
      + '      *) exit 65 ;;\n'
      + '    esac\n'
      + '    ;;\n'
      + '  package:resolve-activity)\n'
      + '    printf "net.dangish.evogent/.MainActivity\\n"\n'
      + '    ;;\n'
      + '  *) exit 65 ;;\n'
      + 'esac\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(fakeBin, 'settings'),
    '#!/bin/sh\n'
      + '[ "$1" = --user ] && [ "$2" = 10 ] && [ "$3" = get ] '
      + '&& [ "$4" = secure ] || exit 65\n'
      + 'case "$5" in\n'
      + '  assistant|voice_interaction_service)\n'
      + '    printf "net.dangish.evogent/.EvogentVoiceInteractionService\\n"\n'
      + '    ;;\n'
      + '  *) exit 65 ;;\n'
      + 'esac\n',
    { mode: 0o700 },
  );
  const trace = path.join(fixture, 'trace');
  const runHarness = (mode, kind) => spawnSync(
    'bash',
    ['-c', harness, 'role-query', mode, kind],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        STAGE_PATH: stage,
        SHELL_PATH: shellRoot,
        TRACE_PATH: trace,
        HELPER_PATH: helper,
      },
    },
  );
  try {
    let result = runHarness('publish', 'current');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '10\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(shellRoot), []);

    result = runHarness('publish', 'empty');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(shellRoot), []);

    result = runHarness('publish', 'holder');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'com.example.home\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(shellRoot), []);

    result = runHarness('publish', 'components');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(shellRoot), []);

    result = runHarness('publish', 'home-match');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(shellRoot), []);

    result = runHarness('lost', 'empty');
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(shellRoot), []);

    assert.equal(
      fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean)
        .every((value) => value === '30'),
      true,
    );
    assert.deepEqual(fs.readdirSync(stage), []);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('malformed role query publication is rejected without leaking holder content and is removed', () => {
  const query = shellFunction(installer, 'read_android_role_query_result');
  const fixture = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'evogent-role-query-invalid-'),
  );
  fs.chmodSync(fixture, 0o700);
  const stage = path.join(fixture, 'stage');
  const shellRoot = path.join(fixture, 'shell');
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.mkdirSync(shellRoot, { mode: 0o700 });
  const helper = path.join(
    root,
    'phone-paradigm/device/android-role-state.py',
  );
  const harness = `
set -u
${query}
android_role_state_helper_safe() { return 0; }
allocate_shell_staging_file() {
  mkdir -m 0711 "$SHELL_ROOT/query"
  printf 'EVOGENT_ANDROID_ROLE_QUERY_RESULT_V2\\nrole-holders\\ncom.example.privateholder\\n' > "$SHELL_ROOT/query/payload"
  chmod 0644 "$SHELL_ROOT/query/payload"
  printf '%s\\n' "$SHELL_ROOT/query/payload"
}
rish_command() { return 0; }
copy_published_shell_file() {
  cp "$1" "$2"
  chmod 600 "$2"
}
remove_shell_staging_file() { rm -rf -- "\${1%/payload}"; }
STAGE="$STAGE_PATH"
SHELL_ROOT="$SHELL_PATH"
ANDROID_ROLE_STATE_HELPER="$HELPER_PATH"
read_android_role_query_result role-holders "cmd role ignored" 4096
`;
  try {
    const result = spawnSync(
      'bash',
      ['-c', harness],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          STAGE_PATH: stage,
          SHELL_PATH: shellRoot,
          HELPER_PATH: helper,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /privateholder/);
    assert.deepEqual(fs.readdirSync(shellRoot), []);
    assert.deepEqual(fs.readdirSync(stage), []);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('assistant qualification failure cannot mutate HOME', () => {
  const assign = shellFunction(installer, 'assign_release_android_roles');
  const harness = `
set -u
${assign}
installed_release_apk_exact() { return 0; }
validate_android_role_backup() { return 0; }
android_roles_have_only_allowed_post_apk_drift() { return 0; }
verify_release_android_roles() { return 1; }
write_transaction_journal() { printf 'journal:%s\\n' "$1" >> "$TRACE"; }
rish_command() {
  case "$1" in
    *android.app.role.ASSISTANT*) TRACE_LOG="\${TRACE_LOG}assistant|" ;;
    *android.app.role.HOME*) TRACE_LOG="\${TRACE_LOG}home|" ;;
    *) return 90 ;;
  esac
}
wait_for_release_assistant_activation() { TRACE_LOG="\${TRACE_LOG}proved|"; return 1; }
TRACE_LOG=""
ANDROID_ROLE_RESTORE_REQUIRED=0
ANDROID_ROLE_MUTATION_ATTEMPTED=0
ANDROID_ROLES_APPLIED=0
ANDROID_ROLE_USER_ID=0
ANDROID_ASSISTANT_ROLE=android.app.role.ASSISTANT
ANDROID_HOME_ROLE=android.app.role.HOME
PACKAGE_NAME=net.dangish.evogent
if assign_release_android_roles; then exit 91; fi
printf '%s\\n' "$TRACE_LOG"
`;
  const result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, TRACE: '/dev/stderr' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'assistant|proved|\n');
  assert.equal(result.stderr, 'journal:role_assignment_pending\n');
});

test('successful assignment journals intent, verifies assistant, then mutates HOME', () => {
  const assign = shellFunction(installer, 'assign_release_android_roles');
  const harness = `
set -u
${assign}
installed_release_apk_exact() { return 0; }
validate_android_role_backup() { return 0; }
android_roles_have_only_allowed_post_apk_drift() { return 0; }
VERIFY_COUNT=0
verify_release_android_roles() {
  VERIFY_COUNT=$((VERIFY_COUNT + 1))
  [ "$VERIFY_COUNT" -gt 1 ]
}
write_transaction_journal() { TRACE_LOG="\${TRACE_LOG}journal:$1|"; }
rish_command() {
  case "$1" in
    *android.app.role.ASSISTANT*) TRACE_LOG="\${TRACE_LOG}assistant|" ;;
    *android.app.role.HOME*) TRACE_LOG="\${TRACE_LOG}home|" ;;
    *) return 90 ;;
  esac
}
wait_for_release_assistant_activation() { TRACE_LOG="\${TRACE_LOG}assistant-proved|"; }
TRACE_LOG=""
ANDROID_ROLE_RESTORE_REQUIRED=0
ANDROID_ROLE_MUTATION_ATTEMPTED=0
ANDROID_ROLES_APPLIED=0
ANDROID_ROLE_USER_ID=0
ANDROID_ASSISTANT_ROLE=android.app.role.ASSISTANT
ANDROID_HOME_ROLE=android.app.role.HOME
PACKAGE_NAME=net.dangish.evogent
assign_release_android_roles
test "$ANDROID_ROLES_APPLIED" = 1
printf '%s\\n' "$TRACE_LOG"
`;
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'journal:role_assignment_pending|assistant|assistant-proved|home|'
      + 'journal:roles_applied|\n',
  );
});

test('rollback restores roles only after exact APK rollback and never bypasses qualification', () => {
  const rollback = shellFunction(installer, 'rollback_release');
  assert.ok(
    rollback.indexOf('rollback_apk_native')
      < rollback.indexOf('restore_android_roles'),
  );
  assert.ok(
    rollback.indexOf('restore_android_roles')
      < rollback.indexOf('commit_rolled_back_decision'),
  );
  const restore = shellFunction(installer, 'restore_android_roles');
  assert.ok(
    restore.indexOf('restore_android_role_from_snapshot "$ANDROID_HOME_ROLE"')
      < restore.indexOf(
        'restore_android_role_from_snapshot "$ANDROID_ASSISTANT_ROLE"',
      ),
  );
  assert.doesNotMatch(installer, /set-bypassing-role-qualification/);
  assert.doesNotMatch(installer, /pm set-home-activity/);
  assert.doesNotMatch(installer, /settings put secure (?:assistant|voice_interaction_service)/);
});
