export const VISIBLE_PRESENCE_HEARTBEAT_INTERVAL_MS = 75_000;

interface VisiblePresenceHeartbeatOptions {
  isVisible: () => boolean;
  onPresenceHeartbeat: () => void;
  intervalMs?: number;
  setIntervalImpl?: (callback: () => void, intervalMs: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}

export interface VisiblePresenceHeartbeat {
  sync: () => void;
  dispose: () => void;
}

export function createVisiblePresenceHeartbeat(
  options: VisiblePresenceHeartbeatOptions,
): VisiblePresenceHeartbeat {
  const intervalMs = Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0
    ? Math.floor(options.intervalMs as number)
    : VISIBLE_PRESENCE_HEARTBEAT_INTERVAL_MS;
  const schedule = options.setIntervalImpl
    ?? ((callback: () => void, delayMs: number) => globalThis.setInterval(callback, delayMs));
  const cancel = options.clearIntervalImpl
    ?? ((handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  let intervalHandle: unknown = null;

  const stop = () => {
    if (intervalHandle === null) return;
    cancel(intervalHandle);
    intervalHandle = null;
  };

  const tick = () => {
    if (!options.isVisible()) {
      stop();
      return;
    }
    options.onPresenceHeartbeat();
  };

  const sync = () => {
    if (!options.isVisible()) {
      stop();
      return;
    }
    if (intervalHandle === null) {
      intervalHandle = schedule(tick, intervalMs);
    }
  };

  return {
    sync,
    dispose: stop,
  };
}
