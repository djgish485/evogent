import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  calculateScrollDepthPercent,
  createActiveDwellTracker,
  createScrollDepthTracker,
  createUserScrollEvidenceTracker,
} from './feed-engagement-signals';

describe('feed engagement signal mechanics', () => {
  test('calculates visible depth from the bottom edge of the viewport', () => {
    assert.strictEqual(calculateScrollDepthPercent({
      scrollTop: 0,
      viewportHeight: 500,
      scrollHeight: 2_000,
    }), 25);
    assert.strictEqual(calculateScrollDepthPercent({
      scrollTop: 250,
      viewportHeight: 500,
      scrollHeight: 500,
    }), 100);
  });

  test('recalculates conservatively when asynchronously loaded content grows', () => {
    const tracker = createScrollDepthTracker();
    assert.strictEqual(tracker.observe({
      scrollTop: 0,
      viewportHeight: 500,
      scrollHeight: 500,
    }), 100);
    assert.strictEqual(tracker.observe({
      scrollTop: 0,
      viewportHeight: 500,
      scrollHeight: 2_000,
    }), 25);
    assert.strictEqual(tracker.observe({
      scrollTop: 1_000,
      viewportHeight: 500,
      scrollHeight: 2_000,
    }), 75);
  });

  test('counts foreground intervals without inflating hidden time', () => {
    let nowMs = 1_000;
    const tracker = createActiveDwellTracker(() => nowMs);

    tracker.resume();
    nowMs = 4_500;
    assert.strictEqual(tracker.pause(), 3_500);

    nowMs = 40_000;
    assert.strictEqual(tracker.read(), 3_500);

    tracker.resume();
    nowMs = 41_250;
    assert.strictEqual(tracker.read(), 4_750);
    assert.strictEqual(tracker.pause(), 4_750);
  });

  test('requires both user scroll intent and meaningful viewport movement', () => {
    let nowMs = 1_000;
    const tracker = createUserScrollEvidenceTracker(24, () => nowMs);

    assert.strictEqual(tracker.observe(800), false, 'restored position is not user evidence');
    tracker.noteIntent(800);
    assert.strictEqual(tracker.observe(815), false, 'tiny gesture is not meaningful');
    assert.strictEqual(tracker.observe(825), true);
    assert.strictEqual(tracker.observe(0), true, 'evidence stays monotonic');

    const expiring = createUserScrollEvidenceTracker(24, () => nowMs, 1_500);
    expiring.noteIntent(100);
    nowMs += 1_501;
    assert.strictEqual(
      expiring.observe(200),
      false,
      'a later programmatic movement cannot reuse stale touch intent',
    );
  });
});
