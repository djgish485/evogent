import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const tools = path.join(root, 'phone-paradigm/device/phone-tools');

function runPythonHelper(helper, ...args) {
  const program = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(tools)})`,
    `from tweet_clean import ${helper}`,
    `print(json.dumps(${helper}(*json.loads(${JSON.stringify(JSON.stringify(args))}))))`,
  ].join('\n');
  const result = spawnSync('python3', ['-c', program], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runVisibleTargets(tweet, tree) {
  return runPythonHelper('visible_tap_targets', tweet, tree);
}

test('X permalink targets use literal visible body phrases instead of one brittle prefix', () => {
  const raw = 'A quoted opening “breaks” the old prefix but this middle phrase stays exact for tapping';
  const tree = [
    'NODES display=22 pkg=com.twitter.android',
    `TextView text="${raw}"`,
  ].join('\n');
  const targets = runVisibleTargets({
    tapText: raw,
    frag: 'A quoted opening breaks the old',
    text: raw,
  }, tree);

  assert.ok(targets.length > 0);
  for (const target of targets) {
    assert.ok(tree.includes(target), target);
  }
  assert.ok(targets.some((target) => target.includes('middle phrase')));
});

test('X permalink targets fail closed when the tweet is not on the current screen', () => {
  const targets = runVisibleTargets({
    tapText: 'This tweet exists only on an earlier screen in the captured timeline',
    text: 'This tweet exists only on an earlier screen in the captured timeline',
  }, 'NODES display=22 pkg=com.twitter.android\nTextView text="A different tweet entirely"');
  assert.deepEqual(targets, []);
});

test('X permalink attribution requires content as well as the author', () => {
  const tweet = {
    handle: 'same_author',
    handleKnown: true,
    text: 'The newer compiler removes four separate allocation passes',
  };
  assert.equal(runPythonHelper(
    'syndication_matches_tweet',
    tweet,
    {
      user: { screen_name: 'same_author' },
      text: 'The newer compiler removes four separate allocation passes in this benchmark.',
    },
    'newer compiler removes four separate allocation passes',
  ), true);
  assert.equal(runPythonHelper(
    'syndication_matches_tweet',
    tweet,
    {
      user: { screen_name: 'same_author' },
      text: 'A completely different post from the same account about dinner plans.',
    },
    'newer compiler removes four separate allocation passes',
  ), false);
  assert.equal(runPythonHelper(
    'syndication_matches_tweet',
    tweet,
    {
      user: { screen_name: 'different_author' },
      text: 'The newer compiler removes four separate allocation passes in this benchmark.',
    },
    'newer compiler removes four separate allocation passes',
  ), false);
});

test('X provisional source ids are stable across process hash seeds', () => {
  const program = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(tools)})`,
    'from tweet_clean import stable_provisional_source_id',
    'print(stable_provisional_source_id("Example", "One stable captured post"))',
  ].join('\n');
  const outputs = ['1', '987654'].map((seed) => spawnSync(
    'python3',
    ['-c', program],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONHASHSEED: seed },
    },
  ));
  for (const result of outputs) {
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(outputs[0].stdout, outputs[1].stdout);
  assert.match(outputs[0].stdout.trim(), /^x-provisional-[a-f0-9]{20}$/);
});
