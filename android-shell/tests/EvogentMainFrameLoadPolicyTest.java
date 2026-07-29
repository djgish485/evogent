package net.dangish.evogent;

/** Host-side regression checks for exact main-frame/HOME callback identity. */
public final class EvogentMainFrameLoadPolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        bindingPreservesOrdinaryUrlState();
        rebindingReplacesReservedState();
        malformedOrAmbiguousCallbacksFailClosed();
        staleSameUrlCallbackRetainsItsOriginalHomeRequest();
        onlyTheExactPendingStartCanConsumeAuthorization();
        activeBindingStartRequiresFreshDocumentAuthorization();
        System.out.println("EvogentMainFrameLoadPolicyTest: PASS");
    }

    private static void bindingPreservesOrdinaryUrlState() {
        String bound = EvogentMainFrameLoadPolicy.bind(
                "https://127.0.0.1:3443/path?overlay=1#section",
                7L,
                11L);
        require(bound.equals(
                        "https://127.0.0.1:3443/path?overlay=1"
                                + "&__evogent_load=7&__evogent_home=11#section"),
                "binding changed ordinary path/query/fragment state: " + bound);
        EvogentMainFrameLoadPolicy.Binding parsed =
                EvogentMainFrameLoadPolicy.parse(bound);
        require(parsed != null
                        && parsed.loadGeneration == 7L
                        && parsed.homeAvailabilityRequest == 11L,
                "valid callback binding did not round-trip");
    }

    private static void rebindingReplacesReservedState() {
        String rebound = EvogentMainFrameLoadPolicy.bind(
                "https://127.0.0.1:3443/"
                        + "?__evogent_load=2&x=kept&__evogent_home=3",
                4L,
                0L);
        require(rebound.equals(
                        "https://127.0.0.1:3443/"
                                + "?x=kept&__evogent_load=4&__evogent_home=0"),
                "rebinding accumulated stale reserved parameters: " + rebound);
    }

    private static void malformedOrAmbiguousCallbacksFailClosed() {
        String root = "https://127.0.0.1:3443/";
        require(EvogentMainFrameLoadPolicy.parse(root) == null,
                "unbound callback was accepted");
        require(EvogentMainFrameLoadPolicy.parse(
                        root + "?__evogent_load=1&__evogent_home=0"
                                + "&__evogent_home=2") == null,
                "duplicate HOME binding was accepted");
        require(EvogentMainFrameLoadPolicy.parse(
                        root + "?__evogent_load=01&__evogent_home=0") == null,
                "non-canonical generation was accepted");
        require(EvogentMainFrameLoadPolicy.parse(
                        root + "?__evogent_load=1&__evogent_home=-1") == null,
                "negative HOME request was accepted");
        require(EvogentMainFrameLoadPolicy.parse(
                        root + "?__evogent_load=9223372036854775808"
                                + "&__evogent_home=0") == null,
                "overflowing generation was accepted");
    }

    private static void staleSameUrlCallbackRetainsItsOriginalHomeRequest() {
        String first = EvogentMainFrameLoadPolicy.bind(
                "https://127.0.0.1:3443/", 1L, 41L);
        String second = EvogentMainFrameLoadPolicy.bind(
                "https://127.0.0.1:3443/", 2L, 42L);
        EvogentMainFrameLoadPolicy.Binding stale =
                EvogentMainFrameLoadPolicy.parse(first);
        EvogentMainFrameLoadPolicy.Binding current =
                EvogentMainFrameLoadPolicy.parse(second);
        require(stale != null && current != null && !current.matches(stale),
                "same-URL generations collapsed into one callback identity");
        require(stale.homeAvailabilityRequest == 41L
                        && current.homeAvailabilityRequest == 42L,
                "stale callback borrowed the current HOME request");
    }

    private static void onlyTheExactPendingStartCanConsumeAuthorization() {
        EvogentMainFrameLoadPolicy.Binding stale =
                new EvogentMainFrameLoadPolicy.Binding(8L, 18L);
        EvogentMainFrameLoadPolicy.Binding pending =
                new EvogentMainFrameLoadPolicy.Binding(9L, 19L);
        EvogentMainFrameLoadPolicy.Binding samePending =
                new EvogentMainFrameLoadPolicy.Binding(9L, 19L);
        require(!EvogentMainFrameLoadPolicy.acceptsPendingStart(null, stale),
                "a callback consumed authorization with no pending load");
        require(!EvogentMainFrameLoadPolicy.acceptsPendingStart(pending, stale),
                "a stale callback consumed the newer pending load");
        require(EvogentMainFrameLoadPolicy.acceptsPendingStart(
                        pending, samePending),
                "the exact pending callback was rejected");
    }

    private static void activeBindingStartRequiresFreshDocumentAuthorization() {
        EvogentMainFrameLoadPolicy.Binding active =
                new EvogentMainFrameLoadPolicy.Binding(12L, 22L);
        EvogentMainFrameLoadPolicy.Binding rendererReload =
                new EvogentMainFrameLoadPolicy.Binding(12L, 22L);
        EvogentMainFrameLoadPolicy.Binding stale =
                new EvogentMainFrameLoadPolicy.Binding(11L, 21L);
        require(EvogentMainFrameLoadPolicy.isRendererReloadOfActiveDocument(
                        active, rendererReload),
                "an active-binding renderer reload retained the old document authority");
        require(!EvogentMainFrameLoadPolicy.isRendererReloadOfActiveDocument(
                        active, stale),
                "a stale older-generation callback was mistaken for an active reload");
    }
}
