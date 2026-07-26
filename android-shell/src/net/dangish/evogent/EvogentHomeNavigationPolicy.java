package net.dangish.evogent;

/**
 * Pure-Java presentation state for the native HOME recovery surface and strict parsing for the
 * page-level Back acknowledgement.
 *
 * The recovery surface is deliberately native: an unavailable or unauthenticated WebView must
 * never get to impersonate the launcher's only escape hatch. READY is reached only after the
 * caller has completed the authenticated document proof.
 */
final class EvogentHomeNavigationPolicy {
    enum RecoveryState {
        STARTING,
        ERROR,
        READY
    }

    private RecoveryState recoveryState = RecoveryState.STARTING;

    RecoveryState recoveryState() {
        return recoveryState;
    }

    void showStarting() {
        recoveryState = RecoveryState.STARTING;
    }

    /**
     * Automatic retries keep the useful error actions visible instead of flashing a starting
     * screen every few seconds. Initial loads and navigations from a ready document still show
     * the native starting surface.
     */
    void beginAutomaticAttempt() {
        if (recoveryState != RecoveryState.ERROR) {
            recoveryState = RecoveryState.STARTING;
        }
    }

    void showError() {
        recoveryState = RecoveryState.ERROR;
    }

    void markAuthenticatedDocumentReady() {
        recoveryState = RecoveryState.READY;
    }

    boolean shouldShowRecoverySurface() {
        return recoveryState != RecoveryState.READY;
    }

    /**
     * evaluateJavascript returns JSON-encoded values. Accept only our exact sentinel; missing,
     * malformed, exception, and forged-looking partial results all fall back to trusted native
     * WebView history/root handling.
     */
    static boolean pageHandledBack(String javascriptResult) {
        return "\"handled\"".equals(javascriptResult);
    }

    /**
     * Process identity proves who served a document, not that the document is usable. Any
     * main-frame HTTP error must keep native recovery above the WebView.
     */
    static boolean rejectsMainFrameHttpStatus(int statusCode) {
        return statusCode >= 400;
    }
}
