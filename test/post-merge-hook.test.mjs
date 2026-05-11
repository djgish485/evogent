import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const hookSourcePath = path.join(root, '.claude', 'hooks', 'post-merge.sh');
const tempDirs = [];

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

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const repoDir = makeTempDir('post-merge-repo-');
  git(['init'], repoDir);
  git(['config', 'user.name', 'Test User'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);

  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n', 'utf8');
  git(['add', 'README.md'], repoDir);
  git(['commit', '-m', 'base'], repoDir);

  fs.mkdirSync(path.join(repoDir, '.claude', 'hooks'), { recursive: true });
  fs.copyFileSync(hookSourcePath, path.join(repoDir, '.claude', 'hooks', 'post-merge.sh'));
  fs.chmodSync(path.join(repoDir, '.claude', 'hooks', 'post-merge.sh'), 0o755);
  fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });

  const binDir = path.join(repoDir, 'bin');
  const logFile = path.join(repoDir, 'npm.log');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(
    path.join(binDir, 'npm'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "${logFile}"
`,
  );

  return {
    repoDir,
    logFile,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
  };
}

test('post-merge hook clears stale same-commit pending restart when current HEAD is already consumed', () => {
  const { repoDir, logFile, env } = createRepo();
  const head = git(['rev-parse', 'HEAD'], repoDir);
  const shortHead = git(['rev-parse', '--short', 'HEAD'], repoDir);

  fs.writeFileSync(
    path.join(repoDir, 'data', 'restart-state.json'),
    JSON.stringify(
      {
        status: 'consumed',
        commit: shortHead,
        commitFull: head,
        summary: 'merge: prior change',
        serviceReadyAt: '2026-04-17T10:00:00.000Z',
        lastUpdatedAt: '2026-04-17T10:00:00.000Z',
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(repoDir, 'data', 'pending-restart.json'),
    JSON.stringify(
      {
        commit: shortHead,
        commitFull: head,
        summary: 'merge: prior change',
        mergedAt: '2026-04-17T09:59:00.000Z',
        pendingAt: '2026-04-17T09:59:00.000Z',
        pendingSource: 'post-merge-hook',
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = spawnSync('bash', [path.join(repoDir, '.claude', 'hooks', 'post-merge.sh')], {
    cwd: repoDir,
    encoding: 'utf8',
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /cleared stale pending restart flag/);
  assert.match(result.stdout, /current HEAD already consumed by running service; skipping pending restart flag/);
  assert.equal(fs.existsSync(path.join(repoDir, 'data', 'pending-restart.json')), false);

  const restartState = JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'restart-state.json'), 'utf8'));
  assert.equal(restartState.status, 'consumed');
  assert.equal(restartState.commitFull, head);
  assert.equal(fs.existsSync(logFile), false);
});

test('post-merge hook writes pending restart when HEAD differs from the last consumed service commit', () => {
  const { repoDir, logFile, env } = createRepo();
  const head = git(['rev-parse', 'HEAD'], repoDir);

  fs.writeFileSync(
    path.join(repoDir, 'data', 'restart-state.json'),
    JSON.stringify(
      {
        status: 'consumed',
        commit: 'oldhead',
        commitFull: '1111111111111111111111111111111111111111',
        summary: 'merge: older change',
        serviceReadyAt: '2026-04-17T10:00:00.000Z',
        lastUpdatedAt: '2026-04-17T10:00:00.000Z',
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = spawnSync('bash', [path.join(repoDir, '.claude', 'hooks', 'post-merge.sh')], {
    cwd: repoDir,
    encoding: 'utf8',
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /post-merge: npm install/);
  assert.match(fs.readFileSync(logFile, 'utf8'), /npm install --prefer-offline/);

  const pendingState = JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'pending-restart.json'), 'utf8'));
  const restartState = JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'restart-state.json'), 'utf8'));

  assert.equal(pendingState.commitFull, head);
  assert.equal(restartState.status, 'pending');
  assert.equal(restartState.commitFull, head);
});

test('post-merge hook syncs changed library files only for installed runtime skills', () => {
  const { repoDir, env } = createRepo();
  const baseHead = git(['rev-parse', 'HEAD'], repoDir);
  const installedRuntimeDir = path.join(repoDir, '.claude', 'skills', 'tweet-cache');
  const installedLibraryDir = path.join(repoDir, 'skills-library', 'tweet-cache');
  const uninstalledLibraryDir = path.join(repoDir, 'skills-library', 'youtube-cache');

  fs.mkdirSync(path.join(installedLibraryDir, 'scripts'), { recursive: true });
  fs.mkdirSync(uninstalledLibraryDir, { recursive: true });
  fs.mkdirSync(installedRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(installedRuntimeDir, 'SKILL.md'), 'old runtime skill\n', 'utf8');
  fs.writeFileSync(path.join(installedLibraryDir, 'SKILL.md'), 'new library skill\n', 'utf8');
  fs.writeFileSync(path.join(installedLibraryDir, 'scripts', 'refresh.sh'), '#!/usr/bin/env bash\n', 'utf8');
  fs.writeFileSync(path.join(uninstalledLibraryDir, 'SKILL.md'), 'uninstalled library skill\n', 'utf8');
  git(['add', 'skills-library'], repoDir);
  git(['commit', '-m', 'update library skills'], repoDir);
  git(['update-ref', 'ORIG_HEAD', baseHead], repoDir);

  const result = spawnSync('bash', [path.join(repoDir, '.claude', 'hooks', 'post-merge.sh')], {
    cwd: repoDir,
    encoding: 'utf8',
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /synced installed skill tweet-cache from skills-library/);
  assert.equal(fs.readFileSync(path.join(installedRuntimeDir, 'SKILL.md'), 'utf8'), 'new library skill\n');
  assert.equal(fs.existsSync(path.join(installedRuntimeDir, 'scripts', 'refresh.sh')), true);
  assert.equal(fs.existsSync(path.join(repoDir, '.claude', 'skills', 'youtube-cache')), false);
});

test('post-merge hook leaves runtime skills alone when skills-library was not changed', () => {
  const { repoDir, env } = createRepo();
  const runtimeDir = path.join(repoDir, '.claude', 'skills', 'tweet-cache');
  const libraryDir = path.join(repoDir, 'skills-library', 'tweet-cache');

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'SKILL.md'), 'runtime local skill\n', 'utf8');
  fs.writeFileSync(path.join(libraryDir, 'SKILL.md'), 'library skill\n', 'utf8');
  git(['add', 'skills-library'], repoDir);
  git(['commit', '-m', 'add library skill'], repoDir);
  const baseHead = git(['rev-parse', 'HEAD'], repoDir);
  fs.appendFileSync(path.join(repoDir, 'README.md'), 'docs only\n', 'utf8');
  git(['add', 'README.md'], repoDir);
  git(['commit', '-m', 'docs only'], repoDir);
  git(['update-ref', 'ORIG_HEAD', baseHead], repoDir);

  const result = spawnSync('bash', [path.join(repoDir, '.claude', 'hooks', 'post-merge.sh')], {
    cwd: repoDir,
    encoding: 'utf8',
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /synced installed skill/);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'SKILL.md'), 'utf8'), 'runtime local skill\n');
});
