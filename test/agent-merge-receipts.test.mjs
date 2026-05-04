import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const tempDirs = [];

const enqueuePostMergeReviewSourcePath = path.join(root, 'scripts', 'agents', 'enqueue-post-merge-review.sh');
const finalizeMergeSourcePath = path.join(root, 'scripts', 'agents', 'finalize-merge.sh');
const receiptHelperSourcePath = path.join(root, 'scripts', 'agents', 'receipt-helpers.sh');
const runAgentSourcePath = path.join(root, 'scripts', 'agents', 'run-agent.sh');

test.afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function installCommonHarnessScripts(scriptsDir, logFile) {
  fs.copyFileSync(receiptHelperSourcePath, path.join(scriptsDir, 'receipt-helpers.sh'));

  writeExecutable(
    path.join(scriptsDir, 'check-push-size.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'check-push-size %s|%s|%s\\n' "$1" "$2" "$3" >> "${logFile}"
`,
  );

  writeExecutable(
    path.join(scriptsDir, 'notify.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'notify %s|%s\\n' "$1" "$2" >> "${logFile}"
`,
  );
}

function installPostMergeReviewScript(scriptsDir) {
  fs.copyFileSync(enqueuePostMergeReviewSourcePath, path.join(scriptsDir, 'enqueue-post-merge-review.sh'));
}

function installFinalizeMergeScript(scriptsDir) {
  fs.copyFileSync(finalizeMergeSourcePath, path.join(scriptsDir, 'finalize-merge.sh'));
}

function installFakeCurl(binDir, logFile) {
  writeExecutable(
    path.join(binDir, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
method="GET"
data=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X)
      method="$2"
      shift 2
      ;;
    -d|--data|--data-raw)
      data="$2"
      shift 2
      ;;
    -H|-o|-w)
      shift 2
      ;;
    --*)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

printf 'curl %s %s\\n' "$method" "$url" >> "${logFile}"

  case "$url" in
  */api/internal/code-fix-orchestrator/resolve?taskId=*)
    if [ "\${FAKE_CURL_RESOLVE_MODE:-existing}" = "missing" ]; then
      exit 22
    fi
    task_id="\${url##*=}"
    printf '{"ok":true,"taskId":"%s","suggestionId":"%s","feedItemId":"%s","originSessionId":"%s"}\\n' "$task_id" "\${FAKE_CURL_RESOLVE_SUGGESTION_ID:-suggestion-resolved-1}" "\${FAKE_CURL_RESOLVE_SUGGESTION_ID:-suggestion-resolved-1}" "\${FAKE_CURL_RESOLVE_ORIGIN_SESSION_ID:-session-resolved-1}"
    ;;
  */api/feed/*)
    if [ "\${FAKE_CURL_FEED_MODE:-existing}" = "missing" ]; then
      exit 22
    fi
    suggestion_id="\${url##*/}"
    printf '{"item":{"id":"%s","originSessionId":"%s"}}\\n' "$suggestion_id" "\${FAKE_CURL_FEED_ORIGIN_SESSION_ID:-session-origin-1}"
    ;;
  */api/chat/sessions?sessionId=*)
    if [ "\${FAKE_CURL_SESSION_EXISTS:-1}" = "0" ]; then
      printf '{"ok":true,"session":null}\\n'
    else
      session_id="\${url##*=}"
      printf '{"ok":true,"session":{"sessionId":"%s"}}\\n' "$session_id"
    fi
    ;;
  */api/chat?sessionId=*)
    if [ "\${FAKE_CURL_DUPLICATE_REVIEW:-0}" = "1" ]; then
      printf '{"items":[{"metadata":{"source":"post_merge_review","mergeCommit":"%s"}}]}\\n' "\${FAKE_CURL_DUPLICATE_MERGE_COMMIT:-}"
    else
      printf '{"items":[]}\\n'
    fi
    ;;
  */api/chat)
    printf 'chat-payload %s\\n' "$data" >> "${logFile}"
    printf '{"ok":true,"enqueued":true}\\n'
    ;;
  *)
    printf '{}\\n'
    ;;
esac
`,
  );
}

test('finalize-merge.sh writes an env-backed receipt for self-orchestrating merges', () => {
  const taskId = 'task-self-orchestrating-receipt';
  const suggestionId = 'suggestion-self-receipt-1';
  const originSessionId = 'session-self-receipt-1';
  const repoDir = makeTempDir('agent-self-merge-repo-');
  const stateDir = path.join(makeTempDir('agent-self-merge-state-'), 'state');
  const scriptsDir = path.join(repoDir, 'scripts', 'agents');

  fs.mkdirSync(scriptsDir, { recursive: true });
  installCommonHarnessScripts(scriptsDir, path.join(repoDir, 'commands.log'));
  installFinalizeMergeScript(scriptsDir);

  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: repoDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-b', taskId], { cwd: repoDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'self-orchestrating receipt\n', 'utf8');
  execFileSync('git', ['add', 'feature.txt'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fix: add feature'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['checkout', 'main'], { cwd: repoDir, stdio: 'ignore' });

  const result = spawnSync('bash', [path.join(scriptsDir, 'finalize-merge.sh'), taskId, 'pass'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      REPO_DIR: repoDir,
      MEDIA_AGENT_STATE_DIR: stateDir,
      MERGE_BRANCH: taskId,
      MERGE_TARGET: 'main',
      PUSH_AFTER_MERGE: '0',
      ENQUEUE_POST_MERGE_REVIEW: '0',
      RECEIPT_REQUIRED: '1',
      CODE_FIX_SUGGESTION_ID: suggestionId,
      CODE_FIX_ORIGIN_SESSION_ID: originSessionId,
      CODE_FIX_PROMPT_SUMMARY: 'Self-orchestrating merge receipt test',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  const commitBody = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: repoDir, encoding: 'utf8' });
  assert.match(commitBody, new RegExp(`Task-Id: ${taskId}`));
  assert.match(commitBody, new RegExp(`Suggestion-Id: ${suggestionId}`));
  assert.match(commitBody, new RegExp(`Origin-Session-Id: ${originSessionId}`));
  assert.match(commitBody, /Validation-Result: pass/);
  assert.match(commitBody, /Files-Touched-Count: 1/);

  const ledgerLines = fs.readFileSync(path.join(repoDir, 'data', 'agent-receipts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(ledgerLines.length, 1);
  const receipt = JSON.parse(ledgerLines[0]);
  assert.equal(receipt.taskId, taskId);
  assert.equal(receipt.mergeCommit, mergeCommit);
  assert.equal(receipt.suggestionId, suggestionId);
  assert.equal(receipt.originSessionId, originSessionId);
  assert.equal(receipt.validationResult, 'pass');
  assert.deepEqual(receipt.filesTouched, ['feature.txt']);
  assert.deepEqual(receipt.diffSummary, { files: 1, insertions: 1, deletions: 0 });
});

test('enqueue-post-merge-review.sh skips silently when the origin session no longer exists', () => {
  const mergeCommit = '1234567890abcdef1234567890abcdef12345678';
  const taskId = 'task-post-merge-review-skip';
  const repoDir = makeTempDir('agent-post-merge-review-repo-');
  const harnessDir = makeTempDir('agent-post-merge-review-harness-');
  const scriptsDir = path.join(harnessDir, 'scripts', 'agents');
  const stateDir = path.join(harnessDir, 'state');
  const binDir = path.join(harnessDir, 'bin');
  const logFile = path.join(harnessDir, 'commands.log');

  fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  installCommonHarnessScripts(scriptsDir, logFile);
  installPostMergeReviewScript(scriptsDir);
  installFakeCurl(binDir, logFile);

  fs.writeFileSync(
    path.join(repoDir, 'data', 'agent-receipts.jsonl'),
    `${JSON.stringify({
      taskId,
      mergeCommit,
      suggestionId: 'suggestion-skip-1',
      validationResult: 'pass',
      filesTouched: ['alpha.ts', 'beta.ts'],
    })}\n`,
    'utf8',
  );

  const result = spawnSync('bash', [path.join(scriptsDir, 'enqueue-post-merge-review.sh'), mergeCommit, taskId], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEDIA_AGENT_STATE_DIR: stateDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_CURL_SESSION_EXISTS: '0',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const commandLog = fs.readFileSync(logFile, 'utf8');
  assert.match(commandLog, /curl GET http:\/\/127\.0\.0\.1:3001\/api\/feed\/suggestion-skip-1/);
  assert.match(commandLog, /curl GET http:\/\/127\.0\.0\.1:3001\/api\/chat\/sessions\?sessionId=session-origin-1/);
  assert.doesNotMatch(commandLog, /curl POST http:\/\/127\.0\.0\.1:3001\/api\/chat/);
});

test('enqueue-post-merge-review.sh resolves task provenance before skipping empty-suggestion receipts', () => {
  const mergeCommit = 'abcdef1234567890abcdef1234567890abcdef12';
  const taskId = 'task-post-merge-review-resolve';
  const repoDir = makeTempDir('agent-post-merge-review-resolve-repo-');
  const harnessDir = makeTempDir('agent-post-merge-review-resolve-harness-');
  const scriptsDir = path.join(harnessDir, 'scripts', 'agents');
  const stateDir = path.join(harnessDir, 'state');
  const binDir = path.join(harnessDir, 'bin');
  const logFile = path.join(harnessDir, 'commands.log');

  fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  installCommonHarnessScripts(scriptsDir, logFile);
  installPostMergeReviewScript(scriptsDir);
  installFakeCurl(binDir, logFile);

  fs.writeFileSync(
    path.join(repoDir, 'data', 'agent-receipts.jsonl'),
    `${JSON.stringify({
      taskId,
      mergeCommit,
      suggestionId: '',
      validationResult: 'pass',
      filesTouched: ['src/lib/example.ts'],
    })}\n`,
    'utf8',
  );

  const result = spawnSync('bash', [path.join(scriptsDir, 'enqueue-post-merge-review.sh'), mergeCommit, taskId], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEDIA_AGENT_STATE_DIR: stateDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_CURL_RESOLVE_SUGGESTION_ID: 'suggestion-resolved-from-task',
      FAKE_CURL_RESOLVE_ORIGIN_SESSION_ID: 'session-resolved-from-task',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const commandLog = fs.readFileSync(logFile, 'utf8');
  assert.match(commandLog, /curl GET http:\/\/127\.0\.0\.1:3001\/api\/internal\/code-fix-orchestrator\/resolve\?taskId=task-post-merge-review-resolve/);
  assert.match(commandLog, /curl GET http:\/\/127\.0\.0\.1:3001\/api\/chat\/sessions\?sessionId=session-resolved-from-task/);
  assert.match(commandLog, /curl GET http:\/\/127\.0\.0\.1:3001\/api\/chat\?sessionId=session-resolved-from-task&limit=100/);
  assert.match(commandLog, /curl POST http:\/\/127\.0\.0\.1:3001\/api\/chat/);

  const chatPayloadLine = commandLog.split('\n').find((line) => line.startsWith('chat-payload '));
  assert.ok(chatPayloadLine);
  const chatPayload = JSON.parse(chatPayloadLine.replace(/^chat-payload /, ''));
  assert.equal(chatPayload.sessionId, 'session-resolved-from-task');
  assert.equal(chatPayload.metadata.source, 'post_merge_review');
  assert.equal(chatPayload.metadata.mergeCommit, mergeCommit);
  assert.equal(chatPayload.metadata.taskId, taskId);
  assert.equal(chatPayload.metadata.suggestionId, 'suggestion-resolved-from-task');
  assert.match(chatPayload.message, /Review landed merge abcdef123456 for suggestion suggestion-resolved-from-task/);
});

test('enqueue-post-merge-review.sh does not enqueue duplicate reviews for the same merge commit', () => {
  const mergeCommit = 'fedcba9876543210fedcba9876543210fedcba98';
  const taskId = 'task-post-merge-review-duplicate';
  const repoDir = makeTempDir('agent-post-merge-review-duplicate-repo-');
  const harnessDir = makeTempDir('agent-post-merge-review-duplicate-harness-');
  const scriptsDir = path.join(harnessDir, 'scripts', 'agents');
  const stateDir = path.join(harnessDir, 'state');
  const binDir = path.join(harnessDir, 'bin');
  const logFile = path.join(harnessDir, 'commands.log');

  fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  installCommonHarnessScripts(scriptsDir, logFile);
  installPostMergeReviewScript(scriptsDir);
  installFakeCurl(binDir, logFile);

  fs.writeFileSync(
    path.join(repoDir, 'data', 'agent-receipts.jsonl'),
    `${JSON.stringify({
      taskId,
      mergeCommit,
      suggestionId: 'suggestion-duplicate-1',
      originSessionId: 'session-duplicate-1',
      validationResult: 'pass',
      filesTouched: ['src/lib/example.ts'],
    })}\n`,
    'utf8',
  );

  const result = spawnSync('bash', [path.join(scriptsDir, 'enqueue-post-merge-review.sh'), mergeCommit, taskId], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEDIA_AGENT_STATE_DIR: stateDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_CURL_DUPLICATE_REVIEW: '1',
      FAKE_CURL_DUPLICATE_MERGE_COMMIT: mergeCommit,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const commandLog = fs.readFileSync(logFile, 'utf8');
  assert.match(commandLog, /curl GET http:\/\/127\.0\.0\.1:3001\/api\/chat\?sessionId=session-duplicate-1&limit=100/);
  assert.doesNotMatch(commandLog, /curl POST http:\/\/127\.0\.0\.1:3001\/api\/chat/);
});

test('run-agent prompt instructs the dev agent to include a Task-Id trailer and wires post-merge review enqueue', () => {
  const script = fs.readFileSync(runAgentSourcePath, 'utf8');
  assert.match(script, /git commit -m \$'type: description\\n\\nTask-Id: \$\{TASK_ID\}'/);
  assert.match(script, /enqueue-post-merge-review\.sh/);
});
