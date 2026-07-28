package net.dangish.evogent;

import android.content.Context;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;

/**
 * Bounded app-private identity ledger for notification lifecycle control.
 *
 * Raw content never enters this file. Each row contains only the native event digest, Android's
 * opaque key, post time, lifecycle state, and update time. The exact key is needed for a later
 * user-initiated dismissal, so it remains inside the APK's no-backup private files directory and
 * never crosses loopback.
 */
final class EvogentNotificationReceiptStore {
    static final String STATE_OBSERVED = "observed";
    static final String STATE_RECEIPT = "receipt";
    static final String STATE_CURATED_CANCEL_PENDING = "curated_cancel_pending";
    static final String STATE_USER_DISMISS_PENDING = "user_dismiss_pending";
    static final String STATE_REMOVAL_PENDING = "removal_pending";
    static final String STATE_CURATED_REMOVED = "curated_removed";
    static final String STATE_USER_DISMISSED = "user_dismissed";
    static final String STATE_EXTERNAL_REMOVED = "external_removed";
    // Compatibility with the first unshipped receipt schema, which did not distinguish why an
    // original disappeared. Treat it as user-resolved for fail-closed digest reconciliation.
    static final String STATE_REMOVED = "removed";

    enum RemovalDisposition {
        UNKNOWN,
        EXPECTED_CURATED,
        EXPECTED_USER,
        EXTERNAL
    }

    static final class Record {
        final String eventId;
        final String notificationKey;
        final long postTimeMs;
        final String state;
        final long updatedAtMs;

        Record(
                String eventId,
                String notificationKey,
                long postTimeMs,
                String state,
                long updatedAtMs) {
            this.eventId = eventId;
            this.notificationKey = notificationKey;
            this.postTimeMs = postTimeMs;
            this.state = state;
            this.updatedAtMs = updatedAtMs;
        }
    }

    private static final Object LOCK = new Object();
    private static final String FILE_NAME = "notification-receipts-v1.json";
    private static final int MAX_RECORDS = 128;
    private static final int MAX_FILE_BYTES = 256 * 1024;
    private static final long RETENTION_MS = 8L * 24L * 60L * 60L * 1000L;

    private final AtomicFile file;

    EvogentNotificationReceiptStore(Context context) {
        File directory = new File(context.getNoBackupFilesDir(), "notification-state");
        if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) {
            throw new IllegalStateException("notification state directory unavailable");
        }
        file = new AtomicFile(new File(directory, FILE_NAME));
        if (file.getBaseFile().isFile()) {
            synchronized (LOCK) {
                if (!write(prune(read()))) {
                    throw new IllegalStateException("notification state retention unavailable");
                }
            }
        }
    }

    boolean recordObserved(String eventId, String notificationKey, long postTimeMs) {
        return upsert(eventId, notificationKey, postTimeMs, STATE_OBSERVED, false);
    }

    boolean recordReceipt(String eventId, String notificationKey, long postTimeMs) {
        return upsert(eventId, notificationKey, postTimeMs, STATE_RECEIPT, true);
    }

    Record findByEventId(String eventId) {
        if (!isEventId(eventId)) return null;
        synchronized (LOCK) {
            for (Record record : read()) {
                if (eventId.equals(record.eventId)) return record;
            }
        }
        return null;
    }

    Record findByKeyAndPostTime(String notificationKey, long postTimeMs) {
        if (!isNotificationKey(notificationKey) || postTimeMs <= 0L) {
            return null;
        }
        synchronized (LOCK) {
            for (Record record : read()) {
                if (notificationKey.equals(record.notificationKey)
                        && postTimeMs == record.postTimeMs) {
                    return record;
                }
            }
        }
        return null;
    }

    boolean markCancellationPending(String eventId, boolean userInitiated) {
        if (userInitiated) return markUserDismissPending(eventId);
        return transition(
                eventId,
                STATE_RECEIPT,
                STATE_CURATED_CANCEL_PENDING);
    }

    boolean restoreReceiptAfterAbortedCancellation(String eventId, boolean userInitiated) {
        if (userInitiated) return false;
        return transition(
                eventId,
                STATE_CURATED_CANCEL_PENDING,
                STATE_RECEIPT);
    }

    ArrayList<String> pendingRemovalEventIds() {
        return eventIdsInState(STATE_REMOVAL_PENDING);
    }

    ArrayList<String> pendingUserDismissEventIds() {
        return eventIdsInState(STATE_USER_DISMISS_PENDING);
    }

    ArrayList<String> pendingCuratedCancellationEventIds() {
        return eventIdsInState(STATE_CURATED_CANCEL_PENDING);
    }

    ArrayList<String> resolvedLifecycleEventIds() {
        ArrayList<String> resolved = new ArrayList<String>();
        synchronized (LOCK) {
            for (Record record : read()) {
                if (STATE_REMOVAL_PENDING.equals(record.state)
                        || STATE_EXTERNAL_REMOVED.equals(record.state)
                        || STATE_USER_DISMISS_PENDING.equals(record.state)
                        || STATE_USER_DISMISSED.equals(record.state)
                        || STATE_REMOVED.equals(record.state)) {
                    resolved.add(record.eventId);
                }
            }
        }
        return resolved;
    }

    private ArrayList<String> eventIdsInState(String state) {
        ArrayList<String> pending = new ArrayList<String>();
        synchronized (LOCK) {
            for (Record record : read()) {
                if (state.equals(record.state)) {
                    pending.add(record.eventId);
                }
            }
        }
        return pending;
    }

    boolean acknowledgeRemoval(String eventId) {
        return transition(eventId, STATE_REMOVAL_PENDING, STATE_EXTERNAL_REMOVED);
    }

    boolean markUserDismissPending(String eventId) {
        if (!isEventId(eventId)) return false;
        synchronized (LOCK) {
            ArrayList<Record> records = read();
            for (int index = 0; index < records.size(); index++) {
                Record current = records.get(index);
                if (!eventId.equals(current.eventId)) continue;
                if (STATE_USER_DISMISS_PENDING.equals(current.state)) return true;
                if (!STATE_RECEIPT.equals(current.state)
                        && !STATE_CURATED_CANCEL_PENDING.equals(current.state)) {
                    return false;
                }
                records.set(index, new Record(
                        current.eventId,
                        current.notificationKey,
                        current.postTimeMs,
                        STATE_USER_DISMISS_PENDING,
                        System.currentTimeMillis()));
                return write(prune(records));
            }
        }
        return false;
    }

    boolean markUserDismissResolved(String eventId) {
        if (!isEventId(eventId)) return false;
        synchronized (LOCK) {
            ArrayList<Record> records = read();
            for (int index = 0; index < records.size(); index++) {
                Record current = records.get(index);
                if (!eventId.equals(current.eventId)) continue;
                if (STATE_USER_DISMISSED.equals(current.state)) return true;
                if (!STATE_USER_DISMISS_PENDING.equals(current.state)
                        && !STATE_CURATED_REMOVED.equals(current.state)
                        && !STATE_REMOVED.equals(current.state)) {
                    return false;
                }
                records.set(index, new Record(
                        current.eventId,
                        current.notificationKey,
                        current.postTimeMs,
                        STATE_USER_DISMISSED,
                        System.currentTimeMillis()));
                return write(prune(records));
            }
        }
        return false;
    }

    RemovalDisposition markRemoved(
            String eventId,
            boolean listenerCancellation) {
        if (!isEventId(eventId)) return RemovalDisposition.UNKNOWN;
        synchronized (LOCK) {
            ArrayList<Record> records = read();
            for (int index = 0; index < records.size(); index++) {
                Record current = records.get(index);
                if (!eventId.equals(current.eventId)) continue;
                if (STATE_CURATED_REMOVED.equals(current.state)
                        || STATE_USER_DISMISSED.equals(current.state)
                        || STATE_EXTERNAL_REMOVED.equals(current.state)
                        || STATE_REMOVED.equals(current.state)) {
                    return RemovalDisposition.UNKNOWN;
                }
                if (STATE_REMOVAL_PENDING.equals(current.state)) {
                    return RemovalDisposition.EXTERNAL;
                }
                boolean curated =
                        EvogentNotificationReceiptRetentionPolicy.isExpectedCuratedRemoval(
                                current.state,
                                listenerCancellation);
                boolean user =
                        EvogentNotificationReceiptRetentionPolicy.isExpectedUserRemoval(
                                current.state);
                records.set(index, new Record(
                        current.eventId,
                        current.notificationKey,
                        current.postTimeMs,
                        curated
                                ? STATE_CURATED_REMOVED
                                : user
                                    ? STATE_USER_DISMISSED
                                    : STATE_REMOVAL_PENDING,
                        System.currentTimeMillis()));
                if (!write(prune(records))) return RemovalDisposition.UNKNOWN;
                if (curated) return RemovalDisposition.EXPECTED_CURATED;
                if (user) return RemovalDisposition.EXPECTED_USER;
                return RemovalDisposition.EXTERNAL;
            }
        }
        return RemovalDisposition.UNKNOWN;
    }

    private boolean transition(String eventId, String expectedState, String nextState) {
        if (!isEventId(eventId)) return false;
        synchronized (LOCK) {
            ArrayList<Record> records = read();
            for (int index = 0; index < records.size(); index++) {
                Record current = records.get(index);
                if (!eventId.equals(current.eventId)
                        || !expectedState.equals(current.state)) {
                    continue;
                }
                records.set(index, new Record(
                        current.eventId,
                        current.notificationKey,
                        current.postTimeMs,
                        nextState,
                        System.currentTimeMillis()));
                return write(prune(records));
            }
        }
        return false;
    }

    private boolean upsert(
            String eventId,
            String notificationKey,
            long postTimeMs,
            String state,
            boolean promoteObserved) {
        if (!isEventId(eventId)
                || !isNotificationKey(notificationKey)
                || postTimeMs <= 0L) {
            return false;
        }
        String key = notificationKey;
        synchronized (LOCK) {
            ArrayList<Record> records = read();
            for (int index = 0; index < records.size(); index++) {
                Record current = records.get(index);
                if (!eventId.equals(current.eventId)) continue;
                if (!key.equals(current.notificationKey) || postTimeMs != current.postTimeMs) {
                    return false;
                }
                if (STATE_CURATED_REMOVED.equals(current.state)
                        || STATE_USER_DISMISSED.equals(current.state)
                        || STATE_EXTERNAL_REMOVED.equals(current.state)
                        || STATE_REMOVED.equals(current.state)
                        || STATE_REMOVAL_PENDING.equals(current.state)
                        || STATE_CURATED_CANCEL_PENDING.equals(current.state)
                        || STATE_USER_DISMISS_PENDING.equals(current.state)) {
                    // Observation may still reach the server so its tombstone can converge, but a
                    // replayed server response can never mint fresh native cancellation authority
                    // over a terminal or already-pending lifecycle.
                    return !promoteObserved;
                }
                String nextState = promoteObserved ? state : current.state;
                records.set(index, new Record(
                        eventId,
                        key,
                        postTimeMs,
                        nextState,
                        System.currentTimeMillis()));
                return write(prune(records));
            }
            records.add(new Record(
                    eventId,
                    key,
                    postTimeMs,
                    state,
                    System.currentTimeMillis()));
            return write(prune(records));
        }
    }

    private ArrayList<Record> prune(ArrayList<Record> records) {
        final long oldestAllowed = System.currentTimeMillis() - RETENTION_MS;
        ArrayList<Record> retained = new ArrayList<Record>();
        for (Record record : records) {
            if (record.updatedAtMs >= oldestAllowed) retained.add(record);
        }
        Collections.sort(retained, new Comparator<Record>() {
            @Override public int compare(Record left, Record right) {
                int priority = Integer.compare(
                        EvogentNotificationReceiptRetentionPolicy.priority(left.state),
                        EvogentNotificationReceiptRetentionPolicy.priority(right.state));
                if (priority != 0) return priority;
                return Long.compare(right.updatedAtMs, left.updatedAtMs);
            }
        });
        if (retained.size() > MAX_RECORDS) {
            retained.subList(MAX_RECORDS, retained.size()).clear();
        }
        return retained;
    }

    private ArrayList<Record> read() {
        ArrayList<Record> records = new ArrayList<Record>();
        if (!file.getBaseFile().isFile()) return records;
        long oldestAllowed = System.currentTimeMillis() - RETENTION_MS;
        try {
            FileInputStream input = file.openRead();
            try {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_FILE_BYTES) return records;
                    output.write(buffer, 0, count);
                }
                JSONObject root = new JSONObject(
                        new String(output.toByteArray(), StandardCharsets.UTF_8));
                if (root.optInt("schemaVersion", 0) != 1) return records;
                JSONArray rows = root.optJSONArray("records");
                if (rows == null || rows.length() > MAX_RECORDS) return records;
                for (int index = 0; index < rows.length(); index++) {
                    JSONObject row = rows.optJSONObject(index);
                    if (row == null) continue;
                    String eventId = row.optString("eventId", "");
                    String key = row.optString("notificationKey", null);
                    long postTimeMs = row.optLong("postTimeMs", 0L);
                    String state = row.optString("state", "");
                    long updatedAtMs = row.optLong("updatedAtMs", 0L);
                    if (!isEventId(eventId)
                            || !isNotificationKey(key)
                            || postTimeMs <= 0L
                            || updatedAtMs <= 0L
                            || updatedAtMs < oldestAllowed
                            || !isState(state)) {
                        continue;
                    }
                    records.add(new Record(eventId, key, postTimeMs, state, updatedAtMs));
                }
            } finally {
                input.close();
            }
        } catch (Throwable ignored) {
            // Corrupt or unavailable state removes authority. Callers fail closed.
            records.clear();
        }
        return records;
    }

    private boolean write(ArrayList<Record> records) {
        FileOutputStream output = null;
        try {
            JSONObject root = new JSONObject();
            root.put("schemaVersion", 1);
            JSONArray rows = new JSONArray();
            for (Record record : records) {
                JSONObject row = new JSONObject();
                row.put("eventId", record.eventId);
                row.put("notificationKey", record.notificationKey);
                row.put("postTimeMs", record.postTimeMs);
                row.put("state", record.state);
                row.put("updatedAtMs", record.updatedAtMs);
                rows.put(row);
            }
            root.put("records", rows);
            byte[] bytes = root.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_FILE_BYTES) return false;
            output = file.startWrite();
            output.write(bytes);
            output.flush();
            output.getFD().sync();
            file.finishWrite(output);
            return true;
        } catch (Throwable ignored) {
            if (output != null) file.failWrite(output);
            return false;
        }
    }

    private static boolean isState(String state) {
        return STATE_OBSERVED.equals(state)
                || STATE_RECEIPT.equals(state)
                || STATE_CURATED_CANCEL_PENDING.equals(state)
                || STATE_USER_DISMISS_PENDING.equals(state)
                || STATE_REMOVAL_PENDING.equals(state)
                || STATE_CURATED_REMOVED.equals(state)
                || STATE_USER_DISMISSED.equals(state)
                || STATE_EXTERNAL_REMOVED.equals(state)
                || STATE_REMOVED.equals(state);
    }

    private static boolean isEventId(String value) {
        if (value == null || value.length() != 64) return false;
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (!((current >= '0' && current <= '9')
                    || (current >= 'a' && current <= 'f'))) {
                return false;
            }
        }
        return true;
    }

    private static boolean isNotificationKey(String value) {
        return value != null && value.length() > 0 && value.length() <= 1024;
    }
}
