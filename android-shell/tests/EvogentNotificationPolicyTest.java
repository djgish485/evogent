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
        EvogentNotificationPolicy.Decision otp = EvogentNotificationPolicy.decide(input(
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
                rawOtp));
        require(otp.redactContent, "known one-time secret was not redacted");
        require(otp.protectedFromSuppression, "one-time secret original was suppressible");
        require(otp.safeText == null || !otp.safeText.contains("123456"),
                "raw one-time secret remained in transport output");

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

        String eventA = EvogentNotificationPolicy.eventId(
                "example.reader", "notification-key", 1000L, "Title", "Body", null);
        String eventB = EvogentNotificationPolicy.eventId(
                "example.reader", "notification-key", 1001L, "Title", "Body", null);
        String eventReplacement = EvogentNotificationPolicy.eventId(
                "example.reader", "notification-key", 1000L, "Title", "Replacement", null);
        require(!eventA.equals(eventB), "post time was not bound into receipt");
        require(!eventA.equals(eventReplacement), "content generation was not bound into receipt");

        require(EvogentNotificationPolicy.shouldCancelOriginal(
                        normal,
                        eventA,
                        eventA,
                        true,
                        "curated",
                        true,
                        true,
                        true,
                        true),
                "fully proven curated replacement was rejected");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "observe", true, true, true, true),
                "OBSERVE mode cancelled an original");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventB, true, "curated", true, true, true, true),
                "stale receipt cancelled a repost");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, false, "curated", true, true, true, true),
                "server persistence failure cancelled an original");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "curated", true, true, false, true),
                "digest publication failure cancelled an original");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "curated", true, false, false, true),
                "missing digest capability cancelled an original");
        require(!EvogentNotificationPolicy.shouldCancelOriginal(
                        normal, eventA, eventA, true, "curated", true, true, true, false),
                "changed active generation was cancelled");

        System.out.println("EvogentNotificationPolicyTest: PASS");
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
