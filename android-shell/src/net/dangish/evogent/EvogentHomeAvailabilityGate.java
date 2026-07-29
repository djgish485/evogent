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

    enum FallbackResult {
        NOT_CURRENT,
        EXPIRED_WHILE_BACKGROUND,
        LAUNCHED,
        LAUNCH_FAILED
    }

    interface FallbackAction {
        boolean launch();
    }

    private long nextRequest;
    private long activeRequest;
    private long launchedRequest;
    private boolean foreground;

    synchronized void enterForeground() {
        foreground = true;
    }

    /**
     * Linearizes an Activity pause against an off-main fallback launch.
     *
     * A pause that wins first cancels the request. If startActivity already completed while this
     * monitor was held, preserve the request just long enough for the launch-completion cleanup.
     */
    synchronized boolean leaveForeground(long request) {
        foreground = false;
        if (request != 0L && request == launchedRequest) return true;
        activeRequest = 0L;
        launchedRequest = 0L;
        ++nextRequest;
        return false;
    }

    synchronized long arm() {
        return armLocked();
    }

    /**
     * Replaces a HOME request and enters foreground in one ordering point.
     *
     * A HOME intent delivered to a paused singleTask Activity uses this on resume. The old
     * deadline therefore either expires while backgrounded first, or becomes stale before the
     * Activity is marked foreground; it can never launch during the gap between those actions.
     */
    synchronized long enterForegroundAndArm() {
        foreground = true;
        return armLocked();
    }

    private long armLocked() {
        long request = ++nextRequest;
        activeRequest = request;
        launchedRequest = 0L;
        return request;
    }

    synchronized boolean markUsable(long request) {
        if (!foreground || request == 0L || request != activeRequest) return false;
        activeRequest = 0L;
        return true;
    }

    synchronized boolean isActive(long request) {
        return request != 0L && request == activeRequest;
    }

    synchronized void cancel() {
        activeRequest = 0L;
        launchedRequest = 0L;
        ++nextRequest;
    }

    synchronized Decision onUnavailable(long request) {
        if (request == 0L || request != activeRequest) return Decision.WAIT;
        activeRequest = 0L;
        return Decision.FALL_BACK_TO_ANDROID;
    }

    /**
     * Atomically checks foreground ownership, consumes the exact request, and starts fallback.
     *
     * The action intentionally runs under this monitor. It is one bounded startActivity call, and
     * keeping it inside the critical section gives onPause a real ordering: pause-first cancels;
     * launch-first completes its request before pause can return.
     */
    synchronized FallbackResult launchFallbackIfCurrent(
            long request,
            FallbackAction action) {
        if (request == 0L
                || request != activeRequest
                || action == null) {
            return FallbackResult.NOT_CURRENT;
        }
        if (!foreground) {
            // A HOME intent can arrive while singleTask is paused. Its absolute deadline must
            // still retire the token without launching over whatever app is currently visible.
            // onResume will see the inactive token and arm a fresh foreground budget.
            activeRequest = 0L;
            launchedRequest = 0L;
            return FallbackResult.EXPIRED_WHILE_BACKGROUND;
        }
        activeRequest = 0L;
        boolean launched = false;
        try {
            launched = action.launch();
        } catch (Throwable ignored) {
            launched = false;
        }
        launchedRequest = launched ? request : 0L;
        return launched
                ? FallbackResult.LAUNCHED
                : FallbackResult.LAUNCH_FAILED;
    }
}
