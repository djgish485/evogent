import assert from 'node:assert';
import { describe, test } from 'node:test';
import { analyzePatterns, getTriggerDecision, shouldTrigger } from './heartbeat';

describe('heartbeat core behavior', () => {
  test('analyzePatterns groups usage by hour and day', () => {
    const analysis = analyzePatterns([
      { event: 'app_open', timestamp: '2026-02-23T08:10:00.000Z' },
      { event: 'foreground', timestamp: '2026-02-24T08:15:00.000Z' },
      { event: 'pull_refresh', timestamp: '2026-02-24T12:05:00.000Z' },
      { event: 'app_open', timestamp: '2026-02-25T18:00:00.000Z' },
      { event: 'ping', timestamp: '2026-02-25T18:05:00.000Z' },
    ]);

    assert.strictEqual(analysis.sampleSize, 5);
    assert.ok(analysis.peakHours.includes(8));
    assert.ok(analysis.peakHours.includes(18));
    assert.strictEqual(analysis.dayOfWeekHourlyCounts.some((hours) => hours[18] > 0), true);
  });

  test('shouldTrigger blocks before min interval even with recent activity', () => {
    const decision = getTriggerDecision({
      now: '2026-03-01T12:00:00.000Z',
      lastCurationAt: '2026-03-01T11:30:00.000Z',
      latestActivity: { event: 'pull_refresh', timestamp: '2026-03-01T11:58:00.000Z' },
      activityHistory: [{ event: 'pull_refresh', timestamp: '2026-03-01T11:58:00.000Z' }],
    });

    assert.strictEqual(decision.trigger, false);
    assert.strictEqual(decision.reason, 'min_interval_not_elapsed');
  });

  test('shouldTrigger fires immediately for pull refresh after one hour', () => {
    const trigger = shouldTrigger({
      now: '2026-03-01T12:00:00.000Z',
      lastCurationAt: '2026-03-01T10:30:00.000Z',
      latestActivity: { event: 'pull_refresh', timestamp: '2026-03-01T11:55:00.000Z' },
      activityHistory: [{ event: 'pull_refresh', timestamp: '2026-03-01T11:55:00.000Z' }],
    });

    assert.strictEqual(trigger, true);
  });

  test('shouldTrigger fires for app open after two hours', () => {
    const decision = getTriggerDecision({
      now: '2026-03-01T12:00:00.000Z',
      lastCurationAt: '2026-03-01T09:45:00.000Z',
      latestActivity: { event: 'app_open', timestamp: '2026-03-01T11:50:00.000Z' },
      activityHistory: [{ event: 'app_open', timestamp: '2026-03-01T11:50:00.000Z' }],
    });

    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.reason, 'app_open_auto');
  });

  test('app_open does not bypass a configured min interval above two hours', () => {
    const decision = getTriggerDecision({
      now: '2026-03-01T12:00:00.000Z',
      lastCurationAt: '2026-03-01T09:30:00.000Z',
      latestActivity: { event: 'app_open', timestamp: '2026-03-01T11:58:00.000Z' },
      activityHistory: [{ event: 'app_open', timestamp: '2026-03-01T11:58:00.000Z' }],
      minIntervalMinutes: 180,
      maxIntervalMinutes: 360,
    });

    assert.strictEqual(decision.trigger, false);
    assert.strictEqual(decision.reason, 'min_interval_not_elapsed');
  });

  test('shouldTrigger fires before a predicted usage window', () => {
    const decision = getTriggerDecision({
      now: '2026-03-01T07:35:00.000Z',
      lastCurationAt: '2026-03-01T04:00:00.000Z',
      activityHistory: [
        { event: 'app_open', timestamp: '2026-02-22T08:10:00.000Z' },
        { event: 'app_open', timestamp: '2026-02-23T08:05:00.000Z' },
        { event: 'foreground', timestamp: '2026-02-24T08:25:00.000Z' },
        { event: 'pull_refresh', timestamp: '2026-02-25T08:00:00.000Z' },
      ],
    });

    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.reason, 'predicted_usage_window');
  });

  test('shouldTrigger enforces max interval', () => {
    const decision = getTriggerDecision({
      now: '2026-03-01T12:00:00.000Z',
      lastCurationAt: '2026-03-01T04:30:00.000Z',
      activityHistory: [],
    });

    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.reason, 'max_interval_elapsed');
  });

  test('recent automated cancellation suppresses the same stale app-open window', () => {
    const decision = getTriggerDecision({
      now: '2026-04-27T17:45:01.000Z',
      lastCurationAt: '2026-04-27T15:15:00.000Z',
      latestActivity: { event: 'app_open', timestamp: '2026-04-27T17:39:00.000Z' },
      activityHistory: [{ event: 'app_open', timestamp: '2026-04-27T17:39:00.000Z' }],
      minIntervalMinutes: 120,
      maxIntervalMinutes: 360,
      recentAutomatedCancellation: {
        requestId: 'chat-queue-heartbeat-e2855176-06db-4af9-80f4-bfba8a5534fb',
        cancelledAt: '2026-04-27T17:44:17.000Z',
        triggeredBy: 'adaptive_heartbeat:timer:app_open_auto',
        cancellationReason: 'chat message was cancelled before curation output',
      },
      automaticCancellationCooldownMinutes: 120,
    });

    assert.strictEqual(decision.trigger, false);
    assert.strictEqual(decision.reason, 'user_cancel_cooldown_active');
    assert.strictEqual(
      decision.recentAutomatedCancellation?.requestId,
      'chat-queue-heartbeat-e2855176-06db-4af9-80f4-bfba8a5534fb',
    );
  });

  test('successful manual curation after cancellation resets the cancellation cooldown', () => {
    const decision = getTriggerDecision({
      now: '2026-04-27T17:50:00.000Z',
      lastCurationAt: '2026-04-27T17:47:00.000Z',
      latestActivity: { event: 'app_open', timestamp: '2026-04-27T17:49:00.000Z' },
      activityHistory: [{ event: 'app_open', timestamp: '2026-04-27T17:49:00.000Z' }],
      minIntervalMinutes: 1,
      maxIntervalMinutes: 360,
      recentAutomatedCancellation: {
        requestId: 'chat-queue-heartbeat-cancelled',
        cancelledAt: '2026-04-27T17:44:17.000Z',
        triggeredBy: 'adaptive_heartbeat:timer:app_open_auto',
      },
      automaticCancellationCooldownMinutes: 120,
    });

    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.reason, 'app_open_auto');
  });

  test('prolonged inactivity backs off max-interval automatic curation', () => {
    const decision = getTriggerDecision({
      now: '2026-04-27T12:00:00.000Z',
      lastCurationAt: '2026-04-27T05:30:00.000Z',
      latestActivity: { event: 'app_open', timestamp: '2026-04-24T12:00:00.000Z' },
      activityHistory: [{ event: 'app_open', timestamp: '2026-04-24T12:00:00.000Z' }],
      minIntervalMinutes: 120,
      maxIntervalMinutes: 360,
    });

    assert.strictEqual(decision.trigger, false);
    assert.strictEqual(decision.reason, 'inactivity_backoff_active');
    assert.strictEqual(decision.inactivityBackoffIntervalMinutes, 1080);
  });

  test('prolonged inactivity still allows max-interval curation after the backed-off window', () => {
    const decision = getTriggerDecision({
      now: '2026-04-27T12:00:00.000Z',
      lastCurationAt: '2026-04-26T17:30:00.000Z',
      latestActivity: { event: 'app_open', timestamp: '2026-04-24T12:00:00.000Z' },
      activityHistory: [{ event: 'app_open', timestamp: '2026-04-24T12:00:00.000Z' }],
      minIntervalMinutes: 120,
      maxIntervalMinutes: 360,
    });

    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.reason, 'max_interval_elapsed');
    assert.strictEqual(decision.inactivityBackoffIntervalMinutes, 1080);
  });

  test('returns no_trigger_rule_matched when no trigger conditions apply', () => {
    const decision = getTriggerDecision({
      now: '2026-03-01T12:00:00.000Z',
      lastCurationAt: '2026-03-01T10:30:00.000Z',
      latestActivity: { event: 'foreground', timestamp: '2026-03-01T10:00:00.000Z' },
      activityHistory: [],
    });

    assert.strictEqual(decision.trigger, false);
    assert.strictEqual(decision.reason, 'no_trigger_rule_matched');
  });

  test('analyzePatterns peakHours are sorted by score then hour', () => {
    const analysis = analyzePatterns([
      { event: 'pull_refresh', timestamp: '2026-02-20T10:05:00.000Z' },
      { event: 'pull_refresh', timestamp: '2026-02-21T10:10:00.000Z' },
      { event: 'app_open', timestamp: '2026-02-22T08:00:00.000Z' },
      { event: 'app_open', timestamp: '2026-02-23T08:30:00.000Z' },
      { event: 'ping', timestamp: '2026-02-24T14:00:00.000Z' },
      { event: 'ping', timestamp: '2026-02-25T14:45:00.000Z' },
    ]);

    assert.deepStrictEqual(analysis.peakHours, [10, 8, 14]);
  });

  test('analyzePatterns with empty history returns empty peaks', () => {
    const analysis = analyzePatterns([]);

    assert.strictEqual(analysis.sampleSize, 0);
    assert.deepStrictEqual(analysis.peakHours, []);
    assert.deepStrictEqual(analysis.peakWindows, []);
  });

  test('analyzePatterns applies expected activity weights', () => {
    const analysis = analyzePatterns([
      { event: 'pull_refresh', timestamp: '2026-02-20T09:00:00.000Z' },
      { event: 'app_open', timestamp: '2026-02-20T09:01:00.000Z' },
      { event: 'ping', timestamp: '2026-02-20T09:02:00.000Z' },
      { event: 'foreground', timestamp: '2026-02-20T09:03:00.000Z' },
      { event: 'background', timestamp: '2026-02-20T09:04:00.000Z' },
    ]);

    assert.strictEqual(analysis.hourlyCounts[9], 10);
    const summedAcrossDays = analysis.dayOfWeekHourlyCounts.reduce((sum, day) => sum + day[9], 0);
    assert.strictEqual(summedAcrossDays, 10);
  });

  test('multiple pull_refresh events within min interval do not re-trigger', () => {
    const decision = getTriggerDecision({
      now: '2026-03-01T12:00:00.000Z',
      lastCurationAt: '2026-03-01T11:30:00.000Z',
      latestActivity: { event: 'pull_refresh', timestamp: '2026-03-01T11:59:00.000Z' },
      activityHistory: [
        { event: 'pull_refresh', timestamp: '2026-03-01T11:58:00.000Z' },
        { event: 'pull_refresh', timestamp: '2026-03-01T11:59:00.000Z' },
      ],
    });

    assert.strictEqual(decision.trigger, false);
    assert.strictEqual(decision.reason, 'min_interval_not_elapsed');
  });
});
