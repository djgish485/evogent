import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('setup.sh restarts worker with app and installs deleted-worktree cleanup', () => {
  const setupPath = path.join(process.cwd(), 'scripts', 'setup.sh');
  const cleanupScriptPath = path.join(process.cwd(), 'scripts', 'cleanup-stale-worktree-processes.sh');
  const setupContent = fs.readFileSync(setupPath, 'utf8');
  const cleanupContent = fs.readFileSync(cleanupScriptPath, 'utf8');

  assert.match(setupContent, /STALE_WORKTREE_CLEANUP_SCRIPT="\$\{APP_DIR\}\/scripts\/cleanup-stale-worktree-processes\.sh"/);
  assert.match(setupContent, /bash "\$STALE_WORKTREE_CLEANUP_SCRIPT"/);
  assert.match(setupContent, /systemctl restart evogent-worker\.service evogent\.service/);
  assert.doesNotMatch(setupContent, /systemctl start evogent-worker\.service/);
  assert.doesNotMatch(setupContent, /pkill -f "node server\.js" --older 172800/);

  assert.match(cleanupContent, /WORKTREE_BASE="\$\{APP_DIR\}-worktrees"/);
  assert.match(cleanupContent, /terminating stale node pid=/);
  assert.match(cleanupContent, /kill "\$pid"/);
});
