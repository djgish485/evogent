import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
