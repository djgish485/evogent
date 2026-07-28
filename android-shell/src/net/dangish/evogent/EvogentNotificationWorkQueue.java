package net.dangish.evogent;

import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * Two bounded notification lanes feeding one consumer.
 *
 * Live callbacks always leapfrog reconnect history. Within the live lane the newest pending
 * revision is selected first, duplicate notification keys are coalesced, and overload evicts the
 * oldest unprocessed live callback. Evicted/replaced work is safe because the listener leaves the
 * corresponding Android original untouched; only separately processed current work from an
 * explicitly allowed package may reach the best-effort key-cancellation path.
 */
final class EvogentNotificationWorkQueue<T> {
    enum OfferResult {
        ACCEPTED,
        REPLACED_PENDING_REVISION,
        EVICTED_OLDEST_LIVE,
        REJECTED;

        boolean accepted() {
            return this != REJECTED;
        }
    }

    static final class Entry<T> {
        final T value;
        final boolean historical;
        final String key;
        final long liveSequence;
        volatile boolean supersededByNewerRevision;

        Entry(T value, boolean historical, String key, long liveSequence) {
            this.value = value;
            this.historical = historical;
            this.key = key;
            this.liveSequence = liveSequence;
        }
    }

    private final int liveCapacity;
    private final int historicalCapacity;
    private final ArrayDeque<Entry<T>> live = new ArrayDeque<Entry<T>>();
    private final ArrayDeque<Entry<T>> historical = new ArrayDeque<Entry<T>>();
    private long newestLiveSequence;
    private Entry<T> inFlight;

    EvogentNotificationWorkQueue(int liveCapacity, int historicalCapacity) {
        if (liveCapacity <= 0 || historicalCapacity <= 0) {
            throw new IllegalArgumentException("notification queue capacities must be positive");
        }
        this.liveCapacity = liveCapacity;
        this.historicalCapacity = historicalCapacity;
    }

    synchronized OfferResult offer(T value, boolean isHistorical, String key) {
        if (value == null || key == null || key.length() == 0) {
            return OfferResult.REJECTED;
        }
        long sequence = isHistorical ? 0L : ++newestLiveSequence;
        Entry<T> entry = new Entry<T>(value, isHistorical, key, sequence);
        if (!isHistorical
                && inFlight != null
                && !inFlight.historical
                && key.equals(inFlight.key)
                && sequence > inFlight.liveSequence) {
            inFlight.supersededByNewerRevision = true;
        }
        ArrayDeque<Entry<T>> lane = isHistorical ? historical : live;
        Iterator<Entry<T>> iterator = lane.iterator();
        while (iterator.hasNext()) {
            if (key.equals(iterator.next().key)) {
                iterator.remove();
                lane.addLast(entry);
                notifyAll();
                return OfferResult.REPLACED_PENDING_REVISION;
            }
        }
        if (isHistorical) {
            if (historical.size() >= historicalCapacity) {
                return OfferResult.REJECTED;
            }
            historical.addLast(entry);
            notifyAll();
            return OfferResult.ACCEPTED;
        }
        OfferResult result = OfferResult.ACCEPTED;
        if (live.size() >= liveCapacity) {
            live.removeFirst();
            result = OfferResult.EVICTED_OLDEST_LIVE;
        }
        live.addLast(entry);
        notifyAll();
        return result;
    }

    synchronized Entry<T> take() throws InterruptedException {
        while (live.isEmpty() && historical.isEmpty()) {
            wait();
        }
        inFlight = !live.isEmpty() ? live.removeLast() : historical.removeFirst();
        return inFlight;
    }

    synchronized int liveSize() {
        return live.size();
    }

    synchronized int historicalSize() {
        return historical.size();
    }

    synchronized boolean hasNewerRevision(Entry<T> entry) {
        if (entry == null || entry.historical || entry.key == null) return false;
        if (entry.supersededByNewerRevision) return true;
        for (Entry<T> pending : live) {
            if (entry.key.equals(pending.key)
                    && pending.liveSequence > entry.liveSequence) {
                return true;
            }
        }
        return false;
    }

    synchronized boolean isCurrent(Entry<T> entry) {
        return entry != null
                && inFlight == entry
                && !hasNewerRevision(entry);
    }

    synchronized void complete(Entry<T> entry) {
        if (inFlight == entry) {
            inFlight = null;
        }
    }

    synchronized void clear() {
        live.clear();
        historical.clear();
        inFlight = null;
        notifyAll();
    }
}
