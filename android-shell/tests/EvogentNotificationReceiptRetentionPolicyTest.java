package net.dangish.evogent;

/** Host-side adversarial checks for bounded native receipt retention. */
public final class EvogentNotificationReceiptRetentionPolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        require(EvogentNotificationReceiptRetentionPolicy.isExpectedCuratedRemoval(
                        "curated_cancel_pending",
                        true),
                "listener-owned cancellation lost curated removal authority");
        require(!EvogentNotificationReceiptRetentionPolicy.isExpectedCuratedRemoval(
                        "curated_cancel_pending",
                        false),
                "user/app removal raced into curated replacement authority");
        require(!EvogentNotificationReceiptRetentionPolicy.isExpectedCuratedRemoval(
                        "receipt",
                        true),
                "unstaged listener removal gained curated replacement authority");
        require(EvogentNotificationReceiptRetentionPolicy.isExpectedUserRemoval(
                        "user_dismiss_pending"),
                "durable user dismissal was not resolved by removal");
        require(!EvogentNotificationReceiptRetentionPolicy.isExpectedUserRemoval(
                        "curated_cancel_pending"),
                "automatic replacement was mislabeled as user dismissal");

        int removal = EvogentNotificationReceiptRetentionPolicy.priority("removal_pending");
        int receipt = EvogentNotificationReceiptRetentionPolicy.priority("receipt");
        int curated =
                EvogentNotificationReceiptRetentionPolicy.priority("curated_cancel_pending");
        int dismissed =
                EvogentNotificationReceiptRetentionPolicy.priority("user_dismiss_pending");
        int removed = EvogentNotificationReceiptRetentionPolicy.priority("removed");
        int curatedRemoved =
                EvogentNotificationReceiptRetentionPolicy.priority("curated_removed");
        int userDismissed =
                EvogentNotificationReceiptRetentionPolicy.priority("user_dismissed");
        int externalRemoved =
                EvogentNotificationReceiptRetentionPolicy.priority("external_removed");
        int observed = EvogentNotificationReceiptRetentionPolicy.priority("observed");

        require(removal == curated && removal == dismissed,
                "pending lifecycle intent did not receive highest retention");
        require(removal < receipt,
                "pending lifecycle intent could be evicted by active receipt history");
        require(receipt == curatedRemoved,
                "active digest identity did not share receipt retention");
        require(receipt < userDismissed
                        && userDismissed == externalRemoved
                        && userDismissed == removed,
                "terminal lifecycle history could evict active digest authority");
        require(userDismissed < observed,
                "ordinary observation could evict terminal lifecycle convergence");
        require(observed
                        < EvogentNotificationReceiptRetentionPolicy.priority("unknown"),
                "unknown state gained retention authority");
        System.out.println("EvogentNotificationReceiptRetentionPolicyTest: PASS");
    }
}
