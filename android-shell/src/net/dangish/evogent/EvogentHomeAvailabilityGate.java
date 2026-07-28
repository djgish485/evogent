package net.dangish.evogent;

/**
 * Exact-once gate for a system-HOME invocation waiting on a fresh Evogent process proof.
 *
 * Explicit Evogent launches never arm this gate. A request token prevents an old timeout or
 * authentication callback from redirecting or dispatching into a later launch. A previously
 * cached proof is deliberately not an input: every system-HOME invocation arms a new request.
 * Once a fresh proof or one failure wins, every duplicate/stale signal becomes a no-op.
 */
final class EvogentHomeAvailabilityGate {
    enum Decision {
        WAIT,
        FALL_BACK_TO_ANDROID
    }

    private long nextRequest;
    private long activeRequest;

    synchronized long arm() {
        long request = ++nextRequest;
        activeRequest = request;
        return request;
    }

    synchronized boolean markUsable(long request) {
        if (request == 0L || request != activeRequest) return false;
        activeRequest = 0L;
        return true;
    }

    synchronized void cancel() {
        activeRequest = 0L;
        ++nextRequest;
    }

    synchronized Decision onUnavailable(long request) {
        if (request == 0L || request != activeRequest) return Decision.WAIT;
        activeRequest = 0L;
        return Decision.FALL_BACK_TO_ANDROID;
    }
}
