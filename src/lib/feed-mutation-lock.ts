import { AsyncLocalStorage } from 'node:async_hooks';

type FeedMutationLockState = {
  tail: Promise<void>;
};

type GlobalWithFeedMutationLock = typeof globalThis & {
  evogentFeedMutationLock?: FeedMutationLockState;
};

const globalWithLock = globalThis as GlobalWithFeedMutationLock;
const state = globalWithLock.evogentFeedMutationLock ?? { tail: Promise.resolve() };
globalWithLock.evogentFeedMutationLock = state;

const ownership = new AsyncLocalStorage<boolean>();

/**
 * Serialize feed submit/arrange/refresh mutations in the one phone server process.
 *
 * Calls made by a locked operation into another protected route are re-entrant.
 * This lets refresh invoke submit and arrange as one critical section while a
 * concurrent app request or curator turn waits, closing stale-snapshot erasure.
 */
export async function withFeedMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  if (ownership.getStore() === true) {
    return operation();
  }

  let release!: () => void;
  const predecessor = state.tail;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;

  try {
    return await ownership.run(true, operation);
  } finally {
    release();
  }
}
