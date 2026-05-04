import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readDevAgentRepoConfig } = require('../lib/repo-agent-config.js');

function withGitRepo(fn) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-repo-config-'));
  try {
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    fn(repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

test('repo config resolves direct mode without merge or push', () => {
  withGitRepo((repoDir) => {
    fs.writeFileSync(path.join(repoDir, '.evogent-mode.md'), '---\nmode: direct\n---\n', 'utf8');

    const config = readDevAgentRepoConfig(repoDir);

    assert.equal(config.mergeAfterGates, false);
    assert.equal(config.pushAfterMerge, false);
  });
});

test('repo config resolves suggestion-local mode as local merge only', () => {
  withGitRepo((repoDir) => {
    fs.writeFileSync(path.join(repoDir, '.evogent-mode.md'), 'mode: suggestion-local\n', 'utf8');

    const config = readDevAgentRepoConfig(repoDir);

    assert.equal(config.mergeAfterGates, true);
    assert.equal(config.pushAfterMerge, false);
  });
});

test('repo config resolves suggestion-remote mode from mergeAfterGates', () => {
  withGitRepo((repoDir) => {
    fs.writeFileSync(
      path.join(repoDir, '.evogent-mode.md'),
      '---\nmode: suggestion-remote\nmergeAfterGates: true\n---\n',
      'utf8',
    );

    const mergeConfig = readDevAgentRepoConfig(repoDir);
    assert.equal(mergeConfig.mergeAfterGates, true);
    assert.equal(mergeConfig.pushAfterMerge, true);

    fs.writeFileSync(
      path.join(repoDir, '.evogent-mode.md'),
      'mode: suggestion-remote\nmergeAfterGates: false\n',
      'utf8',
    );

    const reviewConfig = readDevAgentRepoConfig(repoDir);
    assert.equal(reviewConfig.mergeAfterGates, false);
    assert.equal(reviewConfig.pushAfterMerge, false);
  });
});

test('repo config falls back to dev-agent addon with remote push behavior intact', () => {
  withGitRepo((repoDir) => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/evogent.git'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.claude/dev-agent-addon.md'),
      [
        '---',
        'mergeAfterGates: true',
        'postMergeHook: .claude/hooks/post-merge.sh',
        '---',
        '',
        'Repo instructions.',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = readDevAgentRepoConfig(repoDir);

    assert.equal(config.mergeAfterGates, true);
    assert.equal(config.pushAfterMerge, true);
    assert.equal(config.postMergeHook, '.claude/hooks/post-merge.sh');
    assert.equal(config.addon.body, 'Repo instructions.');
  });
});

test('repo config keeps addon settings when mode file is present', () => {
  withGitRepo((repoDir) => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/evogent.git'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    fs.writeFileSync(
      path.join(repoDir, '.evogent-mode.md'),
      '---\nmode: suggestion-remote\nmergeAfterGates: true\n---\n',
      'utf8',
    );
    fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.claude/dev-agent-addon.md'),
      '---\npostMergeHook: .claude/hooks/post-merge.sh\n---\n\nRepo instructions.\n',
      'utf8',
    );

    const config = readDevAgentRepoConfig(repoDir);

    assert.equal(config.mergeAfterGates, true);
    assert.equal(config.pushAfterMerge, true);
    assert.equal(config.postMergeHook, '.claude/hooks/post-merge.sh');
    assert.equal(config.addon.body, 'Repo instructions.');
  });
});

test('repo config detects receipt-aware merge support for auto-merge repos', () => {
  withGitRepo((repoDir) => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/evogent.git'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    fs.writeFileSync(
      path.join(repoDir, '.evogent-mode.md'),
      '---\nmode: suggestion-remote\nmergeAfterGates: true\n---\n',
      'utf8',
    );
    fs.mkdirSync(path.join(repoDir, 'scripts', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'scripts', 'agents', 'finalize-merge.sh'), '#!/usr/bin/env bash\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'scripts', 'agents', 'receipt-helpers.sh'), '#!/usr/bin/env bash\n', 'utf8');

    const config = readDevAgentRepoConfig(repoDir);

    assert.equal(config.mergeAfterGates, true);
    assert.equal(config.receiptAwareMergeScript, 'scripts/agents/finalize-merge.sh');
  });
});
