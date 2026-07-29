package net.dangish.evogent;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Atomically publishes the stock-HOME component resolved for one exact launcher request.
 *
 * Resolution runs outside the Activity thread and may finish after a newer HOME invocation has
 * replaced it. Keeping request, completion, and target in one immutable attempt prevents a stale
 * resolver from pairing its component with a newer request token. A completed null target is
 * distinct from a resolver that has not completed yet.
 */
final class EvogentAndroidHomeResolution<T> {
    static final class Attempt<T> {
        final long request;
        final boolean complete;
        final T target;

        private Attempt(long request, boolean complete, T target) {
            this.request = request;
            this.complete = complete;
            this.target = target;
        }
    }

    private final AtomicReference<Attempt<T>> current =
            new AtomicReference<Attempt<T>>(new Attempt<T>(0L, false, null));

    Attempt<T> begin(long request) {
        if (request == 0L) {
            throw new IllegalArgumentException("request must be nonzero");
        }
        Attempt<T> pending = new Attempt<T>(request, false, null);
        current.set(pending);
        return pending;
    }

    boolean complete(Attempt<T> pending, T target) {
        if (pending == null || pending.request == 0L || pending.complete) return false;
        return current.compareAndSet(
                pending,
                new Attempt<T>(pending.request, true, target));
    }

    Attempt<T> snapshot(long request) {
        Attempt<T> observed = current.get();
        return request != 0L && observed.request == request
                ? observed
                : null;
    }

    void cancel() {
        current.set(new Attempt<T>(0L, false, null));
    }
}
