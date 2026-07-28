import { randomUUID } from 'node:crypto';

const SERVER_PROCESS_EPOCH_KEY = Symbol.for('evogent.server-process-epoch.v1');

/**
 * Returns one opaque identity for this Node process.
 *
 * Next may evaluate separate copies of a module in different route bundles.
 * The global symbol registry and global object keep those copies on the same
 * boot epoch without writing any process identity to behavioral history.
 */
export function getServerProcessEpoch(): string {
  const processGlobal = globalThis as Record<PropertyKey, unknown>;
  const existing = processGlobal[SERVER_PROCESS_EPOCH_KEY];
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }

  const epoch = randomUUID();
  Object.defineProperty(globalThis, SERVER_PROCESS_EPOCH_KEY, {
    value: epoch,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return epoch;
}
