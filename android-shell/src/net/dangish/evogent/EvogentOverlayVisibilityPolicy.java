package net.dangish.evogent;

/** Pure lifecycle rule shared by the display-0 overlay host and its host-side release test. */
final class EvogentOverlayVisibilityPolicy {
    private EvogentOverlayVisibilityPolicy() {}

    /**
     * Evogent already contains its own composer. An anywhere-composer request or attached panel
     * must be torn down as soon as Evogent becomes the foreground app, even if authentication or
     * WebView construction is still in flight.
     */
    static boolean shouldClosePanel(
            boolean foregroundIsEvogent,
            boolean panelRequested,
            boolean panelAttached) {
        return foregroundIsEvogent && (panelRequested || panelAttached);
    }

    /**
     * A trusted origin and valid server proof do not make an HTTP error document usable. Tear the
     * panel down and reauthenticate for every trusted main-frame 4xx/5xx, not only the explicit
     * phone-session gate response. Subframes and external origins cannot drive the retry loop.
     */
    static boolean shouldRestartAfterHttpResponse(
            boolean trustedMainFrame,
            boolean phoneSessionGateResponse,
            int statusCode) {
        return trustedMainFrame
                && (phoneSessionGateResponse
                    || EvogentHomeNavigationPolicy.rejectsMainFrameHttpStatus(statusCode));
    }
}
