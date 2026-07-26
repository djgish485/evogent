package net.dangish.evogent;

/** Host-side checks for display-0 HOME and anywhere-composer ownership. */
public final class EvogentOverlayVisibilityPolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        require(EvogentOverlayVisibilityPolicy.shouldClosePanel(true, true, false),
                "HOME did not cancel a composer still authenticating");
        require(EvogentOverlayVisibilityPolicy.shouldClosePanel(true, false, true),
                "HOME left an attached anywhere-composer over Evogent");
        require(!EvogentOverlayVisibilityPolicy.shouldClosePanel(false, true, true),
                "another foreground app unexpectedly closed its composer");
        require(!EvogentOverlayVisibilityPolicy.shouldClosePanel(true, false, false),
                "HOME reported a close when no composer existed");
        require(EvogentOverlayVisibilityPolicy.shouldRestartAfterHttpResponse(
                        true, false, 404),
                "trusted main-frame 404 did not request panel teardown/retry");
        require(EvogentOverlayVisibilityPolicy.shouldRestartAfterHttpResponse(
                        true, false, 500),
                "trusted main-frame 500 did not request panel teardown/retry");
        require(EvogentOverlayVisibilityPolicy.shouldRestartAfterHttpResponse(
                        true, true, 200),
                "explicit phone-session gate did not request reauthentication");
        require(!EvogentOverlayVisibilityPolicy.shouldRestartAfterHttpResponse(
                        true, false, 200),
                "successful trusted panel document requested an authentication restart");
        require(!EvogentOverlayVisibilityPolicy.shouldRestartAfterHttpResponse(
                        false, false, 500),
                "external main frame was allowed to drive the panel retry loop");
        require(!EvogentOverlayVisibilityPolicy.shouldRestartAfterHttpResponse(
                        false, true, 401),
                "subframe/external gate response was allowed to drive panel retry");
        System.out.println("EvogentOverlayVisibilityPolicyTest: PASS");
    }
}
