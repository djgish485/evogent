package net.dangish.evogent;

/** Host-side safety tests for notification observation, redaction, and replacement. */
public final class EvogentNotificationPolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static EvogentNotificationPolicy.Input input(
            String pkg,
            String category,
            int flags,
            int importance,
            boolean clearable,
            boolean ongoing,
            boolean fullScreen,
            boolean groupSummary,
            boolean conversation,
            int visibility,
            String title,
            String text) {
        return new EvogentNotificationPolicy.Input(
                pkg,
                category,
                flags,
                importance,
                clearable,
                ongoing,
                fullScreen,
                groupSummary,
                conversation,
                visibility,
                title,
                text,
                null);
    }

    private static EvogentNotificationPolicy.Decision ordinary() {
        return EvogentNotificationPolicy.decide(input(
                "example.reader",
                "recommendation",
                0,
                3,
                true,
                false,
                false,
                false,
                false,
                0,
                "A new article",
                "A useful article is ready"));
    }

    public static void main(String[] args) {
        EvogentNotificationPolicy.Decision self = EvogentNotificationPolicy.decide(input(
                EvogentNotificationPolicy.EVOGENT_PACKAGE,
                "status",
                0,
                2,
                true,
                false,
                false,
                false,
                false,
                0,
                "Evogent",
                "Digest"));
        require(!self.ingest, "Evogent digest would recurse into curation");

        EvogentNotificationPolicy.Decision normal = ordinary();
        require(normal.ingest, "ordinary app notification was dropped");
        require(normal.nativeCanSuppress, "eligible ordinary notification cannot be curated");
        require(!normal.redactContent, "ordinary content was unexpectedly redacted");
        require("low".equals(normal.priority), "recommendation priority is not low");

        exactLowStakesWireAllowlist();
        realAndroidWireLiteralsAreProtectedAndPrioritized();
        missingUnknownCaseVariantAndConversationFailClosed();

        requireProtected("alarm", 0, 3, true, false, false, "alarm was suppressible");
        requireProtected("call", 0, 3, true, false, false, "call was suppressible");
        requireProtected("navigation", 0, 3, true, false, false, "navigation was suppressible");
        requireProtected("service", 0, 3, true, false, false, "service was suppressible");
        requireProtected("recommendation", 0, 4, true, false, false,
                "high-importance notification was suppressible");
        requireProtected(
                "recommendation",
                0,
                EvogentNotificationPolicy.IMPORTANCE_UNSPECIFIED,
                true,
                false,
                false,
                "unranked notification was suppressible");
        requireProtected("recommendation", 0, 3, false, false, false,
                "non-clearable notification was suppressible");
        requireProtected("recommendation", 0, 3, true, true, false,
                "ongoing notification was suppressible");
        requireProtected("recommendation", 0, 3, true, false, true,
                "full-screen notification was suppressible");

        EvogentNotificationPolicy.Decision group = EvogentNotificationPolicy.decide(input(
                "example.reader",
                "recommendation",
                0,
                3,
                true,
                false,
                false,
                true,
                false,
                0,
                "Summary",
                "Three updates"));
        require(group.protectedFromSuppression, "group summary was suppressible");

        EvogentNotificationPolicy.Decision system = EvogentNotificationPolicy.decide(input(
                "com.android.systemui",
                "system",
                0,
                3,
                true,
                false,
                false,
                false,
                false,
                0,
                "System safety message",
                "Private device state"));
        require(system.protectedFromSuppression, "system safety notification was suppressible");
        require(system.redactContent, "system safety content crossed the bridge");
        require(system.safeTitle == null && system.safeText == null,
                "system safety raw fields remained in transport output");

        String rawOtp = "Your verification code is 123456";
        EvogentNotificationPolicy.Input otpInput = input(
                "example.accounts",
                "message",
                0,
                3,
                true,
                false,
                false,
                false,
                true,
                0,
                "Account",
                rawOtp);
        EvogentNotificationPolicy.Decision otp =
                EvogentNotificationPolicy.decide(otpInput);
        require(otp.redactContent, "known one-time secret was not redacted");
        require(otp.protectedFromSuppression, "one-time secret original was suppressible");
        require(otp.safeText == null || !otp.safeText.contains("123456"),
                "raw one-time secret remained in transport output");
        EvogentNotificationPolicy.Input differentOtpInput = input(
                "example.accounts",
                "message",
                0,
                3,
                true,
                false,
                false,
                false,
                true,
                0,
                "Account",
                "Your verification code is 654321");
        require(EvogentNotificationPolicy.eventId(
                        otpInput,
                        "notification-key",
                        1000L).equals(EvogentNotificationPolicy.eventId(
                                differentOtpInput,
                                "notification-key",
                                1000L)),
                "redacted low-entropy secret remained distinguishable in lifecycle identity");

        EvogentNotificationPolicy.Decision secret = EvogentNotificationPolicy.decide(input(
                "example.private",
                "message",
                0,
                3,
                true,
                false,
                false,
                false,
                true,
                -1,
                "Secret",
                "Do not expose"));
        require(secret.redactContent, "VISIBILITY_SECRET content was not redacted");

        EvogentNotificationPolicy.Input eventInput = input(
                "example.reader", "recommendation", 0, 3, true, false, false,
                false, false, 0, "Title", "Body");
        String eventA = EvogentNotificationPolicy.eventId(
                eventInput, "notification-key", 1000L);
        String eventB = EvogentNotificationPolicy.eventId(
                eventInput, "notification-key", 1001L);
        EvogentNotificationPolicy.Input replacementInput = input(
                "example.reader", "recommendation", 0, 3, true, false, false,
                false, false, 0, "Title", "Replacement");
        String eventReplacement = EvogentNotificationPolicy.eventId(
                replacementInput, "notification-key", 1000L);
        EvogentNotificationPolicy.Input protectedInput = input(
                "example.reader", "recommendation", 0, 4, true, false, false,
                false, false, 0, "Title", "Body");
        String protectedEvent = EvogentNotificationPolicy.eventId(
                protectedInput, "notification-key", 1000L);
        require(!eventA.equals(eventB), "post time was not bound into receipt");
        require(!eventA.equals(eventReplacement), "content generation was not bound into receipt");
        require(!eventA.equals(protectedEvent),
                "suppression-relevant ranking drift reused event id");

        require(EvogentNotificationPolicy.shouldCancelOriginal(
                        normal,
                        eventA,
                        eventA,
                        true,
                        "curated",
                        true,
                        true,
                        true,
                        true,
                        true),
                "fully proven curated replacement was rejected");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "observe",
                        true, true, true, true, true),
                "OBSERVE mode cancelled an original");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventB, true, "curated",
                        true, true, true, true, true),
                "stale receipt cancelled a repost");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, false, "curated",
                        true, true, true, true, true),
                "server persistence failure cancelled an original");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "curated",
                        true, true, true, false, true),
                "digest publication failure cancelled an original");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "curated",
                        true, true, false, false, true),
                "missing digest capability cancelled an original");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "curated",
                        true, true, true, true, false),
                "changed active generation was cancelled");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "curated",
                        false, true, true, true, true),
                "package without explicit replacement permission was cancelled");
        require(EvogentNotificationPolicy.mayCancelFromLiveSequence(false, 3L),
                "current live work lost cancellation authority");
        require(EvogentNotificationPolicy.mayCancelFromLiveSequence(false, 2L),
                "older-arrival work with the freshest serialized response lost authority");
        require(!EvogentNotificationPolicy.mayCancelFromLiveSequence(false, 0L),
                "invalid live sequence gained cancellation authority");
        require(!EvogentNotificationPolicy.mayCancelFromLiveSequence(true, 1L),
                "historical scan gained cancellation authority");

        long nowMs = 1_800_000_000_000L;
        require(EvogentNotificationPolicy.digestTimeoutAfterMs(
                        nowMs + 60_000L, nowMs) == 60_000L,
                "valid absolute digest expiry did not preserve its exact remaining lifetime");
        require(EvogentNotificationPolicy.digestTimeoutAfterMs(nowMs, nowMs) == 0L,
                "equal-now digest expiry retained replacement authority");
        require(EvogentNotificationPolicy.digestTimeoutAfterMs(nowMs - 1L, nowMs) == 0L,
                "expired digest retained replacement authority");
        require(EvogentNotificationPolicy.digestTimeoutAfterMs(
                        nowMs + EvogentNotificationPolicy.MAX_DIGEST_TIMEOUT_MS,
                        nowMs) == EvogentNotificationPolicy.MAX_DIGEST_TIMEOUT_MS,
                "maximum bounded digest timeout was rejected");
        require(EvogentNotificationPolicy.digestTimeoutAfterMs(
                        nowMs + EvogentNotificationPolicy.MAX_DIGEST_TIMEOUT_MS + 1L,
                        nowMs) == 0L,
                "implausibly distant digest expiry gained replacement authority");
        require(EvogentNotificationPolicy.digestTimeoutAfterMs(
                        Long.MAX_VALUE, nowMs) == 0L,
                "overflow-scale digest expiry gained replacement authority");
        require(EvogentNotificationPolicy.digestTimeoutAfterMs(nowMs + 1L, 0L) == 0L,
                "invalid native wall clock gained replacement authority");

        System.out.println("EvogentNotificationPolicyTest: PASS");
    }

    private static void exactLowStakesWireAllowlist() {
        for (String category : new String[] {"promo", "recommendation", "social"}) {
            EvogentNotificationPolicy.Decision decision =
                    EvogentNotificationPolicy.decide(input(
                            "example.editorial",
                            category,
                            0,
                            3,
                            true,
                            false,
                            false,
                            false,
                            false,
                            0,
                            "Title",
                            "Body"));
            require(decision.nativeCanSuppress,
                    "exact low-stakes category was not eligible: " + category);
            require(!decision.protectedFromSuppression,
                    "exact low-stakes category was protected: " + category);
            require(decision.protectionReason == null,
                    "eligible category carried a protection reason: " + category);
        }
    }

    private static void realAndroidWireLiteralsAreProtectedAndPrioritized() {
        EvogentNotificationPolicy.Decision message = decisionFor("msg", false);
        require(message.protectedFromSuppression && !message.nativeCanSuppress,
                "Android CATEGORY_MESSAGE wire literal was suppressible");
        require("high".equals(message.priority),
                "Android CATEGORY_MESSAGE wire literal was not high priority");

        EvogentNotificationPolicy.Decision system = decisionFor("sys", false);
        require(system.protectedFromSuppression && !system.nativeCanSuppress,
                "Android CATEGORY_SYSTEM wire literal was suppressible");
        require("critical".equals(system.priority),
                "Android CATEGORY_SYSTEM wire literal was not critical");

        EvogentNotificationPolicy.Decision error = decisionFor("err", false);
        require(error.protectedFromSuppression && !error.nativeCanSuppress,
                "Android CATEGORY_ERROR wire literal was suppressible");
        require("critical".equals(error.priority),
                "Android CATEGORY_ERROR wire literal was not critical");
    }

    private static void missingUnknownCaseVariantAndConversationFailClosed() {
        for (String category : new String[] {
                null,
                "",
                "vendor_private_category",
                "Promo",
                "PROMO",
                " promo",
                "promo ",
                "\tpromo",
                "promo\n",
                "promo\u0000",
                "recommendation\r",
                "Recommendation",
                "Social",
                "status",
                "email",
                "voicemail",
                "car_information"
        }) {
            EvogentNotificationPolicy.Decision decision = decisionFor(category, false);
            require(decision.protectedFromSuppression,
                    "outside-allowlist category was suppressible: " + category);
            require(!decision.nativeCanSuppress,
                    "outside-allowlist category had native suppression authority: " + category);
            require((category == null || category.isEmpty())
                            ? "category_unavailable".equals(decision.protectionReason)
                            : "protected_category".equals(decision.protectionReason),
                    "outside-allowlist category reported the wrong protection reason: "
                            + category + " -> " + decision.protectionReason);
        }

        EvogentNotificationPolicy.Decision conversation = decisionFor("social", true);
        require(conversation.protectedFromSuppression && !conversation.nativeCanSuppress,
                "conversation escaped through the social allowlist");
        require("conversation".equals(conversation.protectionReason),
                "conversation did not expose its native protection reason");
        require("high".equals(conversation.priority),
                "conversation was not prioritized high");
    }

    private static EvogentNotificationPolicy.Decision decisionFor(
            String category,
            boolean conversation) {
        return EvogentNotificationPolicy.decide(input(
                "example.app",
                category,
                0,
                3,
                true,
                false,
                false,
                false,
                conversation,
                0,
                "Title",
                "Body"));
    }

    private static void requireProtected(
            String category,
            int flags,
            int importance,
            boolean clearable,
            boolean ongoing,
            boolean fullScreen,
            String message) {
        EvogentNotificationPolicy.Decision decision = EvogentNotificationPolicy.decide(input(
                "example.app",
                category,
                flags,
                importance,
                clearable,
                ongoing,
                fullScreen,
                false,
                false,
                0,
                "Title",
                "Body"));
        require(decision.protectedFromSuppression, message);
        require(!decision.nativeCanSuppress, message);
    }
}
