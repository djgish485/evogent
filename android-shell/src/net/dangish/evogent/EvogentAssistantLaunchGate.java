package net.dangish.evogent;

/**
 * Pure exact-once rendezvous between Android's show callback and assist-context readiness.
 *
 * Android does not guarantee that onShow and onHandleAssist arrive in the order the composer
 * needs. The first side waits; the second side emits one LAUNCH. A timeout is simply an empty
 * context becoming ready. Cancellation permanently turns every late callback into WAIT.
 */
final class EvogentAssistantLaunchGate {
    enum Decision {
        WAIT,
        LAUNCH
    }

    private boolean showReceived;
    private boolean contextReady;
    private boolean launchIssued;
    private boolean cancelled;

    synchronized Decision onShow() {
        showReceived = true;
        return decide();
    }

    synchronized Decision onContextReady() {
        contextReady = true;
        return decide();
    }

    synchronized void cancel() {
        cancelled = true;
    }

    private Decision decide() {
        if (!cancelled && !launchIssued && showReceived && contextReady) {
            launchIssued = true;
            return Decision.LAUNCH;
        }
        return Decision.WAIT;
    }
}
