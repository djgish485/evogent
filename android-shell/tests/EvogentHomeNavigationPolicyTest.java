package net.dangish.evogent;

/** Host-side checks for the native HOME recovery and authenticated page-Back contract. */
public final class EvogentHomeNavigationPolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        nativeRecoveryCannotBecomeReadyFromRetryOrFailure();
        automaticRetryKeepsEscapeActionsVisible();
        pageBackAcknowledgementIsFailClosed();
        mainFrameHttpErrorsStayBehindRecovery();
        System.out.println("EvogentHomeNavigationPolicyTest: PASS");
    }

    private static void nativeRecoveryCannotBecomeReadyFromRetryOrFailure() {
        EvogentHomeNavigationPolicy policy = new EvogentHomeNavigationPolicy();
        require(policy.recoveryState()
                        == EvogentHomeNavigationPolicy.RecoveryState.STARTING,
                "cold HOME did not start on the native recovery surface");
        require(policy.shouldShowRecoverySurface(),
                "cold HOME exposed the WebView before authentication");

        policy.showError();
        require(policy.recoveryState() == EvogentHomeNavigationPolicy.RecoveryState.ERROR,
                "authentication failure did not expose recovery actions");
        require(policy.shouldShowRecoverySurface(),
                "failure exposed the unauthenticated WebView");

        policy.showStarting();
        require(policy.shouldShowRecoverySurface(),
                "manual Retry exposed the WebView before document proof");

        policy.markAuthenticatedDocumentReady();
        require(policy.recoveryState() == EvogentHomeNavigationPolicy.RecoveryState.READY,
                "authenticated document did not become ready");
        require(!policy.shouldShowRecoverySurface(),
                "proved document remained hidden behind recovery");
    }

    private static void automaticRetryKeepsEscapeActionsVisible() {
        EvogentHomeNavigationPolicy policy = new EvogentHomeNavigationPolicy();
        policy.showError();
        policy.beginAutomaticAttempt();
        require(policy.recoveryState() == EvogentHomeNavigationPolicy.RecoveryState.ERROR,
                "automatic retry hid the actionable error state");

        policy.markAuthenticatedDocumentReady();
        policy.beginAutomaticAttempt();
        require(policy.recoveryState()
                        == EvogentHomeNavigationPolicy.RecoveryState.STARTING,
                "navigation from a ready page did not cover the WebView while reauthenticating");
    }

    private static void pageBackAcknowledgementIsFailClosed() {
        require(EvogentHomeNavigationPolicy.pageHandledBack("\"handled\""),
                "exact page Back acknowledgement rejected");
        require(!EvogentHomeNavigationPolicy.pageHandledBack(null),
                "missing JavaScript result accepted");
        require(!EvogentHomeNavigationPolicy.pageHandledBack("handled"),
                "non-JSON result accepted");
        require(!EvogentHomeNavigationPolicy.pageHandledBack("\"unhandled\""),
                "page decline accepted as handled");
        require(!EvogentHomeNavigationPolicy.pageHandledBack("\"handled\\n\""),
                "near-match acknowledgement accepted");
    }

    private static void mainFrameHttpErrorsStayBehindRecovery() {
        require(!EvogentHomeNavigationPolicy.rejectsMainFrameHttpStatus(200),
                "successful document rejected");
        require(!EvogentHomeNavigationPolicy.rejectsMainFrameHttpStatus(302),
                "redirect rejected as an HTTP error");
        require(EvogentHomeNavigationPolicy.rejectsMainFrameHttpStatus(404),
                "ordinary 4xx exposed the WebView");
        require(EvogentHomeNavigationPolicy.rejectsMainFrameHttpStatus(500),
                "ordinary 5xx exposed the WebView");
    }
}
