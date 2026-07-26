import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withFeedMutationLock } from './feed-mutation-lock';

test('feed mutation lock serializes callers and remains re-entrant', async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withFeedMutationLock(async () => {
    events.push('first-enter');
    await withFeedMutationLock(async () => {
      events.push('nested-enter');
    });
    await firstGate;
    events.push('first-exit');
  });
  const second = withFeedMutationLock(async () => {
    events.push('second-enter');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(events, ['first-enter', 'nested-enter']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepStrictEqual(events, [
    'first-enter',
    'nested-enter',
    'first-exit',
    'second-enter',
  ]);
});
