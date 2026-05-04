import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAgentPrompt } = require('../lib/agent-self-orchestrate.js');
const { buildRepoMergeLockPath, readDevAgentRepoConfig } = require('../lib/repo-agent-config.js');

test('dev-agent repo config auto-detects install and gates without enabling auto-merge', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-dev-config-'));
  try {
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{}\n', 'utf8');
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint', build: 'next build', test: 'node --test' } }),
      'utf8',
    );

    const config = readDevAgentRepoConfig(repoDir);
    assert.equal(config.useWorktree, true);
    assert.equal(config.installCommand, 'npm install');
    assert.deepEqual(config.validationCommands, ['npm run lint', 'npm run build', 'npm test']);
    assert.equal(config.mergeAfterGates, false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('dev-agent repo config edits in place for non-git directories', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-non-git-config-'));
  try {
    const config = readDevAgentRepoConfig(repoDir);
    assert.equal(config.insideGitWorkTree, false);
    assert.equal(config.useWorktree, false);
    assert.equal(config.mergeAfterGates, false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('buildAgentPrompt uses repo-specific merge lock and addon body', () => {
  const repoDir = '/tmp/example-repo';
  const mergeLockPath = buildRepoMergeLockPath(repoDir);
  const prompt = buildAgentPrompt({
    taskId: 'fix-example-123',
    branchName: 'fix-example-123',
    worktreePath: '/tmp/example-repo-worktrees/fix-example-123',
    repoDir,
    internalBaseUrl: 'http://127.0.0.1:3001',
    suggestion: {
      id: 'code-fix-example',
      title: 'Example fix',
      proposedValue: 'Fix the example.',
    },
    repoConfig: {
      addon: { body: 'Repo-specific instructions live here.' },
      insideGitWorkTree: true,
      useWorktree: true,
      installCommand: 'npm install',
      validationCommands: ['npm run lint', 'npm run build', 'npm test'],
      mergeAfterGates: true,
      mergeTarget: 'main',
      baseRef: 'origin/main',
      mergeLockPath,
      receiptAwareMergeScript: 'scripts/agents/finalize-merge.sh',
      postMergeHook: '.claude/hooks/post-merge.sh',
    },
  });

  assert.match(prompt, new RegExp(mergeLockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /cd '\/tmp\/example-repo'/);
  assert.match(prompt, /scripts\/agents\/finalize-merge\.sh/);
  assert.match(prompt, /CODE_FIX_SUGGESTION_ID='code-fix-example'/);
  assert.match(prompt, /POST_MERGE_HOOK='\/tmp\/example-repo\/\.claude\/hooks\/post-merge\.sh'/);
  assert.doesNotMatch(prompt, /git merge --no-ff 'fix-example-123'/);
  assert.doesNotMatch(prompt, /-m 'merge: <short-description>'/);
  assert.match(prompt, /Repo-specific instructions live here\./);
  assert.match(prompt, /status=progress for every intermediate report/);
  assert.match(prompt, /status=done ONLY on the final phase=merged report when you have a real commitSha/);
  assert.match(prompt, /Reporting status=done at any phase other than merged, or without commitSha, will terminate this task as failed/);
  assert.match(prompt, /For intermediate progress: \{ phase: "lint_pass", status: "progress" \}/);
  assert.doesNotMatch(prompt, /CANONICAL_REPO/);
  assert.doesNotMatch(prompt, /\/tmp\/evogent-merge\.lock/);
  assert.doesNotMatch(prompt, /\/root\/evogent/);
});
