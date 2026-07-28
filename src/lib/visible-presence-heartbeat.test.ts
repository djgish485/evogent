import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createVisiblePresenceHeartbeat,
  VISIBLE_PRESENCE_HEARTBEAT_INTERVAL_MS,
} from '@/lib/visible-presence-heartbeat';
import { PUSH_NOTIFICATION_MIN_FOREGROUND_SUPPRESS_WINDOW_SECONDS } from '@/lib/push-notify';

test('visible presence heartbeat runs below the suppression window and stops while hidden', () => {
  let visible = true;
  let heartbeatCount = 0;
  let nextHandle = 0;
  const scheduled = new Map<number, () => void>();
  const cleared: number[] = [];

  const heartbeat = createVisiblePresenceHeartbeat({
    isVisible: () => visible,
    onPresenceHeartbeat: () => {
      heartbeatCount += 1;
    },
    setIntervalImpl: (callback, intervalMs) => {
      assert.strictEqual(intervalMs, VISIBLE_PRESENCE_HEARTBEAT_INTERVAL_MS);
      const handle = ++nextHandle;
      scheduled.set(handle, callback);
      return handle;
    },
    clearIntervalImpl: (handle) => {
      const numericHandle = Number(handle);
      cleared.push(numericHandle);
      scheduled.delete(numericHandle);
    },
  });

  assert.ok(VISIBLE_PRESENCE_HEARTBEAT_INTERVAL_MS >= 60_000);
  assert.ok(
    VISIBLE_PRESENCE_HEARTBEAT_INTERVAL_MS
      < PUSH_NOTIFICATION_MIN_FOREGROUND_SUPPRESS_WINDOW_SECONDS * 1000,
  );

  heartbeat.sync();
  heartbeat.sync();
  assert.strictEqual(scheduled.size, 1, 'sync must not create overlapping timers');

  scheduled.get(1)?.();
  assert.strictEqual(heartbeatCount, 1);

  visible = false;
  heartbeat.sync();
  assert.deepStrictEqual(cleared, [1]);
  assert.strictEqual(scheduled.size, 0);

  visible = true;
  heartbeat.sync();
  assert.strictEqual(scheduled.size, 1);
  scheduled.get(2)?.();
  assert.strictEqual(heartbeatCount, 2);

  visible = false;
  scheduled.get(2)?.();
  assert.strictEqual(heartbeatCount, 2, 'a delayed hidden-page tick must not report foreground');
  assert.deepStrictEqual(cleared, [1, 2]);

  heartbeat.dispose();
  assert.deepStrictEqual(cleared, [1, 2], 'dispose remains idempotent after a hidden-page stop');
});
