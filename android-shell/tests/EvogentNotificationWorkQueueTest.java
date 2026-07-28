package net.dangish.evogent;

/** Host-side checks for bounded, live-first notification scheduling. */
public final class EvogentNotificationWorkQueueTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        liveEventsLeapfrogReconnectBacklog();
        newestLiveEventNeverWaitsBehindPendingLiveBacklog();
        pendingRevisionsAreCoalescedByNotificationKey();
        inFlightRevisionDetectsPendingSameKeySuccessor();
        removalRetiresPendingAndInFlightRevisions();
        completedRevisionIsNotRetainedAsInFlight();
        liveOverloadEvictsOldestPendingWork();
        liveEntriesCarryMonotonicSequence();
        historicalOverloadRejectsNewestWork();
        invalidCapacitiesFailClosed();
        System.out.println("EvogentNotificationWorkQueueTest: PASS");
    }

    private static void liveEventsLeapfrogReconnectBacklog() throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(2, 3);
        require(queue.offer("history-1", true, "h1").accepted(),
                "first historical item rejected");
        require(queue.offer("history-2", true, "h2").accepted(),
                "second historical item rejected");
        require(queue.offer("live-1", false, "l1").accepted(), "live item rejected");

        require("live-1".equals(queue.take().value),
                "reconnect backlog head-of-line blocked a live event");
        require("history-1".equals(queue.take().value),
                "historical FIFO order changed after live priority");
        require("history-2".equals(queue.take().value),
                "historical backlog was lost without overload");
    }

    private static void newestLiveEventNeverWaitsBehindPendingLiveBacklog()
            throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(4, 1);
        require(queue.offer("live-oldest", false, "a").accepted(), "oldest rejected");
        require(queue.offer("live-middle", false, "b").accepted(), "middle rejected");
        require(queue.offer("live-newest", false, "c").accepted(), "newest rejected");

        require("live-newest".equals(queue.take().value),
                "fresh live work waited behind stale pending live work");
        require("live-middle".equals(queue.take().value),
                "live lane is not ordered newest-first");
        require("live-oldest".equals(queue.take().value),
                "accepted live work disappeared without overload");
    }

    private static void pendingRevisionsAreCoalescedByNotificationKey()
            throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(2, 2);
        require(queue.offer("revision-1", false, "same").accepted(),
                "first revision rejected");
        require(
                queue.offer("revision-2", false, "same")
                        == EvogentNotificationWorkQueue.OfferResult.REPLACED_PENDING_REVISION,
                "same-key pending revision was not coalesced");
        require(queue.liveSize() == 1, "coalescing consumed an extra live slot");
        require("revision-2".equals(queue.take().value),
                "coalescing retained a stale notification revision");
    }

    private static void inFlightRevisionDetectsPendingSameKeySuccessor()
            throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(2, 1);
        require(queue.offer("revision-1", false, "same").accepted(),
                "first revision rejected");
        EvogentNotificationWorkQueue.Entry<String> inFlight = queue.take();
        require(queue.isCurrent(inFlight), "taken revision was not current work");
        require(queue.offer("revision-2", false, "same").accepted(),
                "successor revision rejected");
        require(queue.hasNewerRevision(inFlight),
                "in-flight revision did not detect its same-key successor");
        require(!queue.isCurrent(inFlight),
                "superseded in-flight revision still had publication authority");

        EvogentNotificationWorkQueue<String> crowded =
                new EvogentNotificationWorkQueue<String>(2, 1);
        require(crowded.offer("old", false, "same").accepted(), "old rejected");
        EvogentNotificationWorkQueue.Entry<String> crowdedInFlight = crowded.take();
        require(crowded.offer("successor", false, "same").accepted(),
                "successor rejected");
        require(crowded.offer("other-1", false, "other-1").accepted(),
                "first distinct event rejected");
        require(crowded.offer("other-2", false, "other-2").accepted(),
                "second distinct event rejected");
        require(crowded.hasNewerRevision(crowdedInFlight),
                "successor eviction forgot that the in-flight revision was stale");
        crowded.complete(crowdedInFlight);
        require(!crowded.isCurrent(crowdedInFlight),
                "completed revision retained publication authority");
    }

    private static void completedRevisionIsNotRetainedAsInFlight()
            throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(2, 1);
        require(queue.offer("complete", false, "same").accepted(),
                "completed fixture rejected");
        EvogentNotificationWorkQueue.Entry<String> completed = queue.take();
        queue.complete(completed);
        require(queue.offer("later", false, "same").accepted(),
                "later notification rejected");
        require(!completed.supersededByNewerRevision,
                "completed entry was still mutated as in-flight");
        require("later".equals(queue.take().value),
                "later notification was not available");
        require(!queue.hasNewerRevision(completed),
                "completed entry remained registered as in-flight");
    }

    private static void removalRetiresPendingAndInFlightRevisions()
            throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(4, 4);
        require(queue.offer("live-in-flight", false, "same").accepted(),
                "in-flight removal fixture rejected");
        EvogentNotificationWorkQueue.Entry<String> inFlight = queue.take();
        require(queue.offer("live-successor", false, "same").accepted(),
                "pending successor rejected");
        require(queue.offer("history", true, "same").accepted(),
                "pending history rejected");
        require(queue.offer("unrelated", false, "other").accepted(),
                "unrelated work rejected");

        require(queue.retire("same") == 3,
                "removal did not retire every same-key revision");
        require(!queue.isCurrent(inFlight),
                "removed in-flight work retained publication authority");
        require(queue.liveSize() == 1 && queue.historicalSize() == 0,
                "removal retained queued same-key work");
        require("unrelated".equals(queue.take().value),
                "removal discarded unrelated work");
        require(queue.retire("missing") == 0,
                "unknown removal mutated the queue");
    }

    private static void liveOverloadEvictsOldestPendingWork()
            throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(2, 1);
        require(queue.offer("oldest", false, "a").accepted(), "oldest rejected");
        require(queue.offer("middle", false, "b").accepted(), "middle rejected");
        require(
                queue.offer("newest", false, "c")
                        == EvogentNotificationWorkQueue.OfferResult.EVICTED_OLDEST_LIVE,
                "live overload did not report its safe eviction");
        require(queue.liveSize() == 2, "live overload exceeded its bound");

        require("newest".equals(queue.take().value),
                "overload did not prioritize the newest event");
        require("middle".equals(queue.take().value),
                "overload evicted newer pending work instead of the oldest");
    }

    private static void liveEntriesCarryMonotonicSequence()
            throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(3, 1);
        require(queue.offer("old", false, "a").accepted(), "old event rejected");
        require(queue.offer("new", false, "b").accepted(), "new event rejected");

        EvogentNotificationWorkQueue.Entry<String> newest = queue.take();
        EvogentNotificationWorkQueue.Entry<String> older = queue.take();
        require("new".equals(newest.value), "newest selection changed");
        require(newest.liveSequence > older.liveSequence,
                "live entries do not carry monotonic digest-order provenance");
        require(older.liveSequence > 0L, "live sequence is not positive");
    }

    private static void historicalOverloadRejectsNewestWork()
            throws Exception {
        EvogentNotificationWorkQueue<String> queue =
                new EvogentNotificationWorkQueue<String>(1, 1);
        require(queue.offer("history-kept", true, "h1").accepted(),
                "historical capacity unavailable");
        require(
                queue.offer("history-rejected", true, "h2")
                        == EvogentNotificationWorkQueue.OfferResult.REJECTED,
                "historical lane exceeded its bound");

        require("history-kept".equals(queue.take().value),
                "historical overload evicted previously accepted history");
    }

    private static void invalidCapacitiesFailClosed() {
        boolean rejected = false;
        try {
            new EvogentNotificationWorkQueue<String>(0, 1);
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        require(rejected, "zero live capacity was accepted");
    }
}
