import assert from 'node:assert/strict';
import { test } from 'node:test';
import { predictNextOpen, toSessionStarts } from './anticipation-schedule';

function localTime(daysAgo: number, hour: number, minute: number, base = new Date('2026-07-11T12:00:00')): number {
  const date = new Date(base);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

test('toSessionStarts coalesces bursts within 30 minutes', () => {
  const base = localTime(0, 9, 0);
  const starts = toSessionStarts([base, base + 5 * 60000, base + 20 * 60000, base + 3 * 3600000]);
  assert.equal(starts.length, 2);
  assert.equal(starts[0], base);
  assert.equal(starts[1], base + 3 * 3600000);
});

test('predicts the next habitual hour from a repeated daily pattern', () => {
  // Opens at ~17:10 on each of the last 3 days; now is 12:00 today.
  const opens = [1, 2, 3].map((daysAgo) => localTime(daysAgo, 17, 10));
  const now = new Date('2026-07-11T12:00:00').getTime();
  const prediction = predictNextOpen(now, opens);
  assert.ok(prediction.predictedOpenAtMs !== null);
  const predicted = new Date(prediction.predictedOpenAtMs!);
  assert.equal(predicted.getHours(), 17);
  assert.equal(predicted.getMinutes(), 10);
  assert.equal(prediction.basis.fallback, 'none');
  assert.equal(prediction.basis.chosenHourProbability, 1);
});

test('skips a habitual hour that has already passed today', () => {
  // Habitual 9am opens; it is 12:00 — the prediction must land on TOMORROW 9am, not today.
  const opens = [1, 2, 3].map((daysAgo) => localTime(daysAgo, 9, 5));
  const now = new Date('2026-07-11T12:00:00').getTime();
  const prediction = predictNextOpen(now, opens);
  const predicted = new Date(prediction.predictedOpenAtMs!);
  assert.equal(predicted.getHours(), 9);
  assert.ok(prediction.predictedOpenAtMs! > now + 12 * 3600000);
});

test('sub-threshold history still yields the best available hour', () => {
  // One open at 15:30 two days ago, one at 20:00 yesterday: no hour clears 0.5 across 2 days
  // observed... each hour has 1/2 = 0.5 which clears the threshold; use 3 distinct days with
  // singleton hours so each probability is 1/3.
  const opens = [localTime(1, 20, 0), localTime(2, 15, 30), localTime(3, 8, 15)];
  const now = new Date('2026-07-11T12:00:00').getTime();
  const prediction = predictNextOpen(now, opens);
  assert.ok(prediction.predictedOpenAtMs !== null);
  assert.equal(prediction.basis.fallback, 'none');
  // 15:30 is the earliest upcoming candidate and ties on probability — scan order prefers it.
  assert.equal(new Date(prediction.predictedOpenAtMs!).getHours(), 15);
});

test('no history returns null with an explicit basis', () => {
  const prediction = predictNextOpen(Date.now(), []);
  assert.equal(prediction.predictedOpenAtMs, null);
  assert.equal(prediction.basis.fallback, 'no-history');
});
