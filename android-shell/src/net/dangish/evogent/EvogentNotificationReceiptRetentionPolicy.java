package net.dangish.evogent;

/**
 * Pure retention ordering for the bounded native notification ledger.
 *
 * Ordinary observation is useful for lifecycle convergence but must never evict a durable
 * cancellation/removal record. Within one class the newest record wins.
 */
final class EvogentNotificationReceiptRetentionPolicy {
    private EvogentNotificationReceiptRetentionPolicy() {}

    /**
     * Only Android's listener-cancel reason proves that a staged automatic replacement caused the
     * removal callback. A user swipe, app cancellation, click, or timeout that wins the race must
     * be handled as an external lifecycle event.
     */
    static boolean isExpectedCuratedRemoval(
            String state,
            boolean listenerCancellation) {
        return listenerCancellation && "curated_cancel_pending".equals(state);
    }

    /**
     * The server dismissal is durable before native user cancellation begins, so any subsequent
     * disappearance resolves that already-recorded user intent regardless of Android's reason.
     */
    static boolean isExpectedUserRemoval(String state) {
        return "user_dismiss_pending".equals(state);
    }

    static int priority(String state) {
        if ("removal_pending".equals(state)
                || "curated_cancel_pending".equals(state)
                || "user_dismiss_pending".equals(state)) {
            return 0;
        }
        if ("receipt".equals(state) || "curated_removed".equals(state)) {
            return 1;
        }
        if ("user_dismissed".equals(state)
                || "external_removed".equals(state)
                || "removed".equals(state)) {
            return 2;
        }
        if ("observed".equals(state)) return 3;
        return 4;
    }
}
