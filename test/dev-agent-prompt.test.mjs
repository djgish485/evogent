import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAgentPrompt } = require('../lib/dev-agent-prompt.js');

test('dev-agent prompt omits fetch and push for local merges', () => {
  const prompt = buildAgentPrompt({
    taskId: 'fix-local-123',
    branchName: 'fix-local-123',
    worktreePath: '/tmp/example-worktrees/fix-local-123',
    repoDir: '/tmp/example',
    internalBaseUrl: 'http://127.0.0.1:3001',
    suggestion: { id: 'code-fix-local', proposedValue: 'Fix locally.' },
    repoConfig: {
      addon: { body: '' },
      insideGitWorkTree: true,
      useWorktree: true,
      installCommand: 'npm install',
      validationCommands: ['npm test'],
      mergeAfterGates: true,
      pushAfterMerge: false,
      mergeTarget: 'master',
      baseRef: 'master',
      mergeLockPath: '/tmp/code-fix-merge-example.lock',
      receiptAwareMergeScript: 'scripts/agents/finalize-merge.sh',
    },
  });

  assert.match(prompt, /git checkout 'master'/);
  assert.match(prompt, /scripts\/agents\/finalize-merge\.sh/);
  assert.match(prompt, /PUSH_AFTER_MERGE='0'/);
  assert.match(prompt, /ENQUEUE_POST_MERGE_REVIEW='0'/);
  assert.match(prompt, /RECEIPT_REQUIRED='1'/);
  assert.match(prompt, /CODE_FIX_SUGGESTION_ID='code-fix-local'/);
  assert.doesNotMatch(prompt, /git merge --no-ff 'fix-local-123'/);
  assert.doesNotMatch(prompt, /-m 'merge: <short-description>'/);
  assert.doesNotMatch(prompt, /git fetch origin/);
  assert.doesNotMatch(prompt, /git push origin/);
});

test('dev-agent prompt refuses auto-merge when receipt script is missing', () => {
  const prompt = buildAgentPrompt({
    taskId: 'fix-no-receipt-123',
    branchName: 'fix-no-receipt-123',
    worktreePath: '/tmp/example-worktrees/fix-no-receipt-123',
    repoDir: '/tmp/example',
    internalBaseUrl: 'http://127.0.0.1:3001',
    suggestion: { id: 'code-fix-no-receipt', proposedValue: 'Fix without receipt support.' },
    repoConfig: {
      addon: { body: '' },
      insideGitWorkTree: true,
      useWorktree: true,
      installCommand: 'npm install',
      validationCommands: ['npm test'],
      mergeAfterGates: true,
      pushAfterMerge: true,
      mergeTarget: 'main',
      baseRef: 'origin/main',
      mergeLockPath: '/tmp/code-fix-merge-example.lock',
    },
  });

  assert.match(prompt, /does not expose a receipt-aware merge script/);
  assert.match(prompt, /Do not run a bare git merge or push/);
  assert.match(prompt, /Do not send status=done on this no-receipt\/no-merge path/);
  assert.doesNotMatch(prompt, /git merge --no-ff/);
  assert.doesNotMatch(prompt, /git push origin/);
});
