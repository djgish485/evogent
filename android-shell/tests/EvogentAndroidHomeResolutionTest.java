package net.dangish.evogent;

/** Host-side checks for atomic, request-bound stock-HOME component publication. */
public final class EvogentAndroidHomeResolutionTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        completedNullIsDistinctFromPending();
        staleResolverCannotOverwriteNewAttempt();
        cancellationRejectsLatePublication();
        System.out.println("EvogentAndroidHomeResolutionTest: PASS");
    }

    private static void completedNullIsDistinctFromPending() {
        EvogentAndroidHomeResolution<String> resolution =
                new EvogentAndroidHomeResolution<String>();
        EvogentAndroidHomeResolution.Attempt<String> pending =
                resolution.begin(1L);
        require(!resolution.snapshot(1L).complete,
                "pending resolution was reported complete");
        require(resolution.complete(pending, null),
                "resolved-null result was not published");
        EvogentAndroidHomeResolution.Attempt<String> completed =
                resolution.snapshot(1L);
        require(completed != null && completed.complete && completed.target == null,
                "resolved-null target was confused with unresolved state");
    }

    private static void staleResolverCannotOverwriteNewAttempt() {
        EvogentAndroidHomeResolution<String> resolution =
                new EvogentAndroidHomeResolution<String>();
        EvogentAndroidHomeResolution.Attempt<String> stale =
                resolution.begin(1L);
        EvogentAndroidHomeResolution.Attempt<String> current =
                resolution.begin(2L);
        require(resolution.complete(current, "new-target"),
                "current resolver could not publish");
        require(!resolution.complete(stale, "old-target"),
                "stale resolver overwrote a newer request");
        EvogentAndroidHomeResolution.Attempt<String> observed =
                resolution.snapshot(2L);
        require(observed != null
                        && observed.complete
                        && "new-target".equals(observed.target),
                "new request token was paired with a stale target");
    }

    private static void cancellationRejectsLatePublication() {
        EvogentAndroidHomeResolution<String> resolution =
                new EvogentAndroidHomeResolution<String>();
        EvogentAndroidHomeResolution.Attempt<String> pending =
                resolution.begin(3L);
        resolution.cancel();
        require(!resolution.complete(pending, "late-target"),
                "cancelled resolver retained publication authority");
        require(resolution.snapshot(3L) == null,
                "cancelled request remained observable");
    }
}
